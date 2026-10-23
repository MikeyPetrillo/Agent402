// Circle Gateway nanopayments (src/gateway-nanopayments.js): the batched,
// gas-free USDC x402 option beside the plain accept on Arc and Base.
//
// Part 1 drives the client against a fetch stub (no network): /supported
// parsing (the live shape, malformed, a kind without the fields), the switch
// and network list, the local preflight (domain, amount, payTo, chain,
// signature), verify and settle wire bodies, settlement_pending as its own
// outcome, reduced errors (an HTML 500 reaches nobody), the pending book, the
// balance read and its status word, and the routing install against a REAL
// x402ResourceServer: a batched payment goes to the Gateway client, a plain
// one to the plain facilitator, and an onBeforeSettle abort (the client-gone
// hook) stops a batched settle before Gateway is asked.
//
// Part 2 boots the real paid server against three stubs (PayAI for Base and
// Polygon, Circle for Arc, Gateway for the batched option; a preload rewrites
// the two constant base URLs to the stubs) and proves on the wire: the 402
// carries the batched accept on Arc and Base only, last in the list, same
// price and payTo as the plain accept, valid against the protocol schema and
// under the challenge ceiling on every catalog route; an identity-bound route
// offers none; a batched payment on each chain is verified and settled by the
// Gateway stub AFTER the handler and books one sale under the gateway-batched
// wire with Gateway's transaction id; a handler 4xx never settles;
// settlement_pending answers 402 with the reason and hint, books no sale and
// lands in the pending book; an upstream HTML 500 leaks nothing; a plain
// payment never reaches the Gateway stub; a hang-up during verify runs and
// settles nothing; the status words are words; the switch off, an unreadable
// /supported and a /supported without a chain each remove the accept there
// and leave the plain accepts alone.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
} from "../src/gateway-nanopayments.js";
import { classifySettlementPending, settlementKindOf, isGatewayBatchedHeader } from "../src/gateway-wire.js";
import { CIRCLE_FACILITATOR_BASE } from "../src/circle-supported.js";

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
async function signed({ accept, chainId, value = accept.amount, to = accept.payTo, domain = null, validBefore = now() + 604900, signer = acct, resource = "https://example.invalid/api/x" } = {}) {
  const authorization = { from: signer.address, to, value: String(value), validAfter: "0", validBefore: String(validBefore), nonce: nonce() };
  const signature = await signer.signTypedData({
    domain: domain || { name: GATEWAY_KIND_NAME, version: "1", chainId, verifyingContract: accept.extra.verifyingContract },
    types: TYPES, primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  return { x402Version: 2, resource: typeof resource === "string" ? { url: resource } : resource, accepted: accept, payload: { authorization, signature } };
}

// ---------------------------------------------------------------- part 1
console.log("part 1: the client, offline");

const kinds = gatewayKindsFromSupported(SUPPORTED);
const baseKind = kinds.get("eip155:8453");
const baseAccept = { scheme: "exact", network: "eip155:8453", amount: "5000", asset: BASE_USDC, payTo: TREASURY, ...gatewayAcceptFields(baseKind) };
const plainAccept = { scheme: "exact", network: "eip155:8453", amount: "5000", asset: BASE_USDC, payTo: TREASURY, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };

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
const gw = { mode: "ok", calls: [], balances: [{ domain: 6, depositor: TREASURY, balance: "20.5" }, { domain: 26, depositor: TREASURY, balance: "10" }] };
const fetchStub = async (url, init = {}) => {
  gw.calls.push({ url, init });
  const path = String(url).slice(GATEWAY_API_BASE.length);
  const json = (status, body, type = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
  if (path === "/v1/x402/supported") return gw.mode === "die" ? json(500, `<html>${MARKER}</html>`, "text/html") : json(200, SUPPORTED);
  const body = init.body ? JSON.parse(init.body) : {};
  const payer = body.paymentPayload?.payload?.authorization?.from;
  if (path === "/v1/x402/verify") return json(200, { isValid: true, payer });
  if (path === "/v1/x402/settle") {
    if (gw.mode === "html500") return json(500, `<html>${MARKER}</html>`, "text/html");
    if (gw.mode === "pending") return json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: body.paymentRequirements.network, payer });
    if (gw.mode === "notx") return json(200, { success: true, transaction: "", network: body.paymentRequirements.network, payer });
    if (gw.mode === "refused") return json(200, { success: false, errorReason: "insufficient_balance", transaction: "", network: body.paymentRequirements.network, payer });
    return json(200, { success: true, transaction: uuid(), network: body.paymentRequirements.network, payer });
  }
  if (path === "/v1/balances") return json(200, { token: "USDC", balances: gw.balances });
  return json(404, {});
};
const pendings = [];
const client = new GatewayNanopaymentsClient({ fetchImpl: fetchStub, networks: ["eip155:8453", "eip155:5042"], onPending: (e) => pendings.push(e) });

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
await check("client: settlement_pending is its own outcome - not settled, transaction empty, booked by authorization", async () => {
  gw.mode = "pending"; gw.calls.length = 0;
  const p = await signed({ accept: baseAccept, chainId: 8453 });
  const s = await client.settle(p, baseAccept);
  assert.deepEqual(s, { success: false, errorReason: "settlement_pending", transaction: "", network: "eip155:8453", payer: acct.address });
  assert.equal(pendings.length, 1);
  assert.equal(pendings[0].nonce, p.payload.authorization.nonce);
  assert.equal(pendings[0].payer, acct.address);
  assert.equal(pendings[0].amount, "5000");
  assert.equal(pendings[0].resource, "https://example.invalid/api/x");
  gw.mode = "ok";
});
await check("client: a Gateway refusal is relayed as its reason word only; an HTML 500 and a success without an id are reduced", async () => {
  gw.mode = "refused";
  const s = await client.settle(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept);
  assert.equal(s.errorReason, "insufficient_balance");
  gw.mode = "html500";
  await assert.rejects(client.settle(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept), (e) => e.errorReason === "non_json_response" && e.statusCode === 500 && !String(e.message + e.errorMessage).includes(MARKER));
  gw.mode = "notx";
  await assert.rejects(client.settle(await signed({ accept: baseAccept, chainId: 8453 }), baseAccept), (e) => e.errorReason === "invalid_settle_response");
  gw.mode = "die";
  await assert.rejects(client.getSupported(), (e) => e.reason === "non_json_response" && !String(e.message).includes(MARKER));
  gw.mode = "ok";
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
  assert.equal(await book.book({ payer: acct.address, network: "eip155:8453", nonce: n, amount: "5000" }), false, "same authorization: once");
  assert.equal(await book.book({ payer: "0xnope", network: "eip155:8453", nonce: n }), false);
  assert.equal(await book.alarmStatus(), "pending");
  const view = await book.operatorView();
  assert.equal(view.count, 1); assert.equal(view.entries[0].payer, acct.address.toLowerCase()); assert.equal(view.entries[0].amount, "5000");
  assert.equal((await book.resolve(view.entries[0].key, { outcome: "nothing" })).ok, false);
  assert.equal((await book.resolve(view.entries[0].key, { outcome: "refunded", note: "repaid by hand" })).ok, true);
  assert.equal(await book.alarmStatus(), "ok");
  rmSync(dir, { recursive: true, force: true });
});
await check("the 402 hint for a pending settlement", () => {
  const h = classifySettlementPending({ success: false, errorReason: "settlement_pending", network: "eip155:8453" });
  assert.equal(h.reason, "settlement-pending"); assert.equal(h.retry, "fresh-authorization"); assert.equal(h.network, "eip155:8453");
  assert.match(h.detail, /no charge is counted/);
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

// ---------------------------------------------------------------- part 2
console.log("part 2: the paid server");

const [P_PAYAI, P_CIRCLE, P_GW, ...SERVER_PORTS] = await getFreePorts(11);
const st = { gw: "ok", gwSupported: "full", gwVerifyDelayMs: 0, gwHits: [], payaiHits: [], circleHits: [] };
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
  if (req.url === "/v1/x402/supported") {
    if (st.gwSupported === "die") return rawJson(res, 500, `<html>${MARKER}</html>`, "text/html");
    if (st.gwSupported === "baseonly") return rawJson(res, 200, { ...SUPPORTED, kinds: SUPPORTED.kinds.filter((k) => k.network === "eip155:8453") });
    return rawJson(res, 200, SUPPORTED);
  }
  if (req.url === "/v1/balances") return rawJson(res, 200, { token: "USDC", balances: [{ domain: 6, depositor: body?.sources?.[0]?.depositor, balance: "30.5" }] });
  if (req.url === "/v1/x402/verify") { if (st.gwVerifyDelayMs) await sleep(st.gwVerifyDelayMs); return rawJson(res, 200, { isValid: true, payer }); }
  if (req.url === "/v1/x402/settle") {
    if (st.gw === "html500") return rawJson(res, 500, `<html>${MARKER}</html>`, "text/html");
    if (st.gw === "pending") return rawJson(res, 200, { success: false, errorReason: "settlement_pending", transaction: "", network: body.paymentRequirements.network, payer });
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
  for (const k of ["STATE_DATABASE_URL", "REDIS_URL", "CIRCLE_FACILITATOR_API_KEY", "GATEWAY_NANOPAYMENTS", "GATEWAY_NANOPAYMENT_NETWORKS", "GATEWAY_WITHDRAW_ALERT_USD"]) delete env[k];
  const proc = spawn(process.execPath, ["--import", preload, "src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...env, PORT: String(port), FREE_MODE: "",
      WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base,polygon,arc",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "",
      PAYAI_FACILITATOR_URL: `http://127.0.0.1:${P_PAYAI}`, PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      CIRCLE_FACILITATOR_API_KEY: KEY, CIRCLE_TEST_STUB: `http://127.0.0.1:${P_CIRCLE}`, GW_TEST_STUB: `http://127.0.0.1:${P_GW}`,
      GATEWAY_NANOPAYMENTS: "on",
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
    assert.match(llms, /Gas-free batched option \(Circle Gateway nanopayments\)\.\*\* On (Base and Arc|Arc and Base)/);
    assert.match(llms, /GatewayWalletBatched/);
    const openapi = await (await fetch(`${base}/openapi.json`)).json();
    const hashInfo = openapi.paths["/api/hash"].post["x-payment-info"];
    assert.deepEqual(hashInfo.nanopayments.networks.sort(), ["eip155:5042", "eip155:8453"]);
    assert.equal(openapi.paths["/api/memory"].post["x-payment-info"].nanopayments, undefined, "no batched option on an identity-bound route in openapi either");
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

await check("every catalog route's 402 stays under the challenge ceiling with the batched accepts in it", async () => {
  const { base, proc } = await boot();
  try {
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    const routes = pricing.endpoints.map((e) => ({ method: e.method || "GET", path: e.path })).filter((r) => r.path);
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
            if (!batchedOf(decode(pr), "eip155:8453") && !/\/memory|my-usage|attest|feedback|receipts/.test(r.path)) reject(new Error(`${r.path}: no batched accept`));
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
    // settlement_pending.
    st.gw = "pending"; st.gwHits.length = 0;
    const accept = batchedOf(env, "eip155:8453");
    const pp = await signed({ accept, chainId: 8453, resource: env.resource });
    const r = await pay(base, pp);
    const body = await r.json();
    assert.equal(r.status, 402, `a pending settlement is not served (got ${r.status})`);
    assert.equal(body.reason, "settlement-pending");
    assert.match(body.hint, /no charge is counted/);
    assert.equal(body.error, undefined, "a body that explains itself carries no error");
    assert.equal(body.retry, "fresh-authorization");
    assert.equal(body.network, "eip155:8453");
    const receipt = decode(r.headers.get("payment-response"));
    assert.equal(receipt.success, false); assert.equal(receipt.errorReason, "settlement_pending"); assert.equal(receipt.transaction, "");
    assert.equal(gwSettles(), 1, "one settle call, no vendor retry on an empty transaction");
    await sleep(400);
    assert.equal(sales(port).length, 0, "no sale for a pending settlement");
    const pending = await (await fetch(`${base}/__operator/gateway-pending.json`, { headers: { Authorization: `Bearer ${OP}` } })).json();
    assert.equal(pending.count, 1);
    assert.equal(pending.entries[0].nonce, pp.payload.authorization.nonce.toLowerCase());
    assert.equal(pending.entries[0].network, "eip155:8453");
    assert.equal(pending.entries[0].payer, acct.address.toLowerCase());
    assert.equal(pending.entries[0].amount, accept.amount);
    const pub = await (await fetch(`${base}/api/gateway-status`)).json();
    assert.deepEqual(pub.gatewayPending, { status: "pending" });
    assert.equal((await fetch(`${base}/__operator/gateway-pending.json`)).status, 404, "the operator view needs the token");
    const resolved = await (await fetch(`${base}/__operator/gateway-pending`, { method: "POST", headers: { Authorization: `Bearer ${OP}`, "content-type": "application/json" }, body: JSON.stringify({ action: "resolve", key: pending.entries[0].key, outcome: "not_charged", note: "test" }) })).json();
    assert.equal(resolved.ok, true);
    assert.deepEqual((await (await fetch(`${base}/api/gateway-status`)).json()).gatewayPending, { status: "ok" });
    // The same signed authorization is not served on a resend (its claim is held).
    const again = await pay(base, pp);
    await again.text();
    assert.equal(again.status, 402, "a resent pending authorization is not served");
    // HTML 500 from Gateway at settle: 402, nothing leaked.
    st.gw = "html500";
    const rf = await pay(base, await signed({ accept, chainId: 8453, resource: env.resource }));
    const rfText = await rf.text();
    assert.equal(rf.status, 402);
    assert.ok(!leaks(`${rfText} ${JSON.stringify(Object.fromEntries(rf.headers))}`), "the buyer's 402 carries no upstream body");
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
    assert.ok(!/batched option/.test(await (await fetch(`${base}/base`)).text()));
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
