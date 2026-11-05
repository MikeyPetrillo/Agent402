#!/usr/bin/env node
// What a throw in one of our x402 beforeVerify / beforeSettle hooks does.
// @x402/core (2.30.0 and later) refuses a payment whose beforeVerify hook
// throws and cancels the settle of one whose beforeSettle hook throws; every
// hook we register states its own choice (src/x402-hook-guard.js): a money or
// identity check, or a mark the books read after the settle, refuses with its
// own reason; a buyer courtesy with its own backstop passes.
//
// Part 1, in process, the real @x402/core resource server and @x402/express
// middleware with a stub facilitator client: each guarded hook forced to
// throw answers its declared choice; the Arc contract-wallet gate's throw is
// a 402 before the handler runs.
// Part 2, three paid-mode boots against a stub facilitator: with the wallet
// blocklist hook, or the settle-sent mark, forced to throw, a real signed
// payment answers 402 with no settle call, no booked sale and no idempotency
// commit; the control boot
// settles, books the sale and replays. A payment header that decodes to JSON
// that is not an object (array, string, null, number) answers 4xx, never 5xx.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok  ${msg}`); else { failures++; console.log(`  FAIL ${msg}`); } };

// Every dependency is required: a missing one fails the suite, never skips it.
const [{ x402ResourceServer }, { ExactEvmScheme }, express, { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer }, guard, payments, hangup, Database] = await Promise.all([
  import("@x402/core/server"), import("@x402/evm/exact/server"), import("express").then((m) => m.default),
  import("@x402/express"), import("../src/x402-hook-guard.js"), import("../src/payments.js"), import("../src/hangup-settlement.js"),
  import("better-sqlite3").then((m) => m.default),
]);
const { HOOK_NAMES, _setHookFaultsForTest, ARC_CONTRACT_WALLET_CHECK_FAILED, WALLET_CHECK_FAILED, SETTLE_MARK_FAILED } = guard;

// ------------------------------------------------------------ part 1
console.log("part 1: each guarded hook against the real resource server");
const BASE_NET = "eip155:8453";
const { ARC_CAIP2: ARC } = await import("../src/circle-supported.js");
if (ARC !== "eip155:5042") throw new Error(`Arc network id read as ${ARC}`);
const PAYTO = "0x000000000000000000000000000000000000dEaD";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function stubFacilitator() {
  const calls = { verify: 0, settle: 0 };
  return {
    calls,
    async getSupported() { return { kinds: [BASE_NET, ARC].map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} }; },
    async verify(p) { calls.verify++; return { isValid: true, payer: p?.payload?.authorization?.from }; },
    async settle(p, r) { calls.settle++; return { success: true, transaction: "0x" + "5e".repeat(32), network: r.network, payer: p?.payload?.authorization?.from }; },
  };
}
const requirementsFor = (network) => ({ scheme: "exact", network, asset: USDC_BASE, amount: "1000", payTo: PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
const payloadFor = (network, from = "0x" + "ab".repeat(20)) => ({
  x402Version: 2, accepted: requirementsFor(network), resource: { url: "http://x/api/uuid" },
  payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: PAYTO, value: "1000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomUUID().replace(/-/g, "").padEnd(64, "0") } },
});
async function resourceServer(register) {
  const fac = stubFacilitator();
  const server = new x402ResourceServer(fac).register(BASE_NET, new ExactEvmScheme()).register(ARC, new ExactEvmScheme());
  await server.initialize();
  register(server);
  return { server, fac };
}
const settleOf = async (server, payload, req) => {
  try { return await server.settlePayment(payload, payload.accepted, undefined, req ? { request: { adapter: { req } } } : undefined); }
  catch (e) { return e?.name === "SettleError" ? { thrown: true, ...e.response, errorReason: e.response?.errorReason ?? e.errorReason } : { thrown: true, error: String(e?.message || e) }; }
};
// Capture the guard's log line, so a hook whose wrapper is gone (its fault
// never fires) cannot pass a "pass on throw" case by doing nothing.
async function withLogs(fn) {
  const lines = []; const w = console.warn, e = console.error;
  console.warn = (...a) => { lines.push(a.join(" ")); }; console.error = (...a) => { lines.push(a.join(" ")); };
  try { return { out: await fn(), lines }; } finally { console.warn = w; console.error = e; }
}

{
  // Wallet blocklist (beforeSettle): refuses with its own reason.
  const { server, fac } = await resourceServer((s) => payments.registerWalletBlocklistHook(s));
  const control = await settleOf(server, payloadFor(BASE_NET));
  ok(control.success === true && fac.calls.settle === 1, `blocklist control: an unblocked payer settles (${JSON.stringify(control).slice(0, 120)})`);
  const prev = process.env.WALLET_BLOCKLIST;
  process.env.WALLET_BLOCKLIST = "0x" + "cd".repeat(20);
  const blocked = await settleOf(server, payloadFor(BASE_NET, "0x" + "cd".repeat(20)));
  if (prev === undefined) delete process.env.WALLET_BLOCKLIST; else process.env.WALLET_BLOCKLIST = prev;
  ok(blocked.thrown && blocked.errorReason === "wallet_blocked" && fac.calls.settle === 1, `blocklist: a listed payer is refused as before (${blocked.errorReason})`);
  _setHookFaultsForTest([HOOK_NAMES.walletBlocklist]);
  const { out: faulted, lines } = await withLogs(() => settleOf(server, payloadFor(BASE_NET)));
  _setHookFaultsForTest(null);
  ok(faulted.thrown && faulted.errorReason === WALLET_CHECK_FAILED, `blocklist: a throw refuses with ${WALLET_CHECK_FAILED}, not the library's default (${faulted.errorReason})`);
  ok(fac.calls.settle === 1, `blocklist: a throw makes no settle call (settles ${fac.calls.settle})`);
  ok(lines.some((l) => l.includes(`${HOOK_NAMES.walletBlocklist} failed, payment refused`)), "blocklist: the refusal is logged by name");
}

{
  // Client-gone cancel (beforeSettle): a throw passes, the payment settles.
  const { server, fac } = await resourceServer((s) => payments.registerClientGoneSettleHook(s));
  _setHookFaultsForTest([HOOK_NAMES.clientGone]);
  const { out, lines } = await withLogs(() => settleOf(server, payloadFor(BASE_NET), { headers: {} }));
  _setHookFaultsForTest(null);
  ok(out.success === true && fac.calls.settle === 1, `client-gone: a throw passes and the payment settles (${JSON.stringify(out).slice(0, 120)})`);
  ok(lines.some((l) => l.includes(`${HOOK_NAMES.clientGone} failed, payment goes on`)), "client-gone: the fault fired and was logged by name");
}

{
  // Settle-sent mark (beforeSettle): a settle it did not mark would be booked
  // as a forgiven hang-up, so a throw refuses with its own reason and the
  // facilitator is never called. Without a fault the mark is set and the
  // payment settles, as before.
  const { server, fac } = await resourceServer((s) => hangup.registerSettleSentHook(s));
  const req = { headers: {} };
  const control = await settleOf(server, payloadFor(BASE_NET), req);
  ok(control.success === true && fac.calls.settle === 1 && hangup.settleSentWhileConnected(req), `settle-sent control: the mark is set and the payment settles (${JSON.stringify(control).slice(0, 120)})`);
  _setHookFaultsForTest([HOOK_NAMES.settleSent]);
  const faultReq = { headers: {} };
  const { out, lines } = await withLogs(() => settleOf(server, payloadFor(BASE_NET), faultReq));
  _setHookFaultsForTest(null);
  ok(out.thrown && out.errorReason === SETTLE_MARK_FAILED, `settle-sent: a throw refuses with ${SETTLE_MARK_FAILED}, not the library's default (${out.errorReason})`);
  ok(fac.calls.settle === 1, `settle-sent: a throw makes no settle call (settles ${fac.calls.settle})`);
  ok(!hangup.settleSentWhileConnected(faultReq), "settle-sent: the refused settle is not marked sent");
  ok(lines.some((l) => l.includes(`${HOOK_NAMES.settleSent} failed, payment refused`)), "settle-sent: the refusal is logged by name");
}

{
  // Arc contract-wallet gate (beforeVerify), through the real middleware: a
  // throw is a 402 naming its reason, before the handler and before verify.
  const fac = stubFacilitator();
  const server = new x402ResourceServer(fac).register(BASE_NET, new ExactEvmScheme()).register(ARC, new ExactEvmScheme());
  payments.registerArcContractWalletRouteGate(server, new Set(["GET /api/uuid"]));
  const routes = { "GET /api/uuid": { accepts: [{ scheme: "exact", network: ARC, payTo: PAYTO, price: { amount: "1000", asset: USDC_BASE, extra: { name: "USDC", version: "2" } }, maxTimeoutSeconds: 300 }], description: "uuid" } };
  const http = new x402HTTPResourceServer(server, routes);
  await http.initialize();
  let handlerRuns = 0;
  const app = express();
  app.use(paymentMiddlewareFromHTTPServer(http, undefined, undefined, false));
  app.get("/api/uuid", (_req, res) => { handlerRuns++; res.json({ uuid: randomUUID() }); });
  const [p] = await getFreePorts(1);
  const listener = await new Promise((r) => { const l = app.listen(p, "127.0.0.1", () => r(l)); });
  try {
    const unpaid = await fetch(`http://127.0.0.1:${p}/api/uuid`);
    const accepted = JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString()).accepts[0];
    const header = (from) => Buffer.from(JSON.stringify({ ...payloadFor(ARC, from), accepted })).toString("base64");
    _setHookFaultsForTest([HOOK_NAMES.arcContractWalletGate]);
    const { out: r, lines } = await withLogs(async () => { const res = await fetch(`http://127.0.0.1:${p}/api/uuid`, { headers: { "payment-signature": header() } }); return { status: res.status, text: await res.text(), pr: res.headers.get("payment-required") || "" }; });
    _setHookFaultsForTest(null);
    const pr = r.pr ? Buffer.from(r.pr, "base64").toString() : "";
    ok(r.status === 402, `arc gate: a throw answers 402 (${r.status})`);
    ok(`${r.text} ${pr}`.includes(ARC_CONTRACT_WALLET_CHECK_FAILED) && !`${r.text} ${pr}`.includes("before_verify_hook_error"), `arc gate: the 402 names ${ARC_CONTRACT_WALLET_CHECK_FAILED}, not the library default (${`${r.text} ${pr}`.slice(0, 200)})`);
    ok(handlerRuns === 0 && fac.calls.verify === 0 && fac.calls.settle === 0, `arc gate: nothing ran: handler ${handlerRuns}, verify ${fac.calls.verify}, settle ${fac.calls.settle}`);
    ok(lines.some((l) => l.includes(`${HOOK_NAMES.arcContractWalletGate} failed, payment refused`)), "arc gate: the refusal is logged by name");
    // Control: with no fault the same request passes the gate's throw path
    // and reaches its own route rule (an unparseable signature reads as a
    // contract wallet, which /api/uuid accepts), then verify and the handler.
    const ctl = await fetch(`http://127.0.0.1:${p}/api/uuid`, { headers: { "payment-signature": header() } });
    await ctl.text();
    ok(ctl.status === 200 && handlerRuns === 1 && fac.calls.verify === 1 && fac.calls.settle === 1, `arc gate control: with no fault the payment verifies, runs and settles (${ctl.status}, handler ${handlerRuns}, verify ${fac.calls.verify}, settle ${fac.calls.settle})`);
  } finally { listener.close(); }
}

{
  // The same gate with a throw from inside its async body (its clock), not
  // the seam: the rejection is caught too, and verify is never called.
  const { server, fac } = await resourceServer((s) => payments.registerArcContractWalletRouteGate(s, new Set(["GET /api/uuid"]), { now: () => { throw new Error("clock unavailable"); } }));
  const req = { method: "GET", path: "/api/uuid", ip: "127.0.0.1" };
  const { out, lines } = await withLogs(() => server.verifyPayment(payloadFor(ARC), requirementsFor(ARC), undefined, { request: { adapter: { req } } }));
  ok(out?.isValid === false && out.invalidReason === ARC_CONTRACT_WALLET_CHECK_FAILED, `arc gate: a rejection inside the async check refuses with ${ARC_CONTRACT_WALLET_CHECK_FAILED} (${out?.invalidReason})`);
  ok(fac.calls.verify === 0, `arc gate: the facilitator is never asked (verify ${fac.calls.verify})`);
  ok(lines.some((l) => l.includes("clock unavailable")), "arc gate: the logged refusal carries the thrown error");
}

// ------------------------------------------------------------ part 2
console.log("part 2: paid-mode boots against a stub facilitator");
const [CTL_PORT, FAULT_PORT, MARK_PORT, FAC_PORT] = await getFreePorts(4);
const fac = { verify: 0, settle: 0 };
let txN = 0;
const facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE_NET }], extensions: [], signers: {} });
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
      const balanceOf = rpc.method === "eth_call" && String(rpc.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply({ jsonrpc: "2.0", id: rpc.id ?? 1, result: balanceOf ? "0x" + (1_000_000_000).toString(16).padStart(64, "0") : "0x0" });
    }
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { fac.verify++; return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { fac.settle++; return reply({ success: true, transaction: "0x" + (++txN).toString(16).padStart(64, "0"), network: BASE_NET, payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const procs = [];
function boot(port, extra) {
  const stores = ownStoreEnv(`hook-throws-${port}`);
  const env = { ...process.env, ...stores };
  delete env.REDIS_URL; delete env.STATE_DATABASE_URL;
  const proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...env, PORT: String(port), FREE_MODE: "", NODE_ENV: "test", NETWORK: "base", PAYMENT_NETWORKS: "base", WALLET_ADDRESS: PAYTO,
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "",
      MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "", OPENROUTER_API_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
      FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      STATS_ALLOW_EPHEMERAL: "true", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000", FIRST_CALL_ALLOWANCE: "", WALLET_BLOCKLIST: "",
      ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  proc.stdout.on("data", (d) => log.push(String(d))); proc.stderr.on("data", (d) => log.push(String(d)));
  procs.push(proc);
  return { base: `http://127.0.0.1:${port}`, proc, log, salesDb: stores.SALES_LEDGER_DB };
}
async function up(s) {
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${s.base}/health`)).ok) return true; } catch { /* booting */ } await sleep(250); }
  throw new Error(`server did not boot: ${s.log.join("").slice(-1500)}`);
}
const salesRows = (s) => {
  try { const db = new Database(s.salesDb, { readonly: true }); try { return db.prepare("SELECT slug, tx FROM sales").all(); } finally { db.close(); } }
  catch (e) { if (/no such table|unable to open/.test(String(e?.message))) return []; throw e; }
};

try {
  const ctl = boot(CTL_PORT, {});
  const flt = boot(FAULT_PORT, { X402_HOOK_FAULT_FOR_TEST: HOOK_NAMES.walletBlocklist });
  const mrk = boot(MARK_PORT, { X402_HOOK_FAULT_FOR_TEST: HOOK_NAMES.settleSent });
  await Promise.all([up(ctl), up(flt), up(mrk)]);
  const [{ privateKeyToAccount, generatePrivateKey }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] =
    await Promise.all([import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch")]);
  // Mint one genuine signed payment header against a server's 402.
  async function mint(s, path) {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    let minted = null, name = null;
    const capturing = async (input, init) => {
      const r = input instanceof Request ? input : new Request(input, init);
      for (const n of ["payment-signature", "x-payment"]) { const v = r.headers.get(n); if (v) { minted = v; name = n; } }
      if (minted) return new Response("{}", { status: 402, headers: { "Content-Type": "application/json" } });
      return fetch(input, init);
    };
    await wrapFetchWithPayment(capturing, client)(`${s.base}${path}`).catch(() => {});
    if (!minted) throw new Error(`no payment header minted for ${path}`);
    return { name, value: minted };
  }
  const settledSales = async (s, n) => { for (let i = 0; i < 60; i++) { const rows = salesRows(s); if (rows.length >= n) return rows; await sleep(100); } return salesRows(s); };

  // Control: a signed payment settles, books a sale, and its resend with the
  // same Idempotency-Key is the stored answer.
  {
    const pay = await mint(ctl, "/api/uuid");
    const key = `hook-throws-${randomUUID()}`;
    const v0 = fac.verify, s0 = fac.settle;
    const r = await fetch(`${ctl.base}/api/uuid`, { headers: { [pay.name]: pay.value, "Idempotency-Key": key } });
    const body = await r.json().catch(() => null);
    ok(r.status === 200 && body && typeof body === "object", `control: a signed payment is served (${r.status} ${JSON.stringify(body).slice(0, 80)})`);
    ok(fac.verify - v0 === 1 && fac.settle - s0 === 1, `control: one verify, one settle (${fac.verify - v0}, ${fac.settle - s0})`);
    const rows = await settledSales(ctl, 1);
    ok(rows.length === 1 && rows[0].slug === "uuid", `control: the sale is booked (${JSON.stringify(rows)})`);
    const again = await fetch(`${ctl.base}/api/uuid`, { headers: { [pay.name]: pay.value, "Idempotency-Key": key } });
    const againBody = await again.json().catch(() => null);
    ok(again.status === 200 && JSON.stringify(againBody) === JSON.stringify(body) && fac.settle - s0 === 1, `control: the resend is the committed answer, no second settle (${again.status})`);
  }

  // The wallet blocklist hook forced to throw: 402, no settle, no sale, no
  // idempotency commit; the reason is the hook's own.
  {
    const pay = await mint(flt, "/api/uuid");
    const key = `hook-throws-${randomUUID()}`;
    const v0 = fac.verify, s0 = fac.settle;
    const r = await fetch(`${flt.base}/api/uuid`, { headers: { [pay.name]: pay.value, "Idempotency-Key": key } });
    const text = await r.text();
    const resp = r.headers.get("payment-response") || r.headers.get("x-payment-response") || "";
    const decoded = resp ? Buffer.from(resp, "base64").toString() : "";
    ok(r.status === 402, `fault: the blocklist hook's throw answers 402 (${r.status})`);
    ok(`${text} ${decoded}`.includes(WALLET_CHECK_FAILED), `fault: the answer names ${WALLET_CHECK_FAILED} (${`${text} ${decoded}`.slice(0, 240)})`);
    ok(fac.verify - v0 === 1 && fac.settle - s0 === 0, `fault: verified once, never settled (${fac.verify - v0}, ${fac.settle - s0})`);
    await sleep(500);
    ok(salesRows(flt).length === 0, `fault: no sale is booked (${JSON.stringify(salesRows(flt))})`);
    const again = await fetch(`${flt.base}/api/uuid`, { headers: { [pay.name]: pay.value, "Idempotency-Key": key } });
    await again.text();
    ok(again.status === 402 && !again.headers.get("x-replayed-answer") && !again.headers.get("x-idempotent-replay") && fac.settle - s0 === 0, `fault: nothing was committed under the key or the payment (resend ${again.status}, replayed ${again.headers.get("x-replayed-answer") || again.headers.get("x-idempotent-replay") || "no"})`);
    ok(flt.log.join("").includes(`${HOOK_NAMES.walletBlocklist} failed, payment refused`), "fault: the server logged the refusal by name");
  }

  // The settle-sent mark forced to throw: 402 naming its reason, no settle,
  // no sale, nothing committed.
  {
    const pay = await mint(mrk, "/api/uuid");
    const key = `hook-throws-${randomUUID()}`;
    const v0 = fac.verify, s0 = fac.settle;
    const r = await fetch(`${mrk.base}/api/uuid`, { headers: { [pay.name]: pay.value, "Idempotency-Key": key } });
    const text = await r.text();
    const resp = r.headers.get("payment-response") || r.headers.get("x-payment-response") || "";
    const decoded = resp ? Buffer.from(resp, "base64").toString() : "";
    ok(r.status === 402, `settle-sent fault: the mark's throw answers 402 (${r.status})`);
    ok(`${text} ${decoded}`.includes(SETTLE_MARK_FAILED), `settle-sent fault: the answer names ${SETTLE_MARK_FAILED} (${`${text} ${decoded}`.slice(0, 240)})`);
    ok(fac.verify - v0 === 1 && fac.settle - s0 === 0, `settle-sent fault: verified once, never settled (${fac.verify - v0}, ${fac.settle - s0})`);
    await sleep(500);
    ok(salesRows(mrk).length === 0, `settle-sent fault: no sale is booked (${JSON.stringify(salesRows(mrk))})`);
    const again = await fetch(`${mrk.base}/api/uuid`, { headers: { [pay.name]: pay.value, "Idempotency-Key": key } });
    await again.text();
    ok(again.status === 402 && !again.headers.get("x-replayed-answer") && !again.headers.get("x-idempotent-replay") && fac.settle - s0 === 0, `settle-sent fault: nothing was committed (resend ${again.status})`);
    ok(mrk.log.join("").includes(`${HOOK_NAMES.settleSent} failed, payment refused`), "settle-sent fault: the server logged the refusal by name");
  }

  // A payment header that decodes to JSON that is not an object.
  {
    const shapes = { array: [], arrayOfObject: [{ x402Version: 2 }], string: "payment", null: null, number: 42, bool: true };
    const targets = [["GET", "/api/uuid"], ["POST", "/v1/nano/chat/completions"], ["GET", "/api/memory?key=a"], ["POST", "/api/memory"]];
    const s0 = fac.settle;
    const seen = [];
    for (const s of [ctl, flt]) {
      for (const [label, value] of Object.entries(shapes)) {
        const enc = Buffer.from(JSON.stringify(value)).toString("base64");
        for (const headerName of ["payment-signature", "x-payment"]) {
          for (const [method, path] of targets) {
            const r = await fetch(`${s.base}${path}`, { method, headers: { [headerName]: enc, "content-type": "application/json", "Idempotency-Key": `odd-${randomUUID()}` }, body: method === "POST" ? JSON.stringify(path.startsWith("/v1/") ? { messages: [{ role: "user", content: "hi" }], max_tokens: 4 } : { key: "a", value: "b" }) : undefined });
            await r.text();
            seen.push(`${label}/${headerName}/${path}=${r.status}`);
            if (!(r.status >= 400 && r.status < 500)) ok(false, `non-object header ${label} in ${headerName} on ${method} ${path} answers 4xx (${r.status})`);
          }
        }
      }
    }
    const bad = seen.filter((x) => !/=4\d\d$/.test(x));
    ok(bad.length === 0, `every non-object payment header answers 4xx, never 5xx (${seen.length} requests; ${bad.length ? bad.join(", ") : "statuses " + [...new Set(seen.map((x) => x.slice(x.lastIndexOf("=") + 1)))].join(",")})`);
    ok(fac.settle === s0, "no non-object header reached a settle");
    ok(![ctl, flt].some((s) => /TypeError|Cannot read properties of null/.test(s.log.join(""))), "no server logged a TypeError from a non-object header");
  }
} finally {
  for (const p of procs) p.kill("SIGKILL");
  facilitator.close();
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall x402 hook-throw checks passed");
process.exit(0);
