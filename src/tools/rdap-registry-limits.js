// Per-registry limits on RDAP lookups, shared by every tool that asks a
// registry's RDAP service (whois, domain-availability), so a registry sees
// one paced client however many tools ask it.
//
// Pacing: lookups to one RDAP host leave at least `paceMs` apart, queued in
// order; a lookup whose turn is further off than PACE_MAX_WAIT_MS, or past
// the run's ceiling, answers a retryable 503 instead of waiting (nothing was
// sent).
//
// Daily ceiling: at most `dailyMax` lookups to one RDAP host per UTC day
// (RDAP_REGISTRY_DAILY_MAX, default DEFAULT_REGISTRY_DAILY_MAX; `off` lifts
// it). A lookup past it answers a retryable 503 that names the time the day
// turns over; nothing is sent and, being a 503, nothing is charged. The count
// is this process's own.
import { capByCeiling } from "../run-ceiling.js";
import { CAP_NAMES } from "../upstream-cap-refusals.js";

export const PACE_MS = 100;
export const PACE_MAX_WAIT_MS = 3000;
export const DEFAULT_REGISTRY_DAILY_MAX = 1000;

/** The configured per-registry daily ceiling: a positive integer, or null
 *  when lifted (`off`). Anything else reads the default. */
export function registryDailyMax(env = process.env) {
  const raw = String(env.RDAP_REGISTRY_DAILY_MAX ?? "").trim().toLowerCase();
  if (raw === "off") return null;
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : DEFAULT_REGISTRY_DAILY_MAX;
}

const DAY_MS = 86_400_000;

/**
 * Build one set of per-host limits. `now` is the clock the daily count is
 * kept on (a test seam); pacing waits on the wall clock so a test clock never
 * stalls it. `dailyMax` is a number, null (no ceiling) or a function read on
 * each lookup (the default reads the environment).
 */
export function createRegistryLimits({ paceMs = PACE_MS, dailyMax = () => registryDailyMax(), now = () => Date.now() } = {}) {
  const nextSlot = new Map(); // host -> wall-clock ms its next lookup may leave
  const days = new Map(); // host -> { day, count }
  const maxNow = () => (typeof dailyMax === "function" ? dailyMax() : dailyMax);

  function admitDaily(host) {
    const max = maxNow();
    if (!max) return;
    const t = now();
    const day = Math.floor(t / DAY_MS);
    const cur = days.get(host);
    const count = cur && cur.day === day ? cur.count : 0;
    if (count >= max) {
      const retryAfter = Math.max(1, Math.ceil(((day + 1) * DAY_MS - t) / 1000));
      throw Object.assign(new Error(`Lookups to this registry's RDAP service (${host}) reached this service's daily limit, so this one was not sent; retry after 00:00 UTC (in ${retryAfter}s)`), { statusCode: 503, retryAfter, attribution: "ours", registryDailyLimit: true, capRefusal: CAP_NAMES.rdapRegistryDay });
    }
    days.set(host, { day, count: count + 1 });
    if (days.size > 500) for (const [h, v] of days) { if (v.day !== day) days.delete(h); }
  }

  async function pace(host) {
    if (!(paceMs > 0)) return;
    const t = Date.now();
    const slot = Math.max(t, nextSlot.get(host) || 0);
    const wait = slot - t;
    if (wait > PACE_MAX_WAIT_MS || (wait > 0 && capByCeiling(wait) < wait)) {
      // Our own pacing, not the registry's: nothing was sent.
      const retryAfter = Math.max(1, Math.ceil(wait / 1000));
      throw Object.assign(new Error(`Lookups to this registry's RDAP service (${host}) are paced, and this one would wait ${wait > PACE_MAX_WAIT_MS ? `more than ${PACE_MAX_WAIT_MS / 1000} s` : "past this call's time limit"}, so it was not sent; retry in ${retryAfter}s`), { statusCode: 503, retryAfter, attribution: "ours" });
    }
    nextSlot.set(host, slot + paceMs);
    if (nextSlot.size > 500) for (const [h, at] of nextSlot) { if (at < t) nextSlot.delete(h); }
    if (slot > t) await new Promise((r) => setTimeout(r, slot - t));
  }

  /** Take one lookup's place for `host`: the daily ceiling first, then the
   *  pacing queue. Throws a 503 (attribution ours) when the lookup is not to
   *  be sent. */
  async function admit(host) {
    admitDaily(host);
    try { await pace(host); } catch (err) {
      // Not sent: the place in the day's count is given back.
      const c = days.get(host);
      if (c && c.count > 0) c.count--;
      throw err;
    }
  }

  return { admit, _count: (host) => { const c = days.get(host); return c && c.day === Math.floor(now() / DAY_MS) ? c.count : 0; } };
}

/** The limits every production RDAP lookup shares. */
export const registryLimits = createRegistryLimits();
