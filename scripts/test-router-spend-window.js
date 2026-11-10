// The router's per-minute ceilings on what its spending wallet holds for
// outside sellers (src/router-spend-window.js, read by reserveSpend in
// src/x402-buyer.js): past SOR_SPEND_CAP_ATOMIC a purchase is still made and
// the status word reads over; a purchase that would pass
// SOR_SPEND_HARD_CAP_ATOMIC is refused 429 before anything is signed and the
// word reads capped; each word holds an hour and then reads ok; 0 is the
// switch; the public word carries no figure.
//
// Purchases run through the real payer (payX402) against a stubbed fetch, a
// throwaway key and no chain. Nothing is sent or paid. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "router-spend-window-test-"));
process.env.OUTBOUND_LEDGER_FILE = join(dir, "outbound-spend.ndjson");
process.env.MEMORY_DB_FILE = join(dir, "memory.db");
process.env.WALLET_DAILY_LEDGER_FILE = join(dir, "wallet-daily.json");
process.env.SOR_ROUTER_PURCHASES_FILE = join(dir, "router-purchases.json");
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
const EACH = 1000n; // one purchase, atomic USDC
const ALARM = 2n * EACH;
process.env.SOR_SPEND_CAP_ATOMIC = String(ALARM);
delete process.env.SOR_SPEND_HARD_CAP_ATOMIC;
const warn = console.warn; const logged = [];
console.warn = (...a) => { logged.push(a.join(" ")); };

(await import("../src/tools/sanctions-kit.js")).__seedPayoutListForTests();
const buyer = await import("../src/x402-buyer.js");
const W = await import("../src/router-spend-window.js");
const { HARD_MULTIPLIER, REFUSAL_HOLD_MS } = await import("../src/daily-ceilings.js");
buyer.__setBuyerAddressGuardForTest(false); // the seller is a stub

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const origFetch = globalThis.fetch;

// --- the two ceilings ----------------------------------------------------------
{
  const c = (alarm, hard) => { const r = W.spendWindowCeilings({ SOR_SPEND_CAP_ATOMIC: alarm, SOR_SPEND_HARD_CAP_ATOMIC: hard }); return [r.alarmAtomic, r.hardAtomic]; };
  const M = BigInt(HARD_MULTIPLIER);
  const [dflt] = c(undefined, undefined);
  ok(dflt > 0n && c(undefined, undefined)[1] === dflt * M, "unset: the default alarm, and the stop at the documented multiple of it");
  ok(c("3000", undefined).join() === [3000n, 3000n * M].join(), "the configured value is the alarm; the stop defaults to the multiple");
  ok(c("3000", "4000").join() === "3000,4000", "the stop has its own variable");
  ok(c("3000", "10")[1] === 3000n, "a stop under the alarm reads as the alarm");
  for (const bad of ["", "  ", "abc", "-5", "1.5", "0x10", "9".repeat(40)]) ok(c(bad, bad).join() === [dflt, dflt * M].join(), `a blank or malformed value (${JSON.stringify(bad.slice(0, 8))}) reads as the default, never as off`);
  ok(c("3000", "0")[1] === 3000n * M, "a stop of 0 reads as the default stop");
  ok(c("0", "5000").join() === "0,0", "an alarm of 0 is the switch");
}

// --- through the payer -----------------------------------------------------------
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const accept = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: String(EACH), payTo: "0x" + "ef".repeat(20), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
const challenge = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [accept] })).toString("base64");
let paidSends = 0;
globalThis.fetch = async (_url, init) => {
  if (init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.["X-PAYMENT"]) { paidSends++; return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); }
  return { status: 402, headers: { get: (k) => (k.toLowerCase() === "payment-required" ? challenge : null) }, json: async () => ({}), text: async () => "{}" };
};
const buy = () => buyer.payX402("https://seller.example/x", { maxAtomic: 5000n, method: "POST", body: {}, chain: "base", refusalMaxWaitMs: 0, notDebited: async () => ({ debited: false, observed: 0, expired: false }) })
  .then(() => 200, (e) => e.statusCode || `threw: ${e?.message}`);

try {
  W._resetSpendWindowMarks();
  ok(W.spendWindowWord() === "ok", "before any purchase the word reads ok");
  const first = [await buy(), await buy()];
  ok(first.join() === "200,200" && W.spendWindowWord() === "ok", `purchases up to the alarm are made and the word stays ok (${first}, ${W.spendWindowWord()})`);

  // The defect this suite pins: the third purchase of the minute is for a
  // paying buyer and used to answer 429.
  const third = await buy();
  ok(third === 200 && paidSends === 3, `a purchase past the alarm is made (${third}; ${paidSends} paid requests reached the seller)`);
  ok(W.spendWindowWord() === "over", `and the word reads over (${W.spendWindowWord()})`);
  ok(buyer._spentThisWindow() === 3n * EACH, "the hold past the alarm is counted, so the stop still sees it");
  ok(logged.filter((l) => /SOR_SPEND_CAP_ATOMIC/.test(l)).length === 1 && !/[0-9]/.test(String(logged.find((l) => /SOR_SPEND_CAP_ATOMIC/.test(l))).replace("[x402-buyer]", "")), "one log line, with no figure");

  // Up to the stop every purchase is made; the one that would pass it is not.
  const HARD = ALARM * BigInt(HARD_MULTIPLIER);
  const more = [];
  for (let i = 0; i < 50 && buyer._spentThisWindow() + EACH <= HARD; i++) more.push(await buy());
  ok(more.length > 0 && more.every((s) => s === 200) && buyer._spentThisWindow() === HARD, `every purchase up to the stop is made (${more.length} more, all 200)`);
  ok(W.spendWindowWord() === "over", "and the word still reads over");
  ok(logged.filter((l) => /SOR_SPEND_CAP_ATOMIC/.test(l)).length === 1, "still one log line for the hold");
  const sentBefore = paidSends;
  const refused = await buy();
  ok(refused === 429 && paidSends === sentBefore, `the purchase that would pass the stop is refused 429 with nothing signed or sent (${refused})`);
  ok(buyer._spentThisWindow() === HARD, "and it holds nothing");
  ok(W.spendWindowWord() === "capped", `the word reads capped (${W.spendWindowWord()})`);

  // The public answer is the word alone; the operator view carries the ceilings.
  const pub = W.spendWindowStatus();
  ok(Object.keys(pub).join() === "status" && !/[0-9]/.test(JSON.stringify(pub)), `the public status is one word with no figure (${JSON.stringify(pub)})`);
  const op = W.spendWindowStatus({ full: true });
  ok(op.alarmAtomic === String(ALARM) && op.hardAtomic === String(HARD) && typeof op.overUntil === "string" && typeof op.cappedUntil === "string", "the operator view carries both ceilings and when each mark ends");

  // The word clears: each mark is held from its last occurrence, then reads ok.
  const t = Date.now();
  ok(W.spendWindowWord(t + REFUSAL_HOLD_MS - 5_000) === "capped", "inside the hold the word still reads capped");
  ok(W.spendWindowWord(t + REFUSAL_HOLD_MS + 5_000) === "ok", "past the hold the word reads ok");
  ok(W.spendWindowStatus({ full: true, now: t + REFUSAL_HOLD_MS + 5_000 }).cappedUntil === null, "and the operator view shows no mark");
  // over alone, on the clock: a refusal an hour old with a newer over minute.
  W._resetSpendWindowMarks();
  W.noteSpendWindowRefused(t, () => {});
  W.noteSpendWindowOver(t + REFUSAL_HOLD_MS - 60_000, () => {});
  ok(W.spendWindowWord(t + REFUSAL_HOLD_MS + 1) === "over", "once the refusal's hold ends a later over minute still reads over");
  ok(W.spendWindowWord(t + 2 * REFUSAL_HOLD_MS) === "ok", "and then ok");

  // The stop's own variable: a purchase is refused there and not before.
  W._resetSpendWindowMarks();
  process.env.SOR_SPEND_HARD_CAP_ATOMIC = String(HARD + 2n * EACH);
  const raised = [await buy(), await buy(), await buy()];
  ok(raised.join() === "200,200,429", `SOR_SPEND_HARD_CAP_ATOMIC moves the stop (${raised})`);
  delete process.env.SOR_SPEND_HARD_CAP_ATOMIC;

  // The switch: 0 refuses every purchase and the word reads off, not capped.
  W._resetSpendWindowMarks();
  process.env.SOR_SPEND_CAP_ATOMIC = "0";
  let off = null; try { buyer.reserveSpend("1"); } catch (e) { off = e; }
  ok(off?.statusCode === 429 && W.spendWindowWord() === "off", `0 refuses every purchase and reads off (${off?.statusCode}, ${W.spendWindowWord()})`);
  process.env.SOR_SPEND_CAP_ATOMIC = String(ALARM);
  ok(W.spendWindowWord() === "ok", "and the switch leaves no mark behind");
} finally {
  globalThis.fetch = origFetch;
  console.warn = warn;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\ntest-router-spend-window: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
