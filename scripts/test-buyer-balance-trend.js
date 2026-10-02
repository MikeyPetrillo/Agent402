// The spending wallet should never go down, so a FALL is the signal.
//
// Everything that spends from it settles into it (SELF_FUNDING_SLUGS), and every
// execution tier charges more than it can spend. Barring a manual withdrawal the
// balance is monotonically non-decreasing. A low-water alarm fires after the
// money is gone; this fires on the first unexplained dollar.
//
// The hard part is the TRANSIENT dip that settlement ordering guarantees: we pay
// the seller during the handler and collect afterwards. An alarm that cannot
// tell that from a drain would page on every healthy call.
import { noteBuyerBalance, upstreamBuyerStatus } from "../src/upstream-buyer-status.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const fresh = (v) => noteBuyerBalance(v, { reset: true });

{
  ok(fresh(10) === "ok", "the first read is a baseline, never an alarm");
  ok(noteBuyerBalance(10.3) === "ok", "a rise is healthy - this is what a self-funding wallet does");
  ok(noteBuyerBalance(10.6) === "ok", "…and keeps re-baselining upward");
}

{
  // THE FALSE POSITIVE THIS MUST NOT HAVE. Settlement runs after the handler,
  // so the balance dips while a call is in flight and recovers when revenue
  // lands. Paging on that would make the alarm useless within a day.
  fresh(10);
  ok(noteBuyerBalance(9.7) === "ok", "a dip inside tolerance is an in-flight call, not a drain");
  ok(noteBuyerBalance(10.4) === "ok", "and it recovers when the buyer's payment settles");
}

{
  // THE REAL DRAIN. A fall past tolerance, sustained across consecutive reads.
  fresh(10);
  ok(noteBuyerBalance(7) === "ok", "one big fall is not yet an alarm - a single read could be an in-flight max-tier call");
  ok(noteBuyerBalance(6.9) === "ok", "two is still not");
  ok(noteBuyerBalance(6.8) === "draining", "three consecutive reads below the high-water mark is a drain");
}

{
  // A slow bleed sits INSIDE tolerance on every individual read. If a
  // within-tolerance read cleared the counter, a wallet losing $0.40 a read
  // would never alarm - it would just quietly empty.
  fresh(10);
  noteBuyerBalance(6.5); // past tolerance, counter 1
  noteBuyerBalance(6.4); // counter 2
  ok(noteBuyerBalance(9.6) === "ok",
    "a read within tolerance of the high-water mark does not itself alarm");
  fresh(10);
  ok([9.6, 9.55, 9.5].map((v) => noteBuyerBalance(v)).every((s) => s === "ok"),
    "…and a genuinely small wobble never alarms on its own");
}

{
  // Recovery must clear it, or one bad afternoon pages forever.
  fresh(10);
  noteBuyerBalance(6); noteBuyerBalance(5.9);
  ok(noteBuyerBalance(5.8) === "draining", "draining while it is falling");
  ok(noteBuyerBalance(11) === "ok", "a new high clears the alarm and re-baselines");
  ok(noteBuyerBalance(10.9) === "ok", "and the counter really was reset, not merely masked");
}

{
  ok(fresh(NaN) === "unknown", "an unreadable balance is unknown, never a drain");
  ok(noteBuyerBalance(undefined) === "unknown", "and never throws on junk");
}

{
  // A withdrawal looks exactly like a drain, and SHOULD: the alarm's job is to
  // say "this wallet fell and nobody told me". A human who withdrew can close
  // the issue; a silent fall is the one we must never miss.
  fresh(50);
  const seq = [20, 20, 20].map((v) => noteBuyerBalance(v));
  ok(seq[2] === "draining", "a manual withdrawal alarms too - indistinguishable on purpose");
}

{
  // Keyless boot: the status reads "unconfigured" and never throws, so
  // /api/gateway-status and the heartbeat see a word, not an error.
  const saved = process.env.X402_UPSTREAM_BUYER_KEY;
  delete process.env.X402_UPSTREAM_BUYER_KEY;
  const st = await upstreamBuyerStatus();
  ok(st.configured === false && st.status === "unconfigured" && st.attests === "balance-only", "keyless upstreamBuyerStatus is unconfigured and says it attests the balance only");
  if (saved !== undefined) process.env.X402_UPSTREAM_BUYER_KEY = saved;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
