// A buyer whose connection is gone before the first response byte is not
// charged, within a budget (src/hangup-settlement.js, src/hangup-forgiveness.js);
// past the budget, and for a close during the settle call itself, the charge
// goes through and is booked as owed in the refund ledger.
//
// Why: @x402/express decides whether to settle from res.statusCode alone and
// never asks whether the buyer is still connected, so a client with a 20 s
// timeout against a 40 s media run used to produce a settled charge the buyer
// never received plus a refund-ledger debt. Not settling fixes that, but a
// hang-up costs the caller nothing, so on its own it would be a free run on
// repeat: the forgiveness budget (per wallet, per IP, service-wide, reserved
// when the handler starts, never reset by a paid success) is what bounds it,
// and running out of it puts the old behavior back rather than refusing.
//
// Part 1 drives the hook, the predicates, the budget and the credits gate
// directly, and pins from source the seams the booted part cannot isolate.
// Part 2 boots the REAL paid server against a stub facilitator and a stub
// OpenRouter (scripts/lib/openrouter-stub-preload.js sends every openrouter.ai
// fetch to it; the preload refuses to load without a stub, so this can never
// spend upstream), sends real HTTP requests and destroys the socket at chosen
// moments:
//   a. connected control: settled, nothing owed;
//   b. close during a slow /settle (the residual window): settled once, owed once;
//   c. close during verify: the handler never runs, nothing settles, no budget spent;
//   d. close mid-handler inside the budget: nothing settles, nothing owed,
//      the spent credential cannot buy a second run;
//   e. hang-ups interleaved with a paid success from one
//      wallet): forgiven and cut off inside the wallet's budget, then settled
//      and owed, never refused;
//   f. one IP rotating wallets: the IP's budget binds;
//   g. ten concurrent hang-ups: in-flight runs count;
//   h. rotating wallets AND IPs: the service-wide budget binds;
//   i. close AFTER the whole answer arrived: an ordinary settled sale;
//   j. no hang-up feeds the settle breaker or the composite guard;
//   k. (runs after h) with the wallet's budget spent, a close during verify
//      runs nothing and charges nothing, on the generic binder and on the
//      memory family;
//   l. (runs before h) a route whose effect outlives the answer is never
//      forgiven: a hang-up after the handler ran on a memory write, attest,
//      feedback or route-execute settles and is booked as owed, with budget
//      to spare, while the same hang-up on an ordinary tool is not settled.
// Part 2 also checks the lasting-effect list against the booted catalog.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
requireUpstreamCosts("test-hangup-settlement");
import { join } from "node:path";
import express from "express";
import { createHangupSettlementHook, clientGoneBeforeFirstByte, chargeCancelledForClientGone, clientGoneError, isClientGoneAbort, CLIENT_GONE_TEXT } from "../src/hangup-settlement.js";
import { reserveHangupForgiveness, settleHangupTicket, hangupForgiven, hangupForgivenessStatus, hangupForgivenessConfig, hangupTicketDenial, hasLastingEffect, LASTING_EFFECT_SLUG_LIST, _resetHangupForgiveness, hangupKeyDigest, persistPath, persistNow, flushHangupForgiveness, loadHangupForgiveness } from "../src/hangup-forgiveness.js";
import { createCredits } from "../src/credits.js";
import { getFreePorts } from "./lib/free-port.js";
import { planRefunds, REPEAT_HANGUP_HOLD } from "./refund-run.js";
let pass = 0, proc = null, facilitator = null, orStub = null;
const serverLog = [];
const TMP = mkdtempSync(join(tmpdir(), "hangup-"));
const cleanup = () => { proc?.kill("SIGKILL"); facilitator?.close(); orStub?.close(); rmSync(TMP, { recursive: true, force: true }); };
const fail = (m) => { console.error("FAIL:", m); for (const l of serverLog.slice(-30)) console.error("  server:", l); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` })); });
const waitFor = async (cond, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(20); } return cond(); };

// Send a request and destroy the socket when `abortWhen` resolves (or after a
// fixed delay), before any reply. Resolves once the socket is gone.
const hangUp = (url, { method = "GET", headers = {}, body = null, abortAfterMs = null, abortWhen = null } = {}) => new Promise((resolve) => {
  const req = httpRequest(url, { method, headers });
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  req.on("error", finish);
  req.on("response", (r) => { r.resume(); finish(); });
  if (body) req.write(body);
  req.end();
  const kill = () => { req.destroy(); finish(); };
  if (abortWhen) abortWhen.then(kill); else setTimeout(kill, abortAfterMs ?? 100);
});

// ---------------------------------------------------------------- part 1

// 1a. The hook marks the request only for a close before the first byte.
{
  const seen = [];
  const flags = {};
  const app = express();
  app.use(createHangupSettlementHook({ onUndelivered: (req, _res, kind) => seen.push({ path: req.path, kind }) }));
  // A buffered "gate": holds the handler's end, then ends after a delay, the
  // way every paid gate does once settlement returns.
  app.get("/buffered", (req, res) => { setTimeout(() => { flags.buffered = Object.hasOwn(req, "__a402ClientGoneAt"); flags.bufferedGone = clientGoneBeforeFirstByte(req); res.json({ ok: 1 }); }, 300); });
  app.get("/plain", (req, res) => { res.json({ ok: 1 }); res.on("close", () => { flags.plain = Object.hasOwn(req, "__a402ClientGoneAt"); }); });
  // A stream that has already sent headers when the client leaves.
  app.get("/stream", (req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.write("part"); setTimeout(() => { flags.stream = Object.hasOwn(req, "__a402ClientGoneAt"); flags.streamGone = clientGoneBeforeFirstByte(req); res.end("rest"); }, 300); });
  const { server, url } = await listen(app);
  await hangUp(`${url}/buffered`, { abortAfterMs: 80 });
  await sleep(450);
  ok(flags.buffered === true && flags.bufferedGone === true, "a close before the first byte marks the request (__a402ClientGoneAt) and the predicate reads it");
  ok(seen.length === 1 && seen[0].path === "/buffered" && seen[0].kind === "end", `the response ended after the client left is reported once, at end (${JSON.stringify(seen)})`);
  await fetch(`${url}/plain`);
  await sleep(50);
  ok(flags.plain === false && seen.length === 1, "a normal completion is neither marked nor reported");
  await new Promise((resolve) => { const r = httpRequest(`${url}/stream`, (res) => { res.once("data", () => { r.destroy(); resolve(); }); }); r.on("error", () => resolve()); r.end(); });
  await sleep(450);
  ok(flags.stream === false && flags.streamGone === false && seen.length === 1, "a stream the client left part way through (headers already sent) is neither marked nor reported");
  server.close();
}

// 1b. clientGoneBeforeFirstByte truth table, including the belt a request
// without the hook (FREE_MODE, a unit app) falls back to.
{
  const reqWith = (res, extra = {}) => Object.assign({ res, socket: extra.socket || { destroyed: false } }, extra.own || {});
  ok(clientGoneBeforeFirstByte(null) === false && clientGoneBeforeFirstByte(undefined) === false && clientGoneBeforeFirstByte({}) === false, "no request / no response: not gone");
  ok(clientGoneBeforeFirstByte({ __a402ClientGoneAt: Date.now() }) === true, "the hook's own-property flag alone says gone");
  ok(clientGoneBeforeFirstByte(Object.create({ __a402ClientGoneAt: Date.now() })) === false, "a flag on the PROTOTYPE is ignored (a polluted prototype must not make every request unsettled)");
  ok(clientGoneBeforeFirstByte(reqWith({ headersSent: false, destroyed: true })) === true, "belt: no flag, nothing sent, response destroyed -> gone");
  ok(clientGoneBeforeFirstByte(reqWith({ headersSent: false, destroyed: false }, { socket: { destroyed: true } })) === true, "belt: no flag, nothing sent, socket destroyed -> gone");
  ok(clientGoneBeforeFirstByte(reqWith({ headersSent: true, destroyed: true }, { socket: { destroyed: true } })) === false, "belt: headers already sent -> partly delivered, not this case");
  ok(clientGoneBeforeFirstByte(reqWith({ headersSent: false, destroyed: false })) === false, "belt: connected -> not gone");
  const e = clientGoneError();
  ok(isClientGoneAbort(e) && e.statusCode === 499 && e.name === "AbortError" && e.message === CLIENT_GONE_TEXT, "clientGoneError is a 499 AbortError carrying the standard text");
  ok(!isClientGoneAbort(new Error("x")) && !isClientGoneAbort(null) && !isClientGoneAbort(Object.assign(new Error("x"), { statusCode: 499 })), "isClientGoneAbort recognises only its own errors");
  // The belt in a real app with no hook mounted.
  const seenGone = [];
  const app = express();
  app.get("/slow", async (req, res) => { await sleep(250); seenGone.push(clientGoneBeforeFirstByte(req)); try { res.json({ ok: 1 }); } catch { /* gone */ } });
  const { server, url } = await listen(app);
  await hangUp(`${url}/slow`, { abortAfterMs: 60 });
  await fetch(`${url}/slow`);
  await sleep(350);
  ok(seenGone.length === 2 && seenGone[0] === true && seenGone[1] === false, `without the hook the belt still sees an abandoned socket and a connected one (${JSON.stringify(seenGone)})`);
  server.close();
}

// 1c. chargeCancelledForClientGone: gone before the first byte AND a granted
// forgiveness ticket. Either alone keeps the charge.
{
  _resetHangupForgiveness();
  const gone = () => ({ __a402ClientGoneAt: Date.now() });
  const g1 = gone(); reserveHangupForgiveness(g1, { keys: ["0xaa", "ip:1.1.1.1"], priceUsd: 0.01 });
  ok(hangupForgiven(g1) && chargeCancelledForClientGone(g1), "gone + granted ticket: the charge is cancelled");
  const connected = {}; reserveHangupForgiveness(connected, { keys: ["0xab", "ip:1.1.1.2"], priceUsd: 0.01 });
  ok(hangupForgiven(connected) && !chargeCancelledForClientGone(connected), "a granted ticket on a connected buyer cancels nothing");
  ok(!chargeCancelledForClientGone(gone()), "gone with NO ticket: the charge stands (settled, then booked as owed)");
  // $0.50: over the default per-key budget ($0.25), under the service-wide
  // one ($2.00).
  const g2 = gone(); reserveHangupForgiveness(g2, { keys: ["ip:1.1.1.3"], priceUsd: 0.5 });
  ok(!hangupForgiven(g2) && !chargeCancelledForClientGone(g2) && g2.__a402HangupTicket.reason === "over per-key budget", `gone with a DENIED ticket: the charge stands (${g2.__a402HangupTicket.reason})`);
  const g3 = Object.assign(Object.create({ __a402HangupTicket: { granted: true } }), { __a402ClientGoneAt: Date.now() });
  ok(!hangupForgiven(g3) && !chargeCancelledForClientGone(g3), "a ticket on the PROTOTYPE is ignored (a polluted prototype must not make every request unsettled)");
  _resetHangupForgiveness();
}

// 1d. The forgiveness budget itself (src/hangup-forgiveness.js), in three
// shapes: hang-ups interleaved with paid successes, a burst
// of concurrent hang-ups, and rotation across wallets.
{
  const saved = { k: process.env.HANGUP_FORGIVE_KEY_USD, g: process.env.HANGUP_FORGIVE_GLOBAL_USD, w: process.env.HANGUP_FORGIVE_WINDOW_MS, o: process.env.HANGUP_FORGIVE };
  // The defaults, read with nothing set: $0.25 per key and $2.00 for the whole
  // service over 24 h, sized for micro-transactions. Stated as literals on
  // purpose, so a change to the defaults has to change this line too.
  for (const k of ["HANGUP_FORGIVE_KEY_USD", "HANGUP_FORGIVE_GLOBAL_USD", "HANGUP_FORGIVE_WINDOW_MS", "HANGUP_FORGIVE"]) delete process.env[k];
  const dflt = hangupForgivenessConfig();
  ok(dflt.enabled && dflt.keyMicro === 250_000 && dflt.globalMicro === 2_000_000 && dflt.windowMs === 86_400_000, `defaults: $0.25 per key and $2.00 service-wide per 24 h (${JSON.stringify(dflt)})`);
  _resetHangupForgiveness();
  // A single call priced above the per-key default is never forgiven, even
  // with nothing spent: $0.26 on a fresh wallet and IP.
  const pricey = {}; reserveHangupForgiveness(pricey, { keys: ["0xdefault", "ip:10.10.0.1"], priceUsd: 0.26 });
  ok(!hangupForgiven(pricey) && pricey.__a402HangupTicket.reason === "over per-key budget", `defaults: a $0.26 call is over the per-key budget on its own (${pricey.__a402HangupTicket.reason})`);
  // The service-wide default binds after $2.00 of abandoned runs across
  // rotating wallets and IPs: eight $0.25 runs fit, the ninth does not.
  const rotDefault = Array.from({ length: 9 }, (_, i) => { const req = {}; const t = reserveHangupForgiveness(req, { keys: [`0xdg${i}`, `ip:10.10.1.${i}`], priceUsd: 0.25 }); settleHangupTicket(req, { abandoned: true }); return t.granted; });
  ok(rotDefault.slice(0, 8).every(Boolean) && rotDefault[8] === false, `defaults: rotating wallets and IPs, eight $0.25 hang-ups fit the $2.00 service budget and the ninth is charged (${JSON.stringify(rotDefault)})`);
  _resetHangupForgiveness();
  process.env.HANGUP_FORGIVE_KEY_USD = "0.009"; process.env.HANGUP_FORGIVE_GLOBAL_USD = "0.05"; process.env.HANGUP_FORGIVE_WINDOW_MS = "60000";
  _resetHangupForgiveness();
  const T0 = 1_000_000;
  const run = (keys, { price = 0.003, now = T0, abandoned = true } = {}) => { const req = {}; const t = reserveHangupForgiveness(req, { keys, priceUsd: price, now }); settleHangupTicket(req, { abandoned, now }); return t.granted; };
  // Interleaved: [2 hang-ups, 1 paid success] x 4 from one wallet on one IP. The
  // success returns its own reservation and clears NOTHING, so the budget
  // (3 x $0.003) is spent by the third hang-up and every later one is charged.
  const r1 = [];
  for (let c = 0; c < 4; c++) { r1.push(run(["0xr1", "ip:10.1.0.1"], { now: T0 + c })); r1.push(run(["0xr1", "ip:10.1.0.1"], { now: T0 + c })); run(["0xr1", "ip:10.1.0.1"], { now: T0 + c, abandoned: false }); }
  ok(hangupForgivenessStatus(T0 + 4).inflightUsd === 0, "interleaved: every paid success returned its reservation (nothing left in flight)");
  ok(r1.filter(Boolean).length === 3 && r1.slice(3).every((g) => g === false), `interleaved: a paid success between hang-ups never resets the budget - 3 of 8 hang-ups forgiven, the other 5 charged (${JSON.stringify(r1)})`);
  // Burst: 10 concurrent runs from one wallet, each from a different IP. The
  // reservation happens BEFORE any of them ends, so in-flight runs count.
  _resetHangupForgiveness();
  const burst = Array.from({ length: 10 }, (_, i) => { const req = {}; reserveHangupForgiveness(req, { keys: ["0xr2", `ip:10.2.0.${i}`], priceUsd: 0.003, now: T0 }); return req; });
  ok(burst.filter(hangupForgiven).length === 3, `burst: 10 concurrent runs from one wallet: only 3 hold a ticket (${burst.filter(hangupForgiven).length})`);
  for (const req of burst) settleHangupTicket(req, { abandoned: true, now: T0 });
  ok(!run(["0xr2", "ip:10.2.9.9"], { now: T0 + 1 }), "burst: and the wallet's next run is not forgiven either (the abandoned burst stays on the books)");
  // One IP rotating wallets is bounded by the IP key.
  _resetHangupForgiveness();
  const ipRot = Array.from({ length: 5 }, (_, i) => run([`0xip${i}`, "ip:10.3.0.1"], { now: T0 }));
  ok(ipRot.filter(Boolean).length === 3, `one IP rotating wallets: 3 forgiven, then the IP budget holds (${JSON.stringify(ipRot)})`);
  // Rotating wallets AND IPs is bounded by the global budget ($0.05 here).
  _resetHangupForgiveness();
  const rot = Array.from({ length: 30 }, (_, i) => run([`0xrot${i}`, `ip:10.4.0.${i}`], { now: T0 }));
  ok(rot.filter(Boolean).length === 16, `rotating wallets and IPs: the service-wide budget stops it at 16 x $0.003 (${rot.filter(Boolean).length})`);
  const denied = {}; reserveHangupForgiveness(denied, { keys: ["0xfresh", "ip:10.9.9.9"], priceUsd: 0.003, now: T0 });
  ok(!hangupForgiven(denied) && denied.__a402HangupTicket.reason === "global budget", "a fresh wallet on a fresh IP is refused forgiveness once the global budget is spent");
  // The window: abandoned runs age out; a success never does it early.
  ok(run(["0xlater", "ip:10.4.1.1"], { now: T0 + 60_001 }), "after the window the budget is available again");
  // A released (delivered) run leaves no trace.
  _resetHangupForgiveness();
  for (let i = 0; i < 20; i++) run(["0xgood", "ip:10.5.0.1"], { now: T0, abandoned: false });
  ok(hangupForgivenessStatus(T0).abandonedInWindow === 0 && hangupForgivenessStatus(T0).inflightUsd === 0, "20 delivered runs leave nothing abandoned and nothing in flight");
  // settleHangupTicket is idempotent, and a denied ticket holds nothing.
  const once = {}; reserveHangupForgiveness(once, { keys: ["0xonce", "ip:10.6.0.1"], priceUsd: 0.003, now: T0 });
  ok(settleHangupTicket(once, { abandoned: true, now: T0 }) === true && settleHangupTicket(once, { abandoned: true, now: T0 }) === false && hangupForgivenessStatus(T0).abandonedInWindow === 1, "a ticket is settled at most once");
  ok(!run(["0xbig", "ip:10.7.0.1"], { price: 0.01 }), "a single run pricier than the per-key budget is never forgiven");
  const noKey = {}; reserveHangupForgiveness(noKey, { keys: [null, ""], priceUsd: 0.001 });
  ok(!hangupForgiven(noKey) && noKey.__a402HangupTicket.reason === "no key", "a run with no key at all is never forgiven");
  process.env.HANGUP_FORGIVE_KEY_USD = "not-a-number";
  ok(hangupForgivenessConfig().keyMicro === 250_000, "a malformed per-key budget reads as the default ($0.25), never as unbounded");
  process.env.HANGUP_FORGIVE_GLOBAL_USD = "-1";
  ok(hangupForgivenessConfig().globalMicro === 2_000_000, "a negative service-wide budget reads as the default ($2.00)");
  process.env.HANGUP_FORGIVE = "off";
  const off = {}; reserveHangupForgiveness(off, { keys: ["0xoff", "ip:10.8.0.1"], priceUsd: 0.001 });
  ok(!hangupForgiven(off) && off.__a402HangupTicket.reason === "disabled", "HANGUP_FORGIVE=off: nothing is forgiven (every hang-up is settled and owed)");
  for (const [k, v] of [["HANGUP_FORGIVE_KEY_USD", saved.k], ["HANGUP_FORGIVE_GLOBAL_USD", saved.g], ["HANGUP_FORGIVE_WINDOW_MS", saved.w], ["HANGUP_FORGIVE", saved.o]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _resetHangupForgiveness();
}

// 1d-2. The abandoned records persist (a deploy is a restart). Keys are held
// as keyed digests, the file is read back strictly, and nothing past the
// window, from the future, or of the wrong shape is trusted.
{
  const saved = { f: process.env.HANGUP_FORGIVE_FILE, s: process.env.HANGUP_FORGIVE_SALT };
  const file = join(TMP, "unit-hangup.json");
  process.env.HANGUP_FORGIVE_FILE = file; process.env.HANGUP_FORGIVE_SALT = "unit-salt";
  _resetHangupForgiveness();
  ok(/^ip:[0-9a-f]{24}$/.test(hangupKeyDigest("ip:203.0.113.7")) && /^payer:[0-9a-f]{24}$/.test(hangupKeyDigest("0xabc")) && /^tempo:[0-9a-f]{24}$/.test(hangupKeyDigest("tempo:0xabc")) && /^credits:[0-9a-f]{24}$/.test(hangupKeyDigest("credits:k1")), "keys are held as kind:digest, the kind kept for the denial reason");
  ok(hangupKeyDigest("ip:203.0.113.7") !== hangupKeyDigest("ip:203.0.113.8") && hangupKeyDigest("0xabc") === hangupKeyDigest("0xabc"), "the digest is stable per identity and distinct across identities");
  const now = Date.now();
  const spend = (keys, price) => { const req = {}; reserveHangupForgiveness(req, { keys, priceUsd: price, now }); settleHangupTicket(req, { abandoned: true, now }); return req; };
  spend(["0xpersist", "ip:203.0.113.7"], 0.2);
  spend(["0xother", "ip:203.0.113.8"], 0.1);
  ok(flushHangupForgiveness() === true, "the shutdown flush writes the records");
  const text = readFileSync(file, "utf8");
  ok(!text.includes("203.0.113") && !text.includes("0xpersist"), "the file holds no client IP and no wallet address");
  const before = hangupForgivenessStatus(now);
  _resetHangupForgiveness();
  ok(hangupForgivenessStatus(now).abandonedInWindow === 0, "(the in-memory record is empty before the load)");
  const r = loadHangupForgiveness(now);
  const after = hangupForgivenessStatus(now);
  ok(r.loaded && r.global === 2 && r.keys === 4 && after.abandonedInWindow === before.abandonedInWindow && Math.abs(after.abandonedUsdInWindow - 0.3) < 1e-9, `loading restores the service-wide and per-key records (${JSON.stringify(r)})`);
  const again = {}; reserveHangupForgiveness(again, { keys: ["0xpersist", "ip:203.0.113.99"], priceUsd: 0.1, now });
  ok(!hangupForgiven(again) && again.__a402HangupTicket.reason === "payer budget", `after the load the same wallet is still past its budget (${again.__a402HangupTicket.reason})`);
  // Strict read: only well-formed records inside the window come back.
  const { writeFileSync } = await import("node:fs");
  const W = 86_400_000, good = [now - 1_000, 5_000];
  writeFileSync(file, JSON.stringify({ v: 1, global: [good, [now - W - 1, 5_000], [now + 3_600_000, 5_000], [now - 1, -5], [now - 1, 1.5], ["x", 5], [now - 1, 2e9], "junk"],
    keys: [["ip:" + "a".repeat(24), [good]], ["203.0.113.7", [good]], ["ip:" + "b".repeat(24), [[now - W - 5, 5]]], ["__proto__", [good]], ["payer:" + "c".repeat(24), "nope"]] }));
  _resetHangupForgiveness();
  const strict = loadHangupForgiveness(now);
  ok(strict.global === 1 && strict.keys === 1 && hangupForgivenessStatus(now).abandonedInWindow === 1 && ({}).polluted === undefined, `a malformed, expired, future or oversized record is dropped, and a raw key is refused (${JSON.stringify(strict)})`);
  writeFileSync(file, "{not json");
  _resetHangupForgiveness();
  ok(loadHangupForgiveness(now).loaded === false && hangupForgivenessStatus(now).abandonedInWindow === 0, "an unreadable file loads nothing and does not throw");
  writeFileSync(file, JSON.stringify({ v: 99, global: [good] }));
  ok(loadHangupForgiveness(now).loaded === false, "a file of another version is not read");
  // The debounced writer: an abandoned run schedules a write, persistNow writes.
  _resetHangupForgiveness();
  spend(["0xdebounce", "ip:203.0.113.20"], 0.01);
  ok(await persistNow() === true && JSON.parse(readFileSync(file, "utf8")).global.length === 1, "persistNow writes the current records (tmp then rename)");
  process.env.HANGUP_FORGIVE_FILE = "off";
  ok(persistPath() === null && flushHangupForgiveness() === false && hangupForgivenessStatus().persisted === false, "HANGUP_FORGIVE_FILE=off persists nothing");
  for (const [k, v] of [["HANGUP_FORGIVE_FILE", saved.f], ["HANGUP_FORGIVE_SALT", saved.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _resetHangupForgiveness();
}

// 1e. Credits decide an abandoned hold when the response ENDS: released with a
// ticket or on a >= 400, settled and flagged for the debt without one.
{
  _resetHangupForgiveness();
  const dir = join(TMP, "credits");
  const sessions = { cs_paid: { id: "cs_paid", mode: "payment", payment_status: "paid", payment_intent: "pi_1", customer_details: { email: "c@example.com" }, metadata: { credits_pack: "credits-20" } } };
  const stripe = { checkout: { sessions: { create: async () => ({ id: "x", url: "https://example.com" }), retrieve: async (id) => sessions[id] } } };
  const cr = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: dir, log: () => {} });
  const { key } = await cr.claim("cs_paid");
  const seen = [];
  const app = express();
  app.use(createHangupSettlementHook({ onUndelivered: (req, res, kind) => seen.push({ path: req.path, kind, charged: req.creditsCharged ?? null, onClose: req.creditsChargedOnClose ?? null }) }));
  app.use(cr.gate((m, p) => (["/forgiven", "/unforgiven", "/fails"].includes(p) ? { priceUsd: 0.25, slug: p.slice(1) } : null)));
  // Mimics the dispatcher: reserve at handler start, settle the ticket on close.
  const handler = (grant, status) => (req, res) => {
    if (grant) reserveHangupForgiveness(req, { keys: [`credits:${req.creditsKeyId}`, `ip:${req.path}`], priceUsd: 0.25 });
    res.once("close", () => settleHangupTicket(req, { abandoned: clientGoneBeforeFirstByte(req) }));
    setTimeout(() => { try { res.status(status).json({ ok: status === 200 }); } catch { /* gone */ } }, 300);
  };
  app.get("/forgiven", handler(true, 200));
  app.get("/unforgiven", handler(false, 200));
  app.get("/fails", handler(false, 502));
  const { server, url } = await listen(app);
  const auth = { Authorization: `Bearer ${key}` };
  await hangUp(`${url}/forgiven`, { headers: auth, abortAfterMs: 80 });
  await sleep(450);
  let bal = cr.balance(key);
  ok(bal.balanceUsd === 20 && bal.heldUsd === 0 && bal.calls === 0, `credits: a hang-up holding a ticket releases the hold (balance ${bal.balanceUsd}, held ${bal.heldUsd})`);
  ok(seen.length === 1 && seen[0].charged === null && seen[0].onClose === null, `credits: the hook sees the undelivered end with no charge evidence (${JSON.stringify(seen)})`);
  await hangUp(`${url}/fails`, { headers: auth, abortAfterMs: 80 });
  await sleep(450);
  bal = cr.balance(key);
  ok(bal.balanceUsd === 20 && bal.heldUsd === 0 && seen.length === 2 && seen[1].onClose === null, `credits: an abandoned run whose handler failed (502) is never charged, ticket or not (balance ${bal.balanceUsd})`);
  await hangUp(`${url}/unforgiven`, { headers: auth, abortAfterMs: 80 });
  await sleep(450);
  bal = cr.balance(key);
  ok(bal.balanceUsd === 19.75 && bal.heldUsd === 0 && bal.calls === 1, `credits: a hang-up WITHOUT a ticket settles the hold, as before the rule (balance ${bal.balanceUsd}, calls ${bal.calls})`);
  ok(seen.length === 3 && seen[2].path === "/unforgiven" && seen[2].onClose === 0.25, `credits: ... and flags it (creditsChargedOnClose) so the hook books it as owed (${JSON.stringify(seen[2])})`);
  const r = await fetch(`${url}/forgiven`, { headers: auth });
  ok(r.status === 200 && cr.balance(key).balanceUsd === 19.5 && seen.length === 3, "credits: a connected buyer is debited once and the hook stays quiet");
  server.close();
  _resetHangupForgiveness();
}

// 1g. A route whose effect outlives the answer never takes a ticket, whatever
// budget is left, and spends none of it. One slug per class, then the readers
// in the same families, which follow the budget like any other route.
{
  _resetHangupForgiveness();
  const classes = [
    ["memory-write", "the memory family's writers"], ["memory-remember", "the memory family's writers"], ["memory-forget", "the memory family's writers"],
    ["attest", "an attestation on Base"], ["feedback", "a verdict stored against a sale"],
    ["route-execute", "a purchase from an outside seller"], ["route-execute-pro", "a purchase from an outside seller"], ["seller-payability", "a purchase from an outside seller"],
  ];
  for (const [slug, why] of classes) {
    const req = { __a402ClientGoneAt: Date.now() };
    reserveHangupForgiveness(req, { keys: [`0x${slug}`, `ip:${slug}`], priceUsd: 0.001, slug });
    ok(!hangupForgiven(req) && !chargeCancelledForClientGone(req) && hangupTicketDenial(req) === "lasting effect", `${slug} (${why}): gone with budget to spare, the ticket is denied for a lasting effect, so the charge stands (${hangupTicketDenial(req)})`);
  }
  const st = hangupForgivenessStatus();
  ok(st.inflightUsd === 0 && st.abandonedInWindow === 0 && st.neverForgiven.includes("attest"), `a denied lasting-effect ticket holds no budget, and the operator surface lists the routes (${JSON.stringify(st)})`);
  for (const slug of ["uuid", "memory-read", "memory-recall", "memory-log", "memory-grants", "feedback-summary", null]) {
    const req = { __a402ClientGoneAt: Date.now() };
    reserveHangupForgiveness(req, { keys: [`0xr-${slug}`, `ip:r-${slug}`], priceUsd: 0.001, slug });
    ok(hangupForgiven(req) && chargeCancelledForClientGone(req) && hangupTicketDenial(req) === null, `${slug ?? "no slug"}: leaves nothing behind, so inside the budget the charge is cancelled`);
  }
  ok(!hasLastingEffect(undefined) && !hasLastingEffect({}) && !hasLastingEffect("Memory-Write") && hasLastingEffect("memory-write"), "hasLastingEffect matches exact catalog slugs only");
  ok(Object.isFrozen(LASTING_EFFECT_SLUG_LIST), "the published list is frozen");
  {
    // A route that pays from our own wallet before settlement is never
    // forgiven, listed or not (decide-execute pays outside sellers).
    const r = {}; const t = reserveHangupForgiveness(r, { keys: ["ip:198.51.100.7"], priceUsd: 0.05, slug: "some-new-wallet-spender", spendsOwnWallet: true });
    ok(t.granted === false && t.reason === "lasting effect", "a def that spends our own wallet takes no ticket, even when its slug is not on the list");
    const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
    ok(/reserveHangupForgiveness\(req, \{[^}]*spendsOwnWallet: def\.spendsOwnWallet === true/.test(src), "the reservation passes the catalog def's spendsOwnWallet");
  }
  _resetHangupForgiveness();
}

// 1f. Source pins for the seams the booted test cannot isolate, and for the
// vendor shape the x402 hook depends on.
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const payments = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  const tempo = readFileSync(new URL("../src/mpp-tempo.js", import.meta.url), "utf8");
  const stripeGate = readFileSync(new URL("../src/mpp-stripe.js", import.meta.url), "utf8");
  const hookAt = server.indexOf("app.use(createHangupSettlementHook(");
  const firstGate = Math.min(...["app.use(tempoGate)", "app.use(mppShim)", "app.use(stripeGate)", "app.use(_credits.gate("].map((s) => server.indexOf(s)).filter((i) => i >= 0));
  ok(hookAt > 0 && hookAt < firstGate, "server.js mounts the hang-up hook before every payment gate");
  ok(/app\.use\(createHangupSettlementHook\(\{ onUndelivered: recordHangupOutcome \}\)\)/.test(server), "the hook reports to recordHangupOutcome (debt or cancelled charge)");
  ok(/registerWalletBlocklistHook\(server\);\s*\n\s*registerClientGoneSettleHook\(server\);/.test(payments), "payments.js registers the client-gone settle hook beside the wallet blocklist");
  ok(/transportContext\?\.request\?\.adapter\?\.req/.test(payments) && /if \(!req \|\| !chargeCancelledForClientGone\(req\)\) return;/.test(payments) && /reason: "client_disconnected"/.test(payments), "the x402 hook aborts only when the charge is cancelled (gone + ticket)");
  const belt = server.indexOf("if (clientGoneBeforeFirstByte(req)) throw clientGoneError(");
  const handlerCall = server.indexOf("? await runInAbortableScope(() => tool.handler(input, req)");
  ok(belt > 0 && handlerCall > belt && handlerCall - belt < 2500, "the dispatcher's belt runs immediately before the handler call");
  // One post-paywall middleware reserves the ticket for EVERY paid catalog
  // route: after the last gate (the x402 dispatcher) and before any handler -
  // the memory family, the hand-written URL tools and the generic binder.
  const reserve = server.indexOf("reserveHangupForgiveness(req, { keys: hangupForgivenessKeys(req), priceUsd: quotedPriceUsd(def, req), slug: def.slug, spendsOwnWallet: def.spendsOwnWallet === true });");
  const x402At = server.indexOf("return x402mw(req, res, next);");
  const firstHandler = Math.min(...['app.post("/api/extract"', 'app.post("/api/memory"', "for (const tool of ALL_KIT) {\n  const [method, path] = tool.route.split"].map((s) => server.indexOf(s)).filter((i) => i >= 0));
  ok(reserve > 0 && x402At > 0 && reserve > x402At && reserve < firstHandler, "the ticket is reserved after every payment gate and before every paid handler");
  const mw = server.slice(server.lastIndexOf("app.use((req, res, next) => {", reserve), reserve);
  ok(/if \(clientGoneBeforeFirstByte\(req\)\) \{\s*\n\s*try \{ res\.status\(499\)/.test(mw) && /X-Pow-Accepted/.test(mw) && /req\.__a402Dispatched = true;/.test(mw), "that middleware answers 499 for a buyer already gone, skips proof-of-work and trial calls, and marks the request dispatched");
  // A request whose payment settled before its handler (a Tempo push
  // credential) is owed if undelivered, so it must not spend the budget.
  ok(/if \(req\.tempoSettled\) return next\(\);\s*\n\s*reserveHangupForgiveness\(/.test(server), "a request already settled before its handler (Tempo push) takes no ticket");
  ok(/res\.once\("close", \(\) => settleHangupTicket\(req, \{ abandoned: clientGoneBeforeFirstByte\(req\) \}\)\);/.test(server), "the ticket is settled on close (abandoned when gone before the first byte)");
  ok(/const who = payer \|\| \(req\.mppTempoSender \? `tempo:\$\{req\.mppTempoSender\}` : req\.creditsKeyId \? `credits:\$\{req\.creditsKeyId\}` : null\);\s*\n\s*return \[who, `ip:\$\{clientIp\(req\)\}`\];/.test(server), "ticket keys: the verified payer (never the Tempo source hint) AND always the client IP");
  ok(!/mppTempoPayer/.test(server.slice(server.indexOf("function hangupForgivenessKeys("), server.indexOf("function hangupForgivenessKeys(") + 600)), "the ticket keys never read the client-supplied Tempo payer hint");
  for (const [name, src, call] of [["mpp-tempo", tempo, "let b = await broadcast(auth);"], ["mpp-stripe", stripeGate, "const b = await settle(auth);"]]) {
    const check = src.indexOf("if (chargeCancelledForClientGone(req)) {");
    ok(check > 0 && src.indexOf(call) > check && src.indexOf(call) - check < 1200, `${name}: the cancelled-charge check precedes the ${call.includes("broadcast") ? "broadcast" : "capture"}`);
  }
  ok(/\} else if \(req\.creditsSettled && Number\(req\.creditsChargedOnClose\) > 0\) \{/.test(server), "the debt recorder books a credits hold settled on an abandoned run");
  ok(/const denied = hangupTicketDenial\(req\);[\s\S]{0,800}\$\{denied \? `; not forgiven: \$\{denied\}` : ""\}/.test(server), "the owed line names why the run was not forgiven");
  ok(/priceFor: \(method, path, req\) => \{[\s\S]{0,700}longRunning: isLongRunningSlug\(def\.slug\) \} : null;\s*\n\s*\},\s*\n\s*\/\/ Input check before the relay round trip/.test(server), "the Tempo GATE's priceFor carries longRunning (not only the challenge appender)");
  // The composite's client-gone signal aborts only when the charge is cancelled.
  ok(/\? await runInAbortableScope\(\(\) => tool\.handler\(input, req\), \{ signal: clientGoneCtl\.signal \}\)/.test(server), "the dispatcher runs a composite with the client-gone signal ({ signal })");
  ok(/res\.once\("close", \(\) => \{ if \(chargeCancelledForClientGone\(req\)\) ctl\.abort\(clientGoneError\(\)\); \}\);/.test(server), "the dispatcher aborts the composite's signal only when the charge is cancelled");
  const gatewayKit = readFileSync(new URL("../src/tools/llm-gateway-kit.js", import.meta.url), "utf8");
  const imagesKit = readFileSync(new URL("../src/tools/llm-images-fast-kit.js", import.meta.url), "utf8");
  const fnBody = (src, sig) => { const i = src.indexOf(sig); if (i < 0) return ""; const j = src.indexOf("\n}\n", i); return src.slice(i, j); };
  const fo = fnBody(gatewayKit, "export async function fetchOpenRouter(");
  ok(/const gone = clientGoneSignal\(\);/.test(fo) && /AbortSignal\.any\(\[own, gone\]\)/.test(fo) && /if \(gone\?\.aborted\) throw gone\.reason;/.test(fo), "fetchOpenRouter joins the client-gone signal (refuses to start, cuts off in flight, rethrows the 499)");
  ok(!/clientGoneSignal/.test(imagesKit), "the video poll and download do NOT join it: a submitted job bills in full, and the poll reports its usage");
  // Vendor shape: @x402/express hands the settle hooks `{ request: context, ... }`
  // where context.adapter is an ExpressAdapter holding the Express request. A
  // bump that moves it would silently revert to settle-then-owe; fail here.
  const vendor = readFileSync(new URL("../node_modules/@x402/express/dist/esm/index.mjs", import.meta.url), "utf8");
  ok(/\{ request: context, responseBody, responseHeaders \}/.test(vendor) && /const adapter = new ExpressAdapter\(req\);/.test(vendor) && /const context = \{\s*adapter,/.test(vendor), "vendor: @x402/express passes { request: context } with context.adapter = new ExpressAdapter(req)");
  ok(/var ExpressAdapter = class \{[\s\S]{0,400}this\.req = req;/.test(vendor), "vendor: ExpressAdapter keeps the Express request as this.req");
}

// ---------------------------------------------------------------- part 2

const [PORT, FAC_PORT, OR_PORT] = await getFreePorts(3);
const B = `http://127.0.0.1:${PORT}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"5e".repeat(32)}`;
const OP = "test-hangup-operator-token-0123456789";

// Stub facilitator: verify/settle counters with optional delays. Every settle
// answers a DISTINCT tx hash (the refund ledger is idempotent on it).
const fac = { verify: 0, settle: 0, verifyDelayMs: 0, settleDelayMs: 0 };
const txFor = (n) => (n === 1 ? TX : `0x${n.toString(16).padStart(64, "0")}`);
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", async () => {
    const reply = (obj) => { if (res.destroyed) return; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    // The stub facilitator verifies every payment as funded, so a balanceOf
    // read (src/inflight-cover.js, for concurrent runs from one wallet)
    // answers a funded wallet too: 1,000 USDC. Every other call keeps "0x0".
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
      const balanceOf = rpc.method === "eth_call" && String(rpc.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply({ jsonrpc: "2.0", id: 1, result: balanceOf ? "0x" + (1_000_000_000).toString(16).padStart(64, "0") : "0x0" });
    }
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { fac.verify++; if (fac.verifyDelayMs) await sleep(fac.verifyDelayMs); return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { const n = ++fac.settle; fac.lastTx = txFor(n); if (fac.settleDelayMs) await sleep(fac.settleDelayMs); return reply({ success: true, transaction: txFor(n), network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

// Stub OpenRouter: counts requests and counts its own inbound requests that
// were closed before it answered (an upstream call we cut off).
const or = { chat: 0, chatDelayMs: 0, chatClosedEarly: 0, images: 0, imagesDelayMs: 0, imagesClosedEarly: 0, imagesClosedAt: 0, other: 0 };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
orStub = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const url = String(req.url || "").split("?")[0];
    const send = (status, obj) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const trackEarlyClose = (key, atKey) => res.on("close", () => { if (!res.writableFinished) { or[key]++; if (atKey) or[atKey] = Date.now(); } });
    if (req.method === "POST" && url === "/api/v1/chat/completions") {
      or.chat++; trackEarlyClose("chatClosedEarly");
      setTimeout(() => send(200, { id: "gen-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "openai/gpt-6-luna", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }), or.chatDelayMs);
      return;
    }
    if (req.method === "GET" && /^\/api\/v1\/images\/models\/.+\/endpoints$/.test(url)) return send(200, { data: { endpoints: [] } });
    if (req.method === "POST" && url === "/api/v1/images") {
      or.images++; trackEarlyClose("imagesClosedEarly", "imagesClosedAt");
      setTimeout(() => send(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: PNG_B64 }], usage: { prompt_tokens: 0, completion_tokens: 0 } }), or.imagesDelayMs);
      return;
    }
    or.other++;
    send(404, { error: { message: "not stubbed" } });
  });
});
await new Promise((r) => orStub.listen(OR_PORT, "127.0.0.1", r));

// Budgets small enough to spend inside one run: $0.10 per wallet and per IP,
// $0.40 for the service, over a day. The nano tier is $0.003, the image tiers
// $0.02 (fast) and $0.05 (pro). The breaker and composite-guard thresholds
// stay at 3 so the test would show it if a hang-up still fed either of them.
// The abandoned records persist across a restart (a deploy is a restart):
// case m stops this server gracefully and boots a second one on the same file.
const HANGUP_FILE = join(TMP, "hangup-forgiveness.json");
const bootServer = () => spawn("node", ["--import", "./scripts/lib/openrouter-stub-preload.js", "--import", "./scripts/lib/hold-json-preload.js", "src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    OPENROUTER_API_KEY: "test-key-never-used", OPENROUTER_MANAGEMENT_KEY: "", OPENROUTER_STUB_URL: `http://127.0.0.1:${OR_PORT}`, OPENROUTER_FLEX: "off",
    GATEWAY_SETTLE_BREAKER_MAX: "3", GATEWAY_SETTLE_BREAKER_WINDOW_MS: "600000", GATEWAY_SETTLE_BREAKER_GLOBAL_MAX: "3",
    COMPOSITE_GUARD_MAX_FAILS: "3", COMPOSITE_GUARD_GLOBAL_MAX_FAILS: "3",
    HANGUP_FORGIVE: "", HANGUP_FORGIVE_KEY_USD: "0.1", HANGUP_FORGIVE_GLOBAL_USD: "0.4", HANGUP_FORGIVE_WINDOW_MS: "86400000",
    HANGUP_FORGIVE_FILE: HANGUP_FILE, HANGUP_FORGIVE_SALT: "hangup-test-salt",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
    AGENT402_OPERATOR_TOKEN: OP, REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_TEST_HOLD_JSON: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 500)); } };
proc = bootServer();
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);
const logSince = (i) => serverLog.slice(i).join("\n");

// The operator surface is rate limited per client IP (30 a minute); this test
// reads it after almost every case, so each read names its own address.
let opReads = 0;
const refundsDoc = async () => (await fetch(`${B}/__operator/refunds.json?status=all`, { headers: { Authorization: `Bearer ${OP}`, "x-forwarded-for": `10.254.${Math.floor(++opReads / 250) % 250}.${opReads % 250}` } })).json();
const refunds = async () => (await refundsDoc()).refunds || [];

// Crafted credentials: the stub facilitator is the only verifier, so a
// credential names its payer in authorization.from and a fresh nonce makes it
// a fresh authorization from the SAME wallet.
let nonceN = 0;
const credential = (accepted, payer) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x7000 + ++nonceN).toString(16).padStart(64, "0") } },
})).toString("base64");
const CHAT = { path: "/v1/nano/chat/completions", method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "say ok" }], max_tokens: 16 }) };
const PRO = { path: "/v1/images/pro", method: "POST", body: JSON.stringify({ prompt: "a red fox in the snow" }) };
const FAST = { path: "/v1/images/fast", method: "POST", body: JSON.stringify({ prompt: "a red fox in the snow" }) };
const accepts = {};
const acceptFor = async (t) => {
  if (accepts[t.path]) return accepts[t.path];
  const r = await fetch(`${B}${t.path}`, { method: t.method, headers: { "content-type": "application/json" }, body: t.body });
  ok(r.status === 402, `unpaid ${t.method} ${t.path} -> 402 (got ${r.status})`);
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
  accepts[t.path] = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(!!accepts[t.path], `${t.path} offers exact on Base`);
  return accepts[t.path];
};
// Every request names its client IP (the server trusts one proxy hop), so a
// scenario can hold the wallet or the IP fixed while it varies the other.
const headersFor = async (t, payer, ip) => ({ "content-type": "application/json", "x-forwarded-for": ip, "payment-signature": credential(await acceptFor(t), payer) });
const pay = async (t, payer, ip) => fetch(`${B}${t.path}`, { method: t.method, headers: await headersFor(t, payer, ip), body: t.body });
const wallet = (n) => `0x${n.toString(16).padStart(40, "0")}`;
// A hang-up once the upstream call has started (the handler is running).
const hangUpMidRun = async (t, payer, ip, { counter = "images", delayMs = 150 } = {}) => {
  const c0 = or[counter];
  const upstreamSeen = waitFor(() => or[counter] > c0, 8000);
  let abortedAt = 0;
  await hangUp(`${B}${t.path}`, { method: "POST", headers: await headersFor(t, payer, ip), body: t.body, abortWhen: upstreamSeen.then(() => sleep(delayMs)).then(() => { abortedAt = Date.now(); }) });
  return () => abortedAt;
};

try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up, "paid server booted with the OpenRouter stub preload");

  // The lasting-effect list against the BOOTED catalog: every slug on it is a
  // live route, every route-execute tier is on it, and every memory route is
  // classified - a writer on the list or a known reader here. A new memory
  // route, or a new router tier, fails until someone decides which it is.
  {
    const MEMORY_READERS = new Set(["memory-read", "memory-grants", "memory-log", "memory-recall"]);
    const slugs = new Set(((await (await fetch(`${B}/api/pricing`)).json()).endpoints || []).map((e) => e.slug));
    const missing = LASTING_EFFECT_SLUG_LIST.filter((sl) => !slugs.has(sl));
    ok(slugs.size > 100 && missing.length === 0, `every lasting-effect slug is a live catalog route (missing: ${JSON.stringify(missing)})`);
    const tiers = [...slugs].filter((sl) => sl.startsWith("route-execute"));
    ok(tiers.length >= 4 && tiers.every(hasLastingEffect), `every route-execute tier is on the list (${JSON.stringify(tiers)})`);
    const memory = [...slugs].filter((sl) => sl.startsWith("memory-"));
    const unclassified = memory.filter((sl) => !hasLastingEffect(sl) && !MEMORY_READERS.has(sl));
    ok(memory.length >= 11 && unclassified.length === 0 && [...MEMORY_READERS].every((sl) => slugs.has(sl) && !hasLastingEffect(sl)), `every memory route is a listed writer or a known reader (unclassified: ${JSON.stringify(unclassified)})`);
    ok(["attest", "feedback", "seller-payability"].every((sl) => slugs.has(sl) && hasLastingEffect(sl)) && slugs.has("feedback-summary") && !hasLastingEffect("feedback-summary"), "attest, feedback and seller-payability are listed; feedback-summary (a read) is not");
  }
  const [{ privateKeyToAccount, generatePrivateKey }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] =
    await Promise.all([import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch")]);

  // a. Control: a connected buyer (a real x402 client) settles, nothing owed.
  {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const r = await wrapFetchWithPayment(fetch, client)(`${B}/api/uuid`);
    ok(r.status === 200, `a. control: a connected x402 buyer is served (${r.status})`);
    await sleep(200);
    ok((await refunds()).length === 0, "a. control: a delivered paid call records no debt");
  }

  // b. The residual window: the buyer leaves while /settle itself is in
  // flight. The money moves; the charge is booked as owed, once.
  {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    let minted = null, mintedHeader = null;
    const capturing = async (input, init) => {
      const r = input instanceof Request ? input : new Request(input, init);
      for (const name of ["payment-signature", "x-payment"]) { const v = r.headers.get(name); if (v) { minted = v; mintedHeader = name; } }
      if (minted) return new Response("{}", { status: 402, headers: { "Content-Type": "application/json" } });
      return fetch(input, init);
    };
    await wrapFetchWithPayment(capturing, client)(`${B}/api/uuid`).catch(() => {});
    ok(!!minted, "b. captured a genuine signed payment header");
    fac.settleDelayMs = 1_200;
    const settlesBefore = fac.settle, logAt = serverLog.length;
    const settleSeen = waitFor(() => fac.settle > settlesBefore, 5000);
    await hangUp(`${B}/api/uuid`, { headers: { [mintedHeader]: minted, "x-forwarded-for": "10.0.0.2" }, abortWhen: settleSeen.then(() => sleep(100)) });
    await sleep(1_800);
    fac.settleDelayMs = 0;
    ok(fac.settle - settlesBefore === 1, `b. a close during the settle call itself: the payment settled (settles +${fac.settle - settlesBefore})`);
    const rows = (await refunds()).filter((row) => row.slug === "uuid");
    ok(rows.length === 1, `b. exactly one debt is recorded for the charge the buyer never received (${rows.length})`);
    ok(rows[0].evidence === fac.lastTx && rows[0].wire === "x402" && rows[0].httpStatus === 499 && (rows[0].network === "base" || rows[0].network === "eip155:8453") && rows[0].status === "owed",
      `b. the debt carries the settle tx, rail and a 499 marker (${JSON.stringify(rows[0])})`);
    ok(rows[0].hangupReason === "settled in flight", `b. the debt records that a granted ticket lost the race to the settle (${rows[0].hangupReason})`);
    ok(/\[hangup\] CHARGED-BUT-NOT-SERVED/.test(logSince(logAt)), "b. the log says CHARGED-BUT-NOT-SERVED");
    const again = await fetch(`${B}/api/uuid`, { headers: { [mintedHeader]: minted } });
    ok(again.status !== 200 && fac.settle - settlesBefore === 1, `b. re-sending the spent credential is refused (${again.status}), no second settle`);
    ok((await refunds()).length === 1, "b. and no second debt is minted");
  }

  // c. The buyer leaves while the payment is being verified: the handler never
  // runs, nothing settles, nothing is owed, and no forgiveness is spent.
  {
    const W = wallet(0xc1);
    fac.verifyDelayMs = 1_200;
    or.chatDelayMs = 0;
    const before = (await refundsDoc()).hangupForgiveness;
    for (let i = 1; i <= 3; i++) {
      const v0 = fac.verify, s0 = fac.settle, c0 = or.chat;
      const verifySeen = waitFor(() => fac.verify > v0, 5000);
      await hangUp(`${B}${CHAT.path}`, { method: "POST", headers: await headersFor(CHAT, W, "10.0.0.3"), body: CHAT.body, abortWhen: verifySeen.then(() => sleep(150)) });
      await sleep(1_500);
      ok(fac.verify - v0 === 1 && fac.settle === s0 && or.chat === c0, `c${i}. gone during verify: verified once, the handler never ran (chat stub +${or.chat - c0}), nothing settled (settles +${fac.settle - s0})`);
    }
    fac.verifyDelayMs = 0;
    const after = (await refundsDoc()).hangupForgiveness;
    ok((await refunds()).length === 1, "c. no debt for a payment that was never settled");
    ok(after.abandonedInWindow === before.abandonedInWindow, `c. a run refused before its handler spends no forgiveness (${before.abandonedInWindow} -> ${after.abandonedInWindow})`);
    const s0 = fac.settle;
    const r = await pay(CHAT, W, "10.0.0.3");
    ok(r.status === 200 && fac.settle === s0 + 1, `c. the same wallet is then served (status ${r.status}, settles +${fac.settle - s0})`);
  }

  // d. The buyer leaves mid-handler on a non-composite route, inside the
  // budget: the payment is not settled, nothing is owed, and the spent
  // credential cannot buy a second run.
  {
    const WD = wallet(0xd1);
    or.chatDelayMs = 1_500;
    const s0 = fac.settle, c0 = or.chat, logAt = serverLog.length;
    const headers = await headersFor(CHAT, WD, "10.0.0.4");
    const upstreamSeen = waitFor(() => or.chat > c0, 5000);
    await hangUp(`${B}${CHAT.path}`, { method: "POST", headers, body: CHAT.body, abortWhen: upstreamSeen.then(() => sleep(150)) });
    await sleep(2_000);
    ok(or.chat - c0 === 1 && fac.settle === s0, `d. gone mid-handler: the handler ran (chat stub +${or.chat - c0}), the payment was NOT settled (settles +${fac.settle - s0})`);
    ok((await refunds()).length === 1, "d. a cancelled charge is not a refund-ledger debt: no row");
    const log = logSince(logAt);
    ok(/\[hangup\] NOT CHARGED: [^\n]*POST \/v1\/nano\/chat\/completions rail=x402[^\n]*within the hang-up forgiveness budget/.test(log) && !/CHARGED-BUT-NOT-SERVED/.test(log), "d. the log says NOT CHARGED within the forgiveness budget");
    const c1 = or.chat;
    const again = await fetch(`${B}${CHAT.path}`, { method: "POST", headers, body: CHAT.body });
    ok(again.status === 409 && or.chat === c1, `d. re-sending the same credential is refused 409 and runs nothing (status ${again.status}, chat stub +${or.chat - c1})`);
    or.chatDelayMs = 0;
  }

  // e. Interleaved: one wallet, [2 hang-ups on /v1/images/pro, then a
  // paid /v1/images/fast] - each from a different IP, so only the WALLET's
  // budget binds. The first two are forgiven and cut off in flight; the paid
  // success resets nothing; the third hang-up is past the wallet's $0.10, so it
  // runs to the end, SETTLES, and is booked as owed. Never refused.
  {
    const WE = wallet(0xe1);
    or.imagesDelayMs = 2_000;
    for (let i = 1; i <= 2; i++) {
      const i0 = or.images, e0 = or.imagesClosedEarly, s0 = fac.settle, logAt = serverLog.length;
      const abortedAt = await hangUpMidRun(PRO, WE, `10.0.1.${i}`);
      const cut = await waitFor(() => or.imagesClosedEarly > e0, 3000);
      ok(cut && or.imagesClosedAt - abortedAt() < 1_000, `e${i}. forgiven: the image call in flight is cut off within a second of the buyer leaving (${or.imagesClosedAt - abortedAt()} ms)`);
      await sleep(600);
      ok(or.images - i0 === 1 && fac.settle === s0, `e${i}. exactly one upstream POST (no failover link after the buyer left), nothing settled (POSTs +${or.images - i0}, settles +${fac.settle - s0})`);
      if (i === 1) ok(/\[hangup\] NOT CHARGED: [^\n]*POST \/v1\/images\/pro rail=x402 after \d+ ms of work\) - payment not settled; within the hang-up forgiveness budget/.test(logSince(logAt)), "e1. the log says NOT CHARGED on /v1/images/pro");
    }
    or.imagesDelayMs = 0;
    const s1 = fac.settle;
    const paid = await pay(FAST, WE, "10.0.1.9");
    ok(paid.status === 200 && fac.settle === s1 + 1, `e. a paid /v1/images/fast from the same wallet is served and settles (status ${paid.status})`);
    or.imagesDelayMs = 1_500;
    const i0 = or.images, e0 = or.imagesClosedEarly, s0 = fac.settle, owed0 = (await refunds()).length, logAt = serverLog.length;
    await hangUpMidRun(PRO, WE, "10.0.1.3");
    await sleep(2_500);
    ok(or.imagesClosedEarly === e0 && or.images - i0 === 1, `e3. past the wallet's budget: the run is NOT cut off, it finishes (closed early +${or.imagesClosedEarly - e0}, POSTs +${or.images - i0})`);
    ok(fac.settle === s0 + 1, `e3. ... and the payment SETTLES: a hang-up is not a free run once the budget is spent (settles +${fac.settle - s0})`);
    const rows = (await refunds()).filter((row) => row.slug === "v1-images-pro");
    ok((await refunds()).length === owed0 + 1 && rows.length === 1 && rows[0].httpStatus === 499 && rows[0].status === "owed" && rows[0].priceUsd === 0.05, `e3. ... and the undelivered charge is booked as owed once (${JSON.stringify(rows)})`);
    ok(rows[0]?.hangupReason === "payer budget", `e3. ... and the debt records the wallet's spent budget as the reason (${rows[0]?.hangupReason})`);
    ok(/\[hangup\] CHARGED-BUT-NOT-SERVED: [^\n]*POST \/v1\/images\/pro/.test(logSince(logAt)), "e3. the log says CHARGED-BUT-NOT-SERVED");
    or.imagesDelayMs = 0;
    const s2 = fac.settle;
    const next = await pay(PRO, WE, "10.0.1.4");
    ok(next.status === 200 && fac.settle === s2 + 1, `e. the wallet is never refused: its next connected call is served and settles (status ${next.status})`);
  }

  // f. One IP rotating wallets: bounded by the IP's budget.
  {
    or.imagesDelayMs = 1_500;
    const s0 = fac.settle, owed0 = (await refunds()).length, e0 = or.imagesClosedEarly;
    for (let i = 1; i <= 3; i++) { await hangUpMidRun(PRO, wallet(0xf0 + i), "10.0.2.1"); await sleep(2_300); }
    const newest = (await refunds()).slice(0, (await refunds()).length - owed0);
    ok(newest.length === 1 && newest[0].hangupReason === "ip budget", `f. the owed run records the IP's spent budget as the reason (${newest.map((r) => r.hangupReason)})`);
    ok(or.imagesClosedEarly - e0 === 2 && fac.settle - s0 === 1 && (await refunds()).length === owed0 + 1, `f. three wallets from one IP: two forgiven and cut off, the third settled and owed (cut +${or.imagesClosedEarly - e0}, settles +${fac.settle - s0}, owed +${(await refunds()).length - owed0})`);
    or.imagesDelayMs = 0;
  }

  // g. Ten CONCURRENT hang-ups from one wallet on
  // /v1/images/fast, each from its own IP. Tickets are reserved when each
  // handler starts, so in-flight runs count: exactly five fit the wallet's
  // $0.10, and the other five are settled and owed.
  {
    const WC = wallet(0x61c);
    or.imagesDelayMs = 2_000;
    const i0 = or.images, e0 = or.imagesClosedEarly, s0 = fac.settle, owed0 = (await refunds()).length;
    const heads = await Promise.all(Array.from({ length: 10 }, (_, i) => headersFor(FAST, WC, `10.0.3.${i}`)));
    const allUp = waitFor(() => or.images - i0 >= 10, 8000);
    await Promise.all(heads.map((headers) => hangUp(`${B}${FAST.path}`, { method: "POST", headers, body: FAST.body, abortWhen: allUp.then(() => sleep(150)) })));
    await sleep(3_000);
    ok(or.images - i0 === 10, `g. all ten runs started upstream (POSTs +${or.images - i0})`);
    ok(or.imagesClosedEarly - e0 === 5 && fac.settle - s0 === 5, `g. five forgiven (cut off, not settled), five settled (cut +${or.imagesClosedEarly - e0}, settles +${fac.settle - s0})`);
    ok((await refunds()).length === owed0 + 5, `g. the five settled runs are booked as owed (+${(await refunds()).length - owed0})`);
    or.imagesDelayMs = 0;
  }

  // l. A route whose effect outlives the answer is never forgiven. The
  // hold-json preload keeps each fast handler's answer back for 900 ms after it
  // RAN, and the buyer closes inside that hold: the work is done, no byte has
  // gone out, nothing has settled. Every request comes from a fresh wallet on
  // a fresh IP with the service budget far from spent, so only the slug can
  // decide. The ordinary tool is forgiven; the four lasting-effect classes
  // settle, are booked as owed, and spend no budget.
  {
    const Database = (await import("better-sqlite3")).default;
    const sales = new Database(join(TMP, "sales.db"));
    const saleRow = (tx) => sales.prepare("SELECT id, slug, payer, response_sha256 FROM sales WHERE tx = ?").get(tx);
    const waitForAsync = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return fn(); };
    const HOLD = "900";
    const UUID = { path: "/api/uuid", method: "GET", body: undefined };
    // A connected paid call whose sale the feedback and attest cases rate.
    const buyUuid = async (payer, ip) => {
      const r = await pay(UUID, payer, ip);
      const tx = JSON.parse(Buffer.from(r.headers.get("payment-response") || "", "base64").toString("utf-8") || "{}").transaction;
      ok(r.status === 200 && !!tx && await waitForAsync(() => !!saleRow(tx)), `l. a connected paid call from ${payer.slice(0, 8)}… settled and its sale is on the ledger (${tx})`);
      return tx;
    };
    // Hang up while the handler's answer is held: after the work, before any byte.
    const heldHangUp = async (t, payer, ip) => {
      const logAt = serverLog.length;
      const held = waitFor(() => serverLog.slice(logAt).some((line) => line.includes(`[hold-json] holding ${t.method} ${t.path.split("?")[0]}`)), 8000);
      const headers = { ...(await headersFor(t, payer, ip)), "x-test-hold-json-ms": HOLD };
      await hangUp(`${B}${t.path}`, { method: t.method, headers, body: t.body, abortWhen: held.then(() => sleep(100)) });
      return logAt;
    };

    // l0. Control: an ordinary tool, same shape of hang-up, inside the budget.
    {
      const s0 = fac.settle, owed0 = (await refunds()).length;
      const logAt = await heldHangUp(UUID, wallet(0x9a0), "10.0.9.1");
      await sleep(1_500);
      ok(fac.settle === s0 && (await refunds()).length === owed0, `l0. an ordinary tool whose buyer left after the handler ran, inside the budget: NOT settled, nothing owed (settles +${fac.settle - s0})`);
      ok(/\[hangup\] NOT CHARGED: [^\n]*GET \/api\/uuid[^\n]*within the hang-up forgiveness budget/.test(logSince(logAt)), "l0. the log says NOT CHARGED within the forgiveness budget");
    }
    const budgetBefore = (await refundsDoc()).hangupForgiveness;
    const lasting = async (label, t, payer, ip, slug) => {
      const s0 = fac.settle, owed0 = (await refunds()).length;
      const logAt = await heldHangUp(t, payer, ip);
      // Wait on the server's own line, not by polling the operator surface
      // (it is rate limited).
      const lineOf = () => logSince(logAt).split("\n").find((l) => /\[hangup\] (CHARGED-BUT-NOT-SERVED|NOT CHARGED)/.test(l) && l.includes(`${t.method} ${t.path.split("?")[0]} `)) || "";
      await waitFor(() => !!lineOf(), 6000);
      await sleep(100);
      ok(fac.settle === s0 + 1, `${label}. ${slug}: the buyer left after the handler ran, with budget to spare, and the payment SETTLED (settles +${fac.settle - s0})`);
      const all = await refunds();
      const rows = all.filter((row) => row.slug === slug);
      ok(all.length === owed0 + 1 && rows.length === 1 && rows[0].httpStatus === 499 && rows[0].status === "owed" && rows[0].evidence === fac.lastTx, `${label}. ${slug}: the undelivered answer is booked as owed once (${all.length - owed0} new; ${JSON.stringify(rows)})`);
      const line = lineOf();
      ok(/not forgiven: lasting effect/.test(line), `${label}. ${slug}: the log says it was not forgiven for a lasting effect (...${line.slice(-60)})`);
      ok(rows[0]?.hangupReason === "lasting effect", `${label}. ${slug}: the debt records the lasting effect as the reason (${rows[0]?.hangupReason})`);
    };

    // l1. The memory family: the write happened, so the charge stands.
    {
      const key = `hangup-l1-${Date.now()}`;
      const MEMW = { path: "/api/memory", method: "POST", body: JSON.stringify({ key, value: "kept" }) };
      await lasting("l1", MEMW, wallet(0x9a1), "10.0.9.2", "memory-write");
      const read = await pay({ path: `/api/memory?key=${key}`, method: "GET", body: undefined }, wallet(0x9a1), "10.0.9.3");
      const doc = await read.json();
      ok(read.status === 200 && doc.value === "kept", `l1. ... and the value it wrote is there for the wallet that paid (${read.status} ${JSON.stringify(doc).slice(0, 120)})`);
    }
    // l2. feedback: the verdict is stored against the sale.
    {
      const tx = await buyUuid(wallet(0x9a2), "10.0.9.4");
      const FB = { path: "/api/feedback", method: "POST", body: JSON.stringify({ tx, verdict: "good" }) };
      await lasting("l2", FB, wallet(0x9a2), "10.0.9.5", "feedback");
      const verdict = sales.prepare("SELECT verdict FROM sale_feedback WHERE tx = ?").get(tx);
      ok(verdict?.verdict === "good", `l2. ... and the verdict is on the ledger (${JSON.stringify(verdict)})`);
    }
    // l3. attest. This test has no chain, so the sale is marked as already
    // attested (what a written attestation leaves on the row) and the handler
    // answers with the existing UID - still a 200 on the attest route, which
    // is all the forgiveness decision reads.
    {
      const tx = await buyUuid(wallet(0x9a3), "10.0.9.6");
      const row = saleRow(tx);
      ok(/^[0-9a-f]{64}$/.test(String(row?.response_sha256 || "")), "l3. the sale carries the response digest attest binds to");
      sales.prepare("UPDATE sales SET attest_uid = ?, attest_tx = ? WHERE id = ?").run(`0x${"ab".repeat(32)}`, `0x${"cd".repeat(32)}`, row.id);
      const AT = { path: "/api/attest", method: "POST", body: JSON.stringify({ tx }) };
      await lasting("l3", AT, wallet(0x9a3), "10.0.9.7", "attest");
    }
    // l4. route-execute: the router pays outside sellers from our wallet.
    {
      const RX = { path: "/api/route/execute", method: "POST", body: JSON.stringify({ slug: "uuid" }) };
      await lasting("l4", RX, wallet(0x9a4), "10.0.9.8", "route-execute");
    }
    const budgetAfter = (await refundsDoc()).hangupForgiveness;
    ok(budgetAfter.abandonedInWindow === budgetBefore.abandonedInWindow && Math.abs(budgetAfter.abandonedUsdInWindow - budgetBefore.abandonedUsdInWindow) < 1e-9 && budgetAfter.inflightUsd === 0, `l. the lasting-effect hang-ups spent no forgiveness budget (${budgetBefore.abandonedInWindow} -> ${budgetAfter.abandonedInWindow})`);
    sales.close();
  }

  // h. Rotating wallets AND IPs: bounded by the service-wide budget ($0.40).
  // Forgiven so far: $0.001 (b) + $0.003 (d) + $0.10 (e) + $0.10 (f) + $0.10
  // (g) + $0.001 (l0) = $0.305, so one more $0.05 run fits and the next does
  // not. The lasting-effect hang-ups in l took no ticket and add nothing.
  {
    const st = (await refundsDoc()).hangupForgiveness;
    ok(Math.abs(st.abandonedUsdInWindow - 0.305) < 1e-9 && st.inflightUsd === 0 && st.perKeyBudgetUsd === 0.1 && st.globalBudgetUsd === 0.4, `h. the operator surface reports the budget in use (${JSON.stringify(st)})`);
    or.imagesDelayMs = 1_500;
    const s0 = fac.settle, owed0 = (await refunds()).length, e0 = or.imagesClosedEarly;
    await hangUpMidRun(PRO, wallet(0x71), "10.0.4.1"); await sleep(2_300);
    ok(or.imagesClosedEarly - e0 === 1 && fac.settle === s0, "h. a fresh wallet on a fresh IP inside the global budget: forgiven");
    await hangUpMidRun(PRO, wallet(0x72), "10.0.4.2"); await sleep(2_300);
    ok(or.imagesClosedEarly - e0 === 1 && fac.settle === s0 + 1 && (await refunds()).length === owed0 + 1, `h. the next fresh wallet on a fresh IP is past the global budget: settled and owed (settles +${fac.settle - s0})`);
    ok(serverLog.some((l) => /\[hangup\] forgiveness budget for the whole service is spent/.test(l)), "h. the server says the service-wide budget is spent");
    const owedNow = await refunds();
    ok(owedNow[0]?.hangupReason === "global budget", `h. the owed run records the service's spent budget as the reason (${owedNow[0]?.hangupReason})`);
    // End to end: the refund planner reads these very rows. Every budget
    // denial is held for review; the in-flight race (b) is an ordinary debt.
    const plan = planRefunds(owedNow.filter((r) => r.status === "owed"), { senders: { evm: true } });
    const heldIds = new Set((plan.held[REPEAT_HANGUP_HOLD] || []).map((r) => r.id));
    const budgetRows = owedNow.filter((r) => ["payer budget", "ip budget", "global budget"].includes(r.hangupReason));
    ok(budgetRows.length >= 8 && budgetRows.every((r) => heldIds.has(r.id)), `h. the planner holds every budget-denied debt for review (${budgetRows.length} rows, ${heldIds.size} held)`);
    ok(plan.send.some((r) => r.slug === "uuid" && r.hangupReason === "settled in flight"), "h. ... and still plans the in-flight race as an ordinary refund");
    or.imagesDelayMs = 0;
    const r = await pay(PRO, wallet(0x73), "10.0.4.3");
    ok(r.status === 200, `h. and nobody is refused: a connected buyer is served (${r.status})`);
  }

  // k. With the wallet's budget spent (WE, from e), a buyer who leaves while the
  // payment is being verified still costs nothing and is charged nothing: the
  // post-paywall middleware answers 499 before any handler, on the generic
  // binder (nano) and on a route outside it (the memory family). Without that
  // 499 the memory handler would run, answer 200, and - no ticket left - be
  // settled and booked as owed.
  {
    const MEM = { path: "/api/memory", method: "POST", body: JSON.stringify({ key: "hangup-k", value: "v" }) };
    fac.verifyDelayMs = 1_200;
    const s0 = fac.settle, owed0 = (await refunds()).length, c0 = or.chat;
    for (const [t, ip] of [[MEM, "10.0.7.1"], [CHAT, "10.0.7.2"]]) {
      const v0 = fac.verify;
      const verifySeen = waitFor(() => fac.verify > v0, 5000);
      await hangUp(`${B}${t.path}`, { method: "POST", headers: await headersFor(t, wallet(0xe1), ip), body: t.body, abortWhen: verifySeen.then(() => sleep(150)) });
      await sleep(1_600);
    }
    fac.verifyDelayMs = 0;
    ok(fac.settle === s0 && (await refunds()).length === owed0 && or.chat === c0, `k. gone during verify with the wallet's budget spent: nothing ran, nothing settled, nothing owed (settles +${fac.settle - s0}, owed +${(await refunds()).length - owed0}, chat stub +${or.chat - c0})`);
    const r = await pay(MEM, wallet(0xe1), "10.0.7.3");
    ok(r.status === 200 && fac.settle === s0 + 1, `k. control: the same memory write from a connected buyer is served and settles (${r.status})`);
  }

  // i. Control: the buyer reads the WHOLE answer, then drops the socket. An
  // ordinary settled sale: no debt, no hang-up line.
  {
    const WG = wallet(0x81);
    or.chatDelayMs = 0;
    const s0 = fac.settle, logAt = serverLog.length, owed0 = (await refunds()).length;
    const headers = await headersFor(CHAT, WG, "10.0.5.1");
    const status = await new Promise((resolve) => {
      const req = httpRequest(`${B}${CHAT.path}`, { method: "POST", headers });
      req.on("response", (res) => { res.on("data", () => {}); res.on("end", () => { req.destroy(); resolve(res.statusCode); }); });
      req.on("error", () => resolve(0));
      req.write(CHAT.body); req.end();
    });
    await sleep(300);
    ok(status === 200 && fac.settle === s0 + 1, `i. a buyer who read the whole answer and then closed: served and settled once (status ${status})`);
    ok((await refunds()).length === owed0 && !/\[hangup\]/.test(logSince(logAt)), "i. no debt and no hang-up line for a delivered answer");
  }

  // j. Nothing a hang-up does feeds the settle breaker or the composite
  // guard: after all of the above, the wallets that hung up most are served.
  {
    const r1 = await pay(CHAT, wallet(0xd1), "10.0.6.1");
    const r2 = await pay(PRO, wallet(0x61c), "10.0.6.2");
    ok(r1.status === 200 && r2.status === 200, `j. no 429 anywhere: the hang-up wallets are served (${r1.status}, ${r2.status})`);
  }

  // m. The budget survives a restart. Every deploy is one, so a record kept
  // only in memory would hand a fresh budget to whoever hung up before it.
  // Stop this server the way a deploy does (SIGTERM, so the shutdown flush
  // runs), boot a second one on the same file, and read the budget back.
  {
    const before = (await refundsDoc()).hangupForgiveness;
    const remaining = before.globalBudgetUsd - before.abandonedUsdInWindow;
    ok(before.persisted === true && before.abandonedUsdInWindow > 0.3 && remaining < 0.05, `m. precondition: the service budget is nearly spent before the restart ($${before.abandonedUsdInWindow.toFixed(3)} of $${before.globalBudgetUsd})`);
    const fileText = readFileSync(HANGUP_FILE, "utf8");
    ok(!/10\.0\.\d+\.\d+/.test(fileText) && !/0x0{20,}[0-9a-f]+/i.test(fileText) && /"(ip|payer):[0-9a-f]{24}"/.test(fileText), "m. the persisted file holds keyed digests, never a client IP or a wallet address");
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    ok(await Promise.race([exited.then(() => true), sleep(90_000).then(() => false)]), "m. the first server exits on SIGTERM");
    const logAt = serverLog.length;
    proc = bootServer();
    proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);
    let back = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { back = true; break; } } catch { /* booting */ } await sleep(500); }
    ok(back, "m. the second server booted on the same forgiveness file");
    ok(/\[hangup\] forgiveness records restored: \d+ service-wide, \d+ keys/.test(logSince(logAt)), "m. the boot log says the records were restored");
    const after = (await refundsDoc()).hangupForgiveness;
    ok(after.abandonedInWindow === before.abandonedInWindow && Math.abs(after.abandonedUsdInWindow - before.abandonedUsdInWindow) < 1e-9 && after.keysTracked === before.keysTracked && after.inflightUsd === 0, `m. the budget in use is the same after the restart (${before.abandonedInWindow}/${before.keysTracked} -> ${after.abandonedInWindow}/${after.keysTracked})`);
    // Behaviour, not only counts: a fresh server would forgive a $0.05
    // hang-up from a fresh wallet on a fresh IP; this one must settle it and
    // book it as owed, because the restored record leaves less than $0.05.
    or.imagesDelayMs = 1_500;
    const s0 = fac.settle, owed0 = (await refunds()).length, e0 = or.imagesClosedEarly, at = serverLog.length;
    await hangUpMidRun(PRO, wallet(0x91), "10.0.9.1"); await sleep(2_300);
    or.imagesDelayMs = 0;
    ok(or.imagesClosedEarly === e0 && fac.settle === s0 + 1 && (await refunds()).length === owed0 + 1, `m. after the restart a fresh wallet's hang-up is past the restored service budget: settled and owed (settles +${fac.settle - s0}, owed +${(await refunds()).length - owed0})`);
    ok(/not forgiven: global budget/.test(logSince(at)), "m. and the owed line names the service-wide budget");
  }

  if (process.env.HANGUP_TEST_SHOW_LOG) console.log(serverLog.filter((l) => /\[hangup\]/.test(l)).join("\n"));
  console.log(`\nPASS - ${pass} checks (a buyer gone before the first byte is not charged, within a budget)`);
  cleanup();
  process.exit(0);
} catch (e) {
  fail(`unexpected: ${e?.stack || e}`);
}
