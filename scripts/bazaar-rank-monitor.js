#!/usr/bin/env node
// Checks that our own listing answers our own queries, once a week.
//
// For each of our queries, one GET to the CDP discovery search
// (GET /v2/x402/discovery/search, unauthenticated, at most 20 resources)
// asks one question: does any route of ours come back? A second GET with
// urlSubstring=<our host> tells whether our listing matches the query at all,
// which separates "our metadata does not match" from "our routes match but do
// not come back", two different fixes on our side.
//
// The query list: two fixed flagship queries (web search, chat completion),
// then the next eight tools by our own demand, read from the public
// `topTools` ranking on /api/stats and phrased as each tool's catalog name
// from /api/pricing.
//
// Nothing about the search itself is kept, printed or published: no position,
// no count, no other resource. Each row is reduced to "ours or not" (our exact
// host AND a path our /api/pricing lists), each query to present / absent /
// unreadable, and only the names of OUR absent queries reach the one issue.
// A query the search cannot answer is recorded in this run's own status as
// not measured; it never pages. No history is kept between runs.
//
// The pure parts (query list, ours check, reply reading, issue lines and the
// issue action) are exported and tested by scripts/test-bazaar-rank-monitor.js;
// main() is the thin fetcher the weekly workflow runs. Spends nothing, needs
// no key.
//
//   node scripts/bazaar-rank-monitor.js --issue-body open-issue.md --out out/
//     writes out/status.txt ("measured" or "unmeasured"), out/action.txt
//     ("none", "open", "update" or "close") and out/body.md (the issue body).
//     Prints nothing about the results.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SEARCH_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
export const SEARCH_LIMIT = 20; // the endpoint's maximum
export const OUR_HOST = "agent402.tools";
// The fixed flagship queries. `slug` is the tool's catalog slug, read only so
// the demand list does not repeat a flagship.
export const FLAGSHIPS = Object.freeze([
  Object.freeze({ query: "web search", slug: "search" }),
  Object.freeze({ query: "chat completion", slug: "v1-chat-metered" }),
]);
export const DEMAND_QUERIES = 8;

// Fetch budget. Only a 5xx, a timeout or a network error is retried; a 4xx is
// final. The run stops starting fetches at RUN_DEADLINE_MS, so its worst case
// (WORST_CASE_MS) fits the workflow's timeout-minutes with room for setup.
export const FETCH_TRIES = 2;
export const FETCH_TIMEOUT_MS = 10_000;
export const RETRY_WAIT_MS = 2_000;
export const PAUSE_MS = 1_000;
export const RUN_DEADLINE_MS = 8 * 60_000;
// The deadline is checked before each fetch, so the last fetch that starts
// can still run its full retry ladder past it.
export const WORST_CASE_MS = RUN_DEADLINE_MS + FETCH_TRIES * FETCH_TIMEOUT_MS + (FETCH_TRIES - 1) * RETRY_WAIT_MS + PAUSE_MS;

// A catalog name as a buyer would type it: lower case, without a trailing
// parenthetical or a " - qualifier", punctuation folded to spaces.
export function queryFromName(name) {
  let s = String(name || "").toLowerCase();
  s = s.replace(/\s+-\s+.*$/, "").replace(/\s*\([^)]*\)\s*$/, "");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  return s.slice(0, 120);
}

// Flagships first, then the top tools by demand that are not flagships, up to
// DEMAND_QUERIES, each phrased from its catalog name. A slug the catalog does
// not list is skipped (retired or hidden), and two slugs that phrase the same
// are kept once.
export function buildQueries(topTools, endpoints, { demand = DEMAND_QUERIES } = {}) {
  const bySlug = new Map((endpoints || []).filter((e) => e && e.slug).map((e) => [e.slug, e]));
  const out = FLAGSHIPS.map((f) => ({ query: f.query, slug: f.slug, flagship: true }));
  const seen = new Set(out.map((q) => q.query));
  const flagshipSlugs = new Set(FLAGSHIPS.map((f) => f.slug));
  let added = 0;
  for (const row of topTools || []) {
    if (added >= demand) break;
    const slug = row && row.slug;
    if (!slug || flagshipSlugs.has(slug)) continue;
    const ep = bySlug.get(slug);
    if (!ep) continue;
    const query = queryFromName(ep.name);
    if (!query || seen.has(query)) continue;
    seen.add(query);
    out.push({ query, slug, flagship: false });
    added++;
  }
  return out;
}

// The set of paths our catalog serves, from /api/pricing endpoints[].path.
export function ourRoutes(endpoints) {
  return new Set((endpoints || []).map((e) => e && e.path).filter((p) => typeof p === "string" && p.startsWith("/")));
}

// A resource is ours only when its host is exactly ours AND its path is one
// our catalog lists. Another seller can put our host in a path or a
// look-alike host in a URL; neither counts.
export function isOurs(resource, routes, host = OUR_HOST) {
  try {
    const u = new URL(String(resource));
    return u.protocol === "https:" && u.hostname === host && !u.username && !u.password && routes.has(u.pathname);
  } catch { return false; }
}

// One search reply read as "is any route of ours in it". A reply flagged
// partialResults, or without a resources array, is unreadable (not absent).
export function readReply(body, routes, host = OUR_HOST) {
  if (!body || typeof body !== "object" || body.partialResults === true || !Array.isArray(body.resources)) return { ok: false };
  return { ok: true, ours: body.resources.some((r) => isOurs(r && r.resource, routes, host)) };
}

// The acknowledge list: a comma list of query texts that do not page.
export function parseAck(raw) {
  return new Set(String(raw || "").split(",").map((s) => s.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean));
}

const LINE_PREFIX = "- Absent: ";
const KIND = { unmatched: "our listing does not match this query", outranked: "our listing matches this query but none of our routes comes back" };

// The issue's reason lines: one per absent query of ours that is not
// acknowledged, sorted, in fixed words. Status "unmeasured" when any query
// could not be read (the run then changes nothing).
export function decide(rows, ack = new Set()) {
  if (!rows.length || rows.some((r) => !r.ok)) return { status: "unmeasured", lines: [] };
  const lines = rows
    .filter((r) => !r.present && !ack.has(r.query))
    .map((r) => `${LINE_PREFIX}${r.query} (${r.matches ? KIND.outranked : KIND.unmatched})`)
    .sort();
  return { status: "measured", lines };
}

export function issueBody(lines, runUrl) {
  return [
    "A weekly check of our own listing (scripts/bazaar-rank-monitor.js) found these queries of ours that return none of our routes in the discovery search. To stop a known one from opening this issue, add its query text to the repository variable BAZAAR_RANK_ACK (comma list). Closes when none is left.",
    "",
    ...lines,
    "",
    `Run: ${runUrl}`,
  ].join("\n") + "\n";
}

// The reason lines an open issue's body carries.
export function linesFromBody(body) {
  return String(body || "").split(/\r?\n/).filter((l) => l.startsWith(LINE_PREFIX)).sort();
}

// What the workflow does with the one issue. Nothing on an unmeasured run;
// open when a reason appears, update (edit body + comment) only when the set
// of reasons changes, close when none is left.
export function issueAction({ status, lines }, openBody) {
  if (status !== "measured") return "none";
  const open = openBody != null;
  if (!lines.length) return open ? "close" : "none";
  if (!open) return "open";
  const before = linesFromBody(openBody);
  return before.length === lines.length && before.every((l, i) => l === lines[i]) ? "none" : "update";
}

// ---------------------------------------------------------------- fetcher
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, { fetchImpl = fetch, sleep = realSleep, deadline = Infinity, now = Date.now } = {}) {
  let last = "unreachable";
  for (let i = 0; i < FETCH_TRIES; i++) {
    if (now() >= deadline) throw new Error("deadline");
    let retry = true;
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}`;
      retry = r.status >= 500;
    } catch (e) { last = e?.name === "TimeoutError" ? "timeout" : "unreachable"; }
    if (!retry) break;
    if (i < FETCH_TRIES - 1) await sleep(RETRY_WAIT_MS);
  }
  throw new Error(last);
}

const searchUrl = (query, extra = {}) => {
  const u = new URL(SEARCH_URL);
  u.searchParams.set("query", query);
  u.searchParams.set("limit", String(SEARCH_LIMIT));
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.href;
};

export async function measure(queries, routes, { fetchImpl = fetch, sleep = realSleep, deadline = Infinity, now = Date.now, pauseMs = PAUSE_MS } = {}) {
  const opts = { fetchImpl, sleep, deadline, now };
  const out = [];
  for (const q of queries) {
    const row = { query: q.query, flagship: q.flagship, ok: false };
    try {
      const open = readReply(await getJson(searchUrl(q.query), opts), routes);
      if (open.ok && open.ours) Object.assign(row, { ok: true, present: true });
      else if (open.ok) {
        await sleep(pauseMs);
        const mine = readReply(await getJson(searchUrl(q.query, { urlSubstring: OUR_HOST }), opts), routes);
        if (mine.ok) Object.assign(row, { ok: true, present: false, matches: mine.ours });
      }
    } catch { /* unreadable */ }
    out.push(row);
    await sleep(pauseMs);
  }
  return out;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const started = Date.now();
  const deadline = started + RUN_DEADLINE_MS;
  const base = process.env.BASE_URL || `https://${OUR_HOST}`;
  const outDir = arg("--out") || "bazaar-rank-out";
  const bodyPath = arg("--issue-body");
  const openBody = bodyPath && existsSync(bodyPath) ? readFileSync(bodyPath, "utf8") : null;
  const runUrl = process.env.RUN_URL || "";
  mkdirSync(outDir, { recursive: true });
  let result = { status: "unmeasured", lines: [] };
  try {
    const stats = await getJson(`${base}/api/stats`, { deadline });
    const pricing = await getJson(`${base}/api/pricing`, { deadline });
    const routes = ourRoutes(pricing.endpoints);
    if (routes.size) {
      const rows = await measure(buildQueries(stats.topTools, pricing.endpoints), routes, { deadline });
      result = decide(rows, parseAck(process.env.BAZAAR_RANK_ACK));
    }
  } catch { /* our own catalog could not be read: unmeasured */ }
  const action = issueAction(result, openBody);
  writeFileSync(join(outDir, "status.txt"), result.status + "\n");
  writeFileSync(join(outDir, "action.txt"), action + "\n");
  writeFileSync(join(outDir, "body.md"), issueBody(result.lines, runUrl));
  console.log(`bazaar listing check: ${result.status}, issue action ${action}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("bazaar listing check failed"); process.exit(1); });
}
