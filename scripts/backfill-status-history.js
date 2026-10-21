// One-time (and safely repeatable) import of heartbeat history into the
// /status probe store.
//
// The heartbeat workflow has been probing production every 15 minutes since
// 2026-06-12, and GitHub has kept every run. Each run therefore holds an
// outside observer's verdict on whether production was serving at that moment.
// This reads those runs and posts them to /api/status/probe so the uptime
// history starts populated with real, publicly checkable observations rather
// than an empty chart.
//
// It is idempotent — the store's UNIQUE (source, component, ts) index means
// re-running imports only genuinely new runs — so it is safe to re-run to pick
// up whatever has happened since.
//
// WHAT COUNTS AS AN OBSERVATION (this is the whole correctness of the import)
//   NOT the run's overall conclusion. A heartbeat run can fail for reasons that
//   say nothing about production: sampling the failures on 2026-07-25 found the
//   issue-management step failing, an unrelated on-chain scan failing, and the
//   runner dying in "Set up job" — while production was serving fine throughout.
//   Importing run conclusions would have drawn roughly 17 outages that never
//   happened.
//
//   So each run is judged by its PROBE STEP alone. If the probe step succeeded,
//   production was up; if it failed, production was down; if it never ran (a
//   runner failure, a cancellation), there is no observation and the run is
//   skipped rather than guessed at.
//
//   GitHub does not expose which individual check inside that step failed, so
//   backfilled rows land on the "api" (overall availability) component only.
//   Per-component history begins when the heartbeat starts posting it live,
//   which is why /status shows "not yet measured" for a component instead of
//   back-projecting onto it.
//
// Usage (needs a GitHub token with actions:read and the operator token):
//   GH_TOKEN=… OP_TOKEN=… node scripts/backfill-status-history.js [--dry] [--limit N]
import "../src/tls-distrust-boot.js"; // refuse TLS chains through a distrusted intermediate CA
const REPO = process.env.GITHUB_REPOSITORY || "MikeyPetrillo/Agent402";
const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const WORKFLOW = process.env.BACKFILL_WORKFLOW || "heartbeat.yml";
const GH_TOKEN = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
const OP_TOKEN = (process.env.OP_TOKEN || process.env.AGENT402_OPERATOR_TOKEN || "").trim();

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes("--dry");
const LIMIT = Number(arg("--limit", "0")) || Infinity;
const BATCH = 500;

const die = (m) => { console.error("ABORT:", m); process.exit(1); };
if (!GH_TOKEN) die("GH_TOKEN not set (needs actions:read on the repo)");
if (!DRY && !OP_TOKEN) die("OP_TOKEN not set (the operator token that authorizes /api/status/probe)");

async function ghJson(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "agent402-status-backfill" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GitHub ${path} -> HTTP ${res.status}`);
  return res.json();
}

console.log(`Backfilling ${WORKFLOW} runs from ${REPO} into ${TARGET}/api/status/probe${DRY ? " (DRY)" : ""}`);

// Collect the runs first, then resolve each one's probe step.
const runs = [];
for (let page = 1; page <= 40; page++) {
  const j = await ghJson(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=100&page=${page}`);
  const batch = j.workflow_runs || [];
  if (!batch.length) break;
  runs.push(...batch);
  if (batch.length < 100) break;
}
console.log(`runs found: ${runs.length} — resolving each one's probe step (the run conclusion is not used)`);

const PROBE_STEP = /^probe production/i;
const rows = [];
const tally = { up: 0, down: 0, noProbe: 0 };
let done = 0;
for (const r of runs) {
  if (rows.length >= LIMIT) break;
  let steps = [];
  try {
    const jobs = await ghJson(`/repos/${REPO}/actions/runs/${r.id}/jobs?per_page=50`);
    steps = (jobs.jobs || []).flatMap((j) => j.steps || []);
  } catch (e) {
    console.warn(`  run ${r.id}: could not read jobs (${e.message}) — skipped`);
    tally.noProbe++;
    continue;
  }
  const probe = steps.find((s) => PROBE_STEP.test(String(s.name || "")));
  // No probe step, or it never completed: the observation does not exist.
  if (!probe || (probe.conclusion !== "success" && probe.conclusion !== "failure")) { tally.noProbe++; continue; }
  const ts = Date.parse(probe.started_at || r.run_started_at || r.created_at);
  if (!Number.isFinite(ts)) { tally.noProbe++; continue; }
  const ok = probe.conclusion === "success";
  ok ? tally.up++ : tally.down++;
  rows.push({ ts, source: "backfill", component: "api", ok, detail: ok ? null : "heartbeat probe failed", url: r.html_url });
  if (++done % 100 === 0) console.log(`  resolved ${done}/${runs.length}`);
}
console.log(`probe steps resolved — up: ${tally.up} · down: ${tally.down} · no observation: ${tally.noProbe}`);

rows.sort((a, b) => a.ts - b.ts);
const use = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);


console.log(`observations to import: ${use.length}`);
if (use.length) {
  const first = new Date(use[0].ts).toISOString();
  const last = new Date(use[use.length - 1].ts).toISOString();
  const down = use.filter((r) => !r.ok).length;
  console.log(`window: ${first} -> ${last}`);
  console.log(`up: ${use.length - down} · down: ${down} · observed availability: ${((1 - down / use.length) * 100).toFixed(3)}%`);
}
if (DRY) { console.log("dry run — nothing posted"); process.exit(0); }
if (!use.length) { console.log("nothing to import"); process.exit(0); }

let written = 0, received = 0;
for (let i = 0; i < use.length; i += BATCH) {
  const chunk = use.slice(i, i + BATCH);
  const res = await fetch(`${TARGET}/api/status/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Operator-Token": OP_TOKEN },
    body: JSON.stringify({ source: "backfill", probes: chunk }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) die(`POST /api/status/probe -> HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = await res.json();
  written += j.written || 0;
  received += j.received || 0;
  console.log(`  batch ${i / BATCH + 1}: received ${j.received}, newly written ${j.written}`);
}
console.log(`\nimported ${written} new observation(s) of ${received} sent (the remainder were already recorded).`);
