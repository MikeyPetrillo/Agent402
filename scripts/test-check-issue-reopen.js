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
ok(reopenCandidate([{ ...row(1, 0), closedAt: new Date(NOW + 3600_000).toISOString() }], { title: T, now: NOW }) === null, "a close time in the future (a clock that is off) is not a reopen");
ok(reopenCandidate([{ ...row(1, 0), closedAt: new Date(NOW + 30_000).toISOString() }], { title: T, now: NOW }) === 1, "a close time a few seconds ahead (clock skew) still is");
ok(reopenCandidate([row(1, 1, { state: "open" }), { ...row(2, 1), closedAt: null }], { title: T, now: NOW }) === null, "an open row or one with no close time is not a reopen");

// ---- 2. the opener ----------------------------------------------------------------
const gh = ({ open = [], closed = [], failClosed = false, failWrite = null } = {}) => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (failWrite === args[1]) throw new Error("HTTP 403");
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
  // An outsider's OPEN issue under the exact title is not the check's: it gets
  // no comment and no body, and the check's own issue is filed.
  const g = gh({ open: [{ number: 8, title: T, author: "stranger" }] });
  const r = file(g);
  const w = writes(g);
  ok(r.action === "created" && w.length === 1 && w[0][1] === "create" && !w.some((a) => a.includes("8")), `an outsider's open issue under the title is never touched; a new one is filed (${JSON.stringify(w)})`);
  const g2 = gh({ open: [{ number: 8, title: T, author: "stranger" }] });
  file(g2, { bodyFile: "out/body.md" });
  ok(!writes(g2).some((a) => a[1] === "edit"), "and its body is never replaced with the check's state");
}
{
  // The owner's account: trusted only when the call says so (--trust-owner,
  // passed exactly where the step's own lookup keeps the owner's issues).
  const ownerOpen = { open: [{ number: 21, title: T, author: "o" }] };
  const g = gh(ownerOpen);
  const r = file(g);
  const w = writes(g);
  ok(r.action === "created" && w.length === 1 && w[0][1] === "create" && !w.some((a) => a.includes("21")), `by default an owner-filed open issue gets no comment and no edit; the check files its own (${JSON.stringify(w)})`);
  const g2 = gh(ownerOpen);
  file(g2, { bodyFile: "out/body.md" });
  ok(!writes(g2).some((a) => a.includes("21")), "and its body is never replaced with the check's state");
  const g3 = gh({ ...ownerOpen, open: [...ownerOpen.open, { number: 22, title: T, author: "github-actions[bot]" }] });
  const r3 = file(g3);
  ok(r3.action === "commented" && r3.number === 22 && !writes(g3).some((a) => a.includes("21")), "beside it, the bot's own open issue is the one updated");
  const g4 = gh({ closed: [row(23, 1, { author: "o" })] });
  ok(file(g4).action === "created" && !writes(g4).some((a) => a.includes("23")), "by default an owner-filed closed issue is not reopened");
  const g5 = gh(ownerOpen);
  ok(file(g5, { trustOwner: true }).action === "commented" && writes(g5)[0][2] === "21", "with trustOwner (the step's lookup keeps the owner's issues) it is the check's issue");
  const g6 = gh({ closed: [row(23, 1, { author: "o" })] });
  ok(file(g6, { trustOwner: true }).action === "reopened", "and a closed one is reopened");
}
{
  // The command line: --trust-owner reaches the opener (a stand-in gh on PATH).
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "a402-opener-"));
  writeFileSync(join(dir, "gh"), `#!/bin/bash\necho "$1 $2 $3" >> "$GH_LOG"\nif [ "$1 $2" = "issue list" ]; then case "$*" in *"--state open"*) printf '[{"number":21,"title":"${T}","author":{"login":"o"}}]';; *) printf '[]';; esac; fi\n`);
  chmodSync(join(dir, "gh"), 0o755);
  const cli = (extra) => {
    const log = join(dir, `log-${extra.length}`);
    writeFileSync(log, "");
    const r = spawnSync(process.execPath, [new URL("./check-issue.js", import.meta.url).pathname, "--title", T, ...extra], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_LOG: log, GITHUB_REPOSITORY: "o/r" } });
    return { status: r.status, calls: readFileSync(log, "utf8").trim().split("\n") };
  };
  const plain = cli([]), owned = cli(["--trust-owner"]);
  ok(plain.status === 0 && plain.calls.includes("issue create --repo") && !plain.calls.some((c) => c.includes("21")), `the command line without --trust-owner leaves the owner's issue alone (${plain.calls.join("; ")})`);
  ok(owned.status === 0 && owned.calls.includes("issue comment 21") && !owned.calls.some((c) => c.startsWith("issue create")), `with --trust-owner it is the check's issue (${owned.calls.join("; ")})`);
  rmSync(dir, { recursive: true, force: true });
}
{
  // A reopen that fails files a new issue: never silence.
  for (const verb of ["reopen", "edit"]) {
    const g = gh({ closed: [row(12, 2)], failWrite: verb });
    const r = file(g);
    const w = writes(g);
    ok(r.action === "created" && w.at(-1)[1] === "create" && OPEN_BODY_RE.test(flag(w.at(-1), "--body")), `a failed ${verb} on the closed issue files a new issue with the fixed text`);
  }
  const g = gh({ closed: [row(12, 2)] });
  ok(file(g).action === "reopened" && !writes(g).some((a) => a[1] === "create"), "a reopen that succeeds files nothing new");
}
{
  let threw = false;
  try { fileCheckIssue({ repo: "", title: T, run: () => "[]", log: () => {} }); } catch { threw = true; }
  ok(threw, "no repository: refused before any call");
}

// ---- 3. the Worker ------------------------------------------------------------------
const { syncOutage, syncAlarms, DOWN_TITLE } = await import("../workers/status-probe/src/index.js");
const realFetch = globalThis.fetch, realLog = console.log;
const worker = async (closedRows, fn, { patchStatus = 201, patchThrows = false } = {}) => {
  const writesSeen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "PATCH") { writesSeen.push({ url: u, method: init.method, body: JSON.parse(init.body) }); if (patchThrows) throw new Error("network"); return Response.json({}, { status: patchStatus }); }
    if (/\/issues\?state=closed/.test(u)) return Response.json(closedRows.map((r) => ({ number: r.number, title: r.title, user: { login: r.author }, closed_at: r.closedAt, state: "closed" })));
    if (init.method === "POST" || init.method === "PATCH") { writesSeen.push({ url: u, method: init.method, body: JSON.parse(init.body) }); return Response.json({ number: 1 }, { status: 201 }); }
    return Response.json([]);
  };
  console.log = () => {};
  try { return { r: await fn(), writes: writesSeen }; } finally { globalThis.fetch = realFetch; console.log = realLog; }
};
const ENV = { GITHUB_ISSUES_TOKEN: "t", GITHUB_ISSUES_LOGIN: "probe-bot" };
const outage = (rows, opts) => worker(rows, () => { const open = new Map(); open.bodies = new Map(); return syncOutage(ENV, { apiFailed: true, sleep: async () => {}, confirmDelayMs: 0, healthRead: async () => false, openList: open }); }, opts);
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
for (const opts of [{ patchStatus: 403 }, { patchThrows: true }]) {
  const { r, writes: w } = await outage([{ number: 51, title: DOWN_TITLE, author: "probe-bot", closedAt: new Date(Date.now() - 2 * 86400_000).toISOString() }], opts);
  ok(r.action === "opened" && w.length === 2 && w[0].method === "PATCH" && w[1].method === "POST" && w[1].body.title === DOWN_TITLE && NEUTRAL.test(w[1].body.body), `Worker: a reopen that ${opts.patchThrows ? "throws" : "is refused"} files a new issue instead`);
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
  // Budget: a failed reopen is two writes (PATCH, then POST). With every bad
  // alarm a reopen candidate and every PATCH answering 500, the run's
  // subrequests stay within the cap and every open is made or deferred by name.
  const { judge, MAX_ISSUE_WRITES } = await import("../workers/status-probe/src/index.js");
  const words = ["low", "failing", "reached", "elevated", "repeating", "widespread", "degraded", "unresolved", "in_doubt", "owed", "stalled", "down", "bad", "failed", "high", "exhausted"];
  const fields = ["upstreamBuyer", "upstreamBuyerAvm", "upstreamBuyerEvm", "upstreamBuyerTempo", "upstreamBuyerSvm", "stellarFacilitator", "upstreamBudgets", "toolFailures", "upstreamHealth", "facilitatorFunds", "toolAnswers", "containedTurns", "brokenListings", "directUpstream", "directUpstreamSpend", "directUpstreamBalance", "creditsRefunds", "lateSettlements", "refundsOwed", "tweetQueue", "operatorAuth"];
  const gw = { status: "ok" };
  const badCount = (g) => Object.values(judge({ gateway: g, status: null })).filter((v) => v === "bad").length;
  for (const f of fields) for (const w of words) { const t = { ...gw, [f]: { status: w } }; if (badCount(t) > badCount(gw)) { gw[f] = { status: w }; break; } }
  const bad = Object.entries(judge({ gateway: gw, status: null })).filter(([, v]) => v === "bad").map(([t]) => t);
  ok(bad.length >= 15, `the crafted reading turns at least 15 alarms bad (${bad.length})`);
  let subrequests = 0, posts = 0, patches = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (new URL(u).hostname === "api.github.com") subrequests++;
    if (/state=closed/.test(u)) return Response.json(bad.map((title, i) => ({ number: 300 + i, title, user: { login: "github-actions[bot]" }, closed_at: new Date(Date.now() - 86400_000).toISOString(), state: "closed" })));
    if (init.method === "PATCH") { patches++; return Response.json({}, { status: 500 }); }
    if (init.method === "POST") { posts++; return Response.json({ number: 1 }, { status: 201 }); }
    return Response.json([]);
  };
  console.log = () => {};
  let r;
  try {
    // One recovered alarm with an open issue: its close must wait behind the deferred opens.
    const good = Object.entries(judge({ gateway: gw, status: null })).find(([, v]) => v === "good")?.[0];
    const open = new Map(good ? [[good, 400]] : []); open.bodies = new Map(good ? [[good, ""]] : []);
    r = await syncAlarms(ENV, { fetchStatus: async () => ({ gateway: gw, status: null }), sleep: async () => {}, confirmDelayMs: 0, openList: open });
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
  {
    ok(subrequests <= MAX_ISSUE_WRITES, `failed reopens stay within the write cap (${subrequests} GitHub subrequests, cap ${MAX_ISSUE_WRITES})`);
    ok(posts === patches && r.opened.length === posts && r.reopened.length === 0, `each failed reopen is replaced by a create (${patches} PATCH, ${posts} POST, ${r.opened.length} opened)`);
    ok(r.deferred.length > 0 && r.closed.length === 0 && (r.clearing || []).length === 0, `opens stay first: no close is written while an open waits (${r.closed.length} closed)`);
    const accounted = new Set([...r.opened, ...r.deferred]);
    ok(bad.every((t) => accounted.has(t)), `no open is dropped: every bad alarm is opened or deferred by name (${r.opened.length} opened, ${r.deferred.length} deferred)`);
  }
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
