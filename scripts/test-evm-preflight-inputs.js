#!/usr/bin/env node
// The local EVM payment preflights (src/circle-facilitator.js: the Arc and
// Circle exact one, the Arc upto Permit2 one and the pending-settle nonce;
// src/gateway-nanopayments.js: the batched one) read a payload a buyer wrote.
// A field that is not a string (an object, an array, a number, an object
// whose own toString is not a function) is refused as an invalid payload,
// never coerced and never thrown on. Also pinned here: the signature, permit
// and window rules of the upto preflight that no other suite exercises.
//   node scripts/test-evm-preflight-inputs.js
// Offline: every payment is signed locally with a throwaway key.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { privateKeyToAccount } from "viem/accounts";
import { uptoPermit2WitnessTypes, x402UptoPermit2ProxyAddress, PERMIT2_ADDRESS } from "@x402/evm";
import { preflightUptoPayment, preflightUsdcPayment, pendingNonceOf, ARC_PROFILE } from "../src/circle-facilitator.js";
import { preflightGatewayPayment, gatewayKindsFromSupported, gatewayAcceptFields, GATEWAY_KIND_NAME } from "../src/gateway-nanopayments.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A throwaway key made up for this test (holds nothing on any chain).
const acct = privateKeyToAccount(`0x${"11".repeat(32)}`);
const NOW = 1_900_000_000;
const PAYTO = `0x${"ab".repeat(20)}`, FAC = `0x${"cd".repeat(20)}`;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HOSTILE = [{ toString: 1 }, { toString: 1, valueOf: 1 }, [1, 2], {}, 5, true, null];
const hostile = (v) => JSON.parse(JSON.stringify(v)); // the shape a decoded header can carry
const attempt = async (fn) => { try { return { r: await fn() }; } catch (e) { return { threw: String(e?.message || e).slice(0, 80) }; } };

// --- upto (Permit2) on Arc -----------------------------------------------------
const uptoReq = { scheme: "upto", network: ARC_PROFILE.caip2, asset: ARC_PROFILE.asset, payTo: PAYTO, amount: "50000", maxTimeoutSeconds: 60, extra: { facilitatorAddress: FAC } };
async function upto({ amount = 50000n, spender = x402UptoPermit2ProxyAddress, nonce = 123456789n, deadline = BigInt(NOW + 300), validAfter = BigInt(NOW - 10) } = {}) {
  const message = { permitted: { token: ARC_PROFILE.asset, amount }, spender, nonce, deadline, witness: { to: PAYTO, facilitator: FAC, validAfter } };
  const signature = await acct.signTypedData({ domain: { name: "Permit2", chainId: ARC_PROFILE.chainId, verifyingContract: PERMIT2_ADDRESS }, types: uptoPermit2WitnessTypes, primaryType: "PermitWitnessTransferFrom", message });
  return {
    x402Version: 2, accepted: { scheme: "upto", network: uptoReq.network, asset: uptoReq.asset },
    payload: { signature, permit2Authorization: { from: acct.address, permitted: { token: ARC_PROFILE.asset, amount: String(amount) }, spender, nonce: String(nonce), deadline: String(deadline), witness: { to: PAYTO, facilitator: FAC, validAfter: String(validAfter) } } },
  };
}
const uptoReason = async (p, q = uptoReq, o = {}) => (await preflightUptoPayment(p, q, NOW, o))?.reason ?? "OK";
const good = await upto();
ok(await uptoReason(good) === "OK", "control: a valid upto payment passes the preflight");

// Non-string fields: refused as invalid_payload, never thrown.
{
  const paths = [["from"], ["nonce"], ["spender"], ["deadline"], ["permitted", "amount"], ["permitted", "token"], ["witness", "to"], ["witness", "facilitator"], ["witness", "validAfter"]];
  for (const path of paths) {
    for (const h of HOSTILE) {
      const p = structuredClone(good);
      let o = p.payload.permit2Authorization;
      for (const k of path.slice(0, -1)) o = o[k];
      o[path.at(-1)] = hostile(h);
      const out = await attempt(() => uptoReason(p));
      ok(!out.threw && out.r === "invalid_payload", `upto ${path.join(".")}=${JSON.stringify(h)}: refused as invalid_payload (${out.threw ? `threw ${out.threw}` : out.r})`);
    }
  }
  for (const h of HOSTILE) {
    const p = structuredClone(good); p.payload.permit2Authorization.nonce = hostile(h);
    const out = await attempt(() => pendingNonceOf(p));
    ok(!out.threw && out.r === undefined, `pendingNonceOf with nonce=${JSON.stringify(h)}: no booking nonce, no throw`);
    const e = { payload: { authorization: { nonce: hostile(h) } } };
    const out2 = await attempt(() => pendingNonceOf(e));
    ok(!out2.threw && (h === null ? out2.r === null || out2.r === undefined : out2.r === undefined), `pendingNonceOf with an exact nonce=${JSON.stringify(h)}: no booking nonce, no throw`);
  }
  ok(pendingNonceOf(good) === `0x${(123456789).toString(16).padStart(64, "0")}`, "control: a valid upto nonce is booked in 32-byte form");
}

// Signature, permit and window rules.
{
  const sig = good.payload.signature;
  const s = BigInt(`0x${sig.slice(66, 130)}`), v = parseInt(sig.slice(130), 16);
  const twin = `${sig.slice(0, 66)}${(SECP_N - s).toString(16).padStart(64, "0")}${v === 27 ? "1c" : "1b"}`;
  ok(await uptoReason({ ...good, payload: { ...good.payload, signature: twin } }) === "invalid_upto_evm_payload_signature", "the high-s malleated twin of a valid signature is refused");
  ok(await uptoReason(await upto({ deadline: BigInt(NOW + 5) })) === "permit2_deadline_expired", "a deadline of now+5 is refused");
  ok(await uptoReason(await upto({ deadline: BigInt(NOW + 6) })) === "OK", "a deadline of now+6 is accepted");
  ok(await uptoReason(await upto({ spender: PERMIT2_ADDRESS })) === "invalid_permit2_spender", "a Permit2 authorization naming a spender other than the upto proxy is refused");

  const permitInfo = { from: acct.address, asset: ARC_PROFILE.asset, spender: PERMIT2_ADDRESS, amount: "50000", nonce: "0", deadline: String(NOW + 300), signature: `0x${"22".repeat(65)}`, version: "2" };
  const withPermit = (info) => ({ ...good, extensions: { eip2612GasSponsoring: { info } } });
  ok(await uptoReason(withPermit(permitInfo)) === "OK", "control: an EIP-2612 permit for the signer, the token and Permit2 passes");
  ok(await uptoReason(withPermit({ ...permitInfo, spender: `0x${"ee".repeat(20)}` })) === "invalid_eip2612_extension", "an EIP-2612 permit approving a spender other than Permit2 is refused");
  const { from: _f, ...noFrom } = permitInfo;
  ok(await uptoReason(withPermit(noFrom)) === "invalid_eip2612_extension", "an EIP-2612 permit with no owner (from) is refused");
  ok(await uptoReason(withPermit({ spender: `0x${"ee".repeat(20)}`, signature: `0x${"22".repeat(65)}` })) === "invalid_eip2612_extension", "a partial permit (spender and signature, no from) is refused");
  ok(await uptoReason(withPermit({ description: "the server's declaration", version: "1" })) === "OK", "the server's own declaration echoed back (no permit field) passes: the client merges it in when it holds the allowance");
  const objFrom = await attempt(() => uptoReason(withPermit({ ...permitInfo, from: hostile({ toString: 1 }) })));
  ok(objFrom.r === "invalid_eip2612_extension", `a permit whose from is an object is refused, not thrown on (${objFrom.threw ? `threw ${objFrom.threw}` : objFrom.r})`);
}

// --- exact (EIP-3009) on Arc ---------------------------------------------------
const exactReq = { scheme: "exact", network: ARC_PROFILE.caip2, asset: ARC_PROFILE.asset, payTo: PAYTO, amount: "50000", maxTimeoutSeconds: 60, extra: { name: ARC_PROFILE.name, version: ARC_PROFILE.version } };
const EIP3009 = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
async function exact() {
  const authorization = { from: acct.address, to: PAYTO, value: "50000", validAfter: "0", validBefore: String(NOW + 300), nonce: `0x${"07".repeat(32)}` };
  const signature = await acct.signTypedData({ domain: { name: ARC_PROFILE.name, version: ARC_PROFILE.version, chainId: ARC_PROFILE.chainId, verifyingContract: ARC_PROFILE.asset }, types: EIP3009, primaryType: "TransferWithAuthorization", message: { ...authorization, value: 50000n, validAfter: 0n, validBefore: BigInt(NOW + 300) } });
  return { x402Version: 2, accepted: { scheme: "exact", network: exactReq.network, asset: exactReq.asset }, payload: { signature, authorization } };
}
const exactGood = await exact();
const exactReason = async (p, q = exactReq) => (await preflightUsdcPayment(p, q, NOW))?.reason ?? "OK";
ok(await exactReason(exactGood) === "OK", "control: a valid exact payment passes the preflight");
for (const k of ["from", "to", "value", "validAfter", "validBefore", "nonce"]) {
  for (const h of HOSTILE) {
    const p = structuredClone(exactGood); p.payload.authorization[k] = hostile(h);
    const out = await attempt(() => exactReason(p));
    ok(!out.threw && out.r === "invalid_payload", `exact ${k}=${JSON.stringify(h)}: refused as invalid_payload (${out.threw ? `threw ${out.threw}` : out.r})`);
  }
}

// --- Gateway batched ---------------------------------------------------------
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const GW_WALLET = `0x${"77".repeat(20)}`;
const kinds = gatewayKindsFromSupported({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453", extra: { name: GATEWAY_KIND_NAME, version: "1", verifyingContract: GW_WALLET, minValiditySeconds: 604800, assets: [{ symbol: "USDC", address: BASE_USDC.toLowerCase(), decimals: 6, authorizationVersions: ["1"] }] } }], extensions: [], signers: {} });
const gwReq = { scheme: "exact", network: "eip155:8453", amount: "5000", asset: BASE_USDC, payTo: PAYTO, ...gatewayAcceptFields(kinds.get("eip155:8453")) };
async function gateway() {
  const authorization = { from: acct.address, to: PAYTO, value: "5000", validAfter: "0", validBefore: String(NOW + 604900), nonce: `0x${"09".repeat(32)}` };
  const signature = await acct.signTypedData({ domain: { name: GATEWAY_KIND_NAME, version: "1", chainId: 8453, verifyingContract: GW_WALLET }, types: EIP3009, primaryType: "TransferWithAuthorization", message: { ...authorization, value: 5000n, validAfter: 0n, validBefore: BigInt(NOW + 604900) } });
  return { x402Version: 2, accepted: gwReq, payload: { authorization, signature } };
}
const gwGood = await gateway();
const gwReason = async (p, q = gwReq) => (await preflightGatewayPayment(p, q, kinds, NOW))?.reason ?? "OK";
ok(await gwReason(gwGood) === "OK", "control: a valid Gateway batched payment passes the preflight");
for (const k of ["from", "to", "value", "validAfter", "validBefore", "nonce"]) {
  for (const h of HOSTILE) {
    const p = structuredClone(gwGood); p.payload.authorization[k] = hostile(h);
    const out = await attempt(() => gwReason(p));
    ok(!out.threw && out.r === "invalid_payload", `gateway ${k}=${JSON.stringify(h)}: refused as invalid_payload (${out.threw ? `threw ${out.threw}` : out.r})`);
  }
}

// --- fuzz: random hostile values anywhere in the payload or the requirement --
{
  let seed = 0x2b2b2b2b;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  const pool = [undefined, null, 0, -1, 1.5, "", "0x", "abc", "1e5", " 1", "-1", true, false, [], {}, { toString: 1 }, { valueOf: 1, toString: 1 }, `0x${"zz".repeat(20)}`, "9".repeat(79), "9".repeat(78), "0".repeat(78), [1, 2], `0x${"00".repeat(65)}`, "__proto__"];
  const set = (o, path, val) => { let c = o; for (let i = 0; i < path.length - 1; i++) { if (c[path[i]] === null || typeof c[path[i]] !== "object") c[path[i]] = {}; c = c[path[i]]; } c[path.at(-1)] = val; };
  const leaf = (o, pre = []) => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? [[...pre, k], ...leaf(v, [...pre, k])] : [[...pre, k]]));
  const targets = [
    ["upto", structuredClone({ ...good, extensions: { eip2612GasSponsoring: { info: { from: acct.address, asset: ARC_PROFILE.asset, spender: PERMIT2_ADDRESS } } } }), uptoReq, (p, q) => preflightUptoPayment(p, q, NOW, { settle: rnd(2) === 0 })],
    ["exact", exactGood, exactReq, (p, q) => preflightUsdcPayment(p, q, NOW)],
    ["gateway", gwGood, gwReq, (p, q) => preflightGatewayPayment(p, q, kinds, NOW)],
    ["pendingNonceOf", good, uptoReq, async (p) => pendingNonceOf(p)],
  ];
  for (const [name, base, req, run] of targets) {
    const pPaths = leaf(base), qPaths = leaf(req);
    let throws = 0, first = "";
    for (let i = 0; i < 10_000; i++) {
      const p = structuredClone(base), q = structuredClone(req);
      for (let j = 1 + rnd(3); j > 0; j--) {
        const val = hostile(pool[rnd(pool.length)] ?? null);
        if (rnd(5) === 0) set(q, qPaths[rnd(qPaths.length)], val); else set(p, pPaths[rnd(pPaths.length)], val);
      }
      const out = await attempt(() => run(p, q));
      if (out.threw) { throws++; first ||= out.threw; }
    }
    ok(throws === 0, `${name}: 10,000 payloads with hostile values throw nothing (${throws} threw${first ? `; first: ${first}` : ""})`);
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
