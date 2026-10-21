#!/usr/bin/env node
// Arc mainnet rail (eip155:5042) through Circle's facilitator, fully offline.
//
//   node scripts/test-arc-rail.js
//
// Part 1 drives src/circle-facilitator.js against a stubbed fetch: the paths
// and the auth header, the Arc-only /supported filter, defensive parsing
// (JSON only, byte cap, schema), error reduction (a status and a reason code,
// never the upstream body or the key), the local preflight (an authorization
// signed for another chain, token, payTo or amount is refused before Circle
// sees it), and settlement_pending reconciliation.
//
// Part 2 boots the real server with the x402 paywall active. Circle's base URL
// is a constant in the source, so a preload rewrites requests for it to a
// local stub (the only way a test reaches it). Legs: key unset (Arc absent, no
// errors), /supported listing Arc (offered, bound to Arc USDC + treasury +
// amount; a paid call settles; cross-chain and tampered payments refused
// without reaching Circle), /supported without Arc, Circle failing with the
// key echoed in an HTML body, every facilitator failing (the guard fails open
// for the other rails, Arc still fails closed), malformed /supported. Every
// leg asserts the key and the upstream body never appear in a response or a
// log line.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { parseSignature, signatureToCompactSignature, serializeCompactSignature } from "viem";
import { getFreePorts } from "./lib/free-port.js";
import {
  ARC_CAIP2, ARC_USDC, CIRCLE_FACILITATOR_BASE, CircleFacilitatorClient,
  arcKindsFromSupported, preflightArcPayment, safeReason, withoutArcKinds,
} from "../src/circle-facilitator.js";

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const SECRET = `testsecret${randomBytes(12).toString("hex")}`;
const KEY = `LIVE_API_KEY:${SECRET}`;
const MARKER = `UPSTREAMBODY${randomBytes(6).toString("hex")}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const leaks = (text) => {
  const s = String(text);
  return s.includes(SECRET) || s.includes(MARKER);
};

// ---------------------------------------------------------------- part 1
const acct = privateKeyToAccount(generatePrivateKey());
const now = () => Math.floor(Date.now() / 1000);
const nonce = () => `0x${randomBytes(32).toString("hex")}`;
const arcReq = (over = {}) => ({ scheme: "exact", network: ARC_CAIP2, asset: ARC_USDC.asset, amount: "1000", payTo: TREASURY, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" }, ...over });
async function signed({ chainId = 5042, verifyingContract = ARC_USDC.asset, to = TREASURY, value = "1000", req = arcReq() } = {}) {
  const authorization = { from: acct.address, to, value, validAfter: "0", validBefore: String(now() + 600), nonce: nonce() };
  const signature = await acct.signTypedData({
    domain: { name: "USDC", version: "2", chainId, verifyingContract },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  return { x402Version: 2, accepted: req, payload: { authorization, signature } };
}

/** A fetch stub: routes by path, records every call. */
function stubFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const path = String(url).slice(CIRCLE_FACILITATOR_BASE.length);
    const h = routes[path.split("?")[0]] || routes[path.replace(/\/[0-9a-f-]{36}$/i, "/:id")];
    if (!h) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    const r = await h(init, calls.length);
    return r;
  };
  fn.calls = calls;
  return fn;
}
const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

const SUPPORTED_FULL = {
  x402Version: 2,
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: { name: "USD Coin", version: "2" } },
    { x402Version: 2, scheme: "upto", network: ARC_CAIP2, asset: ARC_USDC.asset, extra: { name: "USDC", version: "2" } },
    { x402Version: 2, scheme: "exact", network: ARC_CAIP2, asset: ARC_USDC.asset, extra: { name: "USDC", version: "2" } },
    { x402Version: 2, scheme: "exact", network: "eip155:137", asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", extra: { name: "USD Coin", version: "2" } },
  ],
  extensions: ["payment-identifier", "settlement-status"],
  signers: { [ARC_CAIP2]: ["0x2240278661b83f55d31b2506f77266f6ffd21d55"], "eip155:8453": ["0x2240278661b83f55d31b2506f77266f6ffd21d55"] },
};
const SUPPORTED_NO_ARC = { ...SUPPORTED_FULL, kinds: SUPPORTED_FULL.kinds.filter((k) => k.network !== ARC_CAIP2) };

console.log("part 1: the Circle client");

await check("constant base URL on Circle's documented facilitator path", () => {
  assert.equal(CIRCLE_FACILITATOR_BASE, "https://api.circle.com/v1/facilitator/x402");
});

await check("/supported: GET on the documented path, keyless, redirects refused; only Arc exact survives the filter", async () => {
  const f = stubFetch({ "/supported": () => json(200, SUPPORTED_FULL) });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f });
  const s = await c.getSupported();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${CIRCLE_FACILITATOR_BASE}/supported`);
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.redirect, "error");
  assert.ok(!f.calls[0].init.headers.Authorization, "/supported is keyless; the key is not sent where it is not needed");
  assert.deepEqual(s.kinds.map((k) => `${k.scheme}:${k.network}`), [`exact:${ARC_CAIP2}`], "Base, Polygon and upto are filtered out");
  assert.deepEqual(Object.keys(s.signers), [ARC_CAIP2]);
});

await check("/supported without Arc yields no kind (the boot check then drops Arc)", async () => {
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/supported": () => json(200, SUPPORTED_NO_ARC) }) });
  assert.deepEqual((await c.getSupported()).kinds, []);
});

await check("/supported listing Arc exact on another asset or domain is not accepted", () => {
  assert.deepEqual(arcKindsFromSupported({ kinds: [{ scheme: "exact", network: ARC_CAIP2, asset: "0x0000000000000000000000000000000000000001" }] }).kinds, []);
  assert.deepEqual(arcKindsFromSupported({ kinds: [{ scheme: "exact", network: ARC_CAIP2, asset: ARC_USDC.asset, extra: { name: "USD Coin", version: "2" } }] }).kinds, []);
});

for (const [label, resp] of [
  ["HTML 200", () => new Response(`<html>${MARKER} ${KEY}</html>`, { status: 200, headers: { "content-type": "text/html" } })],
  ["JSON with kinds not an array", () => json(200, { kinds: MARKER })],
  ["a kind without a network", () => json(200, { kinds: [{ scheme: "exact" }] })],
  ["invalid JSON under a JSON type", () => new Response(`{"kinds": [${MARKER}`, { status: 200, headers: { "content-type": "application/json" } })],
  ["an oversized body", () => new Response(JSON.stringify({ kinds: [], pad: "x".repeat(70_000) + MARKER }), { status: 200, headers: { "content-type": "application/json" } })],
  ["HTTP 500 HTML echoing the key", () => new Response(`<h1>${MARKER}</h1> Authorization: Bearer ${KEY}`, { status: 500, headers: { "content-type": "text/html" } })],
  ["HTTP 401 JSON echoing the key", () => json(401, { code: 401, message: `bad key ${KEY} ${MARKER}`, errors: [{ reason: `${MARKER} <script>` }] })],
  ["a 302 redirect", () => new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } })],
]) {
  await check(`malformed or failing /supported (${label}) throws a reduced error`, async () => {
    const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/supported": resp }) });
    let err = null;
    try { await c.getSupported(); } catch (e) { err = e; }
    assert.ok(err, "it must throw so Arc fails closed");
    const shown = `${err.message} ${err.stack} ${inspect(err)} ${JSON.stringify(err)}`;
    assert.ok(!leaks(shown), `the error carries no upstream body or key: ${err.message}`);
    assert.match(err.message, /^Circle facilitator supported failed \(\d+\): [a-z0-9_]+$/);
  });
}

await check("the key never serializes with the client", () => {
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({}) });
  assert.ok(!leaks(JSON.stringify(c)) && !leaks(inspect(c, { depth: 5, showHidden: true })), "JSON and inspect of the client omit the key");
  assert.equal(c.url, undefined, "no `url` property, so the facilitator diagnostics never quote its error bodies");
});

await check("verify and settle: POST on the documented paths with the Bearer key and the stock x402 body", async () => {
  const p = await signed();
  const f = stubFetch({
    "/verify": () => json(200, { isValid: true, payer: acct.address }),
    "/settle": () => json(200, { success: true, payer: acct.address, transaction: `0x${"ab".repeat(32)}`, network: ARC_CAIP2 }),
  });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f });
  const v = await c.verify(p, arcReq());
  assert.equal(v.isValid, true);
  const s = await c.settle(p, arcReq());
  assert.equal(s.success, true);
  assert.equal(s.network, ARC_CAIP2);
  assert.deepEqual(f.calls.map((x) => [x.url, x.init.method]), [[`${CIRCLE_FACILITATOR_BASE}/verify`, "POST"], [`${CIRCLE_FACILITATOR_BASE}/settle`, "POST"]]);
  for (const x of f.calls) {
    assert.equal(x.init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(x.init.redirect, "error");
    const body = JSON.parse(x.init.body);
    assert.equal(body.x402Version, 2);
    assert.equal(body.paymentRequirements.network, ARC_CAIP2);
    assert.equal(body.paymentPayload.payload.signature, p.payload.signature);
  }
});

// The cross-chain and tamper refusals: each is refused locally, Circle is never called.
for (const [label, make, reason] of [
  ["signed for Base (chainId 8453)", () => signed({ chainId: 8453 }), "invalid_exact_evm_payload_signature"],
  ["signed for another token contract", () => signed({ verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }), "invalid_exact_evm_payload_signature"],
  ["paying another address", () => signed({ to: "0x0000000000000000000000000000000000000bad" }), "invalid_exact_evm_payload_recipient_mismatch"],
  ["for another amount", () => signed({ value: "999" }), "invalid_exact_evm_payload_authorization_value_mismatch"],
]) {
  await check(`a payment ${label} is refused before Circle sees it`, async () => {
    const f = stubFetch({ "/verify": () => json(200, { isValid: true }), "/settle": () => json(200, { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC_CAIP2, payer: acct.address }) });
    const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f });
    const p = await make();
    const v = await c.verify(p, arcReq());
    assert.equal(v.isValid, false);
    assert.equal(v.invalidReason, reason);
    const s = await c.settle(p, arcReq());
    assert.equal(s.success, false);
    assert.equal(s.errorReason, reason);
    assert.equal(f.calls.length, 0, "Circle was never called");
  });
}

for (const [label, req] of [
  ["a Base requirement", arcReq({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })],
  ["an Arc requirement on another asset", arcReq({ asset: "0x0000000000000000000000000000000000000001" })],
  ["an upto requirement", arcReq({ scheme: "upto" })],
]) {
  await check(`the Circle client refuses ${label} without calling Circle (an Arc client never serves another chain)`, async () => {
    const f = stubFetch({ "/verify": () => json(200, { isValid: true }) });
    const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f });
    const v = await c.verify(await signed(), req);
    assert.equal(v.isValid, false);
    assert.equal(f.calls.length, 0);
  });
}

await check("an expired or not-yet-valid authorization is refused locally", async () => {
  const p = await signed();
  assert.equal((await preflightArcPayment(p, arcReq(), now() + 10_000)).reason, "invalid_exact_evm_payload_authorization_valid_before");
  const q = await signed();
  q.payload.authorization.validAfter = String(now() + 1000);
  assert.equal((await preflightArcPayment(q, arcReq(), now())).reason, "invalid_exact_evm_payload_authorization_valid_after");
});

// Every signature form is verified locally: 65-byte v 27/28, 65-byte v 0/1 and
// 64-byte EIP-2098 compact. A Base-domain signature in any of those forms, and
// a form this server cannot verify (a contract wallet's), never reach Circle.
const asV01 = (sig) => { const v = parseInt(sig.slice(130), 16); return sig.slice(0, 130) + (v - 27).toString(16).padStart(2, "0"); };
const asCompact = (sig) => serializeCompactSignature(signatureToCompactSignature(parseSignature(sig)));
for (const [form, conv] of [["65-byte v 27/28", (s) => s], ["65-byte v 0/1", asV01], ["64-byte EIP-2098 compact", asCompact]]) {
  await check(`a valid Arc signature in ${form} form passes the local check`, async () => {
    const p = await signed();
    p.payload.signature = conv(p.payload.signature);
    if (form.startsWith("64")) assert.equal(p.payload.signature.length, 130);
    assert.equal(await preflightArcPayment(p, arcReq()), null);
  });
  await check(`a Base-domain signature in ${form} form is refused locally`, async () => {
    const p = await signed({ chainId: 8453 });
    p.payload.signature = conv(p.payload.signature);
    assert.equal((await preflightArcPayment(p, arcReq()))?.reason, "invalid_exact_evm_payload_signature");
  });
}
await check("a signature this server cannot verify (a contract-wallet form) is refused before Circle", async () => {
  const f = stubFetch({ "/verify": () => json(200, { isValid: true }) });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f });
  const p = await signed();
  p.payload.signature = `0x${"11".repeat(200)}`;
  assert.equal((await preflightArcPayment(p, arcReq()))?.reason, "invalid_exact_evm_payload_signature");
  assert.equal((await c.verify(p, arcReq())).isValid, false);
  assert.equal(f.calls.length, 0);
});

// Only Circle's client may claim Arc: any other client's /supported has the
// Arc networks removed before @x402 routes on it.
await check("a non-Circle facilitator advertising Arc has Arc stripped from its /supported", async () => {
  const other = { async getSupported() { return { kinds: [
    { scheme: "exact", network: "eip155:8453" }, { scheme: "exact", network: ARC_CAIP2 }, { scheme: "exact", network: "eip155:5042002" },
  ], extensions: [], signers: { [ARC_CAIP2]: ["0x0000000000000000000000000000000000000001"], "eip155:8453": [] } }; } };
  withoutArcKinds(other);
  const s = await other.getSupported();
  assert.deepEqual(s.kinds.map((k) => k.network), ["eip155:8453"]);
  assert.deepEqual(Object.keys(s.signers), ["eip155:8453"]);
});

// A settlement still pending after the client's window is booked by paymentId,
// and the reconcile pass resolves it from Circle's final status.
await check("a settle still pending after the window is handed to the booking hook keyed by its authorization", async () => {
  const id = "5b3f6c1e-9d2a-4f08-b1c7-2e9a14d0c3ac";
  const booked = [];
  const f = stubFetch({
    "/settle": () => json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: ARC_CAIP2, extensions: { "settlement-status": { paymentId: id } } }),
    "/status/:id": () => json(200, { paymentId: id, status: "pending", network: ARC_CAIP2 }),
  });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f, pendingPollMs: 5, pendingBudgetMs: 40, onPending: (e) => { booked.push(e); } });
  const p = await signed();
  p.resource = { url: "https://agent402.tools/api/uuid" };
  const s = await c.settle(p, arcReq());
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "settlement_pending");
  assert.equal(booked.length, 1);
  assert.equal(booked[0].paymentId, id);
  assert.equal(booked[0].nonce, p.payload.authorization.nonce);
  assert.equal(booked[0].amount, "1000");
  assert.equal(booked[0].payer.toLowerCase(), acct.address.toLowerCase());
});

await check("the payer is always the verified signer, never an address Circle names (verify, settle and the pending book)", async () => {
  const OTHER = "0x00000000000000000000000000000000000bad01";
  const id = "5b3f6c1e-9d2a-4f08-b1c7-2e9a14d0c3ad";
  const booked = [];
  const okF = stubFetch({ "/verify": () => json(200, { isValid: true, payer: OTHER }), "/settle": () => json(200, { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC_CAIP2, payer: OTHER }) });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: okF });
  const p = await signed();
  assert.equal((await c.verify(p, arcReq())).payer.toLowerCase(), acct.address.toLowerCase());
  assert.equal((await c.settle(p, arcReq())).payer.toLowerCase(), acct.address.toLowerCase());
  const pf = stubFetch({
    "/settle": () => json(200, { success: false, errorReason: "settlement_pending", payer: OTHER, transaction: "", network: ARC_CAIP2, extensions: { "settlement-status": { paymentId: id } } }),
    "/status/:id": () => json(200, { paymentId: id, status: "pending", network: ARC_CAIP2 }),
  });
  const c2 = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: pf, pendingPollMs: 5, pendingBudgetMs: 30, onPending: (e) => { booked.push(e); } });
  await c2.settle(await signed(), arcReq());
  assert.equal(booked[0].payer.toLowerCase(), acct.address.toLowerCase());
});

await check("a high-s (malleable) signature is refused locally (low-s rule)", async () => {
  const p = await signed();
  const sig = p.payload.signature;
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130), 16);
  p.payload.signature = sig.slice(0, 66) + (N - s).toString(16).padStart(64, "0") + (v === 27 ? 28 : 27).toString(16);
  assert.equal((await preflightArcPayment(p, arcReq()))?.reason, "invalid_exact_evm_payload_signature");
});

// A pending settlement keeps its authorization claimed: the same signed
// payment resent while the first settlement is unresolved is refused, not served.
await check("a pending settlement keeps the nonce claimed; the identical payment resent is refused as a duplicate", async () => {
  const { registerSettlementClaimHooks, registerSettlementClaimRelease, __resetSettlementClaims, DUPLICATE_AUTHORIZATION } = await import("../src/settlement-claims.js");
  __resetSettlementClaims();
  const hooks = { beforeVerify: [], beforeSettle: [], afterSettle: [], settleFailure: [] };
  const fake = {
    onBeforeVerify: (h) => { hooks.beforeVerify.push(h); return fake; }, onBeforeSettle: (h) => { hooks.beforeSettle.push(h); return fake; },
    onAfterSettle: (h) => { hooks.afterSettle.push(h); return fake; }, onSettleFailure: (h) => { hooks.settleFailure.push(h); return fake; },
  };
  registerSettlementClaimHooks(fake);
  registerSettlementClaimRelease(fake);
  const p = await signed();
  const ctxFor = (req) => ({ requirements: arcReq(), paymentPayload: p, transportContext: { request: { adapter: { req } } } });
  const first = ctxFor({});
  for (const h of hooks.beforeVerify) await h(first);
  for (const h of hooks.beforeSettle) assert.equal(await h(first), undefined, "the first request claims the authorization");
  const pendingErr = Object.assign(new Error("settlement_pending"), { errorReason: "settlement_pending" });
  for (const h of hooks.settleFailure) await h({ ...first, error: pendingErr });
  const resend = ctxFor({});
  for (const h of hooks.beforeVerify) await h(resend);
  const r = await hooks.beforeSettle[0](resend);
  assert.equal(r?.abort, true, "the resend is refused while the first settlement is pending");
  assert.equal(r.reason, DUPLICATE_AUTHORIZATION);
  // Control: an ordinary failure still frees the authorization for a retry.
  __resetSettlementClaims();
  const q = await signed();
  const c1 = { requirements: arcReq(), paymentPayload: q, transportContext: { request: { adapter: { req: {} } } } };
  for (const h of hooks.beforeVerify) await h(c1);
  await hooks.beforeSettle[0](c1);
  for (const h of hooks.settleFailure) await h({ ...c1, error: Object.assign(new Error("x"), { errorReason: "insufficient_funds" }) });
  const c2 = { requirements: arcReq(), paymentPayload: q, transportContext: { request: { adapter: { req: {} } } } };
  for (const h of hooks.beforeVerify) await h(c2);
  assert.equal(await hooks.beforeSettle[0](c2), undefined, "a plain failure releases the claim (a retry may settle)");
  __resetSettlementClaims();
});

await check("a settlement tx already claimed by the request that served it reads as served", async () => {
  const { txServedElsewhere, claimSettlementKey, txClaimKey, __resetSettlementClaims } = await import("../src/settlement-claims.js");
  __resetSettlementClaims();
  const tx = `0x${"5c".repeat(32)}`;
  await claimSettlementKey(txClaimKey(ARC_CAIP2, tx), "the-request-that-served-it");
  assert.equal(await txServedElsewhere(ARC_CAIP2, tx, "circle-pending:x"), true);
  const fresh = `0x${"5d".repeat(32)}`;
  assert.equal(await txServedElsewhere(ARC_CAIP2, fresh, "circle-pending:y"), false, "an unclaimed tx is not served");
  assert.equal(await txServedElsewhere(ARC_CAIP2, fresh, "another-request"), true, "and once checked it is held, so nothing serves it afterwards");
  __resetSettlementClaims();
});

{
  const { createCirclePendingBook, MAX_PASS_MS, RECONCILE_LEASE_MS, UNREADABLE_LIMIT } = await import("../src/circle-pending.js");
  const pendingDir = mkdtempSync(join(tmpdir(), "a402-circle-pending-"));
  let clock = 1_000_000;
  const now = () => clock;
  const nonce = (i) => `0x${i.toString(16).padStart(64, "0")}`;
  const uuid = (i) => `11111111-2222-4333-8444-${i.toString(16).padStart(12, "0")}`;
  const bookFile = (name) => join(pendingDir, `${name}.json`);
  const finalTx = `0x${"9a".repeat(32)}`;

  {
    const owed = [];
    const recorded = new Set();
    const book = createCirclePendingBook({ file: bookFile("a"), now, log: () => {},
      recordOwed: async (row) => { owed.push(row); recorded.add(row.tx); return true; },
      owedRecorded: async (tx) => recorded.has(tx) });
    const ids = { done: 1, fail: 2, wait: 3 };
    for (const [, i] of Object.entries(ids)) await book.book({ paymentId: uuid(i), payer: acct.address, network: ARC_CAIP2, nonce: nonce(i), amount: "2500", resource: "https://agent402.tools/api/uuid" });
    await book.book({ paymentId: uuid(1), payer: acct.address, network: ARC_CAIP2, nonce: nonce(1), amount: "2500" });
    await book.book({ paymentId: "../../not-a-uuid", payer: acct.address, network: ARC_CAIP2, nonce: nonce(9), amount: "1" });
    await book.book({ paymentId: uuid(8), payer: acct.address, network: ARC_CAIP2, amount: "1" });
    clock += 2 * 60_000;
    const statusOf = { [uuid(1)]: { status: "completed", transaction: finalTx }, [uuid(2)]: { status: "failed", transaction: null }, [uuid(3)]: { status: "pending", transaction: null } };
    const r = await book.reconcile({ status: async (id) => statusOf[id] || null });
    await check("pending book: keyed by authorization (one entry per nonce), a bad id or a missing nonce is never booked", () => {
      assert.equal(r.checked, 3);
    });
    await check("reconcile: a late completion becomes an owed refund keyed by its settlement tx, dropped once the ledger holds it", () => {
      assert.equal(r.owed, 1);
      assert.equal(owed.length, 1);
      assert.equal(owed[0].tx, finalTx);
      assert.equal(owed[0].payer.toLowerCase(), acct.address.toLowerCase());
      assert.equal(owed[0].priceUsd, 0.0025);
      assert.equal(owed[0].slug, "uuid");
    });
    await check("reconcile: failed owes nothing and is dropped; pending is kept; the book survives a reload", () => {
      assert.equal(r.failed, 1);
      assert.equal(r.pending, 1);
      assert.deepEqual(book.list().map((e) => e.paymentId), [uuid(3)]);
      const again = createCirclePendingBook({ file: bookFile("a"), now, log: () => {} });
      assert.deepEqual(again.list().map((e) => e.paymentId), [uuid(3)]);
    });
  }

  await check("reconcile: a completion whose tx was served after all is NOT booked owed (served and refunded never both)", async () => {
    const owed = [];
    const book = createCirclePendingBook({ file: bookFile("b"), now, log: () => {}, recordOwed: async (row) => { owed.push(row); return true; }, owedRecorded: async () => true,
      wasServed: async ({ tx }) => tx === finalTx });
    await book.book({ paymentId: uuid(20), payer: acct.address, network: ARC_CAIP2, nonce: nonce(20), amount: "1000" });
    clock += 2 * 60_000;
    const r = await book.reconcile({ status: async () => ({ status: "completed", transaction: finalTx }) });
    assert.equal(r.served, 1);
    assert.equal(owed.length, 0);
    assert.equal(book.list().length, 0);
  });

  await check("reconcile: an owed write that did not land keeps the entry for the next pass", async () => {
    let landed = false;
    const book = createCirclePendingBook({ file: bookFile("c"), now, log: () => {}, recordOwed: async () => false, owedRecorded: async () => landed });
    await book.book({ paymentId: uuid(30), payer: acct.address, network: ARC_CAIP2, nonce: nonce(30), amount: "1000" });
    clock += 2 * 60_000;
    await book.reconcile({ status: async () => ({ status: "completed", transaction: finalTx }) });
    assert.equal(book.list().length, 1, "not dropped on an unconfirmed write");
    landed = true;
    clock += 2 * 60_000;
    const r = await book.reconcile({ status: async () => ({ status: "completed", transaction: finalTx }) });
    assert.equal(r.owed, 1);
    assert.equal(book.list().length, 0);
  });

  await check("reconcile: oldest-due first with a per-entry next check, so a stuck entry never starves newer ones", async () => {
    const book = createCirclePendingBook({ file: bookFile("d"), now, log: () => {}, recordOwed: async () => true, owedRecorded: async () => true });
    for (let i = 0; i < 60; i++) { await book.book({ paymentId: uuid(100 + i), payer: acct.address, network: ARC_CAIP2, nonce: nonce(100 + i), amount: "1" }); clock += 1; }
    clock += 2 * 60_000;
    const seen = new Set();
    const status = async (id) => { seen.add(id); return null; }; // all unreadable
    await book.reconcile({ status, maxChecks: 25 });
    await book.reconcile({ status, maxChecks: 25 });
    await book.reconcile({ status, maxChecks: 25 });
    assert.equal(seen.size, 60, `every entry got a turn across passes (${seen.size}/60)`);
  });

  await check("reconcile: repeated unreadable answers move an entry to unresolved (kept, never dropped) and the alarm word says so", async () => {
    const book = createCirclePendingBook({ file: bookFile("e"), now, log: () => {} });
    await book.book({ paymentId: uuid(200), payer: acct.address, network: ARC_CAIP2, nonce: nonce(200), amount: "1" });
    assert.equal(book.alarmStatus(), "ok");
    for (let i = 0; i < UNREADABLE_LIMIT + 2; i++) { clock += 7 * 3600_000; await book.reconcile({ status: async () => null }); }
    assert.equal(book.list().length, 1, "never silently dropped");
    assert.equal(book.list()[0].state, "unresolved");
    assert.equal(book.alarmStatus(), "unresolved");
  });

  await check("pending book: bounded, near_capacity before the bound and full at it (a refusal is logged, not a silent replacement)", async () => {
    const logs = [];
    const book = createCirclePendingBook({ file: bookFile("f"), now, log: (m) => logs.push(m), maxEntries: 5 });
    for (let i = 0; i < 4; i++) await book.book({ paymentId: uuid(300 + i), payer: acct.address, network: ARC_CAIP2, nonce: nonce(300 + i), amount: "1" });
    assert.equal(book.alarmStatus(), "near_capacity");
    await book.book({ paymentId: uuid(304), payer: acct.address, network: ARC_CAIP2, nonce: nonce(304), amount: "1" });
    assert.equal(await book.book({ paymentId: uuid(305), payer: acct.address, network: ARC_CAIP2, nonce: nonce(305), amount: "1" }), false);
    assert.equal(book.list().length, 5);
    assert.equal(book.alarmStatus(), "full");
    assert.ok(logs.some((l) => /full/.test(l)));
  });

  await check("reconcile: a pass is bounded by time, and the lease outlasts the worst pass", async () => {
    const book = createCirclePendingBook({ file: bookFile("g"), now, log: () => {} });
    for (let i = 0; i < 10; i++) await book.book({ paymentId: uuid(400 + i), payer: acct.address, network: ARC_CAIP2, nonce: nonce(400 + i), amount: "1" });
    clock += 2 * 60_000;
    const r = await book.reconcile({ status: async () => { clock += 60_000; return null; }, maxPassMs: 3 * 60_000 });
    assert.ok(r.checked <= 4, `stopped at the time budget (${r.checked} checked)`);
    assert.ok(RECONCILE_LEASE_MS >= MAX_PASS_MS + 15_000 + 30_000, "the lease covers the pass budget plus one status call and margin");
  });
  rmSync(pendingDir, { recursive: true, force: true });
}

for (const [label, resp, wantReason] of [
  ["HTTP 500 HTML echoing the key", () => new Response(`<b>${MARKER}</b> ${KEY}`, { status: 500, headers: { "content-type": "text/html" } }), "non_json_response"],
  ["HTTP 403 JSON with a message echoing the key", () => json(403, { code: 403, message: `${KEY} ${MARKER}`, errors: [{ reason: "registration_required" }] }), "registration_required"],
  ["HTTP 409 JSON with an unsafe reason", () => json(409, { code: 409, message: MARKER, errors: [{ reason: `${MARKER}<img>` }] }), "circle_http_409"],
  ["HTTP 502 JSON without a reason", () => json(502, { code: 502, message: `${MARKER} ${KEY}` }), "circle_http_502"],
  ["HTTP 200 success without a transaction", () => json(200, { success: true, transaction: MARKER, network: ARC_CAIP2, payer: acct.address }), "invalid_settle_response"],
  ["HTTP 200 success naming another network", () => json(200, { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453", payer: acct.address }), "invalid_settle_response"],
]) {
  await check(`settle error (${label}) is reduced to a status and '${wantReason}'`, async () => {
    const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/settle": resp }) });
    let err = null;
    try { await c.settle(await signed(), arcReq()); } catch (e) { err = e; }
    assert.ok(err, "a non-2xx or unprovable settle throws");
    assert.equal(err.errorReason, wantReason);
    const shown = `${err.message} ${err.stack} ${inspect(err)} ${JSON.stringify(err)}`;
    assert.ok(!leaks(shown), `no upstream body or key in the error: ${err.message}`);
  });
}

await check("a verify 5xx is reduced too", async () => {
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/verify": () => new Response(`${MARKER} ${KEY}`, { status: 503, headers: { "content-type": "text/plain" } }) }) });
  let err = null;
  try { await c.verify(await signed(), arcReq()); } catch (e) { err = e; }
  assert.ok(err);
  assert.ok(!leaks(`${err.message} ${inspect(err)}`));
});

await check("a 200 {success:false} reason from Circle is passed only when it is a safe code", async () => {
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/settle": () => json(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: ARC_CAIP2, payer: acct.address }) }) });
  const s = await c.settle(await signed(), arcReq());
  assert.equal(s.errorReason, "insufficient_funds");
  assert.equal(safeReason(`x ${MARKER}`), "circle_unrecognized_reason");
});

await check("settlement_pending is reconciled through /status until completed", async () => {
  const id = "5b3f6c1e-9d2a-4f08-b1c7-2e9a14d0c3aa";
  let polls = 0;
  const f = stubFetch({
    "/settle": () => json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: ARC_CAIP2, payer: acct.address, extensions: { "settlement-status": { status: "pending", paymentId: id } } }),
    "/status/:id": () => (++polls < 2 ? json(200, { paymentId: id, status: "pending", network: ARC_CAIP2 }) : json(200, { paymentId: id, status: "completed", network: ARC_CAIP2, transaction: `0x${"cd".repeat(32)}` })),
  });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f, pendingPollMs: 5, pendingBudgetMs: 2000 });
  const s = await c.settle(await signed(), arcReq());
  assert.equal(s.success, true);
  assert.equal(s.transaction, `0x${"cd".repeat(32)}`);
  const statusCall = f.calls.find((x) => x.url.includes("/status/"));
  assert.equal(statusCall.url, `${CIRCLE_FACILITATOR_BASE}/status/${id}`);
  assert.equal(statusCall.init.headers.Authorization, `Bearer ${KEY}`);
});

await check("a pending answer with a non-UUID paymentId is never interpolated into a path", async () => {
  const f = stubFetch({ "/settle": () => json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: ARC_CAIP2, extensions: { "settlement-status": { paymentId: "../../v1/w3s/wallets" } } }) });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f, pendingPollMs: 5, pendingBudgetMs: 50 });
  const s = await c.settle(await signed(), arcReq());
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "settlement_pending");
  assert.equal(f.calls.length, 1, "no /status call");
});

await check("a pending payment that stays pending is reported unsettled, never as settled", async () => {
  const id = "5b3f6c1e-9d2a-4f08-b1c7-2e9a14d0c3ab";
  const f = stubFetch({
    "/settle": () => json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: ARC_CAIP2, extensions: { "settlement-status": { paymentId: id } } }),
    "/status/:id": () => json(200, { paymentId: id, status: "pending", network: ARC_CAIP2 }),
  });
  const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f, pendingPollMs: 5, pendingBudgetMs: 60 });
  const s = await c.settle(await signed(), arcReq());
  assert.equal(s.success, false);
});

await check("a timeout and a network error keep the 'may have broadcast' shape (no settle fallback)", async () => {
  const { isPreBroadcastSettleRejection, fallbackCandidatesFor } = await import("../src/payments.js");
  const slow = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); } });
  let e1 = null; try { await slow.settle(await signed(), arcReq()); } catch (e) { e1 = e; }
  assert.ok(e1 && !isPreBroadcastSettleRejection(e1));
  const down = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: async () => { throw new TypeError(`fetch failed ${MARKER}`); } });
  let e2 = null; try { await down.settle(await signed(), arcReq()); } catch (e) { e2 = e; }
  assert.ok(e2 && !isPreBroadcastSettleRejection(e2) && !leaks(e2.message));
  assert.deepEqual(fallbackCandidatesFor(ARC_CAIP2, { settle() {} }, { settle() {} }, { [ARC_CAIP2]: [] }), [], "Arc names no fallback facilitator");
});

await check("paid canary: the Arc leg is gated (absent from the 402 = skipped, not a rail failure); its funding check follows the shared low-water rule", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./paid-canary.js", import.meta.url), "utf8");
  assert.match(src, /\{ key: "arc", caip2: "eip155:5042",[^}]*gated: true/);
  const skipAt = src.indexOf("if (!accepts.length && leg.gated)");
  const failAt = src.indexOf("NOT among the live 402 accepts", skipAt);
  assert.ok(skipAt > 0 && failAt > skipAt, "the gated skip runs before the dropped-rail failure");
  const { CHAIN_FUNDING, chainLowWaterReport } = await import("./paid-canary.js");
  const arc = CHAIN_FUNDING.find((c) => c.key === "arc");
  assert.ok(arc && arc.lowWater === undefined, "Arc funding has no special threshold");
  const r = chainLowWaterReport([{ key: "arc", label: "Arc", usd: 0.1 }, { key: "sei", label: "Sei", usd: 0.1 }], { chainLowWater: 0.5 });
  assert.deepEqual(r.low.map((x) => x.key).sort(), ["arc", "sei"], "a low Arc balance pages exactly like a low Sei balance");
});

// ------------------------------------------------ contract wallets (switch)
{
  const { createContractVerifier, arcContractWalletsEnabled, circleClientFromEnv } = await import("../src/circle-facilitator.js");
  const { registerArcContractWalletRouteGate, ARC_CONTRACT_WALLET_ROUTE_REASON } = await import("../src/payments.js");
  const SCW = "0x00000000000000000000000000000000000c0de1";
  const contractSigned = async (signature) => {
    const p = await signed();
    p.payload.authorization.from = SCW;
    p.payload.signature = signature;
    return p;
  };
  const SIG_1271 = `0x${"ab".repeat(96)}`;
  const MAGIC_6492 = "6492649264926492649264926492649264926492649264926492649264926492";
  const SIG_6492 = `0x${"cd".repeat(160)}${MAGIC_6492}`;
  // A stubbed public client: records every verifyTypedData call and answers per mode.
  const stubClient = (mode) => {
    const calls = [];
    return {
      calls,
      async verifyTypedData(args) {
        calls.push(args);
        if (mode === "valid") return true;
        if (mode === "invalid") return false;
        if (mode === "error") throw new Error(`rpc says no ${MARKER}`);
        return new Promise(() => {}); // "hang": never answers
      },
    };
  };

  await check("switch: only ARC_CONTRACT_WALLETS=on turns contract wallets on", () => {
    assert.equal(arcContractWalletsEnabled({}), false);
    assert.equal(arcContractWalletsEnabled({ ARC_CONTRACT_WALLETS: "true" }), false);
    assert.equal(arcContractWalletsEnabled({ ARC_CONTRACT_WALLETS: "1" }), false);
    assert.equal(arcContractWalletsEnabled({ ARC_CONTRACT_WALLETS: "on" }), true);
  });

  await check("switch off: a contract-wallet signature is refused as before, with no RPC call", async () => {
    const pc = stubClient("valid");
    const c = circleClientFromEnv({ CIRCLE_FACILITATOR_API_KEY: KEY }, { contractVerifier: createContractVerifier({ publicClient: pc }) });
    const v = await c.verify(await contractSigned(SIG_1271), arcReq());
    assert.equal(v.isValid, false);
    assert.equal(v.invalidReason, "invalid_exact_evm_payload_signature");
    assert.equal(pc.calls.length, 0, "the verifier is not even wired with the switch off");
  });

  const onClient = (pc, fetchImpl, timeoutMs) => circleClientFromEnv(
    { CIRCLE_FACILITATOR_API_KEY: KEY, ARC_CONTRACT_WALLETS: "on" },
    { contractVerifier: createContractVerifier({ publicClient: pc, ...(timeoutMs ? { timeoutMs } : {}) }), fetchImpl },
  );
  const okFetch = () => stubFetch({ "/verify": () => json(200, { isValid: true, payer: SCW }), "/settle": () => json(200, { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC_CAIP2, payer: SCW }) });

  await check("switch on + ERC-1271 valid: passes the local gate and reaches Circle; settle reuses the verdict (one RPC call)", async () => {
    const pc = stubClient("valid");
    const f = okFetch();
    const c = onClient(pc, f);
    const p = await contractSigned(SIG_1271);
    assert.equal((await c.verify(p, arcReq())).isValid, true);
    assert.equal((await c.settle(p, arcReq())).success, true);
    assert.equal(pc.calls.length, 1, "verify and settle share one on-chain check");
    assert.equal(pc.calls[0].address, SCW);
    assert.equal(pc.calls[0].domain.chainId, 5042, "verified under Arc's own domain");
    assert.equal(pc.calls[0].domain.verifyingContract, ARC_USDC.asset);
    assert.equal(f.calls.filter((x) => x.url.endsWith("/verify")).length, 1);
  });

  await check("switch on + ERC-1271 invalid: refused before Circle", async () => {
    const pc = stubClient("invalid");
    const f = okFetch();
    const v = await onClient(pc, f).verify(await contractSigned(SIG_1271), arcReq());
    assert.equal(v.isValid, false);
    assert.equal(v.invalidReason, "invalid_exact_evm_payload_signature");
    assert.equal(f.calls.length, 0);
  });

  for (const mode of ["error", "hang"]) {
    await check(`switch on + RPC ${mode === "hang" ? "timeout" : "error"}: refused with a clean reason (a 402, never a 500 or a pass), not cached`, async () => {
      const pc = stubClient(mode);
      const f = okFetch();
      const c = onClient(pc, f, 60);
      const p = await contractSigned(SIG_1271);
      const v = await c.verify(p, arcReq());
      assert.equal(v.isValid, false);
      assert.equal(v.invalidReason, "contract_signature_unverifiable");
      assert.ok(!leaks(JSON.stringify(v)));
      const s = await c.settle(p, arcReq());
      assert.equal(s.success, false);
      assert.equal(pc.calls.length, 2, "a failed check is retried, never remembered as a pass");
      assert.equal(f.calls.length, 0);
    });
  }

  await check("switch on + ERC-6492 wrapped signature: handed to the universal validator unchanged", async () => {
    const pc = stubClient("valid");
    const c = onClient(pc, okFetch());
    const v = await c.verify(await contractSigned(SIG_6492), arcReq());
    assert.equal(v.isValid, true);
    assert.equal(pc.calls.length, 1);
    assert.equal(pc.calls[0].signature, SIG_6492, "the wrapped signature (factory data + magic suffix) goes to the validator as signed");
  });

  await check("switch on + EOA signature: verified locally, zero RPC calls", async () => {
    const pc = stubClient("valid");
    const c = onClient(pc, okFetch());
    assert.equal((await c.verify(await signed(), arcReq())).isValid, true);
    assert.equal(pc.calls.length, 0);
    // A Base-domain EOA signature is not an EOA signature for Arc: with the
    // switch on it goes to the on-chain check, which an EOA cannot pass.
    const refuse = onClient(stubClient("invalid"), okFetch());
    assert.equal((await refuse.verify(await signed({ chainId: 8453 }), arcReq())).isValid, false);
  });

  await check("the default verifier calls the Arc RPC constant (no request input names it)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/circle-facilitator.js", import.meta.url), "utf8");
    assert.match(src, /createContractVerifier\(\{ rpcUrl: EVM_RPCS\[ARC_CAIP2\] \}\)/);
  });

  // Identity-bound routes: a contract wallet's authorization.from is the
  // contract's address, and who may sign for it is whatever its
  // isValidSignature says at that moment. Those routes take EOAs only.
  const gate = () => {
    const hooks = [];
    registerArcContractWalletRouteGate({ onBeforeVerify: (h) => hooks.push(h) }, new Set(["GET /api/uuid", "GET /api/demand-radar"]));
    return hooks[0];
  };
  const ctxFor = async (method, path, payload) => ({ requirements: arcReq(), paymentPayload: payload, transportContext: path ? { request: { adapter: { req: { method, path } } } } : undefined });
  await check("identity-bound routes refuse a contract-wallet payment before verification", async () => {
    const h = gate();
    for (const [m, p] of [["POST", "/api/memory"], ["POST", "/api/attest"], ["POST", "/api/feedback"], ["GET", "/api/my-usage"]]) {
      const r = await h(await ctxFor(m, p, await contractSigned(SIG_1271)));
      assert.equal(r?.abort, true, `${m} ${p} refuses`);
      assert.equal(r.reason, ARC_CONTRACT_WALLET_ROUTE_REASON);
    }
    const unknown = await h(await ctxFor(null, null, await contractSigned(SIG_1271)));
    assert.equal(unknown?.abort, true, "a request the gate cannot place is refused too");
  });
  await check("the route gate passes a contract wallet on a non-identity route, and every EOA everywhere", async () => {
    const h = gate();
    assert.equal(await h(await ctxFor("GET", "/api/uuid", await contractSigned(SIG_1271))), undefined);
    assert.equal(await h(await ctxFor("POST", "/api/memory", await signed())), undefined);
    const base = await h({ requirements: { ...arcReq(), network: "eip155:8453" }, paymentPayload: await contractSigned(SIG_1271) });
    assert.equal(base, undefined, "other chains are untouched by the Arc gate");
  });
}

// ---------------------------------------------------------------- part 2
console.log("part 2: the paid server");

const [P_PAYAI, P_CIRCLE, ...SERVER_PORTS] = await getFreePorts(14);
const st = { payai: "ok", circle: "full", circleHits: [], payaiHits: [], rpcHits: [] };
const rawJson = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });
const payaiStub = createServer(async (req, res) => {
  const body = await readBody(req);
  st.payaiHits.push({ url: req.url, body });
  if (req.url === "/supported") {
    if (st.payai === "die") { res.writeHead(500, { Connection: "close" }); return res.end("down"); }
    // payaiArc: a general facilitator that starts advertising Arc. It must
    // never be routed an Arc payment (only Circle's client may claim Arc).
    const kinds = [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }];
    if (st.payaiArc) kinds.push({ x402Version: 2, scheme: "exact", network: ARC_CAIP2 }, { x402Version: 2, scheme: "exact", network: "eip155:5042002" });
    return rawJson(res, 200, { kinds, extensions: [], signers: {} });
  }
  if (req.url === "/verify" && body?.paymentRequirements?.network === ARC_CAIP2) return rawJson(res, 200, { isValid: true, payer: body?.paymentPayload?.payload?.authorization?.from });
  if (req.url === "/settle" && body?.paymentRequirements?.network === ARC_CAIP2) return rawJson(res, 200, { success: true, transaction: `0x${"77".repeat(32)}`, network: ARC_CAIP2, payer: body?.paymentPayload?.payload?.authorization?.from });
  if (req.url === "/verify") return rawJson(res, 200, { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" });
  return rawJson(res, 404, {});
});
const circleStub = createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.url === "/rpc") { st.rpcHits.push(body); return rawJson(res, 200, { jsonrpc: "2.0", id: body?.id ?? 1, error: { code: -32000, message: "stub rpc refuses" } }); }
  st.circleHits.push({ url: req.url, auth: req.headers.authorization || "", body });
  if (req.url === "/supported") {
    if (st.circle === "die") { res.writeHead(500, { "Content-Type": "text/html", Connection: "close" }); return res.end(`<html>${MARKER} key=${KEY}</html>`); }
    if (st.circle === "malformed") return rawJson(res, 200, { kinds: `${MARKER}` });
    return rawJson(res, 200, st.circle === "noarc" ? SUPPORTED_NO_ARC : SUPPORTED_FULL);
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) return rawJson(res, 401, { code: 401, message: "missing key" });
  if (req.url === "/verify") return rawJson(res, 200, { isValid: true, payer: body?.paymentPayload?.payload?.authorization?.from });
  if (req.url === "/settle") {
    if (st.settle === "html500") { res.writeHead(500, { "Content-Type": "text/html", Connection: "close" }); return res.end(`<html>${MARKER} ${KEY}</html>`); }
    return rawJson(res, 200, { success: true, transaction: `0x${"ef".repeat(32)}`, network: ARC_CAIP2, payer: body?.paymentPayload?.payload?.authorization?.from });
  }
  return rawJson(res, 404, {});
});
await Promise.all([[payaiStub, P_PAYAI], [circleStub, P_CIRCLE]].map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));

const tmp = mkdtempSync(join(tmpdir(), "a402-arc-rail-"));
const preload = join(tmp, "circle-redirect.mjs");
writeFileSync(preload, `
const BASE = ${JSON.stringify(CIRCLE_FACILITATOR_BASE)};
const STUB = process.env.ARC_TEST_CIRCLE_STUB;
const real = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
  if (STUB && typeof u === "string" && u.startsWith(BASE)) return real(STUB + u.slice(BASE.length), init);
  // The Arc RPC (contract-wallet checks) goes to the same stub, counted there.
  if (STUB && typeof u === "string" && u.startsWith("https://rpc.mainnet.arc.io")) return real(STUB + "/rpc", init);
  return real(input, init);
};
`);

let portIdx = 0;
async function boot(extraEnv) {
  const port = SERVER_PORTS[portIdx++];
  const env = { ...process.env };
  delete env.STATE_DATABASE_URL;
  delete env.CIRCLE_FACILITATOR_API_KEY;
  const proc = spawn(process.execPath, ["--import", preload, "src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...env, PORT: String(port), FREE_MODE: "",
      WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base,arc",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "",
      PAYAI_FACILITATOR_URL: `http://127.0.0.1:${P_PAYAI}`, PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      ARC_TEST_CIRCLE_STUB: `http://127.0.0.1:${P_CIRCLE}`,
      SOLVADOR_KEY: "", PAYMENT_SETTLE_FALLBACK: "", X402_UPTO_NETWORKS: "", POSTHOG_API_KEY: "", MPP_SECRET_KEY: "",
      SALES_LEDGER_DB: join(tmp, `sales-${port}.db`), INFLIGHT_COVER: "off", CIRCLE_PENDING_FILE: join(tmp, `circle-pending-${port}.json`), GATED_RAIL_HISTORY_FILE: join(tmp, `gated-history-${port}.json`),
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = { text: "" };
  proc.stdout.on("data", (c) => { log.text += c; });
  proc.stderr.on("data", (c) => { log.text += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { base, log, proc }; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill("SIGKILL");
  throw new Error(`server never became healthy: ${log.text.slice(-600)}`);
}
const PATH = "/api/demand-radar?limit=1";
const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
async function surfaces(base) {
  const out = [];
  for (const p of ["/health", "/api/rails", "/.well-known/x402", "/api/gateway-status", "/api/pricing", PATH]) {
    const r = await fetch(`${base}${p}`);
    out.push(`${p} ${r.status} ${JSON.stringify(Object.fromEntries(r.headers))} ${await r.text()}`);
    const pr = r.headers.get("payment-required");
    if (pr) out.push(JSON.stringify(decode(pr)));
  }
  return out.join("\n");
}
async function offeredNets(base) {
  const r = await fetch(`${base}${PATH}`);
  assert.equal(r.status, 402, `unpaid paid route answers 402 (got ${r.status})`);
  return { nets: new Set(decode(r.headers.get("payment-required")).accepts.map((a) => a.network)), env: decode(r.headers.get("payment-required")) };
}
const noLeak = async (leg, base, log) => {
  const all = `${await surfaces(base)}\n${log.text}`;
  assert.ok(!leaks(all), `${leg}: the key or an upstream body appeared in a response or log line`);
};

// The runtime surfaces that may name Arc, read once per leg.
async function arcSurfaces(base) {
  const page = (await fetch(`${base}/arc`)).status;
  const panel = (await fetch(`${base}/api/market/arc/panel`)).status;
  const manifest = await (await fetch(`${base}/.well-known/x402`)).json();
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  const howToPay = await (await fetch(`${base}/how-to-pay`)).text();
  const home = await (await fetch(`${base}/`)).text();
  return {
    page, panel,
    chains: manifest.ecosystem?.chains || [],
    sitemap: /\/arc<\/loc>/.test(sitemap),
    howToPay: /\bArc\b/.test(howToPay),
    nav: /href="\/arc"/.test(home),
  };
}
const assertArcHidden = (s, leg) => {
  assert.equal(s.page, 404, `${leg}: /arc is not served (got ${s.page})`);
  assert.equal(s.panel, 404, `${leg}: the Arc market panel is not served`);
  assert.ok(!s.chains.includes("Arc"), `${leg}: the manifest's chains do not name Arc (${s.chains})`);
  assert.ok(!s.sitemap && !s.howToPay && !s.nav, `${leg}: no sitemap entry, how-to-pay mention or nav link (${JSON.stringify(s)})`);
};

// Leg A: no key. Arc absent, the server serves, nothing errors.
await check("key unset: Arc is absent, the 402 still serves, a warning names the drop, no Circle call", async () => {
  st.circle = "full"; st.circleHits = [];
  const { base, log, proc } = await boot({ PAYMENT_NETWORKS: "base,polygon,arc" });
  try {
    const { nets } = await offeredNets(base);
    assert.ok(nets.has("eip155:8453") && !nets.has(ARC_CAIP2), `accepts: ${[...nets]}`);
    assert.match(log.text, /CIRCLE_FACILITATOR_API_KEY is unset - Arc is not configured/);
    assert.equal(st.circleHits.length, 0, "no request to Circle without a key");
    const rails = await (await fetch(`${base}/api/rails`)).json();
    assert.ok(!JSON.stringify(rails).includes("arc"), "/api/rails does not count Arc as configured without the key");
    assertArcHidden(await arcSurfaces(base), "key unset");
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    assert.ok(!/RouteConfigurationError|Unhandled|TypeError/.test(log.text), "no errors in the boot log");
  } finally { proc.kill("SIGKILL"); }
});

// Leg B: key set, Circle lists Arc.
await check("key set + Arc listed: the Arc accept is offered, bound to Arc USDC, the treasury and the Base amount", async () => {
  st.circle = "full"; st.circleHits = []; st.settle = "ok"; st.payaiArc = true; st.payaiHits = [];
  const { base, log, proc } = await boot({ CIRCLE_FACILITATOR_API_KEY: KEY });
  try {
    const surf = await arcSurfaces(base);
    assert.equal(surf.page, 200, "/arc is served once Arc is offered");
    assert.ok(surf.chains.includes("Arc"), `the manifest names Arc (${surf.chains})`);
    assert.ok(surf.sitemap && surf.howToPay && surf.nav, `sitemap, how-to-pay and nav name Arc (${JSON.stringify(surf)})`);
    const { env } = await offeredNets(base);
    const arc = env.accepts.find((a) => a.network === ARC_CAIP2 && a.scheme === "exact");
    const baseAcc = env.accepts.find((a) => a.network === "eip155:8453" && a.scheme === "exact");
    assert.ok(arc, "an Arc exact accept");
    assert.equal(arc.asset.toLowerCase(), ARC_USDC.asset.toLowerCase());
    assert.equal(arc.payTo.toLowerCase(), TREASURY.toLowerCase());
    assert.equal(arc.amount, baseAcc.amount, "same price as the Base accept");
    assert.equal(arc.extra?.name, "USDC");
    assert.equal(arc.extra?.version, "2");
    const supportedHits = st.circleHits.filter((h) => h.url === "/supported");
    assert.ok(supportedHits.length >= 1 && supportedHits.every((h) => h.auth === ""), "/supported was probed without the key");

    const rails = await (await fetch(`${base}/api/rails`)).json();
    assert.ok(JSON.stringify(rails).includes("arc"), "/api/rails lists the Arc rail");

    // A correctly signed Arc payment verifies and settles through Circle.
    const pay = async (p) => fetch(`${base}${PATH}`, { headers: { "payment-signature": Buffer.from(JSON.stringify({ ...p, resource: env.resource })).toString("base64") } });
    const good = await signed({ req: arc, value: arc.amount });
    const r = await pay(good);
    await r.text();
    assert.equal(r.status, 200, `a valid Arc payment is served (got ${r.status})`);
    const v = st.circleHits.find((h) => h.url === "/verify");
    const s = st.circleHits.find((h) => h.url === "/settle");
    assert.ok(v && s, "Circle verified and settled");
    for (const h of [v, s]) {
      assert.equal(h.auth, `Bearer ${KEY}`);
      assert.equal(h.body.paymentRequirements.network, ARC_CAIP2);
      assert.equal(h.body.paymentRequirements.asset.toLowerCase(), ARC_USDC.asset.toLowerCase());
      assert.equal(h.body.paymentRequirements.payTo.toLowerCase(), TREASURY.toLowerCase());
      assert.equal(h.body.paymentRequirements.amount, arc.amount);
    }
    const receipt = decode(r.headers.get("payment-response"));
    assert.equal(receipt.network, ARC_CAIP2);

    // Cross-chain replay and tampering: refused, Circle never sees them.
    const hitsBefore = st.circleHits.length;
    for (const bad of [
      await signed({ req: arc, value: arc.amount, chainId: 8453 }),
      await signed({ req: arc, value: arc.amount, chainId: 5042002 }),
      await signed({ req: arc, value: String(BigInt(arc.amount) - 1n) }),
      await signed({ req: arc, value: arc.amount, to: "0x0000000000000000000000000000000000000bad" }),
    ]) {
      const rr = await pay(bad);
      await rr.text();
      assert.equal(rr.status, 402, `a tampered or cross-chain Arc payment is refused (got ${rr.status})`);
    }
    assert.equal(st.circleHits.length, hitsBefore, "none of them reached Circle");
    // The PayAI stub advertises Arc (and would approve and settle it): no Arc
    // payment, good or tampered, was ever routed to it.
    assert.ok(!st.payaiHits.some((h) => (h.url === "/verify" || h.url === "/settle") && String(h.body?.paymentRequirements?.network || "").startsWith("eip155:5042")),
      "a general facilitator advertising Arc is never routed an Arc payment");

    // An Arc-signed authorization presented against the BASE requirement goes
    // to the Base facilitator, never to Circle, and is not served.
    const asBase = await signed({ req: baseAcc, value: baseAcc.amount });
    const rb = await pay(asBase);
    await rb.text();
    assert.equal(rb.status, 402);
    assert.equal(st.circleHits.length, hitsBefore, "a Base requirement never reaches Circle");
    assert.ok(st.payaiHits.some((h) => h.url === "/verify" && h.body?.paymentRequirements?.network === "eip155:8453"), "it was judged by the Base facilitator");

    // Circle failing at settle with the key echoed in HTML: not served, not leaked.
    st.settle = "html500";
    const rf = await pay(await signed({ req: arc, value: arc.amount }));
    const rfText = await rf.text();
    assert.equal(rf.status, 402);
    assert.ok(!leaks(`${rfText} ${JSON.stringify(Object.fromEntries(rf.headers))}`), "the buyer's 402 carries no upstream body or key");
    await new Promise((r2) => setTimeout(r2, 300));
    await noLeak("key set", base, log);
  } finally { proc.kill("SIGKILL"); st.payaiArc = false; }
});

// A general facilitator advertising Arc while Circle does not list it: Arc
// must still be dropped (it is Circle's alone), not handed to that facilitator.
await check("a non-Circle facilitator advertising Arc cannot keep Arc in the offer when Circle drops it", async () => {
  st.circle = "noarc"; st.payaiArc = true;
  const { base, proc } = await boot({ CIRCLE_FACILITATOR_API_KEY: KEY });
  try {
    const { nets } = await offeredNets(base);
    assert.ok(nets.has("eip155:8453") && !nets.has(ARC_CAIP2), `accepts: ${[...nets]}`);
    assertArcHidden(await arcSurfaces(base), "Arc advertised only by PayAI");
  } finally { proc.kill("SIGKILL"); st.payaiArc = false; }
});

await check("key set: Arc joins a multi-chain list without an `arc` entry in PAYMENT_NETWORKS", async () => {
  st.circle = "full";
  const { base, proc } = await boot({ CIRCLE_FACILITATOR_API_KEY: KEY, PAYMENT_NETWORKS: "base,polygon" });
  try {
    const { nets } = await offeredNets(base);
    assert.ok(nets.has(ARC_CAIP2), `accepts: ${[...nets]}`);
  } finally { proc.kill("SIGKILL"); }
});

await check("an Arc that WAS offered on an earlier boot and is now not listed by Circle still reads degraded on /api/rails", async () => {
  st.circle = "noarc";
  const hist = join(tmp, "gated-history-seeded.json");
  writeFileSync(hist, JSON.stringify({ offered: { [ARC_CAIP2]: Date.now() - 86_400_000 } }));
  const { base, proc } = await boot({ CIRCLE_FACILITATOR_API_KEY: KEY, GATED_RAIL_HISTORY_FILE: hist });
  try {
    const rails = await (await fetch(`${base}/api/rails`)).json();
    const row = (rails.rails || []).find((r) => r.network === "arc");
    assert.ok(row && row.offered === false, `the dropped rail is listed as not offered (${JSON.stringify(rails.rails)})`);
    assert.ok(rails.degraded >= 1, "and counts as degraded, so the heartbeat alarms");
  } finally { proc.kill("SIGKILL"); st.circle = "full"; }
});

// Contract wallets switched on: an identity-bound route refuses a contract
// wallet before verification (no RPC call); another route asks the Arc RPC,
// and an RPC failure is a clean 402, never a pass and never reaching Circle.
await check("switch on, booted: identity-bound routes refuse a contract wallet with no RPC call; an RPC failure elsewhere is a 402", async () => {
  st.circle = "full"; st.circleHits = []; st.rpcHits = [];
  const { base, log, proc } = await boot({ CIRCLE_FACILITATOR_API_KEY: KEY, ARC_CONTRACT_WALLETS: "on" });
  try {
    assert.match(log.text, /contract-wallet signatures accepted \(ARC_CONTRACT_WALLETS=on\), except on identity-bound routes/);
    const SCW = "0x00000000000000000000000000000000000c0de1";
    const payWith = async (method, path, body) => {
      const bare = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body });
      const env = decode(bare.headers.get("payment-required"));
      await bare.text();
      const arc = env.accepts.find((a) => a.network === ARC_CAIP2 && a.scheme === "exact");
      assert.ok(arc, `${path} offers Arc`);
      const p = await signed({ req: arc, value: arc.amount });
      p.payload.authorization.from = SCW;
      p.payload.signature = `0x${"ab".repeat(96)}`;
      const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", "payment-signature": Buffer.from(JSON.stringify({ ...p, resource: env.resource })).toString("base64") }, body });
      const text = await r.text();
      return { status: r.status, text, headers: Object.fromEntries(r.headers) };
    };
    const mem = await payWith("POST", "/api/memory", JSON.stringify({ key: "k", value: "v" }));
    assert.equal(mem.status, 402, `identity-bound route refuses a contract wallet (got ${mem.status})`);
    const memPr = mem.headers["payment-required"] ? Buffer.from(mem.headers["payment-required"], "base64").toString("utf8") : "";
    assert.ok(`${mem.text} ${memPr}`.includes("contract_wallet_not_accepted_on_this_route"), `the refusal names its reason (${mem.text.slice(0, 200)} ${memPr.slice(0, 200)})`);
    // Only the signature check counts: a contract-wallet check is an eth_call
    // with no `to` (the deployless universal validator); the live revenue read
    // of the treasury balance also uses the Arc RPC once Arc is offered.
    const validatorCalls = () => st.rpcHits.flatMap((b) => (Array.isArray(b) ? b : [b])).filter((b) => b?.method === "eth_call" && !b?.params?.[0]?.to).length;
    assert.equal(validatorCalls(), 0, "no signature RPC call for a payment the route refuses anyway");
    const other = await payWith("GET", PATH);
    assert.equal(other.status, 402, `an RPC failure refuses the payment (got ${other.status})`);
    assert.ok(validatorCalls() >= 1, `the contract-wallet check asked the Arc RPC (${JSON.stringify(st.rpcHits).slice(0, 300)})`);
    assert.ok(!st.circleHits.some((h) => h.url === "/verify" || h.url === "/settle"), "nothing reached Circle");
  } finally { proc.kill("SIGKILL"); }
});

for (const [label, circleMode, payaiMode] of [
  ["Circle's /supported lacks Arc", "noarc", "ok"],
  ["Circle's /supported fails with the key echoed in HTML", "die", "ok"],
  ["Circle's /supported is malformed", "malformed", "ok"],
  ["EVERY facilitator fails (others fail open, Arc fails closed)", "die", "die"],
]) {
  await check(`${label}: Arc is dropped, nothing else is, nothing leaks`, async () => {
    st.circle = circleMode; st.payai = payaiMode;
    const { base, log, proc } = await boot({ CIRCLE_FACILITATOR_API_KEY: KEY });
    try {
      if (payaiMode === "ok") {
        const { nets } = await offeredNets(base);
        assert.ok(nets.has("eip155:8453") && !nets.has(ARC_CAIP2), `accepts: ${[...nets]}`);
        assertArcHidden(await arcSurfaces(base), label);
        if (circleMode === "noarc") {
          const rails = await (await fetch(`${base}/api/rails`)).json();
          assert.ok(!JSON.stringify(rails.rails || []).includes("arc"), `a never-offered Arc that Circle does not list is absent from /api/rails, not degraded (${JSON.stringify(rails.rails)})`);
          assert.equal(rails.degraded, 0, "no degraded rail for it");
        }
      } else {
        // Fail-open shape for the other rails: the paywall answers as before
        // (a 500 until a facilitator is reachable), and the offer never names Arc.
        const r = await fetch(`${base}${PATH}`);
        const pr = r.headers.get("payment-required");
        if (pr) assert.ok(!decode(pr).accepts.some((a) => a.network === ARC_CAIP2));
        await r.text();
      }
      assert.match(log.text, /dropping eip155:5042\b/);
      await noLeak(label, base, log);
    } finally { proc.kill("SIGKILL"); st.payai = "ok"; }
  });
}

payaiStub.close(); circleStub.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
