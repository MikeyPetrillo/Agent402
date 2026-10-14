// --import preload for scripts/test-solana-intel-deadline.js: RugCheck and
// Jupiter answer in-process, nothing leaves the machine for them. A RugCheck
// read for the STALL mint never answers and rejects only when the signal the
// tool passed aborts, the way undici ends a stalled request at
// AbortSignal.timeout; any other mint gets a small fixture, the control that
// proves the route serves through this stub.
const realFetch = globalThis.fetch;
const STALL = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const stall = (init) => new Promise((_, reject) => {
  const sig = init?.signal;
  if (!sig) return reject(new Error("stub: the read carries no AbortSignal"));
  sig.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), { once: true });
});
const report = (mint) => ({
  mint, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", creator: null, creatorBalance: 0,
  token: { mintAuthority: null, supply: 1000000000000, decimals: 6, isInitialized: true, freezeAuthority: null },
  tokenMeta: { name: "Fixture", symbol: "FIX", uri: "", mutable: false, updateAuthority: "11111111111111111111111111111111" },
  topHolders: Array.from({ length: 20 }, (_, k) => ({ address: `A${k}`, owner: `O${k}`, amount: 1, decimals: 6, pct: 2, uiAmount: 1, insider: false })),
  knownAccounts: {}, risks: [], score: 1, score_normalised: 1, rugged: false, lockers: {},
  markets: [{ pubkey: "M1", marketType: "raydium", mintA: mint, mintB: "So11111111111111111111111111111111111111112", lp: { lpLockedPct: 100, lpLockedUSD: 10, baseUSD: 5, quoteUSD: 5, holders: 1 } }],
  totalMarketLiquidity: 10, totalLPProviders: 1, totalHolders: 1000, price: 1, graphInsidersDetected: 0,
});
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === "string" ? input : input?.url || "");
  const rc = /^https:\/\/api\.rugcheck\.xyz\/v1\/tokens\/([1-9A-HJ-NP-Za-km-z]+)\/report(\/summary)?$/.exec(url);
  if (rc) {
    if (rc[1] === STALL) return stall(init);
    return json(rc[2] ? { tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", score: 1, score_normalised: 1, lpLockedPct: 100, risks: [] } : report(rc[1]));
  }
  if (/^https:\/\/lite-api\.jup\.ag\/tokens\/v2\/search/.test(url)) {
    const q = new URL(url).searchParams.get("query");
    return json([{ id: q, name: "Fixture", symbol: "FIX", decimals: 6, usdPrice: 1, holderCount: 1000, isVerified: true, organicScore: 50, organicScoreLabel: "medium", audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 10 }, mintAuthority: null, freezeAuthority: null }]);
  }
  return realFetch(input, init);
};
