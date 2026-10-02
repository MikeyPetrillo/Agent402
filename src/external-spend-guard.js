import { readFileSync, writeFileSync, renameSync } from "node:fs";
// Bound what a single buyer can make us spend upstream before they have paid us.
//
// THE HOLE. @x402/express runs the handler FIRST and settles AFTER, and a <400
// response whose settlement then fails has its body discarded and returns 402.
// On the external routing path the handler PAYS A THIRD-PARTY SELLER from our
// spending wallet. So the sequence is: buyer's payment verifies, we pay the
// seller real USDC, our settlement fails, buyer is charged nothing. We are out
// the upstream spend with no revenue and no recourse.
//
// Verify-then-fail-to-settle is not hypothetical: it happens naturally when a
// payer's balance drops between the two (documented on Solana, where our own
// best buyer drained to $0 and its last four purchases "timed out"). Self-dealt
// it is an attack - the same wallet lists the seller and buys from it, so every
// drained dollar lands back in the attacker's pocket, bounded per call only by
// the tier cap. It scales with exactly the cap we want to raise.
//
// The existing guards bound WHAT we pay (canonical-USDC asset pin, tier cap
// re-checked against the live 402, a 50-settlement/3-payer reliability floor).
// None of them bound WHETHER WE GET PAID, because that is decided after the
// handler has already spent.
//
// So: a payer may carry only so much UNSETTLED upstream spend at once. Spend is
// recorded before the buy and resolved on the FINAL response - `res.on("finish")`
// with statusCode 200, i.e. after @x402/express has settled - which is the same
// rule the idempotency cache uses and for the same reason: a 200 is not revenue
// until settlement says so.
//
// Deliberately NOT a reputation system. It is a debt ceiling: pay for what you
// asked for and your exposure clears within seconds. It only ever bites a payer
// whose settlements are failing, which is the population it exists for.

/** Max unsettled upstream spend one payer may carry, in USD.
 *
 *  Sized at TWO top-tier calls (route-execute-pro covers an underlying $3.00),
 *  so a buyer can have a second call in flight while the first is still
 *  settling - agents pipeline, and refusing that would break honest traffic -
 *  while a wallet whose payments never settle is stopped after two rather than
 *  draining indefinitely.
 *
 *  MUST be re-sized whenever a higher execution tier is added, or the new tier
 *  is dead on arrival: a single call larger than this ceiling is refused for
 *  every payer, including the honest ones. That coupling is the reason the
 *  tier table points back at this constant. */
const DEFAULT_MAX_UNSETTLED_USD = Number(process.env.EXTERNAL_MAX_UNSETTLED_USD || 6.0);

/** How long an unresolved spend counts against a payer. A settlement that never
 *  reports (process restart, a response that never finished) must not bar a
 *  payer forever, but it must not clear so fast that a fast loop outruns it. */
const STALE_MS = Number(process.env.EXTERNAL_SPEND_STALE_MS || 10 * 60_000);

/** Payers exempt from the ceiling: our own canary and any operator-listed
 *  wallet. Comma-separated, lowercased for EVM. */
function exemptSet() {
  return new Set(
    String(process.env.EXTERNAL_SPEND_EXEMPT || "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

// payer -> [{ usd, at, settled }]
const ledger = new Map();
let seq = 0;

// ---------------------------------------------------------------------------
// PER-CHAIN-WALLET DAILY CEILING.
//
// The per-payer ceiling above is keyed on the buyer (address, else Tempo payer,
// else IP), so rotating wallets or IPs sidesteps it, and the only hard bound on
// what the spending wallets (Base, Solana, Algorand, Tempo) can lose in a day
// was their balance. This is the bound that does not care who the buyer is:
// every upstream spend is ALSO booked against the CHAIN it was paid from, over
// a rolling 24 h, settled or not - a settled buy is still money that left the
// wallet - and a spend that would take the chain past its ceiling is refused
// with its own reason (`wallet_daily_ceiling`) so the caller can tell the buyer
// this is a global pause, not their own limit. In memory only: a restart
// resets the day, the same as the per-payer guard, and the wallet balance
// alarms remain the outer backstop.
//
// `SOR_WALLET_DAILY_MAX_USD` is the default for every chain;
// `SOR_WALLET_DAILY_MAX_USD_<CHAIN>` (BASE, SOLANA, ALGORAND, TEMPO) overrides
// one; `0` or `off` disables the ceiling for that scope. A MALFORMED value is
// treated as unset - a per-chain typo falls through to the global setting, a
// global typo to the default - never as disabled (a typo must not select the
// unbounded behaviour - the fee-bid lesson).
const DEFAULT_WALLET_DAILY_MAX_USD = 25;
const WALLET_DAY_MS = 24 * 60 * 60_000;
export const WALLET_CHAINS = ["base", "solana", "algorand", "tempo"];

// chain -> [{ id, usd, at }]  (settled and unsettled alike; ages out at 24 h)
const chainLedger = new Map();

// --- persistence for the CHAIN ledger (2026-09-20) ---------------------------
//
// The per-payer ledger above stays in memory ON PURPOSE: it bounds UNSETTLED
// spend over a ten-minute window, so a restart losing it is correct behaviour.
//
// The chain ledger makes a TWENTY-FOUR HOUR claim, and a claim that resets on
// every restart is not a daily ceiling - it is a ceiling per restart. This
// service deploys several times a day and every deploy zeroed the day's spend,
// so the intended $25/chain bound could be exceeded by ordinary operations with
// no bug triggered and nothing on disk to show it afterwards.
//
// Write-behind on a short debounce so the signing path never waits on disk, and
// tmp+rename so a crash mid-write cannot leave a torn file. A load failure
// starts the day at zero spent and says so LOUDLY: refusing to boot would turn
// a corrupt file into an outage, but the permissive direction must never be
// silent.
const CHAIN_LEDGER_FILE = (process.env.WALLET_DAILY_LEDGER_FILE || "/data/wallet-daily-spend.json").trim();
let persistTimer = null;

function loadChainLedger() {
  try {
    const raw = JSON.parse(readFileSync(CHAIN_LEDGER_FILE, "utf8"));
    const now = Date.now();
    let restored = 0;
    for (const [chain, rows] of Object.entries(raw?.chains || {})) {
      // Re-filter against the window rather than trusting the file's own view
      // of time: a file written before a clock change must not extend the day.
      const fresh = (Array.isArray(rows) ? rows : []).filter(
        (r) => r && Number.isFinite(Number(r.usd)) && now - Number(r.at || 0) < WALLET_DAY_MS,
      );
      if (fresh.length) { chainLedger.set(chain, fresh); restored += fresh.length; }
    }
    if (restored) console.log(`[spend-guard] restored ${restored} in-window spend record(s) from ${CHAIN_LEDGER_FILE}`);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.warn(`[spend-guard] could not read ${CHAIN_LEDGER_FILE} (${e?.code || e?.message}); `
        + "THE DAY STARTS AT ZERO SPENT - the 24h ceiling is not enforced against earlier spend in this window");
    }
  }
}

function persistChainLedgerSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const chains = Object.fromEntries([...chainLedger.entries()]);
      const tmp = `${CHAIN_LEDGER_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify({ chains, at: Date.now() }));
      renameSync(tmp, CHAIN_LEDGER_FILE);
    } catch (e) {
      // Bookkeeping must never break a spend decision that already happened.
      console.warn(`[spend-guard] persist failed (${e?.code || e?.message}) - the in-memory ceiling still holds`);
    }
  }, 2000);
  persistTimer.unref?.();
}

loadChainLedger();

const chainKeyOf = (chain) => (typeof chain === "string" && chain.trim() ? chain.trim().toLowerCase() : null);

function parseCeiling(raw) {
  if (raw == null || String(raw).trim() === "") return undefined; // not set
  const s = String(raw).trim();
  if (/^off$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined; // malformed reads as unset, never as off
  return n === 0 ? null : n;
}

/** The daily ceiling for a chain in USD, or null when disabled. Read at call
 *  time so an operator can move it without a redeploy of this module's state. */
export function walletDailyCeilingUsd(chain) {
  const k = chainKeyOf(chain);
  const per = k ? parseCeiling(process.env[`SOR_WALLET_DAILY_MAX_USD_${k.toUpperCase()}`]) : undefined;
  if (per !== undefined) return per;
  const all = parseCeiling(process.env.SOR_WALLET_DAILY_MAX_USD);
  return all === undefined ? DEFAULT_WALLET_DAILY_MAX_USD : all;
}

function pruneChain(k, now) {
  const rows = (chainLedger.get(k) || []).filter((r) => now - r.at < WALLET_DAY_MS);
  if (rows.length) chainLedger.set(k, rows); else chainLedger.delete(k);
  return rows;
}

/** Upstream spend booked against a chain's wallet in the last 24 h (settled + unsettled). */
export function walletDailySpentUsd(chain, now = Date.now()) {
  const k = chainKeyOf(chain);
  if (!k) return 0;
  return pruneChain(k, now).reduce((s, r) => s + r.usd, 0);
}

const keyOf = (payer) => {
  if (typeof payer !== "string" || !payer.trim()) return null;
  // EVM addresses are case-insensitive; base58/Stellar/Algorand are NOT, and
  // folding them merges distinct payers (same rule as src/payer.js).
  const p = payer.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(p) ? p.toLowerCase() : p;
};

function prune(rows, now) {
  return rows.filter((r) => !r.settled && now - r.at < STALE_MS);
}

/** Current unsettled exposure for a payer, in USD. */
export function payerExposureUsd(payer, now = Date.now()) {
  const k = keyOf(payer);
  if (!k) return 0;
  const rows = prune(ledger.get(k) || [], now);
  if (rows.length) ledger.set(k, rows); else ledger.delete(k);
  return rows.reduce((s, r) => s + r.usd, 0);
}

/**
 * May this payer make us spend `usd` upstream right now?
 *
 * An UNKNOWN payer (free mode, a non-EIP-3009 rail we cannot attribute) is
 * allowed: refusing there would break every legitimate buyer on a rail whose
 * payer we cannot read, and the tier cap still bounds a single call. This is a
 * per-payer debt ceiling, not an identity requirement.
 */
export function maySpend(payer, usd, { maxUnsettledUsd = DEFAULT_MAX_UNSETTLED_USD, now = Date.now(), chain = null, walletDailyMaxUsd } = {}) {
  // The chain-wallet ceiling is checked FIRST and for every caller, attributable
  // payer or not: it bounds the wallet, not the buyer. `code` is the field a
  // caller branches on - the per-payer refusal below carries none.
  const ck = chainKeyOf(chain);
  if (ck) {
    const ceiling = walletDailyMaxUsd !== undefined ? walletDailyMaxUsd : walletDailyCeilingUsd(ck);
    if (ceiling != null) {
      const spent = walletDailySpentUsd(ck, now);
      const next = spent + (Number(usd) || 0);
      if (next > ceiling) {
        return {
          ok: false,
          code: "wallet_daily_ceiling",
          chain: ck,
          spentUsd: spent,
          ceilingUsd: ceiling,
          reason:
            `the ${ck} spending wallet has reached its daily ceiling ($${spent.toFixed(3)} of $${ceiling} in the last 24 h);` +
            ` external routing on ${ck} is paused for every buyer, not this wallet in particular, until earlier spend ages out of the window.`,
        };
      }
    }
  }
  const k = keyOf(payer);
  if (!k) return { ok: true, reason: "payer not attributable - bounded by the tier cap alone" };
  if (exemptSet().has(k.toLowerCase())) return { ok: true, reason: "exempt" };
  const exposure = payerExposureUsd(k, now);
  const next = exposure + (Number(usd) || 0);
  if (next > maxUnsettledUsd) {
    return {
      ok: false,
      exposure,
      reason:
        `this wallet already has $${exposure.toFixed(3)} of upstream spend from earlier calls whose payment has not settled` +
        ` (ceiling $${maxUnsettledUsd}). It clears as soon as those settle.`,
    };
  }
  return { ok: true, exposure };
}

/** Record an upstream spend as UNSETTLED against the payer, and against the
 *  chain wallet it is paid from when `chain` is given. Returns a handle to
 *  resolve later. The third argument is either a timestamp (legacy) or
 *  `{ now, chain }`. A spend with no attributable payer AND no chain records
 *  nothing (null); with a chain it still counts toward that wallet's day. */
export function noteSpend(payer, usd, opts = undefined) {
  const o = typeof opts === "number" ? { now: opts } : (opts && typeof opts === "object" ? opts : {});
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const k = keyOf(payer);
  const ck = chainKeyOf(o.chain);
  if (!k && !ck) return null;
  const id = ++seq;
  const amount = Number(usd) || 0;
  if (k) {
    const rows = prune(ledger.get(k) || [], now);
    rows.push({ id, usd: amount, at: now, settled: false });
    ledger.set(k, rows);
  }
  if (ck) {
    const rows = pruneChain(ck, now);
    rows.push({ id, usd: amount, at: now });
    chainLedger.set(ck, rows);
    persistChainLedgerSoon();
  }
  return { payer: k, id, chain: ck };
}

/**
 * Correct a recorded spend to what was ACTUALLY paid, once that is known.
 *
 * The authorize-and-book step runs BEFORE the seller quotes, so it has to book
 * the worst case the call could cost (the tier cap). Booking the seller's
 * DECLARED price instead would let one document set our own debt ceiling: since
 * 2026-08-29 a route's resolved price comes from the origin's own current
 * declaration, so a seller declaring $0.0001 while quoting $0.005 on the live
 * 402 would have each call count as a fiftieth of its real exposure. The per-
 * call spend is bounded either way (payExternal re-checks maxAtomic against the
 * accept it signs), but the CEILING is what stops a run of them.
 *
 * Only ever lowers: the booked figure is the cap, and nothing may exceed it.
 */
export function adjustSpend(handle, usd) {
  if (!handle || typeof handle !== "object") return;
  const actual = Number(usd);
  if (!Number.isFinite(actual) || actual < 0) return;
  const lower = (rows) => {
    const row = rows?.find((r) => r.id === handle.id);
    if (row && actual < row.usd) row.usd = actual;
  };
  if (handle.payer) lower(ledger.get(handle.payer));
  if (handle.chain) { lower(chainLedger.get(handle.chain)); persistChainLedgerSoon(); }
}

/**
 * Resolve a recorded spend once the FINAL response is known.
 *
 * `settled` must come from the post-settlement status (res.on("finish") with
 * statusCode === 200), never from the handler's own return: the handler
 * succeeding is precisely the state that precedes a settlement failure.
 */
export function resolveSpend(handle, settled) {
  if (!handle?.payer) return;
  const rows = ledger.get(handle.payer);
  if (!rows) return;
  const row = rows.find((r) => r.id === handle.id);
  if (!row) return;
  if (settled) {
    row.settled = true;
    const left = rows.filter((r) => !r.settled);
    if (left.length) ledger.set(handle.payer, left); else ledger.delete(handle.payer);
  }
  // NOT settled: the row stays as exposure until it ages out. That is the
  // whole point - an unpaid spend must keep counting against the payer.
}

/** Operator view: who currently owes us upstream spend. Counts only. */
export function exposureSnapshot(now = Date.now()) {
  const out = [];
  for (const [payer, rows] of ledger) {
    const live = prune(rows, now);
    if (!live.length) continue;
    out.push({ payer, unsettledUsd: Number(live.reduce((s, r) => s + r.usd, 0).toFixed(6)), calls: live.length });
  }
  return out.sort((a, b) => b.unsettledUsd - a.unsettledUsd);
}

/** Counts only: what each chain wallet has spent upstream in the last 24 h
 *  against its ceiling. Built for the status reporters (x402-buyer's
 *  `avmBuyerStatus` and friends could carry it); never a payer, never a key. */
export function walletDailyStatus(now = Date.now()) {
  const chains = {};
  for (const k of new Set([...WALLET_CHAINS, ...chainLedger.keys()])) {
    const rows = pruneChain(k, now);
    const spentUsd = Number(rows.reduce((s, r) => s + r.usd, 0).toFixed(6));
    const ceilingUsd = walletDailyCeilingUsd(k);
    chains[k] = {
      spentUsd, calls: rows.length, ceilingUsd,
      remainingUsd: ceilingUsd == null ? null : Number(Math.max(0, ceilingUsd - spentUsd).toFixed(6)),
      paused: ceilingUsd != null && spentUsd >= ceilingUsd,
    };
  }
  return { windowMs: WALLET_DAY_MS, chains };
}

/** Test-only. */
export function __reset() { ledger.clear(); chainLedger.clear(); seq = 0; }
export const __config = { DEFAULT_MAX_UNSETTLED_USD, STALE_MS, DEFAULT_WALLET_DAILY_MAX_USD, WALLET_DAY_MS };
