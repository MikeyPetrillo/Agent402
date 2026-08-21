// Direct reproduction of contracted cache-object mutation:
// a paid strict JSON response caches a nested numeric field; the caller
// mutates the returned object to a schema-invalid string. The next identical
// contracted call must fail closed before pay/fetch, evict that exact entry,
// and leave spend unchanged. A later identical call refetches a valid body
// and may cache it; spend increments only then.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent402 } from "../client/index.js";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "../client");
const require = createRequire(join(CLIENT, "index.js"));
try {
  require.resolve("agent-payment-policy");
} catch {
  console.error("agent-payment-policy@0.15.0 is required for this reproduction");
  process.exit(1);
}

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
const CONTRACT_CACHE_RE = /#output-contract\/v1\/[0-9a-f]{64}$/;

let paid = 0;
const c = new Agent402({
  baseUrl: "http://mock.local",
  cache: true,
  fetch: async () => {
    paid++;
    return new Response(JSON.stringify(valid), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
  fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  outputSchema,
  requiredFields: ["data.value", "data.source"],
});
c._catalog = new Map([["t", { method: "POST", path: "/api/t", computePayable: false, price: "$0.01" }]]);

const first = await c.call("t");
if (first?.data?.value !== 42 || paid !== 1) {
  console.error("FAIL: paid strict response did not cache a nested numeric field", { paid, first });
  process.exit(1);
}
const contractKeys = [...c._cache.keys()].filter((k) => CONTRACT_CACHE_RE.test(k));
if (contractKeys.length !== 1 || c._cache.has("t:{}")) {
  console.error("FAIL: expected one contract-qualified cache entry", [...c._cache.keys()]);
  process.exit(1);
}
const storedKey = contractKeys[0];

first.data.value = "42";
if (c.spendingSummary().dailyUsd !== 0.01) {
  console.error("FAIL: spend after valid cache fill", c.spendingSummary());
  process.exit(1);
}

let err = null;
try {
  await c.call("t");
} catch (e) {
  err = e;
}

const afterMutationKeys = [...c._cache.keys()].filter((k) => CONTRACT_CACHE_RE.test(k));
const closed = paid === 1
  && err
  && /buyer contract/.test(err.message)
  && /JSON Schema validation/.test(err.message)
  && c.spendingSummary().dailyUsd === 0.01
  && afterMutationKeys.length === 0
  && !c._cache.has(storedKey)
  && !c._cache.has("t:{}");

if (!closed) {
  console.error("FAIL: mutated contracted cache was not evicted before pay/fetch", {
    paid,
    error: err?.message || null,
    dailyUsd: c.spendingSummary().dailyUsd,
    cacheKeys: [...c._cache.keys()],
  });
  process.exit(1);
}

const again = await c.call("t");
const recached = [...c._cache.keys()].filter((k) => CONTRACT_CACHE_RE.test(k));
if (again?.data?.value !== 42 || typeof again.data.value !== "number" || paid !== 2) {
  console.error("FAIL: later identical call did not refetch a valid response", { paid, again });
  process.exit(1);
}
if (c.spendingSummary().dailyUsd !== 0.02) {
  console.error("FAIL: spend did not increment only on the later network call", c.spendingSummary());
  process.exit(1);
}
if (recached.length !== 1 || recached[0] !== storedKey || again === first) {
  console.error("FAIL: valid refetch did not recache under the same contract-qualified key", {
    recached,
    storedKey,
    sameRef: again === first,
  });
  process.exit(1);
}

console.log("ok - mutated contracted cache fails closed before pay/fetch and evicts that exact entry");
console.log("ok - later identical call refetches a valid response and may cache it");
console.log("ok - spend remains one payment before refetch and increments only on the later network call");
process.exit(0);
