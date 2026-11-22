#!/usr/bin/env node
// Sales rows that repeat a settlement: list them, and (only when told) move
// them off the sales table.
//
//   node scripts/sale-repeats.js --db <agent402-sales.db>            DRY RUN on a ledger file
//   STATE_DATABASE_URL=... node scripts/sale-repeats.js --pg         DRY RUN on the state database
//   ... --json <file>      also write every repeat row (ids, never amounts per payer) to a file
//   ... --apply --expect <rows>   the correction; refuses unless <rows> is the count the dry run printed
//
// THE RULE (src/sale-repeats.js): a Solana settlement signature stands behind
// one sale. A row that names a signature an earlier row already holds is a
// repeat of that sale. The ledger's writer no longer writes one, and every
// reader that counts or sums sales already leaves the stored ones out, so the
// figures are right with no correction at all.
//
// THE CORRECTION (--apply) is for the stored rows: each repeat row is copied
// to `sales_repeats` (same columns, plus when it was moved) and removed from
// `sales`, in one transaction, so a reader outside this codebase (an export,
// a backup, a SQL client) counts the settlement once too. A repeat row that
// carries an attestation, or that a feedback row names, is HELD BACK: a
// buyer can reach it. A running server keeps the rows in its own copy until
// its next restart; its readers leave them out either way.
//
// The read and the correction are src/sale-repeats-correction.js, the same
// code the operator routes run (/__operator/sale-repeats.json and
// /__operator/sale-repeats/apply).
//
// The default is a dry run: it opens the file read-only (or reads the
// database in a read-only transaction) and changes nothing. It prints counts
// and dates, never a payer.
import { writeFileSync } from "node:fs";
import { correctFile, correctPgInTx } from "../src/sale-repeats-correction.js";

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const APPLY = has("--apply");
const usage = () => { console.error("usage: node scripts/sale-repeats.js (--db <file> | --pg) [--json <file>] [--apply --expect <rows>]"); process.exit(2); };
if (has("--db") === has("--pg")) usage();
const expect = opt("--expect") == null ? null : Number(opt("--expect"));
if (APPLY && !Number.isInteger(expect)) { console.error("--apply needs --expect <rows>: the repeat-row count the dry run printed"); process.exit(2); }

const usd = (n) => `$${(Number(n) || 0).toFixed(6)}`;

function print(plan, where) {
  const lines = [];
  lines.push(`${APPLY ? "APPLY" : "DRY RUN (nothing is changed)"}: ${where}`);
  lines.push(`settlements booked more than once: ${plan.settlements.size}`);
  lines.push(`repeat rows: ${plan.rows} (${plan.external} external, ${plan.internal} our own), ${plan.firstDay || "none"} to ${plan.lastDay || "none"}`);
  lines.push(`booked in the repeat rows: ${usd(plan.usd)} (${usd(plan.externalUsd)} external)`);
  lines.push(`repeat rows under another tool than the first row: ${plan.otherSlug}; under another payer: ${plan.otherPayer}`);
  lines.push(`held back (an attestation or a feedback row names the row): ${plan.heldBack} (attestation ${plan.heldAttested}, feedback ${plan.heldFeedback})`);
  lines.push(`a correction would move ${plan.move.length} row(s) from sales to sales_repeats and leave ${plan.settlements.size} settlement(s) with one sale each${plan.heldBack ? ` (${plan.heldBack} held back stay)` : ""}`);
  if (plan.byDay.length) lines.push(`by day: ${plan.byDay.map(([d, n]) => `${d} ${n}`).join(", ")}`);
  if (plan.bySlug.length) lines.push(`by tool: ${plan.bySlug.slice(0, 15).map(([s, n]) => `${s} ${n}`).join(", ")}${plan.bySlug.length > 15 ? `, and ${plan.bySlug.length - 15} more` : ""}`);
  for (const l of lines) console.log(l);
}

function finish(plan) {
  const out = opt("--json");
  if (out) { writeFileSync(out, JSON.stringify({ settlements: plan.settlements.size, rows: plan.rows, move: plan.move.length, heldBack: plan.heldBack, list: plan.list }, null, 1)); console.log(`wrote ${plan.list.length} row(s) to ${out}`); }
}

function refused(plan) {
  console.error(`refused: --expect ${expect} but the store holds ${plan.rows} repeat row(s); run the dry run again and read it`);
  process.exit(3);
}

async function runFile(path) {
  const r = await correctFile(path, { apply: APPLY, expect });
  print(r.plan, `ledger file ${path}`);
  finish(r.plan);
  if (r.refused) refused(r.plan);
  if (r.applied) console.log(`moved ${r.moved} row(s) to sales_repeats`);
}

async function runPg() {
  const { default: pg } = await import("pg");
  const { stateDbUrl, stateDbSchema, SCHEMA_LOCK_KEY } = await import("../src/state-db.js");
  const url = stateDbUrl();
  if (!url) { console.error("--pg needs STATE_DATABASE_URL"); process.exit(2); }
  const schema = stateDbSchema();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let r;
  try {
    await client.query("BEGIN");
    r = await correctPgInTx(client, { schema, apply: APPLY, expect, schemaLockKey: SCHEMA_LOCK_KEY });
    await client.query(r.applied ? "COMMIT" : "ROLLBACK");
  } catch (e) { try { await client.query("ROLLBACK"); } catch { /* closed */ } throw e; }
  finally { await client.end(); }
  print(r.plan, `state database, schema ${schema}`);
  finish(r.plan);
  if (r.refused) refused(r.plan);
  if (r.applied) console.log(`moved ${r.moved} row(s) to ${schema}.sales_repeats; a running server drops them from its own copy at its next restart`);
}

if (has("--db")) { const p = opt("--db"); if (!p) usage(); await runFile(p); }
else await runPg();
