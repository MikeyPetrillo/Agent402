// scripts/state-ledger-checksum.js: the money ledgers compared row for row,
// file against state table, after the stores import a volume-shaped fixture.
// Every ledger must come out EQUAL; then negative controls: a price moved by
// 1e-9, a refund's status changed, a credit balance changed and a log line
// dropped must each be reported. JSON documents (the subscription engines'
// state) are compared whole: a nested value changed in a row that keeps the
// same top-level keys must be reported too. Requires STATE_DATABASE_URL (CI
// fails without it).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema: S } = requireTestPg({ label: "test-state-ledger-checksum-pg" });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "state-checksum-"));
const data = join(DIR, "data");
const fileEnv = { ...process.env }; delete fileEnv.STATE_DATABASE_URL; delete fileEnv.STATE_DB_SCHEMA;
const run = (args, env = { ...process.env, STATE_DB_SCHEMA: S }) => spawnSync(process.execPath, args, { env, encoding: "utf8" });
const checksum = () => { const r = run(["scripts/state-ledger-checksum.js", "--data", data, "--json"]); let j = []; try { j = JSON.parse(r.stdout); } catch { /* reported below */ } return { status: r.status, results: j, stderr: r.stderr }; };
const c = new pg.Client({ connectionString: url });
try {
  ok(run(["scripts/lib/state-fixture.mjs", "seed", data], fileEnv).status === 0, "fixture written in file mode");
  ok(run(["scripts/lib/state-stores.mjs", "boot", data]).status === 0, "the stores import the fixture");
  await c.connect();
  // Two JSON documents on the volume and their imported rows, plus one the
  // boot has not imported yet (its feature never ran).
  const mpp = { subs: { s_1: { payer: "0xabc", plan: { amount: "1000000", interval: "month" }, nextAt: 1_760_000_000_000, active: true } }, version: 2 };
  const stripe = { customers: { cus_1: { subscription: "sub_1", status: "active", items: [{ price: "p_1", quantity: 1 }] } } };
  writeFileSync(join(data, "mpp-subscriptions.json"), JSON.stringify(mpp));
  writeFileSync(join(data, "stripe-subscriptions.json"), JSON.stringify(stripe));
  writeFileSync(join(data, "not-imported-yet.json"), JSON.stringify({ a: 1 }));
  // Key order differs from the file's: the comparison is canonical.
  await c.query(`INSERT INTO ${S}.documents (name, body) VALUES ($1, $2::jsonb), ($3, $4::jsonb) ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body`,
    ["mpp-subscriptions.json", JSON.stringify({ version: 2, subs: mpp.subs }), "stripe-subscriptions.json", JSON.stringify(stripe)]);

  const clean = checksum();
  const names = clean.results.map((r) => r.name);
  ok(clean.status === 0 && clean.results.length >= 15 && clean.results.every((r) => r.equal), `every ledger is EQUAL after the import (${clean.results.filter((r) => !r.equal).map((r) => r.name).join(", ") || names.length + " compared"})`);
  for (const n of ["sales.sales", "sales.sale_feedback", "refunds.refunds", "decide.credits", "decide.runs", "revenue.transfers", "shadow.shadow", "credits records", "outbound-spend.ndjson log"]) ok(names.includes(n), `${n} is compared`);
  ok(names.includes("mpp-subscriptions.json document") && names.includes("stripe-subscriptions.json document"), "the subscription documents are compared");
  ok(clean.results.find((r) => r.name === "not-imported-yet.json document")?.skipped === true, "a document with no row yet is SKIP, not EQUAL by accident");
  ok(clean.results.find((r) => r.name === "sales.sales")?.rowsFile === 600 && clean.results.find((r) => r.name === "refunds.refunds")?.rowsTable === 260, "row counts are the fixture's");

  const control = async (label, ledger, change, undo) => {
    await c.query(change);
    const r = checksum();
    await c.query(undo);
    const hit = r.results.find((x) => x.name === ledger);
    ok(r.status === 1 && hit && !hit.equal && r.results.filter((x) => !x.equal).length === 1, `negative control: ${label} is reported on ${ledger} only`);
  };
  const saleId = (await c.query(`SELECT min(id) AS id FROM ${S}.sales`)).rows[0].id;
  await control("a price moved by 1e-9", "sales.sales", `UPDATE ${S}.sales SET price_usd = price_usd + 1e-9 WHERE id = ${saleId}`, `UPDATE ${S}.sales SET price_usd = price_usd - 1e-9 WHERE id = ${saleId}`);
  const paid = (await c.query(`SELECT min(id) AS id FROM ${S}.refunds WHERE status = 'paid'`)).rows[0].id;
  await control("a paid refund read as owed", "refunds.refunds", `UPDATE ${S}.refunds SET status = 'owed' WHERE id = ${paid}`, `UPDATE ${S}.refunds SET status = 'paid' WHERE id = ${paid}`);
  const credit = (await c.query(`SELECT id FROM ${S}.records WHERE collection = 'credits' AND id LIKE 'k\\_%' ORDER BY id LIMIT 1`)).rows[0].id;
  await control("a credit balance one micro-dollar off", "credits records", `UPDATE ${S}.records SET body = jsonb_set(body, '{balanceMicro}', to_jsonb((body->>'balanceMicro')::bigint + 1)) WHERE collection = 'credits' AND id = '${credit}'`, `UPDATE ${S}.records SET body = jsonb_set(body, '{balanceMicro}', to_jsonb((body->>'balanceMicro')::bigint - 1)) WHERE collection = 'credits' AND id = '${credit}'`);
  const line = (await c.query(`SELECT id, body FROM ${S}.log_lines WHERE stream = 'outbound-spend' ORDER BY id LIMIT 1`)).rows[0];
  await control("a dropped log line", "outbound-spend.ndjson log", `DELETE FROM ${S}.log_lines WHERE id = ${line.id}`, `INSERT INTO ${S}.log_lines (id, stream, body) VALUES (${line.id}, 'outbound-spend', '${JSON.stringify(line.body)}'::jsonb)`);
  await control("a nested subscription amount changed (top-level keys unchanged)", "mpp-subscriptions.json document",
    `UPDATE ${S}.documents SET body = jsonb_set(body, '{subs,s_1,plan,amount}', '"1000001"') WHERE name = 'mpp-subscriptions.json'`,
    `UPDATE ${S}.documents SET body = jsonb_set(body, '{subs,s_1,plan,amount}', '"1000000"') WHERE name = 'mpp-subscriptions.json'`);
  await control("a subscription status changed", "stripe-subscriptions.json document",
    `UPDATE ${S}.documents SET body = jsonb_set(body, '{customers,cus_1,status}', '"canceled"') WHERE name = 'stripe-subscriptions.json'`,
    `UPDATE ${S}.documents SET body = jsonb_set(body, '{customers,cus_1,status}', '"active"') WHERE name = 'stripe-subscriptions.json'`);
  ok(checksum().status === 0, "every control undone: EQUAL again");
} finally {
  await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch(() => {});
  await c.end().catch(() => {});
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
