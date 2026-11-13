// Runtime verification: did the seller keep the promise their OpenAPI made?
//
// The declared contract is a claim. This is the measurement, taken on calls the
// router already pays for. The invariant that matters most here is not
// correctness of the check but RESTRAINT: the response belongs to the buyer who
// paid for it, and the only thing recorded is whether the paths the seller
// itself published were present.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  observeDelivery, deliveryObservation, deliveryProjection, pathPresent,
  __resetObservationsForTest, __observationCountForTest,
} from "../src/response-observation.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const SELLER = "https://seller.example", ROUTE = "/simulate";
const obs = (body, paths = ["data", "data.attributes"]) =>
  observeDelivery({ origin: SELLER, method: "POST", route: ROUTE, guaranteedPaths: paths, body });

// --- presence, not value ---------------------------------------------------
ok(pathPresent({ a: 1 }, "a") === true, "a present path is present");
ok(pathPresent({ a: { b: 1 } }, "a.b") === true, "a nested path is found");
ok(pathPresent({ a: {} }, "a.b") === false, "a missing nested path is missing");
ok(pathPresent({ a: null }, "a") === true,
  "a null VALUE still counts as the field being present - the seller promised the field, and null is a value they may send");
ok(pathPresent({ a: null }, "a.b") === false, "but you cannot descend through null");
ok(pathPresent({ a: [1, 2] }, "a") === true && pathPresent({ a: [1] }, "a.0") === false,
  "arrays are values, not objects to index into");
ok(pathPresent(null, "a") === false && pathPresent("str", "a") === false && pathPresent(undefined, "a") === false,
  "a non-object body has no paths");
// Inherited properties must not count: a seller could otherwise satisfy a
// promise with something they never sent.
ok(pathPresent({}, "toString") === false, "an inherited property is NOT a delivered field");
ok(pathPresent({}, "constructor") === false, "...including constructor");
ok(pathPresent(JSON.parse('{"__proto__":{"x":1}}'), "x") === false, "and a prototype-polluting body delivers nothing");

// --- the verdict -----------------------------------------------------------
__resetObservationsForTest();
obs({ data: { attributes: { k: 1 } } });
let o = deliveryObservation(SELLER, "POST", ROUTE);
ok(o.calls === 1 && o.kept === 1 && o.keptRate === 1 && o.lastMissing.length === 0,
  "a response containing every promised path is recorded as kept");

obs({ data: { other: 1 } });
o = deliveryObservation(SELLER, "POST", ROUTE);
ok(o.calls === 2 && o.kept === 1 && o.keptRate === 0.5,
  `a response missing a promised path lowers the rate (got ${o.keptRate})`);
ok(o.lastMissing.join(",") === "data.attributes",
  `and names WHICH promise was broken (got ${o.lastMissing})`);

// --- restraint: the payload is the buyer's, not ours -----------------------
{
  __resetObservationsForTest();
  const body = { data: { attributes: { ssn: "123-45-6789" } }, secret: "buyer paid for this", token: "sk-live-xyz" };
  obs(body);
  const serialized = JSON.stringify(deliveryObservation(SELLER, "POST", ROUTE));
  for (const leak of ["123-45-6789", "buyer paid for this", "sk-live-xyz", "secret", "token", "ssn"]) {
    ok(!serialized.includes(leak),
      `the observation carries no trace of the response (${leak}) - the buyer paid for that content, not us`);
  }
  ok(serialized.includes("calls") && serialized.includes("keptRate"),
    "it carries the verdict and nothing else");
}

// --- a seller who promised nothing is never observed -----------------------
{
  __resetObservationsForTest();
  ok(obs({ anything: 1 }, []) === null, "no declared paths means no observation: there is no promise to check");
  // Called directly: the helper above has a default parameter, so passing
  // `undefined` through it would silently use the default and prove nothing.
  ok(observeDelivery({ origin: SELLER, method: "POST", route: ROUTE, body: { anything: 1 } }) === null,
    "...and a missing path list is the same");
  ok(__observationCountForTest() === 0,
    "nothing is stored for an undeclared route - 'what did this response contain' is not our question to ask");
}

// --- unobserved is not a pass ----------------------------------------------
{
  __resetObservationsForTest();
  ok(deliveryObservation(SELLER, "POST", "/never-bought") === null,
    "a route we have never paid for reports null, never a clean record");
  ok(Object.keys(deliveryProjection(SELLER, "POST", "/never-bought")).length === 0,
    "and projects nothing, so a consumer can tell 'we checked' from 'we never looked'");
  obs({ data: { attributes: 1 } });
  ok(deliveryProjection(SELLER, "POST", ROUTE).responseDelivery?.source === "agent402_paid_call",
    "an observed route projects, attributed to our own paid call rather than to the seller");
}

// --- it must never break the call it is measuring --------------------------
{
  __resetObservationsForTest();
  const hostile = JSON.parse('{"data":{"attributes":1}}');
  Object.defineProperty(hostile, "boom", { get() { throw new Error("nope"); }, enumerable: true });
  let threw = null;
  try { obs(hostile); } catch (e) { threw = e; }
  ok(threw === null, "a hostile response body cannot throw out of the observer");
  ok(observeDelivery({ origin: null, route: null, guaranteedPaths: ["a"], body: {} }) === null,
    "a call with no route records nothing and does not throw");
}

// --- bounded ---------------------------------------------------------------
{
  __resetObservationsForTest();
  for (let i = 0; i < 5200; i++) {
    observeDelivery({ origin: `https://s${i}.example`, method: "POST", route: "/x", guaranteedPaths: ["a"], body: { a: 1 } });
  }
  ok(__observationCountForTest() <= 5000,
    `the map is bounded at 5000 routes (got ${__observationCountForTest()}), so a wide crawl cannot grow it without limit`);
}

// --- THE CALLER PATH: does the router actually record? -----------------------
//
// Every assertion above drives observeDelivery directly, which proves the
// observer and says nothing about whether a paid call ever reaches it. The
// first version of this wiring got it wrong TWICE - it read a field the
// resolver does not return, and keyed by slug where every reader keys by route,
// so it would have recorded observations nothing could ever read back. This
// drives the real route-execute tool with an injected payer.
{
  __resetObservationsForTest();
  const { buildRouteExecuteTool } = await import("../src/tools/route-execute.js");
  const EXT = {
    seller: "https://ext.example", slug: "zk", url: "https://ext.example/api/zk",
    method: "POST", price: "$0.12", networks: ["eip155:8453"],
    route: "/api/zk", guaranteedPaths: ["data", "data.attributes"],
  };
  const tool = buildRouteExecuteTool({
    getCatalog: () => ({}), tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 },
    resolveExternal: async () => EXT,
    // The seller delivers `data` but NOT the `data.attributes` it promised.
    payExternal: async () => ({ result: { data: { other: 1 } }, quote: { usd: 0.12, network: "eip155:8453" }, receipt: { transaction: "0xTX" } }),
    externalEnabled: () => true,
  });
  await tool.handler({ task: "prove something", include: "external", params: {} }, {});

  const o = deliveryObservation(EXT.seller, "POST", EXT.route);
  ok(o !== null, "a paid external call reaches the observer at all");
  ok(o && o.calls === 1 && o.kept === 0,
    "a seller that broke its own promise is recorded as not kept");
  ok(o && o.lastMissing.join(",") === "data.attributes",
    `and the broken promise is named (got ${o && o.lastMissing})`);
  ok(Object.keys(deliveryProjection(EXT.seller, "POST", EXT.route)).length === 1,
    "the same (origin, method, route) the index projects on reads it back - record and read agree on the key");
}

// The resolver's own return: resolveExternalSeller builds each live candidate
// with resolvedCandidateOf (src/sor-candidates.js), so the fields are read off
// the function production calls. Without them, every test above stays green
// while the observer receives an empty promise list and records nothing.
{
  const { readFileSync } = await import("node:fs");
  const { resolvedCandidateOf } = await import("../src/sor-candidates.js");
  const c = resolvedCandidateOf({ seller: "https://ext.example", slug: "zk", url: "https://ext.example/api/zk", method: "POST", route: "/api/zk", responseContract: { guaranteedPaths: ["data.attributes"] } });
  ok(c.guaranteedPaths.join(",") === "data.attributes",
    "resolveExternalSeller passes the declared paths to the paid call, or there is nothing to verify");
  ok(c.route === "/api/zk",
    "...and the route, or the observation is keyed by something no reader uses");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/resolvedCandidateOf\(/.test(server), "...and the resolver builds its candidates with that function");
}

// A BODY WE COULD NOT READ IS NOT WHAT THE SELLER SENT, and a body cut at our
// byte limit is the seller's choice of size. readAfterSpend marks both by
// identity, not by a key: a cut whose prefix closed a JSON object or array is
// judged on it; any other cut, and a body we could not read at all, is
// counted as unverifiable, apart from calls and kept, so padding an answer
// past the limit, or aborting it after settling, never keeps a record clean.
{
  const o = "https://cut.example";
  const { readAfterSpend } = await import("../src/x402-buyer.js");
  const { markNotSellerBody: markNotSellerBodyFor } = await import("../src/response-observation.js");
  const cut = await readAfterSpend(new Response(JSON.stringify({ result: { pad: "x".repeat(500), value: 1 } })), 64);
  ok(cut?._truncated === true, "our reader cut the oversized body (setup)");
  observeDelivery({ origin: o, method: "POST", route: "/r", guaranteedPaths: ["result.value"], body: cut });
  ok(deliveryObservation(o, "POST", "/r")?.unverifiable === 1 && deliveryObservation(o, "POST", "/r")?.calls === 0 && deliveryObservation(o, "POST", "/r")?.keptRate === null,
    `a body cut at our byte limit that cannot be parsed is counted as unverifiable, never as kept (${JSON.stringify(deliveryObservation(o, "POST", "/r"))})`);
  // A cut that still parses (a long number cut to a shorter one) is ours too.
  const cutParsed = await readAfterSpend(new Response("7".repeat(500)), 64);
  ok(cutParsed?._truncated === true && typeof cutParsed.value === "number", "our reader cut a body whose prefix still parses (setup)");
  observeDelivery({ origin: o, method: "POST", route: "/r", guaranteedPaths: ["result.value"], body: cutParsed });
  ok(deliveryObservation(o, "POST", "/r")?.unverifiable === 2 && deliveryObservation(o, "POST", "/r")?.calls === 0, "a cut whose prefix parses only as a scalar a longer body would extend is unverifiable too");
  const unread = await readAfterSpend(new Response(new ReadableStream({ start(c) { c.error(new Error("reset")); } })), 64);
  ok(typeof unread?.relayError === "string", "our reader could not read the body (setup)");
  observeDelivery({ origin: o, method: "POST", route: "/r", guaranteedPaths: ["result.value"], body: unread });
  ok(deliveryObservation(o, "POST", "/r")?.unverifiable === 3 && deliveryObservation(o, "POST", "/r")?.calls === 0 && deliveryObservation(o, "POST", "/r")?.kept === 0, `a body we could not read is counted as unverifiable, never kept (${JSON.stringify(deliveryObservation(o, "POST", "/r"))})`);
  const fresh = "https://abort.example";
  observeDelivery({ origin: fresh, method: "POST", route: "/r", guaranteedPaths: ["result.value"], body: unread });
  ok(deliveryObservation(fresh, "POST", "/r")?.unverifiable === 1 && deliveryObservation(fresh, "POST", "/r")?.keptRate === null, "a route whose only paid answer was unreadable has a record, and no kept rate");
  // The same keys sent BY THE SELLER are the seller's own answer: observed,
  // so an echoed `_truncated` or `relayError` cannot hide a missed promise.
  const echoed = await readAfterSpend(new Response(JSON.stringify({ _truncated: true, relayError: "x" })), 4096);
  ok(echoed?._truncated === true && typeof echoed.relayError === "string", "a seller body carrying those keys reads through whole (setup)");
  const e = "https://echo.example";
  observeDelivery({ origin: e, method: "POST", route: "/r", guaranteedPaths: ["result.value"], body: echoed });
  ok(deliveryObservation(e, "POST", "/r")?.calls === 1 && deliveryObservation(e, "POST", "/r")?.kept === 0, "a seller body with `_truncated:true` is observed as a missed promise");
  observeDelivery({ origin: e, method: "POST", route: "/r2", guaranteedPaths: ["result.value"], body: { relayError: "upstream body unreadable" } });
  ok(deliveryObservation(e, "POST", "/r2")?.kept === 0, "and so is one with a `relayError` string");
  // A whole body that is not JSON comes back as our own { raw } reading: a
  // promised `raw` is never met by our key.
  const prose = await readAfterSpend(new Response("plain words, not JSON"), 4096);
  ok(typeof prose?.raw === "string" && !prose._truncated, "our reader wraps a whole non-JSON body (setup)");
  // It is still the seller's whole delivery: judged on the seller's bytes, so
  // a route that promised JSON paths and answered prose is a missed promise.
  observeDelivery({ origin: o, method: "POST", route: "/raw", guaranteedPaths: ["raw"], body: prose });
  ok(deliveryObservation(o, "POST", "/raw")?.calls === 1 && deliveryObservation(o, "POST", "/raw")?.kept === 0, "a whole non-JSON body on a JSON route is observed as a missed promise, never kept by our `raw` key");
  const tempoTextForTest = (text, truncated) => markNotSellerBodyFor({ text, truncated, contentType: "text/plain", sha256: "0" });
  observeDelivery({ origin: o, method: "POST", route: "/tt", guaranteedPaths: ["text"], body: tempoTextForTest("prose", false) });
  ok(deliveryObservation(o, "POST", "/tt")?.kept === 0, "and so is the Tempo reader's whole text reading, never kept by our `text` key");
  observeDelivery({ origin: o, method: "POST", route: "/tc", guaranteedPaths: ["text"], body: tempoTextForTest("prose", true) });
  ok(deliveryObservation(o, "POST", "/tc")?.unverifiable === 1 && deliveryObservation(o, "POST", "/tc")?.kept === 0, "a cut text reading is counted as unverifiable, never kept by our text key");
  observeDelivery({ origin: o, method: "POST", route: "/tcj", guaranteedPaths: ["data"], body: tempoTextForTest('{"other":1}' + " ".repeat(40), true) });
  ok(deliveryObservation(o, "POST", "/tcj")?.calls === 1 && deliveryObservation(o, "POST", "/tcj")?.kept === 0, "a cut text reading that closed a JSON object is judged on it");
  // Padding past the read limit: a seller whose JSON answer misses its
  // promised path, padded with trailing whitespace past our cap, is judged on
  // the document it closed. Twenty kept calls and five padded misses read 0.8.
  {
    const p = "https://pad.example";
    for (let i = 0; i < 20; i++) observeDelivery({ origin: p, method: "POST", route: "/q", guaranteedPaths: ["result.value"], body: { result: { value: i } } });
    for (let i = 0; i < 5; i++) {
      const padded = await readAfterSpend(new Response(JSON.stringify({ other: i }) + " ".repeat(600)), 64);
      if (i === 0) ok(padded?._truncated === true, "our reader cut the padded answer (setup)");
      observeDelivery({ origin: p, method: "POST", route: "/q", guaranteedPaths: ["result.value"], body: padded });
    }
    const d = deliveryObservation(p, "POST", "/q");
    ok(d?.calls === 25 && d?.kept === 20 && d?.keptRate === 0.8 && d?.unverifiable === 0, `padded misses are judged on the document they closed: 0.8, not a clean record (${JSON.stringify(d)})`);
    const paddedKept = await readAfterSpend(new Response(JSON.stringify({ result: { value: 1 } }) + " ".repeat(600)), 64);
    observeDelivery({ origin: p, method: "POST", route: "/k", guaranteedPaths: ["result.value"], body: paddedKept });
    ok(deliveryObservation(p, "POST", "/k")?.kept === 1, "control: a padded answer holding its promised path is kept");
  }
  observeDelivery({ origin: o, method: "POST", route: "/tj", guaranteedPaths: ["data"], body: tempoTextForTest('{"data":1}', false) });
  ok(deliveryObservation(o, "POST", "/tj")?.kept === 1, "control: whole text that parses as the promised JSON is kept");
  observeDelivery({ origin: o, method: "POST", route: "/r", guaranteedPaths: ["result.value"], body: { result: { value: 1 } } });
  ok(deliveryObservation(o, "POST", "/r")?.calls === 1 && deliveryObservation(o, "POST", "/r")?.keptRate === 1, "control: a whole body is observed as before");
}
// The published delivery_failing reason says what the memo records: never a
// timeout (a paid leg that times out is not recorded), and two requests.
{
  const { DISPATCH_REASONS, dispatchLegend } = await import("../src/dispatch-eligibility.js");
  const reason = DISPATCH_REASONS.delivery_failing;
  ok(!/timeout|no answer/i.test(reason) && /two different requests/.test(reason), `the delivery_failing reason names no timeout and says two different requests (${reason.slice(0, 90)})`);
  ok(/two different requests/.test(JSON.stringify(dispatchLegend())), "and so does the legend");
}

// --- an unpaid 200: an answer, or an error envelope with no content ---------
{
  const { unpaidNonAnswerReason } = await import("../src/response-observation.js");
  for (const [label, body] of [
    ["a validator's verdict {valid:false, errors}", { valid: false, errors: ["bad checksum"] }],
    ["a health report {ok:false, status:503, ...}", { ok: false, status: 503, db: "down", uptime: 12 }],
    ["a not-found beside content {status:404, error, found:false}", { status: 404, error: "Not Found", found: false }],
    ["a count of zero beside an error {error, count:0}", { error: "none matched", count: 0 }],
    ["a partial answer {data, errors}", { data: { price: 1 }, errors: [{ message: "one field failed" }] }],
    ["an envelope with no error signal {message}", { message: "hello" }],
  ]) {
    const got = unpaidNonAnswerReason(body, []);
    ok(got === null, `${label} is the seller's answer (got ${got})`);
  }
  const challenge = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000" }] };
  for (const [label, body, why, paths = []] of [
    ["null", null, "empty"], ["{}", {}, "empty"], ["a challenge sent as a 200", challenge, "challenge"],
    ["{error}", { error: "upstream down" }, "error-shaped"],
    ["a JSON-RPC error", { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x" } }, "error-shaped"],
    ["a challenge with no payment options", { x402Version: 1, error: "x", accepts: [] }, "error-shaped"],
    ["{ok:false}", { ok: false }, "error-shaped"],
    ["{ok:false, status:503}", { ok: false, status: 503 }, "error-shaped"],
    ["{error, message, code, requestId}", { error: "x", message: "y", code: "E1", requestId: "r1" }, "error-shaped"],
    ["problem details {type, title, status:500, detail}", { type: "about:blank", title: "Internal", status: 500, detail: "boom", errors: ["boom"] }, "error-shaped"],
    ["{errors:[..]} (GraphQL, nothing else)", { errors: [{ message: "x" }] }, "error-shaped"],
    ["{errors:[..], data:null} (GraphQL with a null data)", { errors: [{ message: "x" }], data: null }, "error-shaped"],
    ["{success:false, data:null, error}", { success: false, data: null, error: "Invalid token" }, "error-shaped"],
    ["an error beside empty values {error, data:{}, items:[], note:\"\"}", { error: "x", data: {}, items: [], note: "" }, "error-shaped"],
    ["a framework default error page {timestamp, status:500, error, path}", { timestamp: "2026-11-12T00:00:00Z", status: 500, error: "Internal Server Error", path: "/api/x" }, "error-shaped"],
    ["{error, retryAfter}", { error: "rate limited", retryAfter: 30 }, "error-shaped"],
    ["{error, retry_after}", { error: "rate limited", retry_after: 30 }, "error-shaped"],
    ["{ok:false, reason}", { ok: false, reason: "upstream down" }, "error-shaped"],
    ["a not-found envelope {status:404, error}", { status: 404, error: "Not Found" }, "error-shaped"],
    ["a not-found envelope {statusCode:\"410\", error}", { statusCode: "410", error: "Gone" }, "error-shaped"],
    ["a router's not-found {statusCode:404, message, error}", { statusCode: 404, message: "Cannot GET /api/x", error: "Not Found" }, "error-shaped"],
    ["none of the guaranteed paths", { note: "see docs" }, "missing-fields", ["data.price"]],
  ]) {
    const got = unpaidNonAnswerReason(body, paths);
    ok(got === why, `${label} is not an answer: ${why} (got ${got})`);
  }
  ok(unpaidNonAnswerReason({ ok: false, errors: ["bad checksum"] }, ["ok", "errors"]) === null, "keys the seller's contract guarantees are its answer");
  // Our readers' stand-ins are judged on the seller's bytes, never on our keys.
  const { markNotSellerBody } = await import("../src/response-observation.js");
  const tempoText = (text, truncated = false) => markNotSellerBody({ text, truncated, contentType: "text/plain", sha256: "0" });
  for (const [label, body, paths, why] of [
    ["an empty body read as text", tempoText(""), [], "empty"],
    ["a blank body read as text", tempoText(" \n\t"), [], "empty"],
    ["an error envelope sent as text", tempoText('{"error":"down"}'), [], "error-shaped"],
    ["a challenge sent as text", tempoText(JSON.stringify(challenge)), [], "challenge"],
    ["text when the seller promised a path our key names", tempoText("hello"), ["text"], "missing-fields"],
    ["an x402 reader's empty { raw }", markNotSellerBody({ raw: "" }), [], "empty"],
    ["an x402 reader's { raw } error envelope", markNotSellerBody({ raw: '{"ok":false}' }), [], "error-shaped"],
    ["a body our reader could not read", markNotSellerBody({ relayError: "upstream body unreadable" }), ["relayError"], "unreadable"],
    ["a cut JSON prefix holding only an error", markNotSellerBody({ error: "x", _truncated: true }), [], "error-shaped"],
    ["a cut JSON prefix where the seller promised our key", markNotSellerBody({ note: "n", _truncated: true }), ["_truncated"], "missing-fields"],
  ]) {
    const got = unpaidNonAnswerReason(body, paths);
    ok(got === why, `stand-in: ${label} is not an answer: ${why} (got ${got})`);
  }
  for (const [label, body] of [["plain text", tempoText("an answer")], ["a cut text prefix", tempoText('{"error":"x", "data": 1', true)], ["a cut JSON number", markNotSellerBody({ value: 777, _truncated: true })], ["a cut JSON object with content", markNotSellerBody({ data: "x", _truncated: true })]]) {
    const got = unpaidNonAnswerReason(body, []);
    ok(got === null, `stand-in: ${label} is the seller's answer (got ${got})`);
  }
  ok(unpaidNonAnswerReason({ text: "", truncated: false, contentType: "", sha256: "0" }, []) === null, "control: the same keys from a seller's own JSON are its answer");
  // A top-level array or scalar is judged by the promised shape: guaranteed
  // paths are object paths, so it answers none of them; with none promised,
  // an array of nothing or a blank string is empty.
  for (const [label, body, paths, why] of [
    ["[] on a route that promised paths", [], ["data"], "missing-fields"],
    ["42 on a route that promised paths", 42, ["data"], "missing-fields"],
    ["\"ok\" on a route that promised paths", "ok", ["data"], "missing-fields"],
    ["[1] on a route that promised paths", [1], ["data"], "missing-fields"],
    ["[] with nothing promised", [], [], "empty"],
    ["an array of only empty items", [null, "", {}, []], [], "empty"],
    ["a blank string", "  ", [], "empty"],
    ["[] read as text by our reader", tempoText("[]"), ["data"], "missing-fields"],
    ["42 read as text by our reader", tempoText("42"), ["data"], "missing-fields"],
    ["[] read as text with nothing promised", tempoText("[]"), [], "empty"],
  ]) {
    const got = unpaidNonAnswerReason(body, paths);
    ok(got === why, `shape: ${label} is not an answer: ${why} (got ${got})`);
  }
  for (const [label, body] of [["42", 42], ["false", false], ["text", "ok"], ["[0]", [0]], ["[{a:1}]", [{ a: 1 }]]]) {
    ok(unpaidNonAnswerReason(body, []) === null, `shape: ${label} with nothing promised is the seller's answer`);
  }
  // A seller's own top-level `value` key is never read as our wrapper: a cut
  // prefix is judged on the keys the seller sent.
  ok(unpaidNonAnswerReason(markNotSellerBody({ value: [1, 2], _truncated: true }), ["data.price"]) === "missing-fields", "a cut prefix whose own key is `value` answers none of the promised paths");
  ok(unpaidNonAnswerReason(markNotSellerBody({ value: "text", _truncated: true }), ["data.price"]) === "missing-fields", "nor does one holding a string under `value`");
  ok(unpaidNonAnswerReason(markNotSellerBody({ value: { price: 1 }, _truncated: true }), ["value.price"]) === null, "control: a seller that promised `value.price` and sent it is answered");
  const { readAfterSpend: readCut } = await import("../src/x402-buyer.js");
  const cutNumber = await readCut(new Response("7".repeat(500)), 64);
  ok(unpaidNonAnswerReason(cutNumber, ["value"]) === "missing-fields", "our own wrapper around a cut number never meets a promised `value` path");
  ok(unpaidNonAnswerReason(cutNumber, []) === null, "control: with nothing promised a cut number is still the seller's answer");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
