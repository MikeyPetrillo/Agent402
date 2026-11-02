// Background work holds the event loop in bounded slices, whatever one unit
// of it weighs. Production's "[loop-lag] event loop blocked" lines (1-2 s)
// came from three such jobs, each correct but taken in one turn:
//   (a) the decide index export yielded every 500 rows, and an outside row's
//       verdict is not a fixed cost, so 500 rows bounded nothing;
//   (b) a crawl normalised a large OpenAPI document in one turn, and the
//       crawl runs 25 sellers at once, so a setImmediate yield only handed the
//       loop to the next seller's slice in the same iteration;
//   (c) the persist of a large seller row is pinned in test-x402-index-pg.js
//       (it needs a real database).
// Each case asserts the longest loop gap and that the work still completes
// with the same output as the one-turn version. Offline: no network.
//
//   node scripts/test-loop-slices.js
process.env.X402_INDEX_CRAWL = "off";
process.env.ROUTER_WORKERS = "0";
process.env.DECIDE_INTERNAL_TOKEN = "t".repeat(32);
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const DIR = mkdtempSync(join(tmpdir(), "loop-slices-"));
process.env.INDEX_CACHE_FILE = join(DIR, "x402-index-cache.json");
process.env.CRAWL_CYCLE_FILE = join(DIR, "crawl-cycle.json");

const idx = await import("../src/x402-index.js");
const ex = await import("../src/decide/index-export.js");
idx.loadRemovedOrigins?.();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Longest gap between 2 ms ticks while `fn` runs: the longest the loop was held.
async function longestGap(fn) {
  let last = performance.now(), worst = 0;
  const iv = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 2); last = now; }, 2);
  try { const out = await fn(); return { out, worst: Math.round(worst) }; } finally { clearInterval(iv); }
}
const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* a costly verdict */ } };
const BOUND_MS = Number(process.env.LOOP_SLICE_BOUND_MS || 120);
const PAY = "0x000000000000000000000000000000000000dEaD";

// ---------------------------------------------------------------- (a) the export
{
  const sellers = [];
  for (let s = 0; s < 4; s++) {
    const origin = `https://slices-${s}.example`;
    const tools = Array.from({ length: 400 }, (_, i) => ({ seller: origin, method: "POST", route: `/api/t${i}`, slug: `t${i}`, name: `Tool ${i}`, description: "Returns a value.", category: "data", tags: [], price: 0.002, networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": PAY } }));
    sellers.push([origin, { manifest: { name: `Seller ${s}`, homepage: origin }, tools, fetchedAt: Date.now(), error: null, history: [1, 1, 1] }]);
  }
  idx.__testSeedCache(sellers);
  // A verdict that costs 0.5 ms a row: 500 rows of it were 250 ms in one turn.
  let verdicts = 0, prepared = 0;
  const remoteExecutable = (t) => { verdicts++; spin(0.5); return t.route.length % 2 === 0; };
  const run = async (handler) => {
    const chunks = [];
    const res = { headersSent: false, destroyed: false, status() { return res; }, set() { return res; }, json(b) { chunks.push(JSON.stringify(b)); return res; }, write(c) { chunks.push(c); return true; }, end(c) { if (c) chunks.push(c); return res; }, on() { return res; }, once() { return res; }, off() { return res; }, destroy() {} };
    const req = { headers: { host: "agent402.railway.internal", authorization: "Bearer " + "t".repeat(32) } };
    const { worst } = await longestGap(() => handler(req, res));
    return { worst, body: chunks.join("") };
  };
  const base = { getCatalog: () => ({}), baseUrl: "https://agent402.tools", getNetworks: () => [], getReadiness: () => ({ ready: true }), remoteExecutable };
  const { worst, body } = await run(ex.decideIndexExportHandler({ ...base, prepare: async () => { prepared++; } }));
  const rows = body.trim().split("\n");
  ok(prepared === 1 && verdicts === 1600 && rows.length === 1601 && JSON.parse(rows.at(-1)).rows === 1600, `the export streams every row once after its prepare step (${rows.length - 1} rows, ${verdicts} verdicts)`);
  ok(worst < BOUND_MS, `with a 0.5 ms verdict per row the export never holds the loop past ${BOUND_MS} ms (longest ${worst} ms)`);
  // The same bytes as the rows read in one turn.
  const all = [];
  for await (const r of ex.unifiedRows({ catalog: {}, baseUrl: "https://agent402.tools", remoteExecutable, sliceMs: Infinity })) all.push(JSON.stringify(r));
  ok(all.join("\n") === rows.slice(0, -1).join("\n"), "the sliced export's rows are byte-identical to the rows taken in one turn");
  for (const [o] of sellers) idx._cacheForTests().delete(o);
}

// ---------------------------------------------------------------- (b) the crawl
{
  // A FastAPI-shaped document: every operation's request and response read
  // through local $refs, the work resolveLocalRefs does twice per operation.
  const openapiFor = (o, n) => {
    const paths = {}, schemas = {};
    for (let i = 0; i < n; i++) {
      schemas[`In${i}`] = { type: "object", required: ["q", "limit"], properties: { q: { type: "string" }, limit: { type: "integer" }, filter: { $ref: "#/components/schemas/Filter" } } };
      schemas[`Out${i}`] = { type: "object", required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/Item" } }, next: { type: "string" } } };
      paths[`/api/op${i}`] = { post: { operationId: `op${i}`, summary: `Operation ${i}`, description: "Looks something up.", tags: ["data"], "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.002" } },
        requestBody: { content: { "application/json": { schema: { $ref: `#/components/schemas/In${i}` } } } },
        responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: `#/components/schemas/Out${i}` } } } } } } };
    }
    schemas.Filter = { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, tags: { type: "array", items: { type: "string" } } } };
    schemas.Item = { type: "object", required: ["id"], properties: { id: { type: "string" }, score: { type: "number" }, meta: { $ref: "#/components/schemas/Filter" } } };
    return { openapi: "3.1.0", info: { title: "Big seller" }, servers: [{ url: o }], paths, components: { schemas } };
  };
  const OPS = Number(process.env.LOOP_SLICE_OPS || 1500);
  const origins = Array.from({ length: 12 }, (_, i) => `https://big-doc-${i}.example`);
  const served = new Map();
  const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "2000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
  for (const o of origins) {
    served.set(`${o}/.well-known/x402`, JSON.stringify({ x402Version: 2, name: "Big seller", resources: [{ resource: `${o}/api/op0`, method: "POST", description: "Operation 0", price: "$0.002", accepts }] }));
    served.set(`${o}/openapi.json`, JSON.stringify(openapiFor(o, OPS)));
  }
  idx.__setCrawlFetchForTest(async (url) => {
    await new Promise((r) => setTimeout(r, 1)); // a network read ends a turn
    const hit = served.get(url);
    if (hit === undefined) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
    return { html: hit, finalUrl: url, validators: null };
  });
  idx.__setProbeFetchForTest(async () => { throw new Error("no quote probes offline"); });
  const doc = openapiFor(origins[0], OPS);
  const t0 = performance.now();
  const direct = idx.normaliseOpenapiTools(doc, origins[0]);
  const oneTurnMs = Math.round(performance.now() - t0);
  const { worst } = await longestGap(() => Promise.all(origins.map((o) => idx.__crawlSellerForTest(o))));
  const cache = idx._cacheForTests();
  const crawled = origins.map((o) => cache.get(o));
  ok(crawled.every((e) => e && !e.error && e.tools.length >= OPS), `every concurrent crawl lands with its ${OPS} operations (${crawled.map((e) => e?.tools?.length).join(",")})`);
  // Relative to this machine: three one-turn normalises. In one turn each, the
  // twelve crawls held the loop for seven to eleven of them.
  const crawlBound = Math.max(60, 3 * oneTurnMs);
  ok(worst < crawlBound, `${origins.length} concurrent crawls of ${OPS}-operation documents (one normalise is ${oneTurnMs} ms in one turn) never hold the loop past ${crawlBound} ms (longest ${worst} ms)`);
  // The rows the crawl derived are the rows the one-turn normaliser derives.
  const rowsOf = (tools) => JSON.stringify(tools.filter((t) => t.route !== "/api/op0").map(({ seller, method, route, slug, name, description, price, requestContract, responseContract }) => ({ seller, method, route, slug, name, description, price, requestContract, responseContract })));
  ok(rowsOf(crawled[0].tools) === rowsOf(direct), "the sliced normaliser's rows equal the one-turn normaliser's");
  idx.__setCrawlFetchForTest(null);
  idx.__setProbeFetchForTest(null);
}

console.log(`\ntest-loop-slices: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
