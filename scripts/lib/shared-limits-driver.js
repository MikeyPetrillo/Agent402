// One "replica" for scripts/test-shared-limits-crossprocess.js: a child process
// that loads the real controls (the gateway settle breaker, the composite spend
// guard, the external spend guard's per-payer ledger, the hang-up forgiveness
// budget, the daily spend helper) with the parent's REDIS_URL and answers one
// JSON command per stdin line with one JSON line on stdout. Two of these
// against one Redis are two containers; what one records the other must see.
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

const B = await import("../../src/gateway-settle-breaker.js");
const G = await import("../../src/composite-spend-guard.js");
const E = await import("../../src/external-spend-guard.js");
const H = await import("../../src/hangup-forgiveness.js");
const SL = await import("../../src/shared-limits.js");

const handles = new Map();
const daily = new Map();
// A paid request as the breaker sees it: keyed on the client IP (no payment
// header here), with a response the outcome listener can arm on.
function fakeReq(ip) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.setHeader = () => {};
  res.getHeader = () => undefined;
  return { ip, socket: { remoteAddress: ip }, headers: {}, res };
}
/** Every earlier write on this process's connection has landed once a read answers. */
const barrier = () => SL.shared.flagGet("barrier", "x");

async function run(cmd) {
  switch (cmd.op) {
    case "mode": return { mode: SL.sharedLimitsMode(), word: SL.sharedLimitsStatus().status, breakerShared: B._gatewaySettleBreakerShared, compositeShared: G._compositeGuardShared, hangupShared: H._hangupForgivenessShared, payerLedgerShared: E.__sharedPayerLedger };
    case "barrier": await barrier(); return { ok: true };
    // gateway settle breaker
    case "gwb.fail": { for (let i = 0; i < (cmd.n || 1); i++) B.recordGatewaySettleFailure(cmd.key, Date.now(), { global: cmd.global !== false }); await barrier(); return { ok: true }; }
    case "gwb.success": { B.recordGatewaySettleSuccess(cmd.key); await barrier(); return { ok: true }; }
    case "gwb.check": {
      try { await B.gatewaySettleBreakerCheck(fakeReq(cmd.ip), { global: cmd.global !== false }); return { ok: true }; }
      catch (e) { return { ok: false, status: e.statusCode, message: String(e.message).slice(0, 80) }; }
    }
    case "gwb.local": return B.gatewaySettleBreakerBlocked(cmd.key);
    // composite spend guard
    case "cg.fail": { for (let i = 0; i < (cmd.n || 1); i++) G.recordCompositeSpendFailure(cmd.payer, { global: cmd.global !== false }); await barrier(); await barrier(); return { ok: true }; }
    case "cg.success": { G.recordCompositeSpendSuccess(cmd.payer); await barrier(); return { ok: true }; }
    case "cg.blocked": return { blocked: await G.compositeGuardBlocked(cmd.payer) };
    case "cg.paused": return { paused: await G.compositeGuardGlobalPaused() };
    // external spend guard, per payer
    case "esg.reserve": {
      const r = await E.reserveSpend(cmd.payer, cmd.usd, { maxUnsettledUsd: cmd.ceiling });
      if (r.ok) { const id = `h${handles.size + 1}`; handles.set(id, r.handle); await barrier(); return { ok: true, handle: id, exposure: r.exposure }; }
      return { ok: false, reason: r.reason, exposure: r.exposure };
    }
    case "esg.resolve": { E.resolveSpend(handles.get(cmd.handle), cmd.settled !== false); await barrier(); return { ok: true }; }
    case "esg.adjust": { E.adjustSpend(handles.get(cmd.handle), cmd.usd); await barrier(); await barrier(); return { ok: true }; }
    case "esg.exposure": return { local: E.payerExposureUsd(cmd.payer) };
    // hang-up forgiveness
    case "hf.reserve": {
      const req = {};
      const t = await H.reserveHangupForgiveness(req, { keys: cmd.keys, priceUsd: cmd.price });
      if (cmd.abandon && t.granted) { H.settleHangupTicket(req, { abandoned: true }); await barrier(); }
      else if (t.granted && cmd.release) { H.settleHangupTicket(req, { abandoned: false }); await barrier(); }
      else if (t.granted) { handles.set(cmd.hold || "ticket", req); await barrier(); }
      return { granted: t.granted, reason: t.reason };
    }
    case "hf.settle": { const req = handles.get(cmd.hold || "ticket"); const r = H.settleHangupTicket(req, { abandoned: !!cmd.abandoned }); await barrier(); return { ok: r }; }
    // the daily spend helper
    case "daily.reserve": {
      if (!daily.has(cmd.name)) daily.set(cmd.name, SL.createSharedDailySpend(cmd.name, "test"));
      return { ok: await daily.get(cmd.name).reserve(cmd.usd, cmd.cap), today: await daily.get(cmd.name).today() };
    }
    default: return { error: `unknown op ${cmd.op}` };
  }
}

const rl = createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + "\n");
rl.on("line", async (line) => {
  let cmd;
  try { cmd = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ error: "bad json" }) + "\n"); return; }
  if (cmd.op === "exit") process.exit(0);
  let out;
  try { out = await run(cmd); } catch (e) { out = { error: String(e?.stack || e).slice(0, 300) }; }
  process.stdout.write(JSON.stringify({ id: cmd.id, ...out }) + "\n");
});
