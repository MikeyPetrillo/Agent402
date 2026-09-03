// B20 kit — read-only tools for Base's B20 token standard (native-precompile
// ERC-20 superset, factory at 0xB20f…0000, tokens prefixed 0xB200…). Launched
// alongside the mainnet Activation Registry (2026-07-08); these tools answer
// honestly BEFORE activation too (the registry simply reports not-activated).
//
//   b20-activation-check   is a B20 feature activated on Base mainnet?
//   b20-token-info         ERC-20 metadata + B20 signals for any address
//   b20-verify             boolean verdict: is this address a real B20 token?
//   b20-feature-id         pure-CPU: feature string -> registry calldata
//
// Read-only eth_calls against Base mainnet only — B20 is a Base-native
// primitive. No keys, no writes. The three RPC tools are wallet-only (egress);
// b20-feature-id is pure CPU and PoW-eligible.
import sha3 from "js-sha3"; // CommonJS — default import, then destructure
const { keccak256 } = sha3;
import { ssrfDispatcher } from "./fetch-guard.js";
import { redactSecrets } from "./redact.js";

// Documented Base addresses (docs.base.org/get-started/launch-b20-token).
const REGISTRY = "0x8453000000000000000000000000000000000001";
const FACTORY = "0xb20f000000000000000000000000000000000000";
const TOKEN_PREFIX = "0xb200";
const KNOWN_FEATURES = ["base.b20_asset", "base.b20_stablecoin"];

// Selectors verified locally against js-sha3 (standard ERC-20 ones match the
// canonical values, which validates the hashing path for the B20-specific one).
const SEL_IS_ACTIVATED = "0xba87af80"; // isActivated(bytes32)
const SEL = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  paused: "0x5c975abb", // optional on B20 — best-effort
  cap: "0x355274ea", // optional on B20 — best-effort
};

const BASE_RPCS = [
  ...(process.env.ALCHEMY_API_KEY ? [`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
];

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, { passes = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < passes; attempt++) {
    for (const url of BASE_RPCS) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(15000),
          dispatcher: ssrfDispatcher,
        });
        const text = await r.text();
        let j; try { j = JSON.parse(text); } catch { lastErr = new Error(`${url}: non-JSON`); continue; }
        if (j.result !== undefined) return j.result;
        // eth_call reverts land here — surface them as a null result rather
        // than an outage: the next URL would just revert identically.
        if (j.error && /revert|execution/i.test(String(j.error.message || ""))) return null;
        lastErr = new Error(`${url}: ${JSON.stringify(j.error ?? j).slice(0, 120)}`);
      } catch (e) { lastErr = e; }
    }
    if (attempt < passes - 1) await sleep(1000 * (attempt + 1));
  }
  // lastErr.message can embed the RPC URL, which for the Alchemy endpoint
  // carries ALCHEMY_API_KEY — redact before it reaches the buyer/log. (Today
  // the keyless public RPCs run last and overwrite lastErr, but a list reorder
  // would otherwise be a direct key leak needing no adversarial upstream.)
  throw bad(`Base RPC unavailable: ${redactSecrets(String(lastErr?.message || lastErr)).slice(0, 160)}`, 502);
}

const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

function normAddress(a) {
  const addr = String(a || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw bad('address must be a 0x-prefixed 20-byte hex address');
  return addr;
}

const featureId = (feature) => "0x" + keccak256(String(feature));

// --- minimal ABI decoding (we only read simple returns) ----------------------
const hexBody = (h) => (typeof h === "string" ? h.replace(/^0x/, "") : "");
function decodeBool(h) {
  const b = hexBody(h);
  if (!b) return null; // empty return: precompile not live / no code at address
  return BigInt("0x" + b) === 1n;
}
function decodeUint(h) {
  const b = hexBody(h);
  if (!b) return null;
  return BigInt("0x" + b.slice(0, 64)).toString();
}
function decodeString(h) {
  const b = hexBody(h);
  if (b.length < 128) return null;
  try {
    const len = Number(BigInt("0x" + b.slice(64, 128)));
    return Buffer.from(b.slice(128, 128 + len * 2), "hex").toString("utf8");
  } catch { return null; }
}
function formatSupply(raw, decimals) {
  if (raw == null || decimals == null) return null;
  const d = Number(decimals);
  const v = BigInt(raw);
  const base = 10n ** BigInt(d);
  const frac = (v % base).toString().padStart(d, "0").replace(/0+$/, "");
  return `${v / base}${frac ? "." + frac : ""}`;
}

async function checkFeature(feature) {
  const id = featureId(feature);
  const res = await ethCall(REGISTRY, SEL_IS_ACTIVATED + id.slice(2));
  const activated = decodeBool(res);
  return {
    feature,
    featureId: id,
    activated: activated === true,
    ...(activated === null ? { note: "registry returned empty - Activation Registry precompile not live yet" } : {}),
  };
}

async function readToken(addr) {
  const [name, symbol, decimals, totalSupply, paused, cap, code] = await Promise.all([
    ethCall(addr, SEL.name).then(decodeString).catch(() => null),
    ethCall(addr, SEL.symbol).then(decodeString).catch(() => null),
    ethCall(addr, SEL.decimals).then(decodeUint).catch(() => null),
    ethCall(addr, SEL.totalSupply).then(decodeUint).catch(() => null),
    ethCall(addr, SEL.paused).then(decodeBool).catch(() => null),
    ethCall(addr, SEL.cap).then(decodeUint).catch(() => null),
    rpc("eth_getCode", [addr, "latest"]).catch(() => null),
  ]);
  return { name, symbol, decimals: decimals == null ? null : Number(decimals), totalSupply, paused, cap, codeSize: code ? hexBody(code).length / 2 : 0 };
}

// --- log-scanning helpers (b20-new-tokens, b20-memos) ------------------------
// EXACT decoding per the canonical B20 ABI (base/base-std, src/interfaces/
// IB20.sol + IB20Factory.sol):
//   event Transfer(address indexed from, address indexed to, uint256 amount)
//   event Memo(address indexed caller, bytes32 indexed memo)        // BOTH indexed
//   event B20Created(address indexed token, B20Variant indexed variant,
//                    string name, string symbol, uint8 decimals, bytes variantEventParams)
// Non-canonical layouts return null (counted as skipped upstream) — a log that
// doesn't match the published interface is rejected, never guessed at.
const topicOf = (signature) => "0x" + keccak256(signature);
const TOPIC_B20_CREATED = topicOf("B20Created(address,uint8,string,string,uint8,bytes)");
const TOPIC_TRANSFER = topicOf("Transfer(address,address,uint256)");
const TOPIC_MEMO = topicOf("Memo(address,bytes32)");

// Malformed/missing hex from a flaky public RPC must not 500 a paid request.
const logIndexNum = (h) => { try { return Number(BigInt(h)); } catch { return -1; } };

const topicAddress = (topic) => {
  const w = hexBody(topic);
  if (w.length !== 64 || !w.startsWith("0".repeat(24))) return null;
  return "0x" + w.slice(24);
};

// B20Created: the new token is indexed at topics[1]; the factory-issued 0xb200
// prefix stays as a sanity check against ABI drift.
function findB20Address(log) {
  const addr = topicAddress((log.topics || [])[1]);
  return addr && addr.startsWith(TOKEN_PREFIX) ? addr : null;
}

// Canonical ERC-20/B20 Transfer: from/to indexed, amount in data.
function decodeTransfer(log) {
  const t = log.topics || [];
  if (t.length < 3) return null;
  const from = topicAddress(t[1]);
  const to = topicAddress(t[2]);
  const value = decodeUint(log.data);
  if (!from || !to || value == null) return null;
  return { from, to, value };
}

// Memo: both params indexed — the memo is topics[2] (caller is topics[1]).
function memoWord(log) {
  const t = log.topics || [];
  if (t.length < 3) return null;
  const w = hexBody(t[2]);
  return w.length === 64 ? "0x" + w : null;
}

// Best-effort UTF-8: trim NUL padding, require printable, reject replacement chars.
function memoText(hex) {
  try {
    const buf = Buffer.from(hexBody(hex), "hex");
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0) end--;
    if (end === 0) return null;
    const s = buf.subarray(0, end).toString("utf8");
    if (s.includes("�") || /[\x00-\x1f\x7f]/.test(s)) return null;
    return s;
  } catch { return null; }
}

// Test-only export: offline unit tests exercise the decode layer directly.
export const B20_INTERNALS = { TOPIC_B20_CREATED, TOPIC_TRANSFER, TOPIC_MEMO, findB20Address, decodeTransfer, memoWord, memoText, logIndexNum };

async function latestBlock() {
  return Number(BigInt(await rpc("eth_blockNumber", [])));
}

// Chunked eth_getLogs, newest chunk first (<=9k blocks per call: inside
// Alchemy's range cap, small enough for public RPCs). Stops early at maxLogs
// and reports how far back it actually scanned, so callers never claim
// coverage of blocks it didn't fetch. A malformed (non-array) chunk ends the
// reliable-coverage region the same way.
async function getLogsChunked({ address, topics, fromBlock, toBlock, maxLogs = 2000 }) {
  const CHUNK = 9000;
  const out = [];
  let scannedFrom = toBlock + 1; // nothing scanned yet
  for (let hi = toBlock; hi >= fromBlock && out.length < maxLogs; hi -= CHUNK) {
    const lo = Math.max(fromBlock, hi - CHUNK + 1);
    const logs = await rpc("eth_getLogs", [{ address, topics, fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) }]);
    if (!Array.isArray(logs)) break;
    out.push(...logs);
    scannedFrom = lo;
  }
  return { logs: out, scannedFrom, truncated: scannedFrom > fromBlock };
}

function windowInput(i, { defBlocks = 50000, maxBlocks = 200000 } = {}) {
  const blocks = Math.floor(Number(i.blocks ?? defBlocks));
  if (!Number.isFinite(blocks) || blocks < 1 || blocks > maxBlocks) throw bad(`blocks must be 1..${maxBlocks}`);
  return blocks;
}

export const B20_TOOLS = [
  {
    route: "GET /api/b20-activation-check", name: "B20 activation check", slug: "b20-activation-check", category: "payments", price: "$0.002",
    description:
      "Is B20 live on Base mainnet? Queries the Activation Registry precompile for base.b20_asset and base.b20_stablecoin (or a custom feature id). Honest pre-launch too: reports not-activated until the registry flips. ?feature=base.b20_asset (optional)",
    tags: ["b20", "base", "activation", "registry", "token-standard", "precompile"],
    discovery: {
      input: {},
      inputSchema: { properties: { feature: { type: "string", description: "optional: a single feature string to check (default: both known B20 features)" } } },
      output: { example: { registry: REGISTRY, features: [{ feature: "base.b20_asset", featureId: "0xcdcc…", activated: false }] } },
    },
    handler: async (i) => {
      const features = i.feature ? [String(i.feature)] : KNOWN_FEATURES;
      const results = await Promise.all(features.map(checkFeature));
      return { network: "base", registry: REGISTRY, features: results, allActivated: results.every((f) => f.activated) };
    },
  },
  {
    route: "GET /api/b20-token-info", name: "B20 token info", slug: "b20-token-info", category: "payments", price: "$0.005",
    description:
      "ERC-20 metadata plus B20 signals for any Base address: name, symbol, decimals, total supply, best-effort paused/cap, bytecode size, and whether the address carries the factory-issued 0xB200 prefix. Works on plain ERC-20s too (isB20 comes back false). ?address=0x…",
    tags: ["b20", "base", "erc20", "token", "metadata", "supply"],
    discovery: {
      input: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
      inputSchema: { properties: { address: { type: "string", description: "0x token address on Base" } }, required: ["address"] },
      output: { example: { address: "0x8335…2913", isB20: false, prefixMatch: false, name: "USD Coin", symbol: "USDC", decimals: 6, totalSupply: "…", totalSupplyFormatted: "…" } },
    },
    handler: async (i) => {
      const addr = normAddress(i.address);
      const t = await readToken(addr);
      const prefixMatch = addr.startsWith(TOKEN_PREFIX);
      const erc20Readable = t.name != null && t.symbol != null && t.decimals != null;
      return {
        network: "base", address: addr,
        isB20: prefixMatch && erc20Readable,
        prefixMatch, erc20Readable,
        name: t.name, symbol: t.symbol, decimals: t.decimals,
        totalSupply: t.totalSupply, totalSupplyFormatted: formatSupply(t.totalSupply, t.decimals),
        paused: t.paused, supplyCap: t.cap, codeSize: t.codeSize,
        factory: FACTORY,
      };
    },
  },
  {
    route: "GET /api/b20-verify", name: "Verify B20 token", slug: "b20-verify", category: "payments", price: "$0.005",
    description:
      "Boolean verdict with reasons: is this address a real factory-issued B20 on Base? Checks the 0xB200 address prefix, ERC-20 readability, and whether the B20 feature set is activated on the registry. ?address=0x…",
    tags: ["b20", "base", "verify", "token", "trust", "registry"],
    discovery: {
      input: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
      inputSchema: { properties: { address: { type: "string", description: "0x token address on Base" } }, required: ["address"] },
      output: { example: { address: "0x8335…2913", isB20: false, checks: { prefixMatch: false, erc20Readable: true, registryActivated: false } } },
    },
    handler: async (i) => {
      const addr = normAddress(i.address);
      const [t, asset] = await Promise.all([readToken(addr), checkFeature(KNOWN_FEATURES[0])]);
      const checks = {
        prefixMatch: addr.startsWith(TOKEN_PREFIX),
        erc20Readable: t.name != null && t.symbol != null && t.decimals != null,
        registryActivated: asset.activated,
      };
      const reasons = [];
      if (!checks.prefixMatch) reasons.push("address does not carry the factory-issued 0xB200 prefix");
      if (!checks.erc20Readable) reasons.push("ERC-20 metadata (name/symbol/decimals) not readable at this address");
      if (!checks.registryActivated) reasons.push("B20 asset feature not (yet) activated on the registry");
      return { network: "base", address: addr, isB20: checks.prefixMatch && checks.erc20Readable, checks, reasons, name: t.name, symbol: t.symbol };
    },
  },
  {
    route: "POST /api/b20-feature-id", name: "B20 feature id", slug: "b20-feature-id", category: "payments", price: "$0.001",
    description:
      "Pure-CPU helper: turn a B20 feature string (e.g. base.b20_asset) into its bytes32 feature id and ready-to-send isActivated(bytes32) calldata for the Activation Registry. No network egress.",
    tags: ["b20", "base", "keccak", "calldata", "registry", "encoding"],
    discovery: {
      bodyType: "json",
      input: { feature: "base.b20_asset" },
      inputSchema: { properties: { feature: { type: "string", description: "feature string to hash (keccak256)" } }, required: ["feature"] },
      output: { example: { feature: "base.b20_asset", featureId: "0xcdcc772f…", registry: REGISTRY, calldata: "0xba87af80cdcc…" } },
    },
    handler: async (i) => {
      const feature = String(i.feature || "").trim();
      if (!feature) throw bad("feature is required (e.g. base.b20_asset)");
      if (feature.length > 256) throw bad("feature too long (max 256 chars)");
      const id = featureId(feature);
      return {
        feature, featureId: id, registry: REGISTRY,
        calldata: SEL_IS_ACTIVATED + id.slice(2),
        knownFeatures: KNOWN_FEATURES,
        note: "eth_call { to: registry, data: calldata } on Base mainnet returns bool",
      };
    },
  },
  {
    route: "GET /api/b20-new-tokens", name: "New B20 tokens", slug: "b20-new-tokens", category: "payments", price: "$0.005",
    description:
      "Recently deployed B20 tokens on Base: scans the factory's B20Created logs over a block window, locates each new token by its 0xB200 address prefix, and enriches it with live name/symbol/decimals eth_calls. ?blocks=50000&limit=25",
    tags: ["b20", "base", "factory", "logs", "discovery", "token-standard"],
    discovery: {
      input: { blocks: 1000 },
      inputSchema: { properties: {
        blocks: { type: "number", description: "lookback window in blocks (default 50000 ≈ 28h, max 200000)" },
        limit: { type: "number", description: "max tokens returned, newest first (default 25, max 100)" },
      } },
      output: { example: { network: "base", factory: FACTORY, fromBlock: 1, toBlock: 2, scannedFromBlock: 1, truncated: false, count: 0, skipped: 0, tokens: [] } },
    },
    handler: async (i) => {
      const blocks = windowInput(i);
      const rawLimit = i.limit == null ? 25 : Math.floor(Number(i.limit));
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
      const toBlock = await latestBlock();
      const fromBlock = Math.max(0, toBlock - blocks + 1);
      const { logs, scannedFrom, truncated } = await getLogsChunked({ address: FACTORY, topics: [TOPIC_B20_CREATED], fromBlock, toBlock });
      // Deviation from the spec's "stop early once limit addresses are found":
      // we scan the requested window fully (bounded by maxLogs) and trim after
      // sorting — chunk order alone can't guarantee the newest hits otherwise.
      logs.sort((a, b) => logIndexNum(b.blockNumber) - logIndexNum(a.blockNumber));
      const seen = new Set();
      let skipped = 0;
      const found = [];
      for (const log of logs) {
        const address = findB20Address(log);
        if (!address) { skipped++; continue; }
        if (seen.has(address)) continue;
        seen.add(address);
        found.push({ address, txHash: log.transactionHash, blockNumber: logIndexNum(log.blockNumber) });
        if (found.length >= limit) break;
      }
      const tokens = [];
      for (let k = 0; k < found.length; k += 8) {
        tokens.push(...await Promise.all(found.slice(k, k + 8).map(async (f) => {
          const t = await readToken(f.address).catch(() => null);
          return { ...f, name: t?.name ?? null, symbol: t?.symbol ?? null, decimals: t?.decimals ?? null };
        })));
      }
      return { network: "base", factory: FACTORY, fromBlock, toBlock, scannedFromBlock: scannedFrom, truncated, count: tokens.length, skipped, tokens };
    },
  },
  {
    route: "GET /api/b20-memos", name: "B20 payment memos", slug: "b20-memos", category: "payments", price: "$0.005",
    description:
      "Payment memos attached to B20 transfers: pairs each Memo(address,bytes32) log with its Transfer at the previous log index (same tx, same token). Give a tx hash for one transaction, or scan a block window. Returns memoHex always and memoText when printable UTF-8. ?token=0xb200…&tx=0x…|&blocks=50000&address=0x…&limit=50",
    tags: ["b20", "base", "memo", "payments", "logs", "transfer"],
    discovery: {
      input: { token: "0xb200000000000000000000000000000000000001", blocks: 1000 },
      inputSchema: { properties: {
        token: { type: "string", description: "B20 token address (must carry the 0xb200 prefix)" },
        tx: { type: "string", description: "optional: decode memos in this transaction only" },
        address: { type: "string", description: "optional: only transfers where from or to equals this address" },
        blocks: { type: "number", description: "window-scan lookback (default 50000, max 200000; ignored when tx is given)" },
        limit: { type: "number", description: "max memo rows (default 50, max 200)" },
      }, required: ["token"] },
      output: { example: { token: "0xb200…0001", mode: "window", fromBlock: 1, toBlock: 2, scannedFromBlock: 1, truncated: false, count: 0, memos: [] } },
    },
    handler: async (i) => {
      const token = String(i.token || "").trim().toLowerCase();
      if (!/^0xb200[0-9a-f]{36}$/.test(token)) throw bad("token must be a 0xb200-prefixed B20 token address");
      const rawLimit = i.limit == null ? 50 : Math.floor(Number(i.limit));
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
      const filter = i.address ? normAddress(i.address) : null;

      let logs, mode, window = {};
      if (i.tx) {
        mode = "tx";
        const tx = String(i.tx).trim().toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(tx)) throw bad("tx must be a 0x-prefixed 32-byte transaction hash");
        const receipt = await rpc("eth_getTransactionReceipt", [tx]);
        if (!receipt) throw bad("transaction not found on Base", 404);
        logs = (receipt.logs || []).filter((l) => String(l.address).toLowerCase() === token);
      } else {
        mode = "window";
        const blocks = windowInput(i);
        const toBlock = await latestBlock();
        const fromBlock = Math.max(0, toBlock - blocks + 1);
        const r = await getLogsChunked({ address: token, topics: [[TOPIC_TRANSFER, TOPIC_MEMO]], fromBlock, toBlock });
        window = { fromBlock, toBlock, scannedFromBlock: r.scannedFrom, truncated: r.truncated };
        logs = r.logs;
      }

      // Index Transfer logs by (txHash, logIndex); each Memo pairs with the
      // Transfer at logIndex - 1 in the same tx (CDP-documented adjacency).
      const transfers = new Map();
      for (const l of logs) {
        if ((l.topics || [])[0] === TOPIC_TRANSFER) transfers.set(`${l.transactionHash}:${logIndexNum(l.logIndex)}`, l);
      }
      const memos = [];
      for (const l of logs) {
        if ((l.topics || [])[0] !== TOPIC_MEMO) continue;
        const t = transfers.get(`${l.transactionHash}:${logIndexNum(l.logIndex) - 1}`);
        if (!t) continue;
        const d = decodeTransfer(t);
        if (!d) continue;
        if (filter && d.from !== filter && d.to !== filter) continue;
        const hex = memoWord(l);
        if (!hex) continue;
        memos.push({ txHash: l.transactionHash, blockNumber: logIndexNum(l.blockNumber), from: d.from, to: d.to, amount: d.value, memoHex: hex, memoText: memoText(hex) });
      }
      memos.sort((a, b) => b.blockNumber - a.blockNumber);
      return { network: "base", token, mode, ...window, count: Math.min(memos.length, limit), memos: memos.slice(0, limit) };
    },
  },
];
