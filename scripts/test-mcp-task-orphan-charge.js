#!/usr/bin/env node
// A task (MCP connector) or async job whose run died with its process is
// resolved as failed by the next boot's sweep (src/mcp-tasks.js). Its words
// used to say "You were not charged" every time, but the paid loopback can
// settle its 200 and book the sale just before the process dies, before the
// record is written: that buyer was charged. The sweep now reads the sales
// ledger (read only) for a sale of the run's tool to its paying wallet since
// the run began, and words the record from what it finds:
//   a. a sale on the books: the words say the payment settled, name the
//      transaction, and the charge is handed to onChargedFailure (the refund
//      ledger's booking) on the sale's proof, once;
//   b. no sale: "You were not charged", as before;
//   c. no payer on the record (the ledger cannot be asked): neither claim;
//   d. a sale of another tool, by another wallet, or from before the run:
//      not this run's (b's words);
//   e. the payer is never on the wire, and an EVM payer is stored as the
//      ledger books it (lower case) while a base32 one is kept as given.
// Real sales ledger (SQLite, a file of this run's own), real file task store.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "a402-orphan-charge-"));
process.env.SALES_LEDGER_DB = join(TMP, "sales.db");
process.env.AGENT402_TASK_DATA_DIR = TMP;
const ledger = await import("../src/sales-ledger.js");
const { createTaskStore, detailedTask, createTaskResult } = await import("../src/mcp-tasks.js");

let pass = 0;
const fail = (m) => { console.error(`FAIL - ${m}`); try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

const DIR = join(TMP, "mcp-tasks");
const PAYER = "0x5A1eC0FfEe0000000000000000000000000BeeF1";
const ALGO = "ZKFACAZ3WSEG7KPN5QZNHQ7WRQOYKFLX2PD2S5SAWM4NNVJJL7AKMKU3T4";
const TX = "0x" + "ab".repeat(32);
const booked = [];
const quiet = () => {};
// One boot creates the runs; a second boot over the same directory is the
// restart that finds them orphaned.
const before = createTaskStore({ dir: DIR, bootId: "boot-before", log: quiet });
const recCharged = before.create({ slug: "research", payer: PAYER });
const recClean = before.create({ slug: "research", payer: PAYER.replace("5A1e", "5A2e") });
const recNoPayer = before.create({ slug: "research" });
const recOther = before.create({ slug: "dossier", payer: ALGO });
ok(recCharged && recClean && recNoPayer && recOther, "four working runs are recorded by the first boot");

// e. what the record holds, and what the wire shows.
ok(recCharged.payer === PAYER.toLowerCase() && recOther.payer === ALGO && recNoPayer.payer === undefined, `the payer is stored as the ledger books it (EVM lower case, base32 as given) (${recCharged.payer}, ${recOther.payer})`);
ok(!JSON.stringify(createTaskResult(recCharged)).includes(PAYER.toLowerCase().slice(2, 12)) && !JSON.stringify(detailedTask(recCharged)).includes(PAYER.toLowerCase().slice(2, 12)), "the payer never crosses the wire");

// The ledger: a sale for recCharged's run (this tool, this wallet, after the
// run began); for recOther's wallet only a sale of ANOTHER tool, and one of
// its own tool from before its run began.
ledger.recordSale({ slug: "research", priceUsd: 0.5, rail: "usdc", network: "eip155:8453", payer: PAYER, tx: TX, wire: "x402" });
ledger.recordSale({ slug: "research", priceUsd: 0.5, rail: "usdc", network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", payer: ALGO, tx: "ALGOTX" + "Q".repeat(46), wire: "x402" });
await ledger.salesLedgerFlush?.();

const after = createTaskStore({ dir: DIR, bootId: "boot-after", log: quiet, onChargedFailure: (x) => booked.push(x) });
const reworded = await (after.orphansChecked?.() ?? 0);
ok(reworded === 3, `the sweep read the sales ledger for every orphan with a payer (${reworded} re-worded)`);

// a. charged
{
  const r = after.get(recCharged.taskId);
  ok(r?.status === "failed" && /restart/.test(r.statusMessage) && /payment settled before the restart/.test(r.statusMessage) && r.statusMessage.includes(TX) && !/not charged/i.test(r.statusMessage), `a. a run whose sale is on the books says its payment settled and names the transaction (${String(r?.statusMessage).slice(0, 140)})`);
  ok(/recorded as owed in our refund ledger and repaid after review/.test(r.statusMessage) && r.statusMessage.includes(`/api/refunds/lookup?tx=${TX}`), "a. ...and that the charge is owed back after review, with the free lookup");
  ok(!/not charged/i.test(r.error?.message || "") && /payment settled/.test(r.error?.message || ""), `a. the error says the same (${r.error?.message})`);
  const mine = booked.filter((b) => b.receipt?.transaction === TX);
  ok(mine.length === 1 && mine[0].slug === "research" && mine[0].receipt.success === true && mine[0].receipt.payer === PAYER.toLowerCase() && mine[0].receipt.network === "eip155:8453" && mine[0].priceUsd === 0.5, `a. the charge is booked once, on the sale's proof (${JSON.stringify(mine)})`);
}
// b. no sale on the books for this wallet
{
  const r = after.get(recClean.taskId);
  ok(r?.status === "failed" && /You were not charged/.test(r.statusMessage) && /not charged/.test(r.error?.message || ""), `b. a run with no sale on the books says it was not charged (${String(r?.statusMessage).slice(0, 100)})`);
}
// c. no payer: neither claim
{
  const r = after.get(recNoPayer.taskId);
  ok(r?.status === "failed" && /restart/.test(r.statusMessage) && !/not charged/i.test(r.statusMessage) && !/settled before the restart/.test(r.statusMessage) && /\/api\/refunds\/lookup\?tx=/.test(r.statusMessage), `c. a run whose payer is unknown claims neither, and names the free lookup (${String(r?.statusMessage).slice(0, 140)})`);
  ok(!/not charged/i.test(r.error?.message || ""), "c. ...in its error too");
}
// d. a sale of another tool by this wallet is not this run's
{
  const r = after.get(recOther.taskId);
  ok(r?.status === "failed" && /You were not charged/.test(r.statusMessage), `d. a sale of another tool from the same wallet is not this run's charge (${String(r?.statusMessage).slice(0, 80)})`);
  ok(booked.length === 1, `d. nothing else is booked (${booked.length})`);
}
// d2. a sale booked before the run began is not the run's either.
{
  const dir2 = join(TMP, "d2");
  const early = createTaskStore({ dir: dir2, bootId: "boot-d2a", log: quiet, now: () => Date.now() + 120_000 });
  const rec = early.create({ slug: "research", payer: PAYER });
  const later = createTaskStore({ dir: dir2, bootId: "boot-d2b", log: quiet, onChargedFailure: (x) => booked.push(x), now: () => Date.now() + 120_000 });
  await later.orphansChecked?.();
  const r = later.get(rec.taskId);
  ok(r?.status === "failed" && /You were not charged/.test(r.statusMessage) && booked.length === 1, `d2. a sale from before the run began is not the run's (${String(r?.statusMessage).slice(0, 80)})`);
}
// An injected lookup that throws reads as unread, never as "not charged".
{
  const dir3 = join(TMP, "d3");
  const first = createTaskStore({ dir: dir3, bootId: "boot-d3a", log: quiet });
  const rec = first.create({ slug: "research", payer: PAYER });
  const second = createTaskStore({ dir: dir3, bootId: "boot-d3b", log: quiet, chargeOf: () => { throw new Error("ledger down"); } });
  await second.orphansChecked?.();
  const r = second.get(rec.taskId);
  ok(r?.status === "failed" && !/not charged/i.test(r.statusMessage) && /restart/.test(r.statusMessage), "a ledger that cannot be read leaves the words claiming neither");
}

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${pass} passed, 0 failed`);
