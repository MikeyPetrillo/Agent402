// The operator routes for stored repeat sales (src/sale-repeats-correction.js,
// the code scripts/sale-repeats.js runs), against a booted server on each of
// its ledger backends: a ledger file, and a REAL Postgres (STATE_DATABASE_URL;
// CI fails without it).
//
//   GET  /__operator/sale-repeats.json       the dry run: counts, dates, tools,
//                                            held-back reasons; no payer, no settlement id
//   POST /__operator/sale-repeats/apply      {"expect": <rows>}: the correction
//
// Each backend is seeded with four repeat rows over three settlements: two
// plain ones, one an attestation names and one a feedback row names. The
// routes refuse a caller without the token (404); the dry run changes
// nothing; apply refuses a body without an integer and an expect other than
// the count (nothing changes); apply with the count moves exactly the two
// plain rows to sales_repeats and holds back the other two; a second apply
// moves nothing. On Postgres, apply refuses while another replica holds the
// correction's lease, and two applies sent at once move the rows once.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-sale-repeats-routes.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { bootServer } from "./lib/boot-server.js";

const SELF = fileURLToPath(import.meta.url);
const TOKEN = "sale-repeats-routes-token-0123456789abcdef";
const SOL_A = "So1PayerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SOL_B = "So1PayerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SIG = (n) => `sig${String(n).padStart(3, "0")}${"y".repeat(60)}`;
// Repeat rows per settlement: SIG(1) twice (plain), SIG(2) once (attested), SIG(3) once (feedback names it).
const REPEATS = [[SIG(1), 2], [SIG(2), 1], [SIG(3), 1]];

// ---- child: a ledger file through the writer --------------------------------------
if (process.argv[2] === "seed") {
  const L = await import("../src/sales-ledger.js");
  const sale = (o) => L.recordSale({ priceUsd: 0.02, rail: "usdc", network: "solana", synthetic: false, slug: "web-search", ...o });
  sale({ payer: SOL_A, tx: SIG(1) });
  sale({ payer: SOL_A, tx: SIG(2) });
  sale({ payer: SOL_B, tx: SIG(3), slug: "hash", priceUsd: 0.001 });
  sale({ payer: SOL_B, tx: SIG(4) });
  sale({ payer: "0x00000000000000000000000000000000000000a1", tx: "0xevm", network: "base" });
  sale({ payer: "0x00000000000000000000000000000000000000a1", tx: "0xevm", network: "base" });
  await L.salesLedgerFlush?.();
  process.exit(0);
}

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const BOOT_ENV = {
  FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: TOKEN, TRUST_PROXY_HOPS: "1",
  REDIS_URL: "", TARGET_URL: "", CDN_PROXY: "",
  X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off", REVENUE_LEDGER: "off",
  TWEET_QUEUE: "", LATE_SETTLE_RECONCILE: "off",
};
const boot = (env, label) => bootServer({ stores: label, args: ["--import", "./scripts/lib/loopback-only-preload.js"], env: { ...BOOT_ENV, ...env } });

/** The routes, against one booted server; `count(sql)` reads the store directly. */
async function exercise(where, srv, count, { concurrent = false, otherReplica = null } = {}) {
  const call = async (method, path, { token = TOKEN, body } = {}) => {
    const headers = { ...(token ? { "x-operator-token": token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const r = await fetch(`${srv.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, text, json, cache: r.headers.get("cache-control") || "" };
  };
  const total = await count("SELECT COUNT(*) AS n FROM sales");
  const noToken = await call("GET", "/__operator/sale-repeats.json", { token: null });
  const noTokenApply = await call("POST", "/__operator/sale-repeats/apply", { token: null, body: { expect: 4 } });
  const wrongToken = await call("POST", "/__operator/sale-repeats/apply", { token: `${TOKEN}x`, body: { expect: 4 } });
  ok(noToken.status === 404 && noTokenApply.status === 404 && wrongToken.status === 404 && await count("SELECT COUNT(*) AS n FROM sales") === total, `${where}: without the token both routes answer 404 and nothing changes`);

  const dry = await call("GET", "/__operator/sale-repeats.json");
  const d = dry.json || {};
  ok(dry.status === 200 && d.dryRun === true && d.settlements === 3 && d.rows === 4 && d.move === 2 && d.heldBack === 2 && d.heldBackReasons?.attestation === 1 && d.heldBackReasons?.feedback === 1 && d.apply?.body?.expect === 4,
    `${where}: the dry run reads 4 repeat rows over 3 settlements, 2 to move and 2 held back (one attested, one named by feedback) (${dry.status} ${dry.text.slice(0, 300)})`);
  ok(d.firstDay && d.lastDay && Array.isArray(d.bySlug) && d.bySlug.length > 0 && /private/.test(dry.cache) && /no-store/.test(dry.cache), `${where}: it carries the date range and tools, and is private, no-store`);
  ok(![SOL_A, SOL_B, SIG(1), SIG(2), SIG(3)].some((v) => dry.text.includes(v)), `${where}: the dry run names no payer and no settlement id`);
  ok(await count("SELECT COUNT(*) AS n FROM sales") === total, `${where}: the dry run changes nothing`);

  const bad = await call("POST", "/__operator/sale-repeats/apply", { body: { expect: "4" } });
  const none = await call("POST", "/__operator/sale-repeats/apply", { body: {} });
  const wrong = await call("POST", "/__operator/sale-repeats/apply", { body: { expect: 3 } });
  ok(bad.status === 400 && none.status === 400 && wrong.status === 409 && wrong.json?.applied === false && wrong.json?.rows === 4 && await count("SELECT COUNT(*) AS n FROM sales") === total,
    `${where}: apply refuses a body without an integer (${bad.status}, ${none.status}) and another count than the dry run's (${wrong.status}); nothing changes`);

  if (otherReplica) {
    // Another replica holds the correction's lease: this one refuses and changes nothing.
    await otherReplica.take();
    const held = await call("POST", "/__operator/sale-repeats/apply", { body: { expect: 4 } });
    await otherReplica.drop();
    ok(held.status === 409 && held.json?.reason === "held" && await count("SELECT COUNT(*) AS n FROM sales") === total, `${where}: while another replica holds the lease, apply answers 409 and nothing changes (${held.status} ${held.text.slice(0, 120)})`);
  }

  let moved;
  if (concurrent) {
    const both = await Promise.all([1, 2].map(() => call("POST", "/__operator/sale-repeats/apply", { body: { expect: 4 } })));
    const won = both.filter((r) => r.status === 200 && r.json?.applied === true);
    ok(won.length === 1 && won[0].json.moved === 2 && both.filter((r) => r.status === 409).length === 1, `${where}: two applies sent at once move the rows once (${both.map((r) => `${r.status} ${r.json?.moved ?? r.json?.reason ?? r.json?.rows}`).join(", ")})`);
    moved = won[0]?.json;
  } else {
    const r = await call("POST", "/__operator/sale-repeats/apply", { body: { expect: 4 } });
    ok(r.status === 200 && r.json?.applied === true && r.json?.moved === 2, `${where}: apply with the dry run's count moves the two plain repeat rows (${r.status} ${r.text.slice(0, 200)})`);
    moved = r.json;
  }
  ok(moved && ![SOL_A, SOL_B, SIG(1)].some((v) => JSON.stringify(moved).includes(v)), `${where}: the apply answer names no payer and no settlement id`);
  ok(await count("SELECT COUNT(*) AS n FROM sales") === total - 2 && await count("SELECT COUNT(*) AS n FROM sales_repeats") === 2,
    `${where}: exactly two rows left sales and two are in sales_repeats`);
  ok(await count(`SELECT COUNT(*) AS n FROM sales WHERE tx = '${SIG(1)}'`) === 1 && await count(`SELECT COUNT(*) AS n FROM sales WHERE tx = '${SIG(2)}'`) === 2 && await count(`SELECT COUNT(*) AS n FROM sales WHERE tx = '${SIG(3)}'`) === 2 && await count(`SELECT COUNT(*) AS n FROM sales WHERE tx = '${SIG(4)}'`) === 1 && await count("SELECT COUNT(*) AS n FROM sales WHERE tx = '0xevm'") === 2,
    `${where}: each settlement keeps its first row, the attested and feedback-named repeats stay, and rows outside the rule are untouched`);

  const again = await call("GET", "/__operator/sale-repeats.json");
  const second = await call("POST", "/__operator/sale-repeats/apply", { body: { expect: again.json?.rows } });
  ok(again.json?.rows === 2 && again.json?.move === 0 && second.status === 200 && second.json?.moved === 0 && await count("SELECT COUNT(*) AS n FROM sales_repeats") === 2,
    `${where}: a second apply finds nothing to move (${again.json?.rows} held-back rows remain; moved ${second.json?.moved})`);
}

const dir = mkdtempSync(join(tmpdir(), "a402-repeat-routes-"));
const servers = [];
try {
  // ---- the ledger file ---------------------------------------------------------------
  {
    const file = join(dir, "sales.db");
    const seeded = spawnSync(process.execPath, [SELF, "seed"], { env: { ...process.env, SALES_LEDGER_DB: file, STATE_DATABASE_URL: "", REDIS_URL: "", LEDGER_JOURNAL_REDIS: "" }, encoding: "utf8" });
    if (seeded.status !== 0) throw new Error(`seed exited ${seeded.status}: ${seeded.stderr.slice(-400)}`);
    const db = new Database(file);
    const cols = "slug, price_usd, rail, network, payer, tx, internal, wire";
    const again = db.prepare(`INSERT INTO sales (ts, ${cols}) SELECT ts + ?, ${cols} FROM sales WHERE tx = ? ORDER BY id LIMIT 1`);
    for (const [sig, n] of REPEATS) for (let i = 1; i <= n; i++) again.run(i * 1500, sig);
    db.prepare("UPDATE sales SET attest_uid = '0xattested' WHERE id = (SELECT MAX(id) FROM sales WHERE tx = ?)").run(SIG(2));
    db.prepare("INSERT INTO sale_feedback (tx, sale_id, slug, payer, verdict, reason, ts) SELECT 'fb-tx', MAX(id), 'hash', ?, 'good', NULL, 1 FROM sales WHERE tx = ?").run(SOL_B, SIG(3));
    db.close();
    const srv = await boot({ SALES_LEDGER_DB: file, STATE_DATABASE_URL: "" }, "sale-repeats-routes-file");
    servers.push(srv);
    const read = new Database(file, { readonly: true });
    const count = async (sql) => { try { return read.prepare(sql).get().n; } catch { return -1; } };
    await exercise("ledger file", srv, count);
    read.close();
    await srv.stop();
  }

  // ---- the state database -----------------------------------------------------------
  const url = String(process.env.STATE_DATABASE_URL || "").trim();
  if (!url) {
    const msg = "test-sale-repeats-routes: no STATE_DATABASE_URL for the Postgres half";
    if (process.env.CI) { failed++; console.error(`FAIL - ${msg} (a missing database is a failure under CI)`); }
    else console.log(`SKIP - ${msg}`);
  } else {
    const { default: pg } = await import("pg");
    const schema = `t_${randomBytes(5).toString("hex")}`;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const srv = await boot({ STATE_DATABASE_URL: url, STATE_DB_SCHEMA: schema, SALES_LEDGER_DB: join(dir, "pg-mirror.db") }, "sale-repeats-routes-pg");
      servers.push(srv);
      // The server made the tables at boot; the rows are written the way the old writer left them.
      const S = (t) => `"${schema}".${t}`;
      for (let i = 0; i < 50 && !(await client.query("SELECT to_regclass($1) AS t", [`"${schema}".sale_feedback`])).rows[0].t; i++) await new Promise((r) => setTimeout(r, 200));
      const ins = (ts, slug, network, payer, tx, attest = null) => client.query(`INSERT INTO ${S("sales")} (ts, slug, price_usd, rail, network, payer, tx, internal, wire, attest_uid) VALUES ($1, $2, 0.02, 'usdc', $3, $4, $5, 0, 'x402', $6)`, [ts, slug, network, payer, tx, attest]);
      const t0 = Date.now() - 86_400_000;
      await ins(t0, "web-search", "solana", SOL_A, SIG(1));
      await ins(t0 + 1, "web-search", "solana", SOL_A, SIG(2));
      await ins(t0 + 2, "hash", "solana", SOL_B, SIG(3));
      await ins(t0 + 3, "web-search", "solana", SOL_B, SIG(4));
      await ins(t0 + 4, "web-search", "base", "0x00000000000000000000000000000000000000a1", "0xevm");
      await ins(t0 + 5, "web-search", "base", "0x00000000000000000000000000000000000000a1", "0xevm");
      await ins(t0 + 1500, "web-search", "solana", SOL_A, SIG(1));
      await ins(t0 + 3000, "hash", "solana", SOL_B, SIG(1));
      await ins(t0 + 1500, "web-search", "solana", SOL_A, SIG(2), "0xattested");
      await ins(t0 + 1500, "hash", "solana", SOL_B, SIG(3));
      await client.query(`INSERT INTO ${S("sale_feedback")} (tx, sale_id, slug, payer, verdict, ts) SELECT 'fb-tx', MAX(id), 'hash', $1, 'good', 1 FROM ${S("sales")} WHERE tx = $2`, [SOL_B, SIG(3)]);
      const count = async (sql) => {
        try { return Number((await client.query(sql.replace(/\bFROM (sales_repeats|sales)\b/, (_m, t) => `FROM ${S(t)}`))).rows[0].n); } catch { return -1; }
      };
      const otherReplica = {
        take: () => client.query(`INSERT INTO ${S("leases")} (name, owner, expires_at) VALUES ('sale-repeats-apply', 'another-replica', now() + interval '1 minute')`),
        drop: () => client.query(`DELETE FROM ${S("leases")} WHERE name = 'sale-repeats-apply' AND owner = 'another-replica'`),
      };
      await exercise("state database", srv, count, { concurrent: true, otherReplica });
      await srv.stop();
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await client.end().catch(() => {});
    }
  }
} catch (e) {
  failed++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  for (const s of servers) await s.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ntest-sale-repeats-routes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
