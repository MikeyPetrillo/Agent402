// The Tempo sender a per-buyer bound keys on must be PROVEN by the credential,
// and a route that spends before the buyer's payment settles takes a Tempo pull
// credential only from a proven sender (src/mpp-tempo.js: inspectTempoSender,
// tempoAccessKeyActive, the gate's verifiedSenderRequired step).
//
// Every transaction below is a REAL Tempo transaction built with viem/tempo or
// ox in this process - the same libraries buyers sign with - never a
// hand-written byte string:
//   A. inspectTempoSender on each envelope kind: secp256k1, p256 and webAuthn
//      senders are proven by their signature; a keychain envelope yields the
//      account and access key for an on-chain check; a keychain envelope that
//      names someone else's account, a multisig envelope, an address placed in
//      the fee-payer slot and a p256 envelope carrying someone else's public
//      key never yield a verified sender.
//      An access key on its FIRST use carries the account's authorization of
//      it inline (viem's KeyAuthorizationManager flow); that authorization is
//      checked offline and counts only when it is the account's own signature
//      over exactly that key, on this chain, unexpired.
//   B. tempoAccessKeyState / tempoAccessKeyActive (one eth_call to the
//      AccountKeychain precompile) and the cached verifier, against a stubbed
//      RPC: fails closed; an inline authorization is accepted only while the
//      chain holds no record of the key (never a revoked or expired one).
//   C. The gate in-process: a route that requires a verified sender refuses an
//      unproven pull credential BEFORE validate(); an ordinary route serves it
//      and keys its bounds on the client IP.
//   D. The real server: an unproven credential on route-execute and on
//      seller-payability is refused before any relay call; a proven one
//      (plain key, an access key the stubbed RPC reports active, or a new
//      access key carrying the account's authorization) reaches the relay; an
//      ordinary route still reaches the relay.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import express from "express";
import { Challenge, Credential } from "mppx";
import { Account as TempoAccount, Abis, Addresses } from "viem/tempo";
import { encodeFunctionResult, decodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { P256, Secp256k1 } from "ox";
import { TxEnvelopeTempo, SignatureEnvelope, KeyAuthorization } from "ox/tempo";
import { getFreePorts } from "./lib/free-port.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TREASURY = "0x000000000000000000000000000000000000dEaD";
const CURRENCY = "0x2000000000000000000000000000000000000000";
const TX = { chainId: 4217, calls: [{ to: CURRENCY, data: "0xdeadbeef" }], nonce: 0n, nonceKey: 0n, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
const lc = (a) => String(a).toLowerCase();

// Buyers.
const plainKey = generatePrivateKey();
const plain = TempoAccount.fromSecp256k1(plainKey);
const p256Key = P256.randomPrivateKey();
const p256Root = TempoAccount.fromP256(p256Key);
const webAuthnRoot = TempoAccount.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: "wallet.example", origin: "https://wallet.example" });
const rootKey = generatePrivateKey();
const root = TempoAccount.fromSecp256k1(rootKey);
const accessKey = generatePrivateKey();
const agent = TempoAccount.fromSecp256k1(accessKey, { access: root });
const agentKeyAddress = lc(privateKeyToAccount(accessKey).address);
const p256AccessKey = P256.randomPrivateKey();
const p256Agent = TempoAccount.fromP256(p256AccessKey, { access: root });
// Someone else's funded account, and an attacker who holds none of its keys.
const victim = lc(privateKeyToAccount(generatePrivateKey()).address);
const attackerKey = generatePrivateKey();
const attacker = lc(privateKeyToAccount(attackerKey).address);
const forger = TempoAccount.fromSecp256k1(attackerKey, { access: victim });
// Access keys on their FIRST use (not yet on chain): the transaction carries
// the account's authorization of the key inline, as viem's
// KeyAuthorizationManager attaches it. One key per case, so no server-side
// cache entry is shared between cases.
const EXPIRY_S = Math.floor(Date.now() / 1000) + 3600;
const freshAgent = (access = root) => TempoAccount.fromSecp256k1(generatePrivateKey(), { access });
const newAgent = freshAgent();
const newP256RootKey = P256.randomPrivateKey();
const newP256Root = TempoAccount.fromP256(newP256RootKey);
const newP256Agent = TempoAccount.fromP256(P256.randomPrivateKey(), { access: newP256Root });
const newWebAuthnAgent = TempoAccount.fromHeadlessWebAuthn(P256.randomPrivateKey(), { access: root, rpId: "wallet.example", origin: "https://wallet.example" });
const attackerRoot = TempoAccount.fromSecp256k1(attackerKey);
const forgerNew = TempoAccount.fromSecp256k1(generatePrivateKey(), { access: victim });
/** A key authorization built and signed with ox, for shapes viem does not emit. */
function oxKeyAuthorization(fields, privateKey) {
  const ka = KeyAuthorization.from(fields);
  return KeyAuthorization.from(ka, { signature: SignatureEnvelope.from(Secp256k1.sign({ payload: KeyAuthorization.getSignPayload(ka), privateKey })) });
}
async function firstUse(agentAccount, keyAuthorization) {
  return agentAccount.signTransaction({ ...TX, type: "tempo", nonce: 0, keyAuthorization });
}

async function signWith(account) {
  return account.signTransaction({ ...TX, type: "tempo", nonce: 0 });
}
/** Build a transaction with ox directly, for shapes no stock account emits. */
function oxSigned({ signer = attackerKey, envelope = null, sender = null } = {}) {
  const base = TxEnvelopeTempo.from({ ...TX, ...(sender ? { feePayerSignature: null } : {}) });
  const payload = TxEnvelopeTempo.getSignPayload(base);
  const primitive = SignatureEnvelope.from(Secp256k1.sign({ payload, privateKey: signer }));
  const signature = envelope ? envelope(primitive, payload) : primitive;
  return TxEnvelopeTempo.serialize(base, { signature, ...(sender ? { sender } : {}) });
}

/** A keychain V2 envelope built with ox: `key` signs for `account`, and
 *  `sender` (optional) is written into the fee-payer slot. */
function oxKeychain({ account, key, sender = null }) {
  const base = TxEnvelopeTempo.from({ ...TX, ...(sender ? { feePayerSignature: null } : {}) });
  const inner = SignatureEnvelope.from(Secp256k1.sign({ payload: TxEnvelopeTempo.getSignPayload(base, { from: account }), privateKey: key }));
  const signature = SignatureEnvelope.from({ type: "keychain", userAddress: account, inner, version: "v2" });
  return TxEnvelopeTempo.serialize(base, { signature, ...(sender ? { sender } : {}) });
}

/** A keychain envelope that CARRIES a registered p256 access key's public
 *  key (public on chain once used) with a signature that key never made. */
function oxKeychainForgedP256({ account, publicKey }) {
  const inner = SignatureEnvelope.from({ type: "p256", publicKey, prehash: true, signature: { r: 1n, s: 1n, yParity: 0 } });
  return TxEnvelopeTempo.serialize(TxEnvelopeTempo.from(TX), { signature: SignatureEnvelope.from({ type: "keychain", userAddress: account, inner, version: "v2" }) });
}

const SECRET = "tempo-sender-secret";
const REALM = "sender.test";
function credential(signedTx, { amount = "50000", realm = REALM, secretKey = SECRET, push = false } = {}) {
  const challenge = Challenge.from({
    realm, method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000),
    request: { amount, currency: CURRENCY, decimals: 6, recipient: TREASURY, methodDetails: { chainId: 4217 } },
    secretKey,
  });
  const payload = push ? { hash: `0x${"ab".repeat(32)}`, type: "hash" } : { signature: signedTx, type: "transaction" };
  // `source` names the victim on every credential: the client-supplied hint
  // must never become a key, whatever it says.
  return Credential.serialize({ challenge, payload, source: `did:pkh:eip155:4217:${victim}` });
}

const env = {
  TEMPO_API_KEY: process.env.TEMPO_API_KEY, TEMPO_RECIPIENT_ADDRESS: process.env.TEMPO_RECIPIENT_ADDRESS, TEMPO_CURRENCY: process.env.TEMPO_CURRENCY,
};
process.env.TEMPO_API_KEY = "test-tempo-key";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
process.env.TEMPO_CURRENCY = CURRENCY;
const { inspectTempoSender, tempoSenderOf, tempoAccessKeyActive, tempoAccessKeyState, createKeychainSenderVerifier, createTempoGate, checkTempoCredentialBinding, TEMPO_SENDER_UNVERIFIED } = await import("../src/mpp-tempo.js");
const { gatewaySettleBreakerKey } = await import("../src/gateway-settle-breaker.js");

// Signed transactions, one per shape.
const TX_PLAIN = await signWith(plain);
const TX_P256 = await signWith(p256Root);
const TX_WEBAUTHN = await signWith(webAuthnRoot);
const TX_AGENT = await signWith(agent);
const TX_P256_AGENT = await signWith(p256Agent);
const TX_FORGED_KEYCHAIN = await signWith(forger);
const TX_ROOT_AS_KEYCHAIN = await signWith(TempoAccount.fromSecp256k1(rootKey, { access: root }));
const TX_MULTISIG = oxSigned({ envelope: (primitive) => SignatureEnvelope.from({ account: victim, signatures: [primitive] }) });
const TX_FEE_SLOT_VICTIM = oxSigned({ sender: victim });
const TX_FEE_SLOT_SELF = oxSigned({ sender: attacker });
const victimP256 = P256.getPublicKey({ privateKey: P256.randomPrivateKey() });
const TX_KEYCHAIN_FORGED_P256 = oxKeychainForgedP256({ account: lc(root.address), publicKey: P256.getPublicKey({ privateKey: p256AccessKey }) });
const TX_P256_FORGED = oxSigned({ envelope: () => SignatureEnvelope.from({ type: "p256", publicKey: victimP256, prehash: true, signature: { r: 1n, s: 1n, yParity: 0 } }) });
const TX_FIRST_USE = await firstUse(newAgent, await root.signKeyAuthorization(newAgent, { chainId: 4217, expiry: EXPIRY_S }));
const TX_FIRST_USE_P256_ROOT = await firstUse(newP256Agent, await newP256Root.signKeyAuthorization(newP256Agent, { chainId: 4217, expiry: EXPIRY_S }));
const TX_FIRST_USE_WEBAUTHN_KEY = await firstUse(newWebAuthnAgent, await root.signKeyAuthorization(newWebAuthnAgent, { chainId: 4217 }));
const anyChainAgent = freshAgent();
const TX_FIRST_USE_ANY_CHAIN = await firstUse(anyChainAgent, oxKeyAuthorization({ address: anyChainAgent.accessKeyAddress, chainId: 0n, type: "secp256k1" }, rootKey));
const otherChainAgent = freshAgent();
const TX_FIRST_USE_OTHER_CHAIN = await firstUse(otherChainAgent, await root.signKeyAuthorization(otherChainAgent, { chainId: 42431, expiry: EXPIRY_S }));
const expiredAgent = freshAgent();
const TX_FIRST_USE_EXPIRED = await firstUse(expiredAgent, await root.signKeyAuthorization(expiredAgent, { chainId: 4217, expiry: EXPIRY_S - 7200 }));
// Signed by the attacker's own root for a key the attacker holds, in a
// transaction that names the victim's account.
const TX_FIRST_USE_FORGED = await firstUse(forgerNew, await attackerRoot.signKeyAuthorization(forgerNew, { chainId: 4217, expiry: EXPIRY_S }));
// The account's real authorization, but of a DIFFERENT key than the one that signed.
const otherKeyAgent = freshAgent();
const TX_FIRST_USE_OTHER_KEY = await firstUse(otherKeyAgent, await root.signKeyAuthorization(freshAgent(), { chainId: 4217, expiry: EXPIRY_S }));
const typeAgent = freshAgent();
const TX_FIRST_USE_WRONG_TYPE = await firstUse(typeAgent, oxKeyAuthorization({ address: typeAgent.accessKeyAddress, chainId: 4217n, type: "p256", expiry: EXPIRY_S }, rootKey));
const boundAgent = freshAgent();
const TX_FIRST_USE_BOUND_ELSEWHERE = await firstUse(boundAgent, oxKeyAuthorization({ address: boundAgent.accessKeyAddress, chainId: 4217n, type: "secp256k1", account: victim, isAdmin: true }, rootKey));
// Carries the p256 account's PUBLIC key (public once used) with a signature
// that key never made: the address it names is the account's, the signature
// is not.
const p256ForgedAgent = TempoAccount.fromP256(P256.randomPrivateKey(), { access: newP256Root });
const p256ForgedAuth = KeyAuthorization.from(
  { address: p256ForgedAgent.accessKeyAddress, chainId: 4217n, type: "p256", expiry: EXPIRY_S },
  { signature: SignatureEnvelope.from({ type: "p256", publicKey: P256.getPublicKey({ privateKey: newP256RootKey }), prehash: true, signature: { r: 1n, s: 1n, yParity: 0 } }) },
);
const TX_FIRST_USE_P256_FORGED_AUTH = await firstUse(p256ForgedAgent, p256ForgedAuth);
const oxAgent = freshAgent();
const TX_FIRST_USE_OX = await firstUse(oxAgent, oxKeyAuthorization({ address: oxAgent.accessKeyAddress, chainId: 4217n, type: "secp256k1", expiry: EXPIRY_S }, rootKey));

// ---------------------------------------------------------------------------
// A. inspectTempoSender
// ---------------------------------------------------------------------------
{
  const cases = [
    ["secp256k1 key", TX_PLAIN, lc(plain.address)],
    ["p256 key", TX_P256, lc(p256Root.address)],
    ["webAuthn key", TX_WEBAUTHN, lc(webAuthnRoot.address)],
    ["the account's own key wrapped as a keychain signature", TX_ROOT_AS_KEYCHAIN, lc(root.address)],
  ];
  for (const [name, raw, want] of cases) {
    const s = inspectTempoSender(credential(raw));
    ok(s.verified === want && s.claimed === want && s.keychain === null, `A: ${name} proves its sender (${s.envelope}, ${s.reason})`);
    ok(tempoSenderOf(credential(raw)) === want, `A: tempoSenderOf returns the proven ${name} sender`);
  }
  const k = inspectTempoSender(credential(TX_AGENT));
  ok(k.envelope === "keychain" && k.verified === null && k.claimed === lc(root.address) && k.keychain?.account === lc(root.address) && k.keychain?.accessKey === agentKeyAddress,
    `A: an access key signature yields the account and the access key for an on-chain check, never a verified sender (${JSON.stringify(k.keychain)})`);
  ok(tempoSenderOf(credential(TX_AGENT)) === null, "A: tempoSenderOf does not return a keychain account on its own");
  const kp = inspectTempoSender(credential(TX_P256_AGENT));
  ok(kp.keychain?.account === lc(root.address) && kp.keychain?.accessKey === lc(p256Agent.accessKeyAddress) && kp.verified === null, "A: a p256 access key is recovered from its own public key and checked the same way");
  const f = inspectTempoSender(credential(TX_FORGED_KEYCHAIN));
  ok(f.claimed === victim && f.verified === null && f.keychain?.account === victim && f.keychain?.accessKey === attacker,
    "A: a keychain envelope naming someone else's account is NOT verified; the key it carries is the attacker's own (the chain must vouch for it)");
  const kc = inspectTempoSender(credential(oxKeychain({ account: lc(root.address), key: accessKey })));
  ok(kc.keychain?.account === lc(root.address) && kc.keychain?.accessKey === agentKeyAddress, "A: control - an ox-built keychain envelope reads like the viem-built one");
  const kcSlot = inspectTempoSender(credential(oxKeychain({ account: lc(root.address), key: accessKey, sender: victim })));
  ok(kcSlot.claimed === victim && kcSlot.verified === null && kcSlot.keychain === null, `A: a keychain envelope whose fee-payer slot names a different sender yields neither a sender nor a key to check (${kcSlot.reason})`);
  const kf = inspectTempoSender(credential(TX_KEYCHAIN_FORGED_P256));
  ok(kf.verified === null && kf.keychain === null, `A: a keychain envelope carrying a real access key's public key with a signature that key never made yields no key to check (${kf.reason})`);
  const m = inspectTempoSender(credential(TX_MULTISIG));
  ok(m.envelope === "multisig" && m.claimed === victim && m.verified === null && m.keychain === null, `A: a multisig envelope naming an account is never verified here (${m.reason})`);
  const fs = inspectTempoSender(credential(TX_FEE_SLOT_VICTIM));
  ok(fs.claimed === victim && fs.verified === null && fs.keychain === null, `A: an address placed in the fee-payer slot is not taken as the sender (${fs.reason})`);
  const fsSelf = inspectTempoSender(credential(TX_FEE_SLOT_SELF));
  ok(fsSelf.claimed === attacker && fsSelf.verified === attacker, "A: control - the fee-payer slot naming the real signer is proven by the signature");
  const pf = inspectTempoSender(credential(TX_P256_FORGED));
  ok(pf.claimed !== null && pf.verified === null, `A: a p256 envelope carrying someone else's public key with a signature that does not verify is not a sender (${pf.reason})`);
  // First use of an access key: the account's own authorization rides inline.
  for (const [name, raw, acct, key] of [
    ["a secp256k1 root", TX_FIRST_USE, root.address, newAgent.accessKeyAddress],
    ["a p256 root (p256 access key)", TX_FIRST_USE_P256_ROOT, newP256Root.address, newP256Agent.accessKeyAddress],
    ["a webAuthn access key", TX_FIRST_USE_WEBAUTHN_KEY, root.address, newWebAuthnAgent.accessKeyAddress],
    ["chain 0 (every chain) and no expiry", TX_FIRST_USE_ANY_CHAIN, root.address, anyChainAgent.accessKeyAddress],
    ["an ox-built authorization (control for the shapes below)", TX_FIRST_USE_OX, root.address, oxAgent.accessKeyAddress],
  ]) {
    const s = inspectTempoSender(credential(raw));
    ok(s.verified === null && s.keychain?.account === lc(acct) && s.keychain?.accessKey === lc(key) && s.keychain?.inlineAuthorization === true,
      `A: first use of an access key under ${name}: the inline authorization proves the account, pending the chain read (${s.reason})`);
  }
  ok(inspectTempoSender(credential(TX_AGENT)).keychain?.inlineAuthorization === false, "A: an access key used without an inline authorization reads inlineAuthorization false");
  ok(inspectTempoSender(credential(TX_FIRST_USE), { now: (EXPIRY_S + 10) * 1000 }).keychain?.inlineAuthorization === false, "A: the inline authorization's expiry is read at the time of the request");
  for (const [name, raw] of [
    ["signed by the attacker's own root in a transaction naming the victim's account", TX_FIRST_USE_FORGED],
    ["authorizing a different key than the one that signed", TX_FIRST_USE_OTHER_KEY],
    ["for another chain", TX_FIRST_USE_OTHER_CHAIN],
    ["that has expired", TX_FIRST_USE_EXPIRED],
    ["for a different key type than the signature", TX_FIRST_USE_WRONG_TYPE],
    ["bound to another account", TX_FIRST_USE_BOUND_ELSEWHERE],
    ["carrying the p256 account's public key with a signature that key never made", TX_FIRST_USE_P256_FORGED_AUTH],
  ]) {
    const s = inspectTempoSender(credential(raw));
    ok(s.verified === null && s.keychain !== null && s.keychain.inlineAuthorization === false, `A: an inline authorization ${name} proves nothing (${s.reason})`);
  }
  ok(inspectTempoSender(credential(TX_FIRST_USE_FORGED)).keychain?.account === victim, "A: ...the forged one names the victim's account, which is what it fails to prove");
  ok(inspectTempoSender(credential(null, { push: true })).verified === null && inspectTempoSender("Payment junk").verified === null && inspectTempoSender(credential("0x76deadbeef")).verified === null && inspectTempoSender(credential(`0x02${TX_PLAIN.slice(4)}`)).verified === null,
    "A: a push credential, junk, an undecodable transaction and a non-Tempo type byte yield nothing (never throws)");
}

// ---------------------------------------------------------------------------
// B. The on-chain access-key read, against a stubbed RPC.
// ---------------------------------------------------------------------------
const NOW_S = Math.floor(Date.now() / 1000);
/** A JSON-RPC stub for AccountKeychain.getKey. `keys` maps "account:key" to a
 *  key record; anything else reads as the empty record (no such key). */
function keychainRpc(keys, calls) {
  return (body) => {
    calls.push(body.method);
    if (body.method !== "eth_call" || lc(body.params?.[0]?.to) !== lc(Addresses.accountKeychain)) return { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unsupported in stub" } };
    const { args } = decodeFunctionData({ abi: Abis.accountKeychain, data: body.params[0].data });
    const rec = keys.get(`${lc(args[0])}:${lc(args[1])}`) || { signatureType: 0, keyId: "0x0000000000000000000000000000000000000000", expiry: 0n, enforceLimits: false, isRevoked: false };
    return { jsonrpc: "2.0", id: body.id, result: encodeFunctionResult({ abi: Abis.accountKeychain, functionName: "getKey", result: rec }) };
  };
}
const activeRec = (key, extra = {}) => ({ signatureType: 0, keyId: key, expiry: BigInt(NOW_S + 3600), enforceLimits: true, isRevoked: false, ...extra });
{
  const calls = [];
  const keys = new Map([
    [`${lc(root.address)}:${agentKeyAddress}`, activeRec(agentKeyAddress)],
    [`${lc(root.address)}:${attacker}`, activeRec(attacker, { isRevoked: true })],
    [`${victim}:${agentKeyAddress}`, activeRec(agentKeyAddress, { expiry: BigInt(NOW_S - 10) })],
    [`${victim}:${attacker}`, activeRec(victim)], // keyId names a different key
    [`${victim}:${lc(plain.address)}`, { signatureType: 0, keyId: "0x0000000000000000000000000000000000000000", expiry: 0n, enforceLimits: false, isRevoked: true }], // revoked, record cleared
  ]);
  const handle = keychainRpc(keys, calls);
  const fetchImpl = async (_url, init) => new Response(JSON.stringify(handle(JSON.parse(init.body))), { status: 200, headers: { "content-type": "application/json" } });
  const opts = { rpcUrl: "http://rpc.stub", fetchImpl };
  ok(await tempoAccessKeyActive({ account: root.address, accessKey: agentKeyAddress }, opts) === true, "B: an active, unrevoked, unexpired key reads active");
  ok(await tempoAccessKeyActive({ account: root.address, accessKey: attacker }, opts) === false, "B: a revoked key reads inactive");
  ok(await tempoAccessKeyActive({ account: victim, accessKey: agentKeyAddress }, opts) === false, "B: an expired key reads inactive");
  ok(await tempoAccessKeyActive({ account: victim, accessKey: attacker }, opts) === false, "B: a record for a different key id reads inactive");
  ok(await tempoAccessKeyActive({ account: root.address, accessKey: lc(plain.address) }, opts) === false, "B: no such key (the empty record) reads inactive");
  const states = [
    [root.address, agentKeyAddress, "active"], [root.address, attacker, "revoked"], [victim, agentKeyAddress, "expired"],
    [victim, attacker, "mismatch"], [root.address, lc(plain.address), "absent"], [victim, lc(plain.address), "revoked"],
  ];
  for (const [account, key, want] of states) {
    const got = await tempoAccessKeyState({ account, accessKey: key }, opts);
    ok(got === want, `B: tempoAccessKeyState reads ${want} (got ${got})`);
  }
  ok(await tempoAccessKeyState({ account: root.address, accessKey: agentKeyAddress }, { ...opts, fetchImpl: async () => new Response("nope", { status: 502 }) }) === "unreadable"
    && await tempoAccessKeyState({ account: "nope", accessKey: agentKeyAddress }, opts) === "unreadable", "B: an RPC error or a malformed address reads unreadable, never absent");
  ok(await tempoAccessKeyActive({ account: root.address, accessKey: agentKeyAddress }, { ...opts, fetchImpl: async () => new Response("nope", { status: 502 }) }) === false, "B: an RPC error status fails closed");
  ok(await tempoAccessKeyActive({ account: root.address, accessKey: agentKeyAddress }, { ...opts, fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "x" } })) }) === false, "B: a JSON-RPC error fails closed");
  ok(await tempoAccessKeyActive({ account: root.address, accessKey: agentKeyAddress }, { ...opts, fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1234" })) }) === false, "B: an unreadable result fails closed");
  // AbortSignal.timeout's timer does not hold the event loop open (a real
  // socket does); hold it here so the process waits for the abort.
  const hold = setInterval(() => {}, 1000);
  ok(await tempoAccessKeyActive({ account: root.address, accessKey: agentKeyAddress }, { ...opts, timeoutMs: 50, fetchImpl: (_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) }) === false, "B: a read that outlives its timeout fails closed");
  clearInterval(hold);
  ok(await tempoAccessKeyActive({ account: "nope", accessKey: agentKeyAddress }, opts) === false, "B: a malformed address is refused without a read");

  // The cached verifier: dedupe, cache both ways, bounded concurrency.
  let reads = 0, release;
  const gate = new Promise((r) => { release = r; });
  const slow = createKeychainSenderVerifier({ check: async ({ account }) => { reads++; await gate; return account === lc(root.address); }, maxInFlight: 2 });
  const a = slow({ account: root.address, accessKey: agentKeyAddress });
  const b = slow({ account: root.address, accessKey: agentKeyAddress });
  const c = slow({ account: victim, accessKey: attacker });
  const overflow = await slow({ account: attacker, accessKey: victim });
  ok(overflow === null && reads === 2, `B: concurrent reads for one key are deduplicated, and past maxInFlight the answer is null without a read (reads ${reads})`);
  release();
  ok((await a) === lc(root.address) && (await b) === lc(root.address) && (await c) === null, "B: an active key resolves to the account; an inactive one to null");
  await sleep(0);
  ok((await slow({ account: root.address, accessKey: agentKeyAddress })) === lc(root.address) && (await slow({ account: victim, accessKey: attacker })) === null && reads === 2, "B: both verdicts are cached (no further reads)");
  const expiring = createKeychainSenderVerifier({ check: async () => { reads++; return true; }, ttlMs: 1 });
  await expiring({ account: root.address, accessKey: agentKeyAddress });
  await sleep(5);
  const before = reads;
  await expiring({ account: root.address, accessKey: agentKeyAddress });
  ok(reads === before + 1, "B: an expired cache entry is read again");
  const throwing = createKeychainSenderVerifier({ check: async () => { throw new Error("rpc down"); } });
  ok((await throwing({ account: root.address, accessKey: agentKeyAddress })) === null, "B: a check that throws resolves to null (unverified), never rejects");
  ok((await throwing({ account: root.address, accessKey: agentKeyAddress, inlineAuthorization: true })) === null, "B: ...even for a credential carrying an inline authorization (an unreadable chain is not an absent key)");

  // Inline authorization: accepted only while the chain holds no record of the key.
  for (const state of ["absent", "revoked", "expired", "mismatch", "unreadable", "active"]) {
    const v = createKeychainSenderVerifier({ check: async () => state });
    const withInline = await v({ account: root.address, accessKey: agentKeyAddress, inlineAuthorization: true });
    const without = await createKeychainSenderVerifier({ check: async () => state })({ account: root.address, accessKey: agentKeyAddress, inlineAuthorization: false });
    const want = state === "active" || state === "absent" ? lc(root.address) : null;
    ok(withInline === want && without === (state === "active" ? lc(root.address) : null),
      `B: chain state ${state}: with an inline authorization -> ${withInline}, without -> ${without}`);
  }
  // A remembered "absent" is reused for a credential carrying the authorization,
  // and read again for one without it (the key may have landed since).
  let absentReads = 0;
  let chainState = "absent";
  const landing = createKeychainSenderVerifier({ check: async () => { absentReads++; return chainState; } });
  const kcNew = { account: root.address, accessKey: agentKeyAddress };
  ok((await landing({ ...kcNew, inlineAuthorization: true })) === lc(root.address) && absentReads === 1, "B: first use with an inline authorization while the key is absent: accepted");
  await sleep(0);
  ok((await landing({ ...kcNew, inlineAuthorization: true })) === lc(root.address) && absentReads === 1, "B: ...a second inline-authorized use reuses the remembered absent state");
  chainState = "active";
  ok((await landing({ ...kcNew, inlineAuthorization: false })) === lc(root.address) && absentReads === 2, "B: the next use WITHOUT the authorization (the key has landed) reads the chain again rather than reuse the remembered absent state");
}

// ---------------------------------------------------------------------------
// C. The gate, in-process, with injected validate/broadcast/keychain check.
// ---------------------------------------------------------------------------
const paywallStub = (req, res, next) => (req.tempoSettling ? next() : res.status(402).json({ error: "Payment Required" }));
const priceFor = (_m, path) => (path === "/spend" ? { priceUsd: 0.05, verifiedSenderRequired: true } : path === "/plain" ? { priceUsd: 0.05 } : null);
async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
{
  ok(checkTempoCredentialBinding(credential(TX_PLAIN), { secretKey: SECRET, realm: REALM, priceFor, method: "GET", path: "/spend" }).verifiedSenderRequired === true
    && checkTempoCredentialBinding(credential(TX_PLAIN), { secretKey: SECRET, realm: REALM, priceFor, method: "GET", path: "/plain" }).verifiedSenderRequired === false,
    "C: the binding reports whether the route requires a verified sender");
  const seen = { validate: 0, keychain: [] };
  let keychainAnswer = async () => null;
  let validateDelayMs = 0;
  let broadcastDelayMs = 0;
  const ledger = [];
  const app = express();
  // What the sales ledger / refund rows would book this request under (read
  // at finish, where server.js reads it).
  app.use((req, res, next) => { res.on("finish", () => ledger.push(Object.hasOwn(req, "mppTempoLedgerPayer") ? req.mppTempoLedgerPayer : "unset")); next(); });
  app.use(createTempoGate({
    secretKey: SECRET, realm: REALM, priceFor,
    validate: async () => { seen.validate++; if (validateDelayMs) await sleep(validateDelayMs); return { ok: true, validation: {} }; },
    broadcast: async () => { if (broadcastDelayMs) await sleep(broadcastDelayMs); return { ok: true, receipt: { method: "tempo", status: "success", reference: "0x0t", timestamp: new Date().toISOString() } }; },
    verifyKeychainSender: async (kc) => { seen.keychain.push(kc); return keychainAnswer(kc); },
    pushSender: async () => null, // offline: never the real Tempo RPC
  }));
  app.use(paywallStub);
  const handler = (req, res) => res.json({ sender: req.mppTempoSender ?? null, key: gatewaySettleBreakerKey({ ...req, headers: {}, header: () => undefined, ip: "198.51.100.7", mppTempoSender: req.mppTempoSender }) });
  app.get("/spend", handler);
  app.get("/plain", handler);
  const { server, url } = await listen(app);
  const get = async (path, raw, o) => { const r = await fetch(`${url}${path}`, { headers: { Authorization: credential(raw, o) } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  // Route that spends before settlement.
  let v0 = seen.validate;
  let r = await get("/spend", TX_PLAIN);
  ok(r.status === 200 && r.body.sender === lc(plain.address) && seen.validate === v0 + 1, `C: a plain-key credential reaches a spending route, keyed on its proven sender (${JSON.stringify(r.body)})`);
  ok(ledger.at(-1) === lc(plain.address), `C: ...and the ledger books it under that proven sender (${ledger.at(-1)})`);
  for (const [name, raw] of [["a keychain envelope naming someone else's account", TX_FORGED_KEYCHAIN], ["a multisig envelope", TX_MULTISIG], ["a fee-payer-slot sender", TX_FEE_SLOT_VICTIM], ["a p256 envelope with someone else's key", TX_P256_FORGED]]) {
    v0 = seen.validate;
    r = await get("/spend", raw);
    ok(r.status === 402 && seen.validate === v0 && r.body.type === `https://paymentauth.org/problems/${TEMPO_SENDER_UNVERIFIED.kind}` && r.body.details?.reason === "sender-unverified" && r.body.details?.charged === false,
      `C: ${name} is refused on a spending route BEFORE validate (status ${r.status}, validate +${seen.validate - v0}, ${r.body.details?.reason})`);
  }
  ok(seen.keychain.some((kc) => kc.account === victim && kc.accessKey === attacker), "C: the forged keychain envelope was checked on chain for (named account, its own key) - which is what the chain answers no to");
  // A keychain credential whose access key the chain reports active.
  keychainAnswer = async (kc) => (kc.account === lc(root.address) && kc.accessKey === agentKeyAddress ? kc.account : null);
  v0 = seen.validate;
  r = await get("/spend", TX_AGENT);
  ok(r.status === 200 && r.body.sender === lc(root.address) && r.body.key === `tempo:${lc(root.address)}` && seen.validate === v0 + 1, `C: an access-key credential the chain vouches for reaches a spending route, keyed on the account (${JSON.stringify(r.body)})`);
  // A forged p256 access-key signature is refused even though the chain would
  // vouch for the key it names: the signature is checked before the chain is asked.
  keychainAnswer = async (kc) => (kc.account === lc(root.address) ? kc.account : null);
  v0 = seen.validate;
  r = await get("/spend", TX_KEYCHAIN_FORGED_P256);
  ok(r.status === 402 && seen.validate === v0 && r.body.details?.reason === "sender-unverified", "C: a keychain envelope carrying a registered access key's public key without its signature is refused, even where the chain vouches for that key");
  // The same keychain credential, with the chain read failing: refused.
  keychainAnswer = async () => null;
  v0 = seen.validate;
  r = await get("/spend", TX_AGENT);
  ok(r.status === 402 && seen.validate === v0 && r.body.details?.reason === "sender-unverified", "C: ...and is refused when the chain read does not vouch (fail closed)");
  // First use of an access key, through the real verifier over a chain that
  // holds no record of the key.
  keychainAnswer = createKeychainSenderVerifier({ check: async () => "absent" });
  v0 = seen.validate;
  r = await get("/spend", TX_FIRST_USE);
  ok(r.status === 200 && r.body.sender === lc(root.address) && r.body.key === `tempo:${lc(root.address)}` && seen.validate === v0 + 1, `C: an access key on its first use (inline authorization, key absent on chain) reaches a spending route, keyed on the account (${JSON.stringify(r.body)})`);
  v0 = seen.validate;
  r = await get("/spend", TX_FIRST_USE_FORGED);
  ok(r.status === 402 && seen.validate === v0 && r.body.details?.reason === "sender-unverified", "C: a first-use credential whose authorization is not the named account's own is refused before validate");
  v0 = seen.validate;
  r = await get("/spend", TX_AGENT);
  ok(r.status === 402 && seen.validate === v0 && r.body.details?.reason === "sender-unverified", "C: an access key with no inline authorization and no record on chain is refused before validate");
  keychainAnswer = createKeychainSenderVerifier({ check: async () => "revoked" });
  v0 = seen.validate;
  r = await get("/spend", TX_FIRST_USE);
  ok(r.status === 402 && seen.validate === v0 && r.body.details?.reason === "sender-unverified", "C: a first-use credential for a key the chain reports revoked is refused before validate");
  // A push credential's transfer is on chain before the handler: not refused.
  v0 = seen.validate;
  r = await get("/spend", null, { push: true });
  ok(r.status === 200 && r.body.sender === null && seen.validate === v0 + 1, "C: a push credential is not subject to the sender check (its transfer settles before the handler)");

  // Ordinary route: served; bounds key on the IP unless the sender is proven.
  keychainAnswer = async () => null;
  for (const [name, raw] of [["a forged keychain envelope", TX_FORGED_KEYCHAIN], ["a multisig envelope", TX_MULTISIG], ["a fee-payer-slot sender", TX_FEE_SLOT_VICTIM]]) {
    r = await get("/plain", raw);
    ok(r.status === 200 && r.body.sender === null && r.body.key === "ip:198.51.100.7", `C: ${name} on an ordinary route is served, keyed on the client IP (${JSON.stringify(r.body)})`);
  }
  keychainAnswer = async (kc) => (kc.account === lc(root.address) ? kc.account : null);
  validateDelayMs = 40; // a relay validation takes a network round trip; the read is local here
  r = await get("/plain", TX_AGENT);
  ok(r.status === 200 && r.body.sender === lc(root.address), "C: an access-key credential the chain vouches for (answered before validation) keys on the account on an ordinary route");
  keychainAnswer = () => new Promise((resolve) => setTimeout(() => resolve(lc(root.address)), 300));
  const t = Date.now();
  r = await get("/plain", TX_AGENT);
  ok(r.status === 200 && r.body.sender === null && Date.now() - t < 280, `C: a chain read slower than validation is not waited for on an ordinary route: served at once, keyed on the IP (${Date.now() - t} ms)`);
  ok(ledger.at(-1) === null, `C: ...and a read still pending at settlement is not waited for by the ledger either: the row names nobody (${ledger.at(-1)})`);
  // The read answers after validation but before the broadcast returns: the
  // bounds already keyed on the IP, the ledger books the proven account.
  keychainAnswer = () => new Promise((resolve) => setTimeout(() => resolve(lc(root.address)), 120));
  broadcastDelayMs = 300;
  r = await get("/plain", TX_AGENT);
  broadcastDelayMs = 0;
  ok(r.status === 200 && r.body.sender === null && ledger.at(-1) === lc(root.address), `C: a keychain read that answers before settlement attributes the sale to the proven account (bounds: ${r.body.key}, ledger: ${ledger.at(-1)})`);
  server.close();
}

// ---------------------------------------------------------------------------
// E. Which routes require a verified sender: every handler that spends from
//    one of our wallets before settlement carries spendsOwnWallet, read by the
//    one predicate the gate's priceFor uses.
// ---------------------------------------------------------------------------
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const { spendsBeforeSettlement } = await import("../src/composite-spend-guard.js");
  const { buildRouteExecuteTool, EXEC_TIERS } = await import("../src/tools/route-execute.js");
  const { buildSellerPayabilityTool } = await import("../src/tools/seller-payability-kit.js");
  const { ATTEST_TOOLS } = await import("../src/tools/attest-kit.js");
  const defs = [
    ...EXEC_TIERS.map((tier) => buildRouteExecuteTool({ getCatalog: () => ({}), tier })),
    buildSellerPayabilityTool({ pay: async () => ({}), fetchImpl: async () => new Response(""), assertPublicUrl: async () => {} }),
    ...ATTEST_TOOLS.filter((t) => t.slug === "attest"),
  ];
  ok(defs.length === EXEC_TIERS.length + 2 && defs.every((d) => d.spendsOwnWallet === true && spendsBeforeSettlement(d)), `E: every route-execute tier, seller-payability and attest carry spendsOwnWallet and read as spending before settlement (${defs.map((d) => d.slug).join(", ")})`);
  ok(spendsBeforeSettlement({ slug: "research" }) && !spendsBeforeSettlement({ slug: "hash" }) && !spendsBeforeSettlement(null), "E: the long-running set counts too; an ordinary tool does not");
  // A module that books spend against the external-spend guard spends from
  // our wallets: it must mark its tool. A new one fails here until it does.
  const dirs = ["src", "src/tools"];
  const spenders = dirs.flatMap((d) => readdirSync(new URL(`../${d}/`, import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => `${d}/${f}`))
    .filter((f) => /import\s*\{[^}]*\bmaySpend\b[^}]*\}\s*from\s*["'][./]*external-spend-guard\.js["']/.test(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")));
  const unmarked = spenders.filter((f) => !/spendsOwnWallet: true/.test(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")));
  ok(spenders.length >= 3 && unmarked.length === 0, `E: every module importing maySpend marks its tool spendsOwnWallet (${spenders.join(", ")}${unmarked.length ? `; unmarked: ${unmarked.join(", ")}` : ""})`);
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/const tempoGate = createTempoGate\(\{[\s\S]{0,2500}verifiedSenderRequired: spendsBeforeSettlement\(def\)/.test(server), "E: the Tempo gate's priceFor passes verifiedSenderRequired from spendsBeforeSettlement");
}

// ---------------------------------------------------------------------------
// D. The real server.
// ---------------------------------------------------------------------------
{
  const [PORT, FAC_PORT] = await getFreePorts(2);
  const B = `http://127.0.0.1:${PORT}`;
  const REAL_SECRET = "tempo-sender-server-secret";
  const facilitator = createServer((req, res) => {
    if (req.url === "/supported") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} })); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
  const relayHits = [];
  const relay = createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => { relayHits.push(req.url); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: { code: "invalid_payment", message: "stub relay" } })); });
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const rpcCalls = [];
  const p256AgentKeyAddress = lc(p256Agent.accessKeyAddress);
  const revokedAgent = freshAgent();
  const expiredRecordAgent = freshAgent();
  const TX_FIRST_USE_REVOKED = await firstUse(revokedAgent, await root.signKeyAuthorization(revokedAgent, { chainId: 4217, expiry: EXPIRY_S }));
  const TX_FIRST_USE_EXPIRED_RECORD = await firstUse(expiredRecordAgent, await root.signKeyAuthorization(expiredRecordAgent, { chainId: 4217, expiry: EXPIRY_S }));
  const rpcKeys = new Map([
    [`${lc(root.address)}:${agentKeyAddress}`, activeRec(agentKeyAddress)], [`${lc(root.address)}:${p256AgentKeyAddress}`, activeRec(p256AgentKeyAddress, { signatureType: 1 })],
    [`${lc(root.address)}:${lc(revokedAgent.accessKeyAddress)}`, activeRec(lc(revokedAgent.accessKeyAddress), { isRevoked: true })],
    [`${lc(root.address)}:${lc(expiredRecordAgent.accessKeyAddress)}`, activeRec(lc(expiredRecordAgent.accessKeyAddress), { expiry: BigInt(NOW_S - 10) })],
  ]);
  const rpcHandle = keychainRpc(rpcKeys, rpcCalls);
  const rpc = createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => { let out; try { out = rpcHandle(JSON.parse(b)); } catch { out = { jsonrpc: "2.0", id: 1, error: { message: "bad" } }; } res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out)); });
  });
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));

  const proc = spawn("node", ["src/server.js"], {
    env: {
      ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: TREASURY, NETWORK: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, MPP_SECRET_KEY: REAL_SECRET, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
      TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY, TEMPO_CURRENCY: CURRENCY,
      TEMPO_API_BASE_URL: `http://127.0.0.1:${relay.address().port}`, TEMPO_RPC_URL: `http://127.0.0.1:${rpc.address().port}`,
      X402_INDEX_CRAWL: "off", MPP_LEADERBOARD: "off", MPP_INDEX_CRAWL: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Keep the server's last lines: printed if an assertion below fails.
  const serverLog = [];
  const keep = (b) => { for (const line of String(b).split("\n")) if (line.trim()) { serverLog.push(line); if (serverLog.length > 60) serverLog.shift(); } };
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);
  process.on("exit", (code) => { if (code) console.error(`--- server log (last ${serverLog.length} lines) ---\n${serverLog.join("\n")}`); try { proc.kill("SIGKILL"); } catch { /* gone */ } });
  try {
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i++) { try { healthy = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!healthy) await sleep(500); }
    ok(healthy, "D: the server booted");
    const realm = `127.0.0.1:${PORT}`;
    const cred = (raw, amount = "10000") => credential(raw, { amount, realm, secretKey: REAL_SECRET });
    const post = async (path, raw, amount, body) => {
      const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", Authorization: cred(raw, amount) }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const exec = { slug: "hash", params: { text: "agent402" } };

    let h0 = relayHits.length;
    let r = await post("/api/route/execute", TX_FORGED_KEYCHAIN, "10000", exec);
    ok(r.status === 402 && relayHits.length === h0 && r.body.details?.reason === "sender-unverified" && r.body.details?.charged === false,
      `D: route-execute refuses a keychain credential naming someone else's account before any relay call (status ${r.status}, relay +${relayHits.length - h0}, ${r.body.details?.reason})`);
    ok(rpcCalls.includes("eth_call"), "D: ...after asking the chain about that access key (the stubbed RPC was read)");
    for (const [name, raw] of [["a multisig envelope", TX_MULTISIG], ["a fee-payer-slot sender", TX_FEE_SLOT_VICTIM], ["a registered p256 access key's public key without its signature (the RPC reports that key active)", TX_KEYCHAIN_FORGED_P256]]) {
      h0 = relayHits.length;
      r = await post("/api/route/execute", raw, "10000", exec);
      ok(r.status === 402 && relayHits.length === h0 && r.body.details?.reason === "sender-unverified", `D: route-execute refuses ${name} before any relay call (relay +${relayHits.length - h0})`);
    }
    h0 = relayHits.length;
    r = await post("/api/route/execute-max", TX_FORGED_KEYCHAIN, "550000", exec);
    ok(r.status === 402 && relayHits.length === h0 && r.body.details?.reason === "sender-unverified", `D: every route-execute tier refuses it (the max tier; relay +${relayHits.length - h0})`);
    for (const raw of [TX_FORGED_KEYCHAIN, TX_PLAIN]) {
      h0 = relayHits.length;
      r = await post("/api/seller-payability", raw, "100000", { url: "https://seller.example/api/x" });
      ok(r.status === 402 && relayHits.length === h0 && /method-unsupported|verification-failed/.test(r.body.type || ""), `D: seller-payability refuses a Tempo pull credential before any relay call (relay +${relayHits.length - h0}, ${r.body.type})`);
    }
    // Controls: a proven sender reaches the relay (which the stub refuses).
    h0 = relayHits.length;
    r = await post("/api/route/execute", TX_PLAIN, "10000", exec);
    ok(relayHits.length === h0 + 1 && r.body.details?.reason !== "sender-unverified", `D: control - a plain-key credential on route-execute reaches the relay (relay +${relayHits.length - h0})`);
    h0 = relayHits.length;
    r = await post("/api/route/execute", TX_AGENT, "10000", exec);
    ok(relayHits.length === h0 + 1 && r.body.details?.reason !== "sender-unverified", `D: control - an access-key credential the chain reports active reaches the relay (relay +${relayHits.length - h0})`);
    h0 = relayHits.length;
    r = await post("/api/route/execute", TX_P256_AGENT, "10000", exec);
    ok(relayHits.length === h0 + 1 && r.body.details?.reason !== "sender-unverified", `D: control - a genuine p256 access-key credential the chain reports active reaches the relay (relay +${relayHits.length - h0})`);
    // First use of a new access key (the stubbed RPC holds no record of it).
    for (const [name, raw, tier, amount] of [["route-execute", TX_FIRST_USE, "/api/route/execute", "10000"], ["the max tier, p256 root", TX_FIRST_USE_P256_ROOT, "/api/route/execute-max", "550000"], ["a webAuthn access key", TX_FIRST_USE_WEBAUTHN_KEY, "/api/route/execute", "10000"]]) {
      h0 = relayHits.length;
      r = await post(tier, raw, amount, exec);
      ok(relayHits.length === h0 + 1 && r.body.details?.reason !== "sender-unverified", `D: an access key on its first use, carrying the account's authorization, reaches the relay on ${name} (relay +${relayHits.length - h0})`);
    }
    for (const [name, raw] of [["an authorization signed by someone else's root", TX_FIRST_USE_FORGED], ["a key the chain reports revoked", TX_FIRST_USE_REVOKED], ["a key the chain reports expired", TX_FIRST_USE_EXPIRED_RECORD], ["an authorization for another chain", TX_FIRST_USE_OTHER_CHAIN]]) {
      h0 = relayHits.length;
      r = await post("/api/route/execute", raw, "10000", exec);
      ok(r.status === 402 && relayHits.length === h0 && r.body.details?.reason === "sender-unverified", `D: a first-use credential with ${name} is refused before any relay call (relay +${relayHits.length - h0})`);
    }
    // Once a transaction carrying the authorization lands, the key is on chain
    // and the buyer's next credential carries no authorization: served, even
    // though the server remembered the key as absent a moment ago.
    rpcKeys.set(`${lc(root.address)}:${lc(newAgent.accessKeyAddress)}`, activeRec(lc(newAgent.accessKeyAddress)));
    h0 = relayHits.length;
    r = await post("/api/route/execute", await signWith(newAgent), "10000", exec);
    ok(relayHits.length === h0 + 1 && r.body.details?.reason !== "sender-unverified", `D: after the key lands, the same key without the authorization reaches the relay at once (relay +${relayHits.length - h0})`);
    h0 = relayHits.length;
    const plainRoute = await fetch(`${B}/api/uuid`, { headers: { Authorization: cred(TX_FORGED_KEYCHAIN, "1000") } });
    ok(plainRoute.status === 402 && relayHits.length === h0 + 1, `D: an ordinary route is not refused for the sender: the same forged keychain credential reaches the relay there (relay +${relayHits.length - h0})`);
  } finally {
    proc.kill("SIGKILL");
    facilitator.close(); relay.close(); rpc.close();
  }
}

for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
