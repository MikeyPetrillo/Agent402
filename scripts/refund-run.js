#!/usr/bin/env node
// Repay the refund ledger - every buyer who was charged and got nothing.
//
//   DRY RUN (default):  AGENT402_OPERATOR_TOKEN=… node scripts/refund-run.js
//   LIVE:               REFUND_LIVE=true … node scripts/refund-run.js
//
// Reads owed rows from /__operator/refunds.json, pays each buyer back ON THE
// CHAIN THEY PAID ON, and marks the row paid with the outbound tx. Designed to
// run from the dispatch-only refund.yml workflow, where the spending keys live
// (Actions secrets, never Railway, never local) - the production server can
// record debts but can never send money.
//
// SAFETY MODEL - money leaves a wallet here, so every rule is explicit:
//   * DRY RUN BY DEFAULT. A live run requires REFUND_LIVE=true.
//   * recipient = the ledger row's verified payer, verbatim. Addresses are
//     never case-folded (base58/base32 rails are case-sensitive) and never
//     derived from anything but the row.
//   * amount = the row's priceUsd exactly - a refund, not a gesture.
//   * the ASSET comes from our own live 402: the accepts entry for that
//     network names the exact token buyers pay with, so we refund in the same
//     token, with no hand-maintained address table to rot.
//   * caps: per-refund (REFUND_MAX_EACH_USD, default $0.25) and per-run
//     (REFUND_MAX_TOTAL_USD, default $2). Over-cap rows are HELD and listed,
//     never silently skipped.
//   * synthetic rows (canary/heartbeat self-harm) are held by default -
//     refunding our own burner is churn. REFUND_INCLUDE_SYNTHETIC=true opts in.
//   * a chain without an implemented sender or a configured key HOLDS its
//     rows and says so. The debt stays on the ledger; nothing is written off.
//   * marking paid requires the outbound tx hash, enforced server-side too.
//
// Chain support: EVM rails (one key, REFUND_EVM_KEY), Stellar
// (REFUND_STELLAR_SECRET, classic payment + "agent402 refund" memo), Algorand
// (REFUND_ALGORAND_MNEMONIC, ASA transfer + note). Solana is detection-only
// for now: a failed Solana txn moves no tokens (measured 2026-08-03), so
// charged-but-failed there is rare; rows are held and listed until the SVM
// sender lands with the planned Solana spending wallet.

import { createHash } from "node:crypto";

// This repo is PUBLIC, so every Actions log is world-readable. The project's
// standing rule for buyer identities is "counts only, never addresses - a
// per-day roster of who pays us is a customer list", and it is enforced on
// /revenue. A refund run would otherwise print the full roster (wallet, amount,
// tool, settle evidence) on the DRY-RUN path too, since the plan is printed
// before the live check. So logs carry a stable non-reversible tag; the
// operator resolves it to the address privately via /__operator/refunds.json,
// which is already token-gated.
const tag = (a) => (a ? `payer:${createHash("sha256").update(String(a)).digest("hex").slice(0, 8)}` : "?");

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const TOKEN = (process.env.AGENT402_OPERATOR_TOKEN || "").trim();
const LIVE = /^(1|true|yes)$/i.test((process.env.REFUND_LIVE || "").trim());
const MAX_EACH = Number(process.env.REFUND_MAX_EACH_USD || "0.25");
const MAX_TOTAL = Number(process.env.REFUND_MAX_TOTAL_USD || "2");
// One wallet's share of a run. Bounds the sponsored-gas griefing loop below.
const MAX_PER_PAYER = Number(process.env.REFUND_MAX_PER_PAYER_USD || "0.5");
// Optional dust floor: refunds smaller than this cost more to send than they
// repay. Default 0 (off) - a real debt is owed however small, and holding one
// silently is exactly what this pipeline exists to prevent. Set it only when
// gas genuinely outweighs the debt, and the held rows say so out loud.
const MIN_REFUND = Number(process.env.REFUND_MIN_USD || "0");
const ONLY_CHAIN = (process.env.REFUND_ONLY_CHAIN || "").trim(); // optional CAIP-2 filter

// Public RPCs for the EVM rails we can refund on. Overridable per chain via
// REFUND_RPC_<id> (e.g. REFUND_RPC_8453). A chain with no RPC entry holds its
// rows - refusing loudly beats broadcasting through a guessed endpoint.
const EVM_RPCS = {
  "eip155:8453": "https://mainnet.base.org",
  "eip155:137": "https://polygon-rpc.com",
  "eip155:42161": "https://arb1.arbitrum.io/rpc",
  "eip155:43114": "https://api.avax.network/ext/bc/C/rpc",
  "eip155:10": "https://mainnet.optimism.io",
  "eip155:42220": "https://forno.celo.org",
  "eip155:1329": "https://evm-rpc.sei-apis.com",
  // Rails that had no entry until the all-chains verifier sweep - without one
  // their rows held as "no RPC configured", which is safe but never repays.
  "eip155:143": "https://rpc.monad.xyz",
  "eip155:4663": "https://rpc.robinhoodchain.com",
};

export function familyOf(network) {
  const n = String(network || "");
  if (n.startsWith("eip155:")) return "evm";
  if (n.startsWith("solana:")) return "solana";
  if (n.startsWith("stellar:")) return "stellar";
  if (n.startsWith("algorand:")) return "algorand";
  return "unknown";
}

/**
 * Pure planner: decide what to send and what to hold, with reasons. Exported
 * for the offline test - the dangerous mistakes (skipping caps, refunding the
 * canary, silently dropping an unsupported chain) all live here.
 */
export function planRefunds(rows, {
  maxEachUsd = MAX_EACH,
  maxTotalUsd = MAX_TOTAL,
  maxPerPayerUsd = MAX_PER_PAYER,
  minRefundUsd = MIN_REFUND,
  onlyChain = "",
  includeSynthetic = false,
  senders = {},              // family -> truthy when a key+implementation exists
} = {}) {
  const send = [];
  const held = {}; // reason -> rows
  const hold = (reason, row) => { (held[reason] ||= []).push(row); };
  let total = 0;
  const perPayer = new Map();   // payer -> usd already planned this run
  for (const row of rows) {
    if (row.status && row.status !== "owed") continue;
    if (onlyChain && row.network !== onlyChain) { hold("filtered by chain", row); continue; }
    if (row.synthetic && !includeSynthetic) { hold("synthetic (our own canary - opt in to refund it)", row); continue; }
    if (!row.payer) { hold("no payer recorded - resolve manually (void with a note)", row); continue; }
    const usd = Number(row.priceUsd) || 0;
    if (usd <= 0) { hold("zero amount - void with a note", row); continue; }
    if (usd > maxEachUsd) { hold(`over per-refund cap $${maxEachUsd}`, row); continue; }
    const family = familyOf(row.network);
    if (family === "unknown") { hold(`unsupported network ${row.network}`, row); continue; }
    if (!senders[family]) { hold(`no sender/key for ${family} - debt stays on the ledger`, row); continue; }
    if (usd < minRefundUsd) { hold(`below the dust floor $${minRefundUsd} - costs more in gas than it repays; batch or void with a note`, row); continue; }
    // PER-PAYER BOUND. Gas is sponsored for buyers on the EVM rails, so a
    // griefer can pay $0.001, force a charged-failure, take the $0.001 back
    // and lose nothing - while WE pay gas on every refund. Each debt is real
    // and each refund is correct, so the answer is not to refuse them: it is
    // to bound how much one wallet can extract per run, making the loop
    // visible (rows pile up, held, under that payer) instead of draining a
    // burner one sponsored call at a time.
    const already = perPayer.get(row.payer) || 0;
    if (already + usd > maxPerPayerUsd) { hold(`per-payer cap $${maxPerPayerUsd} reached for this wallet - review before repaying more`, row); continue; }
    if (total + usd > maxTotalUsd) { hold(`deferred - run total would exceed $${maxTotalUsd}`, row); continue; }
    perPayer.set(row.payer, already + usd);
    total += usd;
    send.push(row);
  }
  return { send, held, totalUsd: Number(total.toFixed(6)) };
}

/** Fetch our own live 402 and index the accepts by network - the asset source. */
async function liveAcceptsByNetwork() {
  const res = await fetch(`${TARGET}/api/hash`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "refund-run" }),
  });
  if (res.status !== 402) throw new Error(`expected a 402 from ${TARGET}/api/hash, got ${res.status}`);
  const hdr = res.headers.get("payment-required");
  if (!hdr) throw new Error("402 carried no payment-required header");
  const body = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
  const byNet = {};
  for (const a of body.accepts || []) if (!byNet[a.network]) byNet[a.network] = a;
  return byNet;
}

// ---- chain senders (each returns the outbound tx id) ----

async function sendEvm(row, accepts) {
  const { createWalletClient, http, publicActions, defineChain } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const id = Number(String(row.network).split(":")[1]);
  const rpc = (process.env[`REFUND_RPC_${id}`] || EVM_RPCS[row.network] || "").trim();
  if (!rpc) throw new Error(`no RPC for ${row.network}`);
  const token = accepts?.asset;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(token))) throw new Error(`no ERC-20 asset in live accepts for ${row.network}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(row.payer))) throw new Error(`payer is not an EVM address: ${row.payer}`);
  const account = privateKeyToAccount(process.env.REFUND_EVM_KEY.trim());
  const chain = defineChain({ id, name: row.network, nativeCurrency: { name: "n", symbol: "n", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const client = createWalletClient({ account, chain, transport: http(rpc) }).extend(publicActions);
  const erc20 = [
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  ];
  // Read decimals from the token itself - assuming 6 and being wrong about a
  // future asset would refund a millionth (or a million times) the debt.
  const decimals = await client.readContract({ address: token, abi: erc20, functionName: "decimals" });
  const amount = BigInt(Math.round(row.priceUsd * 10 ** Number(decimals)));
  const hash = await client.writeContract({ address: token, abi: erc20, functionName: "transfer", args: [row.payer, amount] });
  return hash;
}

async function sendStellar(row) {
  const sdk = await import("@stellar/stellar-sdk");
  const { Horizon, Keypair, TransactionBuilder, Networks, Operation, Asset, Memo, BASE_FEE } = sdk.default || sdk;
  const server = new Horizon.Server("https://horizon.stellar.org");
  const kp = Keypair.fromSecret(process.env.REFUND_STELLAR_SECRET.trim());
  const usdc = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  const account = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.payment({ destination: row.payer, asset: usdc, amount: row.priceUsd.toFixed(7) }))
    .addMemo(Memo.text("agent402 refund"))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  return res.hash;
}

async function sendAlgorand(row) {
  const algosdk = (await import("algosdk")).default;
  const account = algosdk.mnemonicToSecretKey(process.env.REFUND_ALGORAND_MNEMONIC.trim());
  const client = new algosdk.Algodv2("", "https://mainnet-api.4160.nodely.dev", "");
  const params = await client.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    from: account.addr, to: row.payer, amount: Math.round(row.priceUsd * 1e6),
    assetIndex: 31566704, // USDC ASA
    note: new TextEncoder().encode("agent402 refund"),
    suggestedParams: params,
  });
  const signed = txn.signTxn(account.sk);
  const { txId } = await client.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(client, txId, 20);
  return txId;
}

async function claimForSend(id) {
  const res = await fetch(`${TARGET}/__operator/refunds/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ id, action: "claim", note: "refund-run: claimed before broadcast" }),
  });
  return res.ok;
}

async function markPaid(id, tx) {
  const res = await fetch(`${TARGET}/__operator/refunds/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ id, action: "paid", tx }),
  });
  if (!res.ok) throw new Error(`mark-paid failed for row ${id}: HTTP ${res.status}`);
}

async function main() {
  if (!TOKEN) { console.error("AGENT402_OPERATOR_TOKEN is required"); process.exit(2); }
  const senders = {
    evm: !!(process.env.REFUND_EVM_KEY || "").trim(),
    stellar: !!(process.env.REFUND_STELLAR_SECRET || "").trim(),
    algorand: !!(process.env.REFUND_ALGORAND_MNEMONIC || "").trim(),
    solana: false, // detection-only until the SVM spending wallet lands
  };
  const res = await fetch(`${TARGET}/__operator/refunds.json?status=owed`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) { console.error(`refunds.json HTTP ${res.status}`); process.exit(2); }
  const { refunds, totals } = await res.json();
  console.log(`refund-run against ${TARGET} - ledger: ${JSON.stringify(totals)}`);

  const plan = planRefunds(refunds, {
    onlyChain: ONLY_CHAIN,
    maxPerPayerUsd: MAX_PER_PAYER,
    minRefundUsd: MIN_REFUND,
    includeSynthetic: /^(1|true|yes)$/i.test(process.env.REFUND_INCLUDE_SYNTHETIC || ""),
    senders,
  });
  for (const [reason, rows] of Object.entries(plan.held)) {
    console.log(`\nHELD (${reason}): ${rows.length}`);
    for (const r of rows) console.log(`   #${r.id} ${r.network} $${r.priceUsd} -> ${tag(r.payer)} (${r.slug})`);
  }
  console.log(`\nTO SEND: ${plan.send.length} refund(s), $${plan.totalUsd} total`);
  for (const r of plan.send) console.log(`   #${r.id} ${r.network} $${r.priceUsd} -> ${tag(r.payer)} (${r.slug})`);

  if (!LIVE) { console.log("\nDRY RUN - no money moved. Set REFUND_LIVE=true to execute."); return; }
  if (!plan.send.length) { console.log("nothing to send."); return; }

  const accepts = await liveAcceptsByNetwork();
  const { verifyInboundPayment } = await import("../src/payment-verify.js");
  const { confirmStellarTransfer } = await import("../src/stellar-confirm.js");
  let ok = 0, failed = 0, unverified = 0;
  for (const row of plan.send) {
    try {
      // PROVE THE PAYMENT BEFORE REPAYING IT. The debt was recorded on the
      // facilitator's success:true, which is unforgeable by a buyer but not
      // guaranteed true - a facilitator can be wrong, and this week it was, in
      // the opposite direction (Stellar reported failure for transfers that
      // confirmed). So the same payer, our payTo, and at least the amount must
      // be confirmed on-chain before anything leaves. Fails closed: an
      // unverifiable row is HELD, still owed, never paid and never written off.
      const proof = await verifyInboundPayment({
        network: row.network, payer: row.payer, amountUsd: row.priceUsd,
        tx: row.evidence, createdAt: row.createdAt,
        acceptsFor: (n) => accepts[n],
        rpcFor: (n) => (process.env[`REFUND_RPC_${String(n).split(":")[1]}`] || EVM_RPCS[n] || "").trim() || null,
        stellarConfirm: confirmStellarTransfer,
      });
      if (!proof.verified) {
        console.warn(`HOLD  #${row.id} $${row.priceUsd} -> ${tag(row.payer)}: UNVERIFIED - ${proof.reason}`);
        unverified++;
        continue;
      }
      console.log(`      #${row.id} inbound payment confirmed on-chain`);
      // CLAIM BEFORE SENDING. Verification proves we were paid; it can never
      // prove we have not already refunded, and it stays true forever. So the
      // row is moved to `sending` first: a crash between broadcast and
      // mark-paid leaves it stuck there for a human instead of being re-sent
      // by the next run. Losing the claim race means another runner has it.
      const claimed = await claimForSend(row.id);
      if (!claimed) {
        console.warn(`HOLD  #${row.id}: could not claim (already sending, resolved, or another run has it)`);
        unverified++;
        continue;
      }
      const family = familyOf(row.network);
      const tx = family === "evm" ? await sendEvm(row, accepts[row.network])
        : family === "stellar" ? await sendStellar(row)
        : family === "algorand" ? await sendAlgorand(row)
        : (() => { throw new Error(`no sender for ${family}`); })();
      await markPaid(row.id, String(tx));
      console.log(`PAID  #${row.id} $${row.priceUsd} -> ${tag(row.payer)}  (tx in the ledger, not this log)`);
      ok++;
    } catch (e) {
      // If the failure came after the claim, the row is now stuck in `sending`
      // and will NOT be retried automatically - that is deliberate. Whether the
      // money left is exactly what a human must check before releasing it.
      console.error(`FAIL  #${row.id}: ${(e?.message || String(e)).slice(0, 160)}`);
      console.error(`      -> if this row is now 'sending', check the chain before resolving it; it will not auto-retry`);
      failed++;
    }
  }
  console.log(`\ndone: ${ok} paid, ${failed} failed, ${unverified} held unverified (all unpaid rows remain owed)`);
  process.exit(failed ? 1 : 0);
}

// Importing for tests must not run the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
