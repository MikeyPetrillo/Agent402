// A paid run that never gets paid must meet a bound, whatever the buyer does
// with the connection or the authorization's lifetime.
//
// @x402/express runs the handler FIRST and settles AFTER, and the facilitator
// re-verifies at settle time. The rules pinned here, each with its honest-path
// control:
//   1. The settle-failure bounds (the composite guard, the gateway and catalog
//      breakers) hear every settlement outcome, including one decided after
//      the buyer closed the connection (src/hangup-settlement.js
//      onSettleOutcome). A charge cancelled for a buyer who left inside the
//      forgiveness budget stays uncounted.
//   2. On a route whose measured run is long, an EVM authorization must
//      outlive the run or, under EVM_VALIDITY_FLOOR=enforce, it is refused
//      before the handler (src/evm-validity.js; the default logs); the floor
//      never exceeds what a stock client carries. route-execute's external
//      leg and seller-payability pay an outside seller only while the
//      buyer's authorization can still settle after the seller answers, and
//      the seller call keeps the payer's own timeout.
//   3. The composite guard's service-wide pause takes at most three failures
//      from any one buyer.
//   4. On the expensive routes a wallet's concurrent runs must be covered by
//      its balance together, or the extra run is refused before it starts
//      (src/inflight-cover.js). A run judged after another of the wallet's
//      runs has left is judged on a balance read taken after that departure.
// Part 1 is offline. Part 2 boots the REAL paid server against a stub
// facilitator that applies the reference 6 s validBefore rule at settle, and a
// stub OpenRouter (scripts/lib/openrouter-stub-preload.js; the preload refuses
// to load without the stub, so this never spends upstream).
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createHangupSettlementHook, onSettleOutcome, onResponseEnd } from "../src/hangup-settlement.js";
import { reserveHangupForgiveness, _resetHangupForgiveness } from "../src/hangup-forgiveness.js";
import { evmCredentialExpiry, requiredEvmSecondsFor, evmValidityShortfall, assertEvmValidityCovers, evmValidityMode, evmCredentialSettleableMs, evmCredentialBudgetMs, EVM_RUN_SECONDS, CLIENT_SLACK_SECONDS, SETTLE_RULE_SECONDS, EVM_SELLER_ALLOWANCE_MS } from "../src/evm-validity.js";
import { coverTermsOf, admitCoveredRun, inflightCoverStatus, markCoveredRunSettled, _setBalanceReaderForTest, _resetInflightCoverForTest } from "../src/inflight-cover.js";
import { registerInflightCoverSettleHook, registerFacilitatorFailureHooks } from "../src/payments.js";
import { x402ResourceServer } from "@x402/core/server";
import { buildRouteExecuteTool } from "../src/tools/route-execute.js";
import { getFreePorts } from "./lib/free-port.js";

let pass = 0, proc = null, facilitator = null, orStub = null;
const serverLog = [];
const TMP = mkdtempSync(join(tmpdir(), "paytime-"));
const cleanup = () => { proc?.kill("SIGKILL"); facilitator?.close(); orStub?.close(); rmSync(TMP, { recursive: true, force: true }); };
const fail = (m) => { console.error("FAIL:", m); for (const l of serverLog.slice(-30)) console.error("  server:", l); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` })); });
const waitFor = async (cond, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(20); } return cond(); };
const nowS = () => Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
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

// 1a. The outcome seam: a response ended by a gate after the buyer left is
// heard once; a forgiven hang-up reaches the bookkeeping listener only.
{
  _resetHangupForgiveness();
  const seen = [];
  const app = express();
  app.use(createHangupSettlementHook({ onUndelivered: () => {} }));
  // A buffered "gate": the handler's answer is held, then the gate ends the
  // response with the status settlement produced.
  const gate = (status, { forgive = false } = {}) => (req, res) => {
    if (forgive) reserveHangupForgiveness(req, { keys: ["0xseam", "ip:seam"], priceUsd: 0.001 });
    onSettleOutcome(req, res, (info) => seen.push({ path: req.path, kind: "settle", status: res.statusCode, ...info }));
    onResponseEnd(req, res, (info) => seen.push({ path: req.path, kind: "always", status: res.statusCode, ...info }));
    setTimeout(() => { try { res.status(status).json({}); } catch { /* socket gone */ } }, 250);
  };
  app.get("/fail", gate(402));
  app.get("/ok", gate(200));
  app.get("/forgiven", gate(402, { forgive: true }));
  app.get("/stream", (req, res) => {
    onSettleOutcome(req, res, (info) => seen.push({ path: req.path, kind: "settle", status: res.statusCode, ...info }));
    res.writeHead(200, { "content-type": "text/plain" }); res.write("part");
    setTimeout(() => { try { res.end("rest"); } catch { /* gone */ } }, 300);
  });
  const { server, url } = await listen(app);
  await hangUp(`${url}/fail`, { abortAfterMs: 60 });
  await sleep(400);
  const f = seen.filter((s) => s.path === "/fail");
  ok(f.length === 2 && f.some((s) => s.kind === "settle" && s.via === "undelivered" && s.status === 402 && !s.forgiven), `a 402 the gate writes after the buyer left reaches the settle listener once, as undelivered (${JSON.stringify(f)})`);
  await fetch(`${url}/ok`);
  await sleep(100);
  const o = seen.filter((s) => s.path === "/ok");
  ok(o.length === 2 && o.every((s) => s.via === "finish" && s.status === 200), `control: a connected response is heard once, on finish (${JSON.stringify(o)})`);
  await hangUp(`${url}/forgiven`, { abortAfterMs: 60 });
  await sleep(400);
  const g = seen.filter((s) => s.path === "/forgiven");
  ok(g.length === 1 && g[0].kind === "always" && g[0].forgiven === true, `a charge cancelled inside the forgiveness budget is NOT a settlement outcome: only the bookkeeping listener hears it (${JSON.stringify(g)})`);
  await new Promise((resolve) => { const r = httpRequest(`${url}/stream`, (res) => { res.once("data", () => { r.destroy(); resolve(); }); }); r.on("error", () => resolve()); r.end(); });
  await sleep(450);
  const s = seen.filter((x) => x.path === "/stream");
  ok(s.length === 1 && s[0].via === "close" && s[0].status === 200, `a response cut after its headers went out is heard on close (${JSON.stringify(s)})`);
  server.close();
  _resetHangupForgiveness();
}

// 1b. The EVM validity floor: decode, sizing, and the pure decision.
{
  const eip = (validBefore, extra = {}) => b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", maxTimeoutSeconds: 300, ...extra }, payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20), value: "600000", validAfter: "0", validBefore: String(validBefore), nonce: "0x" + "01".repeat(32) } } });
  const permit2 = (deadline) => b64({ x402Version: 2, accepted: { scheme: "upto", network: "eip155:8453", maxTimeoutSeconds: 300 }, payload: { signature: "0x" + "11".repeat(65), permit2Authorization: { from: "0x" + "ab".repeat(20), deadline: String(deadline), nonce: "1" } } });
  const v1 = (validBefore) => b64({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x11", authorization: { from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20), value: "1", validAfter: "0", validBefore: String(validBefore), nonce: "0x" + "02".repeat(32) } } });
  ok(evmCredentialExpiry(eip(1234567890))?.expiresAt === 1234567890 && evmCredentialExpiry(eip(1))?.form === "eip3009", "an EIP-3009 authorization's validBefore is read");
  ok(evmCredentialExpiry(permit2(1234567890))?.form === "permit2" && evmCredentialExpiry(permit2(1234567890)).expiresAt === 1234567890, "a Permit2 authorization's deadline is read (upto, exact over Permit2)");
  ok(evmCredentialExpiry(v1(42))?.expiresAt === 42, "an x402 v1 payload is read too");
  ok(evmCredentialExpiry(b64({ x402Version: 2, accepted: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, payload: { transaction: "AAAA" } })) === null && evmCredentialExpiry(b64({ accepted: { network: "algorand:x" }, payload: { paymentGroup: [] } })) === null, "Solana and Algorand payloads are not EVM authorizations");
  ok(evmCredentialExpiry("not base64 json") === null && evmCredentialExpiry("") === null && evmCredentialExpiry(eip("1e9")) === null && evmCredentialExpiry(eip("-5")) === null, "garbage, an empty header and a non-integer validBefore read as nothing");

  ok(requiredEvmSecondsFor("research") === 180 + SETTLE_RULE_SECONDS && requiredEvmSecondsFor("ticker-pack") === 186 && requiredEvmSecondsFor("linkedin-article") === 186, "report composites need their measured run (180 s) plus the facilitator's 6 s");
  ok(requiredEvmSecondsFor("v1-videos") === 66 && requiredEvmSecondsFor("image-gen-premium") === 81, "the video and premium image floors");
  ok(["uuid", "hash", "v1-images-fast", "v1-images-pro", "v1-chat", "v1-chat-nano", "v1-chat-metered", "route-execute"].every((sl) => requiredEvmSecondsFor(sl) === 0), "fast routes have no floor: short windows are an honest pattern there");
  ok(requiredEvmSecondsFor("seller-payability") === 0 && requiredEvmSecondsFor("route-execute-pro") === 0, "the routes that pay an outside seller have no floor: they bound their own run by the buyer's authorization instead");
  ok(requiredEvmSecondsFor("research", 200) === 200 - CLIENT_SLACK_SECONDS, "the floor is capped at maxTimeoutSeconds minus the client slack");
  // Honest clients: the stock client signs now + maxTimeoutSeconds when it
  // pays; a native MPP client signs the challenge expiry (mint + 300 s).
  const every = Object.keys(EVM_RUN_SECONDS);
  ok(every.every((sl) => requiredEvmSecondsFor(sl, 300) <= 300 - CLIENT_SLACK_SECONDS), `no floor exceeds what a stock client carries, less a minute of slack (${every.length} routes)`);
  const t = Date.now();
  const at = (s) => eip(Math.floor(t / 1000) + s);
  ok(evmValidityShortfall(at(299), "research", { nowMs: t }) === null, "control: a stock client's authorization (300 s) runs a report");
  ok(evmValidityShortfall(at(240), "research", { nowMs: t }) === null, "control: an MPP client paying a minute after its 402 runs a report");
  const short = evmValidityShortfall(at(7), "research", { nowMs: t });
  ok(short && short.required === 186 && /validBefore/.test(short.message) && /not been charged/.test(short.message) && !/\u2014/.test(short.message), `a 7 s authorization on a report is refused, naming the field and the seconds needed (${short?.message})`);
  ok(evmValidityShortfall(at(7), "uuid", { nowMs: t }) === null && evmValidityShortfall(at(7), "v1-images-fast", { nowMs: t }) === null, "control: the same 7 s authorization on a fast route is not refused");
  ok(evmValidityShortfall(permit2(Math.floor(t / 1000) + 30), "v1-videos", { nowMs: t })?.message.includes("deadline"), "a Permit2 deadline is judged the same way and named as such");
  ok(evmValidityShortfall(b64({ x402Version: 2, accepted: { network: "solana:x" }, payload: { transaction: "AA" } }), "research", { nowMs: t }) === null, "a non-EVM payment is left to its own rail's rules");
  const req = { header: (n) => (String(n).toLowerCase() === "payment-signature" ? at(7) : undefined) };
  const savedMode = process.env.EVM_VALIDITY_FLOOR;
  process.env.EVM_VALIDITY_FLOOR = "enforce";
  let threw = null; try { assertEvmValidityCovers(req, "research", { nowMs: t }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 422, "under EVM_VALIDITY_FLOOR=enforce the express entry throws a 422 (uncharged: >= 400 cancels settlement)");
  let threwStock = null; try { assertEvmValidityCovers({ header: (n) => (String(n).toLowerCase() === "payment-signature" ? at(299) : undefined) }, "research", { nowMs: t }); } catch (e) { threwStock = e; }
  ok(threwStock === null, "control: under enforce a stock authorization passes");
  delete process.env.EVM_VALIDITY_FLOOR;
  let threwDefault = null; try { assertEvmValidityCovers(req, "research", { nowMs: t }); } catch (e) { threwDefault = e; }
  ok(evmValidityMode() === "log" && threwDefault === null, "unset, the floor logs and refuses nothing: it is sized from logged arrivals before it is enforced");
  process.env.EVM_VALIDITY_FLOOR = "log";
  let threwLog = null; try { assertEvmValidityCovers(req, "research", { nowMs: t }); } catch (e) { threwLog = e; }
  process.env.EVM_VALIDITY_FLOOR = "off";
  let threwOff = null; try { assertEvmValidityCovers(req, "research", { nowMs: t }); } catch (e) { threwOff = e; }
  if (savedMode === undefined) delete process.env.EVM_VALIDITY_FLOOR; else process.env.EVM_VALIDITY_FLOOR = savedMode;
  ok(threwLog === null && threwOff === null, "EVM_VALIDITY_FLOOR=log and =off refuse nothing");
  ok(evmCredentialSettleableMs(req, { nowMs: t }) <= 1000 && evmCredentialSettleableMs(req, { nowMs: t }) > 0 && evmCredentialBudgetMs(req, { nowMs: t }) < 0 && evmCredentialSettleableMs({ header: () => undefined }) === null, "settleable time is validBefore less the facilitator's 6 s; the work budget takes a further margin; no header reads as nothing");
}

// 1c. The composite guard's service-wide pause: each buyer adds at most its
// own per-key limit (3) of failures.
{
  // Default thresholds: 3 per buyer, 12 for the pause.
  const g = await import("../src/composite-spend-guard.js");
  g._compositeGuardReset();
  for (let i = 0; i < 12; i++) g.recordCompositeSpendFailure("0xBURST");
  ok(!g.compositeGuardGlobalPaused(), "one wallet's twelve failures do not pause every buyer's reports");
  ok(g.compositeGuardBlocked("0xBURST"), "... that wallet is blocked by the per-key bound");
  for (let w = 0; w < 2; w++) for (let i = 0; i < 3; i++) g.recordCompositeSpendFailure(`0xLapse${w}`);
  ok(!g.compositeGuardGlobalPaused(), "three buyers with three failures each (nine) do not pause");
  for (let i = 0; i < 3; i++) g.recordCompositeSpendFailure("0xLapse2");
  ok(g.compositeGuardGlobalPaused(), "a fourth buyer's third failure makes twelve: a refusal that hits every buyer still pauses at twelve failures");
  g._compositeGuardReset();
  for (let i = 0; i < 11; i++) g.recordCompositeSpendFailure(`0xWallet${i}`);
  ok(!g.compositeGuardGlobalPaused(), "eleven buyers with one failure each do not pause");
  g.recordCompositeSpendFailure(null);
  ok(g.compositeGuardGlobalPaused(), "a twelfth, unkeyed, does: an unkeyed failure counts as its own buyer");
  g._compositeGuardReset();
}

// 1d. Balance-covered concurrency.
{
  _resetInflightCoverForTest();
  let reads = 0, balance = 600000n, readDelayMs = 50;
  _setBalanceReaderForTest(async () => { reads++; await sleep(readDelayMs); return balance; });
  const hdr = (from, value = "600000", network = "eip155:8453") => b64({ x402Version: 2, accepted: { scheme: "exact", network, asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }, payload: { signature: "0x11", authorization: { from, to: "0x" + "cd".repeat(20), value, validAfter: "0", validBefore: "9999999999", nonce: "0x01" } } });
  const reqFor = (h) => ({ header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) });
  const A = "0x" + "a1".repeat(20);
  ok(coverTermsOf(hdr(A))?.atomic === 600000n && coverTermsOf(hdr(A)).payer === A && coverTermsOf(b64({ payload: { transaction: "x" } })) === null, "cover terms come from the signed authorization; a Solana payment is not covered here");
  const p2 = (from, amount = "600000") => b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }, payload: { signature: "0x11", permit2Authorization: { from, permitted: { token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount }, spender: "0x" + "44".repeat(20), nonce: "1", deadline: "9999999999", witness: { to: "0x" + "cd".repeat(20), validAfter: "0" } } } });
  const t2 = coverTermsOf(p2(A));
  ok(t2?.payer === A && t2.atomic === 600000n && t2.network === "eip155:8453", "a Permit2 authorization on the exact scheme is covered too: its signed owner and permitted amount");
  const r1 = await admitCoveredRun(reqFor(hdr(A)));
  ok(typeof r1 === "function" && reads === 0, "a wallet's first run in flight needs no read: verify already proved its balance");
  const burst = await Promise.allSettled(Array.from({ length: 9 }, () => admitCoveredRun(reqFor(hdr(A)))));
  const refused = burst.filter((x) => x.status === "rejected");
  ok(refused.length === 9 && refused.every((x) => x.reason?.statusCode === 429) && reads === 1, `a burst of nine more from a wallet holding one price: all refused 429 before they start, one balance read (refused ${refused.length}, reads ${reads})`);
  ok(/does not cover this one as well/.test(refused[0].reason.message) && /not been charged/.test(refused[0].reason.message) && refused[0].reason.retryAfter === 30, "the refusal says why and that nothing was charged");
  r1();
  const r2 = await admitCoveredRun(reqFor(hdr(A)));
  ok(typeof r2 === "function", "once the run ends, the wallet's next run is admitted");
  r2();
  // Control: a wallet whose balance covers what it starts is never refused.
  balance = 3n * 600000n;
  const B = "0x" + "b2".repeat(20);
  const three = await Promise.all([admitCoveredRun(reqFor(hdr(B))), admitCoveredRun(reqFor(hdr(B))), admitCoveredRun(reqFor(hdr(B)))]);
  ok(three.every((x) => typeof x === "function"), "control: three concurrent runs from a wallet whose balance covers three are all admitted");
  let fourth = null; try { await admitCoveredRun(reqFor(hdr(B))); } catch (e) { fourth = e; }
  ok(fourth?.statusCode === 429, "... and a fourth it cannot also cover is refused");
  three.forEach((f) => f());
  // Four at once against a balance that covers three, the first already in
  // flight: the three that wait on the one shared read are admitted in turn
  // against the ledger as it stands AFTER the read, so exactly two of them fit.
  const E = "0x" + "e5".repeat(20);
  const first = await admitCoveredRun(reqFor(hdr(E)));
  const racing = await Promise.allSettled([1, 2, 3].map(() => admitCoveredRun(reqFor(hdr(E)))));
  const fit = racing.filter((x) => x.status === "fulfilled");
  ok(fit.length === 2 && racing.filter((x) => x.status === "rejected").length === 1, `four at once against a balance for three: three admitted, one refused (admitted ${fit.length + 1})`);
  first(); fit.forEach((x) => x.value());
  ok(inflightCoverStatus().runsInFlight === 0 && inflightCoverStatus().walletsInFlight === 0, "released runs leave the ledger");
  // Unreadable balance: a bounded allowance, then a refusal.
  _setBalanceReaderForTest(async () => { throw new Error("rpc down"); });
  const C = "0x" + "c3".repeat(20);
  const held = [];
  for (let i = 0; i < 4; i++) held.push(await admitCoveredRun(reqFor(hdr(C))));
  let fifth = null; try { await admitCoveredRun(reqFor(hdr(C))); } catch (e) { fifth = e; }
  ok(held.every((x) => typeof x === "function") && fifth?.statusCode === 429 && /could not be read/.test(fifth.message), "an unreadable balance admits up to four in flight, then refuses");
  held.forEach((f) => f());
  // Different chains are different balances.
  _setBalanceReaderForTest(async () => 600000n);
  const D = "0x" + "d4".repeat(20);
  const d1 = await admitCoveredRun(reqFor(hdr(D, "600000", "eip155:8453")));
  const d2 = await admitCoveredRun(reqFor(hdr(D, "600000", "eip155:137")));
  ok(typeof d1 === "function" && typeof d2 === "function", "the same wallet on two chains is two balances");
  d1(); d2();
  // Permit2 and EIP-3009 payments from one wallet share one ledger.
  _setBalanceReaderForTest(async () => 600000n);
  const P = "0x" + "9f".repeat(20);
  const pf = await admitCoveredRun(reqFor(p2(P)));
  let pSecond = null; try { await admitCoveredRun(reqFor(hdr(P))); } catch (e) { pSecond = e; }
  ok(typeof pf === "function" && pSecond?.statusCode === 429, "a Permit2 run counts against the wallet's balance like an EIP-3009 one");
  pf();
  // A run whose handler has returned is SETTLING: its payment may already be
  // off the wallet while it still counts here. A wallet funded for exactly
  // two runs starts its second while its first is settling: admitted once the
  // first leaves the ledger, not refused.
  let bal2 = 1_200_000n;
  _setBalanceReaderForTest(async () => bal2);
  const S = "0x" + "5e".repeat(20);
  const s1 = await admitCoveredRun(reqFor(hdr(S)));
  s1.settling();
  bal2 = 600_000n; // run 1's settlement has landed on chain; its response has not ended
  const t0s = Date.now();
  const s2p = admitCoveredRun(reqFor(hdr(S)));
  setTimeout(() => s1(), 150);
  const s2 = await s2p.catch((e) => e);
  ok(typeof s2 === "function" && Date.now() - t0s >= 100 && inflightCoverStatus().settleWaits === 1, `a wallet funded for two starts its second run while the first settles: it waits for the first to leave, then runs (${typeof s2 === "function" ? "admitted" : s2?.statusCode})`);
  s2();
  // A run judged across another run's departure is judged on a fresh read,
  // even when the ledger is then empty: the departed run's settlement may have
  // come out of the balance this payment was verified against. A wallet funded
  // for ONE run starts a second while the first settles; the first's payment
  // lands and it leaves: the second is refused, before it starts.
  let bal1 = 600_000n;
  _setBalanceReaderForTest(async () => bal1);
  const O = "0x" + "0e".repeat(20);
  const o1 = await admitCoveredRun(reqFor(hdr(O)));
  o1.settling();
  const o2p = admitCoveredRun(reqFor(hdr(O)));
  setTimeout(() => { bal1 = 0n; o1(); }, 150);
  const o2 = await o2p.catch((e) => e);
  ok(o2?.statusCode === 429 && /no longer covers/.test(o2.message) && /not been charged/.test(o2.message) && inflightCoverStatus().runsInFlight === 0, `a wallet funded for one starts a second run while the first settles: once the first has been paid for and leaves, the second is refused on a fresh read (${typeof o2 === "function" ? "admitted" : o2?.statusCode})`);
  // A read that was already under way when a run left may predate that run's
  // settlement: it is neither used for the decision nor kept in the cache.
  bal1 = 600_000n;
  _setBalanceReaderForTest(async () => { const v = bal1; await sleep(100); return v; });
  const Q = "0x" + "1f".repeat(20);
  const q1 = await admitCoveredRun(reqFor(hdr(Q)));
  q1.settling();
  const q2p = admitCoveredRun(reqFor(hdr(Q)));
  setTimeout(() => { bal1 = 0n; q1(); }, 30);
  const q2 = await q2p.catch((e) => e);
  ok(q2?.statusCode === 429 && inflightCoverStatus().runsInFlight === 0, `a balance read that began before a settling run left is read again after it: refused (${typeof q2 === "function" ? "admitted" : q2?.statusCode})`);
  let bal3 = 1_200_000n;
  _setBalanceReaderForTest(async () => { const v = bal3; await sleep(100); return v; });
  const Q2 = "0x" + "2f".repeat(20);
  const q3 = await admitCoveredRun(reqFor(hdr(Q2)));
  q3.settling();
  const q4p = admitCoveredRun(reqFor(hdr(Q2)));
  setTimeout(() => { bal3 = 600_000n; q3(); }, 30);
  const q4 = await q4p.catch((e) => e);
  ok(typeof q4 === "function", `control: the same sequence from a wallet funded for two admits the second run (${typeof q4 === "function" ? "admitted" : q4?.statusCode})`);
  q4();
  // Several runs waiting on one settling run are judged one after another
  // against the same fresh read, each counting the ones admitted before it:
  // exactly as many run as the balance covers.
  const waitersFor = async (from, balAfter) => {
    let b = 600_000n, n = 0;
    _setBalanceReaderForTest(async () => { n++; return b; });
    const big = await admitCoveredRun(reqFor(hdr(from, "1200000")));
    big.settling();
    const ps = [admitCoveredRun(reqFor(hdr(from))), admitCoveredRun(reqFor(hdr(from)))];
    await sleep(20);
    const before = n;
    setTimeout(() => { b = balAfter; big(); }, 50);
    const out = await Promise.allSettled(ps);
    return { out, readsAfter: n - before };
  };
  const none = await waitersFor("0x" + "5f".repeat(20), 0n);
  ok(none.out.every((x) => x.status === "rejected" && x.reason?.statusCode === 429) && none.readsAfter === 1, `two runs waiting on one settling run that spends the whole balance: both refused, on one shared read (${none.out.map((x) => x.status)}, reads ${none.readsAfter})`);
  const race = await waitersFor("0x" + "3f".repeat(20), 600_000n);
  const raceIn = race.out.filter((x) => x.status === "fulfilled");
  ok(raceIn.length === 1 && race.out.filter((x) => x.status === "rejected" && x.reason?.statusCode === 429).length === 1 && race.readsAfter === 1, `two runs waiting on one settling run, a balance for one more: one admitted, one refused, one shared read (admitted ${raceIn.length}, reads ${race.readsAfter})`);
  raceIn.forEach((x) => x.value());
  const both = await waitersFor("0x" + "4f".repeat(20), 1_200_000n);
  ok(both.out.every((x) => x.status === "fulfilled"), `control: a balance for both after the settlement admits both waiting runs (${both.out.map((x) => x.status)})`);
  both.out.forEach((x) => x.value());
  ok(inflightCoverStatus().runsInFlight === 0, "the waiting runs leave the ledger when released");
  _setBalanceReaderForTest(async () => bal2);
  // Controls: a run still WORKING is not waited for (the refusal is at once),
  // and a settling run that does not leave within the wait is refused.
  bal2 = 600_000n;
  const w1 = await admitCoveredRun(reqFor(hdr(S)));
  const tw = Date.now();
  let wErr = null; try { await admitCoveredRun(reqFor(hdr(S))); } catch (e) { wErr = e; }
  ok(wErr?.statusCode === 429 && Date.now() - tw < 100, "control: while the first run is still working, a second the balance cannot also cover is refused at once");
  w1.settling();
  const tl = Date.now();
  let lErr = null; try { await admitCoveredRun(reqFor(hdr(S)), { settleWaitMs: 200 }); } catch (e) { lErr = e; }
  ok(lErr?.statusCode === 429 && Date.now() - tl >= 150, "a settling run that does not leave within the wait: refused after it");
  w1();
  {
  // A run that has SETTLED leaves the ledger at settlement, not at response
  // end: its payment is off the wallet, so the balance already reflects it.
  // The settle hook is the x402 afterSettle hook (src/payments.js), driven
  // here through a stub resource server holding only that registration.
  let afterSettle = null;
  registerInflightCoverSettleHook({ onAfterSettle: (fn) => { afterSettle = fn; } });
  ok(/\n\s*registerClientGoneSettleHook\(server\);\n\s*registerInflightCoverSettleHook\(server\);/.test(readFileSync(new URL("../src/payments.js", import.meta.url), "utf8")), "the settle hook is registered on the live resource server, beside the client-gone hook");
  const settleCtx = (req, success) => ({ result: { success }, transportContext: { request: { adapter: { req } } } });
  // The scenario: a wallet funded for exactly three runs. Run 1 settles on
  // chain and its response then stalls past the wait; run 3 arrives.
  let bal3r = 1_800_000n;
  _setBalanceReaderForTest(async () => bal3r);
  const R = "0x" + "6e".repeat(20);
  const r1req = reqFor(hdr(R)), r2req = reqFor(hdr(R));
  const r1 = await admitCoveredRun(r1req);
  const r2 = await admitCoveredRun(r2req);
  r1.settling();
  bal3r = 1_200_000n; // run 1 paid on chain
  afterSettle(settleCtx(r1req, true)); // its response has not ended
  const t3 = Date.now();
  let r3 = null; try { r3 = await admitCoveredRun(reqFor(hdr(R)), { settleWaitMs: 200 }); } catch (e) { r3 = e; }
  ok(typeof r3 === "function" && Date.now() - t3 < 150 && inflightCoverStatus().runsInFlight === 2, `a wallet funded for three: run 1 settled, its response still open, run 3 is admitted at once, not refused 429 (${typeof r3 === "function" ? "admitted" : r3?.statusCode})`);
  // No double release: run 1's response now ends; runs 2 and 3 still count.
  r1();
  ok(inflightCoverStatus().runsInFlight === 2, `run 1's response end after its settlement releases nothing more (in flight ${inflightCoverStatus().runsInFlight})`);
  ok(markCoveredRunSettled(r1req) === true && inflightCoverStatus().runsInFlight === 2, "a second settle signal for run 1 releases nothing more either");
  r2(); r3();
  ok(inflightCoverStatus().runsInFlight === 0, "the three runs leave the ledger");
  // Settlement landing WHILE run 3 waits: it is judged again at once.
  bal3r = 1_800_000n;
  const w1req = reqFor(hdr(R)), w2req = reqFor(hdr(R));
  const ww1 = await admitCoveredRun(w1req);
  const ww2 = await admitCoveredRun(w2req);
  ww1.settling();
  bal3r = 1_200_000n;
  const tw3 = Date.now();
  const ww3p = admitCoveredRun(reqFor(hdr(R)), { settleWaitMs: 5_000 });
  setTimeout(() => afterSettle(settleCtx(w1req, true)), 100);
  const ww3 = await ww3p.catch((e) => e);
  ok(typeof ww3 === "function" && Date.now() - tw3 < 1_000, `run 1 settles while run 3 waits: run 3 is admitted when the settlement lands, not when run 1's response ends (${typeof ww3 === "function" ? "admitted" : ww3?.statusCode})`);
  ww1(); ww2(); ww3();
  // Controls. Two UNSETTLED runs on a balance for two: a third is refused.
  bal3r = 1_200_000n;
  const u1 = await admitCoveredRun(reqFor(hdr(R)));
  const u2 = await admitCoveredRun(reqFor(hdr(R)));
  let u3 = null; try { await admitCoveredRun(reqFor(hdr(R))); } catch (e) { u3 = e; }
  ok(u3?.statusCode === 429, "control: two unsettled runs still count, and a third the balance cannot also cover is refused");
  u1(); u2();
  // A FAILED settlement keeps the run counted until its response ends.
  bal3r = 1_200_000n;
  const f1req = reqFor(hdr(R));
  const f1 = await admitCoveredRun(f1req);
  const f2 = await admitCoveredRun(reqFor(hdr(R)));
  f1.settling();
  afterSettle(settleCtx(f1req, false));
  afterSettle({ result: { success: true } }); // a success with no request releases nothing
  let f3 = null; try { await admitCoveredRun(reqFor(hdr(R)), { settleWaitMs: 150 }); } catch (e) { f3 = e; }
  ok(f3?.statusCode === 429 && inflightCoverStatus().runsInFlight === 2, `control: a run whose settlement failed still counts, so a third run is refused (${typeof f3 === "function" ? "admitted" : f3?.statusCode})`);
  f1();
  ok(inflightCoverStatus().runsInFlight === 1, "the failed run leaves when its response ends");
  f2();
  ok(inflightCoverStatus().runsInFlight === 0 && markCoveredRunSettled({}) === false && markCoveredRunSettled(null) === false, "a request the cover never admitted is not a release");
  }
  {
  // A settlement RECOVERED through the PAYMENT_SETTLE_FALLBACK chain releases
  // the run at settlement too. The vendor returns a recovered result from its
  // onSettleFailure hooks WITHOUT running afterSettle, so this drives the REAL
  // x402ResourceServer.settlePayment with the real hook registrations and
  // stub facilitator clients: a primary that rejects pre-broadcast (402) and
  // a fallback that settles.
  const prevFallback = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = "true";
  const rejection402 = () => Object.assign(new Error("settle failed (402): payment-method-required"), { status: 402 });
  const serverWith = (primarySettle, fallbackSettle) => {
    const primary = { getSupported: async () => ({ kinds: [] }), verify: async () => ({ isValid: true }), settle: primarySettle };
    const srv = new x402ResourceServer(primary);
    const fb = { settle: fallbackSettle };
    registerFacilitatorFailureHooks(srv, fb, null);   // fallback as the PayAI slot
    registerInflightCoverSettleHook(srv);
    return srv;
  };
  const settleFor = (srv, req) => srv.settlePayment({ x402Version: 2, payload: {} }, { scheme: "exact", network: "eip155:8453", amount: "600000" }, {}, { request: { adapter: { req } } })
    .catch((e) => ({ success: false, thrown: String(e?.message || e) }));
  const ok200 = async () => ({ success: true, transaction: "0x" + "fa".repeat(32), network: "eip155:8453" });
  const logW = console.warn; console.warn = () => {};
  try {
    let balF = 1_800_000n;
    _setBalanceReaderForTest(async () => balF);
    const F = "0x" + "7f".repeat(20);
    // The scenario: a wallet funded for three. Run 1 settles through the
    // fallback and its response stays open; run 3 arrives.
    const a1req = reqFor(hdr(F));
    const a1 = await admitCoveredRun(a1req);
    const a2 = await admitCoveredRun(reqFor(hdr(F)));
    a1.settling();
    let fallbackCalls = 0;
    const recovered = await settleFor(serverWith(async () => { throw rejection402(); }, async () => { fallbackCalls++; return ok200(); }), a1req);
    ok(recovered.success === true && fallbackCalls === 1, `the primary rejected pre-broadcast and the fallback settled (${JSON.stringify(recovered).slice(0, 80)})`);
    ok(inflightCoverStatus().runsInFlight === 1, `a run settled through the fallback leaves the ledger at settlement, its response still open (in flight ${inflightCoverStatus().runsInFlight})`);
    balF = 1_200_000n; // run 1 paid on chain
    let a3 = null; try { a3 = await admitCoveredRun(reqFor(hdr(F)), { settleWaitMs: 150 }); } catch (e) { a3 = e; }
    ok(typeof a3 === "function", `so a third run the balance covers is admitted, not refused (${typeof a3 === "function" ? "admitted" : a3?.statusCode})`);
    // Exactly once: the response end and a second settle signal release nothing more.
    a1();
    ok(markCoveredRunSettled(a1req) === true && inflightCoverStatus().runsInFlight === 2, `run 1's response end and a repeat signal release nothing more (in flight ${inflightCoverStatus().runsInFlight})`);
    a2(); a3();

    // Controls. A fallback that ALSO fails (gracefully, or by throwing) releases nothing.
    balF = 1_200_000n;
    const c1req = reqFor(hdr(F));
    const c1 = await admitCoveredRun(c1req);
    const c2 = await admitCoveredRun(reqFor(hdr(F)));
    const graceful = await settleFor(serverWith(async () => { throw rejection402(); }, async () => ({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453" })), c1req);
    ok(graceful.success !== true && inflightCoverStatus().runsInFlight === 2, `control: a fallback answering success:false leaves the run counted (in flight ${inflightCoverStatus().runsInFlight})`);
    const thrown = await settleFor(serverWith(async () => { throw rejection402(); }, async () => { throw rejection402(); }), c1req);
    ok(thrown.success !== true && inflightCoverStatus().runsInFlight === 2, "control: a fallback that throws leaves the run counted");
    // A timeout on the primary may have broadcast: no fallback runs, nothing releases.
    let tried = 0;
    await settleFor(serverWith(async () => { throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }); }, async () => { tried++; return ok200(); }), c1req);
    ok(tried === 0 && inflightCoverStatus().runsInFlight === 2, "control: a primary timeout tries no fallback and releases nothing");
    c1(); c2();
    ok(inflightCoverStatus().runsInFlight === 0, "the unsettled runs leave when their responses end");

    // The ordinary path through the same real server: a primary success
    // releases once via afterSettle, and the fallback is never asked.
    const d1req = reqFor(hdr(F));
    const d1 = await admitCoveredRun(d1req);
    const d2 = await admitCoveredRun(reqFor(hdr(F)));
    let fbAsked = 0;
    await settleFor(serverWith(ok200, async () => { fbAsked++; return ok200(); }), d1req);
    ok(fbAsked === 0 && inflightCoverStatus().runsInFlight === 1, "a primary success releases the run once through afterSettle");
    // A client that recovers INSIDE its own settle() (the Stellar confirm /
    // fallback shape) returns a success to the vendor, so afterSettle fires.
    const e1req = reqFor(hdr(F));
    const e1 = await admitCoveredRun(e1req);
    await settleFor(serverWith(async () => { try { throw rejection402(); } catch { return ok200(); } }, async () => ok200()), e1req);
    ok(inflightCoverStatus().runsInFlight === 1, "a settlement recovered inside the facilitator client releases through afterSettle too");
    d1(); d2(); e1();
    ok(inflightCoverStatus().runsInFlight === 0, "every run leaves the ledger");
  } finally {
    console.warn = logW;
    if (prevFallback === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK; else process.env.PAYMENT_SETTLE_FALLBACK = prevFallback;
  }
  }
  process.env.INFLIGHT_COVER = "off";
  ok(await admitCoveredRun(reqFor(hdr(A))) === null, "INFLIGHT_COVER=off disables the check");
  delete process.env.INFLIGHT_COVER;
  _resetInflightCoverForTest();
}

// 1d2. route-execute's external leg pays an outside seller before the buyer
// settles. An EVM buyer's seller is paid only while its authorization keeps
// EVM_SELLER_ALLOWANCE_MS of settleable life (validBefore less the
// facilitator's 6 s); the seller call keeps the payer's own timeout, and only
// the refusal wait is bounded by the authorization. The clock is moved by the
// stubs, and the stub payer honours opts.timeoutMs the way payX402's
// per-fetch timeout does: a cut after the header went out throws a raw error.
{
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  const seller = (name, net = "eip155:8453") => ({ seller: `https://${name}.example`, slug: "zk-prove", url: `https://${name}.example/api/zk-prove`, method: "POST", price: "$0.12", networks: [net] });
  const calls = [];
  let candidates = [seller("ext")], resolveMs = 0, delays = {};
  const payExternal = async (url, opts) => {
    calls.push({ url, ...opts });
    const d = delays[url] ?? 0;
    if (opts.timeoutMs != null && opts.timeoutMs < d) { skew += opts.timeoutMs; throw new Error("The operation was aborted due to timeout"); }
    skew += d;
    return { result: { ok: 1 }, quote: { usd: 0.12, network: opts.chain === "tempo" ? "eip155:4217" : "eip155:8453" }, receipt: { transaction: "0xTX", network: "eip155:8453" } };
  };
  const toolFor = (chains = ["base"]) => buildRouteExecuteTool({ getCatalog: () => ({}), tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 }, resolveExternal: async () => { skew += resolveMs; return candidates; }, payExternal, externalEnabled: () => true, externalChains: () => chains });
  const tool = toolFor();
  const hdr = (validBefore) => b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", maxTimeoutSeconds: 300 }, payload: { signature: "0x11", authorization: { from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20), value: "550000", validAfter: "0", validBefore: String(validBefore), nonce: "0x01" } } });
  const reqWith = (h) => ({ ip: "203.0.113.9", header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) });
  const run = async (req, t = tool) => { try { return { out: await t.handler({ task: "prove a circuit", include: "external", params: {} }, req) }; } catch (e) { return { err: e }; } };
  // Seconds left at settle-time verify, the moment the handler returns.
  const leftAtSettle = (validBefore) => validBefore - Date.now() / 1000;
  const reset = ({ list = [seller("ext")], resolve = 0, d = {} } = {}) => { candidates = list; resolveMs = resolve; delays = d; calls.length = 0; };

  reset();
  const tooShort = await run(reqWith(hdr(nowS() + 8)));
  ok(tooShort.err?.statusCode === 504 && calls.length === 0 && /Too little of your payment authorization/.test(tooShort.err.message) && /Nothing was spent/.test(tooShort.err.message), `an 8 s authorization (2 s past the settle rule, under the ${EVM_SELLER_ALLOWANCE_MS} ms allowance): refused 504 before any seller is paid (${tooShort.err?.statusCode}, paid ${calls.length})`);

  for (const w of [15, 16]) {
    reset({ d: { "https://ext.example/api/zk-prove": 1000 } });
    const vb = nowS() + w;
    const r = await run(reqWith(hdr(vb)));
    const left = leftAtSettle(vb);
    ok(!r.err && calls.length === 1 && calls[0].timeoutMs === undefined && left >= SETTLE_RULE_SECONDS && Math.abs(calls[0].signBy - ((vb - SETTLE_RULE_SECONDS) * 1000 - EVM_SELLER_ALLOWANCE_MS)) < 50, `a ${w} s authorization, a 1 s seller: served with the payer's own seller timeout, ${left.toFixed(1)} s left at settle (${r.err?.statusCode ?? "ok"})`);
  }

  // 12 s: 6 s of settleable life, under the allowance (the settle margin plus a
  // seller's answer) - refused before any seller is signed for.
  reset({ d: { "https://ext.example/api/zk-prove": 3000 } });
  const vb12 = nowS() + 12;
  const tight = await run(reqWith(hdr(vb12)));
  ok(tight.err?.statusCode === 504 && calls.length === 0, `a 12 s authorization, a 3 s seller: refused 504 with nothing paid (a seller that takes 3 s would leave the payment unsettleable) (${tight.err?.statusCode ?? "ok"}, paid ${calls.length})`);

  reset({ resolve: 15_000, d: { "https://ext.example/api/zk-prove": 1000 } });
  const vb17 = nowS() + 30;
  const slowResolve = await run(reqWith(hdr(vb17)));
  ok(!slowResolve.err && calls.length === 1 && leftAtSettle(vb17) >= SETTLE_RULE_SECONDS, `a 30 s authorization, 15 s of resolution, a 1 s seller: served (${slowResolve.err?.statusCode ?? "ok"}, ${leftAtSettle(vb17).toFixed(1)} s left at settle)`);

  reset({ list: [seller("a"), seller("b")], resolve: 12_000, d: { "https://a.example/api/zk-prove": 8000, "https://b.example/api/zk-prove": 1000 } });
  const vbAB = nowS() + 30;
  const ab = await run(reqWith(hdr(vbAB)));
  ok(!ab.err && calls.length === 1 && calls[0].url === "https://a.example/api/zk-prove" && calls[0].timeoutMs === undefined && leftAtSettle(vbAB) >= SETTLE_RULE_SECONDS, `a 30 s authorization, 12 s of resolution, an 8 s first seller: served by that seller with exactly one paid call (paid ${calls.map((c) => c.url.split("/")[2]).join(",")}, ${leftAtSettle(vbAB).toFixed(1)} s left at settle)`);

  reset();
  const short = await run(reqWith(hdr(nowS() + 30)));
  ok(!short.err && calls.length === 1 && calls[0].timeoutMs === undefined && calls[0].refusalMaxWaitMs > 0 && calls[0].refusalMaxWaitMs <= 20_000, `a 30 s authorization: the refusal wait ends inside it (wait ${calls[0]?.refusalMaxWaitMs} ms)`);
  reset();
  const mid = await run(reqWith(hdr(nowS() + 120)));
  ok(!mid.err && calls.length === 1 && calls[0].timeoutMs === undefined && calls[0].refusalMaxWaitMs > 100_000 && calls[0].refusalMaxWaitMs <= 110_000, `a 120 s authorization: the refusal wait ends inside it, the seller call keeps the payer's own timeout (wait ${calls[0]?.refusalMaxWaitMs} ms)`);
  reset();
  const stock = await run(reqWith(hdr(nowS() + 299)));
  ok(!stock.err && calls.length === 1 && calls[0].timeoutMs === undefined && calls[0].refusalMaxWaitMs > 200_000 && calls[0].refusalMaxWaitMs <= 240_000, `control: a stock 300 s authorization is unchanged (no seller timeout override, wait ${calls[0]?.refusalMaxWaitMs} ms of the default 240 s)`);
  reset();
  const unpaid = await run({});
  ok(!unpaid.err && calls.length === 1 && calls[0].timeoutMs === undefined && calls[0].refusalMaxWaitMs > 200_000, "control: a request with no payment header is unchanged");

  // Controls on the other rails: Solana keeps the defaults; Tempo keeps its
  // own 16 s budget for both the seller call and the wait.
  reset({ list: [seller("sol", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")] });
  const solReq = { ip: "203.0.113.9", header: (n) => (String(n).toLowerCase() === "payment-signature" ? b64({ x402Version: 2, accepted: { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, payload: { transaction: "AAAA" } }) : undefined) };
  const sol = await run(solReq, toolFor(["solana"]));
  ok(!sol.err && calls.length === 1 && calls[0].timeoutMs === undefined && calls[0].refusalMaxWaitMs > 200_000, `control: a Solana buyer keeps the default seller timeout and wait (${sol.err?.message || "ok"})`);
  reset({ list: [seller("mpp", "eip155:4217")], resolve: 2000 });
  const tempo = await run({ ip: "203.0.113.9", mppTempoCredential: { challenge: {} }, mppTempoSender: "0x" + "ee".repeat(20), header: () => undefined }, toolFor(["tempo"]));
  ok(!tempo.err && calls.length === 1 && calls[0].timeoutMs > 13_000 && calls[0].timeoutMs <= 14_000 && calls[0].refusalMaxWaitMs > 13_000 && calls[0].refusalMaxWaitMs <= 14_000, `control: a Tempo buyer keeps its 16 s budget for the seller call and the wait (timeout ${calls[0]?.timeoutMs} ms, wait ${calls[0]?.refusalMaxWaitMs} ms; ${tempo.err?.message || "ok"})`);
  Date.now = realNow;
}

// 1e. Source pins for the seams the booted part exercises end to end.
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const breaker = readFileSync(new URL("../src/gateway-settle-breaker.js", import.meta.url), "utf8");
  const from = server.indexOf("if (compositeGuardBlocked(guardKey))");
  const listener = server.slice(from, server.indexOf("let cacheKey = null;", from));
  ok(/onSettleOutcome\(req, res, \(\) => \{/.test(listener) && !/res\.on\("finish"/.test(listener), "the composite guard hears settlement through onSettleOutcome, not finish");
  ok(/onSettleOutcome\(req, res, \(\) => \{/.test(breaker) && !/res\.once\("finish"/.test(breaker), "the gateway and catalog breakers hear settlement through onSettleOutcome, not finish");
  const avm = server.indexOf("await assertAvmValidityCovers(req, tool.slug);");
  const evm = server.indexOf("assertEvmValidityCovers(req, tool.slug);");
  const cover = server.indexOf("coverRelease = await admitCoveredRun(req);");
  const belt = server.indexOf("if (clientGoneBeforeFirstByte(req)) throw clientGoneError(");
  const handler = server.indexOf("? await runInAbortableScope(() => tool.handler(input, req)");
  ok(avm > 0 && evm > avm && cover > evm && belt > cover && handler > belt, "the dispatcher runs the EVM floor, then the concurrency cover, then the client-gone belt, then the handler");
  ok(/if \(!FREE_MODE && EXPENSIVE_COMPOSITE_SLUGS\.has\(tool\.slug\)\) \{\s*\n\s*coverRelease = await admitCoveredRun\(req\);\s*\n\s*if \(coverRelease && !onResponseEnd\(req, res, coverRelease\)\) coverRelease\(\);/.test(server), "the cover covers the expensive routes and releases when the response ends, however it ends");
  ok(/: await tool\.handler\(input, req\);\s*\n\s*coverRelease\?\.settling\?\.\(\);/.test(server), "the covered run counts as settling from the moment its handler returns");
}

// ---------------------------------------------------------------- part 2

const [PORT, FAC_PORT, OR_PORT] = await getFreePorts(3);
const B = `http://127.0.0.1:${PORT}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const OP = "test-paytime-operator-token-0123456789";

// Stub facilitator. Settle applies the reference rule (validBefore at least
// 6 s ahead, @x402/evm) and refuses payers named in `refuse`, the shape of a
// payer who moved the funds between verify and settle. balanceOf on the stub
// RPC answers `balance` (atomic USDC).
const fac = { verify: 0, settle: 0, settled: 0, refused: 0, refuse: new Set(), balance: 1_000_000_000n };
let txN = 0;
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (obj) => { if (res.destroyed) return; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    if (req.url === "/rpc") {
      const balanceOf = parsed.method === "eth_call" && String(parsed.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply({ jsonrpc: "2.0", id: 1, result: balanceOf ? "0x" + fac.balance.toString(16).padStart(64, "0") : "0x0" });
    }
    const auth = parsed.paymentPayload?.payload?.authorization || {};
    const payer = auth.from;
    if (req.url === "/verify") { fac.verify++; return reply({ isValid: Number(auth.validBefore) >= nowS() + 6, payer, ...(Number(auth.validBefore) >= nowS() + 6 ? {} : { invalidReason: "invalid_exact_evm_payload_authorization_valid_before" }) }); }
    if (req.url === "/settle") {
      fac.settle++;
      if (Number(auth.validBefore) < nowS() + 6) { fac.refused++; return reply({ success: false, errorReason: "invalid_exact_evm_payload_authorization_valid_before", transaction: "", network: "eip155:8453", payer }); }
      if (fac.refuse.has(String(payer).toLowerCase())) { fac.refused++; return reply({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453", payer }); }
      fac.settled++;
      return reply({ success: true, transaction: `0x${(++txN).toString(16).padStart(64, "0")}`, network: "eip155:8453", payer });
    }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

const or = { chat: 0, chatDelayMs: 0, images: 0, imagesDelayMs: 0, videos: 0, other: 0 };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
orStub = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const url = String(req.url || "").split("?")[0];
    const send = (status, obj) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && url === "/api/v1/chat/completions") {
      or.chat++;
      setTimeout(() => send(200, { id: "gen-test", object: "chat.completion", created: nowS(), model: "openai/gpt-6-luna", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }), or.chatDelayMs);
      return;
    }
    if (req.method === "GET" && /^\/api\/v1\/images\/models\/.+\/endpoints$/.test(url)) return send(200, { data: { endpoints: [] } });
    if (req.method === "POST" && url === "/api/v1/images") {
      or.images++;
      setTimeout(() => send(200, { created: nowS(), data: [{ b64_json: PNG_B64 }], usage: { prompt_tokens: 0, completion_tokens: 0 } }), or.imagesDelayMs);
      return;
    }
    if (url.startsWith("/api/v1/videos")) { or.videos++; return send(404, { error: { message: "not stubbed" } }); }
    or.other++;
    send(404, { error: { message: "not stubbed" } });
  });
});
await new Promise((r) => orStub.listen(OR_PORT, "127.0.0.1", r));

// Forgiveness ON with a per-wallet (and per-IP) budget that fits exactly one
// nano run ($0.003 of $0.005): a wallet's first nano hang-up is forgiven (not
// settled), every later one is settled, and nothing priced above $0.005 (the
// image and video tiers) is ever forgiven. The forgiveness rule itself is
// scripts/test-hangup-settlement.js; here it only has to stay uncounted.
proc = spawn("node", ["--import", "./scripts/lib/openrouter-stub-preload.js", "src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    OPENROUTER_API_KEY: "test-key-never-used", OPENROUTER_MANAGEMENT_KEY: "", OPENROUTER_STUB_URL: `http://127.0.0.1:${OR_PORT}`, OPENROUTER_FLEX: "off",
    GATEWAY_SETTLE_BREAKER_MAX: "3", GATEWAY_SETTLE_BREAKER_WINDOW_MS: "600000", GATEWAY_SETTLE_BREAKER_GLOBAL_MAX: "50",
    COMPOSITE_GUARD_MAX_FAILS: "3", COMPOSITE_GUARD_GLOBAL_MAX_FAILS: "50",
    HANGUP_FORGIVE: "", HANGUP_FORGIVE_KEY_USD: "0.005", HANGUP_FORGIVE_GLOBAL_USD: "1", HANGUP_FORGIVE_FILE: "off", EVM_VALIDITY_FLOOR: "enforce", INFLIGHT_COVER: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
    AGENT402_OPERATOR_TOKEN: OP, REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db") },
  stdio: ["ignore", "pipe", "pipe"],
});
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(line.slice(0, 500)); } };
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);

let nonceN = 0;
const credential = (accepted, payer, validBefore = nowS() + 299) => b64({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(validBefore), nonce: "0x" + (0x9000 + ++nonceN).toString(16).padStart(64, "0") } },
});
const CHAT = { path: "/v1/nano/chat/completions", method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "say ok" }], max_tokens: 16 }) };
const FAST = { path: "/v1/images/fast", method: "POST", body: JSON.stringify({ prompt: "a red fox in the snow" }) };
const VIDEO = { path: "/v1/videos/generations", method: "POST", body: JSON.stringify({ prompt: "a red fox running in the snow" }) };
const UUID = { path: "/api/uuid", method: "GET", body: undefined };
const accepts = {};
const acceptFor = async (t) => {
  if (accepts[t.path]) return accepts[t.path];
  const r = await fetch(`${B}${t.path}`, { method: t.method, headers: t.body ? { "content-type": "application/json" } : {}, body: t.body });
  ok(r.status === 402, `unpaid ${t.method} ${t.path} -> 402 (got ${r.status})`);
  const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
  accepts[t.path] = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  ok(!!accepts[t.path], `${t.path} offers exact on Base`);
  return accepts[t.path];
};
const headersFor = async (t, payer, ip, validBefore) => ({ ...(t.body ? { "content-type": "application/json" } : {}), "x-forwarded-for": ip, "payment-signature": credential(await acceptFor(t), payer, validBefore) });
const pay = async (t, payer, ip, validBefore) => fetch(`${B}${t.path}`, { method: t.method, headers: await headersFor(t, payer, ip, validBefore), body: t.body });
const wallet = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hangUpMidRun = async (t, payer, ip, counter) => {
  const c0 = or[counter];
  const upstreamSeen = waitFor(() => or[counter] > c0, 8000);
  await hangUp(`${B}${t.path}`, { method: t.method, headers: await headersFor(t, payer, ip), body: t.body, abortWhen: upstreamSeen.then(() => sleep(150)) });
};

try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up, "paid server booted with the OpenRouter stub preload");

  // 2a. Control: a connected buyer with a stock authorization is served.
  {
    const r = await pay(CHAT, wallet(0xa0), "10.1.0.1");
    ok(r.status === 200 && fac.settled >= 1, `a. control: a connected buyer is served and settles (${r.status})`);
  }

  // 2b. A hang-up whose settlement FAILS is counted against the wallet, and a
  // forgiven one is not. The wallet's first nano hang-up is forgiven; two
  // failed ones after it leave it served (the forgiven one would make three);
  // three failed ones in a row refuse its next call before the handler.
  {
    const W = wallet(0xb1);
    fac.refuse.add(W.toLowerCase());
    or.chatDelayMs = 1_200;
    const failedHangUp = async (label, ip) => {
      const r0 = fac.refused;
      await hangUpMidRun(CHAT, W, ip, "chat");
      await waitFor(() => fac.refused > r0, 5000);
      await sleep(200);
      ok(fac.refused === r0 + 1, `${label}. the buyer left mid-run, past the forgiveness budget, and settlement was refused (refused +${fac.refused - r0})`);
    };
    const s0 = fac.settle;
    await hangUpMidRun(CHAT, W, "10.1.1.1", "chat");
    await sleep(1_800);
    ok(fac.settle === s0, `b0. the first hang-up is inside the wallet's forgiveness budget: no settlement was attempted (+${fac.settle - s0})`);
    await failedHangUp("b1", "10.1.1.2");
    await failedHangUp("b2", "10.1.1.3");
    fac.refuse.delete(W.toLowerCase());
    or.chatDelayMs = 0;
    const mid = await pay(CHAT, W, "10.1.1.4");
    ok(mid.status === 200, `b. one forgiven and two failed hang-ups leave the wallet served: the forgiven one is not counted (${mid.status})`);
    fac.refuse.add(W.toLowerCase());
    or.chatDelayMs = 1_200;
    for (let i = 3; i <= 5; i++) await failedHangUp(`b${i}`, `10.1.1.${2 + i}`);
    or.chatDelayMs = 0;
    const c0 = or.chat;
    const r = await pay(CHAT, W, "10.1.1.9");
    const body = await r.json().catch(() => ({}));
    ok(r.status === 429 && or.chat === c0, `b. after three failed hang-ups the wallet's next call is refused 429 before the handler (status ${r.status}, upstream +${or.chat - c0}: ${String(body.error || "").slice(0, 90)})`);
    ok(/failed to settle/.test(String(body.error || "")), "b. ... by the settle-failure breaker, which names the cause");
    fac.refuse.delete(W.toLowerCase());
  }

  // 2c. Control: hang-ups that SETTLE (past the forgiveness budget, so the
  // charge went through and is booked as owed) are successes for the bound;
  // the wallet keeps being served.
  {
    const W = wallet(0xc1);
    or.chatDelayMs = 1_200;
    const s0 = fac.settled;
    for (let i = 1; i <= 4; i++) { await hangUpMidRun(CHAT, W, `10.1.2.${i}`, "chat"); await sleep(1_800); }
    ok(fac.settled === s0 + 3, `c. one hang-up forgiven, three settled (settled +${fac.settled - s0})`);
    or.chatDelayMs = 0;
    const r = await pay(CHAT, W, "10.1.2.9");
    ok(r.status === 200, `c. control: a wallet whose hang-ups all settled is served (${r.status})`);
  }

  // 2d. The same on an expensive route: a hang-up whose settlement fails on
  // /v1/images/fast feeds the composite guard, which answers first.
  {
    const W = wallet(0xd1);
    fac.refuse.add(W.toLowerCase());
    or.imagesDelayMs = 1_200;
    for (let i = 1; i <= 3; i++) {
      const r0 = fac.refused;
      await hangUpMidRun(FAST, W, `10.1.3.${i}`, "images");
      await waitFor(() => fac.refused > r0, 5000);
      await sleep(200);
    }
    or.imagesDelayMs = 0;
    const i0 = or.images;
    const r = await pay(FAST, W, "10.1.3.9");
    const body = await r.json().catch(() => ({}));
    ok(r.status === 429 && or.images === i0 && /Too many recent failed settlements/.test(String(body.error || "")), `d. the composite guard counted the hang-ups and refuses before the upstream (status ${r.status}, upstream +${or.images - i0})`);
    fac.refuse.delete(W.toLowerCase());
  }

  // 2e. The EVM floor, enforced (this server runs EVM_VALIDITY_FLOOR=enforce):
  // a 7 s authorization on the video tier is refused 422 before the handler
  // (no upstream call); a stock authorization reaches it.
  // A 7 s authorization on a fast route is served: no floor there.
  {
    const v0 = or.videos;
    const shortR = await pay(VIDEO, wallet(0xe1), "10.1.4.1", nowS() + 7);
    const body = await shortR.json().catch(() => ({}));
    ok(shortR.status === 422 && or.videos === v0 && /expires too soon/.test(String(body.error || "")), `e. a 7 s authorization on the video tier is refused 422 before the handler (status ${shortR.status}, upstream +${or.videos - v0})`);
    const longR = await pay(VIDEO, wallet(0xe2), "10.1.4.2");
    ok(longR.status !== 422 && or.videos > v0, `e. control: a stock 299 s authorization passes the floor and reaches the handler (status ${longR.status}, upstream +${or.videos - v0})`);
    const s0 = fac.settled;
    const fast = await pay(UUID, wallet(0xe3), "10.1.4.3", nowS() + 12);
    ok(fast.status === 200 && fac.settled === s0 + 1, `e. control: a 12 s authorization on a fast route is served and settles (${fast.status})`);
  }

  // 2f. Balance-covered concurrency on an expensive route: a wallet holding
  // one price starts three runs at once; one runs, two are refused before the
  // upstream. With a balance that covers three, all three run.
  {
    const price = BigInt((await acceptFor(FAST)).amount);
    or.imagesDelayMs = 1_500;
    fac.balance = price;
    const W = wallet(0xf1);
    const i0 = or.images;
    const rs = await Promise.all([1, 2, 3].map(async (i) => pay(FAST, W, `10.1.5.${i}`)));
    const statuses = rs.map((r) => r.status).sort();
    ok(or.images - i0 === 1 && statuses.filter((s) => s === 429).length === 2 && statuses.includes(200), `f. one price, three at once: one runs, two refused 429 before the upstream (statuses ${statuses}, upstream +${or.images - i0})`);
    const again = await pay(FAST, W, "10.1.5.9");
    ok(again.status === 200 && or.images - i0 === 2, `f. once its run has ended the same wallet is admitted again: the ledger released it (status ${again.status})`);
    fac.balance = price * 3n;
    const W2 = wallet(0xf2);
    const i1 = or.images;
    const rs2 = await Promise.all([1, 2, 3].map(async (i) => pay(FAST, W2, `10.1.6.${i}`)));
    ok(or.images - i1 === 3 && rs2.every((r) => r.status === 200), `f. control: a balance that covers three runs all three (statuses ${rs2.map((r) => r.status)}, upstream +${or.images - i1})`);
    or.imagesDelayMs = 0;
    fac.balance = 1_000_000_000n;
  }

  console.log(`\nPASS - ${pass} checks (a paid run that never gets paid meets a bound)`);
  cleanup();
  process.exit(0);
} catch (e) {
  fail(`unexpected: ${e?.stack || e}`);
}
