// Repeat sales moved out of the state database stay out after a restart.
// The server keeps a ledger file beside the tables, and every boot inserts
// the file's sales the tables lack (src/sales-ledger.js reconcileFile): a
// row moved to sales_repeats is still in that file, so the boot used to put
// it back with a new id. Both ways of applying the correction are read here
// against a REAL Postgres (STATE_DATABASE_URL; CI fails without it):
//   - the operator route (POST /__operator/sale-repeats/apply), then a
//     restart: the settlement keeps one sale, the dry run finds nothing, a
//     second apply moves 0 and sales_repeats holds each moved row once;
//   - scripts/sale-repeats.js --pg --apply, then a restart: the same.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-sale-repeats-restart.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pg from "pg";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const url = String(process.env.STATE_DATABASE_URL || "").trim();
if (!url) {
  const msg = "test-sale-repeats-restart: no STATE_DATABASE_URL";
  if (process.env.CI) { console.error(`FAIL - ${msg} (required under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`); process.exit(0);
}
const TOKEN = "sale-repeats-restart-token-0123456789abcdef";
const PAYER = "So1PayerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const dir = mkdtempSync(join(tmpdir(), "a402-repeats-restart-"));
const schema = `rr_${Date.now().toString(36)}`;
const client = new pg.Client({ connectionString: url });
await client.connect();
const S = (t) => `"${schema}".${t}`;

async function run(label, apply) {
  const mirror = join(dir, `${label}.db`);
  const env = { FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: TOKEN, STATE_DATABASE_URL: url, STATE_DB_SCHEMA: schema, SALES_LEDGER_DB: mirror, REDIS_URL: "", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MONITOR_SCHEDULER: "off", REVENUE_LEDGER: "off", TWEET_QUEUE: "", LATE_SETTLE_RECONCILE: "off" };
  const boot = () => bootServer({ stores: `repeats-restart-${label}`, env });
  const call = async (srv, method, path, body) => { const r = await fetch(srv.url + path, { method, headers: { "x-operator-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const SIG = `sig${label}${"z".repeat(70)}`;
  const count = async () => Number((await client.query(`SELECT COUNT(*) AS n FROM ${S("sales")} WHERE tx = $1`, [SIG])).rows[0].n);
  const moved = async () => Number((await client.query(`SELECT COUNT(*) AS n FROM ${S("sales_repeats")} WHERE tx = $1`, [SIG])).rows[0].n);
  let srv = await boot(); await srv.stop();
  // The same settlement booked twice, in the tables and (write-through) in the file.
  const t0 = Date.now(), rows = [];
  for (const ts of [t0, t0 + 1500]) rows.push({ id: Number((await client.query(`INSERT INTO ${S("sales")} (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES ($1, 'web-search', 0.02, 'usdc', 'solana', $2, $3, 0, 'x402') RETURNING id`, [ts, PAYER, SIG])).rows[0].id), ts });
  const f = new Database(mirror);
  for (const r of rows) f.prepare("INSERT INTO sales (id, ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?, ?, 'web-search', 0.02, 'usdc', 'solana', ?, ?, 0, 'x402')").run(r.id, r.ts, PAYER, SIG);
  f.close();
  srv = await boot();
  try {
    const dry = await call(srv, "GET", "/__operator/sale-repeats.json");
    ok(dry.status === 200 && dry.json?.rows === 1, `${label}: the dry run finds the repeat row (${dry.json?.rows})`);
    await apply(srv, call, dry.json?.rows);
    ok(await count() === 1 && await moved() === 1, `${label}: apply leaves one sale and moves one row`);
  } finally { await srv.stop(); }
  srv = await boot();
  try {
    ok(await count() === 1, `${label}: after a restart the settlement still has one sale (${await count()})`);
    const dry2 = await call(srv, "GET", "/__operator/sale-repeats.json");
    ok(dry2.json?.rows === 0, `${label}: after a restart the dry run finds no repeat (${dry2.json?.rows})`);
    const again = await call(srv, "POST", "/__operator/sale-repeats/apply", { expect: 0 });
    ok(again.status === 200 && again.json?.moved === 0 && await moved() === 1, `${label}: a second apply moves 0 and sales_repeats holds the row once (${again.json?.moved}, ${await moved()})`);
  } finally { await srv.stop(); }
}

try {
  await run("route", async (srv, call, rows) => {
    const ap = await call(srv, "POST", "/__operator/sale-repeats/apply", { expect: rows });
    ok(ap.status === 200 && ap.json?.moved === 1 && /stay out/.test(ap.json?.note || ""), `route: apply moves the row and says it stays out after a restart (${ap.json?.note})`);
  });
  await run("script", async (_srv, _call, rows) => {
    const r = spawnSync(process.execPath, ["scripts/sale-repeats.js", "--pg", "--apply", "--expect", String(rows)], { env: { ...process.env, STATE_DATABASE_URL: url, STATE_DB_SCHEMA: schema }, encoding: "utf8" });
    ok(r.status === 0 && /moved 1 row/.test(r.stdout), `script: --pg --apply moves the row (${r.status})`);
  });
} finally {
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
  await client.end();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
