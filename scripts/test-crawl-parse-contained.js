#!/usr/bin/env node
// No fetched document, of any shape, ends the server through its parser.
//
// A parser that runs out of memory inside JSON.parse ends the process it runs
// in, and no reading of the text taken before the parse bounds the tree for
// every shape: an object's integer-like key reserves a slot for each index
// below it, so a few bytes of text cost hundreds of bytes of heap. The crawl's
// off-loop parser is therefore a child process with its own heap limit
// (src/crawl-parse.js, src/crawl-parse-child.js): a document whose tree does
// not fit ends the child, and the server parses it in place as it always did.
//
// Proven here on a stand-in for the server: a process started with the
// NODE_OPTIONS the image sets (read from the Dockerfile, not typed), which
//   - searches document shapes for the most heap per character of text
//     (integer-like keys of every width, chains of them, empty containers,
//     one-key objects, tiny strings, numbers, wide strings, and seeded random
//     mixes of these), measured in place on a small document;
//   - hands the costliest shapes, and a fixed list, to the parser at the
//     crawl's byte caps (12 MB for a seller's document, 64 MB for a registry
//     list) and checks, for every one, that it is still running and that the
//     document was either rebuilt equal to JSON.parse's value or handed back
//     to be parsed in place;
//   - crawls the two documents a review found (a valid OpenAPI head followed
//     by chains of integer-like keys; flat rows of one such key) through the
//     index's own crawl and stores them as the in-place path does.
// Also pinned: the child gets an allowlisted environment and neither the
// server's flags nor its preloads; a parse waiting on the child is handed
// back at once when the parser is stopped; a light subtree nested past the
// whole-value height is still split; an array that grew piece by piece is
// stored at its exact length.
// Mutation-checked: the heap limit taken off the child, the stop check in
// `ask`, the height check and the exact copy each fail it. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/loopback-only-preload.js"; // nothing here reaches a real host
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { childJson } from "./lib/child-json.js";
import { ownStoreEnv } from "./lib/own-stores.js";

const MB = 1024 * 1024;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELLER_CAP = 12 * MB, REGISTRY_CAP = 64 * MB; // MAX_OPENAPI_BYTES, MAX_DISCOVERY_BYTES (src/x402-index.js)
const DEADLINE_MS = Number(process.env.CRAWL_CONTAINED_DEADLINE_MS || 600_000);

// ---- shapes --------------------------------------------------------------------
const rep = (one, bytes, open = "[", close = "]") => { const k = Math.max(1, Math.floor((bytes - 2) / (one.length + 1))); return open + (one + ",").repeat(k - 1) + one + close; };
const chain = (key, levels, leaf = "1") => `{"${key}":`.repeat(levels) + leaf + "}".repeat(levels);
const counted = (bytes, unit) => { const p = []; let len = 0, i = 0; while (len < bytes) { const s = unit(i++); p.push(s); len += s.length + 1; } return p; };
const DIGIT_KEYS = ["9", "16", "34", "35", "99", "100", "322", "499", "999", "1000", "1023", "1024", "1025", "4999", "9999", "65535", "99999", "999999", "4294967294", "4294967295"];
const FIXED = {
  ...Object.fromEntries(DIGIT_KEYS.map((k) => [`key ${k}`, (b) => rep(`{"${k}":1}`, b)])),
  ...Object.fromEntries(["34", "100", "1000"].flatMap((k) => [2, 4, 8, 64].map((d) => [`chain ${k} x${d}`, (b) => rep(chain(k, d), b)]))),
  "two index keys": (b) => rep('{"0":1,"70":1}', b),
  "index key, array value": (b) => rep('{"34":[]}', b),
  "index key under arrays": (b) => rep('[[[{"34":1}]]]', b),
  "empty objects": (b) => rep("{}", b),
  "empty arrays": (b) => rep("[]", b),
  "one distinct key each": (b) => `[${counted(b, (i) => `{"${i.toString(36)}":1}`).join(",")}]`,
  "distinct keys, one object": (b) => `{${counted(b, (i) => `"${i.toString(36)}":1`).join(",")}}`,
  "nested distinct keys": (b) => `[${counted(b, (i) => `{"${i.toString(36)}":{"${(i + 1).toString(36)}_":0}}`).join(",")}]`,
  "tiny strings": (b) => `[${counted(b, (i) => `"${i.toString(36)}"`).join(",")}]`,
  "empty strings": (b) => rep('""', b),
  "numbers": (b) => rep("1.5", b),
  "large numbers": (b) => rep("3e9", b),
  "negative zeros": (b) => rep("-0", b),
  "wide strings": (b) => rep(`"\\u0100${"a".repeat(1000)}"`, b),
  "one wide string": (b) => `{"s":"\\u0100${"a".repeat(b - 20)}"}`,
  "escaped string": (b) => `["${"\\u0041".repeat(Math.floor(b / 6) - 2)}"]`,
  "deep arrays": (b) => "[".repeat(b / 2) + "]".repeat(b / 2),
  "deep objects": (b) => { const k = Math.floor(b / 7); return '{"":'.repeat(k) + "0" + "}".repeat(k); },
  "deep index chain": (b) => chain("34", Math.floor(b / 7)),
  "repeated key": (b) => `{${rep('"a":[1]', b - 2, "", "")}}`,
  "index rows then a wide string": (b) => { const a = Math.floor(b / 2); return `{"a":${rep('{"34":1}', a)},"s":"\\u0100${"a".repeat(b - a - 30)}"}`; },
  // The review's document: a valid OpenAPI head, then chains of an integer-like key.
  "openapi head, index chains": (b) => `{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{"/a":{"get":{"summary":"A","x-payment-info":{"price":"0.01","currency":"USDC","network":"base"},"responses":{"200":{"description":"ok"}}}}},"x":${rep(chain("34", 8), b - 240)}}`,
};
/** Seeded mixes: a unit built from random parts, repeated to the size asked. */
function mixes(count, seed = 20261127) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const leaf = () => pick(["1", "0", "-0", "1.5", "3e9", '""', '"a"', "[]", "{}", "null", "true", '"\\u0100"']);
  const node = (depth) => {
    const r = rnd();
    if (depth <= 0 || r < 0.15) return leaf();
    if (r < 0.6) { const keys = 1 + Math.floor(rnd() * 3), parts = []; for (let k = 0; k < keys; k++) parts.push(`"${rnd() < 0.8 ? pick(DIGIT_KEYS) : pick(["a", "", "k1", "__proto__"])}":${node(depth - 1)}`); return `{${parts.join(",")}}`; }
    const len = 1 + Math.floor(rnd() * 3), parts = []; for (let k = 0; k < len; k++) parts.push(node(depth - 1));
    return `[${parts.join(",")}]`;
  };
  const out = {};
  for (let i = 0; i < count; i++) { const unit = node(1 + Math.floor(rnd() * 5)); out[`mix ${i} ${unit.length > 40 ? `${unit.slice(0, 37)}...` : unit}`] = (b) => rep(unit, b); }
  return out;
}
/** A dense OpenAPI document and a registry list, as honest sellers and registries publish them. */
function denseOpenapi(bytes) {
  const parts = ['{"openapi":"3.1.0","info":{"title":"Stub","version":"1"},"paths":{'];
  let len = parts[0].length, i = 0;
  while (len < bytes - 2048) {
    const u = i.toString(36);
    let props = "";
    for (let j = 0; j < 24; j++) props += `${j ? "," : ""}"f${u}_${j}":{"type":"string","x${u}${j}":${j}}`;
    const op = `${i ? "," : ""}"/api/tool-${i}":{"post":{"operationId":"tool${i}","summary":"Tool ${i}","description":"Rows for query ${i}.","x-payment-info":{"price":"0.01","currency":"USDC","network":"base"},"requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{${props}}}}}},"responses":{"200":{"description":"ok"}}}}`;
    parts.push(op); len += op.length; i++;
  }
  parts.push("}}");
  return parts.join("");
}
const ordinaryOpenapi = (bytes) => `{"openapi":"3.1.0","info":{"title":"Stub","version":"1"},"paths":{${counted(bytes - 80, (i) => `"/v1/items/${i}":{"get":{"operationId":"getItem${i}","summary":"Read item ${i}","description":"Returns the item with its fields, as JSON. Costs one call. ${"Longer prose about the parameters and what the answer holds. ".repeat(3)}","parameters":[{"name":"id","in":"query","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"ok"}}}}`).join(",")}}}`;
const registryList = (bytes) => `{"x402Version":2,"resources":[${counted(bytes - 40, (i) => `{"resource":"https://reg${i % 900}.example/api/r-${i}","type":"http","x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:8453","maxAmountRequired":"${1000 + (i % 9000)}","payTo":"0x000000000000000000000000000000000000dEaD","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","description":"Resource ${i}: weather rows as json"}],"lastUpdated":"2026-01-01T00:00:00Z"}`).join(",")}]}`;

/** Two parsed values are the same, key order included; no recursion, so depth is no limit. */
function sameValue(x, y) {
  const stack = [[x, y]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (a === null || typeof a !== "object") { if (!Object.is(a, b)) return false; continue; }
    if (b === null || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) stack.push([a[i], b[i]]); continue; }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) { if (ka[i] !== kb[i]) return false; stack.push([a[ka[i]], b[kb[i]]]); }
  }
  return true;
}

// ================================ the stand-in ===================================
if (process.env.CRAWL_CONTAINED_STAND_IN === "1") {
  const out = (o) => console.log(`@@${JSON.stringify(o)}`);
  const { parseOffLoop, crawlParseStats, __setCrawlParseForTest, stopCrawlParse } = await import("../src/crawl-parse.js");
  const turn = () => new Promise((r) => setImmediate(r));
  const gc = () => { globalThis.gc(); globalThis.gc(); };
  const liveBytes = () => { gc(); return process.memoryUsage().heapUsed; };
  const hold = globalThis.__crawlContainedHold = { v: null };
  const all = { ...FIXED, ...mixes(Number(process.env.CRAWL_CONTAINED_MIXES || 120)) };

  // ---- the search: heap per character, in place, on a small document ----
  const ranked = [];
  for (const [name, make] of Object.entries(all)) {
    const text = make(MB / 2);
    const before = liveBytes();
    hold.v = JSON.parse(text); // held where the collector can see it is live
    const perChar = (liveBytes() - before) / text.length;
    hold.v = null;
    ranked.push({ name, perChar });
  }
  ranked.sort((a, b) => b.perChar - a.perChar);
  out({ search: { shapes: ranked.length, worst: ranked.slice(0, 8).map((r) => ({ name: r.name, perChar: Math.round(r.perChar) })) } });

  // ---- at the caps ----
  let worstTurn = 0;
  async function atCap(name, text, { inPlace = true } = {}) {
    let last = performance.now(), longest = 0;
    const iv = setInterval(() => { const now = performance.now(); if (now - last > longest) longest = now - last; last = now; }, 1);
    const before = crawlParseStats();
    const t0 = performance.now();
    let r, threw = null;
    try { r = await parseOffLoop(text, { turn }); } catch (e) { threw = e; }
    clearInterval(iv);
    const wall = performance.now() - t0;
    if (longest > worstTurn) worstTurn = longest;
    const after = crawlParseStats();
    let outcome, equal = null;
    if (threw) outcome = `threw ${threw.name}`;
    else if (r.ok) { outcome = "rebuilt"; equal = sameValue(r.value, JSON.parse(text)); }
    else {
      outcome = after.died > before.died ? "parser ended, handed back" : /^unsplit/.test(r.reason) ? "declined, handed back" : `handed back (${r.reason})`;
      // The in-place parse the crawl then makes, as it did before there was a parser.
      if (inPlace) { hold.v = JSON.parse(text); equal = hold.v !== undefined; hold.v = null; }
    }
    r = null; gc();
    out({ case: { name, chars: text.length, outcome, equal, wall: Math.round(wall), longestTurn: Math.round(longest) } });
  }
  const sellerCases = [...new Set([...ranked.slice(0, Number(process.env.CRAWL_CONTAINED_TOP || 10)).map((r) => r.name), ...Object.keys(FIXED)])];
  for (const name of sellerCases) await atCap(`${name} @ seller cap`, all[name](SELLER_CAP - 64));
  // The registry cap: the costliest shapes and the review's flat rows. A tree
  // of this size is not then parsed in place here (that parse is the path the
  // server had before the parser, and is not what this suite contains).
  for (const name of [...new Set([...ranked.slice(0, 3).map((r) => r.name), "key 34", "chain 34 x8", "empty objects", "tiny strings"])]) await atCap(`${name} @ registry cap`, all[name](REGISTRY_CAP - 64), { inPlace: false });
  await atCap("key 34 @ 14 MB", all["key 34"](14 * MB), { inPlace: true });
  // Honest documents: which are rebuilt off the loop, which are handed back.
  for (const [name, make, sizes] of [["ordinary OpenAPI", ordinaryOpenapi, [1, 4, 8, 12]], ["dense OpenAPI", denseOpenapi, [1, 4, 8, 12]], ["registry list", registryList, [8, 20, 36, 64]]]) {
    for (const mb of sizes) await atCap(`honest: ${name} ${mb} MB`, make(mb * MB - 64));
  }
  out({ worstTurn: Math.round(worstTurn), stats: crawlParseStats() });

  // ---- the review's documents through the index's own crawl ----
  {
    Object.assign(process.env, { X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", ROUTER_WORKERS: "0", SELLER_PROBE_DAILY_BUDGET: "off" });
    const quietLog = console.log, kept = [];
    console.log = (...a) => { if (String(a[0]).startsWith("@@")) quietLog(...a); else kept.push(String(a[0])); };
    console.warn = (...a) => { kept.push(String(a[0])); };
    const idx = await import("../src/x402-index.js");
    const served = new Map();
    idx.__setCrawlFetchForTest(async (url) => {
      const u = new URL(url);
      await new Promise((r) => setTimeout(r, 2));
      const body = served.get(u.origin)?.[u.pathname];
      if (body === undefined) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
      return { html: body, finalUrl: url, validators: {} };
    });
    idx.__setProbeFetchForTest(async () => { await new Promise((r) => setTimeout(r, 2)); return new Response("{}", { status: 404 }); });
    const cache = idx._cacheForTests();
    const stored = (e) => JSON.stringify({ tools: e?.tools, error: e?.error, path: e?.discoveryPath, total: e?.toolsTotal }, (k, v) => (/(At|Until)$/.test(k) && typeof v === "number" ? 0 : v));
    for (const [name, text] of [["openapi head, index chains", FIXED["openapi head, index chains"](SELLER_CAP - 64)], ["flat rows of one index key", `{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{"/a":{"get":{"summary":"A","x-payment-info":{"price":"0.01","currency":"USDC","network":"base"}}}},"x":${FIXED["key 34"](SELLER_CAP - 300)}}`]]) {
      const A = `https://reviewed-${name.length}-a.example`, B = `https://reviewed-${name.length}-b.example`;
      served.set(A, { "/openapi.json": text }); served.set(B, { "/openapi.json": text });
      const before = crawlParseStats();
      kept.length = 0;
      await idx.__crawlSellerForTest(A, {});
      const after = crawlParseStats();
      const line = kept.find((l) => /crawl parse .*parsed on the main thread/.test(l)) || null;
      process.env.CRAWL_PARSE_WORKER = "off";
      await idx.__crawlSellerForTest(B, {});
      delete process.env.CRAWL_PARSE_WORKER;
      out({ crawl: { name, bytes: Buffer.byteLength(text), sameAsInPlace: stored(cache.get(A)).replaceAll(A, "O") === stored(cache.get(B)).replaceAll(B, "O"), tools: cache.get(A)?.tools?.length ?? null, error: cache.get(A)?.error || null, rebuilt: after.offLoop > before.offLoop, handedBack: after.fallbacks > before.fallbacks, line } });
    }
    idx.stopCrawler?.();
    console.log = quietLog;
  }

  // ---- what the child is started with ----
  {
    const dir = mkdtempSync(join(tmpdir(), "crawl-contained-"));
    const tell = join(dir, "tell.mjs");
    writeFileSync(tell, 'process.on("message", (m) => { if (m.op === "parse") process.send({ id: m.id, failed: JSON.stringify({ o: process.env.NODE_OPTIONS ?? null, s: process.env.CRAWL_CONTAINED_SENTINEL ?? null, db: process.env.STATE_DATABASE_URL ?? null, a: process.execArgv, p: globalThis.__crawlContainedPreload === true }) }); });\n');
    __setCrawlParseForTest({ workerFile: tell, minChars: 1 });
    const r = await parseOffLoop("[1,2,3]");
    out({ child: JSON.parse(r.reason) });
    __setCrawlParseForTest(null);
  }

  // ---- stopped while a caller waits for its turn: handed back at once ----
  {
    const doc = denseOpenapi(6 * MB);
    const waits = { "next loop iteration": (r) => setImmediate(r), "a 5 ms wait": (r) => setTimeout(r, 5), "a 20 ms wait": (r) => setTimeout(r, 20) };
    const stops = [];
    for (const [name, wait] of Object.entries(waits)) {
      __setCrawlParseForTest({ stepTimeoutMs: 8000 });
      let turns = 0, stopAt = 0;
      const first = parseOffLoop(doc, { turn: () => new Promise((r) => { if (++turns === 18) { stopCrawlParse(); stopAt = performance.now(); } wait(r); }) });
      const second = parseOffLoop(doc, { turn });
      const a = await first.then((x) => x, (e) => ({ ok: false, reason: `rejected: ${e.message}` }));
      const settled = performance.now() - stopAt;
      const b = await second.then((x) => x, (e) => ({ ok: false, reason: `rejected: ${e.message}` }));
      stops.push({ name, stopped: stopAt > 0, firstOk: a.ok, firstReason: a.reason || null, settledMs: Math.round(settled), secondOk: b.ok, secondReason: b.reason || null, bothMs: Math.round(performance.now() - stopAt) });
    }
    out({ stops });
    __setCrawlParseForTest(null);
  }

  // ---- a light subtree nested past the whole-value height is still split ----
  {
    __setCrawlParseForTest({ minChars: 1 });
    const deepLight = `{"rows":[${rep('{"a":1}', 300_000, "", "")}],"deep":${"[".repeat(150_000)}1${"]".repeat(150_000)}}`;
    const before = crawlParseStats();
    const r = await parseOffLoop(deepLight, { turn });
    const after = crawlParseStats();
    out({ deepLight: { ok: r.ok, reason: r.reason || null, equal: r.ok ? sameValue(r.value, JSON.parse(deepLight)) : null, fallbacks: after.fallbacks - before.fallbacks } });
  }
  // ---- an array that grew piece by piece is stored at its exact length ----
  {
    __setCrawlParseForTest({ minChars: 1, pieceBytes: 16 * 1024, minPieceBytes: 16 * 1024, maxPieceBytes: 16 * 1024 });
    // Arrays of small integers, of lengths that end a growth step early.
    const lengths = [300_001, 410_003, 520_007, 630_011, 740_013, 850_017, 960_019, 1_070_023];
    const text = `[${lengths.map((len) => `[${"7,".repeat(len - 1)}7]`).join(",")}]`;
    let base = liveBytes();
    hold.v = JSON.parse(text);
    const inPlaceBytes = liveBytes() - base;
    hold.v = null;
    base = liveBytes();
    let r = await parseOffLoop(text, { turn });
    const pieces = r.pieces, okRebuilt = r.ok && r.value.length === lengths.length && r.value.every((a, i) => a.length === lengths[i]);
    hold.v = r.value; r = null;
    const rebuiltBytes = liveBytes() - base;
    hold.v = null;
    out({ exact: { ok: okRebuilt, pieces, inPlaceMb: +(inPlaceBytes / MB).toFixed(1), rebuiltMb: +(rebuiltBytes / MB).toFixed(1) } });
    __setCrawlParseForTest(null);
  }
  out({ done: true });
  process.exit(0);
}

// ================================== the suite =====================================
let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
// The flags the image runs the server with, read from the Dockerfile.
const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const imageOptions = /^ENV NODE_OPTIONS="([^"]*)"/m.exec(dockerfile)?.[1];
ok(typeof imageOptions === "string" && /--max-semi-space-size=\d+/.test(imageOptions), `control: the image sets NODE_OPTIONS (${imageOptions})`);
const dir = mkdtempSync(join(tmpdir(), "crawl-contained-suite-"));
const preload = join(dir, "preload.cjs");
writeFileSync(preload, "globalThis.__crawlContainedPreload = true;\n");
const SENTINEL = "sentinel-crawl-contained-7d1c";
const standIn = spawn(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url)], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ...ownStoreEnv("crawl-parse-contained"), CRAWL_CONTAINED_STAND_IN: "1", CRAWL_PARSE_WORKER: "", NODE_OPTIONS: `${imageOptions} --require ${preload}`, CRAWL_CONTAINED_SENTINEL: SENTINEL, REMOVED_ORIGINS_FILE: join(dir, "removed.json"), INDEX_CACHE_FILE: join(dir, "cache.json") },
});
let stdout = "", stderr = "";
standIn.stdout.on("data", (d) => { stdout += d; });
standIn.stderr.on("data", (d) => { stderr += d; });
const late = setTimeout(() => standIn.kill("SIGKILL"), DEADLINE_MS);
const ended = await new Promise((r) => standIn.on("close", (code, signal) => r({ code, signal })));
clearTimeout(late);
const records = stdout.split("\n").filter((l) => l.startsWith("@@")).map((l) => childJson(l.slice(2)));
const one = (k) => records.find((r) => r[k] !== undefined)?.[k];
const cases = records.filter((r) => r.case).map((r) => r.case);

ok(ended.code === 0 && !ended.signal && one("done") === true, `the stand-in for the server ran every document under the image's flags and is alive at the end (exit ${ended.code}${ended.signal ? ` ${ended.signal}` : ""}; ${cases.length} documents at the caps${ended.code === 0 ? "" : `; ${stderr.slice(-300)}`})`);
const search = one("search");
console.log(`# searched ${search.shapes} shapes; the most heap per character: ${search.worst.map((w) => `${w.perChar} B (${w.name})`).join("; ")}`);
ok(search.shapes >= 150 && search.worst[0].perChar >= 30, `control: the search found shapes that cost many times their text (${search.worst[0].perChar} bytes of heap per character at most)`);
const by = (re) => cases.filter((c) => re.test(c.name));
const fine = (c) => (c.outcome === "rebuilt" && c.equal === true) || (/handed back/.test(c.outcome) && c.equal !== false);
const bad = cases.filter((c) => !fine(c));
ok(cases.length >= 60 && bad.length === 0, `every document was rebuilt equal to JSON.parse's value or handed back to be parsed in place (${cases.filter((c) => c.outcome === "rebuilt").length} rebuilt, ${cases.filter((c) => c.outcome === "declined, handed back").length} declined unparsed, ${cases.filter((c) => c.outcome === "parser ended, handed back").length} ended the parser alone${bad[0] ? `; first other: ${bad[0].name}: ${bad[0].outcome}` : ""})`);
const endedParser = cases.filter((c) => c.outcome === "parser ended, handed back");
ok(endedParser.length >= 2, `control: some documents under the caps do end the parser, and only the parser (${endedParser.slice(0, 4).map((c) => c.name).join("; ")})`);
ok(by(/@ registry cap$/).length >= 5 && by(/@ seller cap$/).length >= 50, `control: shapes were run at both caps (${by(/@ seller cap$/).length} at 12 MB, ${by(/@ registry cap$/).length} at 64 MB)`);
for (const c of cases.filter((x) => /^honest/.test(x.name))) console.log(`# ${c.name}: ${c.outcome} (${c.wall} ms, longest turn ${c.longestTurn} ms)`);
const honest = by(/^honest: (ordinary|dense) OpenAPI/);
ok(honest.length === 8 && honest.every((c) => c.outcome === "rebuilt"), "an honest OpenAPI document of 1 to 12 MB, ordinary or dense, is rebuilt off the loop");
ok(by(/^honest: registry list (8|20|36) MB/).every((c) => c.outcome === "rebuilt"), "an honest registry list of 8 to 36 MB is rebuilt off the loop");
console.log(`# longest turn of the stand-in while a document was with the parser: ${one("worstTurn")} ms (wall); parser starts ${one("stats").starts}, ended holding a document ${one("stats").died}`);
ok(one("stats").paused === false, "a document that ends the parser does not pause it for the documents after");

const crawls = records.filter((r) => r.crawl).map((r) => r.crawl);
ok(crawls.length === 2 && crawls.every((c) => c.sameAsInPlace && !c.error && c.tools >= 1), `the review's two documents are crawled and stored as the in-place path stores them (${crawls.map((c) => `${c.name}: ${c.bytes} bytes, ${c.rebuilt ? "rebuilt" : "parsed in place"}`).join("; ")})`);
const handed = crawls.find((c) => c.handedBack);
ok(handed && /parsed on the main thread \(parser exited \(SIG[A-Z]+\) holding the document\)/.test(handed.line || "") && !/reviewed-/.test(handed.line), `a document that ended the parser is parsed in place and the log line says why, by hash (${handed?.line})`);

const child = one("child");
ok(child.o === null && child.s === null && child.db === null && child.p === false, "the parser process gets no NODE_OPTIONS, no preload, no store address and no variable outside the allowlist");
ok(child.a.length === 2 && /^--max-old-space-size=\d+$/.test(child.a[0]) && child.a[1] === "--expose-gc", `the parser's flags are its own heap limit and the collector hook (${child.a.join(" ")})`);

for (const s of one("stops")) ok(s.stopped && s.firstOk === false && s.secondOk === false && s.bothMs <= 2000, `stopped while a caller waited for ${s.name}: the parse and the one queued behind it are handed back at once (${s.bothMs} ms; ${s.firstReason}; ${s.secondReason})`);

const deepLight = one("deepLight");
ok(deepLight.ok && deepLight.equal && deepLight.fallbacks === 0, `a light subtree nested 150,000 deep is split and rebuilt, not sent whole (${deepLight.reason || "rebuilt"})`);
const exact = one("exact");
ok(exact.ok && exact.pieces > 50 && exact.rebuiltMb <= exact.inPlaceMb * 1.1, `arrays that grew piece by piece are stored at their exact length (${exact.rebuiltMb} MB rebuilt, ${exact.inPlaceMb} MB parsed in place, ${exact.pieces} pieces)`);

console.log(`test-crawl-parse-contained: ${n} passed`);
process.exit(0);
