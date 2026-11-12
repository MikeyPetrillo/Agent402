// Chain truth for a refused EVM payment: was the EIP-3009 authorization we
// signed ever USED?
//
// A seller's 402/401/4xx on the paid retry is their word, and they control
// the status line: one seller settled a payment and then answered 400 (2026-09-02),
// while other sellers answer 402 to a payment nobody examined. Until now the
// buyer treated any non-200 on Base as "maybe charged" and never tried another
// seller (the post-commit rule); Solana got a chain read of the wallet's own
// USDC account on 2026-09-02, and Base was left as "not built".
//
// On an EIP-3009 token the question has an EXACT answer the seller cannot
// influence and no window heuristic can blur: `authorizationState(authorizer,
// nonce)` on the token contract is true once, and only once, the authorization
// we signed has been consumed by a settlement (transferWithAuthorization /
// receiveWithAuthorization). We hold the nonce - it is in the payload we
// signed - so a false after the grace window means nothing settled with that
// credential, whatever else the wallet did in the meantime (a concurrent buy
// from the same wallet reads correctly as a different nonce).
//
// Fails CLOSED: any RPC failure or unreadable result THROWS, and the caller
// keeps the post-commit stance. Only an explicit false is "not charged".
import { evmBuyerRpc } from "./evm-buyer-chains.js";

const SELECTOR = "0xe94a0102"; // authorizationState(address,bytes32) - pinned in the test via viem

// Every chain the buyer pays on (src/evm-buyer-chains.js): Base reads
// AGENT402_BASE_RPC first, every chain honors EVM_RPC_<id>.
export function evmRpcUrlFor(chain) {
  const k = String(chain || "").toLowerCase();
  if (k === "base") return (process.env.AGENT402_BASE_RPC || "https://mainnet.base.org").trim();
  return evmBuyerRpc(k);
}

/** The eth_call data for authorizationState(authorizer, nonce). Pure; exported for the test. */
export function authorizationStateCalldata(authorizer, nonce) {
  const a = String(authorizer || "").toLowerCase();
  const n = String(nonce || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error("authorizationState: bad authorizer");
  if (!/^0x[0-9a-f]{64}$/.test(n)) throw new Error("authorizationState: bad nonce");
  return SELECTOR + a.slice(2).padStart(64, "0") + n.slice(2);
}

/**
 * Poll authorizationState until it reads true (settled) or the wait ends.
 *   { debited: true, observed }            - the authorization was consumed: charged
 *   { debited: false, observed, expired }  - still unused when the wait ended
 *
 * WHEN THE WAIT ENDS IS THE WHOLE QUESTION (2026-09-03). The authorization we
 * signed stays settleable until its own validBefore, whatever the seller said
 * in its response. A "still unused" reading taken BEFORE that moment proves
 * nothing: a seller can answer 402, wait, and settle the same credential after
 * the buyer has paid somebody else (refuse-then-settle-late: a double pay with
 * no attacker on our side). So a caller that knows the credential's expiry
 * passes it as `untilUnix` and the poll runs to THAT moment, bounded by
 * `maxWaitMs`; the result says whether the expiry was actually reached
 * (`expired: true`) or the bound cut the wait short (`expired: false`). Only
 * expired + unused is "provably unpaid". Without `untilUnix` the legacy grace
 * poll runs and `expired` is null: a reading with no expiry attached is never
 * final, and the caller must keep the hold.
 *
 * THE EXPIRY IS READ ON THE CHAIN'S CLOCK. The token refuses a credential
 * once block.timestamp >= validBefore, so that is the only clock that retires
 * it: a host clock running ahead would end the wait while the credential can
 * still settle. When the host clock says the expiry has passed, the latest
 * block is read (same RPC); only a block whose timestamp is at or past
 * `untilUnix`, with authorizationState still false AT THAT BLOCK, makes
 * `expired: true`. A chain still short of the expiry keeps the poll going
 * (inside `maxWaitMs`); a block that cannot be read is not proven
 * (`expired: false`), never a throw that hides a debit and never a release.
 *
 * THROWS on an RPC failure or a non-boolean authorizationState result.
 */
export async function confirmEvmAuthorizationUnused({ token, authorizer, nonce, chain = "base", rpcUrl = evmRpcUrlFor(chain), graceMs = 8000, untilUnix = null, maxWaitMs = 90_000, pollMs = 2000, fetchImpl = fetch, now = Date.now, timeoutMs = 5000 } = {}) {
  if (!rpcUrl) throw new Error(`confirmEvmAuthorizationUnused: no RPC for chain ${chain}`);
  const to = String(token || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error("confirmEvmAuthorizationUnused: bad token address");
  const data = authorizationStateCalldata(authorizer, nonce);
  const started = now();
  const expiryMs = untilUnix != null && Number.isFinite(Number(untilUnix)) ? Number(untilUnix) * 1000 : null;
  const hardStop = started + Math.max(0, Number(maxWaitMs) || 0);
  const deadline = started + graceMs; // the legacy grace (no expiry attached)
  const rpc = async (method, params) => {
    const res = await fetchImpl(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.json();
  };
  // authorizationState at a block tag: true / false, or THROWS (fail closed).
  const readUsed = async (tag) => {
    const j = await rpc("eth_call", [{ to, data }, tag]);
    const r = j?.result;
    if (typeof r !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r)) throw new Error(`authorizationState unreadable: ${JSON.stringify(j?.error || r).slice(0, 120)}`);
    return BigInt(r) !== 0n;
  };
  // The latest block's number and timestamp, or null when it cannot be read.
  const latestBlock = async () => {
    try {
      const b = (await rpc("eth_getBlockByNumber", ["latest", false]))?.result;
      const num = typeof b?.number === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(b.number) ? b.number : null;
      const ts = typeof b?.timestamp === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(b.timestamp) ? Number(BigInt(b.timestamp)) : null;
      return num && ts != null ? { number: num, timestamp: ts } : null;
    } catch { return null; }
  };
  let observed = 0;
  for (;;) {
    const used = await readUsed("latest");
    observed++;
    if (used) return { debited: true, observed };
    const at = now();
    if (expiryMs != null && at >= Math.min(expiryMs, hardStop)) {
      // The host clock says the credential has expired (or the wait is
      // over): ask the chain, whose clock is the one the token reads.
      const block = await latestBlock();
      if (block && block.timestamp >= Number(untilUnix)) {
        // Unused at a block past the expiry means unused for good.
        const usedThen = await readUsed(block.number);
        observed++;
        if (usedThen) return { debited: true, observed };
        return { debited: false, observed, expired: true, chainTime: block.timestamp };
      }
      if (now() >= hardStop) return { debited: false, observed, expired: false, chainTime: block ? block.timestamp : null };
    } else if (expiryMs == null && at >= deadline) {
      return { debited: false, observed, expired: null };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
