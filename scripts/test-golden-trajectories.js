// Golden trajectories: route-execute's external leg graded step by step.
//
// Every task in scripts/golden-trajectories.json runs through the REAL paid
// server (src/server.js booted in paid mode against a stub facilitator and a
// stub chain RPC) and the real resolver, router and payer, buying from a stub
// seller ecosystem on loopback (fixed listings, prices, payTo wallets,
// settlement histories, live 402s and delivery behaviors). Each step of what
// happened is captured and compared with the task's expected trajectory:
//
//   candidates   the sellers the resolver handed route-execute, in order
//   tried        the sellers paid (payExternal called), in order, and those skipped
//   chosen       the seller on the receipt
//   lane         proven or unproven, for the chosen seller
//   amount       the atomic amount each signed authorization carries
//   payTo        the address each signed authorization pays
//   settle       whether the buyer's payment settled, and which sellers took ours
//   booking      the outbound ledger rows, the payer's held exposure, the
//                unproven lane's per-seller spend
//   receipt      seller, sellerProof, underlyingPriceUsd (and sellerPaid)
//   status       the final HTTP status
//
// A divergence prints the task, the step, expected and actual. A per-step pass
// rate closes the run. Tasks run in file order on one server, so a task can
// read the state an earlier one left (a delivery strike, a capped seller).
// Offline: the preload (scripts/lib/golden-preload.js) carries the
// .golden.test hosts to the stub and refuses every other outside host.
//
//   node scripts/test-golden-trajectories.js [--only <task id>] [--verbose] [--label <seller id>]
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { ownStoreEnv } from "./lib/own-stores.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = JSON.parse(readFileSync(join(ROOT, "scripts", "golden-trajectories.json"), "utf8"));
const argOf = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ONLY = argOf("--only");
const VERBOSE = process.argv.includes("--verbose");
const STEPS = ["candidates", "tried", "chosen", "lane", "amount", "payTo", "settle", "booking", "receipt", "status"];
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));
const lc = (a) => String(a || "").toLowerCase();
const nowS = () => Math.floor(Date.now() / 1000);
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TIERS = { base: "/api/route/execute", plus: "/api/route/execute-plus", max: "/api/route/execute-max" };

// The host's own wallets: a fixed treasury, and a spending wallet from a fixed
// key that only ever signs for the stubs here.
const TREASURY = "0x7e57000000000000000000000000000000000001";
const SPENDING_KEY = "0x" + "1d".repeat(32);
const SPENDING = privateKeyToAccount(SPENDING_KEY).address;
const WALLETS = { ...FIX.wallets, $TREASURY: TREASURY, $SPENDING: SPENDING };
const walletOf = (id) => { const a = WALLETS[id]; if (!a) throw new Error(`fixture: unknown wallet ${id}`); return a; };
const walletIdOf = new Map(Object.entries(WALLETS).map(([id, a]) => [lc(a), id]));
const nameWallet = (a) => walletIdOf.get(lc(a)) || lc(a);

// The stub ecosystem.
const SELLERS = Object.entries(FIX.sellers).map(([id, s]) => {
  const origin = `https://${s.host}.golden.test`;
  return { id, ...s, origin, host: `${s.host}.golden.test`, url: `${origin}/${s.slug}`, method: s.method || "POST", quote: s.quote ?? Math.round(s.price * 1e6), networks: s.networks || ["eip155:8453"] };
});
const sellerByHost = new Map(SELLERS.map((s) => [s.host, s]));
const sellerIdOfOrigin = (o) => { try { return sellerByHost.get(new URL(o).host)?.id ?? o; } catch { return sellerByHost.get(String(o))?.id ?? o; } };

const consumed = new Set(); // nonces the stub chain reports used
const obs = []; // { seller, kind, to, value, nonce }
const paidCalls = new Map(); // seller id -> paid requests seen
let txN = 0;

function offerOf(s, payTo, domainName) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: { url: s.url, description: s.about, mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(s.quote), asset: BASE_USDC, payTo, maxTimeoutSeconds: 300, extra: { name: domainName, version: "2" } }],
  };
}
const sellerStub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const s = sellerByHost.get(lc(req.headers["x-golden-host"]));
    const send = (status, obj, headers = {}) => { if (res.destroyed) return; res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
    if (!s || new URL(req.url, "http://x").pathname !== `/${s.slug}`) return send(404, { error: "no such route" });
    const sig = req.headers["payment-signature"] || req.headers["x-payment"];
    const kind = sig ? "paid" : req.headers["x-agent402-via"] === "router" ? "bare" : "probe";
    if (s.delayMs) await sleep(s.delayMs);
    if (kind === "probe" && s.probeDelayMs) await sleep(s.probeDelayMs);
    if (kind === "bare" && s.bare === 200) { obs.push({ seller: s.id, kind }); return send(200, { served: s.id, free: true }); }
    if (kind === "bare" && s.bare) { obs.push({ seller: s.id, kind }); return send(s.bare, { error: "upstream unavailable" }); }
    if (kind !== "paid") {
      obs.push({ seller: s.id, kind });
      const payTo = walletOf(kind === "bare" ? (s.routerPayTo || s.livePayTo || s.payTo) : (s.livePayTo || s.payTo));
      const offer = offerOf(s, payTo, kind === "probe" || kind === "bare" ? (s.liveDomainName || "USD Coin") : "USD Coin");
      return send(402, offer, { "payment-required": b64(offer) });
    }
    let p = null;
    try { p = unb64(sig); } catch { /* unreadable */ }
    const auth = p?.payload?.authorization || {};
    obs.push({ seller: s.id, kind, to: auth.to, value: String(auth.value), nonce: auth.nonce });
    const n = (paidCalls.get(s.id) || 0) + 1;
    paidCalls.set(s.id, n);
    const mode = s.paid === "fail-first" ? (n === 1 ? "take-and-fail" : "ok") : (s.paid || "ok");
    if (mode === "refuse") {
      const offer = offerOf(s, walletOf(s.livePayTo || s.payTo), "USD Coin");
      return send(402, { ...offer, error: "payment rejected" }, { "payment-required": b64(offer) });
    }
    consumed.add(lc(auth.nonce));
    if (mode === "take-and-fail") return send(500, { error: "backend failed after payment" });
    const tx = `0x${(++txN).toString(16).padStart(64, "0")}`;
    const query = Object.fromEntries(new URL(req.url, "http://x").searchParams);
    return send(200, { served: s.id, query, body: body ? JSON.parse(body) : null }, { "payment-response": b64({ success: true, transaction: tx, network: "eip155:8453", payer: auth.from }) });
  });
});

// Stub facilitator for the buyer's payment to us, and the stub chain RPC.
const settles = []; // { payer, ok }
const facilitator = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (obj) => { if (res.destroyed) return; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    let parsed = {};
    try { parsed = b ? JSON.parse(b) : {}; } catch { /* empty */ }
    if (req.url === "/rpc") {
      const call = parsed.method === "eth_call" ? String(parsed.params?.[0]?.data || "") : "";
      if (call.startsWith("0xe94a0102")) return reply({ jsonrpc: "2.0", id: parsed.id ?? 1, result: "0x" + (consumed.has("0x" + call.slice(-64).toLowerCase()) ? "1" : "0").padStart(64, "0") });
      if (call.startsWith("0x70a08231")) return reply({ jsonrpc: "2.0", id: parsed.id ?? 1, result: "0x" + (10n ** 12n).toString(16).padStart(64, "0") });
      if (parsed.method === "eth_chainId") return reply({ jsonrpc: "2.0", id: parsed.id ?? 1, result: "0x2105" });
      if (parsed.method === "eth_blockNumber") return reply({ jsonrpc: "2.0", id: parsed.id ?? 1, result: "0x100" });
      return reply({ jsonrpc: "2.0", id: parsed.id ?? 1, result: "0x" + "0".repeat(64) });
    }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") return reply({ isValid: true, payer });
    if (req.url === "/settle") {
      settles.push({ payer: lc(payer), ok: true });
      return reply({ success: true, transaction: `0x${(++txN).toString(16).padStart(64, "0")}`, network: "eip155:8453", payer });
    }
    reply({});
  });
});
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
const SELLER_PORT = (await listen(sellerStub)).address().port;
const FAC_PORT = (await listen(facilitator)).address().port;

// The index, the settlement evidence and the payout screen.
const dir = mkdtempSync(join(tmpdir(), "a402-golden-"));
const storeEnv = ownStoreEnv("golden");
const indexDir = dirname(storeEnv.INDEX_CACHE_FILE);
const now = Date.now();
const lines = SELLERS.map((s) => {
  const payTo = walletOf(s.payTo);
  const tool = { seller: s.origin, method: s.method, route: `/${s.slug}`, slug: s.slug, name: s.slug.replace(/-/g, " "), description: s.about, category: "data", tags: [], price: `$${s.price}`, networks: s.networks, payToByNetwork: { [s.networks[0]]: payTo } };
  return JSON.stringify([s.origin, { manifest: { name: s.host, homepage: s.origin }, fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1], payToByNetwork: { [s.networks[0]]: payTo }, evmDomainByNetwork: { "eip155:8453": { name: "USD Coin", version: "2" } }, tools: [tool] }]);
});
writeFileSync(join(indexDir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: lines.length }), ...lines].join("\n") + "\n");
const leaderboard = [], walletEvidence = {};
for (const s of SELLERS) {
  const settled = s.settled ?? s.walletSettled, payers = s.payers ?? s.walletPayers;
  if (!settled) continue;
  const w = lc(walletOf(s.payTo));
  leaderboard.push({ rank: leaderboard.length + 1, homepage: s.origin, origins: [s.origin], wallet: w, wallets: [w], callsSettled: settled, uniqueBuyers: payers });
  walletEvidence[w] = { callsSettled: settled, uniqueBuyers: payers, origins: [s.origin] };
}
const lbFile = join(dir, "leaderboard-snapshot.json");
writeFileSync(lbFile, JSON.stringify({ spec: "x402-leaderboard/1", asOf: new Date(now).toISOString(), windowLabel: "7d", leaderboard, walletEvidence }));
const sanctionsFile = join(dir, "sanctions-payout-addresses.json");
writeFileSync(sanctionsFile, JSON.stringify({ v: 1, fetchedAt: now, publishDate: null, addresses: [{ address: walletOf("sdn"), asset: "ETH", entity: "GOLDEN FIXTURE", sdnId: "990001" }] }));
const ctlFile = join(dir, "ctl-port");

const serverLog = [];
const proc = spawn(process.execPath, ["--import", "./scripts/lib/golden-preload.js", "src/server.js"], {
  cwd: ROOT,
  env: {
    ...process.env, ...storeEnv,
    PORT: "0", FREE_MODE: "", NODE_ENV: "test", WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    OPENROUTER_API_KEY: "", TYPESAFE_API_KEY: "", ROUTE_JUDGE: "off", REDIS_URL: "", STATE_DATABASE_URL: "",
    SOLANA_UPSTREAM_BUYER_KEY: "", ALGORAND_UPSTREAM_BUYER_MNEMONIC: "", TEMPO_UPSTREAM_BUYER_KEY: "",
    SOR_EXTERNAL_ENABLED: "true", X402_UPSTREAM_BUYER_KEY: SPENDING_KEY, X402_UPSTREAM_BUYER_ADDRESS: SPENDING,
    SOR_MULTI_TENANT_PAYTOS: [walletOf("shared"), walletOf("shared_busy")].join(","), SOR_SHARED_PAYTOS_FILE: join(dir, "shared-paytos.json"),
    SOR_SELF_FUNDING_CLEARED_FILE: join(dir, "self-funding-cleared.json"), SOR_ROUTER_PURCHASES_FILE: join(dir, "router-purchases.json"),
    LEADERBOARD_FUNDING_SCAN: "off", LEADERBOARD_SNAPSHOT_FILE: lbFile, SANCTIONS_PAYOUT_FILE: sanctionsFile,
    X402_ECONOMY_DB: join(dir, "econ.db"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_INDEX_CRAWL: "",
    MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0", ROUTER_WORKERS: "0", LOAD_SHED: "off",
    MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", FIRST_CALL_ALLOWANCE: "", SLOW_SYNC_WINDOW_SECONDS: "off",
    GOLDEN_SELLER_PORT: String(SELLER_PORT), GOLDEN_CTL_FILE: ctlFile,
    ...FIX.env,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logText = "";
const keep = (d) => { logText += d; for (const l of String(d).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 400)); if (serverLog.length > 4000) serverLog.splice(0, 1000); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);
let exited = null;
proc.on("exit", (code, signal) => { exited = { code, signal }; });
const cleanup = () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } sellerStub.close(); facilitator.close(); rmSync(dir, { recursive: true, force: true }); };
const die = (m) => { if (process.env.GOLDEN_SERVER_LOG) writeFileSync(process.env.GOLDEN_SERVER_LOG, logText); console.error(`FAIL: ${m}`); for (const l of serverLog.filter((x) => !/^\s+at /.test(x)).slice(-60)) console.error(`  server: ${l}`); cleanup(); process.exit(1); };

let B = null;
for (let i = 0; i < 480 && !B && !exited; i++) { const m = logText.match(/listening on :(\d+)/); if (m) B = `http://127.0.0.1:${m[1]}`; else await sleep(250); }
if (!B) die(`server never came up${exited ? ` (exited ${JSON.stringify(exited)})` : ""}`);
let ready = false;
for (let i = 0; i < 240 && !ready && !exited; i++) {
  try {
    const n = (await (await fetch(`${B}/api/index?limit=1`)).json()).sellerCount || 0;
    const r = await (await fetch(`${B}/api/route?q=quasar%20spectrum&include=external&top=5`)).json();
    ready = n >= SELLERS.length && !r.indexing && (r.results || []).some((x) => x.seller === "https://quasar-prime.golden.test");
  } catch { /* warming */ }
  if (!ready) await sleep(250);
}
if (!ready) die("the index never served the golden sellers");
while (!existsSync(ctlFile)) await sleep(50);
const CTL = `http://127.0.0.1:${readFileSync(ctlFile, "utf8").trim()}`;

const accepts = {};
const acceptFor = async (path) => {
  if (accepts[path]) return accepts[path];
  // The payment gate answers 402 once its facilitator's kinds are read at boot.
  let r = null;
  for (let k = 0; k < 120; k++) {
    r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (r.status === 402) break;
    await sleep(250);
  }
  if (r.status !== 402) die(`unpaid ${path} answered ${r.status}, not 402`);
  const req402 = unb64(r.headers.get("payment-required"));
  accepts[path] = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  if (!accepts[path]) die(`${path} offers no exact Base accept`);
  return accepts[path];
};
const credential = (accepted, payer, nonce, validBefore) => b64({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(validBefore), nonce } },
});
const outboundRows = () => {
  try { return readFileSync(storeEnv.OUTBOUND_LEDGER_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const round6 = (n) => Number(Number(n || 0).toFixed(6));

async function runTask(t, i) {
  const payer = `0xb0b0${(i + 1).toString(16).padStart(36, "0")}`;
  const path = TIERS[t.tier || "plus"];
  const body = t.slug ? { slug: t.slug, params: t.params || {} } : { task: t.task, ...(t.internal ? {} : { include: "external" }), ...(t.params ? { params: t.params } : {}), ...(t.maxUsd ? { maxUsd: t.maxUsd } : {}) };
  if (t.target) body.target = SELLERS.find((s) => s.id === t.target).url;
  if (t.targetUrl) body.target = t.targetUrl;
  const headers = { "content-type": "application/json", "x-golden-task": t.id, "x-forwarded-for": `10.77.${Math.floor(i / 250)}.${(i % 250) + 1}` };
  if (!t.unpaid) {
    const accepted = await acceptFor(path);
    headers["payment-signature"] = credential(accepted, payer, "0x" + "9a".repeat(16) + (i + 1).toString(16).padStart(32, "0"), nowS() + (t.validForSeconds || 300));
  }
  const obs0 = obs.length, settles0 = settles.length, out0 = outboundRows().length;
  const consumed0 = new Set(consumed);
  const r = await fetch(`${B}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  await sleep(60); // the response's finish listeners (exposure resolution) run after the body
  const steps = await (await fetch(`${CTL}/steps?task=${encodeURIComponent(t.id)}`)).json();
  const unprovenIds = Object.keys(t.expect.booking?.unprovenSpentUsd || {});
  const q = new URLSearchParams({ payer });
  for (const id of unprovenIds) { const s = SELLERS.find((x) => x.id === id); q.append("seller", `${s.url}|${walletOf(s.payTo)}`); }
  const state = await (await fetch(`${CTL}/state?${q}`)).json();
  const seen = obs.slice(obs0);
  const candidatesEv = steps.find((e) => e.step === "candidates");
  const attempts = steps.filter((e) => e.step === "attempt");
  const receipt = json?.receipt || null;
  const chosen = r.status === 200 && receipt ? (receipt.seller === "internal" ? "internal" : sellerIdOfOrigin(receipt.seller)) : null;
  const chosenAttempt = chosen && chosen !== "internal" ? [...attempts].reverse().find((e) => sellerIdOfOrigin(e.origin) === chosen) : null;
  const paid = seen.filter((o) => o.kind === "paid");
  const newlyConsumed = [...consumed].filter((n) => !consumed0.has(n));
  const actual = {
    candidates: candidatesEv ? candidatesEv.list.map((c) => sellerIdOfOrigin(c.origin)) : null,
    tried: { tried: attempts.map((e) => sellerIdOfOrigin(e.origin)), skipped: steps.filter((e) => e.step === "skip").map((e) => [sellerIdOfOrigin(e.origin), e.reason]) },
    chosen,
    lane: chosenAttempt ? chosenAttempt.lane : null,
    amount: paid.map((o) => Number(o.value)),
    payTo: paid.map((o) => nameWallet(o.to)),
    settle: { buyer: t.unpaid ? "none" : settles.slice(settles0).some((s) => s.payer === lc(payer) && s.ok) ? "settled" : "cancelled", sellerCharged: [...new Set(paid.filter((o) => newlyConsumed.includes(lc(o.nonce))).map((o) => o.seller))] },
    booking: {
      outbound: outboundRows().slice(out0).map((row) => [sellerIdOfOrigin(row.origin), row.result]),
      exposureUsd: round6(state.exposureUsd),
      ...(unprovenIds.length ? { unprovenSpentUsd: Object.fromEntries(unprovenIds.map((id) => [id, round6(state.unproven[SELLERS.find((x) => x.id === id).url])])) } : {}),
    },
    receipt: receipt && r.status === 200 ? { seller: chosen, sellerProof: receipt.sellerProof ?? null, underlyingPriceUsd: receipt.underlyingPriceUsd, ...(receipt.sellerPaid === false ? { sellerPaid: false } : {}) } : null,
    status: r.status,
  };
  const e = t.expect;
  const expected = {
    candidates: e.candidates,
    tried: { tried: e.tried, skipped: e.skipped || [] },
    chosen: e.chosen,
    lane: e.lane,
    amount: e.signed.map(([, v]) => v),
    payTo: e.signed.map(([w]) => w),
    settle: { buyer: e.settle.buyer, sellerCharged: e.settle.sellerCharged },
    booking: { outbound: e.booking.outbound, exposureUsd: e.booking.exposureUsd, ...(e.booking.unprovenSpentUsd ? { unprovenSpentUsd: e.booking.unprovenSpentUsd } : {}) },
    receipt: e.receipt,
    status: e.status,
  };
  return { expected, actual, detail: { status: r.status, error: json?.error, steps, seen } };
}
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const tasks = FIX.tasks.filter((t) => !ONLY || t.id === ONLY);
const perStep = Object.fromEntries(STEPS.map((s) => [s, { pass: 0, fail: 0 }]));
const failures = [];
try {
  for (let i = 0; i < FIX.tasks.length; i++) {
    const t = FIX.tasks[i];
    if (ONLY && t.id !== ONLY) continue;
    const { expected, actual, detail } = await runTask(t, i);
    const bad = [];
    for (const step of STEPS) {
      const ex = expected[step], ac = actual[step];
      if (stable(ex) === stable(ac)) perStep[step].pass++;
      else { perStep[step].fail++; bad.push({ step, expected: ex, actual: ac }); }
    }
    if (bad.length) {
      failures.push(t.id);
      console.log(`FAIL - ${t.id}`);
      for (const d of bad) console.log(`    step ${d.step} diverged: expected ${stable(d.expected)}, actual ${stable(d.actual)}`);
      console.log(`    (status ${detail.status}${detail.error ? `: ${String(detail.error).slice(0, 220)}` : ""})`);
      if (VERBOSE) console.log(`    steps ${stable(detail.steps)}\n    seen ${stable(detail.seen)}`);
    } else console.log(`ok - ${t.id}`);
  }
  // --label <seller id>: print the public dispatch label of that seller's route (what /api/index publishes).
  for (const id of process.argv.flatMap((a, k) => (process.argv[k - 1] === "--label" ? [a] : []))) {
    const s = SELLERS.find((x) => x.id === id);
    const d = await (await fetch(`${B}/api/index?seller=${encodeURIComponent(s.origin)}`)).json();
    console.log(`label ${id}: ${stable((d.tools || []).map((t) => ({ slug: t.slug, eligible: t.routerDispatchEligible, reason: t.routerDispatchReason, base: t.routerDispatchByChain?.base, lane: t.executeViaLane ?? null, callableNow: t.executeViaCallableNow ?? null })))}`);
  }
  const egress = await (await fetch(`${CTL}/egress`)).json();
  console.log(`\nper-step pass rate over ${tasks.length} tasks:`);
  for (const s of STEPS) { const { pass, fail } = perStep[s]; console.log(`  ${s.padEnd(11)} ${String(pass).padStart(3)}/${pass + fail}  ${((100 * pass) / Math.max(1, pass + fail)).toFixed(1)}%`); }
  const sellersPaid = obs.filter((o) => o.kind === "paid").length;
  console.log(`\n${tasks.length - failures.length}/${tasks.length} trajectories match; ${sellersPaid} stub-seller payments signed; outside hosts refused by the preload: ${egress.hosts.length}${VERBOSE ? ` (${[...new Set(egress.hosts)].join(", ")})` : ""}; ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (!ONLY && FIX.tasks.length < 50) { console.log(`FAIL - the fixture holds ${FIX.tasks.length} tasks; at least 50 are required`); failures.push("count"); }
  cleanup();
  process.exit(failures.length ? 1 : 0);
} catch (e) {
  die(`unexpected: ${e?.stack || e}`);
}
