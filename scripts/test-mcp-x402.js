// test-mcp-x402 - the x402 MCP transport codec (src/mcp-x402.js) against the
// spec (transports-v2/mcp.md), @x402/core's own header codecs and the official
// @x402/mcp client. Offline: an in-memory MCP pair, a locally generated key,
// no RPC, no facilitator, nothing spent.
//
// What this pins:
//  - the payment-required result: isError, structuredContent = the object,
//    content[0].text = JSON.stringify of it, an optional sentence after it, and
//    an MPP challenge _meta carried unchanged (same reference, same bytes);
//  - the reader: absent -> unpaid, a v2 payload -> a detached copy, anything
//    else -> a 400-shaped refusal (never a throw): non-objects, arrays, wrong
//    version, schema misses, prototype keys, depth, the byte bound, getters
//    that throw, cycles;
//  - PAYMENT-SIGNATURE round trip through @x402/core's decoder and the
//    server's own intake decoder (src/payment-header.js);
//  - PAYMENT-REQUIRED and PAYMENT-RESPONSE header reads, the success _meta and
//    the settlement-failed result (no tool output);
//  - the official @x402/mcp client reads our result, signs a payment our
//    reader accepts, and reads our settle receipt.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { deepStrictEqual } from "node:assert";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { x402MCPClient } from "@x402/mcp";
import {
  X402_PAYMENT_META,
  X402_PAYMENT_RESPONSE_META,
  X402_PAYMENT_MAX_BYTES,
  buildPaymentRequiredResult,
  buildSettlementFailedResult,
  paymentRequiredFromHeader,
  paymentResponseMeta,
  paymentSignatureHeader,
  readPaymentFromMeta,
  settleResponseFromHeader,
  withPaymentResponse,
} from "../src/mcp-x402.js";
import { MCP_PAYMENT_REQUIRED_META } from "../src/mcp-mpp.js";
import { decodePaymentHeader } from "../src/payment-header.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const same = (a, b) => { try { deepStrictEqual(a, b); return true; } catch { return false; } };
const noThrow = (fn) => { try { return { value: fn() }; } catch (e) { return { threw: e }; } };

const PAY_TO = "0x1111111111111111111111111111111111111111";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ACCEPT = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC_BASE, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
const REQUIRED = { x402Version: 2, error: "Payment required", resource: { url: "https://agent402.tools/api/example", description: "Example tool", mimeType: "application/json" }, accepts: [ACCEPT] };
const PAYLOAD = {
  x402Version: 2,
  resource: REQUIRED.resource,
  accepted: ACCEPT,
  payload: {
    signature: "0x" + "ab".repeat(65),
    authorization: { from: "0x857b06519E91e3A54538791bDbb0E22373e36b66", to: PAY_TO, value: "10000", validAfter: "1740672089", validBefore: "1740672154", nonce: "0x" + "f3".repeat(32) },
  },
};
// An MPP challenge _meta as src/mcp-mpp.js would carry it: odd key order,
// non-ASCII text and nested arrays, so a re-serialization would show.
const MPP_META = {
  [MCP_PAYMENT_REQUIRED_META]: {
    httpStatus: 402,
    challenges: [{ id: "ch_ZZ9", realm: "agent402.tools", method: "evm", intent: "charge", request: { amount: "10000", currency: USDC_BASE, recipient: PAY_TO, methodDetails: { chainId: 8453, decimals: 6 } }, expires: "2026-11-16T00:05:00Z" }],
    problem: { type: "https://paymentauth.org/problems/payment-required", title: "Payment Required", detail: "Pay é → \u{1F4B8}", status: 402 },
  },
  "x-extra/zeta": [3, 1, [2]],
};

// --- payment-required result ---------------------------------------------------
{
  const r = buildPaymentRequiredResult(REQUIRED, { message: "This tool costs $0.01 in USDC." });
  ok(r && r.isError === true, "payment-required: isError is true");
  ok(r.structuredContent === REQUIRED, "payment-required: structuredContent is the PaymentRequired object");
  ok(r.content[0].type === "text" && r.content[0].text === JSON.stringify(REQUIRED), "payment-required: content[0].text is JSON.stringify of the same object");
  ok(r.content[1]?.text === "This tool costs $0.01 in USDC.", "payment-required: the readable sentence follows the JSON block");
  ok(r._meta === undefined, "payment-required: no _meta when no MPP challenge is given");
  const bare = buildPaymentRequiredResult(REQUIRED);
  ok(bare.content.length === 1, "payment-required: no sentence, one content block");
  const both = buildPaymentRequiredResult(REQUIRED, { mppMeta: MPP_META });
  ok(Object.keys(both._meta).join() === Object.keys(MPP_META).join(), "MPP merge: every _meta key kept, in order");
  ok(Object.keys(MPP_META).every((k) => both._meta[k] === MPP_META[k]), "MPP merge: each value is the same reference");
  ok(Object.keys(MPP_META).every((k) => JSON.stringify(both._meta[k]) === JSON.stringify(MPP_META[k])), "MPP merge: each value serializes byte for byte");
  ok(JSON.stringify(both._meta) === JSON.stringify(MPP_META), "MPP merge: the whole _meta serializes byte for byte");
  ok(both.structuredContent === REQUIRED, "MPP merge: the x402 body is unchanged beside it");
  const poisoned = JSON.parse('{"__proto__":{"polluted":1},"k":1}');
  const p = buildPaymentRequiredResult(REQUIRED, { mppMeta: poisoned });
  ok(p._meta.k === 1 && !Object.hasOwn(p._meta, "__proto__") && ({}).polluted === undefined && Object.getPrototypeOf(p._meta) === Object.prototype, "MPP merge: a __proto__ key is skipped and pollutes nothing");
  for (const [bad, label] of [[null, "null"], [{}, "empty object"], [{ ...REQUIRED, x402Version: 1 }, "v1"], [{ ...REQUIRED, accepts: [] }, "no accepts"], [{ ...REQUIRED, resource: undefined }, "no resource"], ["{}", "a string"], [[REQUIRED], "an array"]]) {
    const t = noThrow(() => buildPaymentRequiredResult(bad));
    ok(!t.threw && t.value === null, `payment-required: ${label} -> null, no throw`);
  }
}

// --- reader ----------------------------------------------------------------------
{
  for (const [meta, label] of [[undefined, "no _meta"], [null, "null _meta"], [{}, "empty _meta"], [{ other: 1 }, "_meta without the key"], [{ [X402_PAYMENT_META]: null }, "a null payment"]]) {
    const r = readPaymentFromMeta(meta);
    ok(r.ok === true && r.payment === null, `reader: ${label} -> unpaid`);
  }
  const good = readPaymentFromMeta({ [X402_PAYMENT_META]: PAYLOAD });
  ok(good.ok && same(good.payment, PAYLOAD), "reader: a v2 payload is read whole");
  ok(good.payment !== PAYLOAD && good.payment.payload !== PAYLOAD.payload, "reader: the payload is a detached copy");
  const withExt = readPaymentFromMeta({ [X402_PAYMENT_META]: { ...PAYLOAD, extensions: { "payment-identifier": { id: "abc" } } } });
  ok(withExt.ok && withExt.payment.extensions["payment-identifier"].id === "abc", "reader: extensions are kept");

  const cyclic = { ...PAYLOAD }; cyclic.self = cyclic;
  const getterThrows = Object.defineProperty({}, X402_PAYMENT_META, { enumerable: true, get() { throw new Error("boom"); } });
  const innerGetter = { ...PAYLOAD, payload: Object.defineProperty({}, "signature", { enumerable: true, get() { throw new Error("boom"); } }) };
  const deep = { ...PAYLOAD, extensions: {} }; let cur = deep.extensions; for (let i = 0; i < 20; i++) { cur.n = {}; cur = cur.n; }
  const big = { ...PAYLOAD, extensions: { pad: "x".repeat(X402_PAYMENT_MAX_BYTES) } };
  const cases = [
    [{ [X402_PAYMENT_META]: "eyJ4NDAyVmVyc2lvbiI6Mn0=" }, "not_object", "a base64 string"],
    [{ [X402_PAYMENT_META]: 42 }, "not_object", "a number"],
    [{ [X402_PAYMENT_META]: [PAYLOAD] }, "not_object", "an array"],
    [{ [X402_PAYMENT_META]: true }, "not_object", "a boolean"],
    [[], "meta_not_object", "_meta is an array"],
    ["x", "meta_not_object", "_meta is a string"],
    [{ [X402_PAYMENT_META]: { ...PAYLOAD, x402Version: 1 } }, "unsupported_version", "x402Version 1"],
    [{ [X402_PAYMENT_META]: { ...PAYLOAD, x402Version: "2" } }, "unsupported_version", "x402Version as a string"],
    [{ [X402_PAYMENT_META]: { ...PAYLOAD, payload: "0xsig" } }, "invalid_shape", "payload is a string"],
    [{ [X402_PAYMENT_META]: { ...PAYLOAD, payload: [] } }, "invalid_shape", "payload is an array"],
    [{ [X402_PAYMENT_META]: { ...PAYLOAD, accepted: undefined } }, "invalid_shape", "no accepted"],
    [{ [X402_PAYMENT_META]: { ...PAYLOAD, accepted: { ...ACCEPT, network: "base" } } }, "invalid_shape", "a v1 network name in a v2 accepted"],
    [{ [X402_PAYMENT_META]: { ...PAYLOAD, accepted: { ...ACCEPT, amount: "" } } }, "invalid_shape", "an empty amount"],
    [{ [X402_PAYMENT_META]: { ...PAYLOAD, accepted: { ...ACCEPT, maxTimeoutSeconds: -1 } } }, "invalid_shape", "a negative timeout"],
    [{ [X402_PAYMENT_META]: JSON.parse(`{"x402Version":2,"__proto__":{"admin":true},"accepted":${JSON.stringify(ACCEPT)},"payload":{}}`) }, "forbidden_key", "a top-level __proto__ key"],
    [{ [X402_PAYMENT_META]: JSON.parse(`{"x402Version":2,"accepted":${JSON.stringify(ACCEPT)},"payload":{"constructor":{"prototype":{"x":1}}}}`) }, "forbidden_key", "a nested constructor.prototype key"],
    [{ [X402_PAYMENT_META]: deep }, "too_deep", "nesting past the depth bound"],
    [{ [X402_PAYMENT_META]: big }, "too_large", "a payload past the byte bound"],
    [{ [X402_PAYMENT_META]: cyclic }, "not_json", "a cyclic object"],
    [getterThrows, "not_json", "a _meta getter that throws"],
    [{ [X402_PAYMENT_META]: innerGetter }, "not_json", "a payload getter that throws"],
    [{ [X402_PAYMENT_META]: { ...PAYLOAD, payload: { v: 10n } } }, "not_json", "a BigInt value"],
    [{ [X402_PAYMENT_META]: new Map([["x402Version", 2]]) }, "not_object", "a Map"],
    [{ [X402_PAYMENT_META]: Object.assign(Object.create({ inherited: 1 }), PAYLOAD) }, "not_object", "an object with a foreign prototype"],
  ];
  for (const [meta, reason, label] of cases) {
    const t = noThrow(() => readPaymentFromMeta(meta));
    ok(!t.threw && t.value?.ok === false && t.value.status === 400 && t.value.error === "invalid_payment" && t.value.reason === reason && typeof t.value.message === "string", `reader: ${label} -> 400 ${reason}, no throw${t.threw ? ` (threw ${t.threw.message})` : t.value?.reason !== reason ? ` (got ${JSON.stringify(t.value)})` : ""}`);
  }
  ok(({}).admin === undefined && ({}).x === undefined, "reader: no prototype was polluted");
  // The byte bound is the bound: a payload of exactly the limit passes, one byte over refuses.
  const base = JSON.stringify({ ...PAYLOAD, extensions: { pad: "" } });
  const exact = { ...PAYLOAD, extensions: { pad: "y".repeat(X402_PAYMENT_MAX_BYTES - Buffer.byteLength(base)) } };
  ok(Buffer.byteLength(JSON.stringify(exact)) === X402_PAYMENT_MAX_BYTES && readPaymentFromMeta({ [X402_PAYMENT_META]: exact }).ok, "reader: a payload of exactly the byte bound is read");
  const over = { ...exact, extensions: { pad: exact.extensions.pad + "y" } };
  ok(readPaymentFromMeta({ [X402_PAYMENT_META]: over }).reason === "too_large", "reader: one byte over the bound refuses");
  ok(readPaymentFromMeta({ [X402_PAYMENT_META]: PAYLOAD }, { maxBytes: 100 }).reason === "too_large", "reader: a caller's lower bound applies");
  const multibyte = { ...PAYLOAD, extensions: { pad: "é".repeat(X402_PAYMENT_MAX_BYTES / 2) } };
  ok(readPaymentFromMeta({ [X402_PAYMENT_META]: multibyte }).reason === "too_large", "reader: the bound counts UTF-8 bytes, not characters");
}

// --- PAYMENT-SIGNATURE round trip ---------------------------------------------------
{
  const read = readPaymentFromMeta({ [X402_PAYMENT_META]: PAYLOAD }).payment;
  const h = paymentSignatureHeader(read);
  ok(typeof h === "string" && /^[A-Za-z0-9+/]+=*$/.test(h), "header: base64 text");
  ok(same(decodePaymentSignatureHeader(h), PAYLOAD), "header: @x402/core's decodePaymentSignatureHeader returns the payload");
  ok(same(decodePaymentHeader(h), PAYLOAD), "header: the server's intake decoder (src/payment-header.js) returns the payload");
  const unicode = { ...PAYLOAD, resource: { ...PAYLOAD.resource, description: "café \u{1F4B8}" } };
  ok(same(decodePaymentSignatureHeader(paymentSignatureHeader(readPaymentFromMeta({ [X402_PAYMENT_META]: unicode }).payment)), unicode), "header: non-ASCII text survives the round trip");
  for (const [bad, label] of [[null, "null"], ["x", "a string"], [[PAYLOAD], "an array"]]) {
    const t = noThrow(() => paymentSignatureHeader(bad));
    ok(!t.threw && t.value === null, `header: ${label} -> null, no throw`);
  }
}

// --- PAYMENT-REQUIRED and PAYMENT-RESPONSE headers ------------------------------------
const SETTLED = { success: true, transaction: "0x" + "12".repeat(32), network: "eip155:8453", payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66" };
{
  ok(same(paymentRequiredFromHeader(encodePaymentRequiredHeader(REQUIRED)), REQUIRED), "PAYMENT-REQUIRED: @x402/core's encoding reads back whole");
  ok(same(paymentRequiredFromHeader(` ${encodePaymentRequiredHeader(REQUIRED)} `), REQUIRED), "PAYMENT-REQUIRED: surrounding whitespace is ignored");
  for (const [bad, label] of [[undefined, "absent"], ["", "empty"], ["%%%", "not base64"], [Buffer.from("not json").toString("base64"), "not JSON"], [encodePaymentRequiredHeader({ x402Version: 2, accepts: [] }), "an invalid PaymentRequired"], [encodePaymentRequiredHeader([1]), "an array"], [42, "a number"]]) {
    const t = noThrow(() => paymentRequiredFromHeader(bad));
    ok(!t.threw && t.value === null, `PAYMENT-REQUIRED: ${label} -> null, no throw`);
  }
  const h = encodePaymentResponseHeader(SETTLED);
  ok(same(settleResponseFromHeader(h), SETTLED), "PAYMENT-RESPONSE: @x402/core's encoding reads back whole");
  ok(same(paymentResponseMeta(h), { [X402_PAYMENT_RESPONSE_META]: SETTLED }), "PAYMENT-RESPONSE: the success _meta entry");
  for (const [bad, label] of [[undefined, "absent"], ["", "empty"], ["@@", "not base64"], [encodePaymentResponseHeader({ ...SETTLED, success: false }), "success: false"], [encodePaymentResponseHeader({ ...SETTLED, transaction: "" }), "no transaction"], [encodePaymentResponseHeader({ ...SETTLED, network: 8453 }), "a numeric network"], [Buffer.from('{"success":true,"transaction":"0x1","network":"eip155:8453","__proto__":{"p":1}}').toString("base64"), "a __proto__ key"]]) {
    const t = noThrow(() => paymentResponseMeta(bad));
    ok(!t.threw && t.value === null, `PAYMENT-RESPONSE: ${label} -> null, no throw`);
  }
  const tool = { content: [{ type: "text", text: "{}" }], structuredContent: { slug: "x" }, _meta: { "org.paymentauth/receipt": { status: "success" } } };
  const paid = withPaymentResponse(tool, h);
  ok(paid._meta["org.paymentauth/receipt"] === tool._meta["org.paymentauth/receipt"] && same(paid._meta[X402_PAYMENT_RESPONSE_META], SETTLED) && paid.content === tool.content, "success: the receipt rides beside the result's own _meta");
  ok(withPaymentResponse(tool, "") === tool, "success: no receipt leaves the result as it was");
}

// --- settlement failed ------------------------------------------------------------------
{
  const failed = { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:8453" };
  const r = buildSettlementFailedResult(REQUIRED, { reason: "insufficient_funds", settleResponse: failed, mppMeta: MPP_META });
  ok(r.isError === true && r.structuredContent.error === "Payment settlement failed: insufficient_funds", "settle failed: isError, and error names the failure");
  ok(same({ ...r.structuredContent, error: REQUIRED.error }, REQUIRED) && REQUIRED.error === "Payment required", "settle failed: the offer is unchanged, the input not mutated");
  ok(r.content.length === 1 && r.content[0].text === JSON.stringify(r.structuredContent), "settle failed: content is the payment JSON only (no tool output)");
  ok(same(r._meta[X402_PAYMENT_RESPONSE_META], failed), "settle failed: the failed SettleResponse rides in _meta");
  ok(r._meta[MCP_PAYMENT_REQUIRED_META] === MPP_META[MCP_PAYMENT_REQUIRED_META], "settle failed: the MPP challenge rides along unchanged");
  const plain = buildSettlementFailedResult(REQUIRED);
  ok(plain.structuredContent.error === "Payment settlement failed: Settlement failed" && plain._meta === undefined, "settle failed: no reason, no receipt -> generic error and no _meta");
  ok(buildSettlementFailedResult(REQUIRED, { settleResponse: SETTLED })._meta === undefined, "settle failed: a success receipt is never attached to a failure");
  ok(buildSettlementFailedResult({ x402Version: 2 }) === null, "settle failed: an invalid PaymentRequired -> null");
}

// --- the official @x402/mcp client against our results ---------------------------------
{
  const account = privateKeyToAccount(generatePrivateKey());
  const seen = [];
  const server = new Server({ name: "mcp-x402-test", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "paid.echo", inputSchema: { type: "object" } }, { name: "paid.fails", inputSchema: { type: "object" } }] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const read = readPaymentFromMeta(req.params._meta);
    seen.push({ name: req.params.name, read });
    if (!read.ok) return { isError: true, content: [{ type: "text", text: read.message }] };
    if (!read.payment) return buildPaymentRequiredResult(REQUIRED, { message: "Pay to run this tool.", mppMeta: MPP_META });
    if (req.params.name === "paid.fails") return buildSettlementFailedResult(REQUIRED, { reason: "insufficient_funds" });
    const decoded = decodePaymentSignatureHeader(paymentSignatureHeader(read.payment));
    const settle = { success: true, transaction: "0x" + "34".repeat(32), network: decoded.accepted.network, payer: decoded.payload.authorization.from };
    return withPaymentResponse({ content: [{ type: "text", text: JSON.stringify({ echoed: req.params.arguments }) }] }, encodePaymentResponseHeader(settle));
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const payments = new x402Client();
  registerExactEvmScheme(payments, { signer: account });
  const client = new x402MCPClient(new Client({ name: "official-x402-client", version: "0.0.0" }), payments, { autoPayment: true });
  await client.connect(ct);

  const probe = await client.getToolPaymentRequirements("paid.echo", {});
  ok(probe && probe.x402Version === 2 && same(probe.accepts[0].amount, ACCEPT.amount) && probe.accepts[0].payTo === PAY_TO, "official client: reads our payment-required result");

  const out = await client.callTool("paid.echo", { q: "hi" });
  const paidCall = seen.filter((s) => s.name === "paid.echo").at(-1);
  ok(paidCall.read.ok && paidCall.read.payment && paidCall.read.payment.x402Version === 2, "official client: the payment it signs passes our reader");
  ok(paidCall.read.payment?.payload?.authorization?.from?.toLowerCase() === account.address.toLowerCase() && paidCall.read.payment.accepted.payTo === PAY_TO && paidCall.read.payment.accepted.amount === "10000", "official client: the payload names the signer, our payTo and the amount");
  ok(same(decodePaymentSignatureHeader(paymentSignatureHeader(paidCall.read.payment)), paidCall.read.payment), "official client: its payload survives our header encoding");
  ok(out.paymentMade === true && out.isError !== true && JSON.parse(out.content[0].text).echoed.q === "hi", "official client: the paid call returns the tool output");
  ok(out.paymentResponse?.success === true && out.paymentResponse.payer.toLowerCase() === account.address.toLowerCase(), "official client: reads our _meta settle receipt");

  const fails = await client.callTool("paid.fails", {});
  ok(fails.paymentMade === true && fails.isError === true && !fails.paymentResponse, "official client: a settlement-failed result is an error with no receipt");
  const failText = JSON.parse(fails.content[0].text);
  ok(failText.error.startsWith("Payment settlement failed") && !("echoed" in failText), "official client: the failure carries no tool output");
  await client.close();
}

console.log(`\n${fail ? "FAIL" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
