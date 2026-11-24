// agent402-actions-plugin - offline against a paid-mode Agent402 server (free
// tier via proof-of-work), plus a stub gateway that records the Authorization
// header for the credits-key path. No @elizaos/core needed: the plugin never
// imports it at runtime; a stub runtime supplies getSetting().
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
if (!existsSync(join(HERE, "node_modules", "agent402-client"))) {
  execSync("npm install ../../client --no-save --silent --ignore-scripts", { cwd: HERE, stdio: "inherit" });
}
const { getFreePort } = await import("../../scripts/lib/free-port.js");
const plugin = (await import("./index.js")).default;
const { findAction, callAction, aboutAction, agent402Provider, spendingSummaryFor, maxPerCallFrom, DEFAULT_MAX_PER_CALL_USD } = await import("./index.js");

const PORT = await getFreePort();
const BASE = process.env.AGENT402_BASE_URL || `http://127.0.0.1:${PORT}`;
let proc = null;
if (!process.env.AGENT402_BASE_URL) {
  proc = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off",
      POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/pow`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}

let pass = 0;
const ok = (c, m) => { if (!c) throw new Error(m); pass++; console.log(`ok - ${m}`); };
const runtime = (settings = {}) => ({ getSetting: (k) => settings[k] ?? null, getService: () => null });
const msg = (content) => ({ id: "m1", entityId: "u1", roomId: "r1", content });
const capture = () => { const calls = []; const cb = async (c) => { calls.push(c); return []; }; return { calls, cb }; };

async function main() {
  {
    // No @elizaos/core peer: the plugin imports nothing from core at run time,
    // and npm's peer check never admits a prerelease outside its own version
    // tuple, so any range refuses a host on the registry's `beta` line
    // (2.x prereleases) with ERESOLVE. test-runtime.js installs the packed
    // plugin beside core `latest` and `beta`; this keeps the cause in view.
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
    ok(!pkg.peerDependencies?.["@elizaos/core"] && !pkg.peerDependenciesMeta?.["@elizaos/core"], "no @elizaos/core peer that would refuse a host on a core prerelease");
  }
  ok(plugin.name === "agent402" && plugin.actions.length === 3 && plugin.providers.length === 1 && typeof plugin.init === "function", "plugin shape: name, three actions, one provider, init");
  ok(plugin.actions.map((a) => a.name).join(",") === "AGENT402_FIND,AGENT402_CALL,AGENT402_ABOUT", "actions in order: find, call, about");
  for (const a of plugin.actions) ok(typeof a.validate === "function" && typeof a.handler === "function" && a.description.length > 40 && Array.isArray(a.examples) && a.examples[0].length === 2, `${a.name}: validate + handler + description + a two-turn example`);
  await plugin.init({}, runtime({ AGENT402_BASE_URL: BASE }));

  const rt = runtime({ AGENT402_BASE_URL: BASE });
  // find: structured task, then plain text
  let { calls, cb } = capture();
  let r = await findAction.handler(rt, msg({ text: "", task: "sha256 hash of a string", k: 3 }), undefined, undefined, cb);
  ok(r.success === true && r.data.results.some((x) => x.slug === "hash") && /`hash`/.test(r.text), "AGENT402_FIND resolves a structured task to the hash tool and names it in the reply");
  ok(calls.length === 1 && calls[0].text === r.text, "the callback receives the same text the ActionResult carries");
  r = await findAction.handler(rt, msg({ text: "which tool makes a uuid" }), undefined, undefined, undefined);
  ok(r.success === true && r.data.results.some((x) => x.slug === "uuid"), "AGENT402_FIND falls back to the message text and needs no callback");
  r = await findAction.handler(rt, msg({ text: "" }));
  ok(r.success === false && /what you need/.test(r.text), "AGENT402_FIND with nothing to search answers a prompt, not an error");

  // call: validate needs a slug; the free tier pays with proof-of-work
  ok((await callAction.validate(rt, msg({ text: "hi" }))) === true && (await callAction.validate(rt, msg({ text: "", slug: "hash" }))) === true, "AGENT402_CALL validates on any message - the planner can only pick an action the ACTIONS provider listed, and that list is what validate() admits (0.2.0)");
  ({ calls, cb } = capture());
  r = await callAction.handler(rt, msg({ text: "", slug: "hash", params: { text: "hello world", algo: "sha256" } }), undefined, undefined, cb);
  const want = createHash("sha256").update("hello world").digest("hex");
  ok(r.success === true && (r.data.result.hex || r.data.result.digest || r.data.result.hash) === want, "AGENT402_CALL paid the free tier with proof-of-work and returned sha256('hello world')");
  ok(calls.length === 1 && calls[0].text.includes(want) && /complete JSON/.test(calls[0].text), "AGENT402_CALL reports the COMPLETE result JSON through the callback text (the 600-char preview is gone)");
  r = await callAction.handler(rt, msg({ text: "", slug: "no-such-tool-xyz", params: {} }));
  ok(r.success === false && /failed/.test(r.text), "an unknown slug is a clean failure, never a throw");

  // credits key path: a stub gateway sees Authorization: Bearer <key> on the paid route
  const seen = [];
  const stub = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || null });
    if (req.url.startsWith("/api/find")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ results: [{ slug: "search", name: "search", price: "$0.02", route: "POST /api/search", walletOnly: true, description: "web search" }] })); }
    if (req.url.startsWith("/api/pricing")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ endpoints: [{ slug: "search", method: "POST", path: "/api/search", price: "$0.02", computePayable: false }, { slug: "hash", method: "POST", path: "/api/hash", price: "$0.001", computePayable: true }] })); }
    res.writeHead(402, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Insufficient credits", reason: "insufficient", balanceUsd: 0 }));
  });
  await new Promise((r2) => stub.listen(0, "127.0.0.1", r2));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  const KEY = "a402_" + "k".repeat(40);
  const rtKey = runtime({ AGENT402_BASE_URL: stubBase, AGENT402_CREDITS_KEY: KEY });
  r = await callAction.handler(rtKey, msg({ text: "", slug: "search", params: { q: "x402" } }));
  ok(r.success === false && seen.some((s) => s.auth === `Bearer ${KEY}`) && /credits|402|failed/i.test(r.text), "with AGENT402_CREDITS_KEY the paid call carries Authorization: Bearer <key>; an insufficient-credits 402 is a clean failure");
  ok(!JSON.stringify(r).includes(KEY), "the credits key never appears in the ActionResult");
  r = await aboutAction.handler(rtKey, msg({ text: "what is agent402" }));
  ok(r.success === true && r.data.tools === 2 && r.data.freeTier === 1 && /2 pay-per-call/.test(r.text), "AGENT402_ABOUT reads /api/pricing and reports tool + free-tier counts");
  stub.close();

  // wallet key without the x402 peers installed: no paying fetch, free tier still works, nothing throws
  const rtWallet = runtime({ AGENT402_BASE_URL: BASE, AGENT402_WALLET_KEY: "0x" + "11".repeat(32) });
  r = await callAction.handler(rtWallet, msg({ text: "", slug: "hash", params: { text: "abc", algo: "sha256" } }));
  ok(r.success === true, `a wallet key (x402 peers present or not) still pays the free tier with proof-of-work (got: ${r.text})`);

  // The per-call ceiling holds on the payment that is SIGNED: a stub seller
  // quotes $0.01 to the unpaid preflight and $5 to the request the wallet
  // signs for. The wallet is a throwaway key; the stub records any signature.
  {
    const seen = { unpaid: 0, signed: 0 };
    const offer = (amount) => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/api/dear", description: "dear", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(amount), asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
    })).toString("base64");
    const dear = createServer((req, res) => {
      const j = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (req.url.startsWith("/api/pricing")) return j(200, { endpoints: [{ slug: "dear", method: "POST", path: "/api/dear", price: "$0.01", computePayable: false }] });
      req.resume();
      if (req.headers["payment-signature"] || req.headers["x-payment"]) { seen.signed++; return j(200, { ok: true }); }
      seen.unpaid++;
      return j(402, {}, { "payment-required": offer(seen.unpaid === 1 ? 10000 : quote) });
    });
    let quote = 5000000;
    await new Promise((resolve) => dear.listen(0, "127.0.0.1", resolve));
    // Spending caps are opt-in: a per-call ceiling the operator sets holds on
    // the signed payment, and with none set the same $5 payment is paid.
    const rtDear = runtime({ AGENT402_BASE_URL: `http://127.0.0.1:${dear.address().port}`, AGENT402_WALLET_KEY: "0x" + "22".repeat(32), AGENT402_MAX_PER_CALL_USD: "1" });
    r = await callAction.handler(rtDear, msg({ text: "", slug: "dear", params: { q: "x" } }));
    ok(seen.unpaid === 2 && seen.signed === 0, `the $5 payment the paid request asked for was never signed under a $1 ceiling the operator set (unpaid ${seen.unpaid}, signed ${seen.signed})`);
    ok(r.success === false && r.data?.errorCode === "spend_limit", `the call answers a spend-limit refusal (got: ${r.text})`);
    // With no setting the per-call ceiling is $5: a $5 call is paid and a $6
    // one is refused before signing, naming the price, the ceiling and how
    // to raise or turn it off. 0 or off pays it; a malformed value keeps $5.
    const dearUrl = `http://127.0.0.1:${dear.address().port}`;
    const rtOpen = runtime({ AGENT402_BASE_URL: dearUrl, AGENT402_WALLET_KEY: "0x" + "33".repeat(32) });
    const r2 = await callAction.handler(rtOpen, msg({ text: "", slug: "dear", params: { q: "y" } }));
    const lim = spendingSummaryFor(rtOpen)?.limits;
    ok(lim && lim.maxPerCallUsd === 5 && lim.dailyLimitUsd === null, `with no spending setting the client has the $5 per-call ceiling and no daily limit (${JSON.stringify(lim)})`);
    ok(r2.success === true && seen.signed === 1, `with no spending setting a $5 call is paid (signed ${seen.signed}, got: ${String(r2.text).slice(0, 120)})`);
    quote = 6000000;
    const r3 = await callAction.handler(rtOpen, msg({ text: "", slug: "dear", params: { q: "z" } }));
    ok(r3.success === false && r3.data?.errorCode === "spend_limit" && seen.signed === 1, `the $5 default refuses a $6 call before signing (signed ${seen.signed}, got: ${String(r3.text).slice(0, 200)})`);
    ok(/\$6\b/.test(r3.text) && /\$5/.test(r3.text) && /AGENT402_MAX_PER_CALL_USD/.test(r3.text) && /0 or off/.test(r3.text), `the refusal names the price, the ceiling and how to raise or turn it off (${r3.text})`);
    for (const [i, v] of ["0", "off"].entries()) {
      const rt = runtime({ AGENT402_BASE_URL: dearUrl, AGENT402_WALLET_KEY: "0x" + String(44 + i).repeat(32), AGENT402_MAX_PER_CALL_USD: v });
      const before = seen.signed;
      const rr = await callAction.handler(rt, msg({ text: "", slug: "dear", params: { q: v } }));
      ok(rr.success === true && seen.signed === before + 1, `AGENT402_MAX_PER_CALL_USD=${v} turns the ceiling off and the $6 call is paid (${String(rr.text).slice(0, 120)})`);
    }
    {
      const warned = [];
      const origErr = console.error;
      console.error = (...a) => warned.push(a.join(" "));
      let rb;
      const before = seen.signed;
      try {
        const rt = runtime({ AGENT402_BASE_URL: dearUrl, AGENT402_WALLET_KEY: "0x" + "66".repeat(32), AGENT402_MAX_PER_CALL_USD: "five" });
        rb = await callAction.handler(rt, msg({ text: "", slug: "dear", params: { q: "bad" } }));
        await callAction.handler(rt, msg({ text: "", slug: "dear", params: { q: "bad2" } }));
      } finally { console.error = origErr; }
      ok(rb?.success === false && rb.data?.errorCode === "spend_limit" && seen.signed === before && /\$5/.test(rb.text), `a malformed AGENT402_MAX_PER_CALL_USD keeps the $5 ceiling (${String(rb?.text).slice(0, 200)})`);
      ok(warned.filter((m) => /AGENT402_MAX_PER_CALL_USD="five" is not a USD amount, 0 or "off"; keeping the default \$5 per-call ceiling/.test(m)).length === 1, `a malformed AGENT402_MAX_PER_CALL_USD is named once on stderr (${warned.join(" | ")})`);
    }
    {
      const w = [];
      ok(DEFAULT_MAX_PER_CALL_USD === 5 && maxPerCallFrom(null) === 5 && maxPerCallFrom("0") === null && maxPerCallFrom("OFF") === null && maxPerCallFrom("2.5") === 2.5, "maxPerCallFrom: unset is $5, 0 or off is none, a number sets it");
      ok(["-1", "NaN", "abc ", "1e999"].every((v) => maxPerCallFrom(v, (m) => w.push(m)) === 5), "maxPerCallFrom: negative, NaN, text or infinite keeps the $5 default");
    }
    dear.close();
  }

  // provider: names the payment mode without leaking a key
  const p = await agent402Provider.get(rtKey, msg({ text: "" }), {});
  ok(/credits key/.test(p.text) && p.values.agent402PaymentMode === "credits key" && !p.text.includes(KEY), "provider context names the payment mode (credits key) and never the key");
  const p2 = await agent402Provider.get(runtime({ AGENT402_BASE_URL: BASE }), msg({ text: "" }), {});
  ok(/free tier only/.test(p2.text), "provider says free tier only when nothing is configured");
}

try {
  await main();
  console.log(`\n${pass} passed`);
} finally {
  if (proc) proc.kill("SIGKILL");
}
