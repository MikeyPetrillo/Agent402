// The sales ledger against a REAL Postgres (STATE_DATABASE_URL; CI fails
// without it): both tables of the SQLite file are imported once at the first
// boot with the database on and never again, every write lands in Postgres
// (and in the file, write-through) in call order, one tx carries one feedback
// row, an attestation is written once, the boot sweep reclassifies our own
// wallets in the table, and a fresh process reads the table, not the file.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-sales-ledger-pg.js
import { mkdtempSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-sales-ledger-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = mkdtempSync(join(tmpdir(), "sales-pg-"));
const FILE = join(DIR, "agent402-sales.db");
process.env.SALES_LEDGER_DB = FILE;
process.env.LEDGER_MIRROR_MARGIN_MS = "400";
const BUYER = "0x1111111111111111111111111111111111111111";
const BUYER2 = "0x2222222222222222222222222222222222222222";

// The file a volume would hold, as the file-only build wrote it.
{
  const f = new Database(FILE);
  f.exec(`CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, slug TEXT NOT NULL, price_usd REAL NOT NULL, rail TEXT NOT NULL, network TEXT, payer TEXT, tx TEXT, internal INTEGER NOT NULL, wire TEXT, quote_usd REAL, response_sha256 TEXT, attest_uid TEXT, attest_tx TEXT);
    CREATE TABLE sale_feedback (tx TEXT PRIMARY KEY, sale_id INTEGER NOT NULL, slug TEXT NOT NULL, payer TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT, ts INTEGER NOT NULL)`);
  const ins = f.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire, quote_usd) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ins.run(Date.now() - 86_400_000, "hash", 0.001, "usdc", "base", BUYER, "0xfile1", 0, "x402", null);
  ins.run(Date.now() - 3600_000, "v1-chat-metered", 0.004, "usdc", "base", BUYER2, "0xfile2", 0, "mpp", 0.01);
  ins.run(Date.now() - 1000, "hash", 0.001, "heartbeat", null, null, null, 1, null, null);
  f.prepare("INSERT INTO sale_feedback (tx, sale_id, slug, payer, verdict, reason, ts) VALUES (?,?,?,?,?,?,?)").run("0xfile1", 1, "hash", BUYER, "good", "fine", Date.now() - 1000);
  f.close();
}

const sdb = await import("../src/state-db.js");
const sl = await import("../src/sales-ledger.js");
const { OUR_EVM_WALLETS } = await import("../src/revenue-live.js");
const BURNER = [...OUR_EVM_WALLETS][0].toLowerCase();
const S = sdb.stateDbSchema();
const q = async (sql, params = []) => (await sdb.stateQuery(sql, params)).rows;

try {
  ok(sl.salesLedgerBackend === "pg" && sl.salesPersistent === true, "the ledger reports the database backend and counts as persistent");
  await sl.salesLedgerReady();

  // ---- (1) import once, both tables ------------------------------------------
  let s = sl.salesSummary({ detailed: true });
  ok(s.totals.external.sales === 2 && s.totals.internal.sales === 1 && s.totals.external.revenueUsd === 0.005, `the file's sales are imported (${JSON.stringify(s.totals)})`);
  ok(sl.saleByTx("0xfile2")?.id === 2 && sl.saleByTx("0xfile2")?.wire === "mpp", "a sale is readable by tx with the file's id");
  ok(sl.feedbackForTx("0xfile1")?.verdict === "good", "the feedback table is imported too");
  const mark = await sdb.imports.done("agent402-sales.db");
  ok(mark && mark.source === FILE, "the import is marked under the file's basename");
  ok((await q(`SELECT count(*)::int AS n FROM ${S}.sales`))[0].n === 3 && (await q(`SELECT count(*)::int AS n FROM ${S}.sale_feedback`))[0].n === 1, "Postgres holds both tables");
  ok(sl.proofFeed().external.count === 1 && sl.proofFeed().external.latest.underQuote === true, "the metered proof reads from the mirror");

  // ---- M2: the first refresh after an import does not pull the import again --
  // (a child on its own schema, with a margin far wider than the boot, so
  // every imported row is inside it)
  {
    const src = `
      const sl = await import(${JSON.stringify(join(ROOT, "src/sales-ledger.js"))});
      const sdb = await import(${JSON.stringify(join(ROOT, "src/state-db.js"))});
      await sl.salesLedgerReady();
      const n = await sl.salesLedgerRefresh();
      console.log(JSON.stringify({ n, imported: sl.salesSummary({ detailed: true }).totals.external.sales }));
      await sdb.__dropStateSchema(); await sdb.closeStateDb(); process.exit(0);
    `;
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", src], {
      env: { ...process.env, STATE_DB_SCHEMA: `${S}_imp`, LEDGER_MIRROR_MARGIN_MS: "60000", LEDGER_MIRROR_REFRESH_MS: "1000000000" }, cwd: ROOT, encoding: "utf8",
    }).trim().split("\n").pop());
    ok(out.imported === 2 && out.n === 0, `M2: the first refresh after an import pulls none of the imported rows (${out.n}; mirror holds ${out.imported} external sales)`);
  }

  // ---- (2) writes land in call order, in Postgres and in the file -------------
  const p1 = sl.recordSale({ slug: "a-first", priceUsd: 0.01, rail: "usdc", network: "base", payer: BUYER, tx: "0xnew1", synthetic: false, wire: "x402" });
  const p2 = sl.recordSale({ slug: "b-second", priceUsd: 0.02, rail: "usdc", network: "base", payer: BUYER2, tx: "0xnew2", synthetic: false, wire: "mpp" });
  const p3 = sl.recordSale({ slug: "c-third", priceUsd: 0.03, rail: "usdc", network: "base", payer: BURNER, tx: "0xnew3", synthetic: false });
  ok([p1, p2, p3].every((p) => typeof p?.then === "function"), "recordSale returns a promise in database mode");
  ok((await Promise.all([p1, p2, p3])).every((v) => v === true), "every write resolves true once it is in Postgres");
  const ids = await q(`SELECT id::int AS id, slug FROM ${S}.sales WHERE tx IN ('0xnew1','0xnew2','0xnew3') ORDER BY id`);
  ok(ids.map((r) => r.slug).join() === "a-first,b-second,c-third" && ids[0].id === 4, `rows land in call order with ids continuing past the file's (${ids.map((r) => r.id).join()})`);
  ok(sl.saleByTx("0xnew3")?.internal === true, "a burner payer is classified internal at record time");
  s = sl.salesSummary({ detailed: true });
  ok(s.totals.external.sales === 4 && s.totals.internal.sales === 2, "the mirror has the landed rows");
  {
    const f = new Database(FILE, { readonly: true });
    const r = f.prepare("SELECT id, slug FROM sales WHERE tx = ?").get("0xnew2");
    f.close();
    ok(r && r.id === 5 && r.slug === "b-second", "write-through: the landed sale is also in the SQLite file with the same id");
  }
  ok((await sl.recordSale({})) === true && sl.saleByTx("") === null, "garbage input still records an unknown row and never throws");

  // ---- (3) one feedback row per tx; an attestation is written once -----------
  const sale = sl.saleByTx("0xnew1");
  const f1 = await sl.recordSaleFeedback({ tx: "0xnew1", saleId: sale.id, slug: sale.slug, payer: BUYER, verdict: "good", reason: "ok" });
  const f2 = await sl.recordSaleFeedback({ tx: "0xnew1", saleId: sale.id, slug: sale.slug, payer: BUYER, verdict: "bad", reason: "changed my mind" });
  ok(f1?.verdict === "good" && f2?.verdict === "bad", "feedback resolves the recorded row");
  ok((await q(`SELECT verdict FROM ${S}.sale_feedback WHERE tx = '0xnew1'`)).map((r) => r.verdict).join() === "bad", "one row per tx: the second verdict replaces the first");
  ok(sl.feedbackForTx("0xnew1")?.verdict === "bad" && sl.feedbackByTool({ days: 1 }).find((r) => r.slug === "a-first")?.bad === 1, "the mirror reads the replaced verdict");
  ok(sl.badFeedback({ days: 1 })[0]?.reason === "changed my mind", "the operator list carries the words");
  ok((await sl.recordSaleFeedback({ tx: "0xnew1", saleId: sale.id, slug: sale.slug, payer: BUYER, verdict: "meh" })) === null, "a verdict outside good/bad is refused");
  {
    const f = new Database(FILE, { readonly: true });
    const r = f.prepare("SELECT verdict FROM sale_feedback WHERE tx = ?").get("0xnew1");
    f.close();
    ok(r?.verdict === "bad", "write-through: the feedback row is in the file with the replaced verdict");
  }
  ok((await sl.setAttestation(sale.id, { uid: "0xuid1", attestTx: "0xatt1" })) === true, "the first attestation is written");
  ok((await sl.setAttestation(sale.id, { uid: "0xuid2", attestTx: "0xatt2" })) === false, "a second attestation for the same sale is a no-op");
  ok((await q(`SELECT attest_uid FROM ${S}.sales WHERE id = $1`, [sale.id]))[0].attest_uid === "0xuid1" && sl.saleByTx("0xnew1")?.attestUid === "0xuid1", "the first UID stands in Postgres and in the mirror");

  // ---- another container's row arrives on refresh -----------------------------
  await sdb.stateQuery(`INSERT INTO ${S}.sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES ($1, 'elsewhere', 0.05, 'usdc', 'base', $2, '0xelse', 0, 'x402')`, [Date.now(), BUYER2]);
  ok(sl.saleByTx("0xelse") === null, "before a refresh the mirror lacks the other container's row");
  await sl.salesLedgerRefresh();
  ok(sl.saleByTx("0xelse")?.slug === "elsewhere" && sl.salesSummary().totals.external.sales === 6, "after a refresh the mirror has it (2 imported + 2 recorded + the unknown-rail row + the other container's)");

  // ---- (1b) a second boot: no re-import, the boot sweep, a current table -------
  await sdb.stateQuery(`DELETE FROM ${S}.sales WHERE tx = '0xfile1'`); // only a test deletes; the file still holds the row
  await sdb.stateQuery(`INSERT INTO ${S}.sales (ts, slug, price_usd, rail, network, payer, tx, internal) VALUES ($1, 'late-burner', 0.01, 'usdc', 'base', $2, '0xlate', 0)`, [Date.now(), BURNER]);
  const childSrc = `
    process.env.SALES_LEDGER_DB = ${JSON.stringify(join(DIR, "absent", "agent402-sales.db"))};
    const sl = await import(${JSON.stringify(join(ROOT, "src/sales-ledger.js"))});
    const sdb = await import(${JSON.stringify(join(ROOT, "src/state-db.js"))});
    await sl.salesLedgerReady();
    const s = sl.salesSummary({ detailed: true });
    console.log(JSON.stringify({ totals: s.totals, file1: sl.saleByTx("0xfile1"), late: sl.saleByTx("0xlate"), new1: sl.saleByTx("0xnew1"), fb: sl.feedbackForTx("0xnew1"), else_: sl.saleByTx("0xelse") }));
    await sdb.closeStateDb();
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", childSrc], { env: { ...process.env }, cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop());
  ok(out.file1 === null, "a second boot does not import the file again (a row deleted from the table stays gone)");
  ok(out.late?.internal === true, "the boot sweep reclassifies a burner's row in the table");
  ok(out.new1?.attestUid === "0xuid1" && out.fb?.verdict === "bad" && out.else_?.slug === "elsewhere", "the second boot reads the table's current state");
  ok(out.totals.external.sales === 5 && out.totals.internal.sales === 3, `the second boot's totals: one external row deleted, one burner row swept internal (${JSON.stringify(out.totals)})`);
  ok(!existsSync(join(DIR, "absent", "agent402-sales.db")), "a boot with no file does not create one");

  // ---- roll-forward after a rollback -----------------------------------------
  const bootWithFile = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", childSrc.replace(JSON.stringify(join(DIR, "absent", "agent402-sales.db")), JSON.stringify(FILE))], { env: { ...process.env }, cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop());
  // (a) an ordinary write-through: the file sits within the grace of the tables' newest row, so a file edit is not applied.
  ok((await sl.recordSale({ slug: "roll", priceUsd: 0.01, rail: "usdc", network: "base", payer: BUYER, tx: "0xroll1", synthetic: false })) === true, "a sale recorded by the database build (written through to the file)");
  { const f = new Database(FILE); f.prepare("UPDATE sale_feedback SET verdict = 'good' WHERE tx = '0xnew1'").run(); f.close(); }
  bootWithFile();
  ok((await q(`SELECT verdict FROM ${S}.sale_feedback WHERE tx = '0xnew1'`))[0].verdict === "bad", "a file written within the grace is not rolled forward (write-through, not a rollback)");
  // (b) the file-only build ran alone: a sale and a changed verdict in the file, past the grace.
  {
    const f = new Database(FILE);
    f.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, 'file-only', 0.07, 'usdc', 'base', ?, '0xfileonly', 0, 'x402')").run(Date.now(), BUYER2);
    f.prepare("UPDATE sale_feedback SET verdict = 'good', reason = 'rolled forward', ts = ? WHERE tx = '0xnew1'").run(Date.now());
    f.close();
    const future = new Date(Date.now() + 10 * 60_000);
    utimesSync(FILE, future, future);
  }
  const rolled = bootWithFile();
  ok((await q(`SELECT slug FROM ${S}.sales WHERE tx = '0xfileonly'`))[0]?.slug === "file-only", "a sale added to the file alone is in the database after the next boot");
  ok((await q(`SELECT verdict, reason FROM ${S}.sale_feedback WHERE tx = '0xnew1'`))[0]?.reason === "rolled forward", "a verdict changed in the file wins in the database");
  ok(rolled.fb?.verdict === "good" && rolled.file1?.tx === "0xfile1", "the booting instance reads the rolled-forward verdict, and a row the file still holds is back (insert-if-absent)");
  await sl.salesLedgerRefresh();
  ok(sl.saleByTx("0xfileonly")?.slug === "file-only", "a refresh brings the rolled-forward row into this instance's mirror");
  ok((await sl.recordSale({ slug: "after", priceUsd: 0.01, rail: "usdc", network: "base", payer: BUYER, tx: "0xafterroll", synthetic: false })) === true && sl.saleByTx("0xafterroll").id > sl.saleByTx("0xfileonly").id, "the id sequence continues past the rolled-forward rows");
  // A verdict in the file older than the table's is not applied, even past the grace.
  {
    const f = new Database(FILE);
    f.prepare("UPDATE sale_feedback SET verdict = 'bad', reason = 'stale', ts = 1 WHERE tx = '0xnew1'").run();
    f.close();
    const future = new Date(Date.now() + 20 * 60_000);
    utimesSync(FILE, future, future);
    bootWithFile();
    ok((await q(`SELECT reason FROM ${S}.sale_feedback WHERE tx = '0xnew1'`))[0]?.reason === "rolled forward", "an older verdict in the file never replaces the table's newer one");
  }

  // ---- M5: a cutover-window sale by the file-only build, its id taken, old mtime ----
  {
    const taken = sl.saleByTx("0xafterroll").id;
    const f = new Database(FILE);
    f.prepare("DELETE FROM sales WHERE id = ?").run(taken);
    f.prepare("INSERT INTO sales (id, ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, ?, 'cutover', 0.02, 'usdc', 'base', ?, '0xcutover', 0, 'x402')").run(taken, Date.now(), BUYER2);
    f.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal) VALUES (?, 'pow-cutover', 0, 'pow', NULL, NULL, NULL, 0)").run(Date.now());
    // Two sales naming one payment: both must land (a tx is not a sale's identity).
    f.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, 'monitor', 5, 'card', 'stripe', NULL, 'in_cutover-shared', 0, 'stripe-subscription')").run(Date.now());
    f.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, 'monitor-report', 0, 'card', 'stripe', NULL, 'in_cutover-shared', 0, 'stripe-subscription')").run(Date.now());
    f.close();
    const past = new Date(Date.now() - 30 * 60_000);
    utimesSync(FILE, past, past);
    bootWithFile();
    ok((await q(`SELECT count(*)::int AS n FROM ${S}.sales WHERE tx = '0xcutover'`))[0].n === 1 && (await q(`SELECT count(*)::int AS n FROM ${S}.sales WHERE slug = 'pow-cutover'`))[0].n === 1, "M5: sales the old build wrote to the file land at the next boot, under a taken id and an old mtime, with or without a tx");
    bootWithFile();
    ok((await q(`SELECT count(*)::int AS n FROM ${S}.sales WHERE tx = '0xcutover'`))[0].n === 1 && (await q(`SELECT count(*)::int AS n FROM ${S}.sales WHERE slug = 'pow-cutover'`))[0].n === 1, "M5: and a second boot inserts them no second time");
    ok((await q(`SELECT count(*)::int AS n FROM ${S}.sales WHERE tx = 'in_cutover-shared'`))[0].n === 2, "M5: two file sales sharing one tx both land, once each");
    ok((await q(`SELECT slug FROM ${S}.sales WHERE id = $1`, [taken]))[0]?.slug === "after", "M5: the table's own row under that id is untouched");
  }

  // ---- H13: a NUL in a buyer's words never stops the ledger -------------------
  {
    const sale = sl.saleByTx("0xnew2");
    const fbn = await sl.recordSaleFeedback({ tx: "0xnew2", saleId: sale.id, slug: sale.slug, payer: BUYER2, verdict: "bad", reason: "broken\u0000output" });
    ok(fbn?.verdict === "bad" && (await q(`SELECT reason FROM ${S}.sale_feedback WHERE tx = '0xnew2'`))[0]?.reason === "brokenoutput", "H13: a verdict whose reason carries a NUL is stored, NUL stripped");
    const f = new Database(FILE);
    f.prepare("INSERT INTO sale_feedback (tx, sale_id, slug, payer, verdict, reason, ts) VALUES ('0xnulfb', 1, 'hash', ?, 'bad', ?, ?)").run(BUYER, "x\u0000y", Date.now());
    f.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal) VALUES (?, ?, 0.01, 'usdc', 'base', ?, '0xnulsale', 0)").run(Date.now(), "nul\u0000slug", BUYER);
    f.close();
    const out3 = bootWithFile();
    ok(out3.totals && (await q(`SELECT reason FROM ${S}.sale_feedback WHERE tx = '0xnulfb'`))[0]?.reason === "xy" && (await q(`SELECT slug FROM ${S}.sales WHERE tx = '0xnulsale'`))[0]?.slug === "nulslug", "H13: file rows with a NUL are imported and the ledger still loads");
    ok((await sl.recordSale({ slug: "after-nul", priceUsd: 0.01, rail: "usdc", network: "base", payer: BUYER, tx: "0xafternul", synthetic: false })) === true, "H13: a later sale still lands");
  }

  // ---- e5: salesLedgerFlush resolves only once a queued write is in Postgres ----
  {
    sl.recordSale({ slug: "flush", priceUsd: 0.01, rail: "usdc", network: "base", payer: BUYER, tx: "0xflush", synthetic: false }); // not awaited
    await sl.salesLedgerFlush();
    ok((await q(`SELECT count(*)::int AS n FROM ${S}.sales WHERE tx = '0xflush'`))[0].n === 1, "e5: a queued sale is in Postgres when the flush resolves");
  }

  // ---- M2: an import burst is not pulled again on every refresh ---------------
  {
    const vals = [];
    for (let i = 0; i < 10000; i++) vals.push(`(${Date.now()}, 'bulk', 0.001, 'usdc', 'base', '0xbulk${i}', 0)`);
    await sdb.stateQuery(`INSERT INTO ${S}.sales (ts, slug, price_usd, rail, network, tx, internal) VALUES ${vals.join(",")}`);
    const gap = () => new Promise((r) => setTimeout(r, Number(process.env.LEDGER_MIRROR_MARGIN_MS) + 300));
    await gap();
    const first = await sl.salesLedgerRefresh();
    await gap();
    const second = await sl.salesLedgerRefresh();
    ok(first >= 10000 && second === 0, `M2: a 10k-row burst is pulled once, and the next refresh pulls nothing (${first}, ${second})`);
  }

  // ---- a file with 130k sales in the reconcile window still loads ------------
  // The per-boot reconcile reads every file sale since the import mark; its
  // lowest ts was once taken with Math.min(...spread), which throws a
  // RangeError past ~110k arguments, so the first load never landed.
  {
    const bigDir = join(DIR, "big");
    const bigFile = join(bigDir, "agent402-sales.db");
    execFileSync("mkdir", ["-p", bigDir]);
    const f = new Database(bigFile);
    f.exec(`CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, slug TEXT NOT NULL, price_usd REAL NOT NULL, rail TEXT NOT NULL, network TEXT, payer TEXT, tx TEXT, internal INTEGER NOT NULL, wire TEXT, quote_usd REAL, response_sha256 TEXT, attest_uid TEXT, attest_tx TEXT);
      CREATE TABLE sale_feedback (tx TEXT PRIMARY KEY, sale_id INTEGER NOT NULL, slug TEXT NOT NULL, payer TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT, ts INTEGER NOT NULL)`);
    const ins = f.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, ?, 0.001, 'usdc', 'base', NULL, ?, 0, 'x402')");
    const t0 = Date.now();
    f.transaction(() => { for (let i = 0; i < 130_000; i++) ins.run(t0 + i, `tool-${i % 17}`, `0xbig${i}`); })();
    f.close();
    const bigSchema = `${S}_big`;
    const src = `
      const sl = await import(${JSON.stringify(join(ROOT, "src/sales-ledger.js"))});
      const sdb = await import(${JSON.stringify(join(ROOT, "src/state-db.js"))});
      const { unloadedStores } = await import(${JSON.stringify(join(ROOT, "src/store-retry.js"))});
      const loaded = await Promise.race([sl.salesLedgerReady().then(() => true), new Promise((r) => setTimeout(() => r(false), 60000))]);
      const landed = await sl.recordSale({ slug: "after-big", priceUsd: 0.01, rail: "usdc", network: "base", payer: null, tx: "0xafterbig" });
      const n = Number((await sdb.stateQuery("SELECT count(*) AS n FROM " + sdb.stateDbSchema() + ".sales")).rows[0].n);
      console.log(JSON.stringify({ loaded, unloaded: unloadedStores(), landed, n }));
      await sdb.__dropStateSchema(); await sdb.closeStateDb(); process.exit(0);
    `;
    const big = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", src], {
      env: { ...process.env, SALES_LEDGER_DB: bigFile, STATE_DB_SCHEMA: bigSchema, STATE_STORE_RETRY_MS: "500", LEDGER_MIRROR_REFRESH_MS: "1000000000" },
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20,
    }).trim().split("\n").pop());
    ok(big.loaded && !big.unloaded.includes("sales ledger") && big.landed === true && big.n === 130_001,
      `130k file sales in the reconcile window: the ledger loads and a sale lands (${JSON.stringify(big)})`);
  }
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
