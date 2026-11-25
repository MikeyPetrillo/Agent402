// The x402 payer screen (src/x402-payer-screen.js), driven through the REAL
// paid server: a stub facilitator verifies every payment and counts each
// verify and settle per payer, so the counts prove where the screen sits
// (after verify, before settle) and that a refusal settles nothing.
//
//   - a payer on the screen's EVM set (EIP-3009, or a Permit2 signer, or a
//     Permit2 payment carrying a different unsigned authorization block) is
//     refused 403 after verification, and nothing settles;
//   - a clean payer on the same route is served and settles once, before and
//     after the refusals (the live control);
//   - the refused write never ran: in a second boot with no list loaded the
//     listed payer's namespace is empty, while the clean payer's write from
//     the first boot reads back; and that boot serves the listed payer (fail
//     open, status "missing");
//   - an async job and an Idempotency-Key retry stay refused for a listed
//     payer, while the same calls for a clean payer complete;
//   - /api/gateway-status reports the screen's word under x402 alone (no
//     Tempo direct mode), and the server log masks the address.
// Non-EVM payloads (Solana, Stellar, Algorand) name no EVM address: covered
// by the pure extractor checks at the top (this harness offers Base only).
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";
import { ownStoreEnv } from "./lib/own-stores.js";
import { x402ScreenedAddressesOf } from "../src/x402-payer-screen.js";
import { payerFromRequest } from "../src/payer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const LISTED = "0x" + "5a".repeat(20);       // on the stored set below
const LISTED_MIXED = "0x" + "5A".repeat(20); // the same address, other case
const CLEAN = "0x" + "c1".repeat(20);
const CLEAN_2 = "0x" + "c2".repeat(20);
const OTHER_LISTED = "0x" + "77".repeat(20);

// ---------------------------------------------------------------------------
// 1. The extractor: which addresses a request's payment names.
{
  const req = (headers) => ({ header: (k) => headers[String(k).toLowerCase()] ?? null });
  const eip3009 = (from) => b64({ x402Version: 2, payload: { signature: "0x", authorization: { from, nonce: "0x01" } } });
  const permit2 = (from, authFrom) => b64({ x402Version: 2, payload: { signature: "0x", permit2Authorization: { from, nonce: "1" }, ...(authFrom ? { authorization: { from: authFrom } } : {}) } });
  ok(x402ScreenedAddressesOf(req({ "payment-signature": eip3009(LISTED_MIXED) })).join() === LISTED, "EIP-3009: authorization.from, lowercased");
  ok(x402ScreenedAddressesOf(req({ "x-payment": eip3009(CLEAN) })).join() === CLEAN, "the x-payment spelling is read too");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": eip3009(LISTED), "x-payment": eip3009(CLEAN) })).join() === LISTED, "payment-signature wins over x-payment, as in the middleware");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": permit2(LISTED) })).join() === LISTED, "Permit2: permit2Authorization.from");
  const both = x402ScreenedAddressesOf(req({ "payment-signature": permit2(LISTED, CLEAN) }));
  ok(both.join() === LISTED, "Permit2 beside an authorization block: the Permit2 signer is screened (the block is unsigned there and is dropped at decode)");
  ok(payerFromRequest(req({ "payment-signature": permit2(LISTED, CLEAN) })) === LISTED, "...and attribution names the Permit2 signer, never the address typed beside it");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": b64({ x402Version: 2, accepted: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, payload: { transaction: "AQAB" } }) })).length === 0, "a Solana payload names no EVM address");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": b64({ x402Version: 2, accepted: { network: "stellar:pubnet" }, payload: { transaction: "AAAA" } }) })).length === 0, "a Stellar payload names no EVM address");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": b64({ x402Version: 2, accepted: { network: "algorand:mainnet" }, payload: { paymentGroup: ["gqNzaWc="], paymentIndex: 0 } }) })).length === 0, "an Algorand payload names no EVM address");
  // The paywall drops a UTF-8 byte order mark from the decoded bytes and
  // settles the payment, so the screen has to read the payer through one too.
  const withBom = (o) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(o))]).toString("base64");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": withBom({ x402Version: 2, payload: { authorization: { from: LISTED } } }) })).join() === LISTED, "a payer behind a byte order mark is screened");
  ok(x402ScreenedAddressesOf(req({ "x-payment": eip3009(LISTED).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") })).join() === LISTED, "a base64url header is screened");
  const channel = (payer, payerAuthorizer = "0x" + "00".repeat(20), funder = null) => b64({ x402Version: 2, accepted: { scheme: "batch-settlement", network: "eip155:8453" }, payload: { type: funder ? "deposit" : "voucher", channelConfig: { payer, payerAuthorizer }, voucher: { channelId: "0x" + "cd".repeat(32) }, ...(funder ? { deposit: { amount: "1", authorization: { permit2Authorization: { from: funder } } } } : {}) } });
  ok(x402ScreenedAddressesOf(req({ "payment-signature": channel(LISTED_MIXED) })).join() === LISTED, "a payment channel: channelConfig.payer, lowercased; the zero authorizer is not a party");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": channel(CLEAN, LISTED, LISTED_MIXED) })).sort().join() === [CLEAN, LISTED].sort().join(), "a payment channel: the voucher signer and a Permit2 deposit's funder are read too, de-duplicated");
  ok(x402ScreenedAddressesOf(req({})).length === 0 && x402ScreenedAddressesOf(req({ "payment-signature": "not-json!" })).length === 0, "no header, or an unreadable one: nothing to screen");
  ok(x402ScreenedAddressesOf(req({ "payment-signature": b64({ payload: { authorization: { from: "0xNOTHEX" } }, from: LISTED }) })).length === 0, "a malformed from, or an address outside the payload, is not read");
}

// ---------------------------------------------------------------------------
// 1b. A non-EVM payment: the transaction's signer, read from the payload the
//     facilitator verifies, against the payout map (every address OFAC lists).
{
  const kit = await import("@solana/kit");
  const { createX402PayerScreen, __resetX402PayerScreenForTests, x402PayerScreenView } = await import("../src/x402-payer-screen.js");
  const K = await import("../src/tools/sanctions-kit.js");
  const feePayer = await kit.generateKeyPairSigner(), buyer = await kit.generateKeyPairSigner();
  const blockhash = { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n };
  const ix = { programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [{ address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer }], data: new TextEncoder().encode("screen") };
  const msg = kit.pipe(kit.createTransactionMessage({ version: 0 }), (m) => kit.setTransactionMessageFeePayer(feePayer.address, m), (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => kit.appendTransactionMessageInstruction(ix, m));
  const tx = kit.getBase64EncodedWireTransaction(await kit.partiallySignTransactionMessageWithSigners(msg));
  const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const svmHeader = b64({ x402Version: 2, accepted: { scheme: "exact", network: SOLANA, extra: { feePayer: feePayer.address } }, payload: { transaction: tx } });
  const mw = createX402PayerScreen({ log: () => {} });
  const run = (headers) => new Promise((resolve) => {
    const out = { next: false, code: null, body: null };
    const req = { method: "POST", path: "/api/hash", header: (k) => headers[String(k).toLowerCase()] ?? null, headers };
    const res = { setHeader() {}, status(c) { out.code = c; return res; }, json(b) { out.body = b; resolve(out); return res; } };
    mw(req, res, () => { out.next = true; resolve(out); });
  });
  K.__seedPayoutListForTests([{ address: buyer.address, asset: "SOL", entity: "TEST FIXTURE", sdnId: "7" }]);
  __resetX402PayerScreenForTests();
  const listed = await run({ "payment-signature": svmHeader });
  ok(!listed.next && listed.code === 403 && listed.body?.reason === "payer-not-accepted" && listed.body?.charged === false, `a listed Solana signer is refused 403 before the handler (${listed.code}, next ${listed.next})`);
  ok(!JSON.stringify(listed.body).includes(buyer.address), "the refusal never echoes the address");
  ok(x402PayerScreenView().refused === 1 && x402PayerScreenView().screened === 1, "counted as screened and refused");
  K.__seedPayoutListForTests([{ address: feePayer.address, asset: "SOL", entity: "TEST FIXTURE", sdnId: "8" }]);
  const clean = await run({ "payment-signature": svmHeader });
  ok(clean.next && clean.code === null, "CONTROL: a signer not on the list passes (the fee payer's listing is not the buyer's)");
  K.__resetPayoutListForTests();
  const noList = await run({ "payment-signature": svmHeader });
  ok(noList.next && x402PayerScreenView().servedUnscreened === 1, "no payout list loaded: served unscreened and counted, as the EVM path does");
  const none = await run({});
  ok(none.next && x402PayerScreenView().screened === 2, "no payment header: passes without a screen");
  // AN SPL MULTISIG IN A LOOKUP TABLE. The listed wallet X is the multisig's
  // signing member; the transfer's authority M is a lookup-table entry, so no
  // single payer reads from it. Every required signer except the fee payer is
  // screened, so X is refused; an unlisted X passes (never limit a buyer).
  {
    const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
    const X = await kit.generateKeyPairSigner();
    const M = (await kit.generateKeyPairSigner()).address, src = (await kit.generateKeyPairSigner()).address, payTo = (await kit.generateKeyPairSigner()).address, table = (await kit.generateKeyPairSigner()).address;
    const transferIx = { programAddress: kit.address(TOKEN), accounts: [
      { address: kit.address(src), role: kit.AccountRole.WRITABLE },
      { address: kit.address(USDC), role: kit.AccountRole.READONLY },
      { address: kit.address(payTo), role: kit.AccountRole.WRITABLE },
      { address: kit.address(M), role: kit.AccountRole.READONLY },
      { address: X.address, role: kit.AccountRole.READONLY_SIGNER, signer: X },
    ], data: new Uint8Array([12, ...u64(1000), 6]) };
    const build = async (version, ixs, lut) => {
      let m = kit.pipe(kit.createTransactionMessage({ version }), (q) => kit.setTransactionMessageFeePayer(feePayer.address, q), (q) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, q), (q) => kit.appendTransactionMessageInstructions(ixs, q));
      if (lut) m = kit.compressTransactionMessageUsingAddressLookupTables(m, { [table]: [kit.address(M), kit.address(payTo)] });
      return kit.getBase64EncodedWireTransaction(await kit.partiallySignTransaction([X.keyPair], kit.compileTransaction(m)));
    };
    const hdr = (tx) => b64({ x402Version: 2, accepted: { scheme: "exact", network: SOLANA, extra: { feePayer: feePayer.address } }, payload: { transaction: tx } });
    const lutTx = await build(0, [transferIx], true);
    ok(Buffer.from(lutTx, "base64").includes(Buffer.from(kit.getAddressEncoder().encode(kit.address(M)))) === false, "control: the multisig authority is not a static key (it sits in the lookup table)");
    // A v0 message with more instructions than the reader walks: only the
    // signer list the installed kit decodes (what @x402/svm verified) names X.
    const memo = (i) => ({ programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [{ address: X.address, role: kit.AccountRole.READONLY_SIGNER, signer: X }], data: new TextEncoder().encode(String(i)) });
    const wideTx = await build(0, [transferIx, ...Array.from({ length: 17 }, (_, i) => memo(i))], true);
    const v1Tx = await build(1, [transferIx], false);
    const unrelated = (await kit.generateKeyPairSigner()).address;
    for (const [label, tx] of [["v0, multisig authority in a lookup table", lutTx], ["v0, more instructions than the reader walks", wideTx], ["v1 (message-first envelope)", v1Tx]]) {
      K.__seedPayoutListForTests([{ address: X.address, asset: "SOL", entity: "TEST FIXTURE", sdnId: "9" }]);
      __resetX402PayerScreenForTests();
      const r = await run({ "payment-signature": hdr(tx) });
      ok(!r.next && r.code === 403 && r.body?.charged === false, `${label}: a listed signing member is refused 403 before the handler (${r.code}, next ${r.next})`);
      K.__seedPayoutListForTests([{ address: unrelated, asset: "SOL", entity: "TEST FIXTURE", sdnId: "10" }]);
      const c = await run({ "payment-signature": hdr(tx) });
      ok(c.next && c.code === null && x402PayerScreenView().screened === 2, `CONTROL ${label}: the same payment from an unlisted wallet is served and counted as screened`);
    }
    // An unreadable Solana transaction keeps the screen's behavior: it passes.
    K.__seedPayoutListForTests([{ address: X.address, asset: "SOL", entity: "TEST FIXTURE", sdnId: "9" }]);
    const junk = await run({ "payment-signature": hdr("bm90IGEgdHg=") });
    ok(junk.next && junk.code === null, "an unreadable Solana transaction passes (nothing names a signer), as before");
    K.__resetPayoutListForTests();
    __resetX402PayerScreenForTests();
  }
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/const x402PayerScreen = createX402PayerScreen\(\);/.test(server), "server.js mounts the screen with its real signer reader");
  ok(/function flushStateQueues[\s\S]{0,200}const flushes = \[[^\]]*\bflushSanctionsEvents\b/.test(server) && /\bstartSanctionsJournalReplay\(\)/.test(server), "server.js writes pending sanctions changes on a graceful shutdown and replays the journal at boot");
  __resetX402PayerScreenForTests();
}

// ---------------------------------------------------------------------------
// 1c. The strict screen the /ref copies use (src/server.js): a payer on
//     WALLET_BLOCKLIST is refused before the handler, and with no list loaded
//     a payment is refused (fail closed, counted) instead of served. The
//     default screen (the direct routes) still serves with no list.
{
  const SS = await import("../src/sanctions-screen.js");
  const { createX402PayerScreen, __resetX402PayerScreenForTests, x402PayerScreenView, X402_PAYER_UNSCREENED_TEXT } = await import("../src/x402-payer-screen.js");
  const { blockedPayerFromPayload } = await import("../src/payments.js");
  const dir = mkdtempSync(join(tmpdir(), "x402-screen-strict-"));
  const run = (mw, headers) => new Promise((resolve) => {
    const out = { next: false, code: null, body: null, headers: {} };
    const req = { method: "POST", path: "/ref/hash", header: (k) => headers[String(k).toLowerCase()] ?? null, headers };
    const res = { setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; }, status(c) { out.code = c; return res; }, json(b) { out.body = b; resolve(out); return res; } };
    mw(req, res, () => { out.next = true; resolve(out); });
  });
  const pay = (from) => ({ "payment-signature": b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: { signature: "0x", authorization: { from, nonce: "0x01" } } }) });
  const BLOCKED = "0x" + "b0".repeat(20);
  const strict = createX402PayerScreen({ log: () => {}, noList: "refuse", blockedPayerOf: blockedPayerFromPayload });
  const lenient = createX402PayerScreen({ log: () => {} });
  try {
    process.env.WALLET_BLOCKLIST = `${CLEAN_2},${BLOCKED.toUpperCase().replace("0X", "0x")}`;
    // No list loaded.
    SS.__resetSanctionsScreenForTests();
    __resetX402PayerScreenForTests();
    const shut = await run(strict, pay(CLEAN));
    ok(!shut.next && shut.code === 503 && shut.body?.reason === "payer-screen-unavailable" && shut.body?.charged === false && shut.body?.error === X402_PAYER_UNSCREENED_TEXT && Number(shut.headers["retry-after"]) > 0, `strict, no list loaded: refused 503 with Retry-After, nothing charged (${shut.code} ${shut.body?.reason})`);
    ok(x402PayerScreenView().refusedUnscreened === 1 && x402PayerScreenView().servedUnscreened === 0, `...and counted as refused unscreened, never as served (${JSON.stringify(x402PayerScreenView())})`);
    const open = await run(lenient, pay(CLEAN));
    ok(open.next && x402PayerScreenView().servedUnscreened === 1, "CONTROL: the default screen (the direct routes) still serves with no list, and counts it");
    const blockedNoList = await run(strict, pay(BLOCKED));
    ok(!blockedNoList.next && blockedNoList.code === 403 && blockedNoList.body?.reason === "wallet_blocked" && blockedNoList.body?.charged === false, `strict: a blocklisted payer is refused 403 even with no list loaded (${blockedNoList.code} ${blockedNoList.body?.reason})`);
    // A list loaded.
    process.env.SANCTIONS_SCREEN_FILE = join(dir, "screen.json");
    writeFileSync(process.env.SANCTIONS_SCREEN_FILE, JSON.stringify({ v: 1, loadedAt: Date.now(), publishDate: "01/01/2026", perAsset: { ETH: 1 }, addresses: [LISTED] }));
    SS.__resetSanctionsScreenForTests();
    ok(await SS.loadStoredSanctionsScreen(), "setup: the list loads");
    const served = await run(strict, pay(CLEAN));
    const blocked = await run(strict, pay(BLOCKED));
    const blocked2 = await run(strict, pay(CLEAN_2));
    const listed = await run(strict, pay(LISTED));
    ok(served.next, "CONTROL: strict, a clean payer with the list loaded passes");
    ok(!blocked.next && blocked.code === 403 && blocked.body?.reason === "wallet_blocked" && !blocked2.next && blocked2.body?.reason === "wallet_blocked", `strict: a payer on WALLET_BLOCKLIST (any case) is refused 403 before the handler (${blocked.code}, ${blocked2.code})`);
    ok(!JSON.stringify(blocked.body).includes(BLOCKED.slice(2, 12)) && !/https?:\/\//.test(JSON.stringify(blocked.body)), "the blocklist refusal echoes no address and points nowhere");
    ok(!listed.next && listed.code === 403 && listed.body?.reason === "payer-not-accepted", "strict: a listed payer is still refused by the sanctions screen");
    const lenientBlocked = await run(lenient, pay(BLOCKED));
    ok(lenientBlocked.next, "CONTROL: the default screen leaves the blocklist to the direct routes' own settle check");
  } finally {
    delete process.env.WALLET_BLOCKLIST;
    delete process.env.SANCTIONS_SCREEN_FILE;
    SS.__resetSanctionsScreenForTests();
    __resetX402PayerScreenForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1d. What a refusal RECORDS (src/sanctions-events.js). The screen refuses on
//     every address a payment names, but keeps a permanent record only of a
//     listed address the payment's own signature proves
//     (src/x402-signed-payers.js): one row per (address, route class) a day,
//     every repeat an attempt on it, with no cap; a refusal on an unproven
//     address is counted in the hour's aggregate row, never with the address.
{
  const SS = await import("../src/sanctions-screen.js");
  const EV = await import("../src/sanctions-events.js");
  const { createX402PayerScreen, __resetX402PayerScreenForTests, x402PayerScreenView } = await import("../src/x402-payer-screen.js");
  const { x402SignedPayers } = await import("../src/x402-signed-payers.js");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const { PERMIT2_ADDRESS, permit2WitnessTypes, x402ExactPermit2ProxyAddress } = await import("@x402/evm");
  const dir = mkdtempSync(join(tmpdir(), "x402-screen-records-"));
  const outerEvents = process.env.SANCTIONS_EVENTS_FILE;
  process.env.SANCTIONS_EVENTS_FILE = join(dir, "events.jsonl");
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const PAY_TO = "0x000000000000000000000000000000000000dEaD";
  const accepted = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const AUTH = [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }];
  const nonce = () => `0x${Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
  // An EIP-3009 payment signed by `account` (Transfer, or Receive as /ref takes it), with `extra` merged into the payload.
  const signed3009 = async (account, { primaryType = "TransferWithAuthorization", extra = {}, from = account.address } = {}) => {
    const t = Math.floor(Date.now() / 1000);
    const authorization = { from, to: PAY_TO, value: "10000", validAfter: String(t - 60), validBefore: String(t + 300), nonce: nonce() };
    const signature = await account.signTypedData({ domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC }, types: { [primaryType]: AUTH }, primaryType, message: { ...authorization, value: 10000n, validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } });
    return { "payment-signature": b64({ x402Version: 2, accepted, payload: { signature, authorization, ...extra } }) };
  };
  const signedPermit2 = async (account) => {
    const t = Math.floor(Date.now() / 1000);
    const permit2Authorization = { from: account.address, permitted: { token: USDC, amount: "10000" }, spender: x402ExactPermit2ProxyAddress, nonce: String(BigInt(nonce()) >> 8n), deadline: String(t + 300), witness: { to: PAY_TO, validAfter: String(t - 60) } };
    const signature = await account.signTypedData({ domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS }, types: permit2WitnessTypes, primaryType: "PermitWitnessTransferFrom",
      message: { permitted: { token: USDC, amount: 10000n }, spender: x402ExactPermit2ProxyAddress, nonce: BigInt(permit2Authorization.nonce), deadline: BigInt(permit2Authorization.deadline), witness: { to: PAY_TO, validAfter: BigInt(permit2Authorization.witness.validAfter) } } });
    return { "payment-signature": b64({ x402Version: 2, accepted, payload: { signature, permit2Authorization } }) };
  };
  const run = (mw, headers, { path = "/ref/hash", ip = "203.0.113.20" } = {}) => new Promise((resolve) => {
    const out = { next: false, code: null, body: null };
    const req = { method: "POST", path, ip, header: (k) => headers[String(k).toLowerCase()] ?? null, headers };
    const res = { setHeader() {}, status(c) { out.code = c; return res; }, json(b) { out.body = b; resolve(out); return res; } };
    mw(req, res, () => { out.next = true; resolve(out); });
  });
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const allRows = async () => (await EV.sanctionsEventsOperatorView({ recent: 1000 })).recent;
  const rows = async () => (await allRows()).filter((r) => !r.aggregate);
  const aggs = async () => (await allRows()).filter((r) => r.aggregate);
  const listedAcct = privateKeyToAccount(generatePrivateKey());
  const listedP2 = privateKeyToAccount(generatePrivateKey());
  const throwaway = privateKeyToAccount(generatePrivateKey());
  const cleanAcct = privateKeyToAccount(generatePrivateKey());
  const flood = Array.from({ length: 140 }, () => privateKeyToAccount(generatePrivateKey()));
  const LISTED_SIGNER = listedAcct.address.toLowerCase();
  const strict = createX402PayerScreen({ log: () => {}, noList: "refuse" });
  const lenient = createX402PayerScreen({ log: () => {} });
  try {
    process.env.SANCTIONS_SCREEN_FILE = join(dir, "screen.json");
    writeFileSync(process.env.SANCTIONS_SCREEN_FILE, JSON.stringify({ v: 1, loadedAt: Date.now(), publishDate: "01/01/2026", perAsset: { ETH: 1 }, addresses: [LISTED_SIGNER, listedP2.address.toLowerCase(), ...flood.map((a) => a.address.toLowerCase())] }));
    SS.__resetSanctionsScreenForTests();
    ok(await SS.loadStoredSanctionsScreen(), "setup: the list loads");
    EV.__resetSanctionsEventsForTests(); EV.__resetSanctionsEventLimitsForTests(); __resetX402PayerScreenForTests();

    // The signer reader itself.
    const t1 = await signed3009(listedAcct);
    const decode = (h) => JSON.parse(Buffer.from(h["payment-signature"], "base64").toString("utf8"));
    ok((await x402SignedPayers(decode(t1))).join() === LISTED_SIGNER, "the signer reader proves an EIP-3009 TransferWithAuthorization signer");
    ok((await x402SignedPayers(decode(await signed3009(listedAcct, { primaryType: "ReceiveWithAuthorization" })))).join() === LISTED_SIGNER, "...and a ReceiveWithAuthorization signer (the /ref shape)");
    ok((await x402SignedPayers(decode(await signedPermit2(listedP2)))).join() === listedP2.address.toLowerCase(), "...and a Permit2 signer");
    ok((await x402SignedPayers(decode(await signed3009(throwaway, { from: listedAcct.address })))).length === 0, "a signature that does not recover to the stated `from` proves nothing");

    // (a) A throwaway wallet signs; the listed address sits in fields no signature covers.
    const unsignedFields = [
      ["channelConfig.payer", { channelConfig: { payer: listedAcct.address, payerAuthorizer: "0x" + "00".repeat(20) } }],
      ["channelConfig.payerAuthorizer", { channelConfig: { payer: throwaway.address, payerAuthorizer: listedAcct.address } }],
      ["a channel deposit's funder", { deposit: { amount: "1", authorization: { permit2Authorization: { from: listedAcct.address } } } }],
    ];
    for (const [label, extra] of unsignedFields) {
      const r = await run(strict, await signed3009(throwaway, { primaryType: "ReceiveWithAuthorization", extra }));
      ok(!r.next && r.code === 403 && r.body?.reason === "payer-not-accepted", `${label} names a listed address beside a throwaway's signature: still refused 403 on the strict screen (${r.code})`);
    }
    const forged = await run(strict, await signed3009(throwaway, { from: listedAcct.address }));
    ok(!forged.next && forged.code === 403, "a listed `from` the signature does not recover to: refused 403");
    await settle();
    ok((await rows()).length === 0 && x402PayerScreenView().refusedUnrecorded === 4 && x402PayerScreenView().refused === 4, `...and none of those refusals gets a row of its own (${(await rows()).length} rows, ${x402PayerScreenView().refusedUnrecorded} unrecorded)`);
    let ag = await aggs();
    ok(ag.length === 1 && ag[0].kind === "unproven-refusal" && ag[0].count === 4 && ag[0].byReason?.["unsigned-field"] === 3 && ag[0].byReason?.["unproven-signer"] === 1 && ag[0].address === null && ag[0].routeClass === "ref" && ag[0].report === null && typeof ag[0].hourStart === "string", `...but all four are counted in the hour's unproven-refusal aggregate row (${JSON.stringify(ag[0] && { count: ag[0].count, byReason: ag[0].byReason })})`);
    ok(!JSON.stringify(ag).toLowerCase().includes(LISTED_SIGNER.slice(2)), "the aggregate row keeps no address the caller chose");
    ok(EV.sanctionsReportStatus() === "clear", "the report word stays clear (the aggregate is a record, not a report)");

    // (b) The listed wallet signs: refused and recorded once, naming the signer.
    const real = await run(strict, await signed3009(listedAcct, { primaryType: "ReceiveWithAuthorization" }));
    await settle();
    let r1 = await rows();
    ok(!real.next && real.code === 403 && r1.length === 1 && r1[0].address.toLowerCase() === LISTED_SIGNER && r1[0].kind === "screen-hit" && r1[0].route === "POST /ref/hash" && EV.sanctionsReportStatus() === "due", `a listed signer is refused and recorded once, naming the signer; the word reads due (${real.code}, ${r1.length} row)`);
    // A listed signer beside an unsigned block naming another listed address: the record names the
    // signer (on the direct routes, another route class than /ref, so it is not a repeat).
    const both = await run(lenient, await signed3009(listedAcct, { extra: { channelConfig: { payer: listedP2.address } } }), { path: "/api/hash" });
    await settle();
    r1 = await rows();
    ok(!both.next && both.code === 403 && r1.length === 2 && r1[0].address.toLowerCase() === LISTED_SIGNER && r1.every((x) => x.address.toLowerCase() !== listedP2.address.toLowerCase()), "with a listed signer and another listed address in an unsigned field, only the signer is recorded");
    const p2 = await run(lenient, await signedPermit2(listedP2), { path: "/api/hash" });
    await settle();
    ok(!p2.next && p2.code === 403 && (await rows()).some((x) => x.address.toLowerCase() === listedP2.address.toLowerCase()), "a listed Permit2 signer is refused and recorded");

    // (c) Repeats inside the window add attempts to the row, never a second row, never dropped.
    const before = (await rows()).length;
    for (let i = 0; i < 5; i++) { const r = await run(strict, await signed3009(listedAcct, { primaryType: "ReceiveWithAuthorization" })); if (r.code !== 403) ok(false, "a repeat is still refused"); }
    await settle();
    const refRow = (await rows()).find((x) => x.address.toLowerCase() === LISTED_SIGNER && x.route === "POST /ref/hash");
    ok((await rows()).length === before && refRow?.attempts === 6 && Date.parse(refRow.lastSeenAt) >= Date.parse(refRow.at), `five more refused payments from the same listed signer on /ref add five attempts to its row (${(await rows()).length - before} new rows, attempts ${refRow?.attempts})`);
    // Another direct route is the same route class: an attempt on the direct row.
    await run(lenient, await signed3009(listedAcct), { path: "/api/other" });
    await settle();
    const directRow = (await rows()).find((x) => x.address.toLowerCase() === LISTED_SIGNER && x.route === "POST /api/hash");
    ok((await rows()).length === before && directRow?.attempts === 2, `the direct routes are one route class: a second direct route is an attempt on the direct row (attempts ${directRow?.attempts})`);
    ok(readFileSync(process.env.SANCTIONS_EVENTS_FILE, "utf8").includes(`"attempts":6`), "the attempt count is in the stored file, not only in memory");
    // Filed: the row takes no more attempts; the next one opens a new row.
    await EV.markSanctionsEventsFiled({ ids: [refRow.id], reference: "RS-TEST" });
    await run(strict, await signed3009(listedAcct, { primaryType: "ReceiveWithAuthorization" }));
    await settle();
    const refRows = (await rows()).filter((x) => x.address.toLowerCase() === LISTED_SIGNER && x.route === "POST /ref/hash");
    ok(refRows.length === 2 && refRows.find((x) => x.id === refRow.id)?.attempts === 6 && refRows.find((x) => x.id !== refRow.id)?.attempts === 1, "a filed row keeps the count it was filed with; the next attempt opens a new row");

    // (d) No cap: a flood of distinct listed signers is recorded in full, one row each.
    EV.__resetSanctionsEventsForTests(); EV.__resetSanctionsEventLimitsForTests();
    rmSync(process.env.SANCTIONS_EVENTS_FILE, { force: true });
    EV.__resetSanctionsEventsForTests();
    const one = await Promise.all(flood.slice(0, 30).map(async (a) => run(strict, await signed3009(a, { primaryType: "ReceiveWithAuthorization" }), { ip: "198.51.100.1" })));
    const many = await Promise.all(flood.slice(30).map(async (a, i) => run(strict, await signed3009(a, { primaryType: "ReceiveWithAuthorization" }), { ip: `198.51.${101 + Math.floor(i / 5)}.${i % 5}` })));
    await settle();
    const flooded = await rows();
    ok(flood.length === 140 && [...one, ...many].every((r) => r.code === 403) && flooded.length === flood.length && new Set(flooded.map((x) => x.address.toLowerCase())).size === flood.length, `${flood.length} listed signers, 30 of them from one client address: all refused, every one recorded (${flooded.length} rows)`);
    // Sent again: every attempt counted, no row added.
    await Promise.all(flood.slice(0, 30).map(async (a) => run(strict, await signed3009(a, { primaryType: "ReceiveWithAuthorization" }), { ip: "198.51.100.1" })));
    await settle();
    const again = await rows();
    ok(again.length === flood.length && again.filter((x) => x.attempts === 2).length === 30 && again.reduce((t, x) => t + x.attempts, 0) === flood.length + 30, `the same 30 again add one attempt each (${again.reduce((t, x) => t + x.attempts, 0)} attempts in ${again.length} rows)`);
    ok(EV.sanctionsReportStatus() === "due" && (await EV.sanctionsEventsOperatorView()).writeLimits?.repeats === 30, "the word reads due and the operator view counts the repeats");
    // Unproven refusals in a flood: one aggregate row per hour, its count exact.
    const before2 = (await aggs()).reduce((t, x) => t + x.count, 0);
    await Promise.all(Array.from({ length: 200 }, async () => run(strict, await signed3009(throwaway, { from: flood[0].address }))));
    await settle();
    const ag2 = (await aggs()).filter((x) => x.routeClass === "ref");
    ok(ag2.length === 1 && ag2[0].count - before2 === 200, `200 refusals on an unproven address: counted in one aggregate row (${ag2.length} rows, count ${ag2[0]?.count})`);
    ok(readFileSync(process.env.SANCTIONS_EVENTS_FILE, "utf8").includes(`"count":${ag2[0].count}`), "the aggregate count is in the stored file");

    // (f) A contract wallet's signature (EIP-1271 / EIP-6492: no local recovery). After the
    //     facilitator verified it (the direct routes) its signer is recorded; before it (/ref)
    //     it is refused, never a row, and counted in the aggregate as an unproven signer.
    const smart = privateKeyToAccount(generatePrivateKey());
    writeFileSync(process.env.SANCTIONS_SCREEN_FILE, JSON.stringify({ v: 1, loadedAt: Date.now(), publishDate: "01/01/2026", perAsset: { ETH: 1 }, addresses: [smart.address.toLowerCase()] }));
    SS.__resetSanctionsScreenForTests();
    await SS.loadStoredSanctionsScreen();
    const t6492 = Math.floor(Date.now() / 1000);
    const contractSig = { "payment-signature": b64({ x402Version: 2, accepted, payload: { signature: "0x" + "ab".repeat(400), authorization: { from: smart.address, to: PAY_TO, value: "10000", validAfter: String(t6492 - 60), validBefore: String(t6492 + 300), nonce: nonce() } } }) };
    const unprovenBefore = ((await aggs()).find((x) => x.routeClass === "ref")?.byReason?.["unproven-signer"]) || 0;
    const sw1 = await run(strict, contractSig);
    await settle();
    ok(!sw1.next && sw1.code === 403 && !(await rows()).some((x) => x.address.toLowerCase() === smart.address.toLowerCase()) && (await aggs()).find((x) => x.routeClass === "ref")?.byReason?.["unproven-signer"] === unprovenBefore + 1, "/ref: a listed contract-wallet signer is refused, gets no row (not verified yet), and is counted in the aggregate as an unproven signer");
    const sw2 = await run(lenient, contractSig, { path: "/api/hash" });
    await settle();
    ok(!sw2.next && sw2.code === 403 && (await rows()).some((x) => x.address.toLowerCase() === smart.address.toLowerCase() && x.route === "POST /api/hash"), "direct routes (after verify): the same listed contract-wallet signer is refused and recorded");

    // (g1) ONE write that fails, with no repeat after it, still lands once the store recovers.
    {
      const { mkdirSync } = await import("node:fs");
      const blocker1 = join(dir, "not-a-dir-1");
      writeFileSync(blocker1, "x");
      const keepFile = process.env.SANCTIONS_EVENTS_FILE;
      const oneAddr = "0x" + "f1".repeat(20);
      try {
        process.env.SANCTIONS_EVENTS_FILE = join(blocker1, "events.jsonl");
        EV.__resetSanctionsEventsForTests();
        const only = await EV.recordSanctionsEvent({ kind: "screen-hit", address: oneAddr, rail: "x402", route: "POST /api/hash" });
        ok(only === null && EV.sanctionsEventWriteLimits().pending === 1, "setup: a single write is refused by the store and held pending");
        rmSync(blocker1, { force: true });
        mkdirSync(blocker1, { recursive: true });
        await EV.flushSanctionsEvents();
        const landedRow = readFileSync(process.env.SANCTIONS_EVENTS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.address === oneAddr);
        ok(landedRow?.attempts === 1 && EV.sanctionsEventWriteLimits().pending === 0, `with no repeat after it, the one refused write lands once the store recovers (${landedRow ? "written" : "missing"})`);
      } finally { process.env.SANCTIONS_EVENTS_FILE = keepFile; EV.__resetSanctionsEventsForTests(); }
    }

    // (g) A write that fails is retried, and the attempts it gathered meanwhile are kept.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const goodFile = process.env.SANCTIONS_EVENTS_FILE;
    const failAcct = privateKeyToAccount(generatePrivateKey());
    const failAddr = "0x" + "fa".repeat(20);
    try {
      process.env.SANCTIONS_EVENTS_FILE = join(blocker, "events.jsonl");
      const first = await EV.recordSanctionsEvent({ kind: "screen-hit", address: failAddr, rail: "x402", route: "POST /api/hash" });
      ok(first === null, "setup: the store refuses the first write (its directory is a file)");
      const second = await EV.recordSanctionsEvent({ kind: "screen-hit", address: failAddr, rail: "x402", route: "POST /api/hash" });
      ok(second?.attempts === 2, `the next refusal of the same payer is an attempt on the unwritten row, not a dropped repeat (attempts ${second?.attempts})`);
      rmSync(blocker, { force: true });
      const { mkdirSync } = await import("node:fs");
      mkdirSync(blocker, { recursive: true });
      await EV.flushSanctionsEvents();
      const stored = readFileSync(process.env.SANCTIONS_EVENTS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.address === failAddr);
      ok(stored?.attempts === 2 && EV.sanctionsEventWriteLimits().pending === 0, `once the store recovers, the row is written with both attempts (${stored?.attempts})`);
      const third = await EV.recordSanctionsEvent({ kind: "screen-hit", address: failAcct.address, rail: "x402", route: "POST /api/hash" });
      ok(third && readFileSync(process.env.SANCTIONS_EVENTS_FILE, "utf8").includes(failAcct.address), "and a new refusal after the recovery writes its row at once");
    } finally { process.env.SANCTIONS_EVENTS_FILE = goodFile; EV.__resetSanctionsEventsForTests(); }

    // (h) A hard kill: a process records a hit, three repeats and an unproven count, is killed
    //     with SIGKILL before its write-behind flush; the next process reads them all.
    {
      const { runRestartCase } = await import("./lib/sanctions-restart.js");
      const restartFile = join(dir, "restart", "events.jsonl");
      const addr = "0x" + "4b".repeat(20);
      const res = runRestartCase({ env: { SANCTIONS_EVENTS_FILE: restartFile }, address: addr });
      const hitRow = res.rows?.find((x) => x.address === addr);
      const countRow = res.rows?.find((x) => x.aggregate && x.kind === "unproven-refusal");
      ok(res.killedBy === "SIGKILL" && hitRow?.attempts === 4 && countRow?.count === 1 && res.rows.length === 2, `after a SIGKILL the next process reads every attempt and the count row (killed by ${res.killedBy}; attempts ${hitRow?.attempts}, count ${countRow?.count}${res.rows ? "" : `; ${res.readerErr || res.writerErr}`})`);
      const again = runRestartCase({ env: { SANCTIONS_EVENTS_FILE: restartFile }, address: "0x" + "4c".repeat(20) });
      const first = again.rows?.find((x) => x.address === addr);
      ok(first?.attempts === 4 && again.rows?.filter((x) => x.aggregate).reduce((t, x) => t + x.count, 0) === 2, `a second kill and replay never counts the first one twice (attempts ${first?.attempts})`);
    }

    // (e) Live control: a clean signed payment passes and records nothing.
    const n = (await rows()).length;
    const clean = await run(strict, await signed3009(cleanAcct, { primaryType: "ReceiveWithAuthorization" }));
    const cleanDirect = await run(lenient, await signed3009(cleanAcct), { path: "/api/hash" });
    await settle();
    ok(clean.next && clean.code === null && cleanDirect.next && (await rows()).length === n, "CONTROL: a clean signed payment passes both screens and records nothing");
  } finally {
    delete process.env.SANCTIONS_SCREEN_FILE;
    if (outerEvents === undefined) delete process.env.SANCTIONS_EVENTS_FILE; else process.env.SANCTIONS_EVENTS_FILE = outerEvents;
    SS.__resetSanctionsScreenForTests();
    EV.__resetSanctionsEventsForTests(); EV.__resetSanctionsEventLimitsForTests();
    __resetX402PayerScreenForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. The real paid server.
const TMP = mkdtempSync(join(tmpdir(), "x402-payer-screen-"));
let proc = null;
const booted = [];
const serverLog = () => booted.flatMap((s) => s.log().split("\n").filter((l) => l.trim()).map((l) => l.slice(0, 400)));
setTimeout(() => { console.error("FAIL - timed out"); for (const l of serverLog().slice(-25)) console.error("  server:", l); proc?.kill("SIGKILL"); process.exit(1); }, 180_000).unref();

const fac = { verify: {}, settle: {} };
const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
const facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (o, s = 200) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") {
      let rpc = {}; try { rpc = JSON.parse(b || "{}"); } catch { /* ignore */ }
      const balanceOf = rpc.method === "eth_call" && String(rpc.params?.[0]?.data || "").startsWith("0x70a08231");
      return reply({ jsonrpc: "2.0", id: rpc.id ?? 1, result: balanceOf ? "0x" + (1_000_000_000).toString(16).padStart(64, "0") : "0x0" });
    }
    if (req.url === "/SDN.XML") return reply({}, 503); // the list source stays down: only the stored set is ever loaded
    let p = {}; try { p = JSON.parse(b || "{}"); } catch { /* ignore */ }
    const inner = p.paymentPayload?.payload || {};
    const payer = String(inner.permit2Authorization?.from || inner.authorization?.from || "").toLowerCase();
    if (req.url === "/verify") { bump(fac.verify, payer); return reply({ isValid: true, payer }); }
    if (req.url === "/settle") { bump(fac.settle, payer); return reply({ success: true, transaction: `0x${String(Object.values(fac.settle).reduce((a, n) => a + n, 0)).padStart(64, "0")}`, network: "eip155:8453", payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC_PORT = facilitator.address().port;
const FAC = `http://127.0.0.1:${FAC_PORT}`;

// A stub over api.openai.com for the async route (a test boot can never spend).
const up = { calls: 0 };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const upstream = createServer((req, res) => {
  req.resume();
  req.on("end", () => { up.calls++; setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 1, output_tokens: 1 } })); }, 200); });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UP_PORT = upstream.address().port;
const preload = join(TMP, "openai-stub.mjs");
writeFileSync(preload, `
const STUB = ${JSON.stringify(`http://127.0.0.1:${UP_PORT}`)};
const real = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  let p = null; try { p = typeof url === "string" ? new URL(url) : null; } catch { /* not a URL */ }
  if (p && p.protocol === "https:" && p.hostname === "api.openai.com") return real.call(this, STUB + p.pathname + p.search, init);
  return real.call(this, input, init);
};
`);

// The stored set the screen reads at boot (the shape src/sanctions-screen.js saves).
const STORE = join(TMP, "screen.json");
writeFileSync(STORE, JSON.stringify({ v: 1, loadedAt: Date.now(), publishDate: "01/01/2026", perAsset: { ETH: 2 }, addresses: [LISTED, OTHER_LISTED] }));

// Both boots share one set of file stores, as they did before (the files this
// suite names per boot are named by the boot's label).
const STORES = ownStoreEnv("x402-payer-screen");
const boot = async (port, storeFile) => {
  const env = { ...STORES, TRUST_PROXY_HOPS: "1", FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, PAYMENT_NETWORKS: "base",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", TEMPO_RELAY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
    OPENAI_API_KEY: "sk-test-never-used", OPENROUTER_API_KEY: "", AGENT402_OPERATOR_TOKEN: "payer-screen-test-operator-token-0123456789",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    AGENT402_TASK_DATA_DIR: join(TMP, `tasks-${port}`), REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, `sales-${port}.db`), HANGUP_FORGIVE_FILE: join(TMP, `hangup-${port}.json`),
    MEMORY_DB_FILE: join(TMP, "memory.db"),
    SANCTIONS_SCREEN_FILE: storeFile, SANCTIONS_LIST_URL: `${FAC}/SDN.XML` };
  let srv;
  try { srv = await bootServer({ stores: false, args: ["--import", preload], timeoutMs: 80_000, env }); } catch (e) { throw new Error(`server did not boot\n${e.message}`); }
  booted.push(srv);
  proc = srv.child;
  return srv.url;
};
const stop = async () => { if (!proc) return; const p = proc; proc = null; p.kill("SIGTERM"); await new Promise((r) => { const t = setTimeout(() => { p.kill("SIGKILL"); r(); }, 8000); p.once("exit", () => { clearTimeout(t); r(); }); }); };

let nonce = 0;
const acceptedCache = new Map();
const acceptedFor = async (B, method, url, body) => {
  const k = `${method} ${url}`;
  if (!acceptedCache.has(k)) {
    const r = await fetch(`${B}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body });
    const pr = r.headers.get("payment-required");
    const a = pr ? (JSON.parse(Buffer.from(pr, "base64").toString("utf8")).accepts || []).find((x) => x.network === "eip155:8453" && x.scheme === "exact") : null;
    acceptedCache.set(k, a || null);
  }
  return acceptedCache.get(k);
};
const credential = (accepted, { from, permit2From, both } = {}) => {
  const n = "0x" + (0x7000 + ++nonce).toString(16).padStart(64, "0");
  const authorization = { from, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: n };
  const p2 = permit2From ? { from: permit2From, permitted: { token: accepted.asset, amount: accepted.amount }, spender: "0x" + "02".repeat(20), nonce: String(BigInt(n)), deadline: "9999999999", witness: { to: accepted.payTo, validAfter: "0", extra: "0x" } } : null;
  const payload = p2 ? { signature: "0x" + "22".repeat(65), permit2Authorization: p2, ...(both ? { authorization } : {}) } : { signature: "0x" + "11".repeat(65), authorization };
  return b64({ x402Version: 2, resource: accepted.resource, accepted, payload });
};
const paid = async (B, method, url, body, who, extra = {}) => {
  const accepted = await acceptedFor(B, method, url, body);
  if (!accepted) return { status: -1, json: {} };
  const r = await fetch(`${B}${url}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), "payment-signature": credential(accepted, who), ...extra }, body });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, headers: r.headers };
};
const settles = (a) => fac.settle[a] || 0;
const verifies = (a) => fac.verify[a] || 0;
const status = async (B, auth) => (await (await fetch(`${B}/api/gateway-status`, auth ? { headers: { "X-Operator-Token": "payer-screen-test-operator-token-0123456789" } } : {})).json()).sanctionsScreen;

const PUT = (key, value) => JSON.stringify({ key, value });
try {
  // ---- Boot A: the stored list is loaded ----
  let B = await boot("a", STORE);
  const pub = await status(B);
  ok(pub?.status === "fresh" && Object.keys(pub).join() === "status", `x402 alone (no Tempo direct mode) publishes the screen's one word: ${JSON.stringify(pub)}`);

  // Live control first.
  let r = await paid(B, "POST", "/api/memory", PUT("k", "clean-value"), { from: CLEAN });
  ok(r.status === 200 && settles(CLEAN) === 1, `control: a clean payer's paid write is served and settles once (got ${r.status}, settles ${settles(CLEAN)})`);

  // A listed EIP-3009 payer, mixed case: verified, refused, nothing settles.
  r = await paid(B, "POST", "/api/memory", PUT("k", "listed-value"), { from: LISTED_MIXED });
  ok(r.status === 403, `a listed payer is refused 403 (got ${r.status})`);
  ok(r.json?.error === "This server cannot accept a payment from this address (sanctions screening). Nothing was charged for this request." && r.json?.reason === "payer-not-accepted" && r.json?.charged === false, `the refusal body is the neutral text (${JSON.stringify(r.json)})`);
  ok(!JSON.stringify(r.json).toLowerCase().includes(LISTED.slice(2)), "the refusal body does not echo the address");
  ok(verifies(LISTED) === 1 && settles(LISTED) === 0, `the payment verified first and nothing settled (verify ${verifies(LISTED)}, settle ${settles(LISTED)})`);

  // Permit2 from a listed signer, and a Permit2 whose unsigned authorization block names a clean wallet.
  r = await paid(B, "POST", "/api/memory", PUT("k2", "p2"), { permit2From: LISTED });
  ok(r.status === 403 && settles(LISTED) === 0, `a Permit2 payment from a listed signer is refused, nothing settles (got ${r.status})`);
  // On a route with no payer identity of its own (memory would refuse this
  // shape anyway), so only the screen can refuse it.
  const cleanSettlesBefore = settles(CLEAN);
  r = await paid(B, "POST", "/api/hash", JSON.stringify({ text: "hello" }), { from: CLEAN, permit2From: LISTED, both: true });
  ok(r.status === 403 && settles(LISTED) === 0 && settles(CLEAN) === cleanSettlesBefore, `a Permit2 signer that is listed is refused even beside a clean authorization block (got ${r.status})`);
  r = await paid(B, "POST", "/api/hash", JSON.stringify({ text: "hello" }), { from: CLEAN });
  ok(r.status === 200 && settles(CLEAN) === cleanSettlesBefore + 1, `control: the same route serves a clean payer (got ${r.status})`);
  // Permit2 control: a clean Permit2 signer on the same route.
  r = await paid(B, "POST", "/api/memory", PUT("k4", "p2-clean"), { permit2From: CLEAN_2 });
  ok(r.status === 200 && settles(CLEAN_2) === 1, `control: a clean Permit2 signer is served and settles (got ${r.status})`);

  // A GET route is screened the same way.
  r = await paid(B, "GET", "/api/memory?key=k", null, { from: LISTED });
  ok(r.status === 403 && settles(LISTED) === 0, `a listed payer's paid read is refused too (got ${r.status})`);

  // Idempotency-Key: a refusal is never cached, so the retry is verified and screened again.
  const v0 = verifies(LISTED);
  const idem = { "idempotency-key": "screen-idem-1" };
  const accW = await acceptedFor(B, "POST", "/api/memory", PUT("k5", "x"));
  const credL = credential(accW, { from: LISTED });
  const send = (cred, key) => fetch(`${B}/api/memory`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": cred, "idempotency-key": key }, body: PUT("k5", "x") });
  const i1 = await send(credL, idem["idempotency-key"]);
  const i2 = await send(credL, idem["idempotency-key"]);
  ok(i1.status === 403 && i2.status === 403 && i2.headers.get("x-idempotent-replay") !== "true" && verifies(LISTED) === v0 + 2 && settles(LISTED) === 0, `a keyed retry of a refused payment is refused again, never replayed (${i1.status}/${i2.status}, verifies +${verifies(LISTED) - v0})`);
  const credC = credential(accW, { from: CLEAN });
  const c1 = await send(credC, "screen-idem-2");
  const c2 = await send(credC, "screen-idem-2");
  ok(c1.status === 200 && c2.status === 200 && c2.headers.get("x-idempotent-replay") === "true", `control: a clean keyed retry replays the settled answer (${c1.status}/${c2.status})`);

  // Async job (Prefer: respond-async): the loopback replay is screened.
  const ASYNC = "/api/image-gen-premium", ABODY = JSON.stringify({ prompt: "a red fox in the snow" });
  const accA = await acceptedFor(B, "POST", ASYNC, ABODY);
  ok(!!accA, "the async route offers exact on Base");
  if (accA) {
    const job = async (headers) => {
      const j = await (await fetch(`${B}${ASYNC}`, { method: "POST", headers: { "content-type": "application/json", prefer: "respond-async", ...headers }, body: ABODY })).json();
      let g = {};
      for (let i = 0; i < 200; i++) { g = await (await fetch(`${B}${j.statusUrl}`)).json(); if (["completed", "failed"].includes(g.status)) break; await sleep(100); }
      return { j, g };
    };
    const calls0 = up.calls;
    const L = await job({ "x-forwarded-for": "10.7.0.1", "payment-signature": credential(accA, { from: LISTED }) });
    ok(/^[0-9a-f]{48}$/.test(L.j.jobId || "") && L.g.status === "failed" && L.g.error?.httpStatus === 403, `a listed payer's async job ends failed with the 403 (job ${L.g.status}, HTTP ${L.g.error?.httpStatus})`);
    ok(up.calls === calls0 && settles(LISTED) === 0, "the async replay never reached the upstream and settled nothing");
    const s0 = settles(CLEAN);
    const C = await job({ "x-forwarded-for": "10.7.0.2", "payment-signature": credential(accA, { from: CLEAN }) });
    ok(C.g.status === "completed" && C.g.result?.httpStatus === 200 && settles(CLEAN) === s0 + 1 && up.calls === calls0 + 1, `control: a clean payer's async job completes and settles once (job ${C.g.status})`);
  }

  // Trailing control, after every refusal.
  r = await paid(B, "POST", "/api/memory", PUT("k6", "still"), { from: CLEAN });
  ok(r.status === 200, `trailing control: the clean payer is still served (got ${r.status})`);

  const op = await status(B, true);
  ok(op?.status === "fresh" && op?.evmAddresses === 2 && op?.x402?.refused >= 6 && op?.x402?.servedUnscreened === 0, `the operator view counts the x402 refusals (${JSON.stringify(op?.x402)})`);
  const logText = serverLog().join("\n").toLowerCase();
  ok(/x402 payer 0x5a5a\.\.\.5a5a refused before the handler/.test(logText), "the server log names the refusal with the address masked");
  ok(!logText.includes(LISTED.slice(2)), "the server log never carries the full address");
  await stop();

  // ---- Boot B: no list loaded (fail open), same memory store ----
  B = await boot("b", join(TMP, "no-such-store.json"));
  ok((await status(B))?.status === "missing", "with no list loaded the status word reads missing");
  // The memory handler itself answers this read (the screen let it through),
  // and it finds nothing: the refused write in the first boot never ran.
  r = await paid(B, "GET", "/api/memory?key=k", null, { from: LISTED });
  ok(r.status === 404 && r.json?.error === "Key not found" && !JSON.stringify(r.json).includes("listed-value"), `the refused write never ran: the listed payer's namespace is empty (${r.status} ${JSON.stringify(r.json).slice(0, 120)})`);
  const settledBefore = settles(LISTED);
  r = await paid(B, "POST", "/api/memory", PUT("k", "unscreened"), { from: LISTED });
  ok(r.status === 200 && settles(LISTED) === settledBefore + 1, `a listed payer is served while no list is loaded (fail open; got ${r.status}, settles +${settles(LISTED) - settledBefore})`);
  r = await paid(B, "GET", "/api/memory?key=k", null, { from: CLEAN });
  ok(r.status === 200 && JSON.stringify(r.json).includes("clean-value"), `control: the clean payer's write from the first boot reads back (${JSON.stringify(r.json).slice(0, 120)})`);
  const opB = await status(B, true);
  ok(opB?.status === "missing" && opB?.x402?.servedUnscreened >= 1, `the operator view counts payments served unscreened (${JSON.stringify(opB?.x402)})`);
  ok(/serving x402 payments unscreened/.test(serverLog().join("\n")), "the unscreened state is logged");
} finally {
  await stop();
  facilitator.close(); upstream.close();
  rmSync(TMP, { recursive: true, force: true });
}
if (fail) for (const l of serverLog().slice(-30)) console.error("  server:", l);
console.log(`\ntest-x402-payer-screen: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
