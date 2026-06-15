// Exact-output tests for util-kit (jwt-sign, uuid-v5, group-by, json-to-xml,
// geo-distance, color-contrast). Pure functions, no server needed.
import { createHmac } from "node:crypto";
import { UTIL_TOOLS } from "../src/tools/util-kit.js";

const tool = (slug) => UTIL_TOOLS.find((t) => t.slug === slug);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (slug, input) => tool(slug).handler(input);
const b64urlDecode = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

// jwt-sign: structure + payload round-trips + signature verifies + deterministic
let r = run("jwt-sign", { payload: { sub: "123", role: "admin" }, secret: "s3cr3t" });
const parts = r.token.split(".");
ok(parts.length === 3 && r.alg === "HS256", `jwt-sign returns 3-part HS256 token`);
ok(JSON.stringify(b64urlDecode(parts[1])) === JSON.stringify({ sub: "123", role: "admin" }), `jwt-sign payload round-trips`);
const expectSig = createHmac("sha256", "s3cr3t").update(`${parts[0]}.${parts[1]}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
ok(parts[2] === expectSig, `jwt-sign signature verifies against recomputed HMAC`);
ok(run("jwt-sign", { payload: { sub: "123", role: "admin" }, secret: "s3cr3t" }).token === r.token, `jwt-sign is deterministic`);
let threw = false; try { run("jwt-sign", { payload: { a: 1 }, secret: "x", alg: "RS256" }); } catch { threw = true; }
ok(threw, `jwt-sign rejects unsupported alg`);

// uuid-v5: standard DNS test vector + determinism
r = run("uuid-v5", { namespace: "dns", name: "example.com" });
ok(r.uuid === "cfbff0d1-9375-5685-968c-48ce8b15ae17", `uuid-v5 DNS "example.com" matches known vector (got ${r.uuid})`);
ok(r.version === 5, `uuid-v5 reports version 5`);
ok(run("uuid-v5", { namespace: "dns", name: "example.com" }).uuid === r.uuid, `uuid-v5 is deterministic`);

// group-by: sum aggregate + first-seen order + count-only
r = run("group-by", { data: [{ city: "NYC", n: 2 }, { city: "LA", n: 5 }, { city: "NYC", n: 3 }], by: "city", field: "n", op: "sum" });
ok(JSON.stringify(r.groups) === JSON.stringify([{ key: { city: "NYC" }, count: 2, sum: 5 }, { key: { city: "LA" }, count: 1, sum: 5 }]) && r.count === 2,
  `group-by sum + order (got ${JSON.stringify(r.groups)})`);
r = run("group-by", { data: [{ t: "a" }, { t: "b" }, { t: "a" }], by: "t" });
ok(r.groups[0].count === 2 && r.groups[1].count === 1 && !("sum" in r.groups[0]), `group-by count-only`);
threw = false; try { run("group-by", { data: [{ t: "a", n: "x" }], by: "t", field: "n", op: "sum" }); } catch { threw = true; }
ok(threw, `group-by rejects non-numeric aggregate field`);

// json-to-xml: nesting + escaping + arrays
r = run("json-to-xml", { data: { book: { title: "x" } } });
ok(r.xml === `<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <book>\n    <title>x</title>\n  </book>\n</root>`, `json-to-xml nesting (got ${JSON.stringify(r.xml)})`);
r = run("json-to-xml", { data: { v: "a & b < c" }, root: "doc" });
ok(r.xml.includes("<v>a &amp; b &lt; c</v>") && r.xml.includes("<doc>"), `json-to-xml escapes text + custom root`);
r = run("json-to-xml", { data: { tag: ["a", "b"] } });
ok(r.xml.includes("<tag>a</tag>\n  <tag>b</tag>"), `json-to-xml repeats array tag`);

// geo-distance: NYC -> LA (haversine, ~3936 km)
r = run("geo-distance", { from: { lat: 40.7128, lng: -74.006 }, to: { lat: 34.0522, lng: -118.2437 } });
ok(Math.abs(r.km - 3935.75) < 1 && Math.abs(r.miles - 2445.56) < 1, `geo-distance NYC->LA ~3936km (got ${r.km}km / ${r.miles}mi)`);
r = run("geo-distance", { from: { lat: 0, lng: 0 }, to: { lat: 0, lng: 0 } });
ok(r.km === 0, `geo-distance same point = 0`);
threw = false; try { run("geo-distance", { from: { lat: 99, lng: 0 }, to: { lat: 0, lng: 0 } }); } catch { threw = true; }
ok(threw, `geo-distance rejects out-of-range lat`);

// color-contrast: known WCAG ratios
r = run("color-contrast", { foreground: "#000000", background: "#ffffff" });
ok(r.ratio === 21 && r.AA.normal === true && r.AAA.normal === true, `color-contrast black/white = 21 (got ${r.ratio})`);
r = run("color-contrast", { foreground: "#777777", background: "#ffffff" });
ok(Math.abs(r.ratio - 4.48) < 0.05 && r.AA.normal === false && r.AA.large === true, `color-contrast #777/#fff ~4.48, fails AA-normal (got ${r.ratio})`);
r = run("color-contrast", { foreground: "#fff", background: "#000" });
ok(r.ratio === 21, `color-contrast accepts #rgb shorthand`);
threw = false; try { run("color-contrast", { foreground: "nope", background: "#fff" }); } catch { threw = true; }
ok(threw, `color-contrast rejects invalid hex`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
