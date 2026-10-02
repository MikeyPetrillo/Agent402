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
// either way.
//
// Never written here: the credential, the signature, any private key, any
// request header. Recorded: when, chain, destination, amount, what asked for
// it, and how it ended.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FILE = (process.env.OUTBOUND_LEDGER_FILE || "/data/outbound-spend.ndjson").trim();
const DISABLED = /^(0|false|off|no)$/i.test((process.env.OUTBOUND_LEDGER ?? "").trim());

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
    }) + "\n";
    try { appendFileSync(FILE, line); }
    catch (e) {
      if (e?.code === "ENOENT") { mkdirSync(dirname(FILE), { recursive: true }); appendFileSync(FILE, line); }
      else throw e;
    }
  } catch (e) {
    warnOnce(`write failed (${e?.code || e?.message}) - the payment itself is unaffected`);
  }
}

export const outboundLedgerFile = () => FILE;
