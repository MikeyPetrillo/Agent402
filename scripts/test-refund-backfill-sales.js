#!/usr/bin/env node
// Refund debts for sales the operator names by settle transaction
// (src/refund-backfill.js backfillNamedSales, POST
// /__operator/refunds/backfill-sales), on a booted server.
//
// It moves no money, but it decides who is OWED money, so the rules are
// pinned through the route an operator calls:
//   - without ?write=1 it reports what it would mint and mints nothing;
//   - with it, one owed row per matched sale, whose payer, network, slug and
//     price are the sales ledger's row (a base58 payer byte for byte), with
//     the note stored on the row;
//   - a payer, price, slug or network in the request is never read;
//   - a tx with no sale, an internal sale, a tx recorded for two sales, a
//     sale with no payer and a sale at no price are named in `skipped` and
//     mint nothing;
//   - only ?write=1 writes: ?write=0 or any other value is a dry run;
//   - a second write mints nothing new;
//   - a missing note, an empty list and a list over the cap are a 400;
//   - without the operator token the route answers 404 (the same request
//     with the token is the control), and the pack backfill beside it answers
//     as before.
//
//   node scripts/test-refund-backfill-sales.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import Database from "better-sqlite3";
import { bootServer } from "./lib/boot-server.js";
import { ownStoreEnv } from "./lib/own-stores.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const OP_TOKEN = "refund-backfill-sales-test-operator-token-0123456789";

// Seed the sales ledger BEFORE the boot: the server opens it at import.
const stores = ownStoreEnv("refund-backfill-sales");
const seed = new Database(stores.SALES_LEDGER_DB);
seed.exec(`CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, slug TEXT NOT NULL,
  price_usd REAL NOT NULL, rail TEXT NOT NULL, network TEXT, payer TEXT, tx TEXT,
  internal INTEGER NOT NULL)`);
const ins = seed.prepare("INSERT INTO sales (ts,slug,price_usd,rail,network,payer,tx,internal) VALUES (?,?,?,?,?,?,?,?)");
const NOW = Date.now() - 3_600_000;
// Mixed case on purpose: a base58 address and signature are case-exact.
const SOL_PAYER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SOL_TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const EVM_PAYER = "0x00000000000000000000000000000000000000a1";
const EVM_TX = "0x" + "ab".repeat(32);
const EVM_TX_2 = "0x" + "cd".repeat(32);
const INTERNAL_TX = "0x" + "ee".repeat(32);
const TWICE_TX = "0x" + "77".repeat(32);
const UNKNOWN_TX = "0x" + "99".repeat(32);
const NOPAYER_TX = "0x" + "a5".repeat(32);
const ZERO_TX = "0x" + "b6".repeat(32);
ins.run(NOW, "json-diff", 0.05, "usdc", "solana", SOL_PAYER, SOL_TX, 0);
ins.run(NOW, "web-search", 0.02, "usdc", "base", EVM_PAYER, EVM_TX, 0);
ins.run(NOW, "web-search", 0.02, "usdc", "base", EVM_PAYER, EVM_TX_2, 0);
ins.run(NOW, "web-search", 0.02, "usdc", "base", "0x00000000000000000000000000000000000000b2", INTERNAL_TX, 1); // ours
ins.run(NOW, "web-search", 0.02, "usdc", "base", EVM_PAYER, TWICE_TX, 0);
ins.run(NOW, "json-diff", 0.03, "usdc", "base", EVM_PAYER, TWICE_TX, 0); // one tx, two sales
ins.run(NOW, "web-search", 0.02, "usdc", "base", null, NOPAYER_TX, 0); // no one to pay
ins.run(NOW, "web-search", 0, "usdc", "base", EVM_PAYER, ZERO_TX, 0); // nothing to pay
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
  const post = async (body, { write = false, headers = AUTH, query = write ? "?write=1" : "" } = {}) => {
    const r = await fetch(`${srv.url}/__operator/refunds/backfill-sales${query}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, text, json, cache: r.headers.get("cache-control") };
  };
  const ledger = async () => (await (await fetch(`${srv.url}/__operator/refunds.json?status=all&limit=500`, { headers: AUTH })).json()).refunds;
  const NOTE = "answered without the data the listing shows";
  const ALL = [SOL_TX, EVM_TX, INTERNAL_TX, UNKNOWN_TX, TWICE_TX];
  const reasonOf = (j, tx) => (j?.skipped || []).find((s) => s.tx === tx)?.reason;

  // --- operator only -------------------------------------------------------------
  const anon = await post({ txs: ALL, note: NOTE }, { write: true, headers: {} });
  ok(anon.status === 404 && !/minted|byPayer|skipped/.test(anon.text), `without the token a write answers 404 (${anon.status})`);
  const wrong = await post({ txs: ALL, note: NOTE }, { write: true, headers: { Authorization: "Bearer not-the-operator-token" } });
  ok(wrong.status === 404 && !/minted|byPayer|skipped/.test(wrong.text), `a wrong token answers 404 (${wrong.status})`);
  ok((await ledger()).length === 0, "and none of them recorded anything");

  // --- dry by default --------------------------------------------------------------
  const dry = await post({ txs: ALL, note: NOTE });
  ok(dry.status === 200 && dry.json.write === false, `control: the token reads it, dry without write=1 (${dry.status})`);
  ok(dry.json.matched === 2 && dry.json.wouldMint === 2 && dry.json.minted === 0, `a dry run reports two sales it would mint (${dry.json.matched}, ${dry.json.wouldMint}, ${dry.json.minted})`);
  ok(dry.json.byPayer?.[SOL_PAYER]?.settlements === 1 && dry.json.byPayer?.[SOL_PAYER]?.usd === 0.05 && dry.json.byPayer?.[EVM_PAYER]?.settlements === 1 && dry.json.byPayer?.[EVM_PAYER]?.usd === 0.02, `per payer: a count and a total from the ledger (${JSON.stringify(dry.json.byPayer)})`);
  ok(dry.json.owedUsd === 0.07, `the total is the matched sales' ledger prices (${dry.json.owedUsd})`);
  ok(/private/.test(dry.cache || "") && /no-store/.test(dry.cache || ""), `the answer is private, no-store (${dry.cache})`);
  ok((await ledger()).length === 0, "a dry run records nothing");

  // --- who is skipped, by name ------------------------------------------------------
  ok(reasonOf(dry.json, UNKNOWN_TX) === "no_sale", `a tx with no sale is named and skipped (${reasonOf(dry.json, UNKNOWN_TX)})`);
  ok(reasonOf(dry.json, INTERNAL_TX) === "internal_sale", `an internal sale is named and skipped (${reasonOf(dry.json, INTERNAL_TX)})`);
  ok(reasonOf(dry.json, TWICE_TX) === "more_than_one_sale", `a tx recorded for two sales is named and skipped (${reasonOf(dry.json, TWICE_TX)})`);
  ok(dry.json.skipped.length === 3, `nothing else is skipped (${dry.json.skipped.length})`);
  const folded = await post({ txs: [SOL_TX.toLowerCase()], note: NOTE });
  ok(folded.json.matched === 0 && reasonOf(folded.json, SOL_TX.toLowerCase()) === "no_sale", "a signature in another case is not that sale: the tx is matched as stored");

  // --- refused requests -------------------------------------------------------------
  ok((await post({ txs: ALL }, { write: true })).status === 400, "a request with no note is a 400");
  ok((await post({ txs: ALL, note: " x " }, { write: true })).status === 400, "a note under three characters is a 400");
  ok((await post({ txs: [], note: NOTE }, { write: true })).status === 400, "an empty list is a 400");
  ok((await post({ note: NOTE }, { write: true })).status === 400, "a missing list is a 400");
  ok((await post({ txs: [EVM_TX, 7], note: NOTE }, { write: true })).status === 400, "a value that is not a string is a 400");
  const over = await post({ txs: Array.from({ length: 101 }, (_, i) => "0x" + i.toString(16).padStart(64, "0")), note: NOTE }, { write: true });
  ok(over.status === 400 && /max 100/.test(over.text), `a list over the cap is a 400, never a partial run (${over.status})`);
  ok((await ledger()).length === 0, "none of the refused requests recorded anything");

  // --- a sale the executor could not pay ----------------------------------------------
  const unpayable = await post({ txs: [NOPAYER_TX, ZERO_TX], note: NOTE });
  ok(unpayable.json?.matched === 0 && unpayable.json?.wouldMint === 0 && unpayable.json?.owedUsd === 0, `a sale with no payer and one at no price match nothing (${unpayable.json?.matched}, ${unpayable.json?.wouldMint})`);
  ok(reasonOf(unpayable.json, NOPAYER_TX) === "no_payer", `a sale with no payer is named and skipped (${reasonOf(unpayable.json, NOPAYER_TX)})`);
  ok(reasonOf(unpayable.json, ZERO_TX) === "no_amount", `a sale at no price is named and skipped (${reasonOf(unpayable.json, ZERO_TX)})`);
  const unpayableWrite = await post({ txs: [NOPAYER_TX, ZERO_TX], note: NOTE }, { write: true });
  ok(unpayableWrite.json?.minted === 0 && (await ledger()).length === 0, `and a write mints no row for either (${unpayableWrite.json?.minted})`);

  // --- only write=1 writes ------------------------------------------------------------
  for (const query of ["?write=0", "?write=true", "?write="]) {
    const r = await post({ txs: ALL, note: NOTE }, { query });
    ok(r.status === 200 && r.json?.write === false && r.json?.minted === 0 && r.json?.wouldMint === 2, `${query} is a dry run (write ${r.json?.write}, minted ${r.json?.minted})`);
  }
  ok((await ledger()).length === 0, "and none of those recorded anything");

  // --- write: the ledger row decides, never the request -----------------------------
  const ATTACKER = "0x000000000000000000000000000000000000beef";
  const wrote = await post({
    txs: ALL, note: NOTE,
    // None of these is read.
    payer: ATTACKER, priceUsd: 999, price: 999, slug: "something-else", network: "eip155:1",
    sales: [{ tx: EVM_TX, payer: ATTACKER, priceUsd: 999 }],
  }, { write: true });
  ok(wrote.status === 200 && wrote.json.write === true && wrote.json.minted === 2 && wrote.json.alreadyRecorded === 0, `a write mints one row per matched sale (${wrote.json?.minted})`);
  let rows = await ledger();
  ok(rows.length === 2 && rows.every((r) => r.status === "owed"), `the ledger holds two owed rows (${rows.length})`);
  const sol = rows.find((r) => r.evidence === SOL_TX), evm = rows.find((r) => r.evidence === EVM_TX);
  ok(sol?.payer === SOL_PAYER && sol.payer !== SOL_PAYER.toLowerCase(), `the base58 payer is the ledger's, byte for byte (${sol?.payer})`);
  ok(sol?.network === "solana" && sol?.slug === "json-diff" && sol?.priceUsd === 0.05, `its network, slug and price are the sale's (${sol?.network}, ${sol?.slug}, ${sol?.priceUsd})`);
  ok(evm?.payer === EVM_PAYER && evm?.priceUsd === 0.02 && evm?.slug === "web-search" && evm?.network === "base", `a payer, price, slug or network in the request is ignored (${evm?.payer}, ${evm?.priceUsd}, ${evm?.slug}, ${evm?.network})`);
  ok(!JSON.stringify(rows).includes("beef") && !rows.some((r) => r.priceUsd === 999), "nothing of the request's own fields reached the ledger");
  ok(rows.every((r) => r.note === NOTE), `the note is stored on each row (${rows[0]?.note})`);
  ok(!rows.some((r) => [INTERNAL_TX, UNKNOWN_TX, TWICE_TX].includes(r.evidence)), "no skipped tx has a row");

  // --- idempotent on the settle tx --------------------------------------------------
  const again = await post({ txs: ALL, note: "a second note" }, { write: true });
  ok(again.json.minted === 0 && again.json.alreadyRecorded === 2 && again.json.owedUsd === 0, `a second write mints nothing new (${again.json.minted}, ${again.json.alreadyRecorded})`);
  rows = await ledger();
  ok(rows.length === 2 && rows.every((r) => r.note === NOTE), "and leaves the two rows as they were");
  const dryAfter = await post({ txs: [EVM_TX, EVM_TX_2, EVM_TX_2], note: NOTE });
  ok(dryAfter.json.wouldMint === 1 && dryAfter.json.alreadyRecorded === 1 && reasonOf(dryAfter.json, EVM_TX_2) === "repeated_in_request", `a later dry run counts only the sale with no row yet, once (${dryAfter.json.wouldMint}, ${dryAfter.json.alreadyRecorded})`);

  // --- the pack backfill beside it is unchanged -------------------------------------
  const pack = await fetch(`${srv.url}/__operator/refunds/backfill`, { method: "POST", headers: AUTH });
  const pj = await pack.json();
  ok(pack.status === 200 && pj.write === false && Array.isArray(pj.slugs) && pj.settlements === 0 && pj.minted === 0, `the pack backfill answers its own report (${pack.status})`);
  ok((await ledger()).length === 2, "and recorded nothing");
} catch (e) {
  failed++;
  console.error(`FAIL - ${e?.stack || e}`);
  if (srv) console.error(srv.log().split("\n").slice(-25).join("\n"));
} finally {
  await srv?.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
