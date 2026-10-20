// Per-payment record of money this server SIGNED OUT.
//
// `daily_upstream_spend` in stats.js already totals outbound spend per day per
// source, and that stays - it is the right shape for "what did upstream cost
// last month". What it cannot answer is the question an incident asks: WHICH
// payments, to WHOM, on WHAT CHAIN, and did the thing we paid for arrive. It
// carries no destination, no chain, no transaction and no outcome, and it is
// bumped only on the delivered path - so a payment that signed and then failed
// to deliver, the single case a review most needs, recorded nothing at all.
//
// Append-only NDJSON on the volume. One line per SIGNED payment, written
// whether or not delivery then succeeded, because the money left the wallet
// either way. Each line carries a random `ref`, so the line is unique on its
// own and a retried write adds it once.
//
// With the state database on, the stream is the record and the line goes
// through a money journal first (createDeadLetter, journal "outbound"): the
// entry is written ahead of the insert and removed once the stream holds the
// line. With LEDGER_JOURNAL_REDIS=on the journal lives in Redis (it outlives
// the container), otherwise on local disk beside the file, and a replay on a
// timer lands whatever an insert did not. The insert is keyed on the line's
// content (logLines.appendOnce), so the write, the replay and the boot
// reconcile of the file add it once between them.
//
// Never written here: the credential, the signature, any private key, any
// request header. Recorded: when, chain, destination, amount, what asked for
// it, and how it ended.
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { logLines, stateDbEnabled, stateDbSchema, trackStoreReady, reconcileLogFile, markStoreFailed, markStoreLoaded } from "./state-db.js";
import { retryingLoad } from "./store-retry.js";
import { createDeadLetter, isRowError, everyMs } from "./ledger-mirror.js";
import { noteOutboundDestination } from "./outbound-destinations.js";

export const OUTBOUND_STREAM = "outbound-spend";

const FILE = (process.env.OUTBOUND_LEDGER_FILE || "/data/outbound-spend.ndjson").trim();
const DISABLED = /^(0|false|off|no)$/i.test((process.env.OUTBOUND_LEDGER ?? "").trim());
// Boot: lines the file holds past the stream (written while rolled back to a
// build that used the file alone) are appended to the stream.
// A reconcile that fails is retried with a backoff and the store reads
// unloaded until one lands (it is never reported loaded on a failure).
const STORE_NAME = "outbound-ledger reconcile";
const REPLAY_MS = Number(process.env.OUTBOUND_JOURNAL_REPLAY_MS) || 5_000;
// The money journal for lines the stream does not hold yet (database mode only).
let journal = null;
if (stateDbEnabled() && !DISABLED) {
  const load = retryingLoad(STORE_NAME, () => reconcileLogFile(OUTBOUND_STREAM, FILE), { onLoaded: () => markStoreLoaded(STORE_NAME) });
  trackStoreReady(load.ready().catch(() => { markStoreFailed(STORE_NAME); }), STORE_NAME);
  // Beside the file while its directory (the volume) exists, else in /tmp as
  // the other journals fall back: a journal never creates /data itself.
  const journalFile = `${existsSync(dirname(FILE)) ? FILE : join("/tmp", basename(FILE))}.pending.ndjson`;
  journal = createDeadLetter({ file: journalFile, name: "outbound", journalKey: `${stateDbSchema()}:outbound` });
  load.ready().then(() => replayOutboundJournal()).catch(() => {});
  everyMs(() => (journal.size() ? replayOutboundJournal() : null), REPLAY_MS);
}

/** Insert one journaled line, then drop its entry; on a failure the entry is left for the replay. Never rejects. */
async function landLine(rec, id) {
  try {
    // The write-ahead entry is in Redis (or on local disk) before the insert it guards.
    if (id != null) await journal.durable?.(id);
    await logLines.appendOnce(OUTBOUND_STREAM, rec);
    if (id != null) await journal.remove(id);
  } catch (e) {
    warnOnce(`write failed (${e?.code || e?.message}) - kept in the journal for replay; the payment itself is unaffected`);
    if (id != null) journal.release(id);
    else if (journal.add("outbound", rec) == null) console.error("[outbound-ledger] an outbound payment record could not be written to Postgres or the journal");
  }
}

// One replay at a time; a caller arriving during one shares it.
let replaying = null;
/**
 * Land every journaled line the stream lacks (claimed: one drainer across
 * containers; an entry is removed only once the stream holds its line).
 * Resolves how many entries it removed as landed.
 */
export function replayOutboundJournal() {
  if (!journal) return Promise.resolve(0);
  if (!replaying) {
    replaying = (async () => {
      let landed = 0;
      try {
        landed = await journal.drain(async (e) => {
          const rec = e.payload;
          if (!rec || typeof rec !== "object") return "drop";
          try { await logLines.appendOnce(OUTBOUND_STREAM, rec); return "landed"; }
          catch (err) {
            if (isRowError(err)) { console.error(`[outbound-ledger] a journaled outbound record was refused (${String(err?.message || err).slice(0, 120)})`); return "drop"; }
            throw err;
          }
        });
      } catch { /* the database is still away: the next tick retries */ }
      if (landed) console.log(`[outbound-ledger] landed ${landed} journaled record(s)`);
      return landed;
    })().finally(() => { replaying = null; });
  }
  return replaying;
}

let warnedAt = 0;
function warnOnce(msg) {
  const now = Date.now();
  if (now - warnedAt < 600_000) return;
  warnedAt = now;
  console.warn(`[outbound-ledger] ${msg}`);
}

/** Host only - a full URL can carry a query, and a query can carry a secret. */
function hostOf(u) {
  if (!u) return null;
  try { return new URL(String(u)).host; } catch { return null; }
}

/**
 * Record one signed outbound payment.
 *
 * `result` is the OUTCOME, not a status code:
 *   "delivered"   - paid and the seller answered
 *   "undelivered" - paid and the seller did not deliver (money gone, nothing back)
 *   "refused"     - paid retry refused AND the chain showed no debit (released)
 *   "unknown"     - we could not determine it
 *
 * Best-effort by construction: bookkeeping must never throw into a payment path
 * that has already committed money.
 */
export function recordOutbound({ chain, payTo, amountAtomic, asset, usd, slug, origin, result, tx } = {}) {
  if (DISABLED) return;
  // The new-destination watch (src/outbound-destinations.js) learns every
  // recipient money actually went to: delivered or not, the wallet paid. A
  // released credential ("refused": the chain showed no debit) paid nobody.
  // Off the payment path: handed over, never awaited.
  if (result !== "refused" && chain && payTo) {
    try { noteOutboundDestination({ chain, payTo, origin, slug }); } catch { /* bookkeeping never throws into a payment */ }
  }
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      chain: chain || null,
      payTo: payTo || null,
      amountAtomic: amountAtomic == null ? null : String(amountAtomic),
      asset: asset || null,
      usd: Number.isFinite(Number(usd)) ? Number(Number(usd).toFixed(6)) : null,
      slug: slug || null,
      origin: hostOf(origin) || origin || null,
      result: result || "unknown",
      tx: tx || null,
      ref: randomBytes(9).toString("hex"),
    }) + "\n";
    if (journal) {
      // One row per payment in the state database, journaled first (see the
      // note at the top); never awaited by, and never thrown into, the payment path.
      const rec = JSON.parse(line);
      landLine(rec, journal.add("outbound", rec, { pending: true }));
      // Write-through to the volume while it exists, so the nightly backup
      // keeps the record of money paid out; best effort, never the verdict.
      try { appendFileSync(FILE, line); } catch { /* no volume */ }
      return;
    }
    try { appendFileSync(FILE, line); }
    catch (e) {
      if (e?.code === "ENOENT") { mkdirSync(dirname(FILE), { recursive: true }); appendFileSync(FILE, line); }
      else throw e;
    }
  } catch (e) {
    warnOnce(`write failed (${e?.code || e?.message}) - the payment itself is unaffected`);
  }
}
