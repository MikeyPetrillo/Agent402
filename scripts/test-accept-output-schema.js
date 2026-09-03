#!/usr/bin/env node
// accepts[0].outputSchema on our 402 (src/accept-output-schema.js): the accept
// DECLARES the extension's typed output schema and a prototype patch on
// @x402/core's requirement builder carries it onto the built requirement - so
// the 402 and the verify-time match read one object, and a stock client that
// echoes the accept back still settles (the header-only first draft failed
// exactly that control in test-x402-v1-accepts). Pure pieces here; the booted
// shape is pinned in test-bazaar-contracts and the settlement in
// test-x402-v1-accepts + test-mpp-shim.
import { readFileSync } from "node:fs";
import { x402ResourceServer } from "@x402/core/server";
import { installAcceptOutputSchema, stampOutputSchema, withOutputSchemaOnFirstAccept, outputSchemaFromExtensions, restoreOutputSchemaOnAccepted, acceptOutputSchemaEnabled } from "../src/accept-output-schema.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const J = (x) => JSON.stringify(x);
const schema = { type: "object", properties: { hex: { type: "string" } }, required: ["hex"] };
const base = "eip155:8453", sol = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
{
  ok(outputSchemaFromExtensions({ bazaar: { schema: { properties: { output: { properties: { example: schema } } } } } }) === schema, "the schema is read from where declareDiscoveryExtension puts it (same object, not a copy)");
  ok(outputSchemaFromExtensions({}) === null && outputSchemaFromExtensions({ bazaar: { schema: { properties: { output: { properties: { example: [1] } } } } } }) === null, "no extension / non-object -> null (a schema is never invented)");
}
{
  const accepts = [{ scheme: "exact", network: base, price: "$0.001" }, { scheme: "exact", network: sol, price: "$0.001" }];
  const out = withOutputSchemaOnFirstAccept(accepts, schema);
  ok(out !== accepts && out[0].outputSchema === schema && out[0].price === "$0.001", "the first accept declares the schema, everything else on it intact");
  ok(out[1] === accepts[1] && out[1].outputSchema === undefined, "the second accept is untouched (one copy)");
  ok(withOutputSchemaOnFirstAccept(accepts, null) === accepts && withOutputSchemaOnFirstAccept([], schema).length === 0, "no schema / no accepts -> unchanged");
  ok(withOutputSchemaOnFirstAccept(out, { other: true }) === out, "an accept already declaring one is left alone");
}
{
  const options = [{ scheme: "exact", network: base, outputSchema: schema }, { scheme: "upto", network: base }, { scheme: "exact", network: sol }];
  // The core may build several requirements per option and may skip one; the
  // stamp goes by scheme + network, never by index.
  const reqs = [{ scheme: "exact", network: sol, amount: "1000" }, { scheme: "exact", network: base, amount: "1000" }, { scheme: "upto", network: base, amount: "1000" }];
  const r = stampOutputSchema(options, reqs);
  ok(r === reqs && reqs[1].outputSchema === schema, "stamped onto the requirement with the declaring option's scheme + network, in place");
  ok(reqs[0].outputSchema === undefined && reqs[2].outputSchema === undefined, "no other requirement (other rail, or upto on the same rail) carries it");
  ok(stampOutputSchema([{ scheme: "exact", network: base }], [{ scheme: "exact", network: base }])[0].outputSchema === undefined, "no declaring option -> nothing stamped");
  const kept = { scheme: "exact", network: base, outputSchema: { kept: true } };
  stampOutputSchema(options, [kept]);
  ok(kept.outputSchema.kept === true, "a requirement already carrying one is not overwritten");
  ok(stampOutputSchema(options, null) === null && stampOutputSchema(null, reqs) === reqs, "malformed inputs pass through");
}
{
  // The real class: patched once, idempotent, and the built requirements
  // (what the 402 serialises AND what verify deep-equals the echoed accept
  // against) carry the schema on the Base exact requirement only.
  // findMatchingRequirements stands in for the core's: every field but extra
  // deep-equal (key order ignored), which is exactly what refuses a stripped
  // echo.
  const norm = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => (k === "extra" ? a : (a[k] = o[k], a)), {}));
  class Fake {
    async buildPaymentRequirementsFromOptions(options) { return options.map((o) => ({ scheme: o.scheme, network: o.network, amount: "1000", extra: {} })); }
    findMatchingRequirements(reqs, payload) { return reqs.find((r) => norm(r) === norm(payload.accepted)); }
  }
  ok(installAcceptOutputSchema(Fake) === true && installAcceptOutputSchema(Fake) === false, "installs once (second call is a no-op)");
  const built = await new Fake().buildPaymentRequirementsFromOptions([{ scheme: "exact", network: base, outputSchema: schema }, { scheme: "exact", network: sol }]);
  ok(built[0].outputSchema === schema && built[1].outputSchema === undefined, "the patched builder's requirements carry the declared schema on the first accept only");
  ok(installAcceptOutputSchema({}) === false, "a class without the method is refused, never thrown on");
  // A strict client codec (mppx's x402 protocol, measured 2026-09-02) echoes
  // the accept WITHOUT the field: the match seam restores ours and matches.
  const stripped = { x402Version: 2, accepted: { scheme: "exact", network: base, amount: "1000", extra: {} }, payload: {} };
  const matched = new Fake().findMatchingRequirements(built, stripped);
  ok(matched === built[0] && stripped.accepted.outputSchema === schema, "an echo missing outputSchema is matched after OUR schema is restored onto it (in place, so verify/settle see the advertised accept)");
  const wrongAmount = { x402Version: 2, accepted: { scheme: "exact", network: base, amount: "999", extra: {} }, payload: {} };
  ok(new Fake().findMatchingRequirements(built, wrongAmount) === undefined, "restoring never makes a different amount match (every other field stays byte-exact)");
  const wrongSchema = { x402Version: 2, accepted: { scheme: "exact", network: base, amount: "1000", extra: {}, outputSchema: { type: "string" } }, payload: {} };
  ok(new Fake().findMatchingRequirements(built, wrongSchema) === undefined && wrongSchema.accepted.outputSchema.type === "string", "an echo carrying a DIFFERENT outputSchema is refused and never overwritten");
  const v1 = { x402Version: 1, accepted: { scheme: "exact", network: base, amount: "1000" }, payload: {} };
  ok(restoreOutputSchemaOnAccepted(built, v1) === false && v1.accepted.outputSchema === undefined, "v1 payloads are never touched");
  const otherRail = { x402Version: 2, accepted: { scheme: "exact", network: sol, amount: "1000", extra: {} }, payload: {} };
  ok(new Fake().findMatchingRequirements(built, otherRail) === built[1] && otherRail.accepted.outputSchema === undefined, "a rail that advertises no schema matches as before, nothing restored");
  ok(typeof x402ResourceServer.prototype.buildPaymentRequirementsFromOptions === "function", "the vendor class still exposes the seam this patches (a rename upstream fails here, not silently in prod)");
}
{
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  const installAt = src.search(/^\s*installAcceptOutputSchema\(x402ResourceServer\);\s*$/m);
  const newAt = src.search(/^\s*let server = new x402ResourceServer\(/m);
  ok(installAt > 0 && newAt > installAt, "payments.js installs the patch BEFORE constructing the resource server");
  ok(/accepts: withOutputSchemaOnFirstAccept\(acceptsFor\(item\), acceptOutputSchemaEnabled\(\) \? outputSchemaFromExtensions\(ext\) : null\)/.test(src), "catalog route accepts declare the extension's schema on the first accept, behind the rollout switch");
  ok(acceptOutputSchemaEnabled({}) === true && acceptOutputSchemaEnabled({ ACCEPT_OUTPUT_SCHEMA: "off" }) === false && acceptOutputSchemaEnabled({ ACCEPT_OUTPUT_SCHEMA: "OFF" }) === false, "ACCEPT_OUTPUT_SCHEMA=off is the switch; default on");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(!/createOutputSchemaAppender/.test(server), "the header-only appender is gone from server.js (it broke every stock client's match)");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
