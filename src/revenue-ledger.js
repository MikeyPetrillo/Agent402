// All-time revenue ledger — "how much has this service ACTUALLY earned,
// since the beginning?" answered from on-chain ground truth, persistently.
//
// The live /revenue view reads a few recent hours per refresh; this module
// owns the rest of history: a SQLite table (on the /data volume, same
// pattern as stats.js) of every inbound stablecoin transfer to the revenue
// wallet on every rail, each row classified with the scanners' shared rule
// (external = not our burner + per-call-sized). A background loop backfills
// from the wallet's first funding (LEDGER_EPOCH) in polite chunked
// eth_getLogs sweeps, persisting a per-chain cursor as it goes — restarts
// resume, they never rescan — then keeps tailing the head. Solana pages
// getSignaturesForAddress back to the account's genesis once, then follows
// new signatures. SUM(external) is the all-time revenue figure; every row
// keeps its tx id, so the number stays independently verifiable.
//
// Zero config: runs whenever /data exists (i.e., prod) or when
// REVENUE_LEDGER=true forces it (local/dev); CI test boots have neither, so
// tests never hammer public RPCs.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  EVM, SOLANA_RPCS, rpcCall, pad, TRANSFER_TOPIC, USDC_SOL_MINT,
  MAX_CALL_USD, OUR_EVM_WALLETS, OUR_SOLANA_WALLETS,
} from "./revenue-live.js";
import { usdcDeltaForOwner, payerFromMeta, isExternalPayment } from "../scripts/revenue-scan-solana.js";

const HAS_DATA_DIR = existsSync("/data");
const DB_PATH = process.env.REVENUE_LEDGER_DB || join(HAS_DATA_DIR ? "/data" : "/tmp", "agent402-revenue.db");
export const ledgerPersistent = HAS_DATA_DIR || Boolean(process.env.REVENUE_LEDGER_DB);

// Before the wallet's first funding (service launched 2026-06-12; margin
// back to May). Per-chain block time turns this into a start block, so no
// per-chain block numbers need hardcoding. Env-overridable per chain with
// an absolute block: REVENUE_LEDGER_FROM_BASE=31000000 etc.
const LEDGER_EPOCH_MS = Date.parse(process.env.REVENUE_LEDGER_EPOCH || "2026-05-20T00:00:00Z");
const BLOCK_MS = { base: 2000, polygon: 2100, arbitrum: 250, robinhood: 150 }; // robinhood measured ~0.15s (not the 2s Orbit default)

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS transfers (
  chain    TEXT NOT NULL,
  wallet   TEXT NOT NULL,
  txid     TEXT NOT NULL,   -- EVM: txHash:logIndex · Solana: signature
  tx_hash  TEXT NOT NULL,
  block    INTEGER,          -- EVM block / Solana slot
  when_ts  INTEGER,          -- unix seconds when the chain reports it (Solana)
  payer    TEXT,
  usd      REAL NOT NULL,
  asset    TEXT NOT NULL,
  external INTEGER NOT NULL,
  PRIMARY KEY (chain, wallet, txid)
);
CREATE INDEX IF NOT EXISTS idx_transfers_ext ON transfers (wallet, external, chain);
CREATE TABLE IF NOT EXISTS cursors (
  chain      TEXT NOT NULL,
  wallet     TEXT NOT NULL,
  next_block INTEGER,        -- EVM: next fromBlock to scan
  newest_sig TEXT,           -- Solana: incremental anchor
  backfilled INTEGER DEFAULT 0, -- Solana: paged to account genesis
  caught_up  INTEGER DEFAULT 0,
  updated_ts INTEGER,
  PRIMARY KEY (chain, wallet)
);`);

const upsertTransfer = db.prepare(`INSERT OR IGNORE INTO transfers
  (chain, wallet, txid, tx_hash, block, when_ts, payer, usd, asset, external)
  VALUES (@chain, @wallet, @txid, @tx_hash, @block, @when_ts, @payer, @usd, @asset, @external)`);
const getCursor = db.prepare("SELECT * FROM cursors WHERE chain = ? AND wallet = ?");
const putCursor = db.prepare(`INSERT INTO cursors (chain, wallet, next_block, newest_sig, backfilled, caught_up, updated_ts)
  VALUES (@chain, @wallet, @next_block, @newest_sig, @backfilled, @caught_up, @updated_ts)
  ON CONFLICT (chain, wallet) DO UPDATE SET
    next_block = excluded.next_block, newest_sig = excluded.newest_sig,
    backfilled = excluded.backfilled, caught_up = excluded.caught_up, updated_ts = excluded.updated_ts`);

/** Record one transfer (idempotent — the PK dedupes replays/rescans). */
export function recordTransfer(row) {
  upsertTransfer.run({ when_ts: null, payer: null, ...row, external: row.external ? 1 : 0 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startBlockFor = (chain, head) => {
  const env = parseInt(process.env[`REVENUE_LEDGER_FROM_${chain.toUpperCase()}`] || "", 10);
  if (Number.isFinite(env)) return Math.max(0, env);
  return Math.max(0, head - Math.ceil((Date.now() - LEDGER_EPOCH_MS) / (BLOCK_MS[chain] || 2000)));
};

/** Advance one EVM chain's cursor by up to `maxChunks` getLogs windows. */
async function syncEvmChain(chain, wallet, { maxChunks = 20 } = {}) {
  const c = EVM[chain];
  const head = parseInt(await rpcCall(c.rpcs, "eth_blockNumber", [], 6000), 16);
  const cur = getCursor.get(chain, wallet);
  let next = cur?.next_block ?? startBlockFor(chain, head);
  // Capped at 9,000 blocks like the other two scanners (revenue-scan.js and
  // the live view's recentInbound) — Alchemy rejects getLogs ranges over 10k
  // on some chains (Robinhood, verified 2026-07-08). Without the cap, any
  // cursor gap wider than the RPC limit (≈25 min of downtime at Robinhood's
  // 0.15s blocks) made every subsequent getLogs request span the whole gap,
  // fail, and never advance — the all-time figure froze with ↺ forever.
  const chunkSize = Math.min(9000, Math.ceil(c.span / 4));
  let chunks = 0;
  while (next <= head && chunks < maxChunks) {
    const to = Math.min(next + chunkSize - 1, head);
    const logs = await rpcCall(c.rpcs, "eth_getLogs", [{
      address: c.token,
      topics: [TRANSFER_TOPIC, null, pad(wallet)],
      fromBlock: "0x" + next.toString(16),
      toBlock: "0x" + to.toString(16),
    }], 8000);
    for (const l of Array.isArray(logs) ? logs : []) {
      const usd = Number(BigInt(l.data && l.data !== "0x" ? l.data : "0x0")) / 1e6;
      const payer = l.topics?.[1] ? ("0x" + l.topics[1].slice(-40)).toLowerCase() : null;
      recordTransfer({
        chain, wallet,
        txid: `${l.transactionHash}:${parseInt(l.logIndex ?? "0x0", 16)}`,
        tx_hash: l.transactionHash,
        block: parseInt(l.blockNumber, 16),
        payer, usd, asset: c.asset,
        external: isExternalPayment({ payer, usd }, { ourWallets: OUR_EVM_WALLETS, maxUsd: MAX_CALL_USD }),
      });
    }
    next = to + 1;
    chunks++;
    putCursor.run({
      chain, wallet, next_block: next, newest_sig: null, backfilled: 1,
      caught_up: next > head ? 1 : 0, updated_ts: Math.floor(Date.now() / 1000),
    });
    await sleep(150); // stay polite to public RPCs
  }
  return { caughtUp: next > head, next, head };
}

/** Solana: one-time page-to-genesis backfill, then follow new signatures. */
async function syncSolana(wallet, { maxPages = 5 } = {}) {
  const chain = "solana";
  const cur = getCursor.get(chain, wallet);
  const backfilled = Boolean(cur?.backfilled);
  let newest = cur?.newest_sig || null;
  let before = null; // backfill pagination anchor (restarts refetch dup pages; PK dedupes)
  let pages = 0;
  let sawEnd = backfilled;
  while (pages < maxPages) {
    const opts = { limit: 100 };
    if (backfilled && newest) opts.until = newest;
    if (!backfilled && before) opts.before = before;
    const sigs = await rpcCall(SOLANA_RPCS, "getSignaturesForAddress", [wallet, opts], 8000);
    if (!Array.isArray(sigs) || !sigs.length) { sawEnd = true; break; }
    if (!newest) newest = sigs[0].signature;
    if (backfilled) newest = sigs[0].signature; // follow mode: advance the anchor
    for (const s of sigs) {
      if (s.err) continue;
      try {
        const txn = await rpcCall(SOLANA_RPCS, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 8000);
        const usd = Number(usdcDeltaForOwner(txn?.meta, wallet).toFixed(6));
        if (usd > 0) {
          const payer = payerFromMeta(txn?.meta, wallet);
          recordTransfer({
            chain, wallet, txid: s.signature, tx_hash: s.signature,
            block: s.slot ?? null, when_ts: s.blockTime ?? null,
            payer, usd, asset: "USDC",
            external: isExternalPayment({ payer, usd }, { ourWallets: OUR_SOLANA_WALLETS, maxUsd: MAX_CALL_USD }),
          });
        }
        await sleep(200);
      } catch { /* skip an undecodable tx; the next full backfill pass never happens, but PK-idempotency makes a manual re-run safe */ }
    }
    pages++;
    if (backfilled) break; // follow mode needs one page per tick
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 100) { sawEnd = true; break; }
  }
  putCursor.run({
    chain, wallet, next_block: null, newest_sig: newest,
    backfilled: sawEnd ? 1 : 0, caught_up: sawEnd ? 1 : 0,
    updated_ts: Math.floor(Date.now() / 1000),
  });
  return { caughtUp: sawEnd };
}

/** All-time totals + sync progress — cheap enough to run per request. */
export function ledgerSummary({ walletAddress, solanaWallet }) {
  const per = {};
  let allTimeExternalUsd = 0;
  let allTimeExternalCount = 0;
  const q = db.prepare(`SELECT
      COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd,
      COALESCE(SUM(CASE WHEN external = 1 THEN usd END), 0) AS extUsd,
      COALESCE(SUM(external), 0) AS extN
    FROM transfers WHERE chain = ? AND wallet = ?`);
  // EVM rows are stored lowercase (sync normalizes); Solana base58 is case-exact.
  const chains = [...Object.keys(EVM).map((k) => [k, walletAddress?.toLowerCase()]), ["solana", solanaWallet]];
  for (const [chain, wallet] of chains) {
    if (!wallet) continue;
    const t = q.get(chain, wallet);
    const cur = getCursor.get(chain, wallet);
    per[chain] = {
      externalUsd: Number(t.extUsd.toFixed(6)),
      externalCount: t.extN,
      inboundUsd: Number(t.usd.toFixed(6)),
      inboundCount: t.n,
      caughtUp: Boolean(cur?.caught_up),
      syncedAt: cur?.updated_ts ?? null,
    };
    allTimeExternalUsd += t.extUsd;
    allTimeExternalCount += t.extN;
  }
  return {
    allTimeExternalUsd: Number(allTimeExternalUsd.toFixed(6)),
    allTimeExternalCount,
    perChain: per,
    persistent: ledgerPersistent,
    syncing: Object.values(per).some((p) => !p.caughtUp),
  };
}

let loopStarted = false;
/** Boot the background sync loop. Fast ticks while backfilling, then a
 *  5-minute tail. Errors back off to the next tick — never crash the app. */
export function startRevenueLedger({ walletAddress, solanaWallet }) {
  const enabled = HAS_DATA_DIR || process.env.REVENUE_LEDGER === "true";
  if (loopStarted || !enabled || (!walletAddress && !solanaWallet)) return false;
  loopStarted = true;
  const tick = async () => {
    let allCaughtUp = true;
    if (walletAddress) {
      for (const chain of Object.keys(EVM)) {
        try {
          const r = await syncEvmChain(chain, walletAddress.toLowerCase());
          if (!r.caughtUp) allCaughtUp = false;
        } catch (e) {
          allCaughtUp = false;
          console.warn(`revenue-ledger: ${chain} sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
        }
      }
    }
    if (solanaWallet) {
      try {
        const r = await syncSolana(solanaWallet);
        if (!r.caughtUp) allCaughtUp = false;
      } catch (e) {
        allCaughtUp = false;
        console.warn(`revenue-ledger: solana sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
      }
    }
    setTimeout(tick, allCaughtUp ? 300_000 : 20_000).unref?.();
  };
  setTimeout(tick, 5_000).unref?.(); // let boot settle first
  console.log(`revenue-ledger: sync loop started (db: ${DB_PATH})`);
  return true;
}
