// Per-network settle deadlines (src/settle-deadlines.js), through the real
// paywall and on the module itself.
//
//   node scripts/test-settle-deadlines.js
//
// Boots the REAL server in paid mode on Base and Celo against stub
// facilitators (Base's, Celo's and the settle fallback) and a stub chain
// (scripts/lib/settle-deadlines-harness.js), file stores, with Celo's row
// shortened by SETTLE_DEADLINES so the suite runs in seconds:
//   - Base on its default row (cap 60 s): a 3 s settle is served with no
//     chain read, and a 30 s settle that then succeeds is SERVED, as today;
//   - Celo: a transfer that lands while the facilitator is still holding its
//     answer is read on chain and served as settled before it answers;
//   - Celo: a 30 s settle is cut at the network's cap and answered
//     unconfirmed; the authorization is booked; the same payment sent again
//     gets the kept answer with nothing run; its transfer lands after the cut
//     and is booked owed exactly once; on file stores (no state database)
//     the same payment sent again still gets the kept 402 and the debt stays
//     owed (the served-on-resend path needs the database's void mark:
//     scripts/test-settle-deadlines-pg.js);
//   - Celo: two slow settles in a row mark the primary slow, the next payment
//     is settled by the fallback with the primary not asked, and after the
//     cool-down the primary is asked first again and keeps its place.
// Then the module half: the default table and its basis, the overrides, the
// payments it leaves alone, the cap, the claim that decides a race, the slow
// record, every branch of the resend verdict, and the booking of a resend
// served (rail, wire, served counter, settlement event, once per transfer).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { startSettleDeadlineHarness, BASE, CELO, CELO_ROW } from "./lib/settle-deadlines-harness.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let H = null;
try {
  H = await startSettleDeadlineHarness({ env: { SETTLE_DEADLINES: JSON.stringify({ celo: CELO_ROW }) } });
  const { srv, send, pay, snap, asked, lateEntries, waitFor, refundOf, owedLines, chain, st, counts, releases, land, landTxOf } = H;

  // 1. Base on its default row (cap 60 s): a 3 s settle with no chain read,
  // and a 30 s settle that then succeeds is served, as today.
  {
    st.base = "slow"; st.holdMs = 3000;
    const c0 = snap();
    const h = await pay(BASE);
    ok(h.status === 200 && h.receipt?.success === true && counts.base - c0.base === 1 && h.ms >= 2900, `Base: a 3 s settle is served as before (${h.status}, ${h.ms} ms)`);
    ok(chain.reads[BASE] === c0.reads[BASE], `Base: no chain read inside its default row (${chain.reads[BASE] - c0.reads[BASE]} reads)`);
    st.holdMs = 30_000;
    const long = await pay(BASE);
    ok(long.status === 200 && long.receipt?.success === true && long.ms >= 29_900 && long.body && !long.body.reason, `Base: a 30 s settle that then succeeds is SERVED, never cut (${long.status}, ${long.ms} ms)`);
    st.base = "ok";
    const f = await pay(BASE);
    ok(f.status === 200 && f.receipt?.success === true, "Base: a fast settle is served");
  }

  // 2. Celo: the transfer lands while the facilitator holds its answer: read
  // on chain and served as settled before the facilitator answers.
  {
    st.celo = "land-hold";
    const c0 = snap();
    const h = await pay(CELO);
    const T = landTxOf(h.nonce);
    ok(h.status === 200 && h.receipt?.success === true && String(h.receipt.transaction).toLowerCase() === T && h.ms < CELO_ROW.capMs, `a landed transfer is served from the chain read before the facilitator answers (${h.status}, ${h.ms} ms, tx ${h.receipt?.transaction})`);
    ok(h.body && typeof h.body === "object" && !h.body.reason && asked(c0) === "1/0" && chain.reads[CELO] > c0.reads[CELO], `the route's answer, the primary asked once, no fallback (${asked(c0)}; ${chain.reads[CELO] - c0.reads[CELO]} reads)`);
    ok(/read on chain after \d+ ms, before .* answered; served as settled/.test(srv.log()), "the log says the transfer was read on chain first");
    for (const rel of [...releases]) rel();
    await sleep(300);
    ok(!lateEntries().some((e) => String(e.nonce || "").toLowerCase() === h.nonce.toLowerCase()), "nothing booked for a served transfer");
    st.celo = "ok";
    const f = await pay(CELO);
    ok(f.status === 200, "a fast Celo settle afterwards is served (and clears the slow streak)");
  }

  // 3. Celo: a 30 s settle cut at the cap; booked; landed after the cut and
  // owed once; on file stores the resend keeps the 402 and the debt stays owed.
  {
    st.celo = "hold30";
    const c0 = snap();
    const h = await pay(CELO);
    ok(h.status === 402 && h.ms >= CELO_ROW.capMs - 100 && h.ms < CELO_ROW.capMs + 2500, `a 30 s Celo settle is cut at Celo's cap (${h.status}, ${h.ms} ms, cap ${CELO_ROW.capMs})`);
    ok(h.body?.reason === "settlement-unconfirmed" && h.body.retry === "check-wallet" && h.receipt?.errorReason === "settlement_unconfirmed" && /Do not sign a new authorization/.test(String(h.body.hint)) && /booked as owed/.test(String(h.body.hint)),
      `answered as an unconfirmed stop: do not sign again, owed if it lands (${h.text.slice(0, 200)})`);
    ok(asked(c0) === "1/0", `no fallback asked after the cut (${asked(c0)})`);
    ok(await waitFor(() => lateEntries().some((e) => String(e.nonce || "").toLowerCase() === h.nonce.toLowerCase() && String(e.payer).toLowerCase() === h.payer.toLowerCase() && e.unconfirmed === true)), "the authorization is booked for the late-settlement read");
    const c1 = snap();
    const early = await send(h.header);
    ok(early.status === 402 && early.replayed === "1" && early.body?.reason === "settlement-unconfirmed" && counts.verify === c1.verify && asked(c1) === "0/0",
      `sent again before it lands: the kept answer, nothing run (${early.status}/${early.replayed})`);
    const T = land(h);
    // The late book's first read of a booking comes FIRST_CHECK_MS (30 s) after it.
    ok(await waitFor(() => owedLines(T) === 1, 50_000), "the transfer that landed after the cut is booked owed");
    ok(/"owed"/.test(JSON.stringify(await refundOf(T))), `the debt reads owed (${JSON.stringify(await refundOf(T)).slice(0, 160)})`);
    await sleep(1500);
    ok(owedLines(T) === 1 && !lateEntries().some((e) => String(e.nonce || "").toLowerCase() === h.nonce.toLowerCase()), `owed exactly once across further passes (${owedLines(T)})`);
    const c2 = snap();
    const again = [await send(h.header), await send(h.header)];
    ok(again.every((r) => r.status === 402 && r.replayed === "1" && r.body?.reason === "settlement-unconfirmed") && counts.verify === c2.verify && asked(c2) === "0/0",
      `file stores: the same payment sent again after it landed keeps the kept 402, nothing run (${again.map((r) => r.status).join(",")})`);
    ok(/"owed"/.test(JSON.stringify(await refundOf(T))) && owedLines(T) === 1 && !/served the kept answer/.test(srv.log()), "file stores: the debt stays owed, once, and nothing is served on the resend");
    for (const rel of [...releases]) rel();
    await sleep(200);
  }

  // 4. Celo: two slow settles in a row mark the primary slow; the fallback
  // settles the next payment first; after the cool-down the primary is asked
  // first again and keeps its place.
  {
    st.celo = "ok";
    await pay(CELO);
    st.celo = "slow"; st.holdMs = 1600;
    const s1 = await pay(CELO), s2 = await pay(CELO);
    ok(s1.status === 200 && s2.status === 200, `slow settles under the cap are served (${s1.ms} ms, ${s2.ms} ms)`);
    ok(/marked slow after 2 slow settles in a row/.test(srv.log()), "the primary is marked slow after two slow settles in a row");
    st.celo = "ok";
    const c0 = snap();
    const sw = await pay(CELO);
    ok(sw.status === 200 && sw.receipt?.success === true && asked(c0) === "0/1", `the next payment is settled by the fallback, the primary not asked (${sw.status}, ${asked(c0)})`);
    await sleep(3200);
    const c1 = snap();
    const back = await pay(CELO);
    ok(back.status === 200 && asked(c1) === "1/0" && /asked first again/.test(srv.log()), `after the cool-down the primary is asked first and recovers (${asked(c1)})`);
    const c2 = snap();
    const stay = await pay(CELO);
    ok(stay.status === 200 && asked(c2) === "1/0", `and keeps its place (${asked(c2)})`);
  }
} catch (e) {
  ok(false, e?.stack || String(e));
} finally {
  if (failed && H) console.error(H.srv.log().split("\n").filter((l) => /\[payments\]|late-settle|settle-deadlines|settle/i.test(l)).slice(-40).join("\n"));
  await H?.stop();
}

// ---- the module half -------------------------------------------------------------
let mod = null;
try { mod = await import("../src/settle-deadlines.js"); } catch (e) { ok(false, `src/settle-deadlines.js loads (${String(e?.message || e).slice(0, 120)})`); }
if (mod) {
  const { defaultDeadlineRow, deadlineFor, settleDeadlineTable, deadlineEligible, withSettleDeadline, settleDeadlineStopOf, noteSettleTime, isSlowPrimary, cappedResendVerdict, cappedResendHolder, noteSettleContext, _resetSettleDeadlines, CAP_FLOOR_MS } = mod;
  const { resetBlockMsMeasurements } = await import("../src/chain-block-time.js");
  resetBlockMsMeasurements();
  const env = { SETTLE_DEADLINES: "" };
  // The table and its basis.
  {
    const rows = Object.fromEntries(settleDeadlineTable({ env }).map((r) => [r.name, r]));
    const want = {
      base: [4000, 2000, 8000, 60000, false], polygon: [4200, 2100, 8400, 60000, false], arbitrum: [2000, 1000, 6000, 60000, false], optimism: [4000, 2000, 8000, 60000, false],
      avalanche: [2280, 1140, 6000, 60000, false], celo: [2000, 1000, 6000, 20000, true], monad: [2000, 1000, 6000, 60000, false], sei: [2000, 1000, 6000, 60000, false],
    };
    const bad = Object.entries(want).filter(([n, w]) => { const r = rows[n]; return !r || JSON.stringify([r.checkAfterMs, r.checkEveryMs, r.slowMs, r.capMs, r.switch]) !== JSON.stringify(w); });
    ok(bad.length === 0 && CAP_FLOOR_MS === 60_000, `the default table follows each chain's block time (${bad.map(([n]) => `${n}: ${JSON.stringify(rows[n])}`).join("; ") || "all rows"})`);
    const denim = defaultDeadlineRow("base", { env: { BASE_DENIM_ACTIVATION_TIMESTAMP: "2020-01-01T00:00:00Z" } });
    ok(denim.checkAfterMs === 2000 && denim.checkEveryMs === 1000 && denim.slowMs === 6000 && denim.capMs === 60000, `Base after its 200 ms upgrade: the floors (${JSON.stringify(denim)})`);
    ok(deadlineFor("eip155:4663", { env }) === null && deadlineFor("eip155:5042", { env }) === null && deadlineFor("eip155:57073", { env }) === null && deadlineFor("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", { env }) === null,
      "Robinhood, Arc, Ink and Solana keep their own settle paths: no row");
  }
  // Overrides.
  {
    const warn = console.warn; const lines = []; console.warn = (l) => lines.push(String(l));
    try {
      ok(deadlineFor(CELO, { env: { SETTLE_DEADLINES: "off" } }) === null, "SETTLE_DEADLINES=off: no deadlines");
      const e1 = { SETTLE_DEADLINES: JSON.stringify({ base: "off", "eip155:42220": { capMs: 15000, switch: false }, polygon: { capMs: -1 }, mars: {} }) };
      const celo = deadlineFor(CELO, { env: e1 });
      ok(deadlineFor(BASE, { env: e1 }) === null && celo.capMs === 15000 && celo.switch === false && celo.slowMs === 6000, `per network: off, or fields over the default (${JSON.stringify(celo)})`);
      ok(deadlineFor("eip155:137", { env: e1 })?.capMs === 60000 && lines.some((l) => /polygon ignored/.test(l)) && lines.some((l) => /mars/.test(l)), "a malformed entry or an unknown network is ignored with a warning");
      ok(deadlineFor(CELO, { env: { SETTLE_DEADLINES: JSON.stringify({ celo: { capMs: 1000, slowMs: 5000 } }) } }).capMs === 5001, "a cap set under the slow mark is moved past it");
      ok(deadlineFor(CELO, { env: { SETTLE_DEADLINES: "{not json" } })?.capMs === 20000 && lines.some((l) => /not "off" and not a JSON object/.test(l)), "unreadable JSON: the defaults, with a warning");
    } finally { console.warn = warn; }
  }
  // What it leaves alone.
  const FROM = `0x${"a1".repeat(20)}`, PAYTO = `0x${"b2".repeat(20)}`, ASSET = `0x${"c3".repeat(20)}`;
  const reqs = (network = CELO, scheme = "exact") => ({ network, scheme, payTo: PAYTO, asset: ASSET, amount: "1000" });
  const payloadOf = (n = 1) => ({ x402Version: 2, payload: { signature: "0x00", authorization: { from: FROM, to: PAYTO, value: "1000", validAfter: "0", validBefore: "9999999999", nonce: `0x${String(n).padStart(64, "0")}` } } });
  const rpcFor = () => "http://127.0.0.1:9";
  ok(deadlineEligible(payloadOf(), reqs(), { rpcFor }) && !deadlineEligible(payloadOf(), reqs(CELO, "upto"), { rpcFor })
    && !deadlineEligible({ payload: { permit2Authorization: { from: FROM }, authorization: payloadOf().payload.authorization } }, reqs(), { rpcFor })
    && !deadlineEligible(payloadOf(), reqs(), { rpcFor: () => null }) && !deadlineEligible({ payload: { authorization: { from: "x", nonce: "y" } } }, reqs(), { rpcFor }),
    "an EIP-3009 exact payment with an RPC is handled; upto, Permit2, no RPC or an unreadable authorization is not");
  const quiet = () => {};
  const testEnv = { SETTLE_DEADLINES: JSON.stringify({ celo: { capMs: 600, checkAfterMs: 100, checkEveryMs: 50, slowMs: 300 }, base: { capMs: 600, checkAfterMs: 100, checkEveryMs: 50, slowMs: 300 } }) };
  {
    _resetSettleDeadlines();
    const calls = [];
    const fast = { success: true, transaction: `0x${"0".repeat(63)}1`, network: BASE };
    const client = { settle: async (...a) => { calls.push(a); return fast; } };
    let proves = 0;
    withSettleDeadline(client, { env: { SETTLE_DEADLINES: "" }, rpcFor, prove: async () => { proves++; return { proven: false, unread: true }; }, log: quiet });
    const p = payloadOf(2), r = reqs(BASE);
    const out = await client.settle(p, r, "extra");
    ok(out === fast && calls.length === 1 && calls[0][0] === p && calls[0][1] === r && calls[0][2] === "extra" && proves === 0, "Base on its default row: a fast settle passes through unchanged, no chain read");
    const again = await client.settle(p, r);
    ok(again === fast && calls.length === 2, "a payload already handled passes straight through (the settle-fallback chain's own calls)");
    const slowRes = await new Promise((res) => { const c2 = { settle: () => new Promise((r2) => setTimeout(() => r2(fast), 900)) }; withSettleDeadline(c2, { env: { SETTLE_DEADLINES: "off" }, rpcFor, log: quiet }); c2.settle(payloadOf(3), reqs(CELO)).then(res, res); });
    ok(slowRes === fast, "SETTLE_DEADLINES=off: a settle past any cap is waited for as before");
  }
  // The cap.
  {
    _resetSettleDeadlines();
    const client = { settle: () => new Promise(() => {}) };
    withSettleDeadline(client, { env: testEnv, rpcFor, labelOf: () => "Celo", prove: async () => ({ proven: false, unread: true }), log: quiet });
    const t0 = Date.now();
    let err = null;
    try { await client.settle(payloadOf(4), reqs(CELO)); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    ok(err && err.name === "SettleError" && err.errorReason === "timeout" && err.statusCode === 504 && settleDeadlineStopOf(err)?.kind === "cap" && settleDeadlineStopOf(err)?.via === "Celo" && ms >= 580 && ms < 1500,
      `nothing answered by the cap: a time-limit failure tagged as the cap's (${ms} ms, ${err?.errorReason})`);
    ok(settleDeadlineStopOf(new Error("x")) === null, "control: another error is not the cap's");
  }
  // The claim decides the race: a transfer being claimed when the cap fires
  // is served; a claim that fails then lets the cap's answer stand.
  for (const [claims, want] of [[true, "chain"], [false, "cap"]]) {
    _resetSettleDeadlines();
    const client = { settle: () => new Promise(() => {}) };
    const proven = { proven: true, transaction: `0x${"77".repeat(32)}`, payer: FROM };
    const p = payloadOf(claims ? 5 : 6);
    noteSettleContext({ paymentPayload: p, transportContext: { request: { adapter: { req: {} } } } });
    withSettleDeadline(client, {
      env: testEnv, rpcFor, log: quiet,
      prove: async () => (await sleep(450), proven),
      recover: async () => { await sleep(400); return claims ? { recovered: true, result: { success: true, transaction: proven.transaction, network: CELO, payer: FROM } } : { recovered: false, reason: "another request owns this authorization" }; },
    });
    let out = null, err = null;
    const t0 = Date.now();
    try { out = await client.settle(p, reqs(CELO)); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    ok(want === "chain" ? (out?.success === true && out.transaction === proven.transaction && ms > 600) : (settleDeadlineStopOf(err)?.kind === "cap" && ms > 600),
      `the cap fires while the transfer is being claimed: ${want === "chain" ? "the claimed transfer is served" : "the claim fails, the cap's answer stands"} (${ms} ms)`);
  }
  // A facilitator error before anything else passes through as is.
  {
    _resetSettleDeadlines();
    const boom = Object.assign(new Error("Facilitator settle failed (500): x"), { statusCode: 500 });
    const client = { settle: async () => { throw boom; } };
    withSettleDeadline(client, { env: testEnv, rpcFor, log: quiet });
    let err = null; try { await client.settle(payloadOf(7), reqs(CELO)); } catch (e) { err = e; }
    ok(err === boom && settleDeadlineStopOf(err) === null, "a facilitator's own failure before the cap is passed on unchanged");
  }
  // The slow record: two slow in a row mark it, the cool-down ends, one fast
  // settle clears it, a slow one after the cool-down marks it again at once.
  {
    _resetSettleDeadlines();
    const prev = process.env.SETTLE_SLOW_COOLDOWN_MS;
    process.env.SETTLE_SLOW_COOLDOWN_MS = "1000";
    try {
      const t = 1_000_000;
      noteSettleTime(CELO, "P", 2000, { slowMs: 1000, now: t, log: quiet });
      ok(!isSlowPrimary(CELO, "P", t), "one slow settle does not mark it");
      noteSettleTime(CELO, "P", 10, { slowMs: 1000, cut: true, now: t + 1, log: quiet });
      ok(isSlowPrimary(CELO, "P", t + 2) && !isSlowPrimary(BASE, "P", t + 2) && !isSlowPrimary(CELO, "Q", t + 2), "a second one in a row (a cut counts, whatever the time) marks it, on that network only");
      ok(!isSlowPrimary(CELO, "P", t + 1002), "the mark ends with the cool-down");
      noteSettleTime(CELO, "P", 3000, { slowMs: 1000, now: t + 1003, log: quiet });
      ok(isSlowPrimary(CELO, "P", t + 1004), "after the cool-down one more slow settle marks it again at once");
      noteSettleTime(CELO, "P", 900, { slowMs: 1000, now: t + 1005, log: quiet });
      ok(!isSlowPrimary(CELO, "P", t + 1006), "one settle at or under the slow mark clears it");
      noteSettleTime(CELO, "P", 2000, { slowMs: 1000, now: t + 1007, log: quiet });
      ok(!isSlowPrimary(CELO, "P", t + 1008), "the streak starts again from zero after a clear");
    } finally { if (prev === undefined) delete process.env.SETTLE_SLOW_COOLDOWN_MS; else process.env.SETTLE_SLOW_COOLDOWN_MS = prev; }
  }
  // The switch: fallbacks only on a network that switches; a refusal made
  // before sending hands on; any other fallback failure ends the settle there.
  {
    _resetSettleDeadlines();
    const seen = [];
    const mk = (name, fn) => ({ name, client: { settle: async () => { seen.push(name); return fn(); } } });
    const ok200 = { success: true, transaction: `0x${"88".repeat(32)}`, network: CELO };
    const refused402 = () => { throw Object.assign(new Error("Facilitator settle failed (402): no"), { statusCode: 402 }); };
    const run = async (network, alts, { primary = () => ok200 } = {}) => {
      seen.length = 0;
      // Marked slow before each run (a fast primary answer clears the mark).
      for (let i = 0; i < 2; i++) noteSettleTime(network, "P", 9000, { slowMs: 1000, log: quiet });
      const client = { settle: async () => { seen.push("primary"); return primary(); } };
      const asked = [];
      withSettleDeadline(client, { env: { SETTLE_DEADLINES: JSON.stringify({ celo: { switch: true }, base: { switch: false } }) }, rpcFor, labelOf: () => "P", alternatesFor: () => alts, isPreBroadcast: (e) => Number(e?.statusCode) === 402, noteAsked: (_p, _n, name) => asked.push(name), log: quiet });
      let out = null, err = null;
      try { out = await client.settle(payloadOf(100 + seen.length + Math.floor(Math.random() * 1e6)), reqs(network)); } catch (e) { err = e; }
      return { out, err, seen: [...seen], asked };
    };
    const a = await run(CELO, [mk("F1", () => ok200)]);
    ok(a.out === ok200 && a.seen.join() === "F1" && a.asked.join() === "F1", `slow primary: the fallback is asked first and settles (${a.seen.join()})`);
    const b = await run(CELO, [mk("F1", refused402), mk("F2", refused402)]);
    ok(b.out === ok200 && b.seen.join() === "F1,F2,primary", `fallbacks refusing before sending hand on to the primary (${b.seen.join()})`);
    const amb = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const c = await run(CELO, [mk("F1", () => { throw amb; }), mk("F2", () => ok200)]);
    ok(c.err === amb && c.seen.join() === "F1" && settleDeadlineStopOf(c.err)?.kind === "fallback" && settleDeadlineStopOf(c.err)?.via === "F1", `a fallback failure that may have sent ends the settle there, unconfirmed (${c.seen.join()})`);
    const d = await run(BASE, [mk("F1", () => ok200)]);
    ok(d.out === ok200 && d.seen.join() === "primary", "a network whose row does not switch keeps its primary first, slow or not");
    const e = await run(CELO, [{ ...mk("own", () => ok200), own: true }]);
    ok(e.seen.join() === "primary", "our own relayer is never asked by the switch");
  }
  // The resend verdict.
  {
    const P = { network: CELO, asset: ASSET, payTo: PAYTO, amount: "2500", from: FROM, nonce: `0x${"9".repeat(64)}`, seenAt: Date.now() - 60_000 };
    const TX = `0x${"ab".repeat(32)}`;
    const mk = (o = {}) => {
      const log = { sales: [], voids: 0, claimHolder: null };
      const deps = {
        prove: async (a) => { log.prove = a; return o.proof ?? { proven: true, transaction: TX, payer: FROM }; },
        claimTx: async (_n, _t, holder) => { log.claimHolder = holder; return o.claim ?? { claimed: true, holder }; },
        isLateHolder: (h) => String(h || "").startsWith("late-settle:"),
        rowOf: async () => o.row ?? null,
        replayVerdict: async () => { log.voids++; return o.verdict ?? { verdict: "serve", voided: true }; },
        book: async (s) => { log.sales.push(s); },
        ledgerShared: o.ledgerShared ?? true,
        refundLookup: (t) => `https://x.example/api/refunds/lookup?tx=${t}`,
      };
      return { deps, log };
    };
    let m = mk({ ledgerShared: false });
    ok((await cappedResendVerdict(P, m.deps)) === null && m.log.prove === undefined && m.log.sales.length === 0 && m.log.voids === 0, "the refund ledger is not the state database: the kept 402 stands, the chain is not even read");
    m = mk({ proof: { proven: false, unread: true } });
    ok((await cappedResendVerdict(P, m.deps)) === null && m.log.prove.notBeforeMs === P.seenAt && m.log.prove.requirements.amount === "2500", "not landed (or unreadable): the kept 402 stands; the chain is read for this payment, mined after it was first seen");
    m = mk();
    let v = await cappedResendVerdict(P, m.deps);
    ok(v?.serve === true && v.tx === TX && JSON.parse(Buffer.from(v.receipt, "base64").toString()).transaction === TX && m.log.claimHolder === cappedResendHolder(P) && m.log.sales.length === 1 && m.log.sales[0].priceUsd === 0.0025 && m.log.voids === 0,
      "landed and nobody holds the transfer: claimed under the payment's own holder, served, sale booked, no debt to void");
    m = mk({ claim: { claimed: false, holder: "late-settle:k" } });
    ok((await cappedResendVerdict(P, m.deps)) === null && m.log.voids === 0, "the late book holds it but no debt row yet: the kept 402 stands, nothing voided");
    m = mk({ claim: { claimed: false, holder: "late-settle:k" }, row: { status: "owed" } });
    v = await cappedResendVerdict(P, m.deps);
    ok(v?.serve === true && m.log.voids === 1 && m.log.sales.length === 1, "booked owed: the debt is voided, then the answer is served");
    m = mk({ claim: { claimed: false, holder: "late-settle:k" }, row: { status: "owed" }, verdict: { verdict: "pending", row: { status: "owed" } } });
    v = await cappedResendVerdict(P, m.deps);
    ok(v?.serve === false && v.status === 503 && v.body.error === "replay_pending" && m.log.sales.length === 0, "a void that did not land: retry shortly, nothing served");
    m = mk({ claim: { claimed: false, holder: "late-settle:k" }, row: { status: "sending" }, verdict: { verdict: "refunded", row: { status: "sending" } } });
    v = await cappedResendVerdict(P, m.deps);
    ok(v?.serve === false && v.status === 402 && v.body.error === "payment_refunded" && v.body.refund.status === "sending" && v.body.refund.lookup === `https://x.example/api/refunds/lookup?tx=${TX}` && m.log.sales.length === 0, "a debt being repaid: refused as refunded, never served too");
    m = mk({ claim: { claimed: false, holder: "some-other-request" } });
    ok((await cappedResendVerdict(P, m.deps)) === null && m.log.sales.length === 0, "another request holds the transfer: the kept 402 stands");
    ok((await cappedResendVerdict({ ...P, network: "eip155:4663" }, mk().deps)) === null && (await cappedResendVerdict({ ...P, from: "x" }, mk().deps)) === null, "a network off the table or an unreadable payment: nothing");
  }
  // The booking of a resend served: its real rail and wire, the served-call
  // counter and the settlement event, once per transfer.
  {
    const { bookCappedServe } = mod;
    const mkSinks = (exists = false) => {
      const got = { sales: [], served: [], events: [] };
      return { got, sinks: {
        saleExists: async () => exists, networkName: (n) => ({ [CELO]: "celo" })[n] || n,
        recordSale: (r) => { got.sales.push(r); }, recordServedCall: (...a) => { got.served.push(a); }, capturePostHogSettlement: (e) => { got.events.push(e); },
      } };
    };
    const base = { slug: "hash", tx: `0x${"cd".repeat(32)}`, network: CELO, payer: FROM, priceUsd: 0.001, clientUa: "node" };
    let k = mkSinks();
    ok((await bookCappedServe({ ...base, wire: "x402" }, k.sinks)) === true
      && k.got.sales.length === 1 && k.got.sales[0].rail === "usdc" && k.got.sales[0].wire === "x402" && k.got.sales[0].network === "celo" && k.got.sales[0].tx === base.tx && k.got.sales[0].slug === "hash"
      && k.got.served.length === 1 && JSON.stringify(k.got.served[0]) === JSON.stringify(["hash", "usdc", "celo", null, { internal: false }])
      && k.got.events.length === 1 && k.got.events[0].rail === "usdc" && k.got.events[0].wire === "x402" && k.got.events[0].network === "celo" && k.got.events[0].payer === FROM && k.got.events[0].clientUa === "node",
      `an x402 resend: the sale on usdc/x402, one served call on celo, one payment_settled event (${JSON.stringify(k.got.served[0])})`);
    k = mkSinks();
    await bookCappedServe({ ...base, wire: "mpp" }, k.sinks);
    ok(k.got.sales[0]?.wire === "mpp" && k.got.served[0]?.[3] === "mpp" && k.got.events[0]?.wire === "mpp", "a payment that came through the MPP shim: booked and counted as MPP");
    k = mkSinks();
    await bookCappedServe({ ...base, wire: "x402", internal: true, ownWallet: true }, k.sinks);
    ok(k.got.served[0]?.[4]?.internal === true && k.got.events[0]?.ownWallet === true, "our own wallet's resend is counted as internal");
    k = mkSinks(true);
    ok((await bookCappedServe({ ...base, wire: "x402" }, k.sinks)) === false && k.got.sales.length + k.got.served.length + k.got.events.length === 0, "a transfer that already holds a sale (an earlier resend served it): nothing booked twice");
  }
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
