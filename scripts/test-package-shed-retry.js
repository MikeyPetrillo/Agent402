// Every published package that reads a discovery surface itself (the
// adapters and openclaw; agent402-client and agent402-mcp carry their own
// cases in client/test.js and mcp/test.js) retries a load-shed 503 that names
// its delay, at most 3 tries, and then fails with an error that names the
// surface and the last status. A paid call answering 503 is never repeated.
// Offline: fetch is stubbed, and the framework peers a package imports at
// build time are replaced by tiny stand-ins through a module resolve hook, so
// no registry or network is touched.
//
//   node scripts/test-package-shed-retry.js
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); pass++; };

// The adapters that wrap agent402-client resolve it to this tree's client; the
// two that build framework tools at load get stand-ins for their peer.
const MAP = {
  "agent402-client": pathToFileURL(join(ROOT, "client", "index.js")).href,
  "@strands-agents/sdk": `data:text/javascript,${encodeURIComponent("export const tool = (d) => ({ ...d });")}`,
  llamaindex: `data:text/javascript,${encodeURIComponent("export const tool = (fn, m) => ({ fn, ...m });")}`,
};
register(`data:text/javascript,${encodeURIComponent(`
const MAP = ${JSON.stringify(MAP)};
export async function resolve(spec, ctx, next) {
  if (Object.prototype.hasOwnProperty.call(MAP, spec)) return { url: MAP[spec], shortCircuit: true };
  return next(spec, ctx);
}`)}`);

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const shed = (seconds = 0) => json(503, { error: "The server is busy", retryAfterSeconds: seconds }, { "retry-after": String(seconds) });

const PRICING = { endpoints: [
  { slug: "hash", method: "GET", path: "/api/hash", price: "$0.001", computePayable: true },
  { slug: "paid", method: "POST", path: "/api/paid", price: "$0.01", computePayable: false },
] };
const OPENAPI = { paths: { "/api/hash": { get: { operationId: "hashGet", summary: "Hash text", parameters: [{ name: "text", required: true, schema: { type: "string" } }] } } } };
const BODIES = {
  "/api/pricing": PRICING,
  "/openapi.json": OPENAPI,
  "/api/find": { results: [{ slug: "hash" }] },
  "/api/route": { query: "hash", results: [] },
  "/.well-known/x402": { name: "stub" },
  "/v1/models": { object: "list", data: [{ id: "m1", x402: { endpoint: "/v1/chat/m1", priceUsd: 0.01, tier: "v1-chat-small" } }] },
};

// A stub host: `shedFor[path]` is how many shed 503s that path answers before
// its 200 (Infinity: always shed). Counts every request by path.
function stubHost(shedFor = {}) {
  const counts = {};
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    counts[path] = (counts[path] || 0) + 1;
    if (counts[path] <= (shedFor[path] || 0)) return shed(0);
    return BODIES[path] ? json(200, BODIES[path]) : json(404, { error: "not found" });
  };
  return { counts, fetchImpl };
}
async function withGlobalFetch(fetchImpl, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = saved; }
}
async function rejects(promise) { try { await promise; } catch (e) { return e; } return null; }

const BASE = "https://shed.example";

// 1) The four meta-tool adapters (find / route / call / about).
for (const name of ["ai-sdk", "langchain", "google-adk", "openai-agents"]) {
  const { agent402ToolSpecs } = await import(pathToFileURL(join(ROOT, "adapters", name, "index.js")).href);
  const byName = (specs, n) => specs.find((s) => s.name === n);
  {
    const h = stubHost({ "/api/find": 1, "/api/route": 1, "/.well-known/x402": 1 });
    const specs = agent402ToolSpecs({ baseUrl: BASE, fetchImpl: h.fetchImpl });
    const found = await byName(specs, "agent402_find").execute({ task: "hash" });
    ok(found.results?.[0]?.slug === "hash" && h.counts["/api/find"] === 2, `${name}: find answers after one shed 503`);
    await byName(specs, "agent402_route").execute({ query: "hash" });
    ok(h.counts["/api/route"] === 2, `${name}: route (POST) answers after one shed 503`);
    await byName(specs, "agent402_about").execute({});
    ok(h.counts["/.well-known/x402"] === 2, `${name}: about answers after one shed 503`);
  }
  {
    const h = stubHost({ "/api/find": Infinity });
    const err = await rejects(byName(agent402ToolSpecs({ baseUrl: BASE, fetchImpl: h.fetchImpl }), "agent402_find").execute({ task: "hash" }));
    ok(err && /^GET \/api\/find\?q=hash&k=5: HTTP 503 after 3 attempts$/.test(err.message) && err.status === 503 && h.counts["/api/find"] === 3,
      `${name}: 3 shed 503s fail naming the surface and status (${err && err.message})`);
  }
  {
    // The catalog read before a call retries; the paid send itself does not.
    const h = stubHost({ "/api/pricing": 1 });
    const paidCalls = [];
    const payFetch = async (url) => { paidCalls.push(String(url)); return shed(0); };
    const specs = agent402ToolSpecs({ baseUrl: BASE, fetchImpl: h.fetchImpl, fetch: payFetch });
    const err = await rejects(byName(specs, "agent402_call").execute({ slug: "paid", params: { a: 1 } }));
    ok(h.counts["/api/pricing"] === 2, `${name}: the catalog read before a call retries a shed 503`);
    ok(err && paidCalls.length === 1, `${name}: a paid call answering 503 is sent once (${paidCalls.length})`);
  }
  {
    const h = stubHost({ "/api/pricing": Infinity });
    const err = await rejects(byName(agent402ToolSpecs({ baseUrl: BASE, fetchImpl: h.fetchImpl }), "agent402_call").execute({ slug: "hash", params: {} }));
    ok(err && /GET \/api\/pricing\): HTTP 503 after 3 attempts$/.test(err.message), `${name}: a shed catalog read names /api/pricing (${err && err.message})`);
  }
}

// 2) The catalog-to-tools adapters (openapi.json + /api/pricing on global fetch).
for (const name of ["anthropic-tools", "openai-tools", "llamaindex", "strands"]) {
  const { agent402Tools } = await import(pathToFileURL(join(ROOT, "adapters", name, "index.js")).href);
  {
    const h = stubHost({ "/openapi.json": 1, "/api/pricing": 2 });
    const out = await withGlobalFetch(h.fetchImpl, () => agent402Tools({ baseUrl: BASE }));
    ok(out.tools.length === 1 && h.counts["/openapi.json"] === 2 && h.counts["/api/pricing"] === 3,
      `${name}: tools build through shed 503s on both surfaces (${out.tools.length} tools)`);
  }
  {
    const h = stubHost({ "/openapi.json": Infinity });
    const err = await rejects(withGlobalFetch(h.fetchImpl, () => agent402Tools({ baseUrl: BASE })));
    ok(err && err.message === `Could not load ${BASE}/openapi.json: HTTP 503 after 3 attempts` && h.counts["/openapi.json"] === 3,
      `${name}: 3 shed 503s fail naming the surface and status (${err && err.message})`);
  }
}

// 3) agentkit: find and about read discovery surfaces through fetchImpl.
{
  const { agent402Actions } = await import(pathToFileURL(join(ROOT, "adapters", "agentkit", "index.js")).href);
  const z = (await import("zod")).z;
  const h = stubHost({ "/api/find": 1, "/api/pricing": 1 });
  const actions = await agent402Actions({ baseUrl: BASE, fetchImpl: h.fetchImpl, zod: z });
  const find = actions.find((a) => a.name === "agent402_find");
  const about = actions.find((a) => a.name === "agent402_about");
  ok(JSON.parse(await find.invoke({ task: "hash" })).results[0].slug === "hash" && h.counts["/api/find"] === 2, "agentkit: find answers after one shed 503");
  ok(JSON.parse(await about.invoke({})).tools === 2 && h.counts["/api/pricing"] === 2, "agentkit: about answers after one shed 503");
  const h2 = stubHost({ "/api/find": Infinity });
  const actions2 = await agent402Actions({ baseUrl: BASE, fetchImpl: h2.fetchImpl, zod: z });
  const err = await rejects(actions2.find((a) => a.name === "agent402_find").invoke({ task: "hash" }));
  ok(err && err.message === "agent402_find failed (GET /api/find): HTTP 503 after 3 attempts" && h2.counts["/api/find"] === 3, `agentkit: 3 shed 503s fail clearly (${err && err.message})`);
}

// 4) elizaos-plugin-agent402: AGENT402_ABOUT reads /api/pricing on global fetch.
{
  const { aboutAction } = await import(pathToFileURL(join(ROOT, "adapters", "eliza", "index.js")).href);
  const runtime = { getSetting: (k) => (k === "AGENT402_BASE_URL" ? BASE : null) };
  const h = stubHost({ "/api/pricing": 1 });
  const out = await withGlobalFetch(h.fetchImpl, () => aboutAction.handler(runtime, {}, {}, {}, null));
  ok(out.success && out.data.tools === 2 && h.counts["/api/pricing"] === 2, "eliza: about answers after one shed 503");
  const h2 = stubHost({ "/api/pricing": Infinity });
  const bad = await withGlobalFetch(h2.fetchImpl, () => aboutAction.handler(runtime, {}, {}, {}, null));
  ok(!bad.success && /GET \/api\/pricing: HTTP 503 after 3 attempts/.test(bad.text) && h2.counts["/api/pricing"] === 3, `eliza: 3 shed 503s fail clearly (${bad.text})`);
}

// 5) agent402-openclaw: the model table read (GET /v1/models).
{
  const { loadRoutes } = await import(pathToFileURL(join(ROOT, "openclaw", "proxy.js")).href);
  const h = stubHost({ "/v1/models": 1 });
  const routes = await loadRoutes(BASE, h.fetchImpl);
  ok(routes.has("m1") && h.counts["/v1/models"] === 2, "openclaw: the model table loads after one shed 503");
  const h2 = stubHost({ "/v1/models": Infinity });
  const err = await rejects(loadRoutes(BASE, h2.fetchImpl));
  ok(err && err.message === "GET /v1/models: HTTP 503 after 3 attempts" && h2.counts["/v1/models"] === 3, `openclaw: 3 shed 503s fail clearly (${err && err.message})`);
}

// 6) The wait honors the server's delay (one real second here).
{
  const { agent402ToolSpecs } = await import(pathToFileURL(join(ROOT, "adapters", "ai-sdk", "index.js")).href);
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? shed(1) : json(200, BODIES["/api/find"]));
  const t0 = Date.now();
  await agent402ToolSpecs({ baseUrl: BASE, fetchImpl }).find((s) => s.name === "agent402_find").execute({ task: "hash" });
  const waited = Date.now() - t0;
  ok(waited >= 900 && waited < 4000, `a Retry-After of 1 s waits about 1 s (${waited} ms)`);
}

// 7) One mechanism, not ten: the inlined helper is the same text in every
// package that carries it (these packages ship with zero shared runtime
// code, so the copy is deliberate and must not drift).
{
  const files = ["ai-sdk", "langchain", "google-adk", "openai-agents", "anthropic-tools", "openai-tools", "llamaindex", "strands", "agentkit", "eliza"]
    .map((n) => join("adapters", n, "index.js")).concat([join("openclaw", "proxy.js")]);
  const grab = (src) => {
    const start = src.indexOf("const DISCOVERY_ATTEMPTS = 3;");
    const end = src.indexOf("\n}\n", src.indexOf("async function discoveryFetch("));
    return start >= 0 && end > start ? src.slice(start, end) : null;
  };
  const first = grab(readFileSync(join(ROOT, files[0]), "utf8"));
  ok(first, "the helper is present in adapters/ai-sdk");
  for (const f of files) ok(grab(readFileSync(join(ROOT, f), "utf8")) === first, `${f} carries the same discovery retry helper`);
}

console.log(`package shed-503 retry: ${pass} passed`);
