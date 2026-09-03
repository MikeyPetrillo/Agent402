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

import { createHash, createHmac } from "node:crypto";

// This repo is PUBLIC, so every Actions log is world-readable. The project's
// standing rule for buyer identities is "counts only, never addresses - a
// per-day roster of who pays us is a customer list", and it is enforced on
// /revenue. A refund run would otherwise print the full roster (wallet, amount,
// tool, settle evidence) on the DRY-RUN path too, since the plan is printed
// before the live check. So logs carry a stable non-reversible tag; the
// operator resolves it to the address privately via /__operator/refunds.json,
// which is already token-gated.
// KEYED, not plain sha256. Every wallet that has ever paid us is enumerable
// from the chain (~200 distinct buyers), so an unsalted digest over that set is
// trivially CONFIRMABLE: hash each candidate, match 8 hex chars, and the public
// log identifies the buyer again. Non-reversible is not the property we need -
// unconfirmable is. The operator token is already in this job's env, keeps the
// tag stable across an operator's runs, and is not something a reader has.
const TAG_KEY = (process.env.AGENT402_OPERATOR_TOKEN || "").trim();
const tag = (a) => {
  if (!a) return "?";
  const h = TAG_KEY
    ? createHmac("sha256", TAG_KEY).update(String(a)).digest("hex")
    : createHash("sha256").update(String(a)).digest("hex");
  return `payer:${h.slice(0, 8)}`;
};

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/+$/, "");
const TOKEN = (process.env.AGENT402_OPERATOR_TOKEN || "").trim();
const LIVE = /^(1|true|yes)$/i.test((process.env.REFUND_LIVE || "").trim());
// Caps come from free-text workflow_dispatch inputs, so they MUST be parsed
// rather than coerced. Number("$2") is NaN, and every `x > NaN` is false - so a
// malformed cap did not clamp, it DISAPPEARED. Measured: a "$2" run cap sent 40
// refunds totalling $10 where "2" sent 8 totalling $2. That fails OPEN, in the
// one direction this pipeline must never fail, on a single fat-fingered
// dispatch. Refuse to run instead.
function capUsd(raw, dflt, name) {
  const v = Number(String(raw ?? "").trim() || dflt);
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)} - refusing to run rather than sending with no cap`);
  }
  return v;
}
const MAX_EACH = capUsd(process.env.REFUND_MAX_EACH_USD, "0.25", "REFUND_MAX_EACH_USD");
const MAX_TOTAL = capUsd(process.env.REFUND_MAX_TOTAL_USD, "2", "REFUND_MAX_TOTAL_USD");
// One wallet's share of a run. Bounds the sponsored-gas griefing loop below.
const MAX_PER_PAYER = capUsd(process.env.REFUND_MAX_PER_PAYER_USD, "0.5", "REFUND_MAX_PER_PAYER_USD");
// Optional dust floor: refunds smaller than this cost more to send than they
// repay. Default 0 (off) - a real debt is owed however small, and holding one
// silently is exactly what this pipeline exists to prevent. Set it only when
// gas genuinely outweighs the debt, and the held rows say so out loud.
const MIN_REFUND = capUsd(process.env.REFUND_MIN_USD, "0", "REFUND_MIN_USD");
const ONLY_CHAIN = (process.env.REFUND_ONLY_CHAIN || "").trim(); // optional CAIP-2 filter

// Public RPCs for the EVM rails we can refund on. Overridable per chain via
// REFUND_RPC_<id> (e.g. REFUND_RPC_8453). A chain with no RPC entry holds its
// rows - refusing loudly beats broadcasting through a guessed endpoint.
const EVM_RPCS = {
  "eip155:8453": "https://mainnet.base.org",
  // polygon-rpc.com was shut off 2026-07-31 (probe: "tenant disabled", 403) and
  // was the ONLY Polygon RPC here, so every Polygon refund held unpaid.
  "eip155:137": "https://polygon-bor-rpc.publicnode.com",
  "eip155:42161": "https://arb1.arbitrum.io/rpc",
  "eip155:43114": "https://api.avax.network/ext/bc/C/rpc",
  "eip155:10": "https://mainnet.optimism.io",
  "eip155:42220": "https://forno.celo.org",
  "eip155:1329": "https://evm-rpc.sei-apis.com",
  // Rails that had no entry until the all-chains verifier sweep - without one
  // their rows held as "no RPC configured", which is safe but never repays.
  "eip155:143": "https://rpc.monad.xyz",
  // rpc.robinhoodchain.com answers an EMPTY body; the host the rest of the repo
  // and Robinhood's own docs use is this one (probe: chainId 0x1237).
  "eip155:4663": "https://rpc.mainnet.chain.robinhood.com",
};

// The sales ledger records SHORT chain names ("base", "solana"); settle
// receipts record CAIP-2 ("eip155:8453"). Debts minted by the charged-failure
// detector carry the receipt form; debts minted by the 2026-09-01 backfill
// carried the ledger form, and familyOf + the accepts lookup both key on
// CAIP-2 - so four provably-owed Base rows were held "unsupported network
// base". Normalize the known short names at intake. Values verified against
// our own live 402 accepts, not typed from memory.
const CAIP2_BY_SHORT_NAME = {
  base: "eip155:8453", optimism: "eip155:10", polygon: "eip155:137",
  arbitrum: "eip155:42161", celo: "eip155:42220", avalanche: "eip155:43114",
  sei: "eip155:1329", monad: "eip155:143", robinhood: "eip155:4663",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  stellar: "stellar:pubnet",
  algorand: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
};
export function normalizeNetwork(network) {
  const n = String(network || "").trim();
  return CAIP2_BY_SHORT_NAME[n.toLowerCase()] || n;
}

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
export function planRefunds(rawRows, {
  maxEachUsd = MAX_EACH,
  maxTotalUsd = MAX_TOTAL,
  maxPerPayerUsd = MAX_PER_PAYER,
  minRefundUsd = MIN_REFUND,
  onlyChain = "",
  includeSynthetic = false,
  senders = {},              // family -> truthy when a key+implementation exists
} = {}) {
  // Normalized ONCE at intake so familyOf, the accepts lookup and the row the
  // sender receives all agree on the CAIP-2 form.
  const rows = (rawRows || []).map((r) => ({ ...r, network: normalizeNetwork(r.network) }));
  // Comparisons are written `!(x <= cap)` rather than `x > cap` so that a NaN
  // cap HOLDS the row instead of waving it through - NaN makes every `>` false.
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
    if (!(usd <= maxEachUsd)) { hold(`over per-refund cap $${maxEachUsd}`, row); continue; }
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
    if (!(already + usd <= maxPerPayerUsd)) { hold(`per-payer cap $${maxPerPayerUsd} reached for this wallet - review before repaying more`, row); continue; }
    if (!(total + usd <= maxTotalUsd)) { hold(`deferred - run total would exceed $${maxTotalUsd}`, row); continue; }
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

// payTo is per-SLUG, not per-network. The self-funding routes (route-execute
// and the Blockscout tools) settle to the SPENDING wallet, not the treasury,
// so verifying every row against /api/hash's treasury payTo made those debts
// permanently unverifiable - and they are the routes most likely to
// charged-fail, since they spend upstream on the buyer's behalf. Probing the
// row's own route is the precise fix; accepting any wallet WE control on that
// network is the safe one, and it needs no slug->route map to drift.
export function ourPayToSet(accepts, env = process.env) {
  // CASE MATTERS ON EVERY RAIL BUT EVM. The first version lowercased every
  // address, which is correct for EVM and DESTROYS base32 (Algorand) and
  // base58 (Solana): the indexer returns
  // C7IIHG7SPLPZ...BEE2OY2XIE and a folded copy never matches it, so every
  // Algorand and Solana debt would have been held forever. Same rule the rest
  // of the codebase states repeatedly (src/payer.js, src/revenue-ledger.js):
  // lowercase EVM only, preserve everything else verbatim.
  const norm = (a) => (/^0x[0-9a-fA-F]{40}$/.test(String(a)) ? String(a).toLowerCase() : String(a));
  const set = new Map();   // network -> Set(payTo, EVM-folded only)
  for (const [net, a] of Object.entries(accepts || {})) {
    if (a?.payTo) set.set(net, new Set([norm(a.payTo)]));
  }
  for (const [key, nets] of [
    ["X402_UPSTREAM_BUYER_ADDRESS", Object.keys(accepts || {}).filter((n) => n.startsWith("eip155:"))],
    ["ALGORAND_UPSTREAM_BUYER_ADDRESS", Object.keys(accepts || {}).filter((n) => n.startsWith("algorand:"))],
  ]) {
    const v = (env[key] || "").trim();
    if (!v) continue;
    for (const n of nets) {
      if (!set.has(n)) set.set(n, new Set());
      set.get(n).add(norm(v));
    }
  }
  return set;
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(row.payer))) throw new Error(`payer is not an EVM address (${tag(row.payer)})`);
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
  // algosdk v3 field names. v2 used from/to and returned { txId }; this file
  // was written against v2 while v3.6 is installed, so the builder threw
  // "Address must not be null or undefined" on EVERY Algorand refund - and it
  // threw AFTER the row was claimed, stranding the debt in `sending` with no
  // path back. Verified against the installed SDK: from/to throws,
  // sender/receiver builds.
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr, receiver: row.payer, amount: Math.round(row.priceUsd * 1e6),
    assetIndex: 31566704, // USDC ASA
    note: new TextEncoder().encode("agent402 refund"),
    suggestedParams: params,
  });
  const signed = txn.signTxn(account.sk);
  const res = await client.sendRawTransaction(signed).do();
  // v3 returns `txid`. Reading the v2 name gave undefined, which would have
  // been waited on and then written to the ledger as the string "undefined" -
  // a hole in the one field the ledger treats as proof of repayment.
  const txid = res?.txid || res?.txId;
  if (typeof txid !== "string" || !txid.trim()) {
    throw new Error("Algorand broadcast returned no transaction id - MONEY MAY HAVE LEFT; resolve this row by hand");
  }
  await algosdk.waitForConfirmation(client, txid, 20);
  return txid;
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
  const payToSets = ourPayToSet(accepts);
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
        payToSetFor: (n) => payToSets.get(n) || [],
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
  // A run where everything was HELD used to exit 0 and read as green. A whole
  // class being systematically unverifiable is exactly what that hides.
  process.exit(failed || unverified ? 1 : 0);
}

// Importing for tests must not run the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
