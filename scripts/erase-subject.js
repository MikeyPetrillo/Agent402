#!/usr/bin/env node
// Erase a person's data by email address across every store that can hold one.
//
//   node scripts/erase-subject.js <email> [--dry] [--data-root /data]
//
// The privacy policy promises deletion on request; before 2026-08-28 there was
// no script behind that promise (seven stores, each with its own shape). This
// walks all of them, prints what it found, and rewrites atomically (tmp +
// rename) unless --dry. Stripe's own customer record is not touched here: use
// the Stripe dashboard (customer deletion) for the card processor's copy.
//
// Stores:
//   free-alerts.json          alerts[*].email            -> record deleted
//   followups.json            seqs[*].email              -> record deleted
//   stripe-subscriptions.json (map of subId -> rec.email) -> email nulled, status kept (billing history)
//   mpp-subscriptions.json    (no email: wallet-keyed)    -> skipped
//   monitor-runs.json         (no email)                  -> skipped
//   human-checkout/<cs_*>.json (no email stored)          -> nothing to do
//   credits/<k_*>.json         (no email stored)          -> nothing to do
//   Postgres tollbooth_leads  email column                -> rows deleted (DATABASE_URL)
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const email = String(args.find((a) => !a.startsWith("--")) || "").trim().toLowerCase();
const dry = args.includes("--dry");
const rootIdx = args.indexOf("--data-root");
const ROOT = rootIdx >= 0 ? args[rootIdx + 1] : (existsSync("/data") ? "/data" : "/tmp");
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error("usage: node scripts/erase-subject.js <email> [--dry] [--data-root DIR]"); process.exit(2); }

const report = [];
function rewrite(path, obj) {
  if (dry) return;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, path);
}
function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }

// free alerts
{
  const p = join(ROOT, "free-alerts.json"); const j = readJson(p);
  if (j?.alerts) {
    const ids = Object.keys(j.alerts).filter((id) => String(j.alerts[id]?.email || "").toLowerCase() === email);
    for (const id of ids) delete j.alerts[id];
    if (ids.length) rewrite(p, j);
    report.push(`free-alerts.json: ${ids.length} record(s) deleted`);
  } else report.push("free-alerts.json: absent");
}
// follow-ups
{
  const p = join(ROOT, "followups.json"); const j = readJson(p);
  if (j?.seqs) {
    const ids = Object.keys(j.seqs).filter((id) => String(j.seqs[id]?.email || "").toLowerCase() === email);
    for (const id of ids) delete j.seqs[id];
    if (ids.length) rewrite(p, j);
    report.push(`followups.json: ${ids.length} sequence(s) deleted`);
  } else report.push("followups.json: absent");
}
// stripe subscriptions: keep the billing record, drop the address
{
  const p = join(ROOT, "stripe-subscriptions.json"); const j = readJson(p);
  if (j && typeof j === "object") {
    let n = 0;
    for (const rec of Object.values(j)) if (rec && typeof rec === "object" && String(rec.email || "").toLowerCase() === email) { rec.email = null; rec.erasedAt = new Date().toISOString(); n++; }
    if (n) rewrite(p, j);
    report.push(`stripe-subscriptions.json: ${n} record(s) had the address removed (subscription ids kept for billing history; cancel in Stripe if still active)`);
  } else report.push("stripe-subscriptions.json: absent");
}
report.push("human-checkout/: stores no email (nothing to do)");
report.push("credits/: stores no email (nothing to do)");

// Postgres leads
if (process.env.DATABASE_URL) {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: /railway\.internal|localhost/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: true } });
    await client.connect();
    const r = dry ? await client.query("SELECT count(*)::int AS n FROM tollbooth_leads WHERE lower(email) = $1", [email]) : await client.query("DELETE FROM tollbooth_leads WHERE lower(email) = $1", [email]);
    report.push(`tollbooth_leads: ${dry ? r.rows[0].n + " row(s) would be deleted" : r.rowCount + " row(s) deleted"}`);
    await client.end();
  } catch (e) { report.push(`tollbooth_leads: skipped (${String(e.message).slice(0, 80)})`); }
} else report.push("tollbooth_leads: DATABASE_URL unset, skipped");

console.log(`${dry ? "[dry run] " : ""}erase ${email} under ${ROOT}`);
for (const line of report) console.log(" -", line);
console.log("Reminder: delete the customer in the Stripe dashboard for the processor's copy; email delivery logs at the provider expire on their own schedule.");
