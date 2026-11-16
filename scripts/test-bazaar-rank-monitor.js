// The weekly Bazaar rank monitor: query list, rank, week-over-week diff and the
// page decision, on fixtures (offline), plus the workflow's schedule, its
// single fixed-title issue and that it commits nothing.
//
//   node scripts/test-bazaar-rank-monitor.js
import { readFileSync } from "node:fs";
import {
  FLAGSHIPS, SEARCH_LIMIT, DEFAULT_DROP, queryFromName, buildQueries, ourPath, rankOurs,
  diffWeeks, pageDecision, renderReport,
} from "./bazaar-rank-monitor.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- query list ---------------------------------------------------------------
ok(queryFromName("Chat completions - metered (pay what the call costs)") === "chat completions", "a name loses its ' - qualifier'");
ok(queryFromName("Unique ID generator (UUID)") === "unique id generator", "a name loses a trailing parenthetical");
ok(queryFromName("Onchain SQL") === "onchain sql", "a name is lower-cased");

const endpoints = [
  { slug: "search", name: "Web search" },
  { slug: "v1-chat-metered", name: "Chat completions - metered (pay what the call costs)" },
  { slug: "hash", name: "Hash" }, { slug: "base64", name: "Base64" }, { slug: "uuid", name: "Unique ID generator (UUID)" },
  { slug: "a", name: "Tool A" }, { slug: "b", name: "Tool B" }, { slug: "c", name: "Tool C" }, { slug: "d", name: "Tool D" },
  { slug: "e", name: "Tool E" }, { slug: "f", name: "Tool F" }, { slug: "dup", name: "Hash (other)" },
];
const top = ["hash", "v1-chat-metered", "base64", "gone", "dup", "uuid", "a", "b", "c", "d", "e", "f"].map((slug, i) => ({ slug, n: 100 - i }));
const qs = buildQueries(top, endpoints);
ok(qs.length === FLAGSHIPS.length + 8, `two flagships plus eight by demand (${qs.length})`);
ok(qs[0].query === "web search" && qs[1].query === "chat completion" && qs[0].flagship && qs[1].flagship, "the flagships lead, in the owner's words");
ok(qs.slice(2).every((q) => !q.flagship && q.source === "demand"), "the rest come from demand");
ok(!qs.slice(2).some((q) => q.slug === "v1-chat-metered"), "a flagship slug in the demand list is not counted twice");
ok(!qs.some((q) => q.slug === "gone"), "a slug the catalog no longer lists is skipped");
ok(!qs.some((q) => q.slug === "dup"), "a slug that phrases like an earlier one is kept once");
ok(qs.slice(2).map((q) => q.slug).join(",") === "hash,base64,uuid,a,b,c,d,e", `demand order follows the ranking (${qs.slice(2).map((q) => q.slug).join(",")})`);
ok(buildQueries([], endpoints).length === 2, "no demand data still measures the flagships");

// ---- ranking: only our rows survive ----------------------------------------
ok(ourPath("https://agent402.tools/api/search") === "/api/search", "our path is read");
ok(ourPath("https://agent402.tools.example.com/api/x") === null, "a host that only starts with ours is not ours");
ok(ourPath("https://example.com/agent402.tools") === null, "our host in another site's path is not ours");
ok(ourPath("not a url") === null, "a malformed resource is not ours");
const rows = [
  { resource: "https://example.com/a" }, { resource: "https://example.org/b" },
  { resource: "https://agent402.tools/api/search" }, { resource: "https://example.net/c" },
  { resource: "https://agent402.tools/api/search-lite" },
];
const r = rankOurs(rows);
ok(r.best === 3 && r.bestPath === "/api/search", `best rank is our first position, 1-based (${r.best})`);
ok(r.ours.length === 2 && r.returned === 5, "every row of ours is counted and the list length kept");
ok(!JSON.stringify(r).includes("example"), "nothing of another resource survives the reduction");
ok(rankOurs([{ resource: "https://example.com/a" }]).best === null, "no row of ours is absent (null)");
ok(rankOurs(undefined).best === null, "a missing list is absent");

// ---- diff and page decision ---------------------------------------------------
const wk = (rows2) => ({ at: "2026-11-16T00:00:00Z", queries: rows2.map(([query, best, flagship = false, okk = true]) => ({ query, best, flagship, ok: okk })) });
const prev = wk([["web search", 2, true], ["chat completion", 4, true], ["hash", 1], ["base64", 3], ["uuid", null], ["gone", 1]]);

let d = pageDecision(prev, wk([["web search", 2, true], ["chat completion", 4, true], ["hash", 1], ["base64", 3], ["uuid", null]]));
ok(!d.page && d.reasons.length === 0, "an unchanged week is clean");

d = pageDecision(prev, wk([["web search", null, true], ["chat completion", 4, true]]));
ok(d.page && d.reasons.some((x) => x.reason === "flagship_absent" && x.query === "web search"), "a flagship query with none of ours pages");
d = pageDecision(null, wk([["web search", null, true]]));
ok(d.page && d.reasons[0].reason === "flagship_absent", "a flagship absent pages on the first week too (no baseline needed)");
d = pageDecision(null, wk([["web search", 3, true], ["uuid", null]]));
ok(!d.page, "a demand query with none of ours does not page by itself");

const drop = DEFAULT_DROP;
d = pageDecision(prev, wk([["web search", 2, true], ["chat completion", 4, true], ["hash", 1 + drop]]));
ok(d.page && d.reasons.some((x) => x.reason === "rank_drop" && x.query === "hash"), `a fall of exactly ${drop} places pages`);
d = pageDecision(prev, wk([["web search", 2, true], ["chat completion", 4, true], ["hash", drop]]));
ok(!d.page, `a fall of ${drop - 1} places does not`);
d = pageDecision(prev, wk([["web search", 2, true], ["chat completion", 4, true], ["base64", null]]));
ok(d.page && d.reasons.some((x) => x.reason === "rank_drop" && x.query === "base64"), `leaving the list from rank 3 counts as a fall to ${SEARCH_LIMIT + 1}`);
d = pageDecision(wk([["base64", SEARCH_LIMIT - 1]]), wk([["base64", null]]));
ok(!d.page, "leaving the list from its bottom is a small fall and does not page");
d = pageDecision(prev, wk([["web search", 2, true], ["chat completion", 4, true], ["uuid", 20]]));
ok(!d.page, "absent last week has no baseline to fall from");
d = pageDecision(prev, wk([["web search", 2, true], ["chat completion", 4, true], ["hash", 1], ["newq", 19]]));
ok(!d.page, "a query new this week has no baseline");
d = pageDecision(prev, wk([["web search", 1, true], ["chat completion", 1, true], ["hash", 1], ["base64", 1]]));
ok(!d.page, "climbing never pages");
d = pageDecision(prev, wk([["web search", 1, true], ["hash", 1], ["base64", undefined, false, false]]));
ok(d.page && d.reasons.some((x) => x.reason === "unreadable" && x.query === "base64"), "a query the search could not answer pages as unreadable");
ok(!d.reasons.some((x) => x.reason === "rank_drop"), "an unreadable week is not a drop");
d = pageDecision(wk([["hash", 1, false, false]]), wk([["hash", 20]]));
ok(!d.page, "an unreadable baseline is no baseline");
d = pageDecision(prev, wk([]));
ok(d.page && d.reasons[0].reason === "no_measurement", "a run that measured nothing pages");
d = pageDecision(prev, wk([["web search", 2, true], ["chat completion", 4, true], ["hash", 4]]), { drop: 3 });
ok(d.page, "the drop threshold is configurable");

const diffs = diffWeeks(prev, wk([["hash", 3], ["uuid", 5]]));
ok(diffs.length === 2 && diffs[0].fell === 2 && diffs[0].prevBest === 1, "diff rows follow this week's list with last week's best");

// ---- report text ---------------------------------------------------------------
const cur = { at: "2026-11-16T00:00:00Z", queries: [
  { query: "web search", flagship: true, ok: true, best: null, bestPath: null, oursMatching: 10 },
  { query: "hash", flagship: false, ok: true, best: 1, bestPath: "/api/hash", oursMatching: 6 },
  { query: "base64", flagship: false, ok: false },
] };
const rep = renderReport(prev, cur);
ok(rep.includes("| web search | flagship | absent | 2 |  | 10 |"), "the report shows absent, last week and the host-limited match count");
ok(rep.includes("| hash | demand | 1 | 1 | `/api/hash` | 6 |"), "a ranked row names our route");
ok(rep.includes("| base64 | demand | unreadable |"), "an unreadable row says so");
ok(rep.includes("Paging because") && rep.includes("web search: a flagship query returns none of our routes"), "the reasons are listed");
ok(!/https?:\/\/(?!agent402\.tools)/.test(rep), "the report carries no other host");

// ---- the workflow ----------------------------------------------------------------
const wf = readFileSync(new URL("../.github/workflows/bazaar-rank.yml", import.meta.url), "utf8");
const cron = (wf.match(/cron:\s*"([^"]+)"/) || [])[1] || "";
const f = cron.split(/\s+/);
ok(f.length === 5 && f[2] === "*" && /^[0-6]$/.test(f[4]), `weekly cron (${cron})`);
ok(/workflow_dispatch:/.test(wf), "it can be dispatched");
ok(/timeout-minutes:\s*\d+/.test(wf), "the job has a timeout");
ok(/contents:\s*read/.test(wf) && !/contents:\s*write/.test(wf), "it never writes to the repo (history is an artifact)");
ok(!/git (commit|push)/.test(wf), "no commit or push step");
ok(/actions\/upload-artifact@[0-9a-f]{40}/.test(wf), "the history is uploaded as a pinned artifact action");
ok(/gh run download/.test(wf) && /actions:\s*read/.test(wf), "last week's history is read back from the previous run's artifact");
ok(/node scripts\/bazaar-rank-monitor\.js/.test(wf), "it runs the monitor script");
const title = (wf.match(/TITLE="([^"]+)"/) || [])[1] || "";
ok(title !== "" && !/\$|\d/.test(title), `one fixed issue title with no counts (${title})`);
ok(/gh issue create/.test(wf) && /gh issue comment/.test(wf) && /gh issue close/.test(wf), "opens one issue, comments on it while open, closes it when clean");
ok((wf.match(/gh issue create/g) || []).length === 1, "exactly one place opens an issue");
for (const m of wf.matchAll(/uses:\s*([^\s#]+)/g)) ok(/@[0-9a-f]{40}$/.test(m[1]), `action pinned to a commit (${m[1].split("@")[0]})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
