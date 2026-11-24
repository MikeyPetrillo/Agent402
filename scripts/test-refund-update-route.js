#!/usr/bin/env node
// POST /__operator/refunds/update answers by what happened to the row, on a
// booted server (file backends):
//   - 409 only for a state conflict: no row, already resolved, claimed by
//     another run, or not sending for a release (the refund runner reads a
//     409 on a claim as "another run has this row" and moves on);
//   - 503 when the store did not take the write (here a trigger in the
//     ledger file refuses the UPDATE of one row, as a full disk or a held
//     lock would): never a 409, so a failed write is not read as a lost race
//     and the row is read before anything is retried;
//   - 400 for missing evidence (paid without its tx, void or release without
//     a note) and for an unknown action;
//   - 200 for a change that landed, and the row reads as changed.
//
//   node scripts/test-refund-update-route.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import Database from "better-sqlite3";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";
import { ownStoreEnv } from "./lib/own-stores.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const OP_TOKEN = "refund-update-route-test-operator-token-0123456789";

// Seed the ledger file BEFORE the boot: three owed debts, and a trigger that
// refuses any UPDATE of row 1 (the store failing that write).
const stores = ownStoreEnv("refund-update-route");
const seed = new Database(join(stores.REFUND_DB_DIR, "agent402-refunds.db"));
seed.exec(`CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT, evidence TEXT NOT NULL UNIQUE, slug TEXT NOT NULL, network TEXT, payer TEXT,
  priceUsd REAL NOT NULL DEFAULT 0, httpStatus INTEGER, synthetic INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'owed',
  paidTx TEXT, note TEXT, createdAt INTEGER NOT NULL, resolvedAt INTEGER, wire TEXT, hangupReason TEXT, claimedAt INTEGER)`);
const ins = seed.prepare("INSERT INTO refunds (id, evidence, slug, network, payer, priceUsd, httpStatus, createdAt, wire) VALUES (?,?,?,?,?,?,?,?,?)");
const PAYER = "0x00000000000000000000000000000000000000d4";
for (const id of [1, 2, 3]) ins.run(id, `0x${String(id).repeat(64)}`, "web-search", "eip155:8453", PAYER, 0.01, 502, Date.now() - 60_000, "x402");
seed.exec("CREATE TRIGGER refuse_update BEFORE UPDATE ON refunds WHEN OLD.id = 1 BEGIN SELECT RAISE(ABORT, 'store refused the write'); END;");
seed.close();

let srv = null;
try {
  srv = await bootServer({
    stores: false,
    env: {
      ...stores, FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: OP_TOKEN,
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", FACILITATOR_GAS_CHECK: "off",
    },
  });
  const AUTH = { Authorization: `Bearer ${OP_TOKEN}` };
  const update = async (body) => {
    const r = await fetch(`${srv.url}/__operator/refunds/update`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, cache: r.headers.get("cache-control") || "" };
  };
  const row = async (id) => (await (await fetch(`${srv.url}/__operator/refunds.json?status=all&limit=50`, { headers: AUTH })).json()).refunds.find((r) => r.id === id);

  // --- a store that does not take the write is a 503, never a 409 -----------------
  const refused = await update({ id: 1, action: "claim", note: "refund-run: claimed before broadcast" });
  ok(refused.status === 503 && /did not confirm/.test(refused.json?.error || ""), `a claim the store refuses answers 503, not a lost race (${refused.status} ${JSON.stringify(refused.json)})`);
  ok(/private/.test(refused.cache) && /no-store/.test(refused.cache), `the answer is private, no-store (${refused.cache})`);
  ok((await row(1))?.status === "owed", "control: the refused claim changed nothing (row 1 still owed)");
  const refusedVoid = await update({ id: 1, action: "void", note: "operator void" });
  ok(refusedVoid.status === 503, `a void the store refuses answers 503 too (${refusedVoid.status})`);

  // --- 409 is a state conflict ------------------------------------------------------
  ok((await update({ id: 999, action: "claim" })).status === 409, "a claim of a row that does not exist is a 409");
  ok((await update({ id: 2, action: "release", note: "checked the chain" })).status === 409, "a release of a row that is not sending is a 409");
  const claimed = await update({ id: 2, action: "claim", note: "refund-run: claimed before broadcast" });
  ok(claimed.status === 200 && claimed.json?.ok === true && (await row(2))?.status === "sending", `control: a claim the store takes answers 200 and the row is sending (${claimed.status})`);
  const second = await update({ id: 2, action: "claim", note: "a second run" });
  ok(second.status === 409 && /claimed by another run/.test(second.json?.error || ""), `a second claim of the same row is a 409 (${second.status})`);

  // --- 400 is missing evidence --------------------------------------------------------
  ok((await update({ id: 2, action: "paid" })).status === 400, "paid without the outbound tx is a 400, not a 409");
  ok((await update({ id: 2, action: "paid", tx: "undefined" })).status === 400, "paid with the string \"undefined\" as its tx is a 400");
  ok((await update({ id: 3, action: "void" })).status === 400, "void without a note is a 400");
  ok((await update({ id: 2, action: "release" })).status === 400, "release without a note is a 400");
  ok((await update({ id: 2, action: "refund" })).status === 400, "an unknown action is a 400");
  ok((await row(2))?.status === "sending" && (await row(3))?.status === "owed", "none of them changed a row");

  const paid = await update({ id: 2, action: "paid", tx: "0x" + "ab".repeat(32) });
  ok(paid.status === 200 && (await row(2))?.status === "paid", `control: paid with its tx answers 200 and the row is paid (${paid.status})`);
  ok((await update({ id: 2, action: "paid", tx: "0x" + "cd".repeat(32) })).status === 409, "marking a paid row paid again is a 409");

  // --- block: a payee on a sanctions list is held as blocked property --------------
  ok((await update({ id: 3, action: "block" })).status === 400, "block without a note is a 400");
  const blocked = await update({ id: 3, action: "block", note: "refund-run: payee is on a sanctions list" });
  ok(blocked.status === 200 && (await row(3))?.status === "blocked" && blocked.json?.totals?.blocked?.n === 1, `block moves an owed row to blocked and the totals count it (${blocked.status})`);
  ok((await update({ id: 3, action: "claim", note: "refund-run: claimed before broadcast" })).status === 409, "a blocked row cannot be claimed for a send");
  ok((await update({ id: 3, action: "void", note: "write it off" })).status === 409, "a blocked row cannot be written off");
  const blockedList = await (await fetch(`${srv.url}/__operator/refunds.json?status=blocked`, { headers: AUTH })).json();
  ok(blockedList.status === "blocked" && blockedList.refunds.length === 1 && blockedList.refunds[0].id === 3, "refunds.json lists the blocked rows (the annual blocked-property report reads them)");
} catch (e) {
  failed++;
  console.error(`FAIL - ${e?.stack || e}`);
  if (srv) console.error(srv.log().split("\n").slice(-25).join("\n"));
} finally {
  await srv?.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
