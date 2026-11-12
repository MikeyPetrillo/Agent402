#!/usr/bin/env node
// x-search-recent author and post histogram (src/x-search-stats.js), offline.
//
// Proves the caller path: a local express app with the real request-scope
// middleware (src/request-timing.js) in front of the real x-search-recent
// handler (X stubbed), and a settlement stand-in that, like the x402
// middleware, turns the handler's 200 into a 402 after the handler ran. A
// call is counted by the distinct authors in `includes.users` and the posts
// in `data` only on a FINAL 200; a settle failure, an upstream error and a
// call outside a request count nothing there. The day's author reads
// (`authorReads`) count every page X answered, a settle failure and a call
// outside a request included, since X bills them either way. The answer is
// unchanged by the counting. The xSearchAuthors word shares one bounded store
// read across concurrent requests and keeps a flushed batch in its figure. The counts land in the state document (file backend here),
// survive a fresh module state, never hold a username, id or query text, and
// days past the keep window are pruned.
//
//   node scripts/test-x-search-stats.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const dir = mkdtempSync(join(tmpdir(), "a402-x-search-stats-"));
const STATS_FILE = join(dir, "x-search-author-stats.json");
process.env.X_SEARCH_STATS_FILE = STATS_FILE;
process.env.X_BEARER_TOKEN = "test-bearer-token-0123456789";
process.env.X_DATA_DAILY_MAX_USD = "1000";
// Counts, not margins: the placeholder cost table is enough for X's card to
// load (without one every read refuses 503), and no figure is printed.
delete process.env.UPSTREAM_COSTS_JSON;
process.env.UPSTREAM_COSTS_FILE = fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url));

const { X_DATA_TOOLS } = await import("../src/tools/x-data-kit.js");
const { requestTimingMiddleware, currentRequestScope } = await import("../src/request-timing.js");
const stats = await import("../src/x-search-stats.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
// One sold call, as the handler records it: author reads, then the final 200.
const sale = (o) => { stats.noteXSearchAuthorReads(o); return stats.noteXSearchCall({ status: 200, ...o }); };

// --- the bucket rule, pure ----------------------------------------------------
const B = (n) => stats.bucketOf(n);
ok(B(0) === "0" && B(1) === "1" && B(2) === "2-3" && B(3) === "2-3" && B(4) === "4-6" && B(6) === "4-6" && B(7) === "7-10" && B(10) === "7-10" && B(11) === "11+" && B(100) === "11+", "buckets 0, 1, 2-3, 4-6, 7-10, 11+");
ok(B(-1) === "0" && B("x") === "0", "a malformed count lands in 0");
const c0 = stats.countsOf({ data: [{ id: "1" }, { id: "2" }], includes: { users: [{ id: "a" }, { id: "a" }, { id: "b" }] } });
ok(c0.authors === 2 && c0.posts === 2, `distinct authors are counted once (${JSON.stringify(c0)})`);
ok(JSON.stringify(stats.countsOf({})) === JSON.stringify({ authors: 0, posts: 0 }), "an empty page counts zero authors and zero posts");
ok(stats.noteXSearchCall({ status: 402, authors: 1, posts: 1 }) === false && stats.noteXSearchCall({ status: 499, authors: 1, posts: 1 }) === false, "a 402 (settle failed) or a hang-up is not counted");

// --- X, stubbed -------------------------------------------------------------------
const realFetch = globalThis.fetch;
const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (posts, authors) => ({
  data: Array.from({ length: posts }, (_, i) => ({ id: `19000000000000000${10 + i}`, text: `post ${i}`, author_id: `u${i % Math.max(1, authors)}`, created_at: "2026-11-07T00:00:00.000Z" })),
  includes: { users: Array.from({ length: authors }, (_, i) => ({ id: `u${i}`, username: `secrethandle${i}`, name: `Name ${i}` })) },
  meta: { result_count: posts },
});
let answer = null;
globalThis.fetch = async (url, init = {}) => {
  const host = (() => { try { return new URL(String(url)).hostname; } catch { return ""; } })();
  if (host !== "api.x.com" && host !== "api.twitter.com") return realFetch(url, init);
  return answer();
};

// --- the caller path: request scope, handler, settlement stand-in ---------------
const tool = X_DATA_TOOLS.find((t) => t.slug === "x-search-recent");
const app = express();
app.use(requestTimingMiddleware((req) => req.path));
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers["x-synthetic"] === "1") { const s = currentRequestScope(); if (s) s.synthetic = true; }
  // Like @x402/express: the handler's answer is held, then settled; a failed
  // settle discards it and answers 402.
  const orig = res.json.bind(res);
  res.json = (body) => (res.statusCode < 400 && req.headers["x-settle"] === "fail" ? orig.call(res.status(402), { error: "settlement failed" }) : orig(body));
  next();
});
app.post("/api/x-search-recent", async (req, res) => {
  try { res.json(await tool.handler(req.body)); }
  catch (e) { res.status(e.statusCode || 502).json({ error: e.message }); }
});
const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (fn, headers = {}) => {
  answer = fn;
  const r = await realFetch(`${base}/api/x-search-recent`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ query: "secretquery -is:retweet" }) });
  const body = await r.json();
  await new Promise((res) => setTimeout(res, 20)); // the finish hook runs after the body is sent
  return { status: r.status, body };
};

try {
  const a = await call(() => J(200, page(10, 3)));
  ok(a.status === 200 && a.body.count === 10 && a.body.tweets[0].author?.username === "secrethandle0", `a 10-post, 3-author page answers 200 with authors flattened (${a.status})`);
  const b = await call(() => J(200, page(10, 10)));
  ok(b.status === 200, "a 10-post, 10-author page answers 200");
  const c = await call(() => J(200, page(1, 1)));
  ok(c.status === 200, "a 1-post, 1-author page answers 200");
  const empty = await call(() => J(200, { meta: { result_count: 0 } }));
  ok(empty.status === 200 && empty.body.count === 0, "an empty page answers 200");
  const fail = await call(() => J(200, page(10, 5)), { "x-settle": "fail" });
  ok(fail.status === 402, `a handler 200 whose settlement fails is a final 402 (${fail.status})`);
  const up = await call(() => J(500, {}));
  ok(up.status >= 500, `an upstream 5xx is not a 200 (${up.status})`);
  const syn = await call(() => J(200, page(10, 7)), { "x-synthetic": "1" });
  ok(syn.status === 200, "a synthetic call answers 200");
  // A call outside any request is not counted.
  answer = () => J(200, page(10, 4));
  await tool.handler({ query: "x402" });

  let rep = await stats.xSearchStatsReport();
  const o = rep.totals.outside, s = rep.totals.synthetic;
  ok(o.calls === 4, `outside lane: four final 200s; the settle failure, the 5xx and the out-of-request call add nothing (${o.calls})`);
  ok(o.authors["2-3"] === 1 && o.authors["7-10"] === 1 && o.authors["1"] === 1 && o.authors["0"] === 1 && o.authors["4-6"] === 0, `outside authors histogram (${JSON.stringify(o.authors)})`);
  ok(o.posts["7-10"] === 2 && o.posts["1"] === 1 && o.posts["0"] === 1 && o.posts["11+"] === 0, `outside posts histogram (${JSON.stringify(o.posts)})`);
  ok(s.calls === 1 && s.authors["7-10"] === 1 && s.posts["7-10"] === 1, `synthetic lane counted apart (${JSON.stringify(s)})`);
  ok(rep.days.length === 1 && rep.days[0].day === new Date().toISOString().slice(0, 10), "counts sit under today's UTC day");
  ok(JSON.stringify(rep.buckets) === JSON.stringify(["0", "1", "2-3", "4-6", "7-10", "11+"]), "the report names its buckets");

  // Stored, then read back by a fresh module state (a deploy).
  const f = await stats.flushXSearchStats();
  ok(f.ok && f.flushed && existsSync(STATS_FILE), "a flush writes the state document");
  const raw = readFileSync(STATS_FILE, "utf8");
  ok(!/secret|Name |u0|1900000|retweet|x402/i.test(raw), "the stored document holds counts only (no username, id or query text)");
  stats._resetXSearchStats();
  rep = await stats.xSearchStatsReport();
  ok(rep.totals.outside.calls === 4 && rep.totals.synthetic.calls === 1 && rep.scope === "stored", "the counts survive a fresh process state");

  // Increments from two writers add up (read-modify-write, never a whole-body replace).
  sale({ authors: 12, posts: 12 });
  await stats.flushXSearchStats();
  sale({ authors: 5, posts: 10 });
  rep = await stats.xSearchStatsReport();
  ok(rep.totals.outside.calls === 6 && rep.totals.outside.authors["11+"] === 1 && rep.totals.outside.authors["4-6"] === 1, `stored and unflushed counts merge on read (${rep.totals.outside.calls})`);
  await stats.flushXSearchStats();

  // The xSearchAuthors word: today's exact author reads (both lanes, stored
  // and unflushed) against X_SEARCH_AUTHOR_DAILY_ALERT; an alarm only.
  ok(stats.X_SEARCH_AUTHOR_DAILY_ALERT_DEFAULT === 500 && stats.xSearchAuthorDailyAlert() === 500, "the alert mark defaults to 500 author reads a day");
  // Stored so far: outside 3+10+1+0, plus 5 from the settle failure and 4
  // from the out-of-request call (X billed both), plus 12+5 = 40; synthetic 7.
  rep = await stats.xSearchStatsReport();
  ok(rep.totals.outside.authorReads === 40 && rep.totals.synthetic.authorReads === 7, `each lane keeps the exact author reads beside the histogram, every page X answered included (${rep.totals.outside.authorReads}, ${rep.totals.synthetic.authorReads})`);
  ok(rep.totals.outside.calls === 6, `the settle failure and the out-of-request call still add no call (${rep.totals.outside.calls})`);
  let w = await stats.xSearchAuthorsStatus();
  ok(JSON.stringify(w) === JSON.stringify({ status: "ok" }), `under the mark the public word is ok, with no figure (${JSON.stringify(w)})`);
  w = await stats.xSearchAuthorsStatus({ full: true });
  ok(w.status === "ok" && w.authorReadsToday === 47 && w.alertAbove === 500 && w.scope === "stored", `the operator view counts both lanes, stored and unflushed (${JSON.stringify(w)})`);
  process.env.X_SEARCH_AUTHOR_DAILY_ALERT = "47";
  ok((await stats.xSearchAuthorsStatus()).status === "ok", "at the mark the word stays ok");
  sale({ authors: 1, posts: 1 });
  ok((await stats.xSearchAuthorsStatus()).status === "alert", "one author read past the mark reads alert (unflushed counts included)");
  await stats.flushXSearchStats();
  stats._resetXSearchStats();
  ok((await stats.xSearchAuthorsStatus()).status === "alert", "a fresh process reads alert from the stored day");
  ok((await stats.xSearchAuthorsStatus({ now: Date.now() + 86_400_000 })).status === "ok", "the next UTC day reads ok");
  // The answer path is never refused for it: a call past the mark still answers 200 and is counted.
  const past = await call(() => J(200, page(10, 10)));
  ok(past.status === 200 && past.body.count === 10, `a call past the mark is served as usual (${past.status})`);
  process.env.X_SEARCH_AUTHOR_DAILY_ALERT = "0";
  ok(stats.xSearchAuthorDailyAlert() === 500, "a zero or malformed mark falls back to the default");
  delete process.env.X_SEARCH_AUTHOR_DAILY_ALERT;
  await stats.flushXSearchStats();

  // One store read serves every concurrent status request, and it is bounded.
  {
    const noon = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);
    stats._resetXSearchStats();
    const d = stats._xSearchStatsDoc();
    const realRead = d.read.bind(d);
    let reads = 0;
    d.read = (...a) => { reads++; return new Promise((r) => setTimeout(r, 30)).then(() => realRead(...a)); };
    const first = await Promise.all(Array.from({ length: 200 }, () => stats.xSearchAuthorsStatus({ now: noon })));
    ok(reads === 1 && first.every((x) => x.status === "ok"), `200 concurrent status requests make one store read (${reads})`);
    const lapsed = await Promise.all(Array.from({ length: 200 }, () => stats.xSearchAuthorsStatus({ now: noon + 31_000 })));
    ok(reads === 2 && lapsed.every((x) => x.status === "ok"), `after the 30 s reuse, 200 concurrent requests make one more read (${reads})`);
    d.read = () => new Promise(() => {});
    const t0 = Date.now();
    const hung = await Promise.race([stats.xSearchAuthorsStatus({ now: noon + 62_000 }), new Promise((r) => setTimeout(() => r({ status: "still waiting" }), 3_000).unref())]);
    ok(hung.status === "unknown" && Date.now() - t0 < 2_000, `a store read that never answers is cut at its deadline and reads unknown (${hung.status}, ${Date.now() - t0} ms)`);
    d.read = realRead;
  }

  // A flush keeps the flushed reads in the word: no alert -> ok -> alert flap.
  {
    const day = Date.parse(`${new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)}T12:00:00.000Z`);
    process.env.X_SEARCH_AUTHOR_DAILY_ALERT = "500";
    stats._resetXSearchStats();
    stats.noteXSearchAuthorReads({ authors: 490, now: day });
    await stats.flushXSearchStats({ now: day });
    stats._resetXSearchStats();
    let f = await stats.xSearchAuthorsStatus({ now: day, full: true });
    ok(f.status === "ok" && f.authorReadsToday === 490, `490 stored reads under a mark of 500 read ok (${JSON.stringify(f)})`);
    stats.noteXSearchAuthorReads({ authors: 20, now: day });
    f = await stats.xSearchAuthorsStatus({ now: day + 1_000, full: true });
    ok(f.status === "alert" && f.authorReadsToday === 510, `490 stored and 20 unflushed read alert (${JSON.stringify(f)})`);
    // While the batch is being written it still counts.
    const d = stats._xSearchStatsDoc();
    const realUpdate = d.update.bind(d);
    let release;
    const gate = new Promise((r) => { release = r; });
    d.update = (...a) => gate.then(() => realUpdate(...a));
    const flushing = stats.flushXSearchStats({ now: day });
    f = await stats.xSearchAuthorsStatus({ now: day + 2_000, full: true });
    ok(f.status === "alert" && f.authorReadsToday === 510, `a batch being written still counts (${JSON.stringify(f)})`);
    release();
    const fr = await flushing;
    d.update = realUpdate;
    ok(fr.ok && fr.flushed, "the flush lands");
    f = await stats.xSearchAuthorsStatus({ now: day + 3_000, full: true });
    ok(f.status === "alert" && f.authorReadsToday === 510, `after the flush, inside the 30 s reuse, it still reads alert (${JSON.stringify(f)})`);
    f = await stats.xSearchAuthorsStatus({ now: day + 40_000, full: true });
    ok(f.status === "alert" && f.authorReadsToday === 510, `the next store read agrees, with no double count (${JSON.stringify(f)})`);
    // A status read that started before a flush landed and answers after it
    // may hold the row from before the write: the larger figure stands.
    const day2 = day + 86_400_000;
    stats._resetXSearchStats();
    stats.noteXSearchAuthorReads({ authors: 490, now: day2 });
    await stats.flushXSearchStats({ now: day2 });
    stats._resetXSearchStats();
    ok((await stats.xSearchAuthorsStatus({ now: day2 })).status === "ok", "the second day starts at 490 stored, ok");
    stats.noteXSearchAuthorReads({ authors: 20, now: day2 });
    const d2 = stats._xSearchStatsDoc();
    const realRead2 = d2.read.bind(d2);
    let releaseRead;
    const readGate = new Promise((r) => { releaseRead = r; });
    let snapshotTaken;
    const taken = new Promise((r) => { snapshotTaken = r; });
    d2.read = async (...a) => { const before = await realRead2(...a); snapshotTaken(); await readGate; return before; };
    const overlapping = stats.xSearchAuthorsStatus({ now: day2 + 40_000, full: true });
    await taken;
    await stats.flushXSearchStats({ now: day2 });
    releaseRead();
    f = await overlapping;
    d2.read = realRead2;
    ok(f.status === "alert" && f.authorReadsToday === 510, `a status read from before a flush landed keeps the flushed reads (${JSON.stringify(f)})`);
    delete process.env.X_SEARCH_AUTHOR_DAILY_ALERT;
  }

  // Days past the keep window are pruned on the next write.
  const old = Date.now() - (stats.X_SEARCH_STATS_KEEP_DAYS + 5) * 86_400_000;
  sale({ authors: 1, posts: 1, now: old });
  await stats.flushXSearchStats();
  const body = JSON.parse(readFileSync(STATS_FILE, "utf8"));
  const days = Object.keys((body.body ?? body).days || {});
  ok(days.length === 3 && !days.includes(new Date(old).toISOString().slice(0, 10)), `a day past the keep window is pruned (${days.join(", ")})`);
} finally {
  server.close();
  globalThis.fetch = realFetch;
  stats._resetXSearchStats();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
