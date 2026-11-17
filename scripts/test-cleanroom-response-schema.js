// Behavior test written from cleanroom specs 45 and 46: the typed 200 schema
// for /openapi.json and the byte-bounded schema a 402 challenge declares.
// Pure: imports one module, boots nothing.
import "./lib/offline-stores.js";
import { responseSchemaFor, boundedResponseSchemaFor, boundedSchemaFromExample, SHAPE_HAPPY_PATH_ONLY } from "../src/openapi-schema.js";

let passed = 0, failed = 0;
const same = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed++; else { failed++; console.error(`FAIL - ${label}\n  got  ${g}\n  want ${w}`); }
};

// Promise only what the sweeps enforce: non-null top-level example fields.
same(responseSchemaFor("/api/hash", { x: 1, y: null, z: "s" }),
  { type: "object", properties: { x: { type: "number" }, y: {}, z: { type: "string" } }, required: ["x", "z"] },
  "a fixed route requires its non-null fields, in property order");
same(responseSchemaFor(null, { a: 1 }), { type: "object", properties: { a: { type: "number" } } },
  "no route, no promise");
const happy = [...SHAPE_HAPPY_PATH_ONLY][0];
same(responseSchemaFor(happy, { a: 1 }).required, undefined, "a happy-path-only route requires nothing");
same(responseSchemaFor("/p", { a: null }).required, undefined, "an all-null example requires nothing");
same(responseSchemaFor("/p", { a: 1, b: null }, { t: { type: "number", description: "d" } }),
  { type: "object", properties: { a: { type: "number" }, b: {}, t: { type: "number", description: "d" } }, required: ["a"] },
  "declared optional fields are listed and never required");

// The challenge-side schema: any JSON value, inside a character budget.
same(boundedResponseSchemaFor("/api/hash", { x: 1, y: null, z: "s" }),
  { type: "object", properties: { x: { type: "number" }, y: {}, z: { type: "string" } }, required: ["x", "z"] },
  "same required policy as /openapi.json");
same(boundedResponseSchemaFor(happy, { x: 1 }), { type: "object", properties: { x: { type: "number" } } }, "happy-path route: no required");
same(boundedResponseSchemaFor(null, "raw"), { type: "string" }, "a string output is a string schema");
same(boundedResponseSchemaFor("/p", [1, 2]), { type: "array", items: { type: "number" } }, "an array output");
same(boundedResponseSchemaFor("/p", 7), { type: "number" }, "a whole number is typed number");
same(boundedResponseSchemaFor("/p", true), { type: "boolean" }, "a boolean output");
same(boundedResponseSchemaFor("/p", null), null, "null example: nothing to declare");
same(boundedResponseSchemaFor("/p", undefined), null, "undefined example: nothing to declare");
same(boundedResponseSchemaFor("/p", {}), { type: "object" }, "an empty object");
same(boundedResponseSchemaFor("/p", []), { type: "array" }, "an empty array");
same(boundedResponseSchemaFor("/p", { a: { b: { c: { d: { e: 1 } } } } }, 60), null, "gives up when even depth 1 does not fit");
{
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  const full = boundedResponseSchemaFor("/p", deep, 100000);
  const tight = boundedResponseSchemaFor("/p", deep, JSON.stringify(full).length - 1);
  same(tight !== null && JSON.stringify(tight).length < JSON.stringify(full).length, true, "a tighter budget gives a shallower schema, not nothing");
  same(JSON.stringify(full).length <= 100000 && JSON.stringify(tight).length <= JSON.stringify(full).length - 1, true, "every answer fits its budget");
}
same(boundedResponseSchemaFor("/p", { a: 1 }, 1500, { t: { type: "number", description: "x" }, u: "str", a: { type: "string" } }),
  { type: "object", properties: { a: { type: "number" }, t: { type: "number" }, u: {} }, required: ["a"] },
  "optional fields are typed only, never override the example's own, never required");
{
  const opt = { t: { type: "number", description: "a long description that does not matter" } };
  const withOpt = boundedResponseSchemaFor("/p", { a: 1 }, 1500, opt);
  const budget = JSON.stringify(withOpt).length - 1;
  same(boundedResponseSchemaFor("/p", { a: 1 }, budget, opt), { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
    "a budget the optional fields do not fit drops them first");
}

// The older helper is for object outputs only and never promises fields.
for (const v of [null, "raw", [1, 2], 7, true]) same(boundedSchemaFromExample(v, 500), null, `boundedSchemaFromExample(${JSON.stringify(v)}) is null`);
same(boundedSchemaFromExample({ x: 1, y: null }), { type: "object", properties: { x: { type: "number" }, y: {} } },
  "boundedSchemaFromExample types an object and requires nothing");

console.log(`${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
