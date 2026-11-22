// One settlement, one sale (src/sale-repeats.js), offline:
//
//   1. THE WRITER: a second sale for a Solana settlement signature is not
//      written; a signature of its own is; the rule stays off the rows it is
//      not true of (an EVM hash, a card invoice, a private-rail transaction,
//      a free call).
//   2. THE READERS: a ledger file that already holds repeat rows reads, in
//      every counting and summing reader, exactly as the same file without
//      them. Two children read the two files and the answers are compared
//      whole, so a reader added later that sums the table is compared too
//      once it is listed in READERS, and a statement that names the paying,
//      counted or buyer rails without the once term fails the source check.
//   3. THE OPERATOR SCRIPT (scripts/sale-repeats.js): the dry run lists the
//      repeats and changes nothing (the file's bytes are compared); --apply
//      refuses without the expected count, moves the rows when given it, and
//      holds back a row an attestation names.
//
//   node scripts/test-sale-repeats.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { childJson } from "./lib/child-json.js";

const SELF = fileURLToPath(import.meta.url);
const SCRIPT = join(SELF, "..", "sale-repeats.js");
const SOL_A = "So1PayerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SOL_B = "So1PayerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const EVM = "0x00000000000000000000000000000000000000a1";
const SIG = (n) => `sig${String(n).padStart(3, "0")}${"x".repeat(60)}`;

// ---- child: seed a ledger through the writer -------------------------------------
if (process.argv[2] === "seed") {
  const L = await import("../src/sales-ledger.js");
  const sale = (o) => L.recordSale({ priceUsd: 0.01, rail: "usdc", synthetic: false, ...o });
  sale({ slug: "web-search", network: "solana", payer: SOL_A, tx: SIG(1), priceUsd: 0.02, responseSha256: "a".repeat(64) });
  sale({ slug: "web-search", network: "solana", payer: SOL_A, tx: SIG(2), priceUsd: 0.02, responseSha256: "b".repeat(64) });
  sale({ slug: "hash", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payer: SOL_B, tx: SIG(3), priceUsd: 0.001 });
  sale({ slug: "v1-chat-metered", network: "solana", payer: SOL_B, tx: SIG(4), priceUsd: 0.004, quoteUsd: 0.01 });
  sale({ slug: "decide", network: "solana", payer: SOL_A, tx: SIG(5), priceUsd: 0.05 });
  sale({ slug: "web-search", network: "base", payer: EVM, tx: "0xevm1", priceUsd: 0.02 });
  sale({ slug: "web-search", network: "base", payer: EVM, tx: "0xevm1", priceUsd: 0.02 }); // an EVM hash is out of scope: both stand
  sale({ slug: "monitor", rail: "card", network: "stripe", payer: null, tx: "in_1", priceUsd: 5, wire: "stripe-subscription" });
  sale({ slug: "monitor", rail: "card", network: "stripe", payer: null, tx: "in_1", priceUsd: 5, wire: "stripe-subscription" });
  sale({ slug: "qr", rail: "pow", network: null, payer: null, tx: null, priceUsd: 0.001 });
  // The writer, on the rule itself.
  const before = L.salesSummary({ detailed: true }).totals.external.sales;
  sale({ slug: "web-search", network: "solana", payer: SOL_A, tx: SIG(1), priceUsd: 0.02 });
  sale({ slug: "hash", network: "solana", payer: SOL_B, tx: SIG(1), priceUsd: 0.001 }); // another tool and payer under the same signature: still a repeat
  const afterRepeat = L.salesSummary({ detailed: true }).totals.external.sales;
  sale({ slug: "web-search", network: "solana", payer: SOL_A, tx: SIG(6), priceUsd: 0.02 });
  const afterNew = L.salesSummary({ detailed: true }).totals.external.sales;
  console.log(JSON.stringify({ before, afterRepeat, afterNew, stats: L.saleRepeatStats(), plan: L.settlementBookedPlan?.() ?? null }));
  process.exit(0);
}

// ---- child: every counting and summing reader, as one JSON line ---------------------
// Lookups by transaction and the list of a payer's calls (free ones included)
// are not sums and are not compared: saleByTx, salesByTx, payerReceipts.
if (process.argv[2] === "read") {
  const L = await import("../src/sales-ledger.js");
  const now = Number(process.env.REPEATS_NOW), since = now - 30 * 86_400_000; // one clock for every child
  const READERS = {
    summary: () => L.salesSummary({ detailed: true }),
    summaryPublic: () => L.salesSummary(),
    summaryAsync: () => L.salesSummaryAsync({ detailed: true }),
    byNetwork: () => L.externalByNetwork(),
    topByBuyers: () => L.topByBuyers(),
    topPayers: () => L.topExternalPayersAsync({ now }),
    slugWindow: () => L.externalSlugWindow(since, now + 60_000),
    answers: () => L.answerDigestWindow(since, now + 60_000),
    claimed: () => L.claimedSettlements(since, now + 60_000),
    usageA: () => L.payerUsage(SOL_A),
    usageB: () => L.payerUsage(SOL_B),
    auditA: () => L.payerAuditRows(SOL_A, { fromMs: since, toMs: now + 60_000 }),
    auditB: () => L.payerAuditRows(SOL_B, { fromMs: since, toMs: now + 60_000 }),
    daily: () => L.externalDailyRevenue(),
    byPath: () => L.salesByPath(),
    funnel: () => L.funnelLedger({ now }),
    cohorts: () => L.salesCohorts({ now, fresh: true }),
    returning: () => L.returningBuyers({ now }),
    metered: () => L.meteredExternal(),
    proof: () => L.proofFeed(),
    decide: () => L.decideSales(),
    scorecard: () => L.buyerScorecard({ now, minGroup: 1 }),
    scoreboard: () => L.scoreboardLedger({ now }),
    paidA: () => L.payerHasPaidSale(SOL_A),
    forSlugs: () => L.externalSalesForSlugs(["web-search", "hash", "decide"], since, now + 60_000),
  };
  const out = {};
  // An answer's own "generated at" stamp is the read's clock, not a figure.
  for (const [k, f] of Object.entries(READERS)) out[k] = JSON.parse(JSON.stringify(await f(), (key, v) => (key === "generatedAt" ? undefined : v)));
  console.log(JSON.stringify({ readers: out, stats: L.saleRepeatStats() }));
  process.exit(0);
}

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const NOW = Date.now() + 5_000; // after every seeded row
const dir = mkdtempSync(join(tmpdir(), "a402-repeats-"));
const child = (mode, file) => {
  const r = spawnSync(process.execPath, [SELF, mode], { env: { ...process.env, SALES_LEDGER_DB: file, REPEATS_NOW: String(NOW) }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${mode} child exited ${r.status}: ${r.stderr.slice(-400)}`);
  return { json: childJson(r.stdout), stderr: r.stderr };
};
// The file and its write-ahead log, as one digest.
const sha = (f) => createHash("sha256").update(readFileSync(f)).update(existsSync(`${f}-wal`) ? readFileSync(`${f}-wal`) : "").digest("hex");
// A whole copy of a ledger file (its write-ahead log folded in).
const copyFileSync = (from, to) => { const d = new Database(from); d.prepare("VACUUM INTO ?").run(to); d.close(); };
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env }, encoding: "utf8" });

try {
  // ---- 1. the writer ---------------------------------------------------------------
  const clean = join(dir, "clean.db");
  const seeded = child("seed", clean);
  const w = seeded.json;
  ok(w.afterRepeat === w.before, `a second sale for one Solana settlement is not written, whatever tool or payer it names (${w.before} -> ${w.afterRepeat})`);
  ok(w.afterNew === w.before + 1, `a sale under a signature of its own is written (${w.afterRepeat} -> ${w.afterNew})`);
  ok(w.stats.refusedSinceBoot === 2 && w.stats.repeatRows === 0, `the two refusals are counted and no repeat row is on the books (${JSON.stringify(w.stats)})`);
  // The check runs on the loop once per Solana sale: it finds the settlement
  // by its id, never by walking the rail's rows (42 to 48 ms a sale measured
  // on 300,000 rows through the (rail, ts) index; microseconds through tx).
  ok(Array.isArray(w.plan) && w.plan.length === 1 && /\bidx_sales_tx\b/.test(w.plan[0]) && /^SEARCH\b/.test(w.plan[0]) && !/idx_sales_rail_ts|^SCAN\b/.test(w.plan[0]), `the writer's settlement check reads the settlement-id index and nothing else (${JSON.stringify(w.plan)})`);
  ok(/a sale was not written/.test(seeded.stderr) && !seeded.stderr.includes(SIG(1)) && !seeded.stderr.includes(SOL_A), "the refusal is logged with the tool and network, never the signature or the payer");
  {
    const db = new Database(clean, { readonly: true });
    const n = (sql, ...a) => db.prepare(sql).pluck().get(...a);
    ok(n("SELECT COUNT(*) FROM sales WHERE tx = ?", SIG(1)) === 1, "the file holds one row for the repeated signature");
    ok(n("SELECT COUNT(*) FROM sales WHERE tx = '0xevm1'") === 2 && n("SELECT COUNT(*) FROM sales WHERE tx = 'in_1'") === 2, "an EVM hash and a card invoice still stand behind two rows each (the rule is not theirs)");
    db.close();
  }

  // ---- 2. the readers ----------------------------------------------------------------
  // The same file with repeat rows written the way the old writer wrote them:
  // later rows, the same signature, some under another tool or payer.
  const dirty = join(dir, "dirty.db");
  copyFileSync(clean, dirty);
  {
    const db = new Database(dirty);
    const cols = "slug, price_usd, rail, network, payer, tx, internal, wire, quote_usd, response_sha256, via, run_key";
    const again = db.prepare(`INSERT INTO sales (ts, ${cols}) SELECT ts + ?, ${cols} FROM sales WHERE tx = ? ORDER BY id LIMIT 1`);
    for (const [sig, times] of [[SIG(1), 3], [SIG(2), 1], [SIG(3), 2], [SIG(4), 1], [SIG(5), 1]]) for (let i = 1; i <= times; i++) again.run(i * 1500, sig);
    db.prepare("UPDATE sales SET slug = 'hash', payer = ? WHERE id = (SELECT MAX(id) FROM sales WHERE tx = ?)").run(SOL_B, SIG(1));
    ok(db.prepare("SELECT COUNT(*) FROM sales").pluck().get() === new Database(clean, { readonly: true }).prepare("SELECT COUNT(*) FROM sales").pluck().get() + 8, "the second file holds eight repeat rows over five settlements");
    db.close();
  }
  const a = child("read", clean).json, a2 = child("read", clean).json, b = child("read", dirty).json;
  ok(JSON.stringify(a.readers) === JSON.stringify(a2.readers), "control: one file read twice gives the same answers (the comparison is not noise)");
  const differing = Object.keys(a.readers).filter((k) => JSON.stringify(a.readers[k]) !== JSON.stringify(b.readers[k]));
  ok(differing.length === 0, `every counting and summing reader counts a settlement once (${Object.keys(a.readers).length} readers${differing.length ? `; differing: ${differing.join(", ")}` : ""})`);
  ok(a.readers.summary.totals.external.sales > 0 && a.readers.usageA && a.readers.claimed.length > 0 && a.readers.auditA && JSON.stringify(a.readers.byNetwork).includes("solana"), "the readers compared hold the Solana sales (the comparison is not of empty answers)");
  ok(b.stats.repeatRows === 8 && a.stats.repeatRows === 0, `the repeat rows are listed for the operator (${b.stats.repeatRows})`);

  // Every statement that names the paying, counted or buyer rails carries the
  // once term, by its own text or through the window page it reads.
  {
    const src = readFileSync(join(SELF, "..", "..", "src", "sales-ledger.js"), "utf8");
    const statements = [...src.matchAll(/(`[^`]*`|"[^"\n]*")/g)].map((m) => m[1]).filter((q) => /rail IN \$\{(?:PAYING|COUNTED|BUYER)_RAILS_SQL\}/.test(q));
    // The one exception reads a payer's FIRST paid row after a grant: the first row under a settlement is never a repeat.
    const bare = statements.filter((q) => !/\$\{ONCE_SQL\}|\$\{WINDOW_PAGE\}/.test(q) && !/s\.rail IN \$\{PAYING_RAILS_SQL\}/.test(q));
    ok(statements.length >= 40 && bare.length === 0, `every statement on the paying, counted or buyer rails leaves repeat rows out (${statements.length} statements${bare.length ? `; bare: ${bare.map((q) => q.replace(/\s+/g, " ").slice(0, 80)).join(" | ")}` : ""})`);
    ok(/const WINDOW_PAGE = `[^`]*\$\{ONCE_SQL\}/.test(src), "the window page every stepped summary reads leaves repeat rows out");
  }

  // ---- 3. the operator script ----------------------------------------------------------
  const before = sha(dirty);
  const listFile = join(dir, "list.json");
  const dry = run(["--db", dirty, "--json", listFile]);
  ok(dry.status === 0 && /DRY RUN \(nothing is changed\)/.test(dry.stdout) && /settlements booked more than once: 5/.test(dry.stdout) && /repeat rows: 8 \(8 external, 0 our own\)/.test(dry.stdout), `the dry run lists the repeats (${dry.stdout.split("\n").slice(0, 3).join(" / ")})`);
  ok(/under another tool than the first row: 1; under another payer: 1/.test(dry.stdout) && /would move 8 row\(s\)/.test(dry.stdout), "and says what a correction would change, and which repeats name another tool or payer");
  ok(sha(dirty) === before, "the dry run leaves the file byte for byte as it was");
  ok(!dry.stdout.includes(SOL_A) && !dry.stdout.includes(SOL_B), "the dry run prints no payer");
  const list = JSON.parse(readFileSync(listFile, "utf8"));
  ok(list.rows === 8 && list.list.length === 8 && list.list.every((r) => r.keptId < r.id), "the list file names each repeat row and the earlier row it repeats");
  ok(run(["--db", clean]).stdout.includes("repeat rows: 0"), "a file with no repeats lists none");
  const noExpect = run(["--db", dirty, "--apply"]);
  const wrongExpect = run(["--db", dirty, "--apply", "--expect", "7"]);
  ok(noExpect.status === 2 && wrongExpect.status === 3 && sha(dirty) === before, `--apply refuses without the count the dry run printed, and with another count (${noExpect.status}, ${wrongExpect.status}); the file is unchanged`);
  {
    // A copy, with one repeat row an attestation names: that row is held back.
    const applied = join(dir, "applied.db");
    copyFileSync(dirty, applied);
    const db = new Database(applied);
    const heldId = db.prepare("SELECT MAX(id) FROM sales WHERE tx = ?").pluck().get(SIG(2));
    db.prepare("UPDATE sales SET attest_uid = '0xattested' WHERE id = ?").run(heldId);
    db.close();
    const r = run(["--db", applied, "--apply", "--expect", "8"]);
    const after = new Database(applied, { readonly: true });
    const n = (sql, ...x) => after.prepare(sql).pluck().get(...x);
    ok(r.status === 0 && /moved 7 row\(s\)/.test(r.stdout) && n("SELECT COUNT(*) FROM sales_repeats") === 7, `the correction moves the repeat rows to sales_repeats (${r.stdout.trim().split("\n").pop()})`);
    ok(n("SELECT COUNT(*) FROM sales WHERE id = ?", heldId) === 1 && n("SELECT COUNT(*) FROM sales WHERE tx = ?", SIG(2)) === 2, "a repeat row an attestation names is held back");
    ok(n("SELECT COUNT(*) FROM sales WHERE tx = ?", SIG(1)) === 1 && n("SELECT MIN(id) FROM sales WHERE tx = ?", SIG(1)) === n("SELECT id FROM sales WHERE tx = ? ORDER BY id LIMIT 1", SIG(1)) && n("SELECT COUNT(*) FROM sales WHERE tx = '0xevm1'") === 2, "each settlement keeps its first row, and rows outside the rule are untouched");
    after.close();
    const c = child("read", applied).json;
    const still = Object.keys(a.readers).filter((k) => JSON.stringify(a.readers[k]) !== JSON.stringify(c.readers[k]));
    ok(still.length === 0, `the corrected file reads as the clean one${still.length ? ` (differing: ${still.join(", ")})` : ""}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
