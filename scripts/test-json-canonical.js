// json-format's sortKeys and canonical (RFC 8785) modes, offline. The vector
// is the RFC's own example (section 3.2.3); strings are built from char codes
// so no editor or shell can reinterpret the escapes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as kit from "../src/tools/kit.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const h = Object.values(kit).flat().find((t) => t && t.slug === "json-format").handler;
const bs = String.fromCharCode(92);

const input = `{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "${bs}u20ac$${bs}u000F${bs}u000aA'${bs}u0042${bs}u0022${bs}u005c${bs}${bs}${bs}"${bs}/", "literals": [null, true, false]}`;
const want = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$${bs}u000f${bs}nA'B${bs}"${bs}${bs}${bs}${bs}${bs}"/"}`;
const r = h({ json: input, canonical: true });
ok(r.valid && r.canonical === want, "RFC 8785 section 3.2.3 vector canonicalizes exactly");
ok(r.sha256 === createHash("sha256").update(want, "utf8").digest("hex") && r.formatted === r.canonical, "sha256 is over the canonical UTF-8 bytes");

const nested = h({ json: '{"b":{"d":1,"c":[{"z":0,"y":1}]},"a":null}', sortKeys: true, indent: 0 });
ok(nested.formatted === '{"a":null,"b":{"c":[{"y":1,"z":0}],"d":1}}' && nested.sortedKeys === true, "sortKeys sorts at every depth, arrays keep their order");
ok(h({ json: '{"b":1,"a":2}', indent: 0 }).formatted === '{"b":1,"a":2}', "without sortKeys the key order is untouched");
ok(h({ json: '{"a":', canonical: true }).valid === false, "invalid JSON reports valid:false");
assert.throws(() => h({ json: "{}", canonical: "yes" }), (e) => e.statusCode === 400);
ok(true, "a non-boolean canonical is a 400");

console.log(`test-json-canonical: ${n} passed`);
