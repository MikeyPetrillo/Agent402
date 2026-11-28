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
// The fit, in four rules:
//   1. A top-up starts a new stretch. A rise between two readings larger
//      than RUNWAY_TOPUP_SHARE of the room above the line is money added, not
//      negative spend: the trail restarts at that reading. The stretches
//      before and after share one fitted slope (each keeps its own level),
//      and the days left are counted from the real latest balance, so a
//      top-up neither hides the spend before it nor empties the trail.
//   2. The spend has to hold across the window. The spend per day is the
//      smallest of three least-squares fits: the whole window and each half
//      of it. One buy sits in one half only, so on its own it projects
//      nothing; a drain that continues shows in every part.
//   3. A drain still running is read from its own stretch. The trailing
//      readings that each sit lower than the one before are a running drain
//      once they number RUNWAY_MIN_READINGS and span RUNWAY_MIN_SPAN_MS (what
//      any fit needs). Its spend is the smallest of the same three fits over
//      that stretch alone, and the wallet's spend is the larger of this and
//      rule 2's, so a drain that began on a flat trail is read before it
//      fills half the window. One buy is one lower reading, never a stretch;
//      a drain that stops (a reading not lower than the last) is rule 2's again.
//   4. The word holds. A wallet turns low-soon when the days left reach
//      FUNDING_RUNWAY_DAYS and turns back to ok only once they are past
//      RUNWAY_CLEAR_FACTOR (1.5) times that, counted on the whole window's
//      fit alone (a quiet half or an ended stretch does not clear it), so a wallet sitting at
//      the mark does not change word with every reading. The held word is
//      kept with the trail.
//
// A warning only. It never moves money, never tops anything up, never refuses
// or slows a buyer, and never changes the existing alarm's word. It makes no
// chain read of its own: a reader hands it the number it already has
// (noteFundingReading), at that reader's own cadence. Wallets the server does
// not spend from are read by address in src/funding-watch.js and handed over
// the same way (`watch:<label>`). The words ride the
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
export const RUNWAY_CLEAR_FACTOR = 1.5; // low-soon is left only past this many times the look-ahead
export const RUNWAY_TOPUP_SHARE = 0.05; // a rise above this share of the room over the line is a top-up
const STORE_MS = 2_000;
const MAX_WALLETS = 64;
const DAY_MS = 24 * 3600_000;

/** FUNDING_RUNWAY_DAYS: how many days ahead the early word looks (default 3). */
export function runwayDays(env = process.env) {
  const raw = String(env.FUNDING_RUNWAY_DAYS ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n > 0 ? n : 3;
}

// Least squares over [time, balance, stretch] points: one slope (balance per
// millisecond) shared by the stretches, each around its own mean. Null when
// the points cannot carry a fit.
function slopeOf(pts) {
  const by = new Map();
  for (const p of pts) { const g = by.get(p[2]) || []; g.push(p); by.set(p[2], g); }
  let num = 0, den = 0;
  for (const g of by.values()) {
    const mt = g.reduce((s, p) => s + p[0], 0) / g.length;
    const mv = g.reduce((s, p) => s + p[1], 0) / g.length;
    for (const [t, v] of g) { num += (t - mt) * (v - mv); den += (t - mt) ** 2; }
  }
  return den > 0 ? num / den : null;
}

/**
 * The runway of one wallet from its readings. Pure: the word a wallet held
 * before comes in as `wasSoon`.
 * @param {Array<[number, number]>} samples [time ms, balance] pairs, any order
 * @param {number} line the alarm line, in the same unit as the balances
 * @param {object} [o]
 * @param {boolean} [o.wasSoon] the wallet read low-soon (or low) at its last fit: it clears only past the margin
 * @returns {{ status: string, readings: number, spanHours?: number, spendPerDay?: number, daysLeft?: number|null }}
 */
export function projectRunway(samples, line, {
  now = Date.now(), days = runwayDays(), windowMs = RUNWAY_WINDOW_MS,
  minReadings = RUNWAY_MIN_READINGS, minSpanMs = RUNWAY_MIN_SPAN_MS, wasSoon = false,
} = {}) {
  const pts = (Array.isArray(samples) ? samples : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] <= now && p[0] >= now - windowMs)
    .sort((a, b) => a[0] - b[0]);
  const readings = pts.length;
  if (!Number.isFinite(line) || readings === 0) return { status: "unknown", readings };
  const latest = pts[readings - 1][1];
  if (latest < line) return { status: "low", readings };
  const span = pts[readings - 1][0] - pts[0][0];
  const spanHours = round(span / 3600_000, 1);
  if (readings < minReadings || span < minSpanMs) return { status: "unknown", readings, spanHours };
  // Rule 1: a top-up starts a new stretch.
  let stretch = 0;
  const spent = pts.map((p, i) => {
    if (i > 0 && p[1] - pts[i - 1][1] > RUNWAY_TOPUP_SHARE * Math.max(0, pts[i - 1][1] - line)) stretch++;
    return [p[0], p[1], stretch];
  });
  // Rule 2: the spend every part of the window carries.
  const mid = pts[0][0] + span / 2;
  const slopes = [spent, spent.filter((p) => p[0] <= mid), spent.filter((p) => p[0] >= mid)].map(slopeOf);
  if (slopes.some((x) => x === null)) return { status: "unknown", readings, spanHours };
  // Rule 3: a drain still running is read from its own stretch, the trailing
  // readings each lower than the one before, by the same smallest-of-three fit.
  let k = readings - 1;
  while (k > 0 && pts[k][1] < pts[k - 1][1]) k--;
  const run = spent.slice(k);
  const runSpan = pts[readings - 1][0] - pts[k][0];
  let running = 0;
  if (run.length >= minReadings && runSpan >= minSpanMs) {
    const half = pts[k][0] + runSpan / 2;
    const fits = [run, run.filter((p) => p[0] <= half), run.filter((p) => p[0] >= half)].map(slopeOf);
    if (!fits.some((x) => x === null)) running = Math.min(...fits.map((x) => -x));
  }
  // Rule 4: a held word is judged on the whole window's fit, a new one on rules 2 and 3.
  const spendPerDay = Math.max(0, wasSoon ? -slopes[0] : Math.max(running, Math.min(...slopes.map((x) => -x)))) * DAY_MS;
  const base = { readings, spanHours, spendPerDay: round(spendPerDay, 4) };
  if (spendPerDay <= 0) return { status: "ok", ...base, daysLeft: null };
  const daysLeft = (latest - line) / spendPerDay;
  // In at the look-ahead, out only past the margin.
  const soon = daysLeft <= (wasSoon ? days * RUNWAY_CLEAR_FACTOR : days);
  return { status: soon ? "low-soon" : "ok", ...base, daysLeft: round(daysLeft, 1) };
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

// key -> { line, unit, soon, samples: [[t, v], ...] }; `soon` is the held word (rule 4)
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
  return { line: Number.isFinite(e.line) ? e.line : null, unit: typeof e.unit === "string" ? e.unit.slice(0, 12) : "USD", soon: e.soon === true, samples };
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
      trail.set(k, { line: mine?.line ?? e.line, unit: mine?.unit ?? e.unit, soon: mine?.soon ?? e.soon, samples });
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
        wallets[key] = { line: entry.line, unit: entry.unit, soon: entry.soon === true, samples: mergeSamples(prev?.samples || [], entry.samples, now) };
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

// One wallet's runway, with the held word read and kept: low-soon and low
// hold it, ok releases it, unknown leaves it as it was.
function judge(e, now, days) {
  const r = projectRunway(e.samples, e.line, { now, days, wasSoon: e.soon === true });
  if (r.status === "low-soon" || r.status === "low") e.soon = true;
  else if (r.status === "ok") e.soon = false;
  return r;
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
    const cur = trail.get(key) || { line: null, unit, soon: false, samples: [] };
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
    judge(cur, now, runwayDays());
    queueSave(key, { line: cur.line, unit: cur.unit, soon: cur.soon, samples: [[now, balance]] }, now);
  } catch { /* a warning never breaks the reader */ }
}

/** The operator view: one word and each wallet's runway with its figures. */
export async function fundingRunwayStatus({ now = Date.now(), days = runwayDays(), expect = [] } = {}) {
  await bounded(ensureLoaded(now));
  const wallets = {};
  for (const [k, e] of trail) {
    if (isStale(e.samples, now)) { trail.delete(k); continue; } // no longer read: off the report
    wallets[k] = { ...judge(e, now, days), line: e.line, unit: e.unit };
  }
  // A wallet a reader is set to read (`expect`: { key, line, unit }) and has
  // no reading of inside the window is on the report as unknown, not absent.
  for (const x of Array.isArray(expect) ? expect : []) {
    if (x && typeof x.key === "string" && !(x.key in wallets)) wallets[x.key] = { status: "unknown", readings: 0, line: Number.isFinite(x.line) ? x.line : null, unit: x.unit || "USD" };
  }
  return { status: worstRunwayWord(Object.values(wallets).map((w) => w.status)), days, clearDays: days * RUNWAY_CLEAR_FACTOR, warningOnly: true, wallets };
}

/** Resolves once every queued store write has ended. */
export function flushFundingRunway() { return saveChain; }
export function __resetFundingRunwayForTest({ doc = null } = {}) {
  trail = new Map(); loaded = null; saveChain = Promise.resolve(); docRef = doc;
}
