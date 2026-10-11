// The money journals in Redis (src/ledger-journal-redis.js, through
// src/ledger-mirror.js createDeadLetter), on a REAL Postgres and a REAL Redis,
// each behind a TCP relay the test cuts and heals. Container B is a child
// process with healthy connections to both.
//   1. Postgres down: sales and a refund debt go to Redis (nothing on local
//      disk, the word "pending"); Postgres back: one replay books each once,
//      a second books nothing.
//   2. Another container drains them: B books A's journaled rows once, and
//      A's own replay afterwards books nothing twice.
//   3. A void that reached the database before the debt it voids (the Tempo
//      tombstone): the debt replayed from Redis books nothing owed.
//   4. Redis down too: the entries go to local disk, the word reads "local";
//      Postgres back: the replay lands them from disk, once.
//   5. Two replayers on one journal while a writer keeps adding: every record
//      applied exactly once, none lost.
//   6. A replayer killed mid-claim (and a writer killed with writes queued):
//      its entries come back to the other replayer once the lease lapses.
//   7. A replay that fails part way: the entries after the failure (and the
//      one that failed) stay in the journal and land on the next pass.
//   8. Card checkout, Redis up, A cut from Postgres past the stale window
//      (no heartbeat ever written): A answers the report from the shared
//      journal, B books A's record and never regenerates or refunds.
//   9. Card checkout, both stores down for A: A never answers the report;
//      B's takeover is the one outcome (a regeneration, or a refund), and
//      A's late replay books nothing over it, even while B's regeneration is
//      still running.
//  10. Outbound spend records (src/outbound-ledger.js), Postgres down: the
//      lines go to Redis (the word "pending", nothing on local disk);
//      Postgres back: the boot reconcile of the file and the replay together
//      add each line once.
//  11. Outbound, Redis down too: the lines go to local disk, the word reads
//      "local"; Postgres back: the replay lands them from disk, once.
//  12. Outbound, two replayers: one that inserted every line and was killed
//      before removing any (the other applies them again after the lease
//      lapses and adds nothing), then A and container B draining one journal
//      live: every line added exactly once, and an entry whose line already
//      landed adds nothing.
// Requires STATE_DATABASE_URL and REDIS_URL (under CI a missing one fails).
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "redis";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";

const SELF = fileURLToPath(import.meta.url);
const MODE = process.argv[2] || "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
delete process.env.ZEPTOMAIL_TOKEN; delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
const stripeOf = (refunds, product = "dossier") => ({
  refunds: { create: async (o) => { refunds.push(o.payment_intent); return { id: `re_${refunds.length}` }; } },
  checkout: { sessions: { retrieve: async (id) => ({ id, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, amount_total: 200, customer_details: { email: null }, metadata: { product, input: "MSFT" } }) } },
});

// ---- children (container B, or a replayer that dies) ------------------------
if (MODE === "sales-b") {
  process.env.REFUND_DB_DIR = mkdtempSync(join(tmpdir(), "jr-B-"));
  process.env.SALES_LEDGER_DB = join(process.env.REFUND_DB_DIR, "agent402-sales.db");
  const sdb = await import("../src/state-db.js");
  const rl = await import("../src/refund-ledger.js");
  const sl = await import("../src/sales-ledger.js");
  await rl.refundLedgerReady(); await sl.salesLedgerReady();
  await sl.salesLedgerRefresh(); await rl.refundLedgerRefresh();
  console.log(JSON.stringify({ ok: true }));
  await sdb.closeStateDb();
  process.exit(0);
}
if (MODE === "void-b") {
  process.env.REFUND_DB_DIR = mkdtempSync(join(tmpdir(), "jr-VB-"));
  const sdb = await import("../src/state-db.js");
  const rl = await import("../src/refund-ledger.js");
  await rl.refundLedgerReady();
  const voided = await rl.voidOwedOnClaim(process.argv[3], "claimed on retry");
  await rl.refundLedgerFlush();
  console.log(JSON.stringify({ voided }));
  await sdb.closeStateDb();
  process.exit(0);
}
if (MODE === "claim-die" || MODE === "pending-die") {
  const { createDeadLetter, flushJournals } = await import("../src/ledger-mirror.js");
  const dl = createDeadLetter({ file: join(mkdtempSync(join(tmpdir(), "jr-die-")), "j.ndjson"), journalKey: process.env.JR_KEY });
  if (MODE === "claim-die") {
    const got = await dl.claim();
    console.log(JSON.stringify({ claimed: got.length }));
  } else {
    for (let i = 0; i < 3; i++) dl.add("item", { n: 1000 + i }, { pending: true });
    await flushJournals();
    console.log(JSON.stringify({ added: 3 }));
  }
  await new Promise((r) => process.stdout.write("", r));
  process.kill(process.pid, "SIGKILL");
}
if (MODE === "outbound-b") {
  process.env.OUTBOUND_LEDGER_FILE = join(mkdtempSync(join(tmpdir(), "jr-ob-B-")), "outbound-spend.ndjson");
  process.env.OUTBOUND_JOURNAL_REPLAY_MS = "3600000";
  const sdb = await import("../src/state-db.js");
  const ob = await import("../src/outbound-ledger.js");
  let landed = 0;
  for (let i = 0; i < 40; i++) { landed += await ob.replayOutboundJournal(); await wait(15); }
  console.log(JSON.stringify({ landed }));
  await sdb.closeStateDb();
  process.exit(0);
}
if (MODE === "outbound-apply-die") {
  const sdb = await import("../src/state-db.js");
  const { createDeadLetter } = await import("../src/ledger-mirror.js");
  const dl = createDeadLetter({ file: join(mkdtempSync(join(tmpdir(), "jr-obd-")), "j.ndjson"), journalKey: `${sdb.stateDbSchema()}:outbound` });
  const got = await dl.claim();
  for (const e of got) await sdb.logLines.appendOnce("outbound-spend", e.payload);
  console.log(JSON.stringify({ applied: got.length }));
  await new Promise((r) => process.stdout.write("", r));
  process.kill(process.pid, "SIGKILL");
}
if (MODE === "hc-b") {
  process.env.HUMAN_CHECKOUT_REPLAY_MS = "200";
  const sdb = await import("../src/state-db.js");
  if (process.env.JR_HOLD_DRAIN) {
    // A is alive and its replay holds the drain of the journal (it keeps
    // failing against Postgres): B cannot claim the entry, so only the
    // stale-claim check can find it.
    const c = createClient({ url: process.env.REDIS_URL }); c.on("error", () => {}); await c.connect();
    await c.set(`a402:journal:{${sdb.stateDbSchema()}:checkoutFinals}:drain`, "container-A", { PX: 60_000 });
    await c.quit();
  }
  const { createHumanCheckout } = await import("../src/human-checkout.js");
  let gens = 0; const refunds = [], sales = [];
  const genDelay = Number(process.env.JR_GEN_DELAY_MS) || 0;
  const hc = createHumanCheckout({ stripe: stripeOf(refunds), baseUrl: "https://example.test", storeDir: mkdtempSync(join(tmpdir(), "jr-hc-B-")), log: () => {}, onSale: (s) => sales.push(s.sessionId),
    generate: async () => { gens++; if (genDelay) await wait(genDelay); return { report: "# B", title: "t", sources: [], tables: [] }; } });
  await hc.ready();
  await hc.fulfill(process.argv[3]);
  let p; for (let i = 0; i < 40 + genDelay / 50; i++) { p = await hc.peek(process.argv[3]); if (p && p.status !== "generating") break; await wait(50); }
  console.log(JSON.stringify({ gens, refunds: refunds.length, sales: sales.length, status: p?.status, report: p?.report ?? null }));
  await sdb.closeStateDb();
  process.exit(0);
}

// ---- the test (container A) -------------------------------------------------
requireTestPg({ label: "test-ledger-journal-redis-pg" });
const REDIS_DIRECT = String(process.env.REDIS_URL || "").trim();
if (!REDIS_DIRECT) {
  const msg = "test-ledger-journal-redis-pg: no REDIS_URL; start a local Redis (redis-server --port 26379 --save '' --appendonly no) and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}
const PG_DIRECT = process.env.STATE_DATABASE_URL;
const schema = process.env.STATE_DB_SCHEMA;
const pgRelay = await startPgRelay(PG_DIRECT);
const redisRelay = await startPgRelay(REDIS_DIRECT); // a TCP relay: any protocol
const DIR = mkdtempSync(join(tmpdir(), "jr-A-"));
process.env.STATE_DATABASE_URL = pgRelay.url;
process.env.REDIS_URL = redisRelay.url;
process.env.LEDGER_JOURNAL_REDIS = "on";
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1500";
process.env.STATE_DB_QUERY_TIMEOUT_MS = "2500";
process.env.LEDGER_JOURNAL_LEASE_MS = "1500";
process.env.LEDGER_JOURNAL_REDIS_OP_MS = "400";
process.env.LEDGER_JOURNAL_REDIS_DOWN_MS = "200";
process.env.HUMAN_CHECKOUT_REPLAY_MS = "200";
process.env.REFUND_DB_DIR = DIR;
process.env.SALES_LEDGER_DB = join(DIR, "agent402-sales.db");
const OB_FILE = join(DIR, "outbound-spend.ndjson");
process.env.OUTBOUND_LEDGER_FILE = OB_FILE;
process.env.OUTBOUND_JOURNAL_REPLAY_MS = "3600000"; // the test drives the replay

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A's journal client goes through the Redis relay; a fresh connection after a cut.
const jr = await import("../src/ledger-journal-redis.js");
let rc = null;
jr.__setJournalRedisForTest(async () => {
  if (rc?.isReady) return rc;
  try {
    const c = createClient({ url: redisRelay.url, disableOfflineQueue: true, socket: { reconnectStrategy: false, connectTimeout: 400 } });
    c.on("error", () => {});
    await c.connect();
    rc = c;
    return c;
  } catch { return null; }
});
const rd = createClient({ url: REDIS_DIRECT }); rd.on("error", () => {}); await rd.connect();
const hlen = (journal) => rd.hLen(`a402:journal:{${schema}:${journal}}:items`);
const pgDirect = async (sql, params) => {
  const pg = (await import("pg")).default; const c = new pg.Client({ connectionString: PG_DIRECT }); await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
};
const n = async (sql, params) => Number((await pgDirect(sql, params)).rows[0].n);
const child = (args, env = {}) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [SELF, ...args], { env: { ...process.env, STATE_DATABASE_URL: PG_DIRECT, STATE_DB_SCHEMA: schema, REDIS_URL: REDIS_DIRECT, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; c.stdout.on("data", (d) => { out += d; });
  c.on("exit", (code, sig) => { try { resolve({ ...JSON.parse(out.trim().split("\n").pop()), code, sig }); } catch { reject(new Error(`child ${args[0]} exited ${code ?? sig}: ${out}`)); } });
});

const sdb = await import("../src/state-db.js");
const rl = await import("../src/refund-ledger.js");
const sl = await import("../src/sales-ledger.js");
const { createDeadLetter, flushJournals, ledgerDeadLetterStatus } = await import("../src/ledger-mirror.js");
const { createHumanCheckout } = await import("../src/human-checkout.js");
const ob = await import("../src/outbound-ledger.js");
const PAYER = "0x4444444444444444444444444444444444444444";
const sale = (tx) => sl.recordSale({ slug: "hash", priceUsd: 0.002, rail: "usdc", network: "base", payer: PAYER, tx, wire: "x402" });
const debt = (tx) => rl.recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: PAYER, priceUsd: 0.002, tx, httpStatus: 502, wire: "x402" });
const salesOf = (tx) => n(`SELECT count(*) AS n FROM ${schema}.sales WHERE tx = $1`, [tx]);
const debtsOf = (tx) => n(`SELECT count(*) AS n FROM ${schema}.refunds WHERE evidence = $1`, [tx]);

try {
  await rl.refundLedgerReady(); await sl.salesLedgerReady();

  // ---- 1. Postgres down: the entries go to Redis; back: booked once ----------
  {
    pgRelay.cut();
    const txs = Array.from({ length: 5 }, (_, i) => `0xjr1-sale-${i}`);
    const answered = await Promise.all([...txs.map(sale), debt("0xjr1-debt")]);
    await flushJournals();
    ok(answered.every((v) => v === false), "the writes report not landed while Postgres is away");
    ok(await hlen("sales") === 5 && await hlen("refunds") === 1, `the sales and the debt wait in Redis (${await hlen("sales")}, ${await hlen("refunds")})`);
    await sl.salesLedgerRefresh().catch(() => {}); // a replay against a database still away keeps them
    const st = ledgerDeadLetterStatus({ full: true });
    ok(st.status === "pending" && st.sales.onLocalDisk === 0 && st.refunds.onLocalDisk === 0 && await hlen("sales") === 5, `nothing on local disk: the word reads ${st.status}, Redis still holds them (${await hlen("sales")})`);
    pgRelay.heal();
    await sl.salesLedgerRefresh(); await rl.refundLedgerRefresh();
    const counts = await Promise.all(txs.map(salesOf));
    ok(counts.every((c) => c === 1) && await debtsOf("0xjr1-debt") === 1, `Postgres back: every sale and the debt booked once (${counts.join(",")}, ${await debtsOf("0xjr1-debt")})`);
    ok(await hlen("sales") === 0 && await hlen("refunds") === 0 && ledgerDeadLetterStatus().status === "none", "...removed from Redis once booked; the word reads none");
    await sl.salesLedgerRefresh(); await rl.refundLedgerRefresh();
    ok((await Promise.all(txs.map(salesOf))).every((c) => c === 1) && await debtsOf("0xjr1-debt") === 1, "a second replay books nothing twice");
  }

  // ---- 2. another container drains A's journal ---------------------------------
  {
    pgRelay.cut();
    const txs = Array.from({ length: 4 }, (_, i) => `0xjr2-sale-${i}`);
    await Promise.all([...txs.map(sale), debt("0xjr2-debt")]);
    await flushJournals();
    ok(await hlen("sales") === 4 && await hlen("refunds") === 1, "A's rows wait in Redis while A cannot reach Postgres");
    await child(["sales-b"]);
    ok((await Promise.all(txs.map(salesOf))).every((c) => c === 1) && await debtsOf("0xjr2-debt") === 1 && await hlen("sales") === 0 && await hlen("refunds") === 0, "B (healthy) books A's journaled rows once and empties the journal");
    pgRelay.heal();
    await sl.salesLedgerRefresh(); await rl.refundLedgerRefresh();
    ok((await Promise.all(txs.map(salesOf))).every((c) => c === 1) && await debtsOf("0xjr2-debt") === 1, "A's own replay afterwards books nothing twice");
    ok(rl.refundByEvidence("0xjr2-debt")?.status === "owed", "A's mirror reads the debt B booked");
  }

  // ---- 3. the void tombstone holds for a debt replayed from Redis --------------
  {
    const h = `0x${randomBytes(32).toString("hex")}`;
    pgRelay.cut();
    await debt(h);
    await flushJournals();
    ok(await hlen("refunds") === 1, "A's debt waits in Redis");
    // B serves the claimed retry and voids before the debt reaches the database
    // (its journal stays local here, so it cannot land A's debt first).
    const b = await child(["void-b", h], { LEDGER_JOURNAL_REDIS: "off" });
    ok(b.voided === false && await debtsOf(h) === 0, "B voids while no row exists yet (the void marks the evidence)");
    pgRelay.heal();
    await rl.refundLedgerRefresh();
    const row = (await pgDirect(`SELECT status FROM ${schema}.refunds WHERE evidence = $1`, [h])).rows[0];
    ok(row?.status !== "owed" && await hlen("refunds") === 0, `A's debt replayed from Redis books nothing owed (row ${row?.status ?? "none"}), and leaves the journal`);
  }

  // ---- 4. Redis down too: local disk, the word "local", replay from disk -------
  {
    pgRelay.cut(); redisRelay.cut();
    await Promise.all([sale("0xjr4-sale"), debt("0xjr4-debt")]);
    await flushJournals();
    const st = ledgerDeadLetterStatus({ full: true });
    ok(st.status === "local" && st.sales.onLocalDisk === 1 && st.refunds.onLocalDisk === 1, `with Redis away the entries are on local disk and the word reads ${st.status} (${st.sales.onLocalDisk}, ${st.refunds.onLocalDisk})`);
    ok(Object.keys(ledgerDeadLetterStatus()).join(",") === "status", "the public view is the word alone");
    pgRelay.heal(); // Redis still away
    await sl.salesLedgerRefresh(); await rl.refundLedgerRefresh();
    ok(await salesOf("0xjr4-sale") === 1 && await debtsOf("0xjr4-debt") === 1, "Postgres back (Redis still away): the replay lands them from disk, once");
    ok(ledgerDeadLetterStatus().status === "none", "...and the word reads none");
    redisRelay.heal();
    await sl.salesLedgerRefresh(); await rl.refundLedgerRefresh();
    ok(await salesOf("0xjr4-sale") === 1 && await debtsOf("0xjr4-debt") === 1, "Redis back: nothing booked twice");
  }

  // ---- 5. two replayers, one journal, a writer still adding --------------------
  {
    const key = `${schema}:claims5`;
    const mk = () => createDeadLetter({ file: join(mkdtempSync(join(DIR, "r-")), "j.ndjson"), journalKey: key });
    const X = mk(), Y = mk(), Z = mk();
    const applied = new Map();
    const apply = async (e) => { applied.set(e.payload.n, (applied.get(e.payload.n) || 0) + 1); await wait(Math.random() * 2); return "landed"; };
    const TOTAL = 400;
    let added = 0, writing = true;
    const writer = (async () => {
      while (added < TOTAL) { for (let i = 0; i < 20; i++) X.add("item", { n: added++ }); await flushJournals(); await wait(5); }
      writing = false;
    })();
    const drainer = (dl) => (async () => {
      for (let i = 0; i < 2000; i++) {
        await dl.drain(apply);
        if (!writing && await rd.hLen(`a402:journal:{${key}}:items`) === 0) return;
        await wait(Math.random() * 3);
      }
    })();
    await Promise.all([writer, drainer(Y), drainer(Z), drainer(createDeadLetter({ file: join(mkdtempSync(join(DIR, "r-")), "j.ndjson"), journalKey: key }))]);
    const twice = [...applied].filter(([, c]) => c > 1).length;
    const missing = Array.from({ length: TOTAL }, (_, i) => i).filter((i) => !applied.has(i)).length;
    ok(twice === 0 && missing === 0 && applied.size === TOTAL, `three replayers draining one journal while a writer adds ${TOTAL}: each applied exactly once (twice ${twice}, missing ${missing})`);
  }

  // ---- 6. a replayer killed mid-claim; a writer killed with writes queued ------
  {
    const key = `${schema}:claims6`;
    const mk = () => createDeadLetter({ file: join(mkdtempSync(join(DIR, "r-")), "j.ndjson"), journalKey: key });
    const X = mk(), Y = mk();
    for (let i = 0; i < 20; i++) X.add("item", { n: i });
    await flushJournals();
    const died = await child(["claim-die"], { JR_KEY: key, LEDGER_JOURNAL_LEASE_MS: "1500" });
    ok(died.claimed === 20 && died.sig === "SIGKILL", `a replayer claimed all ${died.claimed} entries and was killed`);
    const applied = new Map();
    const apply = async (e) => { applied.set(e.payload.n, (applied.get(e.payload.n) || 0) + 1); return "landed"; };
    await Y.drain(apply);
    ok(applied.size === 0, `inside the dead replayer's lease nobody else applies them (${applied.size})`);
    const pend = await child(["pending-die"], { JR_KEY: key, LEDGER_JOURNAL_LEASE_MS: "1500" });
    await Y.drain(apply);
    ok(pend.added === 3 && applied.size === 0, "a writer killed with three writes queued: its write-ahead entries are not taken inside their lease");
    await wait(1800);
    await Y.drain(apply);
    const twice = [...applied].filter(([, c]) => c > 1).length;
    ok(applied.size === 23 && twice === 0, `once the leases lapse the other replayer applies all of them once (${applied.size}, twice ${twice})`);
    ok(await rd.hLen(`a402:journal:{${key}}:items`) === 0, "...and the journal is empty");
  }

  // ---- 7. a replay that fails part way keeps the rest --------------------------
  {
    const key = `${schema}:claims7`;
    const mk = () => createDeadLetter({ file: join(mkdtempSync(join(DIR, "r-")), "j.ndjson"), journalKey: key });
    const X = mk(), Y = mk();
    for (let i = 0; i < 10; i++) X.add("item", { n: i });
    await flushJournals();
    const committed = new Map();
    let failAt = 4;
    const apply = async (e) => {
      if (e.payload.n === failAt) { failAt = -1; throw new Error("database away"); }
      committed.set(e.payload.n, (committed.get(e.payload.n) || 0) + 1);
      return "landed";
    };
    let threw = false;
    try { await Y.drain(apply); } catch { threw = true; }
    ok(threw && committed.size === 4 && await rd.hLen(`a402:journal:{${key}}:items`) === 6, `a pass stopped by a failure removes only what committed (${committed.size} committed, ${await rd.hLen(`a402:journal:{${key}}:items`)} left)`);
    await Y.drain(apply);
    const twice = [...committed].filter(([, c]) => c > 1).length;
    ok(committed.size === 10 && twice === 0, `the next pass lands the rest, the failed one included, each once (${committed.size}, twice ${twice})`);
  }

  // ---- outbound spend -------------------------------------------------------------
  // Each call writes one line (with its own ref) through to the file; the refs come back from it.
  const fileRefs = () => (existsSync(OB_FILE) ? readFileSync(OB_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).ref) : []);
  const pay = (k, i) => ob.recordOutbound({ chain: "base", payTo: "0x" + "b".repeat(40), amountAtomic: "1000", asset: "USDC", usd: 0.001, slug: `ob${k}-${i}`, origin: "https://seller.test/x", result: "delivered", tx: null });
  const record = (k, count) => { const before = fileRefs().length; for (let i = 0; i < count; i++) pay(k, i); return fileRefs().slice(before); };
  const rowsOfRef = (ref) => n(`SELECT count(*) AS n FROM ${schema}.log_lines WHERE stream = 'outbound-spend' AND body->>'ref' = $1`, [ref]);
  const eachOnce = async (refs) => (await Promise.all(refs.map(rowsOfRef))).every((c) => c === 1);
  const obState = () => ledgerDeadLetterStatus({ full: true }).outbound;
  const until = async (pred, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (await pred()) return true; return pred(); };
  // True once a journal entry this process adds lands in Redis (its client reconnected after a cut).
  const probe = createDeadLetter({ file: join(mkdtempSync(join(DIR, "probe-")), "j.ndjson"), journalKey: `${schema}:probe` });
  const redisBack = () => until(async () => { const { id, where } = await probe.addAsync("probe", {}); if (where === "redis") await probe.remove(id); return where === "redis"; });

  // ---- 10. outbound, Postgres down: Redis; back: reconcile + replay add once ----
  {
    pgRelay.cut();
    const refs = record(10, 3);
    ok(refs.length === 3 && new Set(refs).size === 3, "three outbound payments, each line with its own ref");
    // The inserts fail against the cut database and release their entries to the replay.
    ok(await until(() => obState().waiting === 3), `the lines wait in the journal once their inserts fail (${obState().waiting})`);
    await flushJournals();
    const st = ledgerDeadLetterStatus({ full: true });
    ok(await hlen("outbound") === 3 && st.outbound.onLocalDisk === 0 && st.status === "pending", `they are in Redis, none on local disk; the word reads ${st.status} (${await hlen("outbound")})`);
    ok(await ob.replayOutboundJournal() === 0 && await hlen("outbound") === 3, "a replay against a database still away keeps them");
    pgRelay.heal();
    // A restart with the volume: the boot reconcile restores the file's lines first.
    const restored = await sdb.reconcileLogFile(ob.OUTBOUND_STREAM, OB_FILE, { log: () => {} });
    ok(restored === 3 && await eachOnce(refs), `the boot reconcile adds the file's lines (${restored})`);
    const landed = await ob.replayOutboundJournal();
    ok(landed === 3 && await eachOnce(refs) && await hlen("outbound") === 0, `the replay then adds nothing twice and empties the journal (landed ${landed}, Redis ${await hlen("outbound")})`);
    ok(ledgerDeadLetterStatus().status === "none", "...the word reads none");
    ok(await sdb.reconcileLogFile(ob.OUTBOUND_STREAM, OB_FILE, { log: () => {} }) === 0 && await ob.replayOutboundJournal() === 0 && await eachOnce(refs), "a second reconcile and replay add nothing");
    // Without a volume there is no file to reconcile: the replay alone lands them.
    pgRelay.cut();
    const refs2 = record(10.5, 2);
    ok(await until(() => obState().waiting === 2), "two more wait in the journal");
    pgRelay.heal();
    ok(await ob.replayOutboundJournal() === 2 && await eachOnce(refs2) && await hlen("outbound") === 0, "with no file reconcile, the replay alone adds each once");
    // Healthy: the write lands at once and leaves nothing behind.
    const refs3 = record(10.7, 2);
    ok(await until(async () => (await eachOnce(refs3)) && obState().onDisk === 0) && await hlen("outbound") === 0, "with the database up a line lands at once and its entry is removed");
    // Two identical payments in one tick (same everything, no tx): two lines, not one.
    const twin = () => ob.recordOutbound({ chain: "base", payTo: "0x" + "c".repeat(40), amountAtomic: "1000", asset: "USDC", usd: 0.001, slug: "ob10-twin", origin: "https://seller.test/x", result: "undelivered", tx: null });
    twin(); twin();
    const twins = () => n(`SELECT count(*) AS n FROM ${schema}.log_lines WHERE stream = 'outbound-spend' AND body->>'slug' = 'ob10-twin'`);
    ok(await until(async () => (await twins()) === 2) && await twins() === 2, "two identical payments in one tick are two lines (each has its own ref)");
  }

  // ---- 11. outbound, Redis down too: local disk, the word "local" --------------
  {
    pgRelay.cut(); redisRelay.cut();
    const refs = record(11, 2);
    ok(await until(() => obState().waiting === 2), `the lines wait once their inserts fail (${obState().waiting})`);
    await flushJournals();
    const st = ledgerDeadLetterStatus({ full: true });
    ok(st.status === "local" && st.outbound.onLocalDisk === 2, `with Redis away the lines are on local disk and the word reads ${st.status} (${st.outbound.onLocalDisk})`);
    ok(existsSync(`${OB_FILE}.pending.ndjson`), "...in the journal file beside the ledger file");
    pgRelay.heal(); // Redis still away
    ok(await ob.replayOutboundJournal() === 2 && await eachOnce(refs), "Postgres back (Redis still away): the replay lands them from disk, once");
    ok(ledgerDeadLetterStatus().status === "none", "...and the word reads none");
    redisRelay.heal();
    // Past the outbound journal's own down window (a failed command sends its adds to disk for LEDGER_JOURNAL_REDIS_DOWN_MS).
    await wait(Number(process.env.LEDGER_JOURNAL_REDIS_DOWN_MS) + 100);
    ok(await redisBack(), "Redis back: a new journal entry reaches Redis again");
    await ob.replayOutboundJournal();
    ok(await eachOnce(refs) && await hlen("outbound") === 0, "Redis back: nothing added twice");
  }

  // ---- 12. outbound, two replayers ----------------------------------------------
  {
    const DRAIN = `a402:journal:{${schema}:outbound}:drain`;
    // (a) A replayer that inserted every line and died before removing any
    // entry: the other replayer applies them all again, and adds nothing.
    pgRelay.cut();
    const refs = record(12, 30);
    ok(await until(() => obState().waiting === 30, 15000), `thirty lines wait in Redis (${obState().waiting})`);
    await flushJournals();
    pgRelay.heal();
    const died = await child(["outbound-apply-die"]);
    ok(died.applied === 30 && died.sig === "SIGKILL" && await eachOnce(refs) && await hlen("outbound") === 30, `a replayer inserted all ${died.applied} lines and was killed before removing them (journal ${await hlen("outbound")})`);
    ok(await ob.replayOutboundJournal() === 0, "inside its lease the other replayer takes none of them");
    await wait(Number(process.env.LEDGER_JOURNAL_LEASE_MS) + 300);
    const again = await ob.replayOutboundJournal();
    ok(again === 30 && await eachOnce(refs) && await hlen("outbound") === 0, `once the lease lapses it applies all ${again} again: every line still once, the journal empty`);

    // (b) Two live replayers: B claims first, A drains alongside; one more
    // entry's line already reached the stream (its removal was lost).
    pgRelay.cut();
    const refs2 = record(12.5, 20);
    ok(await until(() => obState().waiting === 20, 15000), `twenty more wait in Redis (${obState().waiting})`);
    const done = { at: new Date().toISOString(), chain: "base", payTo: null, amountAtomic: "1", asset: null, usd: 0.000001, slug: "ob12-landed", origin: null, result: "delivered", tx: null, ref: randomBytes(9).toString("hex") };
    await pgDirect(`INSERT INTO ${schema}.log_lines (stream, body, line_key) VALUES ('outbound-spend', $1::jsonb, $2)`, [JSON.stringify(done), sdb.logLineKey(done)]);
    const side = createDeadLetter({ file: join(mkdtempSync(join(DIR, "ob-")), "j.ndjson"), journalKey: `${schema}:outbound` });
    side.add("outbound", done);
    await flushJournals();
    ok(await hlen("outbound") === 21, `the journal holds 21 entries (${await hlen("outbound")})`);
    pgRelay.heal();
    let bDone = false;
    const bP = child(["outbound-b"]).finally(() => { bDone = true; });
    await until(async () => bDone || Boolean(await rd.get(DRAIN)), 15000);
    let aLanded = 0;
    for (let i = 0; i < 40; i++) { aLanded += await ob.replayOutboundJournal(); await wait(15); }
    const b = await bP;
    ok(b.landed > 0 && aLanded + b.landed === 21, `A and B together land each entry once (A ${aLanded}, B ${b.landed})`);
    ok(await eachOnce([...refs2, done.ref]) && await hlen("outbound") === 0, "every line is in the stream exactly once, the already-landed one included, and the journal is empty");
  }

  // ---- card checkout -------------------------------------------------------------
  const rowOf = async (id) => (await pgDirect(`SELECT body FROM ${schema}.records WHERE collection = 'human-checkout' AND id = $1`, [id])).rows[0]?.body ?? null;
  // The claim made 11 minutes ago, no heartbeat ever written.
  const ageClaim = (id, takeovers) => pgDirect(
    `UPDATE ${schema}.records SET body = (body - 'beatAt' - 'generatedAt') || jsonb_build_object('claimedAt', $2::bigint, 'takeovers', $3::int) WHERE collection = 'human-checkout' AND id = $1`,
    [id, Date.now() - 11 * 60_000, takeovers]);
  const A = { gens: 0, refunds: [], sales: [], cutRedis: false };
  A.hc = createHumanCheckout({ stripe: stripeOf(A.refunds), baseUrl: "https://example.test", storeDir: mkdtempSync(join(tmpdir(), "jr-hc-A-")), log: () => {}, onSale: (s) => A.sales.push(s.sessionId),
    generate: async () => { A.gens++; pgRelay.cut(); if (A.cutRedis) redisRelay.cut(); return { report: "# A", title: "t", sources: [], tables: [] }; } });
  await A.hc.ready();
  const settleA = async (id) => { for (let i = 0; i < 40; i++) { const p = await A.hc.peek(id).catch(() => null); if (p && p.status !== "generating") return p; await wait(50); } return A.hc.peek(id).catch(() => null); };
  const healA = () => { pgRelay.heal(); redisRelay.heal(); };
  const landedRow = async (id, pred) => { for (let i = 0; i < 60; i++) { const r = await rowOf(id); if (pred(r)) return r; await wait(100); } return rowOf(id); };

  // ---- 8. Redis up, A cut from Postgres past the window: B books A's record ----
  for (const takeovers of [0, 1]) {
    const id = `cs_jr8${takeovers}_${randomBytes(3).toString("hex")}`;
    A.sales.length = 0; A.cutRedis = false;
    await A.hc.fulfill(id);
    const served = await settleA(id);
    ok(served?.status === "done" && served.report === "# A" && A.sales.length === 1 && await hlen("checkoutFinals") >= 1, `Redis up, takeovers=${takeovers}: A's record is in Redis, so A answers the report (${served?.status}) and delivers it once (sales ${A.sales.length})`);
    await ageClaim(id, takeovers);
    const b = await child(["hc-b", id], { JR_HOLD_DRAIN: "1" });
    const row = await rowOf(id);
    ok(b.gens === 0 && b.refunds === 0 && b.sales === 0 && b.status === "done" && b.report === "# A", `Redis up, takeovers=${takeovers}: B finds A's record in the journal and books it: no regeneration, no refund, no second sale (B generations ${b.gens}, refunds ${b.refunds}, sales ${b.sales}, answers ${b.status} "${b.report}")`);
    ok(row?.status === "done" && row.report === "# A" && !row.refundId, `Redis up, takeovers=${takeovers}: the row holds A's report (${row?.status})`);
    await rd.del(`a402:journal:{${schema}:checkoutFinals}:drain`); // the stand-in drain holder lets go
    healA();
    for (let i = 0; i < 40 && await hlen("checkoutFinals"); i++) await wait(100);
    const after = await rowOf(id);
    ok(await hlen("checkoutFinals") === 0 && after?.report === "# A" && A.sales.length === 1 && A.refunds.length === 0, `Redis up, takeovers=${takeovers}: A's own replay afterwards books nothing new and delivers nothing twice (sales ${A.sales.length}, journal ${await hlen("checkoutFinals")})`);
  }

  // ---- 9. both stores down for A: B's takeover is the one outcome ----------
  for (const takeovers of [0, 1]) {
    const id = `cs_jr9${takeovers}_${randomBytes(3).toString("hex")}`;
    A.sales.length = 0; A.refunds.length = 0; A.cutRedis = true;
    await A.hc.fulfill(id);
    await settleA(id);
    const answered = await A.hc.fulfill(id).catch(() => ({ status: "threw" }));
    const peeked = await A.hc.peek(id).catch(() => null);
    const st = ledgerDeadLetterStatus({ full: true });
    ok(answered?.status === "generating" && peeked?.status === "generating" && A.sales.length === 0 && st.checkoutFinals.onLocalDisk >= 1 && st.status === "local", `both down, takeovers=${takeovers}: A's record is on its disk only, so A answers ${answered?.status} (never the report), delivers nothing (sales ${A.sales.length}); the word reads ${st.status}`);
    await ageClaim(id, takeovers);
    // B's regeneration is slow, so A's replay runs while B's claim is live.
    const bP = child(["hc-b", id], { JR_GEN_DELAY_MS: takeovers === 0 ? "2500" : "0" });
    const before = await rowOf(id);
    const taken = await landedRow(id, (r) => r && r.claimId && r.claimId !== before?.claimId);
    healA();
    for (let i = 0; i < 30 && ledgerDeadLetterStatus({ full: true }).checkoutFinals.onLocalDisk; i++) await wait(100);
    const whileB = await rowOf(id);
    ok(taken?.claimId !== before?.claimId && ledgerDeadLetterStatus({ full: true }).checkoutFinals.onLocalDisk === 0 && whileB?.report !== "# A", `both down, takeovers=${takeovers}: A's late replay, under a claim B has taken over, books nothing (row ${whileB?.status}${whileB?.report ? ` "${whileB.report}"` : ""})`);
    const b = await bP;
    const row = await landedRow(id, (r) => r && r.status !== "generating");
    if (takeovers === 0) ok(b.gens === 1 && b.refunds === 0 && row?.status === "done" && row.report === "# B", `both down, takeovers=0: B regenerates, the one outcome (B generations ${b.gens}, refunds ${b.refunds}, row ${row?.status} "${row?.report}")`);
    else ok(b.gens === 0 && b.refunds === 1 && row?.status === "error" && row.refundId, `both down, takeovers=1: B refunds, the one outcome (B refunds ${b.refunds}, row ${row?.status} refundId ${row?.refundId})`);
    const aNow = await A.hc.fulfill(id);
    ok(A.sales.length === 0 && A.refunds.length === 0 && aNow?.status === row?.status && (aNow?.report ?? null) === (row?.report ?? null), `both down, takeovers=${takeovers}: A delivers nothing and now answers B's outcome (${aNow?.status})`);
  }
} catch (e) {
  fail++;
  console.error(`FAIL - threw: ${e?.stack || e}`);
} finally {
  await rd.quit().catch(() => {});
  try { await rc?.quit(); } catch { /* gone */ }
  await sdb.closeStateDb().catch(() => {});
  await pgRelay.close(); await redisRelay.close();
}
console.log(`\ntest-ledger-journal-redis-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
