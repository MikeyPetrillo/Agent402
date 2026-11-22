// Preload: every EVM JSON-RPC call the server makes is answered by a
// deterministic stub chain and counted, by caller, method and block range.
//
//   node --import ./scripts/lib/evm-rpc-stub-preload.mjs src/server.js
//
// EVM_STUB_LOG   file the calls are appended to (one JSON line each)
// EVM_STUB_T0    epoch ms the stub chains' heads are counted from; pass the
//                same value to two boots so the second sees the chain move on
// EVM_STUB_SELLERS  how many Base sellers the stub discovery listing names (default 300)
// EVM_STUB_STEP  blocks between two transfers a getLogs answer holds (default 4000)
// EVM_STUB_ACTIVITY_SECONDS  chain seconds between two transfers an
//                alchemy_getAssetTransfers answer holds (default 240)
//
// Each chain's head is HEAD0 + (now - T0) / blockMs, so a restart reads a
// head that moved by the wall time between boots. A transfer lands every
// STEP blocks; a log names its block, index and amount from the block number
// alone, so a full read and a resumed read of the same range answer the same.
// Any other outbound call (a non-RPC host) is refused as "fetch failed": the
// boot stays offline. Loopback is passed through.
import { appendFileSync } from "node:fs";

const LOG = process.env.EVM_STUB_LOG || "";
const T0 = Number(process.env.EVM_STUB_T0) || Date.now();
const SELLERS = Number(process.env.EVM_STUB_SELLERS) || 300;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// [chain, host tokens, block ms, head at T0]
const CHAINS = [
  ["base-sepolia", ["base-sepolia", "sepolia.base"], 2000, 30_000_000],
  ["base", ["base"], 200, 40_000_000],
  ["arbitrum", ["arb"], 250, 300_000_000],
  ["polygon", ["polygon"], 2100, 70_000_000],
  ["monad", ["monad"], 300, 40_000_000],
  ["celo", ["celo", "forno"], 1000, 40_000_000],
  ["avalanche", ["avax", "avalanche"], 1140, 60_000_000],
  ["sei", ["sei"], 450, 160_000_000],
  ["optimism", ["opt-", "optimism"], 2000, 140_000_000],
  ["arc", ["arc-mainnet", "arc.io"], 500, 30_000_000],
  ["ink", ["ink"], 1000, 62_000_000],
  ["robinhood", ["robinhood"], 150, 50_000_000],
  ["ethereum", ["eth-mainnet", "ethereum", "eth.drpc", "cloudflare-eth"], 12000, 23_000_000],
];
const STEP = 4000; // one transfer every STEP blocks

function chainOf(host) {
  for (const [name, tokens, ms, head0] of CHAINS) if (tokens.some((t) => host.includes(t))) return { name, ms, head0 };
  return null;
}
// In-process tests steer the chains through globalThis.__evmStub:
//   frozen: true        heads stop following the clock; advance[chain] (or
//                       advanceAll) blocks are added to HEAD0 instead
//   step                blocks between two transfers (default STEP)
//   failBlock           an eth_getLogs range holding this block answers an error
//   reorgFrom, reorgSalt  every transfer at or above that block is answered
//                       with another amount and payer (a reorganized tail)
const knobs = () => globalThis.__evmStub || {};
const headOf = (c, now = Date.now()) => {
  const k = knobs();
  if (k.frozen) return c.head0 + (Number(k.advance?.[c.name] ?? k.advanceAll) || 0);
  return c.head0 + Math.floor((now - T0) / c.ms);
};
const tsOf = (c, n) => Math.floor((T0 - (c.head0 - n) * c.ms) / 1000);
const hex = (n) => "0x" + Math.max(0, Math.floor(n)).toString(16);
const addr = (seed) => "0x" + (BigInt(seed) * 0x9e3779b97f4a7c15n % (1n << 160n)).toString(16).padStart(40, "0");
const pad = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();

// Synthetic transfer at block b: to one of the listed seller wallets (or our
// wallet when it is named), from a payer picked by the block.
function logsFor(c, f) {
  const from = parseInt(f.fromBlock, 16), to = f.toBlock === "latest" || f.toBlock == null ? headOf(c) : parseInt(f.toBlock, 16);
  const t1 = f.topics?.[1], t2 = f.topics?.[2];
  const list = (t) => (t == null ? null : Array.isArray(t) ? t.map((x) => String(x).toLowerCase()) : [String(t).toLowerCase()]);
  const froms = list(t1), tos = list(t2);
  const out = [];
  if (!(to >= from)) return out;
  const step = Number(knobs().step) || Number(process.env.EVM_STUB_STEP) || STEP;
  for (let b = Math.ceil(from / step) * step; b <= to; b += step) {
    let k = b / step;
    const r = knobs();
    if (Number.isFinite(r.reorgFrom) && b >= r.reorgFrom) k += Number(r.reorgSalt) || 1;
    const payer = pad(addr(1000 + (k % 37)));
    // The recipient: the k-th wallet of the filter when one is given (so every
    // filtered wallet sees transfers), else a seller-shaped address.
    const recipient = tos ? tos[k % tos.length] : pad(addr(5000 + (k % 11)));
    if (froms && !froms.includes(payer)) {
      // An outbound read (topics[1] = the wallet): the wallet pays a payer.
      if (!(k % 5 === 0)) continue;
      out.push(mk(c, b, froms[k % froms.length], recipient, k));
      continue;
    }
    out.push(mk(c, b, payer, recipient, k));
  }
  return out;
}
function mk(c, b, fromTopic, toTopic, k) {
  return {
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    topics: [TRANSFER, fromTopic, toTopic],
    data: hex(1000 + (k % 50) * 1000),
    blockNumber: hex(b), logIndex: hex(k % 7), transactionIndex: "0x0",
    transactionHash: "0x" + (BigInt(b) * 1000003n + BigInt(k % 7)).toString(16).padStart(64, "0"),
    blockHash: "0x" + BigInt(b).toString(16).padStart(64, "0"), removed: false,
  };
}

// alchemy_getAssetTransfers (desc): a transfer to the named wallet every
// ACTIVITY_SECONDS of chain time, paged by a key that names the next block.
const ACTIVITY_SECONDS = Number(process.env.EVM_STUB_ACTIVITY_SECONDS) || 240;
function assetTransfers(c, p) {
  const step = Math.max(1, Math.round((ACTIVITY_SECONDS * 1000) / c.ms));
  const lo = parseInt(p.fromBlock || "0x0", 16) || 0;
  const top = p.toBlock && p.toBlock !== "latest" ? parseInt(p.toBlock, 16) : headOf(c);
  const hi = p.pageKey ? Math.min(top, Number(p.pageKey)) : top;
  const max = parseInt(p.maxCount || "0x3e8", 16) || 1000;
  const transfers = [];
  let b = Math.floor(hi / step) * step;
  for (; b >= lo && transfers.length < max; b -= step) {
    let k = b / step;
    const r = knobs();
    if (Number.isFinite(r.reorgFrom) && b >= r.reorgFrom) k += Number(r.reorgSalt) || 1;
    transfers.push({
      blockNum: hex(b), uniqueId: `0x${b.toString(16)}:log:0`, hash: "0x" + BigInt(b).toString(16).padStart(64, "0"),
      from: addr(1000 + (k % 37)), to: String(p.toAddress || "").toLowerCase(), value: (k % 50 + 1) / 1000, asset: "USDC", category: "erc20",
      metadata: { blockTimestamp: new Date(tsOf(c, b) * 1000).toISOString() },
    });
  }
  return { transfers, ...(b >= lo && transfers.length >= max ? { pageKey: String(b) } : {}) };
}

function answer(c, method, params) {
  switch (method) {
    case "eth_blockNumber": return hex(headOf(c));
    case "eth_chainId": return "0x1";
    case "eth_gasPrice": return "0x3b9aca00";
    case "eth_call": return "0x" + (123456789n).toString(16).padStart(64, "0");
    case "eth_getBlockByNumber": {
      const tag = params?.[0];
      const n = tag === "latest" || tag == null ? headOf(c) : parseInt(tag, 16);
      if (n > headOf(c)) return null;
      return { number: hex(n), timestamp: hex(tsOf(c, n)), hash: "0x" + BigInt(n).toString(16).padStart(64, "0"), transactions: [] };
    }
    case "eth_getLogs": return logsFor(c, params?.[0] || {});
    case "alchemy_getAssetTransfers": return assetTransfers(c, params?.[0] || {});
    case "eth_getTransactionReceipt": case "eth_getTransactionByHash": return null;
    default: return null;
  }
}

function callers() {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  const s = new Error().stack || "";
  Error.stackTraceLimit = prev;
  const files = [];
  for (const line of s.split("\n")) {
    const m = line.match(/\/(src\/[^:)]+\.js):\d+/);
    if (!m || m[1] === "src/egress-meter.js") continue;
    if (!files.includes(m[1])) files.push(m[1]);
  }
  return files;
}

function note(row) {
  if (!LOG) return;
  try { appendFileSync(LOG, JSON.stringify(row) + "\n"); } catch { /* the stub never breaks the server */ }
}

function bazaarPage(url) {
  const u = new URL(url);
  const limit = Number(u.searchParams.get("limit")) || 1000, offset = Number(u.searchParams.get("offset")) || 0;
  const items = [];
  for (let i = offset; i < Math.min(SELLERS, offset + limit); i++) {
    items.push({
      resource: `https://seller${i}.example/api/tool`, type: "http",
      accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: addr(5000 + (i % 400)), maxAmountRequired: "10000" }],
    });
  }
  return { items, pagination: { total: SELLERS, limit, offset } };
}

const real = globalThis.fetch;
globalThis.fetch = async function stubFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  let u;
  try { u = new URL(url); } catch { return real.call(this, input, init); }
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "[::1]") return real.call(this, input, init);
  if (u.hostname === "api.cdp.coinbase.com" && u.pathname.endsWith("/discovery/resources")) {
    note({ host: u.hostname, method: "bazaar", callers: callers() });
    return new Response(JSON.stringify(bazaarPage(u.href)), { status: 200, headers: { "content-type": "application/json" } });
  }
  const c = chainOf(u.hostname);
  const body = typeof init?.body === "string" ? init.body : null;
  let req = null;
  try { req = body ? JSON.parse(body) : null; } catch { req = null; }
  if (!c || !req || (Array.isArray(req) ? !req.length || !req[0].jsonrpc : !req.jsonrpc) || (init?.method || "GET").toUpperCase() !== "POST") {
    throw new TypeError("fetch failed");
  }
  const who = callers();
  const one = (r) => {
    const p = r.params?.[0];
    note({ host: u.hostname, chain: c.name, method: r.method, from: p && typeof p === "object" && p.fromBlock ? parseInt(p.fromBlock, 16) : null, to: p && typeof p === "object" && p.toBlock && p.toBlock !== "latest" ? parseInt(p.toBlock, 16) : null, callers: who });
    const fb = knobs().failBlock;
    if (r.method === "eth_getLogs" && Number.isFinite(fb) && p && parseInt(p.fromBlock, 16) <= fb && fb <= parseInt(p.toBlock, 16)) {
      return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "stub: this range is unavailable" } };
    }
    return { jsonrpc: "2.0", id: r.id, result: answer(c, r.method, r.params) };
  };
  const out = Array.isArray(req) ? req.map(one) : one(req);
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
};

/** In-process tests: the stub chains' head and timestamp math. */
export const evmStub = { chains: CHAINS.map(([name, , ms, head0]) => ({ name, ms, head0 })), headOf: (name) => { const c = CHAINS.find((x) => x[0] === name); return headOf({ name, ms: c[2], head0: c[3] }); }, T0, STEP };
