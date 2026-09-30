// Chain constants. Both tokens have 6 decimals.
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// USDC's EIP-3009 event: every x402 exact settlement on Base emits it beside
// its Transfer, which is how an x402 payment is told apart from any other
// USDC movement (address-poisoning spam uses zero-value transferFrom and
// never carries a signed authorization).
export const AUTH_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

export const BASE = {
  key: "x402",
  chain: "base",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  rpcs: (process.env.LIVE_BASE_RPCS || "https://base-rpc.publicnode.com,https://mainnet.base.org").split(",").map((s) => s.trim()),
  blockSeconds: 2,
  txUrl: (h) => `https://basescan.org/tx/${h}`,
};

export const TEMPO = {
  key: "mpp",
  chain: "tempo",
  usdc: "0x20c000000000000000000000b9537d11c60e8b50",
  rpcs: (process.env.LIVE_TEMPO_RPCS || "https://rpc.tempo.xyz").split(",").map((s) => s.trim()),
  blockSeconds: 0.6,
  txUrl: (h) => `https://explore.tempo.xyz/tx/${h}`,
};

// A single payment above this is not an agent calling an API; it is left out.
export const MAX_PAYMENT_USD = Number(process.env.LIVE_MAX_PAYMENT_USD || 50);
