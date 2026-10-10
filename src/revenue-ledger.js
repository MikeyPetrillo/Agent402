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
// new signatures. Stellar forward-pages Horizon /payments with one ascending
// cursor. SUM(external) is the all-time revenue figure; every row
// keeps its tx id, so the number stays independently verifiable.
//
// Zero config: runs whenever /data exists (i.e., prod) or when
// REVENUE_LEDGER=true forces it (local/dev); CI test boots have neither, so
// tests never hammer public RPCs.
//
// With STATE_DATABASE_URL set the transfers and cursors live in the state
// database and the SQLite file is a local read mirror of them (see "The
// ledger in the state database" below); without it nothing here changes.
import Database from "better-sqlite3";
import { leased, stateDbEnabled, stateQuery, stateDbSchema, withStateTx, importOnce, trackStoreReady, withSchemaLock } from "./state-db.js";
import { retryingLoad } from "./store-retry.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EVM, SOLANA_RPCS, rpcCall, pad, TRANSFER_TOPIC, USDC_SOL_MINT,
  MAX_CALL_USD, OUR_EVM_WALLETS, OUR_SOLANA_WALLETS, OUR_STELLAR_WALLETS, OUR_ALGORAND_WALLETS, USDC_ISSUER,
  getJsonAcross, ALGORAND_INDEXER_BASES,
} from "./revenue-live.js";
import { usdcDeltaForOwner, payerFromMeta, isExternalPayment } from "../scripts/revenue-scan-solana.js";
import { externalTempoPayments } from "./sales-ledger.js";
import { createBlockClock, rpcHeaderReader, dateFromAnchors } from "./block-clock.js";

const HAS_DATA_DIR = existsSync("/data");
const DB_PATH = process.env.REVENUE_LEDGER_DB || join(HAS_DATA_DIR ? "/data" : "/tmp", "agent402-revenue.db");
const USE_PG = stateDbEnabled();
export const ledgerPersistent = HAS_DATA_DIR || Boolean(process.env.REVENUE_LEDGER_DB) || USE_PG;

// Before the wallet's first funding (service launched 2026-06-12; margin
// back to May). Per-chain block time turns this into a start block, so no
// per-chain block numbers need hardcoding. Env-overridable per chain with
// an absolute block: REVENUE_LEDGER_FROM_BASE=31000000 etc.
const LEDGER_EPOCH_MS = Date.parse(process.env.REVENUE_LEDGER_EPOCH || "2026-05-20T00:00:00Z");
// EVM rows carry no chain timestamp, so ledgerDaily DATES THEM FROM BLOCK
// HEIGHT using these. A chain missing from this table fell back to 2000ms, and
// every chain that fell back is exactly the set that went missing from
// /revenue: a settle 20h old on Monad (real 302ms blocks, assumed 2000ms) was
// filed ~80 HOURS in the past, so it never appeared on the day it happened.
// The rows were there the whole time, under the wrong date.
//
// Measured 2026-08-01 by sampling 5,000 blocks per chain and dividing by the
// elapsed timestamps, not taken from docs:
//   base 2000 · arbitrum 249 · optimism 2000 · avalanche 1136
//   celo 1000 · sei 448 · monad 302
// New rows no longer depend on this at all (syncEvmChain now stores the real
// block timestamp); it remains only to date rows recorded before that landed.
export const LEDGER_BLOCK_MS = {
  base: 2000, polygon: 2100, arbitrum: 250, robinhood: 150, // robinhood measured ~0.15s (not the 2s Orbit default)
  monad: 300, celo: 1000, avalanche: 1140, sei: 450, optimism: 2000,
};
const BLOCK_MS = LEDGER_BLOCK_MS;

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
-- ledgerRecent() runs once per rail at boot (revenueSnapshot warm) and asks for
-- the newest 8 transfers by (chain, wallet) ordered by block, then when_ts. With
-- only the (wallet, external, chain) index every call sorted a wallet's whole
-- history: 2.05 s of the boot event loop on prod (first-import CPU profile,
-- 2026-08-25). This index answers it as an ordered scan of 8 rows.
CREATE INDEX IF NOT EXISTS idx_transfers_recent ON transfers (chain, wallet, block DESC, when_ts DESC);
-- The buyer figures fold external Tempo settlements in from the sales ledger
-- and skip any whose tx is already a transfer here; this answers that lookup.
CREATE INDEX IF NOT EXISTS idx_transfers_txhash ON transfers (tx_hash);
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

// Ledger-wide one-shot migrations, keyed so each runs once per database.
db.exec(`CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT)`);
export function runLedgerMigrations() {
  const has = (k) => Boolean(db.prepare("SELECT 1 FROM ledger_meta WHERE key = ?").get(k));
  const mark = (k) => db.prepare("INSERT OR REPLACE INTO ledger_meta (key, value) VALUES (?, ?)").run(k, new Date().toISOString());
  const applied = [];
  // 2026-09-09: the Algorand scanner skipped one full descending page per
  // walk, so rows below the live cursor were never read. Reset the cursor
  // once; the next ticks re-walk the account (a few pages) and the transfers
  // primary key makes the re-read a no-op for everything already held.
  if (!has("algorand-rescan-2026-09-09")) {
    const r = db.prepare("UPDATE cursors SET next_block = 0, newest_sig = NULL, caught_up = 0 WHERE chain = 'algorand'").run();
    mark("algorand-rescan-2026-09-09");
    applied.push(`algorand-rescan-2026-09-09 (${r.changes} cursor row${r.changes === 1 ? "" : "s"} reset)`);
  }
  return applied;
}
for (const line of runLedgerMigrations()) console.log(`revenue-ledger: migration ${line}`);


const upsertTransfer = db.prepare(`INSERT OR IGNORE INTO transfers
  (chain, wallet, txid, tx_hash, block, when_ts, payer, usd, asset, external)
  VALUES (@chain, @wallet, @txid, @tx_hash, @block, @when_ts, @payer, @usd, @asset, @external)`);
const getCursor = db.prepare("SELECT * FROM cursors WHERE chain = ? AND wallet = ?");
const putCursor = db.prepare(`INSERT INTO cursors (chain, wallet, next_block, newest_sig, backfilled, caught_up, updated_ts)
  VALUES (@chain, @wallet, @next_block, @newest_sig, @backfilled, @caught_up, @updated_ts)
  ON CONFLICT (chain, wallet) DO UPDATE SET
    next_block = excluded.next_block, newest_sig = excluded.newest_sig,
    backfilled = excluded.backfilled, caught_up = excluded.caught_up, updated_ts = excluded.updated_ts`);

// ---------------------------------------------------------------------------
// The ledger in the state database (STATE_DATABASE_URL set)
// ---------------------------------------------------------------------------
// With a database the transfers and cursors live in two tables of the state
// schema and the SQLite file above becomes a LOCAL READ MIRROR of them: filled
// from the tables at the first load (trackStoreReady, so the server waits
// before it listens) and refreshed after every sync tick, so every reader
// below keeps its synchronous signature and its SQL unchanged. The sync loop
// reads its cursors from the tables (the truth, which another container may
// have advanced), writes a chunk's transfers and its cursor in ONE transaction
// (a cursor never advances past rows that are not stored), then applies the
// same rows to the mirror. The file is imported into the tables once
// (insert-if-absent, so two containers booting at once are safe); after that
// it is a mirror, and on a container without the volume it is a scratch file
// rebuilt from the tables at boot. A rollback to the build that reads the
// file alone resumes from the file's own cursors, and the primary key makes
// its rescan a no-op for every row it already holds.
//
// The SQLite-era migrations above (ledger_meta, user_version) keep running
// on the file: every row they would touch was migrated before the import.
const T = (t) => `${stateDbSchema()}.${t}`;
const PG_DDL = () => `
  CREATE TABLE IF NOT EXISTS ${T("revenue_transfers")} (
    seq      BIGSERIAL,
    chain    TEXT NOT NULL,
    wallet   TEXT NOT NULL,
    txid     TEXT NOT NULL,
    tx_hash  TEXT NOT NULL,
    block    BIGINT,
    when_ts  BIGINT,
    payer    TEXT,
    usd      DOUBLE PRECISION NOT NULL,
    asset    TEXT NOT NULL,
    external SMALLINT NOT NULL,
    PRIMARY KEY (chain, wallet, txid)
  );
  CREATE INDEX IF NOT EXISTS revenue_transfers_seq ON ${T("revenue_transfers")} (seq);
  CREATE TABLE IF NOT EXISTS ${T("revenue_cursors")} (
    chain      TEXT NOT NULL,
    wallet     TEXT NOT NULL,
    next_block BIGINT,
    newest_sig TEXT,
    backfilled SMALLINT NOT NULL DEFAULT 0,
    caught_up  SMALLINT NOT NULL DEFAULT 0,
    updated_ts BIGINT,
    PRIMARY KEY (chain, wallet)
  );
`;
let pgTablesReady = null;
// Under the schema lock: two containers creating these at once would otherwise race on the catalog.
const pgTables = () => (pgTablesReady ||= withSchemaLock((c) => c.query(PG_DDL())).catch((e) => { pgTablesReady = null; throw e; }));
const intOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
// A row as the tables and the mirror both store it: the SQLite shape with the
// integer columns made integers (a chain timestamp is whole seconds).
const pgRow = (row) => ({
  chain: String(row.chain), wallet: String(row.wallet), txid: String(row.txid), tx_hash: row.tx_hash ?? null,
  block: intOrNull(row.block), when_ts: intOrNull(row.when_ts), payer: row.payer ?? null,
  usd: Number(row.usd), asset: row.asset ?? null, external: row.external ? 1 : 0,
});
const cursorFromPg = (r) => (r ? {
  chain: r.chain, wallet: r.wallet, next_block: intOrNull(r.next_block), newest_sig: r.newest_sig ?? null,
  backfilled: Number(r.backfilled) || 0, caught_up: Number(r.caught_up) || 0, updated_ts: intOrNull(r.updated_ts),
} : undefined);

async function pgInsertTransfers(client, rows) {
  if (!rows.length) return;
  const col = (k) => rows.map((r) => r[k] ?? null);
  await client.query(
    `INSERT INTO ${T("revenue_transfers")} (chain, wallet, txid, tx_hash, block, when_ts, payer, usd, asset, external)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::bigint[], $7::text[], $8::float8[], $9::text[], $10::smallint[])
     ON CONFLICT (chain, wallet, txid) DO NOTHING`,
    [col("chain"), col("wallet"), col("txid"), col("tx_hash"), col("block"), col("when_ts"), col("payer"), col("usd"), col("asset"), col("external")],
  );
}
async function pgPutCursor(client, c, { ifAbsent = false } = {}) {
  await client.query(
    `INSERT INTO ${T("revenue_cursors")} (chain, wallet, next_block, newest_sig, backfilled, caught_up, updated_ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain, wallet) DO ${ifAbsent ? "NOTHING" : `UPDATE SET next_block = EXCLUDED.next_block, newest_sig = EXCLUDED.newest_sig,
       backfilled = EXCLUDED.backfilled, caught_up = EXCLUDED.caught_up, updated_ts = EXCLUDED.updated_ts`}`,
    [String(c.chain), String(c.wallet), intOrNull(c.next_block), c.newest_sig ?? null, c.backfilled ? 1 : 0, c.caught_up ? 1 : 0, intOrNull(c.updated_ts)],
  );
}
async function pgGetCursor(chain, wallet) {
  await pgTables();
  const r = await stateQuery(`SELECT * FROM ${T("revenue_cursors")} WHERE chain = $1 AND wallet = $2`, [chain, wallet]);
  return cursorFromPg(r.rows[0]);
}

// The mirror never decides anything: a failed mirror write is logged once and
// the next refresh pulls the row again.
let mirrorWarned = false;
function mirror(fn) {
  try { db.transaction(fn)(); }
  catch (e) {
    if (mirrorWarned) return;
    mirrorWarned = true;
    console.warn(`revenue-ledger: mirror write failed (${String(e?.message || e).slice(0, 100)}); the next refresh retries`);
  }
}

// Transfers a scan found, waiting for the cursor write that covers them.
const staged = new Map(); // "chain|wallet" -> rows
const stageKey = (chain, wallet) => `${chain}|${wallet}`;
/** A transfer found by a scan. On the file it is written at once (as before);
 *  with a database it is held until writeCursor() stores it with its cursor. */
function stageTransfer(row) {
  if (!USE_PG) { recordTransfer(row); return; }
  const r = pgRow(row);
  const k = stageKey(r.chain, r.wallet);
  if (!staged.has(k)) staged.set(k, []);
  staged.get(k).push(r);
}
/** Write a cursor; with a database, the transfers staged for it land in the
 *  same transaction, so the cursor can never say "scanned" about rows that
 *  are not stored. On a failure nothing is kept: the scan replays from the
 *  stored cursor on the next tick and the primary key dedupes the replay. */
async function writeCursor(cur) {
  if (!USE_PG) { putCursor.run(cur); return; }
  const k = stageKey(cur.chain, cur.wallet);
  const rows = staged.get(k) || [];
  staged.delete(k);
  await pgTables();
  await withStateTx(async (client) => {
    await pgInsertTransfers(client, rows);
    await pgPutCursor(client, cur);
  });
  mirror(() => { for (const r of rows) upsertTransfer.run(r); putCursor.run(cur); });
}
/** The cursor a scan resumes from: the tables with a database, the file without. */
const readCursor = (chain, wallet) => (USE_PG ? pgGetCursor(chain, wallet) : getCursor.get(chain, wallet));

/** Import the file once. The mirror IS the file at this point (nothing has
 *  been pulled yet), so its tables hold exactly what the file held; every row
 *  is insert-if-absent. */
const IMPORT_NAME = DB_PATH.split("/").pop();
const IMPORT_PAGE = 2000;
async function importSqliteFile() {
  let rows = 0, cursors = 0;
  const page = db.prepare("SELECT rowid, chain, wallet, txid, tx_hash, block, when_ts, payer, usd, asset, external FROM transfers WHERE rowid > ? ORDER BY rowid LIMIT ?");
  let after = 0;
  for (;;) {
    const batch = page.all(after, IMPORT_PAGE);
    if (!batch.length) break;
    await withStateTx((client) => pgInsertTransfers(client, batch.map(pgRow)));
    rows += batch.length;
    after = batch[batch.length - 1].rowid;
    if (batch.length < IMPORT_PAGE) break;
    await new Promise((r) => setImmediate(r));
  }
  const curs = db.prepare("SELECT * FROM cursors").all();
  if (curs.length) {
    await withStateTx(async (client) => { for (const c of curs) await pgPutCursor(client, c, { ifAbsent: true }); });
    cursors = curs.length;
  }
  let bytes = 0;
  try { bytes = statSync(DB_PATH).size; } catch { /* no file yet: nothing to measure */ }
  if (rows || cursors) console.log(`revenue-ledger: imported ${rows} transfer(s) and ${cursors} cursor(s) from ${DB_PATH} into the state database`);
  return { bytes, rows, cursors };
}

// Pull what the tables hold past the mirror's watermark, a page per turn.
// The watermark is this process's: a boot pulls everything (a container
// without the volume starts from an empty file). A row another container
// committed with a lower seq after this process read past it is picked up at
// the next boot; the lease keeps two ticks from writing at once, so that is
// the hand-over moment at most.
let mirrorSeq = 0;
const MIRROR_PAGE = 2000;
async function refreshMirror() {
  await pgTables();
  for (;;) {
    const r = await stateQuery(
      `SELECT seq, chain, wallet, txid, tx_hash, block, when_ts, payer, usd, asset, external FROM ${T("revenue_transfers")} WHERE seq > $1 ORDER BY seq LIMIT $2`,
      [mirrorSeq, MIRROR_PAGE],
    );
    if (!r.rows.length) break;
    const rows = r.rows.map(pgRow);
    mirror(() => { for (const x of rows) upsertTransfer.run(x); });
    mirrorSeq = Number(r.rows[r.rows.length - 1].seq);
    if (r.rows.length < MIRROR_PAGE) break;
    await new Promise((res) => setImmediate(res));
  }
  const c = await stateQuery(`SELECT * FROM ${T("revenue_cursors")}`);
  const curs = c.rows.map(cursorFromPg);
  mirror(() => { for (const x of curs) putCursor.run(x); });
}

// The first load is retried until it lands, within the boot: a failed
// attempt is forgotten and tried again by a background timer (and by the next
// tick), so a blip at boot never leaves the import or the mirror undone.
const storeLoader = USE_PG ? retryingLoad("revenue-ledger: state database", async () => {
  await pgTables();
  const imp = await importOnce(IMPORT_NAME, { source: DB_PATH, run: importSqliteFile });
  await refreshMirror();
  return imp;
}) : null;
if (storeLoader) { trackStoreReady(storeLoader.eventually); storeLoader.ready().catch(() => {}); }
const storeReadyP = () => (storeLoader ? storeLoader.ready().catch(() => ({ imported: false, error: true })) : Promise.resolve({ imported: false }));
/** Resolves once the first load has finished (the file imported once, the
 *  mirror filled), `{ error: true }` while it has not landed yet (it is
 *  retried); already resolved without a database. */
export function ledgerStoreReady() { return storeReadyP(); }
/** Tests and operators: pull the tables into the mirror now. No-op without a database. */
export async function refreshLedgerMirror() { if (USE_PG) await refreshMirror(); }

// One-off reclassification (user_version-gated): `external` is stamped at
// record time, so rule changes (the $0.50→$0.75 ceiling; wallets later added
// to the OUR_* sets, e.g. the SOR spending wallets) never touched stored
// rows. Recompute every row under the CURRENT rules whenever the migration
// version bumps. Idempotent, runs once per version, ~20k rows in well under
// a second.
const RECLASS_VERSION = 1;
function reclassifyAll() {
  if (db.pragma("user_version", { simple: true }) >= RECLASS_VERSION) return;
  const sets = { solana: OUR_SOLANA_WALLETS, stellar: OUR_STELLAR_WALLETS, algorand: OUR_ALGORAND_WALLETS };
  const rows = db.prepare("SELECT rowid, chain, payer, usd, external FROM transfers").all();
  const upd = db.prepare("UPDATE transfers SET external = ? WHERE rowid = ?");
  let flipped = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const ours = sets[r.chain] || OUR_EVM_WALLETS;
      const ext = isExternalPayment({ payer: r.payer, usd: r.usd }, { ourWallets: ours, maxUsd: MAX_CALL_USD }) ? 1 : 0;
      if (ext !== r.external) { upd.run(ext, r.rowid); flipped++; }
    }
    db.pragma(`user_version = ${RECLASS_VERSION}`);
  });
  tx();
  if (flipped) console.log(`revenue-ledger: reclassified ${flipped} rows under current rules (v${RECLASS_VERSION})`);
}
reclassifyAll();

/**
 * Dates a row that carries no timestamp (rows recorded before syncEvmChain
 * stored one, or whose block lookup failed). It interpolates between the
 * chain's own DATED rows on either side, and steps from the nearest one at the
 * chain's table rate only past the ends. Anchoring on the chain's own
 * timestamps is what keeps a legacy row's date right after a block-time
 * change: the old method stepped back from the cursor head at a fixed 2 s per
 * block, which after Base's move to 200 ms blocks would file every legacy row
 * days too early. The cursor (when caught up) is one more anchor. Returns a
 * function block -> ms | null; the anchors are read lazily, once.
 */
export function undatedRowDater(chain, wallet, { anchorsFor = datedAnchors } = {}) {
  let anchors = null;
  return (block) => {
    if (block == null) return null;
    if (!anchors) anchors = anchorsFor(chain, wallet);
    return dateFromAnchors(Number(block), anchors, BLOCK_MS[chain] || 2000);
  };
}
function datedAnchors(chain, wallet) {
  const pts = db.prepare("SELECT block, MIN(when_ts) AS ts FROM transfers WHERE chain = ? AND when_ts IS NOT NULL AND block IS NOT NULL GROUP BY block ORDER BY block").all(chain)
    .map((r) => [Number(r.block), Number(r.ts) * 1000]);
  const cur = getCursor.get(chain, wallet);
  if (cur?.caught_up && cur.next_block != null && cur.updated_ts && (!pts.length || cur.next_block > pts[pts.length - 1][0])) {
    pts.push([Number(cur.next_block), cur.updated_ts * 1000]);
  }
  return pts;
}

/** Record one transfer (idempotent: the PK dedupes replays/rescans).
 *  Synchronous on the file. With a database it returns a promise that
 *  resolves once the row is stored in the tables (and mirrored); a caller
 *  that must know the row is durable awaits it. */
export function recordTransfer(row) {
  if (!USE_PG) { upsertTransfer.run({ when_ts: null, payer: null, ...row, external: row.external ? 1 : 0 }); return; }
  const r = pgRow(row);
  return pgTables()
    .then(() => withStateTx((client) => pgInsertTransfers(client, [r])))
    .then(() => { mirror(() => upsertTransfer.run(r)); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Where a NEW cursor starts: the first block at or after the ledger epoch,
 *  found by block timestamp (src/block-clock.js). A block count at an assumed
 *  rate starts too late once a chain's blocks get faster (Base Denim: 2 s to
 *  200 ms), silently skipping the oldest revenue; the timestamp search is right
 *  either side of that change. Falls back to the rate estimate when no header
 *  can be read. `getHeader` is injectable for tests. */
export async function startBlockFor(chain, head, { getHeader = null, epochMs = LEDGER_EPOCH_MS } = {}) {
  const env = parseInt(process.env[`REVENUE_LEDGER_FROM_${chain.toUpperCase()}`] || "", 10);
  if (Number.isFinite(env)) return Math.max(0, env);
  const estimate = Math.max(0, head - Math.ceil((Date.now() - epochMs) / (BLOCK_MS[chain] || 2000)));
  try {
    const reader = getHeader || rpcHeaderReader((m, p) => rpcCall(EVM[chain].rpcs, m, p, 6000));
    const at = await createBlockClock(reader, { fallbackMsPerBlock: BLOCK_MS[chain] || 2000 }).blockAtOrAfter(Math.floor(epochMs / 1000), { headNumber: head });
    return at.source === "chain" ? at.block : Math.min(estimate, at.block);
  } catch { return estimate; }
}

/** getLogs window for one chain's ledger sync. Chains whose RPCs enforce a
 *  tighter range declare chunkBlocks (Sei: 1,900) — both other scanners
 *  honored it, this one didn't, so every Sei tick sent a 9,000-block range,
 *  the primary rejected it, the fallback walk ended on publicnode's archive
 *  gate, and the cursor never advanced: ZERO Sei rows ever despite daily
 *  canary settles (verified on-chain 2026-07-30). sei-apis serves any depth
 *  at ≤1,900 blocks per request, so backfill needs no archive lane. */
export const ledgerChunkBlocks = (c) => Math.min(c.chunkBlocks || 9000, 9000, Math.ceil(c.span / 4));

/** Advance one EVM chain's cursor by up to `maxChunks` getLogs windows. */
// Providers disagree, loudly and in their own words, about how many blocks one
// eth_getLogs may span. Measured against the ledger's own 9,000-block chunk:
//
//   avalanche  "requested too many blocks"
//   celo       "query exceeds range, retry smaller (max blocks ...)"
//   monad      "eth_getLogs is limited to a 100 range"
//
// Only `sei` ever declared a chunkBlocks, so every other chain's FALLBACK RPCs
// were unusable: the moment the first lane (Alchemy, where configured) has a
// bad day, rpcCall walks to a public RPC that rejects the range outright, the
// whole tick throws, and the chain simply stops reporting revenue.
//
// So a range rejection is no longer fatal. Parse the limit the provider names,
// or halve, and retry the SAME range smaller. The caller narrows its chunk for
// the rest of the run so one probe teaches the whole tick.
//
// The cursor is untouched here on purpose. It advances only after a range has
// actually been scanned, so a chunk that can never succeed throws and gets
// logged rather than silently skipping blocks - the one outcome that would
// lose revenue permanently.
const RANGE_ERR = /too many blocks|exceeds? range|limited to a \d+ range|range too large|block range|query returned more than/i;
const MIN_CHUNK = 100;

/**
 * Given a provider's rejection and the span we tried, what should we try next?
 * Returns null when the error is NOT a range complaint, so genuine failures
 * (auth, archive gates, network) still propagate instead of being retried into
 * a smaller shape that will fail identically.
 *
 * Exported because these three strings are real, measured provider output, and
 * a regex that stops matching them is how the fallback lanes silently die again.
 */
export function nextChunkSpan(message, span) {
  const msg = String(message || "");
  if (!RANGE_ERR.test(msg) || span <= MIN_CHUNK) return null;
  // Prefer the number the provider states ("limited to a 100 range") over a
  // blind reduction: it converges in one step instead of several.
  const stated = Number((msg.match(/(\d{2,6})\s*(?:block)?\s*range/i) || msg.match(/max blocks?\D{0,12}(\d{2,6})/i) || [])[1]);
  if (Number.isFinite(stated) && stated >= MIN_CHUNK && stated < span) return stated;
  return Math.max(MIN_CHUNK, Math.floor(span / 4));
}

async function getLogsAdaptive(c, wallet, from, to, onNarrow) {
  let span = to - from + 1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const hi = from + span - 1;
    try {
      const scannedTo = Math.min(hi, to);
      const logs = await rpcCall(c.rpcs, "eth_getLogs", [{
        address: c.token,
        topics: [TRANSFER_TOPIC, null, pad(wallet)],
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + scannedTo.toString(16),
      }], 8000);
      // Return the range actually covered. A narrowed retry scans LESS than the
      // caller asked for, and advancing the cursor past what was scanned would
      // skip those blocks forever - silently, since nothing throws.
      return { logs, scannedTo };
    } catch (e) {
      const msg = String(e?.message || e);
      const narrowed = nextChunkSpan(msg, span);
      if (narrowed === null) throw e;
      span = narrowed;
      onNarrow?.(span);
      console.warn(`revenue-ledger: ${c.label} narrowed getLogs chunk to ${span} blocks (provider: ${msg.slice(0, 60)})`);
    }
  }
  throw new Error(`${c.label}: getLogs kept failing down to ${span}-block ranges`);
}

async function syncEvmChain(chain, wallet, { maxChunks = 20 } = {}) {
  const c = EVM[chain];
  const head = parseInt(await rpcCall(c.rpcs, "eth_blockNumber", [], 6000), 16);
  const cur = await readCursor(chain, wallet);
  let next = cur?.next_block ?? await startBlockFor(chain, head);
  // Capped at 9,000 blocks like the other two scanners (revenue-scan.js and
  // the live view's recentInbound) — Alchemy rejects getLogs ranges over 10k
  // on some chains (Robinhood, verified 2026-07-08). Without the cap, any
  // cursor gap wider than the RPC limit (≈25 min of downtime at Robinhood's
  // 0.15s blocks) made every subsequent getLogs request span the whole gap,
  // fail, and never advance — the all-time figure froze with ↺ forever.
  let chunkSize = ledgerChunkBlocks(c);
  let chunks = 0;
  while (next <= head && chunks < maxChunks) {
    const to = Math.min(next + chunkSize - 1, head);
    const { logs, scannedTo } = await getLogsAdaptive(c, wallet, next, to, (smaller) => { chunkSize = smaller; });
    // EXACT dates, so a row never depends on a block-rate estimate again.
    // Only blocks that actually CONTAIN a transfer are fetched, and transfers
    // are rare (a handful per chain per day), so this is a few extra calls a
    // day rather than one per block. A failed lookup leaves when_ts null and
    // the estimate above still applies, so this can only improve accuracy.
    const blockTimes = new Map();
    for (const l of Array.isArray(logs) ? logs : []) {
      if (l?.blockNumber && !blockTimes.has(l.blockNumber)) blockTimes.set(l.blockNumber, null);
    }
    for (const bn of blockTimes.keys()) {
      try {
        const blk = await rpcCall(c.rpcs, "eth_getBlockByNumber", [bn, false], 6000);
        if (blk?.timestamp) blockTimes.set(bn, parseInt(blk.timestamp, 16));
      } catch { /* keep null - falls back to the height estimate */ }
    }
    for (const l of Array.isArray(logs) ? logs : []) {
      const usd = Number(BigInt(l.data && l.data !== "0x" ? l.data : "0x0")) / 1e6;
      const payer = l.topics?.[1] ? ("0x" + l.topics[1].slice(-40)).toLowerCase() : null;
      stageTransfer({
        chain, wallet,
        txid: `${l.transactionHash}:${parseInt(l.logIndex ?? "0x0", 16)}`,
        tx_hash: l.transactionHash,
        block: parseInt(l.blockNumber, 16),
        when_ts: blockTimes.get(l.blockNumber) ?? null,
        payer, usd, asset: c.asset,
        external: isExternalPayment({ payer, usd }, { ourWallets: OUR_EVM_WALLETS, maxUsd: MAX_CALL_USD }),
      });
    }
    next = scannedTo + 1;   // only past what was actually scanned
    chunks++;
    await writeCursor({
      chain, wallet, next_block: next, newest_sig: null, backfilled: 1,
      caught_up: next > head ? 1 : 0, updated_ts: Math.floor(Date.now() / 1000),
    });
    await sleep(150); // stay polite to public RPCs
  }
  return { caughtUp: next > head, next, head };
}

/** Solana: one-time page-to-genesis backfill, then follow new signatures. */
// An EMPTY page ends a scan, and that end has to be written: every scanner used
// to `break` before its putCursor, so a wallet whose last non-empty page was a
// FULL page kept caught_up=0 and a stale updated_ts for as long as nothing new
// arrived - /revenue showed Algorand "still syncing" for ten hours on 2026-09-09
// with the scan actually complete (6,220 rows, indexer answering in 200 ms).
// The cursor itself is unchanged; only the verdict and the timestamp move.
async function markCaughtUp(chain, wallet) {
  const cur = await readCursor(chain, wallet);
  await writeCursor({
    chain, wallet,
    next_block: cur?.next_block ?? null, newest_sig: cur?.newest_sig ?? null,
    backfilled: 1, caught_up: 1, updated_ts: Math.floor(Date.now() / 1000),
  });
}

export async function syncSolana(wallet, { maxPages = 5 } = {}) {
  const chain = "solana";
  // Signatures MUST be read from the USDC associated token account, not the
  // owner: an inbound SPL transfer references only the token accounts, so
  // the owner's signature list never shows incoming settles (it only carried
  // ATA-creation/funding txs — the ledger recorded those, marked itself
  // caught up, and froze). Same resolution as the live card's solanaRail.
  const accts = await rpcCall(SOLANA_RPCS, "getTokenAccountsByOwner", [wallet, { mint: USDC_SOL_MINT }, { encoding: "jsonParsed" }], 8000);
  const tokenAccount = accts?.value?.[0]?.pubkey;
  if (!tokenAccount) throw new Error("no USDC token account found for the wallet");
  const cur = await readCursor(chain, wallet);
  // next_block (unused on Solana) doubles as a mode sentinel: cursors written
  // before the token-account fix lack it, and their backfilled flag and
  // newest anchor describe the owner's history — discard both so the first
  // tick re-pages the token account's full history (the transfers PK dedupes
  // anything already recorded).
  const tokenMode = cur?.next_block === 1;
  const backfilled = tokenMode && Boolean(cur?.backfilled);
  let newest = tokenMode ? (cur?.newest_sig || null) : null;
  let before = null; // backfill pagination anchor (restarts refetch dup pages; PK dedupes)
  let pages = 0;
  let sawEnd = backfilled;
  while (pages < maxPages) {
    const opts = { limit: 100 };
    if (backfilled && newest) opts.until = newest;
    if (!backfilled && before) opts.before = before;
    const sigs = await rpcCall(SOLANA_RPCS, "getSignaturesForAddress", [tokenAccount, opts], 8000);
    if (!Array.isArray(sigs) || !sigs.length) { sawEnd = true; await markCaughtUp(chain, wallet); break; }
    if (!newest) newest = sigs[0].signature;
    if (backfilled) newest = sigs[0].signature; // follow mode: advance the anchor
    for (const s of sigs) {
      if (s.err) continue;
      // No try/catch here: rpcCall only throws when the RPC lane itself fails
      // (429/timeout — a genuinely undecodable tx returns a null result, and
      // usdcDeltaForOwner(null) is just 0). Swallowing that error silently
      // dropped the settle from all-time forever, because the cursor advanced
      // past it and no full re-pass ever happens. Let it propagate instead:
      // putCursor never runs, the tick retries in 20s, and the PK dedupes the
      // replayed page.
      const txn = await rpcCall(SOLANA_RPCS, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 8000);
      const usd = Number(usdcDeltaForOwner(txn?.meta, wallet).toFixed(6));
      if (usd > 0) {
        const payer = payerFromMeta(txn?.meta, wallet);
        stageTransfer({
          chain, wallet, txid: s.signature, tx_hash: s.signature,
          block: s.slot ?? null, when_ts: s.blockTime ?? null,
          payer, usd, asset: "USDC",
          external: isExternalPayment({ payer, usd }, { ourWallets: OUR_SOLANA_WALLETS, maxUsd: MAX_CALL_USD }),
        });
      }
      await sleep(200);
    }
    pages++;
    if (backfilled) break; // follow mode needs one page per tick
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 100) { sawEnd = true; break; }
  }
  await writeCursor({
    chain, wallet, next_block: 1, newest_sig: newest,
    backfilled: sawEnd ? 1 : 0, caught_up: sawEnd ? 1 : 0,
    updated_ts: Math.floor(Date.now() / 1000),
  });
  return { caughtUp: sawEnd };
}

/** Stellar: forward-page Horizon /payments from account genesis, then keep
 *  following. One ascending cursor (the record paging_token, stored in the
 *  newest_sig column) covers both backfill and tail — Horizon pages are
 *  ordered and cursor-resumable, so restarts continue where they left off.
 *  Classification mirrors stellarRail: classic payments checked for the
 *  Circle USDC issuer; Soroban invoke_host_function credited from its
 *  asset_balance_changes (r.source_account is the facilitator's fee channel,
 *  the change's `from` is the actual payer). */
export async function syncStellar(wallet, { maxPages = 5 } = {}) {
  const chain = "stellar";
  const cur = await readCursor(chain, wallet);
  let cursor = cur?.newest_sig || null;
  const ours = new Set([...OUR_STELLAR_WALLETS, wallet]);
  let sawEnd = false;
  for (let pages = 0; pages < maxPages && !sawEnd; pages++) {
    const url = new URL(`https://horizon.stellar.org/accounts/${wallet}/payments`);
    url.searchParams.set("order", "asc");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Horizon HTTP ${res.status}`);
    const records = (await res.json())?._embedded?.records || [];
    if (!records.length) { sawEnd = true; await markCaughtUp(chain, wallet); break; }
    for (const r of records) {
      cursor = r.paging_token;
      let usd = null, payer = null;
      if (r.type === "payment" || r.type === "path_payment_strict_send" || r.type === "path_payment_strict_receive") {
        if (r.to !== wallet || r.asset_code !== "USDC" || r.asset_issuer !== USDC_ISSUER) continue;
        usd = Number(r.amount) || 0;
        payer = r.from || null;
      } else if (r.type === "invoke_host_function") {
        const changes = (r.asset_balance_changes || []).filter(
          (c) => c.type === "transfer" && c.to === wallet && c.asset_code === "USDC" && c.asset_issuer === USDC_ISSUER
        );
        if (!changes.length) continue;
        usd = Number(changes.reduce((s, c) => s + Number(c.amount || 0), 0).toFixed(7));
        payer = changes[0].from || null;
      } else continue;
      stageTransfer({
        chain, wallet, txid: String(r.id), tx_hash: r.transaction_hash,
        block: null, when_ts: r.created_at ? Math.floor(Date.parse(r.created_at) / 1000) : null,
        payer, usd, asset: "USDC",
        external: isExternalPayment({ payer, usd }, { ourWallets: ours, maxUsd: MAX_CALL_USD }),
      });
    }
    if (records.length < 200) sawEnd = true;
    await writeCursor({
      chain, wallet, next_block: null, newest_sig: cursor,
      backfilled: sawEnd ? 1 : 0, caught_up: sawEnd ? 1 : 0,
      updated_ts: Math.floor(Date.now() / 1000),
    });
    if (!sawEnd) await sleep(300); // stay polite to Horizon
  }
  return { caughtUp: sawEnd };
}

/** Algorand: forward-page AlgoNode's indexer for inbound ASA 31566704 (USDC)
 *  transfers, ascending by round, using next_block as the round cursor (the
 *  AVM's block number — same role the EVM chains' next_block plays; Algorand
 *  has no signature/paging_token to reuse the way Solana/Stellar do). One
 *  indexer page (limit 1000) per chunk; a short page (< limit) means caught
 *  up. min-round is bumped past the highest confirmed-round actually seen
 *  each page (not just cursor+limit), so it's correct regardless of the
 *  indexer's internal sort order. Classification mirrors algorandRail: a
 *  per-record asset-id re-check even though the URL already filters —
 *  defense in depth against a filter regression/typo. */
// ALGORAND_INDEXER_URL pins a single indexer; otherwise walk the shared base
// list from revenue-live (Cloudflare relay first when configured — Nodely
// 403s Railway's egress IP, see workers/algorand-relay/).
const ALGORAND_INDEXER_LIST = process.env.ALGORAND_INDEXER_URL
  ? [process.env.ALGORAND_INDEXER_URL.trim().replace(/\/+$/, "")]
  : ALGORAND_INDEXER_BASES;
const ALGORAND_USDC_ASA = 31566704;
export async function syncAlgorand(wallet, { maxPages = 5 } = {}) {
  const chain = "algorand";
  const cur = await readCursor(chain, wallet);
  const ours = new Set([...OUR_ALGORAND_WALLETS, wallet]);
  // The indexer serves an account's transactions NEWEST FIRST and has no order
  // parameter, so one tick is one WALK: min-round pinned at the cursor for the
  // whole walk, pages followed by the indexer's own next-token until a short
  // page. The cursor moves only when the walk completes. The earlier loop
  // bumped min-round past the newest round of each page, which on a full
  // descending page skipped every row between the old cursor and that page's
  // oldest row - measured 2026-09-09: 7,220 inbound transfers at the indexer,
  // 6,220 in the ledger, exactly one page lost. A walk cut short by maxPages
  // persists its next-token (JSON in newest_sig) and resumes next tick.
  const minRound = cur?.next_block ?? 0;
  let token = null;
  let highestRound = minRound - 1;
  if (cur?.newest_sig) {
    try {
      const w = JSON.parse(cur.newest_sig);
      if (w && w.walkFrom === minRound && typeof w.next === "string" && w.next) {
        token = w.next;
        if (Number.isFinite(Number(w.high))) highestRound = Math.max(highestRound, Number(w.high));
      }
    } catch { /* a legacy or foreign value: start the walk over from min-round */ }
  }
  let sawEnd = false;
  for (let pages = 0; pages < maxPages && !sawEnd; pages++) {
    const path =
      `/v2/accounts/${wallet}/transactions?asset-id=${ALGORAND_USDC_ASA}` +
      `&tx-type=axfer&min-round=${minRound}&limit=1000` + (token ? `&next=${encodeURIComponent(token)}` : "");
    const res = await getJsonAcross(ALGORAND_INDEXER_LIST, path, { timeoutMs: 8000 });
    if (!res.ok) throw new Error(res.error || `indexer HTTP ${res.status}`);
    const txns = res.json?.transactions || [];
    for (const t of txns) {
      const xfer = t["asset-transfer-transaction"];
      if (!xfer || xfer["asset-id"] !== ALGORAND_USDC_ASA || xfer.receiver !== wallet) continue;
      const usd = Number(xfer.amount) / 1e6;
      const payer = t.sender || null;
      stageTransfer({
        chain, wallet, txid: t.id, tx_hash: t.id,
        block: t["confirmed-round"] ?? null,
        when_ts: t["round-time"] ?? null,
        payer, usd, asset: "USDC",
        external: isExternalPayment({ payer, usd }, { ourWallets: ours, maxUsd: MAX_CALL_USD }),
      });
      if (Number.isFinite(t["confirmed-round"])) highestRound = Math.max(highestRound, t["confirmed-round"]);
    }
    const nextToken = typeof res.json?.["next-token"] === "string" ? res.json["next-token"] : null;
    if (txns.length < 1000 || !nextToken) {
      sawEnd = true;
      await writeCursor({
        chain, wallet, next_block: highestRound + 1, newest_sig: null,
        backfilled: 1, caught_up: 1, updated_ts: Math.floor(Date.now() / 1000),
      });
    } else {
      token = nextToken;
      await writeCursor({
        chain, wallet, next_block: minRound, newest_sig: JSON.stringify({ walkFrom: minRound, next: token, high: highestRound }),
        backfilled: cur?.backfilled ? 1 : 0, caught_up: 0, updated_ts: Math.floor(Date.now() / 1000),
      });
      await sleep(150); // stay polite to AlgoNode
    }
  }
  return { caughtUp: sawEnd };
}

/** All-time totals + sync progress — cheap enough to run per request. */
// One (chain, wallet) pair per scanned wallet. baseExtraWallets are ADDITIONAL
// revenue wallets on Base only — the SOR spending wallet receives the
// route-execute Base leg (SELF_FUNDING_SLUGS), which is real revenue that the
// treasury-only scan missed entirely.
// EVM rows are stored lowercase (sync normalizes); Solana base58, Stellar
// G… addresses, and Algorand base32 addresses are all case-exact.
function walletPairs({ walletAddress, solanaWallet, stellarWallet, algorandWallet, baseExtraWallets = [], algorandExtraWallets = [] }) {
  return [
    ...Object.keys(EVM).map((k) => [k, walletAddress?.toLowerCase()]),
    ...baseExtraWallets.filter(Boolean).map((w) => ["base", w.toLowerCase()]),
    ["solana", solanaWallet], ["stellar", stellarWallet], ["algorand", algorandWallet],
    // AVM spending wallet (chain-matched self-funding). Base58-family
    // addresses are NEVER case-folded - folding merges distinct wallets
    // (same rule as src/payer.js).
    ...algorandExtraWallets.filter(Boolean).map((w) => ["algorand", w]),
  ];
}

/**
 * Per-chain sync state: where each cursor sits, how far behind the head it is,
 * and when it last moved.
 *
 * WHY THIS EXISTS. The canary settled on avalanche, celo and monad on
 * 2026-07-31 and those settlements are verifiably on-chain (two $0.001 Celo
 * transfers to the treasury, found by direct getLogs), yet the ledger reported
 * zero for all three that day. No error was logged, because none was thrown:
 * a chain that is merely BEHIND looks exactly like a chain with no activity,
 * and every surface built on this data — /revenue, the daily digest's
 * "Scan: ok" column — reported healthy throughout.
 *
 * A scan that returns nothing because it has not got there yet must not be
 * indistinguishable from a scan that returns nothing because nothing happened.
 * `lagBlocks` is the number that tells them apart, and until now nothing
 * exposed it.
 *
 * Operator-only: cursor positions and wallet addresses are not public data.
 */
/** The newest inbound transfers for a chain, in the shape the revenue rail
 *  cards already render.
 *
 *  WHY THIS EXISTS: the rail card built `recent[]` by re-scanning the chain on
 *  every snapshot refresh - chunked eth_getLogs across six EVM rails, measured
 *  at 221 Alchemy calls per refresh by a production egress census. Crawler
 *  traffic kept that cache warm, so it ran up to 144 times a day: on the order
 *  of a million billed calls a month, to redisplay transfers this table has
 *  already stored.
 *
 *  The ledger is the same data from the same source, indexed once by the
 *  background sync instead of re-derived per page view. Balances still need a
 *  live read (a balance is not a transfer, and nothing here records it), but
 *  those are single eth_call reads that already go publics-first - they were
 *  never the expensive part.
 *
 *  Returns [] when the ledger has nothing for this chain, which the caller
 *  MUST treat as "fall back to the live scan" rather than "no activity" - a
 *  cold boot or a chain we do not sync would otherwise silently render as
 *  zero settlements. */
export function ledgerRecent(chain, wallets, { limit = 8 } = {}) {
  // EVM addresses are stored lowercase by recordTransfer, and WALLET_ADDRESS is
  // checksummed - so an un-normalised IN clause matches nothing and every rail
  // silently falls back to the live chain scan. That is exactly what happened:
  // the ledger path shipped, never engaged once, and the tests passed because
  // they asserted the FALLBACK worked rather than that the ledger was used.
  //
  // ONLY 0x addresses are folded. Solana and Algorand are base58/base32 and
  // case-SENSITIVE; lowercasing those would merge or lose distinct accounts,
  // which is the rule src/payer.js states for the same reason.
  const norm = (w) => (/^0x[0-9a-fA-F]{40}$/.test(String(w)) ? String(w).toLowerCase() : String(w));
  const list = (Array.isArray(wallets) ? wallets : [wallets]).filter(Boolean).map(norm);
  if (!chain || !list.length) return [];
  try {
    const placeholders = list.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT tx_hash, block, when_ts, payer, usd, asset, external
         FROM transfers WHERE chain = ? AND wallet IN (${placeholders})
        ORDER BY block DESC, when_ts DESC
        LIMIT ?`
    ).all(chain, ...list, Math.max(1, Math.min(50, limit)));
    return rows.map((r) => ({
      usd: Number(r.usd),
      from: r.payer || null,
      txHash: r.tx_hash,
      block: r.block ?? null,
      // when_ts is unix SECONDS; the card renders an ISO string.
      when: r.when_ts ? new Date(r.when_ts * 1000).toISOString() : null,
      external: Boolean(r.external),
      internal: !r.external && r.payer != null,
      asset: r.asset || null,
      fromLedger: true,
    }));
  } catch {
    // A ledger read must never break the revenue page - the live scan is still
    // there, and returning [] routes the caller to it.
    return [];
  }
}

/** The newest settle one of OUR wallets paid into `wallets` on `chain`
 *  (a canary or volume run): not external, payer known, call-sized. The
 *  capped `ledgerRecent` page can hold only outside buyers on a busy rail,
 *  so the rail's proof row reads this instead. Null when none is recorded. */
export function ledgerNewestOwn(chain, wallets) {
  const norm = (w) => (/^0x[0-9a-fA-F]{40}$/.test(String(w)) ? String(w).toLowerCase() : String(w));
  const list = (Array.isArray(wallets) ? wallets : [wallets]).filter(Boolean).map(norm);
  if (!chain || !list.length) return null;
  try {
    const placeholders = list.map(() => "?").join(",");
    const r = db.prepare(
      `SELECT tx_hash, block, when_ts, usd FROM transfers
        WHERE chain = ? AND wallet IN (${placeholders}) AND external = 0 AND payer IS NOT NULL AND usd > 0 AND usd <= ?
        ORDER BY block DESC, when_ts DESC LIMIT 1`
    ).get(chain, ...list, MAX_CALL_USD);
    if (!r) return null;
    return { usd: Number(r.usd), txHash: r.tx_hash, block: r.block ?? null, when: r.when_ts ? new Date(r.when_ts * 1000).toISOString() : null };
  } catch { return null; }
}

// Tx hashes this ledger has actually SEEN ON-CHAIN, for reconciling against the
// settlement receipts recorded at serve time. `tx_hash` (not `txid`) is the
// join key: EVM txids carry a `:logIndex` suffix that a settle receipt never
// has, so matching on txid would report every EVM settlement as missing.
const qTxHashes = db.prepare("SELECT DISTINCT tx_hash FROM transfers WHERE chain = ? AND tx_hash IS NOT NULL");
/** Set of tx hashes seen on-chain for a chain. Case-exact: base58/base32
 *  signatures are case-sensitive, and folding them merges distinct txs. */
export function onchainTxHashes(chain) {
  return new Set(qTxHashes.all(String(chain || "")).map((r) => r.tx_hash));
}

/** Which chains this ledger actually tracks. A chain with NO coverage is not
 *  "clean" - it is unscanned, and reconciliation must say so rather than report
 *  its settlements as missing money.
 *
 *  Coverage is a cursor OR any recorded transfer, and it needs both halves. A
 *  cursor with no transfers yet is still scanned (we would know if a payment
 *  landed), and transfers with no cursor row still prove we can see the chain.
 *  Reading cursors alone classified a chain we plainly had data for as
 *  unverifiable. */
export function ledgerTrackedChains() {
  const out = new Map();
  for (const r of db.prepare("SELECT DISTINCT chain FROM transfers").all()) {
    out.set(r.chain, { updatedTs: null, caughtUp: null });
  }
  for (const r of db.prepare("SELECT chain, MAX(updated_ts) AS updated_ts, MIN(caught_up) AS caught_up FROM cursors GROUP BY chain").all()) {
    out.set(r.chain, { updatedTs: r.updated_ts || null, caughtUp: r.caught_up === 1 });
  }
  return out;
}

export function ledgerSyncState() {
  const rows = db.prepare("SELECT chain, wallet, next_block, caught_up, updated_ts FROM cursors").all();
  const now = Math.floor(Date.now() / 1000);
  return rows
    .map((r) => ({
      chain: r.chain,
      // Never expose a full wallet on an ops surface; the prefix is enough to
      // tell two cursors on the same chain apart.
      wallet: String(r.wallet || "").slice(0, 10),
      nextBlock: r.next_block,
      caughtUp: r.caught_up === 1,
      updatedAt: r.updated_ts ? new Date(r.updated_ts * 1000).toISOString() : null,
      staleSeconds: r.updated_ts ? now - r.updated_ts : null,
    }))
    .sort((a, b) => a.chain.localeCompare(b.chain) || a.wallet.localeCompare(b.wallet));
}

export function ledgerSummary(wallets) {
  const per = {};
  let allTimeExternalUsd = 0;
  let allTimeExternalCount = 0;
  let allTimeInboundUsd = 0;
  let allTimeInboundCount = 0;
  // External = classified external AND at least the dust floor (a transfer
  // under the cheapest catalog price paid for no call). Inbound keeps every
  // transfer: it is throughput, ours and dust included.
  const q = db.prepare(`SELECT
      COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd,
      COALESCE(SUM(CASE WHEN external = 1 AND usd + ${DUST_EPSILON} >= ? THEN usd END), 0) AS extUsd,
      COALESCE(SUM(CASE WHEN external = 1 AND usd + ${DUST_EPSILON} >= ? THEN 1 ELSE 0 END), 0) AS extN
    FROM transfers WHERE chain = ? AND wallet = ?`);
  for (const [chain, wallet] of walletPairs(wallets)) {
    if (!wallet) continue;
    const t = q.get(payerDustFloorUsd, payerDustFloorUsd, chain, wallet);
    const cur = getCursor.get(chain, wallet);
    // Two wallets on one chain (treasury + spending) ACCUMULATE into one row.
    const p = per[chain] || (per[chain] = { externalUsd: 0, externalCount: 0, inboundUsd: 0, inboundCount: 0, caughtUp: true, syncedAt: null });
    p.externalUsd = Number((p.externalUsd + t.extUsd).toFixed(6));
    p.externalCount += t.extN;
    p.inboundUsd = Number((p.inboundUsd + t.usd).toFixed(6));
    p.inboundCount += t.n;
    p.caughtUp = p.caughtUp && Boolean(cur?.caught_up);
    p.syncedAt = Math.max(p.syncedAt ?? 0, cur?.updated_ts ?? 0) || null;
    allTimeExternalUsd += t.extUsd;
    allTimeExternalCount += t.extN;
    allTimeInboundUsd += t.usd;
    allTimeInboundCount += t.n;
  }
  // Tempo is not a scanned chain, so its external settlements come from the
  // sales ledger (deduped against the transfers above). The on-chain figures
  // keep their meaning; the combined pair is what /revenue headlines.
  let tempoCount = 0, tempoUsd = 0;
  for (const r of tempoExternalRows()) { tempoCount++; tempoUsd += r.usd; }
  return {
    allTimeExternalUsd: Number(allTimeExternalUsd.toFixed(6)),
    allTimeExternalCount,
    tempoExternal: { count: tempoCount, usd: Number(tempoUsd.toFixed(6)), source: "sales ledger, Tempo MPP settlements (tempo/charge and tempo/subscription), external rows only" },
    allTimeExternalWithTempoCount: allTimeExternalCount + tempoCount,
    allTimeExternalWithTempoUsd: Number((allTimeExternalUsd + tempoUsd).toFixed(6)),
    // ALL settled inbound transfers, our own canary/volume/test wallets
    // included — the /revenue throughput band's number. Never presented as
    // revenue: throughput proves the rails, external proves the demand.
    allTimeInboundUsd: Number(allTimeInboundUsd.toFixed(6)),
    allTimeInboundCount,
    perChain: per,
    persistent: ledgerPersistent,
    syncing: Object.values(per).some((p) => !p.caughtUp),
  };
}

let loopStarted = false;
/** Boot the background sync loop. Fast ticks while backfilling, then a
 *  5-minute tail. Errors back off to the next tick — never crash the app. */
/** Daily revenue series for the /revenue chart: one row per (day, chain) with
 *  external vs internal (canary-sized) USD + tx counts. Funding/sweep-sized
 *  non-external inbound is EXCLUDED — the chart compares revenue-shaped flows.
 *  EVM rows carry no when_ts; their day is estimated from block height
 *  anchored to the sync cursor (next_block ≈ chain head at updated_ts) via the
 *  per-chain block cadence — no network calls, accurate to sync lag, and
 *  drift over months only ever mis-buckets a row by a day at the boundary. */
// `mppTx` is an optional Set of tx hashes whose credential arrived over the MPP
// wire (from the separate sales db — on-chain, an MPP settlement is identical to
// an x402 one, so the wire cannot be derived here). When supplied, each bucket
// also carries its MPP subset, letting the chart filter by wire. Absent or
// empty, the extra fields are all zero and the series behaves exactly as before.
// `withScope` returns { days, scope } instead of the bare array. Opt-in, so
// every existing caller keeps the array it has always been handed and only
// /api/revenue/daily - the one surface that PUBLISHES this series - has to
// carry the disclosure.
//
// THREE FILTERS, NONE OF THEM DISCLOSED, until 2026-09-22. This series drops
// undateable rows, internal transfers over MAX_CALL_USD, and everything before
// REVENUE_DAILY_START - and then /revenue headlines it as "every settled
// on-chain transaction, ours included". Measured on prod that day: the days
// sum to 42,951 transactions / $571.82 against /api/revenue's own allTime of
// 43,665 / $664.70, and 24 of the missing rows are real outside customers who
// paid before the chart's epoch. Both sibling series (/api/calls/daily,
// /api/sales) carry recordingSince; this one was the odd one out, so anyone
// reconciling us found two of our own numbers disagreeing by $92.89 with
// nothing in either response to explain it.
export function ledgerDaily(wallets, mppTx = null, { withScope = false } = {}) {
  // Counted while filtering, never re-derived: a disclosure computed from a
  // second pass can drift from the filter it describes.
  let droppedUndateable = 0;
  const droppedOverCap = { transactions: 0, usd: 0 };
  const droppedDust = { transactions: 0, usd: 0 };
  const isMpp = (h) => {
    if (!mppTx || !mppTx.size || !h) return false;
    return mppTx.has(h) || (/^0x[0-9a-fA-F]+$/.test(h) && mppTx.has(h.toLowerCase()));
  };
  const rows = db.prepare("SELECT chain, wallet, block, when_ts, usd, external, tx_hash FROM transfers WHERE chain = ? AND wallet = ?");
  const chains = walletPairs(wallets);
  // Settled-to split: rows received by the SOR spending wallet (self-funding
  // slugs: the route-execute tiers) vs the treasury. On-chain
  // truth by receiving wallet - the /revenue SOR filter reads these fields.
  const sorWallets = new Set([
    ...(wallets.baseExtraWallets || []).filter(Boolean).map((w) => w.toLowerCase()),
    // AVM addresses join verbatim - never case-folded.
    ...(wallets.algorandExtraWallets || []).filter(Boolean),
  ]);
  const byDay = new Map(); // "YYYY-MM-DD|chain" -> {extUsd, extTx, intUsd, intTx}
  for (const [chain, wallet] of chains) {
    if (!wallet) continue;
    const dateOf = undatedRowDater(chain, wallet);
    for (const t of rows.all(chain, wallet)) {
      if (t.chain !== chain) continue;
      let ms = t.when_ts ? t.when_ts * 1000 : null;
      if (ms == null) ms = dateOf(t.block);
      if (ms == null) { droppedUndateable++; continue; } // undateable row — skip rather than guess
      const day = new Date(ms).toISOString().slice(0, 10);
      const key = `${day}|${chain}`;
      const b = byDay.get(key) || {
        day, chain, extUsd: 0, extTx: 0, intUsd: 0, intTx: 0,
        extMppUsd: 0, extMppTx: 0, intMppUsd: 0, intMppTx: 0,
        extSorUsd: 0, extSorTx: 0, intSorUsd: 0, intSorTx: 0,
      };
      const mpp = isMpp(t.tx_hash);
      const sor = sorWallets.has(wallet);
      if (t.external && belowDust(t.usd)) {
        // Under the cheapest catalog price: paid for no call. Out of the
        // external series exactly as ledgerSummary leaves it out of the
        // external totals (the payer dust floor), and NAMED in the scope.
        droppedDust.transactions += 1; droppedDust.usd += t.usd;
      } else if (t.external) {
        b.extUsd += t.usd; b.extTx += 1;
        if (mpp) { b.extMppUsd += t.usd; b.extMppTx += 1; }
        if (sor) { b.extSorUsd += t.usd; b.extSorTx += 1; }
      } else if (t.usd <= MAX_CALL_USD) { // canary-sized only
        b.intUsd += t.usd; b.intTx += 1;
        if (mpp) { b.intMppUsd += t.usd; b.intMppTx += 1; }
        if (sor) { b.intSorUsd += t.usd; b.intSorTx += 1; }
      } else {
        // An internal transfer larger than a call: treasury funding, not
        // traffic. Correctly excluded from a per-call series, and correctly
        // NAMED rather than silently missing from the totals.
        droppedOverCap.transactions += 1; droppedOverCap.usd += t.usd;
      }
      byDay.set(key, b);
    }
  }
  // Chart epoch: the pre-launch trickle (ledger backfill of pre-launch dust)
  // adds a flat run of near-zero bars — start the series at June 15 unless
  // the operator overrides.
  const start = process.env.REVENUE_DAILY_START || "2026-06-15";
  const all = [...byDay.values()];
  // The ledger's own earliest dated day, before the epoch cuts it - so the
  // response can say what it is NOT showing rather than only where it starts.
  let firstDay = null;
  const droppedPreEpoch = { transactions: 0, usd: 0 };
  for (const b of all) {
    if (firstDay === null || b.day < firstDay) firstDay = b.day;
    if (b.day < start) {
      droppedPreEpoch.transactions += b.extTx + b.intTx;
      droppedPreEpoch.usd += b.extUsd + b.intUsd;
    }
  }
  const days = all
    .filter((b) => b.day >= start)
    .map((b) => ({
      ...b,
      extUsd: Number(b.extUsd.toFixed(6)), intUsd: Number(b.intUsd.toFixed(6)),
      extMppUsd: Number(b.extMppUsd.toFixed(6)), intMppUsd: Number(b.intMppUsd.toFixed(6)),
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.chain.localeCompare(b.chain)));
  if (!withScope) return days;
  const usd = (n) => Number(Number(n).toFixed(6));
  const excluded = {
    beforeSeriesStart: { transactions: droppedPreEpoch.transactions, usd: usd(droppedPreEpoch.usd) },
    internalOverMaxCallUsd: { transactions: droppedOverCap.transactions, usd: usd(droppedOverCap.usd), maxCallUsd: MAX_CALL_USD },
    externalUnderDustFloor: { transactions: droppedDust.transactions, usd: usd(droppedDust.usd), dustFloorUsd: payerDustFloorUsd },
    undateable: { transactions: droppedUndateable },
  };
  // Derived from the counters, never asserted: an empty ledger is complete, and
  // one dropped row is not.
  const complete = excluded.beforeSeriesStart.transactions === 0
    && excluded.internalOverMaxCallUsd.transactions === 0
    && excluded.externalUnderDustFloor.transactions === 0
    && excluded.undateable.transactions === 0;
  return {
    days,
    scope: {
      recordingSince: firstDay,
      seriesStart: start,
      complete,
      excluded,
      note: complete
        ? `This series covers every dated transfer in the ledger from ${start}.`
        : `This series starts ${start} and is NOT the whole ledger: ${excluded.beforeSeriesStart.transactions} transactions ($${excluded.beforeSeriesStart.usd}) settled before it, ${excluded.internalOverMaxCallUsd.transactions} internal transfers over $${MAX_CALL_USD} are excluded as treasury funding rather than calls, ${excluded.externalUnderDustFloor.transactions} outside transfers ($${excluded.externalUnderDustFloor.usd}) under the $${payerDustFloorUsd} dust floor are excluded because they cannot have paid for a call, and ${excluded.undateable.transactions} rows carry no usable date. /api/revenue allTime is the unfiltered total; the two will not reconcile without this object.`,
    },
  };
}

/**
 * Distinct EXTERNAL buyers per day, oldest first.
 *
 * Answers "are we winning more buyers, or is the same handful paying more?",
 * which transaction counts alone cannot: 200 calls is one whale or fifty
 * customers and the revenue line looks identical either way.
 *
 * Three things this gets right on purpose:
 *   • A buyer is counted ONCE PER DAY no matter how many chains they paid on.
 *     The transfer rows are keyed by day+chain, so counting there would report
 *     a multi-chain buyer as two buyers.
 *   • `cumulative` is a running UNION, never a sum of the daily counts. Summing
 *     distinct counts double-counts every returning buyer and would turn a
 *     stagnant handful into an impressive-looking climb — the exact illusion
 *     this series exists to dispel.
 *   • `newBuyers` is measured against ALL prior history, not just the charted
 *     window, so nobody is called "new" merely because the epoch cuts them off.
 *
 * `unattributed` counts external payments whose payer could not be read from
 * the chain scan. Those are in the revenue totals but cannot be attributed to a
 * buyer, so the page can say so instead of quietly undercounting.
 *
 * Returns counts only. Buyer addresses are public on-chain, but publishing a
 * per-day roster of who pays us is a customer list, so it stays out.
 */
/** Monday (UTC) of the ISO week holding a YYYY-MM-DD day, as YYYY-MM-DD. */
/** First day of `day`'s UTC month, the month twin of weekStartOf. */
export function monthStartOf(day) {
  return `${String(day).slice(0, 7)}-01`;
}

export function weekStartOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** A payer as one buyer identity across rails: EVM addresses are
 *  case-insensitive and fold to lowercase (so a wallet paying on Base and on
 *  Tempo is one buyer); base58/Stellar/Algorand stay case-exact (src/payer.js). */
function buyerKey(raw) {
  if (!raw) return null;
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : raw;
}

/** The EVM address inside a Tempo payer, whether stored bare or as a did:pkh
 *  (`did:pkh:eip155:4217:0x...`). Anything else is unattributable. */
function tempoPayerKey(raw) {
  const m = String(raw || "").match(/0x[0-9a-fA-F]{40}/);
  return m ? m[0].toLowerCase() : null;
}

/** Lowercased tx hashes from `txs` that already appear in the transfers table. */
function onchainTxSet(txs) {
  const found = new Set();
  if (!txs.length) return found;
  const q = db.prepare("SELECT 1 FROM transfers WHERE tx_hash = ? OR tx_hash = ? LIMIT 1");
  for (const tx of txs) {
    const s = String(tx);
    if (q.get(s, s.toLowerCase())) found.add(s.toLowerCase());
  }
  return found;
}

/**
 * External Tempo MPP settlements from the sales ledger (tempo/charge and
 * tempo/subscription), minus any whose tx is already a transfer in this
 * ledger, so a payment is never counted by both sources. Only Tempo: MPP over
 * Base/Celo settles as an ordinary on-chain transfer and is already here.
 */
function tempoExternalRows() {
  const tempo = externalTempoPayments();
  const onchain = onchainTxSet(tempo.map((r) => r.tx).filter(Boolean));
  return tempo.filter((r) => !(r.tx && onchain.has(String(r.tx).toLowerCase())));
}

/**
 * Every EXTERNAL payment the buyer figures count, as {day, payer|null}: the
 * on-chain inbound transfers this ledger scans, plus external Tempo MPP
 * settlements from the sales ledger (Tempo is not a scanned chain). Internal
 * classification is each source's own, never re-derived here. A Tempo row
 * whose tx is also in the transfers table is skipped, so no payment is
 * counted twice. Undateable on-chain rows are skipped rather than guessed.
 */
// The daily, weekly and monthly buyer series, concentration and retention
// each read this full history. A caller building several of them at once
// reads it ONCE (externalPaymentEventsFor) and passes `{ events }` to each;
// a figure asked for on its own reads fresh.
// A DUST FLOOR FOR "A WALLET THAT PAID US".
//
// A transfer smaller than the cheapest price we sell cannot have paid for a
// call. Address-poisoning sends exactly that: a sub-cent transfer from a
// lookalike of a wallet we really trade with, so the lookalike lands in our
// history. Measured on /revenue: a $0.00001 transfer from an address mimicking
// the CI burner's first and last characters counted as an outside paying
// agent. The floor is DERIVED from the catalog (server.js sets it to the
// cheapest priced tool at boot), never a typed address list, so it catches the
// next lookalike too. Unset (0) means no floor, which is what tests and
// scripts that do not boot the catalog get.
let payerDustFloorUsd = 0;
const DUST_EPSILON = 1e-9;
/** Set the floor: the cheapest price in the catalog, in USD. */
export function setPayerDustFloorUsd(usd) {
  const n = Number(usd);
  payerDustFloorUsd = Number.isFinite(n) && n > 0 ? n : 0;
}
/** The current floor (0 = none). */
export function getPayerDustFloorUsd() { return payerDustFloorUsd; }
const belowDust = (usd) => payerDustFloorUsd > 0 && !(Number(usd) + DUST_EPSILON >= payerDustFloorUsd);

export function externalPaymentEventsFor(wallets) { return readExternalPaymentEvents(wallets); }
function externalPaymentEvents(wallets, events) { return events || readExternalPaymentEvents(wallets); }
function readExternalPaymentEvents(wallets) {
  const out = [];
  const rows = db.prepare("SELECT chain, wallet, block, when_ts, external, payer, usd FROM transfers WHERE chain = ? AND wallet = ?");
  for (const [chain, wallet] of walletPairs(wallets)) {
    if (!wallet) continue;
    const dateOf = undatedRowDater(chain, wallet);
    for (const t of rows.all(chain, wallet)) {
      if (t.chain !== chain || !t.external) continue;
      // Under the cheapest catalog price: not a payment for a call (see the
      // dust floor above), so not a paying agent.
      if (belowDust(t.usd)) continue;
      let ms = t.when_ts ? t.when_ts * 1000 : null;
      if (ms == null) ms = dateOf(t.block);
      if (ms == null) continue;
      out.push({ day: new Date(ms).toISOString().slice(0, 10), payer: buyerKey(t.payer || null) });
    }
  }
  for (const r of tempoExternalRows()) {
    if (!Number.isFinite(r.ts)) continue;
    out.push({ day: new Date(r.ts).toISOString().slice(0, 10), payer: tempoPayerKey(r.payer) });
  }
  return out;
}

/** Per-day payer sets + first-seen map + unattributed counts, across ALL
 *  history. Shared by the daily and weekly buyer series so the two can never
 *  disagree about who a buyer is or when they were first seen. */
function buyerDaySets(wallets, events) {
  const byDay = new Map(); // day -> Set(payer)
  const unattributed = new Map(); // day -> count
  const firstSeen = new Map(); // payer -> earliest day ever, across ALL history
  for (const { day, payer } of externalPaymentEvents(wallets, events)) {
    if (!payer) { unattributed.set(day, (unattributed.get(day) || 0) + 1); continue; }
    if (!byDay.has(day)) byDay.set(day, new Set());
    byDay.get(day).add(payer);
    const prev = firstSeen.get(payer);
    if (!prev || day < prev) firstSeen.set(payer, day);
  }

  const start = process.env.REVENUE_DAILY_START || "2026-06-15";
  const allDays = [...new Set([...byDay.keys(), ...unattributed.keys()])].sort();
  return { byDay, unattributed, firstSeen, allDays, start };
}

export function ledgerBuyersDaily(wallets, { events } = {}) {
  const { byDay, unattributed, firstSeen, allDays, start } = buyerDaySets(wallets, events);
  const seen = new Set();
  const out = [];
  for (const day of allDays) {
    const set = byDay.get(day) || new Set();
    for (const p of set) seen.add(p); // union BEFORE the window filter, so the
    // cumulative line is a true all-time distinct count rather than restarting
    // at the chart epoch.
    if (day < start) continue;
    let fresh = 0;
    for (const p of set) if (firstSeen.get(p) === day) fresh++;
    out.push({
      day,
      buyers: set.size,
      newBuyers: fresh,
      returningBuyers: set.size - fresh,
      cumulative: seen.size,
      unattributed: unattributed.get(day) || 0,
    });
  }
  return out;
}

/**
 * Distinct external buyers per ISO week (Monday-start, UTC). The same four
 * invariants as the daily series, and one more that only exists at this
 * grain: a WEEK'S distinct count is the union of its days, never the sum of
 * the daily counts - a buyer paying on Monday and Wednesday is one weekly
 * buyer, and summing the daily rows would report two. That is why the client
 * cannot fold the daily series itself and this is served instead.
 *
 * `week` is the Monday; `weekEnd` the Sunday; the newest week is usually
 * partial and says so (`partial: true`, `daysCovered`) so a reader does not
 * compare a two-day week against seven-day ones. A buyer is `new` in the week
 * of their first-ever payment across all history, whatever the chart epoch.
 */
export function ledgerBuyersWeekly(wallets, { events } = {}) {
  const { byDay, unattributed, firstSeen, allDays, start } = buyerDaySets(wallets, events);
  const seen = new Set();
  const weeks = new Map(); // monday -> { set, fresh, unattributed, days }
  for (const day of allDays) {
    const set = byDay.get(day) || new Set();
    for (const p of set) seen.add(p);
    if (day < start) continue;
    const wk = weekStartOf(day);
    let w = weeks.get(wk);
    if (!w) { w = { set: new Set(), fresh: new Set(), unattributed: 0, days: new Set(), cumulative: 0 }; weeks.set(wk, w); }
    for (const p of set) { w.set.add(p); if (weekStartOf(firstSeen.get(p)) === wk) w.fresh.add(p); }
    w.unattributed += unattributed.get(day) || 0;
    w.days.add(day);
    w.cumulative = seen.size; // union as of the last day of the week seen so far
  }
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const wk of [...weeks.keys()].sort()) {
    const w = weeks.get(wk);
    const end = new Date(`${wk}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
    const weekEnd = end.toISOString().slice(0, 10);
    out.push({
      week: wk,
      weekEnd,
      buyers: w.set.size,
      newBuyers: w.fresh.size,
      returningBuyers: w.set.size - w.fresh.size,
      cumulative: w.cumulative,
      unattributed: w.unattributed,
      daysCovered: w.days.size,
      partial: weekEnd >= today,
    });
  }
  return out;
}

/**
 * Monthly buyers: the same union the weekly series computes, over UTC months.
 *
 * Exists for the same reason the weekly one does, and the reason is worth
 * repeating because it is the whole hazard of adding a coarser bucket: a
 * distinct count CANNOT be folded from finer buckets. A buyer who pays on the
 * 3rd and the 20th is one monthly buyer, and summing daily or weekly rows
 * would report two. The client therefore never folds buyers itself; it asks
 * for this series, exactly as it does for weeks.
 *
 * `month` is the first of the month; `monthEnd` the last day; the newest month
 * is usually partial and says so, so nobody compares a three-day month against
 * full ones. A buyer is `new` in the month of their first-ever payment across
 * all history, whatever the chart epoch.
 */
export function ledgerBuyersMonthly(wallets, { events } = {}) {
  const { byDay, unattributed, firstSeen, allDays, start } = buyerDaySets(wallets, events);
  const seen = new Set();
  const months = new Map();
  for (const day of allDays) {
    const set = byDay.get(day) || new Set();
    for (const p of set) seen.add(p);
    if (day < start) continue;
    const mk = monthStartOf(day);
    let m = months.get(mk);
    if (!m) { m = { set: new Set(), fresh: new Set(), unattributed: 0, days: new Set(), cumulative: 0 }; months.set(mk, m); }
    for (const p of set) { m.set.add(p); if (monthStartOf(firstSeen.get(p)) === mk) m.fresh.add(p); }
    m.unattributed += unattributed.get(day) || 0;
    m.days.add(day);
    m.cumulative = seen.size;
  }
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const mk of [...months.keys()].sort()) {
    const m = months.get(mk);
    const end = new Date(`${mk}T00:00:00Z`);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0); // last day of mk's month
    const monthEnd = end.toISOString().slice(0, 10);
    out.push({
      month: mk,
      monthEnd,
      buyers: m.set.size,
      newBuyers: m.fresh.size,
      returningBuyers: m.set.size - m.fresh.size,
      cumulative: m.cumulative,
      unattributed: m.unattributed,
      daysCovered: m.days.size,
      partial: monthEnd >= today,
    });
  }
  return out;
}

/**
 * Buyer concentration over the charted window: how much of our external volume
 * comes from the biggest few wallets.
 *
 * The daily series answers "how many buyers"; this answers the other half,
 * "does it matter". Two hundred buyers where one wallet is 80% of payments is a
 * single-customer business wearing a crowd as a costume, and only this number
 * says so.
 *
 * Shares are of PAYMENT COUNT, not dollars: at sub-cent prices a single
 * expensive call would otherwise masquerade as concentration. Counts and
 * percentages only, never addresses.
 */
// TWO "buyers" FIELDS, TWO POPULATIONS, ONE RESPONSE.
//
// /api/revenue/daily serves `concentration.buyers` and `retention.buyers` side
// by side. Measured on prod 2026-09-22 they read 495 and 496 - one apart,
// identically named, and neither said why: concentration starts at
// REVENUE_DAILY_START (2026-06-15) while retention is deliberately all-time,
// so the extra buyer is simply someone who paid before the chart's epoch. A
// third figure, the host entry's own `allTime.buyers`, read 443 on the same
// day over a different source again (the sales ledger, from 2026-07-03, card
// and credits included). Three true numbers, three scopes, none stated.
//
// Both figures here read the on-chain transfers ledger plus the sales ledger's
// external Tempo MPP settlements (Tempo is not a scanned chain), so they are
// blind to card and prepaid-credits buyers by construction, and they skip a
// payment whose payer is not exposed (SVM and Stellar rows carry none) or
// whose date cannot be established. Every one of those is a reason
// the number is a floor rather than a total, and a consumer cannot infer any
// of it from `buyers: 495`. /revenue renders it as "distinct agents have paid
// us", which is the reading this scope object exists to correct.
const BUYER_SCOPE = ({ since }) => ({
  scope: {
    since: since || null,
    source: "on-chain inbound transfers to our own wallets, plus Tempo MPP settlements (tempo/charge and tempo/subscription) from the sales ledger; external rows only, one buyer per wallet across rails",
    excludes: [
      "card and prepaid-credits buyers (they settle no on-chain transfer to us)",
      "settlements whose payer is not exposed (Solana, Stellar, and any Tempo settlement recorded without a payer)",
      "transfers whose date could not be established",
      ...(payerDustFloorUsd > 0 ? [`transfers under $${payerDustFloorUsd} (the cheapest catalog price), which cannot have paid for a call`] : []),
    ],
    note: since
      ? `Distinct wallets counted from ${since}; a floor, not a lifetime total of everyone who has paid us.`
      : "Distinct wallets over the whole scanned ledger; a floor, not a total of everyone who has paid us.",
  },
});

export function ledgerBuyerConcentration(wallets, { events } = {}) {
  const start = process.env.REVENUE_DAILY_START || "2026-06-15";
  const counts = new Map();
  let payments = 0;
  for (const { day, payer } of externalPaymentEvents(wallets, events)) {
    if (!payer || day < start) continue;
    counts.set(payer, (counts.get(payer) || 0) + 1);
    payments++;
  }
  if (!payments) return { buyers: 0, payments: 0, topSharePct: null, top5SharePct: null, ...BUYER_SCOPE({ since: start }) };
  const sorted = [...counts.values()].sort((a, b) => b - a);
  const pct = (n) => Math.round((n / payments) * 1000) / 10;
  return {
    buyers: counts.size,
    payments,
    topSharePct: pct(sorted[0]),
    top5SharePct: pct(sorted.slice(0, 5).reduce((a, b) => a + b, 0)),
    // The window and the exclusions, beside the number rather than in a
    // comment - see BUYER_SCOPE.
    ...BUYER_SCOPE({ since: start }),
  };
}

/**
 * Did our buyers ever come back?
 *
 * The daily series answers "how many buyers today" and splits them into new and
 * returning FOR THAT DAY. Concentration answers "does it matter". Neither
 * answers the question that decides whether this is a business: of everyone who
 * has ever paid us, how many tried it once and never returned.
 *
 * Measured once by hand from the sales ledger (2026-09-11), the share of
 * buyers who paid exactly once lived nowhere any surface could show it.
 *
 * RETENTION IS COUNTED IN DAYS, NOT PAYMENTS. A buyer who made forty calls in
 * one afternoon and never came back is a one-time buyer, however impressive the
 * call count: they evaluated us once. Counting payments would score that
 * session as loyalty. So the classes are:
 *
 *   oneDay      seen on exactly one calendar day, ever
 *   returned    seen on two or more distinct days
 *
 * ...and `oneDayOneCall` splits the first group again, because "called once and
 * left" and "spent an afternoon on us and left" are different failures: the
 * first is a test call, the second is an evaluation that decided no.
 *
 * All-time, never windowed: retention over a 30-day slice would relabel every
 * long-standing buyer as new the moment the window moved. Counts and
 * percentages only - a roster of who pays us is a customer list.
 */
export function ledgerBuyerRetention(wallets, { events } = {}) {
  const days = new Map();  // payer -> Set(day)
  const calls = new Map(); // payer -> payment count
  for (const { day, payer } of externalPaymentEvents(wallets, events)) {
    if (!payer) continue;
    if (!days.has(payer)) days.set(payer, new Set());
    days.get(payer).add(day);
    calls.set(payer, (calls.get(payer) || 0) + 1);
  }
  const buyers = days.size;
  if (!buyers) return { buyers: 0, oneDay: 0, oneDayOneCall: 0, returned: 0, oneDayPct: null, returnedPct: null, ...BUYER_SCOPE({ since: null }) };
  let oneDay = 0, oneDayOneCall = 0;
  for (const [payer, set] of days) {
    if (set.size > 1) continue;
    oneDay++;
    if ((calls.get(payer) || 0) === 1) oneDayOneCall++;
  }
  const pct = (n) => Math.round((n / buyers) * 1000) / 10;
  return {
    buyers,
    oneDay,
    oneDayOneCall,
    returned: buyers - oneDay,
    oneDayPct: pct(oneDay),
    returnedPct: pct(buyers - oneDay),
    // All-time here, windowed in concentration: the same field name over two
    // different populations is why both now carry their own scope.
    ...BUYER_SCOPE({ since: null }),
  };
}

/**
 * The batch goal's number: of outside buyers whose first payment is at least
 * seven days old, how many paid again on a DIFFERENT day within seven days of
 * their first. Days, not calls, for the reason retention gives: forty calls in
 * one afternoon is one evaluation, not a return. Buyers whose first day is
 * under seven days old are `pending` (their window is still open), never
 * counted as not-returned.
 *
 * `byFirstWeek` groups the same count by the ISO week (Monday, UTC) of each
 * buyer's first payment, newest first, so the history before a change is the
 * baseline for the weeks after it. Counts only, never a wallet; the scope
 * (including the rails whose payer we cannot see) rides beside the number.
 */
export function ledgerBuyerRepeat7(wallets, { events, now = Date.now(), weeks = 16 } = {}) {
  const days = new Map(); // payer -> Set(day)
  for (const { day, payer } of externalPaymentEvents(wallets, events)) {
    if (!payer) continue;
    if (!days.has(payer)) days.set(payer, new Set());
    days.get(payer).add(day);
  }
  const DAY = 86_400_000;
  const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
  const today = toMs(new Date(now).toISOString().slice(0, 10));
  const weekOf = (ms) => { const d = new Date(ms); const back = (d.getUTCDay() + 6) % 7; return new Date(ms - back * DAY).toISOString().slice(0, 10); };
  let eligible = 0, returned = 0, pending = 0;
  const byWeek = new Map(); // week -> { firstTimeBuyers, returnedWithin7, pending }
  for (const set of days.values()) {
    const sorted = [...set].map(toMs).sort((a, b) => a - b);
    const first = sorted[0];
    const wk = weekOf(first);
    if (!byWeek.has(wk)) byWeek.set(wk, { week: wk, firstTimeBuyers: 0, returnedWithin7: 0, pending: 0 });
    const row = byWeek.get(wk);
    row.firstTimeBuyers++;
    const back = sorted.some((ms) => ms > first && ms - first <= 7 * DAY);
    if (today - first < 7 * DAY && !back) { pending++; row.pending++; continue; }
    eligible++;
    if (back) { returned++; row.returnedWithin7++; }
  }
  const byFirstWeek = [...byWeek.values()].sort((a, b) => (a.week < b.week ? 1 : -1)).slice(0, weeks);
  return {
    definition: "outside buyers who paid again on a different day within 7 days of their first payment; buyers whose first payment is under 7 days old are pending",
    eligible,
    returnedWithin7: returned,
    returnedWithin7Pct: eligible ? Math.round((returned / eligible) * 1000) / 10 : null,
    pending,
    byFirstWeek,
    ...BUYER_SCOPE({ since: null }),
  };
}

// The loop runs wherever its rows persist: the volume, REVENUE_LEDGER=true,
// or the state database (the only place they persist once the volume is gone).
export function revenueLedgerLoopEnabled(env = process.env, { hasDataDir = HAS_DATA_DIR } = {}) {
  return hasDataDir || env.REVENUE_LEDGER === "true" || stateDbEnabled(env);
}

export function startRevenueLedger({ walletAddress, solanaWallet, stellarWallet, algorandWallet, baseExtraWallets = [], algorandExtraWallets = [] }) {
  const enabled = revenueLedgerLoopEnabled();
  if (loopStarted || !enabled || (!walletAddress && !solanaWallet && !stellarWallet && !algorandWallet)) return false;
  loopStarted = true;
  // The sync work runs under a lease (two containers never advance the
  // cursors at once); the re-arm is outside it, so a skipped tick (another
  // holder, a database error) tries again rather than ending the loop.
  const syncOnce = leased("revenue-ledger-tick", { ttlMs: 10 * 60_000, failOpen: true }, async () => {
    let allCaughtUp = true;
    if (USE_PG) { await storeReadyP(); staged.clear(); }
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
    // Extra Base revenue wallets (the SOR spending wallet: route-execute's
    // Base leg settles here — revenue, not float).
    for (const w of baseExtraWallets.filter(Boolean)) {
      try {
        const r = await syncEvmChain("base", w.toLowerCase());
        if (!r.caughtUp) allCaughtUp = false;
      } catch (e) {
        allCaughtUp = false;
        console.warn(`revenue-ledger: base extra-wallet sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
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
    if (stellarWallet) {
      try {
        const r = await syncStellar(stellarWallet);
        if (!r.caughtUp) allCaughtUp = false;
      } catch (e) {
        allCaughtUp = false;
        console.warn(`revenue-ledger: stellar sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
      }
    }
    if (algorandWallet) {
      try {
        const r = await syncAlgorand(algorandWallet);
        if (!r.caughtUp) allCaughtUp = false;
      } catch (e) {
        allCaughtUp = false;
        console.warn(`revenue-ledger: algorand sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
      }
    }
    // The AVM spending wallet receives route-execute's Algorand leg (revenue,
    // same rule as the Base extra). ledgerSummary() has folded it into the
    // chain's row since 2026-07 but nothing scanned it, so it never had a
    // cursor row and the row read "not caught up" forever (/revenue: Algorand
    // "still syncing", 2026-09-09) while its inbound went unrecorded.
    for (const w of algorandExtraWallets.filter(Boolean)) {
      try {
        const r = await syncAlgorand(w);
        if (!r.caughtUp) allCaughtUp = false;
      } catch (e) {
        allCaughtUp = false;
        console.warn(`revenue-ledger: algorand extra-wallet sync tick failed (will retry): ${String(e?.message || e).slice(0, 100)}`);
      }
    }
    // The readers' mirror follows the tables after every tick (rows another
    // container wrote included).
    if (USE_PG) {
      try { await refreshMirror(); }
      catch (e) { console.warn(`revenue-ledger: mirror refresh failed (will retry next tick): ${String(e?.message || e).slice(0, 100)}`); }
    }
    return allCaughtUp;
  });
  const tick = async () => {
    let allCaughtUp = false;
    try { const r = await syncOnce(); allCaughtUp = r === true; }
    catch (e) { console.warn(`revenue-ledger: sync tick threw (will retry): ${String(e?.message || e).slice(0, 100)}`); }
    setTimeout(tick, allCaughtUp ? 300_000 : 20_000).unref?.();
  };
  setTimeout(tick, 5_000).unref?.(); // let boot settle first
  console.log(`revenue-ledger: sync loop started (${USE_PG ? `state database; mirror: ${DB_PATH}` : `db: ${DB_PATH}`})`);
  return true;
}
