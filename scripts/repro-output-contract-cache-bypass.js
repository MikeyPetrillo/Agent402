// Direct reproduction of the buyer output-contract cache bypass:
// a no-contract paid text/plain body with whitespace padding used to cache
// under slug+params, then a later strict JSON contract with a smaller
// maxResponseBytes returned the cached parsed object (skipping MIME and the
// wire-byte cap). This script proves the current client fails closed: a
// second fetch occurs and the contracted response is evaluated normally.
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
const compact = JSON.stringify(valid);
const padded = compact + " ".repeat(64);
const small = Buffer.byteLength(compact);
const CONTRACT_CACHE_RE = /#output-contract\/v1\/[0-9a-f]{64}$/;

const bodies = [];
let paid = 0;
const c = new Agent402({
  baseUrl: "http://mock.local",
  cache: true,
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
if (uncontracted?.data?.value !== 42 || paid !== 1 || !c._cache.has("t:{}")) {
  console.error("FAIL: no-contract padded text/plain did not cache under the legacy key");
  process.exit(1);
}

bodies.push({ raw: padded, type: "text/plain" });
let err = null;
try {
  await c.call("t", {}, {
    outputSchema,
    requiredFields: ["data.value", "data.source"],
    maxResponseBytes: small,
  });
} catch (e) {
  err = e;
}

const contractKeys = [...c._cache.keys()].filter((k) => CONTRACT_CACHE_RE.test(k));
const closed = paid === 2
  && err
  && /Content-Type was not application\/json/.test(err.message)
  && c.spendingSummary().dailyUsd === 0.02
  && contractKeys.length === 0
  && c._cache.has("t:{}");

if (!closed) {
  console.error("FAIL: old cache bypass still open", {
    paid,
    error: err?.message || null,
    dailyUsd: c.spendingSummary().dailyUsd,
    cacheKeys: [...c._cache.keys()],
  });
  process.exit(1);
}

console.log("ok - no-contract padded text/plain cannot satisfy a strict JSON output contract");
console.log("ok - second fetch occurred and failed closed on application/json MIME");
console.log("ok - settled spend retained; no contract-qualified cache entry");
process.exit(0);
