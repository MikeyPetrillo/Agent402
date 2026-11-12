// The buyer behind a Solana x402 payment is read from the transaction it
// signed, so verify_failed's payer id groups one wallet's retries.
//
// Measured 2026-09-03/04: ~200 Solana verify failures an hour, every one the
// token program's InsufficientFunds, and 197 distinct payer ids for 197 events
// - because the SVM fallback keyed on the credential, and a Solana credential
// is a fresh transaction (new memo nonce) per attempt. One empty wallet looping
// and two hundred wallets hitting a fault of ours were indistinguishable.
//
// Transactions here are built by @solana/kit itself (the same builder the
// scheme client and solana-buyer.js use), never hand-assembled, so the walk is
// proven against the real wire layout for BOTH message versions.
//   node scripts/test-svm-payer.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFile } from "node:fs/promises";
import { svmRequiredSigners, svmPayerFromPayload, base58Encode, svmSignedTransfer, svmTransferAccounts, svmTransferAuthority, svmPaymentAuthority, isSvmNetwork } from "../src/svm-payer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const kit = await import("@solana/kit");

// --- base58, against kit's own codec ------------------------------------------
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
ok(base58Encode(kit.getAddressEncoder().encode(kit.address(USDC))) === USDC, "base58 round-trips a real address through kit's encoder");
ok(base58Encode(new Uint8Array(32)) === "1".repeat(32), "leading zero bytes become leading 1s");

// --- a real partially-signed transaction, both message versions ----------------
const feePayer = await kit.generateKeyPairSigner();   // the facilitator's key, unsigned by the buyer
const buyer = await kit.generateKeyPairSigner();      // the wallet whose USDC moves
const bystander = await kit.generateKeyPairSigner();  // a non-signer account in the instruction
const blockhash = { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n };
async function build(version) {
  const ix = {
    programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    accounts: [
      { address: bystander.address, role: kit.AccountRole.READONLY },
      { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer },
    ],
    data: new TextEncoder().encode("agent402 test"),
  };
  const msg = kit.pipe(
    kit.createTransactionMessage({ version }),
    (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => kit.appendTransactionMessageInstruction(ix, m),
  );
  const signed = await kit.partiallySignTransactionMessageWithSigners(msg);
  return kit.getBase64EncodedWireTransaction(signed);
}
for (const version of [0, "legacy"]) {
  const tx = await build(version);
  const signers = svmRequiredSigners(tx);
  ok(Array.isArray(signers) && signers.length === 2 && signers[0] === feePayer.address && signers[1] === buyer.address,
    `${version} message: required signers are [feePayer, buyer] in account order (${JSON.stringify(signers)})`);
  ok(!signers.includes(bystander.address), `${version} message: a non-signer account is never reported as a signer`);
  const payload = { x402Version: 2, payload: { transaction: tx }, accepted: { extra: { feePayer: feePayer.address } } };
  ok(svmPayerFromPayload(payload, { feePayer: feePayer.address }) === buyer.address, `${version} message: the buyer is the signer that is not the fee payer`);
  ok(svmPayerFromPayload(payload) === buyer.address, `${version} message: with no fee payer named, the second signer is the buyer`);
  ok(svmPayerFromPayload(payload, { feePayer: buyer.address }) === feePayer.address, `${version} message: exclusion is by address, not position`);
}

// --- shape guards: null, never a throw, never a guess --------------------------
for (const junk of [null, undefined, "", "!!!", "AAAA", "gA==", Buffer.alloc(300).toString("base64"), { payload: {} }, { payload: { transaction: 42 } }]) {
  let out;
  try { out = typeof junk === "object" && junk !== null ? svmPayerFromPayload(junk) : svmRequiredSigners(junk); } catch (e) { out = `threw ${e.message}`; }
  ok(out === null, `junk input ${String(JSON.stringify(junk)).slice(0, 30)} -> null`);
}
// A signature count that disagrees with the header is not a transaction we understand.
{
  const tx = Buffer.from(await build(0), "base64");
  tx[0] = 3; // claims three signatures; the header still says two
  ok(svmRequiredSigners(tx.toString("base64")) === null, "a signature count that contradicts the header is refused");
}

// --- the transfer authority's signature, checked here --------------------------
// svmSignedTransfer answers only when the TransferChecked authority is a
// required signer AND its ed25519 signature over the message verifies.
{
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", CB = "ComputeBudget111111111111111111111111111111";
  const payTo = await kit.generateKeyPairSigner();
  const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
  const src = (await kit.generateKeyPairSigner()).address;
  // authority: "signs" (signer slot, signed), "slot" (signer slot, never signed), "named" (no signer slot)
  async function transfer(version, authority, amount = 4321) {
    const role = authority === "named" ? kit.AccountRole.READONLY : kit.AccountRole.READONLY_SIGNER;
    const ixs = [
      { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, 0x20, 0x4e, 0, 0]) },
      { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(1)]) },
      { programAddress: kit.address(TOKEN), accounts: [
        { address: kit.address(src), role: kit.AccountRole.WRITABLE },
        { address: kit.address(USDC), role: kit.AccountRole.READONLY },
        { address: payTo.address, role: kit.AccountRole.WRITABLE },
        authority === "signs" ? { address: buyer.address, role, signer: buyer } : { address: buyer.address, role },
      ], data: new Uint8Array([12, ...u64(amount), 6]) },
    ];
    const msg = kit.pipe(kit.createTransactionMessage({ version }),
      (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
      (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => kit.appendTransactionMessageInstructions(ixs, m));
    const compiled = kit.compileTransaction(msg);
    const signed = authority === "signs" ? await kit.partiallySignTransaction([buyer.keyPair], compiled) : compiled;
    return kit.getBase64EncodedWireTransaction(signed);
  }
  for (const version of [0, "legacy"]) {
    const tx = await transfer(version, "signs");
    const t = svmSignedTransfer(tx);
    ok(t && t.authority === buyer.address && t.source === src && t.amount === 4321n, `${version} message: a signed transfer reads with its amount (${t && t.amount})`);
    const slot = await transfer(version, "slot");
    ok(svmTransferAccounts(slot)?.authority === buyer.address && svmSignedTransfer(slot) === null, `${version} message: a signer slot left unsigned reads as null`);
    const named = await transfer(version, "named");
    ok(svmTransferAccounts(named)?.authority === buyer.address && svmSignedTransfer(named) === null, `${version} message: an authority that is not a required signer reads as null`);
    const sigFlip = Buffer.from(tx, "base64");
    sigFlip[1 + 64 + 10] ^= 0x01; // the buyer's signature (slot 1; slot 0 is the fee payer's)
    ok(svmSignedTransfer(sigFlip.toString("base64")) === null, `${version} message: a forged signature reads as null`);
    const msgFlip = Buffer.from(tx, "base64");
    msgFlip[msgFlip.length - 3] ^= 0x01; // a byte of the transfer amount, after signing
    ok(svmSignedTransfer(msgFlip.toString("base64")) === null, `${version} message: a message changed after signing reads as null`);
    const otherKey = Buffer.from(tx, "base64");
    otherKey.fill(0, 1, 65); // the fee payer's slot (it signs later, at settle)
    ok(svmSignedTransfer(otherKey.toString("base64"))?.authority === buyer.address, `${version} message: the fee payer's empty slot does not matter, only the authority's`);
  }
  for (const junk of [null, "", "AAAA", Buffer.alloc(300).toString("base64"), "A".repeat(5000)]) {
    let out; try { out = svmSignedTransfer(junk); } catch (e) { out = `threw ${e.message}`; }
    ok(out === null, `svmSignedTransfer junk ${String(junk).slice(0, 12)} -> null`);
  }
}

// --- the transfer authority with lookup-table accounts and a decoy co-signer ----
// A v0 message may name the transfer's source, mint and destination through an
// address lookup table; the authority is a signer, and signers are always
// static keys, so it still reads with no RPC. A co-signer ahead of it in the
// signer order is never the key.
{
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", CB = "ComputeBudget111111111111111111111111111111";
  const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
  const payTo = (await kit.generateKeyPairSigner()).address, src = (await kit.generateKeyPairSigner()).address;
  const decoy = await kit.generateKeyPairSigner();
  const table = (await kit.generateKeyPairSigner()).address;
  const fp = await kit.generateKeyPairSigner();
  // authority: "signs" (signer), "named" (no signer slot), "none" (no transfer at all)
  async function altTx({ inTable, authority = "signs", second = null }) {
    const transferIx = (who) => ({ programAddress: kit.address(TOKEN), accounts: [
      { address: kit.address(src), role: kit.AccountRole.WRITABLE },
      { address: kit.address(USDC), role: kit.AccountRole.READONLY },
      { address: kit.address(payTo), role: kit.AccountRole.WRITABLE },
      authority === "named" ? { address: who.address, role: kit.AccountRole.READONLY } : { address: who.address, role: kit.AccountRole.READONLY_SIGNER, signer: who },
      { address: decoy.address, role: kit.AccountRole.WRITABLE_SIGNER, signer: decoy },
    ], data: new Uint8Array([12, ...u64(1000), 6]) });
    const memo = { programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [{ address: decoy.address, role: kit.AccountRole.WRITABLE_SIGNER, signer: decoy }, { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer }], data: new TextEncoder().encode("x") };
    const ixs = [
      { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, 0x20, 0x4e, 0, 0]) },
      { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(1)]) },
      authority === "none" ? memo : transferIx(buyer),
      ...(second ? [transferIx(second)] : []),
    ];
    let msg = kit.pipe(kit.createTransactionMessage({ version: 0 }),
      (m) => kit.setTransactionMessageFeePayer(fp.address, m),
      (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => kit.appendTransactionMessageInstructions(ixs, m));
    if (inTable.length) msg = kit.compressTransactionMessageUsingAddressLookupTables(msg, { [table]: inTable.map((a) => kit.address(a)) });
    const signers = [decoy.keyPair, ...(authority === "named" ? [] : [buyer.keyPair]), ...(second ? [second.keyPair] : [])];
    return kit.getBase64EncodedWireTransaction(await kit.partiallySignTransaction(signers, kit.compileTransaction(msg)));
  }
  const asPayload = (tx) => ({ x402Version: 2, accepted: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: fp.address } }, payload: { transaction: tx } });
  const destInTable = await altTx({ inTable: [payTo] });
  const signers = svmRequiredSigners(destInTable) || [];
  ok(signers[1] === decoy.address && signers.includes(buyer.address), "control: the decoy is the first signer after the fee payer");
  ok(svmTransferAccounts(destInTable) === null, "control: the destination sits in the lookup table, so the four-account read is null");
  ok(svmTransferAuthority(destInTable)?.authority === buyer.address, "destination in a lookup table: the authority still reads from the static keys");
  ok(svmPaymentAuthority(asPayload(destInTable), { feePayer: fp.address }) === buyer.address, `destination in a lookup table plus a decoy co-signer: the payer is the authority (${svmPaymentAuthority(asPayload(destInTable), { feePayer: fp.address }) === decoy.address ? "got the decoy" : "ok"})`);
  const threeInTable = await altTx({ inTable: [payTo, src, USDC] });
  ok(svmPaymentAuthority(asPayload(threeInTable), { feePayer: fp.address }) === buyer.address, "source, mint and destination all in a lookup table: the payer is the authority");
  const staticTx = await altTx({ inTable: [] });
  ok(svmPaymentAuthority(asPayload(staticTx), { feePayer: fp.address }) === buyer.address && svmTransferAccounts(staticTx)?.authority === buyer.address, "all static: the authority, and the four-account read agrees");
  const named = await altTx({ inTable: [payTo], authority: "named" });
  const namedGot = svmPaymentAuthority(asPayload(named), { feePayer: fp.address });
  ok(namedGot === buyer.address, `an authority that is a static key but not a signer (an SPL multisig account) is the payer, never the co-signer (${namedGot === decoy.address ? "got the decoy" : namedGot})`);
  const namedInTable = await altTx({ inTable: [payTo, buyer.address], authority: "named" });
  ok(svmPaymentAuthority(asPayload(namedInTable), { feePayer: fp.address }) === null, "an authority that is a lookup-table entry gives no payer, never the co-signer");
  // A header that claims more signers than there are static keys: account 3
  // at index 2 of a two-key message would read the recent blockhash's bytes.
  {
    const enc = kit.getAddressEncoder();
    const bh = new Uint8Array(32).fill(7);
    const raw = (numReq) => {
      const sigCount = numReq;
      const keys = [enc.encode(kit.address(fp.address)), enc.encode(kit.address(TOKEN))];
      const ix = [1, 4, 0, 0, 0, 2, 10, 12, ...u64(1000), 6];
      const bytes = [sigCount, ...new Array(64 * sigCount).fill(0), numReq, 0, 1, keys.length, ...keys.flatMap((k) => [...k]), ...bh, 1, ...ix];
      return Buffer.from(bytes).toString("base64");
    };
    ok(svmTransferAuthority(raw(2))?.authority === base58Encode(bh) || svmTransferAuthority(raw(2))?.found === true, "control: the same layout with a valid header reads a transfer");
    ok(svmTransferAuthority(raw(3)) === null, `a header claiming more signers than static keys is malformed, never the blockhash as authority (${JSON.stringify(svmTransferAuthority(raw(3)))})`);
    ok(svmPaymentAuthority({ payload: { transaction: raw(3) } }) === null, "and gives no payer");
  }
  const other = await kit.generateKeyPairSigner();
  const twoAuth = await altTx({ inTable: [payTo], second: other });
  ok(svmPaymentAuthority(asPayload(twoAuth), { feePayer: fp.address }) === null, "two transfers with different authorities give no payer");
  const sameTwice = await altTx({ inTable: [payTo], second: buyer });
  ok(svmPaymentAuthority(asPayload(sameTwice), { feePayer: fp.address }) === buyer.address, "two transfers with the same authority give that authority");
  const noTransfer = await altTx({ inTable: [], authority: "none" });
  ok(svmTransferAuthority(noTransfer)?.found === false && svmPaymentAuthority(asPayload(noTransfer), { feePayer: fp.address }) === decoy.address, "no transfer at all: the signer order still names a payer");
  for (const junk of [null, "", "AAAA", Buffer.alloc(300).toString("base64"), "A".repeat(5000), { toString: 1 }]) {
    let out; try { out = svmPaymentAuthority({ payload: { transaction: junk } }); } catch (e) { out = `threw ${e.message}`; }
    ok(out === null, `svmPaymentAuthority junk ${typeof junk === "string" ? junk.slice(0, 12) : typeof junk} -> null`);
  }
}

// --- network names: v2 CAIP-2 and the x402 v1 names ------------------------------
{
  const pkg = await import("@x402/svm");
  const v1Names = Object.keys(pkg.V1_TO_V2_NETWORK_MAP || {});
  ok(v1Names.length >= 2 && v1Names.every((n) => isSvmNetwork(n)), `every v1 Solana network name of the installed @x402/svm reads as Solana (${v1Names.join(", ")})`);
  ok(Object.values(pkg.V1_TO_V2_NETWORK_MAP).every((n) => isSvmNetwork(n)), "and so does every CAIP-2 id it maps to");
  ok(!isSvmNetwork("eip155:8453") && !isSvmNetwork("solanax") && !isSvmNetwork("") && !isSvmNetwork(null) && !isSvmNetwork({ toString: () => "solana" }), "other networks and non-strings do not");
}

// --- the wiring in payments.js is pinned from source ---------------------------
const payments = await readFile("src/payments.js", "utf8");
const derive = payments.slice(payments.indexOf("let payerKey = null;"), payments.indexOf("capturePostHogVerifyFailed({"));
ok(/svmPaymentAuthority\(ctx\?\.paymentPayload, \{ feePayer: ctx\?\.requirements\?\.extra\?\.feePayer \}\)/.test(derive),
  "recordVerifyFailure asks svm-payer.js for the transfer authority, with the accept's fee payer");
ok(/basis = `svm-payer:\$\{svm\}`/.test(derive), "the SVM buyer becomes the HMAC basis");
ok(derive.indexOf("svm-payer:") < derive.indexOf("credentialKeyOf"), "and it is tried BEFORE the per-credential fallback, else every retry is a new id");
ok(!/svm\)\.toLowerCase|svm\.toLowerCase/.test(derive), "base58 is never case-folded");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
