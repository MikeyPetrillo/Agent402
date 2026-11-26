#!/usr/bin/env node
// A check that fails again soon after its issue closed reopens that issue.
//
// One rule (workers/status-probe/src/reopen-window.js), two readers: the
// workflows' opener, scripts/check-issue.js, and the status Worker. Offline,
// with the GitHub reads and writes stubbed:
//   1. the rule: same exact title, trusted author, closed inside the window,
//      most recent first; a stranger's, another title's or an old one is not;
//   2. the opener: an open issue gets the fixed comment (no create); one
//      closed 2 days ago is reopened with the fixed text (no create); one
//      closed 9 days ago, or one under another title, leaves a new issue
//      filed; an unreadable closed list files a new one; the saved-state body
//      file rides along;
//   3. the Worker: the same cases through syncOutage and syncAlarms.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { OPEN_BODY_RE, STILL_BODY_RE } from "./lib/monitor-issue-text.js";
import { REOPEN_WINDOW_DAYS, reopenCandidate } from "../workers/status-probe/src/reopen-window.js";
import { fileCheckIssue } from "./check-issue.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const NOW = Date.parse("2026-11-26T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400_000).toISOString();
const T = "Scheduled check needs review: tool-failures";
const OTHER = "Scheduled check needs review: listing-presence";

// ---- 1. the rule -----------------------------------------------------------------
ok(REOPEN_WINDOW_DAYS === 7, "the window is seven days");
const row = (number, closedDays, extra = {}) => ({ number, title: T, author: "github-actions[bot]", closedAt: daysAgo(closedDays), state: "closed", ...extra });
ok(reopenCandidate([row(1, 2)], { title: T, now: NOW }) === 1, "closed 2 days ago: reopened");
ok(reopenCandidate([row(1, 9)], { title: T, now: NOW }) === null, "closed 9 days ago: not reopened");
ok(reopenCandidate([row(1, 5), row(2, 1), row(3, 3)], { title: T, now: NOW }) === 2, "the most recently closed one is taken");
ok(reopenCandidate([row(1, 1, { title: OTHER })], { title: T, now: NOW }) === null, "another title's issue is not taken");
ok(reopenCandidate([row(1, 1, { title: `${T} (b)` })], { title: T, now: NOW }) === null, "a title that only starts the same is not taken");
ok(reopenCandidate([row(1, 1, { author: "stranger" })], { title: T, now: NOW }) === null, "a stranger's issue under the title is not taken");
ok(reopenCandidate([row(1, 1, { author: "Probe-Bot" })], { title: T, trusted: ["probe-bot"], now: NOW }) === 1, "the trusted account's issue is taken, in any case");
ok(reopenCandidate([row(1, 1, { state: "open" }), { ...row(2, 1), closedAt: null }], { title: T, now: NOW }) === null, "an open row or one with no close time is not a reopen");

// ---- 2. the opener ----------------------------------------------------------------
const gh = ({ open = [], closed = [], failClosed = false } = {}) => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[1] === "list") {
      const state = args[args.indexOf("--state") + 1];
      if (state === "closed" && failClosed) throw new Error("HTTP 502");
      return JSON.stringify((state === "open" ? open : closed).map((r) => ({ ...r, author: { login: r.author } })));
    }
    return args[1] === "create" ? "https://github.com/o/r/issues/99\n" : "";
  };
  return { calls, run };
};
const file = (g, over = {}) => fileCheckIssue({ repo: "o/r", title: T, runUrl: "https://github.com/o/r/actions/runs/7", now: NOW, run: g.run, log: () => {}, ...over });
const writes = (g) => g.calls.filter((a) => a[1] !== "list");
const flag = (a, f) => a[a.indexOf(f) + 1];
{
  const g = gh({ open: [{ number: 4, title: T, author: "app/github-actions" }] });
  const r = file(g);
  const w = writes(g);
  ok(r.action === "commented" && w.length === 1 && w[0][1] === "comment" && w[0][2] === "4" && STILL_BODY_RE.test(flag(w[0], "--body")), `an open issue gets the fixed comment and nothing is filed (${JSON.stringify(w)})`);
}
{
  const g = gh({ closed: [row(12, 2)] });
  const r = file(g);
  const w = writes(g);
  const reopen = w.find((a) => a[1] === "reopen");
  const edit = w.find((a) => a[1] === "edit");
  ok(r.action === "reopened" && r.number === 12 && !w.some((a) => a[1] === "create"), "closed 2 days ago: reopened, no create");
  ok(reopen && reopen[2] === "12" && STILL_BODY_RE.test(flag(reopen, "--comment")), "the reopen carries the fixed still-needs-review comment");
  ok(edit && edit[2] === "12" && OPEN_BODY_RE.test(flag(edit, "--body")), "the reopened body starts over as the fixed opening text");
  const search = g.calls.find((a) => a[1] === "list" && flag(a, "--state") === "closed");
  ok(search && /closedAt/.test(flag(search, "--json")) && flag(search, "--search").includes(`"${T}"`), "the closed issues are read by title with their close times");
}
{
  const g = gh({ closed: [row(12, 9)] });
  const r = file(g);
  const w = writes(g);
  ok(r.action === "created" && w.length === 1 && w[0][1] === "create" && flag(w[0], "--title") === T && OPEN_BODY_RE.test(flag(w[0], "--body")), "closed 9 days ago: a new issue with the fixed text");
}
{
  const g = gh({ closed: [row(12, 1, { title: OTHER })], open: [{ number: 3, title: OTHER, author: "app/github-actions" }] });
  const w = (file(g), writes(g));
  ok(w.length === 1 && w[0][1] === "create" && !w.some((a) => a.includes("12") || a.includes("3")), "another title's issues, open or closed, are untouched");
}
{
  const g = gh({ closed: [row(12, 1)], failClosed: true });
  const r = file(g);
  ok(r.action === "created", "an unreadable closed list files a new issue, as before");
}
{
  const g = gh({ closed: [row(12, 1)] });
  file(g, { bodyFile: "out/body.md" });
  const w = writes(g);
  ok(w[0][1] === "edit" && flag(w[0], "--body-file") === "out/body.md" && w[1][1] === "reopen", "a saved-state check reopens with its state file as the body");
}
{
  let threw = false;
  try { fileCheckIssue({ repo: "", title: T, run: () => "[]", log: () => {} }); } catch { threw = true; }
  ok(threw, "no repository: refused before any call");
}

// ---- 3. the Worker ------------------------------------------------------------------
const { syncOutage, syncAlarms, DOWN_TITLE } = await import("../workers/status-probe/src/index.js");
const realFetch = globalThis.fetch, realLog = console.log;
const worker = async (closedRows, fn) => {
  const writesSeen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (/\/issues\?state=closed/.test(u)) return Response.json(closedRows.map((r) => ({ number: r.number, title: r.title, user: { login: r.author }, closed_at: r.closedAt, state: "closed" })));
    if (init.method === "POST" || init.method === "PATCH") { writesSeen.push({ url: u, method: init.method, body: JSON.parse(init.body) }); return Response.json({ number: 1 }, { status: 201 }); }
    return Response.json([]);
  };
  console.log = () => {};
  try { return { r: await fn(), writes: writesSeen }; } finally { globalThis.fetch = realFetch; console.log = realLog; }
};
const ENV = { GITHUB_ISSUES_TOKEN: "t", GITHUB_ISSUES_LOGIN: "probe-bot" };
const outage = (rows) => worker(rows, () => { const open = new Map(); open.bodies = new Map(); return syncOutage(ENV, { apiFailed: true, sleep: async () => {}, confirmDelayMs: 0, healthRead: async () => false, openList: open }); });
const NEUTRAL = /^A scheduled check reported a result that needs review\. Observed by the status probe at \S+Z, confirmed by a second reading\. This issue closes when the check next passes, or by hand after review\.$/;
{
  const { r, writes: w } = await outage([{ number: 51, title: DOWN_TITLE, author: "probe-bot", closedAt: new Date(Date.now() - 2 * 86400_000).toISOString() }]);
  ok(r.action === "reopened" && w.length === 1 && w[0].method === "PATCH" && /\/issues\/51$/.test(w[0].url) && w[0].body.state === "open" && NEUTRAL.test(w[0].body.body), `Worker: closed 2 days ago is reopened with the fixed text, no create (${JSON.stringify(w)})`);
}
{
  const { r, writes: w } = await outage([{ number: 51, title: DOWN_TITLE, author: "probe-bot", closedAt: new Date(Date.now() - 9 * 86400_000).toISOString() }]);
  ok(r.action === "opened" && w.length === 1 && w[0].method === "POST" && w[0].body.title === DOWN_TITLE && NEUTRAL.test(w[0].body.body), "Worker: closed 9 days ago, a new issue");
}
{
  const { writes: w } = await outage([{ number: 52, title: OTHER, author: "probe-bot", closedAt: new Date(Date.now() - 86400_000).toISOString() }, { number: 53, title: DOWN_TITLE, author: "stranger", closedAt: new Date(Date.now() - 86400_000).toISOString() }]);
  ok(w.length === 1 && w[0].method === "POST" && !w.some((x) => /\/(52|53)$/.test(x.url)), "Worker: another title's or a stranger's closed issue is untouched");
}
{
  const reading = { gateway: { status: "ok", toolFailures: { status: "failing" } }, status: null };
  const { r, writes: w } = await worker([{ number: 61, title: T, author: "github-actions[bot]", closedAt: new Date(Date.now() - 2 * 86400_000).toISOString() }], () => {
    const open = new Map(); open.bodies = new Map();
    return syncAlarms(ENV, { fetchStatus: async () => reading, sleep: async () => {}, confirmDelayMs: 0, openList: open });
  });
  const mine = w.filter((x) => /\/issues\/61$/.test(x.url));
  ok(r.opened.includes(T) && r.reopened.includes(T) && mine.length === 1 && mine[0].body.state === "open" && !w.some((x) => x.method === "POST" && x.body.title === T), `Worker alarms: the check's issue closed 2 days ago is reopened, not filed again (${JSON.stringify(r.opened)})`);
}
{
  // An open issue is today's path: no closed read, no reopen, no create.
  let closedReads = 0;
  globalThis.fetch = async (url, init = {}) => { if (/state=closed/.test(String(url))) closedReads++; if (init.method) return Response.json({}); return Response.json([]); };
  console.log = () => {};
  try {
    const open = new Map([[T, 70]]); open.bodies = new Map([[T, ""]]);
    const r = await syncAlarms(ENV, { fetchStatus: async () => ({ gateway: { status: "ok", toolFailures: { status: "failing" } }, status: null }), sleep: async () => {}, confirmDelayMs: 0, openList: open });
    ok(!r.opened.includes(T) && closedReads === 0, "Worker alarms: an open issue is left as today, with no closed-issue read");
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
}

console.log(`\ncheck-issue reopen: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
