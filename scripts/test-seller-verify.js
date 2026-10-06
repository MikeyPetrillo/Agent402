#!/usr/bin/env node
// The judgement half of the seller sweep, tested without spending anything.
//
// The sweep pays real money to strangers and then publishes a verdict about
// them, so the verdict has to be right for reasons that survive someone
// disagreeing with it. Every case here is a shape observed on a live seller's
// own 402 on 2026-09-12, or a shape this repo has shipped itself and been
// caught by.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { acceptFilterFor, unwrapForContract, readOutputContract, missingGuaranteedPaths, missingPromisedKeys, emptyPromisedArrays, missingSchemaProperties, verdictFor, VERDICTS } from "./seller-verify-core.mjs";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

// --- reading the contract out of a real challenge ----------------------------
{
  // The shape most live sellers publish (bazaar extension, example).
  const withExample = { accepts: [{ scheme: "exact", network: "eip155:8453", extra: {} }],
    extensions: { bazaar: { schema: { properties: { output: { type: "json", example: { summary: "…", key_facts: ["a"], sources: [{ title: "x" }] } } } } } } };
  const c1 = readOutputContract(withExample);
  eq(c1.kind, "example", "an output EXAMPLE nested anywhere in the challenge is found (31 of 46 live sellers publish this shape)");
  eq(Object.keys(c1.value).sort(), ["key_facts", "sources", "summary"], "...with its promised keys");

  // The shape a few sellers publish (properties, no example).
  const withSchema = { accepts: [{}], extensions: { bazaar: { output: { type: "object", properties: { data: { type: "object" } } } } } };
  eq(readOutputContract(withSchema).kind, "schema", "an output SCHEMA is found too (5 of 46)");

  // The spec field wins when anyone sets it.
  const spec = { accepts: [{ outputSchema: { properties: { a: {} } } }], extensions: { bazaar: { output: { properties: { b: {} } } } } };
  eq(Object.keys(readOutputContract(spec).value.properties), ["a"], "accepts[].outputSchema is preferred over the extension - it is the field the spec defines, even though no live seller set it");

  eq(readOutputContract({ accepts: [{ scheme: "exact" }] }), null, "a seller publishing nothing about its output reads null, not an empty contract (10 of 46)");
  eq(readOutputContract(null), null, "garbage in is null, never a throw - this runs against strangers' documents");
}

// --- the graders -------------------------------------------------------------
{
  const ex = { summary: "…", key_facts: ["a", "b"], sources: [{ title: "x" }] };
  eq(missingPromisedKeys(ex, { summary: "hi", key_facts: ["p"], sources: [{ title: "y" }] }), [], "a complete answer is missing nothing");
  eq(missingPromisedKeys(ex, { summary: "hi" }), ["key_facts", "sources"], "keys the seller promised and did not send are named");
  eq(emptyPromisedArrays(ex, { summary: "hi", key_facts: [], sources: [] }), ["key_facts", "sources"],
     "THE HOLLOW 200: every promised key present and every promised array empty. This passes a status check, a keys check and any payability check ever written, and it is the shape our own demand-radar sold for six weeks");
  eq(emptyPromisedArrays(ex, { summary: "hi", key_facts: ["p"], sources: [{}] }), [], "a populated answer is not hollow");
  eq(missingPromisedKeys(ex, "a string"), [], "a non-object body grades as nothing rather than everything - it is a different failure and paid_no_answer covers it");
  eq(emptyPromisedArrays({ a: [] }, { a: [] }), [], "an example whose own array is EMPTY promises nothing about that array, so an empty answer is not a breach");

  const sch = { properties: { data: {}, meta: {} }, required: ["data"] };
  eq(missingSchemaProperties(sch, { data: 1 }), [], "a schema's REQUIRED list governs when it has one");
  eq(missingSchemaProperties(sch, { meta: 1 }), ["data"], "...and a missing required property is named");
  eq(missingSchemaProperties({ properties: { a: {}, b: {} } }, { a: 1 }), ["b"], "with no required list, the declared properties are the promise");
  eq(missingSchemaProperties({ type: "object" }, { a: 1 }), [], "a schema declaring no properties promises nothing checkable");
}

// --- the verdict is narrow on purpose ----------------------------------------
{
  const base = { challengeReadable: true, baseAccept: {}, quoteUsd: 0.01, capUsd: 0.02, settled: true, status: 200 };
  eq(verdictFor({ ...base, body: { summary: "x", key_facts: ["a"] }, contract: { kind: "example", value: { summary: "…", key_facts: ["a"] } } }).verdict, "paid_delivers", "paid and the shape matches");
  const hollow = verdictFor({ ...base, body: { summary: "x", key_facts: [] }, contract: { kind: "example", value: { summary: "…", key_facts: ["a"] } } });
  eq(hollow.verdict, "paid_hollow", "paid and hollow is its own verdict - the finding nobody else can produce");
  eq(hollow.emptyArrays, ["key_facts"], "...naming what was empty, so the seller can check it themselves");
  eq(verdictFor({ ...base, body: { a: 1 }, contract: null }).verdict, "paid_ungraded", "a seller that publishes nothing is UNGRADED, never failed - an honest absence is not a defect, and calling it one would be the same error we refuse everywhere else");
  eq(verdictFor({ ...base, body: {} }).verdict, "paid_no_answer", "an empty body is its own verdict, before any grading");
  eq(verdictFor({ ...base, settled: false, status: 402 }).verdict, "payment_refused", "a payment that did not settle is not a delivery judgement at all");
  eq(verdictFor({ ...base, quoteUsd: 5 }).verdict, "over_cap", "a quote above the cap is reported, never paid");
  eq(verdictFor({ challengeReadable: false }).verdict, "no_challenge", "no readable 402, nothing to say");
  eq(verdictFor({ challengeReadable: true, baseAccept: null }).verdict, "no_base_accept", "no signable Base accept, nothing to say");

  // Ordering: a cheap seller that refuses payment must not be graded on shape.
  eq(verdictFor({ ...base, settled: false, status: 402, body: { summary: "x" }, contract: { kind: "example", value: { summary: "…" } } }).verdict, "payment_refused",
     "settlement is checked BEFORE shape: a refused payment that still returned a well-shaped body is not evidence about delivery");
  eq(verdictFor({ ...base, settled: false, status: 200, body: { summary: "x" }, contract: { kind: "example", value: { summary: "…" } } }).verdict, "served_no_receipt",
     "...and a 200 with no receipt is reported as served, never graded as a delivery we paid for - we cannot show money moved");
}

// --- every verdict is documented, and none of them accuses anyone ------------
{
  const used = ["no_challenge", "no_base_accept", "over_cap", "input_rejected", "payment_refused", "served_no_receipt", "seller_error", "paid_no_answer", "paid_hollow", "paid_ungraded", "paid_delivers"];
  for (const v of used) ok(VERDICTS[v], `${v} carries a published sentence explaining it`);
  eq(Object.keys(VERDICTS).sort(), used.sort(), "the vocabulary is closed: a verdict the driver can emit is a verdict a reader can look up");
  const blob = JSON.stringify(VERDICTS).toLowerCase();
  for (const w of ["broken", "bad", "scam", "fraud", "fake", "unreliable"])
    ok(!blob.includes(w), `no verdict calls a seller "${w}" - every sentence describes what WE observed when WE paid, which is the only thing we can defend`);
  ok(/cannot be checked against anything/.test(VERDICTS.paid_ungraded), "the ungraded sentence says why it is unknown rather than implying fault");
  // The claim must stop at shape. A response can carry every promised key and
  // wrong values in all of them, and nothing here can see that.
  const src = readFileSync(new URL("./seller-verify-core.mjs", import.meta.url), "utf8");
  ok(/delivered the shape it promised/.test(src), "the source states the limit of the claim: shape, never correctness");
}

// --- the guaranteed-paths grader, which is the primary contract -------------
// Our crawler already extracts responseContract.guaranteedPaths from each
// seller's own OpenAPI. The row beside it says runtimeVerified:false, and has
// on every row since it shipped, because nothing had ever paid a seller to
// find out. These are the real paths from a live seller.
{
  const paths = ["confidence", "query", "result", "result.confidence_score", "result.key_facts", "result.sources", "result.summary"];
  eq(missingGuaranteedPaths(paths, { confidence: 1, query: "q", result: { confidence_score: 1, key_facts: [], sources: [], summary: "" } }), [],
     "every guaranteed path resolving is a pass, even where the values are empty - a guaranteed field that is present and empty was still delivered");
  eq(missingGuaranteedPaths(paths, { confidence: 1, query: "q" }), ["result"],
     "a missing PARENT is reported alone: naming its five children too would be five findings about one fact");
  eq(missingGuaranteedPaths(paths, { confidence: 1, query: "q", result: { summary: "x" } }).sort(),
     ["result.confidence_score", "result.key_facts", "result.sources"],
     "and a partially-delivered parent names exactly the children that are missing");
  eq(missingGuaranteedPaths(["a.b"], { a: { b: null } }), [], "present-and-null RESOLVES: null is an answer, and calling it a breach would fail every honest empty result");
  eq(missingGuaranteedPaths(["rows.id"], { rows: [{ id: 1 }] }), [], "a path under an array is checked against its first element");
  eq(missingGuaranteedPaths([], { a: 1 }), [], "no guaranteed paths promises nothing");
  eq(missingGuaranteedPaths(["a"], null), [], "and a missing body grades as nothing - paid_no_answer covers that case");
  eq(verdictFor({ challengeReadable: true, baseAccept: {}, quoteUsd: 0.01, capUsd: 0.02, settled: true, status: 200,
    body: { confidence: 1, query: "q" }, contract: { kind: "paths", value: paths } }).verdict, "paid_hollow",
    "a paid answer missing a guaranteed path is hollow, graded against the seller's OWN OpenAPI");
}

// --- the accept filter, and the state bug that made it useless --------------
// The sweep's FIRST live run failed 44 of 45 sellers with "All payment
// requirements were filtered out by policies", spent $0.00, and reported those
// 44 as refusing payment. The refusal was ours: x402Client.registerPolicy
// ACCUMULATES, and a policy registered per seller on one shared client left
// every earlier seller's payee in force - no accept is payable to two
// addresses. The rule was right; the state it lived in was wrong.
{
  const cap = 20_000n; // $0.02
  const keep = acceptFilterFor({ payTo: "0xAbCd", maxAtomic: cap });
  const accept = (o = {}) => ({ scheme: "exact", network: "eip155:8453", payTo: "0xabcd", amount: "10000", ...o });
  ok(keep(accept()), "a Base exact accept to the named payee, under the cap, is payable");
  ok(!keep(accept({ payTo: "0xother" })), "...another payee is refused: the payee comes from that seller's OWN bare 402");
  ok(!keep(accept({ amount: String(cap + 1n) })), "one atomic unit over the cap is refused");
  ok(keep(accept({ amount: String(cap) })), "exactly at the cap is payable");
  ok(!keep(accept({ network: "eip155:137" })), "another chain is refused - the burner signs for Base only");
  ok(!keep(accept({ scheme: "upto" })), "a non-exact scheme is refused");
  ok(!keep(accept({ amount: "not-a-number" })), "an unparseable amount is refused rather than coerced");
  ok(!acceptFilterFor({ payTo: "", maxAtomic: cap })(accept()), "an unknown payee refuses everything: with nothing to bind to, nothing is payable");

  // The filter is a FUNCTION OF ITS INPUTS with nowhere to accumulate. Two
  // sellers in a row must not interfere, which is the whole bug.
  const first = acceptFilterFor({ payTo: "0xaaa", maxAtomic: cap });
  const second = acceptFilterFor({ payTo: "0xbbb", maxAtomic: cap });
  ok(first(accept({ payTo: "0xaaa" })) && !first(accept({ payTo: "0xbbb" })), "the first seller's filter binds only the first seller");
  ok(second(accept({ payTo: "0xbbb" })) && !second(accept({ payTo: "0xaaa" })), "and the second's only the second - building one does not narrow the other");

  // ...and the driver must build a FRESH client per seller, or the accumulation
  // comes back however pure this function is.
  const drv = readFileSync(new URL("./seller-sweep.mjs", import.meta.url), "utf8");
  ok(/const client = newClient\(\);/.test(drv), "the driver builds a fresh x402 client per seller");
  ok(!/^\s*client\.registerPolicy/m.test(drv.slice(0, drv.indexOf("for (const c of candidates)"))), "and registers no policy on a shared client before the loop");
  eq((drv.match(/\bclient\.registerPolicy\(/g) || []).length, 1, "exactly one registerPolicy CALL exists, inside the loop, on a client that is thrown away after");
}

// --- why it did not settle, from the first live run -------------------------
// That run reported 21 sellers as refusing payment. Fourteen were HTTP 400 -
// the seller rejecting the BODY we sent, which never reaches the question of
// payment - and one was a plain 200. Publishing those as refused payments
// would have been a claim about 15 sellers that was really a fact about our
// own request. Settlement ordering makes it worse than sloppy: a >= 400
// cancels settlement, so nobody was charged and there is nothing to refuse.
{
  const base = { challengeReadable: true, baseAccept: {}, quoteUsd: 0.01, capUsd: 0.02, settled: false };
  const v = (status) => verdictFor({ ...base, status }).verdict;
  eq(v(400), "input_rejected", "a 400 is the seller rejecting our INPUT, never a payment refusal");
  eq(v(422), "input_rejected", "...and so is a 422");
  eq(v(402), "payment_refused", "a 402 on the PAID retry is a genuine payment refusal");
  eq(v(401), "payment_refused", "...and so is a 401");
  eq(v(500), "seller_error", "a 5xx is the seller's own backend, and settlement ordering means nobody was charged");
  eq(v(200), "served_no_receipt", "a 200 with no receipt SERVED us - calling that a refused payment was simply wrong");
  eq(v(null), "payment_refused", "no status at all (the request never completed) stays the conservative verdict");
  for (const k of ["input_rejected", "served_no_receipt", "seller_error"]) ok(VERDICTS[k], `${k} carries its own published sentence`);
  ok(/says nothing about whether the seller can be paid/.test(VERDICTS.input_rejected),
     "and input_rejected says plainly that it is not a payability judgement, because that is the claim we nearly published about 14 sellers");
}

// --- an envelope is not a breach --------------------------------------------
// The same run flagged a seller hollow for returning {ok, data, settlement}
// against a promised {eth_usd, change_24h, seller, network}. The promised
// fields were inside `data`. Comparing top-level keys alone turns a perfectly
// good envelope into an accusation about someone else's service.
{
  const ex = { eth_usd: 1, change_24h: 1, seller: "x", network: "base" };
  eq(missingPromisedKeys(ex, { ok: true, data: { ...ex }, settlement: {} }), [],
     "promised keys one level down inside a wrapper satisfy the contract");
  eq(missingPromisedKeys(ex, { ...ex }), [], "and at the top level, as before");
  eq(missingPromisedKeys(ex, { ok: true, data: { eth_usd: 1 } }).length, 4,
     "ALL OR NOTHING: a wrapper carrying only some promised keys does not count as the payload, so the contract is judged at the top level and genuinely fails");
  eq(unwrapForContract(["a"], { x: { a: 1 }, y: { a: 2 } }), { a: 1 }, "the FIRST place every key resolves wins - deterministic, not a search");
  eq(unwrapForContract(["a"], { x: { b: 1 } }), { x: { b: 1 } }, "nothing satisfying returns the body unchanged, so the grader judges what it was given");
  eq(unwrapForContract([], { a: 1 }), { a: 1 }, "no keys to satisfy means no unwrapping");
  // One level only. A deeper hunt would find these names somewhere in almost
  // any document and grade everything a pass.
  eq(missingPromisedKeys(ex, { a: { b: { ...ex } } }).length, 4, "two levels down is NOT unwrapped - a grader that searches far enough to always succeed is not a grader");
  eq(emptyPromisedArrays({ rows: [1] }, { data: { rows: [] } }), ["rows"], "the empty-array check unwraps the same way, so a hollow answer inside an envelope is still caught");
}

console.log(`test-seller-verify: ${n} assertions OK`);
