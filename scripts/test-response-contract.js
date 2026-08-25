// What a seller's OpenAPI guarantees about a paid route's response.
//
// The rule worth defending is the intersection: a path counts as guaranteed
// only when EVERY explicit 2xx variant guarantees it. Reporting a field that
// only the 200 promises tells a buyer they are safe on a success path where
// they are not, which is worse than reporting nothing.
import { responseContractOf, packResponseContract, unpackResponseContract } from "../src/response-contract.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const json = (schema) => ({ content: { "application/json": { schema } } });
const obj = (required, properties = {}) => ({ type: "object", required, properties });
const op = (responses) => ({ responses });

// --- the basic declaration -------------------------------------------------
{
  const c = responseContractOf(op({ 200: json(obj(["data", "ok"], { data: { type: "object" }, ok: { type: "boolean" } })) }));
  ok(c.state === "declared", `a single JSON success schema is declared (got ${c.state})`);
  ok(c.guaranteedPaths.join(",") === "data,ok", `it names the required paths (got ${c.guaranteedPaths})`);
  ok(c.source === "seller_openapi", "attributed to the seller's own document");
  ok(c.runtimeVerified === false, "and never claims the response was actually delivered");
}

// --- nesting, only through required objects --------------------------------
{
  const c = responseContractOf(op({ 200: json(obj(["data"], { data: obj(["attributes"], { attributes: { type: "object" } }) })) }));
  ok(c.guaranteedPaths.join(",") === "data,data.attributes",
    `a required object is descended into (got ${c.guaranteedPaths})`);
  const shallow = responseContractOf(op({ 200: json(obj(["data"], { data: { type: "object", properties: { x: { type: "string" } } } })) }));
  ok(shallow.guaranteedPaths.join(",") === "data",
    "a property that is described but not required is NOT a guarantee");
}

// --- THE INTERSECTION RULE -------------------------------------------------
{
  const c = responseContractOf(op({
    200: json(obj(["data", "ok"], { data: { type: "object" }, ok: { type: "boolean" } })),
    201: json(obj(["data"], { data: { type: "object" } })),
  }));
  ok(c.successVariants === 2 && c.jsonSchemas === 2, "both explicit success variants are counted");
  ok(c.guaranteedPaths.join(",") === "data",
    `only what EVERY variant guarantees survives (got ${c.guaranteedPaths}) - "ok" is promised by the 200 alone`);

  const disjoint = responseContractOf(op({
    200: json(obj(["a"], { a: { type: "string" } })),
    202: json(obj(["b"], { b: { type: "string" } })),
  }));
  ok(disjoint.guaranteedPaths.length === 0 && disjoint.state === "partial",
    "variants that guarantee nothing in common guarantee NOTHING, and say so as partial");
}

// --- one unreadable variant must not let a strong one speak for the route --
{
  const c = responseContractOf(op({
    200: json(obj(["data"], { data: { type: "object" } })),
    201: { description: "created" },            // no content at all
  }));
  ok(c.state === "partial" && c.guaranteedPaths.length === 0,
    "a success variant we cannot read makes the whole report partial, never declared");

  const nonJson = responseContractOf(op({
    200: json(obj(["data"], { data: { type: "object" } })),
    201: { content: { "text/csv": { schema: obj(["data"], { data: { type: "object" } }) } } },
  }));
  ok(nonJson.state === "partial", "a non-JSON success variant does the same");
}

// --- composed schemas are refused, not half-read ---------------------------
for (const kw of ["$ref", "allOf", "anyOf", "oneOf", "not", "if", "patternProperties"]) {
  const schema = obj(["data"], { data: { type: "object" } });
  schema.properties.data[kw] = kw === "$ref" ? "#/components/schemas/X" : [{ type: "object" }];
  const c = responseContractOf(op({ 200: json(schema) }));
  ok(c.state !== "declared" && c.guaranteedPaths.length === 0,
    `a schema using ${kw} is refused rather than half-understood`);
}

// --- absence is absence ----------------------------------------------------
{
  ok(responseContractOf(op({ 500: json(obj(["e"])) })).state === "absent", "no 2xx variant means absent");
  ok(responseContractOf(op({ default: json(obj(["e"])) })).state === "absent",
    "`default` is a catch-all covering errors and is NEVER read as a success guarantee");
  ok(responseContractOf(op({})).state === "absent", "no responses at all is absent");
  ok(responseContractOf(null).state === "absent", "a missing operation is absent, not a throw");
  ok(responseContractOf({ responses: "nonsense" }).state === "absent", "a malformed operation is absent, not a throw");
}

// --- bounded against a hostile document ------------------------------------
{
  // Deeply nested requireds: bounded by depth, and it must not hang or throw.
  let deep = { type: "object" };
  const root = deep;
  for (let i = 0; i < 200; i++) { const next = { type: "object" }; deep.required = ["n"]; deep.properties = { n: next }; deep = next; }
  const t0 = Date.now();
  const c = responseContractOf(op({ 200: json(root) }));
  ok(Date.now() - t0 < 500, "a 200-deep schema is bounded, not a hang");
  // Beyond the depth bound we REFUSE the schema rather than truncating it. A
  // truncated walk would report the first few levels as guaranteed, which is a
  // claim about a document we admittedly stopped reading. "≤ 64" would pass
  // trivially here and prove nothing, so assert the actual behaviour.
  ok(c.state !== "declared" && c.guaranteedPaths.length === 0,
    `a schema nested past the depth bound is refused, not truncated into a half-report (state ${c.state})`);

  // A schema nested WITHIN the bound still reports, so the cap is a bound and
  // not an accidental off switch.
  let okDeep = { type: "object" }; const okRoot = okDeep;
  for (let i = 0; i < 4; i++) { const next = { type: "object" }; okDeep.required = ["n"]; okDeep.properties = { n: next }; okDeep = next; }
  const inBound = responseContractOf(op({ 200: json(okRoot) }));
  ok(inBound.state === "declared" && inBound.guaranteedPaths.length === 4,
    `a schema inside the bound still reports every level (got ${inBound.guaranteedPaths.length})`);

  // Very wide: bounded by the path cap.
  const wide = { type: "object", required: [], properties: {} };
  for (let i = 0; i < 500; i++) { wide.required.push(`f${i}`); wide.properties[`f${i}`] = { type: "string" }; }
  // Hitting the breadth cap is TRUNCATION, so the variant becomes inadmissible
  // rather than reporting the first 64 of 500 fields as the guarantee.
  const wideC = responseContractOf(op({ 200: json(wide) }));
  ok(wideC.state !== "declared" && wideC.guaranteedPaths.length === 0,
    `a 500-field schema is refused as truncated, not reported as its first 64 fields (state ${wideC.state})`);

  // And a schema just inside the breadth cap still reports in full.
  const narrow = { type: "object", required: [], properties: {} };
  for (let i = 0; i < 10; i++) { narrow.required.push(`f${i}`); narrow.properties[`f${i}`] = { type: "string" }; }
  ok(responseContractOf(op({ 200: json(narrow) })).guaranteedPaths.length === 10,
    "a schema inside the breadth cap reports every field");

  // An absurd field name is dropped rather than carried into a projection.
  const longName = "x".repeat(500);
  const c2 = responseContractOf(op({ 200: json(obj([longName, "ok"], { [longName]: { type: "string" }, ok: { type: "string" } })) }));
  ok(!c2.guaranteedPaths.some((p) => p.length > 128), "an oversized field name never reaches the report");
}

// --- the cache tuple round-trips, and a stale one degrades quietly ---------
{
  const c = responseContractOf(op({ 200: json(obj(["data"], { data: { type: "object" } })) }));
  const back = unpackResponseContract({ responseContract: packResponseContract(c) });
  ok(back.state === c.state && back.guaranteedPaths.join() === c.guaranteedPaths.join(),
    "the compact tuple round-trips through the cache");
  ok(back.runtimeVerified === false && back.source === "seller_openapi",
    "and the constants are restored rather than stored on every row");
  ok(packResponseContract(responseContractOf(op({}))) === null, "an absent contract stores nothing at all");
  for (const junk of [undefined, null, [], ["declared"], ["nope", 1, 1, []], "string", { a: 1 }]) {
    ok(unpackResponseContract({ responseContract: junk }) === null,
      `a stale or malformed cache value reads as no contract, never a throw (${JSON.stringify(junk)})`);
  }
}

// --- ALL THREE SURFACES, or the field is inert -------------------------------
//
// x402-index.js's own header records shipping a field on two of three tool-row
// projections TWICE, where it renders on whichever surface the caller does not
// happen to read. The three are seller detail, /api/route (routeQuery) and
// /api/index/tools. This is a source assertion because the projections are
// inside a 3,900-line module that boots a crawler on import; it is the weaker
// instrument, used because the stronger one is not available here.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");

  const between = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  const detail = between("export function sellerDetail", "export function indexSnapshot");
  const route = between("const results = picked.map", "neutrality:");
  const indexTools = src.slice(src.lastIndexOf("payable: payabilityOf(t),"));

  ok(/responseContractProjection\(t\)/.test(detail), "seller detail carries the response contract");
  ok(/responseContractProjection\(t\)/.test(route), "/api/route carries it too");
  ok(/responseContractProjection\(t\)/.test(indexTools), "/api/index/tools carries it too");
  ok((src.match(/responseContractProjection\(t\)/g) || []).length === 3,
    "exactly three projections - a fourth tool-row surface would need one as well");

  // It REPORTS. Proximity to the word "sort" was the first version of this
  // check and it failed on an adjacent comment, which is the right outcome for
  // a bad proxy: nearness in the source is not evidence about behaviour. The
  // precise claim is that every mention is one of the four known sites, so the
  // symbol cannot be reaching a ranking or authorisation path unnoticed.
  const mentions = src.split("\n").filter((l) => /responseContract/.test(l)).map((l) => l.trim());
  const allowed = [
    /^import \{.*\} from ".\/response-contract.js";$/,
    /^const packed = packResponseContract\(responseContractOf\(op\)\);$/,
    /^return packed \? \{ responseContract: packed \} : \{\};$/,
    /^responseContract: _bazaarResponseContract,$/,
    /^\.\.\.\(Array\.isArray\(o\.responseContract\) \? \{ responseContract: o\.responseContract \} : \{\}\),$/,
    /^\.\.\.responseContractProjection\(t\),$/,
    /^\.\.\.\(external \? responseContractProjection\(t\) : \{\}\),$/,
  ];
  const unexpected = mentions.filter((l) => !allowed.some((re) => re.test(l)));
  ok(unexpected.length === 0,
    `every mention is a known projection or the crawl-side store, so it cannot feed ranking or authorisation unnoticed${unexpected.length ? ` (unexpected: ${unexpected.join(" | ")})` : ""}`);
  // Stored compact, not as the repeated public object.
  ok(/packResponseContract\(/.test(src) && !/runtimeVerified/.test(src),
    "rows store the compact tuple; the constant fields live in the projection, not in the cache");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
