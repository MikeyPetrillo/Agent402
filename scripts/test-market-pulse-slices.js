// The x402 market pulse's supply picture never holds the event loop, at
// production scale (about 5,800 origins and 198,000 tools). The picture
// classifies every tool's text against the category rules; built in one
// turn, or in fixed counts of origins, a large catalogue held the loop for
// seconds, on a paid call's first build and again on each stale rebuild.
//   node scripts/test-market-pulse-slices.js
import { PerformanceObserver } from "node:perf_hooks";
process.env.X402_INDEX_CRAWL = "off";
const X = await import("../src/x402-index.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Production shape: thousands of small catalogues and one operator's run of
// large ones, adjacent in the cache (the largest hosts in production carry
// 2,000 to 5,000 tools each, several under one operator). Half the tools
// carry text no rule matches, the slow path (every rule is tried).
function tools(n, seed) {
  const words = ["crypto price", "weather", "web search", "token", "wallet", "image generation", "llm chat", "news", "stock quote", "swap"];
  return Array.from({ length: n }, (_, k) => (k + seed) % 2
    ? { name: `${words[(k + seed) % words.length]} ${k}`, description: `Returns ${words[(seed + k * 3) % words.length]} data for an agent.`, route: `/api/x/${k}` }
    : { name: `zz thing ${k}`, description: "a generic utility that does assorted tasks for users and agents with some long description text here", route: `/v1/x/${seed}/${k}` });
}
const giants = [5009, 3186, 2198, ...Array(40).fill(2100)];
const ORIGINS = 5800, TOOLS = 198000;
const per = (TOOLS - giants.reduce((a, b) => a + b, 0)) / (ORIGINS - giants.length);
const entries = [];
let left = TOOLS;
for (let i = 0; i < ORIGINS; i++) {
  const n = i < giants.length ? giants[i] : (i === ORIGINS - 1 ? left : Math.max(1, Math.round(per * (0.25 + 1.5 * ((i * 7919) % 1000) / 1000))));
  left -= n;
  entries.push([`https://seller-${i}.example`, { tools: tools(n, i), fetchedAt: 1 }]);
}
X.__testSeedCache(entries);

// The longest gap between 1 ms timer ticks while `fn` runs, less the
// collector's pauses inside it.
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
  let ms = 0;
  for (const [a, b] of gaps) {
    let gc = 0;
    for (const [s, e] of gcs) gc += Math.max(0, Math.min(b, e) - Math.max(a, s));
    ms = Math.max(ms, b - a - gc);
  }
  return { result, ms: Math.round(ms) };
}
// Wait (yielding) until the memo is replaced by a rebuild, or give up.
async function nextPicture(prev, deadlineMs = 60_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const v = await X.ecosystemMarket({ limit: 12 });
    if (v !== prev) return v;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 2));
  }
}

// One slice is 20 ms; the rest covers one tool's classification and the
// final count over cached per-origin totals. The walks this replaces held
// the loop for the whole classification (seconds).
const BOUND_MS = Number(process.env.MARKET_SLICE_TEST_BOUND_MS) || 150;

// TTL 0: every call after the first finds the picture stale (the hook also
// clears the memo, so it is set before the first build).
X.__setMarketMemoTtl(0);
const cold = await longestBlock(() => X.ecosystemMarket({ limit: 12 }));
ok(cold.result?.tools === TOOLS && cold.result?.sellers === ORIGINS, `the first build covers every origin and tool (${cold.result?.sellers}, ${cold.result?.tools})`);
ok(cold.ms < BOUND_MS, `the first build never held the event loop past ${BOUND_MS} ms (longest block ${cold.ms} ms)`);

// The largest catalogues are re-crawled (new entry objects), then the memo
// goes stale: the next call serves the last picture and rebuilds.
const recrawled = entries.slice(0, giants.length).map(([o, e]) => [o, { ...e, tools: tools(e.tools.length, 7) }]);
X.__testSeedCache(recrawled);
const stale = await longestBlock(async () => {
  const served = await X.ecosystemMarket({ limit: 12 });
  const rebuilt = await nextPicture(served);
  return { served, rebuilt };
});
X.__setMarketMemoTtl();
ok(stale.result.served === cold.result, "a stale call serves the last picture");
ok(stale.result.rebuilt && stale.result.rebuilt.tools === TOOLS, "the rebuild replaces it with a full picture");
ok(stale.ms < BOUND_MS, `the stale rebuild never held the event loop past ${BOUND_MS} ms (longest block ${stale.ms} ms)`);
// The sliced build gives the same figures as one synchronous pass.
const current = [...recrawled, ...entries.slice(giants.length)].map(([, e]) => e);
const pick = ({ sellers, tools: t, categories }) => ({ sellers, tools: t, categories });
ok(JSON.stringify(pick(stale.result.rebuilt || {})) === JSON.stringify(pick(X.aggregateEcosystemSupply(current, { limit: 12 }))), "the rebuilt picture matches one synchronous pass over the same entries");

console.log(`\ntest-market-pulse-slices: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
