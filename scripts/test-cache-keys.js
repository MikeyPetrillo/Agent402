// The response cache answers a repeat call from Redis, so its key must change
// whenever the answer would. A key built from a list of field names can miss
// an input the tool reads, and then calls with different inputs share one
// entry.
//
// 1. Each cached kit route's keyFields name inputs its inputSchema declares,
//    and every declared input is a keyField.
// 2. cacheKeyFor separates any two calls that differ in any field (declared or
//    not), keeps case, and does not collide on a shared long prefix.
// Offline: imports the kits, no server, no Redis.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CACHEABLE_ROUTES, cacheKeyFor } from "../src/cache.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log("ok - " + msg); else { failed++; console.log("FAIL - " + msg); } };

// Routes the server defines itself rather than through a kit, and inputs a
// handler reads without declaring them; each with where it is read.
const SERVER_ROUTES = new Set(["/api/find", "/api/route"]); // src/server.js, each with its own cache read
const UNDECLARED_READS = { "/api/search": ["includeDomains", "excludeDomains"] }; // src/tools/search.js domainFilter

// Import only the kit files that declare a cached route (some files in
// src/tools are worker entry points that cannot be imported).
const toolDir = path.join(root, "src/tools");
const kitFiles = fs.readdirSync(toolDir).filter((f) => f.endsWith(".js")).filter((f) => {
  const src = fs.readFileSync(path.join(toolDir, f), "utf8");
  return Object.keys(CACHEABLE_ROUTES).some((p) => src.includes(`"GET ${p}"`));
});
const byPath = new Map();
for (const f of kitFiles) {
  const m = await import(path.join(toolDir, f));
  for (const v of Object.values(m)) {
    if (!Array.isArray(v)) continue;
    for (const t of v) if (t && typeof t.route === "string") byPath.set(t.route.split(" ").pop(), t);
  }
}

for (const [p, policy] of Object.entries(CACHEABLE_ROUTES)) {
  if (SERVER_ROUTES.has(p)) continue;
  const tool = byPath.get(p);
  ok(Boolean(tool), `${p}: a kit tool serves the cached route`);
  if (!tool) continue;
  const declared = Object.keys(tool.discovery?.inputSchema?.properties || {});
  const allowed = new Set([...declared, ...(UNDECLARED_READS[p] || [])]);
  const unknown = policy.keyFields.filter((f) => !allowed.has(f));
  ok(unknown.length === 0, `${p}: every keyField is an input the tool reads${unknown.length ? ` (not inputs: ${unknown.join(", ")})` : ""}`);
  const unkeyed = declared.filter((f) => !policy.keyFields.includes(f));
  ok(unkeyed.length === 0, `${p}: every declared input is a keyField${unkeyed.length ? ` (missing: ${unkeyed.join(", ")})` : ""}`);
}

const k = (input, fields = []) => cacheKeyFor("/api/x", input, fields);
ok(k({ q: "Eiffel Tower" }, ["address"]) !== k({ q: "Statue of Liberty" }, ["address"]), "a field outside keyFields still changes the key");
ok(k({ q: "a", limit: 1 }) === k({ limit: 1, q: "a" }), "field order does not change the key");
ok(k({ q: "a", limit: "" }) === k({ q: "a" }), "an empty field reads as absent");
ok(k({ address: "So1anaAddrXyz" }) !== k({ address: "so1anaaddrxyz" }), "case is kept (base58 addresses are case-sensitive)");
const long = "https://example.com/" + "a".repeat(300);
ok(k({ url: long + "1" }) !== k({ url: long + "2" }), "two long values sharing a prefix get different keys");
ok(k({ ids: ["a", "b"] }) !== k({ ids: ["a", "c"] }), "array values are part of the key");
ok(cacheKeyFor("/api/x", { q: "a" }, []) !== cacheKeyFor("/api/y", { q: "a" }, []), "the path is part of the key");

// 3. A route whose answer is anchored on the clock (a default date of
//    tomorrow, a series that starts today or this hour at the place) keys on
//    the clock slot, so an entry written before a day or hour change never
//    answers a call made after it. Every UTC offset in use is a multiple of
//    15 minutes, so every local midnight and hour change is a slot boundary.
import { targetDate } from "../src/tools/weather-probability-kit.js";
const CLOCK_ANCHORED = ["/api/weather-probability", "/api/weather-daily", "/api/weather-hourly"];
const at = (iso) => Date.parse(iso);
const keyAt = (p, input, now) => cacheKeyFor(p, input, CACHEABLE_ROUTES[p].keyFields, { clockSlotSeconds: CACHEABLE_ROUTES[p].clockSlotSeconds, now });
for (const p of CLOCK_ANCHORED) {
  const slot = CACHEABLE_ROUTES[p]?.clockSlotSeconds;
  ok(Number.isInteger(slot) && slot > 0 && 900 % slot === 0, `${p}: declares a clock slot that divides 15 minutes (${slot})`);
}
const probIn = { lat: 41.8781, lon: -87.6298, variable: "temperature_max", op: ">=", value: 40 };
const beforeUtcMidnight = at("2026-11-17T23:59:30Z"), afterUtcMidnight = at("2026-11-18T00:00:30Z");
ok(targetDate(undefined, beforeUtcMidnight) !== targetDate(undefined, afterUtcMidnight), "the default probability date moves at UTC midnight (fixture check)");
ok(keyAt("/api/weather-probability", probIn, beforeUtcMidnight) !== keyAt("/api/weather-probability", probIn, afterUtcMidnight),
  "a probability call with no date before UTC midnight and one after it get different keys");
ok(keyAt("/api/weather-probability", probIn, at("2026-11-17T23:46:00Z")) === keyAt("/api/weather-probability", probIn, at("2026-11-17T23:59:00Z")),
  "two probability calls inside one slot share a key");
// Local midnight at UTC+05:45 falls at 18:15Z.
const dailyIn = { place: "Kathmandu", days: 3 };
ok(keyAt("/api/weather-daily", dailyIn, at("2026-11-17T18:14:00Z")) !== keyAt("/api/weather-daily", dailyIn, at("2026-11-17T18:16:00Z")),
  "a daily forecast before and after local midnight at a quarter-hour offset gets different keys");
ok(keyAt("/api/weather-hourly", { lat: 1, lon: 2 }, at("2026-11-17T09:59:00Z")) !== keyAt("/api/weather-hourly", { lat: 1, lon: 2 }, at("2026-11-17T10:01:00Z")),
  "an hourly forecast before and after the hour gets different keys");
ok(cacheKeyFor("/api/x", { q: "a" }, [], { now: at("2026-11-17T00:00:00Z") }) === cacheKeyFor("/api/x", { q: "a" }, [], { now: at("2026-11-18T00:00:00Z") }),
  "a route without a clock slot keys on its input only");
// The server builds both cache reads through the policy's slot.
const serverSrc = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
const keyCalls = serverSrc.match(/cacheKeyFor\([^;]*\)/g) || [];
ok(keyCalls.length >= 2 && keyCalls.every((c) => /clockSlotSeconds/.test(c)), `every server cache key passes the policy's clock slot (${keyCalls.length} calls)`);

import { cacheTtlFor } from "../src/cache.js";
// A route with a backup provider declares fallbackSource and fallbackTtl.
const geoPolicy = { ttl: 86400, keyFields: ["q"], fallbackSource: "photon", fallbackTtl: 600 };
ok(cacheTtlFor(geoPolicy, { source: "photon.komoot.io (ODbL)" }) === geoPolicy.fallbackTtl && geoPolicy.fallbackTtl < geoPolicy.ttl, "a backup-geocoder answer is kept for the shorter fallbackTtl");
ok(cacheTtlFor(geoPolicy, { source: "primary.example (ODbL)" }) === geoPolicy.ttl, "a primary answer keeps the route ttl");
ok(cacheTtlFor(CACHEABLE_ROUTES["/api/fx-rate"], { source: "photon" }) === CACHEABLE_ROUTES["/api/fx-rate"].ttl, "a route without a fallback policy keeps its ttl");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
