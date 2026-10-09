#!/usr/bin/env node
// The traffic classifier's store (src/traffic-classifier.js) on the state
// database: the directory's day files and payers.json are imported once at
// the first load with the database on (and never again), persist() writes the
// rollups to the `records` table (collection "traffic") where a fresh
// instance reads them, the repeat-buyer memory survives a restart through the
// payers row, and retention deletes a day row once it passes retentionDays,
// on load and on persist, while the payers row is never touched.
//
// Needs STATE_DATABASE_URL (CI fails without it; locally it prints SKIP).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-traffic-classifier-pg" });
const sdb = await import("../src/state-db.js");
const { createTrafficStore } = await import("../src/traffic-classifier.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = mkdtempSync(join(tmpdir(), "traffic-pg-"));
const DIR = join(ROOT, "traffic");           // the production layout: <volume>/traffic
const quiet = () => {};
const t0 = Date.parse("2026-09-22T10:00:00Z");
const ids = async () => (await sdb.records.list("traffic", { limit: 1000 })).map((r) => r.id).sort();
const mkStore = (dir, extra = {}) => createTrafficStore({ dir, crawlerDistinctPaths: 5, salt: "test", log: quiet, ...extra });

try {
  // ---- 1. import once ----------------------------------------------------------
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "2026-09-20.json"), JSON.stringify({ day: "2026-09-20", total: 7, classes: { paid: 7 }, byClass: {}, discovery: {}, indexers: {}, crawlers: {}, distinctIps: 3 }));
  writeFileSync(join(DIR, "2026-06-01.json"), JSON.stringify({ day: "2026-06-01", total: 1 })); // past retention: never imported
  writeFileSync(join(DIR, "payers.json"), JSON.stringify({ deadbeef0001: 2 }));
  writeFileSync(join(DIR, "notes.txt"), "not a rollup");
  const a = mkStore(DIR);
  ok(a.backend === "pg", "with STATE_DATABASE_URL the store's backend is pg");
  await a.load(t0);
  ok((await ids()).join() === "2026-09-20,payers", `the day file inside retention and payers.json are imported; the expired one is not (${(await ids()).join()})`);
  const mark = await sdb.imports.done(basename(DIR));
  ok(mark && mark.source === DIR && mark.bytes > 0, "the import is marked under the directory's basename");
  ok(a._days.get("2026-09-20")?.total === 7 && a._payers.get("deadbeef0001") === 2, "memory is filled from the rows");
  // A file added after the import is not picked up by a second load: the mark stands.
  writeFileSync(join(DIR, "2026-09-21.json"), JSON.stringify({ day: "2026-09-21", total: 99 }));
  const b = mkStore(DIR);
  await b.load(t0);
  ok(!(await ids()).includes("2026-09-21") && !b._days.has("2026-09-21"), "a second load does not re-import the directory (a file added later is not in the table)");

  // ---- 2. writes go to the table; a fresh instance reads them ------------------
  const rec = (store, over) => store.record({ ip: "203.0.113.7", ua: "curl/8.0", path: "/api/hash", method: "POST", status: 402, accept: "*/*", now: t0, ...over });
  for (let i = 0; i < 5; i++) rec(a, { path: `/api/tool-${i}` });
  const p1 = rec(a, { ip: "192.0.2.1", status: 200, paidReceipt: true, payer: "0xabc" });
  const p2 = rec(a, { ip: "192.0.2.1", status: 200, paidReceipt: true, payer: "0xabc" });
  ok(p1 === "paid" && p2 === "repeat-buyer", "classes are unchanged on the database backend");
  ok(a.persist(t0) === true, "persist() returns true at once: the write is queued");
  await a.flush();
  const row = await sdb.records.get("traffic", "2026-09-22");
  ok(row?.total === 7 && row.classes.crawler === 1 && row.classes["repeat-buyer"] === 1, `the day rollup is in the table (${JSON.stringify(row?.classes)})`);
  const payersRow = await sdb.records.get("traffic", "payers");
  ok(payersRow && Object.keys(payersRow).length === 2 && payersRow.deadbeef0001 === 2, "the payers row carries the imported hash and the new one");
  ok(existsSync(join(DIR, "2026-09-22.json")) && JSON.parse(readFileSync(join(DIR, "2026-09-22.json"), "utf8")).total === 7, "the volume's file is kept current by write-through");
  ok(!JSON.stringify(row).includes("203.0.113.7") && !JSON.stringify(payersRow).includes("0xabc"), "no raw ip or payer address in any row");
  // A fresh instance with an EMPTY directory (a new container) reads the rows.
  const EMPTY = join(ROOT, "traffic-fresh");
  mkdirSync(EMPTY, { recursive: true });
  const c = mkStore(EMPTY);
  await c.load(t0);
  ok(c.report({ days: 1 }).days[0]?.total === 7 && c._days.get("2026-09-20")?.total === 7, "a fresh instance reads today's rollup and the imported day from the table");
  ok(c.record({ ip: "192.0.2.9", ua: "curl", path: "/api/hash", method: "POST", status: 200, paidReceipt: true, payer: "0xabc", now: t0 }) === "repeat-buyer", "the repeat-buyer memory survives a restart through the payers row");
  ok(c.summaryLine("2026-09-22").includes("total=8"), "the daily summary line reads the loaded rollup plus the request just classed");

  // ---- 3. retention on the table ---------------------------------------------
  // 2026-09-20 passes 90 days on 2026-12-20: a persist after that deletes its
  // row; the payers row is never touched.
  c.record({ ip: "198.51.100.9", ua: "curl", path: "/api/uuid", method: "GET", status: 402, now: t0 + 91 * 864e5 });
  c.persist(t0 + 91 * 864e5);
  await c.flush();
  await new Promise((r) => setTimeout(r, 200)); // the retention delete is fire-and-forget beside the save
  const after = await ids();
  ok(!after.includes("2026-09-20") && after.includes("payers") && after.includes("2026-12-22"), `persist deletes a day row past retention and keeps payers (${after.join()})`);
  await sdb.records.put("traffic", "2026-01-01", { day: "2026-01-01", total: 1 });
  const d = mkStore(EMPTY);
  await d.load(t0 + 91 * 864e5);
  await new Promise((r) => setTimeout(r, 200));
  ok(!(await ids()).includes("2026-01-01") && !d._days.has("2026-01-01"), "load deletes a day row past retention and does not read it");
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} assertions, ${fail} failures`);
process.exit(fail ? 1 : 0);
