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
const SELECTOR = "0xe94a0102"; // authorizationState(address,bytes32) - pinned in the test via viem

const RPC_BY_CHAIN = {
  base: () => (process.env.AGENT402_BASE_RPC || "https://mainnet.base.org").trim(),
};
export function evmRpcUrlFor(chain) {
  const f = RPC_BY_CHAIN[String(chain || "").toLowerCase()];
  return f ? f() : null;
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
 * THROWS on an RPC failure or a non-boolean result.
 */
export async function confirmEvmAuthorizationUnused({ token, authorizer, nonce, chain = "base", rpcUrl = evmRpcUrlFor(chain), graceMs = 8000, untilUnix = null, maxWaitMs = 90_000, pollMs = 2000, fetchImpl = fetch, now = Date.now, timeoutMs = 5000 } = {}) {
  if (!rpcUrl) throw new Error(`confirmEvmAuthorizationUnused: no RPC for chain ${chain}`);
  const to = String(token || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error("confirmEvmAuthorizationUnused: bad token address");
  const data = authorizationStateCalldata(authorizer, nonce);
  const started = now();
  const expiryMs = untilUnix != null && Number.isFinite(Number(untilUnix)) ? Number(untilUnix) * 1000 : null;
  const deadline = expiryMs != null ? Math.min(expiryMs, started + Math.max(0, Number(maxWaitMs) || 0)) : started + graceMs;
  let observed = 0;
  for (;;) {
    const res = await fetchImpl(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await res.json();
    const r = j?.result;
    if (typeof r !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r)) throw new Error(`authorizationState unreadable: ${JSON.stringify(j?.error || r).slice(0, 120)}`);
    observed++;
    const used = BigInt(r) !== 0n;
    if (used) return { debited: true, observed };
    if (now() >= deadline) return { debited: false, observed, expired: expiryMs != null ? now() >= expiryMs : null };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
