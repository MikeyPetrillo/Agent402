// The backfill mints debts for buyers a 200-with-an-empty-envelope charged,
// which the charged-failure detector cannot see (it mints only on a NON-200).
// It moves no money, but it decides who is OWED money, so the selection rules
// are pinned here: who is in, who is out, and that a second run is a no-op.
//
// Runs against temp ledgers via SALES_LEDGER_DB / REFUND_DB_DIR.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "a402-refund-backfill-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.REFUND_DB_DIR = dir;

// Seed BEFORE importing, because both ledgers open their database at module load.
const seed = new Database(process.env.SALES_LEDGER_DB);
seed.exec(`CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, slug TEXT NOT NULL,
  price_usd REAL NOT NULL, rail TEXT NOT NULL, network TEXT, payer TEXT, tx TEXT,
  internal INTEGER NOT NULL)`);
const ins = seed.prepare("INSERT INTO sales (ts,slug,price_usd,rail,network,payer,tx,internal) VALUES (?,?,?,?,?,?,?,?)");
const IN_WINDOW = Date.parse("2026-08-01T00:00:00Z");
const BEFORE = Date.parse("2026-06-01T00:00:00Z");
ins.run(IN_WINDOW, "skill-fred-snapshot", 0.10, "usdc", "base", "0xoutsider", "0xaaa", 0);
ins.run(IN_WINDOW, "skill-openapi-audit", 0.06, "usdc", "solana", "SoLoutsider", "sig1", 0);
ins.run(IN_WINDOW, "skill-fred-snapshot", 0.10, "usdc", "base", "0xourburner", "0xbbb", 1); // internal
ins.run(BEFORE,    "skill-fred-snapshot", 0.10, "usdc", "base", "0xoutsider", "0xccc", 0);  // out of window
ins.run(IN_WINDOW, "skill-crypto-dossier", 0.12, "usdc", "base", "0xoutsider", "0xddd", 0); // partial pack
ins.run(IN_WINDOW, "skill-competitor-scan", 0.15, "usdc", "base", "0xoutsider", null, 0);   // no settle tx
seed.close();

const { backfillBrokenPackRefunds } = await import("../src/refund-backfill.js");
const { listRefunds } = await import("../src/refund-ledger.js");

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log("ok -", msg); };

const dry = backfillBrokenPackRefunds({ write: false });
ok(dry.settlements === 3, `only in-window external sales of non-delivering packs are selected (got ${dry.settlements})`);
ok(!Object.keys(dry.byPayer).includes("0xourburner"), "our own burner is never owed a refund from ourselves");
ok(!Object.values(dry.byPayer).some((v) => v.usd === 0.12), "a partial-delivery pack is not treated as non-delivery");
ok(dry.owedUsd === 0.31, `owed is the sum of the selected rows only (got ${dry.owedUsd})`);
ok(dry.skippedNoTx === 1, "a sale with no settle tx is counted and skipped, not minted unverifiable");
ok(listRefunds({ status: "owed" }).length === 0, "a dry run records nothing");

const wrote = backfillBrokenPackRefunds({ write: true });
ok(wrote.minted === 2, `only rows carrying a settle tx are minted (got ${wrote.minted})`);
const owed = listRefunds({ status: "owed", limit: 50 });
ok(owed.length === 2, `the ledger holds one debt per minted settlement (got ${owed.length})`);
ok(owed.some((r) => r.network === "solana"), "a Solana debt IS recorded even though no sender exists - refund-run holds it before claiming, so it cannot strand");

const again = backfillBrokenPackRefunds({ write: true });
ok(again.minted === 0 && again.alreadyRecorded === 2, "a second run mints nothing (idempotent on the settle tx)");
ok(listRefunds({ status: "owed", limit: 50 }).length === 2, "and does not duplicate the ledger rows");

console.log(`\n${passed} passed, 0 failed`);
