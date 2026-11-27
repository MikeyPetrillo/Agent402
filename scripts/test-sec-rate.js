#!/usr/bin/env node
// One pace for every request to the SEC's hosts (src/tools/sec-rate.js).
//
//   node scripts/test-sec-rate.js          (offline: the SEC host is a stand-in)
//
// Proves, with the real EDGAR handlers over a stand-in for the SEC's hosts:
//   - thirty calls made at once all succeed, and in no rolling second do more
//     than eight requests start (each one counted when the stand-in gets it);
//   - nothing is refused before its deadline: a waiting read is answered the
//     503 (Retry-After, "ours", uncharged wording) only once its wait is spent;
//   - the wait ends at the run's ceiling (a 504, and nothing starts after it),
//     on the caller's signal and inside the handler budget;
//   - the line is bounded, and the pace is divided across replicas;
// and, by reading the source, that no file under src/ reaches an SEC host
// except through the pace.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stubGuardResolver } from "./lib/guard-resolver-stub.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createSecPace, secPaced, secPaceStatus, secStartsPerSecond, secBusyError, isSecHost, SEC_HOSTS, SEC_STARTS_PER_SECOND_TOTAL, SEC_MAX_WAIT_MS, SEC_READ_RESERVE_MS, _resetSecPaceForTests } = await import("../src/tools/sec-rate.js");
const { withRunCeiling } = await import("../src/run-ceiling.js");
const { underBudget } = await import("../src/upstream-deadline.js");
const { runAsRouteCall, runAsStep } = await import("../src/not-charged.js");
const { EDGAR_TOOLS, fetchXmlText } = await import("../src/tools/edgar-kit.js");
const { fetchDocText } = await import("../src/tools/filing-watch-kit.js");
const { rangeBytes } = await import("../src/tools/edgar-13f-datasets.js");
const { scanInfoTableForIssuer } = await import("../src/tools/ticker-pack-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The most starts inside any rolling `windowMs` (a window opens at each start). */
const mostPerWindow = (times, windowMs = 1000) => {
  const t = [...times].sort((a, b) => a - b);
  let most = 0;
  for (let i = 0, j = 0; i < t.length; i++) { while (t[i] - t[j] >= windowMs) j++; most = Math.max(most, i - j + 1); }
  return most;
};
ok(mostPerWindow([0, 1, 2, 999, 1000, 1001]) === 4 && mostPerWindow([0, 100, 200], 50) === 1, "the window counter counts a rolling window");

// ---- the stand-in for the SEC's hosts ----
const starts = []; // { at, host, path }
const realFetch = globalThis.fetch;
const submissions = (cik) => ({ cik, name: `Company ${cik}`, filings: { recent: { form: ["10-K", "8-K"], filingDate: ["2026-01-02", "2026-02-03"], reportDate: ["2025-12-31", ""], accessionNumber: ["0000000001-26-000001", "0000000001-26-000002"], primaryDocument: ["a.htm", "b.htm"], primaryDocDescription: ["10-K", "8-K"], isXBRL: [1, 0] }, files: [] } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (!isSecHost(u)) throw new Error(`unexpected egress in an offline suite: ${u.host}`);
  starts.push({ at: performance.now(), host: u.host, path: u.pathname });
  await sleep(15);
  if (init.signal?.aborted) throw init.signal.reason;
  const headers = { "content-type": "application/json" };
  if (u.pathname.endsWith("company_tickers.json")) return new Response(JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }), { status: 200, headers });
  if (u.pathname.startsWith("/submissions/")) return new Response(JSON.stringify(submissions(u.pathname.replace(/\D/g, ""))), { status: 200, headers });
  if (init.headers?.Range) return new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 0-3/100" } });
  return new Response("<doc>ok</doc>", { status: 200, headers: { "content-type": "text/xml" } });
};
const restoreResolver = stubGuardResolver((host, family) => (family === 4 ? ["93.184.216.34"] : []));

// ---- thirty calls at once, through the real handlers ----
{
  _resetSecPaceForTests();
  starts.length = 0;
  const filings = EDGAR_TOOLS.find((t) => t.slug === "edgar-filings").handler;
  const t0 = performance.now();
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => runAsRouteCall(() => filings({ cik: String(1000 + i), limit: 2 }))));
  const took = performance.now() - t0;
  const good = results.filter((r) => r.status === "fulfilled" && r.value?.filings?.length === 2).length;
  const refused = results.filter((r) => r.status === "rejected");
  const most = mostPerWindow(starts.map((s) => s.at));
  ok(good === 30 && refused.length === 0, `thirty calls made at once all succeed (${good} answered, ${refused.length} refused${refused[0] ? `: ${refused[0].reason?.statusCode} ${String(refused[0].reason?.message).slice(0, 80)}` : ""})`);
  ok(starts.length === 30 && most <= SEC_STARTS_PER_SECOND_TOTAL && most >= 2, `their thirty requests start at most eight to a rolling second (most ${most}, over ${Math.round(took)} ms)`);
  ok(took >= 2800 && took < SEC_MAX_WAIT_MS, `the calls waited their turn instead of being refused (${Math.round(took)} ms for thirty)`);
  ok(secPaceStatus().refused === 0 && secPaceStatus().waiting === 0, "the pace refused nothing and nobody is left waiting");
}

// ---- every kind of SEC read shares the one pace ----
{
  _resetSecPaceForTests();
  starts.length = 0;
  const filings = EDGAR_TOOLS.find((t) => t.slug === "edgar-filings").handler;
  const jobs = [];
  for (let i = 0; i < 6; i++) {
    jobs.push(filings({ cik: String(2000 + i), limit: 1 }));
    jobs.push(fetchXmlText(`https://www.sec.gov/Archives/edgar/data/1/${i}/form4.xml`));
    jobs.push(fetchDocText(`https://www.sec.gov/Archives/edgar/data/1/${i}/doc.htm`));
    jobs.push(rangeBytes(`https://www.sec.gov/files/structureddata/data/form-13f-data-sets/x${i}.zip`, 0, 3));
    jobs.push(scanInfoTableForIssuer(`https://www.sec.gov/Archives/edgar/data/1/${i}/infotable.xml`, { want: "example corp", cusip6: null }));
  }
  const settled = await Promise.allSettled(jobs);
  const most = mostPerWindow(starts.map((s) => s.at));
  ok(settled.every((r) => r.status === "fulfilled") && starts.length === 30, `JSON, XML, document, range and information-table reads all answer (${settled.filter((r) => r.status === "fulfilled").length} of 30${settled.find((r) => r.status === "rejected") ? `; ${String(settled.find((r) => r.status === "rejected").reason?.message).slice(0, 90)}` : ""})`);
  ok(most <= SEC_STARTS_PER_SECOND_TOTAL && new Set(starts.map((s) => s.host)).size >= 2, `across hosts and kits, at most eight starts to a rolling second (most ${most}; hosts ${[...new Set(starts.map((s) => s.host))].join(", ")})`);
}

// ---- nothing is refused before its deadline; past it, the 503 ----
{
  const pace = createSecPace({ perSecond: 4, maxWaitMs: 400, queueMax: 64 });
  const t0 = performance.now();
  const outcomes = await Promise.all(Array.from({ length: 12 }, () => runAsRouteCall(() => pace.paced(async () => "read")).then((v) => ({ v, at: performance.now() - t0 }), (e) => ({ e, at: performance.now() - t0 }))));
  const served = outcomes.filter((o) => o.v === "read"), refused = outcomes.filter((o) => o.e);
  ok(served.length === 4 && refused.length === 8, `with four places and a 400 ms wait, four of twelve are served and eight wait (${served.length} served, ${refused.length} refused)`);
  ok(refused.every((o) => o.at >= 395), `none of the eight is refused before its deadline (earliest ${Math.round(Math.min(...refused.map((o) => o.at)))} ms)`);
  const e = refused[0].e;
  ok(e.statusCode === 503 && e.retryAfter > 0 && e.attribution === "ours" && e.secBusy === true && /EDGAR is busy/.test(e.message) && /Nothing was read\. Nothing was charged\./.test(e.message), `the refusal is a 503 with Retry-After, ours, uncharged (${e.statusCode} ${e.message})`);
  ok(pace.status().waiting === 0 && pace.status().refused === 8, "a refused read leaves the line");
  // A step prints no charge claim.
  const inStep = await runAsStep(async () => secBusyError());
  ok(!/Nothing was charged/.test(inStep.message) && /Nothing was read\./.test(inStep.message), "inside a step the refusal makes no charge claim");
  // CONTROL: the same twelve with the default wait are all served.
  const roomy = createSecPace({ perSecond: 4 });
  const all = await Promise.allSettled(Array.from({ length: 12 }, () => roomy.paced(async () => "read")));
  ok(all.every((r) => r.status === "fulfilled") && roomy.status().refused === 0, "CONTROL: with the default wait all twelve are served");
}

// ---- the wait ends at the run's ceiling, and nothing starts after it ----
{
  const pace = createSecPace({ perSecond: 1 });
  await pace.paced(async () => "first");
  let ran = 0;
  const t0 = performance.now();
  let err = null;
  try { await withRunCeiling(120, () => pace.paced(async () => { ran++; })); } catch (e) { err = e; }
  const took = performance.now() - t0;
  ok(err?.statusCode === 504 && err.ceilingCut === true && ran === 0 && took >= 100 && took < 400, `a read waiting at the run's ceiling ends there as a 504 and never starts (${err?.statusCode}, ${Math.round(took)} ms, ran ${ran})`);
  ok(pace.status().waiting === 0, "the read the ceiling ended left the line");
  err = null;
  try { await withRunCeiling(1, async () => { await sleep(10); return pace.paced(async () => { ran++; }); }); } catch (e) { err = e; }
  ok(err?.ceilingCut === true && ran === 0, "nothing starts once the ceiling has passed");
}

// ---- the caller's signal ends the wait ----
{
  const pace = createSecPace({ perSecond: 1 });
  await pace.paced(async () => "first");
  const ac = new AbortController();
  let ran = 0;
  const p = pace.paced(async () => { ran++; }, { signal: ac.signal }).then(() => null, (e) => e);
  await sleep(30);
  const waitingBefore = pace.status().waiting;
  ac.abort(Object.assign(new Error("caller went away"), { name: "AbortError" }));
  const e = await p;
  ok(waitingBefore === 1 && e?.name === "AbortError" && ran === 0 && pace.status().waiting === 0, `an aborted caller leaves the line and its read never starts (${e?.name}, waiting ${waitingBefore} -> ${pace.status().waiting})`);
  const gone = await pace.paced(async () => 1, { signal: AbortSignal.abort() }).then(() => null, (x) => x);
  ok(gone != null, "a signal already aborted starts nothing");
}

// ---- inside a handler budget: the wait leaves the read its reserve ----
{
  const pace = createSecPace({ perSecond: 1, windowMs: 60_000 });
  await pace.paced(async () => "first");
  const budgeted = underBudget(async () => pace.paced(async () => "late"), SEC_READ_RESERVE_MS + 250);
  const t0 = performance.now();
  let err = null;
  try { await budgeted({}); } catch (e) { err = e; }
  const took = performance.now() - t0;
  ok(err?.secBusy === true && took >= 200 && took < 900, `a wait is bounded by the handler budget less the read's reserve (${err?.statusCode} after ${Math.round(took)} ms)`);
  const spent = underBudget(async () => pace.paced(async () => "late"), SEC_READ_RESERVE_MS - 500);
  err = null;
  const t1 = performance.now();
  try { await spent({}); } catch (e) { err = e; }
  ok(err?.secBusy === true && performance.now() - t1 < 100, "with no budget left for a wait and no free place, the answer is at once");
}

// ---- the line is bounded ----
{
  const pace = createSecPace({ perSecond: 2, maxWaitMs: 500 });
  const settled = [];
  const jobs = Array.from({ length: 500 }, () => pace.paced(async () => "read").then((v) => settled.push(v), (e) => settled.push(e)));
  await sleep(5);
  const s = pace.status();
  ok(s.waiting <= pace.lineMax && s.longestLine <= pace.lineMax && pace.lineMax <= 8, `five hundred reads at once hold at most ${pace.lineMax} places in line (waiting ${s.waiting})`);
  ok(settled.filter((x) => x?.secBusy).length >= 500 - 2 - pace.lineMax, "the reads past the line are answered at once");
  await Promise.all(jobs);
  ok(pace.status().waiting === 0, "and the line empties");
}

// ---- the pace is this process's share ----
ok(secStartsPerSecond({}) === 8 && secStartsPerSecond({ RATE_LIMIT_REPLICAS: "1" }) === 8 && secStartsPerSecond({ RATE_LIMIT_REPLICAS: "2" }) === 4 && secStartsPerSecond({ RATE_LIMIT_REPLICAS: "3" }) === 2 && secStartsPerSecond({ RATE_LIMIT_REPLICAS: "40" }) === 1 && secStartsPerSecond({ RATE_LIMIT_REPLICAS: "junk" }) === 8,
  "the pace is divided across replicas (RATE_LIMIT_REPLICAS), never under one start a second");
ok(SEC_STARTS_PER_SECOND_TOTAL <= 8 && SEC_HOSTS.join() === "sec.gov,www.sec.gov,data.sec.gov,efts.sec.gov" && isSecHost("https://EFTS.sec.gov/LATEST/search-index?q=x") && !isSecHost("https://sec.gov.example/") && !isSecHost("https://notsec.gov/") && !isSecHost("nonsense"),
  "the pace is eight a second at most and covers the four hosts, by exact host name");

// ---- every fetch of an SEC host goes through the pace (source guard) ----
// A file under src/ that names an SEC host and makes a network call makes
// every such call inside secPaced(() => ...). Files that only print the host
// (a citation, a URL in an answer) make no network call and are not read.
{
  const CALL_RE = /(?<![.\w])(?:upstreamFetch|safeFetch|fetchWithRetry|probePublicUrl|fetchImpl|fetch)\(/g;
  const HOST_RE = /(?:www\.|data\.|efts\.)?sec\.gov/;
  // A file that names the host for a reader and calls the network for something else.
  const OTHER_CALLS = new Map([
    ["src/pow.js", "a code sample in a string (the proof-of-work snippet); the SEC host is in a comment"],
  ]);
  const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "generated" || n === "node_modules" ? [] : walk(p)) : (/\.(?:js|mjs)$/.test(n) ? [p] : []); });
  const unpaced = (src) => {
    const out = [];
    for (const m of src.matchAll(CALL_RE)) {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const line = src.slice(lineStart, src.indexOf("\n", m.index));
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;                       // a comment
      if (/(?:async )?function \w*$/.test(src.slice(lineStart, m.index))) continue; // a declaration
      if (/secPaced\(\(\) => $/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
      out.push(line.trim().slice(0, 110));
    }
    return out;
  };
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "workers")), ...walk(join(ROOT, "services"))].filter((f) => !f.endsWith(join("tools", "sec-rate.js")));
  const naming = files.filter((f) => HOST_RE.test(readFileSync(f, "utf8")));
  let pacedFiles = 0;
  for (const f of naming) {
    const rel = relative(ROOT, f), src = readFileSync(f, "utf8");
    const raw = unpaced(src);
    if (OTHER_CALLS.has(rel)) { ok(raw.length > 0 && !/secPaced/.test(src), `${rel} is still an exception with a reason: ${OTHER_CALLS.get(rel)}`); continue; }
    ok(raw.length === 0, `${rel} reaches no SEC host outside the pace${raw.length ? `: ${raw[0]}` : ""}`);
    if (/secPaced\(\(\) => /.test(src)) { pacedFiles++; ok(/import \{ secPaced \} from "\.\/sec-rate\.js";/.test(src), `${rel} imports the pace it uses`); }
  }
  const count = (rel) => (readFileSync(join(ROOT, rel), "utf8").match(/secPaced\(\(\) => /g) || []).length;
  ok(naming.length >= 12 && pacedFiles === 4 && count("src/tools/edgar-kit.js") === 2 && count("src/tools/edgar-13f-datasets.js") === 3 && count("src/tools/filing-watch-kit.js") === 1 && count("src/tools/ticker-pack-kit.js") === 1,
    `the SEC's hosts are read from four files, seven call sites, each inside the pace (${naming.length} files name a host, ${pacedFiles} read one)`);
  // The guard sees a call that leaves the pace, and one added beside it.
  const kit = readFileSync(join(ROOT, "src/tools/edgar-kit.js"), "utf8");
  ok(unpaced(kit.replace("await secPaced(() => upstreamFetch(safeUrl, { headers: { \"User-Agent\": edgarUserAgent(), Accept: \"application/json\" } }, ctx));", "await upstreamFetch(safeUrl, { headers: { \"User-Agent\": edgarUserAgent(), Accept: \"application/json\" } }, ctx);")).length === 1
    && unpaced(`${kit}\nconst r = await fetch("https://data.sec.gov/x");\n`).length === 1 && unpaced(`${kit}\n  const res = await safeFetch(u);\n`).length === 1,
  "CONTROL: the guard fails a call taken out of the pace and a new raw call beside it");
}

globalThis.fetch = realFetch;
restoreResolver();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
