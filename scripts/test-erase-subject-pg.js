#!/usr/bin/env node
// scripts/erase-subject.js against the state database: with STATE_DATABASE_URL
// set every store is a row (documents through json-document, credits and the
// card-checkout failure index in the records table), and the erase must reach
// those rows, not files. The script runs as a child exactly as an operator
// runs it, on this test's own schema. A store the server holds open meanwhile
// (a json-document loaded before the erase, written after it) never brings an
// erased record back.
// Requires STATE_DATABASE_URL (CI fails without it).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireTestPg } from "./lib/test-pg.js";

const { schema } = requireTestPg({ label: "test-erase-subject-pg" });
const sdb = await import("../src/state-db.js");
const { createJsonDocument } = await import("../src/json-document.js");
const here = dirname(fileURLToPath(import.meta.url));
const script = process.env.ERASE_SUBJECT_SCRIPT || join(here, "erase-subject.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const T = () => `${sdb.stateDbSchema()}.records`;
const putRec = (collection, id, body) => sdb.stateQuery(`INSERT INTO ${T()} (collection, id, body) VALUES ($1, $2, $3::jsonb)`, [collection, id, JSON.stringify(body)]);
const getRec = async (collection, id) => (await sdb.stateQuery(`SELECT body FROM ${T()} WHERE collection = $1 AND id = $2`, [collection, id])).rows[0]?.body ?? null;
const getDoc = async (name) => (await sdb.documents.get(name))?.body ?? null;
const who = "Erase.Me@example.com";
const failKey = createHash("sha256").update("erase.me@example.com").digest("hex").slice(0, 24);
const otherKey = createHash("sha256").update("keep@example.com").digest("hex").slice(0, 24);
const env = { ...process.env, STATE_DB_SCHEMA: schema };
const run = (...extra) => spawnSync(process.execPath, [script, who, ...extra], { encoding: "utf8", env, timeout: 60_000 });

try {
  await sdb.stateDb();
  await sdb.documents.put("free-alerts.json", { alerts: { a1: { email: "erase.me@example.com", kind: "insider" }, a2: { email: "keep@example.com" } } });
  await sdb.documents.put("followups.json", { seqs: { s1: { email: "erase.me@example.com" }, s2: { email: "keep@example.com" } } });
  await sdb.documents.put("stripe-subscriptions.json", { sub_1: { email: "erase.me@example.com", status: "active", updatedAt: "2026-01-01T00:00:00.000Z" }, sub_2: { email: "keep@example.com", status: "active" } });
  await sdb.documents.put("mpp-subscriptions.json", { mpp_1: { subId: "mpp_1", email: "Erase.Me@example.com", status: "active", payer: "0xAbC" }, mpp_2: { subId: "mpp_2", email: "keep@example.com" }, "tempo:sub:1": { amount: "1", lookupKey: "k" } });
  await putRec("credits", "k_aaa", { keyId: "k1", balanceMicro: 500, email: "erase.me@example.com" });
  await putRec("credits", "k_bbb", { keyId: "k2", balanceMicro: 700, email: "keep@example.com" });
  await putRec("credits", "_sessions", { cs_1: "aaa" });
  await putRec("human-checkout", "_failures", { [failKey]: [1], [otherKey]: [2] });
  const vBefore = (await sdb.documents.get("free-alerts.json")).version;

  // A store held open the way the server holds it: loaded before the erase.
  const held = createJsonDocument({ name: "free-alerts.json", log: () => {}, failLog: () => {} });
  await held.load(null);

  const dry = run("--dry");
  ok(dry.status === 0, `dry run exits 0 (${dry.status}) ${dry.stderr.slice(0, 300)}`);
  ok(/state database/.test(dry.stdout), "the run names the state database as its backend");
  ok(/free-alerts\.json: 1 record\(s\) would be deleted/.test(dry.stdout) && /mpp-subscriptions\.json: 1 record\(s\) would be/.test(dry.stdout) && /credits: 1 key record\(s\) would be/.test(dry.stdout) && /_failures: 1 failure counter\(s\) would be deleted/.test(dry.stdout), `dry run reports per store what would be removed:\n${dry.stdout}`);
  ok((await getDoc("free-alerts.json")).alerts.a1 && (await getRec("credits", "k_aaa")).email && (await getRec("human-checkout", "_failures"))[failKey], "dry run changes no row");
  ok((await sdb.documents.get("free-alerts.json")).version === vBefore, "dry run leaves the document version as it was");

  const r = run();
  ok(r.status === 0, `erase exits 0 (${r.status}) ${r.stderr.slice(0, 300)}`);
  const alerts = (await getDoc("free-alerts.json")).alerts;
  ok(!alerts.a1 && Boolean(alerts.a2), "free alert row: the address's record deleted, others kept");
  const seqs = (await getDoc("followups.json")).seqs;
  ok(!seqs.s1 && Boolean(seqs.s2), "follow-up row: the sequence deleted, others kept");
  const ss = await getDoc("stripe-subscriptions.json");
  ok(ss.sub_1.email === null && ss.sub_1.status === "active" && ss.sub_1.updatedAt > "2026-01-01T00:00:00.000Z" && ss.sub_2.email === "keep@example.com", "card subscription row keeps the record without the address, stamped newer (newer wins on the server's reload)");
  const mpp = await getDoc("mpp-subscriptions.json");
  ok(mpp.mpp_1.email === null && mpp.mpp_1.payer === "0xAbC" && mpp.mpp_2.email === "keep@example.com" && mpp["tempo:sub:1"].lookupKey === "k", "MPP subscription row keeps the record without the address; the wallet's case and other keys untouched");
  const k1 = await getRec("credits", "k_aaa"), k2 = await getRec("credits", "k_bbb");
  ok(k1.email === null && k1.balanceMicro === 500 && k2.email === "keep@example.com", "credit key row keeps its balance without the address; other keys untouched");
  const fx = await getRec("human-checkout", "_failures");
  ok(!fx[failKey] && Boolean(fx[otherKey]), "card-checkout failure counter for the address deleted, others kept");
  ok(/wallet-digest\.json: absent/.test(r.stdout), "a store with no row reports absent");
  ok((await sdb.documents.get("free-alerts.json")).version > vBefore, "the document write is a versioned write (the version moved)");

  // The held store writes after the erase, the way the server does: a
  // versioned read-modify-write on the fresh row never restores a1.
  const w = await held.update((b) => { b.alerts.a3 = { email: "new@example.com" }; });
  ok(w.ok && !(await getDoc("free-alerts.json")).alerts.a1 && Boolean((await getDoc("free-alerts.json")).alerts.a3), "a write from a store loaded before the erase keeps the record erased");

  const again = run("--dry");
  ok(again.status === 0 && !/: [1-9]\d* /.test(again.stdout), `a second dry run finds nothing left:\n${again.stdout}`);
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
