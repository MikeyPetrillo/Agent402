// The all-time revenue ledger against a REAL Postgres: the SQLite file on the
// volume is imported once (a second boot with the same file re-imports
// nothing), writes land in the tables and a fresh instance with no file of
// its own reads them through its mirror, a transfer is counted once however
// often a rescan replays it (the (chain, wallet, txid) key), and a cursor
// advances only in the transaction that stores its rows (a page that cannot
// be stored leaves the cursor where it was). Requires STATE_DATABASE_URL (CI
// fails without it).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-revenue-ledger-pg" });

const DIR = mkdtempSync(join(tmpdir(), "revenue-ledger-pg-"));
const FILE = join(DIR, "agent402-revenue.db"); // the volume's basename: the import is marked under it
process.env.REVENUE_LEDGER_DB = FILE;
process.env.SALES_LEDGER_DB = join(DIR, "agent402-sales.db");

const sdb = await import("../src/state-db.js");
const { USDC_ISSUER } = await import("../src/revenue-live.js");
const Database = (await import("better-sqlite3")).default;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const W = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const STW = "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL";
const wallets = { walletAddress: W, stellarWallet: STW };
const S = sdb.stateDbSchema();
const count = async (where = "", params = []) => Number((await sdb.stateQuery(`SELECT count(*)::int AS n FROM ${S}.revenue_transfers ${where}`, params)).rows[0].n);
const cursorOf = async (chain, wallet) => (await sdb.stateQuery(`SELECT * FROM ${S}.revenue_cursors WHERE chain = $1 AND wallet = $2`, [chain, wallet])).rows[0] || null;
const payment = (id, hash, from, amount = "0.01") => ({ id: String(id), paging_token: String(id), type: "payment", to: STW, asset_code: "USDC", asset_issuer: USDC_ISSUER, amount, from, transaction_hash: hash, created_at: "2026-06-20T12:00:00Z" });
const realFetch = globalThis.fetch;

try {
  // The volume's file, written the way the old build wrote it.
  {
    const f = new Database(FILE);
    f.exec(`CREATE TABLE transfers (chain TEXT NOT NULL, wallet TEXT NOT NULL, txid TEXT NOT NULL, tx_hash TEXT NOT NULL, block INTEGER, when_ts INTEGER, payer TEXT, usd REAL NOT NULL, asset TEXT NOT NULL, external INTEGER NOT NULL, PRIMARY KEY (chain, wallet, txid));
            CREATE TABLE cursors (chain TEXT NOT NULL, wallet TEXT NOT NULL, next_block INTEGER, newest_sig TEXT, backfilled INTEGER DEFAULT 0, caught_up INTEGER DEFAULT 0, updated_ts INTEGER, PRIMARY KEY (chain, wallet));`);
    const ins = f.prepare("INSERT INTO transfers (chain, wallet, txid, tx_hash, block, when_ts, payer, usd, asset, external) VALUES (?,?,?,?,?,?,?,?,?,?)");
    ins.run("base", W, "0xaaa:0", "0xaaa", 100, 1781956800, "0x1111111111111111111111111111111111111111", 0.01, "USDC", 1);
    ins.run("base", W, "0xbbb:0", "0xbbb", 101, 1781956800, "0x2222222222222222222222222222222222222222", 0.02, "USDC", 1);
    f.prepare("INSERT INTO cursors (chain, wallet, next_block, newest_sig, backfilled, caught_up, updated_ts) VALUES (?,?,?,?,?,?,?)").run("base", W, 102, null, 1, 1, 1781956900);
    f.close();
  }

  // ---- boot 1: the file is imported once ----------------------------------------
  const m1 = await import("../src/revenue-ledger.js");
  const first = await m1.ledgerStoreReady();
  ok(first?.imported === true && first.rows === 2 && first.cursors === 1, `the first load imports the file's 2 transfers and 1 cursor (${JSON.stringify(first)})`);
  ok((await count()) === 2 && (await cursorOf("base", W))?.next_block === "102", "the tables hold the file's rows and cursor");
  const mark = await sdb.imports.done("agent402-revenue.db");
  ok(mark && mark.source === FILE && mark.bytes > 0, "the import is marked under the file's basename with its source and size");
  ok(m1.ledgerPersistent === true, "the ledger reports itself persistent with a database");
  let s = m1.ledgerSummary(wallets);
  ok(s.perChain.base.inboundCount === 2 && Math.abs(s.perChain.base.externalUsd - 0.03) < 1e-9 && s.perChain.base.caughtUp === true, "the synchronous readers answer from the mirror");

  // ---- boot 2, same file: nothing is re-imported ---------------------------------
  await sdb.stateQuery(`DELETE FROM ${S}.revenue_transfers WHERE txid = $1`, ["0xbbb:0"]);
  const m2 = await import("../src/revenue-ledger.js?boot=2");
  const second = await m2.ledgerStoreReady();
  ok(second?.imported === false, "a second boot with the same file does not import again");
  ok((await count()) === 1, "the row deleted from the tables is not resurrected from the file");
  // Put it back for the rest of the suite (the file's copy stays in the mirror either way).
  await m1.recordTransfer({ chain: "base", wallet: W, txid: "0xbbb:0", tx_hash: "0xbbb", block: 101, when_ts: 1781956800, payer: "0x2222222222222222222222222222222222222222", usd: 0.02, asset: "USDC", external: true });

  // ---- writes go to the tables; a replay is counted once -------------------------
  const row3 = { chain: "base", wallet: W, txid: "0xccc:0", tx_hash: "0xccc", block: 103, when_ts: 1781960400, payer: "0x3333333333333333333333333333333333333333", usd: 0.05, asset: "USDC", external: true };
  const r = m1.recordTransfer(row3);
  ok(r && typeof r.then === "function", "recordTransfer returns a promise with a database");
  await r;
  ok((await count("WHERE txid = $1", ["0xccc:0"])) === 1, "the recorded transfer is in the tables");
  s = m1.ledgerSummary(wallets);
  ok(s.perChain.base.inboundCount === 3 && Math.abs(s.perChain.base.externalUsd - 0.08) < 1e-9, "the mirror sees the write at once");
  await m1.recordTransfer(row3);
  await m1.recordTransfer({ ...row3, usd: 99 }); // the same (chain, wallet, txid) with other values: still one row, the first kept
  ok((await count("WHERE txid = $1", ["0xccc:0"])) === 1 && Number((await sdb.stateQuery(`SELECT usd FROM ${S}.revenue_transfers WHERE txid = $1`, ["0xccc:0"])).rows[0].usd) === 0.05, "a replayed transfer is counted once (the primary key), first values kept");

  // ---- a scan stores its page and its cursor in one transaction ------------------
  globalThis.fetch = async () => new Response(JSON.stringify({ _embedded: { records: [payment(1001, "h1", "GBUYER1"), payment(1002, "h2", "GBUYER2")] } }), { status: 200, headers: { "content-type": "application/json" } });
  const rs = await m1.syncStellar(STW);
  ok(rs.caughtUp === true, "a short Horizon page reports caught up");
  let cur = await cursorOf("stellar", STW);
  ok((await count("WHERE chain = 'stellar'")) === 2 && cur?.newest_sig === "1002" && Number(cur.caught_up) === 1, "the page's rows and its cursor are in the tables");
  ok(m1.ledgerSyncState().find((x) => x.chain === "stellar")?.caughtUp === true, "ledgerSyncState reads the cursor from the mirror");

  // A page that cannot be stored (a record without a transaction hash violates
  // the row's NOT NULL) must leave the cursor where it was AND store none of
  // the page: the cursor never advances past rows that are not stored.
  globalThis.fetch = async () => new Response(JSON.stringify({ _embedded: { records: [payment(1003, "h3", "GBUYER3"), { ...payment(1004, "h4", "GBUYER4"), transaction_hash: undefined }] } }), { status: 200, headers: { "content-type": "application/json" } });
  let threw = null;
  try { await m1.syncStellar(STW); } catch (e) { threw = e; }
  ok(threw !== null, `a page that cannot be stored throws out of the scan (${String(threw?.message || "").slice(0, 60)})`);
  cur = await cursorOf("stellar", STW);
  ok(cur?.newest_sig === "1002", `the cursor did not advance past the failed page (newest_sig ${cur?.newest_sig})`);
  ok((await count("WHERE chain = 'stellar'")) === 2, "none of the failed page's rows were stored (the good row rolled back with the bad one)");
  // The next tick resumes from the stored cursor: the good page is stored and the cursor moves.
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    ok(u.searchParams.get("cursor") === "1002", "the next scan resumes from the stored cursor");
    return new Response(JSON.stringify({ _embedded: { records: [payment(1003, "h3", "GBUYER3")] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await m1.syncStellar(STW);
  cur = await cursorOf("stellar", STW);
  ok(cur?.newest_sig === "1003" && (await count("WHERE chain = 'stellar'")) === 3, "the resumed scan stores the page and advances the cursor");

  // ---- a fresh instance with no file reads the tables ----------------------------
  process.env.REVENUE_LEDGER_DB = join(DIR, "fresh", "agent402-revenue.db");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(DIR, "fresh"), { recursive: true });
  const m3 = await import("../src/revenue-ledger.js?boot=3");
  const third = await m3.ledgerStoreReady();
  ok(third?.imported === false, "a container without the file imports nothing (the mark is shared)");
  const s3 = m3.ledgerSummary(wallets);
  ok(s3.perChain.base.inboundCount === 3 && s3.perChain.stellar.inboundCount === 3 && s3.perChain.stellar.caughtUp === true, `a fresh instance sees every row and cursor through its mirror (base ${s3.perChain.base.inboundCount}, stellar ${s3.perChain.stellar.inboundCount})`);
  ok(m3.ledgerRecent("stellar", STW).length === 3 && m3.onchainTxHashes("stellar").has("h3"), "ledgerRecent and onchainTxHashes answer from the fresh mirror");
  // A row written after the fresh instance loaded arrives on its next refresh.
  await m1.recordTransfer({ chain: "base", wallet: W, txid: "0xddd:0", tx_hash: "0xddd", block: 104, when_ts: 1781964000, payer: "0x4444444444444444444444444444444444444444", usd: 0.01, asset: "USDC", external: true });
  ok(m3.ledgerSummary(wallets).perChain.base.inboundCount === 3, "another instance's write is not visible before a refresh");
  await m3.refreshLedgerMirror();
  ok(m3.ledgerSummary(wallets).perChain.base.inboundCount === 4, "the refresh after a tick pulls rows another instance wrote");
  ok((await sdb.stateStoresReady()) === "ready", "no store is left pending");
} finally {
  globalThis.fetch = realFetch;
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
