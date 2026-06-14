// Security regressions from the deep audit. Calls handlers directly and asserts
// the hardening holds: no prototype pollution, hostile input yields a clean 4xx
// (not a 500), and the DoS-prone tools stay bounded.
import { KIT2 } from "../src/tools/kit2.js";
import { KIT } from "../src/tools/kit.js";

const bySlug = Object.fromEntries([...KIT2, ...KIT].map((t) => [t.slug, t]));
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const call = (slug, input) => bySlug[slug].handler(input);

// 1. Prototype pollution via json-flatten (unflatten) must be rejected, and must
//    not pollute Object.prototype.
for (const payload of [{ "__proto__.polluted": "YES" }, { "constructor.prototype.pwned": "X" }]) {
  let threw = false;
  try { await call("json-flatten", { json: payload, mode: "unflatten" }); } catch (e) { threw = true; if (e.statusCode !== 400) fail(`json-flatten should 400 on unsafe key, got statusCode ${e.statusCode}`); }
  if (!threw) fail(`json-flatten must reject path ${JSON.stringify(payload)}`);
}
if (({}).polluted !== undefined || ({}).pwned !== undefined) fail("Object.prototype was polluted!");
console.log("1. json-flatten blocks prototype pollution ✓");

// 2. stats must return a clean 400 (not a 500) on a non-JSON `numbers` string.
let threw = false;
try { await call("stats", { numbers: "AAAA" }); } catch (e) { threw = true; if (e.statusCode !== 400) fail(`stats should 400 on bad input, got statusCode ${e.statusCode}`); }
if (!threw) fail("stats should reject non-array numbers");
console.log("2. stats returns 400 (not 500) on bad input ✓");

// 3. xml-to-json must reject deeply-nested XML fast (no event-loop DoS).
{
  const xml = "<a>".repeat(5000) + "x" + "</a>".repeat(5000);
  const t0 = Date.now();
  let threw = false;
  try { call("xml-to-json", { xml }); } catch (e) { threw = true; if (e.statusCode !== 400) fail(`xml-to-json should 400 on deep nesting, got ${e.statusCode}`); }
  const ms = Date.now() - t0;
  if (!threw) fail("xml-to-json should reject deeply-nested XML");
  if (ms > 1000) fail(`xml-to-json depth guard too slow: ${ms}ms`);
  console.log(`3. xml-to-json rejects deep nesting fast (${ms}ms) ✓`);
}

// 4. redact / extract-entities email regex must stay bounded on a long no-@ run.
{
  const text = "A".repeat(99000);
  for (const slug of ["redact", "extract-entities"]) {
    const t0 = Date.now();
    await call(slug, { text });
    const ms = Date.now() - t0;
    if (ms > 1000) fail(`${slug} email regex too slow on long input: ${ms}ms`);
    console.log(`4. ${slug} bounded on 99k no-@ input (${ms}ms) ✓`);
  }
}

console.log("\nsecurity regressions: all passed ✓");
