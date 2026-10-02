// H-01/H-03: one lever halts every signing path, and the daily ceiling survives
// a restart.
//
// Both halves run their CONTROL FIRST. A guard that only ever refuses would pass
// while proving nothing, and a persistence test whose ceiling never refuses in
// the first place proves nothing either.
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A hang in this file once cost a CI lane 59 minutes before the job timed out.
// Fail fast instead: if the suite has not finished in 60 s something is stuck,
// and a stuck test should say so rather than burn a runner.
const watchdog = setTimeout(() => {
  console.error("FAIL - test-signing-halt did not finish within 60s (something is blocking)");
  process.exit(1);
}, 60_000);
watchdog.unref();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ── H-01: the halt ──────────────────────────────────────────────────────────
const { signingHalted, assertSigningAllowed } = await import("../src/signing-halt.js");
const halted = (v) => { process.env.SIGNING_HALTED = v; return signingHalted(); };

ok(halted("") === false, "control: unset permits signing");
ok(halted("off") === false, "explicit off permits signing");
ok(halted("false") === false, "false permits signing");
ok(halted("0") === false, "0 permits signing");

ok(halted("1") === true, "1 halts");
ok(halted("true") === true, "true halts");
ok(halted("  ON  ") === true, "whitespace and case tolerated");
// The property that matters most: a typo must stop spending, not permit it.
ok(halted("disabled") === true, "a MALFORMED value HALTS - fails closed, never open");
ok(halted("no-really-off") === true, "an almost-off value halts");

process.env.SIGNING_HALTED = "1";
try { assertSigningAllowed("a test payment"); ok(false, "halted state throws"); }
catch (e) {
  // 503 and not 4xx: a halt is our configuration, not the caller's error, and a
  // status >= 400 already cancels settlement so nobody pays to meet it.
  ok(e.statusCode === 503, `the refusal is 503, not ${e.statusCode}`);
  ok(/not attempted/i.test(e.message) && /Nothing was charged/i.test(e.message),
    "the refusal states nothing was charged");
}
process.env.SIGNING_HALTED = "";
try { assertSigningAllowed("x"); ok(true, "permitted state does not throw"); }
catch { ok(false, "permitted state does not throw"); }

// EVERY signing path consults it, pinned from source: a new signing path added
// without the check fails here rather than shipping unguarded.
const MUST_GUARD = [
  "src/x402-buyer.js", "src/solana-buyer.js", "src/tempo-buyer.js",
  "src/tools/attest-kit.js", "src/mpp-subscriptions.js",
];
for (const f of MUST_GUARD) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  ok(/assertSigningAllowed\(/.test(src), `${f} consults the halt`);
}

// ── H-03: the ceiling survives a restart ────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "spendguard-"));
process.env.WALLET_DAILY_LEDGER_FILE = join(dir, "wallet-daily-spend.json");
process.env.SOR_WALLET_DAILY_MAX_USD = "1.00";

const g1 = await import("../src/external-spend-guard.js?boot=1");
const h = g1.maySpend("0xpayer-a", 0.90, { chain: "base" });
ok(h && h.ok !== false, "control: a first spend under the cap is permitted");
g1.noteSpend("0xpayer-a", 0.90, { chain: "base" });
const refused = g1.maySpend("0xpayer-b", 0.90, { chain: "base" });
ok(refused?.ok === false, "control: the chain ceiling refuses once the day is spent");

await new Promise((r) => setTimeout(r, 2400));
ok(existsSync(process.env.WALLET_DAILY_LEDGER_FILE), "the chain ledger reached disk");

// A fresh module instance IS a restart.
const g2 = await import("../src/external-spend-guard.js?boot=2");
const after = g2.maySpend("0xpayer-c", 0.90, { chain: "base" });
ok(after?.ok === false, "after a RESTART the day is still spent - the ceiling did not reset");

// ── H-02: every signed payment leaves a per-payment record ──────────────────
{
  const dir2 = mkdtempSync(join(tmpdir(), "outbound-"));
  process.env.OUTBOUND_LEDGER_FILE = join(dir2, "outbound-spend.ndjson");
  const { recordOutbound } = await import("../src/outbound-ledger.js");

  recordOutbound({ chain: "base", payTo: "0xdead", amountAtomic: "1000", asset: "0xusdc",
                   usd: 0.001, slug: "route-execute", origin: "https://seller.example/x?key=SHOULD_NOT_APPEAR",
                   result: "delivered", tx: "0xabc" });
  // The branch that previously recorded nothing at all.
  recordOutbound({ chain: "base", payTo: "0xdead", amountAtomic: "1000",
                   usd: 0.001, slug: "route-execute", origin: "seller.example", result: "undelivered" });

  const raw = readFileSync(process.env.OUTBOUND_LEDGER_FILE, "utf8");
  const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
  ok(rows.length === 2, `both payments recorded (${rows.length})`);
  ok(rows[1].result === "undelivered", "an UNDELIVERED payment is recorded - the money still left");
  ok(rows.every((r) => r.chain && r.payTo && r.amountAtomic && r.at), "every row carries when/chain/destination/amount");
  // A full URL can carry a secret in its query; only the host is kept.
  ok(!raw.includes("SHOULD_NOT_APPEAR") && rows[0].origin === "seller.example",
    "the origin is reduced to a host - a query string never reaches the ledger");
  for (const bad of ["signature", "privatekey", "authorization", "payment-signature", "mnemonic"]) {
    ok(!raw.toLowerCase().includes(bad), `no "${bad}" in the ledger`);
  }

  // Bookkeeping must never throw into a payment path that already committed.
  //
  // The unwritable path is a file used as a directory, which fails ENOTDIR
  // immediately on every platform. An earlier version used /proc/nonexistent:
  // macOS has no /proc so it returned at once, while on Linux the recursive
  // mkdir into procfs BLOCKED, and this test hung a CI lane for 59 minutes
  // before the job timed out. Never reach for a kernel filesystem to get a
  // predictable failure.
  const blocker = join(dir2, "not-a-directory");
  writeFileSync(blocker, "x");
  process.env.OUTBOUND_LEDGER_FILE = join(blocker, "x.ndjson");
  const { recordOutbound: r2 } = await import("../src/outbound-ledger.js?fresh=1");
  try { r2({ chain: "base", payTo: "0x1", amountAtomic: "1", result: "delivered" }); ok(true, "an unwritable ledger does not throw into the payment path"); }
  catch { ok(false, "an unwritable ledger does not throw into the payment path"); }

  // Pinned from source: all three outcome branches record.
  const buyer = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  // Delivered and undelivered only. A refusal the CHAIN proved unpaid releases
  // the hold - no value moved - so recording it in a SPEND ledger would
  // overstate what the wallet actually paid; noteSellerRefusal already tracks
  // it. The first cut recorded it and that was a counting error, not a gap.
  for (const r of ["delivered", "undelivered"]) {
    ok(new RegExp(`result: "${r}"`).test(buyer), `payX402 records the "${r}" outcome`);
  }
  ok(!/result: "refused"/.test(buyer),
    "a chain-proven refusal is NOT recorded as spend - no value moved");
}

// ── H-05: one request may not cause unbounded signatures ────────────────────
{
  const src = readFileSync(new URL("../src/tools/route-execute.js", import.meta.url), "utf8");
  ok(/MAX_PAID_ATTEMPTS/.test(src), "route-execute bounds paid attempts per request");
  ok(/__paidAttempts >= MAX_PAID_ATTEMPTS/.test(src), "the bound is checked BEFORE the pay call");
  ok(/__paidAttempts\+\+/.test(src), "only a signed attempt increments the counter");
  // The counter must be incremented at the pay site, not at the top of the loop,
  // or a candidate skipped at resolution would consume the budget.
  // The increment must be gated on payX402's own `committed` stamp, not placed
  // before the call: a pre-payment failure (unreachable seller, SSRF refusal,
  // over cap) signed nothing, and counting it would let two cheap misses starve
  // a legitimate retry. The first cut of this patch got that wrong and
  // test-route-execute caught it.
  ok(/if \(spentMaybe \|\| unanswered\) __paidAttempts\+\+/.test(src),
    "only a COMMITTED payment increments the counter (pre-payment failures are free)");
  ok(!/__paidAttempts\+\+[\s\S]{0,200}?paid = await payExternal/.test(src),
    "the counter is not incremented before the pay call");
  ok(/n >= 1 && n <= 10 \? n : 1/.test(src), "a malformed SOR_MAX_PAID_ATTEMPTS reads as 1, never unlimited");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
