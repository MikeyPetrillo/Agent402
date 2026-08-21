// agent402-client tested against a server with the x402 paywall ACTIVE, so the
// client really exercises the proof-of-work auto-payment path. The facilitator
// is never contacted (X402_SYNC_ON_START=false); PoW bypasses settlement.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent402, withNetworkPreference, withPayeeAllowlist, NETWORK_CAIP2 } from "./index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3081;
const proc = spawn("node", ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false",
    POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
  stdio: "ignore",
});
const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
let pass = 0; const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

// Offline: withNetworkPreference pins the settlement chain (e.g. USDG on
// Robinhood Chain) on any duck-typed x402 client — no @x402 dependency here.
{
  ok(NETWORK_CAIP2.robinhood === "eip155:4663", "NETWORK_CAIP2 knows robinhood -> eip155:4663");
  const accepts = [{ network: "eip155:8453", a: "base" }, { network: "eip155:4663", a: "usdg" }];
  const seen = [];
  const fake = { createPaymentPayload: (pr) => { seen.push(pr.accepts.map((x) => x.a)); return "ok"; } };
  withNetworkPreference(fake, ["robinhood"]);
  ok(fake.createPaymentPayload({ accepts }) === "ok", "wrapped client delegates");
  ok(JSON.stringify(seen[0]) === '["usdg"]', "preference filters accepts to the pinned chain");
  let threw = false;
  const none = { createPaymentPayload: () => "x" };
  withNetworkPreference(none, ["eip155:1"]);
  try { none.createPaymentPayload({ accepts }); } catch { threw = true; }
  ok(threw, "no-match preference throws before paying");
  const untouched = { createPaymentPayload: (pr) => pr.accepts.length };
  withNetworkPreference(untouched, []);
  ok(untouched.createPaymentPayload({ accepts }) === 2, "empty preference leaves the client untouched");
}

// Offline: withPayeeAllowlist refuses a 402 whose payTo is not allowlisted -
// the buyer-side "who gets paid" control (filters accepts before any signature).
{
  const calls = [];
  const fake = { createPaymentPayload: async (pr) => { calls.push(pr); return { ok: true }; } };
  withPayeeAllowlist(fake, ["0xABCDEF0000000000000000000000000000000001"]);
  await fake.createPaymentPayload({ accepts: [
    { network: "eip155:8453", payTo: "0xabcdef0000000000000000000000000000000001" },
    { network: "eip155:8453", payTo: "0x9999999999999999999999999999999999999999" },
  ] });
  if (calls.length !== 1 || calls[0].accepts.length !== 1 || calls[0].accepts[0].payTo !== "0xabcdef0000000000000000000000000000000001") { console.error("FAIL: withPayeeAllowlist should keep only the allowlisted payee (case-insensitive 0x)"); process.exit(1); }
  let refused = null;
  try { await fake.createPaymentPayload({ accepts: [{ network: "eip155:8453", payTo: "0x9999999999999999999999999999999999999999" }] }); } catch (e) { refused = e; }
  if (!refused || !/payee allowlist refused/.test(refused.message)) { console.error("FAIL: withPayeeAllowlist must refuse a quote with no allowlisted payee"); process.exit(1); }
  let empty = null; try { withPayeeAllowlist({ createPaymentPayload: async () => {} }, []); } catch (e) { empty = e; }
  if (!empty) { console.error("FAIL: withPayeeAllowlist with no payees must throw"); process.exit(1); }
  console.log("ok - withPayeeAllowlist filters accepts to allowlisted payees and refuses otherwise");
}
// Offline: buyer spending caps refuse to overpay BEFORE signing (defends the
// x402 "wallet drain via uncapped spending" failure mode). No server needed —
// stub the catalog and a paying fetch.
{
  const okResp = { ok: true, json: async () => ({ ok: true }) };
  const mk = (opts) => {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: false,
      fetch: async () => { paid++; return okResp; },     // x402 payFetch (wallet-only path)
      fetchImpl: async () => okResp,                       // plain fetch (unused; catalog is stubbed)
      ...opts,
    });
    c._catalog = new Map([
      ["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }],
      ["pricey", { method: "POST", path: "/api/pricey", computePayable: false, price: "$1.00" }],
    ]);
    return { c, paid: () => paid };
  };

  // per-call cap refuses an over-price tool before any payment
  {
    const { c, paid } = mk({ maxPerCallUsd: 0.05 });
    let e = null; try { await c.call("pricey"); } catch (err) { e = err; }
    ok(e && e.name === "SpendingLimitError" && e.limit === "maxPerCallUsd", "maxPerCallUsd blocks an over-price tool");
    ok(paid() === 0, "blocked call never paid (refused before signing)");
    await c.call("cheap");
    ok(paid() === 1, "under-cap tool pays normally");
    ok(c.spendingSummary().dailyUsd === 0.01, "settled spend is recorded");
  }

  // daily cap sums across calls and blocks the one that would cross it
  {
    const { c, paid } = mk({ dailyLimitUsd: 0.025 });
    await c.call("cheap"); await c.call("cheap"); // 0.02 total
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && e.limit === "dailyLimitUsd", "dailyLimitUsd blocks the call that would cross the ceiling");
    ok(paid() === 2, "exactly the two under-budget calls paid");
  }

  // per-host cap bounds spend to a single seller host
  {
    const { c } = mk({ maxPerHostUsd: 0.015 });
    await c.call("cheap");
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && e.limit === "maxPerHostUsd", "maxPerHostUsd bounds per-seller spend");
  }

  // no caps configured → behavior unchanged (pays regardless of price)
  {
    const { c, paid } = mk({});
    await c.call("pricey");
    ok(paid() === 1, "no caps → default behavior, pays any price");
  }

  // a failed paid call does NOT count against the budget (commit only on settle)
  {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: false, dailyLimitUsd: 0.05,
      fetch: async () => { paid++; return { ok: false, status: 500 }; },
      fetchImpl: async () => okResp,
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
    let failed = false; try { await c.call("cheap"); } catch { failed = true; }
    ok(failed && paid === 1, "a failed paid call throws");
    ok(c.spendingSummary().dailyUsd === 0, "a failed paid call does not count against the budget");
  }
}

// Offline: buyer-owned output contract (agent-payment-policy@0.15.0) is compiled
// before payFetch, so a paid 200 with the wrong JSON is delivery failure — not
// a cached success. Omit outputSchema and existing behavior is unchanged.
{
  const require = createRequire(import.meta.url);
  try {
    require.resolve("agent-payment-policy");
  } catch {
    fail("agent-payment-policy@0.15.0 is required for output-contract tests; install once with: npm install --ignore-scripts --no-save --no-package-lock agent-payment-policy@0.15.0");
  }
  ok(typeof require.resolve("agent-payment-policy") === "string",
    "tests resolve agent-payment-policy public export, not package.json");

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
      baseUrl: "https://seller.example", cache: true,
      fetch: async () => {
        paid++;
        const payload = raw !== undefined ? raw : body;
        return Object.prototype.hasOwnProperty.call(extra, "contentType")
          ? jsonResponse(payload, 200, contentType)
          : jsonResponse(payload);
      },
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
      outputSchema,
      requiredFields: ["data.value", "data.source"],
      ...opts,
    });
    c._catalog = new Map([
      ["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }],
    ]);
    return { c, paid: () => paid };
  };

  {
    const { c, paid } = mk(valid);
    const out = await c.call("cheap");
    ok(out && out.data && out.data.value === 42, "valid paid JSON still returns unchanged");
    ok(paid() === 1, "valid paid JSON still pays once");
    ok(c.spendingSummary().dailyUsd === 0.01, "valid paid JSON still records settled spend");
    const cached = await c.call("cheap");
    ok(cached === out && paid() === 1, "valid paid JSON remains cacheable");
  }

  {
    const { c, paid } = mk({ data: { value: "42", source: "https://example.com/source" } });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /buyer contract/.test(e.message) && /JSON Schema validation/.test(e.message),
      "wrong JSON type after paid 200 fails closed");
    ok(paid() === 1, "invalid delivery still went through payFetch (funds moved)");
    ok(c.spendingSummary().dailyUsd === 0.01, "invalid delivery still records settled spend");
    ok(!c._cache.has('cheap:{}'), "invalid delivery is not cached as success");
  }

  {
    const { c, paid } = mk({ data: { value: 42, source: "not a uri" } });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /JSON Schema validation/.test(e.message), "invalid URI format after paid 200 fails closed");
    ok(paid() === 1, "invalid format still paid once");
  }

  {
    const { c, paid } = mk({ data: { value: 42 } });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /missing required fields/.test(e.message), "missing required field after paid 200 fails closed");
    ok(paid() === 1, "missing field still paid once");
  }

  {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: false,
      fetch: async () => { paid++; return { ok: true, json: async () => valid }; },
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
      outputSchema: { type: "object", additionalProperties: true },
      requiredFields: ["data.value"],
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && paid === 0, "inadmissible output schema fails before payFetch");
    ok(c.spendingSummary().dailyUsd === 0, "inadmissible schema never records spend");
  }

  {
    const { c, paid } = mk(valid, { outputSchema: undefined, requiredFields: undefined });
    c._outputSchema = null;
    c._outputRequiredFields = [];
    const out = await c.call("cheap");
    ok(out && out.data && out.data.value === 42 && paid() === 1,
      "omitting outputSchema preserves existing successful paid behavior");
  }

  {
    const { c, paid } = mk(valid, { raw: "{not-json" });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /not valid JSON/.test(e.message), "malformed JSON after paid 200 fails closed");
    ok(paid() === 1, "malformed JSON still went through payFetch");
    ok(c.spendingSummary().dailyUsd === 0.01, "malformed JSON still records settled spend");
    ok(!c._cache.has("cheap:{}"), "malformed JSON is not cached as success");
  }

  {
    const { c, paid } = mk(valid, { raw: "" });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /empty/.test(e.message), "empty body after paid 200 fails closed");
    ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01, "empty body still records settled spend");
    ok(!c._cache.has("cheap:{}"), "empty body is not cached as success");
  }

  {
    const compact = JSON.stringify(valid);
    const maxResponseBytes = Buffer.byteLength(compact) + 8;
    const padded = compact + " ".repeat(16);
    ok(Buffer.byteLength(padded) > maxResponseBytes, "padded fixture exceeds the raw bound");
    ok(Buffer.byteLength(JSON.stringify(JSON.parse(padded))) <= maxResponseBytes,
      "stringify(parsed) would not catch the padded oversize");
    const { c, paid } = mk(valid, { raw: padded, maxResponseBytes });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /exceeded maxResponseBytes/.test(e.message),
      "whitespace-padded body exceeding the raw limit fails before parse");
    ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01,
      "raw-size rejection after HTTP success retains settled spend");
    ok(!c._cache.has("cheap:{}"), "raw-size rejection is not cached as success");
  }

  {
    const cases = [
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
    for (const [opts, label] of cases) {
      let e = null; try { new Agent402({ fetch: async () => jsonResponse(valid), ...opts }); } catch (err) { e = err; }
      ok(e && new RegExp(label).test(e.message), `invalid constructor ${label}=${JSON.stringify(opts[label])} fails before pay`);
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
      let e = null; try { await c.call("cheap", {}, opts); } catch (err) { e = err; }
      ok(e && new RegExp(label).test(e.message) && paid() === before,
        `invalid per-call ${label} fails before payFetch`);
    }
    ok(c.spendingSummary().dailyUsd === 0, "invalid per-call controls never record spend");
  }

  {
    const { c, paid } = mk(valid);
    let e = null; try { await c.call("cheap", {}, { outputSchema: false }); } catch (err) { e = err; }
    ok(e && /outputSchema/.test(e.message) && paid() === 0,
      "per-call outputSchema:false fails before pay and does not disable the constructor contract");
    const out = await c.call("cheap");
    ok(out && out.data && out.data.value === 42 && paid() === 1,
      "constructor outputSchema still applies after a rejected per-call false");
  }

  {
    const { c, paid } = mk(valid, { contentType: null });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /Content-Type was missing/.test(e.message),
      "missing Content-Type after paid 200 fails closed before parse");
    ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01, "missing Content-Type retains settled spend");
    ok(!c._cache.has("cheap:{}"), "missing Content-Type is not cached as success");
  }

  {
    const { c, paid } = mk(valid, { contentType: "text/plain" });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /Content-Type was not application\/json/.test(e.message),
      "text/plain Content-Type after paid 200 fails closed even when body is JSON");
    ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01, "wrong Content-Type retains settled spend");
    ok(!c._cache.has("cheap:{}"), "wrong Content-Type is not cached as success");
  }

  {
    const { c, paid } = mk(valid, { contentType: "text/json" });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /Content-Type was not application\/json/.test(e.message) && paid() === 1,
      "text/json is not application/json");
    ok(!c._cache.has("cheap:{}"), "text/json is not cached as success");
  }

  {
    const { c, paid } = mk(valid, { contentType: "application/ld+json" });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /Content-Type was not application\/json/.test(e.message) && paid() === 1,
      "application/ld+json is not application/json");
    ok(!c._cache.has("cheap:{}"), "JSON-compatible suffix types are not cached as success");
  }

  {
    const { c, paid } = mk(valid, { raw: "{not-json", contentType: "text/plain" });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /Content-Type was not application\/json/.test(e.message) && !/not valid JSON/.test(e.message),
      "wrong Content-Type fails on media type before JSON parse");
    ok(paid() === 1 && c.spendingSummary().dailyUsd === 0.01 && !c._cache.has("cheap:{}"),
      "media-type rejection before parse retains spend and is not cached");
  }

  {
    const { c, paid } = mk(valid, { contentType: "application/json; charset=utf-8" });
    const out = await c.call("cheap");
    ok(out && out.data && out.data.value === 42 && paid() === 1,
      "parameterized application/json; charset=utf-8 is accepted");
  }

  {
    const { c, paid } = mk(valid, { contentType: "application/json; charset=\"utf-8\"" });
    const out = await c.call("cheap");
    ok(out && out.data && out.data.value === 42 && paid() === 1, "quoted charset parameter is accepted");
  }

  {
    const { c, paid } = mk(valid, { contentType: "Application/JSON" });
    const out = await c.call("cheap");
    ok(out && out.data && out.data.value === 42 && paid() === 1,
      "case-insensitive Application/JSON is accepted");
  }

  {
    const { c, paid } = mk(valid, { contentType: "APPLICATION/JSON; Charset=UTF-8" });
    const out = await c.call("cheap");
    ok(out && out.data && out.data.value === 42 && paid() === 1,
      "case-insensitive type with charset parameter is accepted");
  }

  {
    let paid = 0;
    const body = { ok: true };
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: true,
      fetch: async () => { paid++; return { ok: true, status: 200, json: async () => body }; },
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
    const out = await c.call("cheap");
    ok(out === body && paid === 1, "no-contract path still uses response.json() without a Body polyfill");
    ok(c.spendingSummary().dailyUsd === 0.01, "no-contract successful paid JSON still records settled spend");
    const cached = await c.call("cheap");
    ok(cached === out && paid === 1, "no-contract successful paid JSON remains cacheable");
  }

  {
    let paid = 0;
    const body = { ok: true };
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: true,
      fetch: async () => {
        paid++;
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "text/plain" } });
      },
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
    const out = await c.call("cheap");
    ok(out && out.ok === true && paid === 1, "no-contract path does not enforce JSON Content-Type");
    ok(c.spendingSummary().dailyUsd === 0.01, "no-contract text/plain JSON still records settled spend");
  }

  {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: true,
      fetch: async () => { paid++; return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } }; },
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && paid === 1, "no-contract malformed JSON after HTTP 200 still fails");
    ok(c.spendingSummary().dailyUsd === 0.01, "no-contract malformed JSON after HTTP 200 retains settled spend");
    ok(!c._cache.has("cheap:{}"), "no-contract malformed JSON is not cached");
  }

  {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: false,
      fetch: async () => { paid++; return { ok: false, status: 502 }; },
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      outputSchema,
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /HTTP 502/.test(e.message) && paid === 1, "non-OK HTTP still goes through payFetch");
    ok(c.spendingSummary().dailyUsd === 0, "non-OK HTTP still releases spend reservation");
  }

  const CONTRACT_CACHE_RE = /#output-contract\/v1\/[0-9a-f]{64}$/;
  const contractCacheKeys = (client) => [...(client._cache?.keys() || [])].filter((k) => CONTRACT_CACHE_RE.test(k));
  const outputContractIdentityDigest = (contract) => createHash("sha256").update(JSON.stringify({
    maxResponseBytes: Number(contract.maxResponseBytes),
    mediaType: String(contract.mediaType || "").split(";", 1)[0].trim().toLowerCase(),
    requiredFields: [...new Set((contract.requiredFields || []).map((f) => String(f).trim()).filter(Boolean))].sort(),
    schemaDigest: String(contract.schemaDigest || "").toLowerCase(),
  }), "utf8").digest("hex");
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
    const compact = JSON.stringify(valid);
    const padded = compact + " ".repeat(64);
    const small = Buffer.byteLength(compact);
    const bodies = [];
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: true,
      fetch: async () => {
        paid++;
        const spec = bodies.shift();
        return new Response(spec.raw, { status: 200, headers: { "content-type": spec.type } });
      },
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);

    bodies.push({ raw: padded, type: "text/plain" });
    const uncontracted = await c.call("cheap");
    ok(uncontracted && uncontracted.data && uncontracted.data.value === 42 && paid === 1,
      "no-contract padded text/plain caches under legacy behavior");
    ok(c._cache.has("cheap:{}") && contractCacheKeys(c).length === 0,
      "legacy key is used; no contract-qualified entry yet");

    bodies.push({ raw: padded, type: "text/plain" });
    let e = null;
    try {
      await c.call("cheap", {}, {
        outputSchema,
        requiredFields: ["data.value", "data.source"],
        maxResponseBytes: small,
      });
    } catch (err) { e = err; }
    ok(paid === 2, "strict JSON contract with a small wire limit does not reuse the uncontracted cache");
    ok(e && /Content-Type was not application\/json/.test(e.message),
      "second fetch is evaluated under the contracted MIME gate");
    ok(c.spendingSummary().dailyUsd === 0.02, "both paid successes record settled spend");
    ok(c._cache.has("cheap:{}") && contractCacheKeys(c).length === 0,
      "rejected contracted delivery creates no contract-qualified cache entry");

    bodies.push({ raw: compact, type: "application/json" });
    const contracted = await c.call("cheap", {}, {
      outputSchema,
      requiredFields: ["data.value", "data.source"],
      maxResponseBytes: small,
    });
    ok(contracted && contracted.data && contracted.data.value === 42 && paid === 3,
      "a later valid contracted JSON response is fetched and accepted");
  }

  {
    const { c, paid } = mk(valid, { maxResponseBytes: 100000 });
    const compact = JSON.stringify(valid);
    await c.call("cheap");
    ok(paid() === 1, "large maxResponseBytes caches under its identity");
    const again = await c.call("cheap", {}, { maxResponseBytes: Buffer.byteLength(compact) });
    ok(again && again.data && again.data.value === 42 && paid() === 2,
      "a smaller maxResponseBytes does not hit a larger-ceiling cache entry");
  }

  {
    const { c, paid } = mk(valid);
    await c.call("cheap");
    const other = await c.call("cheap", {}, { outputSchema: outputSchemaAlt });
    ok(other && other.data && other.data.value === 42 && paid() === 2, "a different schema digest cannot cross-hit");
    const fewerFields = await c.call("cheap", {}, { requiredFields: ["data.value"] });
    ok(fewerFields && fewerFields.data && fewerFields.data.value === 42 && paid() === 3,
      "different requiredFields cannot cross-hit");
  }

  {
    const policy = await import(require.resolve("agent-payment-policy"));
    const inspected = policy.inspectOutputSchema({
      schema: outputSchema,
      requiredFields: ["data.value", "data.source"],
    });
    const { c, paid } = mk(valid);
    const out = await c.call("cheap");
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
    ok(stored && stored.endsWith(jsonDigest), "stored cache digest matches the canonical application/json identity");
    ok(jsonDigest !== plainDigest, "media type is part of the cache identity");
    c._cache.set(`cheap:{}#output-contract/v1/${plainDigest}`, { data: { value: 99, source: "https://evil.example/" } });
    const hit = await c.call("cheap");
    ok(hit === out && paid() === 1 && hit.data.value === 42,
      "a different media-type cache entry cannot satisfy application/json");
  }

  {
    const { c, paid } = mk(valid);
    const first = await c.call("cheap", {}, { requiredFields: ["data.source", "data.value"] });
    const second = await c.call("cheap", {}, { requiredFields: ["data.value", "data.source"] });
    ok(first === second && paid() === 1,
      "identical normalized requiredFields hit the same contract-qualified cache entry");
  }

  {
    const { c, paid } = mk({ data: { value: "42", source: "https://example.com/source" } });
    let e = null; try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /JSON Schema validation/.test(e.message) && paid() === 1, "schema-invalid contracted response still paid");
    ok(c.spendingSummary().dailyUsd === 0.01 && contractCacheKeys(c).length === 0,
      "schema-invalid contracted response retains spend and writes no contract-qualified cache");
  }

  {
    const { c, paid } = mk(valid);
    await c.call("cheap");
    const before = paid();
    let e = null; try { await c.call("cheap", {}, { outputSchema: false }); } catch (err) { e = err; }
    ok(e && /outputSchema/.test(e.message) && paid() === before,
      "invalid per-call outputSchema:false fails before any cache read or pay");
  }

  {
    let constructed = null;
    try {
      constructed = new Agent402({ fetch: async () => jsonResponse(valid), outputSchema: false });
    } catch (err) {
      constructed = err;
    }
    ok(constructed instanceof Error && /outputSchema/.test(constructed.message),
      "invalid constructor outputSchema fails before any cache or pay");
  }

  {
    let paid = 0;
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: true,
      fetch: async () => { paid++; return jsonResponse(valid); },
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      outputSchema,
      requiredFields: ["data.value", "data.source"],
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);

    const first = await c.call("cheap");
    ok(first && first.data && first.data.value === 42 && paid === 1,
      "paid strict response caches a nested numeric field");
    ok(contractCacheKeys(c).length === 1 && !c._cache.has("cheap:{}"),
      "success is stored only under the complete contract-qualified namespace");
    const storedKey = contractCacheKeys(c)[0];
    first.data.value = "42";
    ok(c.spendingSummary().dailyUsd === 0.01, "spend is one payment after the valid cache fill");

    let e = null;
    try { await c.call("cheap"); } catch (err) { e = err; }
    ok(e && /buyer contract/.test(e.message) && /JSON Schema validation/.test(e.message),
      "identical contracted call throws the controlled contract error after mutation");
    ok(paid === 1, "mutated cache hit fails before pay/fetch");
    ok(c.spendingSummary().dailyUsd === 0.01, "spend remains one payment before refetch");
    ok(!c._cache.has(storedKey) && contractCacheKeys(c).length === 0,
      "the exact contract-qualified cache entry is evicted");

    const again = await c.call("cheap");
    ok(again && again.data && again.data.value === 42 && paid === 2,
      "later identical call refetches a valid response");
    ok(c.spendingSummary().dailyUsd === 0.02,
      "spend increments only on the later successful network call");
    ok(contractCacheKeys(c).length === 1 && c._cache.has(storedKey),
      "valid refetch can cache under the same contract-qualified key");
  }

  {
    let paid = 0;
    const body = { data: { value: 42, source: "https://example.com/source" } };
    const c = new Agent402({
      baseUrl: "https://seller.example", cache: true,
      fetch: async () => { paid++; return { ok: true, status: 200, json: async () => body }; },
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    });
    c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
    const out = await c.call("cheap");
    out.data.value = "42";
    const hit = await c.call("cheap");
    ok(hit === out && hit.data.value === "42" && paid === 1,
      "legacy no-contract cache hits still return the stored object without revalidation");
    ok(c._cache.has("cheap:{}") && contractCacheKeys(c).length === 0,
      "legacy no-contract cache key and namespace are unchanged");
  }
}

// Offline: every request the SDK issues carries its own User-Agent product
// token (agent402-client/<version>) — the plain-fetch path AND the x402
// payFetch path that settles real payments — so sellers can attribute paid
// traffic to this SDK (payment_settled.clientUa server-side).
{
  const uas = [];
  const grab = async (_url, init) => { uas.push(init?.headers?.["User-Agent"] ?? null); return { ok: true, json: async () => ({ endpoints: [] }) }; };
  const c = new Agent402({ baseUrl: "https://seller.example", cache: false, fetch: grab, fetchImpl: grab });
  await c._loadCatalog(); // plain fetch path
  c._catalog = new Map([["cheap", { method: "POST", path: "/api/cheap", computePayable: false, price: "$0.01" }]]);
  await c.call("cheap"); // payFetch path
  ok(uas.length >= 2 && uas.every((u) => /^agent402-client\/\d+\.\d+\.\d+$/.test(u || "")),
    `every request carries the agent402-client UA product token (got ${JSON.stringify(uas)})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/api/pow`)).ok) break; } catch {} await sleep(500); }
  const a = new Agent402({ baseUrl: `http://localhost:${PORT}` });

  // 1. find() resolves a task to the right tool.
  const matches = await a.find("hash text with sha256");
  ok(matches.some((m) => m.slug === "hash"), `find() returns the hash tool (got ${matches.map((m) => m.slug).slice(0, 3).join(",")})`);

  // 2. call() auto-solves the proof-of-work on a paywalled free tool.
  const out = await a.call("hash", { text: "hello world", algo: "sha256" });
  ok(out.hex && out.hex.slice(0, 8) === "b94d27b9", `call() auto-pays via PoW and returns the result (got ${out.hex?.slice(0, 8)})`);

  // 3. second identical call is served from cache (same reference, no re-solve).
  const out2 = await a.call("hash", { text: "hello world", algo: "sha256" });
  ok(out2 === out, "identical call is served from cache");

  // 4. cache can be bypassed.
  const out3 = await a.call("hash", { text: "hello world", algo: "sha256" }, { cache: false });
  ok(out3 !== out && out3.hex === out.hex, "cache:false re-fetches but returns the same value");

  // 5. solvePow() produces a valid nonce for a difficulty.
  const sol = Agent402.solvePow({ challenge: "abc", difficulty: 8, token: "t" });
  const nonce = sol.split(":").pop();
  const lz = (b) => { let n = 0; for (const x of b) { if (!x) { n += 8; continue; } n += Math.clz32(x) - 24; break; } return n; };
  ok(lz(createHash("sha256").update(`abc:${nonce}`).digest()) >= 8, "solvePow finds a nonce meeting the difficulty");

  // 6. unknown slug is a clear error.
  let threw = false; try { await a.call("definitely-not-a-tool", {}); } catch { threw = true; }
  ok(threw, "unknown slug throws");

  // 7. findWorkflows() surfaces multi-tool skill packs for task-shaped queries.
  const packs = await a.findWorkflows("security audit");
  ok(packs.some((p) => p.slug === "security-audit"), `findWorkflows("security audit") returns the security-audit pack (got ${packs.map((p) => p.slug).slice(0, 3).join(",")})`);

  // 8. getWorkflowPrompt() returns rendered messages with args substituted in.
  const rendered = await a.getWorkflowPrompt("security-audit", { domain: "stripe.com" });
  const promptText = rendered.messages?.[0]?.content?.text ?? "";
  ok(promptText.includes("stripe.com") && !promptText.includes("{{domain}}"), "getWorkflowPrompt substitutes args into the rendered prompt");

  // 9. topSellers() proxies /api/leaderboard with the right envelope. CI runs
  // before the first chain scan finishes, so results may be empty — but the
  // envelope shape and sort/include echo must be correct regardless.
  const sellers = await a.topSellers({ limit: 5, sort: "calls", include: "all" });
  ok(sellers.sort === "calls" && sellers.include === "all", `topSellers echoes sort+include (got sort=${sellers.sort}, include=${sellers.include})`);
  ok(Array.isArray(sellers.results) && sellers.results.length <= 5, `topSellers honors limit (got ${sellers.results?.length} rows)`);
  ok(typeof sellers.source === "string" && sellers.source.endsWith("/api/leaderboard"), "topSellers links to /api/leaderboard");

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
