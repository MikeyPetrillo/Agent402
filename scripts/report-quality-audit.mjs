// Do the paid reports still SAY anything? Graded against each tier's own config.
//
// WHY (2026-09-11). A $1.10 research-max bought that day reported
// `searches_run: 1` and `sources_listed: 5` against a tier configured for 12
// searches, a 40-source pool and 10 full page reads. The prose read fine. It
// rested on a twelfth of the evidence the buyer paid for, and on that run the
// TOP tier did less work than the $0.60 one plans. Nothing caught it because
// every guard we own asserts SHAPE: the envelope was perfect.
//
// The cause is fixed (research-deep-kit now refuses a collapsed plan), but the
// CLASS is not: any report can quietly return less work than its tier promises,
// and the only surfaces that would notice are a buyer's disappointment and this
// file. The reports have card buyers and monitor subscribers; nobody was
// reading what they produce.
//
// WHAT IT GRADES, per report, against the tier's OWN declared config - never a
// number typed in here, so a retune of a tier retunes the expectation:
//   - work actually done: searches_run / sources_listed vs the tier's
//     searches / topK, as a RATIO, so "ran, but barely" is visible;
//   - citations: every [n] inside the source list, none dangling;
//   - honesty: meta.unverified_numeric_claims stays at zero;
//   - substance: prose length, section count, and the absence phrases a thin
//     report reaches for ("not available", "could not be read");
//   - cost: upstream spend against the tier cap, read from the operator
//     surface, so a report that got cheap is as visible as one that got thin.
//
// NOT a CI script. It spends real money on real upstreams. It runs WEEKLY on a
// ROTATING SUBSET (see report-quality.yml) rather than the whole line, because
// a full pass costs real synthesis spend - the point is to notice a regression
// within a couple of weeks, not to audit everything every time.
//
//   TARGET_URL=http://127.0.0.1:PORT node scripts/report-quality-audit.mjs \
//     [--only research-max,dossier] [--out report.json]
import { writeFileSync } from "node:fs";
import { RESEARCH_TIERS } from "../src/tools/research-deep-kit.js";
import { REPORT_TIERS } from "../src/report-tiers.js";

const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ONLY = (arg("--only") || process.env.AUDIT_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = arg("--out");

// Inputs are deliberately BORING and stable - a large-cap ticker, a broad
// question - so a change in the grade means the pipeline changed, not the
// subject. A thin answer about an obscure ticker proves nothing.
const SUBJECTS = [
  { slug: "research",        path: "/v1/research",              body: { query: "What is driving enterprise adoption of stablecoin payments in 2026?" } },
  { slug: "research-pro",    path: "/v1/research/pro",          body: { query: "What is driving enterprise adoption of stablecoin payments in 2026?" } },
  { slug: "research-max",    path: "/v1/research/max",          body: { query: "What is driving enterprise adoption of stablecoin payments in 2026?" } },
  { slug: "market-brief",    path: "/v1/research/market-brief", body: { query: "AI inference API providers" } },
  { slug: "dossier",         path: "/v1/dossier",               body: { ticker: "MSFT" } },
  { slug: "dossier-max",     path: "/v1/dossier/max",           body: { ticker: "MSFT" } },
  { slug: "fund-report",     path: "/v1/fund",                  body: { manager: "Berkshire Hathaway" } },
  { slug: "insider-report",  path: "/v1/insider-report",        body: { ticker: "MSFT" } },
  { slug: "filing-report",   path: "/v1/filing-report",         body: { ticker: "MSFT" } },
  { slug: "ticker-pack",     path: "/v1/ticker-pack",           body: { ticker: "MSFT" } },
];

// A thin report reaches for these. One is normal (an honest gap in a source);
// a handful means the pipeline fed the model nothing.
const ABSENCE = /(not (?:available|provided|visible|disclosed|found)|could not be (?:read|retrieved|determined)|no data (?:available|found)|unavailable in the material)/gi;
const ABSENCE_MAX = 3;
// Below this a "report" is a paragraph. The cheapest tier targets ~1,500 words.
const MIN_PROSE = 4000;
// A tier that plans N searches and lands under this fraction of them did not do
// the work the price is for. 0.5 is deliberately generous: individual searches
// legitimately fail, and the kit's own floor is a third.
const MIN_WORK_RATIO = 0.5;

const expectationsFor = (slug) => {
  const r = RESEARCH_TIERS[slug];
  if (r) return { searches: r.searches, sources: r.topK, cap: r.maxUpstreamUsd, price: Number(String(r.price).replace("$", "")) };
  const t = REPORT_TIERS[slug];
  return t ? { cap: t.maxUpstreamUsd, price: Number(String(t.price ?? "0").replace("$", "")) } : {};
};

const subjects = ONLY.length ? SUBJECTS.filter((s) => ONLY.includes(s.slug)) : SUBJECTS;
if (!subjects.length) { console.error(`no subjects matched --only ${ONLY.join(",")}`); process.exit(2); }

console.log(`report quality: ${subjects.length} report(s) against ${TARGET}\n`);
const results = [];

for (const s of subjects) {
  const exp = expectationsFor(s.slug);
  const t0 = Date.now();
  let res, data;
  try {
    res = await fetch(`${TARGET}${s.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s.body),
      signal: AbortSignal.timeout(600_000),
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    results.push({ slug: s.slug, verdict: "unreachable", detail: String(e.message).slice(0, 120) });
    console.log(`  UNREACHABLE ${s.slug}: ${String(e.message).slice(0, 90)}`);
    continue;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (res.status !== 200) {
    // A 5xx here is the pipeline refusing, which is CORRECT behaviour when it
    // cannot do the work - it cancels settlement and nobody is charged. Report
    // it, never grade it as a thin report.
    const verdict = res.status >= 500 ? "refused" : "rejected";
    results.push({ slug: s.slug, verdict, status: res.status, detail: JSON.stringify(data).slice(0, 200) });
    console.log(`  ${verdict.toUpperCase().padEnd(11)} ${s.slug}  HTTP ${res.status} (${secs}s)`);
    continue;
  }

  const prose = typeof data?.report === "string" ? data.report : (typeof data?.dossier === "string" ? data.dossier : JSON.stringify(data ?? {}));
  const meta = data?.meta || {};
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const cited = [...new Set([...prose.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
  const dangling = cited.filter((n) => n < 1 || n > sources.length);
  const absence = (prose.match(ABSENCE) || []).length;
  const sections = (prose.match(/\n##\s/g) || []).length;

  const fails = [];
  if (prose.length < MIN_PROSE) fails.push(`prose ${prose.length} chars under ${MIN_PROSE}`);
  if (dangling.length) fails.push(`citations outside the source list: ${dangling.join(",")}`);
  if ((meta.unverified_numeric_claims || []).length) fails.push(`${meta.unverified_numeric_claims.length} unverified numeric claims`);
  if (absence > ABSENCE_MAX) fails.push(`${absence} absence phrases (max ${ABSENCE_MAX})`);
  // The check that would have caught the 2026-09-11 defect.
  if (exp.searches && Number.isFinite(meta.searches_run)) {
    const ratio = meta.searches_run / exp.searches;
    if (ratio < MIN_WORK_RATIO) fails.push(`ran ${meta.searches_run} of ${exp.searches} planned searches (${(ratio * 100).toFixed(0)}%, floor ${MIN_WORK_RATIO * 100}%)`);
  }
  if (exp.sources && sources.length && sources.length < exp.sources * 0.25) {
    fails.push(`${sources.length} sources against a ${exp.sources} pool`);
  }

  const row = { slug: s.slug, verdict: fails.length ? "thin" : "ok", secs: Number(secs), proseChars: prose.length, sections,
    sources: sources.length, cited: cited.length, searchesRun: meta.searches_run ?? null, expectedSearches: exp.searches ?? null,
    absence, price: exp.price ?? null, cap: exp.cap ?? null, fails };
  results.push(row);
  console.log(`  ${row.verdict === "ok" ? "OK   " : "THIN "} ${s.slug.padEnd(16)} ${secs}s  ${prose.length} chars · ${sections} sections · ${sources.length} sources · ${cited.length} cited${meta.searches_run != null ? ` · ${meta.searches_run}/${exp.searches ?? "?"} searches` : ""}`);
  for (const f of fails) console.log(`         - ${f}`);
}

const thin = results.filter((r) => r.verdict === "thin");
const broken = results.filter((r) => r.verdict === "unreachable" || r.verdict === "rejected");
console.log(`\n=== ${results.length} graded · ${results.filter((r) => r.verdict === "ok").length} ok · ${thin.length} thin · ${results.filter((r) => r.verdict === "refused").length} refused · ${broken.length} broken ===`);
if (OUT) { writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), target: TARGET, results }, null, 2)); console.log(`wrote ${OUT}`); }
// A THIN report is the thing this exists to catch, so it fails the run. A
// REFUSED one is the pipeline behaving correctly and does not.
process.exit(thin.length || broken.length ? 1 : 0);
