// Daily reconciliation of plan execution against the chain. A REPORT, not an
// alarm: it compares what the decide ledger BOOKED as paid to outside sellers
// (confirmed legs plus uncertain legs booked at their worst case) with the
// USDC that actually left the Base spending wallet, and prints the gap.
//
//   node scripts/decide-reconcile.mjs --db /data/agent402-decide.db --wallet 0x... [--rpc URL] [--hours 24] [--json]
//
// Confirmed legs carry the settlement tx (the router's receipt): each is read
// back from the chain. Uncertain legs (a payment that may have left, booked at
// the most it could have moved) have no tx: the report lists the wallet's
// outgoing transfers inside each such run's window that no confirmed leg
// explains, so a human can see whether the worst case happened.

import Database from "better-sqlite3";

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f179163c4a11628f55a4df523b";
const micro = (x) => Math.round(Number(x) * 1e6);
const usd = (m) => Math.round(m) / 1e6;

/** Pure: the reconciliation, from what the ledger booked and what the chain says. */
export function reconcile({ runs, receipts, transfers }) {
  const confirmed = [], uncertain = [];
  for (const r of runs) {
    for (const st of r.steps || []) {
      if (st.status === "ok" && st.tool && !st.tool.firstParty) {
        confirmed.push({ runId: r.id, seller: st.tool.seller, tx: st.receipt?.settleTx || null, network: st.receipt?.settleNetwork || null, bookedMicro: micro(st.costUsd - (st.routingFeeUsd || 0)) });
      }
      for (const a of st.attempts || []) if (a.mayHavePaid) uncertain.push({ runId: r.id, toolId: a.id, at: r.created_at, until: r.finished_at || r.created_at + 15 * 60_000, bookedMicro: Number.isFinite(Number(a.bookedUsd)) ? micro(a.bookedUsd) : null });
    }
  }
  const explained = new Set();
  let bookedMicro = 0, onChainMicro = 0;
  const mismatches = [], missingTx = [];
  for (const c of confirmed) {
    bookedMicro += c.bookedMicro;
    if (!c.tx) { missingTx.push(c); continue; }
    const got = receipts.get(c.tx.toLowerCase());
    explained.add(c.tx.toLowerCase());
    if (got == null) { mismatches.push({ ...c, onChainMicro: null, note: "tx not found on chain" }); continue; }
    onChainMicro += got;
    if (got !== c.bookedMicro) mismatches.push({ ...c, onChainMicro: got, note: got > c.bookedMicro ? "paid more than booked" : "paid less than booked" });
  }
  // Uncertain legs: transfers out of the wallet inside the run's window that no confirmed leg explains.
  const found = [];
  for (const u of uncertain) {
    const inWindow = transfers.filter((t) => !explained.has(t.tx.toLowerCase()) && t.at >= u.at - 60_000 && t.at <= u.until + 10 * 60_000);
    for (const t of inWindow) { explained.add(t.tx.toLowerCase()); found.push({ ...u, tx: t.tx, to: t.to, micro: t.micro }); }
  }
  // What was booked for the uncertain legs themselves (the seller share at its
  // worst case), not all run spend minus the confirmed legs: that difference
  // also held first-party list prices and routing fees. A leg recorded before
  // bookedUsd existed is counted as unknown rather than guessed.
  const uncertainBookedMicro = uncertain.reduce((a, u) => a + (u.bookedMicro || 0), 0);
  const uncertainBookedUnknown = uncertain.filter((u) => u.bookedMicro == null).length;
  return {
    confirmedLegs: confirmed.length, uncertainLegs: uncertain.length,
    bookedConfirmedUsd: usd(bookedMicro), onChainConfirmedUsd: usd(onChainMicro),
    uncertainTransfersFoundUsd: usd(found.reduce((a, f) => a + f.micro, 0)),
    mismatches, missingTx: missingTx.length, uncertainFound: found,
    note: "Booked worst cases that no transfer explains were not paid: that gap is the amount the ledger over-counted, not money owed.",
    uncertainBookedAtWorstCaseUsd: usd(Math.max(0, uncertainBookedMicro)),
    ...(uncertainBookedUnknown ? { uncertainLegsWithoutBookedAmount: uncertainBookedUnknown } : {}),
    windowNote: "An uncertain leg is matched to any unexplained transfer out of the wallet inside its run's window. The wallet is shared with the router's other buys, so a match is a lead to check, not proof.",
  };
}

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const dbPath = arg("--db"), wallet = String(arg("--wallet", "")).toLowerCase();
  const url = arg("--rpc", process.env.AGENT402_BASE_RPC || "https://mainnet.base.org");
  const hours = Number(arg("--hours", 24));
  if (!dbPath || !/^0x[0-9a-f]{40}$/.test(wallet)) { console.error("usage: --db <path> --wallet <0x spending wallet>"); process.exit(2); }
  const db = new Database(dbPath, { readonly: true });
  const since = Date.now() - hours * 3_600_000;
  const runs = db.prepare("SELECT id, created_at, finished_at, spent_micro / 1e6 AS spent_usd, steps_json FROM runs WHERE created_at >= ?").all(since)
    .map((r) => ({ ...r, steps: JSON.parse(r.steps_json || "[]") }));
  const receipts = new Map();
  const walletTopic = "0x" + wallet.slice(2).padStart(64, "0");
  for (const r of runs) for (const st of r.steps) {
    const tx = st.receipt?.settleTx;
    if (!tx || st.receipt?.settleNetwork !== "eip155:8453" || receipts.has(tx.toLowerCase())) continue;
    const rc = await rpc(url, "eth_getTransactionReceipt", [tx]);
    const m = (rc?.logs || []).filter((l) => l.address.toLowerCase() === USDC_BASE && l.topics[0] === TRANSFER && l.topics[1]?.toLowerCase() === walletTopic)
      .reduce((a, l) => a + Number(BigInt(l.data)), 0);
    receipts.set(tx.toLowerCase(), rc ? m : null);
  }
  // Outgoing transfers in the window (Base ~2s blocks; a generous range).
  const head = Number(await rpc(url, "eth_blockNumber", []));
  const from = Math.max(0, head - Math.ceil((hours * 3600 + 3600) / 2));
  const transfers = [];
  for (let b = from; b <= head; b += 2000) {
    const logs = await rpc(url, "eth_getLogs", [{ address: USDC_BASE, topics: [TRANSFER, walletTopic], fromBlock: "0x" + b.toString(16), toBlock: "0x" + Math.min(head, b + 1999).toString(16) }]);
    for (const l of logs) transfers.push({ tx: l.transactionHash, to: "0x" + l.topics[2].slice(26), micro: Number(BigInt(l.data)), block: Number(l.blockNumber) });
  }
  // Block -> time, from the head (approximate, Base ~2s).
  const headTime = Date.now();
  for (const t of transfers) t.at = headTime - (head - t.block) * 2000;
  const out = reconcile({ runs, receipts, transfers });
  if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`runs ${runs.length} | confirmed outside legs ${out.confirmedLegs} | uncertain legs ${out.uncertainLegs}`);
    console.log(`confirmed: booked $${out.bookedConfirmedUsd}, on chain $${out.onChainConfirmedUsd}, mismatches ${out.mismatches.length}, legs with no tx ${out.missingTx}`);
    console.log(`uncertain: booked at worst case $${out.uncertainBookedAtWorstCaseUsd}, transfers found in their windows $${out.uncertainTransfersFoundUsd}`);
    console.log(out.note);
  }
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
