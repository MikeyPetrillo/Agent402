#!/usr/bin/env node
// A large fetched document does not hold the main loop while it is parsed.
//
// One JSON.parse is one stretch: an OpenAPI document near the crawl's size
// cap that is dense in small objects and distinct keys (every operation's
// schema naming its own properties, as generated documents do) held the loop
// for a quarter of a second here, and several times that on a slower host.
// The crawl now has such a document parsed in a child process and rebuilds it
// a piece per crawl-lane turn (src/crawl-parse.js, src/crawl-parse-child.js).
//
// Driven through the real crawl (src/x402-index.js crawlSeller) of a stub
// seller, in this process, with the longest main-thread turn read on the ours
// clock (scripts/lib/ours-clock.js), so a busy host does not decide it:
//   - the longest turn of a crawl of a document at the size cap stays under a
//     bound that the same document's in-place parse passes (the control);
//   - what the crawl indexes equals what the in-place path indexes for the
//     same content (CRAWL_PARSE_WORKER=off), for a document read on the
//     fallback path, one read beside a manifest, and a registry's whole list;
//   - a document that is not JSON is refused with the same error, and each
//     read is still handed its byte cap, a read refused for size recorded as
//     it was;
//   - when the parser cannot start, answers nothing or dies part-way, the
//     document is parsed in place (never dropped) and a log line says so;
//   - a long turn's log line names the document by a short hash of its
//     origin, never the host, with the size class.
// The parser is a process of its own with its own heap limit: a document whose tree may not
// fit is refused before it is parsed and takes the in-place path (run in a
// child process, since the failure this guards ends the process), the exit
// of a process does not wait on the parser, a document wrapped in tens or
// thousands of containers is split like any other, and the parser is gone
// once its queue is empty.
// Then the rebuild itself: values JSON text cannot carry, an own "__proto__"
// key, integer-like keys, deep nesting, long strings, in both piece formats.
// Mutation-checked: the off-loop path disabled, the long-list passes, the
// quote pick and the registry fold taken off the lane, the registry parse
// left in place, and the in-place fallback removed each fail it. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/loopback-only-preload.js"; // nothing here reaches a real host
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childJson } from "./lib/child-json.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownStoreEnv } from "./lib/own-stores.js";
import { bound, gapMeter, timeOurs, OURS_READING } from "./lib/ours-clock.js";

Object.assign(process.env, ownStoreEnv("crawl-parse-off-loop"));
process.env.X402_INDEX_CRAWL = "off";
process.env.MPP_INDEX_CRAWL = "off";
process.env.ROUTER_WORKERS = "0";
process.env.SELLER_PROBE_DAILY_BUDGET = "off";
delete process.env.CRAWL_PARSE_WORKER;
const dir = mkdtempSync(join(tmpdir(), "crawl-parse-off-loop-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
process.env.INDEX_CACHE_FILE = join(dir, "x402-index-cache.json");

const MB = 1024 * 1024;
const DOC_MB = Number(process.env.CRAWL_PARSE_DOC_MB || 12); // the OpenAPI read's cap
// Every wait below ends on its outcome or on this deadline, never on a fixed sleep.
const DEADLINE_MS = Number(process.env.CRAWL_PARSE_DEADLINE_MS || 120_000);
const within = (p, label) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: no outcome in ${DEADLINE_MS} ms`)), DEADLINE_MS); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

// ---- documents ---------------------------------------------------------------
/** An OpenAPI document of about `bytes`, dense in small objects and distinct keys. */
function denseOpenapi(bytes) {
  const parts = ['{"openapi":"3.1.0","info":{"title":"Stub","version":"1"},"paths":{'];
  let n = parts[0].length, i = 0;
  while (n < bytes - 2048) {
    const u = i.toString(36);
    let props = "";
    for (let j = 0; j < 24; j++) props += `${j ? "," : ""}"f${u}_${j}":{"type":"string","x${u}${j}":${j}}`;
    const op = `${i ? "," : ""}"/api/tool-${i}":{"post":{"operationId":"tool${i}","summary":"Tool ${i}","description":"Rows for query ${i}.","x-payment-info":{"price":"0.01","currency":"USDC","network":"base"},"requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{${props}}},"example":{"q":"alpha ${i}"}}}},"responses":{"200":{"description":"ok"},"402":{"description":"Payment Required"}}}}`;
    parts.push(op); n += op.length; i++;
  }
  parts.push("}}");
  return parts.join("");
}
/** An OpenAPI document holding many small priced operations (a long row list). */
function manyOperations(count) {
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(`"/p/${i}":{"${i % 2 ? "post" : "get"}":{"summary":"P ${i}","x-payment-info":{"price":"0.01","currency":"USDC","network":"base"}}}`);
  return `{"openapi":"3.1.0","info":{"title":"Stub","version":"1"},"paths":{${parts.join(",")}}}`;
}
function manifestOf(count) {
  const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD" }];
  return JSON.stringify({ x402Version: 2, name: "Stub seller", endpoints: Array.from({ length: count }, (_, i) => ({ path: `/m/${i}`, method: "POST", description: `Manifest tool ${i}`, price: "$0.005", accepts })) });
}
/** A registry's whole list in one document: `count` listings over `sellers` origins. */
function registryList(count, sellers) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push(`{"resource":"https://reg${i % sellers}.example/api/r-${i}","type":"http","x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:8453","maxAmountRequired":"${1000 + (i % 9000)}","payTo":"0x000000000000000000000000000000000000dEaD","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","description":"Resource ${i}: structured answers, priced per call.","outputSchema":{"input":{"type":"http","method":"POST","bodyFields":{"q":{"type":"string"}}}}}],"metadata":{"tags":["a","b${i % 30}"]}}`);
  }
  return `{"x402Version":2,"resources":[${parts.join(",")}]}`;
}

// ---- the crawl under test ------------------------------------------------------
const lines = [];
const realLog = console.log, realWarn = console.warn;
const quiet = /^\[x402-index\] (live-402 quote|unrecognized payment-ish|cycle|persisted)/;
console.log = (...a) => { lines.push(String(a[0])); if (!quiet.test(String(a[0])) && !/^\[x402-index\] crawl (parse|walk) /.test(String(a[0]))) realLog(...a); };
console.warn = (...a) => { lines.push(String(a[0])); if (!quiet.test(String(a[0])) && !/^\[x402-index\] crawl parse /.test(String(a[0]))) realWarn(...a); };
const idx = await import("../src/x402-index.js");
const { turnsDuring, _resetTurnsForTest } = await import("../src/active-jobs.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); realLog(`ok - ${m}`); };
const LIMIT = bound(Number(process.env.CRAWL_PARSE_TURN_MS || 100), 6);
realLog(`# ${DOC_MB} MB documents; ${LIMIT.note}`);

const served = new Map(); // origin -> { path: body | Error }
const readCaps = new Map(); // path -> the byte cap the crawl handed the read
const notFound = (url) => Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
idx.__setCrawlFetchForTest(async (url, opts) => {
  const u = new URL(url);
  readCaps.set(u.pathname, opts?.maxBytes);
  await new Promise((r) => setTimeout(r, 2)); // a read answers in a later turn, as a socket does
  const body = served.get(u.origin)?.[u.pathname];
  if (body === undefined) throw notFound(url);
  if (body instanceof Error) throw body;
  return { html: body, finalUrl: url, validators: {} };
});
idx.__setProbeFetchForTest(async () => { await new Promise((r) => setTimeout(r, 2)); return new Response("{}", { status: 404 }); });
const cache = idx._cacheForTests();

/** One crawl of `origin`, with the longest main-thread turn while it ran. */
async function crawl(origin, docs, label) {
  served.set(origin, docs);
  _resetTurnsForTest();
  await new Promise((r) => setImmediate(r));
  const meter = gapMeter(1);
  const t0 = Date.now();
  await within(idx.__crawlSellerForTest(origin, {}), label);
  // The crawl's last stretch ends in the microtasks that resolved it: one
  // more turn, so the meter's timer has read it.
  await new Promise((r) => setTimeout(r, 5));
  const { worst, worstWall } = meter.stop();
  const named = turnsDuring(t0, Date.now(), 3);
  realLog(`# ${label}: longest turn ${worst.toFixed(0)} ms (${OURS_READING}; wall ${worstWall.toFixed(0)} ms); longest named: ${named.join(", ") || "none over 20 ms"}`);
  return { worst, entry: cache.get(origin) };
}
/** What a crawl stored, with the origin and the clock taken out, for comparison. */
const stored = (entry, origin) => JSON.parse(JSON.stringify({
  tools: entry?.tools, toolsTotal: entry?.toolsTotal, error: entry?.error, discoveryPath: entry?.discoveryPath,
  openapiSummary: entry?.openapiSummary, fallbackErrors: entry?.fallbackErrors, source: entry?.source,
}, (k, v) => (/(At|Until)$/.test(k) && typeof v === "number" ? 0 : v)).replaceAll(origin, "https://ORIGIN")); // clock stamps (fetchedAt, quoteRefusedUntil) read 0
/** Two stored entries are the same; a difference is reported by its first few characters, not as a diff of thousands of rows. */
function sameStored(x, y, label) {
  const sx = JSON.stringify(x), sy = JSON.stringify(y);
  if (sx === sy) return;
  let at = 0;
  while (at < sx.length && sx[at] === sy[at]) at++;
  assert.fail(`${label}: the entries differ at character ${at}: ${sx.slice(Math.max(0, at - 60), at + 80)} | ${sy.slice(Math.max(0, at - 60), at + 80)}`);
}
const inPlace = async (fn) => { process.env.CRAWL_PARSE_WORKER = "off"; try { return await fn(); } finally { delete process.env.CRAWL_PARSE_WORKER; } };

// ---- 1. the turn bound, on the fallback path (no manifest: /openapi.json decides) ----
const dense = denseOpenapi(DOC_MB * MB);
const control = Math.min(timeOurs(() => JSON.parse(dense)).ms, timeOurs(() => JSON.parse(dense)).ms);
ok(dense.length > (DOC_MB - 1) * MB && control > LIMIT.ms, `control: parsing the ${(dense.length / MB).toFixed(1)} MB document in place holds the thread ${control.toFixed(0)} ms, past the ${LIMIT.ms} ms bound`);
const A = "https://dense-a.example", B = "https://dense-b.example";
const a = await crawl(A, { "/openapi.json": dense }, "crawl, document parsed off the loop");
ok(a.entry?.tools?.length > 1000 && a.entry.discoveryPath === "/openapi.json" && !a.entry.error, `control: the crawl indexed the document (${a.entry?.tools?.length} tools kept of ${a.entry?.toolsTotal ?? a.entry?.tools?.length})`);
ok(a.worst <= LIMIT.ms, `no turn of the crawl held the loop past ${LIMIT.ms} ms (longest ${a.worst.toFixed(0)} ms)`);

const { crawlParseStats, crawlParseStatus, CRAWL_PARSE_FALLBACK_WORD_MS, crawlParseIdle, __setCrawlParseForTest, parseOffLoop, parsesOffLoop, OFF_LOOP_MIN_CHARS } = await import("../src/crawl-parse.js");
ok(crawlParseStats().offLoop === 1 && crawlParseStats().pieces > 4 && crawlParseStats().fallbacks === 0, `the document was rebuilt from the parser's pieces (${crawlParseStats().pieces} pieces, no fallback)`);

// ---- 2. the same content through the in-place path indexes the same ----------------
const b = await inPlace(() => crawl(B, { "/openapi.json": dense }, "crawl, same document parsed in place"));
ok(crawlParseStats().offLoop === 1, "control: with the switch off the parser parsed nothing");
ok(b.worst > LIMIT.ms, `control: the in-place crawl of the same document holds a turn past the bound (${b.worst.toFixed(0)} ms)`);
sameStored(stored(a.entry, A), stored(b.entry, B), "dense document");
ok(true, "the entry stored from the pieces equals the entry stored from the in-place parse");
ok(readCaps.get("/.well-known/x402") === 4 * MB && readCaps.get("/openapi.json") === 12 * MB, "each read is handed its byte cap as before (4 MB manifest, 12 MB OpenAPI)");

// ---- 2b. depth is not a refusal: the same document inside 70 and inside 2,001 arrays ----
for (const levels of [70, 2001]) {
  const wrapped = `${"[".repeat(levels)}${dense}${"]".repeat(levels)}`;
  const W = `https://wrapped-${levels}-w.example`, X = `https://wrapped-${levels}-x.example`;
  const before = crawlParseStats();
  const w = await crawl(W, { "/openapi.json": wrapped }, `crawl, document inside ${levels} arrays`);
  const after = crawlParseStats();
  ok(after.offLoop === before.offLoop + 1 && after.fallbacks === before.fallbacks, `inside ${levels} arrays the document is still rebuilt from the parser's pieces`);
  ok(w.worst <= LIMIT.ms, `inside ${levels} arrays no turn of the crawl held the loop past ${LIMIT.ms} ms (longest ${w.worst.toFixed(0)} ms)`);
  const x = await inPlace(() => crawl(X, { "/openapi.json": wrapped }, "crawl, same wrapped document parsed in place"));
  sameStored(stored(w.entry, W), stored(x.entry, X), `inside ${levels} arrays`);
  const got = await within(parseOffLoop(wrapped, { turn: () => new Promise((r) => setImmediate(r)) }), "wrapped document");
  ok(got.ok && JSON.stringify(got.value) === JSON.stringify(JSON.parse(wrapped)), `inside ${levels} arrays the rebuilt value and the stored entry equal the in-place ones`);
}
{
  // With the queue empty the parser collects and reports what it still holds:
  // a small one stays for its idle wait (a start is a fork of this process),
  // a large one is ended at once.
  __setCrawlParseForTest({ idleRssMb: 1e9 });
  const first = await within(parseOffLoop(dense), "a document, then idle");
  await within(crawlParseIdle(), "the idle check");
  const starts = crawlParseStats().starts;
  ok(first.ok && crawlParseStats().running === true, "a parser holding little stays through its idle wait after the queue empties");
  const [p, q] = await within(Promise.all([parseOffLoop(dense), parseOffLoop(dense)]), "two documents queued");
  ok(p.ok && q.ok && crawlParseStats().starts === starts, "two documents queued together go through the waiting parser, one at a time, with no new start");
  __setCrawlParseForTest({ idleRssMb: 1e9, idleMs: 40 });
  const r = await within(parseOffLoop(dense), "a document before the idle wait");
  const startsNow = crawlParseStats().starts;
  await within((async () => { while (crawlParseStats().running) await new Promise((res) => setTimeout(res, 10)); })(), "the idle wait");
  ok(r.ok && crawlParseStats().running === false && crawlParseStats().starts === startsNow, "the parser ends once its idle wait passes with nothing to do");
  __setCrawlParseForTest({ idleRssMb: 1 });
  const z = await within(parseOffLoop(dense), "a document, then a large idle parser");
  await within(crawlParseIdle(), "the idle check");
  ok(z.ok && crawlParseStats().running === false, "a parser still holding memory when its queue empties is ended at once");
  __setCrawlParseForTest(null);
  ok(crawlParseStats().running === false, "control: the settings hook ends the parser");
}

// ---- 3. beside a manifest, with a long row list (the passes and the pick take lane slices) ----
const many = manyOperations(Number(process.env.CRAWL_PARSE_MANY_OPS || 60_000)), manifest = manifestOf(2000);
const C = "https://many-c.example", D = "https://many-d.example";
const c = await crawl(C, { "/.well-known/x402": manifest, "/openapi.json": many }, `crawl, manifest beside a ${(many.length / MB).toFixed(1)} MB document`);
ok(c.entry?.discoveryPath === "/.well-known/x402" && c.entry.toolsTotal > 50_000, `control: the manifest crawl read every row before the cap (${c.entry?.toolsTotal} listed, ${c.entry?.tools?.length} kept)`);
ok(c.worst <= LIMIT.ms, `no turn of the manifest crawl held the loop past ${LIMIT.ms} ms (longest ${c.worst.toFixed(0)} ms)`);
const d = await inPlace(() => crawl(D, { "/.well-known/x402": manifest, "/openapi.json": many }, "crawl, same documents parsed in place"));
sameStored(stored(c.entry, C), stored(d.entry, D), "manifest crawl");
ok(true, "the manifest crawl stores the same entry on both paths");
// Counted, so the machine's speed does not decide it: each whole-list walk of
// the long list ran as crawl-lane steps (an iteration counter beside the
// walk observer), and the quote pick, the longest of them, over several turns.
let iteration = 0, counting = true;
const tick = () => { iteration++; if (counting) setImmediate(tick); };
setImmediate(tick);
const walkTurns = new Map(); // walk name -> the loop iterations a stretch of it ended in
idx.__setCrawlWalkObserverForTest((name) => { if (!walkTurns.has(name)) walkTurns.set(name, new Set()); walkTurns.get(name).add(iteration); });
{
  const E = "https://many-e.example";
  await crawl(E, { "/.well-known/x402": manifest, "/openapi.json": many }, "crawl, walks counted");
  const ran = (name) => walkTurns.get(name)?.size || 0;
  ok(["routes", "merge", "vouch", "stamp", "carry", "quote-pick"].every((w) => ran(w) >= 1), `the long list's route list, merge, vouch, stamp, carry and quote pick ran as crawl-lane steps (${[...walkTurns].map(([k, v]) => `${k}:${v.size}`).join(" ")})`);
  ok(ran("quote-pick") >= 2, `the quote pick over the long list took ${ran("quote-pick")} loop iterations, not one`);
}

// ---- 4. a document that is not JSON, and a read refused for its size ---------------
const broken = dense.slice(0, 3 * MB); // cut mid-document
let inPlaceError = null;
try { JSON.parse(broken); } catch (e) { inPlaceError = e; }
const offLoopError = await within(parseOffLoop(broken, { turn: () => new Promise((r) => setImmediate(r)) }), "invalid document").then(() => null, (e) => e);
ok(inPlaceError instanceof SyntaxError && offLoopError instanceof SyntaxError && offLoopError.message === inPlaceError.message, `invalid JSON is a SyntaxError with the same text on both paths ("${inPlaceError.message.slice(0, 60)}...")`);
const F = "https://broken-f.example", G = "https://broken-g.example";
const f = await crawl(F, { "/openapi.json": broken }, "crawl, document cut short");
const g = await inPlace(() => crawl(G, { "/openapi.json": broken }, "crawl, same cut document parsed in place"));
ok(f.entry?.error && !(f.entry?.tools?.length) && (f.entry.fallbackErrors || []).some((x) => x.path === "/openapi.json" && /JSON/.test(x.error)), `the crawl refuses the cut document and says which file (${(f.entry?.fallbackErrors || []).map((x) => x.path).join(", ")})`);
sameStored(stored(f.entry, F), stored(g.entry, G), "cut document");
ok(true, "the refusal is recorded the same on both paths");
const tooLarge = Object.assign(new Error("Response too large (limit 12582912 bytes)"), { statusCode: 422 });
const H = "https://large-h.example", I = "https://large-i.example";
const h = await crawl(H, { "/openapi.json": tooLarge }, "crawl, read refused for size");
const i = await inPlace(() => crawl(I, { "/openapi.json": tooLarge }, "crawl, same refusal, in-place path"));
ok((h.entry?.fallbackErrors || []).some((x) => x.path === "/openapi.json" && /too large/.test(x.error)) && !(h.entry?.tools?.length), "a read refused for size indexes nothing and is recorded against its file");
sameStored(stored(h.entry, H), stored(i.entry, I), "size refusal");
ok(true, "the size refusal is recorded the same on both paths");

// ---- 5. a registry's whole list in one document ------------------------------------
const list = registryList(Number(process.env.CRAWL_PARSE_REGISTRY_ROWS || 40_000), 400);
const source = { name: "stub registry", url: "https://registry.example/list", synthesizeTools: true };
let discoveryCap = null;
idx.__setDiscoveryBodyFetchForTest(async (url, opts) => { discoveryCap = opts?.maxBytes; await new Promise((r) => setTimeout(r, 2)); return { html: list, finalUrl: url }; });
const discover = async (label) => {
  _resetTurnsForTest();
  const meter = gapMeter(1);
  await within(idx.__discoverSourceForTest(source), label);
  await new Promise((r) => setTimeout(r, 5));
  const { worst } = meter.stop();
  const st = idx.__discoveryStateForTest();
  realLog(`# ${label}: longest turn ${worst.toFixed(0)} ms`);
  return { worst, tools: JSON.stringify([...st.bazaarTools].filter(([o]) => /\/\/reg\d+\.example$/.test(o)).sort(([x], [y]) => (x < y ? -1 : 1))), status: [...st.status.values()].find((s) => s.url === source.url) };
};
walkTurns.clear();
const rebuiltBefore = crawlParseStats().offLoop;
const r1 = await discover(`discovery, ${(list.length / MB).toFixed(1)} MB list parsed off the loop`);
ok((walkTurns.get("registry-fold")?.size || 0) === 40, `the 40,000 listings were folded 1,000 per loop iteration (${walkTurns.get("registry-fold")?.size} iterations)`);
ok(crawlParseStats().offLoop === rebuiltBefore + 1, "the registry list was parsed in the parser and rebuilt from its pieces");
counting = false;
idx.__setCrawlWalkObserverForTest(null);
ok(r1.status?.resources === 40_000 && r1.status.origins === 400 && !r1.status.error && discoveryCap === 64 * MB, `control: the pass read the whole list (${r1.status?.resources} listings, ${r1.status?.origins} origins) under its 64 MB cap`);
ok(r1.worst <= LIMIT.ms, `no turn of the discovery pass held the loop past ${LIMIT.ms} ms (longest ${r1.worst.toFixed(0)} ms)`);
const r2 = await inPlace(() => discover("discovery, same list parsed in place"));
ok(r1.tools === r2.tools && r1.tools.length > MB && r2.status.resources === r1.status.resources, "the registry rows published are the same on both paths");
idx.__setDiscoveryBodyFetchForTest(null);

// ---- 6. the long-turn line names the document by hash and size class ---------------
{
  const J = "https://named-j.example";
  const was = idx.__setCrawlTurnLogForTest(0);
  lines.length = 0;
  await crawl(J, { "/openapi.json": dense }, "crawl, every parse logged");
  idx.__setCrawlTurnLogForTest(was);
  const key = createHash("sha256").update(J).digest("hex").slice(0, 8);
  const line = lines.find((l) => l.startsWith(`[x402-index] crawl parse ${key} /openapi.json `));
  ok(line && new RegExp(`^\\[x402-index\\] crawl parse ${key} /openapi\\.json 4-12MB: in pieces longest=\\d+ms total=\\d+ms pieces=\\d+$`).test(line), `a long parse is logged with the origin's hash, the file and the size class (${line})`);
  ok(lines.filter((l) => /crawl (parse|walk) /.test(l)).length > 0 && !lines.some((l) => /crawl (parse|walk) /.test(l) && l.includes("named-j")), "no parse or walk line carries the host");
  const walk = lines.find((l) => l.startsWith(`[x402-index] crawl walk routes ${key} /openapi.json`));
  ok(walk && /^\[x402-index\] crawl walk routes [0-9a-f]{8} \/openapi\.json: longest=\d+ms$/.test(walk), `a walk is logged the same way, by hash (${walk})`);
  ok(was === 100, "the line's threshold is 100 ms unless a test lowers it");
}

// ---- 7. the parser failing: the document is parsed in place and a line says so -----
const hang = join(dir, "hang.mjs"), dies = join(dir, "dies.mjs");
writeFileSync(hang, 'process.on("message", () => {});\n');
writeFileSync(dies, 'process.on("message", (m) => { if (m.op === "parse") process.send({ id: m.id, enc: "json", piece: \'[["o"]]\', weight: 8, done: false }); else if (m.op === "next") process.exit(3); });\n');
let at = 0;
for (const [what, over, reason] of [
  ["cannot start", { workerFile: join(dir, "absent.mjs") }, /parser (error|exited|ended)|channel closed|EPIPE/i],
  ["answers nothing", { workerFile: hang, stepTimeoutMs: 150 }, /no answer in 150 ms/],
  ["dies part-way", { workerFile: dies }, /parser (error|exited)/],
]) {
  __setCrawlParseForTest(over);
  const before = crawlParseStats();
  const K = `https://failing-${at++}.example`;
  lines.length = 0;
  const k = await crawl(K, { "/openapi.json": dense }, `crawl, parser ${what}`);
  const after = crawlParseStats();
  sameStored(stored(k.entry, K), stored(a.entry, A), `parser ${what}`);
  ok(after.fallbacks === before.fallbacks + 1 && after.offLoop === before.offLoop, `parser ${what}: the document is parsed in place and indexed as before`);
  const key = createHash("sha256").update(K).digest("hex").slice(0, 8);
  const line = lines.find((l) => l.startsWith(`[x402-index] crawl parse ${key} /openapi.json 4-12MB: parsed on the main thread (`));
  ok(line && reason.test(line) && !line.includes("failing-"), `parser ${what}: the log line says so, by hash (${line})`);
}
// Three failures in a row and the parser is left alone for a while; a parse still answers.
__setCrawlParseForTest({ workerFile: join(dir, "absent.mjs") });
{
  const starts = crawlParseStats().starts;
  ok(crawlParseStatus().status === "ok", "control: the crawlParse word reads ok before any failure");
  { const r = await within(parseOffLoop(dense), "failing parse"); assert.ok(r.ok === false && !/paused/.test(r.reason), r.reason); }
  ok(crawlParseStatus().status === "fallback" && crawlParseStatus({ now: Date.now() + CRAWL_PARSE_FALLBACK_WORD_MS + 1 }).status === "ok",
    "one parser failure reads fallback on the crawlParse word for the hour that follows, then ok");
  for (let q = 1; q < 3; q++) { const r = await within(parseOffLoop(dense), "failing parse"); assert.ok(r.ok === false && !/paused/.test(r.reason), r.reason); }
  ok(crawlParseStats().paused && crawlParseStats().starts === starts + 3, "after three failures in a row the parser is left alone for a while");
  ok(crawlParseStatus().status === "paused" && Object.keys(crawlParseStatus()).join() === "status", "while it is left alone the word reads paused, one word and no counter");
  const kept = [{ source: "registry", word: "too-large-to-parse" }];
  const full = crawlParseStatus({ full: true, registriesKept: kept });
  ok(full.status === "registry-kept" && full.registriesKept[0].source === "registry" && typeof full.fallbacks === "number" && crawlParseStatus({ registriesKept: kept }).status === "registry-kept",
    "a registry whose whole list was not parsed on its last pass reads registry-kept, the source named for the operator only");
  process.env.CRAWL_PARSE_WORKER = "off";
  ok(crawlParseStatus().status === "off", "CRAWL_PARSE_WORKER=off reads off");
  delete process.env.CRAWL_PARSE_WORKER;
  const r = await within(parseOffLoop(dense), "paused parse");
  ok(r.ok === false && /paused/.test(r.reason) && crawlParseStats().starts === starts + 3, "while paused a document is handed back for the in-place parse at once, with no parser started");
}
__setCrawlParseForTest(null);
{
  const r = await within(parseOffLoop(dense, { turn: () => new Promise((res) => setImmediate(res)) }), "restored parse");
  ok(r.ok === true && !crawlParseStats().paused, "control: with the real parser restored the next document is rebuilt from pieces");
}

// ---- 7b. bounded by its input, in a child process ----------------------------------
const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Run a module script in a child of this tree; resolves { code, signal, out, closedAt }. */
const child = (script) => within(new Promise((resolve) => {
  const c = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, env: { ...process.env, CRAWL_PARSE_WORKER: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  c.stdout.on("data", (d) => { out += d; });
  c.stderr.on("data", (d) => { err += d; });
  c.on("close", (code, signal) => resolve({ code, signal, out, err: err.slice(-300), closedAt: Date.now() }));
}), "child process");
{
  // A list of empty objects costs the heap about 30 times its text. With a
  // small limit on the parser it is refused unparsed; were it parsed there,
  // the parser would reach the limit inside JSON.parse.
  const r = await child(`
    import "./scripts/lib/offline-stores.js";
    const { parseOffLoop, __setCrawlParseForTest, crawlParseStats } = await import("./src/crawl-parse.js");
    __setCrawlParseForTest({ heapMb: 64 });
    const text = "[" + "{},".repeat(2_000_000) + "{}]";
    const r = await parseOffLoop(text);
    const small = await parseOffLoop("[" + "{},".repeat(100_000) + "{}]");
    console.log(JSON.stringify({ ok: r.ok, reason: r.reason, smallOk: small.ok, inPlace: JSON.parse(text).length, stats: crawlParseStats() }));
    process.exit(0);
  `);
  const got = r.code === 0 ? childJson(r.out) : null;
  ok(r.code === 0 && got.ok === false && /^unsplit: about \d+ MB parsed, past the parser's 32 MB$/.test(got.reason) && got.inPlace === 2_000_001, `a document whose tree may not fit the parser is refused unparsed and the process lives to parse it in place (exit ${r.code}${r.signal ? ` ${r.signal}` : ""}: ${got?.reason || r.err})`);
  ok(got.smallOk === true && got.stats.paused === false, "control: under the same limit a smaller list is rebuilt from pieces, and a refusal is not a parser failure");
}
{
  // The exit of a process does not wait on the parser: with a 64 MB list of
  // empty objects handed to the parse, process.exit comes back at once.
  const LATE = bound(1000, 40);
  const r = await child(`
    import "./scripts/lib/offline-stores.js";
    const { parseOffLoop, stopCrawlParse, parsesOffLoop, crawlParseStats } = await import("./src/crawl-parse.js");
    const text = "[" + "{},".repeat(22_000_000) + "{}]";
    let settled = false;
    parseOffLoop(text).then(() => { settled = true; }, () => { settled = true; });
    setTimeout(() => {
      stopCrawlParse();
      console.log(JSON.stringify({ exitAt: Date.now(), settledBefore: settled, offLoopAfterStop: parsesOffLoop(text), running: crawlParseStats().running }));
      process.exit(0);
    }, 120);
  `);
  const got = r.code === 0 ? childJson(r.out) : null;
  ok(r.code === 0 && r.closedAt - got.exitAt <= LATE.ms, `a process with a 64 MB list handed to the parse exits ${r.code === 0 ? r.closedAt - got.exitAt : "?"} ms after process.exit (exit ${r.code}${r.signal ? ` ${r.signal}` : ""}; ${LATE.note})`);
  ok(got.offLoopAfterStop === false && got.running === false, "after stopCrawlParse the parser is gone and every later parse stays in place");
  const server = await (await import("node:fs/promises")).readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const drain = server.slice(server.indexOf("function shutdown(signal"));
  ok(/try \{ stopCrawlParse\(\); \}/.test(drain.slice(0, drain.indexOf("httpServer.close("))), "the server's drain ends the parser before it closes the listener");
}
// A refusal for size is the document, not a failing parser: it never pauses the parser.
{
  const nineMb = `[${"{},".repeat(3_000_000)}{}]`;
  const before = crawlParseStats();
  for (let q = 0; q < 4; q++) { const r = await within(parseOffLoop(nineMb), "refused document"); assert.ok(r.ok === false && /^unsplit: about \d+ MB parsed, past the parser's 256 MB$/.test(r.reason), r.reason); }
  ok(crawlParseStats().fallbacks === before.fallbacks + 4 && !crawlParseStats().paused, "at the shipped limit a 9 MB list of empty objects is refused unparsed each time, and the parser is not paused for it");
}

// ---- 8. the rebuild is the value JSON.parse returns ---------------------------------
ok(OFF_LOOP_MIN_CHARS === 256 * 1024 && !parsesOffLoop("x".repeat(OFF_LOOP_MIN_CHARS - 1)) && parsesOffLoop("x".repeat(OFF_LOOP_MIN_CHARS)) && !parsesOffLoop(undefined), "a document under 256 KB (and a missing body) keeps the in-place path");
const edge = [
  ["negative zero and an out-of-range number", `{"z":-0,"big":1e999,"neg":-1e999,"rows":[${Array.from({ length: 3000 }, (_, j) => `{"i":${j},"v":-0}`).join(",")}]}`],
  ["an own __proto__ key, whole and split", `{"__proto__":{"a":1},"list":[${Array.from({ length: 2000 }, (_, j) => `{"__proto__":${j},"k":"v${j}"}`).join(",")}],"deep":{"__proto__":{"rows":[${Array.from({ length: 2000 }, (_, j) => `"r${j}"`).join(",")}]}}}`],
  ["integer-like and repeated keys", `{"10":"a","2":"b","x":1,"x":2,"1":{"b":1,"a":2,"b":3},"m":{${Array.from({ length: 4000 }, (_, j) => `"${(j * 7919) % 4001}":${j}`).join(",")}}}`],
  ["nesting and empty containers", `${"[".repeat(40)}{"a":[],"b":{},"c":[[],[{}],""],"d":null,"e":[true,false,null,0,1.5e-7,"\\ud83d\\ude00","\\ud800"]}${"]".repeat(40)}`],
  ["a long string and a long flat array", `{"s":"${"é\\n".repeat(60_000)}","nums":[${Array.from({ length: 30_000 }, (_, j) => j * 1.25).join(",")}]}`],
  ["a bare scalar", `"${"y".repeat(5000)}"`],
  ["heavy containers nested in arrays", `[${Array.from({ length: 12 }, (_, j) => `[${Array.from({ length: 12 }, (_, q) => `{"k${j}_${q}":[${Array.from({ length: 300 }, (_, z) => `{"z":${z}}`).join(",")}]}`).join(",")}]`).join(",")}]`],
];
const turn = () => new Promise((r) => setImmediate(r));
for (const clone of [false, true]) {
  __setCrawlParseForTest({ minChars: 1, pieceBytes: 2048, minPieceBytes: 1024, maxPieceBytes: 4096, clone });
  for (const [what, text] of edge) {
    const want = JSON.parse(text);
    const got = await within(parseOffLoop(text, { turn }), what);
    assert.ok(got.ok, `${what}: ${got.reason}`);
    assert.deepStrictEqual(got.value, want);
    assert.equal(JSON.stringify(got.value), JSON.stringify(want)); // key order too
    if (what.startsWith("negative zero")) assert.ok(Object.is(got.value.z, -0) && got.value.big === Infinity && got.value.neg === -Infinity && Object.is(got.value.rows[2999].v, -0));
    if (what.startsWith("an own __proto__")) assert.ok(Object.hasOwn(got.value, "__proto__") && Object.getPrototypeOf(got.value) === Object.prototype && Object.hasOwn(got.value.list[7], "__proto__") && Object.hasOwn(got.value.deep, "__proto__") && Object.getPrototypeOf(got.value.deep) === Object.prototype);
    if (what !== "a bare scalar" && what !== "nesting and empty containers") assert.ok(got.pieces > 3, `${what}: split into pieces (${got.pieces})`);
  }
  ok(true, `the rebuilt value equals JSON.parse's for ${edge.length} hard shapes, pieces sent as ${clone ? "structured clones" : "JSON text"}`);
}
// Depth alone: thousands of levels, each sent as its own step, rebuilt exactly.
__setCrawlParseForTest({ minChars: 1, pieceBytes: 1024, minPieceBytes: 1024 });
for (const nested of [
  `${'{"a":['.repeat(80)}"${"q".repeat(4000)}"${"]}".repeat(80)}`,
  `${"[".repeat(5000)}1,[2,{"k":[]}]${"]".repeat(5000)}`,
  `${'{"":'.repeat(3000)}[-0,"${"z".repeat(3000)}"]${"}".repeat(3000)}`,
]) {
  const r = await within(parseOffLoop(nested, { turn }), "nested document");
  // Compared level by level with a loop: an assertion that recurses would not reach the bottom.
  let x = r.value, y = JSON.parse(nested), levels = 0;
  for (;;) {
    const kx = Array.isArray(x) ? "array" : typeof x, ky = Array.isArray(y) ? "array" : typeof y;
    assert.equal(kx, ky);
    if (x === null || typeof x !== "object" || Object.keys(x).length !== 1) break;
    assert.deepStrictEqual(Object.keys(x), Object.keys(y));
    const k = Object.keys(x)[0]; x = x[k]; y = y[k]; levels++;
  }
  assert.deepStrictEqual(x, y);
  ok(r.ok && levels >= 80 && r.pieces > 1, `a document nested ${levels} levels deep is split and rebuilt exactly (${r.pieces} pieces)`);
}
__setCrawlParseForTest(null);

// The parse the existing lane pin reads is still a named span in its lane turn.
const src = await (await import("node:fs/promises")).readFile(new URL("../src/x402-index.js", import.meta.url), "utf8");
ok(/span: \(fn\) => laneSpan\("crawl-parse", fn\)/.test(src) && /turn: crawlLaneTurn/.test(src), "each piece is rebuilt in a crawl-lane turn, as the named span crawl-parse");

idx.stopCrawler?.();
realLog(`test-crawl-parse-off-loop: ${n} passed`);
process.exit(0);
