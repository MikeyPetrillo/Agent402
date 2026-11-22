// Sweep ALGO off the CI Algorand burner back to OUR revenue wallet.
//
// The burner's 25-word mnemonic lives only in GitHub Actions secrets
// (write-only — unrecoverable outside a CI run), so a signed transfer can only
// happen inside a workflow. This script is deliberately minimal and safe:
//
//   • DEST is HARDCODED to the revenue Algorand wallet. There is no destination
//     input, so even a maliciously-dispatched run can only move funds TO us.
//   • The signing key must derive to the known burner address or it aborts.
//   • It leaves the account's minimum balance (opted into USDC = 0.2 ALGO)
//     plus a fee margin, so the account and its USDC opt-in survive.
//   • USDC is untouched — this moves ALGO only.
//
// Usage (CI): node scripts/burner-recover.js <algoAmount>
//   with ALGORAND_BURNER_MNEMONIC in env. Amount is capped defensively.
import algosdk from "algosdk";
import { installPublicLog, figure } from "./lib/public-log.js";
// Under PUBLIC_LOG=1 (set by the workflow: its log is public) money figures print as words.
installPublicLog();

const BURNER = "ZKFACAZATPUUYUXVVVE7QWMMZTSMLGQVA4G4QKW7D2UI7FCIFE3QB2SHRE";
const DEST = "C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE"; // revenue wallet — HARDCODED, never an input
const MIN_RESERVE_MICRO = 300_000n; // 0.3 ALGO: covers 0.2 min-balance (1 ASA opt-in) + fees + margin
const client = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");

const die = (m) => { console.error("ABORT:", m); process.exit(1); };

async function main() {
  const amtArg = Number(process.argv[2]);
  if (!Number.isFinite(amtArg) || amtArg <= 0 || amtArg > 700) die("amount must be 0-700 ALGO");

  const mn = (process.env.ALGORAND_BURNER_MNEMONIC || "").trim();
  if (!mn) die("ALGORAND_BURNER_MNEMONIC not set");
  let acct;
  try { acct = algosdk.mnemonicToSecretKey(mn); } catch { die("mnemonic did not parse"); }
  if (acct.addr.toString() !== BURNER) die(`derived ${acct.addr} != burner ${BURNER} — wrong key`);

  const info = await client.accountInformation(BURNER).do();
  const balMicro = BigInt(info.amount);
  const wantMicro = BigInt(Math.round(amtArg * 1e6));
  const maxSendable = balMicro > MIN_RESERVE_MICRO ? balMicro - MIN_RESERVE_MICRO : 0n;
  const sendMicro = wantMicro <= maxSendable ? wantMicro : maxSendable;
  if (sendMicro <= 0n) die("nothing sendable (the balance is at or under the kept reserve)");

  console.log("burner balance read (not printed: this log is public)");
  console.log(`sending ${(Number(sendMicro) / 1e6).toFixed(4)} ALGO -> ${DEST}`);

  const sp = await client.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: BURNER,
    receiver: DEST,
    amount: sendMicro,
    suggestedParams: sp,
  });
  const { txid } = await client.sendRawTransaction(txn.signTxn(acct.sk)).do();
  console.log("submitted txid:", txid);

  // Wait for confirmation.
  let confirmed = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pend = await client.pendingTransactionInformation(txid).do();
    if (pend.confirmedRound) { console.log("confirmed in round", Number(pend.confirmedRound)); confirmed = true; break; }
  }
  if (!confirmed) die("not confirmed within timeout — check the explorer");

  const after = await client.accountInformation(BURNER).do();
  console.log(`burner now: ${figure((Number(after.amount) / 1e6).toFixed(4))} ALGO`);
  console.log(`https://allo.info/tx/${txid}`);
}

main().catch((e) => die(e?.message || String(e)));
