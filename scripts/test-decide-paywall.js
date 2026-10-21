// Decide as an outside buyer meets it, on a real boot in paid mode (a local
// /supported stub; nothing is paid, and the decide service is an address
// nothing listens on, so no model is called):
//   - the unpaid 402 for /api/decide is a valid offer, names every depth's
//     price, and carries the whole output example (what the fee buys);
//   - /api/decide/execute's published example runs as written (a free plan
//     sketch quoted at its steps' list prices), and a decisionId this server
//     never issued gets a free 404 saying where one comes from, before any 402;
//   - GET /__operator/decide-stats.json is operator-only (404 otherwise);
//   - a lower price set in DECIDE_CONFIG alone reaches the 402, /api/pricing,
//     the description, the example's credit, /decide and /llms.txt.
//
//   node scripts/test-decide-paywall.js
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";
import { parsePaymentRequired } from "@x402/core/schemas";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { DEFAULTS } from "../src/decide/config.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = "op_" + "x".repeat(40);
const dir = mkdtempSync(join(tmpdir(), "decide-paywall-"));

const [facPort, deadPort] = await getFreePorts(2);
const facilitator = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    if (req.url === "/supported") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(facPort, "127.0.0.1", r));

async function boot(name, extra = {}) {
  const [port] = await getFreePorts(1);
  const env = { ...process.env };
  for (const k of ["STATE_DATABASE_URL", "DECIDE_CONFIG", "FREE_MODE"]) delete env[k];
  let log = "";
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...env, PORT: String(port), FREE_MODE: "", NODE_ENV: "test",
      NETWORK: "base", PAYMENT_NETWORKS: "base", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      FACILITATOR_URL: `http://127.0.0.1:${facPort}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      STATS_ALLOW_EPHEMERAL: "true",
      DECIDE_SERVICE_URL: `http://127.0.0.1:${deadPort}`, DECIDE_INTERNAL_TOKEN: "t".repeat(32),
      DECIDE_LEDGER_DB: join(dir, `${name}.db`), AGENT402_OPERATOR_TOKEN: TOKEN,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { /* booting */ }
    if (!up) await wait(250);
  }
  if (!up) { console.log(log.slice(-1500)); throw new Error(`${name}: server did not boot`); }
  return { base, stop: () => child.kill("SIGKILL"), log: () => log };
}

const post = (base, path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
const offerOf = (res) => {
  const h = res.headers.get("payment-required");
  return h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null;
};
const baseAmountUsd = (offer) => Number(offer?.accepts?.find((a) => a.network === "eip155:8453" && a.scheme === "exact")?.amount) / 1e6;
const fmt = (n) => `$${n}`;

async function checks(s, prices, label) {
  const pricing = await (await fetch(`${s.base}/api/pricing`)).json();
  const rows = pricing.endpoints || [];
  const row = (path) => rows.find((r) => r.path === path);
  const priceOf = (slug) => Number(String(rows.find((r) => r.slug === slug)?.price ?? "").replace(/[^0-9.]/g, ""));
  ok(row("/api/decide") && Number(String(row("/api/decide").price).replace(/[^0-9.]/g, "")) === prices.plan, `${label}: /api/pricing lists decide at the default depth's (plan) price from the config (${row("/api/decide")?.price})`);

  // ---- the decide 402 ----
  const openapi = await (await fetch(`${s.base}/openapi.json`)).json();
  const op = openapi.paths?.["/api/decide"]?.post;
  const example = op?.requestBody?.content?.["application/json"]?.example || { task: "Resolve the ENS name vitalik.eth and read its wallet balance on Base", depth: "plan" };
  for (const depth of ["quick", "plan", "full"]) {
    const r = await post(s.base, "/api/decide", { ...example, depth });
    const offer = offerOf(r);
    if (!offer) console.log(`${label}: ${depth} answered ${r.status} with no offer; server log tail:\n${s.log().slice(-1200)}`);
    ok(r.status === 402 && baseAmountUsd(offer) === prices[depth], `${label}: an unpaid ${depth} decision quotes ${fmt(prices[depth])} (${baseAmountUsd(offer)})`);
    if (depth !== "plan") continue;
    const parsed = parsePaymentRequired(offer);
    ok(parsed.success === true, `${label}: the decide 402 parses under the protocol's own schema`);
    ok(validateDiscoveryExtension(offer.extensions?.bazaar)?.valid === true, `${label}: its discovery extension validates`);
    const desc = String(offer.resource?.description || "");
    ok(["quick", "plan", "full"].every((d) => desc.includes(`${d} ${fmt(prices[d])}`)), `${label}: the 402 description names each depth's price (${desc.slice(0, 260)})`);
    const out = offer.extensions?.bazaar?.info?.output?.example;
    ok(out && !out.truncated && Array.isArray(out.plan) && out.plan.length >= 2, `${label}: the 402 carries the whole output example, not a pointer`);
    ok(out?.executionCredit?.amountUsd === prices.plan && out.priceUsd === prices.plan, `${label}: the example's fee and credit are the configured plan price`);
    for (const st of out?.plan || []) ok(priceOf(st.tool.slug) === st.tool.priceUsd, `${label}: the example's ${st.tool.slug} step quotes its catalog price (${st.tool.priceUsd})`);
  }

  // ---- execute: the published example runs as written ----
  const xr = await post(s.base, "/api/decide/execute", {});
  const xoffer = offerOf(xr);
  const xin = xoffer?.extensions?.bazaar?.info?.input?.body;
  ok(xin && Array.isArray(xin.steps) && !("decisionId" in xin), `${label}: the execute example is a free plan sketch, no decisionId (${JSON.stringify(xin)})`);
  const xe = await post(s.base, "/api/decide/execute", xin);
  const want = Math.round(xin.steps.reduce((a, slug) => a + priceOf(slug), 0) * 1e6) / 1e6;
  ok(xe.status === 402 && baseAmountUsd(offerOf(xe)) === want, `${label}: the execute example is quoted at its steps' list prices (${baseAmountUsd(offerOf(xe))} vs ${want})`);

  // ---- an unknown decisionId: a free 404 with the way forward ----
  const unk = await post(s.base, "/api/decide/execute", { decisionId: "dec_2b1c9e0f4a7d4c3e9b8a1f00" });
  const uj = await unk.json().catch(() => ({}));
  ok(unk.status === 404 && !unk.headers.get("payment-required"), `${label}: an unknown decisionId is a 404 before any 402 (${unk.status})`);
  ok(/POST \/api\/decide/.test(uj.error || "") && /api\/find/.test(uj.error || "") && uj.charged === false, `${label}: ...that says where a decisionId comes from and how to run without one`);

  // ---- operator stats ----
  const anon = await fetch(`${s.base}/__operator/decide-stats.json`);
  const wrong = await fetch(`${s.base}/__operator/decide-stats.json`, { headers: { authorization: "Bearer wrong-token-value" } });
  const good = await fetch(`${s.base}/__operator/decide-stats.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const gj = await good.json().catch(() => ({}));
  ok(anon.status === 404 && wrong.status === 404, `${label}: decide-stats is 404 without the operator token (${anon.status}, ${wrong.status})`);
  ok(good.status === 200 && gj.enabled === true && gj.windows?.["7d"]?.external && gj.windows?.["30d"]?.ours, `${label}: ...and the aggregates with it (${good.status})`);

  // ---- derived prose ----
  const usd = (n) => `$${Number(n).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  const page = await (await fetch(`${s.base}/decide`)).text();
  ok(["quick", "plan", "full"].every((d) => page.includes(usd(prices[d]))), `${label}: /decide quotes every configured price`);
  const llms = await (await fetch(`${s.base}/llms.txt`)).text();
  ok(llms.includes(`Depth quick $${prices.quick} / plan $${prices.plan} / full $${prices.full}`), `${label}: /llms.txt quotes every configured price`);
}

try {
  const a = await boot("defaults");
  try { await checks(a, DEFAULTS.prices, "defaults"); } finally { a.stop(); }
  // A lower price is a configuration change only.
  const low = { quick: 0.003, plan: 0.01, full: 0.03 };
  const b = await boot("lowered", { DECIDE_CONFIG: JSON.stringify({ prices: low }) });
  try { await checks(b, low, "lowered"); } finally { b.stop(); }
} finally {
  facilitator.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ntest-decide-paywall: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
