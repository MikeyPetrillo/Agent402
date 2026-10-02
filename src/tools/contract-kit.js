// Contract/EVM kit — smart-contract introspection for agents: verified source +
// ABI (Sourcify), a deterministic Solidity pattern scan, calldata decoding with
// a signature-DB fallback (openchain.xyz / 4byte.directory), selector lookup,
// read-only tx simulation (eth_call + eth_estimateGas over the same keyless
// public-RPC pool as evm-rpc), and a curated known-address labeler.
//
// Upstreams are keyless. Egress tools (contract-source, contract-abi,
// calldata-decode, selector-lookup, tx-simulate) are in WALLET_ONLY_SLUGS;
// solidity-scan and address-label are pure CPU and stay PoW-eligible.
//
// Deterministic only — solidity-scan is a fixed heuristic ruleset, NOT an
// audit and NOT an LLM.
//
// Covered by scripts/test-contract-kit.js (offline validation, no network).

import sha3 from "js-sha3"; // CommonJS — default import, then destructure
const { keccak256 } = sha3;
import { ssrfDispatcher } from "./fetch-guard.js";
import { publicJsonRpc, pickNetwork } from "./chain-kit.js";

const TIMEOUT_MS = 12_000;
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_RE = /^0x[a-fA-F0-9]*$/;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function takeAddress(raw, field = "address") {
  if (typeof raw !== "string" || !ADDR_RE.test(raw.trim())) {
    throw bad(`"${field}" must be a 0x-prefixed 40-char hex Ethereum address`);
  }
  return raw.trim().toLowerCase();
}

// Sourcify chain coverage — the EVM chains we serve elsewhere plus the major
// EVM mainnets Sourcify indexes deeply. Mainnets only.
const SOURCIFY_CHAINS = {
  ethereum: 1,
  base: 8453,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  bsc: 56,
  gnosis: 100,
  celo: 42220,
};

function pickSourcifyChain(value) {
  const n = typeof value === "string" ? value.toLowerCase().trim() : "base";
  const chainId = SOURCIFY_CHAINS[n];
  if (!chainId) throw bad(`Unsupported network "${value}" - supported: ${Object.keys(SOURCIFY_CHAINS).join(", ")}`);
  return { name: n, chainId };
}

// Blockscout public instances — a DIVERSE second verification source for
// contract-source / contract-abi. Sourcify is a single anonymous upstream and
// prod shares one Railway egress IP with other tenants, so a Sourcify per-IP
// throttle or outage becomes OUR intermittent failure. Hosts verified live
// 2026-07-21 against `/api/v2/smart-contracts/<USDC>` on each chain:
//   eth/base/arbitrum/gnosis/celo answered 200 with is_verified:true;
//   optimism.blockscout.com 301s to explorer.optimism.io (which answers);
//   polygon.blockscout.com 500s consistently on this endpoint (dropped);
//   bsc has no public Blockscout instance (404 default backend — dropped).
// Chains without an entry simply have no fallback — the Sourcify error
// surfaces unchanged.
const BLOCKSCOUT_HOSTS = {
  1: "eth.blockscout.com",
  8453: "base.blockscout.com",
  10: "explorer.optimism.io",
  42161: "arbitrum.blockscout.com",
  100: "gnosis.blockscout.com",
  42220: "celo.blockscout.com",
};

// Was a getJson failure an upstream problem (unreachable/5xx/rate-limit/
// non-JSON), as opposed to a clean not-found answer? getJson maps the whole
// upstream-failure class into 502/503/504; a Sourcify 404 ("never verified")
// does NOT throw, so it never reaches this.
function isUpstreamFailure(e) {
  const sc = e?.statusCode;
  return sc === 502 || sc === 503 || sc === 504;
}

// Fetch a contract from the chain's public Blockscout instance.
// Returns null when the chain has no Blockscout host;
// { verified: false } on a clean miss (404, or known-but-unverified);
// { verified: true, host, data } when Blockscout has the verified contract.
// Upstream failures throw (getJson semantics).
async function blockscoutContract(chainId, address) {
  const host = BLOCKSCOUT_HOSTS[chainId];
  if (!host) return null;
  const { status, data } = await getJson(
    `https://${host}/api/v2/smart-contracts/${address}`,
    `Blockscout (${host})`
  );
  if (status === 404 || !data || data.is_verified !== true) return { verified: false, host };
  return { verified: true, host, data };
}

// Sourcify failed upstream, so "Blockscout doesn't have it" is NOT "not
// verified" — Sourcify may have it and we can't tell. Never a false miss.
function verificationSourcesUnavailable() {
  return bad(
    "Verification sources unavailable - Sourcify is unreachable and Blockscout could not confirm this contract. Try again shortly.",
    502
  );
}

// Blockscout's verification-strength flags mapped onto Sourcify's match
// vocabulary: a full (bytecode + metadata) verification is an exact_match,
// a partial one is a match.
const blockscoutMatch = (data) => (data.is_fully_verified === true ? "exact_match" : "match");

// Assemble Blockscout's source layout ({source_code, additional_sources}) into
// the { path: content } tree the Sourcify path returns.
function blockscoutSources(data) {
  const sources = {};
  const mainPath =
    typeof data.file_path === "string" && data.file_path.replace(/\.sol$/, "").trim()
      ? data.file_path
      : `${data.name || "Contract"}.sol`;
  sources[mainPath] = typeof data.source_code === "string" ? data.source_code : "";
  for (const extra of Array.isArray(data.additional_sources) ? data.additional_sources : []) {
    if (extra && typeof extra.file_path === "string" && typeof extra.source_code === "string") {
      sources[extra.file_path] = extra.source_code;
    }
  }
  return sources;
}

// Cap a { path: content } source tree at MAX_SOURCE_BYTES total — trim
// gigantic trees rather than 500. Shared by the Sourcify and Blockscout paths
// of contract-source. Entries may be raw strings or Sourcify's {content}.
const MAX_SOURCE_BYTES = 800_000;
function capSourceTree(rawSources) {
  const sources = {};
  let total = 0, truncated = false;
  for (const [path, entry] of Object.entries(rawSources || {})) {
    const content = typeof entry === "string" ? entry : entry?.content || "";
    if (total + content.length > MAX_SOURCE_BYTES) {
      const room = Math.max(0, MAX_SOURCE_BYTES - total);
      sources[path] = content.slice(0, room);
      truncated = true;
      break;
    }
    sources[path] = content;
    total += content.length;
  }
  return { sources, truncated };
}

// Derive the human-readable signature lists contract-abi returns from a raw
// ABI array — same derivation for both providers.
function deriveAbiViews(abi) {
  const functions = abi
    .filter((x) => x.type === "function" && x.name)
    .map((x) => { const sig = signatureOf(x); return { signature: sig, selector: selectorOf(sig), stateMutability: x.stateMutability ?? null }; });
  const events = abi
    .filter((x) => x.type === "event" && x.name)
    .map((x) => ({ signature: signatureOf(x), topic: "0x" + keccak256(signatureOf(x)) }));
  return { functions, events };
}

// Small JSON GET against a fixed keyless upstream (Sourcify / openchain /
// 4byte / Blockscout). Hosts are hardcoded by the handlers, so this is not an
// SSRF surface, but every fetch still rides the guarded dispatcher by
// convention.
async function getJson(url, upstream) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      dispatcher: ssrfDispatcher,
    });
  } catch {
    throw bad(`${upstream} did not respond - try again shortly`, 504);
  }
  if (res.status === 429) throw bad(`${upstream} rate limit reached - retry shortly`, 503);
  if (!res.ok && res.status !== 404) throw bad(`${upstream} error (HTTP ${res.status})`, 502);
  let data;
  try { data = await res.json(); } catch { throw bad(`${upstream} returned non-JSON`, 502); }
  return { status: res.status, data };
}

// ============================================================================
// Minimal ABI decoding — pure CPU, no external library. Supports the standard
// ABI type grammar: uintN/intN/address/bool/bytesN/bytes/string/function,
// fixed + dynamic arrays, and (nested) tuples.
// ============================================================================

// Split "address,uint256,(uint8,bytes)[]" on top-level commas.
function splitTypes(inner) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (depth !== 0) throw bad("Unbalanced parentheses in signature");
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function arrayInfo(t) {
  const m = t.match(/^(.*)\[(\d*)\]$/);
  if (!m) return null;
  return { base: m[1], len: m[2] === "" ? null : parseInt(m[2], 10) };
}

function tupleComponents(t) {
  return t.startsWith("(") && t.endsWith(")") ? splitTypes(t.slice(1, -1)) : null;
}

function isDynamicType(t) {
  const a = arrayInfo(t);
  if (a) return a.len === null || isDynamicType(a.base);
  const c = tupleComponents(t);
  if (c) return c.some(isDynamicType);
  return t === "bytes" || t === "string";
}

// Bytes a type's head occupies inside a tuple encoding.
function headBytes(t) {
  if (isDynamicType(t)) return 32;
  const a = arrayInfo(t);
  if (a) return a.len * headBytes(a.base);
  const c = tupleComponents(t);
  if (c) return c.reduce((s, x) => s + headBytes(x), 0);
  return 32;
}

// data: lowercase hex string WITHOUT 0x. Offsets/lengths in bytes.
function sliceHex(data, byteOff, byteLen) {
  if (byteOff < 0 || byteLen < 0 || (byteOff + byteLen) * 2 > data.length) {
    throw bad("Calldata too short for the declared parameter types");
  }
  return data.slice(byteOff * 2, (byteOff + byteLen) * 2);
}

const wordUint = (data, off) => BigInt("0x" + (sliceHex(data, off, 32) || "0"));

function decodeStatic(t, data, pos) {
  const a = arrayInfo(t);
  if (a) {
    const vals = [];
    const step = headBytes(a.base);
    for (let i = 0; i < a.len; i++) vals.push(decodeStatic(a.base, data, pos + i * step));
    return vals;
  }
  const c = tupleComponents(t);
  if (c) return decodeTuple(c, data, pos);
  const w = sliceHex(data, pos, 32);
  if (t === "address") return "0x" + w.slice(24);
  if (t === "bool") return BigInt("0x" + w) !== 0n;
  if (/^uint(\d+)?$/.test(t)) return BigInt("0x" + w).toString(10);
  if (/^int(\d+)?$/.test(t)) {
    let v = BigInt("0x" + w);
    if (v >= 1n << 255n) v -= 1n << 256n; // ABI sign-extends to 256 bits
    return v.toString(10);
  }
  const bm = t.match(/^bytes(\d+)$/);
  if (bm) {
    const n = parseInt(bm[1], 10);
    if (n < 1 || n > 32) throw bad(`Invalid ABI type "${t}"`);
    return "0x" + w.slice(0, n * 2);
  }
  if (t === "function") return "0x" + w.slice(0, 48);
  throw bad(`Unsupported ABI type "${t}"`);
}

function decodeDynamic(t, data, loc) {
  if (t === "bytes" || t === "string") {
    const len = Number(wordUint(data, loc));
    if (!Number.isSafeInteger(len) || len > 1_000_000) throw bad("Declared dynamic length is implausibly large");
    const raw = sliceHex(data, loc + 32, len);
    return t === "bytes" ? "0x" + raw : Buffer.from(raw, "hex").toString("utf8");
  }
  const a = arrayInfo(t);
  if (a && a.len === null) {
    const len = Number(wordUint(data, loc));
    if (!Number.isSafeInteger(len) || len > 10_000) throw bad("Declared array length is implausibly large");
    return decodeTuple(Array(len).fill(a.base), data, loc + 32);
  }
  if (a) return decodeTuple(Array(a.len).fill(a.base), data, loc); // fixed array, dynamic base
  const c = tupleComponents(t);
  if (c) return decodeTuple(c, data, loc);
  throw bad(`Unsupported ABI type "${t}"`);
}

function decodeTuple(types, data, base) {
  const out = [];
  let pos = base;
  for (const t of types) {
    if (isDynamicType(t)) {
      const rel = Number(wordUint(data, pos));
      if (!Number.isSafeInteger(rel) || rel > data.length / 2) throw bad("Invalid dynamic-offset pointer in calldata");
      out.push(decodeDynamic(t, data, base + rel));
      pos += 32;
    } else {
      out.push(decodeStatic(t, data, pos));
      pos += headBytes(t);
    }
  }
  return out;
}

// Canonical type string for an ABI input entry (expands tuples).
function canonicalType(input) {
  const t = String(input.type || "");
  if (t.startsWith("tuple")) {
    const suffix = t.slice(5); // "", "[]", "[3]", …
    return "(" + (input.components || []).map(canonicalType).join(",") + ")" + suffix;
  }
  return t;
}

function signatureOf(abiItem) {
  return `${abiItem.name}(${(abiItem.inputs || []).map(canonicalType).join(",")})`;
}

export function selectorOf(signature) {
  return "0x" + keccak256(signature).slice(0, 8);
}

// Classify a JSON-RPC node error for tx-simulate: is it the node's verdict
// that the transaction would fail ("revert"), or a node-side problem
// ("error" — rate limit, method not found, connectivity) that must surface
// as a 502 instead of a false {success:false, revertReason} result?
// JSON-RPC error code 3 is the standard "execution reverted" code.
export function classifyRpcError(msg, code) {
  if (code === 3) return "revert";
  if (/revert|out of gas|insufficient funds|execution reverted/i.test(msg || "")) return "revert";
  return "error";
}

// Parse "transfer(address,uint256)" → { name, types[] }.
function parseSignature(sig) {
  const s = String(sig).trim();
  const open = s.indexOf("(");
  if (open <= 0 || !s.endsWith(")")) throw bad(`"signature" must look like name(type1,type2,…) - got "${s.slice(0, 80)}"`);
  return { name: s.slice(0, open), types: splitTypes(s.slice(open + 1, -1)) };
}

// ============================================================================
// Signature-DB lookup — openchain.xyz primary, 4byte.directory fallback.
// Shared by selector-lookup and calldata-decode's no-ABI path.
// ============================================================================
async function lookupSignatures(hex, kind) {
  // openchain.xyz — filter=true drops known-junk collisions.
  try {
    const param = kind === "event" ? "event" : "function";
    const { data } = await getJson(
      `https://api.openchain.xyz/signature-database/v1/lookup?${param}=${hex}&filter=true`,
      "openchain.xyz"
    );
    const rows = data?.result?.[param]?.[hex];
    if (Array.isArray(rows) && rows.length) {
      return { signatures: rows.map((r) => r.name).filter(Boolean), source: "openchain.xyz" };
    }
  } catch { /* fall through to 4byte */ }
  const path = kind === "event" ? "event-signatures" : "signatures";
  const { data } = await getJson(
    `https://www.4byte.directory/api/v1/${path}/?hex_signature=${hex}`,
    "4byte.directory"
  );
  const rows = Array.isArray(data?.results) ? data.results : [];
  // Earliest submission first — overwhelmingly the canonical signature.
  rows.sort((a, b) => (a.id || 0) - (b.id || 0));
  return { signatures: rows.map((r) => r.text_signature).filter(Boolean), source: "4byte.directory" };
}

// ============================================================================
// solidity-scan — fixed deterministic ruleset. A heuristic pattern check over
// raw source text (line-based), NOT a compiler, NOT an audit, NOT an LLM.
// ============================================================================
const SCAN_MAX_BYTES = 512 * 1024;
const SCAN_RULES = [
  {
    rule: "tx-origin", severity: "high", pattern: /\btx\.origin\b/,
    message: "tx.origin used - authentication via tx.origin is phishable; use msg.sender.",
  },
  {
    rule: "delegatecall", severity: "high", pattern: /\.delegatecall\s*[({]/,
    message: "delegatecall used - callee code runs in this contract's storage context; ensure the target is trusted and immutable.",
  },
  {
    rule: "selfdestruct", severity: "high", pattern: /\b(selfdestruct|suicide)\s*\(/,
    message: "selfdestruct present - the contract can be destroyed and its balance force-sent.",
  },
  {
    rule: "unchecked-low-level-call", severity: "high",
    pattern: /\.call(\{[^}]*\})?\s*\(/,
    // Only fires when the line neither captures the success bool nor wraps in require.
    exclude: /\(\s*bool\b|require\s*\(|revert\b/,
    message: "Low-level .call() whose success flag appears unchecked - a failed call is silently ignored.",
  },
  // NOTE: a checked .call() (success bool captured / require-wrapped) is
  // downgraded to an informational "low-level-call" finding inside the scan
  // loop — see the exclude branch below.
  {
    rule: "unchecked-send", severity: "medium", pattern: /\.send\s*\(/, exclude: /require\s*\(|\(\s*bool\b/,
    message: ".send() return value appears unchecked - a failed transfer is silently ignored.",
  },
  {
    rule: "floating-pragma", severity: "low", pattern: /pragma\s+solidity\s*(\^|>=?)/,
    message: "Floating pragma - pin an exact compiler version for reproducible builds.",
  },
  {
    rule: "block-timestamp", severity: "low", pattern: /\bblock\.timestamp\b|\bnow\b/,
    message: "block.timestamp/now used - miner-influenceable within ~15s; avoid as a strict randomness or deadline source.",
  },
  {
    rule: "weak-randomness", severity: "medium", pattern: /\bblockhash\s*\(|\bblock\.(difficulty|prevrandao)\b/,
    message: "Block-derived entropy (blockhash/prevrandao/difficulty) - predictable and miner-influenceable; not a randomness source.",
  },
  {
    rule: "inline-assembly", severity: "info", pattern: /\bassembly\s*[({]/,
    message: "Inline assembly - bypasses Solidity safety checks; review manually.",
  },
  {
    rule: "ecrecover", severity: "info", pattern: /\becrecover\s*\(/,
    message: "ecrecover used - check for signature malleability and the zero-address failure result.",
  },
];

function scanSolidity(source) {
  const lines = source.split(/\r?\n/);
  const findings = [];
  const seen = new Set(); // one finding per rule per line
  lines.forEach((line, idx) => {
    const code = line.replace(/\/\/.*$/, ""); // strip line comments — rules match code, not prose
    for (const r of SCAN_RULES) {
      if (!r.pattern.test(code)) continue;
      if (r.exclude && r.exclude.test(code)) {
        // The call is checked — downgrade to the informational sibling once.
        if (r.rule === "unchecked-low-level-call") {
          const key = `low-level-call:${idx}`;
          if (!seen.has(key)) {
            seen.add(key);
            findings.push({ rule: "low-level-call", severity: "info", line: idx + 1, snippet: line.trim().slice(0, 160), message: "Low-level .call() used (success flag is checked) - verify reentrancy posture." });
          }
        }
        continue;
      }
      const key = `${r.rule}:${idx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ rule: r.rule, severity: r.severity, line: idx + 1, snippet: line.trim().slice(0, 160), message: r.message });
    }
  });
  // File-level rules
  if (!/SPDX-License-Identifier/.test(source)) {
    findings.push({ rule: "missing-spdx", severity: "info", line: 1, snippet: null, message: "No SPDX-License-Identifier comment found." });
  }
  if (/\.call\{\s*value\s*:/.test(source) && !/nonReentrant|ReentrancyGuard/.test(source)) {
    findings.push({ rule: "reentrancy-surface", severity: "medium", line: null, snippet: null, message: "Value-bearing external call present with no ReentrancyGuard/nonReentrant marker - verify checks-effects-interactions ordering." });
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.line || 0) - (b.line || 0));
  const summary = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;
  return { findings, summary };
}

// ============================================================================
// address-label — curated committed dataset of well-known EVM addresses.
// Pure CPU. Provenance rides on every response; refresh by editing this table.
// ============================================================================
const LABEL_DATASET_UPDATED = "2026-10-02";
const ADDRESS_LABELS = {
  // --- Stablecoins + majors ---
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": [{ label: "USDC", category: "token", network: "base", note: "Circle USD Coin (native)" }],
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": [{ label: "USDC", category: "token", network: "ethereum", note: "Circle USD Coin" }],
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": [{ label: "USDC", category: "token", network: "polygon", note: "Circle USD Coin (native)" }],
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": [{ label: "USDC.e", category: "token", network: "polygon", note: "Bridged USD Coin" }],
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": [{ label: "USDC", category: "token", network: "arbitrum", note: "Circle USD Coin (native)" }],
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85": [{ label: "USDC", category: "token", network: "optimism", note: "Circle USD Coin (native)" }],
  // The other settlement rails' stablecoins, copied from the accept config in
  // src/payments.js (each verified there against its EIP-712 domain);
  // test-address-label-settlement pins that every EVM settlement asset is here.
  "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": [{ label: "USDC", category: "token", network: "avalanche", note: "Circle USD Coin (native)" }],
  "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392": [{ label: "USDC", category: "token", network: "sei", note: "Circle USD Coin (native)" }],
  "0x754704bc059f8c67012fed69bc8a327a5aafb603": [{ label: "USDC", category: "token", network: "monad", note: "Circle USD Coin (native)" }],
  "0xceba9300f2b948710d2653dd7b07f33a8b32118c": [{ label: "USDC", category: "token", network: "celo", note: "Circle USD Coin (native)" }],
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": [{ label: "USDG", category: "token", network: "robinhood", note: "Global Dollar (USDG)" }],
  "0xdac17f958d2ee523a2206206994597c13d831ec7": [{ label: "USDT", category: "token", network: "ethereum", note: "Tether USD" }],
  "0x6b175474e89094c44da98b954eedeac495271d0f": [{ label: "DAI", category: "token", network: "ethereum", note: "Dai Stablecoin" }],
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": [{ label: "WETH", category: "token", network: "ethereum", note: "Wrapped Ether" }],
  "0x4200000000000000000000000000000000000006": [{ label: "WETH", category: "token", network: "base", note: "Wrapped Ether (OP-stack predeploy - same address on Optimism)" }],
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": [{ label: "WBTC", category: "token", network: "ethereum", note: "Wrapped BTC" }],
  "0x514910771af9ca656af840dff83e8264ecf986ca": [{ label: "LINK", category: "token", network: "ethereum", note: "Chainlink token" }],
  // --- DEX routers ---
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": [{ label: "Uniswap V2 Router 02", category: "router", network: "ethereum" }],
  "0xe592427a0aece92de3edee1f18e0157c05861564": [{ label: "Uniswap V3 SwapRouter", category: "router", network: "ethereum" }],
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": [{ label: "Uniswap V3 SwapRouter02", category: "router", network: "ethereum" }],
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": [{ label: "Uniswap Universal Router", category: "router", network: "ethereum" }],
  "0x2626664c2603336e57b271c5c0b26f421741e481": [{ label: "Uniswap V3 SwapRouter02", category: "router", network: "base" }],
  "0x1111111254eeb25477b68fb85ed929f73a960582": [{ label: "1inch Aggregation Router v5", category: "router", network: "ethereum" }],
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": [{ label: "0x Exchange Proxy", category: "router", network: "ethereum" }],
  // --- Bridges / L2 infra ---
  "0x3154cf16ccdb4c6d922629664174b904d80f2c35": [{ label: "Base: L1 Standard Bridge", category: "bridge", network: "ethereum" }],
  "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1": [{ label: "Optimism: L1 Standard Bridge", category: "bridge", network: "ethereum" }],
  "0x8315177ab297ba92a06054ce80a67ed4dbd7ed3a": [{ label: "Arbitrum One: Bridge", category: "bridge", network: "ethereum" }],
  "0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f": [{ label: "Arbitrum One: Delayed Inbox", category: "bridge", network: "ethereum" }],
  "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf": [{ label: "Polygon (Matic): ERC20 Bridge", category: "bridge", network: "ethereum" }],
  // --- Exchange wallets ---
  "0x28c6c06298d514db089934071355e5743bf21d60": [{ label: "Binance 14", category: "exchange", network: "ethereum", note: "Hot wallet" }],
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": [{ label: "Binance 15", category: "exchange", network: "ethereum", note: "Hot wallet" }],
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": [{ label: "Binance 16", category: "exchange", network: "ethereum", note: "Hot wallet" }],
  "0xf977814e90da44bfa03b6295a0616a897441acec": [{ label: "Binance 8", category: "exchange", network: "ethereum", note: "Cold wallet" }],
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": [{ label: "Coinbase 1", category: "exchange", network: "ethereum" }],
  "0x503828976d22510aad0201ac7ec88293211d23da": [{ label: "Coinbase 2", category: "exchange", network: "ethereum" }],
  "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740": [{ label: "Coinbase 3", category: "exchange", network: "ethereum" }],
  "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": [{ label: "Coinbase 10", category: "exchange", network: "ethereum" }],
  // --- Burn / system ---
  "0x0000000000000000000000000000000000000000": [{ label: "Zero address", category: "system", network: null, note: "Mint/burn sentinel" }],
  "0x000000000000000000000000000000000000dead": [{ label: "Burn address", category: "system", network: null }],
};

// ============================================================================
export const CONTRACT_TOOLS = [
  // ===========================================================================
  // contract-source — verified Solidity source + compiler metadata (Sourcify).
  // ===========================================================================
  {
    route: "POST /api/contract-source",
    name: "Verified contract source (Sourcify)",
    slug: "contract-source",
    category: "crypto",
    price: "$0.005",
    description:
      "Fetch the verified Solidity source files and compiler metadata for a contract address from Sourcify's open verification repository. Covers 8 EVM mainnets (ethereum, base, polygon, arbitrum, optimism, bsc, gnosis, celo). Contracts that were never verified return a structured {verified:false} miss, not an error. Feed the returned source into /api/solidity-scan for a heuristic pattern check.",
    tags: ["crypto", "contract", "smart-contract", "solidity", "source", "verified-source", "sourcify", "evm", "verification", "audit"],
    discovery: {
      bodyType: "json",
      input: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char contract address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism / bsc / gnosis / celo (default base)." },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          network: "base", chainId: 8453,
          verified: true, match: "exact_match", verifiedAt: "2024-08-08T13:59:29Z",
          compiler: { language: "Solidity", version: "0.6.12" },
          sourceCount: 2,
          sources: { "contracts/FiatTokenProxy.sol": "// SPDX-License-Identifier: MIT …" },
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const chain = pickSourcifyChain(i.network);
      let data;
      try {
        ({ data } = await getJson(
          `https://sourcify.dev/server/v2/contract/${chain.chainId}/${address}?fields=compilation,sources`,
          "Sourcify"
        ));
      } catch (e) {
        // Sourcify UPSTREAM failure (5xx/timeout/non-JSON — a clean 404 "never
        // verified" does not throw): serve from the chain's Blockscout instance.
        if (!isUpstreamFailure(e)) throw e;
        console.warn(`[contract] Sourcify failed (${e.message}) - falling back to Blockscout for chain ${chain.chainId}`);
        let bs = null;
        try { bs = await blockscoutContract(chain.chainId, address); } catch { /* both down → unavailable below */ }
        if (!bs) throw e; // no Blockscout host for this chain — surface the Sourcify error
        if (!bs.verified) throw verificationSourcesUnavailable();
        const { sources, truncated } = capSourceTree(blockscoutSources(bs.data));
        return {
          address, network: chain.name, chainId: chain.chainId,
          verified: true,
          match: blockscoutMatch(bs.data),
          verifiedAt: bs.data.verified_at ?? null,
          compiler: {
            language: bs.data.language ?? null,
            version: bs.data.compiler_version ?? null,
            name: null,
            contract: bs.data.name ?? null,
          },
          sourceCount: Object.keys(sources).length,
          sources,
          source: `Blockscout (${bs.host})`,
          note: `Served from Blockscout (${bs.host}) - Sourcify was unreachable.${truncated ? " Source tree exceeds 800KB - trailing files truncated." : ""}`,
          ...(truncated ? { truncated: true } : {}),
        };
      }
      if (!data || data.match == null) {
        return {
          address, network: chain.name, chainId: chain.chainId,
          verified: false, match: null, sources: null,
          note: "Contract is not verified on Sourcify for this chain - no source available.",
        };
      }
      // Cap the response: trim gigantic source trees rather than 500.
      const { sources, truncated } = capSourceTree(data.sources);
      const comp = data.compilation || {};
      return {
        address, network: chain.name, chainId: chain.chainId,
        verified: true,
        match: data.match,
        verifiedAt: data.verifiedAt ?? null,
        compiler: {
          language: comp.language ?? null,
          version: comp.compilerVersion ?? null,
          name: comp.compiler ?? null,
          contract: comp.fullyQualifiedName ?? comp.name ?? null,
        },
        sourceCount: Object.keys(data.sources || {}).length,
        sources,
        ...(truncated ? { truncated: true, note: "Source tree exceeds 800KB - trailing files truncated." } : {}),
      };
    },
  },

  // ===========================================================================
  // contract-abi — verified ABI for a contract address (Sourcify).
  // ===========================================================================
  {
    route: "POST /api/contract-abi",
    name: "Verified contract ABI (Sourcify)",
    slug: "contract-abi",
    category: "crypto",
    price: "$0.003",
    description:
      "Fetch the verified ABI for a contract address from Sourcify, plus a ready-to-use list of human-readable function signatures with their 4-byte selectors. Covers 8 EVM mainnets. Unverified contracts return a structured {verified:false} miss. Pair with /api/calldata-decode to decode transactions against this ABI.",
    tags: ["crypto", "contract", "smart-contract", "abi", "sourcify", "evm", "selector"],
    discovery: {
      bodyType: "json",
      input: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "base" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char contract address." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism / bsc / gnosis / celo (default base)." },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          network: "base", chainId: 8453,
          verified: true, match: "exact_match",
          abi: [{ name: "implementation", type: "function", inputs: [], outputs: [{ type: "address" }] }],
          functions: [{ signature: "implementation()", selector: "0x5c60da1b" }],
          events: [{ signature: "Upgraded(address)" }],
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const chain = pickSourcifyChain(i.network);
      let data;
      try {
        ({ data } = await getJson(
          `https://sourcify.dev/server/v2/contract/${chain.chainId}/${address}?fields=abi`,
          "Sourcify"
        ));
      } catch (e) {
        // Sourcify UPSTREAM failure: serve the ABI from Blockscout instead.
        if (!isUpstreamFailure(e)) throw e;
        console.warn(`[contract] Sourcify failed (${e.message}) - falling back to Blockscout for chain ${chain.chainId}`);
        let bs = null;
        try { bs = await blockscoutContract(chain.chainId, address); } catch { /* both down → unavailable below */ }
        if (!bs) throw e; // no Blockscout host for this chain — surface the Sourcify error
        if (!bs.verified || !Array.isArray(bs.data.abi)) throw verificationSourcesUnavailable();
        const { functions, events } = deriveAbiViews(bs.data.abi);
        return {
          address, network: chain.name, chainId: chain.chainId,
          verified: true,
          match: blockscoutMatch(bs.data),
          abi: bs.data.abi,
          functions,
          events,
          source: `Blockscout (${bs.host})`,
          note: `Served from Blockscout (${bs.host}) - Sourcify was unreachable.`,
        };
      }
      if (!data || !Array.isArray(data.abi)) {
        return {
          address, network: chain.name, chainId: chain.chainId,
          verified: false, abi: null,
          note: "Contract is not verified on Sourcify for this chain - no ABI available.",
        };
      }
      const { functions, events } = deriveAbiViews(data.abi);
      return {
        address, network: chain.name, chainId: chain.chainId,
        verified: true,
        match: data.match ?? null,
        abi: data.abi,
        functions,
        events,
      };
    },
  },

  // ===========================================================================
  // solidity-scan — deterministic heuristic pattern scan (pure CPU).
  // ===========================================================================
  {
    route: "POST /api/solidity-scan",
    name: "Solidity heuristic pattern scan",
    slug: "solidity-scan",
    category: "crypto",
    price: "$0.01",
    description:
      "Deterministic static pattern scan of Solidity smart-contract source text - a fixed ruleset flagging tx.origin authentication, delegatecall, selfdestruct, unchecked low-level calls, unchecked .send(), floating pragmas, block-timestamp dependence, weak block-derived randomness, value-call reentrancy surface, inline assembly, ecrecover, and missing SPDX headers. Returns line-anchored findings with severities. This is a heuristic pattern check for triage - it is NOT a compiler, NOT a formal audit, and uses no AI. Pair with /api/contract-source to scan any verified contract.",
    tags: ["crypto", "solidity", "smart-contract", "security", "audit", "auditor", "static-analysis", "contract", "scan", "evm"],
    discovery: {
      bodyType: "json",
      input: {
        source: "pragma solidity ^0.8.0;\ncontract Wallet {\n  function drain(address payable to) external {\n    require(tx.origin == msg.sender);\n    to.call{value: address(this).balance}(\"\");\n  }\n}",
      },
      inputSchema: {
        properties: {
          source: { type: "string", description: "Solidity source text to scan (max 512KB)." },
        },
        required: ["source"],
      },
      output: {
        example: {
          lines: 7,
          findings: [
            { rule: "tx-origin", severity: "high", line: 4, snippet: "require(tx.origin == msg.sender);", message: "tx.origin used - authentication via tx.origin is phishable; use msg.sender." },
          ],
          summary: { high: 2, medium: 1, low: 1, info: 1 },
          disclaimer: "Deterministic heuristic pattern check - not a compiler, not an audit.",
        },
      },
    },
    handler: async (i) => {
      const source = typeof i.source === "string" ? i.source : "";
      if (!source.trim()) throw bad(`"source" is required - Solidity source text to scan`);
      if (Buffer.byteLength(source, "utf8") > SCAN_MAX_BYTES) {
        throw bad(`"source" is capped at ${SCAN_MAX_BYTES / 1024}KB`, 413);
      }
      const { findings, summary } = scanSolidity(source);
      return {
        lines: source.split(/\r?\n/).length,
        findings,
        summary,
        disclaimer: "Deterministic heuristic pattern check - not a compiler, not an audit.",
      };
    },
  },

  // ===========================================================================
  // calldata-decode — decode tx calldata via supplied ABI/signature, with a
  // signature-DB fallback for unknown selectors.
  // ===========================================================================
  {
    route: "POST /api/calldata-decode",
    name: "Calldata decoder (ABI or selector DB)",
    slug: "calldata-decode",
    category: "crypto",
    price: "$0.003",
    description:
      "Decode EVM smart-contract transaction calldata into the function name and typed parameters. Supply an ABI (from /api/contract-abi) or a signature like transfer(address,uint256) for a fully offline decode; with neither, the 4-byte selector is resolved via the openchain.xyz signature database (4byte.directory fallback) and each candidate signature is tried. Unknown selectors return a documented partial decode (selector + raw 32-byte words) instead of an error.",
    tags: ["crypto", "calldata", "decode", "abi", "selector", "evm", "transaction", "smart-contract"],
    discovery: {
      bodyType: "json",
      input: { data: "0xa9059cbb000000000000000000000000abf4fabd7c416fb67202e5f9002389fc75e2a9d000000000000000000000000000000000000000000000000000000000000f4240" },
      inputSchema: {
        properties: {
          data: { type: "string", description: "0x-prefixed calldata (selector + encoded args). Max 100KB." },
          abi: { type: "array", description: "Optional contract ABI (JSON array) - enables a fully offline decode with parameter names." },
          signature: { type: "string", description: "Optional function signature, e.g. transfer(address,uint256) - offline decode without a full ABI." },
        },
        required: ["data"],
      },
      output: {
        example: {
          selector: "0xa9059cbb",
          decoded: true,
          name: "transfer",
          signature: "transfer(address,uint256)",
          params: [
            { type: "address", name: null, value: "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0" },
            { type: "uint256", name: null, value: "1000000" },
          ],
          source: "openchain.xyz",
        },
      },
    },
    handler: async (i) => {
      const raw = typeof i.data === "string" ? i.data.trim() : "";
      if (!HEX_RE.test(raw) || raw.length < 10) {
        throw bad(`"data" must be 0x-prefixed hex calldata of at least 4 bytes (selector)`);
      }
      if (raw.length > 200_010) throw bad(`"data" is capped at 100KB of calldata`, 413);
      if ((raw.length - 2) % 2 !== 0) throw bad(`"data" has an odd number of hex digits`);
      const hex = raw.slice(2).toLowerCase();
      const selector = "0x" + hex.slice(0, 8);
      const body = hex.slice(8);
      const words = [];
      for (let p = 0; p + 64 <= body.length && words.length < 64; p += 64) words.push("0x" + body.slice(p, p + 64));

      const tryDecode = (sig, names = null) => {
        const { name, types } = parseSignature(sig);
        const values = decodeTuple(types, body, 0);
        return {
          selector, decoded: true, name,
          signature: `${name}(${types.join(",")})`,
          params: types.map((t, idx) => ({ type: t, name: names?.[idx] ?? null, value: values[idx] })),
        };
      };

      // 1) Full ABI supplied → offline decode with parameter names.
      if (Array.isArray(i.abi) && i.abi.length) {
        for (const item of i.abi) {
          if (item?.type !== "function" || !item.name) continue;
          const sig = signatureOf(item);
          if (selectorOf(sig) !== selector) continue;
          const names = (item.inputs || []).map((inp) => inp.name || null);
          return { ...tryDecode(sig, names), source: "abi" };
        }
        throw bad(`Selector ${selector} not found in the supplied ABI`);
      }
      // 2) Signature supplied → offline decode.
      if (typeof i.signature === "string" && i.signature.trim()) {
        const sig = i.signature.trim();
        if (selectorOf(`${parseSignature(sig).name}(${parseSignature(sig).types.join(",")})`) !== selector) {
          throw bad(`Supplied signature hashes to a different selector than the calldata's ${selector}`);
        }
        return { ...tryDecode(sig), source: "provided-signature" };
      }
      // 3) Selector-DB fallback (egress) — try each candidate until one decodes.
      // Prefer candidates that consume the calldata exactly: for an all-static
      // signature the encoded length is exactly sum(headBytes), so a candidate
      // that decodes but leaves trailing bytes is likely a selector collision —
      // keep it only as a last resort. Dynamic signatures can't be measured
      // cheaply (tail layout is offset-driven; offsets already validate against
      // the data length), so they are accepted as-is.
      const { signatures, source } = await lookupSignatures(selector, "function");
      let partial = null;
      for (const sig of signatures) {
        try {
          const res = { ...tryDecode(sig), source };
          const { types } = parseSignature(sig);
          if (types.every((t) => !isDynamicType(t)) &&
              types.reduce((s, t) => s + headBytes(t), 0) * 2 !== body.length) {
            if (!partial) partial = res; // decodes, but ignores trailing calldata
            continue;
          }
          return res;
        } catch { /* collision — try next */ }
      }
      if (partial) return partial;
      return {
        selector,
        decoded: false,
        signature: null,
        candidates: signatures.slice(0, 10),
        words,
        note: signatures.length
          ? "Known signatures for this selector did not decode cleanly against the calldata - raw 32-byte words returned."
          : "Unknown selector - not in the openchain.xyz/4byte.directory signature databases. Raw 32-byte words returned.",
      };
    },
  },

  // ===========================================================================
  // selector-lookup — 4-byte selector / 32-byte event topic → known signatures.
  // ===========================================================================
  {
    route: "POST /api/selector-lookup",
    name: "Function selector / event topic lookup",
    slug: "selector-lookup",
    category: "crypto",
    price: "$0.002",
    description:
      "Resolve a 4-byte function selector or a 32-byte event topic hash to its known human-readable Solidity signatures, via the openchain.xyz signature database with 4byte.directory as fallback. Unknown selectors return {found:false} with an empty list, not an error.",
    tags: ["crypto", "selector", "4byte", "signature", "event", "topic", "evm", "smart-contract", "solidity"],
    discovery: {
      bodyType: "json",
      input: { selector: "0xa9059cbb" },
      inputSchema: {
        properties: {
          selector: { type: "string", description: "0x-prefixed 4-byte function selector (10 chars) or 32-byte event topic hash (66 chars)." },
        },
        required: ["selector"],
      },
      output: {
        example: {
          selector: "0xa9059cbb",
          kind: "function",
          found: true,
          signatures: ["transfer(address,uint256)"],
          source: "openchain.xyz",
        },
      },
    },
    handler: async (i) => {
      const raw = typeof i.selector === "string" ? i.selector.trim().toLowerCase() : "";
      if (!/^0x[a-f0-9]{8}$/.test(raw) && !/^0x[a-f0-9]{64}$/.test(raw)) {
        throw bad(`"selector" must be a 0x-prefixed 4-byte function selector (e.g. 0xa9059cbb) or 32-byte event topic hash`);
      }
      const kind = raw.length === 10 ? "function" : "event";
      const { signatures, source } = await lookupSignatures(raw, kind);
      return { selector: raw, kind, found: signatures.length > 0, signatures: signatures.slice(0, 25), source };
    },
  },

  // ===========================================================================
  // tx-simulate — read-only eth_call simulation + gas estimate (public RPCs).
  // ===========================================================================
  {
    route: "POST /api/tx-simulate",
    name: "Transaction simulation (eth_call + gas)",
    slug: "tx-simulate",
    category: "crypto",
    price: "$0.005",
    description:
      "Dry-run a prospective smart-contract call or transaction without broadcasting it: executes eth_call and eth_estimateGas against the latest block over the same keyless multi-endpoint public RPC pool as /api/evm-rpc (ethereum, base, polygon, arbitrum, optimism). Returns the return data and a gas estimate on success, or {success:false} with the revert reason when the call would fail. Strictly read-only - nothing is signed or broadcast.",
    tags: ["crypto", "simulation", "eth_call", "gas", "transaction", "evm", "dry-run", "smart-contract"],
    discovery: {
      bodyType: "json",
      input: {
        network: "base",
        to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        data: "0x70a08231000000000000000000000000abf4fabd7c416fb67202e5f9002389fc75e2a9d0",
      },
      inputSchema: {
        properties: {
          to: { type: "string", description: "0x-prefixed 40-char target contract/account address." },
          data: { type: "string", description: "0x-prefixed calldata (default 0x - plain value transfer)." },
          from: { type: "string", description: "Optional sender address (default zero address)." },
          value: { type: "string", description: "Optional value in wei - decimal string or 0x hex (default 0)." },
          network: { type: "string", description: "ethereum / base / polygon / arbitrum / optimism (default base)." },
        },
        required: ["to"],
      },
      output: {
        example: {
          network: "base",
          success: true,
          returnData: "0x00000000000000000000000000000000000000000000000000000000000f4240",
          gasEstimate: 31234,
          revertReason: null,
        },
      },
    },
    handler: async (i) => {
      const network = pickNetwork(i.network);
      // Extract the trimmed node message from a publicJsonRpc "Node error:"
      // throw, or null when the error isn't a node-level JSON-RPC error.
      const nodeErrMsg = (e) =>
        e?.statusCode === 502 && /^Node error:/i.test(e.message || "")
          ? e.message.replace(/^Node error:\s*/i, "").trim()
          : null;
      const to = takeAddress(i.to, "to");
      const call = { to };
      if (i.from !== undefined) call.from = takeAddress(i.from, "from");
      const data = i.data === undefined || i.data === null ? "0x" : String(i.data).trim();
      if (!HEX_RE.test(data)) throw bad(`"data" must be 0x-prefixed hex calldata`);
      if (data.length > 200_010) throw bad(`"data" is capped at 100KB of calldata`, 413);
      if ((data.length - 2) % 2 !== 0) throw bad(`"data" has an odd number of hex digits`);
      if (data !== "0x") call.data = data.toLowerCase();
      if (i.value !== undefined && i.value !== null && i.value !== "") {
        const v = String(i.value).trim();
        let wei;
        try { wei = BigInt(v); } catch { throw bad(`"value" must be a wei amount - decimal string or 0x hex`); }
        if (wei < 0n) throw bad(`"value" must be non-negative`);
        if (wei > 0n) call.value = "0x" + wei.toString(16);
      }
      // A node-level "execution reverted" is the simulation's verdict, not an
      // upstream failure — surface it as a structured result. Everything else a
      // node reports (rate limit, method not found, connection trouble) is a
      // tool failure and must stay a 502, never a false {success:false} verdict.
      let returnData = null, revertReason = null, success = true;
      try {
        returnData = await publicJsonRpc(network, "eth_call", [call, "latest"]);
      } catch (e) {
        const msg = nodeErrMsg(e);
        if (msg === null) throw e;
        if (classifyRpcError(msg, e.rpcCode) !== "revert") {
          throw bad(`RPC node error during simulation: ${msg.slice(0, 200)}`, 502);
        }
        success = false;
        revertReason = msg;
      }
      let gasEstimate = null;
      if (success) {
        try {
          const gasHex = await publicJsonRpc(network, "eth_estimateGas", [call]);
          gasEstimate = parseInt(gasHex, 16);
        } catch (e) {
          const msg = nodeErrMsg(e);
          if (msg === null) throw e;
          if (classifyRpcError(msg, e.rpcCode) !== "revert") {
            throw bad(`RPC node error during gas estimation: ${msg.slice(0, 200)}`, 502);
          }
          // eth_call succeeded but estimation reverted (state-dependent edge) —
          // keep the call result, leave the estimate null.
        }
      }
      return { network: network.name, success, returnData, gasEstimate, revertReason };
    },
  },

  // ===========================================================================
  // address-label — curated known-address labels (pure CPU, committed dataset).
  // ===========================================================================
  {
    route: "POST /api/address-label",
    name: "Known-address label lookup",
    slug: "address-label",
    category: "crypto",
    price: "$0.002",
    description:
      "Label a known EVM address from a curated, committed dataset: major stablecoin + token contracts (the USDC and USDG contracts of every EVM chain we settle on, USDC on Ethereum, USDT, DAI, WETH, WBTC), DEX routers (Uniswap, 1inch, 0x), canonical L1↔L2 bridges, large exchange hot/cold wallets, and burn/system addresses. Deterministic and offline - the provenance field states the dataset revision. Unknown addresses return {found:false}, not an error.",
    tags: ["crypto", "address", "label", "exchange", "bridge", "router", "token", "evm"],
    discovery: {
      bodyType: "json",
      input: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      inputSchema: {
        properties: {
          address: { type: "string", description: "0x-prefixed 40-char EVM address to label." },
        },
        required: ["address"],
      },
      output: {
        example: {
          address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          found: true,
          labels: [{ label: "USDC", category: "token", network: "base", note: "Circle USD Coin (native)" }],
          provenance: { source: "curated in-repo dataset", updated: "2026-10-02", entries: 39 },
        },
      },
    },
    handler: async (i) => {
      const address = takeAddress(i.address);
      const labels = ADDRESS_LABELS[address] || [];
      return {
        address,
        found: labels.length > 0,
        labels,
        provenance: {
          source: "curated in-repo dataset",
          updated: LABEL_DATASET_UPDATED,
          entries: Object.keys(ADDRESS_LABELS).length,
        },
      };
    },
  },
];
