#!/usr/bin/env node
// Receipts: the caller's OWN settled payments, in the shape a finance system
// posts, and nobody else's.
//
// Two properties are the whole product and both are pinned here:
//
//   1. IDENTITY-BOUND BY THE SIGNATURE, NEVER A PARAMETER. The wallet comes
//      from the verified EIP-3009 authorization. A `wallet` field in the body
//      must change nothing - if it ever did, this route would be a way to read
//      any buyer's payables, which is the customer list we refuse to publish
//      anywhere else.
//
//   2. EVIDENCE SURVIVES. settlementTx, responseSha256 and attestationUid are
//      what make a row auditable by someone who does not trust us. A row that
//      drops them is just a number we assert.
//
// Offline: the ledger is driven directly with a temp database.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-receipts-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");

const { recordSale, payerReceipts } = await import("../src/sales-ledger.js");
const { USAGE_TOOLS } = await import("../src/tools/usage-kit.js");
const { isIdentityBoundRoute } = await import("../src/payments.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

const MINE = "0xaaaa000000000000000000000000000000000001";
const THEIRS = "0xbbbb000000000000000000000000000000000002";
const def = USAGE_TOOLS.find((t) => t.slug === "receipts");
ok(def, "the receipts tool exists");

// --- the route must be identity-bound, or a non-EVM buyer pays then is refused
ok(isIdentityBoundRoute(def), "receipts is identity-bound: it advertises EVM exact only, so a Solana or Stellar buyer is never charged for a call the server cannot answer");

// --- seed two payers plus an internal row -----------------------------------
recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "base", payer: MINE, tx: "0xtx1", wire: "x402", responseSha256: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae" });
recordSale({ slug: "v1-chat-metered", priceUsd: 0.642466, quoteUsd: 0.74, rail: "usdc", network: "base", payer: MINE, tx: "0xtx2", wire: "x402" });
recordSale({ slug: "seller-dossier", priceUsd: 0.05, rail: "usdc", network: "base", payer: THEIRS, tx: "0xtx3", wire: "x402" });
recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "base", payer: MINE, tx: "0xtx4", synthetic: true });

// --- 1. one payer sees only their own ---------------------------------------
{
  const r = payerReceipts(MINE, {});
  const items = r.rows.map((x) => x.item).sort();
  eq(items, ["hash", "v1-chat-metered"], "only this payer's EXTERNAL rows are returned");
  ok(!JSON.stringify(r).includes(THEIRS), "another payer's address appears nowhere");
  ok(!r.rows.some((x) => x.item === "uuid"), "an internal/synthetic row is not a purchase and is excluded");
  eq(r.wallet, MINE, "the wallet is echoed so a row set is self-describing");
  eq(r.currency, "USD", "the currency is stated rather than assumed");

  const theirs = payerReceipts(THEIRS, {});
  eq(theirs.rows.map((x) => x.item), ["seller-dossier"], "the other payer sees only theirs");
}

// --- 2. evidence survives ----------------------------------------------------
{
  const r = payerReceipts(MINE, {});
  const hash = r.rows.find((x) => x.item === "hash");
  eq(hash.settlementTx, "0xtx1", "the settlement transaction rides, so a row is checkable on-chain");
  eq(hash.responseSha256, "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae", "the hash of the delivered bytes rides");
  eq(payerReceipts(MINE, {}).rows.find((x) => x.item === "v1-chat-metered").responseSha256, null,
     "a row with no recorded digest says null - recordSale rejects anything that is not a full 64-hex sha256, so a partial value can never masquerade as evidence");
  ok("attestationUid" in hash, "the attestation field is always present, null when none was written");

  const metered = r.rows.find((x) => x.item === "v1-chat-metered");
  eq(metered.amountUsd, 0.642466, "the amount is what SETTLED");
  eq(metered.quotedUsd, 0.74, "the quoted ceiling rides beside it - the gap is what a buyer reconciles");
  eq(hash.quotedUsd, null, "a flat-priced row has no quote, and says null rather than repeating the price");
}

// --- 3. a body parameter can never redirect the read -------------------------
{
  // The handler derives the wallet from the request only. Passing someone
  // else's address as input must be inert - this is the assertion that keeps
  // the route from becoming a customer-list reader.
  const req = { headers: {}, __testPayer: MINE };
  const out = await def.handler({ wallet: THEIRS, payer: THEIRS, from: null }, {
    headers: { "payment-signature": "" },
    ...req,
  }).catch((e) => e);
  ok(out instanceof Error, "with no verifiable payer the handler REFUSES rather than falling back to a parameter");
  ok(/wallet that PAYS/i.test(out.message), "and the refusal explains that payment is the identity");
}

// --- 4. windows and truncation are stated, not implied -----------------------
{
  const r = payerReceipts(MINE, { limit: 1 });
  eq(r.rows.length, 1, "limit is honoured");
  eq(r.truncated, true, "a cut page SAYS it was cut - a consumer must never mistake a page for the period");
  eq(r.returned, 1, "`returned` is this page");
  eq(r.total, 2, "`total` is the WINDOW, uncapped - a LIMITed length published as a count is how a capped query once became a business figure, and here it would silently under-report payables");
  eq(payerReceipts(MINE, {}).truncated, false, "a complete page says so");
  ok(payerReceipts(MINE, { from: "not-a-date" }).error, "an unparseable window is an error, never a silent default");
  const empty = payerReceipts(MINE, { from: "2020-01-01", to: "2020-01-02" });
  eq(empty.total, 0, "a window with no activity is an honest zero");
  eq(empty.returned, 0, "and nothing returned");
  eq(empty.rows, [], "and an empty list, not a missing field");
}

// --- 5. CSV is importable and cannot execute --------------------------------
{
  const rows = payerReceipts(MINE, {}).rows;
  const { receiptsCsv } = await import("../src/tools/usage-kit.js").then((m) => ({ receiptsCsv: m.receiptsCsv }));
  ok(typeof receiptsCsv === "function", "the CSV formatter is exported so it can be tested without a paid request");
  const csv = receiptsCsv([...rows, { settledAt: "x", item: "=cmd|'/c calc'!A1", amountUsd: 1, quotedUsd: null, rail: 'a"b', network: "n,m", wire: null, settlementTx: null, responseSha256: null, attestationUid: null }]);
  const lines = csv.split("\n");
  eq(lines[0], '"settledAt","item","amountUsd","quotedUsd","rail","network","wire","settlementTx","responseSha256","attestationUid"', "a header row names every column");
  eq(lines.length, rows.length + 2, "one line per row plus the header");
  ok(csv.includes(`"'=cmd`), "a leading = is quote-prefixed: spreadsheet software EXECUTES those, and these rows carry third-party slugs");
  ok(csv.includes('"a""b"'), "an embedded quote is doubled");
  ok(csv.includes('"n,m"'), "a comma inside a field cannot shift a column");
}

rmSync(dir, { recursive: true, force: true });
console.log(`test-receipts: ${n} assertions OK`);
