// Locks the agent402-client buyer-owned output contract (offline, mocks catalog + fetch):
//  - inspectOutputSchema + prepareOutputValidator run before payFetch
//  - a paid 200 with the wrong JSON is delivery failure, not cached success
//  - settled spend is retained (funds already moved) after HTTP success
//  - omitting outputSchema preserves existing successful paid behavior
//  - invalid constructor/per-call controls fail before payFetch
//  - maxResponseBytes is actual response bytes, not JSON.stringify(parsed)
//  - JSON Content-Type is enforced before body read/parse
//  - contracted cache entries are namespaced by prepared contract identity
//  - contracted cache hits revalidate; a mutated stored object fails closed,
//    evicts that exact entry, and does not pay or fetch
//  - tests resolve agent-payment-policy's public export and never mutate installs
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent402 } from "../client/index.js";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "../client");
const require = createRequire(join(CLIENT, "index.js"));
try {
  require.resolve("agent-payment-policy");
} catch {
  console.error("agent-payment-policy@0.15.0 is required for this suite; install once with:");
  console.error("  npm install --ignore-scripts --no-save --no-package-lock agent-payment-policy@0.15.0");
  console.error("Tests do not install or remove the optional peer.");
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const CONTRACT_CACHE_RE = /#output-contract\/v1\/[0-9a-f]{64}$/;
const contractCacheKeys = (c) => [...(c._cache?.keys() || [])].filter((k) => CONTRACT_CACHE_RE.test(k));
const outputContractIdentityDigest = (contract) => createHash("sha256").update(JSON.stringify({
  maxResponseBytes: Number(contract.maxResponseBytes),
  mediaType: String(contract.mediaType || "").split(";", 1)[0].trim().toLowerCase(),
  requiredFields: [...new Set((contract.requiredFields || []).map((f) => String(f).trim()).filter(Boolean))].sort(),
  schemaDigest: String(contract.schemaDigest || "").toLowerCase(),
}), "utf8").digest("hex");

const outputSchema = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        value: { type: "number" },
        source: { type: "string", format: "uri" },
      },
      required: ["value", "source"],
      additionalProperties: false,
    },
  },
  required: ["data"],
  additionalProperties: false,
};
const valid = { data: { value: 42, source: "https://example.com/source" } };
const jsonResponse = (payload, status = 200, contentType = "application/json") => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (contentType === null) {
    const r = new Response(body, { status, headers: { "content-type": "application/json" } });
    r.headers.delete("content-type");
    return r;
  }
  return new Response(body, { status, headers: { "content-type": contentType } });
};

const mk = (body, extra = {}) => {
  const { raw, contentType, ...opts } = extra;
  let paid = 0;
  const c = new Agent402({
    baseUrl: "http://mock.local",
    cache: true,
    fetch: async () => {
      paid++;
      const payload = raw !== undefined ? raw : body;
      return Object.prototype.hasOwnProperty.call(extra, "contentType")
        ? jsonResponse(payload, 200, contentType)
        : jsonResponse(payload);
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: 1 }) }),
    outputSchema,
    requiredFields: ["data.value", "data.source"],
    ...opts,
  });
  c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);
  return { c, paid: () => paid };
};

{
  const { c, paid } = mk(valid);
  const out = await c.call("t", {}, { cache: true });
  ok(out?.data?.value === 42, "valid paid JSON still returns unchanged");
  ok(paid() === 1, "valid paid JSON still pays once");
  ok(c.spendingSummary().dailyUsd === 0.01, "valid paid JSON still records settled spend");
  const cached = await c.call("t", {}, { cache: true });
  ok(cached === out && paid() === 1, "valid paid JSON remains cacheable");
  ok(!c._cache.has("t:{}"), "contracted success is not stored under the legacy no-contract key");
  ok(contractCacheKeys(c).length === 1, "contracted success is stored under a contract-qualified key");
}

{
  const { c, paid } = mk({ data: { value: "42", source: "https://example.com/source" } });
  let e = null; try { await c.call("t", {}, { cache: true }); } catch (err) { e = err; }
  ok(!!e && /buyer contract/.test(e.message) && /JSON Schema validation/.test(e.message),
    "wrong JSON type after paid 200 fails closed");
  ok(paid() === 1, "invalid delivery still went through payFetch");
  ok(c.spendingSummary().dailyUsd === 0.01, "invalid delivery still records settled spend");
  ok(!c._cache.has("t:{}") && contractCacheKeys(c).length === 0,
    "invalid delivery writes neither a legacy nor a contract-qualified cache entry");
}

{
  const { c, paid } = mk({ data: { value: 42, source: "not a uri" } });
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /JSON Schema validation/.test(e.message), "invalid URI format after paid 200 fails closed");
  ok(paid() === 1, "invalid format still paid once");
}

{
  const { c, paid } = mk({ data: { value: 42 } });
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /missing required fields/.test(e.message), "missing required field after paid 200 fails closed");
  ok(paid() === 1, "missing field still paid once");
}

{
  let paid = 0;
  const c = new Agent402({
    baseUrl: "http://mock.local",
    cache: false,
    fetch: async () => { paid++; return jsonResponse(valid); },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    outputSchema: { type: "object", additionalProperties: true },
    requiredFields: ["data.value"],
  });
  c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && paid === 0, "inadmissible output schema fails before payFetch");
  ok(c.spendingSummary().dailyUsd === 0, "inadmissible schema never records spend");
}

{
  const { c, paid } = mk(valid, { outputSchema: null, requiredFields: [] });
  const out = await c.call("t");
  ok(out?.data?.value === 42 && paid() === 1, "omitting outputSchema preserves existing successful paid behavior");
}

{
  const { c, paid } = mk(valid, { raw: "{not-json" });
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /not valid JSON/.test(e.message), "malformed JSON after paid 200 fails closed");
  ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01, "malformed JSON retains settled spend");
  ok(!c._cache.has("t:{}") && contractCacheKeys(c).length === 0,
    "malformed JSON writes no contract-qualified cache entry");
}

{
  const { c, paid } = mk(valid, { raw: "" });
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /empty/.test(e.message), "empty body after paid 200 fails closed");
  ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01, "empty body retains settled spend");
  ok(!c._cache.has("t:{}") && contractCacheKeys(c).length === 0,
    "empty body writes no contract-qualified cache entry");
}

{
  const compact = JSON.stringify(valid);
  const maxResponseBytes = Buffer.byteLength(compact) + 8;
  const padded = compact + " ".repeat(16);
  ok(Buffer.byteLength(padded) > maxResponseBytes, "padded fixture exceeds the raw bound");
  ok(Buffer.byteLength(JSON.stringify(JSON.parse(padded))) <= maxResponseBytes,
    "stringify(parsed) would not catch the padded oversize");
  const { c, paid } = mk(valid, { raw: padded, maxResponseBytes });
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /exceeded maxResponseBytes/.test(e.message),
    "whitespace-padded body exceeding the raw limit fails before parse");
  ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01,
    "raw-size rejection after HTTP success retains settled spend");
  ok(!c._cache.has("t:{}") && contractCacheKeys(c).length === 0,
    "raw-size rejection writes no contract-qualified cache entry");
}

{
  const ctorCases = [
    [{ outputSchema: false }, "outputSchema"],
    [{ outputSchema: "object" }, "outputSchema"],
    [{ outputSchema: [outputSchema] }, "outputSchema"],
    [{ requiredFields: "data.value" }, "requiredFields"],
    [{ requiredFields: [1] }, "requiredFields"],
    [{ requiredFields: [""] }, "requiredFields"],
    [{ maxResponseBytes: 0 }, "maxResponseBytes"],
    [{ maxResponseBytes: -1 }, "maxResponseBytes"],
    [{ maxResponseBytes: 1.5 }, "maxResponseBytes"],
    [{ maxResponseBytes: "1000" }, "maxResponseBytes"],
  ];
  for (const [opts, label] of ctorCases) {
    let e = null; try { new Agent402({ fetch: async () => jsonResponse(valid), ...opts }); } catch (err) { e = err; }
    ok(!!e && new RegExp(label).test(e.message), `invalid constructor ${label} fails before pay`);
  }
}

{
  const { c, paid } = mk(valid);
  const perCall = [
    [{ outputSchema: false }, "outputSchema"],
    [{ outputSchema: "object" }, "outputSchema"],
    [{ requiredFields: false }, "requiredFields"],
    [{ requiredFields: ["data.value", 2] }, "requiredFields"],
    [{ maxResponseBytes: 0 }, "maxResponseBytes"],
    [{ maxResponseBytes: -5 }, "maxResponseBytes"],
  ];
  for (const [opts, label] of perCall) {
    const before = paid();
    let e = null; try { await c.call("t", {}, opts); } catch (err) { e = err; }
    ok(!!e && new RegExp(label).test(e.message) && paid() === before,
      `invalid per-call ${label} fails before payFetch`);
  }
  ok(c.spendingSummary().dailyUsd === 0, "invalid per-call controls never record spend");
}

{
  const { c, paid } = mk(valid);
  let e = null; try { await c.call("t", {}, { outputSchema: false }); } catch (err) { e = err; }
  ok(!!e && /outputSchema/.test(e.message) && paid() === 0,
    "per-call outputSchema:false fails before pay and does not disable the constructor contract");
  const out = await c.call("t");
  ok(out?.data?.value === 42 && paid() === 1,
    "constructor outputSchema still applies after a rejected per-call false");
}

{
  ok(typeof require.resolve("agent-payment-policy") === "string",
    "tests resolve agent-payment-policy public export, not package.json");
}

{
  const { c, paid } = mk(valid, { contentType: null });
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /Content-Type was missing/.test(e.message),
    "missing Content-Type after paid 200 fails closed before parse");
  ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01, "missing Content-Type retains settled spend");
  ok(!c._cache.has("t:{}") && contractCacheKeys(c).length === 0,
    "missing Content-Type writes no contract-qualified cache entry");
}

{
  const { c, paid } = mk(valid, { contentType: "text/plain" });
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /Content-Type was not application\/json/.test(e.message),
    "text/plain Content-Type after paid 200 fails closed even when body is JSON");
  ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01, "wrong Content-Type retains settled spend");
  ok(!c._cache.has("t:{}") && contractCacheKeys(c).length === 0,
    "wrong Content-Type writes no contract-qualified cache entry");
}

{
  const { c, paid } = mk(valid, { contentType: "text/json" });
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /Content-Type was not application\/json/.test(e.message) && paid() === 1,
    "text/json is not application/json");
  ok(!c._cache.has("t:{}"), "text/json is not cached as success");
}

{
  const { c, paid } = mk(valid, { contentType: "application/ld+json" });
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /Content-Type was not application\/json/.test(e.message) && paid() === 1,
    "application/ld+json is not application/json");
  ok(!c._cache.has("t:{}"), "JSON-compatible suffix types are not cached as success");
}

{
  const { c, paid } = mk(valid, { raw: "{not-json", contentType: "text/plain" });
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /Content-Type was not application\/json/.test(e.message) && !/not valid JSON/.test(e.message),
    "wrong Content-Type fails on media type before JSON parse");
  ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01 && !c._cache.has("t:{}"),
    "media-type rejection before parse retains spend and is not cached");
}

{
  const { c, paid } = mk(valid, { contentType: "application/json; charset=utf-8" });
  const out = await c.call("t");
  ok(out?.data?.value === 42 && paid() === 1, "parameterized application/json; charset=utf-8 is accepted");
  ok(c.spendingSummary().dailyUsd === 0.01, "parameterized JSON media type still records settled spend");
}

{
  const { c, paid } = mk(valid, { contentType: "application/json; charset=\"utf-8\"" });
  const out = await c.call("t");
  ok(out?.data?.value === 42 && paid() === 1, "quoted charset parameter is accepted");
}

{
  const { c, paid } = mk(valid, { contentType: "Application/JSON" });
  const out = await c.call("t");
  ok(out?.data?.value === 42 && paid() === 1, "case-insensitive Application/JSON is accepted");
}

{
  const { c, paid } = mk(valid, { contentType: "APPLICATION/JSON; Charset=UTF-8" });
  const out = await c.call("t");
  ok(out?.data?.value === 42 && paid() === 1,
    "case-insensitive type with charset parameter is accepted");
}

{
  let paid = 0;
  const body = { ok: true };
  const c = new Agent402({
    baseUrl: "http://mock.local", cache: true,
    fetch: async () => { paid++; return { ok: true, status: 200, json: async () => body }; },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);
  const out = await c.call("t");
  ok(out === body && paid === 1, "no-contract path still uses response.json() without a Body polyfill");
  ok(c.spendingSummary().dailyUsd === 0.01, "no-contract successful paid JSON still records settled spend");
  const cached = await c.call("t");
  ok(cached === out && paid === 1, "no-contract successful paid JSON remains cacheable");
}

{
  let paid = 0;
  const body = { ok: true };
  const c = new Agent402({
    baseUrl: "http://mock.local", cache: true,
    fetch: async () => {
      paid++;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "text/plain" } });
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);
  const out = await c.call("t");
  ok(out?.ok === true && paid === 1, "no-contract path does not enforce JSON Content-Type");
  ok(c.spendingSummary().dailyUsd === 0.01, "no-contract text/plain JSON still records settled spend");
}

{
  let paid = 0;
  const c = new Agent402({
    baseUrl: "http://mock.local", cache: true,
    fetch: async () => { paid++; return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } }; },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && paid === 1, "no-contract malformed JSON after HTTP 200 still fails");
  ok(c.spendingSummary().dailyUsd === 0.01, "no-contract malformed JSON after HTTP 200 retains settled spend");
  ok(!c._cache.has("t:{}"), "no-contract malformed JSON is not cached");
}

{
  let paid = 0;
  const c = new Agent402({
    baseUrl: "http://mock.local", cache: false,
    fetch: async () => { paid++; return { ok: false, status: 502 }; },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    outputSchema,
  });
  c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);
  let e = null; try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /HTTP 502/.test(e.message) && paid === 1, "non-OK HTTP still goes through payFetch");
  ok(c.spendingSummary().dailyUsd === 0, "non-OK HTTP still releases spend reservation");
}

const outputSchemaAlt = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        value: { type: "number" },
        source: { type: "string", format: "uri" },
        note: { type: "string" },
      },
      required: ["value", "source"],
      additionalProperties: false,
    },
  },
  required: ["data"],
  additionalProperties: false,
};

{
  // P1: a no-contract paid text/plain body with whitespace padding caches under
  // the legacy key, then cannot satisfy a later strict JSON contract with a
  // smaller wire limit. A second fetch occurs and is evaluated normally.
  const compact = JSON.stringify(valid);
  const padded = compact + " ".repeat(64);
  const small = Buffer.byteLength(compact);
  ok(Buffer.byteLength(padded) > small, "repro padded fixture exceeds the contracted wire limit");
  const bodies = [];
  let paid = 0;
  const c = new Agent402({
    baseUrl: "http://mock.local", cache: true,
    fetch: async () => {
      paid++;
      const spec = bodies.shift();
      return new Response(spec.raw, { status: 200, headers: { "content-type": spec.type } });
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);

  bodies.push({ raw: padded, type: "text/plain" });
  const uncontracted = await c.call("t");
  ok(uncontracted?.data?.value === 42 && paid === 1, "no-contract padded text/plain caches under legacy behavior");
  ok(c._cache.has("t:{}") && contractCacheKeys(c).length === 0, "legacy key is used; no contract-qualified entry yet");

  bodies.push({ raw: padded, type: "text/plain" });
  let e = null;
  try {
    await c.call("t", {}, {
      outputSchema,
      requiredFields: ["data.value", "data.source"],
      maxResponseBytes: small,
    });
  } catch (err) { e = err; }
  ok(paid === 2, "strict JSON contract with a small wire limit does not reuse the uncontracted cache");
  ok(!!e && /Content-Type was not application\/json/.test(e.message),
    "second fetch is evaluated under the contracted MIME gate");
  ok(c.spendingSummary().dailyUsd === 0.02, "both paid successes record settled spend");
  ok(c._cache.has("t:{}") && contractCacheKeys(c).length === 0,
    "rejected contracted delivery creates no contract-qualified cache entry");

  bodies.push({ raw: compact, type: "application/json" });
  const contracted = await c.call("t", {}, {
    outputSchema,
    requiredFields: ["data.value", "data.source"],
    maxResponseBytes: small,
  });
  ok(contracted?.data?.value === 42 && paid === 3,
    "a later valid contracted JSON response is fetched and accepted");
  ok(contractCacheKeys(c).length === 1 && c._cache.has("t:{}"),
    "legacy and contract-qualified entries coexist without cross-hitting");
}

{
  const { c, paid } = mk(valid, { maxResponseBytes: 100000 });
  const compact = JSON.stringify(valid);
  await c.call("t");
  ok(paid() === 1 && contractCacheKeys(c).length === 1, "large maxResponseBytes caches under its identity");
  const again = await c.call("t", {}, { maxResponseBytes: Buffer.byteLength(compact) });
  ok(again?.data?.value === 42 && paid() === 2,
    "a smaller maxResponseBytes does not hit a larger-ceiling cache entry");
  ok(contractCacheKeys(c).length === 2, "each byte ceiling stores its own contract-qualified entry");
}

{
  const { c, paid } = mk(valid);
  await c.call("t");
  ok(paid() === 1, "baseline schema paid once");
  const other = await c.call("t", {}, { outputSchema: outputSchemaAlt });
  ok(other?.data?.value === 42 && paid() === 2, "a different schema digest cannot cross-hit");
  const fewerFields = await c.call("t", {}, { requiredFields: ["data.value"] });
  ok(fewerFields?.data?.value === 42 && paid() === 3, "different requiredFields cannot cross-hit");
  ok(contractCacheKeys(c).length === 3, "schema and requiredFields identities are distinct cache entries");
}

{
  const policy = await import(require.resolve("agent-payment-policy"));
  const inspected = policy.inspectOutputSchema({
    schema: outputSchema,
    requiredFields: ["data.value", "data.source"],
  });
  const { c, paid } = mk(valid);
  const out = await c.call("t");
  const stored = contractCacheKeys(c)[0];
  const jsonDigest = outputContractIdentityDigest({
    schemaDigest: inspected.schemaDigest,
    requiredFields: ["data.source", "data.value"],
    mediaType: "application/json",
    maxResponseBytes: 100000,
  });
  const plainDigest = outputContractIdentityDigest({
    schemaDigest: inspected.schemaDigest,
    requiredFields: ["data.source", "data.value"],
    mediaType: "text/plain",
    maxResponseBytes: 100000,
  });
  ok(stored?.endsWith(jsonDigest), "stored cache digest matches the canonical application/json identity");
  ok(jsonDigest !== plainDigest, "media type is part of the cache identity");
  c._cache.set(`t:{}#output-contract/v1/${plainDigest}`, { data: { value: 99, source: "https://evil.example/" } });
  const hit = await c.call("t");
  ok(hit === out && paid() === 1 && hit?.data?.value === 42,
    "a different media-type cache entry cannot satisfy application/json");
}

{
  const { c, paid } = mk(valid);
  const first = await c.call("t", {}, { requiredFields: ["data.source", "data.value"] });
  const second = await c.call("t", {}, { requiredFields: ["data.value", "data.source"] });
  ok(first === second && paid() === 1,
    "identical normalized requiredFields hit the same contract-qualified cache entry");
}

{
  const { c, paid } = mk(valid);
  await c.call("t");
  const keysBefore = [...c._cache.keys()].sort().join("\n");
  const before = paid();
  let e = null; try { await c.call("t", {}, { outputSchema: false }); } catch (err) { e = err; }
  ok(!!e && /outputSchema/.test(e.message) && paid() === before,
    "invalid per-call outputSchema:false fails before any cache read or pay");
  ok([...c._cache.keys()].sort().join("\n") === keysBefore,
    "invalid per-call control does not mutate the cache");
  ok(c.spendingSummary().dailyUsd === 0.01, "invalid per-call control does not record extra spend");
}

{
  let constructed = null;
  try {
    constructed = new Agent402({
      baseUrl: "http://mock.local",
      cache: true,
      fetch: async () => jsonResponse(valid),
      outputSchema: false,
    });
  } catch (err) {
    constructed = err;
  }
  ok(constructed instanceof Error && /outputSchema/.test(constructed.message),
    "invalid constructor outputSchema fails before any cache or pay");
}

{
  // Adversarial: a paid strict response caches a nested numeric field; the
  // caller mutates that returned object to a schema-invalid string. The next
  // identical contracted call must fail closed before pay/fetch, evict that
  // exact entry, and leave spend unchanged. A later identical call refetches
  // a valid body and may cache it; spend increments only then.
  let paid = 0;
  const c = new Agent402({
    baseUrl: "http://mock.local",
    cache: true,
    fetch: async () => { paid++; return jsonResponse(valid); },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    outputSchema,
    requiredFields: ["data.value", "data.source"],
  });
  c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);

  const first = await c.call("t");
  ok(first?.data?.value === 42 && paid === 1, "paid strict response caches a nested numeric field");
  ok(contractCacheKeys(c).length === 1 && !c._cache.has("t:{}"),
    "success is stored only under the complete contract-qualified namespace");
  const storedKey = contractCacheKeys(c)[0];

  first.data.value = "42";
  ok(c.spendingSummary().dailyUsd === 0.01, "spend is one payment after the valid cache fill");

  let e = null;
  try { await c.call("t"); } catch (err) { e = err; }
  ok(!!e && /buyer contract/.test(e.message) && /JSON Schema validation/.test(e.message),
    "identical contracted call throws the controlled contract error after mutation");
  ok(paid === 1, "mutated cache hit fails before pay/fetch");
  ok(c.spendingSummary().dailyUsd === 0.01, "spend remains one payment before refetch");
  ok(!c._cache.has(storedKey) && contractCacheKeys(c).length === 0 && !c._cache.has("t:{}"),
    "the exact contract-qualified cache entry is evicted");

  const again = await c.call("t");
  ok(again?.data?.value === 42 && typeof again.data.value === "number" && paid === 2,
    "later identical call refetches a valid response");
  ok(c.spendingSummary().dailyUsd === 0.02,
    "spend increments only on the later successful network call");
  ok(contractCacheKeys(c).length === 1 && c._cache.has(storedKey),
    "valid refetch can cache under the same contract-qualified key");
  ok(again !== first, "refetch returns a new object, not the mutated reference");
}

{
  let paid = 0;
  const body = { data: { value: 42, source: "https://example.com/source" } };
  const c = new Agent402({
    baseUrl: "http://mock.local", cache: true,
    fetch: async () => { paid++; return { ok: true, status: 200, json: async () => body }; },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);
  const out = await c.call("t");
  out.data.value = "42";
  const hit = await c.call("t");
  ok(hit === out && hit.data.value === "42" && paid === 1,
    "legacy no-contract cache hits still return the stored object without revalidation");
  ok(c._cache.has("t:{}") && contractCacheKeys(c).length === 0,
    "legacy no-contract cache key and namespace are unchanged");
}

{
  const bodies = [];
  let paid = 0;
  const c = new Agent402({
    baseUrl: "http://mock.local", cache: true,
    fetch: async () => {
      paid++;
      const spec = bodies.shift();
      return new Response(JSON.stringify(spec.body), { status: 200, headers: { "content-type": spec.type } });
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);

  bodies.push({ body: valid, type: "text/plain" });
  const legacy = await c.call("t");
  bodies.push({ body: valid, type: "application/json" });
  const contracted = await c.call("t", {}, {
    outputSchema,
    requiredFields: ["data.value", "data.source"],
  });
  ok(c._cache.has("t:{}") && contractCacheKeys(c).length === 1 && paid === 2,
    "legacy and contract-qualified entries coexist before mutation");
  const contractKey = contractCacheKeys(c)[0];
  contracted.data.value = "42";
  let e = null;
  try {
    await c.call("t", {}, { outputSchema, requiredFields: ["data.value", "data.source"] });
  } catch (err) { e = err; }
  ok(!!e && /buyer contract/.test(e.message) && paid === 2,
    "contracted mutation fails closed without a third pay/fetch");
  ok(c._cache.has("t:{}") && !c._cache.has(contractKey) && contractCacheKeys(c).length === 0,
    "mutation evicts only the exact contract-qualified entry");
  ok(legacy.data.value === 42, "legacy cached object remains a distinct unmutated reference");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
