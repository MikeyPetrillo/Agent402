// Offline: the burner sweep's sizing math (scripts/sweep-burner.js). The
// per-buy amount comes from the tool's live 402, the number of buys from the
// excess over the float, and a run MAX_CALLS cuts short says so. Importing the
// script runs nothing (its main is guarded); no key, no network, no spend.
import { planSweep, baseUsdcAccept, usd } from "./sweep-burner.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const u = (dollars) => BigInt(Math.round(dollars * 1e6));

// The per-buy amount is the Base USDC accept's, whatever the tool costs.
const accepts = [
  { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "37000" },
  { network: "eip155:8453", asset: "0x0000000000000000000000000000000000000001", amount: "1" },
  { network: "eip155:8453", asset: USDC, amount: "37000" },
];
ok(baseUsdcAccept(accepts)?.amount === "37000", "the Base USDC accept is picked (not another chain or asset)");
ok(baseUsdcAccept([{ network: "eip155:137", asset: USDC, amount: "1" }]) === null, "no Base USDC accept -> null (the sweep refuses to size)");

// $12.50 balance, $5 float, $0.037 per buy: 202 buys move $7.474, not 15 x $0.50.
let p = planSweep({ balanceAtomic: u(12.5), floatAtomic: u(5), unitAtomic: 37000n, maxCalls: 500 });
ok(p.buys === 202 && p.plannedAtomic === 7_474_000n && !p.capped, `excess $7.50 at $0.037 -> 202 buys, $7.474 (got ${p.buys}, $${usd(p.plannedAtomic, 6)})`);
ok(u(12.5) - p.plannedAtomic >= u(5) && u(12.5) - p.plannedAtomic - u(5) < 37000n, "the sweep never dips below the float and leaves less than one buy above it");

// MAX_CALLS bounds a run and says so.
p = planSweep({ balanceAtomic: u(12.5), floatAtomic: u(5), unitAtomic: 37000n, maxCalls: 200 });
ok(p.buys === 200 && p.wanted === 202 && p.capped && p.plannedAtomic === 7_400_000n, `MAX_CALLS 200 caps 202 wanted buys and reports it (got ${p.buys}/${p.wanted}, capped ${p.capped})`);

// Under one buy above the float, or under the float: nothing moves.
ok(planSweep({ balanceAtomic: u(5.03), floatAtomic: u(5), unitAtomic: 37000n, maxCalls: 200 }).buys === 0, "excess under one buy -> no buys");
ok(planSweep({ balanceAtomic: u(3), floatAtomic: u(5), unitAtomic: 37000n, maxCalls: 200 }).buys === 0, "balance under the float -> no buys");
let threw = false;
try { planSweep({ balanceAtomic: u(10), floatAtomic: u(5), unitAtomic: 0n, maxCalls: 200 }); } catch { threw = true; }
ok(threw, "a zero per-buy amount is refused, never a divide by zero");
ok(usd(7_474_000n, 6) === "7.474000" && usd(37000n, 6) === "0.037000", "USDC base units print as dollars");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
