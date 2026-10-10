#!/usr/bin/env node
// Per-phase timing of paid calls, per rail (src/paid-phase-timing.js).
//
//   node scripts/test-paid-phase-timing.js     (offline: boots its own paid server)
//
// Boots the REAL server with the x402 paywall active, a stub facilitator with
// injected verify and settle delays, and a stub market-data upstream
// (scripts/lib/databento-stub-preload.js, which refuses to load without its
// stub) with an injected data delay. Then buys stock-quote:
//   a. over x402: the log line and the operator summary carry verify, handler
//      and settle times that match the injected delays, under rail=x402 and the
//      Base network;
//   b. over the native MPP wire (a stock mppx client): the same phases, filed
//      under rail=mpp-evm, not x402;
//   c. a buyer who hangs up mid-handler is marked gone, and nothing settles;
//   d. the summary is operator-only (404 without the token) and the log line
//      carries no payer address and no transaction hash.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";

let pass = 0, proc = null, facilitator = null, dbStub = null;
const serverLog = [];
const TMP = mkdtempSync(join(tmpdir(), "phase-timing-"));
const cleanup = () => { proc?.kill("SIGKILL"); facilitator?.close(); dbStub?.close(); rmSync(TMP, { recursive: true, force: true }); };
const fail = (m) => { console.error("FAIL:", m); for (const l of serverLog.slice(-25)) console.error("  server:", l); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(20); } return cond(); };

const [PORT, FAC_PORT, DB_PORT] = await getFreePorts(3);
const B = `http://127.0.0.1:${PORT}`;
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
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

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
await new Promise((r) => dbStub.listen(DB_PORT, "127.0.0.1", r));

proc = spawn("node", ["--import", "./scripts/lib/databento-stub-preload.js", "src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: SECRET, TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    DATABENTO_API_KEY: "db-test-key-not-real", DATABENTO_STUB_URL: `http://127.0.0.1:${DB_PORT}`, PAID_TIMING_LOG: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
    AGENT402_OPERATOR_TOKEN: OP, REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 600)); } };
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);
const timingLines = () => serverLog.filter((l) => l.startsWith("[paid-timing]"));
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
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up, "paid server booted with the market-data stub preload");
  ok(await waitFor(() => db.range >= 1), `the boot-started quote warmer read the session boundary from the stub (${db.range})`);

  const unpaid = await fetch(`${B}/api/stock-quote?symbol=MSFT`);
  ok(unpaid.status === 402, `unpaid stock-quote -> 402 (got ${unpaid.status})`);
  const accepted = (JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString("utf-8")).accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(!!accepted, "stock-quote offers exact on Base");

  // a. x402
  const before = timingLines().length;
  const r = await fetch(`${B}/api/stock-quote?symbol=MSFT`, { headers: { "payment-signature": credential(accepted, PAYER), "x-forwarded-for": "10.88.0.1" } });
  const body = await r.json();
  ok(r.status === 200 && body.price === 150 && body.cached === false, `x402 buy -> 200 with a fresh quote (got ${r.status}, cached ${body.cached})`);
  ok(await waitFor(() => timingLines().length > before), "a [paid-timing] line was written for the call");
  const line = timingLines().at(-1);
  console.log(`   ${line}`);
  ok(line.includes(" stock-quote ") && field(line, "rail") === "x402" && field(line, "net") === "eip155:8453" && field(line, "status") === "200" && field(line, "gone") === "no",
    "a. the line names the slug, rail=x402, the Base network, status 200, gone=no");
  ok(near(msOf(line, "verify"), VERIFY_MS), `a. verify time matches the facilitator's injected ${VERIFY_MS} ms (${msOf(line, "verify")})`);
  ok(near(msOf(line, "handler"), DATA_MS), `a. handler time matches the upstream's injected ${DATA_MS} ms (${msOf(line, "handler")})`);
  ok(near(msOf(line, "settle"), SETTLE_MS), `a. settle time matches the facilitator's injected ${SETTLE_MS} ms (${msOf(line, "settle")})`);
  ok(msOf(line, "total") >= VERIFY_MS + DATA_MS + SETTLE_MS, `a. total covers all three phases (${msOf(line, "total")})`);
  ok(!line.toLowerCase().includes(PAYER.toLowerCase()) && !line.includes(TX) && !line.includes(TX.slice(2, 20)) && !line.includes("MSFT"), "d. the line carries no payer, no transaction hash and no input");

  // A warm repeat: the handler phase collapses.
  await fetch(`${B}/api/stock-quote?symbol=MSFT`, { headers: { "payment-signature": credential(accepted, PAYER), "x-forwarded-for": "10.88.0.2" } });
  ok(await waitFor(() => timingLines().length > before + 1), "a second line for the warm repeat");
  const warmLine = timingLines().at(-1);
  console.log(`   ${warmLine}`);
  ok(msOf(warmLine, "handler") < 50, `a warm symbol's handler phase is near zero (${msOf(warmLine, "handler")} ms)`);

  // b. MPP evm (native wire, stock mppx client): x402 underneath, filed under mpp-evm.
  const { Fetch, evm } = await import("mppx/client");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const mppFetch = Fetch.from({ methods: [evm.charge({ account: privateKeyToAccount(generatePrivateKey()), currencies: [evm.assets.base.USDC], maxAmount: "1.00" })] });
  const n0 = timingLines().length;
  const m = await mppFetch(`${B}/api/stock-quote?symbol=ORCL`);
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
    const rq = httpRequest(`${B}/api/stock-quote?symbol=NVDA`, { headers: { "payment-signature": credential(accepted, "0x00000000000000000000000000000000000abc02"), "x-forwarded-for": "10.88.0.3" } });
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
  ok(near(x.verifyMs.p50, VERIFY_MS) && near(x.settleMs.p50, SETTLE_MS) && x.handlerMs.p95 >= DATA_MS, `the x402 summary carries p50/p95 per phase (${JSON.stringify({ v: x.verifyMs, h: x.handlerMs, s: x.settleMs })})`);
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
