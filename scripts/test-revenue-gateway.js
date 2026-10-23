#!/usr/bin/env node
// Circle Gateway batched sales on the revenue surfaces, offline.
//
// A batched sale (wire gateway-batched) settles off chain at Circle Gateway
// and is credited to our Gateway balance, so no on-chain transfer to the
// treasury carries it: the chain scan never sees it. The ledger summary
// folds those sales in from the sales ledger, /revenue labels them as
// settled off chain, and the later withdrawal (a USDC mint to the wallet,
// a Transfer from the zero address) is never recorded as a payment, so the
// same money is not counted twice. With no batched sale (the switch off),
// none of this appears.
//
//   node scripts/test-revenue-gateway.js
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-rev-gw-"));
process.env.REVENUE_LEDGER_DB = join(dir, "ledger.db");
process.env.SALES_LEDGER_DB = join(dir, "sales.db");

const { recordTransfer, ledgerSummary, syncEvmChain } = await import("../src/revenue-ledger.js");
const { revenuePage, railThroughput, EVM } = await import("../src/revenue-live.js");
const { gatewayBatchedPayments } = await import("../src/sales-ledger.js");
const { isExternalPayment: isExternalLive } = await import("./revenue-scan-solana.js");
const { isExternalPayment: isExternalEvm } = await import("./revenue-scan.js");
const Database = (await import("better-sqlite3")).default;

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const W = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const wallets = { walletAddress: W };
const ZERO = "0x0000000000000000000000000000000000000000";
const BUYER = "0x1111111111111111111111111111111111111111";
const salesDb = new Database(process.env.SALES_LEDGER_DB);
let seq = 0;
const sale = ({ wire = "gateway-batched", internal = 0, usd = 0.01, rail = "usdc", network = "eip155:8453" } = {}) =>
  salesDb.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(Date.now(), "hash", usd, rail, network, BUYER, `gw-transfer-${++seq}`, internal, wire);
const page = (allTime) => revenuePage("https://agent402.tools", {
  asOf: "2026-10-23T00:00:00.000Z",
  rails: [{ rail: "Base", asset: "USDC", balance: 1, recent: [], lastInbound: null }],
  allTime,
  mpp: { count: 0, rails: {} },
});
const flat = (html) => html.replace(/<[^>]*>/g, " ").replace(/[<>]/g, " ").replace(/\s+/g, " ");

console.log("revenue: Circle Gateway batched sales");

// One on-chain external payment, so the page renders its hero.
recordTransfer({ chain: "base", wallet: W, txid: "0xaaa:0", tx_hash: "0xaaa", block: 100, when_ts: 1780000000, payer: BUYER, usd: 0.01, asset: "USDC", external: true });

await check("no batched sale: no batched field, figure or text", () => {
  const s = ledgerSummary(wallets);
  assert.equal(s.gatewayBatched, undefined);
  assert.equal(s.allTimeExternalAllUsd, undefined);
  assert.equal(railThroughput({ allTime: s }).gatewayBatched, 0);
  const text = flat(page(s));
  assert.doesNotMatch(text, /Circle Gateway|batched|off chain/i, "the page names no batched option");
  assert.match(text, /settled on-chain \(x402 rails \+ Tempo MPP\)/, "the headline reads as before");
});

await check("a sale on another wire is never read as batched", () => {
  sale({ wire: "x402" });
  sale({ wire: "gateway-batched", rail: "pow" });
  assert.deepEqual(gatewayBatchedPayments(), { count: 0, usd: 0, externalCount: 0, externalUsd: 0 });
});

await check("batched sales join the external figures with an off-chain label", () => {
  const before = ledgerSummary(wallets);
  sale({ usd: 0.01 }); sale({ usd: 0.02 }); sale({ usd: 0.5, internal: 1 });
  const s = ledgerSummary(wallets);
  assert.equal(s.gatewayBatched.count, 3, "every batched settlement, ours included");
  assert.equal(s.gatewayBatched.externalCount, 2);
  assert.ok(Math.abs(s.gatewayBatched.externalUsd - 0.03) < 1e-9, "external dollars only");
  assert.equal(s.gatewayBatched.settledOffChain, true);
  assert.match(s.gatewayBatched.source, /off chain at Circle Gateway/);
  assert.equal(s.allTimeExternalCount, before.allTimeExternalCount, "the on-chain field keeps its meaning");
  assert.equal(s.allTimeExternalWithTempoCount, before.allTimeExternalWithTempoCount, "the Tempo pair keeps its meaning");
  assert.equal(s.allTimeExternalAllCount, s.allTimeExternalWithTempoCount + 2);
  assert.ok(Math.abs(s.allTimeExternalAllUsd - (s.allTimeExternalWithTempoUsd + 0.03)) < 1e-6);
  assert.equal(railThroughput({ allTime: s }).total, s.allTimeInboundCount + 3, "throughput counts each batched settlement once");
  const text = flat(page(s));
  assert.match(text, /3 external payments · \$0\.04 revenue, x402 rails and Tempo MPP settled on-chain, plus Circle Gateway batched payments settled off chain, all-time/);
  assert.match(text, /Circle Gateway batched: 3 transactions, 2 external, \$0\.030 external\. Settled off chain at Circle Gateway and withdrawn on chain separately/);
  assert.doesNotMatch(text, /Gateway balance/i, "no Gateway balance on the public page");
});

await check("a withdrawal mint is not counted again: the scan records no mint, and no mint is external", async () => {
  assert.equal(isExternalLive({ payer: ZERO, usd: 0.02 }, { ourWallets: new Set(), maxUsd: 0.75 }), false, "the live view's rule");
  assert.equal(isExternalEvm({ payer: ZERO, usd: 0.02 }, { ourWallets: new Set(), maxUsd: 0.75 }), false, "the scan script's rule");
  assert.equal(isExternalLive({ payer: BUYER, usd: 0.02 }, { ourWallets: new Set(), maxUsd: 0.75 }), true, "control: a buyer's transfer is external");
  const before = ledgerSummary(wallets);
  // Base: one block with a Gateway withdrawal mint (from the zero address)
  // and one ordinary buyer transfer, both to our wallet.
  const topic = (a) => "0x" + a.slice(2).padStart(64, "0");
  const usdc = (n) => "0x" + BigInt(Math.round(n * 1e6)).toString(16).padStart(64, "0");
  const HEAD = 40_000_000;
  const db = new Database(process.env.REVENUE_LEDGER_DB);
  db.prepare("INSERT OR REPLACE INTO cursors (chain, wallet, next_block, newest_sig, backfilled, caught_up, updated_ts) VALUES (?,?,?,?,?,?,?)").run("base", W, HEAD - 10, null, 1, 0, 1780000000);
  db.close();
  const logs = [
    { blockNumber: "0x" + (HEAD - 5).toString(16), transactionHash: "0xmint", logIndex: "0x0", topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(ZERO), topic(W)], data: usdc(0.02) },
    { blockNumber: "0x" + (HEAD - 5).toString(16), transactionHash: "0xbuy", logIndex: "0x1", topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(BUYER), topic(W)], data: usdc(0.01) },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init?.body || "{}");
    const answer = (b) => {
      if (b.method === "eth_blockNumber") return { result: "0x" + (HEAD + 100).toString(16) };
      if (b.method === "eth_getLogs") {
        const from = parseInt(b.params[0].fromBlock, 16), to = parseInt(b.params[0].toBlock, 16);
        return { result: logs.filter((l) => { const n = parseInt(l.blockNumber, 16); return n >= from && n <= to; }) };
      }
      if (b.method === "eth_getBlockByNumber") return { result: { timestamp: "0x" + (1780000100).toString(16) } };
      return { result: null };
    };
    const out = Array.isArray(body) ? body.map((b) => ({ jsonrpc: "2.0", id: b.id, ...answer(b) })) : { jsonrpc: "2.0", id: body.id ?? 1, ...answer(body) };
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  try { await syncEvmChain("base", W); } finally { globalThis.fetch = realFetch; }
  const s = ledgerSummary(wallets);
  assert.equal(s.allTimeExternalCount - before.allTimeExternalCount, 1, "only the buyer's transfer is external");
  assert.equal(s.allTimeInboundCount - before.allTimeInboundCount, 1, "the mint is not a settled transaction either");
  assert.equal(s.gatewayBatched.externalCount, before.gatewayBatched.externalCount, "the batched figure is unchanged by its own withdrawal");
  assert.ok(Math.abs((s.allTimeExternalAllUsd - before.allTimeExternalAllUsd) - 0.01) < 1e-9, "the combined figure grows by the buyer's payment only");
  void EVM;
});

salesDb.close();
rmSync(dir, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall revenue gateway checks passed");
