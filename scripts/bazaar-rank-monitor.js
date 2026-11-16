#!/usr/bin/env node
// Where our routes rank in the Bazaar's own search, once a week.
//
// The CDP discovery API has a ranked search: GET /v2/x402/discovery/search
// (unauthenticated) takes `query` and returns at most 20 resources, ordered by
// a blend of query relevance and quality. No score is returned, so a rank here
// is our position in that list (1 = first), and "absent" means none of our
// routes is in it. The same call with urlSubstring=<our host> returns only our
// routes that match the query: when that is not empty and the open search has
// none of ours, the query matches us and we are outranked, which is a
// different fix from a query that does not match our metadata at all.
//
// The query list: the two flagship queries the owner named (web search, chat
// completion), then the next eight tools by our own demand, read from the
// public `topTools` ranking on /api/stats (raw call volume, free and paid) and
// phrased as each tool's catalog name from /api/pricing. Two GETs to our host
// per run; everything else goes to the discovery API.
//
// Reports our own routes only. Another resource's host, name or URL is never
// kept, printed or written: a row from the search is reduced to "ours or not"
// before anything else reads it.
//
// The pure parts (query list, rank, week-over-week diff, page decision, issue
// text) are exported and tested by scripts/test-bazaar-rank-monitor.js; main()
// is the thin fetcher the weekly workflow runs. Spends nothing, needs no key.
//
//   node scripts/bazaar-rank-monitor.js --history prev/history.json --out out/
//     writes out/history.json (prior weeks plus this one), out/report.md, and
//     out/page.txt containing "page" or "clear".
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SEARCH_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
export const SEARCH_LIMIT = 20; // the endpoint's maximum
export const OUR_HOST = "agent402.tools";
// The owner's flagship queries, each with the slug that should answer it.
export const FLAGSHIPS = Object.freeze([
  Object.freeze({ query: "web search", slug: "search" }),
  Object.freeze({ query: "chat completion", slug: "v1-chat-metered" }),
]);
export const DEMAND_QUERIES = 8;
// A best rank that falls this many places or more in a week pages.
export const DEFAULT_DROP = 5;
// Weeks of history carried forward in the artifact.
export const HISTORY_KEEP = 104;

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
  const out = FLAGSHIPS.map((f) => ({ query: f.query, slug: f.slug, flagship: true, source: "owner" }));
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
    out.push({ query, slug, flagship: false, source: "demand" });
    added++;
  }
  return out;
}

// Our path for a resource URL, or null when the resource is not ours. The
// only thing read from another seller's row is that it is not ours.
export function ourPath(resource, host = OUR_HOST) {
  try {
    const u = new URL(String(resource));
    return u.hostname === host ? u.pathname : null;
  } catch { return null; }
}

// One search answer reduced to our own rows: positions (1-based) and paths.
export function rankOurs(resources, host = OUR_HOST) {
  const ours = [];
  (resources || []).forEach((r, i) => {
    const path = ourPath(r && r.resource, host);
    if (path) ours.push({ rank: i + 1, path });
  });
  return { returned: (resources || []).length, ours, best: ours.length ? ours[0].rank : null, bestPath: ours.length ? ours[0].path : null };
}

// The rank used for a diff: absent counts as one place past the list.
const effective = (rank) => (rank == null ? SEARCH_LIMIT + 1 : rank);

// Week-over-week: one row per query in this week's list. A query without a
// readable baseline (new this week, or unreadable either week) has no drop.
export function diffWeeks(prev, cur, { drop = DEFAULT_DROP } = {}) {
  const before = new Map(((prev && prev.queries) || []).map((q) => [q.query, q]));
  return ((cur && cur.queries) || []).map((q) => {
    const p = before.get(q.query);
    const comparable = !!p && p.ok !== false && q.ok !== false && p.best !== undefined;
    const fell = comparable ? effective(q.best) - effective(p.best) : 0;
    return { query: q.query, flagship: !!q.flagship, prevBest: comparable ? p.best : undefined, best: q.best, fell, dropped: fell >= drop };
  });
}

// The page decision. Reasons are fixed words; the issue body lists the queries.
export function pageDecision(prev, cur, { drop = DEFAULT_DROP } = {}) {
  const reasons = [];
  const qs = (cur && cur.queries) || [];
  if (!qs.length) reasons.push({ reason: "no_measurement", query: null });
  for (const q of qs) {
    if (q.ok === false) reasons.push({ reason: "unreadable", query: q.query });
    else if (q.flagship && q.best == null) reasons.push({ reason: "flagship_absent", query: q.query });
  }
  for (const d of diffWeeks(prev, cur, { drop })) {
    if (d.dropped) reasons.push({ reason: "rank_drop", query: d.query });
  }
  return { page: reasons.length > 0, reasons };
}

const rankText = (r) => (r == null ? "absent" : String(r));

export function renderReport(prev, cur, { drop = DEFAULT_DROP } = {}) {
  const dec = pageDecision(prev, cur, { drop });
  const diffs = new Map(diffWeeks(prev, cur, { drop }).map((d) => [d.query, d]));
  const lines = [
    `Bazaar search ranks for ${OUR_HOST}, measured ${cur.at}.`,
    "",
    `Each query goes to the discovery search (top ${SEARCH_LIMIT}, relevance and quality blended, no score returned). "Best" is the position of our first route; "ours matching" is how many of our routes the same query returns when the search is limited to our host, so absent with matches means outranked and absent with none means our metadata does not match the query.`,
    "",
    "| query | source | best | last week | our route | ours matching |",
    "|---|---|---|---|---|---|",
  ];
  for (const q of cur.queries) {
    const d = diffs.get(q.query);
    const last = d && d.prevBest !== undefined ? rankText(d.prevBest) : "n/a";
    const best = q.ok === false ? "unreadable" : rankText(q.best);
    const route = q.bestPath ? `\`${q.bestPath}\`` : "";
    const matching = q.ok === false || q.oursMatching == null ? "" : String(q.oursMatching);
    lines.push(`| ${q.query} | ${q.flagship ? "flagship" : "demand"} | ${best} | ${last} | ${route} | ${matching} |`);
  }
  lines.push("");
  if (dec.page) {
    lines.push("Paging because:");
    for (const r of dec.reasons) {
      const what = {
        flagship_absent: "a flagship query returns none of our routes",
        rank_drop: `our best rank fell ${drop} or more places since last week`,
        unreadable: "the search could not be read for this query",
        no_measurement: "no query was measured",
      }[r.reason];
      lines.push(`- ${r.query ? `${r.query}: ` : ""}${what}`);
    }
  } else {
    lines.push("Clean: every flagship query returns one of our routes and no best rank fell by the drop threshold.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- fetcher
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { tries = 3, timeoutMs = 20_000 } = {}) {
  let last = "unreachable";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}`;
    } catch (e) { last = e?.name === "TimeoutError" ? "timeout" : "unreachable"; }
    await sleep(2000 * (i + 1));
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

export async function measure(queries, { pauseMs = 1000 } = {}) {
  const out = [];
  for (const q of queries) {
    const row = { query: q.query, slug: q.slug, flagship: q.flagship };
    try {
      const open = await getJson(searchUrl(q.query));
      const r = rankOurs(open.resources);
      await sleep(pauseMs);
      const mine = await getJson(searchUrl(q.query, { urlSubstring: OUR_HOST }));
      Object.assign(row, { ok: true, best: r.best, bestPath: r.bestPath, oursInTop: r.ours.length, returned: r.returned, oursMatching: rankOurs(mine.resources).ours.length });
    } catch (e) {
      Object.assign(row, { ok: false, error: String(e.message).slice(0, 40) });
    }
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
  const base = process.env.BASE_URL || `https://${OUR_HOST}`;
  const drop = Number(process.env.BAZAAR_RANK_DROP) > 0 ? Number(process.env.BAZAAR_RANK_DROP) : DEFAULT_DROP;
  const outDir = arg("--out") || "bazaar-rank-out";
  const histPath = arg("--history");
  let history = [];
  if (histPath && existsSync(histPath)) {
    try { const h = JSON.parse(readFileSync(histPath, "utf8")); if (Array.isArray(h)) history = h; } catch { /* a bad file starts a new history */ }
  }
  const stats = await getJson(`${base}/api/stats`);
  const pricing = await getJson(`${base}/api/pricing`);
  const queries = buildQueries(stats.topTools, pricing.endpoints);
  const cur = { at: new Date().toISOString(), queries: await measure(queries) };
  const prev = history.length ? history[history.length - 1] : null;
  const dec = pageDecision(prev, cur, { drop });
  history = [...history, cur].slice(-HISTORY_KEEP);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "history.json"), JSON.stringify(history, null, 1));
  const report = renderReport(prev, cur, { drop });
  writeFileSync(join(outDir, "report.md"), report + "\n");
  writeFileSync(join(outDir, "page.txt"), dec.page ? "page\n" : "clear\n");
  console.log(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`bazaar rank monitor failed: ${String(e?.message || e).slice(0, 200)}`); process.exit(1); });
}
