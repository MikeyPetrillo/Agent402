// One-time SPL USDC transfer on Solana, for refunds the refund runner cannot
// pay. `senders.solana` is hardcoded false in scripts/refund-run.js (no SVM
// spending wallet), so debts on that chain are recorded and held. This sends
// one, deliberately, under the same discipline the runner uses.
//
// Dry by default: it prints what it would do and exits. --send is the only
// thing that broadcasts.
//
//   SOLANA_BURNER_KEY=... node scripts/solana-refund-send.js --to <addr> --usd 1.60
//   ... --send        # actually broadcast
//
// Guards, each of which refuses rather than guesses:
//   * the destination must ALREADY hold a USDC token account. We are refunding
//     someone who paid us in USDC on Solana, so they have one; needing to
//     create it would mean the address is wrong.
//   * a hard ceiling (--max, default $5) no single run may exceed
//   * the burner must hold the amount plus a SOL fee reserve
//   * the transfer amount is integer base units, never a float
import { createHash } from "node:crypto";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// SPL Memo v2. Built by hand rather than adding a dependency: the instruction
// is a program id, optional signer accounts and UTF-8 bytes. Listing our own
// signer makes the memo attributable - Solscan shows it as signed by the
// sender, so the recipient can tell the note really came from us and not from
// anyone who happened to transfer them dust.
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
// A memo shares the transaction's size budget and is PUBLIC and PERMANENT.
const MEMO_MAX_BYTES = 400;
// A ceiling the DISPATCHER cannot raise. --max is an input, so it bounds
// nothing against someone who can set inputs; this is the bound that holds.
// $2, matching refund-run's own per-run cap: the one debt this script exists
// for is $1.60, and a bigger send should mean editing this line in a reviewed
// commit, never a bigger number in a dispatch box.
const ABSOLUTE_MAX_USD = 2;
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const SEND = process.argv.includes("--send");
const TO = String(arg("to", "")).trim();
const USD = Number(arg("usd", "0"));
const MAX = Number(arg("max", "5"));
const MEMO = String(arg("memo", "")).trim();
const EVIDENCE = String(arg("evidence", "")).trim();
const OPERATOR = (process.env.AGENT402_OPERATOR_TOKEN || "").trim();

if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(TO)) { console.error("--to must be a base58 Solana address"); process.exit(2); }
if (!(USD > 0)) { console.error("--usd must be positive"); process.exit(2); }
if (USD > MAX) { console.error(`--usd ${USD} exceeds the ceiling $${MAX}; raise --max deliberately if that is intended`); process.exit(2); }
if (USD > ABSOLUTE_MAX_USD) { console.error(`--usd ${USD} exceeds the hard ceiling $${ABSOLUTE_MAX_USD} compiled into this script`); process.exit(2); }
const memoBytes = MEMO ? new TextEncoder().encode(MEMO) : null;
if (memoBytes && memoBytes.length > MEMO_MAX_BYTES) {
  console.error(`--memo is ${memoBytes.length} bytes, over the ${MEMO_MAX_BYTES} cap`); process.exit(2);
}

const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) {
    // The generic message ("Transaction simulation failed") is useless without
    // the payload - err + program logs live in error.data, and discarding them
    // cost a full diagnose-reproduce cycle on 2026-09-01.
    const detail = j.error.data ? ` ${JSON.stringify(j.error.data).slice(0, 600)}` : "";
    throw new Error(`${method}: ${j.error.message}${detail}`);
  }
  return j.result;
};

// PROOF THAT THE DESTINATION IS A REAL PAYER.
//
// Without this, --to is free text: anyone who can dispatch the workflow could
// send the burner's balance to their own wallet. Repo write access is already
// required, but "send money anywhere" should not be one input away, and --max
// is itself an input so it bounds nothing against that person.
//
// So the destination must be proven on-chain to have PAID US, using the same
// doctrine scripts/refund-run.js uses before every send: name a settlement
// transaction, and re-derive it from the chain. Our payTo is read from our own
// LIVE 402 rather than hardcoded, so it cannot drift or be planted here.
if (!EVIDENCE) { console.error("--evidence <signature> is required: a settlement tx proving this address paid us"); process.exit(2); }

const accepts = await (await fetch("https://agent402.tools/api/hash")).headers;
const header = accepts.get("payment-required") || "";
let payTo = null, asset = null;
try {
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const svm = (decoded.accepts || []).find((a) => String(a.network || "").toLowerCase().includes("solana"));
  payTo = svm?.payTo || null; asset = svm?.asset || null;
} catch { /* handled below */ }
if (!payTo || asset !== USDC_MINT) { console.error("could not read our own Solana payTo from a live 402 - refusing"); process.exit(1); }
console.log(`our payTo (from a live 402): ${payTo}`);

const evTx = await rpc("getTransaction", [EVIDENCE, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
if (!evTx) { console.error(`evidence tx ${EVIDENCE} not found on chain`); process.exit(1); }
if (evTx.meta?.err) { console.error("evidence tx failed on chain - it moved nothing"); process.exit(1); }
// Compare per OWNER, not per token account: a payer may use a non-default
// account, so matching derived addresses would miss a real payment.
const pre = evTx.meta?.preTokenBalances || [], post = evTx.meta?.postTokenBalances || [];
const delta = (owner) => {
  const p = post.find((b) => b.owner === owner && b.mint === USDC_MINT);
  const q = pre.find((b) => b.owner === owner && b.mint === USDC_MINT);
  return Number(p?.uiTokenAmount?.uiAmount ?? 0) - Number(q?.uiTokenAmount?.uiAmount ?? 0);
};
const paidIn = delta(payTo), paidOut = delta(TO);
if (!(paidIn > 0)) { console.error(`evidence tx did not credit our payTo ${payTo} in USDC`); process.exit(1); }
if (!(paidOut < 0)) { console.error(`evidence tx does not show ${TO} paying - refusing to refund an address that never paid us`); process.exit(1); }
console.log(`evidence: ${EVIDENCE} moved ${(-paidOut).toFixed(6)} USDC from ${TO} to our payTo (+${paidIn.toFixed(6)})`);


// AMOUNT BOUND: never more than the ledger says this payer is OWED.
//
// The evidence check above proves the destination is a real payer. It says
// NOTHING about how much. Without this, anyone who can dispatch could buy a
// $0.001 tool to register their wallet as "provably a payer" and then have
// the full ceiling sent to it. Being a customer must not be a withdrawal
// credential.
//
// So the refund is capped by this payer's own owed rows in the refund ledger,
// which only ever gets rows from settlements we actually recorded. Someone who
// paid us $0.001 is owed $0.001 and can be sent $0.001. That makes the attack
// identical to "get your own money back", which is what a refund is.
if (!OPERATOR) { console.error("AGENT402_OPERATOR_TOKEN is required to read what this payer is owed"); process.exit(2); }
const ledger = await fetch("https://agent402.tools/__operator/refunds.json?status=owed", {
  headers: { Authorization: `Bearer ${OPERATOR}` },
});
if (!ledger.ok) { console.error(`could not read the refund ledger (HTTP ${ledger.status}) - refusing`); process.exit(1); }
let owedRows = (await ledger.json()).refunds || [];
// --reclaim-sending: include rows a PRIOR run of this script claimed and then
// failed to pay - ONLY after a human verified on-chain that the earlier
// attempt moved nothing. Folded in HERE, before the amount bound, because the
// first version reclaimed only at the claim step: the bound then read $0 owed
// (everything sat in `sending`) and refused its own retry.
const RECLAIM = process.argv.includes("--reclaim-sending");
if (RECLAIM) {
  const all = await fetch("https://agent402.tools/__operator/refunds.json?status=all", {
    headers: { Authorization: `Bearer ${OPERATOR}` },
  });
  if (!all.ok) { console.error(`could not read the full ledger (HTTP ${all.status})`); process.exit(1); }
  const stuck = ((await all.json()).refunds || []).filter(
    (r) => r.status === "sending" && String(r.payer || "") === TO && /solana-refund-send/.test(String(r.note || ""))
  );
  console.log(`reclaim: including ${stuck.length} row(s) this script previously claimed`);
  owedRows = owedRows.concat(stuck);
}
const owedToThem = owedRows
  .filter((r) => String(r.payer || "") === TO)
  .reduce((a, r) => a + (Number(r.priceUsd) || 0), 0);
console.log(`ledger says ${TO} is owed $${owedToThem.toFixed(6)} across ${owedRows.filter((r) => String(r.payer || "") === TO).length} row(s)`);
if (owedToThem <= 0) { console.error("the ledger records no owed debt for this address - refusing"); process.exit(1); }
if (USD > owedToThem + 1e-9) {
  console.error(`--usd ${USD} exceeds the $${owedToThem.toFixed(6)} this payer is owed - refusing`);
  process.exit(1);
}

const raw = (process.env.SOLANA_BURNER_KEY || "").trim();
if (!raw) { console.error("SOLANA_BURNER_KEY is required"); process.exit(2); }

const kit = await import("@solana/kit");
const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
const signer = await kit.createKeyPairSignerFromBytes(bytes);
const FROM = String(signer.address);

const units = BigInt(Math.round(USD * 1e6)); // USDC is 6dp; integer base units only
console.log(`from: ${FROM}`);
console.log(`to:   ${TO}`);
console.log(`send: ${USD} USDC (${units} base units)  ceiling $${MAX}`);
if (MEMO) console.log(`memo: ${MEMO}\n      (${memoBytes.length} bytes, public and permanent on-chain)`);

const accountsOf = async (owner) =>
  (await rpc("getTokenAccountsByOwner", [owner, { mint: USDC_MINT }, { encoding: "jsonParsed" }])).value;

const [srcAccts, dstAccts] = await Promise.all([accountsOf(FROM), accountsOf(TO)]);
if (!srcAccts.length) { console.error("the burner holds no USDC token account"); process.exit(1); }
if (!dstAccts.length) {
  // Refusing rather than creating one: the recipient paid us in USDC on
  // Solana, so an absent account means the destination is not who we think.
  console.error("the destination holds no USDC token account - refusing (a payer of USDC would have one; check the address)");
  process.exit(1);
}
const src = srcAccts[0], dst = dstAccts[0];
const have = BigInt(src.account.data.parsed.info.tokenAmount.amount);
console.log(`burner USDC: ${src.account.data.parsed.info.tokenAmount.uiAmountString} (ata ${src.pubkey})`);
console.log(`dest   USDC: ${dst.account.data.parsed.info.tokenAmount.uiAmountString} (ata ${dst.pubkey})`);
if (have < units) { console.error(`burner holds ${have} base units, needs ${units}`); process.exit(1); }

const lamports = await rpc("getBalance", [FROM]);
console.log(`burner SOL:  ${(lamports.value ?? lamports) / 1e9}`);
if ((lamports.value ?? lamports) < 1_000_000) { console.error("burner SOL is too low to pay the fee"); process.exit(1); }

if (!SEND) { console.log("\nDRY RUN - nothing broadcast. Re-run with --send to transfer."); process.exit(0); }

// CLAIM BEFORE SEND - the double-refund window, closed the same way
// refund-run.js closed it on 2026-08-04. Without this, a second run reads the
// same still-owed rows and sends again: the inbound payment verifies forever,
// so nothing else stops it. `claim` moves owed -> sending atomically and only
// one caller can win a row, so a concurrent or repeated run claims nothing,
// falls short of the amount, and aborts without broadcasting.
//
// A row stuck in `sending` afterwards is DELIBERATE: whether money left is a
// question for a human, never for a retry.
const myRows = owedRows.filter((r) => String(r.payer || "") === TO);
const claimed = [];
for (const r of myRows) {
  const c = await fetch("https://agent402.tools/__operator/refunds/update", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
    body: JSON.stringify({ id: r.id, action: "claim", note: `solana-refund-send ${new Date().toISOString()}` }),
  });
  if (c.ok || (RECLAIM && r.status === "sending")) claimed.push(r);
}
const claimedUsd = claimed.reduce((a, r) => a + (Number(r.priceUsd) || 0), 0);
console.log(`claimed ${claimed.length}/${myRows.length} owed row(s) = $${claimedUsd.toFixed(6)}`);
if (USD > claimedUsd + 1e-9) {
  console.error(`could only claim $${claimedUsd.toFixed(6)} of the $${USD} requested - another run may hold the rest. ABORTING with nothing sent; the ${claimed.length} claimed row(s) are now in 'sending' and need a human (ids: ${claimed.map((r) => r.id).join(", ")})`);
  process.exit(1);
}

const { getTransferInstruction } = await import("@solana-program/token");
const rpcClient = kit.createSolanaRpc(RPC);
// "confirmed" on BOTH the blockhash fetch and the preflight: the public RPC's
// default pairing can hand a blockhash the simulating node has not seen yet,
// which surfaces as the generic "Transaction simulation failed".
const { value: blockhash } = await rpcClient.getLatestBlockhash({ commitment: "confirmed" }).send();

const ix = getTransferInstruction({
  source: kit.address(src.pubkey),
  destination: kit.address(dst.pubkey),
  authority: signer,
  amount: units,
});
const instructions = [ix];
if (memoBytes) {
  instructions.push({
    programAddress: kit.address(MEMO_PROGRAM),
    accounts: [{ address: signer.address, role: kit.AccountRole.READONLY_SIGNER }],
    data: memoBytes,
  });
}
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
  // One retry, only for the blockhash-visibility race - the same signed bytes,
  // so a duplicate broadcast is the SAME transaction and cannot double-pay.
  if (!/Blockhash not found|simulation failed/i.test(String(err.message))) throw err;
  console.warn(`preflight refused (${String(err.message).slice(0, 120)}) - retrying once in 3s`);
  await new Promise((r) => setTimeout(r, 3000));
  await sendOnce();
}
console.log(`SENT ${USD} USDC -> ${TO}`);
console.log(`signature: ${sig}`);
// Mark every claimed row paid with the real outbound signature. A failure
// here leaves rows in `sending` with the money genuinely gone - print the
// signature loudly so the human resolving them has the evidence in hand.
let marked = 0;
for (const r of claimed) {
  const m = await fetch("https://agent402.tools/__operator/refunds/update", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
    body: JSON.stringify({ id: r.id, action: "paid", tx: String(sig), note: "solana-refund-send" }),
  }).catch(() => null);
  if (m?.ok) marked++;
}
console.log(`marked ${marked}/${claimed.length} row(s) paid with that signature`);
if (marked < claimed.length) console.error(`ATTENTION: ${claimed.length - marked} row(s) are stuck in 'sending' though the money DID move (${sig}) - resolve by hand with that tx`);
console.log(`https://solscan.io/tx/${sig}`);
console.log(`digest(for the ledger note): sha256:${createHash("sha256").update(String(sig)).digest("hex").slice(0, 16)}`);
