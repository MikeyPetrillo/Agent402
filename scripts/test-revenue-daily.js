// Offline unit for ledgerDaily (the /api/revenue/daily series): day bucketing
// from real timestamps AND cursor-anchored EVM block estimation, external vs
// canary-sized internal split, funding-sized exclusion. Temp DB, no network.
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REVENUE_LEDGER_DB = join(mkdtempSync(join(tmpdir(), "rvd-")), "t.db");
// The ledger folds Tempo settlements in from the sales ledger; isolate it.
process.env.SALES_LEDGER_DB = join(mkdtempSync(join(tmpdir(), "rvd-sales-")), "s.db");
const { recordTransfer, ledgerDaily } = await import("../src/revenue-ledger.js");
const Database = (await import("better-sqlite3")).default;

const W = "0xabc0000000000000000000000000000000000abc";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Algorand rows carry real timestamps: two on one day, one the day before.
recordTransfer({ chain: "algorand", wallet: "ALGOWALLET", txid: "a1", tx_hash: "a1", block: 1, when_ts: NOW - DAY, usd: 0.01, asset: "USDC", external: true });
recordTransfer({ chain: "algorand", wallet: "ALGOWALLET", txid: "a2", tx_hash: "a2", block: 2, when_ts: NOW, usd: 0.02, asset: "USDC", external: true });
recordTransfer({ chain: "algorand", wallet: "ALGOWALLET", txid: "a3", tx_hash: "a3", block: 3, when_ts: NOW, usd: 0.05, asset: "USDC", external: false }); // canary-sized internal
recordTransfer({ chain: "algorand", wallet: "ALGOWALLET", txid: "a4", tx_hash: "a4", block: 4, when_ts: NOW, usd: 5.0, asset: "USDC", external: false });  // funding-sized: excluded

// Base rows have NO when_ts — dated via the cursor anchor (head=1000 now,
// 2s blocks): block 1000 ≈ now, block 1000 - 43200 ≈ one day ago.
const db = new Database(process.env.REVENUE_LEDGER_DB);
db.prepare("INSERT INTO cursors (chain, wallet, next_block, newest_sig, backfilled, caught_up, updated_ts) VALUES ('base', ?, 1000000, NULL, 1, 1, ?)").run(W, NOW);
recordTransfer({ chain: "base", wallet: W, txid: "b1", tx_hash: "b1", block: 1000000, when_ts: null, usd: 0.003, asset: "USDC", external: true });
recordTransfer({ chain: "base", wallet: W, txid: "b2", tx_hash: "b2", block: 1000000 - 43200, when_ts: null, usd: 0.004, asset: "USDC", external: true });

// Spending wallet (baseExtraWallets): its inbound route-execute sale is revenue.
const SPEND = "0x7706000000000000000000000000000000004121";
recordTransfer({ chain: "base", wallet: SPEND, txid: "s1", tx_hash: "s1", block: 1000000, when_ts: null, usd: 0.55, asset: "USDC", external: true });
db.prepare("INSERT INTO cursors (chain, wallet, next_block, newest_sig, backfilled, caught_up, updated_ts) VALUES ('base', ?, 1000000, NULL, 1, 1, ?)").run(SPEND, NOW);

const wallets = { walletAddress: W, solanaWallet: null, stellarWallet: null, algorandWallet: "ALGOWALLET", baseExtraWallets: [SPEND] };
const days = ledgerDaily(wallets);
const today = new Date(NOW * 1000).toISOString().slice(0, 10);
const yesterday = new Date((NOW - DAY) * 1000).toISOString().slice(0, 10);
const get = (day, chain) => days.find((d) => d.day === day && d.chain === chain);

let passed = 0;
const ok = (c, n) => { if (c) { passed++; console.log("ok - " + n); } else { console.log("FAIL - " + n); process.exitCode = 1; } };

ok(get(today, "algorand")?.extUsd === 0.02 && get(today, "algorand")?.extTx === 1, "real-timestamp rows bucket to their day");
ok(get(yesterday, "algorand")?.extUsd === 0.01, "prior-day row buckets separately");
ok(get(today, "algorand")?.intUsd === 0.05 && get(today, "algorand")?.intTx === 1, "canary-sized internal counted; funding-sized $5 excluded");
ok(get(today, "base")?.extTx === 2, "EVM rows at cursor head estimate to today (treasury + spending)");
ok(get(yesterday, "base")?.extUsd === 0.004, "EVM row 43200 blocks back (2s cadence) estimates to yesterday");
ok(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)), "all rows carry ISO day keys");
ok(get(today, "base")?.extUsd === Number((0.003 + 0.55).toFixed(6)), "spending-wallet route-execute sale counts in the daily base series");
const { ledgerSummary } = await import("../src/revenue-ledger.js");
const sum = ledgerSummary(wallets);
ok(sum.perChain.base.externalUsd === Number((0.003 + 0.004 + 0.55).toFixed(6)), "summary aggregates treasury + spending wallet on base");
ok(sum.allTimeExternalUsd > 0.55, "all-time total includes the spending-wallet revenue");

// --- wire split (the chart's All / x402 / MPP filter) -----------------------
// On-chain an MPP settlement is identical to an x402 one, so the wire arrives
// as a Set of tx hashes joined in from the sales db. The invariant the chart
// depends on: MPP is a SUBSET of the totals, so x402 == all - mpp exactly.
ok(days.every((d) => d.extMppUsd === 0 && d.extMppTx === 0 && d.intMppUsd === 0 && d.intMppTx === 0),
  "no mppTx set -> every MPP field is zero and the series is unchanged");

// a2 (external $0.02) and a3 (internal canary $0.05) arrived over the MPP wire.
const wired = ledgerDaily(wallets, new Set(["a2", "a3"]));
const w = (day, chain) => wired.find((d) => d.day === day && d.chain === chain);
ok(w(today, "algorand").extMppUsd === 0.02 && w(today, "algorand").extMppTx === 1,
  "external MPP settlement lands in the external MPP subset");
ok(w(today, "algorand").intMppUsd === 0.05 && w(today, "algorand").intMppTx === 1,
  "internal (canary) MPP settlement lands in the internal MPP subset");
ok(w(today, "algorand").extUsd === 0.02 && w(today, "algorand").intUsd === 0.05,
  "the MPP subset does not change the totals it is drawn from");
ok(w(yesterday, "algorand").extMppUsd === 0 && w(yesterday, "algorand").extTx === 1,
  "a non-MPP day keeps its total with an empty MPP subset (x402 remainder)");
ok(wired.every((d) => d.extMppUsd <= d.extUsd && d.intMppUsd <= d.intUsd
  && d.extMppTx <= d.extTx && d.intMppTx <= d.intTx),
  "MPP is always a subset -> the chart's x402 remainder can never go negative");

// A funding-sized internal row ($5, excluded from the series) must stay excluded
// even when its hash is on the MPP list — the wire never resurrects a filtered row.
const wiredFunding = ledgerDaily(wallets, new Set(["a4"]));
const wf = wiredFunding.find((d) => d.day === today && d.chain === "algorand");
ok(wf.intUsd === 0.05 && wf.intMppUsd === 0,
  "funding-sized row stays excluded even when its tx is on the MPP list");

// EVM hashes are hex and case-insensitive; base58/base32 ids are not, so a
// checksummed-vs-lowercase mismatch must still join.
recordTransfer({ chain: "base", wallet: W, txid: "0xAbCdEf", tx_hash: "0xAbCdEf", block: 1000000, when_ts: null, usd: 0.007, asset: "USDC", external: true });
const wiredCase = ledgerDaily(wallets, new Set(["0xabcdef"]));
ok(wiredCase.find((d) => d.day === today && d.chain === "base").extMppUsd === 0.007,
  "EVM tx hash joins case-insensitively (lowercase set vs mixed-case ledger row)");

console.log(`\ntest-revenue-daily: ${passed} passed${process.exitCode ? ", FAILURES" : ""}`);
