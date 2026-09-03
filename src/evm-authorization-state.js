// Chain truth for a refused EVM payment: was the EIP-3009 authorization we
// signed ever USED?
//
// A seller's 402/401/4xx on the paid retry is their word, and they control
// the status line: xfuel settled a payment and then answered 400 (2026-09-02),
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
 * Poll authorizationState until it reads true (settled) or the grace expires.
 *   { debited: true, observed }   - the authorization was consumed: charged
 *   { debited: false, observed }  - still unused after the grace: not charged
 * THROWS on an RPC failure or a non-boolean result.
 */
export async function confirmEvmAuthorizationUnused({ token, authorizer, nonce, chain = "base", rpcUrl = evmRpcUrlFor(chain), graceMs = 8000, pollMs = 2000, fetchImpl = fetch, now = Date.now, timeoutMs = 5000 } = {}) {
  if (!rpcUrl) throw new Error(`confirmEvmAuthorizationUnused: no RPC for chain ${chain}`);
  const to = String(token || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error("confirmEvmAuthorizationUnused: bad token address");
  const data = authorizationStateCalldata(authorizer, nonce);
  const deadline = now() + graceMs;
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
    if (now() >= deadline) return { debited: false, observed };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
