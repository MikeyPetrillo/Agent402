// Funding runway: an early word for the spending and fee wallets, read from
// the balance readings the low-water alarms already take.
//
// Every low-water alarm (upstreamBuyer, upstreamBuyerEvm, upstreamBuyerAvm,
// upstreamBuyerSvm, upstreamBuyerTempo, subscriptionFeePayer,
// stellarFacilitator) fires once a balance is already under its line. This
// module keeps a short trail of those same readings, fits the spend per day
// over a trailing window, and says "low-soon" when the projected balance
// crosses the alarm line within FUNDING_RUNWAY_DAYS (default 3).
//
// A warning only. It never moves money, never tops anything up, never refuses
// or slows a buyer, and never changes the existing alarm's word. It makes no
// chain read of its own: a reader hands it the number it already has
// (noteFundingReading), at that reader's own cadence. The words ride the
// operator view of /api/gateway-status only (`fundingRunway`), with the
// figures; nothing here reaches a public surface.
//
// Words, per wallet and for the whole:
//   ok        the trail is flat or rising, or the line is further off than N days
//   low-soon  the fitted spend reaches the line within N days
//   low       the latest reading is already under the line (the alarm's case)
//   unknown   too few readings, or too short a span, to fit a spend
// "unknown" is neither healthy nor an alarm. The whole reads the worst word
// across wallets in the order low, low-soon, unknown, ok.
//
// The trail is kept in the state database when one is configured (one small
// document, `funding-runway`), so a deploy does not empty it; in process
// memory otherwise.
//
// A wallet nobody reads any more (a chain turned off, a key removed) leaves
// the report once its newest reading is older than the window: it is not
// reported, not loaded from the stored document, and deleted from that
// document by the next write. Its "unknown" never holds the whole word.

export const RUNWAY_WINDOW_MS = 24 * 3600_000; // the trailing window a spend is fitted over
export const RUNWAY_SAMPLE_MS = 30 * 60_000; // at most one kept reading per wallet per this
export const RUNWAY_MIN_READINGS = 4;
export const RUNWAY_MIN_SPAN_MS = 6 * 3600_000;
const STORE_MS = 2_000;
const MAX_WALLETS = 64;
const DAY_MS = 24 * 3600_000;

/** FUNDING_RUNWAY_DAYS: how many days ahead the early word looks (default 3). */
export function runwayDays(env = process.env) {
  const raw = String(env.FUNDING_RUNWAY_DAYS ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n > 0 ? n : 3;
}

/**
 * The runway of one wallet from its readings. Pure.
 * @param {Array<[number, number]>} samples [time ms, balance] pairs, any order
 * @param {number} line the alarm line, in the same unit as the balances
 * @returns {{ status: string, readings: number, spanHours?: number, spendPerDay?: number, daysLeft?: number|null }}
 */
export function projectRunway(samples, line, {
  now = Date.now(), days = runwayDays(), windowMs = RUNWAY_WINDOW_MS,
  minReadings = RUNWAY_MIN_READINGS, minSpanMs = RUNWAY_MIN_SPAN_MS,
} = {}) {
  const pts = (Array.isArray(samples) ? samples : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] <= now && p[0] >= now - windowMs)
    .sort((a, b) => a[0] - b[0]);
  const readings = pts.length;
  if (!Number.isFinite(line) || readings === 0) return { status: "unknown", readings };
  const latest = pts[readings - 1][1];
  if (latest < line) return { status: "low", readings };
  const span = pts[readings - 1][0] - pts[0][0];
  if (readings < minReadings || span < minSpanMs) return { status: "unknown", readings, spanHours: round(span / 3600_000, 1) };
  // Least squares over the window: balance per millisecond.
  const mt = pts.reduce((s, p) => s + p[0], 0) / readings;
  const mv = pts.reduce((s, p) => s + p[1], 0) / readings;
  let num = 0, den = 0;
  for (const [t, v] of pts) { num += (t - mt) * (v - mv); den += (t - mt) ** 2; }
  const slope = den > 0 ? num / den : 0;
  const spendPerDay = slope < 0 ? -slope * DAY_MS : 0;
  const base = { readings, spanHours: round(span / 3600_000, 1), spendPerDay: round(spendPerDay, 4) };
  if (spendPerDay <= 0) return { status: "ok", ...base, daysLeft: null };
  const daysLeft = (latest - line) / spendPerDay;
  return { status: daysLeft <= days ? "low-soon" : "ok", ...base, daysLeft: round(daysLeft, 1) };
}
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

const ORDER = ["low", "low-soon", "unknown", "ok"];
/** The worst word across wallets ("off" with none). */
export function worstRunwayWord(words) {
  const list = [...words];
  if (!list.length) return "off";
  for (const w of ORDER) if (list.includes(w)) return w;
  return "unknown";
}

// key -> { line, unit, samples: [[t, v], ...] }
let trail = new Map();
let loaded = null; // the one load from the store, in flight or done
let saveChain = Promise.resolve();
let docRef = null;

async function runwayDoc() {
  if (!docRef) {
    const { createJsonDocument } = await import("./json-document.js");
    docRef = createJsonDocument({ name: "funding-runway", file: null, log: () => {}, importFromFile: false });
  }
  return docRef;
}
async function bounded(p) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), STORE_MS); timer.unref?.(); });
  try { return await Promise.race([p, deadline]); } catch { return undefined; } finally { clearTimeout(timer); }
}
function shapeEntry(e) {
  if (!e || typeof e !== "object") return null;
  const samples = (Array.isArray(e.samples) ? e.samples : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return { line: Number.isFinite(e.line) ? e.line : null, unit: typeof e.unit === "string" ? e.unit.slice(0, 12) : "USD", samples };
}
function mergeSamples(a, b, now) {
  const byT = new Map();
  for (const p of [...a, ...b]) byT.set(p[0], p);
  return [...byT.values()].filter((p) => p[0] >= now - RUNWAY_WINDOW_MS).sort((x, y) => x[0] - y[0]);
}
// Whether a wallet's newest reading is older than the window at `now`.
const isStale = (samples, now) => !samples.some((p) => p[0] >= now - RUNWAY_WINDOW_MS);
function ensureLoaded(now) {
  if (loaded) return loaded;
  loaded = (async () => {
    const d = await runwayDoc();
    if (d.backend === "memory") return;
    const r = await bounded(d.read({ quiet: true }));
    const wallets = r?.ok && r.body && typeof r.body === "object" ? r.body.wallets : null;
    if (!wallets || typeof wallets !== "object") return;
    let stale = false;
    for (const [k, raw] of Object.entries(wallets)) {
      const e = shapeEntry(raw);
      if (!e) continue;
      const mine = trail.get(k);
      const samples = mergeSamples(e.samples, mine?.samples || [], now);
      if (!samples.length) { stale = true; continue; } // no reading inside the window: not loaded
      if (!mine && trail.size >= MAX_WALLETS) continue;
      trail.set(k, { line: mine?.line ?? e.line, unit: mine?.unit ?? e.unit, samples });
    }
    if (stale) queueSave(null, null, now);
  })().catch(() => {});
  return loaded;
}
function queueSave(key, entry, now) {
  const run = async () => {
    const d = await runwayDoc();
    if (d.backend === "memory") return;
    await bounded(d.update((b) => {
      const wallets = b && typeof b === "object" && b.wallets && typeof b.wallets === "object" ? { ...b.wallets } : {};
      if (key != null) {
        const prev = shapeEntry(wallets[key]);
        wallets[key] = { line: entry.line, unit: entry.unit, samples: mergeSamples(prev?.samples || [], entry.samples, now) };
      }
      // A wallet with no reading inside the window leaves the document.
      for (const k of Object.keys(wallets)) if (isStale(shapeEntry(wallets[k])?.samples || [], now)) delete wallets[k];
      const keys = Object.keys(wallets);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_WALLETS))) delete wallets[k];
      return { v: 1, wallets };
    }, { fallback: null }));
  };
  const p = saveChain.then(run, run);
  saveChain = p.catch(() => {});
  return p;
}

/**
 * Record one balance reading a low-water reader already took. Never throws and
 * never waits on the store: the reader's answer is not held by it. A reading
 * inside RUNWAY_SAMPLE_MS of the wallet's last kept one is dropped, so a
 * reader that runs on every request keeps the trail the same size.
 * @param {string} key the wallet ("base", "evm:polygon", "solana", ...)
 * @param {number} balance in `unit`
 * @param {number} line the alarm line the reader compared it with
 */
export function noteFundingReading(key, balance, line, { unit = "USD", now = Date.now() } = {}) {
  try {
    if (typeof key !== "string" || !key || !Number.isFinite(balance)) return;
    ensureLoaded(now);
    const cur = trail.get(key) || { line: null, unit, samples: [] };
    if (!trail.has(key) && trail.size >= MAX_WALLETS) {
      for (const [k, e] of trail) if (isStale(e.samples, now)) trail.delete(k);
      if (trail.size >= MAX_WALLETS) return;
    }
    cur.line = Number.isFinite(line) ? line : cur.line;
    cur.unit = unit;
    const last = cur.samples[cur.samples.length - 1];
    if (last && now - last[0] < RUNWAY_SAMPLE_MS) { trail.set(key, cur); return; }
    cur.samples = mergeSamples(cur.samples, [[now, balance]], now);
    trail.set(key, cur);
    queueSave(key, { line: cur.line, unit: cur.unit, samples: [[now, balance]] }, now);
  } catch { /* a warning never breaks the reader */ }
}

/** The operator view: one word and each wallet's runway with its figures. */
export async function fundingRunwayStatus({ now = Date.now(), days = runwayDays() } = {}) {
  await bounded(ensureLoaded(now));
  const wallets = {};
  for (const [k, e] of trail) {
    if (isStale(e.samples, now)) { trail.delete(k); continue; } // no longer read: off the report
    wallets[k] = { ...projectRunway(e.samples, e.line, { now, days }), unit: e.unit };
  }
  return { status: worstRunwayWord(Object.values(wallets).map((w) => w.status)), days, warningOnly: true, wallets };
}

/** Resolves once every queued store write has ended. */
export function flushFundingRunway() { return saveChain; }
export function __resetFundingRunwayForTest({ doc = null } = {}) {
  trail = new Map(); loaded = null; saveChain = Promise.resolve(); docRef = doc;
}
