#!/usr/bin/env node
// A document too long to parse in place is not parsed in place on any path.
//
// The crawl parses a long document in a child process (src/crawl-parse.js).
// When the child cannot do it (it cannot start, answers nothing inside the
// step timeout, is paused after failures in a row, or was stopped at the
// drain) the document is handed back and parsed on the serving thread, as
// before there was a parser. A document of DECLINED_IN_PLACE_MAX_CHARS or more
// is the exception on every one of those paths, as it already was for one the
// child declined: it is not parsed, the registry's rows of its last pass stand,
// the word `too-large-to-parse` is recorded and one line says so.
// CRAWL_PARSE_WORKER=off, the operator's choice, still parses it in place.
//
// Driven through a real registry pass (src/x402-index.js discoverOneSource)
// with JSON.parse watched for any text of the limit's length (a spy, never a
// timing). Controls: under the limit every fallback still parses in place and
// the pass takes the new rows. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/loopback-only-preload.js"; // nothing here reaches a real host
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownStoreEnv } from "./lib/own-stores.js";

Object.assign(process.env, ownStoreEnv("crawl-parse-large-fallback"));
Object.assign(process.env, { X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", ROUTER_WORKERS: "0", SELLER_PROBE_DAILY_BUDGET: "off" });
delete process.env.CRAWL_PARSE_WORKER;
const dir = mkdtempSync(join(tmpdir(), "crawl-parse-large-fallback-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
process.env.INDEX_CACHE_FILE = join(dir, "x402-index-cache.json");

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failed++; };
const DEADLINE_MS = 120_000;
const within = (p, label) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: no outcome in ${DEADLINE_MS} ms`)), DEADLINE_MS); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

const { DECLINED_IN_PLACE_MAX_CHARS, KEEP_PREVIOUS, __setCrawlParseForTest, stopCrawlParse, parseOffLoop, crawlParseStats, crawlParseStatus } = await import("../src/crawl-parse.js");
const lines = [];
const realWarn = console.warn, realLog = console.log;
console.warn = (...a) => { lines.push(String(a[0])); };
console.log = (...a) => { const s = String(a[0]); if (/^(PASS|FAIL) /.test(s)) realLog(...a); else lines.push(s); };
const idx = await import("../src/x402-index.js");

/** A registry list of `chars` characters or a little more, `tag` making each list distinct. */
function registryList(chars, tag) {
  const rows = [];
  let n = 40, i = 0;
  while (n < chars) {
    const r = `{"resource":"https://${tag}-reg${i % 400}.example/api/r-${i}","type":"http","x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:8453","maxAmountRequired":"${1000 + (i % 9000)}","payTo":"0x000000000000000000000000000000000000dEaD","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","description":"Resource ${i}: rows as json ${"x".repeat(120)}"}]}`;
    rows.push(r); n += r.length + 1; i++;
  }
  return `{"x402Version":2,"resources":[${rows.join(",")}]}`;
}
const LARGE = DECLINED_IN_PLACE_MAX_CHARS + 64 * 1024;
const SMALL = 1024 * 1024;

const realParse = JSON.parse;
let bigParses = 0;
JSON.parse = function watched(text, reviver) { if (typeof text === "string" && text.length >= DECLINED_IN_PLACE_MAX_CHARS) bigParses++; return realParse.call(JSON, text, reviver); };

let body = null;
idx.__setDiscoveryBodyFetchForTest(async () => ({ html: body }));
const rows = () => { const s = idx.__discoveryStateForTest(); return JSON.stringify([[...s.bazaarTools.keys()].sort(), [...s.discoveredSeeds].sort()]); };
let at = 0;
/** One registry pass over `text`: whether the rows of the last pass stood, the word, the big parses here, the lines. */
async function pass(text) {
  const source = { name: `large fallback ${at++}`, url: "https://registry-large.example/discovery/resources", synthesizeTools: true };
  body = registryList(64 * 1024, `seed${at}`);
  __setCrawlParseForTest(null);
  await within(idx.__discoverSourceForTest(source), "seed pass");
  const seeded = rows();
  return { source, seeded, run: async () => {
    body = text; lines.length = 0; bigParses = 0;
    const before = crawlParseStats();
    await within(idx.__discoverSourceForTest(source), "pass");
    const st = idx.__discoveryStateForTest().status.get(source.name);
    return { kept: rows() === seeded, word: st.keptPrevious || null, error: st.error || null, bigParses, lines: [...lines], kept_: crawlParseStats().kept - before.kept };
  } };
}

const hang = join(dir, "hang.mjs");
writeFileSync(hang, 'process.on("message", () => {});\n');
const absent = join(dir, "absent.mjs");
const large = registryList(LARGE, "big");
const notParsedLine = (r) => r.lines.some((l) => /^\[x402-index\] crawl parse [0-9a-f]{8} registry-list 12-64MB: not parsed, last read kept \(too-large-to-parse\)$/.test(l));
const KINDS = [
  ["cannot start", async () => { __setCrawlParseForTest({ workerFile: absent }); }],
  ["no answer in the step timeout", async () => { __setCrawlParseForTest({ workerFile: hang, stepTimeoutMs: 150 }); }],
  ["paused after three failures", async () => {
    __setCrawlParseForTest({ workerFile: absent, minChars: 1 });
    for (let q = 0; q < 3; q++) await within(parseOffLoop("[1]"), "failing parse");
    if (!crawlParseStats().paused) throw new Error("not paused");
  }],
  ["stopped at the drain", async () => { __setCrawlParseForTest(null); stopCrawlParse(); }],
];

for (const [kind, arrange] of KINDS) {
  const p = await pass(large);
  await arrange();
  const r = await p.run();
  ok(r.kept && r.word === KEEP_PREVIOUS.large && r.bigParses === 0 && /too-large-to-parse/.test(r.error || "") && notParsedLine(r),
    `${kind}: a ${LARGE}-character list is not parsed in place, the last pass's rows stand, the word and the line are recorded (kept=${r.kept} word=${r.word} bigParses=${r.bigParses} error=${r.error})`);
  {
    const named = idx.discoveryKeptPrevious().find((k) => k.source === p.source.name);
    ok(named?.word === KEEP_PREVIOUS.large && crawlParseStatus({ registriesKept: idx.discoveryKeptPrevious() }).status === "registry-kept",
      `${kind}: the registry held from its last pass is named, and the crawlParse word reads registry-kept (${JSON.stringify(named)})`);
  }
  // Control: the same path with a list under the limit is parsed in place as before.
  const q = await pass(registryList(SMALL, `small${at}`));
  await arrange();
  const s = await q.run();
  ok(!idx.discoveryKeptPrevious().some((k) => k.source === q.source.name), `${kind}: control, a registry whose pass was parsed is not named as held`);
  const inPlaceSaid = kind === "stopped at the drain" || s.lines.some((l) => / registry-list 1-4MB: parsed on the main thread \(/.test(l));
  ok(!s.kept && s.word === null && !s.error && s.kept_ === 0 && inPlaceSaid,
    `${kind}: control, a list under the limit is parsed in place and its rows taken (changed=${!s.kept} error=${s.error})`);
}

// The operator's switch: every document is parsed in place, the long one included.
{
  const p = await pass(registryList(LARGE, "off"));
  process.env.CRAWL_PARSE_WORKER = "off";
  const r = await p.run();
  delete process.env.CRAWL_PARSE_WORKER;
  ok(!r.kept && r.word === null && !r.error && r.bigParses === 1, `CRAWL_PARSE_WORKER=off: the long list is parsed in place and its rows taken (bigParses=${r.bigParses} error=${r.error})`);
}
// And with the parser well, a long list is still rebuilt off the loop (no in-place parse).
{
  const p = await pass(registryList(LARGE, "well")); // origins no pass above listed
  __setCrawlParseForTest(null);
  const before = crawlParseStats().offLoop;
  const r = await p.run();
  ok(!r.kept && !r.error && r.bigParses === 0 && crawlParseStats().offLoop === before + 1, `control: with the parser well the long list is rebuilt off the loop and its rows taken (error=${r.error})`);
}

JSON.parse = realParse;
idx.__setDiscoveryBodyFetchForTest(null);
__setCrawlParseForTest(null);
idx.stopCrawler?.();
console.warn = realWarn; console.log = realLog;
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
