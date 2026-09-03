// One-purpose funding sender: move a small amount of USDC on Solana from the
// CI canary burner to the DEDICATED SVM spending wallet behind Solana
// external routing (src/solana-buyer.js).
//
// The control design is stronger than an allowlist: the destination is
// COMPILED IN and there is no input that names an address at all. The only
// inputs are the amount (hard-capped at $5 in code, no input can raise it)
// and the send flag (dry run by default). The workflow that runs this sits
// behind the refund-approval environment, so even a modified-branch dispatch
// waits for the operator's click.
//
// A fresh wallet has no USDC token account yet, so the transfer prepends the
// idempotent create-ATA instruction (burner pays the rent, ~0.002 SOL) - safe
// to repeat, a no-op once the account exists.
import * as kit from "@solana/kit";
import { getTransferInstruction, getCreateAssociatedTokenIdempotentInstruction, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

const DESTINATION = "8KqQG8MefNvQEQmp9gBjov39DXcWsUpSeqjL9pPCGKKE"; // the SVM spending wallet (SOLANA_UPSTREAM_BUYER_KEY's address)
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ABSOLUTE_MAX_USD = 5;
const RPC = (process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();

const USD = Number(process.env.USD || "0");
const SEND = process.env.SEND === "true";
if (!(USD > 0)) { console.error("USD must be a positive amount"); process.exit(1); }
if (USD > ABSOLUTE_MAX_USD) { console.error(`refusing: $${USD} exceeds the compiled $${ABSOLUTE_MAX_USD} ceiling (no input raises it)`); process.exit(1); }
const units = BigInt(Math.round(USD * 1e6));

const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) {
    const detail = j.error.data ? ` ${JSON.stringify(j.error.data).slice(0, 600)}` : "";
    throw new Error(`${method}: ${j.error.message}${detail}`);
  }
  return j.result;
};

// Every check runs BEFORE the signing key is read (the refund sender's rule).
const destAccounts = await rpc("getTokenAccountsByOwner", [DESTINATION, { mint: USDC_MINT }, { encoding: "jsonParsed" }]);
const destHas = Number(destAccounts?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
console.log(`destination ${DESTINATION}`);
console.log(`destination current USDC: ${destHas}`);

const raw = (process.env.SOLANA_BURNER_KEY || "").trim();
if (!raw) { console.error("SOLANA_BURNER_KEY is not set"); process.exit(1); }
const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
const signer = await kit.createKeyPairSignerFromBytes(bytes);
console.log(`burner (source): ${signer.address}`);

const srcAccounts = await rpc("getTokenAccountsByOwner", [signer.address, { mint: USDC_MINT }, { encoding: "jsonParsed" }]);
const src = srcAccounts?.value?.[0];
const srcBal = Number(src?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
console.log(`burner USDC balance: ${srcBal}`);
if (!src || srcBal < USD) { console.error(`refusing: burner holds ${srcBal} USDC, need ${USD}`); process.exit(1); }

const [destAta] = await findAssociatedTokenPda({ mint: kit.address(USDC_MINT), owner: kit.address(DESTINATION), tokenProgram: TOKEN_PROGRAM_ADDRESS });
console.log(`destination ATA: ${destAta}${destHas === 0 ? " (will be created, burner pays rent)" : ""}`);
console.log(`plan: send ${USD} USDC (${units} units) burner -> spending wallet`);
if (!SEND) { console.log("DRY RUN - nothing sent (dispatch with send: true to broadcast)"); process.exit(0); }

const { value: blockhash } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]).then((r) => ({ value: r.value ?? r }));
const memoBytes = new TextEncoder().encode("Funding the Agent402 SVM spending wallet (Solana external routing)");
const instructions = [
  getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destAta, owner: kit.address(DESTINATION), mint: kit.address(USDC_MINT) }),
  getTransferInstruction({ source: kit.address(src.pubkey), destination: destAta, authority: signer, amount: units }),
  { programAddress: kit.address(MEMO_PROGRAM), accounts: [{ address: signer.address, role: kit.AccountRole.READONLY_SIGNER }], data: memoBytes },
];
const message = kit.pipe(
  kit.createTransactionMessage({ version: 0 }),
  (m) => kit.setTransactionMessageFeePayerSigner(signer, m),
  (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) => kit.appendTransactionMessageInstructions(instructions, m),
);
const signed = await kit.signTransactionMessageWithSigners(message);
const sig = kit.getSignatureFromTransaction(signed);
const wire = kit.getBase64EncodedWireTransaction(signed);
const sendOnce = () => rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
try { await sendOnce(); }
catch (err) {
  // Same-bytes retry only - a duplicate broadcast is the SAME transaction.
  if (!/Blockhash not found|simulation failed/i.test(String(err.message))) throw err;
  console.warn(`preflight refused (${String(err.message).slice(0, 120)}) - retrying once in 3s`);
  await new Promise((r) => setTimeout(r, 3000));
  await sendOnce();
}
console.log(`SENT ${USD} USDC -> ${DESTINATION}`);
console.log(`signature: ${sig}`);
console.log(`https://solscan.io/tx/${sig}`);
// Confirm on-chain before reporting success - a broadcast is not a landing.
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = await rpc("getSignatureStatuses", [[String(sig)], { searchTransactionHistory: true }]).catch(() => null);
  const s = st?.value?.[0];
  if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
    if (s.err) { console.error(`CONFIRMED BUT FAILED on-chain: ${JSON.stringify(s.err)}`); process.exit(1); }
    console.log(`confirmed (${s.confirmationStatus})`); process.exit(0);
  }
}
console.error("broadcast went out but confirmation was not observed in 30s - check the signature on solscan before retrying");
process.exit(1);
