// Robinhood Chain reachability probe. The sandbox can't reach external RPCs, so
// this runs in CI (which has network) to prove the chain params baked into
// x402-kit are correct and the public RPC is live — i.e. that the `robinhood`
// network on tx-status / gas-estimate actually works end to end.
//
// It does NOT test an x402 PAYMENT: Robinhood Chain has no x402 facilitator yet
// (CDP/PayAI don't list chain 4663) and its stablecoin is USDG, not Circle USDC,
// so `exact`-scheme USDC settlement isn't available. This validates the READ
// path (the part we shipped) and confirms the chain is what we think it is.
//
//   node scripts/rh-chain-probe.js
const CHAINS = {
  mainnet: { url: "https://rpc.mainnet.chain.robinhood.com", expectChainId: 4663 },
  testnet: { url: "https://rpc.testnet.chain.robinhood.com", expectChainId: 46646 },
};

async function rpc(url, method, params = []) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

let ok = true;
for (const [name, c] of Object.entries(CHAINS)) {
  console.log(`\n=== Robinhood Chain ${name} (${c.url}) ===`);
  try {
    const [chainIdHex, blockHex, gasHex] = await Promise.all([
      rpc(c.url, "eth_chainId"),
      rpc(c.url, "eth_blockNumber"),
      rpc(c.url, "eth_gasPrice"),
    ]);
    const chainId = parseInt(chainIdHex, 16);
    const block = parseInt(blockHex, 16);
    const gwei = (Number(BigInt(gasHex)) / 1e9).toFixed(6);
    console.log(`  chainId:     ${chainId} (${chainIdHex})`);
    console.log(`  blockNumber: ${block}`);
    console.log(`  gasPrice:    ${gwei} gwei`);
    if (chainId !== c.expectChainId) {
      console.log(`  >>> MISMATCH: expected chainId ${c.expectChainId}, got ${chainId}`);
      if (name === "mainnet") ok = false; // only mainnet correctness gates the exit code
    } else {
      console.log(`  >>> OK: chainId matches, RPC live, ${name} reachable`);
    }
  } catch (e) {
    console.log(`  UNREACHABLE: ${e?.message || e}`);
    if (name === "mainnet") ok = false;
  }
}

console.log(`\n${ok ? "PASS" : "FAIL"}: Robinhood Chain mainnet read path`);
process.exit(ok ? 0 : 1);
