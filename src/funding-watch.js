// Watched funding wallets: the funding runway (src/funding-runway.js) for
// wallets this server does not spend from.
//
// The runway reads only the balances the server's own low-water alarms take.
// The wallets the scheduled paid checks spend from are funded and read by CI
// alone: each run sees one balance, keeps no trail between runs, and so can
// say "under the line" but never "under the line in two days". The server
// already keeps the trail and the fit, so it reads those wallets too, by
// PUBLIC ADDRESS only. No key for a watched wallet is ever configured here,
// and nothing in this module can sign, pay or move anything.
//
// FUNDING_WATCH_ADDRESSES (present = on) is a comma list of
//   label:chain:address:lineUsd
//   label    1 to 24 of a-z, 0-9 and "-", unique; the wallet reads as
//            `watch:<label>` on the operator view
//   chain    base (USDC) or tempo (USDC.e)
//   address  the wallet's 0x address (40 hex digits)
//   lineUsd  the low-water line its own alarm uses, in USD (0 or more)
// At most FUNDING_WATCH_MAX entries. A malformed entry is ignored, and one
// line at boot names the variable and the entry's position, never its text.
//
// Cadence and cost. A read is started by a read of /api/gateway-status (the
// same trigger as every other low-water reader), never by a paid route, and
// is never awaited by the answer. Each wallet is read at most once per
// RUNWAY_SAMPLE_MS (the runway keeps one reading per wallet per that long, so
// a faster read would be thrown away), one read in flight per wallet, a failed
// read retried no sooner than FUNDING_WATCH_RETRY_MS, each bounded by
// FUNDING_WATCH_READ_MS. The read is the one balance call the server's own
// wallet on that chain already makes, through the same reader and RPC lane
// (baseUsdcBalanceOf in src/upstream-buyer-status.js, tempoUsdcBalanceOf in
// src/tempo-buyer.js).
//
// Operator view only (`fundingRunway.wallets` on /api/gateway-status). A
// watched wallet with no reading yet, or whose reads fail, reads "unknown"
// there; no other wallet's word changes. Nothing is public and nothing pages.
import { noteFundingReading, RUNWAY_SAMPLE_MS } from "./funding-runway.js";

export const FUNDING_WATCH_VAR = "FUNDING_WATCH_ADDRESSES";
export const FUNDING_WATCH_MAX = 8;
export const FUNDING_WATCH_RETRY_MS = 5 * 60_000;
export const FUNDING_WATCH_READ_MS = 15_000;

const READERS = {
  base: async (address) => (await import("./upstream-buyer-status.js")).baseUsdcBalanceOf(address),
  tempo: async (address) => (await import("./tempo-buyer.js")).tempoUsdcBalanceOf(address),
};
export const FUNDING_WATCH_CHAINS = Object.keys(READERS);

/**
 * The variable's entries. Pure.
 * @returns {{ wallets: Array<{ key: string, label: string, chain: string, address: string, line: number }>, ignored: number[] }}
 *          `ignored` holds the 1-based positions of the entries not taken
 */
export function parseFundingWatch(raw) {
  const wallets = [], ignored = [];
  const parts = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  parts.forEach((part, i) => {
    const f = part.split(":").map((s) => s.trim());
    const [label, chain, address, lineRaw] = f;
    const line = Number(lineRaw);
    const good = f.length === 4
      && /^[a-z0-9][a-z0-9-]{0,23}$/.test(label)
      && Object.hasOwn(READERS, chain)
      && /^0x[0-9a-fA-F]{40}$/.test(address)
      && lineRaw !== "" && Number.isFinite(line) && line >= 0
      && !wallets.some((w) => w.label === label)
      && wallets.length < FUNDING_WATCH_MAX;
    if (good) wallets.push({ key: `watch:${label}`, label, chain, address, line });
    else ignored.push(i + 1);
  });
  return { wallets, ignored };
}

/** The boot line for a variable with entries not taken, or null. Positions only. */
export function fundingWatchBootLine(raw) {
  const { wallets, ignored } = parseFundingWatch(raw);
  if (!ignored.length) return null;
  return `[funding-watch] ${FUNDING_WATCH_VAR}: ${ignored.length} of ${wallets.length + ignored.length} entries ignored (position ${ignored.join(", ")}); an entry is label:chain:address:lineUsd, chain one of ${FUNDING_WATCH_CHAINS.join(", ")}, at most ${FUNDING_WATCH_MAX} entries`;
}
{
  const line = fundingWatchBootLine(process.env[FUNDING_WATCH_VAR]);
  if (line) console.warn(line);
}

let parsed = { raw: null, wallets: [] };
function current(env = process.env) {
  const raw = String(env[FUNDING_WATCH_VAR] ?? "");
  if (parsed.raw !== raw) parsed = { raw, wallets: parseFundingWatch(raw).wallets };
  return parsed.wallets;
}

/** The watched wallets as the runway reports them (key, line, unit). No address. */
export function watchedFundingWallets(env = process.env) {
  return current(env).map((w) => ({ key: w.key, line: w.line, unit: "USD" }));
}

const nextAt = new Map(); // key -> the earliest time of its next read
const inFlight = new Map(); // key -> the read in flight

async function readOne(w, now, readers) {
  let timer, usd = null;
  try {
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), FUNDING_WATCH_READ_MS); timer.unref?.(); });
    usd = await Promise.race([Promise.resolve().then(() => readers[w.chain](w.address)), deadline]);
  } catch { usd = null; } finally { clearTimeout(timer); }
  if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) {
    noteFundingReading(w.key, usd, w.line, { now });
    nextAt.set(w.key, now + RUNWAY_SAMPLE_MS);
    return true;
  }
  nextAt.set(w.key, now + FUNDING_WATCH_RETRY_MS); // unread: the runway keeps what it had
  return false;
}

/**
 * Start the reads that are due. Never throws; the caller does not await it
 * (the returned promise is for tests). With the variable unset this is a
 * no-op that reads nothing.
 * @returns {Promise<number>} how many reads this call started
 */
export function noteWatchedFunding({ now = Date.now(), readers = READERS, env = process.env } = {}) {
  try {
    const started = [];
    for (const w of current(env)) {
      if (inFlight.has(w.key) || now < (nextAt.get(w.key) ?? 0)) continue;
      const p = readOne(w, now, readers).catch(() => false).finally(() => { if (inFlight.get(w.key) === p) inFlight.delete(w.key); });
      inFlight.set(w.key, p);
      started.push(p);
    }
    return Promise.all(started).then(() => started.length, () => started.length);
  } catch { return Promise.resolve(0); }
}

export function __resetFundingWatchForTest() { nextAt.clear(); inFlight.clear(); parsed = { raw: null, wallets: [] }; }
