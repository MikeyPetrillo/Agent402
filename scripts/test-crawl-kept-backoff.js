#!/usr/bin/env node
// An origin whose document the crawl did not parse is not fetched again each cycle.
//
// A read that held a document the crawl does not parse (one that ended the
// parser, src/crawl-parse.js KEEP_PREVIOUS) keeps the entry as the last read
// left it. The parser answers the same text from memory for a day, so a
// scheduled turn that fetched it again only downloaded and hashed megabytes to
// keep the same entry. Its scheduled turns now pass under the same word with no
// request until that memory ends; an explicit crawl still reads, a completed
// read ends the wait, and the entry is never dropped or blanked.
//
// Driven through the real crawl (crawlSeller, crawlScheduled) of a stub seller
// whose parser is a child that ends by a signal on every document. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/loopback-only-preload.js"; // nothing here reaches a real host
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownStoreEnv } from "./lib/own-stores.js";

Object.assign(process.env, ownStoreEnv("crawl-kept-backoff"));
Object.assign(process.env, { X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", ROUTER_WORKERS: "0", SELLER_PROBE_DAILY_BUDGET: "off" });
delete process.env.CRAWL_PARSE_WORKER;
const dir = mkdtempSync(join(tmpdir(), "crawl-kept-backoff-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
process.env.INDEX_CACHE_FILE = join(dir, "x402-index-cache.json");

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failed++; };
const realLog = console.log;
console.warn = () => {};
console.log = (...a) => { const s = String(a[0]); if (/^(PASS|FAIL) /.test(s) || /^\n/.test(s)) realLog(...a); };

const { __setCrawlParseForTest, crawlParseStats } = await import("../src/crawl-parse.js");
const idx = await import("../src/x402-index.js");
const killer = join(dir, "killer.mjs");
writeFileSync(killer, 'process.on("message", (m) => { if (m.op === "parse") process.kill(process.pid, "SIGKILL"); });\n');

const served = new Map();
const requests = new Map(); // origin -> requests made
idx.__setCrawlFetchForTest(async (url) => {
  const u = new URL(url);
  requests.set(u.origin, (requests.get(u.origin) || 0) + 1);
  const body = served.get(u.origin)?.[u.pathname];
  if (body === undefined) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422, upstreamStatus: 404 });
  return { html: body, finalUrl: url, validators: {} };
});
idx.__setProbeFetchForTest(async () => new Response("{}", { status: 404 }));
const cache = idx._cacheForTests();
const openapi = (title) => JSON.stringify({ openapi: "3.1.0", info: { title, version: "1" }, paths: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`/api/tool-${i}`, { post: { operationId: `tool${i}`, summary: `Tool ${i}`, "x-payment-info": { price: "0.01", currency: "USDC", network: "base" }, responses: { 200: { description: "ok" } } } }])) });
const asked = (o) => requests.get(o) || 0;
const whole = (o) => (cache.has(o) ? JSON.stringify(cache.get(o)) : null);
const RECALL_MS = 1500;

const O = "https://kept-backoff.example";
// A good read first: the entry the later turns keep.
__setCrawlParseForTest({ minChars: 1 });
served.set(O, { "/openapi.json": openapi("first") });
await idx.__crawlSellerForTest(O, {});
const firstEntry = whole(O);
ok(firstEntry && (cache.get(O)?.tools?.length ?? 0) >= 1, "control: a good read lists the seller");

// Every document now ends the parser.
__setCrawlParseForTest({ minChars: 1, workerFile: killer, recallMs: RECALL_MS });
served.set(O, { "/openapi.json": openapi("second") });
const kept = await idx.__crawlSellerForTest(O, {});
ok(kept?.keptPrevious === "parser-ended" && whole(O) === firstEntry, `a read whose document ended the parser keeps the entry (${kept?.keptPrevious})`);

// The scheduled turns that follow make no request and keep the entry.
const before = asked(O), startsBefore = crawlParseStats().starts;
const turns = [];
for (let i = 0; i < 3; i++) turns.push(await idx.__crawlScheduledForTest(O));
ok(turns.every((t) => t === "parser-ended") && asked(O) === before && crawlParseStats().starts === startsBefore && whole(O) === firstEntry,
  `the scheduled turns pass under the word with no request and no parser started, the entry kept (${turns.join(",")}; requests +${asked(O) - before})`);
// An explicit crawl still reads.
{
  const b = asked(O), st = crawlParseStats();
  const r = await idx.__crawlSellerForTest(O, {});
  const st2 = crawlParseStats();
  ok(asked(O) > b && r?.keptPrevious === "parser-ended" && whole(O) === firstEntry && st2.recalled === st.recalled + 1 && st2.starts === st.starts, `control: an explicit crawl still fetches, and the same document is answered from the parser's memory with no child started (requests +${asked(O) - b})`);
}
// Once the parser's memory of the document ends, the scheduled turn reads again.
await new Promise((r) => setTimeout(r, RECALL_MS + 100));
{
  const b = asked(O);
  const t = await idx.__crawlScheduledForTest(O);
  ok(asked(O) > b && t === "parser-ended" && whole(O) === firstEntry, `after the parser's memory ends the scheduled turn fetches again (requests +${asked(O) - b}, ${t})`);
}
// A completed read ends the wait: kept once more (a new wait), then an explicit
// read with the parser well takes the new document and the next scheduled turn reads.
served.set(O, { "/openapi.json": openapi("third") });
ok((await idx.__crawlSellerForTest(O, {}))?.keptPrevious === "parser-ended" && (await idx.__crawlScheduledForTest(O)) === "parser-ended", "control: a new kept read starts a new wait");
__setCrawlParseForTest({ minChars: 1 });
await idx.__crawlSellerForTest(O, {});
const thirdEntry = whole(O);
ok(thirdEntry !== firstEntry && (cache.get(O)?.tools?.length ?? 0) >= 1, "a completed read takes the new document");
{
  const b = asked(O);
  const t = await idx.__crawlScheduledForTest(O);
  ok(t !== "parser-ended" && (asked(O) > b || t === "unchanged"), `after a completed read the scheduled turn is decided by the load controls again (${t}, requests +${asked(O) - b})`);
}
{
  const P = "https://kept-backoff-other.example";
  served.set(P, { "/openapi.json": openapi("other") });
  const b = asked(P);
  const t = await idx.__crawlScheduledForTest(P);
  ok(asked(P) > b && t !== "parser-ended", `control: an origin with no kept document is read on its scheduled turn (requests +${asked(P) - b}, ${t})`);
}

__setCrawlParseForTest(null);
idx.stopCrawler?.();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
