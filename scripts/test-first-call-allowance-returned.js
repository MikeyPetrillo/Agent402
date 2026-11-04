// First-call allowance, returning grant holders (operator view): of the
// wallets with a served grant, how many later made an outside paid sale, and
// how many within 7 days of the grant. Offline, no Redis, no database.
//
// Part A drives the real assembly (firstCallAllowanceStatus with `returned`)
// against a stub grant store and a stub ledger reader that applies the rules
// itself only where the ledger does (outside, paid, strictly after):
//   - 3 granted wallets: one pays 2 days after its grant, one 9 days after,
//     one never: granted 3, paidAgain 2, paidAgainWithin7d 1;
//   - a reader that hands back the grant's own moment is not counted;
//   - a mixed-case EVM grant id matches the lowercased ledger payer;
//   - a non-EVM payer is passed case-exact, never folded;
//   - the figure is reported with the switch off;
//   - the cache returns the same object inside its window, recomputes after.
// Part B runs the real ledger query (src/sales-ledger.js
// firstPaidSaleAfterAsync) on a temporary SQLite ledger: internal sales, sales
// before the grant and free (proof-of-work) rows never count, a mixed-case EVM
// payer matches, a lowercased Solana address does not, and chunking gives the
// same answer as one query.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.STATE_DATABASE_URL;
delete process.env.FIRST_CALL_ALLOWANCE;
const dir = mkdtempSync(join(tmpdir(), "fca-returned-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");

const m = await import("../src/first-call-allowance.js");
const ledger = await import("../src/sales-ledger.js");

let pass = 0, failed = 0;
const ok = (c, msg) => { if (c) { pass++; console.log(`ok - ${msg}`); } else { failed++; console.error(`FAIL - ${msg}`); } };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 4, 0, 0, 0);
const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);
const MIXED = "0xAbCdEf" + "0".repeat(34);
const SOL = "So1anaPayerAddressCaseMatters1111111111111";

// ---- Part A: stub grant store and stub ledger ----
function stubLedger(sales) {
  // sales: [{ payer, ts, internal }]; the reader returns, per granted payer,
  // its first sale strictly after the grant that is not internal: what the
  // real query does (its own rules are proven in part B).
  const calls = [];
  const reader = async (grants) => {
    calls.push(grants.map((g) => ({ ...g })));
    const out = new Map();
    for (const g of grants) {
      const hits = sales.filter((s) => s.payer === g.payer && !s.internal && s.ts > g.grantedAtMs).map((s) => s.ts);
      if (hits.length) out.set(g.payer, Math.min(...hits));
    }
    return out;
  };
  reader.calls = calls;
  return reader;
}
const grantsOf = (rows) => async () => ({ grants: rows, complete: true });

m._resetFirstCallAllowance();
{
  const listGrants = grantsOf([
    { payer: A, grantedAtMs: T0 },
    { payer: B, grantedAtMs: T0 + DAY },
    { payer: C, grantedAtMs: T0 + 2 * DAY },
  ]);
  const reader = stubLedger([
    { payer: A, ts: T0 - DAY, internal: 0 }, // before the grant
    { payer: A, ts: T0 + 2 * DAY, internal: 0 }, // 2 days after
    { payer: B, ts: T0 + DAY + 3 * 3600_000, internal: 1 }, // internal
    { payer: B, ts: T0 + 10 * DAY, internal: 0 }, // 9 days after
  ]);
  const st = await m.firstCallAllowanceStatus({ now: T0 + 20 * DAY, returned: { listGrants, firstPaidAfter: reader } });
  const r = st.returnedPayers;
  ok(st.enabled === false && st.status === "off", "switch off: status reads off");
  ok(r && r.granted === 3, `granted counts every served grant (${r?.granted})`);
  ok(r?.paidAgain === 2, `paidAgain counts the 2-day and 9-day returns (${r?.paidAgain})`);
  ok(r?.paidAgainWithin7d === 1, `paidAgainWithin7d counts only the 2-day return (${r?.paidAgainWithin7d})`);
  ok(r?.sinceIso === new Date(T0).toISOString(), "sinceIso is the earliest grant");
  ok(r?.asOf === new Date(T0 + 20 * DAY).toISOString(), "asOf is the computation time");
  ok(r?.complete === true, "complete reads true for a full grant list");
  ok(reader.calls.length === 1 && reader.calls[0].length === 3, "one batched ledger read for all granted wallets");
}

// The free call's own moment, handed back by a reader, never counts.
m._resetFirstCallAllowance();
{
  const reader = async () => new Map([[A, T0]]);
  const st = await m.firstCallAllowanceStatus({ now: T0 + DAY, returned: { listGrants: grantsOf([{ payer: A, grantedAtMs: T0 }]), firstPaidAfter: reader } });
  ok(st.returnedPayers.paidAgain === 0 && st.returnedPayers.paidAgainWithin7d === 0, "a sale at the grant's own moment does not count");
}

// Mixed-case EVM matches; non-EVM is passed case-exact.
m._resetFirstCallAllowance();
{
  const reader = stubLedger([
    { payer: MIXED.toLowerCase(), ts: T0 + DAY, internal: 0 },
    { payer: SOL.toLowerCase(), ts: T0 + DAY, internal: 0 },
  ]);
  const st = await m.firstCallAllowanceStatus({ now: T0 + 2 * DAY, returned: { listGrants: grantsOf([{ payer: MIXED, grantedAtMs: T0 }, { payer: SOL, grantedAtMs: T0 }]), firstPaidAfter: reader } });
  const passed = reader.calls[0].map((g) => g.payer);
  ok(passed.includes(MIXED.toLowerCase()), "a mixed-case EVM grant is read lowercased");
  ok(passed.includes(SOL) && !passed.includes(SOL.toLowerCase()), "a non-EVM payer is passed case-exact");
  ok(st.returnedPayers.granted === 2 && st.returnedPayers.paidAgain === 1, `only the EVM wallet matches (${st.returnedPayers.paidAgain})`);
}

// Cache: same object inside the window, recomputed after it.
m._resetFirstCallAllowance();
{
  const reader = stubLedger([]);
  const seams = { listGrants: grantsOf([{ payer: A, grantedAtMs: T0 }]), firstPaidAfter: reader };
  const one = await m.returnedPayersStatus({ ...seams, now: T0 + DAY });
  const two = await m.returnedPayersStatus({ ...seams, now: T0 + DAY + m.RETURNED_CACHE_MS - 1 });
  ok(one === two && reader.calls.length === 1, "inside the cache window: the same object, no second read");
  const three = await m.returnedPayersStatus({ ...seams, now: T0 + DAY + m.RETURNED_CACHE_MS });
  ok(three !== one && reader.calls.length === 2 && three.asOf === new Date(T0 + DAY + m.RETURNED_CACHE_MS).toISOString(), "after the window: recomputed");
  // Concurrent asks share one computation.
  m._resetFirstCallAllowance();
  const before = reader.calls.length;
  const [x, y] = await Promise.all([m.returnedPayersStatus({ ...seams, now: T0 }), m.returnedPayersStatus({ ...seams, now: T0 })]);
  ok(x === y && reader.calls.length === before + 1, "concurrent asks share one computation");
}

// No `returned`: the public word's caller never computes it.
m._resetFirstCallAllowance();
{
  const st = await m.firstCallAllowanceStatus();
  ok(!("returnedPayers" in st), "without `returned` the figure is not computed");
}

// A failing reader is reported, not cached.
m._resetFirstCallAllowance();
{
  let n = 0;
  const seams = { listGrants: grantsOf([{ payer: A, grantedAtMs: T0 }]), firstPaidAfter: async () => { n++; throw new Error("ledger down"); } };
  const st = await m.firstCallAllowanceStatus({ now: T0, returned: seams });
  ok(st.returnedPayers?.error === "ledger down", "a failed read reads as an error field");
  await m.firstCallAllowanceStatus({ now: T0 + 1, returned: seams });
  ok(n === 2, "a failed read is not cached");
}

// Without the state database there are no grant records to read.
{
  const r = await m.listServedGrants();
  ok(r.grants.length === 0 && r.complete === true, "no state database: no grants listed");
}

// ---- Part B: the real ledger query ----
const now = Date.now();
const SOL_REAL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const D = "0x" + "d4".repeat(20);
const E = "0x" + "e5".repeat(20);
ledger.recordSale({ slug: "web-search", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: A, tx: "0x01" });
ledger.recordSale({ slug: "web-search", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: B, tx: "0x02" });
ledger.recordSale({ slug: "web-search", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: C, tx: "0x03", synthetic: true });
ledger.recordSale({ slug: "web-search", priceUsd: 0.01, rail: "pow", payer: D });
ledger.recordSale({ slug: "web-search", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: MIXED, tx: "0x04" });
ledger.recordSale({ slug: "web-search", priceUsd: 0.01, rail: "usdc", network: "solana", payer: SOL_REAL, tx: "sol1" });
ledger.recordSale({ slug: "web-search", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: E, tx: "0x05" });
await ledger.salesLedgerFlush?.();
const grants = [
  { payer: A, grantedAtMs: now - 2 * DAY }, // paid after
  { payer: B, grantedAtMs: now - 9 * DAY }, // paid after, past 7 days
  { payer: C, grantedAtMs: now - DAY }, // internal only
  { payer: D, grantedAtMs: now - DAY }, // free row only
  { payer: MIXED, grantedAtMs: now - DAY }, // mixed case
  { payer: SOL_REAL.toLowerCase(), grantedAtMs: now - DAY }, // folded non-EVM: no match
  { payer: E, grantedAtMs: now + DAY }, // sale before the grant
];
const map = await ledger.firstPaidSaleAfterAsync(grants);
ok(map.has(A) && map.has(B), "real ledger: paid sales after the grant are found");
ok(!map.has(C), "real ledger: an internal sale does not count");
ok(!map.has(D), "real ledger: a proof-of-work row does not count");
ok(map.has(MIXED.toLowerCase()), "real ledger: a mixed-case EVM payer matches");
ok(!map.has(SOL_REAL.toLowerCase()) && !map.has(SOL_REAL), "real ledger: a case-folded Solana address does not match");
ok(!map.has(E), "real ledger: a sale before the grant does not count");
const chunked = await ledger.firstPaidSaleAfterAsync(grants, { chunk: 2 });
ok(JSON.stringify([...chunked].sort()) === JSON.stringify([...map].sort()), "real ledger: chunked reads give the same answer");
const exact = await ledger.firstPaidSaleAfterAsync([{ payer: SOL_REAL, grantedAtMs: now - DAY }]);
ok(exact.has(SOL_REAL), "real ledger: the case-exact Solana address matches");

m._resetFirstCallAllowance();
const st = await m.firstCallAllowanceStatus({ returned: { listGrants: grantsOf(grants), firstPaidAfter: ledger.firstPaidSaleAfterAsync } });
const r = st.returnedPayers;
ok(r.granted === 7 && r.paidAgain === 3 && r.paidAgainWithin7d === 2, `assembled over the real ledger: 7 granted, 3 paid again, 2 within 7 days (${r.granted}/${r.paidAgain}/${r.paidAgainWithin7d})`);

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
