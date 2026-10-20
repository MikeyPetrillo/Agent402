#!/usr/bin/env node
// Erase a person's data by email address across every store that can hold one.
//
//   node scripts/erase-subject.js <email> [--dry] [--data-root DIR]
//
// The privacy policy promises deletion on request. This walks every store that
// keeps an address, prints per store what it removed (or, with --dry, what it
// would remove), and exits 1 when any store could not be read or written.
// Stripe's own customer record is not touched here: use the Stripe dashboard
// (customer deletion) for the card processor's copy.
//
// WHERE THE STORES ARE. The script goes through the same APIs the server does:
//   - STATE_DATABASE_URL set: the rows of the state database (src/state-db.js,
//     schema STATE_DB_SCHEMA). Whole-file stores are documents read and
//     written through src/json-document.js; credits and the card-checkout
//     failure index are rows of the records table. Files are touched only when
//     --data-root is given or /data exists (the write-through copies a volume
//     keeps); otherwise nothing is written to local disk, so a run from an
//     operator shell never leaves a copy of a store behind.
//   - STATE_DATABASE_URL unset: the files under --data-root (default /data,
//     else /tmp, the server's own fallback).
//
// RUNNING BESIDE THE SERVER.
//   - With the database the erase is safe while the server runs: every
//     document change is json-document's versioned read-modify-write (a write
//     another container made meanwhile is re-read, never overwritten), a
//     credits record changes under its row lock (SELECT ... FOR UPDATE, as
//     src/credits.js moves money), and the failure index loses one key in one
//     statement. The alert and follow-up stores re-read the row before every
//     change and skip a record that is gone, so a deletion sticks. The two
//     subscription stores write one record at a time from a copy in memory
//     that is refreshed from the row (the monitor tick's reload, per-key
//     reads), so the erased record is stamped with a newer updatedAt (newer
//     wins on reload). Confirm afterwards: run again with --dry after the next
//     monitor tick; every store must report 0.
//   - Without the database (files) the server holds the stores in memory and
//     rewrites whole files, so stop the server first: an erase under a running
//     file-backed server can be written over.
//
// Stores:
//   free-alerts.json           alerts[*].email             -> record deleted
//   followups.json             seqs[*].email               -> record deleted
//   wallet-digest.json         subs[*].email (leftover)    -> record deleted
//   stripe-subscriptions.json  {subId: rec.email}          -> email nulled, record kept (billing history)
//   mpp-subscriptions.json     {mpp_*: rec.email}          -> email nulled, record kept (billing history)
//   credits k_<hash>           rec.email (card credit key) -> email nulled, balance kept
//   human-checkout _failures   sha256(email) prefix key    -> key deleted
//   monitor-runs.json, human-checkout sessions, credits _sessions: store no email
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--data-root");
const rootGiven = rootIdx >= 0 && Boolean(args[rootIdx + 1]);
const email = String(args.find((a, i) => !a.startsWith("--") && !(rootGiven && i === rootIdx + 1)) || "").trim().toLowerCase();
const dry = args.includes("--dry");
const ROOT = rootGiven ? args[rootIdx + 1] : (existsSync("/data") ? "/data" : "/tmp");
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error("usage: node scripts/erase-subject.js <email> [--dry] [--data-root DIR]"); process.exit(2); }

const sdb = await import("../src/state-db.js");
const { createJsonDocument, SKIP_UPDATE } = await import("../src/json-document.js");
const PG = sdb.stateDbEnabled();
// With the database, files are the volume's write-through copies: touched only on a volume.
const FILES = !PG || rootGiven || existsSync("/data");

const report = [];
let failures = 0;
const matches = (v) => typeof v === "string" && v.trim().toLowerCase() === email;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const say = (store, n, noun, done, would = done) => report.push(`${store}: ${n} ${noun}(s) ${dry ? `would be ${would}` : done}`);
const failed = (store, e) => { failures++; report.push(`${store}: FAILED (${String(e?.message || e).slice(0, 160)})`); };

function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function writeJson(path, body) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, path);
}

/**
 * One whole-file store. `change(body)` edits the body in place and returns how
 * many records it changed; it runs again on a fresh body after a version
 * conflict, so it decides only from the body it is given.
 */
async function eraseDocument(name, change, noun, done, would) {
  const doc = createJsonDocument({ name, file: FILES ? join(ROOT, name) : null, log: () => {}, failLog: () => {}, importFromFile: false, writeThroughFiles: FILES && !dry });
  let n = 0, present = false;
  const r = await doc.update((b) => {
    present = isObj(b); n = 0;
    if (!present) return SKIP_UPDATE;
    n = change(b);
    return n && !dry ? b : SKIP_UPDATE;
  }, { fallback: null });
  if (!r.ok) return failed(name, r.error);
  if (!present) return report.push(`${name}: absent`);
  say(name, n, noun, done, would);
}
const deleteWhere = (field) => (b) => {
  const m = isObj(b[field]) ? b[field] : {};
  const ids = Object.keys(m).filter((id) => isObj(m[id]) && matches(m[id].email));
  for (const id of ids) delete m[id];
  return ids.length;
};
const nullEmail = (rec, at) => { rec.email = null; rec.erasedAt = at; rec.updatedAt = at; };
const nullEmails = (b) => {
  const at = new Date().toISOString();
  let n = 0;
  for (const rec of Object.values(b)) if (isObj(rec) && matches(rec.email)) { nullEmail(rec, at); n++; }
  return n;
};

async function step(store, fn) { try { await fn(); } catch (e) { failed(store, e); } }

await step("free-alerts.json", () => eraseDocument("free-alerts.json", deleteWhere("alerts"), "record", "deleted"));
await step("followups.json", () => eraseDocument("followups.json", deleteWhere("seqs"), "sequence", "deleted"));
await step("wallet-digest.json", () => eraseDocument("wallet-digest.json", deleteWhere("subs"), "subscription", "deleted"));
await step("stripe-subscriptions.json", () => eraseDocument("stripe-subscriptions.json", nullEmails, "record", "had the address removed (subscription ids kept for billing history; cancel in Stripe if still active)", "stripped of the address"));
await step("mpp-subscriptions.json", () => eraseDocument("mpp-subscriptions.json", nullEmails, "record", "had the address removed (subscription kept; cancel it from its manage link if still active)", "stripped of the address"));

// Card credit keys: one record per key. With the database each changes under
// its row lock, the same transaction shape src/credits.js moves money with.
await step("credits", async () => {
  let n = 0;
  if (PG) {
    const T = `${sdb.stateDbSchema()}.records`;
    const ids = (await sdb.stateQuery(`SELECT id FROM ${T} WHERE collection = 'credits' AND id LIKE 'k\\_%' ESCAPE '\\' AND lower(trim(body ->> 'email')) = $1 ORDER BY id`, [email])).rows.map((r) => r.id);
    for (const id of ids) {
      if (dry) { n++; continue; }
      const changed = await sdb.withStateTx(async (c) => {
        const r = await c.query(`SELECT body FROM ${T} WHERE collection = 'credits' AND id = $1 FOR UPDATE`, [id]);
        const rec = r.rows[0]?.body;
        if (!isObj(rec) || !matches(rec.email)) return null;
        nullEmail(rec, new Date().toISOString());
        await c.query(`UPDATE ${T} SET body = $2::jsonb, updated_at = now() WHERE collection = 'credits' AND id = $1`, [id, JSON.stringify(rec)]);
        return rec;
      });
      if (changed) { n++; if (FILES && existsSync(join(ROOT, "credits", `${id}.json`))) writeJson(join(ROOT, "credits", `${id}.json`), changed); }
    }
  } else {
    const dir = join(ROOT, "credits");
    const files = (() => { try { return readdirSync(dir).filter((f) => f.startsWith("k_") && f.endsWith(".json")); } catch { return null; } })();
    if (files === null) return report.push("credits: absent");
    for (const f of files) {
      const rec = readJson(join(dir, f));
      if (!isObj(rec) || !matches(rec.email)) continue;
      n++;
      if (!dry) { nullEmail(rec, new Date().toISOString()); writeJson(join(dir, f), rec); }
    }
  }
  say("credits", n, "key record", "had the address removed (balance kept)", "stripped of the address");
});

// Card-checkout failure counter: keyed by a hash prefix of the address (the
// same derivation as failKeyOf in src/human-checkout.js).
await step("human-checkout/_failures", async () => {
  const key = createHash("sha256").update(email).digest("hex").slice(0, 24);
  let n = 0;
  if (PG) {
    const T = `${sdb.stateDbSchema()}.records`;
    const r = dry
      ? await sdb.stateQuery(`SELECT 1 FROM ${T} WHERE collection = 'human-checkout' AND id = '_failures' AND body ? $1`, [key])
      : await sdb.stateQuery(`UPDATE ${T} SET body = body - $1::text, updated_at = now() WHERE collection = 'human-checkout' AND id = '_failures' AND body ? $1 RETURNING body`, [key]);
    n = r.rowCount;
    const p = join(ROOT, "human-checkout", "_failures.json");
    if (!dry && n && FILES && existsSync(p)) writeJson(p, r.rows[0].body);
  } else {
    const p = join(ROOT, "human-checkout", "_failures.json");
    const idx = readJson(p);
    if (!isObj(idx)) return report.push("human-checkout/_failures: absent");
    if (Object.hasOwn(idx, key)) { n = 1; if (!dry) { delete idx[key]; writeJson(p, idx); } }
  }
  say("human-checkout/_failures", n, "failure counter", "deleted");
});
report.push("monitor-runs.json, human-checkout sessions, credits _sessions: store no email (nothing to do)");

console.log(`${dry ? "[dry run] " : ""}erase ${email} in ${PG ? `the state database (schema ${sdb.stateDbSchema()})${FILES ? ` and the files under ${ROOT}` : ""}` : `the files under ${ROOT}`}`);
for (const line of report) console.log(" -", line);
if (PG && !dry) console.log("Confirm: run again with --dry after the next monitor tick; every store must report 0.");
if (!PG && !dry) console.log("File stores: the server must have been stopped for this run (a running file-backed server rewrites whole files).");
console.log("Reminder: delete the customer in the Stripe dashboard for the processor's copy; email delivery logs at the provider expire on their own schedule.");
if (PG) await sdb.closeStateDb().catch(() => {});
process.exit(failures ? 1 : 0);
