// Circle Gateway nanopayments (src/gateway-nanopayments.js): the batched,
// gas-free USDC x402 option beside the plain accept on Arc and Base.
//
// Part 1 drives the client against a fetch stub (no network): /supported
// parsing (the live shape, malformed, a kind without the fields), the switch
// and network list, the local preflight (domain, amount, payTo, chain,
// signature), verify and settle wire bodies, settlement_pending as its own
// outcome (Gateway's transfer record read for a bounded wait, cut to the CDN
// answer window; accepted -> served, failed -> refused, a record for another
// authorization never taken), every ambiguous settle (timeout, network
// error, 5xx, unreadable or malformed 2xx) booked exactly as
// settlement_pending, a booking the book cannot take journaled or held in
// memory and paging, reduced errors (an HTML 500 reaches nobody), the
// pending book (writes answer what landed), a resend refused when an owed
// row exists for its transfer, the resolver (catalog slug on the debt,
// failed drops counted kept, ambiguous entries Gateway never took dropped),
// transfer ids compared in any case, the balance read and its status word,
// and the routing
// install against a REAL x402ResourceServer: a batched payment goes to the
// Gateway client, a plain one to the plain facilitator, an onBeforeSettle
// abort (the client-gone hook) stops a batched settle before Gateway is
// asked, Gateway's HTML 500 or 402 reaches no fallback, chain facilitator,
// outage read or relayer (control: a plain 402 does), and a resent pending
// payment is resolved on Gateway's record before any verify or settle. A
// gateway-batched debt is proven by Gateway's record through refund-run's
// executor (confirmed -> repaid on the buyer's network; received, failed,
// another payer, short, or no transfer id -> held with the reason).
//
// Part 2 boots the real paid server against three stubs (PayAI for Base and
// Polygon, Circle for Arc, Gateway for the batched option; a preload rewrites
// the two constant base URLs to the stubs) and proves on the wire: the 402
// carries the batched accept on Arc and Base only, last in the list, same
// price and payTo as the plain accept, valid against the protocol schema and
// under the challenge ceiling on every catalog route; an identity-bound route
// and a route with a lasting effect offer none; the pending book and its
// resolver run with the switch off or /supported unreadable; a batched payment on each chain is verified and settled by the
// Gateway stub AFTER the handler and books one sale under the gateway-batched
// wire with Gateway's transaction id; a handler 4xx never settles;
// settlement_pending answers 402 with the reason and the same-payment hint,
// books no sale and lands in the pending book; Gateway accepting inside the
// wait is served once; a pending payment resent is refused at verify until
// Gateway's record settles, then served and booked exactly once, and never
// trips the wallet's breaker; with the settle fallback on, Gateway's HTML 500
// and 402 reach no chain facilitator; an upstream HTML 500 leaks nothing; a plain
// payment never reaches the Gateway stub; a hang-up during verify runs and
// settles nothing; the status words are words; the switch off, an unreadable
// /supported and a /supported without a chain each remove the accept there
// and leave the plain accepts alone.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import Database from "better-sqlite3";
import { parsePaymentRequired } from "@x402/core/schemas";
import { x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getFreePorts } from "./lib/free-port.js";
import {
  GATEWAY_API_BASE, GATEWAY_KIND_NAME, GATEWAY_WIRE, GatewayNanopaymentsClient, gatewayKindsFromSupported, gatewayAcceptFields,
  installGatewayRouting, isGatewayBatchedPayment, preflightGatewayPayment, createGatewayPendingBook, gatewayBalanceStatus,
  refreshGatewayBalance, _resetGatewayBalanceForTests, startGatewayBalanceWatch, gatewayNanopaymentNetworks, gatewayNanopaymentsEnabled,
  CDN_PENDING_RESERVE_MS, pendingKey, createGatewayPendingResolver, gatewayResourceOf,
  gatewayPendingLost, _resetGatewayPendingLostForTests, byTransferIdAnyCase, gatewayTransferMatches, normalizeGatewayTransfer,
} from "../src/gateway-nanopayments.js";
import { classifySettlementPending, settlementKindOf, isGatewayBatchedHeader, isGatewayBatchedRequest, isGatewayWire } from "../src/gateway-wire.js";
import { hintFor } from "../src/verify-hint.js";
import { verifyInboundPayment } from "../src/payment-verify.js";
import { registerFacilitatorFailureHooks, gatewayPendingBookWanted, acceptsForItem } from "../src/payments.js";
import { EventEmitter } from "node:events";
import { planRefunds, executeRefunds, GATEWAY_NO_ID_HOLD } from "./refund-run.js";
import { CIRCLE_FACILITATOR_BASE } from "../src/circle-supported.js";
import { LASTING_EFFECT_SLUG_LIST } from "../src/hangup-forgiveness.js";

let pass = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n${e?.stack || e}`); process.exitCode = 1; throw e; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const nonce = () => `0x${randomBytes(32).toString("hex")}`;
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const GW_WALLET = "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const POLY_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const MARKER = `UPSTREAMBODY${randomBytes(6).toString("hex")}`;
const KEY = `LIVE_API_KEY:${randomBytes(8).toString("hex")}`;
const uuid = () => `${randomBytes(4).toString("hex")}-${randomBytes(2).toString("hex")}-4${randomBytes(2).toString("hex").slice(1)}-a${randomBytes(2).toString("hex").slice(1)}-${randomBytes(6).toString("hex")}`;
const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));

// The live /supported shape (read 2026-10-23), with a chain the switch never names.
const kindOf = (network, address) => ({ x402Version: 2, scheme: "exact", network, extra: { name: GATEWAY_KIND_NAME, version: "1", verifyingContract: GW_WALLET, minValiditySeconds: 604800, assets: [{ symbol: "USDC", address, decimals: 6, authorizationVersions: ["1", "2"] }, { symbol: "EURC", address: `0x${"ab".repeat(20)}`, decimals: 6, authorizationVersions: ["2"] }] } });
const SUPPORTED = { kinds: [kindOf("eip155:1", `0x${"a0".repeat(20)}`), kindOf("eip155:8453", BASE_USDC.toLowerCase()), kindOf("eip155:137", POLY_USDC.toLowerCase()), kindOf("eip155:5042", ARC_USDC)], extensions: [], signers: { "eip155:*": [] } };

const acct = privateKeyToAccount(generatePrivateKey());
const TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
/** A payment signed under the Gateway domain (or, with `domain`, another one). */
async function signed({ accept, chainId, value = accept.amount, to = accept.payTo, domain = null, validBefore = now() + 604900, validAfter = 0, signer = acct, resource = "https://example.invalid/api/x" } = {}) {
  const authorization = { from: signer.address, to, value: String(value), validAfter: String(validAfter), validBefore: String(validBefore), nonce: nonce() };
  const signature = await signer.signTypedData({
    domain: domain || { name: GATEWAY_KIND_NAME, version: "1", chainId, verifyingContract: accept.extra.verifyingContract },
    types: TYPES, primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  return { x402Version: 2, resource: typeof resource === "string" ? { url: resource } : resource, accepted: accept, payload: { authorization, signature } };
}

// ---------------------------------------------------------------- part 1
console.log("part 1: the client, offline");

const kinds = gatewayKindsFromSupported(SUPPORTED);
const baseKind = kinds.get("eip155:8453");
const baseAccept = { scheme: "exact", network: "eip155:8453", amount: "5000", asset: BASE_USDC, payTo: TREASURY, ...gatewayAcceptFields(baseKind) };
const plainAccept = { scheme: "exact", network: "eip155:8453", amount: "5000", asset: BASE_USDC, payTo: TREASURY, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };

// The hosted connector's payment.info, as a client reads it (JSON or SSE).
async function mcpPaymentInfo(base) {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "payment.info", arguments: {} } }) });
  const text = await res.text();
  const body = (res.headers.get("content-type") || "").startsWith("text/event-stream") ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")) : JSON.parse(text);
  return JSON.parse(body.result.content[0].text);
}

await check("/supported: every listed chain parses to a kind with the Gateway domain, the USDC asset and a 7-day window", () => {
  assert.deepEqual([...kinds.keys()].sort(), ["eip155:5042", "eip155:8453"], "by default only the chains the option can settle");
  assert.deepEqual([...gatewayKindsFromSupported(SUPPORTED, ["eip155:1", "eip155:137", "eip155:5042", "eip155:8453"]).keys()].sort(), ["eip155:1", "eip155:137", "eip155:5042", "eip155:8453"], "every listed chain parses when asked for");
  assert.equal(baseKind.name, GATEWAY_KIND_NAME);
  assert.equal(baseKind.version, "1");
  assert.equal(baseKind.verifyingContract, GW_WALLET);
  assert.equal(baseKind.chainId, 8453);
  assert.equal(baseKind.asset, BASE_USDC.toLowerCase());
  assert.equal(baseKind.maxTimeoutSeconds, 604900, "minValiditySeconds plus the buffer");
  assert.deepEqual(gatewayAcceptFields(baseKind), { maxTimeoutSeconds: 604900, extra: { name: GATEWAY_KIND_NAME, version: "1", verifyingContract: GW_WALLET } });
  // A wanted list narrows it.
  assert.deepEqual([...gatewayKindsFromSupported(SUPPORTED, ["eip155:5042"]).keys()], ["eip155:5042"]);
});
await check("/supported: malformed answers throw a reason; a kind missing its fields is skipped, never guessed", () => {
  assert.throws(() => gatewayKindsFromSupported({ kinds: "nope" }), /invalid_supported_shape/);
  assert.throws(() => gatewayKindsFromSupported({ kinds: [{ scheme: 3 }] }), /invalid_supported_kind/);
  const noContract = structuredClone(SUPPORTED); delete noContract.kinds[1].extra.verifyingContract;
  assert.equal(gatewayKindsFromSupported(noContract).has("eip155:8453"), false, "no verifyingContract: no kind");
  const noUsdc = structuredClone(SUPPORTED); noUsdc.kinds[1].extra.assets = noUsdc.kinds[1].extra.assets.filter((a) => a.symbol !== "USDC");
  assert.equal(gatewayKindsFromSupported(noUsdc).has("eip155:8453"), false, "no USDC asset: no kind");
  const otherName = structuredClone(SUPPORTED); otherName.kinds[1].extra.name = "USD Coin";
  assert.equal(gatewayKindsFromSupported(otherName).has("eip155:8453"), false, "another domain name: no kind");
  const noVersion = structuredClone(SUPPORTED); delete noVersion.kinds[1].extra.version;
  assert.equal(gatewayKindsFromSupported(noVersion).get("eip155:8453").version, "1", "no kind version: the lowest authorization version the asset accepts");
  const badVersion = structuredClone(SUPPORTED); badVersion.kinds[1].extra.version = "9";
  assert.equal(gatewayKindsFromSupported(badVersion).get("eip155:8453").version, "1", "a kind version the asset does not accept: the lowest it does");
});
await check("the switch and the network list", () => {
  assert.equal(gatewayNanopaymentsEnabled({}), false);
  assert.equal(gatewayNanopaymentsEnabled({ GATEWAY_NANOPAYMENTS: "on" }), true);
  assert.equal(gatewayNanopaymentsEnabled({ GATEWAY_NANOPAYMENTS: "true" }), false, "only `on` turns it on");
  assert.deepEqual(gatewayNanopaymentNetworks({}), ["eip155:5042", "eip155:8453"], "default arc,base");
  assert.deepEqual(gatewayNanopaymentNetworks({ GATEWAY_NANOPAYMENT_NETWORKS: "base" }), ["eip155:8453"]);
  const warned = [];
  assert.deepEqual(gatewayNanopaymentNetworks({ GATEWAY_NANOPAYMENT_NETWORKS: "arc,polygon,eip155:8453" }, (m) => warned.push(m)), ["eip155:5042", "eip155:8453"]);
  assert.equal(warned.length, 1, "an unknown name is dropped with one warning");
});
await check("isGatewayBatchedPayment: only extra.name says so", () => {
  assert.equal(isGatewayBatchedPayment({ accepted: baseAccept }), true);
  assert.equal(isGatewayBatchedPayment(baseAccept), true);
  assert.equal(isGatewayBatchedPayment({ accepted: plainAccept }), false);
  assert.equal(isGatewayBatchedPayment({ accepted: { ...baseAccept, extra: { verifyingContract: GW_WALLET } } }), false);
  assert.equal(isGatewayBatchedPayment(null), false);
  assert.equal(isGatewayBatchedHeader(Buffer.from(JSON.stringify({ accepted: baseAccept })).toString("base64")), true);
  assert.equal(isGatewayBatchedHeader("not base64 json"), false);
  assert.equal(settlementKindOf(GATEWAY_WIRE), "offchain");
  assert.equal(settlementKindOf("x402"), "onchain");
});
await check("preflight: a payment that does not match the requirement or the Gateway domain never reaches Gateway", async () => {
  const good = await signed({ accept: baseAccept, chainId: 8453 });
  assert.equal(await preflightGatewayPayment(good, baseAccept, kinds), null, "a good payment passes");
  const r = async (p, req = baseAccept) => (await preflightGatewayPayment(p, req, kinds))?.reason;
  assert.equal(await r(await signed({ accept: baseAccept, chainId: 8453, domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC } })), "invalid_signature", "signed under the USDC domain");
  assert.equal(await r(await signed({ accept: baseAccept, chainId: 5042 })), "invalid_signature", "signed for another chain");
  assert.equal(await r(await signed({ accept: baseAccept, chainId: 8453, value: "4999" })), "amount_mismatch");
  assert.equal(await r(await signed({ accept: baseAccept, chainId: 8453, to: `0x${"0b".repeat(20)}` })), "address_mismatch");
  assert.equal(await r(await signed({ accept: baseAccept, chainId: 8453, validBefore: now() - 1 })), "authorization_expired");
  assert.equal(await r({ ...good, accepted: plainAccept }, plainAccept), "unsupported_domain", "a plain accept is not this client's");
  assert.equal(await r(good, { ...baseAccept, network: "eip155:137" }), "unsupported_network", "a chain the offer does not carry");
  assert.equal(await r(good, { ...baseAccept, asset: POLY_USDC }), "unsupported_asset");
  const contractShaped = { ...good, payload: { ...good.payload, signature: `0x${"ab".repeat(80)}` } };
  assert.equal(await r(contractShaped), "invalid_signature", "a signature that is not an EOA ECDSA one");
});

// A fetch stub for the Gateway API: records every call, answers by path and mode.
const gw = { mode: "ok", calls: [], transfers: [], balances: [{ domain: 6, depositor: TREASURY, balance: "20.5" }, { domain: 26, depositor: TREASURY, balance: "10" }] };
/** Gateway's transfer record for a signed payment (the documented shape). */
const recordFor = (p, status, over = {}) => ({
  id: uuid(), status, token: "USDC", sendingNetwork: p.accepted.network, recipientNetwork: p.accepted.network,
  fromAddress: p.payload.authorization.from.toLowerCase(), toAddress: p.payload.authorization.to.toLowerCase(), amount: p.payload.authorization.value,
  nonce: p.payload.authorization.nonce, txHash: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
});
const fetchStub = async (url, init = {}) => {
  gw.calls.push({ url, init });
  const path = String(url).slice(GATEWAY_API_BASE.length);
  const json = (status, body, type = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
  if (path === "/v1/x402/supported") return gw.mode === "die" ? json(500, `<html>${MARKER}</html>`, "text/html") : json(200, SUPPORTED);
  if (path.startsWith("/v1/x402/transfers?")) {
    const q = new URL(String(url)).searchParams;
    return json(200, { transfers: gw.transfers.filter((t) => t.nonce.toLowerCase() === String(q.get("nonce")).toLowerCase()) });
  }
  if (path.startsWith("/v1/x402/transfers/")) {
    const t = gw.transfers.find((x) => x.id === path.slice("/v1/x402/transfers/".length));
    return t ? json(200, t) : json(404, { success: false, message: "Transfer not found" });
  }
  const body = init.body ? JSON.parse(init.body) : {};
  const payer = body.paymentPayload?.payload?.authorization?.from;
  if (path === "/v1/x402/verify") return gw.mode === "verifyno" ? json(200, { isValid: false, invalidReason: "insufficient_balance", payer }) : json(200, { isValid: true, payer });
  if (path === "/v1/x402/settle") {
    if (gw.acceptOnSettle) gw.transfers.push(recordFor(body.paymentPayload, gw.acceptOnSettle));
    if (gw.mode === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    if (gw.mode === "neterr") throw new TypeError("fetch failed");
    if (gw.mode === "json503") return json(503, { errors: [{ reason: "service_unavailable" }] });
    if (gw.mode === "badjson") return json(200, "{not json");
    if (gw.mode === "badshape") return json(200, { ok: "yes" });
    if (gw.mode === "othernet") return json(200, { success: true, transaction: uuid(), network: "eip155:5042", payer });
    if (gw.mode === "upperid") return json(200, { success: true, transaction: uuid().toUpperCase(), network: body.paymentRequirements.network, payer });
    if (gw.mode === "html500") return json(500, `<html>${MARKER}</html>`, "text/html");
    if (gw.mode === "status402") return json(402, { success: false, errorReason: "insufficient_balance", transaction: "", network: body.paymentRequirements.network });
    if (gw.mode === "pending") return json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: body.paymentRequirements.network, payer });
    if (gw.mode === "notx") return json(200, { success: true, transaction: "", network: body.paymentRequirements.network, payer });
    if (gw.mode === "refused") return json(200, { success: false, errorReason: "insufficient_balance", transaction: "", network: body.paymentRequirements.network, payer });
    return json(200, { success: true, transaction: uuid(), network: body.paymentRequirements.network, payer });
  }
  if (path === "/v1/balances") return json(200, { token: "USDC", balances: gw.balances });
  return json(404, {});
};
const pendings = [];
const client = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453", "eip155:5042"], onPending: (e) => { pendings.push(e); return true; }, pendingWaitMs: 300, pendingPollMs: 50 });
const searches = () => gw.calls.filter((c) => String(c.url).includes("/v1/x402/transfers?"));

await check("client: /supported is read keyless and keeps only the wanted chains", async () => {
  const s = await client.getSupported();
  assert.deepEqual(s.kinds.map((k) => k.network).sort(), ["eip155:5042", "eip155:8453"]);
  assert.equal(gw.calls[0].url, `${GATEWAY_API_BASE}/v1/x402/supported`);
  assert.equal(gw.calls[0].init.headers.Authorization, undefined, "no key on any call");
  assert.equal(gw.calls[0].init.redirect, "error", "redirects refused");
});
await check("client: verify and settle send the x402 bodies and answer the standard shapes; a success names Gateway's transaction id", async () => {
  gw.calls.length = 0;
  const p = await signed({ accept: baseAccept, chainId: 8453 });
  const v = await client.verify(p, baseAccept);
  assert.deepEqual(v, { isValid: true, payer: acct.address });
  const s = await client.settle(p, baseAccept);
  assert.equal(s.success, true);
  assert.match(s.transaction, /^[0-9a-f-]{36}$/);
  assert.equal(s.network, "eip155:8453");
  assert.equal(s.payer, acct.address, "the payer is the signer this server verified");
  assert.deepEqual(gw.calls.map((c) => [c.url.slice(GATEWAY_API_BASE.length), c.init.method]), [["/v1/x402/verify", "POST"], ["/v1/x402/settle", "POST"]]);
  for (const c of gw.calls) {
    const b = JSON.parse(c.init.body);
    assert.deepEqual(Object.keys(b).sort(), ["paymentPayload", "paymentRequirements"], "the documented body, nothing more");
    assert.equal(b.paymentRequirements.extra.name, GATEWAY_KIND_NAME);
    assert.equal(c.init.headers.Authorization, undefined);
  }
});
await check("client: a refusal before Gateway answers the refusal shape and makes no call", async () => {
  gw.calls.length = 0;
  const bad = await signed({ accept: baseAccept, chainId: 8453, value: "1" });
  assert.deepEqual(await client.verify(bad, baseAccept), { isValid: false, invalidReason: "amount_mismatch", payer: acct.address });
  const s = await client.settle(bad, baseAccept);
  assert.equal(s.success, false); assert.equal(s.errorReason, "amount_mismatch"); assert.equal(s.transaction, "");
  assert.equal(gw.calls.length, 0);
});
await check("client: settlement_pending with no Gateway record inside the wait - not settled, transaction empty, booked by authorization", async () => {
  gw.mode = "pending"; gw.calls.length = 0;
  const p = await signed({ accept: baseAccept, chainId: 8453 });
  const t0 = Date.now();
  const s = await client.settle(p, baseAccept);
  assert.ok(Date.now() - t0 >= 250, "it waited for Gateway's record");
  assert.deepEqual(s, { success: false, errorReason: "settlement_pending", transaction: "", network: "eip155:8453", payer: acct.address });
  assert.ok(searches().length >= 2, `Gateway's transfer record was read while waiting (${searches().length})`);
  for (const c of searches()) {
    const q = new URL(c.url).searchParams;
    assert.equal(q.get("nonce"), p.payload.authorization.nonce.toLowerCase(), "looked up by the authorization's nonce");
    assert.equal(q.get("network"), "eip155:8453");
    assert.equal(c.init.headers.Authorization, undefined, "keyless");
  }
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0].nonce, p.payload.authorization.nonce);
  assert.equal(pendings[0].payer, acct.address);
  assert.equal(pendings[0].amount, "5000");
  assert.equal(pendings[0].resource, null, "the route comes from the request this server answers, never the payload's url (none here)");
  assert.equal(pendings[0].payTo, TREASURY);
  gw.mode = "ok";
});
await check("client: settlement_pending, then Gateway's record shows the transfer accepted inside the wait - served on the record's id, nothing booked", async () => {
  gw.mode = "pending"; gw.calls.length = 0; pendings.length = 0;
  const p = await signed({ accept: baseAccept, chainId: 8453 });
  const rec = recordFor(p, "received");
  setTimeout(() => gw.transfers.push(rec), 120);
  const s = await client.settle(p, baseAccept);
  assert.deepEqual(s, { success: true, transaction: rec.id, network: "eip155:8453", payer: acct.address });
  assert.equal(pendings.length, 0, "a settled payment is not booked pending");
  assert.equal(gw.calls.filter((c) => c.url.endsWith("/settle")).length, 1, "one settle call; the rest are reads");
  gw.mode = "ok";
});
await check("client: settlement_pending, then Gateway's record says failed - refused settlement_failed (not charged), nothing booked", async () => {
  gw.mode = "pending"; pendings.length = 0;
  const p = await signed({ accept: baseAccept, chainId: 8453 });
  gw.transfers.push(recordFor(p, "failed"));
  const s = await client.settle(p, baseAccept);
  assert.equal(s.success, false); assert.equal(s.errorReason, "settlement_failed"); assert.equal(s.transaction, "");
  assert.equal(pendings.length, 0);
  gw.mode = "ok";
});
await check("client: a record that is not this authorization (another payer, a short amount, another network, another payTo) is never taken for it", async () => {
  gw.mode = "pending"; pendings.length = 0;
  const p = await signed({ accept: baseAccept, chainId: 8453 });
  gw.transfers.push(
    recordFor(p, "completed", { fromAddress: `0x${"12".repeat(20)}` }),
    recordFor(p, "completed", { amount: "4999" }),
    recordFor(p, "completed", { sendingNetwork: "eip155:5042", recipientNetwork: "eip155:5042" }),
    recordFor(p, "completed", { toAddress: `0x${"34".repeat(20)}` }),
  );
  const s = await client.settle(p, baseAccept);
  assert.equal(s.errorReason, "settlement_pending", "still pending: no record matched");
  assert.equal(pendings.length, 1);
  gw.mode = "ok";
});
await check("client: the pending wait is cut to the CDN answer window (less a reserve) for a request that came through the CDN", async () => {
  const slow = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"], onPending: () => true, pendingWaitMs: 4000, pendingPollMs: 50 });
  await slow.getSupported();
  const server = new x402ResourceServer([{ async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }; }, async verify() { return { isValid: true }; }, async settle() { throw new Error("plain facilitator must not be asked"); } }]).register("eip155:8453", new ExactEvmScheme());
  await server.initialize();
  installGatewayRouting(server, slow, new Set(["eip155:8453"]));
  gw.mode = "pending";
  const viaCdn = { cdnSyncDeadlineMs: Date.now() + CDN_PENDING_RESERVE_MS + 400 };
  let t0 = Date.now();
  const s1 = await server.settlePayment(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept, undefined, { request: { adapter: { req: viaCdn } } });
  const cdnMs = Date.now() - t0;
  assert.equal(s1.success, false);
  assert.ok(cdnMs < 1500, `inside the CDN window the wait ends with it (${cdnMs} ms of a 4000 ms budget)`);
  const late = { cdnSyncDeadlineMs: Date.now() + CDN_PENDING_RESERVE_MS - 1000 };
  t0 = Date.now();
  await server.settlePayment(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept, undefined, { request: { adapter: { req: late } } });
  assert.ok(Date.now() - t0 < 500, "a window already inside the reserve does not wait");
  // Control: the same client off the CDN waits its whole budget.
  const direct = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"], onPending: () => true, pendingWaitMs: 900, pendingPollMs: 50 });
  await direct.getSupported();
  t0 = Date.now();
  await direct.settle(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept);
  assert.ok(Date.now() - t0 >= 850, "off the CDN the whole budget is used");
  gw.mode = "ok";
});
await check("client: a Gateway refusal (4xx, or success:false with a reason) is relayed as its reason word only and booked nowhere", async () => {
  pendings.length = 0;
  gw.mode = "refused";
  const s = await client.settle(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept);
  assert.equal(s.errorReason, "insufficient_balance");
  gw.mode = "status402";
  await assert.rejects(client.settle(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept), (e) => e.errorReason === "insufficient_balance" && e.statusCode === 402);
  assert.equal(pendings.length, 0, "a refusal is Gateway's answer: nothing to book");
  gw.mode = "die";
  await assert.rejects(client.getSupported(), (e) => e.reason === "non_json_response" && !String(e.message).includes(MARKER));
  gw.mode = "ok";
});
await check("client: every ambiguous settle (timeout, network error, HTML 500, JSON 503, unreadable or malformed 2xx, a success without an id) is booked by its authorization exactly as settlement_pending: same answer, Gateway's record read first", async () => {
  const causes = { timeout: "timeout", neterr: "network_error", html500: "gateway_http_500", json503: "gateway_http_503", badjson: "invalid_json", badshape: "invalid_settle_response", notx: "invalid_settle_response" };
  try {
    for (const [mode, cause] of Object.entries(causes)) {
      gw.mode = mode; gw.calls.length = 0; pendings.length = 0;
      const p = await signed({ accept: baseAccept, chainId: 8453 });
      const s = await client.settle(p, baseAccept);
      assert.deepEqual(s, { success: false, errorReason: "settlement_pending", transaction: "", network: "eip155:8453", payer: acct.address }, `${mode}: answered as pending, never thrown`);
      assert.ok(searches().length >= 1, `${mode}: Gateway's record was read before booking`);
      assert.equal(pendings.length, 1, `${mode}: booked`);
      assert.equal(pendings[0].nonce, p.payload.authorization.nonce);
      assert.equal(pendings[0].origin, "ambiguous");
      assert.equal(pendings[0].cause, cause, mode);
      assert.equal(pendings[0].validBefore, p.payload.authorization.validBefore);
      assert.ok(!JSON.stringify(s).includes(MARKER), `${mode}: no upstream body`);
    }
    // Gateway did take it (its record shows the transfer inside the wait): served on the record.
    gw.mode = "html500"; gw.acceptOnSettle = "received"; pendings.length = 0;
    const q = await signed({ accept: baseAccept, chainId: 8453 });
    const served = await client.settle(q, baseAccept);
    assert.equal(served.success, true);
    assert.equal(served.transaction, gw.transfers.find((t) => t.nonce === q.payload.authorization.nonce).id);
    assert.equal(pendings.length, 0, "served: nothing booked");
    // A settlement_pending answer keeps its own origin.
    gw.acceptOnSettle = null; gw.mode = "pending"; pendings.length = 0;
    await client.settle(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept);
    assert.deepEqual([pendings[0].origin, pendings[0].cause], ["pending", "settlement_pending"]);
  } finally { gw.mode = "ok"; gw.acceptOnSettle = null; }
});
await check("client: a booking the book cannot take is never silent: journaled -> the claim stays held; refused or thrown -> held in memory, logged as an error, and the word reads unresolved until resolved", async () => {
  _resetGatewayPendingLostForTests();
  const errs = [];
  const origError = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    gw.mode = "pending";
    for (const [answer, lost] of [["journaled", 0], [false, 1], ["throw", 2]]) {
      const c = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"], pendingWaitMs: 60, pendingPollMs: 30, onPending: async () => { if (answer === "throw") throw new Error("database down"); return answer; } });
      await c.getSupported();
      const req = { method: "GET", originalUrl: "/api/x" };
      const server = new x402ResourceServer([{ async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }; } }]).register("eip155:8453", new ExactEvmScheme());
      await server.initialize();
      installGatewayRouting(server, c, new Set(["eip155:8453"]));
      const p = await signed({ accept: baseAccept, chainId: 8453 });
      const s = await server.settlePayment(p, baseAccept, undefined, { request: { adapter: { req } } }).catch((e) => e);
      assert.equal(s.errorReason, "settlement_pending", String(answer));
      assert.equal(req[Symbol.for("agent402.gatewayPendingBooked")], undefined, `${answer}: not marked booked, so the settlement claim stays held`);
      assert.equal(gatewayPendingLost().length, lost, `${answer}: held in memory ${lost ? "" : "not "}`);
    }
    assert.ok(errs.some((m) => /could NOT be booked/.test(m)), "logged as an error");
    const dir = mkdtempSync(join(tmpdir(), "a402-gw-lost-"));
    const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {} });
    await book.ready;
    assert.equal(await book.alarmStatus(), "unresolved", "a booking held in memory pages");
    const view = await book.operatorView();
    assert.equal(view.heldInMemory.length, 2);
    for (const e of view.heldInMemory) assert.equal((await book.resolve(e.key, { outcome: "not_charged", note: "checked by hand" })).ok, true);
    assert.equal(await book.alarmStatus(), "ok");
    rmSync(dir, { recursive: true, force: true });
  } finally { console.error = origError; gw.mode = "ok"; _resetGatewayPendingLostForTests(); }
});
await check("the pending book: a store write that fails is journaled (\"journaled\", word unresolved), landed by the resolver's next tick, and never dropped; one the journal also refuses answers false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-journal-"));
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {}, alarm: () => {} });
  await book.ready;
  // The store refuses every write (the file's directory is made unwritable
  // by replacing the file with a directory of the same name).
  mkdirSync(join(dir, "p.json"), { recursive: true });
  const n = nonce();
  assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: n, amount: "5000", payTo: TREASURY, resource: "GET /api/x" }), "journaled");
  assert.equal(await book.alarmStatus(), "unresolved", "a journaled booking pages");
  assert.equal((await book.operatorView()).journaled, 1);
  rmSync(join(dir, "p.json"), { recursive: true, force: true });
  const rc = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"] });
  const resolver = createGatewayPendingResolver({ book, client: rc, recordOwed: async () => true, owedExists: async () => false, log: () => {} });
  const out = await resolver.tick();
  assert.equal(out.journaled, 1, "landed from the journal");
  const key = pendingKey("eip155:8453", acct.address, n);
  assert.ok(await book.get(key), "in the book now");
  assert.equal(await book.alarmStatus(), "pending");
  // Book and journal both refuse: false, and an alarm.
  const alarms = [];
  const deaf = createGatewayPendingBook({ file: join(dir, "q.json"), log: () => {}, alarm: (m) => alarms.push(m), journal: { add: () => null, state: () => ({ total: 0 }), drain: async () => 0 } });
  await deaf.ready;
  mkdirSync(join(dir, "q.json"), { recursive: true });
  assert.equal(await deaf.book({ payer: acct.address, network: "eip155:8453", nonce: nonce(), amount: "5000" }), false);
  assert.equal(alarms.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
await check("client: the balance read is keyless by address and sums the domains", async () => {
  gw.calls.length = 0;
  const b = await client.balances({ depositor: TREASURY, domains: [6, 26] });
  assert.equal(b.usd, 30.5);
  assert.deepEqual(b.byDomain, { 6: 20.5, 26: 10 });
  const body = JSON.parse(gw.calls[0].init.body);
  assert.deepEqual(body, { token: "USDC", sources: [{ domain: 6, depositor: TREASURY }, { domain: 26, depositor: TREASURY }] });
  await assert.rejects(client.balances({ depositor: "nope" }), /invalid_depositor/);
});
await check("the balance word: off until a watch runs, ok under the alert, withdraw at or above it; the figure only on the full view", async () => {
  _resetGatewayBalanceForTests();
  assert.deepEqual(gatewayBalanceStatus(), { status: "off" });
  startGatewayBalanceWatch(client, { depositor: TREASURY, domains: [6, 26], intervalMs: 3_600_000 });
  assert.deepEqual(gatewayBalanceStatus(), { status: "unknown" });
  await refreshGatewayBalance(client, { depositor: TREASURY, domains: [6, 26] });
  assert.deepEqual(gatewayBalanceStatus({ env: { GATEWAY_WITHDRAW_ALERT_USD: "50" } }), { status: "ok" });
  assert.deepEqual(gatewayBalanceStatus({ env: {} }), { status: "withdraw" }, "30.5 is past the default 25");
  const full = gatewayBalanceStatus({ full: true, env: {} });
  assert.equal(full.usd, 30.5); assert.equal(full.alertUsd, 25); assert.deepEqual(full.byDomain, { 6: 20.5, 26: 10 });
  _resetGatewayBalanceForTests();
});
await check("the pending book: books once per authorization, lists, words and resolves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-pending-"));
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {} });
  await book.ready;
  assert.equal(await book.alarmStatus(), "ok");
  const n = nonce();
  assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: n, amount: "5000", resource: "https://x/api/y" }), true);
  assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: n, amount: "5000" }), true, "same authorization: the book already holds it");
  assert.equal((await book.operatorView()).count, 1, "same authorization: booked once");
  assert.equal(await book.book({ payer: "0xnope", network: "eip155:8453", nonce: n }), false);
  assert.equal(await book.alarmStatus(), "pending");
  const view = await book.operatorView();
  assert.equal(view.count, 1); assert.equal(view.entries[0].payer, acct.address.toLowerCase()); assert.equal(view.entries[0].amount, "5000");
  assert.equal((await book.resolve(view.entries[0].key, { outcome: "nothing" })).ok, false);
  assert.equal((await book.resolve(view.entries[0].key, { outcome: "refunded", note: "repaid by hand" })).ok, true);
  assert.equal(await book.alarmStatus(), "ok");
  rmSync(dir, { recursive: true, force: true });
});
await check("the 402 hint for a pending settlement: withheld, resend the same payment, owed if it settles unserved; never a new signature", () => {
  const h = classifySettlementPending({ success: false, errorReason: "settlement_pending", network: "eip155:8453" });
  assert.equal(h.reason, "settlement-pending"); assert.equal(h.retry, "same-payment"); assert.equal(h.network, "eip155:8453");
  assert.equal(h.retryAfterSeconds, 10);
  assert.match(h.detail, /has not confirmed this batched payment yet, so the answer was withheld/);
  assert.match(h.detail, /same request with the same payment header after a short wait to receive it with no new charge/);
  assert.match(h.detail, /If Gateway settles the payment and the request is not served, we record the amount as owed to the paying wallet and repay it/);
  assert.match(h.detail, /Do not sign a new authorization/);
  assert.doesNotMatch(h.detail, /Sign a fresh|Nothing more is charged/, "no new signature asked for, no unscoped no-charge claim");
  // The same words when the resend itself is still pending (refused at verify).
  const v = hintFor({ reason: "settlement_pending", network: "eip155:8453" });
  assert.equal(v.retry, "same-payment"); assert.equal(v.hint, h.detail); assert.equal(v.reason, "settlement-pending");
  assert.equal(hintFor({ reason: "settlement_failed" }).retry, "fresh-authorization", "a failed Gateway transfer was not charged: a fresh one is safe");
  assert.equal(hintFor({ reason: "settlement_failed" }).hint, "Circle Gateway reports this batched payment failed; it did not settle to us and this request was not charged. Sign a fresh authorization to retry.");
  assert.equal(classifySettlementPending({ success: false, errorReason: "insufficient_balance" }), null);
  assert.equal(classifySettlementPending({ success: true, errorReason: "settlement_pending" }), null);
});
await check("routing: a batched payment is settled by the Gateway client, a plain one by the plain facilitator, and an onBeforeSettle abort stops a batched settle before Gateway is asked", async () => {
  const plain = { verify: 0, settle: 0 };
  const plainClient = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }; },
    async verify(p) { plain.verify++; return { isValid: true, payer: p.payload.authorization.from }; },
    async settle(p) { plain.settle++; return { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453", payer: p.payload.authorization.from }; },
  };
  let server = new x402ResourceServer([plainClient]).register("eip155:8453", new ExactEvmScheme());
  await server.initialize();
  let gone = false;
  server.onBeforeSettle(() => (gone ? { abort: true, reason: "client_disconnected", message: "left" } : undefined));
  installGatewayRouting(server, client, new Set(["eip155:8453"]));
  assert.equal(installGatewayRouting(server, client, new Set()), server, "idempotent");
  gw.calls.length = 0;
  const batched = await signed({ accept: baseAccept, chainId: 8453 });
  const vb = await server.verifyPayment(batched, baseAccept);
  assert.equal(vb.isValid, true);
  const sb = await server.settlePayment(batched, baseAccept);
  assert.equal(sb.success, true);
  assert.equal(gw.calls.filter((c) => c.url.endsWith("/settle")).length, 1, "Gateway settled it");
  assert.equal(plain.settle, 0, "the plain facilitator never saw it");
  // A plain payment (crafted; the stub verifies anything) goes to the plain facilitator.
  const plainPayload = { x402Version: 2, resource: { url: "https://x/y" }, accepted: plainAccept, payload: { signature: `0x${"11".repeat(65)}`, authorization: { from: acct.address, to: TREASURY, value: "5000", validAfter: "0", validBefore: String(now() + 300), nonce: nonce() } } };
  await server.verifyPayment(plainPayload, plainAccept);
  await server.settlePayment(plainPayload, plainAccept);
  assert.equal(plain.verify, 1); assert.equal(plain.settle, 1);
  assert.equal(gw.calls.filter((c) => c.url.endsWith("/settle")).length, 1, "Gateway saw no plain payment");
  // The client-gone abort runs before Gateway is asked.
  gone = true;
  await assert.rejects(server.settlePayment(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept), (e) => e.errorReason === "client_disconnected");
  assert.equal(gw.calls.filter((c) => c.url.endsWith("/settle")).length, 1, "no Gateway settle after the abort");
});

await check("no fallback for a batched payment: an HTML 500 and an HTTP 402 from Gateway's /settle leave the chain facilitators, the outage read and our relayer untouched (control: a plain payment's 402 does reach them)", async () => {
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = "on";
  try {
    const touched = { chain: 0, relayer: 0, outage: 0, payai: 0, solvador: 0 };
    const ok = (who) => async (p) => { touched[who]++; return { success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453", payer: p.payload.authorization.from }; };
    let plainRefuses = true;
    const plainClient = {
      async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }; },
      async verify(p) { return { isValid: true, payer: p.payload.authorization.from }; },
      async settle() { if (plainRefuses) throw Object.assign(new Error("Facilitator settle failed (402)"), { status: 402 }); return { success: true }; },
    };
    const server = new x402ResourceServer([plainClient]).register("eip155:8453", new ExactEvmScheme());
    await server.initialize();
    installGatewayRouting(server, client, new Set(["eip155:8453"]));
    registerFacilitatorFailureHooks(server, { settle: ok("payai") }, { settle: ok("solvador") }, {
      "eip155:8453": () => [{ name: "chain facilitator", client: { settle: ok("chain") } }, { name: "own relayer", client: { settle: ok("relayer") }, own: true, revertRetry: true }],
    }, { outageFor: () => ({ handle: async () => { touched.outage++; return { served: true, result: { success: true, transaction: `0x${"ef".repeat(32)}`, network: "eip155:8453" } }; } }) });
    for (const mode of ["html500", "status402"]) {
      gw.mode = mode; gw.calls.length = 0;
      const p = await signed({ accept: baseAccept, chainId: 8453 });
      let out = null;
      try { out = await server.settlePayment(p, baseAccept); } catch (e) { out = e; }
      assert.notEqual(out?.success, true, `${mode}: not settled`);
      assert.equal(gw.calls.filter((c) => c.url.endsWith("/settle")).length, 1, `${mode}: Gateway was asked once`);
      assert.deepEqual(touched, { chain: 0, relayer: 0, outage: 0, payai: 0, solvador: 0 }, `${mode}: no other settle path was tried (${JSON.stringify(touched)})`);
    }
    // Control: the same hooks DO hand a plain payment's 402 to the fallback.
    const plainPayload = { x402Version: 2, resource: { url: "https://x/y" }, accepted: plainAccept, payload: { signature: `0x${"11".repeat(65)}`, authorization: { from: acct.address, to: TREASURY, value: "5000", validAfter: "0", validBefore: String(now() + 300), nonce: nonce() } } };
    const r = await server.settlePayment(plainPayload, plainAccept);
    assert.equal(r.success, true, "the plain payment was recovered by the fallback");
    assert.equal(touched.chain, 1, "control: the chain fallback is live for a plain payment");
  } finally {
    gw.mode = "ok";
    if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK; else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  }
});

await check("a resent pending payment is resolved against Gateway's record before any verify or settle: still pending -> refused with the same words; accepted -> served once on the record (one of two concurrent resends); failed -> dropped, not charged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-resume-"));
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {} });
  await book.ready;
  const bc = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"], onPending: (e) => book.book(e), pendingWaitMs: 100, pendingPollMs: 40 });
  await bc.getSupported();
  const plainClient = { async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }; }, async verify() { throw new Error("plain verify must not be asked"); }, async settle() { throw new Error("plain settle must not be asked"); } };
  const server = new x402ResourceServer([plainClient]).register("eip155:8453", new ExactEvmScheme());
  await server.initialize();
  installGatewayRouting(server, bc, new Set(["eip155:8453"]), { pendingBook: book, wasServed: async () => false });
  const gwVS = () => gw.calls.filter((c) => /\/v1\/x402\/(verify|settle)$/.test(c.url)).length;
  try {
    gw.mode = "pending";
    const p = await signed({ accept: baseAccept, chainId: 8453 });
    assert.equal((await server.verifyPayment(p, baseAccept)).isValid, true);
    const first = await server.settlePayment(p, baseAccept);
    assert.equal(first.errorReason, "settlement_pending");
    const key = pendingKey("eip155:8453", acct.address, p.payload.authorization.nonce);
    assert.ok(await book.get(key), "booked by its authorization");
    gw.mode = "ok"; gw.calls.length = 0;
    // Still pending at Gateway: refused at verify with the pending word; Gateway is only read.
    const v1 = await server.verifyPayment(p, baseAccept);
    assert.deepEqual([v1.isValid, v1.invalidReason], [false, "settlement_pending"]);
    assert.equal(gwVS(), 0, "no Gateway verify or settle for the resend");
    assert.ok(searches().length >= 1, "Gateway's record was read");
    // Accepted at Gateway: two resends at once, one is served on the record.
    const rec = recordFor(p, "batched");
    gw.transfers.push(rec);
    const [a, b2] = await Promise.all([server.verifyPayment(p, baseAccept), server.verifyPayment(p, baseAccept)]);
    assert.deepEqual([a.isValid, b2.isValid].sort(), [false, true], "exactly one concurrent resend takes the entry");
    assert.equal([a, b2].find((x) => !x.isValid).invalidReason, "settlement_pending", "the other is told to wait");
    const served = await server.settlePayment(p, baseAccept);
    assert.deepEqual(served, { success: true, transaction: rec.id, network: "eip155:8453", payer: acct.address });
    assert.equal(gwVS(), 0, "served on the record: no Gateway verify or settle call");
    assert.equal(await book.get(key), null, "the entry is dropped once served");
    // Failed at Gateway: the entry is dropped and the resend refused, not charged.
    gw.mode = "pending";
    const q = await signed({ accept: baseAccept, chainId: 8453 });
    await server.verifyPayment(q, baseAccept);
    await server.settlePayment(q, baseAccept);
    const qkey = pendingKey("eip155:8453", acct.address, q.payload.authorization.nonce);
    assert.ok(await book.get(qkey));
    gw.mode = "ok"; gw.calls.length = 0;
    gw.transfers.push(recordFor(q, "failed"));
    const vf = await server.verifyPayment(q, baseAccept);
    assert.deepEqual([vf.isValid, vf.invalidReason], [false, "settlement_failed"]);
    assert.equal(await book.get(qkey), null, "a failed transfer's entry is dropped");
    assert.equal(gwVS(), 0);
  } finally { gw.mode = "ok"; rmSync(dir, { recursive: true, force: true }); }
});

await check("a pending resend resumes only on the route it was booked on (method and path): route B is refused and the entry stays; route A resumes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-route-"));
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {} });
  await book.ready;
  const bc = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"], onPending: (e) => book.book(e), pendingWaitMs: 100, pendingPollMs: 40 });
  await bc.getSupported();
  const plainClient = { async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }; }, async verify() { throw new Error("plain verify must not be asked"); }, async settle() { throw new Error("plain settle must not be asked"); } };
  const server = new x402ResourceServer([plainClient]).register("eip155:8453", new ExactEvmScheme());
  await server.initialize();
  installGatewayRouting(server, bc, new Set(["eip155:8453"]), { pendingBook: book, wasServed: async () => false });
  const tc = (method, url) => ({ request: { adapter: { req: { method, originalUrl: url } } } });
  const A = tc("POST", "/api/a?x=1"), A2 = tc("post", "/api/a"), B = tc("POST", "/api/b"), AGET = tc("GET", "/api/a");
  assert.equal(gatewayResourceOf(A.request.adapter.req), "POST /api/a");
  assert.equal(gatewayResourceOf(null), null);
  try {
    gw.mode = "pending";
    const p = await signed({ accept: baseAccept, chainId: 8453, resource: "https://example.invalid/api/b" });
    assert.equal((await server.verifyPayment(p, baseAccept, undefined, A)).isValid, true);
    assert.equal((await server.settlePayment(p, baseAccept, undefined, A)).errorReason, "settlement_pending");
    const key = pendingKey("eip155:8453", acct.address, p.payload.authorization.nonce);
    assert.equal((await book.get(key)).resource, "POST /api/a", "booked by the route this server answered, not the payload's url");
    gw.mode = "ok";
    gw.transfers.push(recordFor(p, "confirmed"));
    for (const other of [B, AGET]) {
      const v = await server.verifyPayment(p, baseAccept, undefined, other);
      assert.deepEqual([v.isValid, v.invalidReason], [false, "resource_mismatch"], "another route at the same price is refused");
      const e = await book.get(key);
      assert.ok(e && e.state === "pending", "the entry stays pending");
    }
    const v = await server.verifyPayment(p, baseAccept, undefined, A2);
    assert.equal(v.isValid, true, "the same route resumes");
    const served = await server.settlePayment(p, baseAccept, undefined, A2);
    assert.equal(served.success, true);
    assert.equal(await book.get(key), null, "served and dropped");
  } finally { gw.mode = "ok"; rmSync(dir, { recursive: true, force: true }); }
});

await check("a resend whose transfer already has an owed refund row is refused (never served and refunded) and its entry dropped; resolve and releaseResume answer the real write result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-owed-"));
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {} });
  await book.ready;
  const bc = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"], onPending: (e) => book.book(e), pendingWaitMs: 60, pendingPollMs: 30 });
  await bc.getSupported();
  const plainClient = { async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }; }, async verify() { throw new Error("plain verify must not be asked"); }, async settle() { throw new Error("plain settle must not be asked"); } };
  const server = new x402ResourceServer([plainClient]).register("eip155:8453", new ExactEvmScheme());
  await server.initialize();
  const owedTx = new Set();
  installGatewayRouting(server, bc, new Set(["eip155:8453"]), { pendingBook: book, wasServed: async () => false, owedExists: async (tx) => owedTx.has(tx) });
  try {
    gw.mode = "pending";
    const p = await signed({ accept: baseAccept, chainId: 8453 });
    await server.verifyPayment(p, baseAccept);
    assert.equal((await server.settlePayment(p, baseAccept)).errorReason, "settlement_pending");
    const key = pendingKey("eip155:8453", acct.address, p.payload.authorization.nonce);
    assert.ok(await book.get(key));
    gw.mode = "ok"; gw.calls.length = 0;
    const rec = recordFor(p, "confirmed");
    gw.transfers.push(rec);
    owedTx.add(rec.id);
    const v = await server.verifyPayment(p, baseAccept);
    assert.deepEqual([v.isValid, v.invalidReason], [false, "nonce_already_used"], "an owed debt exists: the resend is never served");
    assert.equal(await book.get(key), null, "the entry is dropped as owed");
    assert.equal(gw.calls.filter((c) => /\/v1\/x402\/(verify|settle)$/.test(c.url)).length, 0);
    // A write that does not land is reported as such.
    const q = nonce();
    assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: q, amount: "5000" }), true);
    const qkey = pendingKey("eip155:8453", acct.address, q);
    assert.equal(await book.claimResume(qkey, "me"), true);
    // The store stays readable but stops taking writes (its directory is
    // made read-only), so the entry is still there to drop or hand back.
    chmodSync(dir, 0o555);
    assert.ok(await book.get(qkey), "still readable");
    assert.equal(await book.releaseResume(qkey, "me"), false, "a hand-back that did not land answers false");
    const r = await book.resolve(qkey, { outcome: "served" });
    assert.equal(r.ok, false, "a drop that did not land answers not ok");
    chmodSync(dir, 0o755);
    assert.equal((await book.get(qkey)).state, "resuming", "nothing changed");
    assert.equal((await book.resolve(qkey, { outcome: "served" })).ok, true, "control: the same drop lands once the store takes writes");
  } finally { gw.mode = "ok"; try { chmodSync(dir, 0o755); } catch { /* removed */ } rmSync(dir, { recursive: true, force: true }); }
});

await check("the resolver: a drop that does not land is counted kept, never owed or served; the owed row carries the slug booked with the entry, else the path (never the last segment); an ambiguous entry Gateway never took is dropped after the grace, a settlement_pending one never on a missing record; an unrecognized record is unreadable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-resolver2-"));
  let t = Date.now();
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {}, now: () => t });
  await book.ready;
  const rc = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"] });
  const owed = new Map();
  const resolver = createGatewayPendingResolver({ book, client: rc, now: () => t, ambiguousNoneMs: 3_600_000, log: () => {},
    recordOwed: async (row) => { owed.set(row.tx, row); return true; }, owedExists: async (tx) => owed.has(tx) });
  const mk = async (over, status) => {
    const p = await signed({ accept: baseAccept, chainId: 8453 });
    assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: p.payload.authorization.nonce, amount: "5000", payTo: TREASURY, ...over }), true);
    const rec = status ? recordFor(p, status) : null;
    if (rec) gw.transfers.push(rec);
    return { key: pendingKey("eip155:8453", acct.address, p.payload.authorization.nonce), rec };
  };
  try {
    const withSlug = await mk({ resource: "POST /v1/chat/completions", slug: "v1-chat-auto" }, "confirmed");
    const noSlug = await mk({ resource: "POST /v1/chat/completions" }, "confirmed");
    const amb = await mk({ origin: "ambiguous", cause: "gateway_http_500", validBefore: String(Math.floor(t / 1000) + 604800) }, null);
    const pend = await mk({ origin: "pending", validBefore: String(Math.floor(t / 1000) + 7200) }, null);
    await resolver.tick();
    assert.equal(owed.get(withSlug.rec.id).slug, "v1-chat-auto", "the catalog slug booked with the entry");
    assert.equal(owed.get(noSlug.rec.id).slug, "v1/chat/completions", "unknown to the catalog: the path, not its last segment");
    assert.ok(await book.get(amb.key) && await book.get(pend.key), "no record yet: both kept inside the grace");
    t += 3_600_000 + 1000;
    await resolver.tick();
    assert.equal(await book.get(amb.key), null, "ambiguous and never taken by Gateway: dropped after the grace");
    assert.ok(await book.get(pend.key), "a settlement_pending entry is not dropped for a missing record while its authorization is valid");
    t += 24 * 3_600_000;
    await resolver.tick();
    assert.ok(await book.get(pend.key), "Gateway answered settlement_pending for it: a missing record never drops it, even after its authorization expired (it waits for an operator and the word pages)");
    // A record for this nonce in a shape we do not recognize reads unreadable, never none.
    {
      const odd = await mk({ origin: "ambiguous", cause: "gateway_http_500", validBefore: String(Math.floor(t / 1000) - 10) }, null);
      const oddEntry = await book.get(odd.key);
      gw.transfers.push({ id: "not-a-uuid", status: "weird", nonce: oddEntry.nonce, fromAddress: acct.address, toAddress: TREASURY, amount: "5000" });
      const look = await rc.transferByAuthorization({ payer: acct.address, payTo: TREASURY, amount: "5000", nonce: oddEntry.nonce, network: "eip155:8453" });
      assert.equal(look.state, "unreadable", `an unrecognized record for the nonce is unreadable (${look.state})`);
      t += 3_600_000 + 1000;
      await resolver.tick();
      assert.ok(await book.get(odd.key), "so an expired ambiguous entry with an unrecognized record is kept, not dropped as not charged");
    }
    // A confirmed entry is booked owed but its drop does not land -> kept.
    const stuck = await mk({}, "confirmed");
    const failingDrop = createGatewayPendingResolver({ book: { ...book, resolve: async () => ({ ok: false, error: "the pending book could not be written" }) }, client: rc, now: () => t, log: () => {},
      recordOwed: async (row) => { owed.set(row.tx, row); return true; }, owedExists: async (tx) => owed.has(tx) });
    const r = await failingDrop.tick();
    assert.equal(r.owed, 0, `a drop that did not land is not counted owed (${JSON.stringify(r)})`);
    assert.ok(owed.has(stuck.rec.id), "the debt is in the ledger; a resend reads it and is refused");
    assert.equal((await book.get(stuck.key)).state, "pending", "and the resolver's hold is handed back");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("transfer ids compare case-insensitively: an upper-case id from Gateway is served and stored lower case, and the resolver finds a sale or debt stored in either case", async () => {
  gw.mode = "upperid";
  const s = await client.settle(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept);
  gw.mode = "ok";
  assert.equal(s.success, true);
  assert.match(s.transaction, /^[0-9a-f-]{36}$/, `stored lower case (${s.transaction})`);
  // A ledger keyed case-sensitively, holding an upper-case id.
  const UPPER = uuid().toUpperCase();
  const sales = new Map([[UPPER, { tx: UPPER }]]);
  const lookup = byTransferIdAnyCase(async (id) => sales.get(id) || null);
  assert.ok(await lookup(UPPER.toLowerCase()), "a lower-case lookup finds an upper-case row");
  assert.ok(await lookup(UPPER), "and the id as given");
  assert.equal(await lookup(uuid()), null);
  // The resolver: Gateway's record carries the id in upper case; the sale was booked in upper case.
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-case-"));
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {} });
  await book.ready;
  const p = await signed({ accept: baseAccept, chainId: 8453 });
  const rec = recordFor(p, "confirmed", { id: uuid().toUpperCase() });
  gw.transfers.push(rec);
  sales.set(rec.id, { tx: rec.id });
  assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: p.payload.authorization.nonce, amount: "5000", payTo: TREASURY }), true);
  const owed = [];
  const resolver = createGatewayPendingResolver({ book, client: new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"] }), log: () => {},
    recordOwed: async (row) => { owed.push(row); return true; }, owedExists: async () => false,
    wasServed: async ({ tx }) => !!(await lookup(tx)) });
  const r = await resolver.tick();
  assert.equal(r.served, 1, "served: the sale is found whatever its case");
  assert.equal(owed.length, 0, "never owed while a sale exists for the transfer");
  rmSync(dir, { recursive: true, force: true });
});

await check("the pending resolver: confirmed and unserved -> exactly one owed row and the entry dropped; failed -> dropped, no row; still pending -> kept; a second tick books nothing more; served -> dropped, no row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-resolver-"));
  let t = Date.now();
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {}, now: () => t, unresolvedMs: 3_600_000 });
  await book.ready;
  const rc = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"] });
  const owed = new Map();
  const recordOwed = async (row) => { if (owed.has(row.tx)) return false; owed.set(row.tx, row); return true; };
  const owedExists = async (tx) => owed.has(tx);
  const servedTx = new Set();
  const resolver = createGatewayPendingResolver({ book, client: rc, recordOwed, owedExists, wasServed: async ({ tx }) => servedTx.has(tx), log: () => {} });
  const mk = async (status) => {
    const p = await signed({ accept: baseAccept, chainId: 8453 });
    assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: p.payload.authorization.nonce, amount: "5000", payTo: TREASURY, resource: "POST /api/hash" }), true);
    const rec = status ? recordFor(p, status) : null;
    if (rec) gw.transfers.push(rec);
    return { key: pendingKey("eip155:8453", acct.address, p.payload.authorization.nonce), rec };
  };
  try {
    gw.mode = "ok";
    const conf = await mk("confirmed");
    const fail = await mk("failed");
    const wait = await mk("batched");
    const none = await mk(null);
    const done = await mk("completed");
    servedTx.add(done.rec.id);
    assert.equal(await book.alarmStatus(), "pending", "the word reads pending while entries wait");
    const r1 = await resolver.tick();
    assert.deepEqual([r1.read, r1.owed, r1.not_charged, r1.served, r1.kept], [5, 1, 1, 1, 2]);
    assert.equal(owed.size, 1, "exactly one owed row");
    const row = owed.get(conf.rec.id);
    assert.equal(row.wire, GATEWAY_WIRE); assert.equal(row.tx, conf.rec.id); assert.equal(row.priceUsd, 0.005);
    assert.equal(row.network, "eip155:8453"); assert.equal(row.payer, acct.address.toLowerCase()); assert.equal(row.slug, "hash");
    assert.equal(await book.get(conf.key), null, "the owed entry is dropped");
    assert.equal(await book.get(fail.key), null, "a failed transfer's entry is dropped");
    assert.equal(await book.get(done.key), null, "a served transfer's entry is dropped");
    assert.ok(await book.get(wait.key), "a batched (not yet confirmed) transfer stays");
    assert.ok(await book.get(none.key), "no record yet stays");
    assert.equal((await book.get(wait.key)).state, "pending", "the resolver's hold is handed back");
    const r2 = await resolver.tick();
    assert.equal(r2.owed, 0); assert.equal(owed.size, 1, "a second tick books nothing more");
    // Idempotent per key: an entry whose debt is already in the ledger is dropped without a second row.
    const again = await mk("confirmed");
    owed.set(again.rec.id, { tx: again.rec.id });
    await resolver.tick();
    assert.equal(owed.size, 2); assert.equal(await book.get(again.key), null);
    // An entry left waiting past the bound reads unresolved (it pages).
    t += 2 * 3_600_000;
    assert.equal(await book.alarmStatus(), "unresolved");
    // A ledger that refuses the write keeps the entry for the next tick.
    const refused = await mk("confirmed");
    const stubborn = createGatewayPendingResolver({ book, client: rc, recordOwed: async () => false, owedExists: async () => false, log: () => {} });
    await stubborn.tick(); await stubborn.tick();
    assert.ok(await book.get(refused.key), "kept while the debt is not in the ledger");
    // The caller path: the refund ledger itself (file mode, a scratch dir),
    // wired as src/payments.js wires it. One row, keyed on the transfer id,
    // that refund-run proves at Gateway.
    process.env.REFUND_DB_DIR = mkdtempSync(join(tmpdir(), "a402-gw-refunds-"));
    const ledger = await import("../src/refund-ledger.js");
    const real = createGatewayPendingResolver({ book, client: rc, log: () => {},
      recordOwed: async (row) => ledger.recordRefundOwed(row),
      owedExists: async (tx) => !!(await ledger.refundByEvidenceFresh(tx)) });
    await real.tick(); await real.tick();
    const rows = ledger.listRefunds({ status: "all" }).filter((r) => r.evidence === refused.rec.id);
    assert.equal(rows.length, 1, "one ledger row for the transfer");
    assert.equal(rows[0].wire, GATEWAY_WIRE); assert.equal(rows[0].status, "owed"); assert.equal(rows[0].price_usd ?? rows[0].priceUsd, 0.005);
    assert.equal(await book.get(refused.key), null, "dropped once the row is in the ledger");
    const proof = await verifyInboundPayment({ network: "eip155:8453", payer: acct.address, amountUsd: 0.005, tx: rows[0].evidence, createdAt: Date.now(), wire: GATEWAY_WIRE,
      acceptsFor: () => ({ payTo: TREASURY.toLowerCase(), asset: BASE_USDC }), payToSetFor: () => [TREASURY.toLowerCase()], rpcFor: () => null, fetchImpl: fetchStub });
    assert.equal(proof.verified, true, `refund-run's proof accepts the row: ${proof.reason || ""}`);
  } finally { gw.mode = "ok"; rmSync(dir, { recursive: true, force: true }); }
});

await check("a gateway-batched debt is proven by Gateway's transfer record and repaid on the buyer's network; an unproven one is held with its reason", async () => {
  const payTo = TREASURY.toLowerCase();
  const p = await signed({ accept: baseAccept, chainId: 8453 });
  const rows = [];
  const mk = (id, status, over = {}, rowOver = {}) => {
    const rec = recordFor(p, status, over);
    gw.transfers.push(rec);
    const row = { id, status: "owed", wire: GATEWAY_WIRE, network: "base", payer: acct.address.toLowerCase(), priceUsd: 0.005, evidence: rec.id, slug: "demand-radar", createdAt: Date.now(), ...rowOver };
    rows.push(row);
    return row;
  };
  mk(1, "confirmed");
  mk(2, "received");
  mk(3, "failed");
  mk(4, "completed", { fromAddress: `0x${"56".repeat(20)}` });
  mk(5, "completed", { amount: "4000" });
  rows.push({ id: 6, status: "owed", wire: GATEWAY_WIRE, network: "base", payer: acct.address.toLowerCase(), priceUsd: 0.005, evidence: `${acct.address.toLowerCase()}|demand-radar|2026-10-23T12:00`, slug: "demand-radar", createdAt: Date.now() });
  const plan = planRefunds(rows, { senders: { evm: true }, maxEachUsd: 1, maxTotalUsd: 10, maxPerPayerUsd: 10 });
  assert.deepEqual((plan.held[GATEWAY_NO_ID_HOLD] || []).map((r) => r.id), [6], "a row with no Gateway transfer id is held by name in the plan (the dry run prints it)");
  assert.deepEqual(plan.send.map((r) => r.id), [1, 2, 3, 4, 5]);
  const verify = (row) => verifyInboundPayment({
    network: row.network, payer: row.payer, amountUsd: row.priceUsd, tx: row.evidence, createdAt: row.createdAt, wire: row.wire,
    acceptsFor: () => ({ payTo, asset: BASE_USDC }), payToSetFor: () => [payTo], rpcFor: () => null, fetchImpl: fetchStub,
  });
  const sent = [], paid = [], warned = [];
  const out = await executeRefunds(plan.send, {
    verifyInbound: verify, claim: async () => true, prepare: async () => null,
    send: async (row) => { sent.push([row.id, row.network]); return `0x${"aa".repeat(32)}`; },
    markPaid: async (id) => { paid.push(id); }, pause: async () => {},
    log: { log: () => {}, warn: (m) => warned.push(m), error: () => {} },
  });
  assert.deepEqual(sent, [[1, "eip155:8453"]], "only the confirmed transfer is repaid, on the network the buyer paid on");
  assert.deepEqual(paid, [1]);
  assert.equal(out.ok, 1); assert.equal(out.unverified, 4);
  const why = (id) => warned.find((m) => m.startsWith(`HOLD  #${id} `)) || "";
  assert.match(why(2), /not settled yet \(status received\)/);
  assert.match(why(3), /failed - it was never charged/);
  assert.match(why(4), /different payer/);
  assert.match(why(5), /short/);
  assert.ok(gw.calls.some((c) => c.url === `${GATEWAY_API_BASE}/v1/x402/transfers/${rows[0].evidence}` && c.init.headers.Authorization === undefined), "proven by the keyless transfer lookup");
  // Control: the same row under the plain wire takes the chain path (and, with no RPC, is held there).
  const plain = await verify({ ...plan.send[0], wire: "x402" });
  assert.equal(plain.verified, false); assert.match(plain.reason, /no RPC configured|no usable transaction hash/);
});

// ---- Decision guards: each check below pins one decision the money path makes.
await check("transfer records: a record is this authorization only on its nonce, payer, payTo, exact amount, USDC and network; an unknown status is unreadable", async () => {
  const p = await signed({ accept: baseAccept, chainId: 8453 });
  const want = { payer: acct.address, payTo: TREASURY, amount: "5000", nonce: p.payload.authorization.nonce, network: "eip155:8453" };
  const norm = (over) => normalizeGatewayTransfer(recordFor(p, "confirmed", over));
  assert.equal(gatewayTransferMatches(norm({}), want), true, "control: the record for this authorization matches");
  assert.equal(gatewayTransferMatches(norm({ nonce: nonce() }), want), false, "another nonce");
  assert.equal(gatewayTransferMatches(norm({ token: "EURC" }), want), false, "another token");
  assert.equal(gatewayTransferMatches(norm({ amount: "5001" }), want), false, "more than the amount is not this authorization either");
  assert.equal(normalizeGatewayTransfer(recordFor(p, "reverted")), null, "a status outside Gateway's documented set is not a shape we read");
  gw.transfers.push(recordFor(p, "reverted"));
  const look = await client.transferByAuthorization(want);
  assert.equal(look.state, "unreadable", `an unknown status for this nonce reads unreadable, never accepted (${look.state})`);
});
await check("preflight: self-transfer, a value above the price, the validity window edges, a v1 payload, a mismatched accepted network and a high-s signature are refused before Gateway", async () => {
  const r = async (p, req = baseAccept) => (await preflightGatewayPayment(p, req, kinds))?.reason;
  const selfAccept = { ...baseAccept, payTo: acct.address };
  assert.equal(await r(await signed({ accept: selfAccept, chainId: 8453 }), selfAccept), "self_transfer");
  assert.equal(await r(await signed({ accept: baseAccept, chainId: 8453, value: "5001" })), "amount_mismatch", "a value above the price is refused too");
  assert.equal(await r(await signed({ accept: baseAccept, chainId: 8453, validAfter: now() })), undefined, "valid from this second: passes");
  assert.equal(await r(await signed({ accept: baseAccept, chainId: 8453, validAfter: now() + 120 })), "authorization_not_yet_valid");
  assert.equal(await r(await signed({ accept: baseAccept, chainId: 8453, validBefore: now() + 3 })), "authorization_expired", "inside the six-second margin");
  const good = await signed({ accept: baseAccept, chainId: 8453 });
  assert.equal(await r({ ...good, x402Version: 1 }), "invalid_payload", "a v1 payload");
  assert.equal(await r({ ...good, accepted: { ...baseAccept, network: "eip155:5042" } }), "unsupported_network", "accepted names another network than the requirement");
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const sig = good.payload.signature;
  const highS = `0x${sig.slice(2, 66)}${(N - BigInt(`0x${sig.slice(66, 130)}`)).toString(16).padStart(64, "0")}${sig.slice(130) === "1b" ? "1c" : "1b"}`;
  assert.equal(await r({ ...good, payload: { ...good.payload, signature: highS } }), "invalid_signature", "the high-s twin of a valid signature (a second encoding of one payment)");
});
await check("client: Gateway's isValid:false is a refusal; a settle success naming another network is not proof (booked as unresolved)", async () => {
  try {
    gw.mode = "verifyno";
    const v = await client.verify(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept);
    assert.deepEqual(v, { isValid: false, invalidReason: "insufficient_balance", payer: acct.address });
    gw.mode = "othernet"; pendings.length = 0;
    const s = await client.settle(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept);
    assert.equal(s.success, false); assert.equal(s.errorReason, "settlement_pending");
    assert.equal(pendings.length, 1);
  } finally { gw.mode = "ok"; }
});
await check("/supported: a USDC listing with other decimals is no kind; the balance word reads withdraw at exactly the alert", async () => {
  const d18 = structuredClone(SUPPORTED); d18.kinds[1].extra.assets[0].decimals = 18;
  assert.equal(gatewayKindsFromSupported(d18).has("eip155:8453"), false);
  _resetGatewayBalanceForTests();
  startGatewayBalanceWatch(client, { depositor: TREASURY, domains: [6, 26], intervalMs: 3_600_000 });
  await refreshGatewayBalance(client, { depositor: TREASURY, domains: [6, 26] });
  assert.deepEqual(gatewayBalanceStatus({ env: { GATEWAY_WITHDRAW_ALERT_USD: "30.5" } }), { status: "withdraw" });
  _resetGatewayBalanceForTests();
});
await check("wire: the X-PAYMENT header is read when Payment-Signature is absent; only the exact wire name is the batched wire", () => {
  const h = Buffer.from(JSON.stringify({ accepted: baseAccept })).toString("base64");
  assert.equal(isGatewayBatchedRequest({ header: (n) => (n === "x-payment" ? h : undefined) }), true);
  assert.equal(isGatewayWire("gateway-batched-v2"), false);
  assert.equal(isGatewayWire("gateway"), false);
  assert.equal(settlementKindOf("gateway-batched-v2"), "onchain");
});
await check("payments: the batched accept respects a tool's onlyNetworks; the pending book is wanted with a state database even with the switch off", () => {
  const gk = new Map([["eip155:8453", baseKind], ["eip155:5042", kinds.get("eip155:5042")]]);
  const rails = { evmCaip2: ["eip155:8453", "eip155:5042"], svmCaip2: [], stellarCaip2: [], avmCaip2: [], walletAddress: TREASURY, gatewayKinds: gk };
  const accepts = acceptsForItem({ slug: "hash", price: "$0.005", onlyNetworks: ["eip155:5042"] }, rails);
  const batchedNets = accepts.filter((a) => a.extra?.name === GATEWAY_KIND_NAME).map((a) => a.network);
  assert.deepEqual(batchedNets, ["eip155:5042"], `batched only where the tool can be served (${batchedNets})`);
  assert.equal(gatewayPendingBookWanted({ STATE_DATABASE_URL: "postgres://x/y", GATEWAY_PENDING_FILE: "/nonexistent/p.json" }), true);
  assert.equal(gatewayPendingBookWanted({ GATEWAY_PENDING_FILE: "/nonexistent/p.json" }), false, "control");
});

/** A routed resource server over a fresh pending book. */
async function routed(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-guard-"));
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {} });
  await book.ready;
  const bc = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"], onPending: (e) => book.book(e), pendingWaitMs: 60, pendingPollMs: 30 });
  await bc.getSupported();
  const plainClient = { async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }; }, async verify() { throw new Error("plain verify must not be asked"); }, async settle() { throw new Error("plain settle must not be asked"); } };
  const server = new x402ResourceServer([plainClient]).register("eip155:8453", new ExactEvmScheme());
  await server.initialize();
  installGatewayRouting(server, bc, new Set(["eip155:8453"]), { pendingBook: opts.bookView ? opts.bookView(book) : book, ...opts.routing });
  // Books a pending entry for a fresh payment (through a real pending settle).
  const pend = async (tc) => {
    gw.mode = "pending";
    const p = await signed({ accept: baseAccept, chainId: 8453 });
    await server.verifyPayment(p, baseAccept, undefined, tc);
    await server.settlePayment(p, baseAccept, undefined, tc);
    gw.mode = "ok";
    return { p, key: pendingKey("eip155:8453", acct.address, p.payload.authorization.nonce) };
  };
  return { dir, book, server, pend, done: () => { gw.mode = "ok"; rmSync(dir, { recursive: true, force: true }); } };
}
await check("resend guards: a forged signature on a booked authorization is refused; an unreadable book, a pending record with no wasServed, and a failing wasServed or owedExists all answer pending and keep the entry", async () => {
  {
    const r = await routed({ routing: { wasServed: async () => false } });
    try {
      const { p, key } = await r.pend();
      gw.transfers.push(recordFor(p, "confirmed"));
      const other = privateKeyToAccount(generatePrivateKey());
      const forged = { ...p, payload: { ...p.payload, signature: await other.signTypedData({ domain: { name: GATEWAY_KIND_NAME, version: "1", chainId: 8453, verifyingContract: GW_WALLET }, types: TYPES, primaryType: "TransferWithAuthorization", message: { ...p.payload.authorization, value: 5000n, validAfter: 0n, validBefore: BigInt(p.payload.authorization.validBefore) } }) } };
      const v = await r.server.verifyPayment(forged, baseAccept);
      assert.deepEqual([v.isValid, v.invalidReason], [false, "invalid_signature"], "the payer and nonce of someone's pending payment never buy a call without its signature");
      assert.ok(await r.book.get(key), "the entry stays");
    } finally { r.done(); }
  }
  {
    const r = await routed({ bookView: (b) => ({ ...b, get: async () => { throw new Error("store down"); } }), routing: { wasServed: async () => false } });
    try {
      const { p } = await r.pend();
      gw.calls.length = 0;
      const v = await r.server.verifyPayment(p, baseAccept);
      assert.deepEqual([v.isValid, v.invalidReason], [false, "settlement_pending"], "an unreadable book answers pending");
      assert.equal(gw.calls.filter((c) => /\/v1\/x402\/(verify|settle)$/.test(c.url)).length, 0, "and never asks Gateway to verify the authorization again");
    } finally { r.done(); }
  }
  {
    const r = await routed({ routing: { owedExists: async () => false } });
    try {
      const { p, key } = await r.pend();
      const v = await r.server.verifyPayment(p, baseAccept);
      assert.deepEqual([v.isValid, v.invalidReason], [false, "settlement_pending"], "no record yet (no wasServed wired): pending");
      assert.equal((await r.book.get(key))?.state, "pending", "the entry stays, unheld");
    } finally { r.done(); }
  }
  {
    const r = await routed({ routing: {} });
    try {
      const { p, key } = await r.pend();
      const v = await r.server.verifyPayment(p, baseAccept);
      assert.deepEqual([v.isValid, v.invalidReason], [false, "settlement_pending"], "no record yet and no ledger lookups wired: still pending, never served");
      assert.equal((await r.book.get(key))?.state, "pending");
    } finally { r.done(); }
  }
  {
    const r = await routed({ routing: { wasServed: async () => { throw new Error("ledger down"); }, owedExists: async () => false } });
    try {
      const { p, key } = await r.pend();
      gw.transfers.push(recordFor(p, "confirmed"));
      const v = await r.server.verifyPayment(p, baseAccept);
      assert.deepEqual([v.isValid, v.invalidReason], [false, "settlement_pending"], "a sale lookup that fails never serves (it may already be served)");
      assert.equal((await r.book.get(key))?.state, "pending");
    } finally { r.done(); }
  }
  {
    const r = await routed({ routing: { wasServed: async () => false, owedExists: async () => { throw new Error("ledger down"); } } });
    try {
      const { p, key } = await r.pend();
      gw.transfers.push(recordFor(p, "confirmed"));
      const v = await r.server.verifyPayment(p, baseAccept);
      assert.equal(v.isValid, false, "a debt lookup that fails never serves (it may already be owed)");
      assert.equal(v.invalidReason, "settlement_pending", "and is told to wait: no debt is known, so the entry is not closed as owed");
      assert.equal((await r.book.get(key))?.state, "pending", "the entry stays and is handed back for the resolver or the next resend");
    } finally { r.done(); }
  }
});
await check("resend outcome: a watched resend answered 400 or closed early hands its entry back; an unwatched settle that fails hands it back", async () => {
  const mkRes = () => Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
  for (const end of ["400", "close"]) {
    const r = await routed({ routing: { wasServed: async () => false, owedExists: async () => false } });
    try {
      const { p, key } = await r.pend();
      gw.transfers.push(recordFor(p, "confirmed"));
      const res = mkRes();
      const tc = { request: { adapter: { req: { method: "GET", originalUrl: "/api/x", res } } } };
      // Booked without a request (resource null); this resend names none either.
      tc.request.adapter.req = { res };
      assert.equal((await r.server.verifyPayment(p, baseAccept, undefined, tc)).isValid, true);
      assert.equal((await r.server.settlePayment(p, baseAccept, undefined, tc)).success, true);
      if (end === "400") { res.statusCode = 400; res.writableFinished = true; res.emit("finish"); } else res.emit("close");
      await sleep(50);
      assert.equal((await r.book.get(key))?.state, "pending", `${end}: not served, so the entry is handed back, never dropped`);
    } finally { r.done(); }
  }
  const r = await routed({ routing: { wasServed: async () => false, owedExists: async () => false } });
  try {
    const { p, key } = await r.pend();
    gw.transfers.push(recordFor(p, "confirmed"));
    assert.equal((await r.server.verifyPayment(p, baseAccept)).isValid, true);
    const bad = { ...p, payload: { ...p.payload, signature: `0x${"11".repeat(65)}` } };
    let out; try { out = await r.server.settlePayment(bad, baseAccept); } catch (e) { out = e; }
    assert.notEqual(out?.success, true);
    assert.equal((await r.book.get(key))?.state, "pending", "a resume whose settle failed is handed back, never dropped as served");
  } finally { r.done(); }
});
await check("the pending book: full at maxEntries (journaled past it), a resume hold lapses after its lease, and only its owner hands it back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-cap-"));
  let t = Date.now();
  const journal = { add: () => "j1", state: () => ({ total: 0 }), drain: async () => 0 };
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {}, maxEntries: 2, journal, now: () => t });
  await book.ready;
  try {
    const n1 = nonce(), n2 = nonce();
    assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: n1, amount: "5000" }), true);
    assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: n2, amount: "5000" }), true);
    assert.equal(await book.alarmStatus(), "full");
    assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: nonce(), amount: "5000" }), "journaled", "the book holds maxEntries, no more");
    const k = pendingKey("eip155:8453", acct.address, n1);
    assert.equal(await book.claimResume(k, "A"), true);
    assert.equal(await book.claimResume(k, "B"), false, "held");
    assert.equal(await book.releaseResume(k, "B"), false, "only the owner hands it back");
    assert.equal((await book.get(k)).state, "resuming");
    t += 10 * 60_000 + 1;
    assert.equal(await book.claimResume(k, "B"), true, "a hold lapses after the lease");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await check("the resolver: an entry a resend holds is left alone; a failed transfer whose drop does not land is kept; an entry with no amount is never decided", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a402-gw-resolver3-"));
  let t = Date.now();
  const book = createGatewayPendingBook({ file: join(dir, "p.json"), log: () => {}, now: () => t });
  await book.ready;
  const rc = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453"] });
  const owed = new Map();
  const opts = { client: rc, now: () => t, ambiguousNoneMs: 600_000, log: () => {}, recordOwed: async (row) => { owed.set(row.tx, row); return true; }, owedExists: async (tx) => owed.has(tx) };
  try {
    const p = await signed({ accept: baseAccept, chainId: 8453 });
    await book.book({ payer: acct.address, network: "eip155:8453", nonce: p.payload.authorization.nonce, amount: "5000", payTo: TREASURY });
    const key = pendingKey("eip155:8453", acct.address, p.payload.authorization.nonce);
    gw.transfers.push(recordFor(p, "confirmed"));
    assert.equal(await book.claimResume(key, "a-resend"), true);
    const r1 = await createGatewayPendingResolver({ book, ...opts }).tick();
    assert.deepEqual([r1.owed, r1.kept], [0, 1], "held by a resend: never booked owed while it may be served");
    assert.equal(owed.size, 0);
    assert.equal(await book.releaseResume(key, "a-resend"), true);
    await book.resolve(key, { outcome: "served" });
    const q = await signed({ accept: baseAccept, chainId: 8453 });
    await book.book({ payer: acct.address, network: "eip155:8453", nonce: q.payload.authorization.nonce, amount: "5000", payTo: TREASURY });
    gw.transfers.push(recordFor(q, "failed"));
    const r2 = await createGatewayPendingResolver({ book: { ...book, resolve: async () => ({ ok: false }) }, ...opts }).tick();
    assert.deepEqual([r2.not_charged, r2.kept], [0, 1], "a failed transfer whose drop did not land is counted kept");
    await book.resolve(pendingKey("eip155:8453", acct.address, q.payload.authorization.nonce), { outcome: "not_charged" });
    const z = await signed({ accept: baseAccept, chainId: 8453 });
    await book.book({ payer: acct.address, network: "eip155:8453", nonce: z.payload.authorization.nonce, amount: "not-a-number", origin: "ambiguous", cause: "timeout" });
    t += 3_600_000;
    const r3 = await createGatewayPendingResolver({ book, ...opts }).tick();
    assert.equal(r3.not_charged, 0, "no amount or payTo to match a record on: never dropped as not charged");
    assert.ok(await book.get(pendingKey("eip155:8453", acct.address, z.payload.authorization.nonce)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await check("refund proof at Gateway: batched (not confirmed), another token, another payTo, another network, another id, a non-EVM debt, a zero amount and a non-OK lookup are all held", async () => {
  const payTo = TREASURY.toLowerCase();
  const p = await signed({ accept: baseAccept, chainId: 8453 });
  const proof = (rec, over = {}, fetchImpl = fetchStub) => {
    if (rec) gw.transfers.push(rec);
    return verifyInboundPayment({ network: "eip155:8453", payer: acct.address, amountUsd: 0.005, tx: rec ? rec.id : uuid(), createdAt: Date.now(), wire: GATEWAY_WIRE,
      acceptsFor: () => ({ payTo, asset: BASE_USDC }), payToSetFor: () => [payTo], rpcFor: () => null, fetchImpl, ...over });
  };
  assert.equal((await proof(recordFor(p, "confirmed"))).verified, true, "control");
  const held = async (label, pr, re) => { const v = await pr; assert.equal(v.verified, false, label); if (re) assert.match(v.reason, re, label); };
  await held("batched", proof(recordFor(p, "batched")), /not settled yet/);
  await held("token", proof(recordFor(p, "confirmed", { token: "EURC" })), /not USDC/);
  await held("payTo", proof(recordFor(p, "confirmed", { toAddress: `0x${"34".repeat(20)}` })), /not to our payTo/);
  await held("network", proof(recordFor(p, "confirmed", { sendingNetwork: "eip155:5042", recipientNetwork: "eip155:5042" })), /different network/);
  const rec = recordFor(p, "confirmed");
  await held("id", proof(null, { tx: rec.id }, async () => new Response(JSON.stringify({ ...rec, id: uuid() }), { status: 200, headers: { "content-type": "application/json" } })), /different transfer/);
  await held("non-EVM", proof(recordFor(p, "confirmed"), { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payToSetFor: () => [payTo] }), /not a network the batched option settles/);
  await held("zero", proof(recordFor(p, "confirmed"), { amountUsd: 0 }), /zero/);
  await held("500", proof(null, { tx: rec.id }, async () => new Response(JSON.stringify({ error: "x" }), { status: 500, headers: { "content-type": "application/json" } })), /HTTP 500/);
  // refund-run: only the batched wire is held for a missing Gateway id.
  const plan = planRefunds([{ id: 9, status: "owed", wire: "x402", network: "base", payer: acct.address.toLowerCase(), priceUsd: 0.005, evidence: `0x${"ab".repeat(32)}`, slug: "hash", createdAt: Date.now() }], { senders: { evm: true }, maxEachUsd: 1, maxTotalUsd: 10, maxPerPayerUsd: 10 });
  assert.equal((plan.held[GATEWAY_NO_ID_HOLD] || []).length, 0, "a plain row with a chain hash is not held by the Gateway rule");
  assert.deepEqual(plan.send.map((r) => r.id), [9]);
});

// ---------------------------------------------------------------- part 2
console.log("part 2: the paid server");

const [P_PAYAI, P_CIRCLE, P_GW, ...SERVER_PORTS] = await getFreePorts(16);
// transfers: Gateway's transfer records the stub answers lookups from;
// acceptOnPending: a settle answered settlement_pending also writes a
// `received` record for that authorization (Gateway accepted it a moment later).
const st = { gw: "ok", gwSupported: "full", gwVerifyDelayMs: 0, gwHits: [], payaiHits: [], circleHits: [], transfers: [], acceptOnPending: false };
const rawJson = (res, status, obj, type = "application/json") => { res.writeHead(status, { "Content-Type": type, Connection: "close" }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });
const payaiStub = createServer(async (req, res) => {
  const body = await readBody(req);
  st.payaiHits.push({ url: req.url, body });
  const payer = body?.paymentPayload?.payload?.authorization?.from;
  if (req.url === "/supported") return rawJson(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: "eip155:137" }], extensions: [], signers: {} });
  if (req.url === "/verify") return rawJson(res, 200, { isValid: true, payer });
  if (req.url === "/settle") return rawJson(res, 200, { success: true, transaction: `0x${randomBytes(32).toString("hex")}`, network: body.paymentRequirements.network, payer });
  return rawJson(res, 404, {});
});
const circleStub = createServer(async (req, res) => {
  const body = await readBody(req);
  st.circleHits.push({ url: req.url, body });
  const payer = body?.paymentPayload?.payload?.authorization?.from;
  if (req.url === "/supported") return rawJson(res, 200, { x402Version: 2, kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:5042", asset: ARC_USDC, extra: { name: "USDC", version: "2" } }], extensions: [], signers: {} });
  if (req.headers.authorization !== `Bearer ${KEY}`) return rawJson(res, 401, { code: 401, message: "missing key" });
  if (req.url === "/verify") return rawJson(res, 200, { isValid: true, payer });
  if (req.url === "/settle") return rawJson(res, 200, { success: true, transaction: `0x${"ef".repeat(32)}`, network: "eip155:5042", payer });
  return rawJson(res, 404, {});
});
const gwStub = createServer(async (req, res) => {
  const body = await readBody(req);
  st.gwHits.push({ url: req.url, auth: req.headers.authorization || "", body });
  const payer = body?.paymentPayload?.payload?.authorization?.from;
  if (req.url.startsWith("/v1/x402/transfers?")) {
    const q = new URL(req.url, "http://x").searchParams;
    return rawJson(res, 200, { transfers: st.transfers.filter((t) => t.nonce.toLowerCase() === String(q.get("nonce")).toLowerCase()) });
  }
  if (req.url === "/v1/x402/supported") {
    if (st.gwSupported === "die") return rawJson(res, 500, `<html>${MARKER}</html>`, "text/html");
    if (st.gwSupported === "baseonly") return rawJson(res, 200, { ...SUPPORTED, kinds: SUPPORTED.kinds.filter((k) => k.network === "eip155:8453") });
    return rawJson(res, 200, SUPPORTED);
  }
  if (req.url === "/v1/balances") return rawJson(res, 200, { token: "USDC", balances: [{ domain: 6, depositor: body?.sources?.[0]?.depositor, balance: "30.5" }] });
  if (req.url === "/v1/x402/verify") { if (st.gwVerifyDelayMs) await sleep(st.gwVerifyDelayMs); return rawJson(res, 200, { isValid: true, payer }); }
  if (req.url === "/v1/x402/settle") {
    if (st.gw === "html500") return rawJson(res, 500, `<html>${MARKER}</html>`, "text/html");
    if (st.gw === "status402") return rawJson(res, 402, { success: false, errorReason: "insufficient_balance", transaction: "", network: body.paymentRequirements.network });
    if (st.gw === "pending") {
      if (st.acceptOnPending) st.transfers.push(recordFor(body.paymentPayload, "received"));
      return rawJson(res, 200, { success: false, errorReason: "settlement_pending", transaction: "", network: body.paymentRequirements.network, payer });
    }
    return rawJson(res, 200, { success: true, transaction: uuid(), network: body.paymentRequirements.network, payer });
  }
  return rawJson(res, 404, {});
});
await Promise.all([[payaiStub, P_PAYAI], [circleStub, P_CIRCLE], [gwStub, P_GW]].map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));

const tmp = mkdtempSync(join(tmpdir(), "a402-gateway-"));
const preload = join(tmp, "redirect.mjs");
writeFileSync(preload, `
const CIRCLE = ${JSON.stringify(CIRCLE_FACILITATOR_BASE)};
const GW = ${JSON.stringify(GATEWAY_API_BASE)};
const real = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
  if (typeof u === "string" && u.startsWith(GW)) return real(process.env.GW_TEST_STUB + u.slice(GW.length), init);
  if (typeof u === "string" && u.startsWith(CIRCLE)) return real(process.env.CIRCLE_TEST_STUB + u.slice(CIRCLE.length), init);
  return real(input, init);
};
`);
const OP = "gateway-test-operator-token-0123456789";
let portIdx = 0;
async function boot(extraEnv = {}) {
  const port = SERVER_PORTS[portIdx++];
  mkdirSync(join(tmp, `refunds-${port}`), { recursive: true });
  const env = { ...process.env };
  for (const k of ["STATE_DATABASE_URL", "REDIS_URL", "CIRCLE_FACILITATOR_API_KEY", "GATEWAY_NANOPAYMENTS", "GATEWAY_NANOPAYMENT_NETWORKS", "GATEWAY_WITHDRAW_ALERT_USD", "GATEWAY_PENDING_WAIT_MS"]) delete env[k];
  const proc = spawn(process.execPath, ["--import", preload, "src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...env, PORT: String(port), FREE_MODE: "",
      WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base,polygon,arc",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "",
      PAYAI_FACILITATOR_URL: `http://127.0.0.1:${P_PAYAI}`, PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      CIRCLE_FACILITATOR_API_KEY: KEY, CIRCLE_TEST_STUB: `http://127.0.0.1:${P_CIRCLE}`, GW_TEST_STUB: `http://127.0.0.1:${P_GW}`,
      GATEWAY_NANOPAYMENTS: "on", GATEWAY_PENDING_WAIT_MS: "600",
      SOLVADOR_KEY: "", PAYMENT_SETTLE_FALLBACK: "", X402_UPTO_NETWORKS: "", POSTHOG_API_KEY: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "",
      SALES_LEDGER_DB: join(tmp, `sales-${port}.db`), REFUND_DB_DIR: join(tmp, `refunds-${port}`), INFLIGHT_COVER: "off",
      CIRCLE_PENDING_FILE: join(tmp, `circle-pending-${port}.json`), GATEWAY_PENDING_FILE: join(tmp, `gateway-pending-${port}.json`), GATED_RAIL_HISTORY_FILE: join(tmp, `gated-history-${port}.json`),
      HANGUP_FORGIVE_FILE: join(tmp, `hangup-${port}.json`), AGENT402_OPERATOR_TOKEN: OP,
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
    try { if ((await fetch(`${base}/health`)).ok) return { base, log, proc, port }; } catch { /* booting */ }
    await sleep(500);
  }
  proc.kill("SIGKILL");
  throw new Error(`server did not boot\n${log.text.slice(-3000)}`);
}
const PATH = "/api/demand-radar?limit=1";
const read402 = async (base, path = PATH, init = {}) => {
  const r = await fetch(`${base}${path}`, init);
  await r.text();
  assert.equal(r.status, 402, `unpaid ${path} answers 402 (got ${r.status})`);
  return { env: decode(r.headers.get("payment-required")), header: r.headers.get("payment-required"), res: r };
};
const batchedOf = (env, network) => env.accepts.find((a) => a.network === network && a.extra?.name === GATEWAY_KIND_NAME);
const plainOf = (env, network) => env.accepts.find((a) => a.network === network && a.scheme === "exact" && a.extra?.name !== GATEWAY_KIND_NAME);
const pay = (base, p, path = PATH, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...(init.headers || {}), "payment-signature": Buffer.from(JSON.stringify(p)).toString("base64") } });
const sales = (port) => { const db = new Database(join(tmp, `sales-${port}.db`), { readonly: true }); try { return db.prepare("SELECT slug, price_usd, rail, network, payer, tx, wire FROM sales ORDER BY id").all(); } finally { db.close(); } };
const gwSettles = () => st.gwHits.filter((h) => h.url === "/v1/x402/settle").length;
const gwVerifies = () => st.gwHits.filter((h) => h.url === "/v1/x402/verify").length;
const leaks = (text) => text.includes(MARKER);

await check("switch on: the 402 carries the batched accept on Arc and Base only, last, at the plain accept's price and payTo, valid against the protocol schema", async () => {
  const { base, log, proc, port } = await boot();
  try {
    const { env, header } = await read402(base);
    assert.match(log.text, /Circle Gateway batched option: offered on eip155:5042, eip155:8453|offered on eip155:8453, eip155:5042/);
    const nets = env.accepts.map((a) => `${a.network}${a.extra?.name === GATEWAY_KIND_NAME ? "+batched" : ""}`);
    assert.deepEqual(nets, ["eip155:8453", "eip155:137", "eip155:5042", "eip155:5042+batched", "eip155:8453+batched"].sort((a, b) => nets.indexOf(a) - nets.indexOf(b)));
    assert.equal(env.accepts.length, 5, `three plain accepts and two batched (${nets})`);
    assert.ok(env.accepts.slice(0, 3).every((a) => a.extra?.name !== GATEWAY_KIND_NAME) && env.accepts.slice(3).every((a) => a.extra?.name === GATEWAY_KIND_NAME), "the batched accepts come last");
    assert.equal(batchedOf(env, "eip155:137"), undefined, "none on Polygon, though Gateway lists it");
    for (const network of ["eip155:8453", "eip155:5042"]) {
      const b = batchedOf(env, network), p = plainOf(env, network);
      assert.ok(b, `batched accept on ${network}`);
      assert.equal(b.scheme, "exact");
      assert.equal(b.amount, p.amount, "same price as the plain accept");
      assert.equal(b.payTo.toLowerCase(), TREASURY.toLowerCase());
      assert.equal(b.asset.toLowerCase(), p.asset.toLowerCase(), "the same USDC the plain accept names");
      assert.deepEqual(b.extra, { name: GATEWAY_KIND_NAME, version: "1", verifyingContract: GW_WALLET });
      assert.equal(b.maxTimeoutSeconds, 604900, "the kind's minValiditySeconds plus the buffer");
      assert.equal(b.outputSchema, undefined, "the typed output schema rides the first accept only");
      assert.equal(p.maxTimeoutSeconds, 300, "the plain accept is untouched");
    }
    const parsed = parsePaymentRequired(decode(header));
    assert.equal(parsed.success, true, `the challenge with the batched accepts parses under the protocol's own schema (${parsed.error?.issues?.[0]?.message || ""})`);
    assert.equal(parsed.data.accepts.length, 5);
    // The identity-bound route offers the plain EVM accepts only.
    const mem = await read402(base, "/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "k", value: "v" }) });
    assert.ok(mem.env.accepts.length >= 3 && mem.env.accepts.every((a) => a.extra?.name !== GATEWAY_KIND_NAME), `an identity-bound route carries no batched accept (${mem.env.accepts.map((a) => a.network)})`);
    // The public surfaces say so, derived from the same offer.
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    assert.deepEqual(pricing.payment.acceptKinds.base, ["exact", "exact:GatewayWalletBatched"]);
    assert.deepEqual(pricing.payment.acceptKinds.arc, ["exact", "exact:GatewayWalletBatched"]);
    assert.deepEqual(pricing.payment.acceptKinds.polygon, ["exact"]);
    assert.deepEqual(Object.keys(pricing.payment.gatewayNanopayments.networks).sort(), ["eip155:5042", "eip155:8453"]);
    assert.equal(pricing.payment.gatewayNanopayments.kind, GATEWAY_KIND_NAME);
    assert.match(pricing.payment.gatewayNanopayments.buyerGas, /none/);
    const manifest = await (await fetch(`${base}/.well-known/x402`)).json();
    assert.deepEqual(Object.keys(manifest.payment.x402.gatewayNanopayments.networks).sort(), ["eip155:5042", "eip155:8453"]);
    assert.deepEqual(manifest.payment.x402.acceptKinds.polygon, ["exact"]);
    const llms = await (await fetch(`${base}/llms.txt`)).text();
    assert.match(llms, /Batched option, no gas per call \(Circle Gateway nanopayments\)\.\*\* On (Base and Arc|Arc and Base)/);
    assert.match(llms, /GatewayWalletBatched/);
    assert.match(llms, /`maxTimeoutSeconds` of 604900 seconds/, "the validity window is read from the offer (Gateway's minValiditySeconds plus the buffer)");
    assert.doesNotMatch(llms, /seven-day/, "never typed");
    // The copy names the buyer's Gateway deposit beside "no gas" (never
    // "once": the buyer tops the balance up as it runs low),
    // and every surface that describes the implicit replay names the
    // identity-bound exclusion.
    assert.match(llms, /after a USDC deposit into Circle Gateway \(an on-chain transfer the buyer makes and pays gas for\)/);
    assert.match(llms, /Identity-bound routes and routes with a lasting effect \(such as memory writes, attest and the route-execute tiers\) offer the plain accept only/);
    assert.match(llms, /\(identity-bound routes, routes with a lasting effect and streamed calls excepted\)/);
    const depositSentence = "After a USDC deposit into Gateway (an on-chain transfer the buyer makes and pays gas for), each payment is a signature against that balance, with no gas per payment.";
    assert.ok(pricing.payment.gatewayNanopayments.buyerGas.includes(depositSentence), "the deposit sentence on /api/pricing");
    assert.ok(manifest.payment.x402.gatewayNanopayments.buyerGas.includes(depositSentence), "the deposit sentence on /.well-known/x402");
    for (const [where, text] of [["/api/pricing", JSON.stringify(pricing)], ["/.well-known/x402", JSON.stringify(manifest)], ["llms.txt", llms]]) {
      assert.doesNotMatch(text, /one-time (USDC )?deposit|deposits USDC into Gateway once|Gas-free/i, `${where}: no "deposit once" and no unscoped gas-free claim`);
    }
    // The legal pages and /how-to-pay carry the batched text only while the
    // option is offered (the off boot below asserts its absence).
    const flat = async (path) => (await (await fetch(`${base}${path}`)).text()).replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    const terms = await flat("/terms");
    assert.ok(terms.includes("A Circle Gateway batched payment settles off chain at Gateway. If Gateway settles one after its request was answered pending and the request is never served, we record the amount as owed and repay it on chain after confirming it in Gateway's records."), "terms: the batched paragraph");
    assert.ok(terms.includes("Paid calls settle on public blockchains (except Circle Gateway batched payments, below)"), "terms: the on-chain sentence is scoped");
    assert.ok(terms.includes("confirm on that chain that your payment reached us (for a Circle Gateway batched payment, in Gateway's records)"), "terms: the refund check is scoped");
    const priv = await flat("/privacy");
    assert.ok(priv.includes("Circle Gateway batched payments are verified and settled by Circle Gateway off chain; the sales ledger keeps Gateway's transfer id for them."), "privacy: the batched sentence");
    assert.ok(priv.includes("for a payment settled on chain, wallet addresses, amounts, and timestamps are public on-chain"), "privacy: the public on-chain sentence is scoped");
    assert.ok(priv.includes("Payment verification for every other payment is performed by the payment facilitators"), "privacy: the verifier sentence is scoped");
    const htp = await flat("/how-to-pay");
    assert.ok(htp.includes("Gateway batched") && htp.includes("A 402 with Retry-After; resend the same payment to be served; a payment that settles and is never served is booked as owed."), "/how-to-pay: the Gateway row in the failure table");
    const privacy = (await (await fetch(`${base}/privacy`)).text()).replace(/\s+/g, " ");
    assert.match(privacy, /not on identity-bound routes such as memory, on routes with a lasting effect, or for streamed calls/);
    const openapi = await (await fetch(`${base}/openapi.json`)).json();
    const hashInfo = openapi.paths["/api/hash"].post["x-payment-info"];
    assert.deepEqual(hashInfo.nanopayments.networks.sort(), ["eip155:5042", "eip155:8453"]);
    assert.equal(openapi.paths["/api/memory"].post["x-payment-info"].nanopayments, undefined, "no batched option on an identity-bound route in openapi either");
    // /api/rails and the connector's payment.info name the option while it is live.
    const rails = await (await fetch(`${base}/api/rails`)).json();
    assert.equal(rails.gatewayBatched?.kind, GATEWAY_KIND_NAME, "/api/rails: the batched kind");
    assert.deepEqual([...rails.gatewayBatched.networks].sort(), ["arc", "base"], "/api/rails: the batched networks");
    const pinfo = await mcpPaymentInfo(base);
    assert.match(pinfo.pay.batched || "", /Circle Gateway batched accept \(extra\.name GatewayWalletBatched\)/, "payment.info: the batched line");
    assert.match(pinfo.pay.batched, /agent402-mcp and agent402-client pay the plain accept/, "payment.info: which accept the packages pay");
    assert.match(pinfo.pay.retries, /X-Replayed-Answer: 1/, "payment.info: the implicit replay");
    for (const [page, want] of [["/base", true], ["/arc", true], ["/polygon", false]]) {
      const html = await (await fetch(`${base}${page}`)).text();
      assert.equal(/batched option/.test(html), want, `${page} ${want ? "names" : "does not name"} the batched option`);
    }
    // The status words are words.
    const pub = await (await fetch(`${base}/api/gateway-status`)).json();
    assert.deepEqual(pub.gatewayPending, { status: "ok" });
    assert.ok(["unknown", "ok", "withdraw"].includes(pub.gatewayBalance?.status) && Object.keys(pub.gatewayBalance).join(",") === "status", `gatewayBalance publishes its word only (${JSON.stringify(pub.gatewayBalance)})`);
    await sleep(2000);
    const op = await (await fetch(`${base}/api/gateway-status`, { headers: { Authorization: `Bearer ${OP}` } })).json();
    assert.equal(op.gatewayBalance.status, "withdraw", `30.5 is past the default alert (${JSON.stringify(op.gatewayBalance)})`);
    assert.equal(op.gatewayBalance.usd, 30.5, "the figure is on the operator view");
    const pub2 = await (await fetch(`${base}/api/gateway-status`)).json();
    assert.deepEqual(pub2.gatewayBalance, { status: "withdraw" });
    assert.ok(!/"usd":\s*30\.5/.test(JSON.stringify(pub2)), "the public body carries no figure");
    assert.ok(!leaks(log.text), "no upstream body in the boot log");
  } finally { proc.kill("SIGKILL"); void port; }
});

await check("every catalog route's 402 stays under the challenge ceiling with the batched accepts in it; a route with a lasting effect (hasLastingEffect) or an identity-bound route carries none", async () => {
  const { base, proc } = await boot();
  try {
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    const lasting = new Set(LASTING_EFFECT_SLUG_LIST);
    const routes = pricing.endpoints.map((e) => ({ method: e.method || "GET", path: e.path, slug: e.slug })).filter((r) => r.path);
    assert.ok(routes.filter((r) => lasting.has(r.slug)).length >= 8, "the lasting-effect routes are in the catalog");
    const lastingSeen = new Set();
    assert.ok(routes.length > 400, `the catalog lists its routes (${routes.length})`);
    let worst = { bytes: 0, total: 0, path: null };
    let n = 0;
    const one = async (r) => {
      await new Promise((resolve, reject) => {
        const req = httpRequest(`${base}${r.path}`, { method: r.method, headers: r.method === "POST" ? { "content-type": "application/json" } : {}, maxHeaderSize: 262144 }, (res) => {
          res.resume();
          let total = 20;
          for (let i = 0; i < res.rawHeaders.length; i += 2) total += res.rawHeaders[i].length + res.rawHeaders[i + 1].length + 4;
          const pr = res.headers["payment-required"];
          if (res.statusCode === 402 && pr) {
            n++;
            if (pr.length > worst.bytes) worst = { bytes: pr.length, total, path: r.path };
            const offered = !!batchedOf(decode(pr), "eip155:8453") || !!batchedOf(decode(pr), "eip155:5042");
            // Identity-bound routes (memory, my-usage, attest, feedback) are
            // proven plain-only by the memory check above; here they may lack it.
            const identityBound = /\/memory|my-usage|attest|feedback|receipts/.test(r.path);
            if (lasting.has(r.slug)) lastingSeen.add(r.slug);
            if (lasting.has(r.slug) && offered) reject(new Error(`${r.path}: a batched accept on a route with a lasting effect (a pending answer's resend would run it twice)`));
            if (!lasting.has(r.slug) && !identityBound && !offered) reject(new Error(`${r.path}: no batched accept`));
          }
          res.on("end", resolve);
        });
        req.on("error", reject);
        req.end(r.method === "POST" ? "{}" : undefined);
      });
    };
    const queue = [...routes];
    await Promise.all(Array.from({ length: 8 }, async () => { for (let r = queue.shift(); r; r = queue.shift()) await one(r); }));
    assert.ok(n > 400, `${n} routes answered a 402`);
    for (const slug of ["route-execute", "route-execute-plus", "seller-payability", "memory-write", "attest", "feedback"]) assert.ok(lastingSeen.has(slug), `${slug} answered a 402 with no batched accept`);
    console.log(`    widest challenge ${worst.bytes} base64 bytes (${worst.total} header bytes total) on ${worst.path}`);
    assert.ok(worst.bytes <= 12_000, `the widest challenge is under the 12,000-byte echo ceiling (${worst.bytes} on ${worst.path})`);
    assert.ok(worst.total <= 13_800, `the widest 402's headers are under the 13,800-byte total (${worst.total} on ${worst.path})`);
  } finally { proc.kill("SIGKILL"); }
});

await check("a batched payment on Base and on Arc is served, settled by Gateway after the handler, and booked under the gateway-batched wire", async () => {
  const { base, log, proc, port } = await boot();
  try {
    const { env } = await read402(base);
    st.gwHits.length = 0; st.payaiHits.length = 0; st.circleHits.length = 0;
    for (const [network, chainId] of [["eip155:8453", 8453], ["eip155:5042", 5042]]) {
      const accept = batchedOf(env, network);
      const p = await signed({ accept, chainId, resource: env.resource });
      const r = await pay(base, p);
      const body = await r.text();
      assert.equal(r.status, 200, `a batched payment on ${network} is served (got ${r.status}: ${body.slice(0, 200)})`);
      const receipt = decode(r.headers.get("payment-response"));
      assert.equal(receipt.success, true);
      assert.equal(receipt.network, network);
      assert.match(receipt.transaction, /^[0-9a-f-]{36}$/, "the receipt names Gateway's transaction id");
      assert.equal(receipt.payer.toLowerCase(), acct.address.toLowerCase());
      const v = st.gwHits.find((h) => h.url === "/v1/x402/verify" && h.body.paymentRequirements.network === network);
      const s = st.gwHits.find((h) => h.url === "/v1/x402/settle" && h.body.paymentRequirements.network === network);
      assert.ok(v && s, "Gateway verified and settled it");
      for (const h of [v, s]) {
        assert.equal(h.auth, "", "keyless");
        assert.equal(h.body.paymentRequirements.extra.name, GATEWAY_KIND_NAME);
        assert.equal(h.body.paymentRequirements.extra.verifyingContract, GW_WALLET);
        assert.equal(h.body.paymentRequirements.amount, accept.amount);
        assert.equal(h.body.paymentRequirements.payTo.toLowerCase(), TREASURY.toLowerCase());
        assert.equal(h.body.paymentPayload.payload.authorization.nonce, p.payload.authorization.nonce);
      }
    }
    assert.ok(!st.payaiHits.some((h) => h.url !== "/supported"), "the plain Base facilitator saw no batched payment");
    assert.ok(!st.circleHits.some((h) => h.url !== "/supported"), "Circle's Arc facilitator saw no batched payment");
    await sleep(400);
    const rows = sales(port);
    assert.equal(rows.length, 2, `two sales booked (${JSON.stringify(rows)})`);
    assert.deepEqual(rows.map((r) => r.wire), [GATEWAY_WIRE, GATEWAY_WIRE]);
    assert.deepEqual(rows.map((r) => r.network), ["base", "arc"]);
    assert.ok(rows.every((r) => /^[0-9a-f-]{36}$/.test(r.tx) && r.payer === acct.address.toLowerCase() && r.rail === "usdc" && r.slug === "demand-radar"), "each row carries Gateway's id, the payer and the price");
    assert.equal(rows[0].price_usd, Number(batchedOf(env, "eip155:8453").amount) / 1e6, "the paid amount");
    // The ledger reads the row as settled off chain.
    const { saleByTx } = await import("../src/sales-ledger.js?gw-" + port);
    void saleByTx;
    assert.ok(!leaks(log.text));
  } finally { proc.kill("SIGKILL"); }
});

await check("a handler 4xx never settles; settlement_pending answers 402 with the reason and hint, books no sale and lands in the pending book; an HTML 500 leaks nothing; a plain payment never reaches Gateway; a hang-up during verify runs and settles nothing", async () => {
  const { base, log, proc, port } = await boot();
  try {
    const { env } = await read402(base);
    const hash402 = await read402(base, "/api/hash", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
    const hashAccept = batchedOf(hash402.env, "eip155:8453");
    st.gwHits.length = 0;
    // Handler 4xx: the payment verifies, the handler refuses the input, nothing settles.
    const bad = await pay(base, await signed({ accept: hashAccept, chainId: 8453, resource: hash402.env.resource }), "/api/hash", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", algo: "not-a-hash" }) });
    const badBody = await bad.text();
    assert.ok(bad.status >= 400 && bad.status < 500 && bad.status !== 402, `the handler refused the input (got ${bad.status}: ${badBody.slice(0, 160)})`);
    assert.equal(gwVerifies(), 1, "Gateway verified it");
    assert.equal(gwSettles(), 0, "Gateway was never asked to settle a 4xx");
    await sleep(300);
    assert.equal(sales(port).length, 0, "no sale");
    // settlement_pending, still unresolved after the wait.
    st.gw = "pending"; st.gwHits.length = 0;
    const accept = batchedOf(env, "eip155:8453");
    const pp = await signed({ accept, chainId: 8453, resource: env.resource });
    const r = await pay(base, pp);
    const body = await r.json();
    assert.equal(r.status, 402, `a pending settlement is not served (got ${r.status})`);
    assert.equal(body.reason, "settlement-pending");
    assert.match(body.hint, /has not confirmed this batched payment yet/);
    assert.match(body.hint, /same payment header/);
    assert.equal(body.error, undefined, "a body that explains itself carries no error");
    assert.equal(body.retry, "same-payment");
    assert.equal(r.headers.get("retry-after"), "10");
    assert.equal(body.network, "eip155:8453");
    const receipt = decode(r.headers.get("payment-response"));
    assert.equal(receipt.success, false); assert.equal(receipt.errorReason, "settlement_pending"); assert.equal(receipt.transaction, "");
    assert.equal(gwSettles(), 1, "one settle call, no vendor retry on an empty transaction");
    assert.ok(st.gwHits.some((h) => h.url.startsWith("/v1/x402/transfers?")), "Gateway's record was read during the wait");
    await sleep(400);
    assert.equal(sales(port).length, 0, "no sale for a pending settlement");
    const pending = await (await fetch(`${base}/__operator/gateway-pending.json`, { headers: { Authorization: `Bearer ${OP}` } })).json();
    assert.equal(pending.count, 1);
    assert.equal(pending.entries[0].nonce, pp.payload.authorization.nonce.toLowerCase());
    assert.equal(pending.entries[0].network, "eip155:8453");
    assert.equal(pending.entries[0].payer, acct.address.toLowerCase());
    assert.equal(pending.entries[0].amount, accept.amount);
    assert.equal(pending.entries[0].resource, "GET /api/demand-radar", "booked by the method and path this server answered");
    const radarSlug = (await (await fetch(`${base}/api/pricing`)).json()).endpoints.find((e) => e.path === "/api/demand-radar").slug;
    assert.equal(pending.entries[0].slug, radarSlug, "booked with the route's catalog slug");
    assert.equal(pending.entries[0].origin, "pending");
    const pub = await (await fetch(`${base}/api/gateway-status`)).json();
    assert.deepEqual(pub.gatewayPending, { status: "pending" });
    assert.equal((await fetch(`${base}/__operator/gateway-pending.json`)).status, 404, "the operator view needs the token");
    const resolved = await (await fetch(`${base}/__operator/gateway-pending`, { method: "POST", headers: { Authorization: `Bearer ${OP}`, "content-type": "application/json" }, body: JSON.stringify({ action: "resolve", key: pending.entries[0].key, outcome: "not_charged", note: "test" }) })).json();
    assert.equal(resolved.ok, true);
    assert.deepEqual((await (await fetch(`${base}/api/gateway-status`)).json()).gatewayPending, { status: "ok" });
    // Resolved by the operator, the entry is gone; a resend goes to Gateway,
    // which (still pending here) is not served.
    const again = await pay(base, pp);
    await again.text();
    assert.equal(again.status, 402, "a resent pending authorization is not served while Gateway still holds it pending");
    // HTML 500 from Gateway at settle: Gateway may have taken it, so it is
    // answered and booked exactly as settlement_pending; nothing leaked.
    st.gw = "html500";
    const p500 = await signed({ accept, chainId: 8453, resource: env.resource });
    const rf = await pay(base, p500);
    const rfText = await rf.text();
    assert.equal(rf.status, 402);
    assert.equal(JSON.parse(rfText).reason, "settlement-pending", "an ambiguous settle is answered as pending");
    assert.ok(!leaks(`${rfText} ${JSON.stringify(Object.fromEntries(rf.headers))}`), "the buyer's 402 carries no upstream body");
    const amb = (await (await fetch(`${base}/__operator/gateway-pending.json`, { headers: { Authorization: `Bearer ${OP}` } })).json()).entries.find((e) => e.nonce === p500.payload.authorization.nonce.toLowerCase());
    assert.ok(amb, "the ambiguous settle is in the pending book");
    assert.deepEqual([amb.origin, amb.cause], ["ambiguous", "gateway_http_500"]);
    st.gw = "ok";
    // A plain payment on Base goes to the plain facilitator; Gateway never sees it.
    // A fresh wallet: the first one's refused settles met the per-wallet
    // settle breaker, which bounds a buyer whose settlements keep failing.
    const acct2 = privateKeyToAccount(generatePrivateKey());
    st.gwHits.length = 0; st.payaiHits.length = 0;
    const plain = plainOf(env, "eip155:8453");
    const plainPayload = { x402Version: 2, resource: env.resource, accepted: plain, payload: { signature: `0x${"11".repeat(65)}`, authorization: { from: acct2.address, to: plain.payTo, value: plain.amount, validAfter: "0", validBefore: String(now() + 300), nonce: nonce() } } };
    const rp = await pay(base, plainPayload);
    await rp.text();
    assert.equal(rp.status, 200, `a plain payment is served (got ${rp.status})`);
    assert.equal(st.gwHits.length, 0, "Gateway saw nothing");
    assert.ok(st.payaiHits.some((h) => h.url === "/settle"), "the plain facilitator settled it");
    await sleep(400);
    const rows = sales(port);
    assert.equal(rows.length, 1); assert.equal(rows[0].wire, "x402");
    // A batched-shaped payment on a chain without the option is refused before Gateway.
    st.gwHits.length = 0;
    const fake = { ...plainOf(env, "eip155:137"), ...gatewayAcceptFields(baseKind) };
    const rpoly = await pay(base, await signed({ accept: fake, chainId: 137, resource: env.resource, signer: acct2 }));
    await rpoly.text();
    assert.equal(rpoly.status, 402);
    assert.equal(st.gwHits.length, 0, "Gateway saw nothing for a chain the offer does not carry");
    // A hang-up while Gateway is still verifying: the handler never runs, nothing settles, nothing owed.
    st.gwVerifyDelayMs = 500; st.gwHits.length = 0;
    const hp = await signed({ accept, chainId: 8453, resource: env.resource, signer: acct2 });
    await new Promise((resolve) => {
      const req = httpRequest(`${base}${PATH}`, { method: "GET", headers: { "payment-signature": Buffer.from(JSON.stringify(hp)).toString("base64") } });
      req.on("error", resolve); req.on("response", (res) => { res.resume(); resolve(); });
      req.end();
      setTimeout(() => { req.destroy(); resolve(); }, 120);
    });
    await sleep(1200);
    st.gwVerifyDelayMs = 0;
    assert.equal(gwVerifies(), 1, "Gateway was asked to verify");
    assert.equal(gwSettles(), 0, "nothing settled for a buyer who left");
    assert.equal(sales(port).length, 1, "no new sale");
    const refunds = await (await fetch(`${base}/__operator/refunds.json?status=all`, { headers: { Authorization: `Bearer ${OP}` } })).json();
    assert.equal((refunds.refunds || []).length, 0, "nothing owed");
    assert.match(log.text, /NOT CHARGED: client closed the connection/);
    assert.ok(!leaks(log.text));
  } finally { proc.kill("SIGKILL"); st.gw = "ok"; st.gwVerifyDelayMs = 0; }
});

await check("pending, end to end: Gateway accepts inside the wait -> served and booked once; still pending -> the same payment resent is refused at verify without reaching Gateway's verify or settle, then served exactly once on Gateway's record when it settles; the pending answers never trip the wallet's breaker", async () => {
  const { base, log, proc, port } = await boot();
  try {
    const { env } = await read402(base);
    const accept = batchedOf(env, "eip155:8453");
    const buyer = privateKeyToAccount(generatePrivateKey());
    // Accepted inside the wait: served on the record, nothing pending.
    st.gw = "pending"; st.acceptOnPending = true; st.gwHits.length = 0;
    const p1 = await signed({ accept, chainId: 8453, resource: env.resource, signer: buyer });
    const r1 = await pay(base, p1);
    await r1.text();
    assert.equal(r1.status, 200, `accepted inside the wait is served (got ${r1.status})`);
    const rec1 = st.transfers.find((t) => t.nonce === p1.payload.authorization.nonce);
    assert.equal(decode(r1.headers.get("payment-response")).transaction, rec1.id, "the receipt names Gateway's transfer id");
    st.acceptOnPending = false;
    await sleep(400);
    assert.deepEqual(sales(port).map((x) => [x.tx, x.wire]), [[rec1.id, GATEWAY_WIRE]], "one sale, under Gateway's transfer id");
    // Still pending after the wait, three times over (three payments): the
    // wallet's settle breaker counts none of them.
    const ps = [];
    for (let i = 0; i < 3; i++) {
      const p = await signed({ accept, chainId: 8453, resource: env.resource, signer: buyer });
      const r = await pay(base, p);
      await r.text();
      assert.equal(r.status, 402);
      ps.push(p);
    }
    const pend = await (await fetch(`${base}/__operator/gateway-pending.json`, { headers: { Authorization: `Bearer ${OP}` } })).json();
    assert.equal(pend.count, 3, "three pending entries");
    // Resent while Gateway still has no settled record: refused at verify, the handler never runs, Gateway is only read.
    st.gw = "ok"; st.gwHits.length = 0;
    const [p] = ps;
    const again = await pay(base, p);
    const againBody = await again.json();
    assert.equal(again.status, 402);
    assert.equal(againBody.reason, "settlement-pending");
    assert.equal(againBody.retry, "same-payment");
    assert.match(againBody.hint, /Do not sign a new authorization/);
    assert.equal(gwVerifies() + gwSettles(), 0, "no Gateway verify or settle for the resend");
    assert.ok(st.gwHits.some((h) => h.url.startsWith("/v1/x402/transfers?")), "Gateway's record was read");
    // Gateway settles it: the same payment resent is served once, booked once.
    const rec = recordFor(p, "confirmed");
    st.transfers.push(rec);
    const served = await pay(base, p);
    await served.text();
    assert.equal(served.status, 200, `the resend is served once Gateway settled it (got ${served.status}); the wallet was never blocked`);
    assert.equal(decode(served.headers.get("payment-response")).transaction, rec.id);
    assert.equal(gwVerifies() + gwSettles(), 0, "served on the record: still no Gateway verify or settle");
    await sleep(400);
    const rows = sales(port);
    assert.deepEqual(rows.map((x) => x.tx), [rec1.id, rec.id], "booked exactly once, under the transfer id");
    assert.equal(rows[1].wire, GATEWAY_WIRE);
    const pend2 = await (await fetch(`${base}/__operator/gateway-pending.json`, { headers: { Authorization: `Bearer ${OP}` } })).json();
    assert.equal(pend2.count, 2, "its entry is dropped");
    // The same payment once more: answered from its first answer by the replay
    // cache (no handler, no Gateway call, no second sale), never run again.
    const third = await pay(base, p);
    await third.text();
    assert.ok(third.status !== 200 || third.headers.get("x-replayed-answer") === "1", `a payment already served is never run again: refused, or the stored answer marked as a replay (got ${third.status}, replay ${third.headers.get("x-replayed-answer")})`);
    assert.equal(gwVerifies() + gwSettles(), 0, "the resend reaches neither Gateway verify nor settle");
    await sleep(400);
    assert.equal(sales(port).length, 2, "no second sale");
    assert.ok(!leaks(log.text));
  } finally { proc.kill("SIGKILL"); st.gw = "ok"; st.acceptOnPending = false; }
});

await check("with the settle fallback on, an HTML 500 and an HTTP 402 from Gateway's /settle never reach the chain facilitators", async () => {
  const { base, log, proc } = await boot({ PAYMENT_SETTLE_FALLBACK: "on" });
  try {
    assert.match(log.text, /Settle fallback: ON/);
    const { env } = await read402(base);
    const accept = batchedOf(env, "eip155:8453");
    for (const mode of ["html500", "status402"]) {
      st.gw = mode; st.gwHits.length = 0; st.payaiHits.length = 0; st.circleHits.length = 0;
      const r = await pay(base, await signed({ accept, chainId: 8453, resource: env.resource, signer: privateKeyToAccount(generatePrivateKey()) }));
      const text = await r.text();
      assert.equal(r.status, 402, `${mode}: refused`);
      assert.equal(gwSettles(), 1, `${mode}: Gateway was asked once`);
      assert.ok(!st.payaiHits.some((h) => h.url === "/settle" || h.url === "/verify"), `${mode}: the Base facilitator saw nothing`);
      assert.ok(!st.circleHits.some((h) => h.url === "/settle" || h.url === "/verify"), `${mode}: the Arc facilitator saw nothing`);
      assert.ok(!leaks(text));
    }
    assert.match(log.text, /Circle Gateway batched SETTLE failed on eip155:8453: .*no other settle path is tried/);
  } finally { proc.kill("SIGKILL"); st.gw = "ok"; }
});

await check("switch off: no batched accept anywhere, no option on the surfaces, Gateway never read", async () => {
  st.gwHits.length = 0;
  const { base, proc } = await boot({ GATEWAY_NANOPAYMENTS: "" });
  try {
    const { env } = await read402(base);
    assert.deepEqual(env.accepts.map((a) => a.network), ["eip155:8453", "eip155:137", "eip155:5042"]);
    assert.ok(env.accepts.every((a) => a.extra?.name !== GATEWAY_KIND_NAME));
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    assert.deepEqual(pricing.payment.acceptKinds, { base: ["exact"], polygon: ["exact"], arc: ["exact"] });
    assert.equal(pricing.payment.gatewayNanopayments, undefined);
    assert.equal((await (await fetch(`${base}/.well-known/x402`)).json()).payment.x402.gatewayNanopayments, undefined);
    assert.ok(!/GatewayWalletBatched/.test(await (await fetch(`${base}/llms.txt`)).text()));
    // No batched text on the legal pages, /how-to-pay, llms.txt or /api/pricing
    // with the switch off; the nonce disclosure and the replay size bound are
    // there regardless.
    const flat = async (path) => (await (await fetch(`${base}${path}`)).text()).replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    const pages = { "/privacy": await flat("/privacy"), "/terms": await flat("/terms"), "/how-to-pay": await flat("/how-to-pay"), "/llms.txt": await flat("/llms.txt"), "/api/pricing": JSON.stringify(pricing) };
    for (const [path, text] of Object.entries(pages)) assert.doesNotMatch(text, /Circle Gateway|Gateway batched|batched payment|Batched option|GatewayWalletBatched/, `${path}: no batched text with the switch off`);
    assert.ok(pages["/terms"].includes("Paid calls settle on public blockchains - USDC"), "terms: the on-chain sentence reads as before");
    assert.match(pages["/privacy"], /the payment's nonce and network \(as an idempotency key for a re-sent payment, held with the cached answer for up to \d+ minutes\)/, "privacy names the nonce read");
    const xm = await (await fetch(`${base}/.well-known/x402`)).json();
    assert.ok(xm.payment.dataHandling.readsOnly.some((r) => /^the payment's nonce and network: as an idempotency key for a re-sent payment, held with the cached answer for up to \d+ minutes$/.test(r)), "readsOnly names the nonce read");
    assert.match(pages["/how-to-pay"], /replays the settled 200 \(answers up to 1 MB\)/, "/how-to-pay: the replay size bound");
    assert.match(pages["/llms.txt"], /inside the replay window \(answers up to 1 MB\)/, "llms.txt: the replay size bound");
    assert.ok(!/batched option/.test(await (await fetch(`${base}/base`)).text()));
    assert.equal((await (await fetch(`${base}/api/rails`)).json()).gatewayBatched, undefined, "/api/rails: no batched block with the switch off");
    const pinfoOff = await mcpPaymentInfo(base);
    assert.equal(pinfoOff.pay.batched, undefined, "payment.info: no batched line with the switch off");
    assert.doesNotMatch(JSON.stringify(pinfoOff), /Circle Gateway|GatewayWalletBatched/, "payment.info: no batched text with the switch off");
    assert.deepEqual((await (await fetch(`${base}/api/gateway-status`)).json()).gatewayBalance, { status: "off" });
    assert.deepEqual((await (await fetch(`${base}/api/gateway-status`)).json()).gatewayPending, { status: "off" });
    assert.equal(st.gwHits.length, 0, "Gateway was never called");
  } finally { proc.kill("SIGKILL"); }
});

await check("switch on, Gateway /supported unreadable: the option is dropped everywhere and the plain accepts are untouched", async () => {
  st.gwSupported = "die";
  const { base, log, proc } = await boot();
  try {
    const { env } = await read402(base);
    assert.deepEqual(env.accepts.map((a) => a.network), ["eip155:8453", "eip155:137", "eip155:5042"]);
    assert.ok(env.accepts.every((a) => a.extra?.name !== GATEWAY_KIND_NAME));
    assert.match(log.text, /Circle Gateway batched option not offered - Gateway's \/supported failed \(non_json_response\)/);
    assert.ok(!leaks(log.text), "the upstream body never reaches the log");
    assert.equal((await (await fetch(`${base}/api/pricing`)).json()).payment.gatewayNanopayments, undefined);
  } finally { proc.kill("SIGKILL"); st.gwSupported = "full"; }
});

await check("the pending book and its resolver run whatever the switch and the boot /supported read say: a book on disk is read with the switch off and with /supported unreadable (word pending, never off), a settled entry becomes one owed debt under its slug; switch off with an empty book reads off", async () => {
  for (const [label, extra, supported] of [["switch off", { GATEWAY_NANOPAYMENTS: "" }, "full"], ["supported unreadable", {}, "die"]]) {
    st.gwSupported = supported;
    const file = join(tmp, `seeded-${label.replace(/\W/g, "-")}.json`);
    const buyer = privateKeyToAccount(generatePrivateKey());
    const mkEntry = async (status) => {
      const accept = { scheme: "exact", network: "eip155:8453", amount: "1000", asset: BASE_USDC, payTo: TREASURY, ...gatewayAcceptFields(baseKind) };
      const p = await signed({ accept, chainId: 8453, signer: buyer });
      if (status) st.transfers.push(recordFor(p, status));
      const n = p.payload.authorization.nonce.toLowerCase();
      return { key: pendingKey("eip155:8453", buyer.address, n), network: "eip155:8453", payer: buyer.address.toLowerCase(), nonce: n, amount: "1000", payTo: TREASURY.toLowerCase(), resource: "GET /api/demand-radar", slug: "seeded-slug", origin: "pending", at: Date.now(), state: "pending" };
    };
    const settled = await mkEntry("confirmed");
    const waiting = await mkEntry(null);
    writeFileSync(file, JSON.stringify({ pending: { [settled.key]: settled, [waiting.key]: waiting } }));
    const { base, proc } = await boot({ ...extra, GATEWAY_PENDING_FILE: file, GATEWAY_PENDING_RESOLVE_MS: "700" });
    try {
      const { env } = await read402(base);
      assert.ok(env.accepts.every((a) => a.extra?.name !== GATEWAY_KIND_NAME), `${label}: no batched accept`);
      let refunds = [];
      for (let i = 0; i < 40 && !refunds.length; i++) {
        await sleep(250);
        refunds = ((await (await fetch(`${base}/__operator/refunds.json?status=all`, { headers: { Authorization: `Bearer ${OP}` } })).json()).refunds || []);
      }
      assert.equal(refunds.length, 1, `${label}: the settled entry became one owed debt`);
      assert.equal(refunds[0].wire, GATEWAY_WIRE);
      assert.equal(refunds[0].slug, "seeded-slug", `${label}: under the slug booked with the entry`);
      assert.deepEqual((await (await fetch(`${base}/api/gateway-status`)).json()).gatewayPending, { status: "pending" }, `${label}: the word reads the book (never off while it holds an entry)`);
      const view = await (await fetch(`${base}/__operator/gateway-pending.json`, { headers: { Authorization: `Bearer ${OP}` } })).json();
      assert.deepEqual(view.entries.map((e) => e.key), [waiting.key], `${label}: the settled entry dropped, the waiting one kept`);
    } finally { proc.kill("SIGKILL"); st.gwSupported = "full"; }
  }
  const empty = join(tmp, "seeded-empty.json");
  writeFileSync(empty, JSON.stringify({ pending: {} }));
  const { base, proc } = await boot({ GATEWAY_NANOPAYMENTS: "", GATEWAY_PENDING_FILE: empty });
  try {
    assert.deepEqual((await (await fetch(`${base}/api/gateway-status`)).json()).gatewayPending, { status: "off" }, "switch off and nothing booked: off");
  } finally { proc.kill("SIGKILL"); }
});

await check("switch on, Gateway lists Base only: the batched accept rides on Base and not on Arc", async () => {
  st.gwSupported = "baseonly";
  const { base, log, proc } = await boot();
  try {
    const { env } = await read402(base);
    assert.ok(batchedOf(env, "eip155:8453") && !batchedOf(env, "eip155:5042"));
    assert.equal(env.accepts.length, 4);
    assert.match(log.text, /partly offered - Gateway's \/supported does not list the batched kind on eip155:5042/);
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    assert.deepEqual(pricing.payment.acceptKinds.arc, ["exact"]);
    assert.deepEqual(Object.keys(pricing.payment.gatewayNanopayments.networks), ["eip155:8453"]);
  } finally { proc.kill("SIGKILL"); st.gwSupported = "full"; }
});

await check("switch on with a network list of one: only that chain carries it", async () => {
  const { base, proc } = await boot({ GATEWAY_NANOPAYMENT_NETWORKS: "arc" });
  try {
    const { env } = await read402(base);
    assert.ok(batchedOf(env, "eip155:5042") && !batchedOf(env, "eip155:8453"));
  } finally { proc.kill("SIGKILL"); }
});

payaiStub.close(); circleStub.close(); gwStub.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed`);
process.exit(process.exitCode || 0);
