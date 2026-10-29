// Bounded burner -> treasury sweep. The SOR external router settles route-execute
// on BASE to the burner (the x402 spending wallet) so its float pays itself; this
// keeps that hot wallet BOUNDED by moving everything above a working float back to
// the treasury. Base only (that is the self-funding chain). Uses only the BURNER
// key — hot -> cold, never the treasury key.
//
// Gasless: the burner holds no native ETH, so we can't do a direct ERC-20
// transfer. Instead it BUYS one of our own tools (skill-company-dossier,
// treasury payTo) repeatedly, facilitator-sponsored — each settled buy moves
// that tool's Base price burner -> treasury. The per-buy amount is read from
// the tool's live 402 (the Base USDC accept), never typed here. We read the
// on-chain balance first and buy only enough to bring it down to the float, so
// a low-volume burner is left alone. MAX_CALLS bounds one run; a run it cuts
// short says so.
//
//   KEY_FILE=/path/to/burner-key TARGET_URL=https://agent402.tools \
//     SWEEP_FLOAT_USD=5 node scripts/sweep-burner.js
//
// Prints the derived burner ADDRESS, the balance and the per-buy amount BEFORE
// moving any money. The sizing math is tested offline by
// scripts/test-sweep-burner.js (which imports this file; nothing runs then).
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const BASE_CAIP2 = "eip155:8453";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_DECIMALS = 6;

/** The Base USDC accept in a decoded 402, or null when Base USDC is not offered. */
export function baseUsdcAccept(accepts) {
  return (Array.isArray(accepts) ? accepts : []).find((a) =>
    String(a?.network || "") === BASE_CAIP2 && String(a?.asset || "").toLowerCase() === USDC_BASE && /^\d+$/.test(String(a?.amount ?? ""))) || null;
}

/** How many buys bring `balanceAtomic` down to `floatAtomic`, at `unitAtomic`
 *  each, bounded by `maxCalls`. All amounts are USDC base units (BigInt). */
export function planSweep({ balanceAtomic, floatAtomic, unitAtomic, maxCalls }) {
  if (unitAtomic <= 0n) throw new Error("per-buy amount must be positive");
  const excess = balanceAtomic > floatAtomic ? balanceAtomic - floatAtomic : 0n;
  const wanted = excess / unitAtomic;
  const cap = BigInt(Math.max(0, Math.floor(Number(maxCalls) || 0)));
  const buys = wanted < cap ? wanted : cap;
  return { excess, wanted: Number(wanted), buys: Number(buys), capped: wanted > cap, plannedAtomic: buys * unitAtomic };
}

/** Base units -> a USD string with `dp` places (USDC, 6 decimals). */
export function usd(atomic, dp = 4) {
  return (Number(atomic) / 10 ** USDC_DECIMALS).toFixed(dp);
}

async function main() {
  const { disableVendorSpendControls } = await import("../src/x402-spend-controls.js");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

  const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
  const KEY_FILE = process.env.KEY_FILE || "/tmp/burner-key";
  const FLOAT_USD = Number(process.env.SWEEP_FLOAT_USD || "5");     // working float to leave in the burner
  const MAX_CALLS = parseInt(process.env.MAX_CALLS, 10) || 200;     // backstop
  const CALL_TIMEOUT_MS = 45000;
  const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const DENOM_URL = `${TARGET}/api/skill-company-dossier`;

  async function baseUsdcBalance(addr) {
    const data = `0x70a08231000000000000000000000000${addr.slice(2).toLowerCase()}`;
    const res = await fetch(BASE_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE, data }, "latest"] }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    if (!j.result || j.result === "0x") throw new Error(`balance read failed: ${JSON.stringify(j).slice(0, 120)}`);
    return BigInt(j.result);
  }

  const pk = readFileSync(KEY_FILE, "utf8").trim();
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  console.log(`Burner:  ${account.address}`);

  const client = disableVendorSpendControls(new x402Client());
  registerExactEvmScheme(client, { signer: account });
  const httpc = new x402HTTPClient(client);
  const denomInit = (i) => ({
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ company: `Sweep Co ${i}`, domain: "example.com" }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

  // The unpaid 402 for one buy: its Base USDC accept is what a buy signs.
  async function quote(init) {
    const bare = await fetch(DENOM_URL, init);
    if (bare.status !== 402) return { reason: `no-402 (HTTP ${bare.status})` };
    const body = await bare.json().catch(() => undefined);
    const pr = httpc.getPaymentRequiredResponse((n) => bare.headers.get(n), body);
    const accept = baseUsdcAccept(pr.accepts);
    return accept ? { pr, accept } : { reason: "base-usdc-not-offered" };
  }

  const first = await quote(denomInit(0));
  if (!first.accept) { console.log(`Cannot size the sweep: ${first.reason}. Nothing moved.`); process.exit(1); }
  const unitAtomic = BigInt(first.accept.amount);

  const before = await baseUsdcBalance(account.address);
  const floatAtomic = BigInt(Math.round(FLOAT_USD * 10 ** USDC_DECIMALS));
  console.log(`Balance: $${usd(before)} USDC on Base · float $${FLOAT_USD.toFixed(2)} · per buy $${usd(unitAtomic, 6)} (live 402)`);
  const plan = planSweep({ balanceAtomic: before, floatAtomic, unitAtomic, maxCalls: MAX_CALLS });
  if (plan.buys < 1) { console.log(`Nothing to sweep (excess $${usd(plan.excess)} < one $${usd(unitAtomic, 6)} buy). Done.`); process.exit(0); }
  console.log(`Sweeping up to $${usd(plan.plannedAtomic, 2)} (${plan.buys} x $${usd(unitAtomic, 6)}) Base -> treasury, leaving ~$${FLOAT_USD.toFixed(2)} float.`);
  if (plan.capped) console.log(`MAX_CALLS=${MAX_CALLS} covers ${plan.buys} of the ${plan.wanted} buys the excess needs; run again (or raise MAX_CALLS) for the rest.`);
  console.log("");

  // A buy is settled only on a final status below 400: the server cancels
  // settlement for any handler error and answers 402 when settlement fails.
  async function payOnBase(i) {
    const q = i === 0 ? first : await quote(denomInit(i));
    if (!q.accept) return { settled: false, reason: q.reason };
    const payload = await client.createPaymentPayload({ ...q.pr, accepts: [q.accept] });
    const payHeaders = httpc.encodePaymentSignatureHeader(payload);
    const init = denomInit(i);
    const paid = await fetch(DENOM_URL, { ...init, headers: { ...(init.headers || {}), ...payHeaders } });
    return paid.status < 400 ? { settled: true, atomic: BigInt(q.accept.amount) } : { settled: false, reason: `HTTP ${paid.status}` };
  }

  let settled = 0, settledAtomic = 0n, fails = 0;
  for (let i = 0; i < plan.buys; i++) {
    let r;
    try { r = await payOnBase(i); }
    catch (e) { r = { settled: false, reason: String(e.message).slice(0, 60) }; }
    if (r.settled) { settled++; settledAtomic += r.atomic; fails = 0; process.stdout.write(`.`); }
    else if (++fails >= 3) { console.log(`\nstopping: ${r.reason || "settlement failed"} (balance may be at float, or facilitator unavailable)`); break; }
  }

  const after = await baseUsdcBalance(account.address).catch(() => null);
  console.log(`\n\n============ SWEEP COMPLETE ============`);
  console.log(`Settled $${usd(settledAtomic, 6)} burner -> treasury (${settled} buys).`);
  if (after != null) console.log(`Burner balance now: $${usd(after)} USDC on Base (down $${usd(before - after, 6)}).`);
  console.log(`Treasury tally: ${TARGET}/api/stats`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
