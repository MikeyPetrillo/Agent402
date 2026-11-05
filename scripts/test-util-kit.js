// Exact-output tests for util-kit (geo-distance). Pure functions, no server needed.
// The other util tools were retired 2026-08-25 (zero external use in 30 days).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createHmac } from "node:crypto";
import { UTIL_TOOLS } from "../src/tools/util-kit.js";

const tool = (slug) => UTIL_TOOLS.find((t) => t.slug === slug);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (slug, input) => tool(slug).handler(input);
const b64urlDecode = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));


let r, threw = false;
// geo-distance: NYC -> LA (haversine, ~3936 km)
r = run("geo-distance", { from: { lat: 40.7128, lng: -74.006 }, to: { lat: 34.0522, lng: -118.2437 } });
ok(Math.abs(r.km - 3935.75) < 1 && Math.abs(r.miles - 2445.56) < 1, `geo-distance NYC->LA ~3936km (got ${r.km}km / ${r.miles}mi)`);
r = run("geo-distance", { from: { lat: 0, lng: 0 }, to: { lat: 0, lng: 0 } });
ok(r.km === 0, `geo-distance same point = 0`);
threw = false; try { run("geo-distance", { from: { lat: 99, lng: 0 }, to: { lat: 0, lng: 0 } }); } catch { threw = true; }
ok(threw, `geo-distance rejects out-of-range lat`);


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
