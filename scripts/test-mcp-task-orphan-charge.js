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
//      ledger books it (lower case) while a base32 one is kept as given;
//   f. a sale that cannot be tied to this run claims neither and books
//      nothing: another run of the same tool by the same wallet overlaps it
//      (its delivered sale is not this run's), or two sales fall in the window;
//   g. a store told the path its runs are sold on (the connector's "mcp")
//      reads only sales booked on that path, so a direct retry is not the run's;
//   h. a sale with no transaction is booked under the run's own key, so two
//      sweeps of one run book one debt;
//   i. the connector labels a task with the wallet an MPP evm credential
//      names, and nothing for any other credential.
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

// f. a sibling run of the same tool by the same wallet: its delivered sale
// is not this run's, so the orphan claims neither and nothing is booked.
{
  const dirF = join(TMP, "f");
  const PAYER_F = PAYER.replace("5A1e", "5AF1");
  const TX_F = "0x" + "cd".repeat(32);
  const first = createTaskStore({ dir: dirF, bootId: "boot-fa", log: quiet });
  const recA = first.create({ slug: "research", payer: PAYER_F });
  first.complete(recA.taskId, { content: [{ type: "text", text: "done" }] });
  ledger.recordSale({ slug: "research", priceUsd: 0.5, rail: "usdc", network: "eip155:8453", payer: PAYER_F, tx: TX_F, wire: "x402" });
  await ledger.salesLedgerFlush?.();
  const recB = first.create({ slug: "research", payer: PAYER_F });
  const bookedF = [];
  const logs = [];
  const second = createTaskStore({ dir: dirF, bootId: "boot-fb", log: (l) => logs.push(l), onChargedFailure: (x) => bookedF.push(x) });
  await second.orphansChecked?.();
  const r = second.get(recB.taskId);
  ok(second.get(recA.taskId)?.status === "completed", "f. control: the sibling run completed");
  ok(r?.status === "failed" && !/settled before the restart/.test(r.statusMessage) && !/not charged/i.test(r.statusMessage) && /\/api\/refunds\/lookup\?tx=/.test(r.statusMessage), `f. an orphan beside a sibling run of the same tool and wallet claims neither (${String(r?.statusMessage).slice(0, 120)})`);
  ok(bookedF.length === 0, `f. ...and the sibling's delivered sale is not booked as owed (${JSON.stringify(bookedF)})`);
  ok(logs.some((l) => /cannot be tied to the run/.test(l)), "f. ...and the sweep logs it for a human");
}
// f2. two sales of the tool to the wallet in the run's window: which one is
// the run's cannot be told, so neither claim and nothing booked.
{
  const dirF2 = join(TMP, "f2");
  const PAYER_F2 = PAYER.replace("5A1e", "5AF2");
  const first = createTaskStore({ dir: dirF2, bootId: "boot-f2a", log: quiet });
  const rec = first.create({ slug: "research", payer: PAYER_F2 });
  ledger.recordSale({ slug: "research", priceUsd: 0.5, rail: "usdc", network: "eip155:8453", payer: PAYER_F2, tx: "0x" + "e1".repeat(32), wire: "x402" });
  ledger.recordSale({ slug: "research", priceUsd: 0.5, rail: "usdc", network: "eip155:8453", payer: PAYER_F2, tx: "0x" + "e2".repeat(32), wire: "x402" });
  await ledger.salesLedgerFlush?.();
  const bookedF2 = [];
  const second = createTaskStore({ dir: dirF2, bootId: "boot-f2b", log: quiet, onChargedFailure: (x) => bookedF2.push(x) });
  await second.orphansChecked?.();
  const r = second.get(rec.taskId);
  ok(r?.status === "failed" && !/settled before the restart/.test(r.statusMessage) && !/not charged/i.test(r.statusMessage) && bookedF2.length === 0, `f2. two sales in the window: neither claim, nothing booked (${bookedF2.length})`);
}
// f3. the default lookup, read directly: five sales of the tool to the wallet
// in the window (a full page, more may follow past it) say nothing; with a
// path, only that path's sales count.
{
  const { salesLedgerChargeOf } = await import("../src/mcp-tasks.js");
  const W = PAYER.replace("5A1e", "5AF3");
  const t0 = Date.now() - 1000;
  for (let i = 0; i < 5; i++) ledger.recordSale({ slug: "dossier", priceUsd: 0.5, rail: "usdc", network: "eip155:8453", payer: W, tx: `0x${String(i).repeat(64)}`, wire: "x402", via: i === 4 ? "mcp" : "http" });
  await ledger.salesLedgerFlush?.();
  const all = await salesLedgerChargeOf({ slug: "dossier", payer: W.toLowerCase(), sinceMs: t0, untilMs: Date.now() + 1000, via: "mcp" });
  ok(all === undefined, `f3. a full page of sales in the window reads as unknown, even with one on the path asked for (${JSON.stringify(all)})`);
  const none = await salesLedgerChargeOf({ slug: "dossier", payer: W.toLowerCase(), sinceMs: Date.now() + 5_000, untilMs: Date.now() + 10_000 });
  ok(none === null, "f3. control: an empty window reads as no sale");
}
// g. a store whose runs are sold on the connector's path reads only those sales.
{
  const dirG = join(TMP, "g");
  const PAYER_G = PAYER.replace("5A1e", "5A61");
  const TX_G = "0x" + "a7".repeat(32);
  const first = createTaskStore({ dir: dirG, bootId: "boot-ga", log: quiet, saleVia: "mcp" });
  const recHttp = first.create({ slug: "research", payer: PAYER_G });
  ledger.recordSale({ slug: "research", priceUsd: 0.5, rail: "usdc", network: "eip155:8453", payer: PAYER_G, tx: "0x" + "a6".repeat(32), wire: "x402", via: "http" });
  await ledger.salesLedgerFlush?.();
  const bookedG = [];
  const second = createTaskStore({ dir: dirG, bootId: "boot-gb", log: quiet, saleVia: "mcp", onChargedFailure: (x) => bookedG.push(x) });
  await second.orphansChecked?.();
  const r = second.get(recHttp.taskId);
  ok(r?.status === "failed" && /You were not charged/.test(r.statusMessage) && bookedG.length === 0, `g. a direct (http) sale of the tool is not the connector run's (${String(r?.statusMessage).slice(0, 80)})`);
  const dirG2 = join(TMP, "g2");
  const PAYER_G2 = PAYER.replace("5A1e", "5A62");
  const third = createTaskStore({ dir: dirG2, bootId: "boot-g2a", log: quiet, saleVia: "mcp" });
  const recMcp = third.create({ slug: "research", payer: PAYER_G2 });
  ledger.recordSale({ slug: "research", priceUsd: 0.5, rail: "usdc", network: "eip155:8453", payer: PAYER_G2, tx: TX_G, wire: "mpp", via: "mcp" });
  await ledger.salesLedgerFlush?.();
  const fourth = createTaskStore({ dir: dirG2, bootId: "boot-g2b", log: quiet, saleVia: "mcp", onChargedFailure: (x) => bookedG.push(x) });
  await fourth.orphansChecked?.();
  const r2 = fourth.get(recMcp.taskId);
  ok(r2?.statusMessage.includes(TX_G) && bookedG.length === 1 && bookedG[0].receipt.transaction === TX_G, "g. control: a sale booked on the connector's path is the run's");
}
// h. a sale with no transaction is booked under the run's own key.
{
  const dirH = join(TMP, "h");
  const first = createTaskStore({ dir: dirH, bootId: "boot-ha", log: quiet });
  const rec = first.create({ slug: "research", payer: PAYER });
  const bookedH = [];
  const second = createTaskStore({ dir: dirH, bootId: "boot-hb", log: quiet, chargeOf: () => ({ tx: null, network: "eip155:8453", priceUsd: 0.5 }), onChargedFailure: (x) => bookedH.push(x) });
  await second.orphansChecked?.();
  ok(bookedH.length === 1 && bookedH[0].requestId === `task-${rec.taskId}`, `h. a tx-less sale is booked under the run's key (${bookedH[0]?.requestId})`);
}
// i. the connector's task label: the wallet an MPP evm credential names.
{
  const { evmPayerOfCredential } = await import("../src/mcp-http.js");
  const cred = (c) => `Payment ${Buffer.from(JSON.stringify(c)).toString("base64url")}`;
  ok(evmPayerOfCredential(cred({ challenge: { method: "evm" }, payload: { from: PAYER } })) === PAYER, "i. an MPP evm credential labels the task with its signed from");
  ok(evmPayerOfCredential(cred({ challenge: { method: "tempo" }, payload: { from: PAYER } })) === null, "i. a Tempo credential labels nothing");
  ok(evmPayerOfCredential("Payment !!!") === null && evmPayerOfCredential("") === null && evmPayerOfCredential(undefined) === null, "i. garbage labels nothing");
}

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${pass} passed, 0 failed`);
