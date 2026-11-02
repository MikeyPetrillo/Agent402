#!/usr/bin/env node
// The stablecoin issuer's facilitator as the LAST settle fallback on Base and
// Polygon (CIRCLE_FACILITATOR_EVM_FALLBACK=on, src/circle-facilitator.js +
// src/payments.js), offline.
//
// What must hold:
//   - switch off (unset or any value but "on"), or no key: no client, no
//     candidate, no request to that facilitator;
//   - it is LAST: after the primary and every existing fallback, never
//     reordering them, and only on Base and Polygon;
//   - it is reached only when every earlier settler refused before
//     broadcasting; an ambiguous failure (timeout, 5xx) anywhere before it
//     stops the chain, so a payment is never settled twice;
//   - it is never a routing client: verify never goes to it, CDP stays first;
//   - it settles exact USDC only, under the chain's own domain: an upto
//     payment, a cross-chain signature or a wrong amount is refused before
//     anything is sent; its errors are a status and a reason code only;
//   - fail closed: a network is a candidate only once its /supported listed
//     exact for it.
// Part 1 drives the real hook and the real client against fetch stubs; part 2
// boots a paid server against stub facilitators to prove the caller path.
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { SettleError } from "@x402/core/types";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hashDomain } from "viem";
import { getFreePorts } from "./lib/free-port.js";
import { registerFacilitatorFailureHooks, lastResortFallbackOverrides, fallbackCandidatesFor } from "../src/payments.js";
import {
  CircleFacilitatorClient, preflightUsdcPayment, ARC_PROFILE, CIRCLE_FACILITATOR_BASE, CIRCLE_EVM_LABEL, CIRCLE_EVM_FALLBACK_PROFILES,
  CIRCLE_EVM_FALLBACK_NETWORKS, circleEvmFallbackFromEnv, circleEvmFallbackEnabled, ARC_CAIP2, ARC_USDC,
} from "../src/circle-facilitator.js";
import { EVM_TOKEN_DOMAINS } from "../src/evm-usdc-domain.js";

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const SECRET = `testsecret${randomBytes(12).toString("hex")}`;
const KEY = `LIVE_API_KEY:${SECRET}`;
const MARKER = `UPSTREAMBODY${randomBytes(6).toString("hex")}`;
const leaks = (t) => String(t).includes(SECRET) || String(t).includes(MARKER);
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const BASE = "eip155:8453";
const POLYGON = "eip155:137";
const profileOf = (n) => CIRCLE_EVM_FALLBACK_PROFILES.find((p) => p.caip2 === n);
const acct = privateKeyToAccount(generatePrivateKey());
const nowSec = () => Math.floor(Date.now() / 1000);
const req = (network = BASE, over = {}) => ({ scheme: "exact", network, asset: profileOf(network).asset, amount: "1000", payTo: TREASURY, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over });
async function signed({ signer = acct, network = BASE, chainId = Number(network.split(":")[1]), verifyingContract = profileOf(network).asset, name = profileOf(network).name, value = "1000", requirement = req(network) } = {}) {
  const authorization = { from: acct.address, to: TREASURY, value, validAfter: "0", validBefore: String(nowSec() + 600), nonce: `0x${randomBytes(32).toString("hex")}` };
  const signature = await signer.signTypedData({
    domain: { name, version: "2", chainId, verifyingContract },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  return { x402Version: 2, accepted: requirement, payload: { authorization, signature } };
}
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
function stubFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const h = routes[String(url).slice(CIRCLE_FACILITATOR_BASE.length)];
    return h ? h(init) : json(404, {});
  };
  fn.calls = calls;
  return fn;
}
const SUPPORTED = {
  x402Version: 2,
  kinds: [
    { x402Version: 2, scheme: "exact", network: ARC_CAIP2, asset: ARC_USDC.asset, extra: { name: "USDC", version: "2" } },
    { x402Version: 2, scheme: "upto", network: BASE, asset: profileOf(BASE).asset },
    { x402Version: 2, scheme: "exact", network: BASE, asset: profileOf(BASE).asset, extra: { name: "USD Coin", version: "2" } },
    { x402Version: 2, scheme: "exact", network: POLYGON, asset: profileOf(POLYGON).asset, extra: { name: "USD Coin", version: "2" } },
  ],
  extensions: [], signers: {},
};
const TX = `0x${"c1".repeat(32)}`;
const settleOk = (init) => { const b = JSON.parse(init.body); return json(200, { success: true, transaction: TX, network: b.paymentRequirements.network, payer: b.paymentPayload.payload.authorization.from }); };

console.log("part 1: the client and the hook");

await check("profiles: Base and Polygon native USDC, each rebuilding the separator the chain returned", () => {
  assert.deepEqual([...CIRCLE_EVM_FALLBACK_NETWORKS], [BASE, POLYGON]);
  for (const p of CIRCLE_EVM_FALLBACK_PROFILES) {
    const row = EVM_TOKEN_DOMAINS.find((r) => r.network === p.caip2 && r.symbol === "USDC");
    assert.equal(hashDomain({ domain: { name: p.name, version: p.version, chainId: p.chainId, verifyingContract: p.asset }, types: { EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ] } }), row.domainSeparator, p.caip2);
  }
});

await check("switch: only CIRCLE_FACILITATOR_EVM_FALLBACK=on with the key builds a client", () => {
  for (const v of [undefined, "", "off", "true", "1", "yes"]) {
    assert.equal(circleEvmFallbackEnabled({ CIRCLE_FACILITATOR_EVM_FALLBACK: v }), false, String(v));
    assert.equal(circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: v, CIRCLE_FACILITATOR_API_KEY: KEY }), null, String(v));
  }
  assert.equal(circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: "on" }), null, "no key, no client");
  const c = circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: " ON ", CIRCLE_FACILITATOR_API_KEY: KEY });
  assert.deepEqual(c.networks, [BASE, POLYGON]);
  assert.deepEqual(circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: "on", CIRCLE_FACILITATOR_API_KEY: KEY }, { networks: [POLYGON] }).networks, [POLYGON], "restricted to the offered networks");
  assert.equal(circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: "on", CIRCLE_FACILITATOR_API_KEY: KEY }, { networks: [] }), null);
  assert.ok(!leaks(`${inspect(c)} ${JSON.stringify(c)}`), "the key is not readable from the client");
  assert.equal(JSON.stringify(c), JSON.stringify({ facilitator: CIRCLE_EVM_LABEL }));
});

await check("/supported: only Base and Polygon exact survive (Arc and upto are not this client's)", async () => {
  const f = stubFetch({ "/supported": () => json(200, SUPPORTED) });
  const c = circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: "on", CIRCLE_FACILITATOR_API_KEY: KEY }, { fetchImpl: f });
  const s = await c.getSupported();
  assert.deepEqual(s.kinds.map((k) => `${k.scheme}:${k.network}`), [`exact:${BASE}`, `exact:${POLYGON}`]);
  assert.ok(!f.calls[0].init.headers.Authorization, "/supported is keyless");
});

await check("candidates: last on Base and Polygon after Solvador and PayAI; absent until confirmed; other chains untouched", () => {
  const pa = {}, sv = {}, last = { name: CIRCLE_EVM_LABEL, client: {} };
  const confirmed = new Set();
  const ov = lastResortFallbackOverrides({ networks: [BASE, POLYGON], payAiClient: pa, solvadorClient: sv, last, confirmed });
  assert.deepEqual(Object.keys(ov), [BASE, POLYGON]);
  assert.deepEqual(fallbackCandidatesFor(BASE, pa, sv, ov).map((c) => c.name), ["Solvador", "PayAI"], "unconfirmed: not a candidate");
  confirmed.add(BASE);
  assert.deepEqual(fallbackCandidatesFor(BASE, pa, sv, ov).map((c) => c.name), ["Solvador", "PayAI", CIRCLE_EVM_LABEL]);
  assert.deepEqual(fallbackCandidatesFor(POLYGON, pa, sv, ov).map((c) => c.name), ["Solvador", "PayAI"], "Polygon waits for its own confirmation");
  confirmed.add(POLYGON);
  assert.deepEqual(fallbackCandidatesFor(POLYGON, pa, sv, ov).map((c) => c.name), ["Solvador", "PayAI", CIRCLE_EVM_LABEL]);
  const alone = lastResortFallbackOverrides({ networks: [BASE], payAiClient: null, solvadorClient: null, last, confirmed });
  assert.deepEqual(fallbackCandidatesFor(BASE, null, null, alone).map((c) => c.name), [CIRCLE_EVM_LABEL], "no other fallback: it is the only one");
  assert.deepEqual(fallbackCandidatesFor("eip155:42161", pa, sv, ov).map((c) => c.name), ["Solvador", "PayAI"], "Arbitrum is not affected");
});

// The real hook, the real client.
const rejection402 = () => new SettleError(402, { success: false, errorReason: "payment_required", transaction: "", network: BASE });
const ambiguous5xx = () => new SettleError(502, { success: false, errorReason: "unexpected_settle_error", transaction: "", network: BASE });
const timeoutErr = () => Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
async function chain({ primaryError, solvador, payai, circleFetch, network = BASE, payload, requirement, flag = true, confirmed = [BASE, POLYGON] }) {
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = flag ? "true" : "";
  const calls = [];
  const stub = (name, behavior) => ({ settle: async () => { calls.push(name); return behavior(); } });
  const pa = payai ? stub("PayAI", payai) : null;
  const sv = solvador ? stub("Solvador", solvador) : null;
  const f = circleFetch || stubFetch({ "/settle": settleOk });
  const circle = circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: "on", CIRCLE_FACILITATOR_API_KEY: KEY }, { fetchImpl: f });
  const settle = circle.settle.bind(circle);
  circle.settle = async (...a) => { calls.push("Circle"); return settle(...a); };
  const hooks = {};
  const server = { onVerifyFailure() { return this; }, onAfterSettle() { return this; }, onSettleFailure(fn) { hooks.fail = fn; return this; } };
  registerFacilitatorFailureHooks(server, pa, sv, lastResortFallbackOverrides({ networks: [BASE, POLYGON], payAiClient: pa, solvadorClient: sv, last: { name: CIRCLE_EVM_LABEL, client: circle }, confirmed: new Set(confirmed) }));
  const requirements = requirement || req(network);
  const paymentPayload = payload || await signed({ network, requirement: requirements });
  let out;
  try { out = await hooks.fail({ requirements, paymentPayload, error: primaryError }); } finally {
    if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK; else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  }
  return { out, calls, fetchCalls: f.calls };
}

await check("primary and every earlier fallback refuse pre-broadcast: the issuer's facilitator settles last, once", async () => {
  const { out, calls, fetchCalls } = await chain({ primaryError: rejection402(), solvador: () => { throw rejection402(); }, payai: () => { throw rejection402(); } });
  assert.deepEqual(calls, ["Solvador", "PayAI", "Circle"]);
  assert.equal(out?.recovered, true);
  assert.equal(out.result.transaction, TX);
  assert.equal(out.result.network, BASE);
  assert.equal(out.result.payer, acct.address);
  const s = fetchCalls.filter((c) => c.url.endsWith("/settle"));
  assert.equal(s.length, 1);
  assert.equal(s[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(JSON.parse(s[0].init.body).paymentRequirements.network, BASE);
});

await check("Polygon: same order, settled under Polygon's own domain", async () => {
  const { out, calls } = await chain({ network: POLYGON, primaryError: rejection402(), solvador: () => { throw rejection402(); }, payai: () => { throw rejection402(); } });
  assert.deepEqual(calls, ["Solvador", "PayAI", "Circle"]);
  assert.equal(out?.result?.network, POLYGON);
});

await check("an earlier fallback that settles: the issuer's facilitator is never asked", async () => {
  const { out, calls, fetchCalls } = await chain({ primaryError: rejection402(), solvador: () => { throw rejection402(); }, payai: () => ({ success: true, transaction: `0x${"0a".repeat(32)}`, network: BASE }) });
  assert.deepEqual(calls, ["Solvador", "PayAI"]);
  assert.equal(out?.recovered, true);
  assert.equal(fetchCalls.length, 0);
});

for (const [label, opts] of [
  ["primary timeout", { primaryError: timeoutErr(), solvador: () => { throw rejection402(); }, payai: () => { throw rejection402(); } }],
  ["primary 5xx", { primaryError: ambiguous5xx(), solvador: () => { throw rejection402(); }, payai: () => { throw rejection402(); } }],
  ["Solvador times out after a primary 402", { primaryError: rejection402(), solvador: () => { throw timeoutErr(); }, payai: () => { throw rejection402(); } }],
  ["PayAI answers 5xx after two 402s", { primaryError: rejection402(), solvador: () => { throw rejection402(); }, payai: () => { throw ambiguous5xx(); } }],
  ["PayAI answers a graceful non-billing failure", { primaryError: rejection402(), solvador: () => { throw rejection402(); }, payai: () => ({ success: false, errorReason: "unexpected_settle_error" }) }],
  ["the settle fallback is off", { flag: false, primaryError: rejection402(), solvador: () => { throw rejection402(); }, payai: () => { throw rejection402(); } }],
  ["the network is not confirmed by /supported", { confirmed: [], primaryError: rejection402(), solvador: () => { throw rejection402(); }, payai: () => { throw rejection402(); } }],
]) {
  await check(`ambiguous or closed (${label}): the issuer's facilitator is never asked, nothing recovered`, async () => {
    const { out, calls, fetchCalls } = await chain(opts);
    assert.ok(!calls.includes("Circle"), `calls: ${calls}`);
    assert.equal(fetchCalls.length, 0);
    assert.notEqual(out?.recovered, true);
  });
}

await check("upto: refused locally after the earlier fallbacks, nothing sent to the issuer's facilitator", async () => {
  const requirement = req(BASE, { scheme: "upto" });
  const payload = { x402Version: 2, accepted: requirement, payload: { permit2Authorization: { from: acct.address }, signature: "0x" + "11".repeat(65) } };
  const { out, calls, fetchCalls } = await chain({ requirement, payload, primaryError: rejection402(), solvador: () => { throw rejection402(); }, payai: () => { throw rejection402(); } });
  assert.deepEqual(calls, ["Solvador", "PayAI", "Circle"]);
  assert.equal(fetchCalls.length, 0);
  assert.notEqual(out?.recovered, true);
  // The client's own answer, even for an upto payload carrying an EIP-3009
  // shaped authorization: the scheme alone refuses it.
  const c = circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: "on", CIRCLE_FACILITATOR_API_KEY: KEY }, { fetchImpl: stubFetch({ "/settle": settleOk, "/verify": () => json(200, { isValid: true }) }) });
  const shaped = await signed({ network: BASE, requirement });
  assert.equal((await c.settle(shaped, requirement)).errorReason, "unsupported_scheme");
  assert.equal((await c.verify(shaped, requirement)).invalidReason, "unsupported_scheme");
  assert.equal(c._fetch.calls.length, 0);
});

await check("cross-chain or tampered payments are refused locally, nothing sent", async () => {
  const c = circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: "on", CIRCLE_FACILITATOR_API_KEY: KEY }, { fetchImpl: stubFetch({ "/settle": settleOk }) });
  const f = c._fetch;
  const cases = [
    ["Base-signed on Polygon", req(POLYGON), await signed({ network: BASE, requirement: req(POLYGON) })],
    ["Polygon chainId, Base token", req(BASE), await signed({ network: BASE, chainId: 137 })],
    ["Arc domain on Base", req(BASE), await signed({ network: BASE, chainId: 5042, name: "USDC", verifyingContract: ARC_USDC.asset })],
    ["short amount", req(BASE), await signed({ network: BASE, value: "999" })],
    ["an Arc requirement", { ...req(BASE), network: ARC_CAIP2, asset: ARC_USDC.asset }, await signed({ network: BASE })],
    ["Arbitrum", { ...req(BASE), network: "eip155:42161" }, await signed({ network: BASE })],
  ];
  for (const [label, r, p] of cases) {
    const out = await c.settle(p, r);
    assert.equal(out.success, false, label);
    assert.match(out.errorReason, /^invalid_/, `${label}: ${out.errorReason}`);
  }
  assert.equal(f.calls.length, 0);
});

await check("a success naming another network or no transaction is not proof", async () => {
  for (const body of [{ success: true, transaction: TX, network: POLYGON }, { success: true, transaction: "", network: BASE }, { success: true, transaction: TX, network: ARC_CAIP2 }]) {
    const c = circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: "on", CIRCLE_FACILITATOR_API_KEY: KEY }, { fetchImpl: stubFetch({ "/settle": () => json(200, body) }) });
    let err = null;
    try { await c.settle(await signed({ network: BASE }), req(BASE)); } catch (e) { err = e; }
    assert.ok(err, JSON.stringify(body));
    assert.equal(err.errorReason, "invalid_settle_response");
  }
});

await check("errors are a status and a reason code: no upstream body or key in anything thrown", async () => {
  const c = circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: "on", CIRCLE_FACILITATOR_API_KEY: KEY }, {
    fetchImpl: stubFetch({ "/settle": () => new Response(`<html>${MARKER} ${KEY}</html>`, { status: 500, headers: { "content-type": "text/html" } }) }),
  });
  let err = null;
  try { await c.settle(await signed({ network: BASE }), req(BASE)); } catch (e) { err = e; }
  assert.ok(err);
  assert.ok(!leaks(`${err.message} ${err.stack} ${inspect(err)} ${JSON.stringify(err)}`));
  assert.equal(err.statusCode, 500, "a 5xx stays ambiguous");
});

await check("settlement_pending on Base is booked with Base's network", async () => {
  const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const booked = [];
  const c = circleEvmFallbackFromEnv({ CIRCLE_FACILITATOR_EVM_FALLBACK: "on", CIRCLE_FACILITATOR_API_KEY: KEY }, {
    pendingPollMs: 5, pendingBudgetMs: 30, onPending: (e) => { booked.push(e); },
    fetchImpl: stubFetch({
      "/settle": () => json(200, { success: false, errorReason: "settlement_pending", extensions: { "settlement-status": { paymentId: id } } }),
      [`/status/${id}`]: () => json(200, { status: "pending", network: BASE }),
    }),
  });
  const out = await c.settle(await signed({ network: BASE }), req(BASE));
  assert.equal(out.success, false);
  assert.equal(out.network, BASE);
  assert.equal(booked.length, 1);
  assert.equal(booked[0].network, BASE);
  assert.equal(booked[0].paymentId, id);
});

await check("the Arc client is unchanged: Base payments never pass its preflight", async () => {
  const f = stubFetch({ "/settle": settleOk });
  const arc = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f });
  const out = await arc.settle(await signed({ network: BASE }), req(BASE));
  assert.equal(out.success, false);
  assert.equal(out.errorReason, "invalid_network");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(arc.networks, [ARC_CAIP2]);
});

// A contract-wallet form: the payload names acct as `from`, but the signature
// is someone else's, so no local EOA check passes and only a verifier could.
const other = privateKeyToAccount(generatePrivateKey());
const ARC_REQ = { scheme: "exact", network: ARC_CAIP2, asset: ARC_USDC.asset, amount: "1000", payTo: TREASURY, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } };
const arcSigned = (signer) => signed({ signer, network: ARC_CAIP2, chainId: 5042, verifyingContract: ARC_USDC.asset, name: "USDC", requirement: ARC_REQ });
const yesVerifier = () => { const v = async () => { v.calls++; return true; }; v.calls = 0; return v; };

await check("a contract-wallet verifier never applies off Arc: an always-yes verifier cannot pass a non-EOA Base or Polygon signature", async () => {
  for (const network of [BASE, POLYGON]) {
    // The preflight itself, handed the verifier with Base/Polygon profiles.
    const v = yesVerifier();
    const direct = await preflightUsdcPayment(await signed({ signer: other, network }), req(network), nowSec(), { contractVerifier: v, profiles: CIRCLE_EVM_FALLBACK_PROFILES });
    assert.equal(direct?.reason, "invalid_exact_evm_payload_signature", `${network} direct`);
    assert.equal(v.calls, 0, `${network}: the verifier is never asked`);
    // A client built with Base/Polygon profiles AND a verifier, and one that
    // also settles Arc (the shape the reconcile status client has).
    for (const profiles of [CIRCLE_EVM_FALLBACK_PROFILES, [ARC_PROFILE, ...CIRCLE_EVM_FALLBACK_PROFILES]]) {
      const cv = yesVerifier();
      const f = stubFetch({ "/settle": settleOk, "/verify": () => json(200, { isValid: true }) });
      const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f, contractVerifier: cv, profiles });
      const s = await c.settle(await signed({ signer: other, network }), req(network));
      assert.equal(s.success, false, `${network} settle`);
      assert.equal(s.errorReason, "invalid_exact_evm_payload_signature");
      assert.equal((await c.verify(await signed({ signer: other, network }), req(network))).invalidReason, "invalid_exact_evm_payload_signature");
      assert.equal(cv.calls, 0, `${network}: the client never hands the verifier a ${network} payment`);
      assert.equal(f.calls.length, 0, "nothing sent");
      // The same client still settles an ordinary EOA payment there.
      assert.equal((await c.settle(await signed({ network }), req(network))).success, true, `${network} EOA`);
    }
  }
});

await check("Arc with the verifier is unchanged: a contract-wallet signature is verified and goes to Circle; without it, refused", async () => {
  for (const profiles of [[ARC_PROFILE], [ARC_PROFILE, ...CIRCLE_EVM_FALLBACK_PROFILES]]) {
    const v = yesVerifier();
    const f = stubFetch({ "/settle": settleOk });
    const c = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: f, contractVerifier: v, profiles });
    const s = await c.settle(await arcSigned(other), ARC_REQ);
    assert.equal(s.success, true, JSON.stringify(s));
    assert.equal(s.network, ARC_CAIP2);
    assert.equal(v.calls, 1);
    assert.equal(f.calls.filter((x) => x.url.endsWith("/settle")).length, 1);
  }
  const bare = new CircleFacilitatorClient({ apiKey: KEY, fetchImpl: stubFetch({ "/settle": settleOk }) });
  assert.equal((await bare.settle(await arcSigned(other), ARC_REQ)).errorReason, "invalid_exact_evm_payload_signature");
  assert.equal((await bare.settle(await arcSigned(acct), ARC_REQ)).success, true, "an Arc EOA payment settles");
});

console.log("part 2: a paid server against stub facilitators");

const [P_SERVER1, P_SERVER2, P_SERVER3, P_CDP, P_PAYAI, P_CIRCLE] = await getFreePorts(6);
const st = { hits: [], cdpSettle: "402" };
const readBody = (r) => new Promise((ok) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });
const raw = (res, s, o) => { res.writeHead(s, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify(o)); };
const payerOf = (b) => b?.paymentPayload?.payload?.authorization?.from;
const cdp = createServer(async (q, res) => {
  const b = await readBody(q);
  st.hits.push({ who: "cdp", url: q.url, network: b?.paymentRequirements?.network });
  if (q.url === "/supported") return raw(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: BASE }], extensions: [], signers: {} });
  if (q.url === "/verify") return raw(res, 200, { isValid: true, payer: payerOf(b) });
  if (q.url === "/settle") {
    if (st.cdpSettle === "500") return raw(res, 500, { errorReason: "unexpected_settle_error" });
    return raw(res, 402, { success: false, errorReason: "payment_required", transaction: "", network: BASE });
  }
  return raw(res, 404, {});
});
const payai = createServer(async (q, res) => {
  const b = await readBody(q);
  st.hits.push({ who: "payai", url: q.url, network: b?.paymentRequirements?.network });
  if (q.url === "/supported") return raw(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "exact", network: POLYGON }], extensions: [], signers: {} });
  if (q.url === "/settle") return raw(res, 402, { success: false, errorReason: "payment_required", transaction: "", network: b?.paymentRequirements?.network });
  if (q.url === "/verify") return raw(res, 200, { isValid: true, payer: payerOf(b) });
  return raw(res, 404, {});
});
const circleStub = createServer(async (q, res) => {
  const b = await readBody(q);
  st.hits.push({ who: "circle", url: q.url, network: b?.paymentRequirements?.network, auth: q.headers.authorization || "" });
  if (q.url === "/supported") return raw(res, 200, SUPPORTED);
  if (q.headers.authorization !== `Bearer ${KEY}`) return raw(res, 401, { code: 401 });
  if (q.url === "/settle") return raw(res, 200, { success: true, transaction: TX, network: b.paymentRequirements.network, payer: payerOf(b) });
  if (q.url === "/verify") return raw(res, 200, { isValid: true, payer: payerOf(b) });
  return raw(res, 404, {});
});
await Promise.all([[cdp, P_CDP], [payai, P_PAYAI], [circleStub, P_CIRCLE]].map(([s, p]) => new Promise((r) => s.listen(p, "127.0.0.1", r))));
const tmp = mkdtempSync(join(tmpdir(), "a402-circle-evm-"));
const preload = join(tmp, "circle-redirect.mjs");
writeFileSync(preload, `
const BASE = ${JSON.stringify(CIRCLE_FACILITATOR_BASE)};
const STUB = process.env.CIRCLE_EVM_TEST_STUB;
const real = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
  if (STUB && typeof u === "string" && u.startsWith(BASE)) return real(STUB + u.slice(BASE.length), init);
  return real(input, init);
};
`);
async function boot(port, extraEnv) {
  const env = { ...process.env };
  for (const k of ["STATE_DATABASE_URL", "REDIS_URL", "SOLVADOR_KEY", "CIRCLE_FACILITATOR_API_KEY", "CIRCLE_FACILITATOR_EVM_FALLBACK"]) delete env[k];
  const proc = spawn(process.execPath, ["--import", preload, "src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...env, PORT: String(port), FREE_MODE: "",
      WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base,polygon",
      CDP_FACILITATOR_URL: `http://127.0.0.1:${P_CDP}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "",
      PAYAI_FACILITATOR_URL: `http://127.0.0.1:${P_PAYAI}`, PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      CIRCLE_EVM_TEST_STUB: `http://127.0.0.1:${P_CIRCLE}`, CIRCLE_FACILITATOR_API_KEY: KEY,
      PAYMENT_SETTLE_FALLBACK: "true", X402_UPTO_NETWORKS: "", POSTHOG_API_KEY: "", MPP_SECRET_KEY: "", FACILITATOR_GAS_CHECK: "off",
      SALES_LEDGER_DB: join(tmp, `sales-${port}.db`), REFUND_DB_DIR: tmp, INFLIGHT_COVER: "off", CIRCLE_PENDING_FILE: join(tmp, `circle-pending-${port}.json`), GATED_RAIL_HISTORY_FILE: join(tmp, `gated-${port}.json`),
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = { text: "" };
  proc.stdout.on("data", (c) => { log.text += c; });
  proc.stderr.on("data", (c) => { log.text += c; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${url}/health`)).ok) return { url, log, proc }; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill("SIGKILL");
  throw new Error(`server never became healthy: ${log.text.slice(-600)}`);
}
const PATH = "/api/demand-radar?limit=1";
const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
async function payBase(url) {
  const r402 = await fetch(`${url}${PATH}`);
  await r402.text();
  const env = decode(r402.headers.get("payment-required"));
  const accepted = env.accepts.find((a) => a.network === BASE && a.scheme === "exact");
  const p = await signed({ network: BASE, value: accepted.amount, requirement: accepted });
  const r = await fetch(`${url}${PATH}`, { headers: { "payment-signature": Buffer.from(JSON.stringify({ ...p, resource: env.resource })).toString("base64") } });
  await r.text();
  return r;
}
const settleOrder = () => st.hits.filter((h) => h.url === "/settle").map((h) => h.who);

await check("switch off (key set): Base settles through CDP then PayAI only; the issuer's facilitator never sees a Base settle", async () => {
  st.hits = []; st.cdpSettle = "402";
  const { url, log, proc } = await boot(P_SERVER1, {});
  try {
    const r = await payBase(url);
    assert.equal(r.status, 402, `both refuse: the buyer is not served (got ${r.status})`);
    assert.deepEqual(settleOrder(), ["cdp", "payai"]);
    assert.ok(!st.hits.some((h) => h.who === "circle" && h.network === BASE), "nothing about Base reached it");
    assert.ok(!log.text.includes(CIRCLE_EVM_LABEL), "no fallback line in the boot log");
  } finally { proc.kill("SIGKILL"); }
});

await check("switch on: CDP verifies and is tried first; after CDP and PayAI refuse pre-broadcast the issuer's facilitator settles once", async () => {
  st.hits = []; st.cdpSettle = "402";
  const { url, log, proc } = await boot(P_SERVER2, { CIRCLE_FACILITATOR_EVM_FALLBACK: "on" });
  try {
    for (let i = 0; i < 40 && !log.text.includes(`${CIRCLE_EVM_LABEL}: last settle fallback`); i++) await new Promise((r) => setTimeout(r, 250));
    assert.match(log.text, new RegExp(`${CIRCLE_EVM_LABEL.replace(/[()]/g, "\\$&")}: last settle fallback on eip155:8453, eip155:137`));
    const r = await payBase(url);
    assert.equal(r.status, 200, `served after the last fallback settled (got ${r.status})`);
    assert.deepEqual(settleOrder(), ["cdp", "payai", "circle"]);
    const v = st.hits.filter((h) => h.url === "/verify");
    assert.ok(v.length >= 1 && v.every((h) => h.who === "cdp"), `verify went to CDP only (${JSON.stringify(v)})`);
    const s = st.hits.find((h) => h.who === "circle" && h.url === "/settle");
    assert.equal(s.auth, `Bearer ${KEY}`);
    assert.equal(s.network, BASE);
    assert.equal(decode(r.headers.get("payment-response")).transaction, TX);
    assert.ok(!leaks(log.text), "the key never reaches a log line");
  } finally { proc.kill("SIGKILL"); }
});

await check("switch on, CDP answers 5xx (ambiguous): the chain stops, nobody else is asked", async () => {
  st.hits = []; st.cdpSettle = "500";
  const { url, log, proc } = await boot(P_SERVER3, { CIRCLE_FACILITATOR_EVM_FALLBACK: "on" });
  try {
    for (let i = 0; i < 40 && !log.text.includes(`${CIRCLE_EVM_LABEL}: last settle fallback`); i++) await new Promise((r) => setTimeout(r, 250));
    const r = await payBase(url);
    assert.equal(r.status, 402);
    assert.deepEqual(settleOrder(), ["cdp"]);
  } finally { proc.kill("SIGKILL"); st.cdpSettle = "402"; }
});

for (const s of [cdp, payai, circleStub]) s.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
