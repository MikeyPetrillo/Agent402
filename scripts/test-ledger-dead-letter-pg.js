// The refund and sales ledgers through a Postgres outage (STATE_DATABASE_URL;
// CI fails without it). Both ledgers run behind a TCP relay the test cuts: a
// debt owed and a sale recorded while the database is unreachable are kept
// in the local dead-letter (the ledger file), and once the relay heals they
// land exactly once, whether the replay comes from this process's refresh or
// from a fresh boot reading the same file. The NDJSON fallback of the
// dead-letter is checked on its own.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-ledger-dead-letter-pg.js
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema } = requireTestPg({ label: "test-ledger-dead-letter-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = mkdtempSync(join(tmpdir(), "ledger-dl-pg-"));

// ---- a TCP relay in front of Postgres the test can cut, black-hole and heal ----
// cut: every connection dropped and new ones refused (an outage that answers).
// blackhole: every connection, open or new, stays up and nothing passes (a
// database that hangs). heal: open connections are dropped, new ones pass.
const target = new URL(url);
let cut = false, hole = false;
const live = new Set();
const relay = createServer((client) => {
  if (cut) { client.destroy(); return; }
  live.add(client);
  client.on("error", () => client.destroy()); client.on("close", () => live.delete(client));
  if (hole) { client.on("data", () => {}); return; }
  const up = connect({ host: target.hostname, port: Number(target.port || 5432) });
  live.add(up);
  client.on("data", (d) => { if (!hole) up.write(d); });
  up.on("data", (d) => { if (!hole) client.write(d); });
  const drop = () => { client.destroy(); up.destroy(); live.delete(client); live.delete(up); };
  up.on("error", drop); client.on("close", drop); up.on("close", drop);
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const relayPort = relay.address().port;
const cutRelay = () => { cut = true; for (const s of live) s.destroy(); live.clear(); };
const blackholeRelay = () => { hole = true; };
const healRelay = () => { if (hole) { for (const s of live) s.destroy(); live.clear(); } cut = false; hole = false; };
const relayUrl = `${target.protocol}//${target.username ? `${target.username}${target.password ? ":" + target.password : ""}@` : ""}127.0.0.1:${relayPort}${target.pathname}${target.search}`;

process.env.STATE_DATABASE_URL = relayUrl;
process.env.STATE_DB_SCHEMA = schema;
// Short limits, so a hung database costs this test seconds, not the 12 s default.
process.env.STATE_DB_QUERY_TIMEOUT_MS = "2500";
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "2000";
process.env.REFUND_DB_DIR = DIR;
process.env.SALES_LEDGER_DB = join(DIR, "agent402-sales.db");

const sdb = await import("../src/state-db.js");
const rl = await import("../src/refund-ledger.js");
const sl = await import("../src/sales-ledger.js");
const { createDeadLetter } = await import("../src/ledger-mirror.js");
const { createTempoPushDebts } = await import("../src/tempo-push-debts.js");
const S = schema;
const count = async (sql, params = []) => Number((await sdb.stateQuery(sql, params)).rows[0].n);
const PAYER = "0x3333333333333333333333333333333333333333";

try {
  await rl.refundLedgerReady();
  await sl.salesLedgerReady();
  ok(rl.refundLedgerBackend === "pg" && sl.salesLedgerBackend === "pg", "both ledgers run on the database");

  // ---- (1) written while the database is unreachable --------------------------
  cutRelay();
  const debt = await rl.recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: PAYER, priceUsd: 0.002, tx: "0xdl-debt", httpStatus: 502, wire: "x402" });
  const sale = await sl.recordSale({ slug: "hash", priceUsd: 0.002, rail: "usdc", network: "base", payer: PAYER, tx: "0xdl-sale", wire: "x402" });
  const powSale = await sl.recordSale({ slug: "uuid", priceUsd: 0, rail: "pow" }); // no tx: matched by ts/slug/rail/payer
  // Two sales naming one payment (a subscription invoice and its report): a tx
  // is not a sale's identity, so the replay must land both.
  const shared1 = await sl.recordSale({ slug: "monitor", priceUsd: 5, rail: "card", network: "stripe", payer: null, tx: "in_dl-shared", wire: "stripe-subscription" });
  const shared2 = await sl.recordSale({ slug: "monitor-report", priceUsd: 0, rail: "card", network: "stripe", payer: null, tx: "in_dl-shared", wire: "stripe-subscription" });
  ok(debt === false && sale === false && powSale === false && shared1 === false && shared2 === false, "the writes report not landed while the database is unreachable");
  ok(rl.refundDeadLetterCount() === 1 && sl.salesDeadLetterCount() === 4, `the debt and the sales wait in the local dead-letter (${rl.refundDeadLetterCount()}, ${sl.salesDeadLetterCount()})`);

  // ---- (2) the database is back: a refresh lands each exactly once ----------------
  healRelay();
  await rl.refundLedgerRefresh();
  await sl.salesLedgerRefresh();
  ok(await count(`SELECT count(*) AS n FROM ${S}.refunds WHERE evidence = '0xdl-debt'`) === 1, "the debt is in Postgres after the outage");
  ok(await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx = '0xdl-sale'`) === 1 && await count(`SELECT count(*) AS n FROM ${S}.sales WHERE rail = 'pow' AND slug = 'uuid'`) === 1, "both sales are in Postgres after the outage");
  ok(await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx = 'in_dl-shared'`) === 2, "two sales sharing one tx both land: a tx alone is not a sale's identity");
  ok(rl.refundDeadLetterCount() === 0 && sl.salesDeadLetterCount() === 0, "the dead-letter is empty once they landed");
  ok(rl.refundByEvidence("0xdl-debt")?.status === "owed" && sl.saleByTx("0xdl-sale")?.slug === "hash", "the mirror reads the landed rows");
  await rl.refundLedgerRefresh();
  await sl.salesLedgerRefresh();
  ok(await count(`SELECT count(*) AS n FROM ${S}.refunds WHERE evidence = '0xdl-debt'`) === 1 && await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx = '0xdl-sale'`) === 1, "a second refresh lands nothing twice");

  // ---- (3) the commit landed but its reply was lost: still exactly once ----------
  cutRelay();
  ok((await rl.recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: PAYER, priceUsd: 0.002, tx: "0xdl-debt2", httpStatus: 502 })) === false, "a second debt waits");
  ok((await sl.recordSale({ slug: "hash", priceUsd: 0.002, rail: "usdc", network: "base", payer: PAYER, tx: "0xdl-sale2" })) === false, "a second sale waits");
  healRelay();
  // Another writer lands the same rows first (as if the original commit had gone through).
  await sdb.stateQuery(`INSERT INTO ${S}.refunds (evidence, slug, price_usd, created_at) VALUES ('0xdl-debt2', 'hash', 0.002, $1)`, [Date.now()]);
  // The landed sale is the queued one, value for value (a lost reply leaves exactly that row).
  const queued = sl._salesDeadLetterEntries().find((e) => e.kind === "sale" && e.payload[6] === "0xdl-sale2")?.payload;
  await sdb.stateQuery(`INSERT INTO ${S}.sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire, quote_usd, response_sha256, sale_uid)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, queued);
  // ---- (4) and a fresh boot reading the same file is the one that replays --------
  const childSrc = `
    const rl = await import(${JSON.stringify(join(ROOT, "src/refund-ledger.js"))});
    const sl = await import(${JSON.stringify(join(ROOT, "src/sales-ledger.js"))});
    const sdb = await import(${JSON.stringify(join(ROOT, "src/state-db.js"))});
    await rl.refundLedgerReady(); await sl.salesLedgerReady();
    console.log(JSON.stringify({ refunds: rl.refundDeadLetterCount(), sales: sl.salesDeadLetterCount() }));
    await sdb.closeStateDb();
  `;
  // Async: the relay runs on this process's event loop.
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", childSrc], { env: { ...process.env }, cwd: ROOT, encoding: "utf8" });
  const out = JSON.parse(stdout.trim().split("\n").pop());
  ok(out.refunds === 0 && out.sales === 0, "a fresh boot replays the dead-letter at its first load");
  ok(await count(`SELECT count(*) AS n FROM ${S}.refunds WHERE evidence = '0xdl-debt2'`) === 1 && await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx = '0xdl-sale2'`) === 1, "a row already in the table is not inserted again (insert-if-absent by evidence and by tx)");

  const settle = async () => {
    // After a heal the pool may hand out a socket the relay just dropped: a few rounds.
    for (let i = 0; i < 6 && (rl.refundDeadLetterCount() || sl.salesDeadLetterCount()); i++) {
      await rl.refundLedgerRefresh().catch(() => {}); await sl.salesLedgerRefresh().catch(() => {});
    }
  };

  // ---- (6) a database that HANGS: every write is on local disk when queued ------
  // The shutdown flush is bounded (10 s in the server, 1.5 s here) and a hung
  // statement waits for its time limit, so a write still queued at exit used
  // to die with the process. Now each sale and debt is on local disk the
  // moment it is queued, and once one write times out the rest fail fast.
  {
    await settle();
    blackholeRelay();
    const t0 = Date.now();
    const ps = [];
    for (let i = 0; i < 3; i++) ps.push(sl.recordSale({ slug: "hang", priceUsd: 0.01, rail: "usdc", network: "base", payer: PAYER, tx: `0xhang-sale${i}`, wire: "x402" }));
    for (let i = 0; i < 2; i++) ps.push(rl.recordRefundOwed({ slug: "hang", network: "eip155:8453", payer: PAYER, priceUsd: 0.01, tx: `0xhang-debt${i}`, httpStatus: 502 }));
    ok(sl.salesDeadLetterCount() === 3 && rl.refundDeadLetterCount() === 2, `queued writes are on local disk at once, before any statement answers (${sl.salesDeadLetterCount()} sales, ${rl.refundDeadLetterCount()} debts)`);
    await Promise.race([Promise.all([sl.salesLedgerFlush(), rl.refundLedgerFlush()]), new Promise((r) => setTimeout(r, 1500))]);
    ok(sl.salesDeadLetterCount() === 3 && rl.refundDeadLetterCount() === 2, "a bounded flush that ends before the time limit leaves every one of them on disk");
    const verdicts = await Promise.all(ps);
    const took = Date.now() - t0;
    ok(verdicts.every((v) => v === false), "each write reports not landed");
    ok(took < 4500, `fail fast: after the first write times out the rest skip Postgres (all five settled in ${took} ms; one time limit is 2.5 s)`);
    healRelay();
    await settle();
    ok(await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx LIKE '0xhang-sale%'`) === 3 && await count(`SELECT count(*) AS n FROM ${S}.refunds WHERE evidence LIKE '0xhang-debt%'`) === 2, "after the database answers again each lands exactly once");
    ok(sl.salesDeadLetterCount() === 0 && rl.refundDeadLetterCount() === 0, "and the dead-letter is empty");
  }

  // ---- (7) killed with writes queued against a hung database ---------------------
  {
    const kdir = join(DIR, "killed");
    const kenv = { ...process.env, REFUND_DB_DIR: kdir, SALES_LEDGER_DB: join(kdir, "agent402-sales.db") };
    const childKill = `
      const rl = await import(${JSON.stringify(join(ROOT, "src/refund-ledger.js"))});
      const sl = await import(${JSON.stringify(join(ROOT, "src/sales-ledger.js"))});
      await rl.refundLedgerReady(); await sl.salesLedgerReady();
      console.log("READY");
      process.stdin.once("data", () => {
        for (let i = 0; i < 3; i++) sl.recordSale({ slug: "killed", priceUsd: 0.01, rail: "usdc", network: "base", payer: ${JSON.stringify(PAYER)}, tx: "0xkill-sale" + i });
        for (let i = 0; i < 2; i++) rl.recordRefundOwed({ slug: "killed", network: "eip155:8453", payer: ${JSON.stringify(PAYER)}, priceUsd: 0.01, tx: "0xkill-debt" + i, httpStatus: 502 });
        console.log("QUEUED");
      });
    `;
    (await import("node:fs")).mkdirSync(kdir, { recursive: true });
    const child = spawn(process.execPath, ["--input-type=module", "-e", childKill], { env: kenv, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let kout = "";
    const saw = (word) => new Promise((resolve) => { const t = setInterval(() => { if (kout.includes(word)) { clearInterval(t); resolve(true); } }, 20); setTimeout(() => { clearInterval(t); resolve(false); }, 30_000); });
    child.stdout.on("data", (d) => { kout += d; });
    child.stderr.on("data", () => {});
    const exited = new Promise((r) => child.on("exit", r));
    ok(await saw("READY"), "a second process loaded both ledgers");
    blackholeRelay();
    child.stdin.write("go\n");
    ok(await saw("QUEUED"), "it queued three sales and two debts against the hung database");
    child.kill("SIGKILL");
    await exited;
    healRelay();
    const childBoot = `
      const rl = await import(${JSON.stringify(join(ROOT, "src/refund-ledger.js"))});
      const sl = await import(${JSON.stringify(join(ROOT, "src/sales-ledger.js"))});
      const sdb = await import(${JSON.stringify(join(ROOT, "src/state-db.js"))});
      await rl.refundLedgerReady(); await sl.salesLedgerReady();
      for (let i = 0; i < 6 && (rl.refundDeadLetterCount() || sl.salesDeadLetterCount()); i++) { await rl.refundLedgerRefresh().catch(() => {}); await sl.salesLedgerRefresh().catch(() => {}); }
      console.log(JSON.stringify({ refunds: rl.refundDeadLetterCount(), sales: sl.salesDeadLetterCount() }));
      await sdb.closeStateDb();
    `;
    const { stdout: bo } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", childBoot], { env: kenv, cwd: ROOT, encoding: "utf8" });
    const b = JSON.parse(bo.trim().split("\n").pop());
    ok(b.refunds === 0 && b.sales === 0, `the next boot from the same disk replays them (${JSON.stringify(b)})`);
    ok(await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx LIKE '0xkill-sale%'`) === 3 && await count(`SELECT count(*) AS n FROM ${S}.refunds WHERE evidence LIKE '0xkill-debt%'`) === 2, "a process killed with writes queued loses none of them: three sales and two debts, once each");
  }

  // ---- (8) a sale's identity is its own id, not ts/slug/rail/payer/tx -------------
  {
    await settle();
    const realNow = Date.now;
    const T0 = realNow() + 5000;
    cutRelay();
    Date.now = () => T0;
    const d1 = sl.recordSale({ slug: "web-search", priceUsd: 0.004, rail: "credits", network: "stripe", payer: "ck_test_key1", tx: null, wire: "credits" });
    const d2 = sl.recordSale({ slug: "web-search", priceUsd: 0.007, rail: "credits", network: "stripe", payer: "ck_test_key1", tx: null, wire: "credits" });
    Date.now = realNow;
    await d1; await d2;
    healRelay();
    await settle();
    const cn = (await sdb.stateQuery(`SELECT count(*)::int AS n, sum(price_usd) AS usd FROM ${S}.sales WHERE rail = 'credits' AND ts = $1`, [T0])).rows[0];
    ok(cn.n === 2 && Math.abs(Number(cn.usd) - 0.011) < 1e-9, `two distinct sales with one key, slug and millisecond both land after an outage (${cn.n} rows, ${cn.usd} usd)`);
    const T1 = realNow() + 9000;
    Date.now = () => T1;
    const l1 = sl.recordSale({ slug: "uuid", priceUsd: 0, rail: "pow" });
    Date.now = realNow;
    await l1;
    cutRelay();
    Date.now = () => T1;
    const l2 = sl.recordSale({ slug: "uuid", priceUsd: 0, rail: "pow" });
    Date.now = realNow;
    await l2;
    healRelay();
    await settle();
    ok(await count(`SELECT count(*) AS n FROM ${S}.sales WHERE rail = 'pow' AND ts = $1`, [T1]) === 2, "a landed sale and a dead-lettered twin in the same millisecond are two sales");
    // An entry queued before sale_uid existed (eleven values) still replays by the whole row, once.
    const old = [realNow(), "legacy", 0.01, "usdc", "base", PAYER, "0xlegacy-entry", 0, "x402", null, null];
    {
      const Database = (await import("better-sqlite3")).default;
      const f = new Database(join(DIR, "agent402-sales.db"));
      f.prepare("INSERT INTO pg_dead_letter (kind, payload, at) VALUES ('sale', ?, ?)").run(JSON.stringify(old), realNow());
      f.prepare("INSERT INTO pg_dead_letter (kind, payload, at) VALUES ('sale', ?, ?)").run(JSON.stringify(old), realNow());
      f.close();
    }
    await settle();
    ok(await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx = '0xlegacy-entry'`) === 1 && sl.salesDeadLetterCount() === 0, "an entry queued before sale ids (eleven values) replays by the whole row, once");
    cutRelay();
    await sl.recordSale({ slug: "uid", priceUsd: 0.01, rail: "usdc", network: "base", payer: PAYER, tx: "0xuid-entry" });
    ok(sl._salesDeadLetterEntries().some((e) => Array.isArray(e.payload) && e.payload.length === 12 && /^[0-9a-f-]{36}$/.test(e.payload[11])), "a new entry carries the sale's id as a twelfth value");
    healRelay();
    await settle();
  }

  // ---- (9) Tempo push debts: changes to a debt wait and land after the debt -------
  {
    await settle();
    const debts = createTempoPushDebts({
      recordOwed: rl.recordRefundOwed, voidOnClaim: rl.voidOwedOnClaim, renoteOwed: rl.renoteOwedRefund,
      refundByEvidence: rl.refundByEvidence, promoteToHangup: rl.promoteOwedToHangup,
      restateHandlerFailure: rl.restateOwedAsHandlerFailure, recordChargedFailure: () => {}, slugOf: () => "dns-lookup",
    });
    const status = async (h) => (await sdb.stateQuery(`SELECT status, note, http_status FROM ${S}.refunds WHERE evidence = $1`, [h])).rows[0] || null;
    const served = (h) => debts.served({ mppTempoPushHash: h, tempoSettled: true }, { statusCode: 200 });
    // refused and served, both while the database is down
    const h1 = "0x" + "d".repeat(64);
    cutRelay();
    await debts.inputRefused({}, { hash: h1, payer: "0x" + "2".repeat(40), amountUsd: 0.01, status: 400 });
    await served(h1);
    ok(rl.refundDeadLetterCount() === 2, `the debt and its void both wait on local disk (${rl.refundDeadLetterCount()})`);
    healRelay();
    await settle();
    ok((await status(h1))?.status === "void", `refused then served during an outage: after the replay the row is void, never owed (${(await status(h1))?.status})`);
    // refused during the outage; served after the heal but before any replay tick
    const h2 = "0x" + "e".repeat(64);
    cutRelay();
    await debts.inputRefused({}, { hash: h2, payer: "0x" + "3".repeat(40), amountUsd: 0.01, status: 400 });
    healRelay();
    const v2 = await served(h2);
    ok(v2 === true && (await status(h2))?.status === "void", `a void queued after the database is back lands the waiting debt first, then voids it (verdict ${v2}, row ${(await status(h2))?.status})`);
    // a hang-up promotion waits behind its debt too
    const h3 = "0x" + "f".repeat(64);
    cutRelay();
    await debts.inputRefused({}, { hash: h3, payer: "0x" + "4".repeat(40), amountUsd: 0.01, status: 400 });
    await debts.hungUp(h3, "payer budget");
    healRelay();
    await settle();
    const r3 = await status(h3);
    ok(r3?.status === "owed" && Number(r3.http_status) === 499 && /then disconnected/.test(r3.note), `a disconnect promotion made during an outage lands after its debt (${JSON.stringify(r3)})`);
    // replaying a change twice changes nothing more
    const before3 = JSON.stringify(await status(h3));
    await rl.promoteOwedToHangup(h3, { from: "push unclaimed: input refused", hangupReason: "payer budget", append: "claimed on retry, then disconnected" });
    ok(JSON.stringify(await status(h3)) === before3, "a change is guarded on the state it moves from: a second run is a no-op");
  }

  // ---- (10) the gateway-status word over both dead-letters -------------------------
  {
    const { deadLetterWord } = await import("../src/ledger-mirror.js");
    await settle();
    const word = (o = {}) => deadLetterWord([sl.salesDeadLetterState(), rl.refundDeadLetterState()], o);
    ok(word() === "none" && sl.salesDeadLetterState().oldestAt === null, "nothing on disk: none");
    cutRelay();
    await sl.recordSale({ slug: "word", priceUsd: 0.01, rail: "usdc", network: "base", payer: PAYER, tx: "0xword-sale" });
    await rl.recordRefundOwed({ slug: "word", network: "eip155:8453", payer: PAYER, priceUsd: 0.01, tx: "0xword-debt", httpStatus: 502 });
    ok(word() === "pending" && sl.salesDeadLetterState().waiting === 1 && rl.refundDeadLetterState().waiting === 1, "a sale and a debt waiting for the database: pending");
    ok(word({ now: Date.now() + 21 * 60_000 }) === "stuck" && word({ now: Date.now() + 21 * 60_000, stuckMinutes: 30 }) === "pending", "an entry older than the limit (20 minutes by default): stuck");
    const queued = sl.recordSale({ slug: "word", priceUsd: 0.01, rail: "usdc", network: "base", payer: PAYER, tx: "0xword-sale2" });
    ok(sl.salesDeadLetterState().total === 2 && sl.salesDeadLetterState().waiting === 1, "a write still queued is on disk but not counted as waiting");
    await queued;
    healRelay();
    await settle();
    ok(word() === "none", "once they land: none");
    ok(word({ enabled: false }) === "off", "without a state database: off");
    const hb = (await import("node:fs")).readFileSync(join(ROOT, ".github/workflows/heartbeat.yml"), "utf8");
    const step = hb.slice(hb.indexOf("- name: Ledger dead-letter check"), hb.indexOf("- name:", hb.indexOf("- name: Ledger dead-letter check") + 10));
    ok(/\.ledgerDeadLetter\.status/.test(step) && /if \[ "\$WORD" = "stuck" \]; then sleep 30; WORD=\$\(read_dl\); fi/.test(step) && /stuck\)\s+if \[ -z "\$OPEN" \]; then\s+gh issue create/.test(step),
      "the heartbeat reads ledgerDeadLetter.status, confirms stuck on a second reading and opens an issue");
  }

  // ---- (7) text Postgres cannot keep, through the dead-letter ---------------------
  // A sale's feedback reason and a debt's note queued during an outage carry
  // U+0000, an unpaired surrogate and JSON-escape text. The replay lands them
  // (the database's cleaning takes out what TEXT cannot hold and leaves the
  // escape text as typed, since neither column is cast to json/jsonb) and
  // the dead-letter empties: an entry is never stuck on its own text.
  {
    await settle();
    cutRelay();
    const reason = '{"x":"\\u0000"} a\u0000b \ud800';
    const note = '{"why":"\\u0000"}\u0000 n\udc00';
    ok((await sl.recordSale({ slug: "hash", priceUsd: 0.002, rail: "usdc", network: "base", payer: PAYER, tx: "0xnul-sale", wire: "x402" })) === false, "a sale waits");
    await sl.recordSaleFeedback({ tx: "0xnul-sale", saleId: 1, slug: "hash", payer: PAYER, verdict: "bad", reason });
    ok((await rl.recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: PAYER, priceUsd: 0.002, tx: "0xnul-debt", httpStatus: 502, note })) === false, "a debt with a note waits");
    ok(sl.salesDeadLetterCount() === 2 && rl.refundDeadLetterCount() === 1, `the sale, its feedback and the debt are on local disk (${sl.salesDeadLetterCount()}, ${rl.refundDeadLetterCount()})`);
    healRelay();
    await settle();
    ok(sl.salesDeadLetterCount() === 0 && rl.refundDeadLetterCount() === 0, `the dead-letter empties (${sl.salesDeadLetterCount()}, ${rl.refundDeadLetterCount()})`);
    const fb = (await sdb.stateQuery(`SELECT reason FROM ${S}.sale_feedback WHERE tx = '0xnul-sale'`)).rows[0]?.reason;
    ok(fb === '{"x":"\\u0000"} ab \ufffd', `the reason landed with U+0000 removed, the surrogate replaced and the escape text as typed (${JSON.stringify(fb)})`);
    const nt = (await sdb.stateQuery(`SELECT note FROM ${S}.refunds WHERE evidence = '0xnul-debt'`)).rows[0]?.note;
    ok(typeof nt === "string" && nt.startsWith('{"why":"\\u0000"}') && !nt.includes("\u0000") && !/[\ud800-\udfff]/.test(nt), `the note landed, escape text kept, U+0000 and the surrogate gone (${JSON.stringify(nt)})`);
    ok(sl.feedbackForTx("0xnul-sale")?.reason === fb, "the mirror reads the reason the database holds");
  }

  // ---- (5) the NDJSON fallback ---------------------------------------------------
  {
    const file = join(DIR, "nd", "dl.ndjson");
    const dl = createDeadLetter({ db: null, file });
    ok(dl.kind === "ndjson" && dl.size() === 0, "without an open SQLite file the dead-letter is an NDJSON file");
    ok(dl.add("refund", { evidence: "a" }) && dl.add("refund", { evidence: "b" }) && existsSync(file) && dl.size() === 2, "entries are appended (the directory is created)");
    const first = dl.list()[0];
    dl.remove(first.id);
    ok(dl.size() === 1 && dl.list()[0].payload.evidence === "b", "an entry is removed once it landed; the rest stay");
    ok(createDeadLetter({ db: null, file }).size() === 1, "the entries survive a restart");
    const p = dl.add("refund", { evidence: "c" }, { pending: true });
    ok(dl.size() === 2 && dl.list().length === 1, "a pending entry is on disk but not handed to the replay");
    dl.release(p);
    ok(dl.list().length === 2 && createDeadLetter({ db: null, file }).list().length === 2, "a released entry is handed to the replay; a fresh process sees every entry");
    for (const e of dl.list()) dl.remove(e.id);
    ok(dl.size() === 0 && dl.oldestAt() === null, "removed entries are gone");
  }
  // In a fail-fast window a write whose dead-letter append failed still tries
  // Postgres (it is kept nowhere else); one that is on disk skips it.
  {
    const { createLedgerWriter } = await import("../src/ledger-mirror.js");
    let diskOk = false, ran = 0;
    const dl = { add: () => (diskOk ? "id-1" : null), release: () => {}, remove: () => {} };
    const w = createLedgerWriter({ enqueue: (f) => f(), ready: async () => {}, deadLetter: dl, warnOnce: () => {}, label: "t" });
    w.failed(Object.assign(new Error("Query read timeout"), { code: "57014" }));
    ok(w.failFastActive(), "a timed-out write opens the fail-fast window");
    const origErr = console.error; console.error = () => {};
    let v;
    try { v = await w.write("w", async () => { ran++; return "landed"; }, { kind: "sale", payload: { a: 1 }, onError: false }); } finally { console.error = origErr; }
    ok(ran === 1 && v === "landed", `a write the dead-letter could not keep tries Postgres in the window (ran ${ran}, answered ${v})`);
    diskOk = true; ran = 0;
    w.failed(Object.assign(new Error("Query read timeout"), { code: "57014" }));
    v = await w.write("w", async () => { ran++; return "landed"; }, { kind: "sale", payload: { a: 2 }, onError: false });
    ok(ran === 0 && v === false, `a write on local disk skips Postgres in the window (ran ${ran})`);
  }
} finally {
  healRelay();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb().catch(() => {});
  relay.close();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
