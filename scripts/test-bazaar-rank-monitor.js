// The weekly check of our own Bazaar listing: query list, the "ours" test,
// reply reading, retries, the issue lines and action, on fixtures (offline),
// plus the workflow's schedule, its single fixed-title issue, its time budget
// and that it keeps and prints nothing about the search.
//
//   node scripts/test-bazaar-rank-monitor.js
import { readFileSync } from "node:fs";
import {
  FLAGSHIPS, WORST_CASE_MS, queryFromName, buildQueries, ourRoutes, isOurs, readReply, parseAck,
  decide, issueBody, linesFromBody, issueAction, getJson, measure,
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
ok(qs.length === FLAGSHIPS.length + 8, `two flagships plus eight by demand (${qs.length})`);
ok(qs[0].query === "web search" && qs[1].query === "chat completion" && qs[0].flagship && qs[1].flagship, "the fixed flagship queries lead");
ok(qs.slice(2).every((q) => !q.flagship), "the rest come from demand");
ok(!qs.slice(2).some((q) => q.slug === "v1-chat-metered"), "a flagship slug in the demand list is not counted twice");
ok(!qs.some((q) => q.slug === "gone"), "a slug the catalog no longer lists is skipped");
ok(!qs.some((q) => q.slug === "dup"), "a slug that phrases like an earlier one is kept once");
ok(qs.slice(2).map((q) => q.slug).join(",") === "hash,base64,uuid,a,b,c,d,e", `demand order follows the ranking (${qs.slice(2).map((q) => q.slug).join(",")})`);
ok(buildQueries([], endpoints).length === 2, "no demand data still checks the flagships");

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

// ---- the script prints nothing about the search -----------------------------
const src = readFileSync(new URL("./bazaar-rank-monitor.js", import.meta.url), "utf8");
const logs = [...src.matchAll(/console\.(log|error|warn)\(([^;]*)\);/g)].map((x) => x[2]);
ok(logs.length >= 1 && logs.every((a) => !/rows|lines|reply|resources|query/.test(a)), "the script's log lines carry no rows, queries or replies");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
