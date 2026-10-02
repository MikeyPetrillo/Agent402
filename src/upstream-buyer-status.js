// Upstream-buyer balance status: the gateway-credits pattern (llm-gateway-kit
// gatewayCreditsStatus) applied to the x402 SPENDING wallet on Base
// (X402_UPSTREAM_BUYER_KEY). route-execute and seller-payability pay external
// sellers in USDC from it; when that runs dry they refuse (buyers are never
// charged), so the heartbeat alarms on "low" BEFORE that happens.
//
// attest signs from the same wallet but pays Base gas in ETH, which this reads
// nothing about: a USDC-empty wallet does not stop it, and the ETH-empty wallet
// that does is invisible here. attest bounds its own gas (ATTEST_MAX_GAS_USD)
// and refuses 503 uncharged; do not read this status as covering it.
// Bucketed status only: the balance number never leaves the server. 5-min
// cache; public-RPC read with graceful "unknown" (an RPC flake must never page).
const BASE_RPCS = ["https://mainnet.base.org", "https://base.drpc.org"];
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Sized against the LARGEST single spend this wallet can be asked to make, not
// against the smallest.
//
// A small default was right when the only thing spending from here was a
// fraction-of-a-cent data purchase. Then route-execute-pro made a single call
// able to spend dollars upstream, and "ok" would have meant "holds more than
// the old floor" for a wallet that could not cover one call. The alarm would
// have stayed green right up to the failure it exists to prevent.
//
// Two largest-tier calls, so we are paged with room to top up rather than at
// the moment of starvation. MUST be re-sized whenever a bigger execution tier
// lands - locked by an assertion in scripts/test-route-execute.js, because a
// threshold that quietly stops covering the biggest call reports nothing.
export const BUYER_LOW_DEFAULT_USD = 6;

// THIS WALLET SHOULD NEVER GO DOWN, so a fall is worth more than a floor.
//
// The route-execute tiers that spend from it also settle INTO it:
// SELF_FUNDING_SLUGS sets payTo to this address for exactly those tools
// (payments.js acceptsForItem), and every execution tier charges more than it
// can spend. seller-payability and attest are NOT in that set - they spend
// without refilling - which is why the fall has a tolerance and has to persist
// across reads rather than tripping on the first dip. So the trend a healthy
// wallet shows is flat or rising, and a SUSTAINED fall past the tolerance
// means something we do not understand is happening: the verify-then-fail-to-
// settle drain, a spend whose revenue never arrived, or a withdrawal nobody
// mentioned.
//
// A low-water alarm fires after the money is gone. This fires on the first
// unexplained dollar, which is the whole difference.
//
// It must tolerate a TRANSIENT dip, because settlement ordering guarantees one:
// we pay the seller during the handler and collect afterwards, so the balance
// is legitimately lower in between. Hence a high-water mark, a tolerance, and a
// requirement that the fall persist across consecutive reads (each 5 min apart)
// before it is called draining.
const BUYER_DROP_TOLERANCE_USD = Number(process.env.UPSTREAM_BUYER_DROP_TOLERANCE_USD || 0.5);
const BUYER_DROP_READS = Number(process.env.UPSTREAM_BUYER_DROP_READS || 3);
let buyerHighWater = null;
let buyerBelowReads = 0;

/** Bucketed trend for the spending wallet: "ok" | "draining". Never a number -
 *  /api/gateway-status is public and balances stay off it. Exported for tests. */
export function noteBuyerBalance(balance, { reset = false } = {}) {
  if (reset) { buyerHighWater = null; buyerBelowReads = 0; }
  if (!Number.isFinite(balance)) return "unknown";
  if (buyerHighWater == null || balance >= buyerHighWater) {
    // A new high (or the first read) is the healthy case: re-baseline and clear.
    buyerHighWater = balance;
    buyerBelowReads = 0;
    return "ok";
  }
  if (buyerHighWater - balance <= BUYER_DROP_TOLERANCE_USD) {
    // Within tolerance: an in-flight call, not a drain. Do NOT reset the
    // counter - a slow bleed sits inside tolerance on every single read.
    return buyerBelowReads >= BUYER_DROP_READS ? "draining" : "ok";
  }
  buyerBelowReads += 1;
  return buyerBelowReads >= BUYER_DROP_READS ? "draining" : "ok";
}
const BUYER_LOW_USD = () => Number(process.env.UPSTREAM_BUYER_LOW_USD || String(BUYER_LOW_DEFAULT_USD));
const BUYER_STATUS_CACHE_MS = 5 * 60_000;
let buyerStatusCache = null;
/** Bucketed BALANCE of the Base spending wallet. Nothing more.
 *
 *  Read the name carefully, because it has already misled once: upstream
 *  purchases failed on the paid retry while this reported "ok", and "ok" was
 *  read as "the buying path is healthy". It does not mean that. It means the
 *  wallet holds USDC above a threshold.
 *
 *  It cannot see whether the seller answers, whether the facilitator settles,
 *  whether our payload is accepted, or whether the quote fits the margin cap.
 *  Every one of those fails happily with a full wallet.
 *
 *  Each return carries `attests: "balance-only"` so a consumer cannot mistake
 *  the scope for the name. An alarm wired to this is a FUNDING alarm; proving
 *  that buying works needs a real buy, which is what the paid canary is for. */
export async function upstreamBuyerStatus() {
  const pk = (process.env.X402_UPSTREAM_BUYER_KEY || "").trim();
  if (!pk) return { configured: false, status: "unconfigured", attests: "balance-only" };
  if (buyerStatusCache && Date.now() - buyerStatusCache.at < BUYER_STATUS_CACHE_MS) return buyerStatusCache.result;
  let result;
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    const address = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`).address;
    const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
    let balance = null;
    for (const rpc of BASE_RPCS) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE, data }, "latest"] }),
          signal: AbortSignal.timeout(6000),
        });
        const j = await res.json();
        if (typeof j.result === "string" && j.result.startsWith("0x")) {
          balance = Number(BigInt(j.result === "0x" ? "0x0" : j.result)) / 1e6;
          break;
        }
      } catch { /* walk the list */ }
    }
    result = balance == null
      ? { configured: true, status: "unknown", attests: "balance-only" }
      : { configured: true, status: balance < BUYER_LOW_USD() ? "low" : "ok", attests: "balance-only", trend: noteBuyerBalance(balance) };
  } catch {
    result = { configured: true, status: "unknown", attests: "balance-only" };
  }
  buyerStatusCache = { at: Date.now(), result };
  return result;
}
