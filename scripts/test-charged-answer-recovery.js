#!/usr/bin/env node
// A charged answer stays deliverable (src/charged-answer-recovery.js): a
// settled answer whose buyer left before it arrived is kept, and a retry that
// carries the SAME signed payment for the same route and input is served it
// with 200 and the original receipt, settling nothing; the hang-up debt booked
// for it is voided only once that replay has actually been delivered.
//
// Part 1 drives the middleware in a plain express app behind a fake buffered
// gate, with a real Redis for the shared half:
//   a hang-up after the gate settled -> kept; the retry gets the same bytes;
//   a different credential, query, body or route -> passed on to the gates;
//   an identity-bound route, a stream, a 402, a delivered answer -> not kept;
//   the original still finishing -> 409 with Retry-After;
//   a replay whose buyer leaves before it finishes -> no delivery recorded;
//   TTL expiry -> passed on; the stored value is sealed (no plaintext);
//   a record kept by one store is replayed by a second store on one Redis.
// Part 2 boots TWO real paid servers on that Redis against a stub
// facilitator and sends real payments:
//   a. a connected buyer: nothing kept;
//   b. a close during a slow settle: a retry while the settle runs -> 409 +
//      Retry-After; after it -> 200, same body twice, no second settle, the
//      debt voided "delivered on retry"; the planner held it meanwhile;
//   c. the same payment from another server -> the same answer;
//   d. the same nonce from another payer, another query, another route ->
//      refused, nothing settled, the answer never shown;
//   e. a hang-up past the forgiveness budget (server B) -> kept and served on A;
//   f. a hang-up inside the budget (not settled) -> nothing kept, refused as before;
//   h. a memory write (identity-bound) -> never kept here; with an
//      Idempotency-Key the settled hang-up replays from that cache;
//   g. TTL expiry -> refused as before.
//
//   node scripts/test-charged-answer-recovery.js           (starts a local redis-server)
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-charged-answer-recovery.js
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createClient } from "redis";
import { getFreePort, getFreePorts } from "./lib/free-port.js";

let pass = 0, redisChild = null, facilitator = null;
const procs = [];
const serverLog = [];
const TMP = mkdtempSync(join(tmpdir(), "a402-recovery-"));
const cleanup = () => { for (const p of procs) p.kill("SIGKILL"); facilitator?.close(); redisChild?.kill("SIGKILL"); try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } };
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of serverLog.slice(-40)) console.error("  server:", l); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(25); } return cond(); };
process.on("uncaughtException", (e) => fail(`uncaught: ${e?.stack || e}`));

// ---- redis -------------------------------------------------------------------
const redisPing = (port) => new Promise((resolve) => {
  const s = connect(port, "127.0.0.1"); let buf = "";
  s.setTimeout(500, () => { s.destroy(); resolve(false); });
  s.on("error", () => resolve(false));
  s.on("connect", () => s.write("PING\r\n"));
  s.on("data", (d) => { buf += d; if (buf.includes("PONG")) { s.end(); resolve(true); } });
});
let REDIS_URL = (process.env.REDIS_URL || "").trim();
if (!REDIS_URL) {
  const candidates = ["/opt/homebrew/bin/redis-server", "/usr/local/bin/redis-server", "/usr/bin/redis-server"];
  let bin = candidates.find((p) => existsSync(p));
  if (!bin) { try { bin = execFileSync("which", ["redis-server"], { encoding: "utf8" }).trim(); } catch { bin = ""; } }
  if (!bin) fail("no REDIS_URL and no redis-server binary: the cross-server half needs a real redis and does not skip");
  const port = await getFreePort();
  redisChild = spawn(bin, ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", TMP], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await sleep(100); up = await redisPing(port); }
  if (!up) fail("redis-server did not answer");
  REDIS_URL = `redis://127.0.0.1:${port}`;
  console.log(`# started redis-server on ${port}`);
}
// Every key this run writes carries its own prefix-free namespace: a fresh
// secret per run makes every record id unique to this run.
const SECRET = `recovery-test-${process.pid}-${Date.now()}`;
process.env.CHARGED_ANSWER_SECRET = SECRET;
const rc = createClient({ url: REDIS_URL });
await rc.connect();

const rec = await import("../src/charged-answer-recovery.js");
const { createChargedAnswerRecovery, createRecoveryStore, paymentCredentialOf, KEPT_NOTE_PREFIX, DELIVERED_NOTE } = rec;
const { createHangupSettlementHook } = await import("../src/hangup-settlement.js");

// ---------------------------------------------------------------- part 1
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` })); });
// Send a request and destroy the socket after `ms`, before any reply.
const hangUp = (url, { method = "GET", headers = {}, body = null, ms = 80 } = {}) => new Promise((resolve) => {
  const req = httpRequest(url, { method, headers });
  let done = false; const finish = () => { if (!done) { done = true; resolve(); } };
  req.on("error", finish); req.on("response", (r) => { r.resume(); finish(); });
  if (body) req.write(body);
  req.end();
  setTimeout(() => { req.destroy(); finish(); }, ms);
});
const cred = (n, from = "0x" + "a1".repeat(20)) => Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x" + "11".repeat(65), authorization: { from, nonce: "0x" + n.toString(16).padStart(64, "0") } } })).toString("base64");
const RECEIPT = (tx) => Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "eip155:8453" })).toString("base64");

// A fake app: the hang-up hook, the recovery middleware, then a gate that
// buffers the handler's end for `gateMs`, "settles" (sets the receipt) and
// writes it, the way every paid gate does.
function buildApp({ store, delivered, kept, gateMs = 300, identityBound = new Set(["/api/mem"]), passes }) {
  const app = express();
  app.use(express.json());
  app.use(createHangupSettlementHook({ onUndelivered: () => {} }));
  app.use(createChargedAnswerRecovery({
    store,
    routeOf: (req) => (req.path.startsWith("/api/") ? { slug: req.path.slice(5), identityBound: identityBound.has(req.path) } : null),
    evidenceOf: (req, res) => { const r = res.getHeader("PAYMENT-RESPONSE"); return r ? { tx: JSON.parse(Buffer.from(String(r), "base64").toString()).transaction } : null; },
    onDelivered: (info) => delivered.push(info),
    onKept: (info) => kept.push(info),
    log: { warn: () => {} },
  }));
  let n = 0;
  app.use((req, res, next) => {
    passes.push(req.path);
    const realEnd = res.end.bind(res);
    res.end = (...args) => { setTimeout(() => { if (res.statusCode === 200 && req.query.settle !== "no") res.setHeader("PAYMENT-RESPONSE", RECEIPT("0x" + "ab".repeat(31) + String(++n).padStart(2, "0"))); realEnd(...args); }, gateMs); return res; };
    next();
  });
  app.get("/api/answer", (req, res) => res.json({ answer: `secret-${Math.random().toString(36).slice(2)}`, q: req.query.q || null }));
  app.post("/api/echo", (req, res) => res.json({ echoed: req.body, nonce: Math.random() }));
  app.get("/api/mem", (_req, res) => res.json({ mine: "private" }));
  app.get("/api/stream", (_req, res) => { res.setHeader("content-type", "text/event-stream"); res.end("data: x\n\n"); });
  app.get("/api/refused", (_req, res) => res.status(402).json({ error: "no" }));
  return app;
}

{
  const redisFn = async () => rc;
  const storeA = createRecoveryStore({ redis: redisFn });
  const storeB = createRecoveryStore({ redis: redisFn }); // a second replica: empty local mirror
  const delivered = [], kept = [], passes = [];
  const { server, url } = await listen(buildApp({ store: storeA, delivered, kept, passes }));
  const deliveredB = [], keptB = [], passesB = [];
  const { server: serverB, url: urlB } = await listen(buildApp({ store: storeB, delivered: deliveredB, kept: keptB, passes: passesB }));

  // 1a. hang-up after the handler, before the gate wrote: kept.
  const c1 = cred(0x101);
  await hangUp(`${url}/api/answer?q=1`, { headers: { "payment-signature": c1 } });
  ok(await waitFor(() => kept.length === 1, 3000), `1a. a settled answer whose buyer left is kept (${kept.length})`);
  const passed = passes.length;
  const r1 = await fetch(`${url}/api/answer?q=1`, { headers: { "payment-signature": c1 } });
  const body1 = await r1.text();
  ok(r1.status === 200 && r1.headers.get("x-payment-recovered") === "true" && /secret-/.test(body1) && passes.length === passed, `1a. the retry with the same payment is replayed before the gate (${r1.status}, gate runs +${passes.length - passed})`);
  ok(JSON.parse(Buffer.from(r1.headers.get("payment-response"), "base64").toString()).transaction.startsWith("0xabab"), "1a. the replay carries the original receipt");
  ok(await waitFor(() => delivered.length === 1) && delivered[0].tx && delivered[0].slug === "answer", `1a. delivery is recorded with the settlement evidence (${JSON.stringify(delivered[0] && { tx: delivered[0].tx, slug: delivered[0].slug })})`);
  const r1b = await fetch(`${url}/api/answer?q=1`, { headers: { "payment-signature": c1 } });
  ok(r1b.status === 200 && (await r1b.text()) === body1, "1a. a second retry gets the identical bytes");

  // 1b. the bindings: another credential, query, route or body passes on.
  const before = passes.length;
  const other = await fetch(`${url}/api/answer?q=1`, { headers: { "payment-signature": cred(0x101, "0x" + "b2".repeat(20)) } });
  const otherBody = await other.text();
  ok(other.headers.get("x-payment-recovered") === null && !otherBody.includes(JSON.parse(body1).answer) && passes.length === before + 1, "1b. the same nonce signed by another payer is passed on to the gate, never served the answer");
  const q2 = await fetch(`${url}/api/answer?q=2`, { headers: { "payment-signature": c1 } });
  ok(q2.headers.get("x-payment-recovered") === null && !(await q2.text()).includes(JSON.parse(body1).answer), "1b. the same payment with another query is passed on");
  const route2 = await fetch(`${url}/api/echo`, { method: "POST", headers: { "payment-signature": c1, "content-type": "application/json" }, body: "{}" });
  ok(route2.headers.get("x-payment-recovered") === null, "1b. the same payment on another route is passed on");
  const c2 = cred(0x102);
  await hangUp(`${url}/api/echo`, { method: "POST", headers: { "payment-signature": c2, "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
  ok(await waitFor(() => kept.length === 2, 3000), "1b. a POST answer is kept");
  const b2 = await fetch(`${url}/api/echo`, { method: "POST", headers: { "payment-signature": c2, "content-type": "application/json" }, body: JSON.stringify({ a: 2 }) });
  ok(b2.headers.get("x-payment-recovered") === null, "1b. the same payment with another body is passed on");
  const b1 = await fetch(`${url}/api/echo`, { method: "POST", headers: { "payment-signature": c2, "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
  ok(b1.status === 200 && b1.headers.get("x-payment-recovered") === "true" && (await b1.json()).echoed.a === 1, "1b. the same body is replayed");

  // 1c. never kept: identity-bound, a stream, a 402, an unsettled 200, a delivered answer.
  const k0 = kept.length;
  await hangUp(`${url}/api/mem`, { headers: { "payment-signature": cred(0x103) } });
  await hangUp(`${url}/api/stream`, { headers: { "payment-signature": cred(0x104) } });
  await hangUp(`${url}/api/refused`, { headers: { "payment-signature": cred(0x105) } });
  await hangUp(`${url}/api/answer?settle=no`, { headers: { "payment-signature": cred(0x106) } });
  const delivered200 = await fetch(`${url}/api/answer?q=d`, { headers: { "payment-signature": cred(0x107) } });
  await delivered200.text();
  await sleep(600);
  ok(kept.length === k0, `1c. an identity-bound route, a stream, a 402, an unsettled 200 and a delivered answer are never kept (${kept.length - k0})`);
  const mem = await fetch(`${url}/api/mem`, { headers: { "payment-signature": cred(0x103) } });
  ok(mem.headers.get("x-payment-recovered") === null, "1c. an identity-bound route's retry goes to the gate (its retry path is the Idempotency-Key cache)");
  ok(paymentCredentialOf({ header: () => null, headers: { authorization: "Bearer a402_abcdefghijklmnopqrstuvwxyz" } }) === null && paymentCredentialOf({ header: () => null, headers: { authorization: "Payment id=\"x\"" } })?.kind === "mpp", "1c. a credits key is not a payment credential; an MPP Payment credential is");

  // 1d. the original still finishing -> 409 with Retry-After, then the answer.
  const delivered0 = delivered.length;
  const c3 = cred(0x108);
  const slowApp = buildApp({ store: storeA, delivered, kept, passes, gateMs: 1200 });
  const { server: slowServer, url: slowUrl } = await listen(slowApp);
  await hangUp(`${slowUrl}/api/answer`, { headers: { "payment-signature": c3 }, ms: 100 });
  await sleep(100);
  const early = await fetch(`${slowUrl}/api/answer`, { headers: { "payment-signature": c3 } });
  const earlyBody = await early.json();
  ok(early.status === 409 && early.headers.get("retry-after") === String(rec.RETRY_AFTER_SECONDS) && earlyBody.error === "payment_settling", `1d. a retry while the original still runs -> 409 + Retry-After (${early.status} ${early.headers.get("retry-after")} ${earlyBody.error})`);
  ok(await waitFor(async () => (await fetch(`${slowUrl}/api/answer`, { headers: { "payment-signature": c3 } })).headers.get("x-payment-recovered") === "true", 4000), "1d. once it ends, the retry is replayed");
  ok(await waitFor(() => delivered.length === delivered0 + 1), "1d. and its delivery recorded");
  slowServer.close();

  // 1e. a replay whose buyer leaves before it finishes records no delivery.
  const slowStore = { ...storeA, get: async (id) => { await sleep(300); return storeA.get(id); }, isPending: storeA.isPending, markPending: storeA.markPending, clearPending: storeA.clearPending, put: storeA.put };
  const d1 = [];
  const { server: s5, url: u5 } = await listen(buildApp({ store: slowStore, delivered: d1, kept: [], passes: [] }));
  await hangUp(`${u5}/api/answer?q=1`, { headers: { "payment-signature": c1 }, ms: 100 });
  await sleep(700);
  ok(d1.length === 0, `1e. a replay never received records no delivery (the debt stays) (${d1.length})`);
  const late = await fetch(`${u5}/api/answer?q=1`, { headers: { "payment-signature": c1 } });
  ok(late.status === 200 && await waitFor(() => d1.length === 1), "1e. a later replay that finishes does");
  s5.close();

  // 1f. sealed at rest: no plaintext answer, no raw credential in Redis.
  const keys = await rc.keys("answer:r:*");
  const vals = await Promise.all(keys.map((k) => rc.get(k)));
  ok(keys.length >= 3 && vals.every((v) => !v.includes("secret-") && !v.includes(c1.slice(0, 40)) && !v.includes("echoed")), `1f. ${keys.length} records in Redis, none holding the answer or the credential in the clear`);

  // 1g. another replica on one Redis replays it.
  const rb = await fetch(`${urlB}/api/answer?q=1`, { headers: { "payment-signature": c1 } });
  ok(rb.status === 200 && rb.headers.get("x-payment-recovered") === "true" && (await rb.text()) === body1 && passesB.length === 0, "1g. a record kept on replica A is replayed by replica B (shared Redis)");

  // 1h. TTL: past it the retry is passed on.
  const shortStore = createRecoveryStore({ redis: async () => null, ttlMs: 400 });
  const k8 = [], p8 = [];
  const { server: s8, url: u8 } = await listen(buildApp({ store: shortStore, delivered: [], kept: k8, passes: p8 }));
  const c8 = cred(0x109);
  await hangUp(`${u8}/api/answer`, { headers: { "payment-signature": c8 } });
  await waitFor(() => k8.length === 1, 3000);
  await sleep(500);
  const expired = await fetch(`${u8}/api/answer`, { headers: { "payment-signature": c8 } });
  ok(k8.length === 1 && expired.headers.get("x-payment-recovered") === null && p8.length === 2, "1h. past the TTL the retry is passed on to the gates (today's behavior)");
  s8.close();

  // 1i. CHARGED_ANSWER_RECOVERY=off: nothing kept, nothing replayed.
  process.env.CHARGED_ANSWER_RECOVERY = "off";
  const r9 = await fetch(`${url}/api/answer?q=1`, { headers: { "payment-signature": c1 } });
  ok(r9.headers.get("x-payment-recovered") === null, "1i. switched off: the retry is passed on");
  delete process.env.CHARGED_ANSWER_RECOVERY;
  server.close(); serverB.close();
}

// ---------------------------------------------------------------- part 2
const [PORT_A, PORT_B, FAC_PORT] = await getFreePorts(3);
const A = `http://127.0.0.1:${PORT_A}`, B = `http://127.0.0.1:${PORT_B}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const OP = "test-recovery-operator-token-0123456789";
const TTL_MS = 9000;
const fac = { verify: 0, settle: 0, settleDelayMs: 0, lastTx: null };
const txFor = (n) => `0x${(0xc0de0000 + n).toString(16).padStart(64, "0")}`;
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", async () => {
    const reply = (obj) => { if (res.destroyed) return; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = b ? JSON.parse(b) : {}; } catch { /* */ }
      const balanceOf = rpc.method === "eth_call" && String(rpc.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply({ jsonrpc: "2.0", id: 1, result: balanceOf ? "0x" + (1_000_000_000).toString(16).padStart(64, "0") : "0x0" });
    }
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { fac.verify++; return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { const n = ++fac.settle; fac.lastTx = txFor(n); if (fac.settleDelayMs) await sleep(fac.settleDelayMs); return reply({ success: true, transaction: txFor(n), network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const boot = (port, extra = {}) => {
  const p = spawn("node", ["--import", "./scripts/lib/hold-json-preload.js", "src/server.js"], {
    env: { ...process.env, PORT: String(port), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "", OPENROUTER_API_KEY: "",
      REDIS_URL, CHARGED_ANSWER_SECRET: SECRET, CHARGED_ANSWER_TTL_MS: String(TTL_MS), CHARGED_ANSWER_RECOVERY: "",
      HANGUP_FORGIVE: "", HANGUP_FORGIVE_KEY_USD: "0.1", HANGUP_FORGIVE_GLOBAL_USD: "0.4", HANGUP_FORGIVE_FILE: "off", HANGUP_FORGIVE_SALT: "recovery-test",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATE_DATABASE_URL: "",
      AGENT402_OPERATOR_TOKEN: OP, REFUND_DB_DIR: join(TMP, "shared"), SALES_LEDGER_DB: join(TMP, `sales-${port}.db`), HANGUP_TEST_HOLD_JSON: "1", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk) => { for (const line of String(chunk).split("\n")) if (line.trim()) serverLog.push(`${port}: ${line.slice(0, 400)}`); };
  p.stdout.on("data", keep); p.stderr.on("data", keep);
  procs.push(p);
  return p;
};
mkdirSync(join(TMP, "shared"), { recursive: true });
await sleep(50);
boot(PORT_A);
// Server B models a buyer whose forgiveness budget is spent: forgiveness off,
// so a hang-up there is settled and booked as owed.
boot(PORT_B, { HANGUP_FORGIVE: "off" });

let opReads = 0;
const refundsDoc = async (base = A) => (await fetch(`${base}/__operator/refunds.json?status=all`, { headers: { Authorization: `Bearer ${OP}`, "x-forwarded-for": `10.253.${Math.floor(++opReads / 250) % 250}.${opReads % 250}` } })).json();
let nonceN = 0;
const credential = (accepted, payer, nonce = ++nonceN) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "22".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x9000 + nonce).toString(16).padStart(64, "0") } },
})).toString("base64");
const accepts = {};
const acceptFor = async (path, method = "GET", body) => {
  const k = `${method} ${path}`;
  if (accepts[k]) return accepts[k];
  const r = await fetch(`${A}${path}`, { method, headers: { "content-type": "application/json" }, body });
  ok(r.status === 402, `unpaid ${k} -> 402 (${r.status})`);
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
  accepts[k] = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  return accepts[k];
};
const WALLET = "0x00000000000000000000000000000000000000a7";
const OTHER = "0x00000000000000000000000000000000000000b8";

try {
  for (const base of [A, B]) {
    let up = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
    ok(up, `paid server ${base} booted`);
  }
  const UUID = "/api/uuid?version=4&count=1";
  const acc = await acceptFor("/api/uuid");

  // a. a connected buyer: served, nothing kept.
  {
    const r = await fetch(`${A}${UUID}`, { headers: { "payment-signature": credential(acc, WALLET), "x-forwarded-for": "10.9.0.1" } });
    ok(r.status === 200, `a. a connected paid buyer is served (${r.status})`);
    await sleep(200);
    ok((await refundsDoc()).chargedAnswerRecovery.kept === 0, "a. a delivered answer is never kept");
  }

  // b. a close during a slow settle.
  const cB = credential(acc, WALLET);
  let replayBody = null, txB = null;
  {
    fac.settleDelayMs = 1500;
    const s0 = fac.settle;
    const settleSeen = waitFor(() => fac.settle > s0, 5000);
    const gone = new Promise((resolve) => {
      const req = httpRequest(`${A}${UUID}`, { headers: { "payment-signature": cB, "x-forwarded-for": "10.9.0.2" } });
      req.on("error", () => resolve()); req.on("response", (r) => { r.resume(); resolve(); });
      req.end();
      settleSeen.then(() => sleep(100)).then(() => { req.destroy(); resolve(); });
    });
    await gone;
    await sleep(100);
    const early = await fetch(`${A}${UUID}`, { headers: { "payment-signature": cB, "x-forwarded-for": "10.9.0.2" } });
    const earlyBody = await early.json().catch(() => ({}));
    ok(early.status === 409 && early.headers.get("retry-after") && earlyBody.error === "payment_settling", `b. a retry while the settle still runs -> 409 + Retry-After (${early.status}, ${early.headers.get("retry-after")}, ${earlyBody.error})`);
    await sleep(1800);
    fac.settleDelayMs = 0;
    txB = fac.lastTx;
    ok(fac.settle - s0 === 1, `b. the payment settled once (${fac.settle - s0})`);
    const doc = await refundsDoc();
    const row = doc.refunds.find((r) => r.evidence === txB);
    ok(row && row.status === "owed" && row.httpStatus === 499 && row.hangupReason === "settled in flight" && String(row.note || "").startsWith(KEPT_NOTE_PREFIX), `b. the debt is booked, noting the kept answer (${JSON.stringify(row && { status: row.status, reason: row.hangupReason, note: row.note })})`);
    ok(doc.chargedAnswerRecovery.kept === 1, "b. the answer is kept");
    const { planRefunds, AWAITING_RETRY_HOLD } = await import("./refund-run.js");
    const plan = planRefunds([row], { senders: { evm: true }, maxEachUsd: 1, maxTotalUsd: 5, maxPerPayerUsd: 5 });
    ok((plan.held?.[AWAITING_RETRY_HOLD] || []).length === 1 && plan.send.length === 0, "b. the refund planner holds it while the retry window is open");
    const later = planRefunds([row], { senders: { evm: true }, maxEachUsd: 1, maxTotalUsd: 5, maxPerPayerUsd: 5, now: Date.now() + TTL_MS + 1000 });
    ok(!(later.held?.[AWAITING_RETRY_HOLD] || []).length, "b. and plans it normally once the window has closed");
    const s1 = fac.settle;
    const r = await fetch(`${A}${UUID}`, { headers: { "payment-signature": cB, "x-forwarded-for": "10.9.0.2" } });
    replayBody = await r.text();
    const receipt = JSON.parse(Buffer.from(r.headers.get("payment-response") || "", "base64").toString() || "{}");
    ok(r.status === 200 && r.headers.get("x-payment-recovered") === "true" && Array.isArray(JSON.parse(replayBody).uuids), `b. the retry with the same payment gets the answer (${r.status}, ${replayBody.slice(0, 80)})`);
    ok(receipt.transaction === txB && receipt.success === true, "b. with the original receipt");
    const again = await fetch(`${A}${UUID}`, { headers: { "payment-signature": cB } });
    ok(again.status === 200 && (await again.text()) === replayBody, "b. a second retry gets the identical bytes");
    ok(fac.settle === s1, `b. nothing settled for either retry (settles +${fac.settle - s1})`);
    ok(await waitFor(async () => { const rw = (await refundsDoc()).refunds.find((x) => x.evidence === txB); return rw?.status === "void" && String(rw.note).endsWith(DELIVERED_NOTE); }, 3000), "b. the debt is voided: delivered on retry");
  }

  // c. the same payment on the other server (one Redis).
  {
    const s0 = fac.settle;
    const r = await fetch(`${B}${UUID}`, { headers: { "payment-signature": cB } });
    ok(r.status === 200 && r.headers.get("x-payment-recovered") === "true" && (await r.text()) === replayBody && fac.settle === s0, "c. another server replays the same answer, settling nothing");
  }

  // d. what may not read it.
  {
    const s0 = fac.settle;
    const answer = JSON.parse(replayBody).uuids[0];
    const sameNonce = credential(acc, OTHER, Number(BigInt(JSON.parse(Buffer.from(cB, "base64").toString()).payload.authorization.nonce) - 0x9000n));
    const r1 = await fetch(`${A}${UUID}`, { headers: { "payment-signature": sameNonce } });
    const t1 = await r1.text();
    ok(r1.status >= 400 && !t1.includes(answer) && r1.headers.get("x-payment-recovered") === null, `d. the same nonce under another payer is refused (${r1.status}) and never sees the answer`);
    const r2 = await fetch(`${A}/api/uuid?version=4&count=2`, { headers: { "payment-signature": cB } });
    const t2 = await r2.text();
    ok(r2.status >= 400 && !t2.includes(answer), `d. the same payment with another query is refused (${r2.status})`);
    const r3 = await fetch(`${A}/api/base64`, { method: "POST", headers: { "payment-signature": cB, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    ok(r3.status >= 400 && !(await r3.text()).includes(answer), `d. the same payment on another route is refused (${r3.status})`);
    ok(fac.settle === s0, `d. nothing settled for any of them (+${fac.settle - s0})`);
  }

  // e. past the forgiveness budget (server B): settled, kept, served on A.
  // f. inside it (server A): not settled, nothing kept, refused as before.
  {
    const accPost = await acceptFor("/api/base64", "POST", JSON.stringify({ text: "x" }));
    const body = JSON.stringify({ text: "recover me" });
    const holdAndHangUp = (base, c) => new Promise((resolve) => {
      const req = httpRequest(`${base}/api/base64`, { method: "POST", headers: { "payment-signature": c, "content-type": "application/json", "x-test-hold-json-ms": "600", "x-forwarded-for": "10.9.0.5" } });
      req.on("error", () => resolve()); req.on("response", (r) => { r.resume(); resolve(); });
      req.write(body); req.end();
      setTimeout(() => { req.destroy(); resolve(); }, 250);
    });
    const cE = credential(accPost, WALLET);
    const s0 = fac.settle;
    await holdAndHangUp(B, cE);
    ok(await waitFor(() => fac.settle === s0 + 1, 4000), "e. a hang-up past the forgiveness budget is settled");
    await sleep(300);
    const rowE = (await refundsDoc(B)).refunds.find((x) => x.evidence === fac.lastTx);
    ok(rowE && String(rowE.note || "").startsWith(KEPT_NOTE_PREFIX), `e. and booked as owed with the kept answer noted (${rowE?.hangupReason})`);
    const r = await fetch(`${A}/api/base64`, { method: "POST", headers: { "payment-signature": cE, "content-type": "application/json" }, body });
    const j = await r.json();
    ok(r.status === 200 && r.headers.get("x-payment-recovered") === "true" && j.result === Buffer.from("recover me").toString("base64") && fac.settle === s0 + 1, `e. the retry on server A gets the answer, nothing settled (${r.status})`);
    const cF = credential(accPost, OTHER);
    const s1 = fac.settle;
    await holdAndHangUp(A, cF);
    await sleep(1200);
    ok(fac.settle === s1, "f. a hang-up inside the forgiveness budget is not settled");
    const rf = await fetch(`${A}/api/base64`, { method: "POST", headers: { "payment-signature": cF, "content-type": "application/json" }, body });
    ok(rf.status === 409 && rf.headers.get("x-payment-recovered") === null && fac.settle === s1, `f. nothing was kept; the spent credential is refused as before (${rf.status})`);
  }

  // h. an identity-bound route (a memory write) is never kept by the recovery;
  // with an Idempotency-Key its settled answer is kept by that cache, now
  // committed on the settlement outcome rather than on "finish".
  {
    const key = `recovery-${Date.now()}`;
    const body = JSON.stringify({ key, value: "kept" });
    const accMem = await acceptFor("/api/memory", "POST", body);
    const heldMemory = (c, extra = {}) => new Promise((resolve) => {
      const req = httpRequest(`${A}/api/memory`, { method: "POST", headers: { "payment-signature": c, "content-type": "application/json", "x-test-hold-json-ms": "600", "x-forwarded-for": "10.9.0.7", ...extra } });
      req.on("error", () => resolve()); req.on("response", (r) => { r.resume(); resolve(); });
      req.write(body); req.end();
      setTimeout(() => { req.destroy(); resolve(); }, 250);
    });
    const cH = credential(accMem, WALLET);
    const s0 = fac.settle;
    await heldMemory(cH);
    ok(await waitFor(() => fac.settle === s0 + 1, 4000), "h. a memory write whose buyer left is settled (its effect outlives the answer)");
    await sleep(300);
    const r = await fetch(`${A}/api/memory`, { method: "POST", headers: { "payment-signature": cH, "content-type": "application/json" }, body });
    ok(r.status === 409 && r.headers.get("x-payment-recovered") === null && fac.settle === s0 + 1, `h. without an Idempotency-Key the resend is refused: identity-bound answers are never kept by the recovery (${r.status})`);
    const cK = credential(accMem, WALLET);
    await heldMemory(cK, { "idempotency-key": `${key}-k` });
    ok(await waitFor(() => fac.settle === s0 + 2, 4000), "h. the keyed write whose buyer left is settled");
    await sleep(300);
    const rk = await fetch(`${A}/api/memory`, { method: "POST", headers: { "payment-signature": cK, "content-type": "application/json", "idempotency-key": `${key}-k` }, body });
    const jk = await rk.json().catch(() => ({}));
    ok(rk.status === 200 && rk.headers.get("x-idempotent-replay") === "true" && fac.settle === s0 + 2, `h. with the same Idempotency-Key the resend replays the settled answer, settling nothing (${rk.status} ${JSON.stringify(jk).slice(0, 80)})`);
  }

  // g. past the TTL: refused as before.
  {
    await sleep(TTL_MS + 500);
    const s0 = fac.settle;
    const r = await fetch(`${A}${UUID}`, { headers: { "payment-signature": cB } });
    ok(r.status === 409 && r.headers.get("x-payment-recovered") === null && fac.settle === s0, `g. past the retry window the same payment is refused as before (${r.status})`);
  }
} catch (e) {
  fail(e?.stack || String(e));
}
await rc.quit().catch(() => {});
cleanup();
console.log(`\n${pass} passed`);
process.exit(0);
