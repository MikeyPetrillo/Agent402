#!/usr/bin/env node
// A settle chain that a FALLBACK stops on an answer that does not prove
// nothing was sent, through the real paywall (src/payments.js).
//
//   node scripts/test-settle-fallback-unconfirmed.js
//
// Boots the REAL server in paid mode (Base) with PAYMENT_SETTLE_FALLBACK on,
// against two stub facilitators: the primary and its settle fallback. The
// primary refuses on billing (a refusal made before anything is signed), so
// the fallback is asked:
//   - the fallback answers an HTTP 500, resets the connection, fails naming a
//     transaction, or answers an HTTP 200 whose body cannot be read: the 402
//     carries no offer, never says the call was not charged, says not to sign
//     a new authorization, names the transaction when one was named (else
//     check-wallet), the authorization's validBefore, and the refund lookup
//     for a named transaction; its receipt reads settlement_unconfirmed; the
//     authorization (or the named transaction) is booked for the
//     late-settlement read;
//   - control: every settler refuses on billing: the old billing answer,
//     nothing booked; the fallback settles: one settlement, a 200;
//   - a fallback's graceful verdict on the buyer's payment with no
//     transaction keeps the old answer, nothing booked (control: a used
//     authorization stays unconfirmed);
//   - one wallet through fourteen unconfirmed settles is never refused 429,
//     holds at most its bound of bookings with the rest journaled and logged,
//     and is served once the facilitators recover;
//   - the same payment sent again (same or other body) gets the unconfirmed
//     answer back with no verify, no handler run and no settle;
//   - its transfer then lands: the reconcile books it owed, once.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { bootServer } from "./lib/boot-server.js";

const { isPreBroadcastSettleRejection, isUnreadableSettleAnswer, isDecidedSettleVerdict, isDecidedHttpSettleVerdict, lateAuthOf, paymentExpiryOf } = await import("../src/payments.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_NET = "eip155:8453";
const NOT_CHARGED = /not charged|nothing (?:was|is) charged|never charged/i;

// ---- module half -------------------------------------------------------------
{
  const { unconfirmedSettleRefusal, unconfirmedSettleReceipt, withPendingSettleRefusal, REJECTION_REASONS, SETTLEMENT_UNCONFIRMED, railTxOf } = await import("../src/payment-reject.js");
  const { settleFailureFault } = await import("../src/settle-fault.js");
  const { lateSettleCandidate } = await import("../src/late-settlements.js");
  const { unconfirmedReplayMs } = await import("../src/idempotency.js");
  const TX = `0x${"ab".repeat(32)}`;
  const none = unconfirmedSettleRefusal({ network: BASE_NET, booked: true, validBefore: 2_000_000_000 });
  ok(none.reason === "settlement-unconfirmed" && none.retry === "check-wallet" && !("transactions" in none) && !("refundStatusUrl" in none) && none.authorizationValidBefore === "2033-05-18T03:33:20Z"
    && /Do not sign a new authorization/.test(none.detail) && /booked as owed/.test(none.detail) && !NOT_CHARGED.test(none.detail),
    `no transaction: check-wallet, do not sign again, validBefore, owed when it lands (${none.detail.slice(0, 100)})`);
  const unbooked = unconfirmedSettleRefusal({ network: BASE_NET, booked: false });
  ok(!/owed/.test(unbooked.detail) && /Do not sign a new authorization/.test(unbooked.detail), "nothing recorded (a Permit2 or non-EVM payment with no transaction): no repayment promise, still do not sign again");
  ok(/^[^]*Check the paying wallet on eip155:8453 first\. Do not sign a new authorization for this call until it shows whether this transfer landed/.test(unbooked.detail) && !/\bbefore \d{4}-|round \d|ledger \d/.test(unbooked.detail) && !("authorizationValidBefore" in unbooked),
    `a payment that carries no expiry: check the paying wallet first, no time promise (${unbooked.detail.slice(-170)})`);
  // The rail's own expiry, where the payment carries one.
  const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
  const sol = unconfirmedSettleRefusal({ network: SOL_NET, transactions: [SIG, SIG.toLowerCase()], validBefore: 2_000_000_000, booked: true });
  ok(sol.retry === "watch-transaction" && JSON.stringify(sol.transactions) === JSON.stringify([SIG]) && sol.authorizationValidBefore === "2033-05-18T03:33:20Z" && !("refundStatusUrl" in sol),
    "Solana: the signature is named as written (never case-folded), the blockhash bound is the time, no EVM refund lookup");
  const ALGO_NET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k";
  const algo = unconfirmedSettleRefusal({ network: ALGO_NET, lastValidRound: "61234567" });
  ok(algo.lastValidRound === 61234567 && !("authorizationValidBefore" in algo) && /until algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k has passed round 61234567/.test(algo.detail) && !/first\. Do not sign/.test(algo.detail),
    `Algorand: the lastValid round is named (${algo.detail.slice(170, 330)})`);
  const xlm = unconfirmedSettleRefusal({ network: "stellar:pubnet", expirationLedger: 55555, transactions: ["AB".repeat(32)] });
  ok(xlm.expirationLedger === 55555 && /has passed ledger 55555/.test(xlm.detail) && JSON.stringify(xlm.transactions) === JSON.stringify(["ab".repeat(32)]),
    "Stellar: the expiration ledger is named and the hash is kept");
  ok(railTxOf(SOL_NET, SIG) === SIG && railTxOf(SOL_NET, TX) === null && railTxOf(BASE_NET, SIG) === null && railTxOf(ALGO_NET, "A".repeat(52)) === "A".repeat(52) && railTxOf(ALGO_NET, "a".repeat(52)) === null && railTxOf(null, TX.toUpperCase().replace("0X", "0x")) === TX,
    "transaction ids in each rail's own format only");
  ok(unconfirmedSettleReceipt({ success: false, errorReason: "x", network: SOL_NET }, { transaction: SIG }).transaction === SIG, "the restated Solana receipt keeps the signature as written");
  {
    const now = Math.floor(Date.now() / 1000);
    const svm = await paymentExpiryOf({ requirements: { network: SOL_NET }, paymentPayload: { payload: { transaction: "AQ==" } } });
    ok(svm && Number(svm.validBefore) >= now + 90 && Number(svm.validBefore) <= now + 125, `Solana: a time past the recent blockhash's life (${svm?.validBefore - now} s)`);
    const evm = await paymentExpiryOf({ requirements: { network: BASE_NET }, paymentPayload: { payload: { authorization: { validBefore: "2000000000" } } } });
    ok(evm?.validBefore === "2000000000", "EVM: the authorization's validBefore");
    const algosdk = (await import("algosdk")).default;
    const acct = algosdk.generateAccount();
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: acct.addr, receiver: acct.addr, amount: 1, suggestedParams: { fee: 1000, minFee: 1000, firstValid: 100, lastValid: 1100, genesisID: "mainnet-v1.0", genesisHash: new Uint8Array(32), flatFee: true } });
    const signed = Buffer.from(txn.signTxn(acct.sk)).toString("base64");
    const avm = await paymentExpiryOf({ requirements: { network: ALGO_NET }, paymentPayload: { payload: { paymentGroup: [signed], paymentIndex: 0 } } });
    ok(avm?.lastValidRound === "1100", `Algorand: the signed transaction's lastValid round (${JSON.stringify(avm)})`);
    const sdk = await import("@stellar/stellar-sdk");
    const NETP = sdk.Networks.PUBLIC;
    const SAC = new sdk.Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN").contractId(NETP);
    const from = sdk.Keypair.random().publicKey();
    const args = [new sdk.Address(from).toScVal(), new sdk.Address(sdk.Keypair.random().publicKey()).toScVal(), sdk.nativeToScVal(1000n, { type: "i128" })];
    const call = new sdk.xdr.InvokeContractArgs({ contractAddress: new sdk.Address(SAC).toScAddress(), functionName: "transfer", args });
    const entry = new sdk.xdr.SorobanAuthorizationEntry({
      credentials: sdk.xdr.SorobanCredentials.sorobanCredentialsAddress(new sdk.xdr.SorobanAddressCredentials({ address: new sdk.Address(from).toScAddress(), nonce: sdk.xdr.Int64.fromString("7"), signatureExpirationLedger: 55555, signature: sdk.xdr.ScVal.scvVoid() })),
      rootInvocation: new sdk.xdr.SorobanAuthorizedInvocation({ function: sdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations: [] }),
    });
    const xdr = new sdk.TransactionBuilder(new sdk.Account(sdk.Keypair.random().publicKey(), "1"), { fee: "100", networkPassphrase: NETP })
      .addOperation(sdk.Operation.invokeContractFunction({ contract: SAC, function: "transfer", args, auth: [entry] })).setTimeout(300).build().toXDR();
    const st = await paymentExpiryOf({ requirements: { network: "stellar:pubnet" }, paymentPayload: { payload: { transaction: xdr } } });
    ok(st?.expirationLedger === "55555", `Stellar: the signed authorization's expiration ledger (${JSON.stringify(st)})`);
    ok((await paymentExpiryOf({ requirements: { network: "stellar:pubnet" }, paymentPayload: { payload: { transaction: "not-xdr" } } })) === null
      && (await paymentExpiryOf({ requirements: { network: ALGO_NET }, paymentPayload: { payload: {} } })) === null, "an unreadable payment carries no expiry: the answer makes no time promise");
  }
  const named = unconfirmedSettleRefusal({ network: BASE_NET, transactions: [TX.toUpperCase().replace("0X", "0x"), "0x12"], booked: true, origin: "https://agent402.tools/" });
  ok(named.retry === "watch-transaction" && JSON.stringify(named.transactions) === JSON.stringify([TX]) && named.refundStatusUrl === `https://agent402.tools/api/refunds?tx=${TX}`,
    `a named transaction: watch-transaction, lowercased, the refund lookup (${named.refundStatusUrl})`);
  ok(unconfirmedSettleRefusal({ network: "<script>" }).network === null, "a network that is not a CAIP-2 id is not echoed");
  const merged = withPendingSettleRefusal({ error: "Payment rail temporarily unavailable", reason: "facilitator-quota", retry: "other-network", hint: "Nothing was charged.", altPayment: { protocol: "x" } }, none);
  ok(merged.reason === "settlement-unconfirmed" && merged.error === undefined && !("transactions" in merged) && merged.altPayment && !NOT_CHARGED.test(JSON.stringify(merged)),
    "merged over a billing answer: its error, hint and retry are replaced");
  const billing = { success: false, errorReason: "free_tier_exhausted", errorMessage: "Settlement refused: free_tier_exhausted", payer: "0xabc", network: BASE_NET, transaction: "" };
  const restated = unconfirmedSettleReceipt(billing, { transaction: TX });
  ok(restated.errorReason === SETTLEMENT_UNCONFIRMED && restated.payer === "0xabc" && restated.transaction === TX && isPreBroadcastSettleRejection(restated) === false && !/free_tier/.test(JSON.stringify(restated)),
    "the restated receipt keeps payer and network and is not read as nothing sent");
  ok(unconfirmedSettleReceipt({ success: true }) === null, "a settled receipt is never restated");
  ok(settleFailureFault({ receipt: restated, raw: { errorReason: "free_tier_exhausted", errorMessage: "" } }) === "not-buyer"
    && settleFailureFault({ receipt: restated, raw: { errorReason: "insufficient_funds", errorMessage: "" } }) === "not-buyer"
    && settleFailureFault({ receipt: { ...restated, errorReason: "duplicate_authorization" }, raw: null }) === "buyer",
    "the breaker reads settlement_unconfirmed as not the buyer's whatever words were kept (control: duplicate_authorization is the buyer's)");
  const unreadable = Object.assign(new Error("Facilitator settle returned invalid JSON: insufficient_credits"), { name: "FacilitatorResponseError" });
  ok(isUnreadableSettleAnswer(unreadable) && isPreBroadcastSettleRejection(unreadable) === false && isPreBroadcastSettleRejection(new Error("insufficient_credits")) === true,
    "an unreadable settle answer is never a refusal made before sending, whatever its excerpt says (control: the same words as a refusal are)");
  ok(isDecidedSettleVerdict({ success: false, errorReason: "insufficient_funds", transaction: "" }) && isDecidedSettleVerdict({ success: false, errorReason: "The authorization has expired" })
    && !isDecidedSettleVerdict({ success: false, errorReason: "insufficient_funds", transaction: TX }) && !isDecidedSettleVerdict({ success: false, errorReason: "authorization_already_used" })
    && !isDecidedSettleVerdict({ success: false, errorReason: "unexpected_error" }), "decided verdicts: a buyer verdict with no transaction only");
  // A fallback's HTTP 4xx that decides the payment (a parsed settle body
  // naming a buyer verdict and no transaction) reads like the graceful
  // verdict; a time limit, a rate limit, a 5xx, a body naming a transaction or
  // an undecided reason does not.
  const httpErr = (statusCode, errorReason, transaction = "") => Object.assign(new Error(errorReason || "settle failed"), { name: "SettleError", statusCode, errorReason, transaction });
  ok(isDecidedHttpSettleVerdict(httpErr(400, "insufficient_funds")) && isDecidedHttpSettleVerdict(httpErr(400, "invalid_exact_evm_payload_signature")) && isDecidedHttpSettleVerdict(httpErr(422, "The authorization has expired")),
    "a fallback's HTTP 4xx naming a buyer verdict and no transaction is a decided verdict");
  ok(!isDecidedHttpSettleVerdict(httpErr(408, "insufficient_funds")) && !isDecidedHttpSettleVerdict(httpErr(429, "insufficient_funds")) && !isDecidedHttpSettleVerdict(httpErr(500, "insufficient_funds"))
    && !isDecidedHttpSettleVerdict(httpErr(400, "insufficient_funds", TX)) && !isDecidedHttpSettleVerdict(httpErr(400, "unexpected_settle_error")) && !isDecidedHttpSettleVerdict(httpErr(400, "authorization_already_used"))
    && !isDecidedHttpSettleVerdict(new Error("Facilitator settle failed (400): insufficient_funds")) && !isDecidedHttpSettleVerdict(null),
    "never a 408, 429 or 5xx, a body naming a transaction, an undecided or used-authorization reason, or an error with no parsed body");
  // The authorization booked for the late read is the one the payer signed:
  // beside a Permit2 payload an `authorization` block is never verified.
  const SIGNER = `0x${"44".repeat(20)}`;
  const N = `0x${"55".repeat(32)}`;
  ok(lateAuthOf({ paymentPayload: { payload: { authorization: { from: SIGNER, nonce: N, validBefore: "2000000000" } } } })?.payer === SIGNER, "an EIP-3009 authorization is booked under its signed from");
  ok(lateAuthOf({ paymentPayload: { payload: { permit2Authorization: { from: SIGNER, deadline: "2000000000" }, authorization: { from: `0x${"66".repeat(20)}`, nonce: N } } } }) === null
    && lateAuthOf({ paymentPayload: { payload: { authorization: { from: "not-an-address", nonce: N } } } }) === null,
    "a crafted Permit2 payload's unsigned authorization block, or a from that is not an address, books nothing");
  const now0 = 1_700_000_000_000;
  // Hostile fields (an object whose own toString or valueOf is not a
  // function, a number, an array, a huge string) read as nothing, never a throw.
  {
    const TRAP = { toString: 1 }, TRAP2 = { toString: 1, valueOf: 1 };
    const { validBeforeIso, refundStatusUrlOf } = await import("../src/payment-reject.js");
    const bad = [TRAP, TRAP2, ["1"], {}, 7, null, undefined, "x".repeat(100_000)];
    const threw = [];
    const tryIt = (label, fn) => { try { fn(); } catch (e) { threw.push(`${label}: ${e.message}`); } };
    for (const v of bad) {
      tryIt("lateAuthOf from", () => { if (lateAuthOf({ paymentPayload: { payload: { authorization: { from: v, nonce: N } } } }) !== null) threw.push("lateAuthOf booked a bad from"); });
      tryIt("lateAuthOf nonce", () => { if (lateAuthOf({ paymentPayload: { payload: { authorization: { from: SIGNER, nonce: v } } } }) !== null && typeof v !== "string") threw.push("lateAuthOf booked a bad nonce"); });
      tryIt("lateAuthOf validBefore", () => { const r = lateAuthOf({ paymentPayload: { payload: { authorization: { from: SIGNER, nonce: N, validBefore: v } } } }); if (r && r.validBefore !== null && typeof r.validBefore === "object") threw.push("lateAuthOf kept an object validBefore"); });
      tryIt("validBeforeIso", () => { if (v !== 7 && validBeforeIso(v) !== null) threw.push("validBeforeIso read a bad value"); });
      tryIt("refundStatusUrlOf", () => { if (refundStatusUrlOf("https://a.example", v) !== null) threw.push("refundStatusUrlOf read a bad tx"); });
      tryIt("railTxOf", () => { if (railTxOf(v, v) !== null || railTxOf("solana:x", v) !== null) threw.push("railTxOf read a bad tx"); });
      tryIt("unconfirmedSettleRefusal", () => { const r = unconfirmedSettleRefusal({ network: v, transactions: [v, TX], validBefore: v, lastValidRound: v, expirationLedger: v, origin: v }); if (r.reason !== "settlement-unconfirmed") threw.push("refusal lost its reason"); });
      tryIt("unconfirmedSettleReceipt", () => { unconfirmedSettleReceipt({ success: false, network: v, payer: v }, { transaction: v, network: v }); });
      tryIt("unconfirmedReplayMs", () => { const ms = unconfirmedReplayMs(v, now0); if (!Number.isFinite(ms)) threw.push("replay life not finite"); });
    }
    for (const v of [TRAP, TRAP2, ["eip155:8453"], 8453]) {
      try { await paymentExpiryOf({ requirements: { network: v }, paymentPayload: { payload: { authorization: { validBefore: "2000000000" } } } }); } catch (e) { threw.push(`paymentExpiryOf network: ${e.message}`); }
      try { await paymentExpiryOf({ requirements: { network: "stellar:pubnet" }, paymentPayload: { payload: { transaction: v } } }); } catch (e) { threw.push(`paymentExpiryOf stellar: ${e.message}`); }
      try { await paymentExpiryOf({ requirements: { network: "algorand:mainnet" }, paymentPayload: { payload: { paymentGroup: [v], paymentIndex: v } } }); } catch (e) { threw.push(`paymentExpiryOf algorand: ${e.message}`); }
    }
    ok(threw.length === 0, `the settle-path parsers read hostile fields as nothing, never a throw (${threw.join("; ") || "none"})`);
    ok(validBeforeIso("2000000000") === "2033-05-18T03:33:20Z" && validBeforeIso(2_000_000_000) === "2033-05-18T03:33:20Z" && refundStatusUrlOf("https://a.example", TX) === `https://a.example/api/refunds?tx=${TX}`,
      "control: a readable validBefore and transaction still read");
  }
  const permit2Ctx = { requirements: { network: BASE_NET, payTo: `0x${"11".repeat(20)}`, asset: `0x${"22".repeat(20)}`, amount: "1000" }, paymentPayload: { payload: { permit2Authorization: { from: `0x${"33".repeat(20)}`, deadline: "2000000000" } } }, __a402UnconfirmedStop: { via: "fallback" } };
  ok(lateSettleCandidate(permit2Ctx) === null, "a Permit2 payment with no transaction leaves nothing for the book (its answer promises no record)");
  const now = 1_700_000_000_000;
  ok(unconfirmedReplayMs(now / 1000 + 300, now) === 360_000 && unconfirmedReplayMs(now / 1000 - 5, now) === 60_000 && unconfirmedReplayMs("2" + "0".repeat(30), now) === 30 * 86_400_000
    && unconfirmedReplayMs(now / 1000 + 10 * 86_400, now) === 10 * 86_400_000 + 60_000 && unconfirmedReplayMs(null, now) === 86_400_000 && unconfirmedReplayMs("garbage", now) === 86_400_000,
    "the replay lasts to validBefore plus a minute, at least a minute, at most 30 days; a day when no validBefore is named");
  ok(REJECTION_REASONS.some((r) => r.reason === "settlement-unconfirmed" && /check-wallet/.test(r.means) && /watch-transaction/.test(r.means) && /authorizationValidBefore/.test(r.means) && !NOT_CHARGED.test(r.means)), "the published reason names both verbs and the fields");
}

// ---- the per-payer bound: past it a booking waits in the journal and lands
// once the payer's open entries fall under the bound -------------------------
{
  const { createLateSettleBook } = await import("../src/late-settlements.js");
  const dir = mkdtempSync(join(tmpdir(), "settle-unconfirmed-bound-"));
  const file = join(dir, "late.json");
  const lines = [];
  try {
    let clock = Date.now();
    const book = createLateSettleBook({ file, rpcFor: () => "http://127.0.0.1:9", log: (l) => lines.push(l), alarm: (l) => lines.push(l), unconfirmedPerPayerMax: 1, now: () => clock });
    await book.ready;
    const payer = `0x${"aa".repeat(20)}`;
    const base = { network: BASE_NET, payer, payTo: `0x${"bb".repeat(20)}`, asset: `0x${"cc".repeat(20)}`, amount: "1000", validBefore: 2_000_000_000, via: "fallback", unconfirmed: true };
    const nonce = (n) => `0x${String(n).repeat(64)}`;
    const first = await book.book({ ...base, nonce: nonce(1) });
    const second = await book.book({ ...base, nonce: nonce(2) });
    const other = await book.book({ ...base, payer: `0x${"dd".repeat(20)}`, nonce: nonce(3) });
    const open = () => Object.values(JSON.parse(readFileSync(file, "utf8")).pending);
    ok(first === true && second === true && other === true && open().length === 2 && open().every((e) => e.unconfirmed === true),
      `one payer at its bound: the next booking is not in the book, another payer's is (${open().length} open)`);
    ok(lines.filter((l) => /per-payer bound/.test(l)).length === 1 && existsSync(`${file}.held.ndjson`) && readFileSync(`${file}.held.ndjson`, "utf8").includes(nonce(2)) && !existsSync(`${file}.pending.ndjson`),
      "past the bound the booking is kept in the held journal (not the failed-write one) with a line naming the bound, never dropped");
    for (let i = 4; i < 9; i++) await book.book({ ...base, nonce: nonce(i) });
    ok(lines.filter((l) => /per-payer bound/.test(l)).length === 1, `more held bookings inside a minute write no more lines (${lines.filter((l) => /per-payer bound/.test(l)).length})`);
    clock += 61_000;
    await book.book({ ...base, nonce: `0x${"e".repeat(64)}` });
    const perPayer = lines.filter((l) => /per-payer bound/.test(l));
    ok(perPayer.length === 2 && /6 booking\(s\) kept in the journal since the last line/.test(perPayer[1]), `a minute later one line names how many were held since (${perPayer[1]?.slice(0, 200)})`);
    ok((await book.alarmStatus({ ttlMs: 0 })) === "ok", "held bookings that drain by themselves do not page");
    const { journalStates, deadLetterWord } = await import("../src/ledger-mirror.js");
    ok(!(Number(journalStates().lateSettlements?.total) > 0) && deadLetterWord(Object.values(journalStates()), { now: Date.now() + 3_600_000 }) === "none",
      "held bookings are not read by the money journals' dead-letter word, however long they wait");
    await book.reconcile();
    ok(open().length === 2, "while the payer is at its bound the journaled booking stays in the journal");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    for (const [k, e] of Object.entries(doc.pending)) if (String(e.nonce) === nonce(1)) delete doc.pending[k];
    (await import("node:fs")).writeFileSync(file, JSON.stringify(doc));
    await book.reconcile();
    ok(open().some((e) => String(e.nonce) === nonce(2) && e.unconfirmed === true) && (await book.alarmStatus({ ttlMs: 0 })) === "ok",
      "once the payer's entry closes, the journaled booking lands in the book and the word clears");
    clock += 61 * 60_000;
    ok((await book.alarmStatus({ ttlMs: 0 })) === "unresolved", "a held booking that waited over an hour reads unresolved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- the held journal at scale: 1,500 open entries and one payer with 2,000
// held bookings. A pass writes the book only for what lands, tries at most
// DRAIN_MAX_PER_PASS bookings, and stays short ------------------------------
{
  const { createLateSettleBook, lateAuthKey, DRAIN_MAX_PER_PASS } = await import("../src/late-settlements.js");
  const fs = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "settle-unconfirmed-scale-"));
  const file = join(dir, "late.json");
  const lines = [];
  try {
    const t0 = Date.now();
    const hex = (n, w = 64) => `0x${n.toString(16).padStart(w, "0")}`;
    const entryOf = (payer, n) => ({ key: lateAuthKey(BASE_NET, payer, hex(n)), network: BASE_NET, tx: null, nonce: hex(n), payer, payTo: `0x${"bb".repeat(20)}`, asset: `0x${"cc".repeat(20)}`, amount: "1000", validBefore: 2_000_000_000, slug: "memory", via: "fallback", unconfirmed: true, at: t0, nextCheckAt: t0 + 3_600_000, checks: 0, unreadable: 0, failures: 0, state: "pending" });
    const pending = {};
    for (let i = 0; i < 1500; i++) { const e = entryOf(hex(0x100000 + i, 40), i + 1); pending[e.key] = e; }
    const P = `0x${"aa".repeat(20)}`;
    const mine = entryOf(P, 9_000_000); pending[mine.key] = mine;
    fs.writeFileSync(file, JSON.stringify({ pending }));
    const heldLine = (e, i) => JSON.stringify({ id: `${t0}-${String(i).padStart(8, "0")}`, kind: "late", payload: e, at: t0 }) + "\n";
    let nd = "";
    for (let i = 0; i < 2000; i++) nd += heldLine(entryOf(P, 10_000_000 + i), i);
    fs.writeFileSync(`${file}.held.ndjson`, nd);
    const book = createLateSettleBook({ file, rpcFor: () => "http://127.0.0.1:9", log: (l) => lines.push(l), alarm: (l) => lines.push(l), unconfirmedPerPayerMax: 1, maxEntries: 5000 });
    await book.ready;
    const before = fs.statSync(file).mtimeMs;
    const body0 = fs.readFileSync(file, "utf8");
    const p0 = Date.now();
    const r = await book.reconcile();
    const ms = Date.now() - p0;
    ok(fs.readFileSync(file, "utf8") === body0 && fs.statSync(file).mtimeMs === before && r.journaled === 0, `a pass with 2,000 bookings held by one payer writes the book 0 times (${r.journaled} landed)`);
    ok(ms < 5_000, `and stays short (${ms} ms)`);
    ok(lines.filter((l) => /wait in the journal behind 1 payer/.test(l)).length === 1, "one summary line for the pass, not one per held booking");
    // Another payer's 120 bookings behind them land DRAIN_MAX_PER_PASS a pass.
    let nd2 = "";
    for (let i = 0; i < 120; i++) nd2 += heldLine({ ...entryOf(hex(0x900000 + i, 40), 20_000_000 + i) }, 5000 + i);
    fs.appendFileSync(`${file}.held.ndjson`, nd2);
    const landed = [];
    for (let k = 0; k < 6; k++) { const n = (await book.reconcile()).journaled; if (!n) break; landed.push(n); }
    ok(landed.length >= 3 && landed.every((n) => n <= DRAIN_MAX_PER_PASS) && landed[0] >= DRAIN_MAX_PER_PASS - 1 && landed.reduce((a, b) => a + b, 0) === 120 && Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).pending).length === 1501 + 120,
      `bookings that can land do so at most ${DRAIN_MAX_PER_PASS} a pass, the rest on the next (${landed.join(", ")})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const TMP = mkdtempSync(join(tmpdir(), "settle-fallback-unconfirmed-"));
const LATE = join(TMP, "late.json");
const failTxOf = (nonce) => `0x${createHash("sha256").update(`fallback:${String(nonce).toLowerCase()}`).digest("hex")}`;
const st = { primary: "billing", fallback: "500" };
// The chain the late-settlement pass reads. dark: nothing can be read.
const chain = { dark: true, used: new Map() };
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const counts = { primary: 0, fallback: 0, verify: 0, images: 0 };
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
let txN = 0;
const stub = (name) => createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
    if (req.url === "/supported") return reply(200, { kinds: name === "primary" ? [{ x402Version: 2, scheme: "exact", network: BASE_NET }] : [], extensions: [], signers: {} });
    // The image tier's upstream (scripts/lib/openrouter-stub-preload.js sends
    // every https://openrouter.ai call here): one tiny image per call.
    const orPath = String(req.url || "").split("?")[0];
    if (req.method === "GET" && /^\/api\/v1\/images\/models\/.+\/endpoints$/.test(orPath)) return reply(200, { data: { endpoints: [] } });
    if (req.method === "POST" && orPath === "/api/v1/images") { counts.images++; return reply(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: PNG_B64 }], usage: { prompt_tokens: 0, completion_tokens: 0 } }); }
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    if (req.url === "/rpc") {
      const out = (result) => reply(200, { jsonrpc: "2.0", id: parsed.id ?? 1, result });
      const dark = () => reply(200, { jsonrpc: "2.0", id: parsed.id ?? 1, error: { message: "stub chain not readable" } });
      const p0 = parsed.params?.[0];
      if (parsed.method === "eth_call") {
        const data = String(p0?.data || "");
        if (data.startsWith("0xe94a0102")) return chain.dark ? dark() : out(word(chain.used.has(`0x${data.slice(-64)}`.toLowerCase()) ? 1 : 0));
        if (data.startsWith("0x313ce567")) return out(word(6));
        return out("0x0");
      }
      if (parsed.method === "eth_getTransactionReceipt") return chain.dark ? dark() : out([...chain.used.values()].find((u) => u.tx === String(p0).toLowerCase())?.receipt ?? null);
      if (parsed.method === "eth_blockNumber") return out("0x3e8");
      if (parsed.method === "eth_getBlockByNumber") return out({ number: "0x3e8", timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` });
      if (parsed.method === "eth_getLogs") { if (chain.dark) return dark(); const u = chain.used.get(String(p0?.topics?.[2] || "").toLowerCase()); return out(u ? [{ transactionHash: u.tx, blockNumber: "0x3e0" }] : []); }
      return out("0x0");
    }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { counts.verify++; return reply(200, { isValid: true, payer }); }
    if (req.url !== "/settle") return reply(404, {});
    counts[name]++;
    const mode = st[name];
    const refuse = (errorReason, extra = {}) => ({ success: false, errorReason, errorMessage: errorReason, transaction: "", network: BASE_NET, payer, ...extra });
    if (mode === "billing") return reply(402, refuse(name === "primary" ? "free_tier_exhausted" : "insufficient_credits"));
    if (mode === "500") return reply(500, { error: "internal error" });
    if (mode === "reset") return req.socket.destroy();
    if (mode === "tx") return reply(200, refuse("transaction_failed", { transaction: failTxOf(parsed.paymentPayload?.payload?.authorization?.nonce) }));
    if (mode === "garbage200") return reply(200, "<html>upstream gateway</html>");
    if (mode === "verdict") return reply(200, refuse("insufficient_funds"));
    if (mode === "expired-words") return reply(200, refuse("The authorization has expired"));
    if (mode === "used") return reply(200, refuse("authorization_already_used"));
    if (mode === "verdict400") return reply(400, refuse("insufficient_funds"));
    if (mode === "undecided400") return reply(400, refuse("unexpected_settle_error"));
    if (mode === "pending") return reply(500, refuse("settlement_pending", { transaction: failTxOf(parsed.paymentPayload?.payload?.authorization?.nonce) }));
    return reply(200, { success: true, transaction: `0x${(++txN).toString(16).padStart(64, "0")}`, network: BASE_NET, payer });
  });
});
const servers = { primary: stub("primary"), fallback: stub("fallback") };
await Promise.all(Object.values(servers).map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))));
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
const PRIMARY = urlOf(servers.primary);

let srv = null;
try {
  const bootOpts = {
    stores: "settle-fallback-unconfirmed",
    args: ["--import", "./scripts/lib/loopback-only-preload.js", "--import", "./scripts/lib/openrouter-stub-preload.js"],
    env: {
      FREE_MODE: "", NODE_ENV: "test", BASE_URL: "https://agent402.tools", TRUST_PROXY_HOPS: "1",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: PRIMARY, AGENT402_BASE_RPC: `${PRIMARY}/rpc`, EVM_RPC_8453: `${PRIMARY}/rpc`, FACILITATOR_GAS_CHECK: "off",
      SOLVADOR_KEY: "settle-fallback-unconfirmed-key", SOLVADOR_FACILITATOR_URL: urlOf(servers.fallback),
      PAYMENT_SETTLE_FALLBACK: "true", LATE_SETTLE_FILE: LATE,
      // The image tier (a report or media route under the composite guard)
      // runs against the stub; the guard's per-buyer bound is 3, and the
      // settle breaker's is set out of reach so a 429 here is the guard's.
      OPENROUTER_API_KEY: "test-key-never-used", OPENROUTER_MANAGEMENT_KEY: "", OPENROUTER_STUB_URL: PRIMARY, OPENROUTER_FLEX: "off",
      COMPOSITE_GUARD_MAX_FAILS: "3", COMPOSITE_GUARD_WINDOW_MS: "600000", GATEWAY_SETTLE_BREAKER_MAX: "100",
      UPSTREAM_COSTS_FILE: process.env.UPSTREAM_COSTS_FILE || join(process.cwd(), "docs/example-upstream-costs.json"),
      LATE_SETTLE_RECONCILE: "", X402_SYNC_ON_START: "", LATE_SETTLE_RECONCILE_MS: "500", LATE_SETTLE_UNCONFIRMED_PER_PAYER_MAX: "5",
      PENDING_SETTLE_RECEIPT_WAIT_MS: "1000",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", CIRCLE_FACILITATOR_API_KEY: "",
      MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "", POSTHOG_API_KEY: "",
      REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "",
      STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
      MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
      SALES_LEDGER_DB: join(TMP, "sales.db"), REFUND_DB_DIR: TMP, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
    },
  };
  srv = await bootServer(bootOpts);
  let B = srv.url;
  // A wallet-only route (no proof-of-work tier) the settle breaker consults.
  const PATH = "/api/memory";
  const bodyOf = (n = 0) => JSON.stringify({ key: `unconfirmed-${n}`, value: { marker: "stored-value-marker" } });
  const signerFor = () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const payments = new x402Client();
    registerExactEvmScheme(payments, { signer: account });
    return { account, payments };
  };
  const httpOffer = async (path = PATH, body = bodyOf()) => {
    const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    await r.arrayBuffer();
    return JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8"));
  };
  const send = async (header, body = bodyOf(), path = PATH) => {
    const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    const hdr = r.headers.get("payment-response");
    let receipt = null; try { receipt = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) : null; } catch { /* unreadable */ }
    return { status: r.status, text, body: json, receipt, offered: r.headers.get("payment-required"), replayed: r.headers.get("x-replayed-answer"), cache: r.headers.get("cache-control") };
  };
  const pay = async ({ signer = null, path = PATH, body = bodyOf() } = {}) => {
    const sg = signer || signerFor();
    const payload = await sg.payments.createPaymentPayload(await httpOffer(path, body));
    const header = Buffer.from(JSON.stringify(payload)).toString("base64");
    const r = await send(header, body, path);
    return { ...r, header, payer: sg.account.address, nonce: payload.payload.authorization.nonce, validBefore: payload.payload.authorization.validBefore };
  };
  const isoOf = (v) => new Date(Number(v) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const lateEntries = () => { try { return Object.values(JSON.parse(readFileSync(LATE, "utf8")).pending || {}); } catch { return []; } };
  const journalLines = () => { const f = `${LATE}.held.ndjson`; return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []; };
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return !!(await fn()); };
  const bookedFor = (p) => lateEntries().find((e) => String(e.payer || "").toLowerCase() === p.payer.toLowerCase() && String(e.nonce || "").toLowerCase() === String(p.nonce).toLowerCase());
  const snap = () => ({ ...counts });
  const asked = (c0) => `${counts.primary - c0.primary}/${counts.fallback - c0.fallback}`;

  // 1. The fallback stops the chain on an answer that proves nothing.
  for (const [mode, what] of [["500", "an HTTP 500"], ["reset", "a connection reset"], ["tx", "a failure naming a transaction"], ["garbage200", "an HTTP 200 with an unreadable body"]]) {
    st.primary = "billing"; st.fallback = mode;
    const named = mode === "tx";
    const c0 = snap();
    const h = await pay();
    ok(h.status === 402 && asked(c0) === "1/1", `${what} at the fallback: a 402, primary and fallback asked once each (${h.status}, ${asked(c0)})`);
    ok(!h.offered && !Array.isArray(h.body?.accepts) && /no-store/.test(String(h.cache)), `${what}: no offer, not cached`);
    ok(h.body && !NOT_CHARGED.test(h.text) && h.body.reason === "settlement-unconfirmed" && h.body.network === BASE_NET && h.body.error === undefined && h.body.retry !== "other-network",
      `${what}: settlement-unconfirmed, never "not charged", no other way to pay (${h.text.slice(0, 220)})`);
    ok(/Do not sign a new authorization/.test(String(h.body?.hint)) && /booked as owed/.test(String(h.body?.hint)), `${what}: do not sign a new authorization; owed if it lands`);
    ok(named ? (h.body?.retry === "watch-transaction" && JSON.stringify(h.body.transactions) === JSON.stringify([failTxOf(h.nonce)])) : (h.body?.retry === "check-wallet" && !h.body.transactions),
      `${what}: ${named ? "watch-transaction with the transaction" : "check-wallet, no transaction"} (${h.body?.retry})`);
    ok(h.body?.authorizationValidBefore === isoOf(h.validBefore) && String(h.body?.hint).includes(`before ${isoOf(h.validBefore)}`), `${what}: the authorization's validBefore is when a new payment is safe (${h.body?.authorizationValidBefore})`);
    ok(named ? h.body?.refundStatusUrl === `https://agent402.tools/api/refunds?tx=${failTxOf(h.nonce)}` : !("refundStatusUrl" in (h.body || {})), `${what}: refundStatusUrl only with a named transaction (${h.body?.refundStatusUrl})`);
    ok(h.receipt?.success === false && h.receipt.errorReason === "settlement_unconfirmed" && isPreBroadcastSettleRejection(h.receipt) === false && (!named || h.receipt.transaction === failTxOf(h.nonce)),
      `${what}: the receipt reads settlement_unconfirmed (${JSON.stringify(h.receipt).slice(0, 160)})`);
    ok(await waitFor(() => (named ? lateEntries().some((e) => String(e.tx || "").toLowerCase() === failTxOf(h.nonce) && e.unconfirmed === true) : bookedFor(h)?.unconfirmed === true)),
      `${what}: ${named ? "the named transaction" : "the authorization"} is booked for the late-settlement read`);
  }

  // 2. Controls: every settler refuses before sending -> the billing answer,
  // nothing booked; the fallback settles -> one settlement, a 200.
  {
    st.primary = "billing"; st.fallback = "billing";
    const before = lateEntries().length;
    const c0 = snap();
    const h = await pay();
    ok(h.status === 402 && asked(c0) === "1/1" && h.body?.reason === "facilitator-quota" && h.body.retry === "other-network" && isPreBroadcastSettleRejection(h.receipt) === true,
      `control: every settler refused on billing -> the billing answer (${h.body?.reason}/${h.body?.retry})`);
    const again = await send(h.header);
    ok(again.status === 402 && again.replayed !== "1" && counts.verify > c0.verify, "control: that payment sent again is not replayed as unconfirmed");
    await sleep(400);
    ok(lateEntries().length === before, `control: nothing booked (${lateEntries().length - before} new)`);
    st.fallback = "ok";
    const c1 = snap();
    const s = await pay();
    ok(s.status === 200 && asked(c1) === "1/1" && s.receipt?.success === true && !s.body?.reason, `control: the fallback settles once -> 200 (${s.status}, ${asked(c1)})`);
  }

  // 3. A fallback's graceful verdict on the buyer's payment with no
  // transaction keeps the old answer; a used authorization does not.
  for (const [mode, what] of [["verdict", "insufficient_funds"], ["expired-words", "an expiry verdict in words"]]) {
    st.primary = "billing"; st.fallback = mode;
    const before = lateEntries().length;
    const h = await pay();
    ok(h.status === 402 && h.body?.reason === "facilitator-quota" && !("authorizationValidBefore" in h.body), `a fallback's graceful ${what}: the earlier answer stands (${h.body?.reason})`);
    await sleep(300);
    ok(lateEntries().length === before, `a fallback's graceful ${what}: nothing booked`);
  }
  // The same verdict as an HTTP 400 with a parsed body: the earlier answer
  // stands, nothing booked; control: a 400 naming no verdict stays unconfirmed.
  {
    st.primary = "billing"; st.fallback = "verdict400";
    const before = lateEntries().length;
    const h = await pay();
    ok(h.status === 402 && h.body?.reason === "facilitator-quota" && !("authorizationValidBefore" in h.body), `a fallback's HTTP 400 insufficient_funds with no transaction: the earlier answer stands (${h.body?.reason})`);
    await sleep(300);
    ok(lateEntries().length === before, "a fallback's HTTP 400 verdict: nothing booked");
    st.fallback = "undecided400";
    const u = await pay();
    ok(u.status === 402 && u.body?.reason === "settlement-unconfirmed" && await waitFor(() => !!bookedFor(u)), `control: a fallback's HTTP 400 with no verdict stays unconfirmed and booked (${u.body?.reason})`);
  }
  {
    st.primary = "billing"; st.fallback = "used";
    const h = await pay();
    ok(h.status === 402 && h.body?.reason === "settlement-unconfirmed" && h.body.retry === "check-wallet" && await waitFor(() => !!bookedFor(h)), `control: a fallback's "authorization already used" stays unconfirmed and booked (${h.body?.reason})`);
  }

  // 4. One wallet, fourteen calls during the outage: never 429; its bound of
  // bookings (5) in the book, the rest journaled with a line each; served
  // once the facilitators recover.
  {
    st.primary = "billing"; st.fallback = "500";
    const signer = signerFor();
    const got = [];
    for (let i = 0; i < 14; i++) got.push(await pay({ signer }));
    ok(got.every((g) => g.status === 402 && g.body?.reason === "settlement-unconfirmed"), `one wallet, fourteen unconfirmed settles: none refused (${got.map((g) => g.status).join(",")})`);
    const mine = () => lateEntries().filter((e) => String(e.payer).toLowerCase() === signer.account.address.toLowerCase());
    await waitFor(() => mine().length >= 5);
    await sleep(300);
    ok(mine().length === 5 && mine().every((e) => e.unconfirmed === true), `the wallet holds its bound of open bookings (${mine().length} of 14)`);
    const held = journalLines().filter((l) => l.toLowerCase().includes(signer.account.address.toLowerCase()));
    ok(held.length === 9, `past the bound each one is journaled, none dropped (${held.length} journaled)`);
    const lines = srv.log().split("\n").filter((l) => /per-payer bound/.test(l) && l.toLowerCase().includes(signer.account.address.slice(0, 6).toLowerCase()));
    ok(lines.length === 1, `the bookings past the bound are logged once for the wallet inside a minute (${lines.length} lines)`);
    const gs = await (await fetch(`${B}/api/gateway-status`)).json();
    ok(gs?.lateSettlements?.status === "ok" && ["none", "off"].includes(gs?.ledgerDeadLetter?.status), `held bookings that drain by themselves page nothing (${gs?.lateSettlements?.status}, ${gs?.ledgerDeadLetter?.status})`);
    st.fallback = "ok";
    const served = await pay({ signer });
    ok(served.status === 200 && served.receipt?.success === true, `after recovery the same wallet is served (${served.status}) ${served.status === 200 ? "" : served.text.slice(0, 200)}`);
  }

  // 5. The same payment sent again: the unconfirmed answer back, with no
  // verify, no handler run, no settle, never a 429, whatever the body.
  let held;
  {
    st.primary = "billing"; st.fallback = "500";
    held = await pay();
    await waitFor(() => !!bookedFor(held));
    st.fallback = "ok";
    const c0 = snap();
    const more = [];
    for (let i = 0; i < 6; i++) more.push(await send(held.header, bodyOf(i % 2)));
    ok(more.every((r) => r.status === 402 && r.replayed === "1" && r.body?.reason === "settlement-unconfirmed" && r.body.retry === "check-wallet" && !r.offered && !NOT_CHARGED.test(r.text)
      && r.receipt?.errorReason === "settlement_unconfirmed" && /no-store/.test(String(r.cache)) && r.body.authorizationValidBefore === isoOf(held.validBefore) && /Do not sign a new authorization/.test(r.body.hint)),
      `the same payment sent six times (two bodies): the unconfirmed answer each time (${more.map((r) => `${r.status}/${r.body?.reason}`).join(" ")})`);
    ok(counts.verify === c0.verify && asked(c0) === "0/0", `the same payment sent again: no verify, no handler run, no settle (${counts.verify - c0.verify} verifies, ${asked(c0)} settles)`);
    // The same authorization in another encoding: keys reordered and spaced,
    // and with another `resource`. One authorization is one payment.
    const p = JSON.parse(Buffer.from(held.header, "base64").toString("utf8"));
    const { payload: signedPart, ...outer } = p;
    const reencoded = Buffer.from(JSON.stringify({ payload: signedPart, ...outer }, null, 2)).toString("base64");
    const otherResource = Buffer.from(JSON.stringify({ ...p, resource: { ...(p.resource || {}), url: `${B}/api/other-route?x=1` } })).toString("base64");
    const c1 = snap();
    const alt = [await send(reencoded), await send(otherResource), await send(reencoded, bodyOf(7))];
    ok(reencoded !== held.header && otherResource !== held.header && alt.every((r) => r.status === 402 && r.replayed === "1" && r.body?.reason === "settlement-unconfirmed" && r.receipt?.errorReason === "settlement_unconfirmed" && r.body.authorizationValidBefore === isoOf(held.validBefore)),
      `the same authorization re-encoded or naming another resource: the stored answer, never a 429 (${alt.map((r) => `${r.status}/${r.replayed}/${r.body?.reason}`).join(" ")})`);
    ok(counts.verify === c1.verify && asked(c1) === "0/0" && !alt.some((r) => /duplicate_authorization/.test(r.text) || r.receipt?.errorReason === "duplicate_authorization"),
      `re-encoded re-sends: no verify, no handler run, no settle, never duplicate_authorization (${counts.verify - c1.verify} verifies, ${asked(c1)} settles)`);
    const fresh = await pay();
    ok(fresh.status === 200, `another wallet's new payment is served meanwhile (${fresh.status})`);
  }

  // 5b. A report or media route (the composite guard): one wallet through
  // five unconfirmed settles is never refused 429 by the guard; control: a
  // settle refusal that is not unconfirmed counts against the wallet, and the
  // guard refuses it at its bound of 3.
  {
    const IMG = "/v1/images/fast";
    const imgBody = () => JSON.stringify({ prompt: "a red fox in the snow" });
    st.primary = "billing"; st.fallback = "500";
    const signer = signerFor();
    const i0 = counts.images;
    const got = [];
    for (let i = 0; i < 5; i++) got.push(await pay({ signer, path: IMG, body: imgBody() }));
    ok(got.every((g) => g.status === 402 && g.body?.reason === "settlement-unconfirmed" && g.receipt?.errorReason === "settlement_unconfirmed") && counts.images - i0 === 5,
      `a composite route, one wallet, five unconfirmed settles: each ran and was answered unconfirmed, none refused (${got.map((g) => `${g.status}/${g.body?.reason || g.text.slice(0, 60)}`).join(" ")}; ${counts.images - i0} runs)`);
    st.fallback = "ok";
    const served = await pay({ signer, path: IMG, body: imgBody() });
    ok(served.status === 200, `after recovery the same wallet is served on the composite route (${served.status} ${served.status === 200 ? "" : served.text.slice(0, 160)})`);
    st.primary = "used"; st.fallback = "billing";
    const ctl = signerFor();
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await pay({ signer: ctl, path: IMG, body: imgBody() }));
    ok(runs.slice(0, 3).every((r) => r.status === 402 && r.body?.reason !== "settlement-unconfirmed") && runs[3].status === 429 && /from this buyer/.test(runs[3].text),
      `control: settle refusals that are not unconfirmed count against the wallet, refused at the guard's bound (${runs.map((r) => `${r.status}/${r.body?.reason || ""}`).join(" ")})`);
    st.primary = "billing";
  }

  // 5c. The PRIMARY answers pending with a transaction the chain read cannot
  // confirm: the 402 is settlement-unconfirmed / watch-transaction, and the
  // same payment sent again gets that answer back with no verify, no handler
  // run and no settle, never duplicate_authorization (which the settle
  // breaker would count against the wallet).
  {
    st.primary = "pending"; st.fallback = "ok";
    const c0 = snap();
    const h = await pay();
    ok(h.status === 402 && h.body?.reason === "settlement-unconfirmed" && h.body.retry === "watch-transaction" && JSON.stringify(h.body.transactions) === JSON.stringify([failTxOf(h.nonce)]) && counts.fallback === c0.fallback,
      `a primary's pending answer the chain read cannot confirm: settlement-unconfirmed, watch-transaction, no fallback asked (${h.status}/${h.body?.reason}/${h.body?.retry})`);
    st.primary = "ok";
    const c1 = snap();
    const again = [await send(h.header), await send(h.header, bodyOf(3))];
    ok(again.every((r) => r.status === 402 && r.replayed === "1" && r.body?.reason === "settlement-unconfirmed" && r.body.retry === "watch-transaction" && JSON.stringify(r.body.transactions) === JSON.stringify([failTxOf(h.nonce)]) && !r.offered && !NOT_CHARGED.test(r.text)),
      `that payment sent again (two bodies): the stored pending answer (${again.map((r) => `${r.status}/${r.replayed}/${r.body?.reason}`).join(" ")})`);
    ok(counts.verify === c1.verify && asked(c1) === "0/0" && !again.some((r) => /duplicate_authorization/.test(r.text) || r.receipt?.errorReason === "duplicate_authorization"),
      `the pending payment sent again: no verify, no handler run, no settle, never duplicate_authorization (${counts.verify - c1.verify} verifies, ${asked(c1)} settles)`);
    const fresh = await pay();
    ok(fresh.status === 200, `a new payment is served once the primary recovers (${fresh.status})`);
    st.primary = "billing";
  }

  // 6. Its transfer lands: the reconcile books it owed, exactly once, and the
  // same payment sent again still runs nothing.
  {
    const e = bookedFor(held);
    const LANDED = `0x${createHash("sha256").update(`landed:${held.nonce}`).digest("hex")}`;
    const topic = (a) => `0x${String(a).slice(2).toLowerCase().padStart(64, "0")}`;
    chain.used.set(String(held.nonce).toLowerCase(), { tx: LANDED, receipt: { status: "0x1", blockNumber: "0x3e0", transactionHash: LANDED, logs: [
      { address: e.asset, topics: ["0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5", topic(e.payer), String(held.nonce).toLowerCase()], data: "0x" },
      { address: e.asset, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(e.payer), topic(e.payTo)], data: word(e.amount) },
    ] } });
    chain.dark = false;
    ok(await waitFor(() => !bookedFor(held), 60_000), "the reconcile finds the transfer that used the authorization and closes the entry");
    const look = await (await fetch(`${B}/api/refunds?tx=${LANDED}`)).json();
    ok(/owed/i.test(JSON.stringify(look)), `the landed transfer is owed (${JSON.stringify(look).slice(0, 200)})`);
    await sleep(1500);
    const owedLines = srv.log().split("\n").filter((l) => l.includes(`tx ${LANDED} landed after a 402; booked owed`));
    ok(owedLines.length === 1 && !lateEntries().some((x) => String(x.tx || "").toLowerCase() === LANDED || String(x.nonce || "").toLowerCase() === String(held.nonce).toLowerCase()),
      `owed once across further passes, nothing left open for it (${owedLines.length} owed lines)`);
    const c0 = snap();
    const r = await send(held.header);
    ok(r.status === 402 && r.replayed === "1" && counts.verify === c0.verify && asked(c0) === "0/0", `sent again after it landed: nothing run, nothing charged (${r.status})`);
  }

  // 7. The replay relies on the idempotency store. A store that lost the
  // stored answer (here: a restart of a server whose store is its own
  // memory, as a flushed shared store would be) sends the same payment down
  // the normal path: verified, run and settled once. Its booking is still in
  // the late-settlement book, and when the chain shows the authorization
  // used by that settlement, the sale closes the entry: charged once, never
  // also owed.
  {
    st.primary = "billing"; st.fallback = "500";
    const lost = await pay();
    ok(lost.status === 402 && lost.body?.reason === "settlement-unconfirmed" && await waitFor(() => !!bookedFor(lost)), "a payment answered unconfirmed and booked by its authorization");
    ok((await send(lost.header)).replayed === "1", "control: before the store is lost, the same payment is replayed");
    await srv.stop();
    srv = await bootServer(bootOpts);
    B = srv.url;
    st.fallback = "ok";
    const c0 = snap();
    const again = await send(lost.header);
    const T = String(again.receipt?.transaction || "").toLowerCase();
    ok(again.status === 200 && again.replayed !== "1" && again.receipt?.success === true && /^0x[0-9a-f]{64}$/.test(T) && counts.verify - c0.verify === 1 && asked(c0) === "1/1",
      `the store lost: the same payment takes the normal path, verified once and settled once (${again.status}, ${counts.verify - c0.verify} verify, ${asked(c0)} settles)`);
    ok(!!bookedFor(lost), "its booking is still open in the late-settlement book");
    const e = bookedFor(lost);
    const topic = (a) => `0x${String(a).slice(2).toLowerCase().padStart(64, "0")}`;
    chain.used.set(String(lost.nonce).toLowerCase(), { tx: T, receipt: { status: "0x1", blockNumber: "0x3e0", transactionHash: T, logs: [
      { address: e.asset, topics: ["0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5", topic(e.payer), String(lost.nonce).toLowerCase()], data: "0x" },
      { address: e.asset, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(e.payer), topic(e.payTo)], data: word(e.amount) },
    ] } });
    chain.dark = false;
    ok(await waitFor(() => !bookedFor(lost), 60_000), "the reconcile finds the settlement that used the authorization and closes the entry");
    await sleep(1500);
    const owedLines = srv.log().split("\n").filter((l) => l.includes(`tx ${T} landed after a 402; booked owed`));
    const look = await (await fetch(`${B}/api/refunds?tx=${T}`)).json().catch(() => ({}));
    ok(owedLines.length === 0 && !/"owed"/i.test(JSON.stringify(look)), `the served settlement is never also owed (${owedLines.length} owed lines; ${JSON.stringify(look).slice(0, 160)})`);
  }
} catch (e) {
  ok(false, e?.stack || String(e));
  if (srv) console.error(srv.log().slice(-3000));
} finally {
  if (failed && srv) console.error(srv.log().split("\n").filter((l) => /\[payments\]|late-settle|settle/i.test(l)).slice(-40).join("\n"));
  await srv?.stop();
  for (const s of Object.values(servers)) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
