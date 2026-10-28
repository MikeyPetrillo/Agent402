#!/usr/bin/env node
// Did yesterday's record actually happen, and does it have data in it?
//
// Two classes of failure this exists for, both of which shipped for real on
// 2026-09-11 and neither of which any existing guard could see:
//
//   1. A COLUMN THAT IS PRESENT AND EMPTY. The routes table recorded 101,733
//      rows with price_usd null on every one, because the allowlist read a
//      field name the crawl row does not carry. The row count was perfect.
//      Nothing that checks "did it run" or "how many rows" can catch that.
//
//   2. A PUBLIC FIELD THAT SILENTLY STOPPED BEING POPULATED. /api/index served
//      network:null and discoveryPath:null for every seller for weeks, because
//      neither survived cache persistence. Found only when something finally
//      counted non-nulls instead of checking for HTTP 200.
//
// So this counts VALUES, never statuses. It reads `recorded` from the operator
// endpoint, which asks the BUCKET - not `status`, which is this process's
// memory and is wiped by every deploy. Reading the memory would file an
// outage every afternoon and be trained away as noise inside a week.
//
//   AGENT402_OPERATOR_TOKEN=... node scripts/dataset-health.mjs
//   --target https://agent402.tools   (default)
//   --max-age-hours 36                (a daily writer missing one day is late, two is broken)

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const TARGET = (arg("target", process.env.TARGET_URL || "https://agent402.tools")).replace(/\/+$/, "");
const MAX_AGE_H = Number(arg("max-age-hours", "36"));
const TOKEN = process.env.AGENT402_OPERATOR_TOKEN || "";

// Columns whose emptiness is a DEFECT rather than an honest absence. Each one
// is here because it was, or would have been, a silent hole: a buyer reading
// the table would have no way to tell it from real data. Columns that are
// legitimately sparse (a template URL, a crawl error) are deliberately absent
// from this list - asserting on those would produce a guard that cries daily
// and gets ignored, which is worse than no guard.
const MUST_BE_POPULATED = {
  sellers: ["origin", "routable", "router_dispatch_reason"],
  routes: ["origin", "route", "price_usd", "price_outlier", "networks"],
  settlement_base: ["pay_to", "calls_settled"],
};

// Columns we EXPECT to fill but do not assert on yet, with the fill at which
// each becomes worth promoting into MUST_BE_POPULATED above.
//
// This list is why the daily check exists rather than a reminder to look. A
// column at 0% is caught by the empty list; a column at 16% or 37% was
// invisible to every automated surface and needed someone to download the
// NDJSON and count - which is how "provenance on every price" survived as a
// claim while routes.price_source sat at 16% of rows. Measured 2026-09-11 on
// the first recorded day; the `at` figure is the point past which an empty
// value is more likely our defect than an honest absence about the ecosystem.
const WATCHED = [
  { table: "sellers", column: "primary_network", at: 0.9, saw: 0.37 },
  { table: "sellers", column: "discovery_path", at: 0.9, saw: 0.51 },
  { table: "routes", column: "price_source", at: 0.6, saw: 0.16 },
];

const fails = [];
const notes = [];
const promote = [];

async function getJson(path, { auth = false } = {}) {
  const res = await fetch(`${TARGET}${path}`, {
    headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

// --- 1. the public index still publishes values, not nulls ------------------
try {
  const idx = await getJson("/api/index?page=3");
  const sellers = (idx.sellers || []).filter((s) => s.origin !== "self");
  if (!sellers.length) {
    fails.push("/api/index returned no third-party sellers on page 3");
  } else {
    for (const field of ["network", "discoveryPath"]) {
      const n = sellers.filter((s) => s[field]).length;
      const pct = Math.round((100 * n) / sellers.length);
      notes.push(`/api/index ${field}: ${n}/${sellers.length} (${pct}%)`);
      // ZERO is the assertion, not a percentage floor. Some sellers genuinely
      // publish neither, so a threshold would flap; but zero across a whole
      // page is the exact signature of the persistence bug and cannot be
      // explained by the ecosystem.
      if (n === 0) fails.push(`/api/index publishes ${field} as null for EVERY sampled seller - the field stopped surviving persistence again (src/x402-index.js: persistedEntries / MANIFEST_PERSIST_KEYS)`);
    }
  }
} catch (e) {
  fails.push(`could not read /api/index: ${e.message}`);
}

// --- 2. the snapshot ran, recently, on its own ------------------------------
let newest = null;
try {
  if (!TOKEN) throw new Error("AGENT402_OPERATOR_TOKEN not set");
  const body = await getJson("/__operator/dataset.json", { auth: true });
  const rec = body.recorded || {};
  const mem = body.status || {};
  if (rec.configured === false) fails.push("dataset snapshot is not configured on prod (BACKUP_S3_* unset)");
  // An unreadable bucket is its own answer and must never be collapsed into
  // "no day recorded" - one is a credentials or network fault, the other is a
  // writer that stopped.
  else if (rec.error) fails.push(`could not read the recorded days from the bucket: ${rec.error}`);
  else if (!rec.newest) fails.push(`no day is recorded in the bucket for the last 3 days${mem.lastError ? ` - last in-process error: ${mem.lastError}` : ""}`);
  else {
    newest = rec.newest;
    const ageH = (Date.now() - Date.parse(newest.writtenAt)) / 3.6e6;
    notes.push(`newest recorded day: ${newest.day}, written ${newest.writtenAt} (${ageH.toFixed(1)}h ago); days present: ${rec.days.join(", ")}`);
    if (ageH > MAX_AGE_H) fails.push(`the newest recorded day was written ${ageH.toFixed(1)}h ago (over ${MAX_AGE_H}h) - the daily scheduler is not firing`);
    if (newest.partial) notes.push(`NOTE that day is PARTIAL: ${Object.keys(newest.partial).join(", ")}`);
  }
} catch (e) {
  fails.push(`could not read the snapshot status: ${e.message}`);
}

// --- 3. the recorded day has data IN it, not just rows ----------------------
if (newest) {
  const rows = newest.rows || {};
  for (const [table, cols] of Object.entries(MUST_BE_POPULATED)) {
    const n = rows[table];
    if (!Number.isFinite(n)) { fails.push(`the last snapshot recorded no ${table} table at all`); continue; }
    if (n === 0) { fails.push(`${table} recorded 0 rows`); continue; }
    notes.push(`${table}: ${n} rows`);
    const empty = (newest.emptyColumns || {})[table] || [];
    for (const c of cols) {
      if (empty.includes(c)) {
        fails.push(`${table}.${c} is EMPTY on every one of ${n} rows - present but null, which no row count can see (this is the 2026-09-11 price_usd failure)`);
      }
    }
  }
  // The watch list: report every day, and say plainly when one is ready to be
  // asserted. Promotion stays a human edit - the check names the candidate and
  // the number behind it, it does not quietly widen its own contract.
  const fill = newest.columnFill || {};
  for (const w of WATCHED) {
    const v = fill[w.table]?.[w.column];
    if (v === undefined || v === null) { notes.push(`watch ${w.table}.${w.column}: not in the manifest (new column, or the table did not record)`); continue; }
    const pct = Math.round(v * 100);
    const was = w.saw === null ? "new" : `was ${Math.round(w.saw * 100)}%`;
    notes.push(`watch ${w.table}.${w.column}: ${pct}% filled (${was}, promote at ${Math.round(w.at * 100)}%)`);
    if (v >= w.at) promote.push(`${w.table}.${w.column} is ${pct}% filled, at or past its ${Math.round(w.at * 100)}% bar - add it to MUST_BE_POPULATED in this script so an emptying is a failure rather than a note`);
  }

  const otherEmpty = Object.entries(newest.emptyColumns || {})
    .flatMap(([t, cs]) => cs.filter((c) => !(MUST_BE_POPULATED[t] || []).includes(c)).map((c) => `${t}.${c}`));
  if (otherEmpty.length) notes.push(`empty but not asserted (may be honest absences): ${otherEmpty.join(", ")}`);
}

console.log(notes.map((n) => `  ${n}`).join("\n"));
if (promote.length) {
  // Not a failure: nothing is broken, a column got good enough to guard.
  console.log(`\nREADY TO ASSERT (${promote.length}):`);
  for (const p of promote) console.log(`  - ${p}`);
}
if (fails.length) {
  console.log(`\nFAILED (${fails.length}):`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nOK: the record ran, is fresh, and its load-bearing columns have values in them.");
