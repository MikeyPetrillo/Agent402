// The signer key for a non-EVM x402 payment (src/non-evm-payer.js), built
// offline from real signed payloads for each rail: no RPC, no broadcast.
// Proves the key is the signer named inside what was signed, is prefixed by
// rail, is never case-folded, and is null for EVM or unreadable payloads.
//
//   node scripts/test-non-evm-payer.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
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
{
  // A transaction with a third signer ahead of the transfer authority: the key
  // is the TransferChecked authority (the wallet whose tokens move), never the
  // first signer that is not the fee payer.
  const kit = await import("@solana/kit");
  const { svmRequiredSigners } = await import("../src/svm-payer.js");
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", CB = "ComputeBudget111111111111111111111111111111", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
  const feePayer = await kit.generateKeyPairSigner(), payTo = await kit.generateKeyPairSigner();
  let buyer = null;
  do buyer = await kit.generateKeyPairSigner(); while (buyer.address === buyer.address.toLowerCase());
  const decoy = await kit.generateKeyPairSigner();
  const src = (await kit.generateKeyPairSigner()).address;
  const blockhash = { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n };
  for (const version of [0, "legacy"]) {
    const ixs = [
      { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, 0x20, 0x4e, 0, 0]) },
      { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(1)]) },
      { programAddress: kit.address(TOKEN), accounts: [
        { address: kit.address(src), role: kit.AccountRole.WRITABLE },
        { address: kit.address(USDC), role: kit.AccountRole.READONLY },
        { address: payTo.address, role: kit.AccountRole.WRITABLE },
        { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer },
        // A writable signer orders ahead of the read-only authority.
        { address: decoy.address, role: kit.AccountRole.WRITABLE_SIGNER, signer: decoy },
      ], data: new Uint8Array([12, ...u64(1000), 6]) },
    ];
    const msg = kit.pipe(kit.createTransactionMessage({ version }),
      (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
      (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => kit.appendTransactionMessageInstructions(ixs, m));
    const tx = kit.getBase64EncodedWireTransaction(await kit.partiallySignTransaction([decoy.keyPair, buyer.keyPair], kit.compileTransaction(msg)));
    const signers = svmRequiredSigners(tx) || [];
    ok(signers.length === 3 && signers[0] === feePayer.address && signers[1] === decoy.address, `${version} message: control: the decoy is the first signer after the fee payer (${signers.length} signers)`);
    const payload = { x402Version: 2, accepted: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: feePayer.address } }, payload: { transaction: tx } };
    const key = await nonEvmPayerFromRequest(reqWith(payload));
    ok(key === `svm:${buyer.address}`, `${version} message: Solana with three signers keys on the transfer authority, case kept (${key === `svm:${decoy.address}` ? "got the decoy" : key})`);
  }
  // A v0 message whose destination sits in an address lookup table, with the
  // decoy co-signer ahead of the authority: the authority is a signer (always a
  // static key), so the key is still the authority, read with no RPC.
  {
    const table = (await kit.generateKeyPairSigner()).address;
    const ixs = [
      { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, 0x20, 0x4e, 0, 0]) },
      { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(1)]) },
      { programAddress: kit.address(TOKEN), accounts: [
        { address: kit.address(src), role: kit.AccountRole.WRITABLE },
        { address: kit.address(USDC), role: kit.AccountRole.READONLY },
        { address: payTo.address, role: kit.AccountRole.WRITABLE },
        { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer },
        { address: decoy.address, role: kit.AccountRole.WRITABLE_SIGNER, signer: decoy },
      ], data: new Uint8Array([12, ...u64(1000), 6]) },
    ];
    const msg = kit.compressTransactionMessageUsingAddressLookupTables(kit.pipe(kit.createTransactionMessage({ version: 0 }),
      (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
      (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => kit.appendTransactionMessageInstructions(ixs, m)), { [table]: [payTo.address] });
    const tx = kit.getBase64EncodedWireTransaction(await kit.partiallySignTransaction([decoy.keyPair, buyer.keyPair], kit.compileTransaction(msg)));
    const { svmTransferAccounts } = await import("../src/svm-payer.js");
    const signers = svmRequiredSigners(tx) || [];
    ok(signers[1] === decoy.address && svmTransferAccounts(tx) === null, "lookup table: control: the decoy is the first signer after the fee payer and the destination is a table entry");
    for (const [label, payload] of [
      ["v2", { x402Version: 2, accepted: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: feePayer.address } }, payload: { transaction: tx } }],
      ["v1", { x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: tx } }],
    ]) {
      const key = await nonEvmPayerFromRequest(reqWith(payload));
      ok(key === `svm:${buyer.address}`, `lookup table, ${label} payload: the key is the transfer authority, not the decoy (${key === `svm:${decoy.address}` ? "got the decoy" : key})`);
    }
  }
  // x402 v1 names Solana by name, not CAIP-2 (@x402/svm V1_TO_V2_NETWORK_MAP):
  // each one is read by the same reader as v2.
  {
    const { V1_TO_V2_NETWORK_MAP } = await import("@x402/svm");
    const ixs = [{ programAddress: kit.address(TOKEN), accounts: [
      { address: kit.address(src), role: kit.AccountRole.WRITABLE },
      { address: kit.address(USDC), role: kit.AccountRole.READONLY },
      { address: payTo.address, role: kit.AccountRole.WRITABLE },
      { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer },
    ], data: new Uint8Array([12, ...u64(1000), 6]) }];
    const msg = kit.pipe(kit.createTransactionMessage({ version: 0 }),
      (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
      (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => kit.appendTransactionMessageInstructions([
        { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, 0x20, 0x4e, 0, 0]) },
        { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(1)]) }, ...ixs], m));
    const tx = kit.getBase64EncodedWireTransaction(await kit.partiallySignTransaction([buyer.keyPair], kit.compileTransaction(msg)));
    const names = Object.keys(V1_TO_V2_NETWORK_MAP || {});
    ok(names.includes("solana"), `control: the installed @x402/svm names v1 Solana networks (${names.join(", ")})`);
    for (const network of names) {
      const key = await nonEvmPayerFromRequest(reqWith({ x402Version: 1, scheme: "exact", network, payload: { transaction: tx } }));
      ok(key === `svm:${buyer.address}`, `v1 network "${network}": the payer key is read (${key})`);
    }
    ok(await nonEvmPayerFromRequest(reqWith({ x402Version: 1, scheme: "exact", network: "solanax", payload: { transaction: tx } })) === null, "a network that only starts with the word is not Solana");
  }
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
