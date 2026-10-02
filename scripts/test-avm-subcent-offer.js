#!/usr/bin/env node
// The Algorand accept leaves SUB-CENT routes while the facilitator's sponsored
// sub-cent allowance for our payTo is spent (src/avm-sponsorship.js), and a
// facilitator billing refusal is never the buyer's settle failure.
//
// Found 2026-09-28 in the deploy logs: the facilitator refused every sub-cent
// settle with `subcent_quota_exceeded`, our 402s kept offering Algorand on
// those routes, @x402/express served each paid call before settling it, and
// the settle breaker then refused the buyer with a message blaming their
// wallet. Part 1 pins the pure rules; part 2 boots a PAID server against stub
// facilitators (EVM + Algorand, both local) with a stub /sponsorship/status,
// and drives the real 402, the real matching and the real settle path.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { getFreePorts } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const g = await import("../src/avm-sponsorship.js");
const ALGO = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const PAYTO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const OTHER = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const exhaustedRow = { chain: "algorand", usedMonth: 1013, quota: 1000, suBalance: 0 };
const headroomRow = { chain: "algorand", usedMonth: 12, quota: 1000, suBalance: 0 };
const req = (amount, over = {}) => ({ scheme: "exact", network: ALGO, asset: "31566704", amount: String(amount), payTo: PAYTO, maxTimeoutSeconds: 300, extra: {}, ...over });
const base = (amount) => ({ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: String(amount), payTo: "0xdead", extra: {} });

// ---- Part 1: the pure rules ------------------------------------------------
{
  const logs = [];
  g._resetAvmSponsorshipForTest({ logger: (m) => logs.push(m) });

  // The facilitator's own document: usedMonth lives only in the chains[] row.
  ok(g.sponsorshipRowOf({ quota: 1000, chains: [{ chain: "base" }, exhaustedRow] }) === exhaustedRow, "the Algorand row is read from chains[]");
  ok(g.sponsorshipRowOf({ quota: 1000 }) === null && g.sponsorshipRowOf(null) === null, "no chains[] row -> null");
  ok(g.isSponsorshipExhausted(exhaustedRow), "used >= quota with no purchased units is exhausted");
  ok(!g.isSponsorshipExhausted(headroomRow), "used < quota is headroom");
  ok(!g.isSponsorshipExhausted({ ...exhaustedRow, suBalance: 25000 }), "purchased Settlement Units are headroom even past the quota");
  ok(!g.isSponsorshipExhausted({ chain: "algorand", quota: "n/a" }) && !g.isSponsorshipExhausted(null), "an unreadable row is NOT exhausted (fail open)");

  // Which requirement is sub-cent Algorand USDC.
  ok(g.isAvmSubcentRequirement(req(1000)) && g.isAvmSubcentRequirement(req(9999)), "$0.001 and $0.009999 on Algorand USDC are sub-cent");
  ok(!g.isAvmSubcentRequirement(req(10000)) && !g.isAvmSubcentRequirement(req(50000)), "one cent and above is not");
  ok(!g.isAvmSubcentRequirement(base(1000)), "an EVM requirement never is");
  ok(!g.isAvmSubcentRequirement(req(1000, { asset: "12345" })), "an asset whose decimals we do not know is left alone");
  ok(!g.isAvmSubcentRequirement(req("0.001")) && !g.isAvmSubcentRequirement(req(1000, { amount: undefined })), "an unreadable amount is left alone");
  ok(g.isAvmSubcentRequirement(req(1000, { asset: "10458941", network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" })), "testnet USDC counts the same (six decimals)");

  // The filter.
  const list = [base(1000), req(1000), req(1000, { payTo: OTHER })];
  const pausedOnly = (p) => p === PAYTO;
  const out = g.withoutPausedSubcentAvm(list, pausedOnly);
  ok(out.length === 2 && out[0] === list[0] && out[1] === list[2], "drops the sub-cent Algorand requirement of the paused payTo, keeps Base and the other payTo");
  ok(g.withoutPausedSubcentAvm([base(10000), req(10000)], () => true).length === 2, "a one-cent route keeps Algorand while paused");
  ok(g.withoutPausedSubcentAvm(list, () => false) === list, "nothing paused -> the SAME array back");
  ok(g.withoutPausedSubcentAvm([req(1000)], () => true).length === 1, "never empties the list (a 402 nobody can pay is worse)");

  // Status reads drive the pause; transitions log once each.
  const t0 = Date.UTC(2026, 8, 28, 2, 0, 0);
  ok(!g.isSubcentPaused(PAYTO, t0), "nothing known -> offered");
  ok(g.noteSponsorshipStatus(PAYTO, null, { now: t0 }) === "unreadable" && !g.isSubcentPaused(PAYTO, t0), "an unreadable status on a fresh boot keeps Algorand offered");
  ok(g.noteSponsorshipStatus(PAYTO, exhaustedRow, { now: t0 }) === "exhausted" && g.isSubcentPaused(PAYTO, t0 + 1000), "an exhausted status pauses the payTo");
  ok(!g.isSubcentPaused(OTHER, t0 + 1000), "...and only that payTo");
  g.noteSponsorshipStatus(PAYTO, exhaustedRow, { now: t0 + 60_000 });
  ok(logs.filter((l) => /PAUSED/.test(l)).length === 1, `logged once per transition, not per read (got ${logs.filter((l) => /PAUSED/.test(l)).length})`);
  ok(logs.some((l) => /PAUSED/.test(l) && /1013\/1000/.test(l) && !l.includes(PAYTO)), "the log names the facilitator's own figures and masks the payTo");
  ok(g.noteSponsorshipStatus(PAYTO, null, { now: t0 + 120_000 }) === "unreadable" && g.isSubcentPaused(PAYTO, t0 + 120_000), "an unreadable read keeps fresh evidence");
  ok(!g.isSubcentPaused(PAYTO, t0 + 60_000 + g.STALE_MS + 1), "evidence older than the stale window offers the rail again (fail open)");
  {
    // Crossed while the evidence is still FRESH (40 s old), so only the month
    // rule can reopen it: a check days later would pass on staleness alone.
    const lastSecond = Date.UTC(2026, 8, 30, 23, 59, 30);
    g.noteSponsorshipStatus(OTHER, exhaustedRow, { now: lastSecond });
    ok(g.isSubcentPaused(OTHER, lastSecond + 20_000), "paused in the month's last minute");
    ok(!g.isSubcentPaused(OTHER, Date.UTC(2026, 9, 1, 0, 0, 10)), "the UTC month turning offers it again at once, on fresh evidence (the allowance resets on the 1st)");
    g.noteSponsorshipStatus(OTHER, headroomRow, { now: lastSecond + 60_000 });
  }
  ok(g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t0 + 180_000 }) === "headroom" && !g.isSubcentPaused(PAYTO, t0 + 180_000), "a status read showing headroom clears the pause");
  ok(logs.filter((l) => /OFFERED again/.test(l) && /headroom/.test(l) && l.includes("AAAAAA…HFKQ")).length === 1, "...and says so, once");

  // The settle refusal itself pauses at once, and a read that began BEFORE it cannot clear it.
  const t1 = t0 + 300_000;
  ok(!g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "insufficient_funds", now: t1 }) && !g.isSubcentPaused(PAYTO, t1), "a buyer-side refusal pauses nothing");
  ok(!g.noteAvmSettleRefusal({ network: "eip155:43114", payTo: PAYTO, reason: "subcent_quota_exceeded", now: t1 }), "a non-Algorand network pauses nothing");
  ok(g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "[Algorand (x)] subcent_quota_exceeded", now: t1 }) && g.isSubcentPaused(PAYTO, t1 + 1), "a subcent_quota_exceeded settle pauses the payTo immediately");
  ok(g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t1 + 500, readStartedAt: t1 - 200 }) === "predates-refusal" && g.isSubcentPaused(PAYTO, t1 + 500), "a headroom read that STARTED before the refusal does not clear it");
  // THE FLAP: a status that reads headroom while its own settles still refuse.
  // A headroom read started after the refusal used to clear it, so the rail
  // reopened every ~90 s read and served-then-refused a buyer each time
  // (~960 a day per stream, each kept off the buyer's breaker count). A pause
  // a refusal set now holds against headroom for REFUSAL_HOLD_MS.
  ok(g.REFUSAL_HOLD_MS === 30 * 60_000 && g.REFUSAL_HOLD_MS > g.STALE_MS, `the refusal hold defaults to 30 min, longer than the stale window (got ${g.REFUSAL_HOLD_MS})`);
  ok(g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t1 + 900, readStartedAt: t1 + 600 }) === "held" && g.isSubcentPaused(PAYTO, t1 + 900), "a headroom read started after the refusal, inside the hold, does NOT clear it");
  {
    let heldAll = true;
    for (let t = t1 + 90_000; t < t1 + g.REFUSAL_HOLD_MS; t += 90_000) {
      if (g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t, readStartedAt: t - 500 }) !== "held" || !g.isSubcentPaused(PAYTO, t + 1)) heldAll = false;
    }
    ok(heldAll, "...nor does any headroom read every 90 s for the whole hold - past the 10 min stale window too, since those reads prove the status is being read");
  }
  ok(g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t1 + g.REFUSAL_HOLD_MS + 1000, readStartedAt: t1 + g.REFUSAL_HOLD_MS }) === "headroom" && !g.isSubcentPaused(PAYTO, t1 + g.REFUSAL_HOLD_MS + 1000), "once the hold has passed since the refusal, a headroom read clears it");
  ok(logs.filter((l) => /keeping sub-cent Algorand withdrawn/.test(l)).length === 1, "the hold is logged once, not per read");
  {
    // A NEW refusal is a new hold, and says so once more.
    const t3 = t1 + g.REFUSAL_HOLD_MS + 5 * 60_000;
    g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "subcent_quota_exceeded", now: t3 });
    g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t3 + 90_000, readStartedAt: t3 + 89_000 });
    g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t3 + 180_000, readStartedAt: t3 + 179_000 });
    ok(logs.filter((l) => /keeping sub-cent Algorand withdrawn/.test(l)).length === 2, "a second refusal's hold is logged once more (and not per read)");
    g.noteSponsorshipStatus(PAYTO, headroomRow, { now: t3 + g.REFUSAL_HOLD_MS + 1000, readStartedAt: t3 + g.REFUSAL_HOLD_MS });
  }
  {
    // A day of a facilitator whose status always reads headroom and whose
    // every sub-cent settle refuses: each moment the rail is open, the next
    // buyer is served and refused (and re-pauses it).
    g._resetAvmSponsorshipForTest({ logger: () => {} });
    const day0 = Date.UTC(2026, 8, 10, 0, 0, 0);
    let refused = 0;
    for (let t = day0; t < day0 + 86_400_000; t += 90_000) {
      g.noteSponsorshipStatus(OTHER, headroomRow, { now: t, readStartedAt: t - 500 });
      if (!g.isSubcentPaused(OTHER, t + 1)) { g.noteAvmSettleRefusal({ network: ALGO, payTo: OTHER, reason: "subcent_quota_exceeded", now: t + 2 }); refused++; }
    }
    const bound = Math.ceil(86_400_000 / g.REFUSAL_HOLD_MS) + 1;
    ok(refused <= bound, `a day of a status that contradicts its own settles costs at most one refused settle per hold (${refused} refused, bound ${bound}; ~960 before)`);
    // The hold keeps a refusal fresh only while reads keep arriving: reads
    // that stop being readable fail open the usual way, from the LAST held read.
    const r0 = day0 + 2 * 86_400_000;
    g.noteAvmSettleRefusal({ network: ALGO, payTo: OTHER, reason: "subcent_quota_exceeded", now: r0 });
    g.noteSponsorshipStatus(OTHER, headroomRow, { now: r0 + 5 * 60_000, readStartedAt: r0 + 5 * 60_000 - 500 });
    g.noteSponsorshipStatus(OTHER, null, { now: r0 + 6 * 60_000 });
    ok(g.isSubcentPaused(OTHER, r0 + 5 * 60_000 + g.STALE_MS - 1000) && !g.isSubcentPaused(OTHER, r0 + 5 * 60_000 + g.STALE_MS + 1000), "held, then unreadable: fails open one stale window after the last held read");
    // A status that CONFIRMS exhaustion takes over from the refusal, and its
    // own later headroom clears at once (that is a recovery, not a contradiction).
    g.noteAvmSettleRefusal({ network: ALGO, payTo: OTHER, reason: "subcent_quota_exceeded", now: r0 + 60 * 60_000 });
    g.noteSponsorshipStatus(OTHER, exhaustedRow, { now: r0 + 61 * 60_000 });
    ok(g.noteSponsorshipStatus(OTHER, headroomRow, { now: r0 + 62 * 60_000 }) === "headroom" && !g.isSubcentPaused(OTHER, r0 + 62 * 60_000), "a pause the status itself confirmed clears on the status's own headroom");
    // The hold keeps a pause in force; it never brings one back. A refusal
    // whose pause already failed open (stale behind unreadable reads) is not
    // revived by a headroom read inside the hold's 30 minutes.
    const r1 = r0 + 3 * 60 * 60_000;
    g.noteAvmSettleRefusal({ network: ALGO, payTo: OTHER, reason: "subcent_quota_exceeded", now: r1 });
    for (let t = r1 + 60_000; t <= r1 + 11 * 60_000; t += 60_000) g.noteSponsorshipStatus(OTHER, null, { now: t });
    ok(!g.isSubcentPaused(OTHER, r1 + 11 * 60_000), "(precondition: the refusal's pause failed open behind unreadable reads)");
    ok(g.noteSponsorshipStatus(OTHER, headroomRow, { now: r1 + 12 * 60_000, readStartedAt: r1 + 12 * 60_000 - 500 }) === "headroom" && !g.isSubcentPaused(OTHER, r1 + 12 * 60_000 + 1), "a headroom read inside the hold does not revive a pause that already failed open");
    // The month turns under a hold: a refusal at 23:50 UTC on the 30th, held
    // by headroom reads, is over at midnight - the allowance reset on the 1st
    // whatever the hold's own clock says, and a held read after midnight
    // neither keeps nor revives it.
    const lateSep = Date.UTC(2026, 8, 30, 23, 50);
    g.noteAvmSettleRefusal({ network: ALGO, payTo: OTHER, reason: "subcent_quota_exceeded", now: lateSep });
    ok(g.noteSponsorshipStatus(OTHER, headroomRow, { now: lateSep + 5 * 60_000, readStartedAt: lateSep + 5 * 60_000 - 500 }) === "held" && g.isSubcentPaused(OTHER, lateSep + 5 * 60_000 + 1), "(precondition: held at 23:55 on the 30th)");
    const oct1 = Date.UTC(2026, 9, 1, 0, 0, 30);
    ok(!g.isSubcentPaused(OTHER, oct1), "at 00:00:30 on the 1st the held pause is over (a new UTC month)");
    ok(g.noteSponsorshipStatus(OTHER, headroomRow, { now: oct1 + 30_000, readStartedAt: oct1 + 29_000 }) === "headroom" && !g.isSubcentPaused(OTHER, oct1 + 30_001), "...and a headroom read after midnight clears it rather than holding it into October");
    g._resetAvmSponsorshipForTest({ logger: (m) => logs.push(m) });
  }
  // A refusal's pause names the hold on /api/rails.
  {
    const now = Date.now();
    g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "subcent_quota_exceeded", now });
    const r = g.avmSubcentOfferStatus(now + 1);
    ok(r[0]?.source === "settle-refusal" && /no sooner than 30 minutes after the last refused settlement/.test(r[0]?.resumes || ""), `/api/rails says a refusal's pause holds (got ${r[0]?.resumes})`);
    g._resetAvmSponsorshipForTest({ logger: (m) => logs.push(m) });
  }
  // A payment VERDICT (insufficient_funds, transaction_failed, ...) whose text
  // merely mentions the allowance pauses nothing - the rule the billing
  // receipt classifier applies (src/payment-reject.js).
  {
    const t2 = t1 + 2 * g.REFUSAL_HOLD_MS;
    ok(!g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, errorReason: "transaction_failed", reason: "transaction_failed: simulate: subcent_quota_exceeded", now: t2 }) && !g.isSubcentPaused(PAYTO, t2 + 1), "a transaction_failed verdict whose message names subcent_quota_exceeded does not pause the rail");
    ok(!g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, errorReason: "insufficient_funds", reason: "subcent_quota_exceeded", now: t2 }) && !g.isSubcentPaused(PAYTO, t2 + 1), "...nor does insufficient_funds");
    ok(g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, errorReason: "unexpected_settle_error", reason: "Facilitator settle failed (400): subcent_quota_exceeded", now: t2 }) && g.isSubcentPaused(PAYTO, t2 + 1), "a GENERIC reason whose message names it does pause (the thrown-settle shape)");
    g._resetAvmSponsorshipForTest({ logger: (m) => logs.push(m) });
    ok(g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, errorReason: "subcent_quota_exceeded", reason: "", now: t2 }) && g.isSubcentPaused(PAYTO, t2 + 1), "...and so does the reason itself");
    g._resetAvmSponsorshipForTest({ logger: (m) => logs.push(m) });
  }

  // /api/rails wording: status words and times, never the payTo or the counts.
  g.noteSponsorshipStatus(PAYTO, exhaustedRow, { now: Date.now() });
  const st = g.avmSubcentOfferStatus();
  ok(st.length === 1 && st[0].network === "algorand" && st[0].status === "paused" && typeof st[0].since === "string", "a pause is published for /api/rails");
  ok(!JSON.stringify(st).includes(PAYTO) && !/1013|1000/.test(JSON.stringify(st)), "...without the payTo or the facilitator's counts");
  g.noteSponsorshipStatus(PAYTO, headroomRow, { now: Date.now() });
  ok(g.avmSubcentOfferStatus().length === 0, "and nothing when open");

  // A status row LAST UPDATED in an earlier UTC month is not evidence about
  // this one. The live row carries no month field, only updatedTs, and its
  // usedMonth may be a stored counter that rolls over on the facilitator's
  // next write - which a paused rail would never send. Taken at its word on
  // the 1st, it re-paused at once and stayed paused all month, silently.
  {
    // The LIVE shape, read 2026-09-28: updatedTs is epoch MILLISECONDS, a number.
    const sepRow = { chain: "algorand", suBalance: 0, suPurchased: 0, suConsumed: 13, usdSpent: 0, updatedTs: 1790559828059, patron: false, useProfile: false, usedMonth: 1013, quota: 1000 };
    ok(g.sponsorshipRowUpdatedAt(sepRow) === 1790559828059 && new Date(g.sponsorshipRowUpdatedAt(sepRow)).toISOString() === "2026-09-28T01:43:48.059Z", "the live epoch-ms updatedTs is read as a time");
    ok(g.sponsorshipRowUpdatedAt({ updatedTs: 1790559828 }) === 1790559828000 && g.sponsorshipRowUpdatedAt({ updatedTs: "1790559828059" }) === 1790559828059 && g.sponsorshipRowUpdatedAt({ updatedTs: "2026-09-28T01:43:48.059Z" }) === 1790559828059, "epoch seconds, a numeric string and an ISO string read the same instant");
    ok(g.isSponsorshipRowFromEarlierMonth(sepRow, Date.UTC(2026, 9, 1, 0, 0, 10)), "a row updated in September read on October 1 is from an earlier month");
    ok(g.isSponsorshipRowFromEarlierMonth({ ...sepRow, updatedTs: "2026-09-28T01:43:48Z" }, Date.UTC(2026, 9, 1, 0, 0, 10)), "...in ISO form too");
    ok(!g.isSponsorshipRowFromEarlierMonth(sepRow, Date.UTC(2026, 8, 30, 23, 59)), "...and is this month's on September 30");
    ok(!g.isSponsorshipRowFromEarlierMonth(exhaustedRow, Date.UTC(2026, 9, 1)) && !g.isSponsorshipRowFromEarlierMonth({ ...exhaustedRow, updatedTs: "soon" }, Date.UTC(2026, 9, 1)) && !g.isSponsorshipRowFromEarlierMonth({ ...exhaustedRow, updatedTs: null }, Date.UTC(2026, 9, 1)), "no readable updatedTs is never read as an earlier month");
    ok(!g.isSponsorshipRowFromEarlierMonth({ ...exhaustedRow, updatedTs: Date.UTC(2026, 9, 1, 0, 0, 5) }, Date.UTC(2026, 8, 30, 23, 59, 58)), "a row a few seconds AHEAD of our clock at the boundary is not an earlier month");

    // The edges of the timestamp. 0, a negative or a small number is not a
    // write time: it used to fall through to Date.parse, which reads "0" as a
    // day in 2000 and "-5" as one in 2001, so a junk value decided the month
    // by accident. Now it is unreadable, and a row with an unreadable (but
    // PRESENT) updatedTs is not evidence - the gate fails open on it.
    const oct1At = Date.UTC(2026, 9, 1, 0, 0, 10);
    for (const v of [0, -5, "0", "-5", " -1 ", 5, "5", 2026, "2026", 999_999_999, "1e3", Number.NaN, Infinity, true, "soon", 1e17, "+275760-09-13T00:00:00Z"]) {
      ok(g.sponsorshipRowUpdatedAt({ updatedTs: v }) === null && g.sponsorshipRowMonth({ ...exhaustedRow, updatedTs: v }, oct1At) === "unreadable" && !g.isSponsorshipRowEvidence({ ...exhaustedRow, updatedTs: v }, oct1At),
        `updatedTs ${JSON.stringify(String(v))}: unreadable, not a month, not evidence`);
    }
    ok(g.sponsorshipRowUpdatedAt({ updatedTs: 1e9 }) === 1e12 && g.sponsorshipRowUpdatedAt({ updatedTs: "1000000000" }) === 1e12, "1e9 is the first value read (as seconds): 2001-09-09");
    ok(g.sponsorshipRowMonth(exhaustedRow, oct1At) === "undated" && g.sponsorshipRowMonth({ ...exhaustedRow, updatedTs: null }, oct1At) === "undated" && g.sponsorshipRowMonth({ ...exhaustedRow, updatedTs: "" }, oct1At) === "undated", "a row with NO updatedTs (absent, null, empty) is undated");
    ok(g.isSponsorshipRowEvidence(exhaustedRow, oct1At), "...and an undated row is taken at its word - the documented rule for a document without the field");
    ok(g.sponsorshipRowMonth(sepRow, oct1At) === "earlier-month" && !g.isSponsorshipRowEvidence(sepRow, oct1At) && g.sponsorshipRowMonth(sepRow, Date.UTC(2026, 8, 29)) === "this-month" && g.isSponsorshipRowEvidence(sepRow, Date.UTC(2026, 8, 29)), "a dated row is this month's evidence in its month and not after it");
    // A time more than a day AHEAD of ours cannot name this month either: a
    // sentinel, an odd encoding or a skewed clock would otherwise keep a
    // stale count "current" into every month that follows.
    for (const v of [Date.UTC(9999, 11, 31), "3000-01-01T00:00:00Z", 1e13, 1.79e11]) {
      ok(g.sponsorshipRowMonth({ ...exhaustedRow, updatedTs: v }, oct1At) === "unreadable" && !g.isSponsorshipRowEvidence({ ...exhaustedRow, updatedTs: v }, oct1At), `updatedTs ${JSON.stringify(v)} (far future) is not evidence`);
    }
    ok(g.sponsorshipRowMonth({ ...exhaustedRow, updatedTs: oct1At + 3_600_000 }, oct1At) === "this-month", "an hour ahead (clock skew) still reads as this month");
    {
      const logs3 = [];
      g._resetAvmSponsorshipForTest({ logger: (m) => logs3.push(m) });
      const at = Date.UTC(2026, 8, 20, 12, 0, 0);
      let threw = null, got = null;
      try { got = g.noteSponsorshipStatus(PAYTO, { ...exhaustedRow, updatedTs: 0 }, { now: at }); } catch (e) { threw = e; }
      ok(!threw && got === "unreadable-timestamp" && !g.isSubcentPaused(PAYTO, at + 1), `an exhausted row whose updatedTs is 0 does not pause (fail open) (got ${got}${threw ? `, threw ${threw.message}` : ""})`);
      threw = null;
      try { got = g.noteSponsorshipStatus(PAYTO, { ...exhaustedRow, updatedTs: 1e17 }, { now: at + 1000 }); } catch (e) { threw = e; }
      ok(!threw && got === "unreadable-timestamp", "an updatedTs past a Date's range is read the same, never a RangeError out of the refresher");
      ok(logs3.filter((l) => /not a readable time/.test(l)).length === 1, "logged once");
      g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "subcent_quota_exceeded", now: at + 2000 });
      g.noteSponsorshipStatus(PAYTO, { ...headroomRow, updatedTs: -5 }, { now: at + 92_000, readStartedAt: at + 91_000 });
      ok(g.isSubcentPaused(PAYTO, at + 92_001), "a refusal still pauses while the rows are unreadable...");
      ok(!g.isSubcentPaused(PAYTO, at + 2000 + g.STALE_MS + 1), "...and fails open one stale window later: an unreadable row neither clears it nor holds it");
      g.noteSponsorshipStatus(PAYTO, { ...exhaustedRow, updatedTs: at + 3 * 3_600_000 }, { now: at + 3 * 3_600_000 });
      ok(g.isSubcentPaused(PAYTO, at + 3 * 3_600_000 + 1), "a row with a readable time this month is evidence again");
    }

    const logs2 = [];
    g._resetAvmSponsorshipForTest({ logger: (m) => logs2.push(m) });
    // September 28: the live shape pauses, as it should.
    const sep28 = Date.UTC(2026, 8, 28, 2, 0, 0);
    ok(g.noteSponsorshipStatus(PAYTO, sepRow, { now: sep28 }) === "exhausted" && g.isSubcentPaused(PAYTO, sep28 + 1000), "September's exhausted row pauses in September");
    // The reset: the refresher keeps reading the UNTOUCHED September row every 90 s.
    const oct1 = Date.UTC(2026, 9, 1, 0, 0, 10);
    const tickAt = (t) => g.noteSponsorshipStatus(PAYTO, sepRow, { now: t });
    ok(tickAt(oct1) === "earlier-month" && !g.isSubcentPaused(PAYTO, oct1), "on October 1 a read of the untouched September row is not evidence, and the rail reopens");
    let reopened = true;
    for (const t of [oct1 + 3_600_000, oct1 + 12 * 3_600_000, oct1 + 7 * 86_400_000]) { tickAt(t); if (g.isSubcentPaused(PAYTO, t)) reopened = false; }
    ok(reopened, "...and stays open at +1 h, +12 h and +7 d of such reads");
    ok(g.avmSubcentOfferStatus(oct1 + 3_600_000).length === 0, "/api/rails reports no pause");
    ok(logs2.filter((l) => /before this UTC month began/.test(l)).length === 1 && logs2.some((l) => /OFFERED again/.test(l) && /new UTC month/.test(l)), "the reopening and the ignored row are each logged once");
    // Only a FRESH refusal (or a row the facilitator has rewritten) pauses in the new month.
    const oct1b = oct1 + 3_600_000;
    ok(g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "subcent_quota_exceeded", now: oct1b }) && g.isSubcentPaused(PAYTO, oct1b + 1000), "a fresh subcent_quota_exceeded refusal in October pauses at once");
    tickAt(oct1b + 90_000);
    ok(g.isSubcentPaused(PAYTO, oct1b + 90_000), "...and a later read of September's row cannot clear it");
    ok(!g.isSubcentPaused(PAYTO, oct1b + g.STALE_MS + 1), "...while it still fails open once that refusal is stale, so the next sub-cent settle asks the facilitator again");
    const octRow = { ...sepRow, updatedTs: Date.UTC(2026, 9, 1, 1, 30) };
    ok(g.noteSponsorshipStatus(PAYTO, octRow, { now: oct1b + 2 * g.STALE_MS }) === "exhausted" && g.isSubcentPaused(PAYTO, oct1b + 2 * g.STALE_MS + 1), "a row the facilitator rewrote in October, still exhausted, is evidence and pauses");
  }

  // isWithdrawnSubcentRefusal: the one refusal the settle breaker keeps off a
  // buyer's count - only while the gate is installed and armed, only for the
  // Algorand sub-cent reason (never a payment verdict that mentions it), only
  // for a requirement THIS request was offered that is under one cent and paid
  // to a paused payTo, and only when the route's next 402 really drops it.
  {
    const rc = (over = {}) => ({ success: false, errorReason: "subcent_quota_exceeded", errorMessage: "subcent_quota_exceeded", network: ALGO, transaction: "", ...over });
    // A request as the breaker sees it: the payment header @x402/express
    // settles from, and (via the patched build) what its route offered.
    const paidReq = (accepted, offered) => {
      const hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { paymentGroup: ["x"], paymentIndex: 0 } })).toString("base64");
      const r = { header: (n) => (String(n).toLowerCase() === "payment-signature" ? hdr : undefined), headers: {} };
      if (offered) g.rememberOfferedRequirements(r, offered);
      return r;
    };
    const sub = req(1000), cent = req(10000), otherSub = req(1000, { payTo: OTHER });
    const routeReq = () => paidReq(sub, [base(1000), sub]);   // the usual route: Base + Algorand
    g._resetAvmSponsorshipForTest({ logger: () => {}, installed: false });
    g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "subcent_quota_exceeded" });
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: routeReq() }), "gate not installed on the resource server: not withdrawn");
    g._resetAvmSponsorshipForTest({ logger: () => {}, installed: true });
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: routeReq() }), "installed but nothing paused: not withdrawn");
    g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "subcent_quota_exceeded" });
    ok(g.isWithdrawnSubcentRefusal(rc(), { req: routeReq() }), "installed and paused: a sub-cent Algorand payment to the paused payTo, refused subcent_quota_exceeded on a route that also offers Base, is withdrawn");
    ok(g.isWithdrawnSubcentRefusal(rc({ errorReason: "unexpected_settle_error", errorMessage: "Facilitator settle failed (400): subcent_quota_exceeded" }), { req: routeReq() }), "...named in the message of a thrown settle, too");
    // (a) the verdict guard: a payment verdict is never exempt, whatever its message says.
    ok(!g.isWithdrawnSubcentRefusal(rc({ errorReason: "insufficient_funds", errorMessage: "subcent_quota_exceeded" }), { req: routeReq() }), "insufficient_funds whose message names subcent_quota_exceeded is NOT withdrawn");
    ok(!g.isWithdrawnSubcentRefusal(rc({ errorReason: "transaction_failed", errorMessage: "simulate failed: subcent_quota_exceeded" }), { req: routeReq() }), "...nor is transaction_failed");
    ok(!g.isWithdrawnSubcentRefusal(rc({ network: "eip155:43114" }), { req: routeReq() }), "the same reason on another network is not");
    ok(!g.isWithdrawnSubcentRefusal(rc({ errorReason: "free_tier_exhausted", errorMessage: "free_tier_exhausted" }), { req: routeReq() }), "another billing reason is not");
    ok(!g.isWithdrawnSubcentRefusal(rc({ success: true }), { req: routeReq() }) && !g.isWithdrawnSubcentRefusal(null, { req: routeReq() }), "a settled or absent receipt is not");
    // (b) the refused requirement itself: under one cent, paid to the paused payTo, one this request was offered.
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: paidReq(cent, [base(10000), cent]) }), "a one-cent requirement is not (nothing withdraws it)");
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: paidReq(otherSub, [base(1000), otherSub]) }), "a sub-cent requirement paid to a payTo that is NOT paused is not");
    // ...even on a route where the gate DOES withdraw something else: what
    // counts is the requirement this call paid, not the route's other accepts.
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: paidReq(cent, [base(1000), sub, cent]) }), "a one-cent requirement on a route whose sub-cent accept IS withdrawn is not");
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: paidReq(otherSub, [base(1000), sub, otherSub]) }), "a sub-cent payment to an unpaused payTo, beside a withdrawn one, is not");
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: paidReq(sub) }) && !g.isWithdrawnSubcentRefusal(rc()), "a request whose offer was never recorded (or no request) is not");
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: paidReq(req(2000), [base(1000), sub]) }), "a payment naming a requirement the route did not offer is not");
    ok(!g.isWithdrawnSubcentRefusal(rc({ network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" }), { req: routeReq() }), "a receipt on a different Algorand network than the requirement paid is not");
    // (c) the never-empty rule: a route whose ONLY accept is that one keeps it, so nothing was withdrawn.
    ok(g.withoutPausedSubcentAvm([sub], (p) => g.isSubcentPaused(p)).includes(sub), "(the filter keeps a lone paused sub-cent Algorand accept)");
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: paidReq(sub, [sub]) }), "a route whose only accept is the paused one: nothing is withdrawn, so the refusal is NOT exempt");
    ok(g.isWithdrawnSubcentRefusal(rc(), { req: paidReq(sub, [sub, otherSub]) }), "a route of two Algorand payTos, only ours paused: ours IS dropped (the other remains), so it is withdrawn");
    g.noteAvmSettleRefusal({ network: ALGO, payTo: OTHER, reason: "subcent_quota_exceeded" });
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: paidReq(sub, [sub, otherSub]) }), "...and with both paused the never-empty rule keeps both: not exempt");
    process.env.AVM_SUBCENT_GATE = "off";
    ok(!g.isWithdrawnSubcentRefusal(rc(), { req: routeReq() }), "AVM_SUBCENT_GATE=off: nothing is withdrawn, so nothing is exempt");
    delete process.env.AVM_SUBCENT_GATE;
    g._resetAvmSponsorshipForTest({ logger: () => {}, installed: false });
  }

  // The switch.
  process.env.AVM_SUBCENT_GATE = "off";
  ok(!g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "subcent_quota_exceeded" }), "AVM_SUBCENT_GATE=off disarms the refusal flip");
  delete process.env.AVM_SUBCENT_GATE;

  // The prototype patch: once, filtering the finished list, keeping the inner patch's marker.
  const { installAcceptOutputSchema } = await import("../src/accept-output-schema.js");
  class FakeServer {
    async buildPaymentRequirementsFromOptions(options) { return options.map((o) => ({ ...o })); }
    findMatchingRequirements(avail, p) { return avail.find((r) => r.network === p?.accepted?.network) || null; }
  }
  ok(installAcceptOutputSchema(FakeServer) === true, "the outputSchema patch installs first");
  ok(g.installAvmSubcentGate(FakeServer) === true && g.installAvmSubcentGate(FakeServer) === false, "the gate installs once");
  ok(installAcceptOutputSchema(FakeServer) === false, "...and the outputSchema patch still sees its own marker through it (no double wrap)");
  g._resetAvmSponsorshipForTest({ logger: () => {} });
  g.noteSponsorshipStatus(PAYTO, exhaustedRow);
  const built = await new FakeServer().buildPaymentRequirementsFromOptions([base(1000), req(1000), req(10000)]);
  ok(built.length === 2 && built.every((r) => !g.isAvmSubcentRequirement(r)), "the patched build drops the paused sub-cent Algorand requirement and keeps the one-cent one");
  {
    // The patched build records what the route offered, against the request
    // @x402/express hands it ({ adapter: { req } }), BEFORE filtering: the
    // record isWithdrawnSubcentRefusal checks the paid requirement against.
    g._resetAvmSponsorshipForTest({ logger: () => {} });
    const httpReq = { header: (n) => (String(n).toLowerCase() === "payment-signature" ? Buffer.from(JSON.stringify({ x402Version: 2, accepted: req(1000), payload: {} })).toString("base64") : undefined), headers: {} };
    await new FakeServer().buildPaymentRequirementsFromOptions([base(1000), req(1000)], { adapter: { req: httpReq } });
    g.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "subcent_quota_exceeded" });
    const receipt = { success: false, errorReason: "subcent_quota_exceeded", network: ALGO, transaction: "" };
    ok(g.isWithdrawnSubcentRefusal(receipt, { req: httpReq }), "the patched build records the route's offer for the request, so its refusal is recognised as withdrawn");
    const loneReq = { ...httpReq };
    await new FakeServer().buildPaymentRequirementsFromOptions([req(1000)], { adapter: { req: loneReq } });
    ok(!g.isWithdrawnSubcentRefusal(receipt, { req: loneReq }), "...and a route built with only the Algorand accept is recorded as such (never exempt)");
  }

  // The refresher: reads the live status on its own timer, fails open, recovers.
  g._resetAvmSponsorshipForTest({ logger: () => {} });
  let mode = "exhausted"; const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (mode === "error") return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ quota: 1000, chains: [mode === "exhausted" ? exhaustedRow : headroomRow] }) };
  };
  const stop = g.startAvmSponsorshipRefresher({ facilitatorUrl: "http://facilitator.test/", payTos: [PAYTO], intervalMs: 20, firstDelayMs: 1, fetchImpl });
  await sleep(80);
  ok(urls[0] === `http://facilitator.test/sponsorship/status?wallet=${PAYTO}` && g.isSubcentPaused(PAYTO), "the timer reads /sponsorship/status for our payTo and pauses on an exhausted answer");
  mode = "error"; await sleep(80);
  ok(g.isSubcentPaused(PAYTO), "an unreadable status keeps the fresh evidence");
  mode = "headroom"; await sleep(80);
  ok(!g.isSubcentPaused(PAYTO), "headroom on a later read offers Algorand again");
  stop();
  const n = urls.length; await sleep(60);
  ok(urls.length === n, "stop() ends the reads");
  ok(g.startAvmSponsorshipRefresher({ facilitatorUrl: "", payTos: [PAYTO], fetchImpl })() === undefined, "no facilitator URL -> no timer (and a harmless stop)");

  // Where it is wired (source pins).
  const pay = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  ok(pay.indexOf("installAvmSubcentGate(x402ResourceServer)") > pay.indexOf("installAcceptOutputSchema(x402ResourceServer)"), "payments.js installs the gate after the outputSchema patch, so it filters the finished list");
  ok(/if \(isBillingRefusalReceipt\(\{ success: false, errorReason: ctx\?\.error\?\.errorReason, errorMessage: failure \}\)\) \{[\s\S]{0,1100}noteAvmSettleRefusal\(\{[^}]*errorReason: ctx\?\.error\?\.errorReason/.test(pay), "the settle-failure hook flips the pause on the refusal itself, gated by the receipt rule and handing the gate the facilitator's own errorReason");
  const brk = readFileSync(new URL("../src/gateway-settle-breaker.js", import.meta.url), "utf8");
  ok(/isWithdrawnSubcentRefusal\(receipt, \{ req \}\)/.test(brk), "the settle breaker hands the gate the request, so it checks the requirement that call paid against");
  const callSites = (readFileSync(new URL("../src/server.js", import.meta.url), "utf8").match(/startAvmSponsorshipRefresher\(/g) || []).length;
  ok(callSites === 0 && (pay.match(/startAvmSponsorshipRefresher\(/g) || []).length === 1, "the status read starts once, at boot, never from a request path");
}

// ---- Part 2: booted, against stub facilitators ------------------------------
{
  const [PORT, PORT_OFF, FAC] = await getFreePorts(3);
  let status = "error", settleMode = "quota", verifies = 0, settles = 0;
  const fac = createServer((rq, rs) => {
    let body = ""; rq.on("data", (c) => (body += c)); rq.on("end", () => {
      const reply = (code, obj) => { rs.writeHead(code, { "Content-Type": "application/json" }); rs.end(JSON.stringify(obj)); };
      const [pathOnly] = rq.url.split("?");
      if (pathOnly === "/evm/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
      if (pathOnly === "/avm/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: ALGO }], extensions: [], signers: {} });
      if (pathOnly === "/avm/sponsorship/status") {
        if (status === "error") return reply(500, { error: "down" });
        return reply(200, { quota: 1000, chains: [status === "exhausted" ? exhaustedRow : headroomRow] });
      }
      if (pathOnly.endsWith("/verify")) { verifies++; return reply(200, { isValid: true, payer: PAYTO }); }
      if (pathOnly === "/avm/settle") {
        settles++;
        if (settleMode === "quota") return reply(200, { success: false, errorReason: "subcent_quota_exceeded", errorMessage: "subcent_quota_exceeded", transaction: "", network: ALGO });
        if (settleMode === "quota-thrown") return reply(400, { success: false, errorReason: "subcent_quota_exceeded", transaction: "", network: ALGO });
        if (settleMode === "fail") return reply(200, { success: false, errorReason: "insufficient_funds", errorMessage: "insufficient_funds", transaction: "", network: ALGO });
        // A payment VERDICT whose message happens to name the allowance.
        if (settleMode === "verdict") return reply(200, { success: false, errorReason: "transaction_failed", errorMessage: "simulate: subcent_quota_exceeded", transaction: "", network: ALGO });
        return reply(200, { success: true, transaction: "TX" + settles, network: ALGO, payer: PAYTO });
      }
      if (pathOnly.endsWith("/settle")) { settles++; return reply(200, { success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453" }); }
      return reply(404, {});
    });
  });
  await new Promise((r) => fac.listen(FAC, "127.0.0.1", r));
  const serverLog = [];
  const procs = [];
  const boot = async (port, extraEnv = {}) => {
    const proc = spawn("node", ["src/server.js"], {
      env: {
        ...process.env, PORT: String(port), FREE_MODE: "",
        WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
        PAYMENT_NETWORKS: "base,algorand", ALGORAND_WALLET_ADDRESS: PAYTO,
        CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
        PAYAI_FACILITATOR_URL: `http://127.0.0.1:${FAC}/evm`, ALGORAND_FACILITATOR_URL: `http://127.0.0.1:${FAC}/avm`,
        ALGORAND_UPSTREAM_BUYER_ADDRESS: "", MPP_SECRET_KEY: "", PAYMENT_SETTLE_FALLBACK: "", AVM_SUBCENT_GATE: "",
        AVM_SPONSORSHIP_REFRESH_MS: "250", AVM_SPONSORSHIP_REFUSAL_HOLD_MS: "2000", AGENT402_BASE_RPC: `http://127.0.0.1:${FAC}/rpc`,
        GATEWAY_SETTLE_BREAKER_MAX: "3", GATEWAY_SETTLE_BREAKER_WINDOW_MS: "600000",
        X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off", SOLANA_LEADERBOARD: "off",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(proc);
    const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(`[${port}] ${l.slice(0, 400)}`); if (serverLog.length > 200) serverLog.splice(0, serverLog.length - 200); };
    proc.stdout.on("data", keep); proc.stderr.on("data", keep);
    const B = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!up) await sleep(500); }
    return up ? B : null;
  };
  const done = (code) => { for (const p of procs) p.kill("SIGKILL"); fac.close(); if (code) for (const l of serverLog.slice(-30)) console.error("  server:", l); console.log(`\n${pass} passed, ${fail} failed`); process.exit(code); };

  const HASH = { path: "/api/hash", body: JSON.stringify({ text: "x" }) };          // $0.001, sub-cent, PoW-eligible (never breakered)
  const CENT = { path: "/api/solidity-scan", body: JSON.stringify({ source: "pragma solidity ^0.8.0;\ncontract C { function f() external {} }" }) }; // $0.01
  // Wallet-only and sub-cent, answered from local state: the settle breaker's
  // catalog consult runs on it, so a count against the buyer is observable.
  // (POST to a GET-only route is served through the method alias.)
  const RADAR = { path: "/api/demand-radar", body: JSON.stringify({ limit: 1 }) };
  const offer402At = async (B, t) => {
    const r = await fetch(`${B}${t.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: t.body });
    const pr = r.status === 402 ? JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8")) : null;
    let body = null; try { body = await r.json(); } catch { body = null; }
    return { status: r.status, pr, body, avm: (pr?.accepts || []).find((a) => String(a.network).startsWith("algorand:")) || null };
  };
  let n = 0;
  const payAvmAt = async (B, t, accepted) => fetch(`${B}${t.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { paymentGroup: [Buffer.from(`group-${++n}-${Date.now()}`).toString("base64")], paymentIndex: 0 } })).toString("base64") },
    body: t.body,
  });
  const waitFor = async (cond, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(100); } return false; };

  try {
    const B = await boot(PORT);
    if (!B) { ok(false, "paid server booted"); done(1); }
    const offer402 = (t) => offer402At(B, t);
    const payAvm = (t, accepted) => payAvmAt(B, t, accepted);
    await sleep(700); // a few status reads (all failing: status "error")

    // Unreadable status: fail open.
    const h0 = await offer402(HASH), c0 = await offer402(CENT);
    ok(h0.status === 402 && !!h0.avm && h0.avm.amount === "1000", `unreadable status: the $0.001 route still offers Algorand (amount ${h0.avm?.amount})`);
    ok(!!c0.avm && c0.avm.amount === "10000", "and the $0.01 route offers it");
    const rails0 = await (await fetch(`${B}/api/rails`)).json();
    ok(Array.isArray(rails0.restrictions) && rails0.restrictions.length === 0, "/api/rails lists no restriction while open");

    // Exhausted status: the sub-cent 402 drops Algorand, the one-cent 402 keeps it.
    status = "exhausted";
    ok(await waitFor(async () => !(await offer402(HASH)).avm), "exhausted status: the $0.001 route stops offering Algorand");
    const h1 = await offer402(HASH), c1 = await offer402(CENT);
    ok(h1.pr.accepts.some((a) => a.network === "eip155:8453"), "...and still offers Base");
    {
      const { parsePaymentRequired } = await import("@x402/core/schemas");
      const parsed = parsePaymentRequired(h1.pr);
      ok(parsed.success && h1.pr.accepts[0]?.outputSchema !== undefined, `the withdrawn 402 is still valid under the protocol's own schema, first accept still carrying outputSchema (${parsed.success ? "valid" : parsed.error.issues[0]?.message})`);
    }
    // The 402 body mirrors the FINAL header (src/payment-required-body.js):
    // what the sub-cent gate withdrew from the header is gone from the body too.
    ok(Array.isArray(h1.body?.accepts) && JSON.stringify(h1.body.accepts) === JSON.stringify(h1.pr.accepts) && !h1.body.accepts.some((a) => String(a.network).startsWith("algorand:")),
      `the withdrawn 402's JSON body carries the filtered accepts, no Algorand entry (body networks: ${(h1.body?.accepts || []).map((a) => a.network).join(",")})`);
    ok(!!c1.avm, "the $0.01 route keeps its Algorand accept");
    const rails1 = await (await fetch(`${B}/api/rails`)).json();
    ok(rails1.restrictions?.[0]?.network === "algorand" && rails1.restrictions[0].status === "paused" && !JSON.stringify(rails1).includes(PAYTO), "/api/rails publishes the pause, status words only");
    ok(serverLog.some((l) => /\[avm-subcent\] Algorand PAUSED/.test(l)), "the transition is logged");

    // A buyer holding the earlier Algorand accept is refused BEFORE the handler.
    {
      const v = verifies, s = settles;
      const r = await payAvm(HASH, h0.avm);
      const b = await r.json().catch(() => ({}));
      ok(r.status === 402 && verifies === v && settles === s, `an Algorand payment on the withdrawn route is a pre-handler 402: nothing verified, nothing served, nothing settled (status ${r.status}, verifies +${verifies - v}, settles +${settles - s})`);
      ok(b.retry === "choose-offered-option" && /not offered/.test(b.hint || ""), `...and the refusal says to pick an offered network (got ${b.reason}: ${String(b.hint).slice(0, 80)})`);
    }

    // Headroom: Algorand returns to sub-cent routes.
    status = "headroom";
    ok(await waitFor(async () => !!(await offer402(HASH)).avm), "headroom on a later read: the $0.001 route offers Algorand again");

    // The settle refusal itself flips it, without waiting for a status read.
    // Re-open between refusals: a status read started after the refusal,
    // showing headroom, then the status goes unreadable again.
    const reopen = async (t) => {
      status = "headroom";
      const back = await waitFor(async () => !!(await offer402(t)).avm);
      status = "error"; await sleep(400);
      return back;
    };
    status = "error"; await sleep(400);
    for (const mode of ["quota", "quota-thrown"]) {
      settleMode = mode;
      const accepted = (await offer402(HASH)).avm;
      if (!accepted) { ok(await waitFor(async () => !!(await offer402(HASH)).avm, 1500), `(${mode}) Algorand offered before the paid call`); }
      const s = settles;
      const r = await payAvm(HASH, accepted || (await offer402(HASH)).avm);
      const b = await r.json().catch(() => ({}));
      ok(r.status === 402 && settles === s + 1, `(${mode}) a sub-cent Algorand payment was served and then refused at settle (status ${r.status})`);
      ok(b.reason === "facilitator-quota" && b.retry === "other-network" && /Algorand facilitator/.test(b.hint || "") && /not because of your wallet/.test(b.hint || ""), `(${mode}) the 402 names the rail and clears the wallet (got ${b.reason}: ${String(b.hint).slice(0, 70)})`);
      const after = await offer402(HASH);
      ok(!after.avm && after.pr.accepts.length > 0, `(${mode}) the very next sub-cent 402 no longer offers Algorand (flipped by the refusal)`);
      ok(!!(await offer402(CENT)).avm, `(${mode}) the $0.01 route keeps Algorand`);
      if (mode === "quota") {
        // The flap: the status reads headroom at once, while the refusal is
        // under a second old. Reads every 250 ms used to reopen it on the
        // first one; the refusal hold (2 s here) keeps it withdrawn.
        status = "headroom"; await sleep(700);
        ok(!(await offer402(HASH)).avm, "(quota) headroom reads inside the refusal hold do not reopen the sub-cent offer");
        ok(serverLog.some((l) => /keeping sub-cent Algorand withdrawn/.test(l)), "...and the server says it is holding");
      }
      ok(await reopen(HASH), `(${mode}) headroom read afterwards restores it`);
    }

    // The SETTLE BREAKER on a wallet-only sub-cent tool. A refusal the gate
    // withdraws is kept off the buyer's count: one buyer (an Algorand payer is
    // keyed by client IP), MAX + 1 such refusals, every one still served -
    // re-opened between them, since each one withdraws the offer.
    let allServed = true;
    for (let i = 1; i <= 4; i++) {
      settleMode = i % 2 ? "quota" : "quota-thrown"; // both wire shapes of the refusal
      const accepted = (await offer402(RADAR)).avm;
      const s = settles;
      const r = await payAvm(RADAR, accepted);
      if (!(accepted && r.status === 402 && settles === s + 1)) allServed = false;
      ok(!(await offer402(RADAR)).avm, `withdrawn refusal ${i} on the wallet-only route: the next 402 no longer offers Algorand`);
      ok(await reopen(RADAR), `withdrawn refusal ${i}: re-opened by a later headroom read`);
    }
    ok(allServed, "four withdrawn refusals from one buyer (MAX 3): each served and refused at settle, never a 429 - none counted against the buyer");
    // Control, same buyer: genuine settle failures still count from zero and trip the 429 at MAX.
    // The first is a payment VERDICT whose message names the allowance: it
    // pauses nothing, is not called a quota, and counts like any failure.
    {
      settleMode = "verdict";
      const quotaLogs = serverLog.filter((l) => /QUOTA exhausted/.test(l)).length;
      const s = settles;
      const r = await payAvm(RADAR, (await offer402(RADAR)).avm);
      ok(r.status === 402 && settles === s + 1, `genuine failure 1 (transaction_failed naming subcent_quota_exceeded in its message) from the same buyer is served (status ${r.status})`);
      await sleep(300);
      ok(!!(await offer402(RADAR)).avm && (await (await fetch(`${B}/api/rails`)).json()).restrictions?.length === 0, "...and it does NOT pause the rail: the next sub-cent 402 still offers Algorand, /api/rails lists nothing");
      ok(serverLog.filter((l) => /QUOTA exhausted/.test(l)).length === quotaLogs, "...nor is it logged as a facilitator quota");
    }
    settleMode = "fail";
    for (let i = 2; i <= 3; i++) {
      const s = settles;
      const r = await payAvm(RADAR, (await offer402(RADAR)).avm);
      ok(r.status === 402 && settles === s + 1, `genuine failure ${i} (insufficient_funds) from the same buyer is served (status ${r.status})`);
    }
    {
      const s = settles;
      const r = await payAvm(RADAR, (await offer402(RADAR)).avm);
      const b = await r.json().catch(() => ({}));
      ok(r.status === 429 && settles === s && /failed to settle/.test(b.error || ""), `...and the next is refused 429 before the handler, exactly as before (status ${r.status})`);
    }

    // A one-cent route settles normally throughout.
    settleMode = "ok";
    {
      const r = await payAvm(CENT, (await offer402(CENT)).avm);
      ok(r.status === 200, `a $0.01 Algorand payment settles (status ${r.status})`);
    }

    // AVM_SUBCENT_GATE=off: the escape hatch withdraws nothing, so NOTHING is
    // exempt from the breaker - a sub-cent Algorand refusal loop is bounded per
    // buyer like any other failed settle, with a 429 that names the billing
    // limit instead of the wallet. (Before this, off meant served free without bound.)
    {
      const B2 = await boot(PORT_OFF, { AVM_SUBCENT_GATE: "off" });
      ok(!!B2, "a second paid server booted with AVM_SUBCENT_GATE=off");
      if (!B2) done(1);
      status = "exhausted"; settleMode = "quota";
      await sleep(700);
      ok(!!(await offer402At(B2, RADAR)).avm, "gate off: the sub-cent 402 keeps offering Algorand while the status reads exhausted");
      for (let i = 1; i <= 3; i++) {
        const s = settles;
        const r = await payAvmAt(B2, RADAR, (await offer402At(B2, RADAR)).avm);
        ok(r.status === 402 && settles === s + 1, `gate off, refusal ${i}: served, then refused at settle (status ${r.status})`);
      }
      const s = settles;
      const r = await payAvmAt(B2, RADAR, (await offer402At(B2, RADAR)).avm);
      const b = await r.json().catch(() => ({}));
      ok(r.status === 429 && settles === s, `gate off, refusal 4: refused 429 BEFORE the handler, the loop bounded per buyer (status ${r.status})`);
      ok(/billing limit on this server's own account/.test(b.error || "") && !/USDC balance/.test(b.error || ""), `...and the 429 names the facilitator's billing limit, not the wallet (got: ${String(b.error).slice(0, 110)})`);
    }
  } catch (e) {
    ok(false, `booted leg threw: ${e?.stack || e}`);
  }
  done(fail ? 1 : 0);
}
