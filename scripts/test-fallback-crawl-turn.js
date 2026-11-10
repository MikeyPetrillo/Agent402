// A registry-fallback crawl of a seller whose registry lists far more rows
// than the per-seller tool cap keeps (77,071, the largest seen) never holds
// the event loop for its whole-list passes. The registry rows are read before
// the cap applies, and each pass (merge, the non-product filter, the declared
// stamp, the quote carry-forward, the live-quote candidate pick) used to walk
// every row in one turn: 0.5 to 1.5 s on a production-sized process, where
// the copies the merge built key by key each ended with a hidden class of
// their own. Now a registry-only listing past the cap is cut to the rows the
// cap keeps before the passes, the copy takes its source's shape, and a long
// list runs each pass in the crawl lane. Checked here: the hold, the copy's
// shape, that no pass is handed more than the cap, the totals a cut entry
// reports, and the one log line a crawl prints about its passes.
//
// The rows come through the product's own registry fold (discoverSource ->
// bazaarItemToTool), over a registry shaped to leave the process in the state
// where key-by-key copies stop sharing a hidden class: one seller of 77,071
// rows whose usage counts are zero, among 2,400 single-row sellers with
// counts. Offline: every fetch is a stub that answers on a later turn.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/loopback-only-preload.js"; // nothing here reaches a real host
import assert from "node:assert/strict";
import v8 from "node:v8";
import { bound, gapMeter, timeOurs, OURS_READING } from "./lib/ours-clock.js";

process.env.X402_INDEX_CRAWL = "off";
process.env.ROUTER_WORKERS = "0";
const idx = await import("../src/x402-index.js");
const { SELLER_TOOL_CAP: CAP } = await import("../src/seller-tool-cap.js");
v8.setFlagsFromString("--allow-natives-syntax");
const sameShape = new Function("a", "b", "return %HaveSameMap(a, b)");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };

const ROWS = Number(process.env.FALLBACK_TURN_ROWS || 77_071);
const LIMIT = bound(Number(process.env.FALLBACK_TURN_MS || 120), 6);
console.log(`# ${ROWS} registry rows; ${LIMIT.note}`);

const ORIGIN = "https://registry-heavy.example.invalid";
const HOST = "registry-heavy.example.invalid";
let seed = 11;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const WORDS = ["price", "token", "quote", "weather", "search", "lookup", "convert", "image", "text", "data", "wallet", "chain", "news", "stock", "workflow", "configuration", "quality", "agent", "report", "score"];
const word = () => WORDS[Math.floor(rnd() * WORDS.length)];
const prose = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(word()); return out.join(" "); };
const PAYTO = "0x" + "ab".repeat(20);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const proven = Date.now() - 3_600_000;

// The registry, as its pages list it: every row priced and described (~390
// characters, as the largest seller's are), seeded so every run builds the
// same rows. One route in 997 ends in a non-product segment.
const item = (origin, route, payTo, quality, description) => {
  const resource = origin + route;
  return { resource, type: "http", x402Version: 1, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: String(1000 + Math.floor(rnd() * 50_000)), resource, description, payTo, asset: USDC, extra: { name: "USD Coin", version: "2" } }], quality };
};
const items = [];
const routes = [];
for (let i = 0; i < ROWS; i++) {
  const route = i % 997 === 0 ? `/api/${word()}-${i}/health` : `/api/${word()}/${word()}-${word()}-${i}`;
  routes.push(route);
  items.push(item(ORIGIN, route, PAYTO, { l30DaysTotalCalls: 0, l30DaysUniquePayers: 0 }, prose(52)));
}
for (let i = 1; i <= 2400; i++) items.push(item(`https://registry-light-${i}.example.invalid`, `/api/${word()}-${i}`, "0x" + String(i).padStart(40, "0"), { l30DaysTotalCalls: 1 + ((i * 7) % 900), l30DaysUniquePayers: i % 25 }, prose(8)));
const later = () => new Promise((r) => setImmediate(r));
idx.__setDiscoveryFetchForTest(async (url) => {
  await later();
  const u = new URL(url);
  const offset = Number(u.searchParams.get("offset") || 0), limit = Number(u.searchParams.get("limit") || 1000);
  return JSON.parse(JSON.stringify({ x402Version: 1, items: items.slice(offset, offset + limit), pagination: { limit, offset, total: items.length } }));
});
process.env.BAZAAR_MAX_PAGES = "400";
const quiet = async (fn) => { const log = console.log; const lines = []; console.log = (...a) => { lines.push(a.join(" ")); }; try { await fn(); } finally { console.log = log; } return lines; };
await quiet(() => idx.__discoverSourceForTest({ name: "registry", url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources" }, "https://self.example.invalid"));

// The copy the merge makes of a registry row. Rows from the fold itself, so
// the copies are of the rows production copies; the key-by-key copy beside
// them is the control that says which shape state this process is in.
{
  const rows = [];
  for (let i = 0; i < ROWS; i++) rows.push(idx.bazaarItemToTool(items[i], ORIGIN));
  const keyByKey = (row) => { const c = {}; for (const k of Object.keys(row)) c[k] = row[k]; return c; };
  const shared = (list) => { let s = 0; for (let i = 1; i < 2000; i++) if (sameShape(list[i], list[i - 1])) s++; return s; };
  const control = shared(rows.slice(0, 2000).map(keyByKey));
  console.log(`# shape state: ${control} of 1999 key-by-key copies share their predecessor's hidden class (${control === 0 ? "the slow state, forced" : "the fast state: the slow one was not reached on this build"})`);
  const COPY = bound(Number(process.env.FALLBACK_COPY_MS || 150), 8);
  let copies = null, best = Infinity;
  for (let k = 0; k < 3; k++) { const t = timeOurs(() => idx.mergeOpenapiIntoBazaar([], rows)); copies = t.value; best = Math.min(best, t.ms); }
  ok(copies.length === ROWS && copies[0] !== rows[0] && JSON.stringify(copies[5]) === JSON.stringify(rows[5]) && Object.keys(copies[5]).join() === Object.keys(rows[5]).join(),
    "the merge with no document returns a copy of every registry row, keys in the row's order");
  const s = shared(copies);
  ok(s === 1999, `copies of same-shaped registry rows share one hidden class (${s} of 1999 share their predecessor's)`);
  ok(best < COPY.ms, `${ROWS} registry rows are copied under ${COPY.ms} ms (${best.toFixed(1)} ms ${OURS_READING})`);
  // The rows the one-step copy must not take: a contract key is left out
  // without its accessor being read, and a symbol key stays behind.
  let read = 0;
  const mark = Symbol("mark");
  const odd = [{ route: "/a", method: "POST", get requestContract() { read++; return [1]; }, responseContract: [2], name: "a" }, { route: "/b", method: "POST", name: "b", [mark]: true }];
  const out = idx.mergeOpenapiIntoBazaar([], odd);
  ok(read === 0 && !("requestContract" in out[0]) && !("responseContract" in out[0]) && out[0].name === "a" && out[1][mark] === undefined && out[1].name === "b",
    "a registry row's contract keys and symbol keys are still left out of its copy, a contract accessor unread");
}

const notFound = async (url) => { await later(); throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 }); };
idx.__setCrawlFetchForTest(notFound);
idx.__setProbeFetchForTest(notFound);
let passes = [];
idx.__setFallbackPassObserverForTest((p) => passes.push(p));
const logLines = [];
const realLog = console.log;
console.log = (...a) => { const line = a.join(" "); if (line.startsWith("[x402-index]")) logLines.push(line); else realLog(...a); };

async function crawlTurn(origin = ORIGIN) {
  idx.__resetRobotsCacheForTest();
  await new Promise((r) => setTimeout(r, 30));
  const g = gapMeter(1);
  await idx.__crawlSellerForTest(origin);
  await new Promise((r) => setTimeout(r, 20));
  return g.stop();
}
// The first crawl compiles the code and stores the entry later crawls replace
// (capped, as stored); one kept row in 24 then holds a quote a live 402
// taught, so the carry-forward has rows to carry.
await crawlTurn();
{
  const first = idx.sellerEntry(ORIGIN);
  const tools = first.tools.map((t, i) => (i % 24 === 0 ? { ...t, quoteSource: "live-402", liveProvenAt: proven, networksVerifiedAt: proven, payToSourceByNetwork: { "eip155:8453": "live" }, networksVerifiedMethod: "POST" } : { ...t }));
  idx.__testSeedCache([[ORIGIN, { ...first, tools }]]);
}
await crawlTurn();
passes = []; logLines.length = 0;
const r = await crawlTurn();
const v = idx.sellerEntry(ORIGIN);
ok(v?.source === "bazaar-fallback" && v.toolsCapped === true && v.toolsTotal === ROWS && v.tools.length === CAP,
  `the crawl stored the registry fallback, capped (${v?.tools?.length} of ${v?.toolsTotal}, source ${v?.source})`);
ok(r.worst < LIMIT.ms, `a ${ROWS}-row registry fallback crawl holds the loop under ${LIMIT.ms} ms per turn (longest ${r.worst.toFixed(1)} ms ${OURS_READING}, wall ${r.worstWall.toFixed(1)} ms)`);

// The cap comes before the passes: no pass was handed more rows than the cap,
// and the kept rows are the ones the cap keeps from the whole listing (every
// row here is described, so the first of the listing), each carried forward.
{
  const p = passes.find((x) => x.origin === ORIGIN);
  ok(p && p.listed === ROWS && p.kept === CAP && p.largestPass > 0 && p.largestPass <= CAP, `a ${ROWS}-row listing reached no pass at more than the cap (largest ${p?.largestPass}, kept ${p?.kept})`);
  // The cut, the candidate pick and the count of the rows left behind each
  // ran as lane work (one stretch or more apiece), none in the crawl's own turn.
  ok(p.stretches >= 3 && p.ms.quotes > 0, `the cut listing's passes ran in the crawl lane (${p.stretches} stretches, the candidate pick among them)`);
  ok(v.tools.every((t, i) => t.route === routes[i]) && v.tools.every((t) => t.declared === false) && v.tools.filter((t) => t.quoteSource === "live-402").length === Math.ceil(CAP / 24),
    "the kept rows are the listing's first, stamped undeclared, their learned quotes carried forward");
  const d = idx.sellerDetail(ORIGIN);
  ok(d?.toolCount === CAP && d.toolsTotal === ROWS && d.toolsCapped === true && d.toolCap === CAP && v.manifest?.capabilities?.tools === ROWS,
    `the seller detail reports the kept count beside the listed one (toolCount ${d?.toolCount}, toolsTotal ${d?.toolsTotal}, toolsCapped ${d?.toolsCapped})`);
}

// The one line a cut crawl prints: the passes by name with their time, and a
// short key in place of the seller.
{
  const mine = logLines.filter((l) => l.includes("fallback passes"));
  ok(mine.length === 1 && new RegExp(`^\\[x402-index\\] fallback passes ${ROWS} rows \\(kept ${CAP}\\) [0-9a-f]{8}: pick=\\d+ms copy=\\d+ms vouch=\\d+ms stamp=\\d+ms carry=\\d+ms quotes=\\d+ms total=\\d+ms longest=\\d+ms$`).test(mine[0]),
    `a cut crawl prints one line naming its passes (${mine[0]})`);
  ok(mine.length === 1 && !mine[0].includes(HOST) && !/https?:|registry-heavy|\.invalid/.test(mine[0]), "the line names no origin");
}

// Rows marked gone leave the count and the kept set as they did when every
// row was passed: one inside the kept rows (the next listed row takes its
// place), two behind them.
{
  idx.markRouteGone(ORIGIN, "POST", routes[7], { kind: "miss" });
  idx.markRouteGone(ORIGIN, "POST", routes[CAP + 40], { kind: "miss" });
  idx.markRouteGone(ORIGIN, "POST", routes[ROWS - 1], { kind: "410" });
  await crawlTurn();
  const g = idx.sellerEntry(ORIGIN);
  ok(g.tools.length === CAP && g.toolsCapped === true && g.toolsTotal === ROWS - 3 && !g.tools.some((t) => t.route === routes[7]) && g.tools[CAP - 1].route === routes[CAP],
    `three listed rows marked gone: ${g.tools.length} kept of ${g.toolsTotal}, the next listed row in the gone one's place`);
  idx._resetGoneRoutes();
}

// Counted at the rows themselves: a listing of 12,000 rows whose every read
// is counted has only the kept rows copied.
{
  const COUNTED = "https://registry-counted.example.invalid";
  let reads = 0;
  const rows = [];
  for (let i = 0; i < 12_000; i++) {
    const row = { seller: COUNTED, method: "POST", methodInferred: true, route: `/api/counted/${i}`, slug: `api-counted-${i}`, name: `counted ${i}`, description: i % 3 === 0 ? "" : `counted row ${i}`, category: "other", tags: [], price: 0.01, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": PAYTO }, provenance: "bazaar", quality: null };
    Object.defineProperty(row, "readMark", { enumerable: true, configurable: true, get() { reads++; return 1; } });
    rows.push(row);
  }
  idx.__testSetBazaarTools(COUNTED, rows);
  passes = [];
  await crawlTurn(COUNTED);
  const c = idx.sellerEntry(COUNTED);
  const described = rows.filter((t) => t.description).map((t) => t.route);
  ok(reads === CAP, `a 12,000-row listing had ${reads} rows copied (the cap is ${CAP})`);
  ok(c.tools.length === CAP && c.toolsTotal === 12_000 && c.toolsCapped === true && c.tools.every((t, i) => t.route === described[i]),
    `the kept rows are the described ones in listing order (${c.tools.length} of ${c.toolsTotal})`);
}

// A kept row a live probe drops in the crawl itself (its second miss) is
// replaced from the listed rows behind the kept ones, so a cut entry stays at
// the cap and keeps its total.
{
  const TOPUP = "https://registry-topup.example.invalid";
  const rows = [];
  for (let i = 0; i < CAP + 50; i++) rows.push({ seller: TOPUP, method: "GET", methodInferred: false, route: `/api/topup/${i}`, slug: `api-topup-${i}`, name: `topup ${i}`, description: `topup row ${i}`, category: "other", tags: [], price: null, networks: [], provenance: "bazaar", quality: null });
  idx.__testSetBazaarTools(TOPUP, rows);
  const twoHoursAgo = Date.now() - 2 * 3_600_000;
  for (const i of [0, 2]) idx.markRouteGone(TOPUP, "GET", rows[i].route, { at: twoHoursAgo, kind: "pending" });
  idx.__setProbeFetchForTest(async (url) => { await later(); if (/\/api\/topup\/[02]$/.test(new URL(url).pathname)) return new Response("not found", { status: 404 }); throw Object.assign(new Error("Upstream returned HTTP 503"), { statusCode: 422 }); });
  await crawlTurn(TOPUP);
  idx.__setProbeFetchForTest(notFound);
  const t = idx.sellerEntry(TOPUP);
  ok(t.tools.length === CAP && t.toolsCapped === true && t.toolsTotal === CAP + 48 && t.tools[0].route === rows[1].route && t.tools[1].route === rows[3].route && t.tools[CAP - 1].route === rows[CAP + 1].route,
    `two kept rows dropped by the crawl's own probes: ${t.tools.length} kept of ${t.toolsTotal}, the next listed rows in their place`);
  idx._resetGoneRoutes();
}

// A small listing takes no extra turns and prints nothing: the threshold is
// the row count, and the line waits for the time to pass its limits.
{
  const SMALL = "https://registry-light.example.invalid";
  const small = v.tools.slice(0, 50).map((t) => ({ ...t, seller: SMALL }));
  idx.__testSetBazaarTools(SMALL, small);
  logLines.length = 0;
  await idx.__crawlSellerForTest(SMALL);
  const s = idx.sellerEntry(SMALL);
  ok(s?.source === "bazaar-fallback" && s.tools.length === 50 && !s.toolsCapped && !("toolsTotal" in s), `a 50-row registry fallback is stored whole (${s?.tools?.length})`);
  ok(!logLines.some((l) => l.includes("fallback passes")), "a small crawl under the time limits prints no line");
  // Past the limits it prints, in the same form and with no origin.
  const was = idx.__setFallbackPassLogForTest({ totalMs: -1, passMs: -1 });
  await idx.__crawlSellerForTest(SMALL);
  idx.__setFallbackPassLogForTest(was);
  const mine = logLines.filter((l) => l.includes("fallback passes"));
  ok(mine.length === 1 && /^\[x402-index\] fallback passes 50 rows \(kept 50\) [0-9a-f]{8}: pick=\d+ms copy=\d+ms vouch=\d+ms stamp=\d+ms carry=\d+ms quotes=\d+ms total=\d+ms longest=\d+ms$/.test(mine[0]) && !/https?:|registry-light|\.invalid/.test(mine[0]),
    `a crawl whose passes exceed the limits prints the line, with no origin (${mine[0]})`);
  logLines.length = 0;
  await idx.__crawlSellerForTest(SMALL);
  ok(!logLines.some((l) => l.includes("fallback passes")), "back under the limits it prints none");
}
console.log = realLog;
console.log(`\n${n} checks passed`);
process.exit(0);
