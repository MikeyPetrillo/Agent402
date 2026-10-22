// The index's background persist and pull never hold the event loop for long,
// at production scale (about 5,800 origins and 198,000 tools, ~170 MB of
// persisted lines). Both walk every tool array: the projection, the
// stringify, the hash and, on the pull, the fold of every changed row. They
// yield on elapsed time, so the longest block stays near one slice whatever
// the catalogues weigh.
//   STATE_DATABASE_URL=postgres://... node scripts/test-index-persist-slices-pg.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PerformanceObserver } from "node:perf_hooks";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-index-persist-slices-pg" });

process.env.X402_INDEX_CRAWL = "off";
const DIR = mkdtempSync(join(tmpdir(), "index-slices-pg-"));
// No write-through: the cache file's directory does not exist, as in production
// (the rows are the cache there).
process.env.INDEX_CACHE_FILE = join(DIR, "absent", "x402-index-cache.json");
process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");

const sdb = await import("../src/state-db.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Production shape: a few large catalogues (the largest ~5,000 tools) and
// thousands of small ones, ~198k tools in all.
function synth({ origins = 5800, tools = 198000, fetchedAt = 1_000_000 } = {}) {
  const giants = [5009, 3186, 2198, 2100, 1900, 1800, 1500, 1200, 1100, 1000];
  const per = (tools - giants.reduce((a, b) => a + b, 0)) / (origins - giants.length);
  const words = ["crypto", "price", "weather", "search", "token", "wallet", "image", "llm", "data", "news", "stock", "defi", "swap", "nft", "email", "sms", "pdf", "scrape", "translate", "agent"];
  const out = [];
  let left = tools;
  for (let i = 0; i < origins; i++) {
    const n = i < giants.length ? giants[i] : (i === origins - 1 ? left : Math.max(1, Math.round(per * (0.25 + 1.5 * ((i * 7919) % 1000) / 1000))));
    left -= n;
    const origin = `https://seller-${i}.example`;
    const list = new Array(n);
    for (let k = 0; k < n; k++) {
      const w = words[(i * 7 + k) % words.length], w2 = words[(i + k * 3) % words.length];
      list[k] = {
        route: `/api/${w}/${w2}/${k}`, method: k % 3 ? "GET" : "POST", name: `${w} ${w2} tool ${k}`,
        description: `Returns ${w} and ${w2} information for an agent, with pagination, filters, sorting and a cached upstream read. ` +
          `Item ${k} of seller ${i}. Answers JSON with stable field names, a request id and documented error codes; ` +
          `rate limited per payer, retried upstream once, and priced per call in USDC on the listed networks.`,
        price: `$0.00${1 + (k % 9)}`, network: "eip155:8453", payTo: "0x" + i.toString(16).padStart(8, "0").repeat(5),
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", tags: [w, w2, "x402", "agent"], mimeType: "application/json", maxTimeoutSeconds: 60,
        quoteSource: "live-402", quotedAt: 1_700_000_000_000 + k, networks: ["eip155:8453", "eip155:137"],
        // Held in memory, dropped from the persisted projection (as a crawled
        // catalogue's schemas are).
        inputSchema: { type: "object", properties: { q: { type: "string", description: `${w} query` }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["q"] },
        outputSchema: { type: "object", properties: { items: { type: "array" }, next: { type: "string" } } },
        example: { q: w2, limit: 10 },
      };
    }
    out.push([origin, { manifest: { name: `Seller ${i}`, description: "A seller", homepage: origin, x402Version: 2, network: "base" }, tools: list, fetchedAt: fetchedAt + i, error: null, source: "crawl", history: [{ at: 1, ok: true }], paywall: null, discoveryPath: "/.well-known/x402" }]);
  }
  return out;
}

// The longest gap between 1 ms timer ticks while `fn` runs, less the
// collector's pauses inside it: the longest stretch our own code held the
// event loop (the production stall line reports collector time apart too).
async function longestBlock(fn) {
  const gcs = [];
  const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) gcs.push([e.startTime, e.startTime + e.duration]); });
  obs.observe({ entryTypes: ["gc"] });
  const gaps = [];
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); gaps.push([last, now]); last = now; }, 1);
  let result;
  try { result = await fn(); } finally {
    await new Promise((r) => setTimeout(r, 20));
    clearInterval(timer);
    obs.disconnect();
  }
  let ms = 0, raw = 0;
  for (const [a, b] of gaps) {
    let gc = 0;
    for (const [s, e] of gcs) gc += Math.max(0, Math.min(b, e) - Math.max(a, s));
    raw = Math.max(raw, b - a);
    ms = Math.max(ms, b - a - gc);
  }
  return { result, ms: Math.round(ms), raw: Math.round(raw) };
}

// The bound is one slice (20 ms) plus four times the largest single unit of
// work (projecting, stringifying and hashing the largest origin), timed on
// this machine so a slower runner gets a proportionally larger bound. The
// walks this replaces held the loop for a whole pass over every origin.
const SLICE_MS = 20;
function largestUnitMs(origin, entry) {
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    const slim = { ...entry, tools: entry.tools.map((t) => { const o = { ...t }; delete o.inputSchema; delete o.outputSchema; delete o.example; return o; }) };
    const line = JSON.stringify([origin, slim]);
    createHash("sha1").update(line).digest("base64");
    JSON.parse(line);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}
const snapArgs = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "test" };

try {
  const A = await import("../src/x402-index.js?container=a");
  const B = await import("../src/x402-index.js?container=b");
  await B.pullIndexChanges(); // B's watermark: it has read everything older
  const data = synth();
  const toolCount = data.reduce((n, [, e]) => n + e.tools.length, 0);
  ok(toolCount === 198000 && data.length === 5800, `prod-scale input: ${data.length} origins, ${toolCount} tools`);
  const unit = largestUnitMs(...data[0]);
  const BOUND_MS = Math.round(SLICE_MS + 4 * unit);
  console.log(`largest origin's unit of work ${unit.toFixed(1)} ms; bound ${BOUND_MS} ms`);
  A.__testSeedCache(data);
  ok(await A.persistIndexCacheAsync(), "A's first save writes every origin");
  // A's route index is built now, so its own background drain (a separate
  // sliced job) is not running beside the measurements below.
  A.warmRouteIndex();

  // Each job runs twice and the shorter of its two longest blocks is held to
  // the bound: the walk this replaces blocks on every run, and a one-off
  // scheduler pause on a shared runner is not the job's own block.
  const twice = async (fn) => { const a = await longestBlock(fn); const b = await longestBlock(fn); return { a, b, ms: Math.min(a.ms, b.ms), raw: Math.min(a.raw, b.raw) }; };

  // ---- an unchanged save: project, stringify and hash every origin ---------
  const save = await twice(() => A.persistIndexCacheAsync());
  ok(save.a.result === true && save.b.result === true, "A's unchanged saves complete");
  ok(save.ms < BOUND_MS, `the save never held the event loop past ${BOUND_MS} ms (longest block ${save.ms} ms; ${save.raw} ms with collector pauses)`);

  // ---- B folds every origin A wrote ------------------------------------------
  const pullOnce = () => longestBlock(() => B.pullIndexChanges({ pageSize: 1000, maxPages: 20 }));
  const pullA = await pullOnce();
  // A re-crawls everything, so B has every origin to fold again.
  A.__testSeedCache(data.map(([o, e]) => [o, { ...e, fetchedAt: e.fetchedAt + 10_000_000 }]));
  await A.persistIndexCacheAsync();
  A.warmRouteIndex(); B.warmRouteIndex();
  const pullB = await pullOnce();
  const pull = { a: pullA, b: pullB, ms: Math.min(pullA.ms, pullB.ms), raw: Math.min(pullA.raw, pullB.raw) };
  ok(pull.a.result === data.length && pull.b.result === data.length, `B pulls every origin A wrote, both times (${pull.a.result}, ${pull.b.result})`);
  ok(pull.ms < BOUND_MS, `the pull never held the event loop past ${BOUND_MS} ms (longest block ${pull.ms} ms; ${pull.raw} ms with collector pauses)`);

  // Same index on both sides: the slicing changed when the work runs, not what it produces.
  const sellers = (m) => m.indexSnapshot(snapArgs).sellers.filter((s) => s.origin.startsWith("https://seller-")).map((s) => `${s.origin} ${s.toolCount}`).sort();
  ok(JSON.stringify(sellers(A)) === JSON.stringify(sellers(B)), "B serves the same sellers and tool counts as A after the pull");
  const row = await sdb.records.get("x402-index", "https://seller-0.example");
  ok(row?.tools?.length === 5009 && row.tools[0].description === data[0][1].tools[0].description && row.fetchedAt === data[0][1].fetchedAt + 10_000_000, "the largest origin's row holds its whole catalogue");
  A.stopCrawler?.(); B.stopCrawler?.();
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-index-persist-slices-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
