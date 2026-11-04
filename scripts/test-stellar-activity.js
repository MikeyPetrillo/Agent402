// Offline unit tests for the Stellar activity scan's pure parts:
// parseStellarPayment (Horizon record → entry) and bucketStellarActivity
// (entries → per-day buckets + totals). No network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { parseStellarPayment, bucketStellarActivity, USDC_ISSUER } from "../src/revenue-live.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const WALLET = "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL";

// --- parseStellarPayment ---
const pay = { type: "payment", to: WALLET, from: "GBUYER1", asset_code: "USDC", asset_issuer: USDC_ISSUER, amount: "0.0010000", transaction_hash: "abc", created_at: "2026-07-10T04:15:00Z" };
let e = parseStellarPayment(pay, WALLET);
ok(e && e.usd === 0.001 && e.from === "GBUYER1" && e.tx.endsWith("/tx/abc"), "classic payment parsed");
ok(parseStellarPayment({ ...pay, to: "GOTHER" }, WALLET) === null, "payment to another wallet rejected");
ok(parseStellarPayment({ ...pay, asset_issuer: "GFAKEISSUER" }, WALLET) === null, "fake-issuer USDC rejected");
ok(parseStellarPayment({ ...pay, asset_code: "USDX" }, WALLET) === null, "non-USDC asset rejected");

const soroban = {
  type: "invoke_host_function", transaction_hash: "def", created_at: "2026-07-09T12:00:00Z", source_account: "GCHANNEL",
  asset_balance_changes: [
    { type: "transfer", to: WALLET, from: "GBUYER2", asset_code: "USDC", asset_issuer: USDC_ISSUER, amount: "0.0020000" },
    { type: "transfer", to: "GOTHER", from: "GBUYER2", asset_code: "USDC", asset_issuer: USDC_ISSUER, amount: "9.0" },
  ],
};
e = parseStellarPayment(soroban, WALLET);
ok(e && e.usd === 0.002 && e.from === "GBUYER2", "Soroban settlement parsed from balance changes (payer = change.from, not channel)");
ok(parseStellarPayment({ ...soroban, asset_balance_changes: [] }, WALLET) === null, "Soroban op with no inbound transfer rejected");
ok(parseStellarPayment({ type: "create_account", to: WALLET }, WALLET) === null, "unrelated op type rejected");

// --- bucketStellarActivity ---
const NOW = Date.parse("2026-07-10T12:00:00Z");
const entries = [
  { when: "2026-07-10T04:00:00Z", usd: 0.001, from: "GBUYER1" },
  { when: "2026-07-10T05:00:00Z", usd: 0.002, from: "GBUYER1" }, // same buyer, same day
  { when: "2026-07-09T10:00:00Z", usd: 0.01, from: "GBUYER2" },
  { when: "2026-06-30T00:00:00Z", usd: 0.05, from: "GBUYER3", internal: true },
  { when: "2026-05-01T00:00:00Z", usd: 99, from: "GOLD" }, // outside 30d window
  { when: "not-a-date", usd: 1, from: "GBAD" },
];
const a = bucketStellarActivity(entries, { days: 30, now: NOW });
ok(a.buckets.length === 30, "30 daily buckets");
ok(a.buckets[29].date === "2026-07-10" && a.buckets[0].date === "2026-06-11", "buckets ordered oldest → newest, ending today");
ok(a.totals.tx === 4, "out-of-window and unparseable-date entries excluded from totals");
ok(a.totals.usd === 0.063, "volume summed over the window");
ok(a.totals.buyers === 3, "buyers = unique wallets across window");
ok(a.totals.internalTx === 1 && a.totals.internalUsd === 0.05, "internal entries counted for the honesty caption");
const today = a.buckets[29];
ok(today.tx === 2 && today.usd === 0.003 && today.buyers === 1, "same-day duplicate buyer counted once per day");
const empty = bucketStellarActivity([], { days: 7, now: NOW });
ok(empty.buckets.length === 7 && empty.totals.tx === 0 && empty.totals.buyers === 0, "empty window is all zeros, never invented");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
