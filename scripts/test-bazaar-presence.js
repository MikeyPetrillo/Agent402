#!/usr/bin/env node
// The Bazaar presence check (scripts/bazaar-presence.js and
// .github/workflows/bazaar-presence.yml): which missing routes it buys, which
// it never buys, the caps that refuse a buy, an unreadable listing that never
// buys and pages only after several checks in a row, the one issue that opens
// on a repeat miss and closes when the route is back, no figure in any log or
// issue line, and the workflow's wiring. Offline: an injected fetch, and one
// run of the CLI against a loopback stub on port 0. Nothing here pays.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import {
  decide, run, issueBody, logLines, catalogRows, missingFromEveryPass, presenceExemption, ISSUE_TITLE,
  DEFAULT_MAX_ROUTES, DEFAULT_MAX_SPEND_USD, UNREADABLE_PAGE_AFTER,
} from "./bazaar-presence.js";
import { aboveCeilingRoutes } from "./lib/keepalive-plan.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
// A $ followed by a figure: what no log line or issue body may carry.
const DOLLAR_FIGURE = /\$\s?\d/;

const HOST = "agent402.tools";
const TARGET = `https://${HOST}`;
const row = (slug, price, extra = {}) => ({ slug, path: `/api/${slug}`, method: "POST", price, ...extra });
const PRICING = {
  endpoints: [
    row("cheap-a", "$0.010"),
    row("cheap-b", "$0.05"),
    row("at-ceiling", "$0.10"),
    row("report", "$0.85"),
    row("quoted-one", "$0.002", { quoted: true }),
    row("model-one", "$0.003", { pricedByModel: true }),
    row("memory-write", "$0.001"),
    row("route-execute-max", "$0.55"),
    row("unpriced", "free"),
  ],
};
const ALL_PATHS = PRICING.endpoints.map((r) => r.path);
const keysOf = (paths) => ({ keys: new Set(paths) });
const without = (...slugs) => ALL_PATHS.filter((p) => !slugs.some((s) => p === `/api/${s}`));
const reading = (passPaths, pricing = PRICING) => ({ pricing, passes: passPaths.map(keysOf) });
const slugsOf = (list) => list.map((r) => r.slug).sort();

// --- missing from both passes is bought; missing from one is not ----------
{
  const d = decide({ reading: reading([without("cheap-a"), without("cheap-a")]), prev: null });
  ok(d.readable && slugsOf(d.buy).join() === "cheap-a", "a route absent from both passes is bought");
  ok(d.action === "none", "the first miss buys and does not page");
  ok(d.state.missing["/api/cheap-a"] === "bought", "the state remembers the route as bought");

  const one = decide({ reading: reading([without("cheap-a"), ALL_PATHS]), prev: null });
  ok(one.buy.length === 0 && one.newlyMissing.length === 0, "a route absent from one pass only is listed: not bought, not missing");
  const last = decide({ reading: reading([ALL_PATHS, without("cheap-a")]), prev: null });
  ok(last.buy.length === 0 && last.newlyMissing.length === 0, "a route absent from the last pass only is listed too");
  const one3 = decide({ reading: reading([without("cheap-b"), without("cheap-b"), ALL_PATHS]), prev: null });
  ok(one3.buy.length === 0, "a route present in a third pass is listed");
  ok(missingFromEveryPass(catalogRows(PRICING), []).length === ALL_PATHS.length, "control: with no pass, every route reads missing (so an empty reading must be refused upstream)");
}

// --- exemptions --------------------------------------------------------------
{
  const exemptSlugs = ["report", "quoted-one", "model-one", "memory-write", "route-execute-max", "unpriced"];
  const d = decide({ reading: reading([without(...exemptSlugs), without(...exemptSlugs)]), prev: null });
  ok(d.buy.length === 0, "no exempt route is bought");
  const why = Object.fromEntries(d.exempt.map((e) => [e.slug, e.why]));
  ok(why["quoted-one"] === "quoted", "a quoted route is exempt");
  ok(why["model-one"] === "model-priced", "a model-priced route is exempt");
  ok(why["memory-write"] === "lasting-effect", "a route whose effect outlives the answer is exempt");
  ok(why["route-execute-max"] === "route-execute", "a route-execute tier is exempt");
  ok(why["unpriced"] === "unpriced", "an unpriced route is exempt");
  ok(why["report"] === "above the ceiling", "a route the pass above the ceiling buys is exempt here");
  ok(d.state.missing["/api/report"] === "above the ceiling", "an exempt route is still remembered, so a repeat miss pages");
  // The tail exemption holds only where the tail pass covers the route.
  const tail = new Set(aboveCeilingRoutes(PRICING).map((r) => r.slug));
  ok(tail.has("report") && !tail.has("route-execute-max"), "control: the tail pass covers the report and not the route-execute tier");
  const entry = catalogRows(PRICING).find((c) => c.slug === "report");
  ok(presenceExemption(entry, new Set()) === null, "a route above the ceiling the tail does not cover is bought here, under the caps");
  const atCeiling = decide({ reading: reading([without("at-ceiling"), without("at-ceiling")]), prev: null });
  ok(slugsOf(atCeiling.buy).join() === "at-ceiling", "a route at the ceiling is bought here");
}

// --- the caps ------------------------------------------------------------------
{
  const many = { endpoints: Array.from({ length: 12 }, (_, i) => row(`r${i}`, "$0.001")).concat([row("keep", "$0.001")]) };
  const keep = ["/api/keep"];
  const at = (n) => keep.concat(many.endpoints.slice(n, 12).map((r) => r.path));
  const ten = decide({ reading: reading([at(10), at(10)], many), prev: null });
  ok(ten.buy.length === 10 && !ten.refused, "ten missing routes are bought");
  const eleven = decide({ reading: reading([at(11), at(11)], many), prev: null });
  ok(eleven.buy.length === 0 && /route-count/.test(eleven.refused || ""), "eleven missing routes refuse the whole buy");
  ok(Object.values(eleven.state.missing).every((v) => v === "refused"), "a refused buy is remembered as refused");
  const dear = { endpoints: [row("d1", "$0.09"), row("d2", "$0.09"), row("keep", "$0.001")] };
  const overCap = decide({ reading: reading([["/api/keep"], ["/api/keep"]], dear), prev: null, maxSpendUsd: "0.1" });
  ok(overCap.buy.length === 0 && /over the cap/.test(overCap.refused || ""), "list prices over the per-run cap refuse the whole buy");
  const noCap = decide({ reading: reading([["/api/keep"], ["/api/keep"]], dear), prev: null, maxSpendUsd: "" });
  ok(noCap.buy.length === 0 && noCap.refused, "a cap that is not a positive number refuses the buy");
  const zeroRoutes = decide({ reading: reading([without("cheap-a"), without("cheap-a")]), prev: null, maxRoutes: 0 });
  ok(zeroRoutes.buy.length === 0 && zeroRoutes.refused, "a route cap that is not a positive integer refuses the buy");
  ok(DEFAULT_MAX_ROUTES === 10 && DEFAULT_MAX_SPEND_USD === 2, "defaults: ten routes and the per-run cap");
}

// --- once per absence; the one issue -------------------------------------------
{
  const r = reading([without("cheap-a"), without("cheap-a")]);
  const first = decide({ reading: r, prev: null });
  const second = decide({ reading: r, prev: first.state });
  ok(second.buy.length === 0, "a route still missing on the next check is not bought again");
  ok(second.action === "open" && second.cause === "missing", "a route still missing on the next check opens the issue");
  ok(second.state.missing["/api/cheap-a"] === "bought", "the note of the first miss is kept");
  const third = decide({ reading: r, prev: second.state, openIssue: true });
  ok(third.action === "update" && third.buy.length === 0, "a third miss keeps the one issue and buys nothing");
  const back = decide({ reading: reading([ALL_PATHS, ALL_PATHS]), prev: third.state, openIssue: true });
  ok(back.action === "close" && Object.keys(back.state.missing).length === 0, "the route back in the listing closes the issue and clears the state");
  const quiet = decide({ reading: reading([ALL_PATHS, ALL_PATHS]), prev: null });
  ok(quiet.action === "none", "nothing missing and no issue: nothing to do");
  // A different route missing for the first time does not page.
  const other = decide({ reading: reading([without("cheap-b"), without("cheap-b")]), prev: first.state });
  ok(other.action === "none" && slugsOf(other.buy).join() === "cheap-b", "a route newly missing (another one back) buys and does not page");
  const body = issueBody(second, "https://github.com/o/r/actions/runs/123");
  ok(body.includes("`POST /api/cheap-a`") && body.includes("observed to leave"), "the issue names the route path and says it was observed to leave");
  ok(!/\b\d+\s+routes?\b/.test(body) && !DOLLAR_FIGURE.test(body), "the issue carries no count and no figure");
  ok(!/30 days|cull|removes? (?:a |any )?resource/i.test(body), "the issue states no rule of the listing's");
  ok(ISSUE_TITLE === "Bazaar presence check", "the title is fixed");
}

// --- an unreadable listing ---------------------------------------------------------
{
  const prev = decide({ reading: reading([without("cheap-a"), without("cheap-a")]), prev: null }).state;
  let s = prev, d;
  const actions = [];
  for (let i = 0; i < UNREADABLE_PAGE_AFTER; i++) {
    d = decide({ reading: null, prev: s });
    actions.push(d.action);
    ok(d.buy.length === 0, `unreadable check ${i + 1} buys nothing`);
    s = d.state;
  }
  ok(actions.slice(0, -1).every((a) => a === "none") && actions.at(-1) === "open", `the issue opens only on the ${UNREADABLE_PAGE_AFTER}rd unreadable check in a row (${actions.join(",")})`);
  ok(s.missing["/api/cheap-a"] === "bought", "an unreadable check keeps the previous missing set");
  ok(decide({ reading: null, prev: s, openIssue: true }).action === "none", "an unreadable check never closes or edits the issue");
  const afterBlind = decide({ reading: reading([without("cheap-a"), without("cheap-a")]), prev: s });
  ok(afterBlind.buy.length === 0 && afterBlind.action === "open", "a route missing before and after unreadable checks is a repeat miss: no rebuy, a page");
  ok(afterBlind.state.unreadable === 0, "a readable check resets the unreadable streak");
  ok(issueBody(d).includes("could not read") && !DOLLAR_FIGURE.test(issueBody(d)), "the unreadable body says so, with no figure");
}

// --- run(): reads, logs, outputs; no figure anywhere -----------------------------
const pagesOf = (paths, extra = []) => {
  const items = paths.map((p) => ({ resource: `${TARGET}${p}`, accepts: [{ network: "eip155:8453" }] })).concat(extra);
  return { items, pagination: { total: items.length } };
};
const fetchFor = ({ pricing = PRICING, walks, failRegistry = false, failPricing = false }) => {
  let walk = -1;
  return async (url) => {
    if (url.endsWith("/api/pricing")) { if (failPricing) throw new Error("HTTP 503"); return pricing; }
    if (failRegistry) throw new Error("HTTP 502");
    if (/offset=0\b/.test(url)) walk++;
    return walks[Math.min(walk, walks.length - 1)];
  };
};
const dir = mkdtempSync(join(tmpdir(), "bazaar-presence-"));
const runOnce = async (name, fetchJson, extraEnv = {}) => {
  const lines = [];
  const env = { TARGET_URL: TARGET, STATE_FILE: join(dir, `${name}.json`), OUT_DIR: join(dir, name), GITHUB_OUTPUT: join(dir, `${name}.out`), ...extraEnv };
  const code = await run({ env, log: (m) => lines.push(String(m)), fetchJson });
  const out = existsSync(env.GITHUB_OUTPUT) ? readFileSync(env.GITHUB_OUTPUT, "utf8") : "";
  const body = existsSync(join(env.OUT_DIR, "body.md")) ? readFileSync(join(env.OUT_DIR, "body.md"), "utf8") : "";
  return { code, lines, out, body, env };
};
{
  const other = { resource: "https://other.example/api/cheap-a", accepts: [] };
  const a = await runOnce("a", fetchFor({ walks: [pagesOf(without("cheap-a", "quoted-one"), [other]), pagesOf(without("cheap-a", "quoted-one"))] }));
  ok(a.code === 0 && /^slugs=cheap-a$/m.test(a.out) && /^max_price=0\.01$/m.test(a.out) && /^action=none$/m.test(a.out), "run(): the missing route goes to slugs=, another host's row does not count as ours");
  ok(a.lines.some((l) => l.includes("/api/quoted-one") && l.includes("quoted")), "run(): an exempt missing route is named in the log with its reason");
  const b = await runOnce("a", fetchFor({ walks: [pagesOf(without("cheap-a", "quoted-one")), pagesOf(without("cheap-a", "quoted-one"))] }), { OPEN_ISSUE: "" });
  ok(/^slugs=$/m.test(b.out.split("\n").slice(-4).join("\n")) && /^action=open$/m.test(b.out), "run(): the next check buys nothing and opens the issue");
  ok(b.body.includes("/api/cheap-a") && b.body.includes("/api/quoted-one"), "run(): the issue names both repeat misses");
  const u = await runOnce("u", fetchFor({ walks: [], failRegistry: true }));
  ok(u.code === 0 && /^slugs=$/m.test(u.out) && /^action=none$/m.test(u.out), "run(): an unreadable listing writes no slugs and does not page");
  const p = await runOnce("p", fetchFor({ walks: [pagesOf(ALL_PATHS)], failPricing: true }));
  ok(/^slugs=$/m.test(p.out), "run(): an unreadable catalog writes no slugs");
  const e = await runOnce("e", fetchFor({ walks: [pagesOf([]), pagesOf([])] }));
  ok(/^slugs=$/m.test(e.out) && e.lines.some((l) => /none of our routes/.test(l)), "run(): a listing holding none of our routes is no reading (never a mass buy)");
  const shortWalk = { items: [{ resource: `${TARGET}/api/cheap-b` }], pagination: { total: 5 } };
  const sw = await runOnce("sw", async (url) => (url.endsWith("/api/pricing") ? PRICING : /offset=0\b/.test(url) ? shortWalk : { items: [], pagination: { total: 5 } }));
  ok(/^slugs=$/m.test(sw.out), "run(): a walk that stops short of the total is unreadable, never a miss");
  const cap = await runOnce("cap", fetchFor({ walks: [pagesOf(without("cheap-a", "cheap-b")), pagesOf(without("cheap-a", "cheap-b"))] }), { MAX_SPEND_USD: "0.01" });
  ok(/^slugs=$/m.test(cap.out) && cap.lines.some((l) => /Refusing the buy/.test(l)), "run(): over the per-run cap, nothing is written to buy");
  const all = [a, b, u, p, e, sw, cap];
  const leaks = all.flatMap((r) => r.lines.concat(r.body.split("\n"))).filter((l) => DOLLAR_FIGURE.test(l));
  ok(leaks.length === 0, `no log line or issue body carries a dollar figure${leaks.length ? `: ${leaks.join(" | ")}` : ""}`);
  ok(!logLines(decide({ reading: reading([without("cheap-a"), without("cheap-a")]), prev: null })).some((l) => /0\.0\d/.test(l)), "no log line carries a price");
}

// --- the CLI end to end against a loopback stub --------------------------------
{
  let walk = -1;
  const srv = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/api/pricing") return res.end(JSON.stringify(PRICING));
    if (u.pathname === "/discovery") {
      if (u.searchParams.get("offset") === "0") walk++;
      const items = without("cheap-b").map((p) => ({ resource: `http://127.0.0.1:${srv.address().port}${p}` }));
      return res.end(JSON.stringify({ items, pagination: { total: items.length } }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const out = join(dir, "cli.out");
  const child = spawn(process.execPath, [fileURLToPath(new URL("bazaar-presence.js", import.meta.url))], {
    env: { ...process.env, TARGET_URL: `http://127.0.0.1:${port}`, BAZAAR_REGISTRY_URL: `http://127.0.0.1:${port}/discovery`, STATE_FILE: join(dir, "cli.json"), OUT_DIR: join(dir, "cli"), GITHUB_OUTPUT: out },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (b) => { stdout += b; });
  child.stderr.on("data", (b) => { stdout += b; });
  const code = await new Promise((r) => child.on("exit", r));
  srv.close();
  const o = existsSync(out) ? readFileSync(out, "utf8") : "";
  ok(code === 0 && /^slugs=cheap-b$/m.test(o), `the CLI writes the one missing slug (exit ${code})`);
  ok(walk >= 1, `the CLI walks the listing at least twice (${walk + 1})`);
  ok(JSON.parse(readFileSync(join(dir, "cli.json"), "utf8")).missing["/api/cheap-b"] === "bought", "the CLI writes the state for the next check");
  ok(!DOLLAR_FIGURE.test(stdout), "the CLI's output carries no dollar figure");
}

// --- the workflow's wiring ---------------------------------------------------------
{
  const src = read(".github/workflows/bazaar-presence.yml");
  const wf = load(src);
  const crons = (wf.on?.schedule || []).map((s) => s.cron);
  ok(crons.length === 1, `one schedule (${crons.join(" | ")})`);
  const hours = String(crons[0] || "").split(/\s+/)[1] || "";
  const m = hours.match(/^(\d+)-(\d+)\/(\d+)$|^\*\/(\d+)$/);
  const step = m ? Number(m[3] || m[4]) : 0;
  ok(step >= 2 && step <= 6 && String(crons[0]).split(/\s+/).slice(2).join(" ") === "* * *", `every few hours, every day (${crons[0]})`);
  ok("workflow_dispatch" in (wf.on || {}), "it can be dispatched");
  const jobs = Object.entries(wf.jobs || {});
  ok(jobs.every(([, j]) => !j.strategy), "no job has a strategy or matrix");
  ok(!/\$\{\{\s*matrix\./.test(src) && !/^\s*matrix:/m.test(src), "the workflow uses no matrix");
  ok(jobs.every(([, j]) => Number.isInteger(j["timeout-minutes"]) && j["timeout-minutes"] <= 60), "every job is bounded");
  const buyers = jobs.filter(([, j]) => (j.steps || []).some((s) => /refresh-bazaar\.js/.test(s.run || "")));
  ok(buyers.length === 1, "exactly one job buys");
  const [, job] = buyers[0] || [null, {}];
  const buySteps = (job.steps || []).filter((s) => /refresh-bazaar\.js/.test(s.run || ""));
  ok(buySteps.length === 1, "exactly one step buys, in one process");
  const buy = buySteps[0] || {};
  ok(job.concurrency?.group === "bazaar-keepalive" && job.concurrency?.["cancel-in-progress"] === false, "the buying job shares the keep-alive concurrency group and never cancels");
  for (const f of ["bazaar-keepalive.yml", "bazaar-keepalive-tail.yml"]) {
    ok(load(read(`.github/workflows/${f}`)).concurrency?.group === "bazaar-keepalive", `${f} is in the same group`);
  }
  ok(buy.env?.MODE === "missing" && buy.env?.REQUIRE_SLUGS === "1" && buy.env?.BATCH_COUNT === "1", "the buy is MODE=missing with REQUIRE_SLUGS=1 in one batch");
  ok(/steps\.check\.outputs\.slugs/.test(buy.env?.SLUGS || "") && /steps\.check\.outputs\.slugs != ''/.test(buy.if || ""), "the buy takes the check's explicit slugs and runs only when there are some");
  ok(/steps\.check\.outputs\.max_price/.test(buy.env?.MAX_PRICE_USD || ""), "each signature is held to the dearest planned route");
  ok(/^\$\{\{\s*vars\.BAZAAR_PRESENCE_MAX_USD\s*\|\|\s*'2'\s*\}\}$/.test(job.env?.MAX_SPEND_USD || ""), "the per-run cap is the repo variable, default 2");
  ok(job.env?.MAX_ROUTES === "10", "the route cap is ten");
  ok(buy.env?.PAY_NETWORK === "base", "the buy settles on Base");
  const check = (job.steps || []).find((s) => s.id === "check") || {};
  ok(/scripts\/bazaar-presence\.js/.test(check.run || "") && (job.steps || []).indexOf(check) < (job.steps || []).indexOf(buy), "the check runs before the buy");
  ok(/select\(\.title == env\.TITLE\)/.test(check.run || "") && job.env?.TITLE === ISSUE_TITLE, "the issue lookup keeps only the exact title");
  const restore = (job.steps || []).find((s) => /actions\/cache\/restore@[0-9a-f]{40}/.test(s.uses || ""));
  const save = (job.steps || []).find((s) => /actions\/cache\/save@[0-9a-f]{40}/.test(s.uses || ""));
  ok(restore && save && restore.with?.path === save.with?.path && /run_id/.test(save.with?.key || ""), "the state is restored and saved through the pinned cache action");
  ok(/always\(\)/.test(save?.if || "") && /steps\.check\.outcome == 'success'/.test(save?.if || ""), "the state is saved after a failed buy too, never after a failed check");
  const issue = (job.steps || []).find((s) => /gh issue create/.test(s.run || "")) || {};
  ok(/--body-file out\/body\.md/.test(issue.run || "") && /--title "\$TITLE"/.test(issue.run || ""), "the issue is the fixed title and the check's body");
  ok(/always\(\)/.test(issue.if || ""), "the issue step runs after a failed buy too");
  const busy = wf.jobs?.busy;
  ok(job.needs === "busy" && /needs\.busy\.outputs\.busy == 'false'/.test(job.if || ""), "the buying job waits out a running or queued keep-alive pass");
  ok(/bazaar-keepalive\.yml/.test(busy?.steps?.[0]?.run || "") && /bazaar-keepalive-tail\.yml/.test(busy?.steps?.[0]?.run || ""), "the busy check reads both keep-alive workflows");
  ok(!busy?.concurrency, "the busy check itself holds no place in the group");
  const runs = jobs.flatMap(([, j]) => (j.steps || []).map((s) => s.run || "")).join("\n");
  ok(!/\$\{\{/.test(runs), "no run block interpolates an expression (values reach the shell through env)");
  ok(!/30 days without|CDP removes|removed after/.test(src), "the workflow states no rule of the listing's");
  ok(wf.permissions?.issues === "write" && wf.permissions?.contents === "read", "permissions are read plus issues");
}

// --- documented ----------------------------------------------------------------
{
  const doc = read("CLAUDE.md");
  ok(/BAZAAR_PRESENCE_MAX_USD/.test(doc) && /bazaar-presence\.yml/.test(doc), "CLAUDE.md documents the workflow and its repo variable");
  const lanes = ["test-unit-c2"].map((l) => read(`scripts/ci/lanes/${l}.sh`)).join("\n");
  ok(/node scripts\/test-bazaar-presence\.js/.test(lanes), "this suite runs in a CI lane");
}

console.log(`\ntest-bazaar-presence: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
