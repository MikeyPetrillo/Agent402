#!/usr/bin/env node
// A task (MCP connector) or async job whose run died with its process is
// resolved as failed by the next boot's sweep (src/mcp-tasks.js). Its words
// used to say "You were not charged" every time, but the paid loopback can
// settle its 200 and book the sale just before the process dies, before the
// record is written: that buyer was charged. Each run names a key
// (newRunKey) on its record and on its loopback, and the route books that key
// on the sale it makes for the run, so the sweep reads the run's OWN sale:
//   a. a sale under the run's key: the words say the payment settled, name
//      the transaction, and the charge is handed to onChargedFailure (the
//      refund ledger's booking) once, on the sale's proof and to the payer
//      the sale was booked to (the one the gate verified);
//   b. no sale under the key and no sale of the tool in the window that
//      names no run: "You were not charged", as before;
//   c. a record with neither key nor payer: neither claim;
//   d. a record made before runs named a key (a payer, no key): a sale found
//      for it cannot be tied to it (neither claim, nothing booked), none
//      found is "not charged";
//   e. the key never crosses the wire, and no payer is recorded;
//   f. a sale of the tool in the window that names no run (a path that books
//      no key may have made it for this run) claims neither and books nothing;
//   g. another call's delivered sale (a direct retry by the same wallet, the
//      connector's own answer inside the gate window, another job) is never
//      taken as the run's: the run's own keyed sale is, beside it;
//   h. a sale with no transaction is booked under the run's own key, so two
//      sweeps of one run book one debt;
//   i. a ledger that has not loaded is never read as "no sale".
// Real sales ledger (SQLite, a file of this run's own), real file task store.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const TMP = mkdtempSync(join(tmpdir(), "a402-orphan-charge-"));
process.env.SALES_LEDGER_DB = join(TMP, "sales.db");
process.env.AGENT402_TASK_DATA_DIR = TMP;
const ledger = await import("../src/sales-ledger.js");
const { createTaskStore, detailedTask, createTaskResult, newTaskId } = await import("../src/mcp-tasks.js");
const tasksMod = await import("../src/mcp-tasks.js");

let pass = 0;
const fail = (m) => { console.error(`FAIL - ${m}`); try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

const PAYER = "0x5A1eC0FfEe0000000000000000000000000BeeF1";
const W = (n) => PAYER.replace("5A1e", n);
const key = () => randomBytes(16).toString("hex");
const quiet = () => {};
const sale = (o) => ledger.recordSale({ priceUsd: 0.5, rail: "usdc", network: "eip155:8453", wire: "x402", ...o });
// A record as a build before run keys wrote it (a payer, no key): written to
// the store's directory as that build's boot left it.
const legacyRecord = (dir, { slug, payer = null, owner = "boot-legacy" }) => {
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const rec = { taskId: newTaskId(), status: "working", statusMessage: `Running ${slug}.`, createdAt: new Date(now).toISOString(), lastUpdatedAt: new Date(now).toISOString(), createdAtMs: now, ttlMs: 3_600_000, pollIntervalMs: 5000, slug, phase: "queued", owner, pid: 1, ...(payer ? { payer: payer.toLowerCase() } : {}) };
  writeFileSync(join(dir, `${rec.taskId}.json`), JSON.stringify(rec));
  return rec;
};
const restart = async (dir, opts = {}) => {
  const booked = [];
  const logs = [];
  const s = createTaskStore({ dir, bootId: `boot-${key().slice(0, 8)}`, log: (l) => logs.push(l), onChargedFailure: (x) => booked.push(x), ...opts });
  await s.orphansChecked?.();
  return { s, booked, logs };
};
const charged = (r, tx) => r?.status === "failed" && /payment settled before the restart/.test(r.statusMessage) && (!tx || r.statusMessage.includes(tx)) && !/not charged/i.test(r.statusMessage);
const notCharged = (r) => r?.status === "failed" && /You were not charged/.test(r.statusMessage) && /not charged/.test(r.error?.message || "");
const neither = (r) => r?.status === "failed" && /restart/.test(r.statusMessage) && !/not charged/i.test(r.statusMessage) && !/settled before the restart/.test(r.statusMessage) && /\/api\/refunds\/lookup\?tx=/.test(r.statusMessage) && !/not charged/i.test(r.error?.message || "");

// a. charged: the run's own sale, under its key.
{
  const dir = join(TMP, "a");
  const K = key();
  const TX = "0x" + "ab".repeat(32);
  const first = createTaskStore({ dir, bootId: "boot-a1", log: quiet });
  const rec = first.create({ slug: "research", runKey: K });
  ok(rec?.runKey === K, "a. the record keeps the run's key");
  sale({ slug: "research", payer: W("5A01"), tx: TX, via: "mcp", runKey: K });
  await ledger.salesLedgerFlush?.();
  const { s, booked } = await restart(dir);
  const r = s.get(rec.taskId);
  ok(charged(r, TX), `a. a run whose own sale is on the books says its payment settled and names the transaction (${String(r?.statusMessage).slice(0, 140)})`);
  ok(/recorded as owed in our refund ledger and repaid after review/.test(r.statusMessage) && r.statusMessage.includes(`/api/refunds/lookup?tx=${TX}`), "a. ...and that the charge is owed back after review, with the free lookup");
  ok(!/not charged/i.test(r.error?.message || "") && /payment settled/.test(r.error?.message || ""), `a. the error says the same (${r.error?.message})`);
  ok(booked.length === 1 && booked[0].slug === "research" && booked[0].receipt.success === true && booked[0].receipt.transaction === TX && booked[0].receipt.payer === W("5A01").toLowerCase() && booked[0].receipt.network === "eip155:8453" && booked[0].priceUsd === 0.5, `a. the charge is booked once, on the sale's proof, to the payer the sale was booked to (${JSON.stringify(booked)})`);
  const again = await restart(dir);
  ok(again.booked.length === 0, "a. a later boot books nothing more for a run already worded");
}
// b. no sale under the key, none of the tool that names no run.
{
  const dir = join(TMP, "b");
  const first = createTaskStore({ dir, bootId: "boot-b1", log: quiet });
  const rec = first.create({ slug: "b-tool", runKey: key() });
  sale({ slug: "b-tool", payer: W("5A02"), tx: "0x" + "b0".repeat(32), via: "mcp", runKey: key() }); // another run's sale of the tool
  await ledger.salesLedgerFlush?.();
  const { s, booked } = await restart(dir);
  const r = s.get(rec.taskId);
  ok(notCharged(r) && booked.length === 0, `b. no sale under the run's key (another run's keyed sale of the tool is not this one's): not charged (${String(r?.statusMessage).slice(0, 90)})`);
}
// c. neither key nor payer: neither claim.
{
  const dir = join(TMP, "c");
  const rec = legacyRecord(dir, { slug: "research" });
  const { s, booked } = await restart(dir);
  const r = s.get(rec.taskId);
  ok(neither(r) && booked.length === 0, `c. a record with no key and no payer claims neither and names the free lookup (${String(r?.statusMessage).slice(0, 120)})`);
}
// d. a record from before run keys: a found sale cannot be tied to it.
{
  const dir = join(TMP, "d");
  const P = W("5A04");
  const found = legacyRecord(dir, { slug: "d-tool", payer: P });
  const none = legacyRecord(dir, { slug: "d-other", payer: P });
  sale({ slug: "d-tool", payer: P, tx: "0x" + "d0".repeat(32), via: "http" });
  await ledger.salesLedgerFlush?.();
  const { s, booked } = await restart(dir);
  ok(neither(s.get(found.taskId)) && booked.length === 0, `d. a keyless record with a sale of its tool by its wallet in the window claims neither and books nothing (${String(s.get(found.taskId)?.statusMessage).slice(0, 90)})`);
  ok(notCharged(s.get(none.taskId)), "d. a keyless record with no sale in its window is not charged");
}
// d2. a sale booked before the run began is not the run's.
{
  const dir = join(TMP, "d2");
  sale({ slug: "d2-tool", payer: W("5A05"), tx: "0x" + "d2".repeat(32), via: "http" });
  await ledger.salesLedgerFlush?.();
  const first = createTaskStore({ dir, bootId: "boot-d2a", log: quiet, now: () => Date.now() + 120_000 });
  const rec = first.create({ slug: "d2-tool", runKey: key() });
  const { s, booked } = await restart(dir, { now: () => Date.now() + 120_000 });
  ok(notCharged(s.get(rec.taskId)) && booked.length === 0, `d2. a sale from before the run began is not the run's (${String(s.get(rec.taskId)?.statusMessage).slice(0, 80)})`);
}
// d3. an injected lookup that throws reads as unread, never as "not charged".
{
  const dir = join(TMP, "d3");
  const rec = createTaskStore({ dir, bootId: "boot-d3a", log: quiet }).create({ slug: "research", runKey: key() });
  const { s } = await restart(dir, { chargeOf: () => { throw new Error("ledger down"); } });
  ok(neither(s.get(rec.taskId)), "d3. a ledger that cannot be read leaves the words claiming neither");
}
// e. what the record holds, and what the wire shows.
{
  const dir = join(TMP, "e");
  const K = key();
  const rec = createTaskStore({ dir, bootId: "boot-e", log: quiet }).create({ slug: "research", runKey: K, payer: PAYER });
  ok(rec.runKey === K && !("payer" in rec), `e. the record keeps the run's key and no payer (${Object.keys(rec).join(",")})`);
  ok(!JSON.stringify(createTaskResult(rec)).includes(K) && !JSON.stringify(detailedTask(rec)).includes(K), "e. the run's key never crosses the wire");
  const bad = createTaskStore({ dir, bootId: "boot-e2", log: quiet }).create({ slug: "research", runKey: "not-a-key" });
  ok(!("runKey" in bad), "e. a value that is not a run key is not kept");
}
// f. a sale of the tool in the window that names no run: neither claim.
{
  const dir = join(TMP, "f");
  const rec = createTaskStore({ dir, bootId: "boot-f1", log: quiet }).create({ slug: "f-tool", runKey: key() });
  sale({ slug: "f-tool", payer: W("5A06"), tx: "0x" + "f0".repeat(32), rail: "usdc", via: "http" });
  await ledger.salesLedgerFlush?.();
  const { s, booked, logs } = await restart(dir);
  ok(neither(s.get(rec.taskId)) && booked.length === 0, `f. a sale of the tool that names no run, in the run's window, claims neither and books nothing (${String(s.get(rec.taskId)?.statusMessage).slice(0, 90)})`);
  ok(logs.some((l) => /cannot be tied to the run/.test(l)), "f. ...and the sweep logs it for a human");
}
// g. another call's delivered sale is never the run's.
{
  // g1. An async job (the store as src/server.js builds it, label async-jobs)
  // cut off before its loopback settled; the same wallet's direct retry
  // settles and is delivered (via http, no key). The job's own record names
  // its key, and the retry's sale is not under it.
  const dir = join(TMP, "g1");
  const P = W("5A07");
  const job = createTaskStore({ dir, bootId: "boot-g1a", log: quiet, label: "async-jobs" }).create({ slug: "g1-tool", runKey: key() });
  sale({ slug: "g1-tool", payer: P, tx: "0x" + "c1".repeat(32), via: "http" });
  await ledger.salesLedgerFlush?.();
  const { s, booked } = await restart(dir, { label: "async-jobs" });
  const r = s.get(job.taskId);
  ok(!/settled before the restart/.test(r?.statusMessage || "") && booked.length === 0, `g1. an interrupted job never takes the same wallet's delivered direct call as its charge (${String(r?.statusMessage).slice(0, 90)}; ${booked.length} booked)`);
  // The same, from a record a build before run keys wrote with the job's payer.
  const dirL = join(TMP, "g1-legacy");
  const legacyJob = legacyRecord(dirL, { slug: "g1-tool", payer: P });
  const L = await restart(dirL, { label: "async-jobs" });
  ok(!/settled before the restart/.test(L.s.get(legacyJob.taskId)?.statusMessage || "") && L.booked.length === 0, "g1. ...nor does a job recorded with its payer before run keys");
}
{
  // g2. The connector: a call answered inside the gate window gets no record,
  // and its sale is booked on the connector's path with no run key; a long
  // call of the same tool by the same wallet becomes a task and is cut off.
  const dir = join(TMP, "g2");
  const P = W("5A08");
  const K = key();
  const TXB = "0x" + "c3".repeat(32);
  const task = createTaskStore({ dir, bootId: "boot-g2a", log: quiet }).create({ slug: "g2-tool", runKey: K });
  sale({ slug: "g2-tool", payer: P, tx: "0x" + "c2".repeat(32), wire: "mpp", via: "mcp" }); // the short call's own sale
  await ledger.salesLedgerFlush?.();
  const { s, booked } = await restart(dir);
  ok(!/settled before the restart/.test(s.get(task.taskId)?.statusMessage || "") && booked.length === 0, `g2. a task never takes the short connector call's delivered sale as its own (${booked.length} booked)`);
  // Its own sale lands under its key beside that one: it is the run's, by key.
  const dir2 = join(TMP, "g2b");
  const K2 = key();
  const task2 = createTaskStore({ dir: dir2, bootId: "boot-g2c", log: quiet }).create({ slug: "g2-tool", runKey: K2 });
  sale({ slug: "g2-tool", payer: P, tx: TXB, wire: "mpp", via: "mcp", runKey: K2 });
  await ledger.salesLedgerFlush?.();
  const R = await restart(dir2);
  ok(charged(R.s.get(task2.taskId), TXB) && R.booked.length === 1 && R.booked[0].receipt.transaction === TXB, `g2. control: the run's own sale under its key is its charge, whatever else the wallet bought (${JSON.stringify(R.booked.map((b) => b.receipt.transaction))})`);
  // The same, from a record a build before run keys wrote (payer, no key):
  // it is never worded charged on a found sale.
  const dirL = join(TMP, "g2-legacy");
  const legacyTask = legacyRecord(dirL, { slug: "g2-tool", payer: P });
  const L = await restart(dirL);
  ok(!/settled before the restart/.test(L.s.get(legacyTask.taskId)?.statusMessage || "") && L.booked.length === 0, "g2. ...and a keyless record never takes a sale found by wallet, tool and time");
}
// h. a sale with no transaction is booked under the run's own key.
{
  const dir = join(TMP, "h");
  const rec = createTaskStore({ dir, bootId: "boot-ha", log: quiet }).create({ slug: "research", runKey: key() });
  const { booked } = await restart(dir, { chargeOf: () => ({ tx: null, network: "eip155:8453", priceUsd: 0.5, payer: PAYER.toLowerCase() }) });
  ok(booked.length === 1 && booked[0].requestId === `task-${rec.taskId}`, `h. a tx-less sale is booked under the run's key (${booked[0]?.requestId})`);
}
// i. a ledger that has not loaded is never read as "no sale".
{
  const dir = join(TMP, "i");
  const rec = createTaskStore({ dir, bootId: "boot-ia", log: quiet }).create({ slug: "research", runKey: key() });
  const { s, booked } = await restart(dir, { chargeOf: () => tasksMod.ORPHAN_LEDGER_UNLOADED });
  ok(typeof tasksMod.ORPHAN_LEDGER_UNLOADED === "string" && neither(s.get(rec.taskId)) && booked.length === 0, `i. an unloaded ledger leaves the words claiming neither (${String(s.get(rec.taskId)?.statusMessage).slice(0, 80)})`);
}
// The default lookup, read directly.
{
  const { salesLedgerChargeOf } = tasksMod;
  const K = key();
  const t0 = Date.now() - 1000;
  for (let i = 0; i < 25; i++) sale({ slug: "busy-tool", payer: W("5A09"), tx: `0x${String(i % 10).repeat(64)}`, via: "http" });
  sale({ slug: "busy-tool", payer: W("5A0a"), tx: "0x" + "ee".repeat(32), via: "mcp", runKey: K });
  await ledger.salesLedgerFlush?.();
  const own = await salesLedgerChargeOf({ slug: "busy-tool", runKey: K, sinceMs: t0, untilMs: Date.now() + 1000 });
  ok(own && own.tx === "0x" + "ee".repeat(32) && own.payer === W("5A0a").toLowerCase(), `a run's own sale is found by its key among many sales of the tool (${JSON.stringify(own)})`);
  ok((await salesLedgerChargeOf({ slug: "busy-tool", runKey: key(), sinceMs: t0, untilMs: Date.now() + 1000 })) === undefined, "a run with no sale under its key, in a window full of the tool's other sales, reads unknown");
  ok((await salesLedgerChargeOf({ slug: "other-slug", runKey: K, sinceMs: t0, untilMs: Date.now() + 1000 })) === undefined, "a sale under the key for another tool reads unknown, never as the run's");
  ok((await salesLedgerChargeOf({ slug: "busy-tool", runKey: key(), sinceMs: Date.now() + 5_000, untilMs: Date.now() + 10_000 })) === null, "control: an empty window with no sale under the key reads as no sale");
}

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${pass} passed, 0 failed`);
