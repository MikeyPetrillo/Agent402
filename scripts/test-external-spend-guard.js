// Offline tests for src/external-spend-guard.js.
//
// The hole it closes: settlement runs AFTER the handler, and the external
// routing handler pays a third-party seller from our wallet. A payment that
// VERIFIES and then fails to SETTLE leaves us out the upstream spend with the
// buyer charged nothing. Self-dealt - one wallet listing the seller and buying
// from it - every drained dollar returns to the attacker.
import {
  maySpend, noteSpend, adjustSpend, resolveSpend, payerExposureUsd, exposureSnapshot, __reset,
} from "../src/external-spend-guard.js";

import { readFile } from "node:fs/promises";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const A = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

// --- the attack, in one block ------------------------------------------------
{
  __reset();
  // An explicit ceiling, not the shipped default: this block is about the
  // MECHANISM, and tying it to whatever the default happens to be today would
  // make it pass for the wrong reason the next time a tier moves.
  const CEIL = { maxUnsettledUsd: 0.75 };
  // Call 1: allowed, we spend upstream.
  ok(maySpend(A, 0.5, CEIL).ok, "a fresh payer may spend");
  const h1 = noteSpend(A, 0.5);
  ok(payerExposureUsd(A) === 0.5, "the spend counts as exposure while unresolved");

  // Their payment FAILS to settle. This is the whole point: handler success is
  // not revenue, and the exposure must survive it.
  resolveSpend(h1, false);
  ok(payerExposureUsd(A) === 0.5,
    `an UNSETTLED spend keeps counting against the payer (got ${payerExposureUsd(A)})`);

  // Call 2 from the same wallet is refused before we spend a second time.
  const second = maySpend(A, 0.5, CEIL);
  ok(second.ok === false, "a second call is refused while the first is unpaid - the drain stops at one");
  ok(/has not settled/i.test(second.reason), `the refusal explains itself (got: ${second.reason})`);
}

{
  // The honest buyer's path: settle, and exposure clears immediately.
  __reset();
  const h = noteSpend(A, 0.5);
  resolveSpend(h, true);
  ok(payerExposureUsd(A) === 0, "a SETTLED spend clears the exposure at once");
  ok(maySpend(A, 0.5, { maxUnsettledUsd: 0.75 }).ok, "and the payer may immediately spend again - this is a debt ceiling, not a reputation");
}

{
  // A wallet that pays reliably is never impeded, however many calls it makes.
  __reset();
  let everRefused = false;
  for (let i = 0; i < 25; i++) {
    if (!maySpend(A, 0.5).ok) everRefused = true;
    resolveSpend(noteSpend(A, 0.5), true);
  }
  ok(!everRefused && payerExposureUsd(A) === 0 && maySpend(A, 0.5).ok,
    "25 settled calls in a row are never refused and leave zero exposure - a good buyer never hits the ceiling");
}

// --- identity handling -------------------------------------------------------
{
  __reset();
  const h = noteSpend(A.toLowerCase(), 0.5);
  resolveSpend(h, false);
  ok(payerExposureUsd(A.toUpperCase().replace("0X", "0x")) === 0.5,
    "EVM addresses are case-insensitive, so a payer cannot reset their ledger by changing case");

  // base58 / Stellar / Algorand are case-SENSITIVE: folding them merges
  // distinct payers, the same rule src/payer.js enforces.
  const s1 = "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL";
  const h2 = noteSpend(s1, 0.4);
  resolveSpend(h2, false);
  ok(payerExposureUsd(s1.toLowerCase()) === 0,
    "a base58/Stellar address is NOT case-folded - folding would merge distinct payers");
}

{
  __reset();
  // An unattributable payer (free mode, a rail whose payer we cannot read) is
  // allowed: refusing would break every legitimate buyer on those rails, and a
  // single call is still bounded by the tier cap.
  const v = maySpend(null, 0.5);
  ok(v.ok === true && /not attributable/i.test(v.reason),
    "an unreadable payer is allowed and says why - the tier cap still bounds the call");
  ok(noteSpend(null, 0.5) === null, "…and nothing is recorded for a payer we cannot name");
}

// --- ceiling arithmetic ------------------------------------------------------
{
  __reset();
  ok(maySpend(A, 0.5, { maxUnsettledUsd: 0.5 }).ok, "exactly at the ceiling is allowed");
  const h = noteSpend(A, 0.5);
  resolveSpend(h, false);
  ok(maySpend(A, 0.01, { maxUnsettledUsd: 0.5 }).ok === false,
    "one cent past the ceiling is refused - the check is on the TOTAL, not the single call");
}

{
  // An unresolved row must not bar a payer forever (a process restart, a
  // response that never finished), but must not clear so fast a loop outruns it.
  __reset();
  const now = 1_000_000;
  noteSpend(A, 0.5, now);
  ok(payerExposureUsd(A, now + 60_000) === 0.5, "exposure stands a minute later");
  ok(payerExposureUsd(A, now + 11 * 60_000) === 0, "an unresolved spend ages out after the stale window");
}

{
  __reset();
  const h = noteSpend(A, 0.25);
  resolveSpend(h, false);
  const snap = exposureSnapshot();
  ok(snap.length === 1 && snap[0].unsettledUsd === 0.25 && snap[0].calls === 1,
    `the operator view reports who owes upstream spend (got ${JSON.stringify(snap)})`);
}

{
  // resolveSpend must never throw on junk - it runs inside a response
  // finish handler, where an exception would break the response.
  __reset();
  let threw = null;
  try { resolveSpend(null, true); resolveSpend({ payer: "nope", id: 9 }, true); resolveSpend(undefined, false); }
  catch (e) { threw = e; }
  ok(!threw, "resolving an unknown or missing handle is a no-op, never a throw");
}

// --- the coupling that would silently kill a tier ----------------------------
// If the ceiling is ever smaller than the largest execution tier's underlying
// cap, that tier is dead on arrival: a single legitimate call exceeds the
// ceiling and EVERY payer is refused, honest ones included. Nothing else would
// report this - the tier would simply never succeed - so it gets an assertion
// rather than the comment it started as.
{
  __reset();
  const { EXEC_TIERS } = await import("../src/tools/route-execute.js");
  const { __config } = await import("../src/external-spend-guard.js");
  const biggest = Math.max(...EXEC_TIERS.map((t) => t.underlyingMaxUsd));
  ok(__config.DEFAULT_MAX_UNSETTLED_USD >= biggest,
    `the unsettled ceiling ($${__config.DEFAULT_MAX_UNSETTLED_USD}) covers the largest tier's underlying cap ($${biggest}) - otherwise that tier can never run`);
  ok(maySpend("0x1111111111111111111111111111111111111111", biggest).ok,
    "a single largest-tier call is allowed for a payer with no exposure");
}

// --- a seller must not be able to set our own debt ceiling -------------------
// Since 2026-08-29 a route's resolved price comes from the origin's OWN current
// declaration (the fix for a price-cut ratchet). That makes the declared price
// a single seller-controlled document, so it must not be the number booked
// against the ceiling: a seller declaring $0.0001 while quoting the tier cap on
// the live 402 would make each call count as a fiftieth of its real exposure,
// and the ceiling is exactly what stops a RUN of those. Book the worst case,
// correct down once the real quote is known.
{
  __reset();
  const PAYER = "0x4444444444444444444444444444444444444444";
  const CAP = 0.005;
  const h = noteSpend(PAYER, CAP);
  ok(payerExposureUsd(PAYER) === CAP,
    `the worst case a call could cost is booked up front ($${CAP}), not a declared price`);

  adjustSpend(h, 0.0001);
  ok(payerExposureUsd(PAYER) === 0.0001,
    "once the seller has actually quoted, the exposure is corrected DOWN to what was paid");

  adjustSpend(h, 99);
  ok(payerExposureUsd(PAYER) === 0.0001,
    "adjustSpend only ever lowers - nothing may book itself above the cap it was authorized under");

  adjustSpend(h, -5);
  adjustSpend(h, Number.NaN);
  ok(payerExposureUsd(PAYER) === 0.0001, "a negative or unreadable amount is ignored, never applied");

  adjustSpend(null, 0.001);
  adjustSpend({ payer: PAYER, id: 999999 }, 0.001);
  ok(payerExposureUsd(PAYER) === 0.0001, "a missing handle or unknown row is a no-op, never a throw");

  resolveSpend(h, true);
  ok(payerExposureUsd(PAYER) === 0, "a settled spend still clears normally after an adjustment");
}

// The ceiling has to bite on the WORST case, or a payer can run far more calls
// than it is meant to before being paused.
{
  __reset();
  const PAYER = "0x5555555555555555555555555555555555555555";
  const CAP = 0.005;
  let allowed = 0;
  for (let i = 0; i < 5000; i++) {
    if (!maySpend(PAYER, CAP).ok) break;
    noteSpend(PAYER, CAP);
    allowed++;
  }
  const { __config } = await import("../src/external-spend-guard.js");
  const expected = Math.floor(__config.DEFAULT_MAX_UNSETTLED_USD / CAP);
  ok(allowed === expected,
    `a payer whose calls never settle is paused after ${expected} worst-case calls (got ${allowed})`);
}

// --- the WIRING, not just the primitive ---------------------------------------
// The two mutations differ in how visible they are: making adjustSpend able to
// raise fails three assertions above, but quietly changing the caller back to
// booking the seller's declared price fails NOTHING - the primitive is still
// correct, it is just handed the wrong number. That is the shape of defect this
// repo keeps rediscovering, so the call site is read directly.
{
  const src = await readFile(new URL("../src/tools/route-execute.js", import.meta.url), "utf8");
  ok(/maySpend\(\s*spendPayer\s*,\s*cap\s*,\s*\{\s*chain\s*\}\s*\)/.test(src),
    "route-execute authorizes against the tier cap, not the seller's declared price, and names the chain the spend leaves from");
  ok(/noteSpend\(\s*spendPayer\s*,\s*cap\s*,\s*\{\s*chain\s*\}\s*\)/.test(src),
    "route-execute books the tier cap as the worst-case exposure, against the chain wallet too");
  ok(/adjustSpend\(\s*spendHandle\s*,\s*underlyingUsd\s*\)/.test(src),
    "route-execute corrects the exposure down to the amount actually quoted");
  ok(src.indexOf("adjustSpend(spendHandle, underlyingUsd)") > src.indexOf("const underlyingUsd"),
    "the correction happens AFTER the real quote is known, never before");
  ok(/allowed\.code\s*===\s*"wallet_daily_ceiling"/.test(src) && /paused for everyone/.test(src),
    "route-execute tells the buyer a wallet_daily_ceiling refusal is a global pause, not their own limit");
}

// --- the per-CHAIN-WALLET daily ceiling ----------------------------------------
// The per-payer ceiling is keyed on the buyer, so rotating wallets or IPs walks
// around it and the only hard bound on a spending wallet was its balance. The
// daily ceiling is keyed on the CHAIN the money leaves from, counts settled and
// unsettled spend alike over a rolling 24 h, and refuses with its own code so a
// caller can say "global pause" rather than "your limit".
const guard = await import("../src/external-spend-guard.js");
const { walletDailySpentUsd, walletDailyStatus, walletDailyCeilingUsd, WALLET_CHAINS, __config } = guard;
const noEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith("SOR_WALLET_DAILY_MAX_USD")) delete process.env[k]; };

{
  __reset(); noEnv();
  const CEIL = { walletDailyMaxUsd: 1.0 };
  const P = "0x6666666666666666666666666666666666666666";
  ok(maySpend(P, 0.4, { chain: "base", ...CEIL }).ok, "under the ceiling: allowed");
  const h1 = noteSpend(P, 0.4, { chain: "base" });
  resolveSpend(h1, true); // SETTLED - and it still counts toward the day
  ok(walletDailySpentUsd("base") === 0.4 && payerExposureUsd(P) === 0,
    "a SETTLED spend clears the payer's exposure but still counts against the chain wallet's day");
  ok(maySpend(P, 0.6, { chain: "base", ...CEIL }).ok, "exactly AT the ceiling: allowed (the check is on the total, inclusive)");
  noteSpend(P, 0.6, { chain: "base" });
  const over = maySpend(P, 0.001, { chain: "base", ...CEIL });
  ok(over.ok === false && over.code === "wallet_daily_ceiling" && over.chain === "base",
    `one tenth of a cent OVER the ceiling is refused with the distinct code (got ${JSON.stringify(over)})`);
  ok(/every buyer/i.test(over.reason) && /24 h/.test(over.reason),
    `the refusal says it is a global pause on the chain (got: ${over.reason})`);
  ok(over.spentUsd === 1.0 && over.ceilingUsd === 1.0, "the refusal carries the figures");
  // A DIFFERENT payer is refused on the same chain - it is the wallet that is capped.
  ok(maySpend("0x7777777777777777777777777777777777777777", 0.001, { chain: "base", ...CEIL }).ok === false,
    "rotating to a fresh payer does not help: the ceiling is per chain wallet, not per buyer");
  ok(maySpend(null, 0.001, { chain: "base", ...CEIL }).ok === false,
    "an unattributable payer is refused too - the chain check runs before the payer check");
  // Another chain is untouched.
  ok(maySpend(P, 0.9, { chain: "solana", ...CEIL }).ok, "another chain's wallet has its own day");
  // A per-payer refusal carries NO code, so the two are distinguishable.
  const perPayer = maySpend(P, 5, { maxUnsettledUsd: 0.5, chain: "solana", walletDailyMaxUsd: 100 });
  ok(perPayer.ok === false && perPayer.code === undefined && /has not settled/.test(perPayer.reason),
    "a per-payer refusal has no code; only the wallet ceiling does");
}

{
  // An unattributable payer with a chain is RECORDED against the chain (the
  // attest gas spend has no payer of its own).
  __reset(); noEnv();
  const h = noteSpend(null, 0.005, { chain: "base" });
  ok(h && h.payer === null && h.chain === "base" && typeof h.id === "number",
    `a payer-less spend with a chain gets a chain-only handle (got ${JSON.stringify(h)})`);
  ok(walletDailySpentUsd("base") === 0.005, "and counts toward that wallet's day");
  ok(noteSpend(null, 0.5) === null, "with neither payer nor chain nothing is recorded (unchanged)");
  adjustSpend(h, 0.002);
  ok(walletDailySpentUsd("base") === 0.002, "adjustSpend lowers the chain row to the real quote");
  adjustSpend(h, 9);
  ok(walletDailySpentUsd("base") === 0.002, "and only ever lowers it");
  let threw = null;
  try { resolveSpend(h, true); resolveSpend(h, false); } catch (e) { threw = e; }
  ok(!threw && walletDailySpentUsd("base") === 0.002, "resolving a chain-only handle is a no-op on the chain ledger (a settled buy still spent the money)");
  // The legacy positional `now` still works.
  const h2 = noteSpend("0x8888888888888888888888888888888888888888", 0.1, 1_000_000);
  ok(h2 && payerExposureUsd("0x8888888888888888888888888888888888888888", 1_000_000 + 60_000) === 0.1, "noteSpend(payer, usd, now) keeps its legacy positional form");
}

{
  // Rolling window: spend ages out after 24 h, not at midnight.
  __reset(); noEnv();
  const t0 = 5_000_000_000;
  noteSpend(null, 10, { chain: "solana", now: t0 });
  noteSpend(null, 10, { chain: "solana", now: t0 + 12 * 3600_000 });
  ok(walletDailySpentUsd("solana", t0 + 23 * 3600_000) === 20, "both spends stand 23 h later");
  // Reads prune what has aged out under the clock they are given, so the
  // refusal-then-allow pair runs BEFORE the later reads below.
  ok(maySpend(null, 5, { chain: "solana", walletDailyMaxUsd: 20, now: t0 + 23 * 3600_000 }).ok === false
     && maySpend(null, 5, { chain: "solana", walletDailyMaxUsd: 20, now: t0 + 25 * 3600_000 }).ok === true,
    "a refusal at hour 23 ($20 + $5 over a $20 ceiling) becomes an allow at hour 25 ($10 + $5) as the window rolls");
  ok(walletDailySpentUsd("solana", t0 + 24 * 3600_000 + 1) === 10, "the first ages out at 24 h; the second still counts");
  ok(walletDailySpentUsd("solana", t0 + 36 * 3600_000 + 1) === 0, "and the second at its own 24 h");
}

{
  // Env: default, per-chain override, off/0, malformed.
  __reset(); noEnv();
  ok(walletDailyCeilingUsd("base") === __config.DEFAULT_WALLET_DAILY_MAX_USD, "no env: the default ceiling");
  process.env.SOR_WALLET_DAILY_MAX_USD = "3";
  ok(walletDailyCeilingUsd("base") === 3 && walletDailyCeilingUsd("tempo") === 3, "SOR_WALLET_DAILY_MAX_USD sets every chain");
  process.env.SOR_WALLET_DAILY_MAX_USD_SOLANA = "0.5";
  ok(walletDailyCeilingUsd("solana") === 0.5 && walletDailyCeilingUsd("base") === 3, "SOR_WALLET_DAILY_MAX_USD_<CHAIN> overrides one chain only");
  noteSpend(null, 0.5, { chain: "solana" });
  ok(maySpend(null, 0.001, { chain: "solana" }).ok === false && maySpend(null, 0.001, { chain: "base" }).ok === true,
    "the override is what the check reads (solana paused at $0.50, base still open at $3)");
  process.env.SOR_WALLET_DAILY_MAX_USD_SOLANA = "off";
  ok(walletDailyCeilingUsd("solana") === null && maySpend(null, 999, { chain: "solana" }).ok === true, "`off` disables the ceiling for that chain");
  process.env.SOR_WALLET_DAILY_MAX_USD_SOLANA = "0";
  ok(walletDailyCeilingUsd("solana") === null, "`0` disables it too");
  process.env.SOR_WALLET_DAILY_MAX_USD_SOLANA = "lots";
  ok(walletDailyCeilingUsd("solana") === 3, "a malformed per-chain value falls back to the global setting, never to disabled");
  delete process.env.SOR_WALLET_DAILY_MAX_USD_SOLANA;
  process.env.SOR_WALLET_DAILY_MAX_USD = "banana";
  ok(walletDailyCeilingUsd("base") === __config.DEFAULT_WALLET_DAILY_MAX_USD, "a malformed global value falls back to the DEFAULT, never to disabled");
  process.env.SOR_WALLET_DAILY_MAX_USD = "off";
  ok(walletDailyCeilingUsd("base") === null && maySpend(null, 1e6, { chain: "base" }).ok === true, "`off` globally disables every chain's ceiling");
  noEnv();
}

{
  // Status: counts only, every known chain present, paused flag honest.
  __reset(); noEnv();
  noteSpend("0x9999999999999999999999999999999999999999", 2, { chain: "tempo" });
  noteSpend(null, 1, { chain: "tempo" });
  const st = walletDailyStatus();
  ok(WALLET_CHAINS.every((c) => st.chains[c]), `every chain wallet has a row (${Object.keys(st.chains).join(", ")})`);
  ok(st.chains.tempo.spentUsd === 3 && st.chains.tempo.calls === 2 && st.chains.tempo.paused === false
     && st.chains.tempo.ceilingUsd === __config.DEFAULT_WALLET_DAILY_MAX_USD
     && st.chains.tempo.remainingUsd === __config.DEFAULT_WALLET_DAILY_MAX_USD - 3,
    `the tempo row carries spent/calls/ceiling/remaining (got ${JSON.stringify(st.chains.tempo)})`);
  ok(st.chains.base.spentUsd === 0 && st.chains.base.calls === 0, "an untouched chain reads zero");
  process.env.SOR_WALLET_DAILY_MAX_USD_TEMPO = "3";
  ok(walletDailyStatus().chains.tempo.paused === true, "paused reads true once spend reaches the ceiling");
  noEnv();
  ok(!/0x9999/.test(JSON.stringify(st)), "status never carries a payer");
}

{
  // The default ceiling must clear a single largest-tier call, or that tier is
  // dead on arrival for every buyer (the same coupling as the unsettled ceiling).
  const { EXEC_TIERS } = await import("../src/tools/route-execute.js");
  const biggest = Math.max(...EXEC_TIERS.map((t) => t.underlyingMaxUsd));
  ok(__config.DEFAULT_WALLET_DAILY_MAX_USD >= biggest,
    `the default daily wallet ceiling ($${__config.DEFAULT_WALLET_DAILY_MAX_USD}) covers the largest tier's underlying cap ($${biggest})`);
}

// --- attest's gas spend books against the Base wallet too -------------------
// It does not go through route-execute, so the kit books itself: worst case
// before the send, corrected to the estimate after, chain "base", refused 503
// when the wallet has hit its day.
{
  const src = await readFile(new URL("../src/tools/attest-kit.js", import.meta.url), "utf8");
  ok(/maySpend\(\s*null\s*,\s*MAX_GAS_USD\(\)\s*,\s*\{\s*chain:\s*"base"\s*\}\s*\)/.test(src), "attest checks the Base wallet's daily ceiling before signing");
  ok(/noteSpend\(\s*null\s*,\s*MAX_GAS_USD\(\)\s*,\s*\{\s*chain:\s*"base"\s*\}\s*\)/.test(src), "attest books the gas ceiling against the Base wallet");
  ok(/adjustSpend\(\s*handle\s*,\s*estimate\s*\)/.test(src), "attest corrects the booking down to the estimate");
  ok(src.indexOf("noteSpend(null, MAX_GAS_USD()") < src.indexOf("chain.attest(") && src.indexOf("adjustSpend(handle, estimate)") < src.indexOf("chain.attest("),
    "booked and corrected before the attestation is sent");
  ok(/Attestations are briefly paused[^\n]*,\s*503\)/.test(src), "a ceiling refusal there is a 503 (a >= 400 cancels the buyer's settlement)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
