// Paid calls whose handler ran past a bound, for the serving-health alarm.
//
// The stall alarm (src/loop-lag.js) sees a frozen event loop; it cannot see a
// paid call whose handler waited a long time on an upstream while the loop
// stayed responsive. That call still keeps a buyer waiting (and a client with
// a short timeout leaves before the answer). This keeps a bounded list of the
// recent ones, fed by the paid-phase timer (src/paid-phase-timing.js) when a
// paid call is recorded, and serving health degrades with reason "slow-paid"
// while one happened in the last hour.
//
// The bound is ALERT_SLOW_PAID_MS (default 20000, "off" disables). A route
// declared slow in src/slow-routes.js is sold as one that runs long, so the
// shared bound does not apply to it; its own run budget does.
//
// A row holds the slug, the handler ms, the time, the status, whether a stall
// overlapped the handler and whether the call is our own traffic. Never a
// payer, an input, an amount or an address. In memory, per replica.
import { asyncProfileOf } from "./slow-routes.js";
import { stallOverlapping } from "./loop-lag.js";

const DEFAULT_MS = 20_000;
const RING = 50;
const ring = []; // newest last

/** ALERT_SLOW_PAID_MS: the handler bound in ms; 0 when switched off. */
export function slowPaidMsFromEnv(raw = process.env.ALERT_SLOW_PAID_MS) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "0") return 0;
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : DEFAULT_MS;
}

/** A slug as it may appear on an operator read or an issue: safe characters only. */
export function safeSlug(slug) {
  return String(slug ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
}

/**
 * The handler bound that applies to `slug`: its run budget when the route is
 * declared slow, the larger of the shared bound and its own ceiling when it
 * can run as a job, the shared bound otherwise; 0 when the alarm is off.
 */
// SOR_EXTERNAL_DEADLINE_MS's default in src/tools/route-execute.js.
const ASYNC_CAPABLE_BOUND_MS = 240_000;

export function slowPaidBoundMs(slug, sharedMs = slowPaidMsFromEnv()) {
  if (!(sharedMs > 0)) return 0;
  let profile = null;
  try { profile = asyncProfileOf({ slug }); } catch { profile = null; }
  if (profile?.slow && profile.maxSeconds > 0) return profile.maxSeconds * 1000;
  // A route that can run as a job but is not declared slow (the router tiers
  // wait on outside sellers; the image tiers on a model) is held to its own
  // ceiling when it has one, else to the router's outside-seller deadline.
  if (profile) return Math.max(sharedMs, profile.maxSeconds > 0 ? profile.maxSeconds * 1000 : ASYNC_CAPABLE_BOUND_MS);
  return sharedMs;
}

/**
 * Note one recorded paid call. `handlerMs` is the handler's own time (null
 * when the handler had not ended when the call was recorded, in which case
 * `elapsedMs` is how long it had run). `endEpochMs` is the wall time of the
 * handler's end (or of the record). Returns the stored row, or null.
 */
export function noteSlowPaidCall({ slug, handlerMs = null, elapsedMs = null, endEpochMs = Date.now(), status = null, synthetic = false } = {}, sharedMs = slowPaidMsFromEnv()) {
  const s = safeSlug(slug);
  if (!s) return null;
  const unfinished = handlerMs == null;
  const ms = Math.round(Number(unfinished ? elapsedMs : handlerMs));
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const bound = slowPaidBoundMs(s, sharedMs);
  if (!(bound > 0) || ms < bound) return null;
  let stalled = false;
  try { stalled = stallOverlapping(endEpochMs - ms, endEpochMs); } catch { stalled = false; }
  const row = { at: new Date(endEpochMs).toISOString(), atMs: endEpochMs, slug: s, ms, boundMs: bound, status: Number.isInteger(status) ? status : null, unfinished, stallOverlap: stalled, synthetic: synthetic === true };
  ring.push(row);
  while (ring.length > RING) ring.shift();
  return row;
}

/** The recent slow paid calls, newest first (copies, without the internal epoch field). */
export function recentSlowPaidCalls() {
  return ring.slice().reverse().map(({ atMs, ...r }) => ({ ...r }));
}

/**
 * The slow-paid verdict over the last `windowMs`: degraded when one or more
 * slow paid calls happened in it (with the alarm on), and the slugs named.
 */
export function slowPaidVerdict(windowMs = 3600_000, now = Date.now(), sharedMs = slowPaidMsFromEnv()) {
  const on = sharedMs > 0;
  const rows = on ? ring.filter((r) => now - r.atMs <= windowMs && r.atMs <= now) : [];
  const slugs = [];
  for (let i = rows.length - 1; i >= 0; i--) if (!slugs.includes(rows[i].slug)) slugs.push(rows[i].slug);
  return {
    degraded: rows.length > 0,
    thresholdMs: sharedMs,
    count: rows.length,
    worstMs: rows.reduce((m, r) => Math.max(m, r.ms), 0),
    withStall: rows.filter((r) => r.stallOverlap).length,
    slugs: slugs.slice(0, 10),
  };
}

/** Test hook. */
export function _resetSlowPaidCalls() { ring.length = 0; }
