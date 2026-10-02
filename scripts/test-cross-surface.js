#!/usr/bin/env node
// Cross-surface pairs: where two surfaces describe the same thing, they must
// agree. Built 2026-09-06 after an outside buyer's last two finds were both of
// this shape - the free /api/wishes beacon said "1 qualified cluster" and the
// paid radar could not say which row that was; the route rows carried a tier
// name a buyer read as "callable now" while the index said otherwise. Every
// per-surface test drives one surface and asserts its own shape; nothing had
// ever read two of them side by side.
//
// Pairs (all free surfaces, FREE_MODE boot or TARGET_URL):
//   1. /health.toolCount == /api/pricing endpoints == priced /openapi.json ops
//   2. /api/pricing <-> /openapi.json: same method+path, same x-price, the MPP
//      offer amount is the price in micro-USD, and every priced op maps back;
//      and each operation's own query example validates against the type it
//      publishes beside it
//   3. /api/pricing <-> /.well-known/x402 resources (one URL per paid route;
//      a route absent from the manifest is named, with its reason, or fails)
//   4. /api/wishes beacon <-> /api/demand-radar: qualifiedClusters, threshold
//      and the qualification bar are the same numbers, and the rows flagged
//      qualified add up to the beacon's count
//   5. /v1/models <-> /api/pricing: every advertised endpoint exists at the
//      advertised price; every chat tier route is advertised by some model;
//      each tier's defaultModel is itself a listed model of that tier
//   6. /api/route local rows and /api/find results <-> /api/pricing: slug,
//      method, route and price agree; find's example and required list are
//      the OpenAPI document's
//
// Mismatches are FATAL: a disagreement between two of our own surfaces is
// never an upstream's fault.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getFreePort } from "./lib/free-port.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

// Routes deliberately absent from the /.well-known/x402 manifest, each with
// its reason. Anything else missing fails.
const MANIFEST_EXEMPT = new Map([]);

async function bootServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.join(HERE, ".."),
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", SOLANA_LEADERBOARD: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`; const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return { base, child }; } catch { /* booting */ }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGKILL"); throw new Error(`no /health in 120s\n${log.slice(-2000)}`);
}
const getJson = async (base, p) => { const r = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(60_000) }); if (!r.ok) throw new Error(`${p} -> ${r.status}`); return r.json(); };
const priceNum = (s) => Number(String(s).replace(/[^0-9.]/g, ""));

async function main() {
  let base = process.env.TARGET_URL?.replace(/\/+$/, "") || "";
  let child = null;
  if (!base) ({ base, child } = await bootServer());
  try {
    const [health, pricing, openapi, manifest, wishes, models] = await Promise.all([
      getJson(base, "/health"), getJson(base, "/api/pricing"), getJson(base, "/openapi.json"),
      getJson(base, "/.well-known/x402"), getJson(base, "/api/wishes"), getJson(base, "/v1/models"),
    ]);
    const eps = pricing.endpoints;
    const byKey = new Map(eps.map((e) => [`${e.method} ${e.path}`, e]));
    const byPath = new Map(); for (const e of eps) byPath.set(e.path, e);

    // ---- 1. counts
    const pricedOps = [];
    for (const [p, ops] of Object.entries(openapi.paths)) for (const [m, op] of Object.entries(ops)) if (op && op["x-price"] !== undefined) pricedOps.push({ method: m.toUpperCase(), path: p, op });
    ok(health.meta?.toolCount === eps.length, `/health toolCount (${health.meta?.toolCount}) == /api/pricing endpoints (${eps.length})`);
    ok(pricedOps.length === eps.length, `priced /openapi.json operations (${pricedOps.length}) == /api/pricing endpoints (${eps.length})`);

    // ---- 2. pricing <-> openapi
    let missingOp = [], priceDrift = [], offerDrift = [];
    for (const e of eps) {
      const op = openapi.paths[e.path]?.[e.method.toLowerCase()];
      if (!op) { missingOp.push(`${e.method} ${e.path}`); continue; }
      if (op["x-price"] !== e.price) priceDrift.push(`${e.path}: openapi ${op["x-price"]} vs pricing ${e.price}`);
      const info = op["x-payment-info"];
      if (info?.price?.amount !== undefined && !near(info.price.amount, priceNum(e.price))) priceDrift.push(`${e.path}: x-payment-info ${info.price.amount} vs ${e.price}`);
      const offer = info?.offers?.find((o) => o.method === "evm");
      // A route priced per request publishes a range (price.mode "dynamic")
      // whose floor is the list price, and every offer amount is null - the
      // live 402 quotes the body. A fixed route's offer is its price.
      if (info?.price?.mode === "dynamic") {
        if (!near(info.price.min, priceNum(e.price))) priceDrift.push(`${e.path}: dynamic min ${info.price.min} vs ${e.price}`);
        if (!(Number(info.price.max) >= Number(info.price.min))) priceDrift.push(`${e.path}: dynamic max ${info.price.max} under min ${info.price.min}`);
        for (const o of info.offers || []) if (o.amount !== null) offerDrift.push(`${e.path}: dynamic route carries a fixed ${o.method} offer ${o.amount}`);
      } else if (offer && !near(Number(offer.amount) / 1e6, priceNum(e.price))) offerDrift.push(`${e.path}: MPP offer ${offer.amount} micro vs ${e.price}`);
    }
    ok(missingOp.length === 0, `every pricing endpoint is an OpenAPI operation${missingOp.length ? ` - missing: ${missingOp.slice(0, 5).join(", ")}` : ""}`);
    ok(priceDrift.length === 0, `x-price / x-payment-info agree with /api/pricing on every route${priceDrift.length ? ` - ${priceDrift.slice(0, 5).join("; ")}` : ""}`);
    ok(offerDrift.length === 0, `the MPP evm offer amount is the route price in micro-USD (null on a dynamic route)${offerDrift.length ? ` - ${offerDrift.slice(0, 5).join("; ")}` : ""}`);
    const orphanOps = pricedOps.filter((o) => !byKey.has(`${o.method} ${o.path}`)).map((o) => `${o.method} ${o.path}`);
    ok(orphanOps.length === 0, `every priced OpenAPI operation is a pricing endpoint${orphanOps.length ? ` - orphans: ${orphanOps.slice(0, 5).join(", ")}` : ""}`);

    // ---- 2b. an operation's own example <-> the type it publishes beside it.
    // One reader copies the example, another generates a client from the type,
    // and a mismatch sends the two to different calls. Found on a GET route
    // whose parameter declared a whole number and published "string" next to a
    // numeric example, which had been true of several routes for months.
    const exampleTypeDrift = [];
    for (const [p, ops] of Object.entries(openapi.paths)) {
      for (const [m, op] of Object.entries(ops)) {
        for (const prm of op?.parameters ?? []) {
          if (prm.in !== "query" || prm.example === undefined) continue;
          const t = prm.schema?.type, ex = prm.example;
          const typeOk = t === "string" ? typeof ex === "string"
            : t === "integer" ? Number.isInteger(ex)
            : t === "number" ? typeof ex === "number"
            : t === "boolean" ? typeof ex === "boolean" : false;
          if (!typeOk) exampleTypeDrift.push(`${m.toUpperCase()} ${p}?${prm.name}: ${t} vs ${JSON.stringify(ex)}`);
        }
      }
    }
    ok(exampleTypeDrift.length === 0, `every documented query example validates against its declared type${exampleTypeDrift.length ? ` - ${exampleTypeDrift.slice(0, 5).join("; ")}` : ""}`);

    // ---- 3. pricing <-> manifest
    const resources = (manifest.resources || []).map((r) => (typeof r === "string" ? r : r?.url || r?.resource || "")).map((u) => { try { return new URL(u).pathname; } catch { return String(u); } });
    const resSet = new Set(resources);
    const notListed = [...new Set(eps.map((e) => e.path))].filter((p) => !resSet.has(p));
    const unexplained = notListed.filter((p) => !MANIFEST_EXEMPT.has(p));
    ok(unexplained.length === 0, `every paid route is a /.well-known/x402 resource, or named as exempt with a reason${unexplained.length ? ` - not listed: ${unexplained.slice(0, 8).join(", ")}` : ""}`);
    for (const [p, why] of MANIFEST_EXEMPT) ok(byPath.has(p) && !resSet.has(p), `exemption still accurate: ${p} exists and is absent from the manifest (${why})`);
    ok(resSet.size === new Set(eps.map((e) => e.path)).size, `manifest lists one resource per distinct paid path (${resSet.size} vs ${new Set(eps.map((e) => e.path)).size})`);
    const unknownRes = resources.filter((p) => !byPath.has(p));
    ok(unknownRes.length === 0, `every manifest resource is a live paid route${unknownRes.length ? ` - stale: ${unknownRes.slice(0, 5).join(", ")}` : ""}`);

    // ---- 4. wishes beacon <-> demand-radar
    const radar = await getJson(base, "/api/demand-radar?limit=50&minCount=1");
    ok(radar.qualifiedClusters === wishes.qualifiedClusters, `radar.qualifiedClusters (${radar.qualifiedClusters}) == beacon qualifiedClusters (${wishes.qualifiedClusters})`);
    ok(radar.buildThreshold === wishes.threshold, `radar.buildThreshold (${radar.buildThreshold}) == beacon threshold (${wishes.threshold})`);
    ok(radar.qualifyMinCallers === wishes.qualifyMinCallers && radar.qualifyMinSpanHours === wishes.qualifyMinSpanHours, "radar and beacon state the same qualification bar");
    ok(radar.distinctClusters === wishes.distinctClusters && radar.totalWishes === wishes.totalWishes, `radar totals (${radar.distinctClusters}/${radar.totalWishes}) == beacon totals (${wishes.distinctClusters}/${wishes.totalWishes})`);
    const flagged = radar.radar.filter((r) => r.qualified === true).length;
    ok(flagged === Math.min(radar.qualifiedClusters, 50), `rows flagged qualified (${flagged}) add up to the beacon's count (${radar.qualifiedClusters}, page 50)`);
    const onlyQ = await getJson(base, "/api/demand-radar?limit=50&qualifiedOnly=true");
    ok(onlyQ.matchedClusters === radar.qualifiedClusters && onlyQ.radar.every((r) => r.qualified), `qualifiedOnly returns exactly the qualified rows (${onlyQ.matchedClusters})`);

    // ---- 5. /v1/models <-> pricing
    const modelRows = models.data || [];
    const tierPaths = new Set(eps.map((e) => e.path).filter((p) => /^\/v1\/.*(chat\/completions|messages|responses)$/.test(p)));
    let badEndpoint = [], badPrice = [];
    for (const m of modelRows) {
      const x = m.x402 || {};
      for (const k of ["endpoint", "meteredEndpoint", "meteredMessagesEndpoint", "meteredResponsesEndpoint"]) if (x[k] && !byPath.has(x[k])) badEndpoint.push(`${m.id}: ${k}=${x[k]}`);
      const ep = byPath.get(x.endpoint);
      if (ep && x.priceUsd !== undefined && !near(x.priceUsd, priceNum(ep.price))) badPrice.push(`${m.id}: ${x.priceUsd} vs ${ep.price} at ${x.endpoint}`);
      const mep = byPath.get(x.meteredEndpoint);
      if (mep && x.meteredFromUsd !== undefined && !near(x.meteredFromUsd, priceNum(mep.price))) badPrice.push(`${m.id}: meteredFromUsd ${x.meteredFromUsd} vs ${mep.price}`);
    }
    ok(badEndpoint.length === 0, `every endpoint /v1/models advertises is a pricing route${badEndpoint.length ? ` - ${badEndpoint.slice(0, 4).join("; ")}` : ""}`);
    ok(badPrice.length === 0, `every /v1/models price matches /api/pricing${badPrice.length ? ` - ${badPrice.slice(0, 4).join("; ")}` : ""}`);
    const advertised = new Set(modelRows.map((m) => m.x402?.endpoint).filter(Boolean));
    // The metered tier lists no models of its own (its prefixes are the union
    // of the flat tiers'); every flat chat model carries meteredEndpoint instead.
    const meteredPath = byPath.has("/v1/metered/chat/completions") ? "/v1/metered/chat/completions" : null;
    const chatTierPaths = [...tierPaths].filter((p) => p.endsWith("chat/completions") && p !== meteredPath);
    const unadvertised = chatTierPaths.filter((p) => !advertised.has(p));
    ok(unadvertised.length === 0, `every flat chat tier route is advertised by at least one model${unadvertised.length ? ` - ${unadvertised.join(", ")}` : ""}`);
    if (meteredPath) {
      // Router tiers (auto, grounded) pick the model themselves and carry no
      // metered twin; the flat tiers do.
      const chatModels = modelRows.filter((m) => /chat\/completions$/.test(m.x402?.endpoint || "") && !/^\/v1\/(auto|grounded)\//.test(m.x402?.endpoint || ""));
      const noMetered = chatModels.filter((m) => m.x402?.meteredEndpoint !== meteredPath).map((m) => `${m.id}@${m.x402?.tier}`);
      ok(noMetered.length === 0, `every flat chat model advertises the metered route${noMetered.length ? ` - ${noMetered.slice(0, 4).join(", ")}` : ""}`);
    }
    // A model id appears once per tier that admits it, so a default must be
    // listed under ITS tier, not merely somewhere.
    const tiersOf = new Map(); for (const m of modelRows) { if (!tiersOf.has(m.id)) tiersOf.set(m.id, new Set()); tiersOf.get(m.id).add(m.x402?.tier); }
    const defaults = new Map(); for (const m of modelRows) if (m.x402?.defaultModel) defaults.set(m.x402.tier, m.x402.defaultModel);
    const badDefault = [...defaults].filter(([tier, dm]) => !tiersOf.get(dm)?.has(tier)).map(([t, d]) => `${t}: ${d}${tiersOf.has(d) ? ` (listed under ${[...tiersOf.get(d)].join("/")})` : " (not listed)"}`);
    ok(badDefault.length === 0, `each tier's defaultModel is listed under that tier${badDefault.length ? ` - ${badDefault.join("; ")}` : ""}`);

    // ---- 6. route + find <-> pricing + openapi (a deterministic sample of 40 slugs)
    const sample = eps.filter((_, i) => i % Math.max(1, Math.floor(eps.length / 40)) === 0).slice(0, 40);
    let routeDrift = [], findDrift = [], findMissing = 0, routeMissing = 0;
    for (const e of sample) {
      const q = encodeURIComponent(e.slug.replace(/-/g, " "));
      const [route, find] = await Promise.all([getJson(base, `/api/route?q=${q}&top=10`), getJson(base, `/api/find?q=${q}`)]);
      const row = (route.results || []).find((r) => r.seller === "self" && r.slug === e.slug);
      if (!row) routeMissing++;
      else if (row.method !== e.method || row.route !== e.path || !near(row.priceUsd, priceNum(e.price))) routeDrift.push(`${e.slug}: route says ${row.method} ${row.route} $${row.priceUsd}, pricing ${e.method} ${e.path} ${e.price}`);
      const f = (find.results || []).find((r) => r.slug === e.slug);
      if (!f) findMissing++;
      else {
        if (f.route !== `${e.method} ${e.path}` || f.price !== e.price || !near(f.priceUsd, priceNum(e.price))) findDrift.push(`${e.slug}: find says ${f.route} ${f.price}, pricing ${e.method} ${e.path} ${e.price}`);
        const op = openapi.paths[e.path]?.[e.method.toLowerCase()];
        const docEx = op?.requestBody?.content?.["application/json"]?.example ?? Object.fromEntries((op?.parameters || []).filter((p) => p.example !== undefined).map((p) => [p.name, p.example]));
        const docReq = op?.requestBody?.content?.["application/json"]?.schema?.required ?? (op?.parameters || []).filter((p) => p.required).map((p) => p.name);
        // Key order is not a difference: a GET example is rebuilt from the
        // parameter list, whose order need not match the tool's own input.
        const canon = (v) => JSON.stringify(v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))) : v);
        if (canon(f.example ?? {}) !== canon(docEx ?? {})) findDrift.push(`${e.slug}: find example differs from the OpenAPI example`);
        if (JSON.stringify(f.required ?? []) !== JSON.stringify(docReq ?? [])) findDrift.push(`${e.slug}: find required ${JSON.stringify(f.required)} vs openapi ${JSON.stringify(docReq)}`);
      }
    }
    ok(routeMissing <= Math.ceil(sample.length * 0.1), `/api/route surfaces our own row for a tool's name (${sample.length - routeMissing} of ${sample.length} sampled; at most 10% may miss - lexical ranking, not a fault)`);
    ok(routeDrift.length === 0, `/api/route local rows carry pricing's method, path and price${routeDrift.length ? ` - ${routeDrift.slice(0, 4).join("; ")}` : ""}`);
    ok(findMissing <= Math.ceil(sample.length * 0.1), `/api/find surfaces the tool for its own name (${sample.length - findMissing} of ${sample.length} sampled; at most 10% may miss)`);
    ok(findDrift.length === 0, `/api/find rows carry pricing's route+price and OpenAPI's example+required${findDrift.length ? ` - ${findDrift.slice(0, 4).join("; ")}` : ""}`);
  } finally {
    if (child) child.kill("SIGTERM");
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
