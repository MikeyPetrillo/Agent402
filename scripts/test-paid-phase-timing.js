#!/usr/bin/env node
// Per-phase timing of paid calls, per rail (src/paid-phase-timing.js).
//
//   node scripts/test-paid-phase-timing.js     (offline: boots its own paid server)
//
// Boots the REAL server with the x402 paywall active, a stub facilitator with
// injected verify and settle delays, and a stub market-data upstream
// (scripts/lib/databento-stub-preload.js, which refuses to load without its
// stub) with an injected data delay. Then buys stock-history (stock-quote is
// never served: src/tools/stock-provider.js STOCK_SERVED_SLUGS):
//   a. over x402: the log line and the operator summary carry verify, handler
//      and settle times that match the injected delays, under rail=x402 and the
//      Base network;
//   b. over the native MPP wire (a stock mppx client): the same phases, filed
//      under rail=mpp-evm, not x402;
//   c. a buyer who hangs up mid-handler is marked gone, and nothing settles;
//   d. the summary is operator-only (404 without the token) and the log line
//      carries no payer address and no transaction hash.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, srv = null, facilitator = null, dbStub = null;
const serverLog = () => (srv?.log() || "").split("\n").filter((l) => l.trim()).map((l) => l.slice(0, 600));
const TMP = mkdtempSync(join(tmpdir(), "phase-timing-"));
const cleanup = () => { srv?.child.kill("SIGKILL"); facilitator?.close(); dbStub?.close(); rmSync(TMP, { recursive: true, force: true }); };
const fail = (m) => { console.error("FAIL:", m); for (const l of serverLog().slice(-25)) console.error("  server:", l); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(20); } return cond(); };

// ---- which phase a departed buyer was waiting on (the module alone) ----
// The booted case below leaves mid-handler. A buyer who leaves while the
// settle call is in flight, or after it, is told apart by the same marks; here
// they are set through the module's own middleware and hooks on a plain
// request and response, with no server.
{
  const { EventEmitter } = await import("node:events");
  const T = await import("../src/paid-phase-timing.js");
  process.env.PAID_TIMING_LOG = "off";
  const hooks = {};
  T.registerPhaseTimingHooks(Object.fromEntries(["onBeforeVerify", "onAfterVerify", "onVerifyFailure", "onBeforeSettle", "onAfterSettle", "onSettleFailure"].map((k) => [k, (fn) => { hooks[k] = fn; }])));
  const arrive = T.phaseArrivalMiddleware();
  // One paid call on its own network (so each lands in its own hang-up list).
  const call = (network) => {
    const req = { headers: {}, header: () => undefined };
    const res = new EventEmitter();
    res.statusCode = 200; res.writableFinished = false; res.end = () => {};
    const ctx = { transportContext: { request: { adapter: { req } } }, requirements: { network } };
    arrive(req, res, () => {});
    hooks.onBeforeVerify(ctx); hooks.onAfterVerify(ctx);
    T.markPaidHandlerStart(req, res, "phase-unit");
    return { req, res, ctx };
  };
  const listed = (network) => T.paidPhaseSummary().hangups[network];
  const tick = () => sleep(5);

  // During settle: the handler ended, the settle call started and has not returned.
  const a = call("test:settle");
  await tick(); a.res.end(); await tick();
  hooks.onBeforeSettle(a.ctx); await tick();
  a.res.emit("close");
  ok(T.hangupWaitOf(a.req)?.during === "settle" && listed("test:settle")?.byPhase?.settle === 1 && listed("test:settle").recent[0].during === "settle", `a buyer who leaves while the settle call is in flight is listed under settle (${JSON.stringify(listed("test:settle")?.byPhase)})`);

  // After the settle returned: the response was being written.
  const b = call("test:after");
  await tick(); b.res.end(); await tick();
  hooks.onBeforeSettle(b.ctx); await tick();
  hooks.onAfterSettle({ ...b.ctx, result: { success: true } }); await tick();
  b.res.emit("close");
  ok(T.hangupWaitOf(b.req)?.during === "after-handler" && listed("test:after")?.byPhase?.["after-handler"] === 1, `a buyer who leaves after the settle returned is listed under after-handler (${JSON.stringify(listed("test:after")?.byPhase)})`);

  // A rail with no settle hooks: after the handler's end it is after-handler.
  const c = call("test:nohooks");
  await tick(); c.res.end(); await tick();
  c.res.emit("close");
  ok(T.hangupWaitOf(c.req)?.during === "after-handler" && listed("test:nohooks")?.byPhase?.["after-handler"] === 1, "with no settle marks, a departure after the handler's end is after-handler");

  // Control: before the handler's end it is the handler, whatever came later.
  const d = call("test:handler");
  await tick(); d.res.emit("close");
  ok(T.hangupWaitOf(d.req)?.during === "handler", "control: a departure before the handler's end reads handler");
  d.res.end();
  ok(listed("test:handler")?.byPhase?.handler === 1 && listed("test:handler").recent[0].waitedMs >= 0, "control: and is listed under handler once the handler ends");

  // The in-flight coverage check's 429s: the "[paid-timing]" line follows the
  // per-wallet sampler's answer (markCoverRefusalLine), so a burst of refused
  // calls prints one line per wallet per minute. A call that ran prints as before.
  {
    const realLog = console.log;
    const lines = [];
    console.log = (l) => { if (typeof l === "string" && l.startsWith("[paid-timing]")) lines.push(l); };
    process.env.PAID_TIMING_LOG = "";
    try {
      const refused = (print, status = 429) => {
        const x = call("test:cover");
        if (print !== undefined) T.markCoverRefusalLine(x.req, print);
        x.res.statusCode = status; x.res.writableFinished = true;
        x.res.end(); x.res.emit("close");
      };
      const before = T.paidPhaseSummary().rails.x402?.calls ?? 0;
      refused(true);
      ok(lines.length === 1 && /status=429/.test(lines[0]), `a wallet's first coverage refusal in the minute prints its timing line (${lines.length})`);
      for (let i = 0; i < 200; i++) refused(false);
      ok(lines.length === 1, `the 200 after it print none (${lines.length - 1})`);
      ok((T.paidPhaseSummary().rails.x402?.calls ?? 0) > before, "the refused calls are still in the rolling window");
      refused(undefined);
      ok(lines.length === 2, "control: a 429 that is not a coverage refusal prints as before");
      refused(false, 200); refused(false, 502);
      ok(lines.length === 4 && /status=200/.test(lines[2]) && /status=502/.test(lines[3]), `control: a marked call whose final status is not 429 prints as before (${lines.length})`);
      const noPhases = {};
      T.markCoverRefusalLine(noPhases, false); T.markCoverRefusalLine(null, false);
      ok(Object.keys(noPhases).length === 0, "a request with no timing record is left alone");
    } finally { console.log = realLog; process.env.PAID_TIMING_LOG = "off"; }
  }
}

let B = "";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"7c".repeat(32)}`;
const OP = "test-phase-timing-operator-token-0123456789";
const SECRET = "test-phase-timing-mpp-secret";
const VERIFY_MS = 200, SETTLE_MS = 300, DATA_MS = 400;

// Stub facilitator with injected delays.
const fac = { verify: 0, settle: 0 };
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", async () => {
    const reply = (obj) => { if (res.destroyed) return; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
      const balanceOf = rpc.method === "eth_call" && String(rpc.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply({ jsonrpc: "2.0", id: 1, result: balanceOf ? "0x" + (1_000_000_000).toString(16).padStart(64, "0") : "0x0" });
    }
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { fac.verify++; await sleep(VERIFY_MS); return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { fac.settle++; await sleep(SETTLE_MS); return reply({ success: true, transaction: TX, network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC_PORT = facilitator.address().port;

// Stub market data: the boundary answers at once, the data read after DATA_MS
// (or `slowDataMs` when a case needs a long handler).
const db = { range: 0, data: 0, cost: 0, slowDataMs: 0 };
const bar = (day, close) => JSON.stringify({ hd: { ts_event: String(Date.parse(day) * 1e6) }, open: "1e11", high: "2e11", low: "5e10", close, volume: "100" });
dbStub = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", async () => {
    const send = (status, text) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { "Content-Type": "application/json" }); res.end(text); };
    const url = String(req.url || "");
    if (url.startsWith("/v0/metadata.get_dataset_range")) { db.range++; return send(200, JSON.stringify({ end: "2026-10-09" })); }
    if (url.startsWith("/v0/metadata.get_cost")) { db.cost++; return send(200, "0.00001"); }
    if (url.startsWith("/v0/timeseries.get_range")) { db.data++; await sleep(db.slowDataMs || DATA_MS); return send(200, bar("2026-10-08", "1.4e11") + "\n" + bar("2026-10-09", "1.5e11") + "\n"); }
    send(404, "{}");
  });
});
await new Promise((r) => dbStub.listen(0, "127.0.0.1", r));
const DB_PORT = dbStub.address().port;

const booting = bootServer({
  stores: false,
  args: ["--import", "./scripts/lib/databento-stub-preload.js"],
  timeoutMs: 60_000,
  env: { TRUST_PROXY_HOPS: "1", FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: SECRET, TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    STOCK_DATA_PROVIDER: "databento", DATABENTO_API_KEY: "db-test-key-not-real", DATABENTO_STUB_URL: `http://127.0.0.1:${DB_PORT}`, PAID_TIMING_LOG: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    AGENT402_OPERATOR_TOKEN: OP, REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json") },
});
const timingLines = () => serverLog().filter((l) => l.startsWith("[paid-timing]"));
const field = (line, k) => { const m = line.match(new RegExp(`\\b${k}=(\\S+)`)); return m ? m[1] : null; };
const msOf = (line, k) => { const v = field(line, k); return v && v !== "-" ? Number(v.replace(/ms$/, "")) : null; };
const near = (v, target, slack = 250) => v != null && v >= target - 20 && v <= target + slack;
let opReads = 0;
const perf = async (auth = true) => fetch(`${B}/__operator/perf.json`, { headers: { ...(auth ? { Authorization: `Bearer ${OP}` } : {}), "x-forwarded-for": `10.77.0.${++opReads}` } });

let nonceN = 0;
const credential = (accepted, payer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x9000 + ++nonceN).toString(16).padStart(64, "0") } },
})).toString("base64");
const PAYER = "0x00000000000000000000000000000000000abc01";

try {
  srv = await booting.catch((e) => fail(`paid server did not boot: ${e.message}`));
  B = srv.url;
  ok(true, "paid server booted with the market-data stub preload");
  // The first tick runs at boot; on a busy CI runner (the boot revenue snapshot
  // reaches public RPCs) it can land well after /health answers.
  const warmed = await waitFor(() => db.range >= 1, 30_000);
  let warmerState = "";
  if (!warmed) { try { warmerState = JSON.stringify((await (await perf()).json())?.stockQuoteWarmer?.lastTick ?? null); } catch (e) { warmerState = `perf read failed: ${e?.message}`; } }
  ok(warmed, `the boot-started quote warmer read the session boundary from the stub (${db.range})${warmerState ? `; last tick: ${warmerState}` : ""}`);

  const unpaid = await fetch(`${B}/api/stock-history?symbol=MSFT&days=2`);
  ok(unpaid.status === 402, `unpaid stock-history -> 402 (got ${unpaid.status})`);
  const accepted = (JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString("utf-8")).accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(!!accepted, "stock-history offers exact on Base");

  // a. x402
  const before = timingLines().length;
  const r = await fetch(`${B}/api/stock-history?symbol=MSFT&days=2`, { headers: { "payment-signature": credential(accepted, PAYER), "x-forwarded-for": "10.88.0.1" } });
  const body = await r.json();
  ok(r.status === 200 && body.bars?.at(-1)?.close === 150 && db.data === 1, `x402 buy -> 200 with bars read from the upstream (got ${r.status}, close ${body.bars?.at(-1)?.close}, reads ${db.data})`);
  ok(await waitFor(() => timingLines().length > before), "a [paid-timing] line was written for the call");
  const line = timingLines().at(-1);
  console.log(`   ${line}`);
  ok(line.includes(" stock-history ") && field(line, "rail") === "x402" && field(line, "net") === "eip155:8453" && field(line, "status") === "200" && field(line, "gone") === "no",
    "a. the line names the slug, rail=x402, the Base network, status 200, gone=no");
  ok(near(msOf(line, "verify"), VERIFY_MS), `a. verify time matches the facilitator's injected ${VERIFY_MS} ms (${msOf(line, "verify")})`);
  ok(near(msOf(line, "handler"), DATA_MS), `a. handler time matches the upstream's injected ${DATA_MS} ms (${msOf(line, "handler")})`);
  ok(near(msOf(line, "settle"), SETTLE_MS), `a. settle time matches the facilitator's injected ${SETTLE_MS} ms (${msOf(line, "settle")})`);
  ok(msOf(line, "total") >= VERIFY_MS + DATA_MS + SETTLE_MS, `a. total covers all three phases (${msOf(line, "total")})`);
  ok(!line.toLowerCase().includes(PAYER.toLowerCase()) && !line.includes(TX) && !line.includes(TX.slice(2, 20)) && !line.includes("MSFT"), "d. the line carries no payer, no transaction hash and no input");

  // A warm repeat: the handler phase collapses.
  await fetch(`${B}/api/stock-history?symbol=MSFT&days=2`, { headers: { "payment-signature": credential(accepted, PAYER), "x-forwarded-for": "10.88.0.2" } });
  ok(await waitFor(() => timingLines().length > before + 1), "a second line for the warm repeat");
  const warmLine = timingLines().at(-1);
  console.log(`   ${warmLine}`);
  ok(msOf(warmLine, "handler") < 50, `a warm symbol's handler phase is near zero (${msOf(warmLine, "handler")} ms)`);

  // b. MPP evm (native wire, stock mppx client): x402 underneath, filed under mpp-evm.
  const { Fetch, evm } = await import("mppx/client");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const mppFetch = Fetch.from({ methods: [evm.charge({ account: privateKeyToAccount(generatePrivateKey()), currencies: [evm.assets.base.USDC], maxAmount: "1.00" })] });
  const n0 = timingLines().length;
  const m = await mppFetch(`${B}/api/stock-history?symbol=ORCL&days=2`);
  ok(m.status === 200, `MPP evm buy -> 200 (got ${m.status})`);
  ok(await waitFor(() => timingLines().length > n0), "a line for the MPP call");
  const mline = timingLines().at(-1);
  console.log(`   ${mline}`);
  ok(field(mline, "rail") === "mpp-evm" && field(mline, "net") === "eip155:8453", `b. the MPP call is filed under rail=mpp-evm (${field(mline, "rail")})`);
  ok(near(msOf(mline, "verify"), VERIFY_MS) && near(msOf(mline, "settle"), SETTLE_MS) && near(msOf(mline, "handler"), DATA_MS), "b. its three phases are measured too");

  // c. a buyer who hangs up mid-handler.
  db.slowDataMs = 1500;
  const settles0 = fac.settle, n1 = timingLines().length, d0 = db.data;
  await new Promise((resolve) => {
    const rq = httpRequest(`${B}/api/stock-history?symbol=NVDA&days=2`, { headers: { "payment-signature": credential(accepted, "0x00000000000000000000000000000000000abc02"), "x-forwarded-for": "10.88.0.3" } });
    rq.on("error", () => resolve()); rq.on("response", (x) => { x.resume(); resolve(); });
    rq.end();
    waitFor(() => db.data > d0, 5000).then(() => sleep(150)).then(() => { rq.destroy(); resolve(); });
  });
  ok(await waitFor(() => timingLines().length > n1, 6000), "a line for the abandoned call (written once the handler ends)");
  const gline = timingLines().at(-1);
  console.log(`   ${gline}`);
  db.slowDataMs = 0;
  ok(field(gline, "gone") === "before-first-byte", `c. the abandoned call is marked gone=before-first-byte (${field(gline, "gone")})`);
  ok(near(msOf(gline, "handler"), 1500, 400), `c. its handler time is still measured to the handler's own end (${msOf(gline, "handler")})`);
  ok(fac.settle === settles0 && field(gline, "settle") === "-", `c. nothing settled for it (settles ${fac.settle - settles0}, settle=${field(gline, "settle")})`);

  // The operator summary, per rail.
  const p = await (await perf()).json();
  const x = p.paidPhases?.rails?.x402, mp = p.paidPhases?.rails?.["mpp-evm"];
  ok(x && x.calls === 3 && x.gone === 1 && mp && mp.calls === 1, `the summary files 3 calls (1 gone) under x402 and 1 under mpp-evm (${JSON.stringify({ x402: x?.calls, gone: x?.gone, mpp: mp?.calls })})`);
  const nets = Object.entries(x.byNetwork || {});
  ok(nets.length >= 1 && nets.reduce((a, [, v]) => a + v.calls, 0) === x.calls && nets.every(([n, v]) => n && v.settleMs && v.totalMs), `the x402 summary splits its calls by network, each with its own settle and total figures (${JSON.stringify(Object.fromEntries(nets.map(([n, v]) => [n, v.calls])))})`);
  ok(near(x.verifyMs.p50, VERIFY_MS) && near(x.settleMs.p50, SETTLE_MS) && x.handlerMs.p95 >= DATA_MS, `the x402 summary carries p50/p95 per phase (${JSON.stringify({ v: x.verifyMs, h: x.handlerMs, s: x.settleMs })})`);
  // e. (2026-11-09) the departure is kept apart from the rolling window, with
  // how long the buyer waited and which phase it left in: the figure that
  // names a buyer client's timeout.
  const hg = Object.values(p.paidPhases?.hangups || {});
  const dep = hg.flatMap((h) => h.recent || []).find((r) => r.slug === "stock-history");
  ok(hg.length >= 1 && hg.reduce((a2, h) => a2 + h.count, 0) === 1, `e. one buyer departure is listed under its network (${JSON.stringify(p.paidPhases?.hangups ? Object.fromEntries(Object.entries(p.paidPhases.hangups).map(([k, v]) => [k, v.count])) : null)})`);
  ok(dep && dep.during === "handler" && dep.waitedMs >= 150 && dep.waitedMs < 1500, `e. it left during the handler, after the time the buyer actually waited (${JSON.stringify(dep)})`);
  ok(hg[0]?.minWaitMs === dep?.waitedMs && hg[0]?.byPhase?.handler === 1, "e. the network's summary carries the shortest wait and a count by phase");
  ok(p.stockQuoteWarmer && p.stockQuoteWarmer.running === true && typeof p.stockQuoteWarmer.background.calls === "number", "the warmer's counts ride the same operator surface");
  ok(!JSON.stringify(p.paidPhases).includes(PAYER.slice(2)) && !JSON.stringify(p.paidPhases).includes("MSFT"), "d. the summary carries no payer and no input");
  const anon = await perf(false);
  ok(anon.status === 404, `d. the summary is operator-only (${anon.status} without the token)`);
  const pub = await (await fetch(`${B}/api/gateway-status`)).text();
  ok(!/paidPhases|handlerMs|settleMs/.test(pub), "d. nothing of it reaches the public gateway status");
} catch (e) {
  fail(e?.stack || String(e));
}
cleanup();
console.log(`\nOK: ${pass} passed`);
process.exit(0);
