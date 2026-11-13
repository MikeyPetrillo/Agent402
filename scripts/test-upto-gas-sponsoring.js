#!/usr/bin/env node
// Permit2 gas sponsorship on the metered upto accepts, and upto on Arc.
// Both are default-off switches (src/upto-gas-sponsoring.js):
//   X402_UPTO_GAS_SPONSORING  declares eip2612GasSponsoring (and, by name,
//                             erc20ApprovalGasSponsoring) in the 402 of a
//                             metered /v1 route that offers upto, only when
//                             the facilitator settling every upto network
//                             advertises the key.
//   X402_UPTO_NETWORKS        Arc (eip155:5042) is a valid member, by name
//                             only ("all" never adds it).
//
//   node scripts/test-upto-gas-sponsoring.js
//   BASELINE_TREE=/path/to/main/checkout node scripts/test-upto-gas-sponsoring.js
//     (also boots that tree and compares its 402s byte for byte)
//     The baseline is assumed to differ from this tree only in the upto and
//     sponsoring code: any other change to a 402 (listing copy, tags, the
//     catalog, the icon) fails the byte comparison without an upto cause. It
//     is booted with its own scripts/lib/boot-server.js and node_modules.
//
// Every server runs against local stubs (Base facilitator, Circle through a
// fetch preload, OpenRouter through scripts/lib/openrouter-stub-preload.js):
// nothing is settled on chain and nothing is sent upstream.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { bootServer } from "./lib/boot-server.js";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { UptoEvmScheme as UptoClient } from "@x402/evm/upto/client";
import { declareEip2612GasSponsoringExtension, declareErc20ApprovalGasSponsoringExtension } from "@x402/extensions";
import {
  gasSponsoringWanted, uptoNetworksWanted, uptoListedByName, gasSponsoringKeys, gasSponsoringDeclarations, isMeteredGatewayRoute,
} from "../src/upto-gas-sponsoring.js";
import { usdcKindsFromSupported, ARC_PROFILE } from "../src/circle-supported.js";
import { CircleFacilitatorClient, CIRCLE_FACILITATOR_BASE, preflightUptoPayment, pendingNonceOf, CIRCLE_EVM_FALLBACK_PROFILES } from "../src/circle-facilitator.js";
import { applyMeteredSettlement } from "../src/gateway-meter.js";
import { CHALLENGE_VARIABLE_MAX_BYTES, UPTO_ACCEPT_JSON_BYTES } from "../src/payments.js";
import { setUpstreamCostsForTest } from "../src/upstream-costs.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = "eip155:8453";
const ARC = "eip155:5042";
const FAC_BASE = "0x1111111111111111111111111111111111111111";
const FAC_ARC = "0x2222222222222222222222222222222222222222";
const PAYTO = "0x000000000000000000000000000000000000dEaD";
const KEY = "test-circle-key-not-a-secret";
const EIP = "eip2612GasSponsoring", ERC = "erc20ApprovalGasSponsoring";
// A throwaway buyer key made up for this test (holds nothing on any chain).
const buyer = privateKeyToAccount(`0x${"4b".repeat(32)}`);

// --- 1. Switch parsing and the declaration -----------------------------------
{
  ok(gasSponsoringWanted({}).length === 0 && gasSponsoringWanted({ X402_UPTO_GAS_SPONSORING: "off" }).length === 0, "unset or off declares nothing");
  ok(JSON.stringify(gasSponsoringWanted({ X402_UPTO_GAS_SPONSORING: "on" })) === JSON.stringify([EIP]), "on is the EIP-2612 permit only (USDC implements it)");
  ok(JSON.stringify(gasSponsoringWanted({ X402_UPTO_GAS_SPONSORING: `${EIP},${ERC},bogus` })) === JSON.stringify([EIP, ERC]), "a CSV names keys; an unknown name is ignored");
  const evm = [BASE, "eip155:137", ARC];
  ok(JSON.stringify(uptoNetworksWanted({ X402_UPTO_NETWORKS: "all" }, evm)) === JSON.stringify([BASE, "eip155:137"]), "\"all\" never adds Arc");
  ok(JSON.stringify(uptoNetworksWanted({ X402_UPTO_NETWORKS: `${BASE},${ARC}` }, evm)) === JSON.stringify([BASE, ARC]), "Arc listed by name is wanted");
  ok(JSON.stringify(uptoNetworksWanted({ X402_UPTO_NETWORKS: `${ARC}, ${BASE},${ARC},eip155:1` }, evm)) === JSON.stringify([ARC, BASE]), "a list keeps its own order, once each, and drops a network not offered here");
  ok(uptoNetworksWanted({}, evm).length === 0 && uptoNetworksWanted({ X402_UPTO_NETWORKS: ARC }, [BASE]).length === 0, "unset is nothing, and a network not offered is never wanted");
  ok(uptoListedByName(ARC, { X402_UPTO_NETWORKS: `${BASE}, ${ARC}` }) && !uptoListedByName(ARC, { X402_UPTO_NETWORKS: "all" }), "Circle's upto read follows Arc listed by name only");
  const ex = new Map([[BASE, [EIP, ERC]], [ARC, [EIP]]]);
  const r = gasSponsoringKeys([EIP, ERC], [BASE, ARC], ex);
  ok(JSON.stringify(r.keys) === JSON.stringify([EIP]) && r.refused.length === 1 && r.refused[0].key === ERC && r.refused[0].networks[0] === ARC, "a key is declared only when the settler of EVERY upto network advertises it");
  ok(gasSponsoringKeys([EIP], [BASE], new Map()).keys.length === 0, "a network whose settler read nothing declares nothing");
  const d = gasSponsoringDeclarations([EIP, ERC]);
  ok(JSON.stringify(d[EIP].info) === JSON.stringify(declareEip2612GasSponsoringExtension()[EIP].info)
    && JSON.stringify(d[ERC].info) === JSON.stringify(declareErc20ApprovalGasSponsoringExtension()[ERC].info), "the declared info is the SDK helper's, word for word");
  ok(!("schema" in d[EIP]) && JSON.stringify(d).length < 400, `the declaration carries no JSON schema, so the challenge stays small (${JSON.stringify(d).length} bytes for both keys)`);
  ok(isMeteredGatewayRoute({ slug: "v1-chat-metered", quote: () => 1 }) && isMeteredGatewayRoute({ slug: "v1-chat", tierQuote: () => 1 })
    && !isMeteredGatewayRoute({ slug: "tts", quote: () => 1 }) && !isMeteredGatewayRoute({ slug: "v1-models" }), "only per-request priced /v1 routes carry the declaration");
}

// --- 2. Circle's /supported read: upto on Arc only when asked ----------------
{
  const sup = {
    kinds: [
      { x402Version: 2, scheme: "exact", network: ARC, asset: ARC_PROFILE.asset },
      { x402Version: 2, scheme: "upto", network: ARC, asset: ARC_PROFILE.asset, extra: { facilitatorAddress: FAC_ARC } },
    ],
    extensions: [EIP, "settlement-status"], signers: { [ARC]: [FAC_ARC] },
  };
  const off = usdcKindsFromSupported(sup, [ARC_PROFILE]);
  ok(off.kinds.length === 1 && off.kinds[0].scheme === "exact" && !off.extensions.includes(EIP), "read without upto: exact only, and the extension list as before");
  const on = usdcKindsFromSupported(sup, [ARC_PROFILE], { uptoNetworks: [ARC] });
  const k = on.kinds.find((x) => x.scheme === "upto");
  ok(on.kinds.length === 2 && k?.extra?.facilitatorAddress === FAC_ARC && on.extensions.includes(EIP), "read for upto: the Arc upto kind with its facilitator address, and the sponsoring key");
  const noAddr = usdcKindsFromSupported({ ...sup, kinds: [sup.kinds[0], { ...sup.kinds[1], extra: {} }] }, [ARC_PROFILE], { uptoNetworks: [ARC] });
  ok(noAddr.kinds.length === 1, "an upto kind without a facilitator address is not one a buyer can sign for: dropped");
  const noExact = usdcKindsFromSupported({ ...sup, kinds: [sup.kinds[1]] }, [ARC_PROFILE], { uptoNetworks: [ARC] });
  ok(noExact.kinds.length === 0, "upto is never listed on a network whose exact kind is missing (Arc is dropped then)");
  const fb = new CircleFacilitatorClient({ apiKey: KEY, profiles: CIRCLE_EVM_FALLBACK_PROFILES, upto: true, fetchImpl: async () => { throw new Error("no fetch"); } });
  ok(fb._uptoNetworks.length === 0, "the Base and Polygon settle fallback never takes upto, whatever it is passed");
}

// --- 3. The Arc upto preflight, with payloads the real SDK client signs ------
const arcAccept = (amount = "50000") => ({
  scheme: "upto", network: ARC, amount, asset: ARC_PROFILE.asset, payTo: PAYTO, maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2", assetTransferMethod: "permit2", facilitatorAddress: FAC_ARC },
});
// The buyer's chain reads, answered locally: no Permit2 allowance yet (so the
// sponsoring path signs a permit), permit nonce 0.
const buyerSigner = {
  address: buyer.address,
  signTypedData: (m) => buyer.signTypedData(m),
  readContract: async ({ functionName }) => (functionName === "allowance" ? 0n : 0n),
  getTransactionCount: async () => 0,
  estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
  signTransaction: async () => "0x00",
};
async function signFor(paymentRequired) {
  const client = new x402Client();
  client.register(ARC, new UptoClient(buyerSigner));
  client.register(BASE, new UptoClient(buyerSigner));
  return client.createPaymentPayload(paymentRequired);
}
{
  const accept = arcAccept();
  const withExt = await signFor({ x402Version: 2, resource: { url: "http://x/v1" }, accepts: [accept], extensions: gasSponsoringDeclarations([EIP]) });
  ok(withExt.extensions?.[EIP]?.info?.signature && withExt.extensions[EIP].info.spender, "the SDK upto client signs an EIP-2612 permit when the 402 declares the key and the buyer holds no allowance");
  const without = await signFor({ x402Version: 2, resource: { url: "http://x/v1" }, accepts: [accept] });
  ok(!without.extensions?.[EIP], "and signs none when the key is not declared (the switch off)");
  const now = Math.floor(Date.now() / 1000);
  ok(await preflightUptoPayment(withExt, accept, now) === null, "a sponsored upto payment the SDK signed passes the local preflight");
  ok(await preflightUptoPayment(without, accept, now) === null, "an unsponsored one passes too");
  ok(await preflightUptoPayment(withExt, { ...accept, amount: "40000" }, now, { settle: true }) === null, "settle under the ceiling passes");
  ok(await preflightUptoPayment(withExt, accept, now, { settle: true }) === null, "settle at the ceiling passes");
  ok((await preflightUptoPayment(withExt, { ...accept, amount: "50001" }, now, { settle: true }))?.reason === "upto_settlement_exceeds_amount", "settle above the ceiling is refused here, before Circle sees it");
  ok((await preflightUptoPayment(withExt, { ...accept, amount: "40000" }, now))?.reason === "permit2_amount_mismatch", "verify needs the ceiling to equal the quote");
  ok((await preflightUptoPayment(withExt, { ...accept, payTo: FAC_BASE }, now))?.reason === "invalid_permit2_recipient_mismatch", "a witness paying someone else is refused");
  ok((await preflightUptoPayment(withExt, { ...accept, extra: { ...accept.extra, facilitatorAddress: FAC_BASE } }, now))?.reason === "invalid_upto_evm_payload_facilitator_mismatch", "a witness naming another facilitator is refused");
  const forged = structuredClone(withExt); forged.payload.permit2Authorization.permitted.amount = "5000000";
  ok((await preflightUptoPayment(forged, { ...accept, amount: "5000000" }, now))?.reason === "invalid_upto_evm_payload_signature", "a raised ceiling the buyer did not sign is refused");
  const other = structuredClone(withExt); other.extensions[EIP].info.from = FAC_BASE;
  ok((await preflightUptoPayment(other, accept, now))?.reason === "invalid_eip2612_extension", "a sponsoring permit for another owner is refused");
  ok((await preflightUptoPayment(withExt, accept, now + 100_000))?.reason === "permit2_deadline_expired", "an expired authorization is refused");
  ok(/^0x[0-9a-f]{64}$/.test(pendingNonceOf(withExt)) && BigInt(pendingNonceOf(withExt)) === BigInt(withExt.payload.permit2Authorization.nonce), "a pending upto settle is booked under its Permit2 nonce, in the book's 32-byte form");
  // The settle claim names the same authorization: a pending Arc upto settle
  // keeps it, so the identical signed payment resent is refused, not settled
  // a second time while the first is unresolved.
  {
    const { registerSettlementClaimHooks, registerSettlementClaimRelease, __resetSettlementClaims, DUPLICATE_AUTHORIZATION } = await import("../src/settlement-claims.js");
    __resetSettlementClaims();
    const hooks = { beforeVerify: [], beforeSettle: [], afterSettle: [], settleFailure: [] };
    const fake = {
      onBeforeVerify: (h) => { hooks.beforeVerify.push(h); return fake; }, onBeforeSettle: (h) => { hooks.beforeSettle.push(h); return fake; },
      onAfterSettle: (h) => { hooks.afterSettle.push(h); return fake; }, onSettleFailure: (h) => { hooks.settleFailure.push(h); return fake; },
    };
    registerSettlementClaimHooks(fake);
    registerSettlementClaimRelease(fake);
    const ctxFor = (payload) => ({ requirements: accept, paymentPayload: payload, transportContext: { request: { adapter: { req: {} } } } });
    const first = ctxFor(withExt);
    for (const h of hooks.beforeVerify) await h(first);
    let firstR; for (const h of hooks.beforeSettle) firstR = await h(first);
    ok(firstR === undefined, "the first upto settle claims its Permit2 authorization");
    for (const h of hooks.settleFailure) await h({ ...first, error: Object.assign(new Error("settlement_pending"), { errorReason: "settlement_pending" }) });
    const resend = ctxFor(structuredClone(withExt));
    for (const h of hooks.beforeVerify) await h(resend);
    const r = await hooks.beforeSettle[0](resend);
    ok(r?.abort === true && r.reason === DUPLICATE_AUTHORIZATION, `a pending Arc upto settle's resend is refused as ${DUPLICATE_AUTHORIZATION} (got ${JSON.stringify(r)})`);
    // Control: another signed upto payment (a new Permit2 nonce) is not refused.
    const fresh = await signFor({ x402Version: 2, resource: { url: "http://x/v1" }, accepts: [accept] });
    const c3 = ctxFor(fresh);
    for (const h of hooks.beforeVerify) await h(c3);
    ok(fresh.payload.permit2Authorization.nonce !== withExt.payload.permit2Authorization.nonce && await hooks.beforeSettle[0](c3) === undefined, "a different upto authorization from the same buyer settles normally");
    __resetSettlementClaims();
  }

  // The client: off, upto is refused before any fetch; on, it is forwarded.
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    seen.push({ path: url.slice(CIRCLE_FACILITATOR_BASE.length), body });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/verify")) return json({ isValid: true, payer: buyer.address });
    if (url.endsWith("/settle")) return json({ success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC, payer: buyer.address });
    return json({});
  };
  const offClient = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl });
  const v0 = await offClient.verify(withExt, accept);
  ok(v0.isValid === false && v0.invalidReason === "unsupported_scheme" && seen.length === 0, "a client not asked for upto refuses an upto payment and sends nothing");
  const onClient = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl, upto: true });
  const v1 = await onClient.verify(withExt, accept);
  ok(v1.isValid === true && v1.payer === buyer.address && seen.at(-1)?.path === "/verify", "asked for upto, a verified payment is forwarded and the payer is the Permit2 signer");
  ok(seen.at(-1)?.body?.paymentPayload?.extensions?.[EIP]?.info?.signature, "the sponsoring permit reaches Circle with the payment");
  const n = seen.length;
  const s1 = await onClient.settle(withExt, { ...accept, amount: "60000" });
  ok(s1.success === false && s1.errorReason === "upto_settlement_exceeds_amount" && seen.length === n, "a settle above the signed ceiling is refused and never sent");
  const s2 = await onClient.settle(withExt, { ...accept, amount: "12345" });
  ok(s2.success === true && seen.at(-1)?.path === "/settle" && seen.at(-1)?.body?.paymentRequirements?.amount === "12345", "a settle under the ceiling is sent at the amount asked");
  // The exact path is unchanged on the same client.
  const v2 = await onClient.verify({ x402Version: 2, payload: {} }, { scheme: "exact", network: ARC, asset: ARC_PROFILE.asset, payTo: PAYTO, amount: "1" });
  ok(v2.isValid === false && v2.invalidReason === "invalid_payload", "an exact payment still takes the exact preflight");
}

// --- 4. The meter caps a sponsored upto settle at the quote ------------------
{
  setUpstreamCostsForTest({ models: [["fake/", { prompt: 1, completion: 1 }]], meter: { markup: 1.2 } });
  const payload = await signFor({ x402Version: 2, resource: { url: "http://x/v1" }, accepts: [arcAccept()], extensions: gasSponsoringDeclarations([EIP]) });
  const hdr = Buffer.from(JSON.stringify(payload)).toString("base64");
  const req = { header: (n) => (String(n).toLowerCase() === "payment-signature" ? hdr : undefined), __meteredQuoteUsd: 0.05 };
  const res = { headersSent: false, setHeader: () => {} };
  let over = null;
  const amt = applyMeteredSettlement({ result: { ok: true, __meterUpstreamUsd: 5 }, req, tool: { slug: "v1-chat-metered", price: "$0.001" }, res, enabled: true, setOverrides: (_r, o) => { over = o; } });
  ok(amt === 0.05 && over?.amount === "$0.050000", `a sponsored upto call whose usage exceeds the quote settles AT the quote, never above (${amt})`);
  let small = null;
  applyMeteredSettlement({ result: { ok: true, __meterUpstreamUsd: 0.001 }, req, tool: { slug: "v1-chat-metered", price: "$0.001" }, res, enabled: true, setOverrides: (_r, o) => { small = o; } });
  ok(small && Number(small.amount.slice(1)) < 0.05, `and a small one settles under it (${small?.amount})`);
}

// --- 5. Paid-mode boots ------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "a402-upto-gas-"));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Facilitator stubs: Base (stock wire) and Circle (redirected by a preload).
const st = { baseExt: [EIP], circleExt: [EIP], baseSettles: [], circleSettles: [], circleVerifies: 0 };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { try { r(JSON.parse(b || "null")); } catch { r(null); } }); });
const send = (res, code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
const baseStub = createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.url === "/supported") return send(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: FAC_BASE } }], extensions: st.baseExt, signers: {} });
  const payer = body?.paymentPayload?.payload?.permit2Authorization?.from || body?.paymentPayload?.payload?.authorization?.from;
  if (req.url === "/verify") return send(res, 200, { isValid: true, payer });
  if (req.url === "/settle") { st.baseSettles.push(body); return send(res, 200, { success: true, transaction: `0x${"cd".repeat(32)}`, network: BASE, payer }); }
  send(res, 404, {});
});
const circleStub = createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.url === "/supported") {
    return send(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: ARC, asset: ARC_PROFILE.asset }, { x402Version: 2, scheme: "upto", network: ARC, asset: ARC_PROFILE.asset, extra: { facilitatorAddress: FAC_ARC } }], extensions: st.circleExt, signers: { [ARC]: [FAC_ARC] } });
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { code: 401 });
  const payer = body?.paymentPayload?.payload?.permit2Authorization?.from || body?.paymentPayload?.payload?.authorization?.from;
  if (req.url === "/verify") { st.circleVerifies++; return send(res, 200, { isValid: true, payer }); }
  if (req.url === "/settle") { st.circleSettles.push(body); return send(res, 200, { success: true, transaction: `0x${"ef".repeat(32)}`, network: ARC, payer }); }
  if (req.url === "/rpc") return send(res, 200, { jsonrpc: "2.0", id: 1, result: "0x0" });
  send(res, 404, {});
});
let orMode = "ok";
const orStub = createServer(async (req, res) => {
  await readBody(req);
  if (req.method === "POST" && String(req.url || "").startsWith("/api/v1/chat/completions")) {
    if (orMode === "fail") return send(res, 500, { error: { message: "stub upstream down" } });
    return send(res, 200, { id: "gen-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "openai/gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
  }
  send(res, 200, { data: [] });
});
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const [P_BASE, P_CIRCLE, P_OR] = await Promise.all([baseStub, circleStub, orStub].map(listen));
const circlePreload = join(tmp, "circle-redirect.mjs");
writeFileSync(circlePreload, `
const BASE = ${JSON.stringify(CIRCLE_FACILITATOR_BASE)};
const STUB = process.env.UPTO_TEST_CIRCLE_STUB;
const real = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
  if (STUB && typeof u === "string" && u.startsWith(BASE)) return real(STUB + u.slice(BASE.length), init);
  if (STUB && typeof u === "string" && (() => { try { return new URL(u).hostname === "rpc.mainnet.arc.io"; } catch { return false; } })()) return real(STUB + "/rpc", init);
  return real(input, init);
};
`);
const orPreload = join(ROOT, "scripts/lib/openrouter-stub-preload.js");

// A baseline tree is booted with its own helper, so it runs from its own root.
const baselineBoot = process.env.BASELINE_TREE
  ? (await import(pathToFileURL(join(process.env.BASELINE_TREE, "scripts/lib/boot-server.js")).href)).bootServer
  : null;
const booted = [];
let bootN = 0;
async function boot(env, { baseline = false, arc = false } = {}) {
  const n = ++bootN;
  const clear = { STATE_DATABASE_URL: "", CIRCLE_FACILITATOR_API_KEY: "", X402_UPTO_NETWORKS: "", X402_UPTO_GAS_SPONSORING: "" };
  const srv = await (baseline ? baselineBoot : bootServer)({
    stores: `upto-gas-${n}`,
    args: ["--import", orPreload, "--import", circlePreload],
    timeoutMs: 120_000,
    env: {
      ...clear,
      // One fixed base URL, so two boots' 402s can be compared byte for byte.
      BASE_URL: "http://upto-gas.test", FREE_MODE: "", NETWORK: "base", PAYMENT_NETWORKS: arc ? "base,arc" : "base",
      FACILITATOR_URL: `http://127.0.0.1:${P_BASE}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
      AGENT402_BASE_RPC: `http://127.0.0.1:${P_CIRCLE}/rpc`,
      WALLET_ADDRESS: PAYTO, X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", SOLANA_LEADERBOARD: "off",
      STATS_ALLOW_EPHEMERAL: "true", SOLVADOR_KEY: "", PAYMENT_SETTLE_FALLBACK: "", MPP_SECRET_KEY: "", POSTHOG_API_KEY: "", INFLIGHT_COVER: "off",
      PAYAI_FACILITATOR_URL: `http://127.0.0.1:${P_BASE}`, PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      LEADERBOARD_FIRST_REFRESH_DELAY_MS: "3600000", RATE_LIMIT_REPLICAS: "1",
      OPENROUTER_API_KEY: "test-key-never-sent", OPENROUTER_STUB_URL: `http://127.0.0.1:${P_OR}`, OPENROUTER_MANAGEMENT_KEY: "", OPENROUTER_FLEX: "off",
      UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_OPTIONAL: "", UPSTREAM_COSTS_FILE: join(ROOT, "docs/example-upstream-costs.json"),
      GATEWAY_METERED_BILLING: "on",
      SALES_LEDGER_DB: join(tmp, `sales-${n}.db`), CIRCLE_PENDING_FILE: join(tmp, `circle-pending-${n}.json`), GATED_RAIL_HISTORY_FILE: join(tmp, `gated-${n}.json`), TRAFFIC_DIR: tmp,
      UPTO_TEST_CIRCLE_STUB: `http://127.0.0.1:${P_CIRCLE}`,
      ...(arc ? { CIRCLE_FACILITATOR_API_KEY: KEY } : {}),
      ...env,
    },
  });
  booted.push(srv);
  return { url: srv.url, log: { get text() { return srv.log(); } }, srv };
}
const stop = async (b) => { try { await b.srv.stop(); } catch { /* gone */ } };
const METERED = "/v1/metered/chat/completions";
const CHAT_BODY = JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 });
const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
async function challenge(url, path = METERED) {
  const r = path === METERED
    ? await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: CHAT_BODY })
    : await fetch(`${url}${path}`);
  const hdr = r.headers.get("payment-required");
  const body = await r.text();
  return { status: r.status, hdr, body, pr: hdr ? decode(hdr) : null };
}

try {
  // 5a. Switch off: no declaration, and (with BASELINE_TREE) byte-identical to that tree.
  {
    const env = { X402_UPTO_NETWORKS: BASE };
    const b = await boot(env);
    const m = await challenge(b.url), u = await challenge(b.url, "/api/uuid");
    ok(m.status === 402 && m.pr?.accepts?.some((a) => a.scheme === "upto"), "switch off: the metered route still offers upto on Base");
    ok(!GAS_KEYS_IN(m.pr) && !GAS_KEYS_IN(u.pr), "switch off: no sponsoring key in any 402, though the facilitator advertises one");
    ok(!/gas sponsoring/.test(b.log.text), "switch off: nothing about sponsoring is logged");
    await stop(b);
    if (process.env.BASELINE_TREE) {
      const a = await boot(env, { baseline: true });
      const m0 = await challenge(a.url), u0 = await challenge(a.url, "/api/uuid");
      ok(m0.hdr === m.hdr && m0.body === m.body, `switch off: the metered 402 header and body are byte-identical to ${process.env.BASELINE_TREE} (${m.hdr?.length} / ${m0.hdr?.length} header bytes)`);
      ok(u0.hdr === u.hdr && u0.body === u.body, "switch off: an ordinary tool's 402 is byte-identical too");
      await stop(a);
      const c = await boot({}, { arc: true });
      const c0 = await boot({}, { arc: true, baseline: true });
      const [x, x0] = [await challenge(c.url), await challenge(c0.url)];
      ok(x.hdr === x0.hdr && x.body === x0.body, "Arc offered, upto unset: the 402 is byte-identical to the baseline");
      await stop(c); await stop(c0);
    }
  }
  // 5b. Switch on, Base only, facilitator advertises the key.
  {
    const b = await boot({ X402_UPTO_NETWORKS: BASE, X402_UPTO_GAS_SPONSORING: "on" });
    const m = await challenge(b.url);
    ok(m.status === 402 && JSON.stringify(m.pr?.extensions?.[EIP]?.info) === JSON.stringify(declareEip2612GasSponsoringExtension()[EIP].info), "switch on: the metered 402 declares eip2612GasSponsoring with the SDK's info");
    ok(!m.pr?.extensions?.[ERC], "and not the approval-transaction key, which was not asked for");
    const u = await challenge(b.url, "/api/uuid");
    ok(u.status === 402 && !GAS_KEYS_IN(u.pr), "a fixed-price tool carries no declaration (upto buys it nothing over exact)");
    const mem = await challenge(b.url, "/api/memory?key=k");
    ok(mem.status === 402 && !GAS_KEYS_IN(mem.pr), "an identity-bound route carries none");
    ok(!m.pr.accepts.some((a) => a.network === ARC), "Arc is not offered: it is not configured on this boot");
    console.log(`# metered 402 header: ${m.hdr.length} bytes with the declaration`);

    // A real SDK client pays it on Base: the permit rides along, the settle is metered under the quote.
    const n0 = st.baseSettles.length;
    const accepts = m.pr.accepts.filter((a) => a.scheme === "upto" && a.network === BASE);
    const payload = await signFor({ ...m.pr, accepts });
    ok(payload.extensions?.[EIP]?.info?.signature, "the SDK client signs a sponsoring permit against our 402");
    const r = await fetch(`${b.url}${METERED}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") }, body: CHAT_BODY });
    await r.text();
    const settled = st.baseSettles.slice(n0);
    ok(r.status === 200 && settled.length === 1, `the sponsored upto call is served and settled once (status ${r.status}, settles ${settled.length})`);
    const amt = BigInt(settled[0]?.paymentRequirements?.amount ?? -1), ceiling = BigInt(accepts[0].amount);
    ok(amt > 0n && amt <= ceiling, `the settled amount is at or under the quote (${amt} <= ${ceiling})`);
    ok(settled[0]?.paymentPayload?.extensions?.[EIP]?.info?.signature, "the permit reaches the facilitator with the settle");
    // A failed call is never charged.
    orMode = "fail";
    const p2 = await signFor({ ...m.pr, accepts });
    const n1 = st.baseSettles.length;
    const rf = await fetch(`${b.url}${METERED}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": Buffer.from(JSON.stringify(p2)).toString("base64") }, body: CHAT_BODY });
    await rf.text();
    orMode = "ok";
    ok(rf.status >= 400 && st.baseSettles.length === n1, `an upstream failure answers ${rf.status} and settles nothing`);
    await stop(b);
  }
  // 5c. Switch on, the facilitator does not advertise the key: refused, logged.
  {
    st.baseExt = [];
    const b = await boot({ X402_UPTO_NETWORKS: BASE, X402_UPTO_GAS_SPONSORING: "on" });
    const m = await challenge(b.url);
    ok(m.status === 402 && !GAS_KEYS_IN(m.pr), "a key the facilitator does not advertise is not declared");
    ok(/REFUSING eip2612GasSponsoring, the facilitator settling upto on eip155:8453 does not advertise it/.test(b.log.text), "and the refusal is logged");
    await stop(b);
    st.baseExt = [EIP];
  }
  // 5d. Arc: offered only when listed by name.
  {
    for (const [val, want] of [[BASE, false], ["all", false], [`${BASE},${ARC}`, true]]) {
      const b = await boot({ X402_UPTO_NETWORKS: val, X402_UPTO_GAS_SPONSORING: "on" }, { arc: true });
      const m = await challenge(b.url);
      const arcUpto = m.pr?.accepts?.find((a) => a.scheme === "upto" && a.network === ARC);
      ok(m.status === 402 && !!arcUpto === want, `X402_UPTO_NETWORKS=${val}: Arc upto ${want ? "is" : "is not"} offered`);
      ok(m.pr?.accepts?.some((a) => a.scheme === "exact" && a.network === ARC), `X402_UPTO_NETWORKS=${val}: Arc exact is offered as before`);
      ok(!!m.pr?.extensions?.[EIP], `X402_UPTO_NETWORKS=${val}: the declaration holds (every upto settler advertises it)`);
      if (want) {
        ok(arcUpto.extra?.facilitatorAddress?.toLowerCase() === FAC_ARC && arcUpto.extra?.assetTransferMethod === "permit2" && arcUpto.amount === m.pr.accepts.find((a) => a.scheme === "exact" && a.network === ARC).amount,
          "the Arc upto accept names Circle's facilitator, Permit2, and the exact accept's amount");
        const payload = await signFor({ ...m.pr, accepts: [arcUpto] });
        const n0 = st.circleSettles.length;
        const r = await fetch(`${b.url}${METERED}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") }, body: CHAT_BODY });
        await r.text();
        const s = st.circleSettles.slice(n0);
        ok(r.status === 200 && s.length === 1, `a sponsored Arc upto call passes the local preflight, is served and settled through Circle (status ${r.status}, settles ${s.length})`);
        const amt = BigInt(s[0]?.paymentRequirements?.amount ?? -1);
        ok(amt > 0n && amt <= BigInt(arcUpto.amount), `the Arc settle is at or under the quote (${amt} <= ${arcUpto.amount})`);
      }
      await stop(b);
    }
    // Circle does not advertise the key while Base does: not declared anywhere.
    st.circleExt = [];
    const b = await boot({ X402_UPTO_NETWORKS: `${BASE},${ARC}`, X402_UPTO_GAS_SPONSORING: "on" }, { arc: true });
    const m = await challenge(b.url);
    ok(m.pr?.accepts?.some((a) => a.scheme === "upto" && a.network === ARC) && !GAS_KEYS_IN(m.pr), "one upto settler lacking the key: upto stays, the declaration is withheld");
    ok(/REFUSING eip2612GasSponsoring, the facilitator settling upto on eip155:5042/.test(b.log.text), "and the refusal names Arc");
    await stop(b);
    st.circleExt = [EIP];
  }
  // 5e. The 402's headers. Production's /v1 chat 402 measures about 16,000
  // bytes with Base upto on (scripts/test-challenge-size.js), 200 under its
  // 16,200 ceiling. An upto network past the first and the declaration are
  // charged to the route's own budget, so switching Arc upto and sponsoring
  // on never grows the chat 402 past that headroom; every exact accept stays.
  {
    const HEADROOM = 200;
    const post = async (url, path) => {
      const r = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: CHAT_BODY });
      await r.text();
      let total = 20; r.headers.forEach((v, k) => { total += k.length + v.length + 4; });
      const hdr = r.headers.get("payment-required");
      return { status: r.status, total, pr: hdr ? decode(hdr) : null };
    };
    const exactOf = (pr) => JSON.stringify((pr?.accepts || []).filter((a) => a.scheme === "exact").map((a) => [a.network, a.amount, a.payTo]));
    const prod = await boot({ X402_UPTO_NETWORKS: BASE }, { arc: true });
    const on = await boot({ X402_UPTO_NETWORKS: `${BASE},${ARC}`, X402_UPTO_GAS_SPONSORING: "on" }, { arc: true });
    for (const path of ["/v1/chat/completions", METERED]) {
      const [a, b] = [await post(prod.url, path), await post(on.url, path)];
      ok(a.status === 402 && b.status === 402 && exactOf(a.pr) === exactOf(b.pr) && exactOf(a.pr) !== "[]", `${path}: every exact accept is offered unchanged with Arc upto and sponsoring on`);
      const extra = (b.pr?.accepts || []).filter((x) => x.scheme === "upto").slice(1);
      const gas = b.pr?.extensions?.[EIP] ? JSON.stringify({ [EIP]: b.pr.extensions[EIP] }).length : 0;
      const variable = JSON.stringify({ bazaar: b.pr?.extensions?.bazaar }).length + String(b.pr?.resource?.description || "").length + extra.reduce((n, x) => n + JSON.stringify(x).length + 1, 0) + gas;
      ok(variable <= CHALLENGE_VARIABLE_MAX_BYTES, `${path}: the listing, the upto accepts past the first and the declaration fit the per-route budget (${variable} <= ${CHALLENGE_VARIABLE_MAX_BYTES})`);
      for (const x of extra) ok(JSON.stringify(x).length + 1 <= UPTO_ACCEPT_JSON_BYTES, `${path}: the ${x.network} upto accept is within the bytes the budget charges for it (${JSON.stringify(x).length + 1} <= ${UPTO_ACCEPT_JSON_BYTES})`);
      if (path === "/v1/chat/completions") {
        ok(b.total - a.total <= HEADROOM, `${path}: Arc upto and sponsoring add ${b.total - a.total} header bytes over production's configuration (at most ${HEADROOM})`);
        ok(extra.some((x) => x.network === ARC) && !!b.pr?.extensions?.[EIP], `${path}: and the route still offers Arc upto and the declaration`);
      }
    }
    await stop(prod); await stop(on);
  }
  // 5f. A route whose listing cannot give up the bytes of a further upto
  // accept is withheld: it keeps every exact accept and one upto accept, on
  // Base (the first network that is not explicit-only) whatever order
  // X402_UPTO_NETWORKS lists, and declares no gas sponsoring.
  {
    const exactOf = (pr) => JSON.stringify((pr?.accepts || []).filter((a) => a.scheme === "exact").map((a) => [a.network, a.amount, a.payTo, a.asset]));
    const call = async (url, route) => {
      const [method, path] = route.split(" ");
      const r = await fetch(`${url}${path}`, method === "GET" ? {} : { method, headers: { "content-type": "application/json" }, body: "{}" });
      await r.text();
      const hdr = r.headers.get("payment-required");
      return { status: r.status, pr: hdr ? decode(hdr) : null };
    };
    const prod = await boot({ X402_UPTO_NETWORKS: BASE }, { arc: true });
    for (const order of [`${ARC},${BASE}`, `${BASE},${ARC}`]) {
      const b = await boot({ X402_UPTO_NETWORKS: order, X402_UPTO_GAS_SPONSORING: "on", FRED_API_KEY: "test-key-never-sent" }, { arc: true });
      const line = /x402 upto: (\d+) route\(s\) offer upto on (\S+) only, with no gas sponsoring declaration: [^(]*\(([^)]*)\)/.exec(b.log.text);
      const withheld = line ? line[3].split(", ").filter((r) => r && r !== "...") : [];
      ok(!!line && Number(line[1]) > 0 && withheld.length > 0, `X402_UPTO_NETWORKS=${order}: some routes are withheld to fit their 402 budget (${line ? line[1] : 0})`);
      ok(line?.[2] === BASE, `X402_UPTO_NETWORKS=${order}: the warning names the network actually kept (${line?.[2]})`);
      for (const route of withheld) {
        const [a, w] = [await call(prod.url, route), await call(b.url, route)];
        const upto = (w.pr?.accepts || []).filter((x) => x.scheme === "upto");
        ok(w.status === 402 && exactOf(w.pr) === exactOf(a.pr) && exactOf(a.pr) !== "[]", `${order} ${route}: every exact accept stays`);
        ok(upto.length === 1 && upto[0].network === BASE, `${order} ${route}: Base upto stays, and only Base (${upto.map((x) => x.network).join(", ") || "none"})`);
        ok(!GAS_KEYS_IN(w.pr), `${order} ${route}: no gas sponsoring declaration`);
      }
      // Every FRED route's 402 listing ends with the FRED notice with upto on.
      const { MACRO_TOOLS } = await import("../src/tools/macro-kit.js");
      const { FRED_NOTICE } = await import("../src/data-attribution.js");
      const fredRoutes = MACRO_TOOLS.filter((t) => t.usesFred === true).map((t) => t.route);
      const missing = [];
      for (const route of fredRoutes) { const w = await call(b.url, route); if (!(w.status === 402 && String(w.pr?.resource?.description || "").endsWith(FRED_NOTICE))) missing.push(`${route} (${w.status})`); }
      ok(fredRoutes.length >= 12 && missing.length === 0, `${order}: every FRED route's 402 listing keeps the FRED notice (${fredRoutes.length} routes; missing: ${missing.join(", ") || "none"})`);
      // Control: a metered route that fits keeps both upto networks.
      const m = await challenge(b.url);
      ok(new Set((m.pr?.accepts || []).filter((x) => x.scheme === "upto").map((x) => x.network)).size === 2, `${order}: a route that fits keeps upto on both networks`);
      await stop(b);
    }
    await stop(prod);
  }
} catch (e) {
  fail++;
  console.error(`FAIL - ${e?.stack || e}`);
} finally {
  for (const b of booted) { try { await b.stop(); } catch { /* gone */ } }
  for (const s of [baseStub, circleStub, orStub]) { try { s.close(); } catch { /* closed */ } }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

function GAS_KEYS_IN(pr) { return !!(pr?.extensions && (EIP in pr.extensions || ERC in pr.extensions)); }

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
