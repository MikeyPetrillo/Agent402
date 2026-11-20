// The weekly check of our own Bazaar listing: query list, the "ours" test,
// reply reading, retries, the issue lines and action, on fixtures (offline),
// plus the workflow's schedule, its single fixed-title issue, its time budget
// and that it keeps and prints nothing about the search.
//
//   node scripts/test-bazaar-rank-monitor.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import {
  FLAGSHIPS, WORST_CASE_MS, queryFromName, buildQueries, ourRoutes, isOurs, readReply, parseAck,
  decide, issueBody, linesFromBody, issueAction, getJson, measure, queryOfLine, keepUnmeasured,
} from "./bazaar-rank-monitor.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- query list ---------------------------------------------------------------
ok(queryFromName("Chat completions - metered (pay what the call costs)") === "chat completions", "a name loses its ' - qualifier'");
ok(queryFromName("Unique ID generator (UUID)") === "unique id generator", "a name loses a trailing parenthetical");
ok(queryFromName("Onchain SQL") === "onchain sql", "a name is lower-cased");

const endpoints = [
  { slug: "search", name: "Web search", path: "/api/search" },
  { slug: "v1-chat-metered", name: "Chat completions - metered (pay what the call costs)", path: "/v1/chat/completions" },
  { slug: "hash", name: "Hash", path: "/api/hash" }, { slug: "base64", name: "Base64", path: "/api/base64" },
  { slug: "uuid", name: "Unique ID generator (UUID)", path: "/api/uuid" },
  { slug: "a", name: "Tool A" }, { slug: "b", name: "Tool B" }, { slug: "c", name: "Tool C" }, { slug: "d", name: "Tool D" },
  { slug: "e", name: "Tool E" }, { slug: "f", name: "Tool F" }, { slug: "dup", name: "Hash (other)" },
];
const top = ["hash", "v1-chat-metered", "base64", "gone", "dup", "uuid", "a", "b", "c", "d", "e", "f"].map((slug, i) => ({ slug, n: 100 - i }));
const qs = buildQueries(top, endpoints);
const F = FLAGSHIPS.length;
ok(qs.length === F + 8, `the flagships plus eight by demand (${qs.length})`);
ok(qs[0].query === "web search" && qs[1].query === "chat completion" && qs.slice(0, F).every((q) => q.flagship), "the fixed flagship queries lead");
// The weather queries buyers type, each pinned to the route that should answer it.
const pinned = Object.fromEntries(FLAGSHIPS.map((f) => [f.query, f.slug]));
ok(pinned["weather forecast"] === "weather-daily" && pinned["historical weather"] === "weather-history" && pinned["weather probability"] === "weather-probability", `the weather queries are fixed flagships with their slugs (${JSON.stringify(pinned)})`);
{
  const { WEATHER_TOOLS } = await import("../src/tools/weather-kit.js");
  const { WEATHER_PROBABILITY_TOOLS } = await import("../src/tools/weather-probability-kit.js");
  const bySlug = new Map([...WEATHER_TOOLS, ...WEATHER_PROBABILITY_TOOLS].map((t) => [t.slug, t]));
  for (const f of FLAGSHIPS.filter((x) => /weather/.test(x.query))) {
    const t = bySlug.get(f.slug);
    ok(t && t.description.toLowerCase().startsWith(f.query), `${f.slug}: its description leads with the words of "${f.query}" (${t?.description.slice(0, 40)})`);
  }
}
ok(qs.slice(F).every((q) => !q.flagship), "the rest come from demand");
ok(!qs.slice(F).some((q) => q.slug === "v1-chat-metered"), "a flagship slug in the demand list is not counted twice");
ok(!qs.some((q) => q.slug === "gone"), "a slug the catalog no longer lists is skipped");
ok(!qs.some((q) => q.slug === "dup"), "a slug that phrases like an earlier one is kept once");
ok(qs.slice(F).map((q) => q.slug).join(",") === "hash,base64,uuid,a,b,c,d,e", `demand order follows the ranking (${qs.slice(F).map((q) => q.slug).join(",")})`);
ok(buildQueries([], endpoints).length === F, "no demand data still checks the flagships");

// ---- ours: exact host AND a listed route -----------------------------------
const routes = ourRoutes(endpoints);
ok(routes.has("/api/search") && routes.size === 5, `our routes come from /api/pricing paths (${routes.size})`);
ok(isOurs("https://agent402.tools/api/search", routes), "our host and a listed path is ours");
ok(isOurs("https://agent402.tools/api/search?q=x", routes), "a query string does not change the path");
ok(!isOurs("https://xagent402.tools/api/search", routes), "a host that ends with ours is not ours");
ok(!isOurs("https://agent402.tools.example.com/api/search", routes), "a host that starts with ours is not ours");
ok(!isOurs("https://example.com/agent402.tools/api/search", routes), "our host in another site's path is not ours");
ok(!isOurs("https://agent402.tools/api/search|@x", routes), "a hostile path on our host is not ours");
ok(!isOurs("https://agent402.tools/api/not-a-route", routes), "an unlisted path on our host is not ours");
ok(!isOurs("https://agent402.tools@evil.example/api/search", routes), "userinfo naming our host is not ours");
ok(!isOurs("https://evil@agent402.tools/api/search", routes), "userinfo on our host is not ours");
ok(!isOurs("http://agent402.tools/api/search", routes), "plain http is not ours");
ok(!isOurs("not a url", routes), "a malformed resource is not ours");

// ---- reply reading ----------------------------------------------------------
const reply = (resources, extra = {}) => ({ resources: resources.map((resource) => ({ resource })), ...extra });
let rr = readReply(reply(["https://example.com/a", "https://agent402.tools/api/search"]), routes);
ok(rr.ok && rr.ours === true, "a reply with a route of ours is present");
rr = readReply(reply(["https://example.com/a", "https://xagent402.tools/api/search"]), routes);
ok(rr.ok && rr.ours === false, "a look-alike host does not make it present");
ok(Object.keys(rr).sort().join(",") === "ok,ours", "nothing else of the reply survives (no position, no count)");
ok(readReply(reply(["https://agent402.tools/api/search"], { partialResults: true }), routes).ok === false, "partialResults:true is unreadable, not absent");
ok(readReply({ items: [] }, routes).ok === false, "a reply without a resources array is unreadable");
ok(readReply(null, routes).ok === false, "an empty reply is unreadable");
ok(readReply(reply([]), routes).ok && readReply(reply([]), routes).ours === false, "an empty resources array is a readable absence");

// ---- decision, ack and the issue -------------------------------------------
const row = (query, present, matches = false, okk = true) => ({ query, ok: okk, present, matches });
let d = decide([row("web search", true), row("hash", true)]);
ok(d.status === "measured" && d.lines.length === 0, "every query present is clean");
d = decide([row("web search", false, true), row("hash", false, false), row("base64", true)]);
ok(d.lines.length === 2 && d.lines[0].includes("hash") && d.lines[1].includes("web search"), "each absent query is one sorted line");
ok(d.lines.every((l) => !/\d/.test(l.replace(/^- Absent: [a-z0-9 ]+/, ""))), "a line carries no number");
ok(d.lines.some((l) => /web search \(our listing matches this query but/.test(l)) && d.lines.some((l) => /hash \(our listing does not match/.test(l)), "a line says whether our listing matches the query");
d = decide([row("web search", false), row("hash", undefined, false, false)]);
ok(d.status === "unmeasured" && d.lines.length === 0, "any unreadable query makes the run unmeasured with no lines");
ok(decide([]).status === "unmeasured", "a run with no query is unmeasured");
const ack = parseAck(" Web  Search , hash ,,");
ok(ack.has("web search") && ack.has("hash") && ack.size === 2, "the ack list is a trimmed, lower-cased comma list");
d = decide([row("web search", false), row("hash", false), row("base64", false)], ack);
ok(d.lines.length === 1 && d.lines[0].includes("base64"), "an acknowledged query does not page");

const RUN = "https://github.com/o/r/actions/runs/1";
const body = issueBody(d.lines, RUN);
ok(linesFromBody(body).join("\n") === d.lines.join("\n"), "the reason set is read back from the issue body");
ok(body.includes("BAZAAR_RANK_ACK") && body.includes(`Run: ${RUN}`), "the body names the ack variable and links the run");
ok(!/\|/.test(body) && !/\d/.test(body.replace(RUN, "").replace(/^- Absent: [a-z0-9 ]+/gm, "")), "the body has no table and no number outside our query text");
const measured = (lines) => ({ status: "measured", lines });
ok(issueAction(measured(d.lines), null) === "open", "a new reason with no open issue opens it");
ok(issueAction(measured(d.lines), body) === "none", "the same set again does nothing");
ok(issueAction(measured([...d.lines, "- Absent: zzz (our listing does not match this query)"].sort()), body) === "update", "a changed set updates");
ok(issueAction(measured([]), body) === "close", "nothing left closes");
ok(issueAction(measured([]), null) === "none", "nothing left and nothing open does nothing");
ok(issueAction({ status: "unmeasured", lines: [] }, body) === "none", "an unmeasured run never closes the issue");
ok(issueAction({ status: "unmeasured", lines: [] }, null) === "none", "an unmeasured run never opens the issue");

// ---- only a measured query clears its line ----------------------------------
ok(queryOfLine("- Absent: web search (our listing does not match this query)") === "web search", "a line's query text is read back");
ok(queryOfLine("- Absent: a (b) (our listing matches this query but none of our routes comes back)") === "a (b)", "the query is read up to the fixed reason words");
ok(queryOfLine("- Absent: x (something else)") === "" && queryOfLine("hello") === "", "a line that is not ours reads as no query");
{
  // Week one: the demand query "hash" is absent; the issue opens.
  const wk1 = decide([row("web search", true), row("chat completion", true), row("hash", false)]);
  ok(issueAction(keepUnmeasured(wk1, null), null) === "open", "week one: an absent demand query opens the issue");
  const open1 = issueBody(wk1.lines, RUN);
  // Week two: "hash" left the top-tools ranking, so it is not measured.
  const q2 = buildQueries(top.filter((t) => t.slug !== "hash" && t.slug !== "dup"), endpoints);
  ok(!q2.some((q) => q.query === "hash"), "week two's query list does not hold the query that left the ranking");
  let wk2 = keepUnmeasured(decide(q2.map((q) => row(q.query, true))), open1);
  ok(wk2.lines.length === 1 && wk2.lines[0].includes("hash"), "a query not measured this run keeps its line");
  ok(issueAction(wk2, open1) === "none", "an absent query that drops out of the ranking does not close or edit the issue");
  // The ranking could not be read: only the flagships are measured.
  const q3 = buildQueries(undefined, endpoints);
  ok(q3.length === FLAGSHIPS.length, "a missing ranking measures only the flagships");
  wk2 = keepUnmeasured(decide(q3.map((q) => row(q.query, true))), open1);
  ok(issueAction(wk2, open1) === "none" && wk2.lines.length === 1, "a missing ranking leaves the demand lines and does not close");
  // Measured again and present: now it clears.
  wk2 = keepUnmeasured(decide([row("web search", true), row("chat completion", true), row("hash", true)]), open1);
  ok(issueAction(wk2, open1) === "close", "a measured query that is present clears its line and closes");
  // A measured flagship clears while an unmeasured demand line stays.
  const open2 = issueBody(decide([row("web search", false), row("hash", false)]).lines, RUN);
  wk2 = keepUnmeasured(decide(q3.map((q) => row(q.query, true))), open2);
  ok(issueAction(wk2, open2) === "update" && wk2.lines.length === 1 && wk2.lines[0].includes("hash"), "a measured flagship clears its own line only");
  // An acknowledged query's kept line is dropped.
  wk2 = keepUnmeasured(decide(q3.map((q) => row(q.query, true))), open1, parseAck("hash"));
  ok(issueAction(wk2, open1) === "close", "an acknowledged query's unmeasured line does not hold the issue open");
  // An unmeasured run still changes nothing.
  ok(issueAction(keepUnmeasured(decide([row("web search", undefined, false, false)]), open1), open1) === "none", "an unmeasured run still changes nothing");
}

// ---- fetch: retry 5xx and timeouts only -------------------------------------
const noSleep = async () => {};
const stub = (answers) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return { ok: a.status === 200, status: a.status, json: async () => a.body };
  };
  return { calls, fetchImpl };
};
const failsWith = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
let s = stub([{ status: 404 }, { status: 200, body: {} }]);
ok(await failsWith(getJson("https://x/", { fetchImpl: s.fetchImpl, sleep: noSleep })) === "HTTP 404" && s.calls.length === 1, "a 4xx is not retried");
s = stub([{ status: 503 }, { status: 200, body: { y: 1 } }]);
ok((await getJson("https://x/", { fetchImpl: s.fetchImpl, sleep: noSleep })).y === 1 && s.calls.length === 2, "a 5xx is retried");
const te = Object.assign(new Error("t"), { name: "TimeoutError" });
s = stub([te, { status: 200, body: { y: 2 } }]);
ok((await getJson("https://x/", { fetchImpl: s.fetchImpl, sleep: noSleep })).y === 2 && s.calls.length === 2, "a timeout is retried");
s = stub([{ status: 500 }, { status: 500 }, { status: 200, body: {} }]);
ok(await failsWith(getJson("https://x/", { fetchImpl: s.fetchImpl, sleep: noSleep })) === "HTTP 500" && s.calls.length === 2, "retries are bounded");
s = stub([{ status: 200, body: {} }]);
ok(await failsWith(getJson("https://x/", { fetchImpl: s.fetchImpl, sleep: noSleep, deadline: 0 })) === "deadline" && s.calls.length === 0, "no fetch starts past the run deadline");

const flag = [{ query: "web search", flagship: true }];
s = stub([{ status: 200, body: reply(["https://agent402.tools/api/search"], { partialResults: true }) }]);
let m = await measure(flag, routes, { fetchImpl: s.fetchImpl, sleep: noSleep });
ok(m[0].ok === false && decide(m).status === "unmeasured", "a partial reply in a run makes it unmeasured");
s = stub([{ status: 200, body: { data: [] } }]);
m = await measure(flag, routes, { fetchImpl: s.fetchImpl, sleep: noSleep });
ok(m[0].ok === false, "a reply without resources in a run is unreadable");
s = stub([{ status: 200, body: reply(["https://agent402.tools/api/search"]) }]);
m = await measure(flag, routes, { fetchImpl: s.fetchImpl, sleep: noSleep });
ok(m[0].ok && m[0].present && s.calls.length === 1, "present needs one call");
s = stub([{ status: 200, body: reply(["https://xagent402.tools/api/search"]) }, { status: 200, body: reply(["https://agent402.tools/api/search"]) }]);
m = await measure(flag, routes, { fetchImpl: s.fetchImpl, sleep: noSleep });
ok(m[0].ok && !m[0].present && m[0].matches && /urlSubstring=agent402\.tools/.test(s.calls[1]), "absent asks the host-limited search whether our listing matches");
s = stub([{ status: 400 }]);
m = await measure(flag, routes, { fetchImpl: s.fetchImpl, sleep: noSleep });
ok(!m[0].ok && s.calls.length === 1, "a 4xx in a run is one call and unreadable");

// ---- the workflow ----------------------------------------------------------------
const wf = readFileSync(new URL("../.github/workflows/bazaar-rank.yml", import.meta.url), "utf8");
const cron = (wf.match(/cron:\s*"([^"]+)"/) || [])[1] || "";
const f = cron.split(/\s+/);
ok(f.length === 5 && f[2] === "*" && /^[0-6]$/.test(f[4]), `weekly cron (${cron})`);
ok(/workflow_dispatch:/.test(wf), "it can be dispatched");
const tmin = Number((wf.match(/timeout-minutes:\s*(\d+)/) || [])[1]);
ok(tmin > 0 && WORST_CASE_MS + 3 * 60_000 <= tmin * 60_000, `the script's worst case plus setup fits timeout-minutes (${tmin})`);
ok(/contents:\s*read/.test(wf) && !/contents:\s*write/.test(wf), "it never writes to the repo");
ok(!/git (commit|push)/.test(wf), "no commit or push step");
ok(!/upload-artifact|gh run download|actions:\s*read/.test(wf), "no history artifact is kept or read");
ok(/node scripts\/bazaar-rank-monitor\.js/.test(wf), "it runs the check script");
ok(/BAZAAR_RANK_ACK:\s*\$\{\{\s*vars\.BAZAAR_RANK_ACK\s*\}\}/.test(wf), "the ack list is the repository variable");
ok(/--body-file out\/body\.md/.test(wf) && !/cat out\/(report|body)/.test(wf), "the issue body is the script's fixed body file, never echoed to the log");
ok(/Not measured this week\./.test(wf), "an unmeasured run says so in its own summary");
const title = (wf.match(/TITLE:\s*(.+)/) || [])[1]?.trim() || "";
ok(title !== "" && !/\$|\d/.test(title), `one fixed issue title with no counts (${title})`);
ok(/gh issue create/.test(wf) && /gh issue edit/.test(wf) && /gh issue comment/.test(wf) && /gh issue close/.test(wf), "opens one issue, updates it on a changed set, closes it when clean");
ok((wf.match(/gh issue create/g) || []).length === 1, "exactly one place opens an issue");
for (const mm of wf.matchAll(/uses:\s*([^\s#]+)/g)) ok(/@[0-9a-f]{40}$/.test(mm[1]), `action pinned to a commit (${mm[1].split("@")[0]})`);

// ---- the workflow's issue step, run with a stub gh and a stub node ----------
{
  const { writeFileSync, mkdtempSync, chmodSync, rmSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const jqOk = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;
  ok(jqOk, "jq is installed (the stub gh applies the workflow's --jq with it)");
  const lines = wf.split("\n");
  const at = lines.findIndex((l) => /- name: Check and update the one issue/.test(l));
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  const indent = lines[runAt + 1].match(/^\s*/)[0].length;
  const stepLines = [];
  for (let i = runAt + 1; i < lines.length && (lines[i].trim() === "" || lines[i].match(/^\s*/)[0].length >= indent); i++) stepLines.push(lines[i].slice(indent));
  const script = stepLines.join("\n");
  ok(at > 0 && script.includes("gh issue list") && script.includes("gh issue create"), "the issue step's script is read from the workflow");
  const dir = mkdtempSync(join(tmpdir(), "bazaar-rank-wf-"));
  // gh: "issue list" applies the step's own --jq to GH_STUB_ISSUES; every call is logged.
  writeFileSync(join(dir, "gh"), `#!/bin/bash
printf '%s\\n' "gh $1 $2 $3" >> "$GH_STUB_LOG"
if [ "$1 $2" = "issue list" ]; then
  EXPR=""; while [ $# -gt 0 ]; do if [ "$1" = "--jq" ]; then shift; EXPR="$1"; fi; shift; done
  printf '%s' "$GH_STUB_ISSUES" | jq -r "$EXPR"
elif [ "$1 $2" = "issue view" ]; then printf 'body\\n'; fi
`);
  // node: writes the action the test asks for.
  writeFileSync(join(dir, "node"), `#!/bin/bash
printf '%s\\n' "node $*" >> "$GH_STUB_LOG"
OUT=""; while [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then shift; OUT="$1"; fi; shift; done
mkdir -p "$OUT"; printf '%s\\n' "$STUB_ACTION" > "$OUT/action.txt"; printf 'measured\\n' > "$OUT/status.txt"; printf 'b\\n' > "$OUT/body.md"
`);
  chmodSync(join(dir, "gh"), 0o755); chmodSync(join(dir, "node"), 0o755);
  const run = (issues, action) => {
    const cwd = mkdtempSync(join(tmpdir(), "bazaar-rank-cwd-"));
    const log = join(cwd, "calls.log");
    writeFileSync(log, "");
    const r = spawnSync("bash", ["-e", "-c", script], { cwd, encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", GITHUB_STEP_SUMMARY: join(cwd, "summary.md"), RUN_URL: "https://run.example/1", TITLE: title, GH_STUB_ISSUES: JSON.stringify(issues), GH_STUB_LOG: log, STUB_ACTION: action } });
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    rmSync(cwd, { recursive: true, force: true });
    return { status: r.status, err: r.stderr, calls };
  };
  const bot = { number: 5, title, author: { login: "app/github-actions" } };
  const stranger = { number: 9, title, author: { login: "someone-else" } };
  let w = run([stranger, bot], "close");
  ok(w.status === 0 && w.calls.includes("gh issue view 5") && w.calls.includes("gh issue close 5") && !w.calls.some((c) => / 9$/.test(c)), `with a newer issue by another account under the title, the bot's issue is the one read and closed (${w.calls.join("; ")}) ${w.err.slice(0, 160)}`);
  w = run([stranger], "open");
  ok(w.status === 0 && !w.calls.some((c) => c.startsWith("gh issue view")) && w.calls.some((c) => c.startsWith("node ") && !c.includes("--issue-body")) && w.calls.includes("gh issue create --repo"), `with only another account's issue under the title, a new issue is opened (${w.calls.join("; ")})`);
  w = run([{ ...bot, author: { login: "github-actions[bot]" } }], "update");
  ok(w.calls.includes("gh issue edit 5") && w.calls.includes("gh issue comment 5"), "the bot's login in either spelling is ours");
  w = run([{ ...bot, title: `${title} (copy)` }], "open");
  ok(w.calls.includes("gh issue create --repo"), "a bot issue under another title is not ours");
  rmSync(dir, { recursive: true, force: true });
}

// ---- the script prints nothing about the search -----------------------------
const src = readFileSync(new URL("./bazaar-rank-monitor.js", import.meta.url), "utf8");
const logs = [...src.matchAll(/console\.(log|error|warn)\(([^;]*)\);/g)].map((x) => x[2]);
ok(/result = keepUnmeasured\(decide\(rows, ack\), openBody, ack\)/.test(src), "the run keeps the open issue's unmeasured lines");
ok(/let topTools = null;\s*try \{\s*const stats = await getJson\(`\$\{base\}\/api\/stats`, \{ deadline \}\);\s*if \(Array\.isArray\(stats\?\.topTools\)\) topTools = stats\.topTools;\s*\} catch \{/.test(src), "an unreadable ranking is caught on its own, so the flagships are still measured");
ok(logs.length >= 1 && logs.every((a) => !/rows|lines|reply|resources|query/.test(a)), "the script's log lines carry no rows, queries or replies");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
