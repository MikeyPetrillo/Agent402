// The signer key for a non-EVM x402 payment (src/non-evm-payer.js), built
// offline from real signed payloads for each rail: no RPC, no broadcast.
// Proves the key is the signer named inside what was signed, is prefixed by
// rail, is never case-folded, and is null for EVM or unreadable payloads.
//
//   node scripts/test-non-evm-payer.js
import algosdk from "algosdk";
import * as sdk from "@stellar/stellar-sdk";
import { nonEvmPayerFromRequest } from "../src/non-evm-payer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const reqWith = (payload) => {
  const v = Buffer.from(JSON.stringify(payload)).toString("base64");
  return { header: (n) => (n === "x-payment" ? v : undefined), headers: { "x-payment": v } };
};

// --- Solana ---------------------------------------------------------------------
{
  const kit = await import("@solana/kit");
  const feePayer = await kit.generateKeyPairSigner();
  const buyer = await kit.generateKeyPairSigner();
  const blockhash = { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n };
  const ix = {
    programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    accounts: [{ address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer }],
    data: new TextEncoder().encode("agent402 test"),
  };
  const msg = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => kit.appendTransactionMessageInstruction(ix, m),
  );
  const tx = kit.getBase64EncodedWireTransaction(await kit.partiallySignTransactionMessageWithSigners(msg));
  const payload = { x402Version: 2, accepted: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: feePayer.address } }, payload: { transaction: tx } };
  ok(await nonEvmPayerFromRequest(reqWith(payload)) === `svm:${buyer.address}`, "Solana: the key is the buyer signer, not the fee payer, case kept");
}

// --- Algorand -------------------------------------------------------------------
{
  const buyer = algosdk.generateAccount();
  const payTo = algosdk.generateAccount();
  const params = { fee: 1000, minFee: 1000, firstValid: 1, lastValid: 1000, genesisID: "mainnet-v1.0", genesisHash: Buffer.from("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "base64"), flatFee: true };
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: buyer.addr, receiver: payTo.addr, amount: 1000, assetIndex: 31566704, suggestedParams: params });
  const signed = txn.signTxn(buyer.sk);
  const addr = buyer.addr.toString();
  const payload = { x402Version: 2, accepted: { network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" }, payload: { paymentGroup: [Buffer.from(signed).toString("base64")], paymentIndex: 0 } };
  ok(await nonEvmPayerFromRequest(reqWith(payload)) === `avm:${addr}`, "Algorand: the key is the sender of the signed payment transaction");
  const unsigned = Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64");
  ok(await nonEvmPayerFromRequest(reqWith({ ...payload, payload: { paymentGroup: [unsigned], paymentIndex: 0 } })) === null, "Algorand: an unsigned transaction names no signer");
}

// --- Stellar --------------------------------------------------------------------
{
  const buyer = sdk.Keypair.random();
  const payTo = sdk.Keypair.random();
  const source = sdk.Keypair.random();
  const contract = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
  const op = sdk.Operation.invokeContractFunction({
    contract, function: "transfer",
    args: [new sdk.Address(buyer.publicKey()).toScVal(), new sdk.Address(payTo.publicKey()).toScVal(), sdk.nativeToScVal(1000n, { type: "i128" })],
  });
  const tx = new sdk.TransactionBuilder(new sdk.Account(source.publicKey(), "1"), { fee: "100", networkPassphrase: sdk.Networks.PUBLIC })
    .addOperation(op).setTimeout(300).build();
  const payload = { x402Version: 2, accepted: { network: "stellar:pubnet" }, payload: { transaction: tx.toXDR() } };
  const got = await nonEvmPayerFromRequest(reqWith(payload));
  ok(got === `stellar:${buyer.publicKey()}`, `Stellar: the key is the transfer's from, not the transaction source (${got})`);
}

// --- not a non-EVM payment ---------------------------------------------------------
ok(await nonEvmPayerFromRequest(reqWith({ x402Version: 2, accepted: { network: "eip155:8453" }, payload: { authorization: { from: "0x" + "a".repeat(40) } } })) === null, "EVM: no key here (payerFromRequest owns that rail)");
ok(await nonEvmPayerFromRequest(reqWith({ x402Version: 2, accepted: { network: "solana:x" }, payload: { transaction: "bm90IGEgdHg=" } })) === null, "an unreadable Solana transaction gives no key");
ok(await nonEvmPayerFromRequest({ header: () => undefined, headers: {} }) === null, "no payment header gives no key");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
