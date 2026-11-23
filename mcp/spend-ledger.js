// Daily and monthly spending caps that hold across restarts.
//
// AGENT402_MAX_USD_PER_DAY and AGENT402_MAX_USD_PER_MONTH (unset or "off" = no
// cap) bound what this package spends per UTC day and per UTC calendar month,
// counted in a small file (spend.json, mode 0600) in the package's config
// folder (./config-dir.js), so a restart, or a second copy of the server on
// the same machine, reads the same totals. Only spend that was confirmed
// (settled, debited, or taken before the call ran) is written; a payment whose
// outcome is unknown is held against the caps in the process that sent it.
// The file is written only while one of these caps is set.
//
// Amounts are kept as whole micro-dollars, so repeated small calls never
// drift. A file that exists but cannot be read refuses paid calls with its
// path named, rather than starting the count again from zero.
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureConfigDir } from "./config-dir.js";

const MICRO = 1_000_000;
const LOCK_WAIT_MS = 1_000;
const LOCK_STALE_MS = 10_000;

export const DAY_CAP_ENV = "AGENT402_MAX_USD_PER_DAY";
export const MONTH_CAP_ENV = "AGENT402_MAX_USD_PER_MONTH";

/** A cap from the environment: Infinity when unset, empty or "off". A value
 *  that is not a non-negative USD amount is named on `warn` and read as 0
 *  (nothing is spent until it is fixed), since reading a typo as no cap
 *  would remove the limit the user meant to set. */
export function capOf(env, name, warn = () => {}) {
  if (!Object.prototype.hasOwnProperty.call(env, name)) return Infinity;
  const raw = String(env[name]).trim().toLowerCase();
  if (raw === "" || raw === "off") return Infinity;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  warn(`${name} is not a USD amount or "off"; no paid call is made until it is fixed`);
  return 0;
}

export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
export const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);
/** The next UTC midnight after `ms`. */
export function nextDayStart(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }
/** The first instant of the next UTC month after `ms`. */
export function nextMonthStart(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }

const usd = (micro) => Number((micro / MICRO).toFixed(6));
const money = (n) => `$${Number(n).toFixed(4)}`;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class SpendLedger {
  /** @param {{file: string, dayCap?: number, monthCap?: number, now?: () => number}} o */
  constructor({ file, dayCap = Infinity, monthCap = Infinity, now = () => Date.now() }) {
    this.file = file;
    this.dayCap = dayCap;
    this.monthCap = monthCap;
    this.now = now;
  }
  get enabled() { return Number.isFinite(this.dayCap) || Number.isFinite(this.monthCap); }

  /** The file's document; `{}` when it does not exist; throws when it exists but cannot be read. */
  _read() {
    let text;
    try { text = readFileSync(this.file, "utf8"); } catch (e) { if (e?.code === "ENOENT") return {}; throw this._unreadable(); }
    try {
      const doc = JSON.parse(text);
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("shape");
      return doc;
    } catch { throw this._unreadable(); }
  }
  _unreadable() { return new Error(`the spend ledger at ${this.file} cannot be read, so the daily and monthly caps cannot be checked; fix or remove that file`); }

  /** Spent today and this month (UTC), in micro-dollars. */
  _totals(ms = this.now()) {
    const doc = this._read();
    const d = Number(doc.days?.[dayKey(ms)]) || 0;
    const m = Number(doc.months?.[monthKey(ms)]) || 0;
    return { dayMicro: Math.max(0, d), monthMicro: Math.max(0, m) };
  }

  /** Where each cap stands now. */
  status(ms = this.now()) {
    const t = this._totals(ms);
    const one = (cap, spentMicro, resetsAt, env) => Number.isFinite(cap)
      ? { capUsd: cap, spentUsd: usd(spentMicro), leftUsd: Math.max(0, usd(Math.round(cap * MICRO) - spentMicro)), resetsAt: new Date(resetsAt).toISOString(), setting: env }
      : null;
    return {
      day: one(this.dayCap, t.dayMicro, nextDayStart(ms), DAY_CAP_ENV),
      month: one(this.monthCap, t.monthMicro, nextMonthStart(ms), MONTH_CAP_ENV),
    };
  }

  /** The most that may still be spent under both caps (Infinity with none set). */
  leftUsd(ms = this.now()) {
    if (!this.enabled) return Infinity;
    const s = this.status(ms);
    return Math.min(s.day ? s.day.leftUsd : Infinity, s.month ? s.month.leftUsd : Infinity);
  }

  /** The refusal text when `priceUsd` (plus `otherUsd` already committed in
   *  this process) does not fit under a cap, else null. */
  refusal(priceUsd, slug, { otherUsd = 0, ms = this.now() } = {}) {
    if (!this.enabled) return null;
    let s;
    try { s = this.status(ms); } catch (e) { return `Refused without paying: ${e.message}.`; }
    for (const [cap, period] of [[s.day, "today"], [s.month, "this month"]]) {
      if (!cap) continue;
      const left = Math.max(0, cap.leftUsd - otherUsd);
      if (priceUsd > left + 1e-9) {
        const which = period === "today" ? "daily" : "monthly";
        return `Refused without paying: "${slug}" costs $${priceUsd}, and the ${which} spending cap (${cap.setting}, $${cap.capUsd}) has ${money(left)} left ${period} (${money(cap.spentUsd)} spent${otherUsd ? `, ${money(otherUsd)} committed to calls in flight or awaiting an outcome` : ""}). It resets at ${cap.resetsAt} (UTC). Raise ${cap.setting}, or set it to off, on this MCP server to continue sooner.`;
      }
    }
    return null;
  }

  /** One line for a cap that refused at signing, or "" with no cap set. */
  summary(ms = this.now()) {
    if (!this.enabled) return "";
    let s;
    try { s = this.status(ms); } catch (e) { return ` ${e.message}.`; }
    const parts = [];
    if (s.day) parts.push(`${DAY_CAP_ENV} $${s.day.capUsd}: ${money(s.day.leftUsd)} left today, resets ${s.day.resetsAt}`);
    if (s.month) parts.push(`${MONTH_CAP_ENV} $${s.month.capUsd}: ${money(s.month.leftUsd)} left this month, resets ${s.month.resetsAt}`);
    return ` (${parts.join("; ")})`;
  }

  /** Add confirmed spend. No-op with no cap set or a non-positive amount. */
  record(amountUsd, ms = this.now()) {
    if (!this.enabled || !(amountUsd > 0)) return;
    const add = Math.round(amountUsd * MICRO);
    ensureConfigDir(dirname(this.file));
    const unlock = this._lock();
    try {
      // An unreadable file is left as it is: the caps keep refusing until it
      // is fixed or removed, and nothing is written over it.
      let doc;
      try { doc = this._read(); } catch { return; }
      const target = this.file;
      const d = dayKey(ms), m = monthKey(ms);
      const days = {}, months = {};
      // Only the current and the previous period are kept.
      const prevDay = dayKey(ms - 86_400_000), prevMonth = monthKey(Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), 0));
      for (const k of [prevDay, d]) if (Number(doc.days?.[k]) > 0) days[k] = Math.round(Number(doc.days[k]));
      for (const k of [prevMonth, m]) if (Number(doc.months?.[k]) > 0) months[k] = Math.round(Number(doc.months[k]));
      days[d] = (days[d] || 0) + add;
      months[m] = (months[m] || 0) + add;
      const out = JSON.stringify({ version: 1, unit: "micro-USD", days, months }) + "\n";
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, out, { mode: 0o600 });
      if (process.platform !== "win32") { try { chmodSync(tmp, 0o600); } catch { /* umask applied */ } }
      renameSync(tmp, target);
    } finally { unlock(); }
  }

  /** A short exclusive lock beside the file (two servers on one machine). */
  _lock() {
    const lock = `${this.file}.lock`;
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { closeSync(openSync(lock, "wx", 0o600)); return () => { try { unlinkSync(lock); } catch { /* gone */ } }; }
      catch (e) {
        if (e?.code !== "EEXIST") return () => {};
        try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; } } catch { continue; }
        if (Date.now() > until) return () => {};
        sleepSync(10);
      }
    }
  }
}

/** The ledger for this process's environment. */
export function ledgerFromEnv({ env = process.env, dir, warn = () => {} } = {}) {
  return new SpendLedger({ file: join(dir, "spend.json"), dayCap: capOf(env, DAY_CAP_ENV, warn), monthCap: capOf(env, MONTH_CAP_ENV, warn) });
}
