// Live consolidated revenue view — one page instead of three explorer tabs.
//
// /api/revenue (JSON) + /revenue (HTML) read, server-side and best-effort,
// every rail's wallet balance and the recent inbound stablecoin transfers:
// Base / Polygon / Arbitrum / Robinhood Chain via public-RPC eth_getLogs
// (same approach as scripts/revenue-scan.js), Solana via
// getTokenAccountsByOwner. Results are cached for 60s so a page refresh is
// instant and public RPCs see at most one scan a minute; a flaky chain shows
// "unavailable" for that rail instead of breaking the page. Balances and
// transfers are public on-chain data — this page just saves the tab-cycling.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { standingBand } from "./standing.js";
import { join } from "node:path";
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { RAILS, RAILS_AMP } from "./rails.js";
// Pure, main-guarded helpers shared with the daily scanners — one
// classification rule everywhere: a transfer is external revenue only if the
// payer isn't one of OUR wallets (canary/test burners) AND the amount is a
// plausible per-call price. Internal test money is shown but never counted.
import { usdcDeltaForOwner, payerFromMeta, isExternalPayment } from "../scripts/revenue-scan-solana.js";
import { cdpSql, cdpConfigured } from "./tools/cdp-kit.js";
import { redactSecrets } from "./tools/redact.js";

// Every string in this module that can reach /api/revenue goes through here.
//
// The rail scanners put upstream failure text straight into `rail.error`, and
// /api/revenue is unauthenticated. Eleven of the RPC endpoints they walk carry
// ALCHEMY_API_KEY in the URL PATH, and an upstream can echo its request back in
// an error body - which is exactly how the key reached the public
// /api/leaderboard body in the 2026-08-18 leak. leaderboard.js, mpp-leaderboard
// .js, solana-leaderboard.js and tempo-transfers.js all redact for that reason;
// this module was the one public error surface that did not.
//
// Redact first, THEN truncate: slicing first can cut a secret in half and leave
// a matchable prefix that the redactor no longer recognises.
export const pubErr = (e, max = 120) => redactSecrets(String(e?.message || e)).slice(0, max);

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Same envs (and defaults) as scripts/revenue-scan{,-solana}.js.
export const MAX_CALL_USD = parseFloat(process.env.MAX_CALL_USD || "0.75");
// Audited 2026-08-30: our own payTo addresses were absent from all four sets
// below. They are RECEIVERS, so a payer-classification set arguably need not
// carry them, and none has ever appeared as a payer - checked against both the
// ledger and telemetry before adding. They are listed anyway because a
// self-payment counted as external REVENUE is the error nobody would spot, and
// the belt costs one string per chain.
//
// The same audit found two wallets that PAY and were also absent, which is not
// cosmetic: 0xaF13AA07… is the Tempo upstream buyer (it pays external MPP
// sellers) and 0x130Ce484… is the Tempo subscription gas sponsor. Neither has
// ever bought from us, so nothing was miscounted - but a payer missing from
// this set books our own spend as somebody else's revenue, and both addresses
// live only inside Railway keys with no _ADDRESS variable, so nothing in the
// tree could have told you they existed. Derived from the keys, not guessed.
export const OUR_EVM_WALLETS = new Set(
  // Canary/burner EVM addresses (public; keys live only in CI). Rotated
  // 2026-07-17: 0xfeda7403… retired (drained), 0x902dcf34… is the current
  // burner. 0x77065d81… is the Base x402 SPENDING wallet (X402_UPSTREAM_BUYER_ADDRESS
  // on Railway) — its sweeps to the treasury are internal moves, never revenue.
  // All listed so historical AND ongoing self-flows stay internal.
  // 0x24e6a249… is the operator's AgentCore/Privy embedded TEST wallet (confirmed
  // 2026-08-20) — the buyer in the AgentCore Payments validation runs. Its
  // buys are self-funded test traffic on every chain it pays from, never
  // revenue (its first Tempo MPP buy classified external for a day because
  // tempo settles carried no payer; both halves fixed the same day).
  (process.env.OUR_WALLETS || "0xfeda7403aabe9a492ed70e810b396d8548a4a022,0x902dcf34e53695bdea2ffb354b1a2e58bd598256,0x77065d81e18ad403bcd6e9a0616b288e16744121,0x24e6a249111ae0cc8ea09f487a114f7e7ef15e12,0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0,0xaf13aa07e7360cc56b3dabf649ffef087c0cd5a6,0x130ce484c8046988ae8e2804289eaf4c7c67f30d")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
);
// Default = the canary's Solana burner (public address; the key lives only
// in CI secrets) — its daily $0.05 self-buys are internal, not revenue.
export const OUR_SOLANA_WALLETS = new Set(
  // The third entry is the Solana spending wallet (route-execute's upstream
  // payer; its public address, derived from SOLANA_UPSTREAM_BUYER_KEY).
  (process.env.OUR_SOLANA_WALLETS || "9EMAayAfBR32J5d3ApEAG3NdKArRBtAqN7LA8c2WRM5o,J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg,8KqQG8MefNvQEQmp9gBjov39DXcWsUpSeqjL9pPCGKKE")
    .split(",").map((s) => s.trim()).filter(Boolean)
);
// Same convention for Stellar: the canary burner's public address is committed;
// extend via env (comma-separated) if other internal wallets settle here.
export const OUR_STELLAR_WALLETS = new Set(
  (process.env.OUR_STELLAR_WALLETS || "GBA2DDJ4KQXQCGNB7RUU5I2BK5SXROJFUNZV7EZ4XUS7RXFOXEPNY6O4,GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL")
    .split(",").map((s) => s.trim()).filter(Boolean)
);
// Same convention for Algorand: the canary burner's public address is
// committed; extend via env (comma-separated) if other internal wallets
// settle here.
export const OUR_ALGORAND_WALLETS = new Set(
  // ZKFACA… = the CI canary burner; W4GZHN36… = the AVM SPENDING wallet
  // (ALGORAND_UPSTREAM_BUYER_MNEMONIC's address, verified on-chain as the
  // sender of settle 6TLUWU6R…MKAQ — positive provenance, never inferred).
  (process.env.OUR_ALGORAND_WALLETS || "ZKFACAZATPUUYUXVVVE7QWMMZTSMLGQVA4G4QKW7D2UI7FCIFE3QB2SHRE,W4GZHN36X35LGSJTTLNZNFPGSSBLMJKFLCMZK4NBLQGUS6PYPPCDB67UOE,C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE")
    .split(",").map((s) => s.trim()).filter(Boolean)
);

// Chain read-config. Stablecoin contracts mirror scripts/revenue-scan.js;
// span ≈ a few hours of blocks so "recent inbound" stays a cheap filtered read.
export const EVM = {
  base: {
    label: "Base", asset: "USDC", span: 30000,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://mainnet.base.org", "https://base.drpc.org",
    ],
    explorer: (a) => `https://basescan.org/address/${a}#tokentxns`,
    tx: (h) => `https://basescan.org/tx/${h}`,
  },
  polygon: {
    label: "Polygon", asset: "USDC", span: 20000,
    token: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    // Alchemy first (reliable getLogs); free RPCs fail on historical queries.
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://polygon.drpc.org",
    ],
    explorer: (a) => `https://polygonscan.com/address/${a}#tokentxns`,
    tx: (h) => `https://polygonscan.com/tx/${h}`,
  },
  arbitrum: {
    label: "Arbitrum", asset: "USDC", span: 90000,
    token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org",
    ],
    explorer: (a) => `https://arbiscan.io/address/${a}#tokentxns`,
    tx: (h) => `https://arbiscan.io/tx/${h}`,
  },
  monad: {
    // Monad L1, chain 143. Native Circle USDC. Fast blocks (~0.5s), so a wide
    // span keeps the daily canary settle inside the "recent inbound" window;
    // Alchemy natively serves Monad (monad-mainnet.g.alchemy.com) for the
    // balance read + getAssetTransfers, with the public RPC as fallback.
    label: "Monad", asset: "USDC", span: 200000,
    token: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://monad-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://rpc.monad.xyz", "https://rpc2.monad.xyz",
    ],
    explorer: (a) => `https://monadscan.com/address/${a}#tokentxns`,
    tx: (h) => `https://monadscan.com/tx/${h}`,
  },
  celo: {
    // Celo L2, chain 42220. Native Circle USDC. ~1s blocks, so 100k blocks
    // ≈ 28h keeps the daily canary settle inside the "recent inbound" window;
    // Alchemy natively serves Celo (celo-mainnet.g.alchemy.com), with the
    // cLabs-operated public forno RPC as fallback.
    label: "Celo", asset: "USDC", span: 100000,
    token: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://celo-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://forno.celo.org",
    ],
    explorer: (a) => `https://celoscan.io/address/${a}#tokentxns`,
    tx: (h) => `https://celoscan.io/tx/${h}`,
  },
  avalanche: {
    // Avalanche C-Chain, native Circle USDC. ~2s blocks → 50k ≈ 28h window.
    label: "Avalanche", asset: "USDC", span: 50000,
    token: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://avax-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com",
    ],
    explorer: (a) => `https://snowtrace.io/address/${a}`,
    tx: (h) => `https://snowtrace.io/tx/${h}`,
  },
  sei: {
    // Sei (pacific-1), native Circle USDC — NOT Noble's IBC token. ~0.4s
    // blocks → 250k ≈ 28h. No Alchemy lane; the Sei Foundation + publicnode
    // RPCs both serve getLogs over chunked ranges.
    // sei-apis caps eth_getLogs ranges at ~2,000 blocks (verified 2026-07-28:
    // a 1,900-block query succeeds where the scan's old 8,929-block chunks
    // were rejected EVERYWHERE - the 28/28 failure was range-cap, not egress).
    // 40000 blocks ≈ 4.4h at 0.4s; the lastInbound carry-forward persists any
    // settle the 10-minute refresh cadence sees, so daily-canary proof holds.
    label: "Sei", asset: "USDC", span: 40000, chunkBlocks: 1900,
    token: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392",
    // Relay-first when configured: evm-rpc.sei-apis.com errors every getLogs
    // from Railway's egress IPs (28/28 windows, 2026-07-28) while serving
    // residential clients fine, and publicnode archive-gates getLogs. The
    // Cloudflare relay (workers/sei-rpc-relay) moves the egress to CF's range.
    rpcs: [
      ...(process.env.SEI_RELAY_URL && process.env.SEI_RELAY_TOKEN
        ? [{ url: process.env.SEI_RELAY_URL.replace(/\/+$/, ""), headers: { Authorization: `Bearer ${process.env.SEI_RELAY_TOKEN}` } }]
        : []),
      "https://evm-rpc.sei-apis.com", "https://sei-evm-rpc.publicnode.com",
    ],
    explorer: (a) => `https://seiscan.io/address/${a}?chain=pacific-1`,
    tx: (h) => `https://seiscan.io/tx/${h}?chain=pacific-1`,
  },
  optimism: {
    // Optimism (OP mainnet, chain 10), native Circle USDC. ~2s blocks → 10.8k ≈ 6h.
    label: "Optimism", asset: "USDC", span: 10800,
    token: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    // Alchemy first (reliable getLogs, same rule as Polygon/Arbitrum);
    // publicnode archive-gates getLogs outright and mainnet.optimism.io
    // rate-limits datacenter egress.
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com",
    ],
    explorer: (a) => `https://optimistic.etherscan.io/address/${a}`,
    tx: (h) => `https://optimistic.etherscan.io/tx/${h}`,
  },
  robinhood: {
    // Measured ~0.15s blocks (not the 2s Orbit default) — 30k blocks was only
    // ~76 real minutes; 600k ≈ 25h so the daily canary settle stays visible.
    label: "Robinhood Chain", asset: "USDG", span: 600000,
    token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://rpc.mainnet.chain.robinhood.com",
    ],
    explorer: (a) => `https://robinhoodchain.blockscout.com/address/${a}`,
    tx: (h) => `https://robinhoodchain.blockscout.com/tx/${h}`,
  },
};
// Fallback matters: the card's per-tx decodes and the all-time ledger's
// backfill share these endpoints, and the public mainnet-beta RPC 429s under
// that contention — without a second lane the card loses its amount/external
// tags whenever the ledger is paging. Same list + env override as
// scripts/revenue-scan-solana.js.
// Alchemy first when the key is set (same key as the EVM rails) — it serves
// Solana JSON-RPC from a datacenter-reachable endpoint, so the balance read
// stops timing out against the rate-limited public RPCs. The publics stay as
// fallbacks (rpcCall walks the list on error/timeout).
export const SOLANA_RPCS = (process.env.SOLANA_RPCS || [
  ...(process.env.ALCHEMY_API_KEY ? [`https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

// Stellar/Algorand REST endpoints. Alchemy doesn't serve these chains, so each
// keeps a public primary plus a second independent provider (both verified
// live), walked on error/timeout. Comma-separated env overrides let ops drop in
// a keyed/dedicated RPC with no code change - "plenty of RPCs" on tap.
export const STELLAR_HORIZON_URLS = (process.env.STELLAR_HORIZON_URLS ||
  "https://horizon.stellar.org,https://horizon.stellar.lobstr.co"
).split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
export const ALGORAND_ALGOD_URLS = (process.env.ALGORAND_ALGOD_URLS ||
  "https://mainnet-api.algonode.cloud,https://mainnet-api.4160.nodely.dev"
).split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
export const ALGORAND_INDEXER_URLS = (process.env.ALGORAND_INDEXER_URLS ||
  "https://mainnet-idx.algonode.cloud,https://mainnet-idx.4160.nodely.dev"
).split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

// Nodely 403s Railway's shared egress IP outright (verified in-container
// 2026-07-16: both hostnames, any User-Agent — an IP-level block, and BOTH
// direct bases above are the same provider, so the walk cannot recover from
// prod). When the ALGORAND_RELAY_URL + ALGORAND_RELAY_TOKEN pair is set
// (workers/algorand-relay/ — same CF Worker pattern as the Sei RPC
// relays), the relay is walked FIRST; the direct bases stay in the list for
// local/dev runs and as insurance if the block is ever lifted.
const ALGORAND_RELAY_URL = (process.env.ALGORAND_RELAY_URL || "").trim().replace(/\/+$/, "");
const ALGORAND_RELAY_TOKEN = (process.env.ALGORAND_RELAY_TOKEN || "").trim();
const algorandRelayEntry = (kind) =>
  ALGORAND_RELAY_URL && ALGORAND_RELAY_TOKEN
    ? [{ url: `${ALGORAND_RELAY_URL}/${kind}`, headers: { Authorization: `Bearer ${ALGORAND_RELAY_TOKEN}` } }]
    : [];
export const ALGORAND_ALGOD_BASES = [...algorandRelayEntry("algod"), ...ALGORAND_ALGOD_URLS];
export const ALGORAND_INDEXER_BASES = [...algorandRelayEntry("idx"), ...ALGORAND_INDEXER_URLS];

// GET JSON across a list of bases, walking to the next on any failure
// (network / timeout / non-2xx). A base is a plain URL string or
// { url, headers } — the object form exists for the Cloudflare relay entries,
// which need a Bearer token. Returns the first success (or the last failure)
// as { ok, status, json, base }. The 10s default deadline (up from 6s) is
// deliberate: these public endpoints are slow-but-working from Railway's
// datacenter IP, not dead, and the short timeout was the main cause of the
// "unreachable" flapping. okStatuses lets a caller treat e.g. 404 (Algorand
// fresh-wallet, no ASA opt-in) as a valid non-error response.
export async function getJsonAcross(bases, path, { timeoutMs = 10000, okStatuses = [] } = {}) {
  let last = { ok: false, status: 0, json: null, base: null, error: "no endpoints" };
  for (const entry of bases) {
    const base = typeof entry === "string" ? entry : entry?.url;
    const headers = typeof entry === "string" ? undefined : entry?.headers;
    if (!base) continue;
    try {
      const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok || okStatuses.includes(res.status)) {
        let json = null;
        try { json = await res.json(); } catch { /* an ok-status body may be empty (404) */ }
        return { ok: true, status: res.status, json, base };
      }
      last = { ok: false, status: res.status, json: null, base, error: `HTTP ${res.status}` };
    } catch (e) {
      last = { ok: false, status: 0, json: null, base, error: pubErr(e, 120) };
    }
  }
  return last;
}

export const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().replace(/^0x/, "");

// Entries are plain URL strings, or { url, headers } for endpoints that need
// auth (the Sei relay's Bearer token) — same convention as the Algorand
// relay's getJsonAcross entries.
export async function rpcCall(urls, method, params, timeoutMs = 5000) {
  let lastErr;
  const failures = [];
  for (const entry of urls) {
    const url = typeof entry === "string" ? entry : entry.url;
    const extraHeaders = typeof entry === "string" ? {} : entry.headers || {};
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
      lastErr = new Error(JSON.stringify(j.error ?? j).slice(0, 120));
    } catch (e) {
      lastErr = e;
    }
    // Remember WHICH lane said what. Reporting only the last failure means the
    // error you see comes from the least-capable fallback, which actively
    // misleads: every Sei outage surfaced as publicnode's "Archive requests
    // require a personal token", so it read as an entitlement problem on a
    // chain whose relay and primary were both fine and had merely blipped.
    // Hours went into the wrong lane because of that one string.
    failures.push(`${laneName(entry)}: ${describeError(lastErr)}`);
  }
  // Name every lane that failed, in order tried, so the primary's reason is
  // visible instead of being buried under the last fallback's.
  const err = new Error(`all ${urls.length} RPCs failed - ${failures.join(" | ")}`);
  err.lanes = failures;
  throw err;
}

/**
 * An error, described well enough to act on.
 *
 * Node flattens EVERY network-level failure to the bare string "fetch failed"
 * and hangs the real reason on `err.cause`. A DNS failure and a refused
 * connection are byte-identical without it. Logging only the message is how a
 * fixable defect gets written off as a transient blip: the field that names it
 * is discarded one line before it is printed.
 *
 * Dual-stack hosts (most of these RPCs sit behind Cloudflare with both A and
 * AAAA) fail via AggregateError, whose wrapper carries no code at all - so the
 * per-address branch is what distinguishes "IPv6 is unroutable from here" from
 * "the host is down", which are very different fixes.
 */
export function describeError(err) {
  const msg = redactSecrets(String(err?.message || err)).slice(0, 90);
  const cause = err?.cause;
  if (Array.isArray(cause?.errors) && cause.errors.length) {
    const subs = cause.errors.slice(0, 3)
      .map((e) => [e?.code, e?.address && `@${e.address}`].filter(Boolean).join(""))
      .filter(Boolean);
    if (subs.length) return `${msg} [all addresses failed: ${subs.join(" | ")}]`;
  }
  if (cause?.code || cause?.syscall) {
    const bits = [cause.code, cause.syscall && `syscall=${cause.syscall}`,
      cause.address && `address=${cause.address}`, cause.port && `port=${cause.port}`].filter(Boolean);
    return `${msg} [${bits.join(" ")}]`;
  }
  return msg;
}

/** Host-only label for an RPC entry: enough to identify the lane, never the
 *  token that may be embedded in the URL or its auth header. */
function laneName(entry) {
  const url = typeof entry === "string" ? entry : entry?.url || "?";
  try { return new URL(url).host; } catch { return "rpc"; }
}

// One eth_getLogs over the whole span trips free-RPC range/"archive" caps
// (that's an RPC-provider upsell, not a real constraint), so the transfer
// scan walks BACKWARD from the head in chunks — newest first, early stop once
// 8 transfers are in hand, hard 12s budget. Chunks are capped at 9,000 blocks
// (Alchemy rejects getLogs ranges over 10k on some chains — Robinhood,
// verified 2026-07-08) with a minimum of 4. A failed chunk is a partial
// window, never an error: the balance (a cheap head read) stays up and the
// card says the scan was partial instead of parroting vendor text.
async function recentInbound(c, wallet, latest) {
  // Per-chain chunk cap: default 9,000 (the Alchemy bound above); chains whose
  // RPCs enforce tighter getLogs ranges declare chunkBlocks (Sei: 1,900).
  const LOG_CHUNKS = Math.max(4, Math.ceil(c.span / (c.chunkBlocks || 9000)));
  const chunk = Math.ceil(c.span / LOG_CHUNKS);
  const deadline = Date.now() + 12_000;
  const logs = [];
  let missed = 0;
  let attempted = 0;
  for (let i = 0; i < LOG_CHUNKS && logs.length < 8 && Date.now() < deadline; i++) {
    attempted++;
    const to = latest - i * chunk;
    if (to <= 0) break;
    const from = Math.max(0, to - chunk + 1);
    // One retry per failed chunk (budget permitting): the newest chunk holds
    // the most recent settles, and a single transient RPC failure there made
    // the card show "no inbound transfers" for a full snapshot TTL even
    // though the canary had just settled (observed 2026-07-08 on Polygon).
    const attemptChunk = () => rpcCall(c.rpcs, "eth_getLogs", [{
      address: c.token,
      topics: [TRANSFER_TOPIC, null, pad(wallet)],
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
    }], 4000);
    try {
      let part;
      try {
        part = await attemptChunk();
      } catch (e1) {
        if (Date.now() + 4500 > deadline) throw e1; // no budget left for a retry
        part = await attemptChunk();
      }
      if (Array.isArray(part)) logs.push(...part);
    } catch (e) {
      missed++;
      // One line per rail per process: the scan's missed counter destroyed
      // the evidence of WHY chunks fail (2026-07-28: Sei read 28/28
      // unavailable through a relay that answered prod's egress in 39ms,
      // and nothing said what the actual per-chunk error was).
      if (!loggedChunkFailure.has(c.label)) {
        loggedChunkFailure.add(c.label);
        console.warn(`[revenue] ${c.label} getLogs chunk failed: ${pubErr(e, 160)}`);
      }
    }
  }
  const recent = logs
    .map((l) => {
      const usd = Number(BigInt(l.data && l.data !== "0x" ? l.data : "0x0")) / 1e6;
      const from = l.topics?.[1] ? ("0x" + l.topics[1].slice(-40)).toLowerCase() : null;
      return {
        usd, from,
        tx: c.tx(l.transactionHash),
        block: parseInt(l.blockNumber, 16),
        external: isExternalPayment({ payer: from, usd }, { ourWallets: OUR_EVM_WALLETS, maxUsd: MAX_CALL_USD }),
        internal: from != null && OUR_EVM_WALLETS.has(from),
      };
    })
    .sort((a, b) => b.block - a.block)
    .slice(0, 8);
  // Best-effort block timestamps — one RPC call per transfer (8 max). Bounded by
  // a total deadline: rpcCall walks a fallback RPC list sequentially, so on a
  // throttled rail 8 transfers x N-RPC retries could run for minutes and hang the
  // whole /revenue response past the edge-proxy timeout (the outage this fixes).
  // Same deadline discipline as the getLogs loop above; timestamps are optional.
  const tsDeadline = Date.now() + 8_000;
  for (const t of recent) {
    if (Date.now() > tsDeadline) break;
    try {
      const blk = await rpcCall(c.rpcs, "eth_getBlockByNumber", ["0x" + t.block.toString(16), false], 3000);
      if (blk?.timestamp) t.when = new Date(parseInt(blk.timestamp, 16) * 1000).toISOString();
    } catch { /* timestamp is nice-to-have, not required */ }
  }
  // Windows never attempted (deadline exit or early stop with zero finds)
  // count as missed when the scan found NOTHING - a budget cutoff must not
  // read as a clean empty. Early stop after real finds stays a success.
  if (logs.length === 0 && attempted < LOG_CHUNKS) missed += LOG_CHUNKS - attempted;
  return { recent, missed, chunks: LOG_CHUNKS };
}

const loggedChunkFailure = new Set();
async function evmRail(name, wallet) {
  const c = EVM[name];
  const out = { rail: c.label, asset: c.asset, wallet: wallet || null, explorer: wallet ? c.explorer(wallet) : null, balance: null, recent: [], error: null, scanNote: null };
  if (!wallet) { out.error = "WALLET_ADDRESS unset"; return out; }
  try {
    // Cheap head-state calls (balance, block number) go publics-first: any free
    // RPC serves them, so Alchemy compute units are reserved for the chunked
    // historical eth_getLogs below, where publics genuinely fail (c.rpcs keeps
    // Alchemy first there). rpcCall walks the list on error, so a flaky public
    // still falls through to Alchemy — and this all runs in the background
    // refresh, never on a visitor's request path.
    const urlOf = (u) => (typeof u === "string" ? u : u.url);
    const cheapRpcs = [...c.rpcs.filter((u) => !urlOf(u).includes("alchemy")), ...c.rpcs.filter((u) => urlOf(u).includes("alchemy"))];
    const balHex = await rpcCall(cheapRpcs, "eth_call", [{ to: c.token, data: "0x70a08231" + pad(wallet).slice(2) }, "latest"]);
    out.balance = Number(BigInt(balHex && balHex !== "0x" ? balHex : "0x0")) / 1e6;
    const latest = parseInt(await rpcCall(cheapRpcs, "eth_blockNumber", []), 16);

    // Prefer the ledger. These transfers are already indexed by the background
    // revenue sync; re-deriving them here meant chunked eth_getLogs on every
    // snapshot refresh - 221 Alchemy calls per refresh, measured by a
    // production egress census, up to 144 times a day under crawler traffic.
    //
    // Falls back to the live scan when the ledger has nothing for this chain,
    // which is the honest reading of an empty result: a cold boot or an
    // unsynced chain must not render as "no settlements". The fallback is the
    // exact code that ran before, so the worst case is the old behaviour.
    // Imported LAZILY, inside the async call, not at module scope.
    // revenue-ledger.js already imports this file, so a static import here
    // closes a cycle and the server dies at boot with "Cannot access
    // ALGORAND_INDEXER_BASES before initialization" - verified, not guessed.
    // By the time a rail is scanned both modules are fully evaluated, so a
    // dynamic import resolves cleanly. Same class of cycle that took the
    // marketplace down earlier today, same fix shape.
    let ledgerRows = [];
    try {
      const { ledgerRecent } = await import("./revenue-ledger.js");
      ledgerRows = ledgerRecent(c.ledgerChain || name, wallet, { limit: 8 });
    } catch { /* ledger unavailable -> live scan below */ }
    let recent = ledgerRows.map((t) => ({ ...t, tx: t.txHash ? c.tx(t.txHash) : null }));
    let missed = 0, chunks = 0, viaLedger = recent.length > 0;
    if (!viaLedger) {
      ({ recent, missed, chunks } = await recentInbound(c, wallet, latest));
    }
    out.recent = recent;
    out.recentSource = viaLedger ? "ledger" : "chain-scan";
    out.externalUsd = Number(recent.filter((t) => t.external).reduce((s, t) => s + t.usd, 0).toFixed(6));
    out.windowBlocks = c.span;
    if (missed) out.scanNote = `transfer scan partial: ${missed}/${chunks} windows unavailable from public RPCs (balance is live)`;
  } catch (e) {
    out.error = pubErr(e, 120);
  }
  return out;
}

/**
 * The snapshot's recent-transfer rows, re-read from the ledger at request time.
 * The snapshot is cached for an hour and refreshed in the background (the
 * balances cost chain calls), so rows read inside it could be an hour old and
 * the first page load after a refresh started still showed them. Only rails
 * whose rows came from the ledger are re-read; that read is one indexed
 * SQLite query per rail. Returns a new snapshot object, never mutating the
 * cached one. `ledgerRecentFn` is revenue-ledger's ledgerRecent (passed in:
 * a static import would close the module cycle described in evmRail).
 */
/** The newest transfer in `recent` that one of OUR wallets paid. */
export function newestOwnSettle(recent) {
  return (Array.isArray(recent) ? recent : []).find((t) => t && t.when && t.internal === true) || null;
}

/**
 * The /api/revenue body. The per-transfer `recent` rows stay server-side: each
 * names the paying wallet (`from`), and even without that field its tx hash
 * resolves to the payer on chain, so publishing them would publish who pays
 * us. What leaves is per rail: our own wallet, its balance, the counts and
 * totals, and `lastInbound`, which is only ever one of OUR settles (see
 * newestOwnSettle). Pure: never mutates the cached snapshot.
 */
export function publicRevenueSnapshot(snap) {
  if (!snap || !Array.isArray(snap.rails)) return snap;
  const rails = snap.rails.map((r) => {
    if (!r || typeof r !== "object") return r;
    const { recent, ...rest } = r;
    const li = rest.lastInbound;
    if (li && li.internal !== true) delete rest.lastInbound;
    return rest;
  });
  return {
    ...snap,
    rails,
    note: "Balances read live from public RPCs (best-effort per rail). totalUsd is the combined wallet balance (includes our own canary/test money); windowExternalUsd counts only classified external per-call payments in the recent scan windows. Per-payment rows are not published: a transaction hash resolves to its payer on chain. lastInbound is our own newest settle on each rail (canary or volume run), never an outside buyer's.",
  };
}

export function withFreshRecent(snap, ledgerRecentFn, ledgerNewestOwnFn = null) {
  if (!snap || !Array.isArray(snap.rails) || typeof ledgerRecentFn !== "function") return snap;
  const byLabel = new Map(Object.entries(EVM).map(([name, c]) => [c.label, [name, c]]));
  let changed = false;
  const rails = snap.rails.map((rail) => {
    if (!rail || !rail.wallet) return rail;
    const hit = byLabel.get(rail.rail);
    if (!hit) return rail;
    const [name, c] = hit;
    let out = rail;
    // Recent rows: re-read only where the snapshot's rows came from the
    // ledger (a chain-scan fallback is kept as scanned).
    if (rail.recentSource === "ledger") {
      let rows = [];
      try { rows = ledgerRecentFn(c.ledgerChain || name, rail.wallet, { limit: 8 }); } catch { rows = []; }
      if (Array.isArray(rows) && rows.length) {
        const recent = rows.map((t) => ({ ...t, tx: t.txHash ? c.tx(t.txHash) : null }));
        out = { ...rail, recent, externalUsd: Number(recent.filter((t) => t.external).reduce((sum, t) => sum + t.usd, 0).toFixed(6)) };
      }
    }
    // The proof row is our own newest settle. On a busy rail the capped page
    // above holds only outside buyers, so read our newest settle directly.
    // Read for every EVM rail with a wallet, whatever the recent rows' source:
    // a snapshot built before the ledger had rows (chain-scan) or a ledger
    // page that came back empty must not leave the chain page without it.
    if (typeof ledgerNewestOwnFn === "function") {
      const seen = newestOwnSettle(out.recent);
      let own = seen ? { when: seen.when, tx: seen.tx || null, usd: Number.isFinite(seen.usd) ? seen.usd : null } : null;
      if (!own) { try { const r = ledgerNewestOwnFn(c.ledgerChain || name, rail.wallet); if (r && r.when) own = { when: r.when, tx: r.txHash ? c.tx(r.txHash) : null, usd: Number.isFinite(r.usd) ? r.usd : null }; } catch { /* keep the snapshot's row */ } }
      const prevWhen = rail.lastInbound?.internal === true ? Date.parse(rail.lastInbound.when) : -Infinity;
      if (own && Date.parse(own.when) >= prevWhen) out = { ...out, lastInbound: { ...own, internal: true } };
    }
    if (out !== rail) changed = true;
    return out;
  });
  return changed ? { ...snap, rails } : snap;
}

// The EVM rails bound "recent" by a block window; Solana (last 6 signatures)
// and Stellar (Horizon's last 10 payment ops) are bounded by COUNT — entries
// can be arbitrarily old. The per-rail externalUsd (and therefore the site
// total) must not count stale history as in-window revenue: sum only entries
// younger than this. Display still lists the older entries with honest tags.
const RECENT_WINDOW_MS = 24 * 3600 * 1000;
const inWindow = (t) => t.when != null && Date.now() - Date.parse(t.when) <= RECENT_WINDOW_MS;

async function solanaRail(wallet) {
  const out = { rail: "Solana", asset: "USDC", wallet: wallet || null, explorer: wallet ? `https://solscan.io/account/${wallet}` : null, balance: null, recent: [], error: null };
  if (!wallet) { out.error = "SOLANA_WALLET_ADDRESS unset"; return out; }
  try {
    const res = await rpcCall(SOLANA_RPCS, "getTokenAccountsByOwner", [wallet, { mint: USDC_SOL_MINT }, { encoding: "jsonParsed" }], 6000);
    out.balance = (res?.value || []).reduce((s, a) => s + (a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
    // Query the TOKEN ACCOUNT for signatures (not the wallet) — USDC transfers
    // hit the associated token account, not the owner address.
    const tokenAccount = res?.value?.[0]?.pubkey || wallet;
    const sigs = await rpcCall(SOLANA_RPCS, "getSignaturesForAddress", [tokenAccount, { limit: 6 }], 6000);
    // Decode each recent tx's USDC delta + payer (same helpers as the daily
    // scanner) so internal test money classifies here too. Best-effort under
    // a budget — an undecodable tx stays a bare signature link.
    const deadline = Date.now() + 12_000;
    out.recent = [];
    for (const s of Array.isArray(sigs) ? sigs : []) {
      const item = {
        tx: `https://solscan.io/tx/${s.signature}`,
        when: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
        err: s.err ? true : false,
      };
      if (!s.err && Date.now() < deadline) {
        try {
          const txn = await rpcCall(SOLANA_RPCS, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 5000);
          const usd = Number(usdcDeltaForOwner(txn?.meta, wallet).toFixed(6));
          if (usd > 0) {
            item.usd = usd;
            item.from = payerFromMeta(txn?.meta, wallet);
            item.external = isExternalPayment({ payer: item.from, usd }, { ourWallets: OUR_SOLANA_WALLETS, maxUsd: MAX_CALL_USD });
            item.internal = item.from != null && OUR_SOLANA_WALLETS.has(item.from);
          }
        } catch { /* leave as a bare signature link */ }
      }
      out.recent.push(item);
    }
    out.externalUsd = Number(out.recent.filter((t) => t.external && inWindow(t)).reduce((s, t) => s + t.usd, 0).toFixed(6));
  } catch (e) {
    out.error = pubErr(e, 120);
  }
  return out;
}

// Stellar — read USDC balance + recent payments via Horizon API.
export const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// Parse one Horizon payment-ish record into { tx, when, usd, from } — or null
// when it isn't an inbound canonical-issuer USDC transfer to `wallet`.
// x402 settlements are invoke_host_function (Soroban); wallet funding can be
// path_payment_strict_send or payment. Issuer check, not just code: anyone can
// issue an asset named "USDC" and pay the wallet to fake revenue on the card.
export function parseStellarPayment(r, wallet) {
  if (r.type === "payment" || r.type === "path_payment_strict_send" || r.type === "path_payment_strict_receive") {
    if (r.to !== wallet) return null;
    if (r.asset_code !== "USDC" || r.asset_issuer !== USDC_ISSUER) return null;
    return {
      tx: `https://stellar.expert/explorer/public/tx/${r.transaction_hash}`,
      when: r.created_at || null,
      usd: Number(r.amount) || 0,
      from: r.from || null,
    };
  }
  if (r.type === "invoke_host_function") {
    // Soroban x402 settlement — the operation itself carries no amount/asset,
    // but Horizon attaches asset_balance_changes with the real SEP-41
    // transfer. NOTE: r.source_account is the facilitator's fee-sponsoring
    // channel account, NOT the payer — the balance change's `from` is the
    // actual buying wallet.
    const changes = (r.asset_balance_changes || []).filter(
      (c) => c.type === "transfer" && c.to === wallet && c.asset_code === "USDC" && c.asset_issuer === USDC_ISSUER
    );
    if (!changes.length) return null; // touched the wallet but paid it nothing
    return {
      tx: `https://stellar.expert/explorer/public/tx/${r.transaction_hash}`,
      when: r.created_at || null,
      usd: Number(changes.reduce((s, c) => s + Number(c.amount || 0), 0).toFixed(7)),
      from: changes[0].from || null,
    };
  }
  return null;
}

// Fold parsed payment entries into per-UTC-day buckets over a trailing window.
// Pure — `now` is injectable so tests are deterministic. Buyers are unique
// `from` wallets (per day in each bucket, across the window in totals).
export function bucketStellarActivity(entries, { days = 30, now = Date.now() } = {}) {
  const DAY = 86_400_000;
  const buckets = [];
  const byDate = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * DAY).toISOString().slice(0, 10);
    const b = { date, tx: 0, usd: 0, buyers: new Set() };
    buckets.push(b);
    byDate.set(date, b);
  }
  const allBuyers = new Set();
  const totals = { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 };
  for (const e of entries) {
    const t = Date.parse(e?.when || "");
    if (!Number.isFinite(t)) continue;
    const b = byDate.get(new Date(t).toISOString().slice(0, 10));
    if (!b) continue; // outside the window
    b.tx += 1;
    b.usd += e.usd || 0;
    if (e.from) { b.buyers.add(e.from); allBuyers.add(e.from); }
    totals.tx += 1;
    totals.usd += e.usd || 0;
    if (e.internal) { totals.internalTx += 1; totals.internalUsd += e.usd || 0; }
  }
  totals.usd = Number(totals.usd.toFixed(6));
  totals.internalUsd = Number(totals.internalUsd.toFixed(6));
  totals.buyers = allBuyers.size;
  return {
    days,
    buckets: buckets.map((b) => ({ date: b.date, tx: b.tx, usd: Number(b.usd.toFixed(6)), buyers: b.buyers.size })),
    totals,
  };
}

// ---------------------------------------------------------------------------
// Scan bounds for the trailing-window activity walkers below.
//
// A paged scan stops for exactly one of three reasons: it reached the far edge
// of the window (complete), the source ran out of pages (complete), or it hit
// a bound we imposed (truncated, and the totals are an honest floor).
//
// That bound used to be a PAGE COUNT, ten everywhere. A page count is a poor
// proxy for cost: it drifts with the page size each source happens to return
// and with how fast the source answers, and it silently turns into a hard
// ceiling on the reported number. Measured on Base 2026-09-20, the busiest
// seller's payTo held 30,253 inbound USDC transfers in the trailing 30 days
// and every surface we rendered said exactly 10,000 - ten pages of a thousand
// - for months, because the walk stopped mid-window every single time. The
// walk was already keyset (each source's own cursor), so nothing was wrong
// with the paging; the bound was simply placed where a real figure used to be.
//
// Bound the WALL CLOCK instead, which is what a page load can actually afford
// and what the cost of a scan is proportional to. The page ceiling stays only
// as a backstop against a cursor that never terminates. Same Base wallet:
// 31 pages, 7.0s end to end, median 222ms per page, so the default budget
// carries roughly 1.7x the busiest wallet on the chain and degrades honestly
// (truncated: true) rather than lying when a source has a slow day.
const SCAN_BUDGET_MS = Math.max(1000, Number(process.env.MARKET_SCAN_BUDGET_MS) || 12_000);
// Backstop only. At the measured page sizes this is 40k-200k records, far past
// any wallet we have seen, so in practice the clock is always what stops a
// long walk and this only catches a source that keeps handing back cursors.
const SCAN_MAX_PAGES = 200;
/** Deadline for one scan. Call sites compare against it before each fetch. */
const scanDeadline = (budgetMs = SCAN_BUDGET_MS) => Date.now() + budgetMs;

// Trailing-window activity scan: page Horizon's payments feed back `days`
// days (newest first, 200 records a page, bounded by the scan budget above —
// a wallet busier than the budget carries sets `truncated: true` and the
// totals are an honest floor, never an estimate).
export async function stellarActivity(wallet, { days = 30, maxPages = SCAN_MAX_PAGES, budgetMs = SCAN_BUDGET_MS } = {}) {
  const out = { rail: "Stellar", wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null };
  if (!wallet) { out.error = "STELLAR_WALLET_ADDRESS unset"; return out; }
  const ours = new Set([...OUR_STELLAR_WALLETS, wallet]);
  const cutoff = Date.now() - days * 86_400_000;
  const entries = [];
  try {
    let url = `https://horizon.stellar.org/accounts/${wallet}/payments?order=desc&limit=200`;
    const until = scanDeadline(budgetMs);
    let more = false; // a cursor is still pending, i.e. we stopped early
    for (let page = 0; page < maxPages && url; page++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { out.error = `Horizon HTTP ${res.status}`; return out; }
      const data = await res.json();
      const records = data?._embedded?.records || [];
      // Cleared every iteration so that ANY exit path is honest: `more` means
      // "we stopped with a cursor still pending", and only the line that sets it
      // just before the deadline check can claim that. Carrying the flag across
      // iterations marked a walk that ran cleanly to the window edge as truncated.
      more = false;
      if (!records.length) { url = null; break; }
      let pastWindow = false;
      for (const r of records) {
        const t = Date.parse(r?.created_at || "");
        if (Number.isFinite(t) && t < cutoff) { pastWindow = true; break; }
        const entry = parseStellarPayment(r, wallet);
        if (!entry) continue;
        entry.internal = entry.from != null && ours.has(entry.from);
        entries.push(entry);
      }
      if (pastWindow) { url = null; break; }
      // Only follow Horizon's own cursor links — never an arbitrary URL from
      // a response body.
      const next = data?._links?.next?.href || "";
      url = next.startsWith("https://horizon.stellar.org/") ? next : null;
      if (!url) break;
      more = true;
      if (Date.now() >= until) break;
    }
    out.truncated = more;
  } catch (e) {
    out.error = pubErr(e, 120);
    return out;
  }
  const bucketed = bucketStellarActivity(entries, { days });
  out.buckets = bucketed.buckets;
  out.totals = bucketed.totals;
  return out;
}
export async function stellarRail(wallet) {
  const out = { rail: "Stellar", asset: "USDC", wallet: wallet || null, explorer: wallet ? `https://stellar.expert/explorer/public/account/${wallet}` : null, balance: null, recent: [], error: null };
  if (!wallet) { out.error = "STELLAR_WALLET_ADDRESS unset"; return out; }
  try {
    // Balance - walk Horizon providers (primary + fallback) on timeout/error.
    const bal = await getJsonAcross(STELLAR_HORIZON_URLS, `/accounts/${wallet}`);
    if (!bal.ok) { out.error = bal.error || `Horizon HTTP ${bal.status}`; return out; }
    const acct = bal.json;
    const usdcBalance = acct.balances?.find((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
    out.balance = usdcBalance ? Number(usdcBalance.balance) : 0;
    // Recent payments (incoming USDC) - prefer the provider the balance read
    // succeeded on, then the rest of the list.
    try {
      const pay = await getJsonAcross([bal.base, ...STELLAR_HORIZON_URLS], `/accounts/${wallet}/payments?order=desc&limit=10`);
      if (pay.ok) {
        const records = pay.json?._embedded?.records || [];
        // Internal = the committed canary burner set + this wallet itself
        // (self-transfers/funding moves are never external revenue).
        const ours = new Set([...OUR_STELLAR_WALLETS, wallet]);
        for (const r of records) {
          const entry = parseStellarPayment(r, wallet);
          if (!entry) continue;
          entry.external = isExternalPayment({ payer: entry.from, usd: entry.usd }, { ourWallets: ours, maxUsd: MAX_CALL_USD });
          entry.internal = entry.from != null && ours.has(entry.from);
          out.recent.push(entry);
        }
      }
      // Same aggregation the EVM and Solana rails do: sum the per-call-sized
      // external inbound so the card's "external in window" line and the
      // site-wide windowExternalUsd total include Stellar.
      out.externalUsd = Number(out.recent.filter((t) => t.external && inWindow(t)).reduce((s, t) => s + (t.usd || 0), 0).toFixed(6));
    } catch { /* payment scan is best-effort */ }
  } catch (e) {
    out.error = pubErr(e, 120);
  }
  return out;
}

// Algorand — read USDC balance + recent inbound ASA transfers via AlgoNode's
// free algod (balance) and indexer (transaction history) endpoints, both
// keyless. USDC is ASA 31566704 (6 decimals); explorer links go to allo.info.
export async function algorandRail(wallet) {
  const out = { rail: "Algorand", asset: "USDC", wallet: wallet || null, explorer: wallet ? `https://allo.info/account/${wallet}` : null, balance: null, recent: [], error: null };
  if (!wallet) { out.error = "ALGORAND_WALLET_ADDRESS unset"; return out; }
  try {
    // Balance - walk algod providers (relay first when configured, then the
    // direct Nodely bases) on timeout/error.
    const bal = await getJsonAcross(ALGORAND_ALGOD_BASES, `/v2/accounts/${wallet}`, { okStatuses: [404] });
    if (bal.status === 404) {
      // A fresh wallet that has never opted in to ASA 31566704 is a valid
      // state, not an error — it just holds no USDC (and can't be paid until
      // it opts in).
      out.balance = 0;
    } else if (!bal.ok) {
      out.error = bal.error || `algod HTTP ${bal.status}`;
      return out;
    } else {
      const acct = bal.json;
      const usdcAsset = (acct.assets || []).find((a) => a["asset-id"] === 31566704);
      out.balance = usdcAsset ? Number(usdcAsset.amount) / 1e6 : 0;
    }
    // Recent inbound USDC transfers (indexer) - walk indexer providers too.
    try {
      const tx = await getJsonAcross(ALGORAND_INDEXER_BASES, `/v2/accounts/${wallet}/transactions?asset-id=31566704&tx-type=axfer&limit=10`);
      if (tx.ok) {
        const txData = tx.json;
        // Internal = the committed canary burner set + this wallet itself
        // (self-transfers/funding moves are never external revenue).
        const ours = new Set([...OUR_ALGORAND_WALLETS, wallet]);
        for (const t of txData?.transactions || []) {
          const xfer = t["asset-transfer-transaction"];
          // Defense in depth, matching stellarRail's issuer check: re-verify
          // the ASA id per record even though the URL already filters
          // asset-id=31566704 — a filter regression/typo must not let a
          // fake-ASA airdrop count as revenue.
          if (!xfer || xfer["asset-id"] !== 31566704 || xfer.receiver !== wallet) continue; // inbound only, real USDC only
          const usd = Number(xfer.amount) / 1e6;
          const entry = {
            tx: `https://allo.info/tx/${t.id}`,
            when: t["round-time"] ? new Date(t["round-time"] * 1000).toISOString() : null,
            usd,
            from: t.sender || null,
          };
          entry.external = isExternalPayment({ payer: entry.from, usd }, { ourWallets: ours, maxUsd: MAX_CALL_USD });
          entry.internal = entry.from != null && ours.has(entry.from);
          out.recent.push(entry);
        }
      }
      // Same aggregation the other rails do: sum the per-call-sized external
      // inbound so the card's "external in window" line and the site-wide
      // windowExternalUsd total include Algorand.
      out.externalUsd = Number(out.recent.filter((t) => t.external && inWindow(t)).reduce((s, t) => s + (t.usd || 0), 0).toFixed(6));
    } catch { /* transaction scan is best-effort */ }
  } catch (e) {
    out.error = pubErr(e, 120);
  }
  return out;
}

// Trailing-window activity scan for Algorand: page AlgoNode's indexer back
// `days` days (newest first via `after-time`, 1000 records a page, bounded by
// the scan budget above —
// a busy wallet sets `truncated: true` and the totals are an honest floor,
// never an estimate). Mirrors stellarActivity's shape and honesty posture.
export async function algorandActivity(wallet, { days = 30, maxPages = SCAN_MAX_PAGES, budgetMs = SCAN_BUDGET_MS } = {}) {
  const out = { rail: "Algorand", wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null };
  if (!wallet) { out.error = "ALGORAND_WALLET_ADDRESS unset"; return out; }
  const ours = new Set([...OUR_ALGORAND_WALLETS, wallet]);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const entries = [];
  try {
    let next = null;
    const until = scanDeadline(budgetMs);
    let more = false; // a cursor is still pending, i.e. we stopped early
    for (let page = 0; page < maxPages; page++) {
      // Walk the indexer bases (relay first when configured) — this loop used
      // to hardcode the direct Nodely host, silently bypassing both the env
      // override and the relay.
      const path =
        `/v2/accounts/${wallet}/transactions?asset-id=31566704&tx-type=axfer&limit=1000&after-time=${encodeURIComponent(cutoff)}` +
        (next ? `&next=${encodeURIComponent(next)}` : "");
      const res = await getJsonAcross(ALGORAND_INDEXER_BASES, path, { timeoutMs: 8000 });
      if (!res.ok) { out.error = res.error || `indexer HTTP ${res.status}`; return out; }
      const data = res.json || {};
      const txs = data?.transactions || [];
      // Cleared every iteration so that ANY exit path is honest: `more` means
      // "we stopped with a cursor still pending", and only the line that sets it
      // just before the deadline check can claim that. Carrying the flag across
      // iterations marked a walk that ran cleanly to the window edge as truncated.
      more = false;
      for (const t of txs) {
        const xfer = t["asset-transfer-transaction"];
        // Defense in depth, matching algorandRail's issuer check: re-verify
        // the ASA id + receiver per record even though the URL already
        // filters asset-id=31566704 — a filter regression must not let a
        // fake-ASA airdrop count as revenue.
        if (!xfer || xfer["asset-id"] !== 31566704 || xfer.receiver !== wallet) continue;
        const usd = Number(xfer.amount) / 1e6;
        const entry = {
          tx: `https://allo.info/tx/${t.id}`,
          when: t["round-time"] ? new Date(t["round-time"] * 1000).toISOString() : null,
          usd,
          from: t.sender || null,
        };
        entry.internal = entry.from != null && ours.has(entry.from);
        entries.push(entry);
      }
      next = data["next-token"] || null;
      if (!next) break;
      more = true;
      if (Date.now() >= until) break;
    }
    out.truncated = more;
  } catch (e) {
    out.error = pubErr(e, 120);
    return out;
  }
  // bucketStellarActivity is chain-agnostic (buckets {when, usd, from,
  // internal} entries by UTC day) — reused here rather than duplicated.
  const bucketed = bucketStellarActivity(entries, { days });
  out.buckets = bucketed.buckets;
  out.totals = bucketed.totals;
  return out;
}

// ---------------------------------------------------------------------------
// 30-day activity scanners for the /base /polygon /arbitrum /solana
// /robinhood market pages — same contract as stellarActivity/algorandActivity
// above: best-effort, never throws, identical output shape, reuses
// bucketStellarActivity (chain-agnostic bucketer) and isExternalPayment/
// OUR_*_WALLETS for the internal-canary flag. Missing data is ALWAYS
// acceptable (the caller renders "unavailable"); inventing data is NEVER
// acceptable.

// Parse one Alchemy `alchemy_getAssetTransfers` transfer record into
// { when, usd, from } — or null when it can't be trusted (no positive USD
// value). `value` arrives already decimal-normalized (Alchemy resolves the
// ERC-20 decimals server-side); `metadata.blockTimestamp` is ISO.
export function parseEvmTransfer(t) {
  if (!t) return null;
  const usd = Number(t.value);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const when = typeof t.metadata?.blockTimestamp === "string" ? t.metadata.blockTimestamp : null;
  const from = typeof t.from === "string" ? t.from.toLowerCase() : null;
  // uid + block are the incremental scan's identity and cursor: Alchemy's
  // uniqueId is per transfer (hash:log:N), so it survives the block overlap a
  // resumed scan re-reads, and blockNum is where the next scan starts.
  const uid = typeof t.uniqueId === "string" ? t.uniqueId : null;
  const block = Number.parseInt(t.blockNum, 16);
  return { when, usd: Number(usd.toFixed(6)), from, uid, block: Number.isFinite(block) ? block : null };
}

// Trailing-window activity scan for an EVM rail (base/polygon/arbitrum/
// robinhood) via Alchemy's alchemy_getAssetTransfers — newest first, paged
// via the response's `pageKey`, STOP once a transfer is older than the `days`
// cutoff, and otherwise at the scan budget above (which sets truncated).
// Public RPCs don't implement this method, so no ALCHEMY_API_KEY → immediate honest "unavailable" rather than
// a failed call per page.
/** How far back a resumed scan re-reads, in blocks. Base produces a block
 *  every ~2s, so this is a couple of minutes of overlap: enough that a
 *  transfer landing between two scans cannot fall in the gap, small enough to
 *  cost nothing. Duplicates are removed by uid, so overlap is free. */
const RESUME_OVERLAP_BLOCKS = 60;

/** Rows retained per wallet for a resume. The busiest wallet on Base holds
 *  ~30k in a 30-day window at ~150 bytes each; the cap bounds one pathological
 *  wallet rather than the normal case, and overflowing it costs that wallet a
 *  full rescan, never a wrong number. */
const SCAN_STATE_MAX_ENTRIES = 60_000;

/** Merge a resumed scan's new rows into what the previous scan kept, newest
 *  first, dropping duplicates by uid and anything now past the window.
 *  Exported for the guard: a wrong merge here double-counts silently. */
export function mergeScanEntries(fresh = [], prior = [], cutoff = 0) {
  const seen = new Set();
  const out = [];
  for (const e of [...fresh, ...prior]) {
    if (!e) continue;
    const ts = Date.parse(e.when || "");
    if (Number.isFinite(ts) && ts < cutoff) continue;   // outside the window now
    // A row with no uid cannot be deduplicated, so it is kept: that is only
    // reachable if the upstream stops sending uniqueId, and dropping rows
    // would be the worse failure.
    if (e.uid) { if (seen.has(e.uid)) continue; seen.add(e.uid); }
    out.push(e);
  }
  return out;
}

export async function evmActivity(chainKey, wallet, { days = 30, maxPages = SCAN_MAX_PAGES, budgetMs = SCAN_BUDGET_MS, prior = null } = {}) {
  const c = EVM[chainKey];
  const out = { rail: c?.label || chainKey, wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null };
  if (!c) { out.error = "unsupported chain"; return out; }
  if (!wallet) { out.error = "WALLET_ADDRESS unset"; return out; }
  if (!process.env.ALCHEMY_API_KEY) { out.error = "activity source unavailable (no ALCHEMY_API_KEY)"; return out; }
  const alchemyUrl = c.rpcs[0]; // prepended first in EVM config above when the key is set
  const cutoff = Date.now() - days * 86_400_000;
  const entries = [];
  let rpcCalls = 0;
  try {
    let pageKey;
    const until = scanDeadline(budgetMs);
    let more = false; // a cursor is still pending, i.e. we stopped early

    // RESUME. This scan used to re-walk the window from block 0 on every
    // refresh, so a busy wallet re-paid for thirty days of history every ten
    // minutes. A prior scan that COVERED the window (never truncated) and is
    // itself still inside it lets this one start at the last block it saw and
    // read only what is new - normally one page. A truncated prior is NOT
    // resumable: it never held the far end of the window, and resuming would
    // freeze that gap in place forever.
    const resumable = !!(prior && !prior.truncated && Number.isFinite(prior.newestBlock)
      && Array.isArray(prior.entries) && Number.isFinite(prior.at) && prior.at >= cutoff);
    const startBlock = resumable ? Math.max(0, prior.newestBlock - RESUME_OVERLAP_BLOCKS) : 0;
    out.resumed = resumable;

    for (let page = 0; page < maxPages; page++) {
      const params = {
        fromBlock: "0x" + startBlock.toString(16), toBlock: "latest", toAddress: wallet, contractAddresses: [c.token],
        category: ["erc20"], withMetadata: true, excludeZeroValue: true, maxCount: "0x3e8", order: "desc",
        ...(pageKey ? { pageKey } : {}),
      };
      const res = await rpcCall([alchemyUrl], "alchemy_getAssetTransfers", [params], 8000);
      rpcCalls++;
      const transfers = res?.transfers || [];
      // Cleared every iteration so that ANY exit path is honest: `more` means
      // "we stopped with a cursor still pending", and only the line that sets it
      // just before the deadline check can claim that. Carrying the flag across
      // iterations marked a walk that ran cleanly to the window edge as truncated.
      more = false;
      if (!transfers.length) { pageKey = null; break; }
      let pastWindow = false;
      for (const t of transfers) {
        const entry = parseEvmTransfer(t);
        if (!entry) continue;
        const ts = Date.parse(entry.when || "");
        if (Number.isFinite(ts) && ts < cutoff) { pastWindow = true; break; }
        // A resumed scan walks newest-first and only needs what sits above its
        // cursor; reaching the overlap means it has caught up and can stop.
        if (resumable && Number.isFinite(entry.block) && entry.block < startBlock) { pastWindow = true; break; }
        entry.internal = entry.from != null && OUR_EVM_WALLETS.has(entry.from);
        entries.push(entry);
      }
      if (pastWindow) { pageKey = null; break; }
      pageKey = res?.pageKey || null;
      if (!pageKey) break;
      more = true;
      if (Date.now() >= until) break;
    }
    out.truncated = more;
  } catch (e) {
    out.error = pubErr(e, 120);
    return out;
  }
  const merged = out.resumed ? mergeScanEntries(entries, prior.entries, cutoff) : entries;
  const bucketed = bucketStellarActivity(merged, { days });
  out.buckets = bucketed.buckets;
  out.totals = bucketed.totals;
  out.rpcCalls = rpcCalls;
  // The state the NEXT scan resumes from. Non-enumerable so it never reaches a
  // response body, a cache file or a log line: it is tens of thousands of rows
  // on a busy wallet and is nobody's business but the scanner's.
  Object.defineProperty(out, "__scanState", {
    enumerable: false, value: {
      entries: merged.slice(0, SCAN_STATE_MAX_ENTRIES),
      newestBlock: merged.reduce((m, e) => (Number.isFinite(e.block) && e.block > m ? e.block : m), -1),
      truncated: !!out.truncated,
      at: Date.now(),
    },
  });
  return out;
}

// Base USDC (native Circle) contract.
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

// Base activity via CDP SQL: ONE server-side aggregation over base.events
// (decoded USDC Transfer logs) instead of paging up to 10k raw transfers over
// RPC. Fast (~0.5s) and COMPLETE — no 10k scan cap, so a busy seller's totals
// are exact, not a floor. Same output shape as evmActivity; callers fall back to
// evmActivity when this errors (no CDP creds, rejected query, timeout). Two
// parallel queries: per-day buckets + window totals (the window-wide DISTINCT
// buyer count isn't the sum of per-day uniques, so it needs its own aggregate).
// Injection-safe: wallet is regex-validated then lowercased, days is clamped to
// an integer, the contract + internal-wallet set are server-owned.
export async function baseActivityViaSql(wallet, { days = 30, now = Date.now() } = {}) {
  const out = { rail: "Base", wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null, source: "cdp-sql" };
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) { out.error = "invalid wallet"; return out; }
  if (!cdpConfigured()) { out.error = "cdp not configured"; return out; }
  const w = wallet.toLowerCase();
  const D = Math.max(1, Math.min(Math.floor(days) || 30, 90));
  const ours = [...OUR_EVM_WALLETS].map((a) => `'${String(a).replace(/[^0-9a-fx]/gi, "")}'`).join(",") || "''";
  const toS = (p) => `variantElement(${p}, 'String')`;
  const val = `toFloat64(variantElement(parameters['value'], 'UInt256')) / 1e6`;
  const from = `lower(${toS("parameters['from']")})`;
  const where = `address = '${BASE_USDC}' AND event_name = 'Transfer' AND action = 'added' AND lower(${toS("parameters['to']")}) = '${w}' AND block_timestamp >= now() - INTERVAL ${D} DAY`;
  const bucketSql = `SELECT toDate(block_timestamp) AS d, count() AS tx, round(sum(${val}),6) AS usd, uniqExact(${from}) AS buyers FROM base.events WHERE ${where} GROUP BY d ORDER BY d`;
  const totalSql = `SELECT count() AS tx, round(sum(${val}),6) AS usd, uniqExact(${from}) AS buyers, countIf(${from} IN (${ours})) AS itx, round(sumIf(${val}, ${from} IN (${ours})),6) AS iusd FROM base.events WHERE ${where}`;
  let bRows, tRows;
  try {
    [bRows, tRows] = await Promise.all([
      cdpSql(bucketSql, { cacheSeconds: 300 }),
      cdpSql(totalSql, { cacheSeconds: 300 }),
    ]);
  } catch (e) { out.error = pubErr(e, 140); return out; }
  const N = (x) => Number(x) || 0;
  // 0-fill a continuous day series (oldest→newest) so the chart x-axis is complete,
  // matching bucketStellarActivity's window shape.
  const byDate = new Map((bRows || []).map((r) => [String(r.d), r]));
  const DAY = 86_400_000;
  for (let i = D - 1; i >= 0; i--) {
    const date = new Date(now - i * DAY).toISOString().slice(0, 10);
    const r = byDate.get(date);
    out.buckets.push({ date, tx: N(r?.tx), usd: Number(N(r?.usd).toFixed(6)), buyers: N(r?.buyers) });
  }
  const t = (tRows && tRows[0]) || {};
  out.totals = {
    tx: N(t.tx), usd: Number(N(t.usd).toFixed(6)), buyers: N(t.buyers),
    internalTx: N(t.itx), internalUsd: Number(N(t.iusd).toFixed(6)),
  };
  return out;
}

// Parse one Solana getTransaction result into { when, usd, from } — `owner`'s
// inbound USDC for that tx, or null when nothing came in (outgoing/failed/
// non-USDC). Thin wrapper over the usdcDeltaForOwner/payerFromMeta helpers
// solanaRail already uses, generalized so the scan below doesn't duplicate
// the parse.
export function parseSolanaTransfer(txn, owner) {
  const usd = Number(usdcDeltaForOwner(txn?.meta, owner).toFixed(6));
  if (!(usd > 0)) return null;
  const from = payerFromMeta(txn?.meta, owner);
  const when = txn?.blockTime ? new Date(txn.blockTime * 1000).toISOString() : null;
  return { when, usd, from };
}

// Trailing-window activity scan: page getSignaturesForAddress on the wallet's
// USDC token account (limit 1000, `before` cursor, newest first), decoding
// each signature with getTransaction — one RPC call each, so a busy page must
// not fire hundreds of them unbounded. An RPC failure mid-scan keeps whatever
// was collected so far (`truncated:true`); only a failure with nothing
// collected is an error.
// Solana's cost is per TRANSACTION, not per page: each signature inside the
// window needs its own getTransaction. Measured 2026-09-20 against the busiest
// Solana payTo we index, that call runs a 65ms median, so the shared budget
// below carries roughly 180 transactions where the old hard `maxTx = 60`
// stopped at sixty on every wallet busier than that. maxTx stays as a backstop
// only - the clock is what stops a long walk here.
export async function solanaActivity(wallet, { days = 30, maxPages = SCAN_MAX_PAGES, maxTx = 2000, budgetMs = SCAN_BUDGET_MS } = {}) {
  const out = { rail: "Solana", wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null };
  if (!wallet) { out.error = "SOLANA_WALLET_ADDRESS unset"; return out; }
  const cutoff = Date.now() - days * 86_400_000;
  const entries = [];
  let tokenAccount;
  try {
    const res = await rpcCall(SOLANA_RPCS, "getTokenAccountsByOwner", [wallet, { mint: USDC_SOL_MINT }, { encoding: "jsonParsed" }], 6000);
    tokenAccount = res?.value?.[0]?.pubkey || wallet;
  } catch (e) {
    out.error = pubErr(e, 120);
    return out;
  }
  let txBudget = maxTx;
  let capped = false;
  const until = scanDeadline(budgetMs);
  try {
    let before;
    scan: for (let page = 0; page < maxPages; page++) {
      const params = before ? [tokenAccount, { limit: 1000, before }] : [tokenAccount, { limit: 1000 }];
      const sigs = await rpcCall(SOLANA_RPCS, "getSignaturesForAddress", params, 8000);
      if (!Array.isArray(sigs) || !sigs.length) break;
      for (const s of sigs) {
        const tms = s.blockTime ? s.blockTime * 1000 : null;
        if (tms != null && tms < cutoff) break scan;
        if (s.err) continue;
        if (txBudget <= 0 || Date.now() >= until) { capped = true; break scan; }
        txBudget--;
        try {
          const txn = await rpcCall(SOLANA_RPCS, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 6000);
          const entry = parseSolanaTransfer(txn, wallet);
          if (entry) {
            entry.internal = entry.from != null && OUR_SOLANA_WALLETS.has(entry.from);
            entries.push(entry);
          }
        } catch { /* one bad tx fetch must not kill the scan */ }
      }
      before = sigs[sigs.length - 1]?.signature;
      if (!before) break;
      if (Date.now() >= until) { capped = true; break; }
    }
  } catch (e) {
    if (!entries.length) { out.error = pubErr(e, 120); return out; }
    capped = true; // partial results survive an RPC failure mid-scan
  }
  out.truncated = capped;
  const bucketed = bucketStellarActivity(entries, { days });
  out.buckets = bucketed.buckets;
  out.totals = bucketed.totals;
  return out;
}

// Parse one Blockscout (Etherscan-compatible) tokentx record into
// { when, usd, from } for inbound USDG to `wallet` — or null when it's
// outbound/to someone else. `value` is atomic units (6 decimals, verified
// live against the real USDG contract 2026-07-11); `timeStamp` is unix
// seconds.
export function parseRobinhoodTransfer(t, wallet) {
  if (!t || !wallet) return null;
  const to = typeof t.to === "string" ? t.to.toLowerCase() : null;
  if (to !== wallet.toLowerCase()) return null;
  const raw = Number(t.value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ts = Number(t.timeStamp);
  return {
    when: Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null,
    usd: Number((raw / 1e6).toFixed(6)),
    from: typeof t.from === "string" ? t.from.toLowerCase() : null,
  };
}

// Trailing-window activity scan for Robinhood Chain (USDG) via Blockscout's
// Etherscan-compatible tokentx API — there is no Alchemy/RPC path for this
// chain's activity (see evmActivity). One retry on failure: verified live
// 2026-07-11 that this endpoint occasionally answers "Something went wrong"
// for a perfectly valid wallet/contract pair and succeeds seconds later
// (transient, not a real error). The honesty signal this function keys on is
// `result` being an array vs. `null` — NOT the `status` field: "no transfers
// found" is ALSO status "0" but carries a valid empty `result: []`, so
// keying on `status` would misreport an empty wallet as a scan failure.
//
// HOST DECISION (2026-09-18 data-provider audit): Blockscout deprecated the
// per-instance APIs on 2026-07-01 in favour of `api.blockscout.com/{chain_id}/
// api/v2` with one key. Probed live that day for chain 4663: BOTH v2 paths
// (`/4663/api/v2/addresses/<w>/token-transfers` and the Etherscan-compatible
// `/4663/api?module=account&action=tokentx`) answer `402 {"error":"Proceed
// with API key or make a X402 payment to continue"}` keyless, and the legacy
// instance answered a Cloudflare challenge (403, HTML) from a residential IP -
// which is why a non-JSON answer below is reported as `Blockscout HTTP <status>`
// rather than thrown. The v2 move needs a Blockscout key (or paying their x402
// gate from the spending wallet, which this free revenue read must not do), so
// the legacy path STAYS and this note is the documentation; revisit when a
// key is on Railway (`BLOCKSCOUT_API_KEY` would be the switch).
export async function robinhoodActivity(wallet, { days = 30 } = {}) {
  const c = EVM.robinhood;
  const out = { rail: c.label, wallet: wallet || null, days, buckets: [], totals: { tx: 0, usd: 0, buyers: 0, internalTx: 0, internalUsd: 0 }, truncated: false, error: null };
  if (!wallet) { out.error = "WALLET_ADDRESS unset"; return out; }
  const cutoff = Date.now() - days * 86_400_000;
  const url = `https://robinhoodchain.blockscout.com/api?module=account&action=tokentx&address=${encodeURIComponent(wallet)}&contractaddress=${encodeURIComponent(c.token)}`;
  const fetchOnce = async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Blockscout HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.result)) throw new Error(String(data?.message || "unexpected response shape").slice(0, 80));
    return data.result;
  };
  let rows;
  try {
    try {
      rows = await fetchOnce();
    } catch {
      rows = await fetchOnce(); // one retry — this endpoint flaps transiently
    }
  } catch (e) {
    out.error = pubErr(e, 120);
    return out;
  }
  const entries = [];
  for (const t of rows) {
    const entry = parseRobinhoodTransfer(t, wallet);
    if (!entry) continue;
    const ts = Date.parse(entry.when || "");
    if (Number.isFinite(ts) && ts < cutoff) continue; // Blockscout order isn't guaranteed - filter, don't break
    entry.internal = entry.from != null && OUR_EVM_WALLETS.has(entry.from);
    entries.push(entry);
  }
  const bucketed = bucketStellarActivity(entries, { days });
  out.buckets = bucketed.buckets;
  out.totals = bucketed.totals;
  return out;
}

// 60s snapshot cache, serve-stale-while-revalidate: a fresh snapshot answers
// directly; a stale one answers IMMEDIATELY while a single deduped background
// refresh runs (the full seven-rail scan takes 10-30s on slow public RPCs —
// no pageview should wait for it, and concurrent expiries must not each
// launch their own scan). Only the very first call after boot has nothing to
// serve and awaits the scan — server.js warms it at boot to cover that too.
// `asOf` keeps any staleness honest.
let cached = null;
let cachedAt = 0;
let refreshing = null;

// The per-rail last-good carry-forward below used to live only in process
// memory, so every deploy wiped it — and the non-EVM rails' public endpoints
// throttle Railway's datacenter IP often enough that the FIRST read after a
// boot can fail, leaving that card on "unreachable" until a read succeeds
// (observed on Algorand after the 2026-07-16 deploys). Persist the last-good
// rails to the /data volume (same convention as stats.js: /data if mounted,
// /tmp otherwise) and seed the carry-forward from disk on boot — a redeploy
// is not evidence a chain went down. Best-effort top to bottom: a read/write
// failure just falls back to the old in-memory behavior. Carried-forward
// balances keep their original balanceAsOf, so the card honestly shows
// "live · cached" rather than a fake-fresh reading.
const LASTGOOD_PATH = join(existsSync("/data") ? "/data" : "/tmp", "revenue-lastgood.json");
let diskLastGood = null;
try { diskLastGood = JSON.parse(readFileSync(LASTGOOD_PATH, "utf8")); } catch { /* first boot or unreadable — in-memory behavior */ }
function persistLastGood(rails) {
  try {
    const keep = rails
      .filter((r) => Number.isFinite(r.balance))
      .map((r) => ({ rail: r.rail, balance: r.balance, balanceAsOf: r.balanceAsOf || null, recent: (r.recent || []).slice(0, 10), lastInbound: r.lastInbound || null }));
    if (keep.length) writeFileSync(LASTGOOD_PATH, JSON.stringify({ asOf: new Date().toISOString(), rails: keep }));
  } catch { /* persistence must never break the snapshot */ }
}
// Snapshot freshness. 10 minutes (was 60s): the refresh fans out ~100 chunked
// eth_getLogs across six EVM rails, and crawler traffic on the marketplace/
// revenue pages kept the 60s cache permanently warm — ~1,440 full scans/day,
// the dominant driver of the Alchemy compute-unit bill. Visitor latency is
// UNAFFECTED (stale-while-revalidate below serves the cached object instantly
// and refreshes in the background); only the card's freshness changes, on a
// surface that already labels carried-forward data "live · cached". Env
// override for ops experiments.
// 60 minutes (was 10, was 60s before that).
//
// MEASURED, not estimated: an egress census run against production recorded
// 221 Alchemy RPC calls from this file in a single refresh - the fan-out of
// chunked eth_getLogs across six EVM rails. At a 10-minute TTL, crawler traffic
// on /revenue, /marketplace and the chain pages keeps the cache permanently
// warm, which is up to 144 refreshes a day: roughly 955,000 billed calls a
// month, for a page that earns nothing.
//
// This is the third time this exact shape has been paid for. It was 60s until
// July (~9.5M/month), then 10 minutes, and the 10 was still chosen by feel
// rather than by measurement. 60 minutes is 83% fewer than 10, and the card
// already labels carried-forward data "live · cached" - the honesty mechanism
// for staleness exists precisely so this number can be tuned for cost.
//
// Visitor latency is unaffected either way: stale-while-revalidate below serves
// the cached object instantly and refreshes in the background. What changes is
// only how old the rail balances may be, on a surface that says so.
//
// The real fix is to stop re-scanning chains we already index - src/revenue-
// ledger.js persists every settlement - but that is a rewrite of where the
// snapshot's numbers come from, not a constant. Filed rather than rushed.
const SNAPSHOT_TTL_MS = parseInt(process.env.REVENUE_SNAPSHOT_TTL_MS, 10) || 60 * 60_000;
const SCAN_REQUEST_DEADLINE_MS = parseInt(process.env.REVENUE_SCAN_DEADLINE_MS, 10) || 25_000;
const RAIL_DEADLINE_MS = parseInt(process.env.REVENUE_RAIL_DEADLINE_MS, 10) || 45_000;
const SCAN_TIMED_OUT = Symbol("revenue-scan-timeout");
export async function revenueSnapshot(opts) {
  if (cached && Date.now() - cachedAt < SNAPSHOT_TTL_MS) return cached;
  if (!refreshing) {
    refreshing = refreshSnapshot(opts)
      .catch(() => cached) // a failed scan keeps serving the last snapshot
      .finally(() => { refreshing = null; });
  }
  // Stale-while-revalidate: never block a visitor on the multi-chain scan if we
  // have anything to serve.
  if (cached) return cached;
  // Cold after a restart: the last good reading saved on the volume is served,
  // marked stale, while the scan runs (a cold page used to wait out the
  // deadline on every visit until the first scan finished).
  if (diskLastGood?.rails?.length) return lastGoodSnapshot(diskLastGood);
  // Cold cache (first request after a boot, before the background primer warms
  // it): wait for the scan, but NEVER past a hard deadline - a single throttled
  // rail must not hang /revenue past the edge-proxy timeout (the outage this
  // fixes). On deadline, throw so the route's own try/catch renders its graceful
  // fallback instead of a 502; the background scan keeps running and fills the
  // cache for the next request.
  const result = await Promise.race([
    refreshing,
    new Promise((resolve) => setTimeout(() => resolve(SCAN_TIMED_OUT), SCAN_REQUEST_DEADLINE_MS)),
  ]);
  if (result === SCAN_TIMED_OUT || !result) {
    const e = new Error("revenue snapshot is warming up - try again shortly");
    e.snapshotWarming = true;
    throw e;
  }
  return result;
}

/** A snapshot built from the saved last-good rails, every balance marked stale. */
export function lastGoodSnapshot(lg) {
  const rails = lg.rails.map((r) => ({ ...r, staleBalance: true, balanceAsOf: r.balanceAsOf || lg.asOf || null, error: null }));
  const totalUsd = rails.reduce((s, r) => s + (Number.isFinite(r.balance) ? r.balance : 0), 0);
  return {
    spec: "agent402-revenue/1",
    asOf: lg.asOf || null,
    stale: true,
    cacheSeconds: 30,
    totalUsd: Number(totalUsd.toFixed(6)),
    windowExternalUsd: null,
    maxCallUsd: MAX_CALL_USD,
    rails,
    note: "The last good reading, saved before this server restarted, shown while a fresh read runs. Balances are marked stale with the time they were read; recent-window external totals return with the fresh read.",
  };
}

async function refreshSnapshot({ walletAddress, solanaWallet }) {
  const stellarWallet = (process.env.STELLAR_WALLET_ADDRESS || "").trim();
  const algorandWallet = (process.env.ALGORAND_WALLET_ADDRESS || "").trim();
  // Each rail is bounded as a whole, not only per request: a rail that pages
  // through many slow reads kept the whole snapshot from finishing, and a cold
  // /revenue then waited out its deadline on every visit (2026-10-01). A rail
  // past its bound reads as an error, so the carry-forward below keeps its
  // last good balance, marked stale.
  const bounded = (label, p) => Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve({ rail: label, balance: null, recent: [], error: `timed out after ${Math.round(RAIL_DEADLINE_MS / 1000)} s` }), RAIL_DEADLINE_MS).unref?.()),
  ]);
  const evm = (name) => bounded(EVM[name]?.label || name, evmRail(name, walletAddress));
  const [base, polygon, arbitrum, monad, celo, avalanche, sei, optimism, robinhood, solana, stellar, algorand] = await Promise.all([
    evm("base"), evm("polygon"), evm("arbitrum"), evm("monad"), evm("celo"),
    evm("avalanche"), evm("sei"), evm("optimism"), evm("robinhood"),
    bounded("Solana", solanaRail(solanaWallet)),
    bounded("Stellar", stellarRail(stellarWallet)),
    bounded("Algorand", algorandRail(algorandWallet)),
  ]);
  const rails = [base, solana, polygon, arbitrum, monad, celo, avalanche, sei, optimism, stellar, algorand, robinhood];
  // Per-rail last-good balance carry-forward. The non-EVM reads (Solana,
  // Stellar, Algorand) hit public endpoints that throttle Railway's datacenter
  // IP and intermittently time out; a wallet balance barely moves between
  // reads, so a transient timeout must NOT wipe a known balance to
  // "unreachable". If this read failed but the previous snapshot had a good
  // balance for the same rail, keep it and flag it stale (honest: it's the last
  // verified reading, timestamped). The next clean refresh replaces it. A rail
  // we've never read successfully stays null -> genuinely unreachable.
  // In-memory snapshot first (freshest), then the on-disk last-good from a
  // previous boot — so a redeploy doesn't demote a healthy rail to
  // "unreachable" just because its first post-boot read hit a throttled RPC.
  const prevRails = (cached?.rails?.length ? cached.rails : diskLastGood?.rails) || [];
  const now = new Date().toISOString();
  // Per-rail lastInbound carry-forward: the newest OBSERVED settle (tx + when)
  // survives scans whose window has simply aged past it. Without this, a
  // successfully-empty 6h scan wiped the evidence a daily settle happened,
  // while a FAILING scan kept it via the balance carry-forward - a working
  // RPC produced a worse page than a broken one (found live 2026-07-28: the
  // Optimism "daily canary" row read unavailable hours after a real settle).
  // The market pages' canary row keys off this, with its own 36h honesty cap.
  //
  // OUR OWN settles only (canary and volume runs). This row is published, and
  // a transaction hash resolves to its payer on chain, so an outside buyer's
  // payment never becomes the rail's public proof row. A carried-forward row
  // from before this rule (no `internal` marker) is dropped, not trusted.
  for (const r of rails) {
    const seen = newestOwnSettle(r.recent);
    const prev = prevRails.find((p) => p.rail === r.rail);
    if (seen) r.lastInbound = { when: seen.when, tx: seen.tx || null, usd: Number.isFinite(seen.usd) ? seen.usd : null, internal: true };
    else if (prev?.lastInbound?.internal === true) r.lastInbound = prev.lastInbound;
    else delete r.lastInbound;
  }
  for (const r of rails) {
    if (r.balance == null || r.error) {
      const prev = prevRails.find((p) => p.rail === r.rail);
      if (prev && Number.isFinite(prev.balance)) {
        r.balance = prev.balance;
        r.staleBalance = true;
        r.balanceAsOf = prev.balanceAsOf || cached?.asOf || diskLastGood?.asOf || null;
        if (!(r.recent && r.recent.length) && prev.recent) r.recent = prev.recent;
      }
    } else {
      r.balanceAsOf = now;
    }
  }
  persistLastGood(rails);
  const totalUsd = rails.reduce((s, r) => s + (Number.isFinite(r.balance) ? r.balance : 0), 0);
  const windowExternalUsd = rails.reduce((s, r) => s + (Number.isFinite(r.externalUsd) ? r.externalUsd : 0), 0);
  cached = {
    spec: "agent402-revenue/1",
    asOf: new Date().toISOString(),
    cacheSeconds: 60,
    totalUsd: Number(totalUsd.toFixed(6)),
    windowExternalUsd: Number(windowExternalUsd.toFixed(6)),
    maxCallUsd: MAX_CALL_USD,
    rails,
    note: "Balances + recent inbound transfers, read live from public RPCs (best-effort per rail). totalUsd is the combined wallet balance (includes our own canary/test money); windowExternalUsd counts only classified external per-call payments in the recent scan windows. All figures are independently verifiable at the explorer links.",
  };
  cachedAt = Date.now();
  return cached;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Explorer links for a settlement's tx hash, keyed by rail. Used by the
// MPP-wire section below.
const SALE_TX_URL = {
  base: (h) => `https://basescan.org/tx/${h}`,
  celo: (h) => `https://celoscan.io/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
  avalanche: (h) => `https://snowtrace.io/tx/${h}`,
  "robinhood (USDG)": (h) => `https://robinhoodchain.blockscout.com/tx/${h}`,
  solana: (h) => `https://solscan.io/tx/${h}`,
  stellar: (h) => `https://stellar.expert/explorer/public/tx/${h}`,
  algorand: (h) => `https://allo.info/tx/${h}`,
  tempo: (h) => `https://explore.tempo.xyz/tx/${h}`,
};
// Some ledger rows store the network as a CAIP-2 id (a chain missing from the
// name map when it settled) rather than the short name — resolve both forms so
// every rail's tx links render regardless of when the row was recorded.
const NET_ALIAS = {
  "eip155:8453": "base", "eip155:42220": "celo", "eip155:137": "polygon",
  "eip155:42161": "arbitrum", "eip155:43114": "avalanche", "eip155:143": "monad",
  "eip155:4663": "robinhood (USDG)", "eip155:4217": "tempo",
  "stellar:pubnet": "stellar", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "algorand",
};
function txHref(network, tx) {
  if (!tx) return null;
  const key = SALE_TX_URL[network] ? network : (NET_ALIAS[network] || network);
  return SALE_TX_URL[key] ? SALE_TX_URL[key](tx) : null;
}
// Friendly network label for display: rows recorded before a chain was in the
// name map store the raw CAIP-2 id (e.g. eip155:42220) — show "celo" instead.
const netName = (n) => NET_ALIAS[n] || n;
// ---------------------------------------------------------------------------
// Two wires, one page. x402 (PAYMENT-SIGNATURE) and MPP (Authorization:
// Payment) are the two protocols this server settles; until 2026-08-18 the
// page was a 12-card x402-by-chain grid with MPP folded into one collapsed
// button at the very bottom. Both wires now get the same structure — an
// overview card each up top, then a by-rail section each with the SAME card
// language — while the numbers stay honest about scale (MPP is younger and
// mostly canary-proven so far; the page must not imply parity of volume).
// ---------------------------------------------------------------------------
const MPP_RAIL_META = {
  base: { label: "Base", asset: "USDC", how: "evm/charge via the shim → x402 settle", explorer: "https://basescan.org/address/" },
  celo: { label: "Celo", asset: "USDC", how: "evm/charge via the shim → x402 settle", explorer: "https://celoscan.io/address/" },
  tempo: { label: "Tempo", asset: "USDC.e / PathUSD", how: "native tempo/charge via Tempo's relay", explorer: "https://explore.tempo.xyz/address/" },
  // Card payments over MPP settle in US dollars, not a stablecoin.
  stripe: { label: "Card", asset: "USD", how: "card over MPP" },
};
const mppRailLabel = (n) => MPP_RAIL_META[n]?.label || netName(n) || n;

// Wire overview: two equal cards. Numbers come from two different ledgers on
// purpose — x402's from the on-chain settlement ledger (allTime), MPP's from
// the sales ledger's wire attribution (mppSales) — and each card says which.
// Honest rail throughput without double counting: MPP on Base/Celo settles as
// on-chain USDC, so it is ALREADY inside the transfers-ledger inbound count;
// only Tempo (native MPP, NOT RPC-scanned by the revenue ledger) is additive.
// Summing all of mppSales().count over the inbound count would double-count
// every Base/Celo MPP settlement — the inflation the adoption framing exists
// to avoid. tempo key confirmed against /api/revenue/mpp.
export function railThroughput(snap) {
  const onchain = Number(snap.allTime?.allTimeInboundCount || 0);
  const tempoMpp = Number(snap.mpp?.rails?.tempo?.count || 0);
  return { onchain, tempoMpp, total: onchain + tempoMpp };
}

// MPP by rail - one row per rail that settles over the wire (offered-but-quiet
// rails included, so a rail with zero settlements shows as live-and-waiting).
// The page is PUBLIC, so it renders the same aggregate /api/revenue/mpp serves
// unauthenticated callers - a per-settlement list pairing tool with price is a
// purchase feed. Count 0 and "rows withheld" are different statements; this
// table only ever makes the first when it is true.
// A rail whose MPP payment settles through x402 (the evm/charge shim) is
// already in the x402 table's External $, so it shows a pointer, not a second
// dollar figure; Tempo and Stripe settle off that ledger and show their own.
function mppExternalUsdCell(n, r) {
  if (/x402 settle/.test(MPP_RAIL_META[n]?.how || "")) return `<span style="color:var(--muted);" title="Settled as x402 on-chain USDC: counted in the x402 table's External $">in x402</span>`;
  if (r.externalUsd == null) return "-";
  return `$${Number(r.externalUsd).toFixed(Number(r.externalUsd) >= 1 ? 2 : 3)}`;
}

function mppRailsSection(mpp) {
  const count = Number(mpp?.count || 0);
  const rails = { ...(mpp?.rails || {}) };
  if (!Object.keys(rails).length && mpp?.byNetwork) {
    for (const [n, c] of Object.entries(mpp.byNetwork)) rails[n] = { count: c, external: null, lastAt: null, txs: [] };
  }
  for (const n of Object.keys(MPP_RAIL_META)) if (!rails[n]) rails[n] = { count: 0, external: 0, externalUsd: 0, lastAt: null, txs: [] };
  const entries = Object.entries(rails).sort((a, b) => (b[1].count - a[1].count) || a[0].localeCompare(b[0]));
  const rows = entries.map(([n, r]) => {
    const meta = MPP_RAIL_META[n] || { label: mppRailLabel(n), asset: "USDC", how: "" };
    // One proof link, labelled by its hash: checkable at a glance, matches an explorer.
    const tx = (r.txs || [])[0];
    const href = tx ? txHref(n, tx) : null;
    const proof = tx ? (href ? `<a href="${esc(href)}" rel="noopener" title="${esc(String(tx))}">${esc(String(tx).slice(0, 10))}…</a>` : `${esc(String(tx).slice(0, 10))}…`) : `<span style="color:var(--muted);">none yet</span>`;
    return `<tr>
      <td><strong>${esc(meta.label)}</strong> <span style="color:var(--muted);">${esc(meta.asset)}</span></td>
      <td class="num">${Number(r.count).toLocaleString()}</td>
      <td class="num">${r.external != null ? Number(r.external).toLocaleString() : "-"}</td>
      <td class="num">${mppExternalUsdCell(n, r)}</td>
      <td>${r.lastAt ? esc(String(r.lastAt).slice(0, 16)) + "Z" : '<span style="color:var(--muted);">offered, no settlement yet</span>'}</td>
      <td>${proof}</td>
    </tr>`;
  }).join("\n");
  return `
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:40px 0 6px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:22px;letter-spacing:-.01em;margin:0;">MPP wire <span style="color:var(--muted);font-weight:400;">· by rail</span></h2>
      <span style="font-family:var(--font-mono);font-size:12px;color:var(--muted);"><strong style="color:var(--ink);">${count.toLocaleString()}</strong> settlement${count === 1 ? "" : "s"} over <code>Authorization: Payment</code> · <a href="/api/revenue/mpp">/api/revenue/mpp</a></span>
    </div>
    <p style="font-size:13.5px;color:var(--muted);margin:0 0 12px;max-width:70ch;">Payments whose credential arrived over the <strong>MPP</strong> wire. Throughput, ours included: most of it is our own daily volume exercising the rails; the external columns are money from others. On Base and Celo an MPP payment settles as ordinary USDC through x402, so its dollars are already in the x402 table above; Tempo and card payments settle off that ledger and are counted here.</p>
    <div class="rv-tablewrap"><table class="rv-table">
      <thead><tr><th>Rail</th><th class="num">Settlements</th><th class="num">External</th><th class="num">External $</th><th>Last settled</th><th>Proof</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// Decide monitor: outside use of the paid planner and its execute route.
// Aggregates from the sales ledger (decideSales), all rails, ours counted
// apart. The page is public, so no per-call rows.
export function decideSection(d) {
  if (!d?.allTime) return "";
  const rows = [["decide", "Plans", "POST /api/decide"], ["decide-execute", "Runs", "POST /api/decide/execute"]].map(([k, label, route]) => {
    const a = d.allTime[k] || {}, w = d.window?.[k] || {};
    const money = (n) => `$${Number(n || 0).toFixed(Number(n || 0) >= 1 ? 2 : 3)}`;
    return `<tr>
      <td><strong>${esc(label)}</strong> <span style="color:var(--muted);"><code>${esc(route)}</code></span></td>
      <td class="num">${Number(a.count || 0).toLocaleString()}</td>
      <td class="num">${Number(a.external || 0).toLocaleString()}</td>
      <td class="num">${money(a.externalUsd)}</td>
      <td class="num">${Number(w.external || 0).toLocaleString()}</td>
      <td class="num">${Number(w.externalBuyers || 0).toLocaleString()}</td>
      <td>${a.lastExternalAt ? esc(String(a.lastExternalAt).slice(0, 13)) + "Z" : '<span style="color:var(--muted);">no outside buy yet</span>'}</td>
    </tr>`;
  }).join("\n");
  return `
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:40px 0 6px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:22px;letter-spacing:-.01em;margin:0;">Decide <span style="color:var(--muted);font-weight:400;">· plans and runs</span></h2>
      <span style="font-family:var(--font-mono);font-size:12px;color:var(--muted);"><a href="/api/revenue/decide">/api/revenue/decide</a></span>
    </div>
    <p style="font-size:13.5px;color:var(--muted);margin:0 0 12px;max-width:70ch;">Paid use of the planner and its execute route, on every rail. Settlements count ours too (canaries and tests); the external columns are other buyers. External $ is what they paid for the plan or the run, not the pass-through payments a run makes to outside sellers.</p>
    <div class="rv-tablewrap"><table class="rv-table">
      <thead><tr><th>Route</th><th class="num">Settlements</th><th class="num">External</th><th class="num">External $</th><th class="num">External, ${Number(d.days || 30)}d</th><th class="num">Buyers, ${Number(d.days || 30)}d</th><th>Last outside buy</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// Revenue chart — stacked-by-chain daily/cumulative series from
// /api/revenue/daily. Hand-rolled SVG, no libraries. Palette: the validated
// 8-slot categorical set (dataviz skill reference; both modes pass the
// six-check validator on this site's surfaces — light carries a contrast WARN
// whose relief is the table view below). Chains map to slots by ENTITY, fixed
// forever (never repainted by filters); chains outside the named seven fold
// into "Other" (slot 8).
// Exported for scripts/test-revenue-chart.js — the free-tier lane has
// invariants (never under Revenue $, never a chain colour) worth testing
// without standing up a full revenue snapshot.
export function revenueChartSection() {
  return `
  <style>
  .rvz{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;--sfree:#9aa0aa;--stempo:#0ea5b8;--snewbuyers:#199e70;--sretbuyers:#9085e9;--scumbuyers:#3987e5;--vsurf:var(--card)}
  .rvz{border:1px solid var(--hairline);background:var(--card);padding:18px 20px;margin:0 0 26px}
  .rvz-controls{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
  .rvz-seg{display:inline-flex;border:1px solid var(--hairline)}
  .rvz-seg button{background:transparent;border:none;border-right:1px solid var(--hairline);color:var(--muted);font-family:var(--font-mono);font-size:12px;padding:6px 12px;cursor:pointer}
  .rvz-seg button:last-child{border-right:none}
  .rvz-seg button.on{background:var(--surface);color:var(--on-dark);font-weight:700}
  .rvz-legend{display:flex;gap:12px;flex-wrap:wrap;font-family:var(--font-mono);font-size:11.5px;color:var(--muted);margin:10px 0 0}
  .rvz-legend span{display:inline-flex;align-items:center;gap:5px}
  .rvz-legend i{width:10px;height:10px;display:inline-block}
  .rvz-tip{position:absolute;pointer-events:none;background:var(--surface);color:var(--on-dark);border:1px solid var(--hairline);font-family:var(--font-mono);font-size:11.5px;line-height:1.6;padding:8px 11px;display:none;z-index:5;max-width:260px}
  .rvz-wrap{position:relative}
  .rvz-empty{font-family:var(--font-mono);font-size:12.5px;color:var(--muted);padding:30px 0;text-align:center}
  .rvz details{margin-top:12px;font-size:12.5px}
  .rvz details.rvz-adv{margin-top:0}
  .rvz details summary{cursor:pointer;font-family:var(--font-mono);color:var(--muted)}
  .rvz table{border-collapse:collapse;font-family:var(--font-mono);font-size:11.5px;margin-top:8px;width:100%}
  .rvz th,.rvz td{border:1px solid var(--dash);padding:3px 8px;text-align:right}
  .rvz th:first-child,.rvz td:first-child{text-align:left}
  </style>
  <div class="rvz" id="rvz">
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <span style="font-weight:800;font-size:17px;">Over time <span style="font-family:var(--font-mono);font-size:12px;color:var(--muted);">· by chain · external only unless you widen it</span></span>
      <a href="/api/revenue/daily" style="font-family:var(--font-mono);font-size:12px;">raw data →</a>
    </div>
    <div class="rvz-controls" style="margin-top:12px">
      <span class="rvz-seg" id="rvzMode"><button data-v="cum" class="on">Cumulative</button><button data-v="daily">Daily</button><button data-v="weekly">Weekly</button><button data-v="monthly">Monthly</button></span>
      <span class="rvz-seg" id="rvzMetric"><button data-v="usd" class="on">Revenue $</button><button data-v="tx">Transactions</button><button data-v="buyers">Buyers</button></span>
    </div>
    <details class="rvz-adv" style="margin:0 0 12px;">
      <summary>more filters: ours vs external, wire, free tier, self-funded</summary>
      <div class="rvz-controls" style="margin-top:10px">
        <span class="rvz-seg" id="rvzScope"><button data-v="ext" class="on">External</button><button data-v="int">Internal (canary)</button><button data-v="both">Both</button></span>
        <span class="rvz-seg" id="rvzWire"><button data-v="all" class="on">All wires</button><button data-v="x402">x402</button><button data-v="mpp">MPP</button></span>
        <span class="rvz-seg" id="rvzTraffic"><button data-v="paid" class="on">Paid</button><button data-v="free">Free (PoW)</button><button data-v="both">Both</button></span>
        <span class="rvz-seg" id="rvzSettle"><button data-v="all" class="on">All revenue</button><button data-v="sor">SOR (self-funded)</button><button data-v="direct">Direct</button></span>
      </div>
    </details>
    <p id="rvzBuyersNote" style="font-family:var(--font-mono);font-size:11.5px;color:var(--muted);margin:0 0 10px;display:none;"></p>
    <p id="rvzFreeNote" style="font-family:var(--font-mono);font-size:11.5px;color:var(--muted);margin:0 0 10px;display:none;"></p>
    <p id="rvzScopeNote" style="font-family:var(--font-mono);font-size:11.5px;color:var(--muted);margin:0 0 10px;display:none;"></p>
    <p id="rvzWireNote" style="font-family:var(--font-mono);font-size:11.5px;color:var(--muted);margin:0 0 10px;display:none;">MPP-wire settlements are identified by tx hash from the sales ledger, which began recording the wire on 2026-07-24 - earlier days read as x402 because the wire was not recorded, not because no MPP traffic existed. The teal Tempo lane is always MPP-wire (it's never x402-settleable) and drops out under the x402 filter.</p>
    <p id="rvzSettleNote" style="font-family:var(--font-mono);font-size:11.5px;color:var(--muted);margin:0 0 10px;display:none;">SOR = revenue settled on-chain to the dedicated spending wallet that pays external sellers (the route-execute tiers today) - the self-funding loop. Direct = everything settled to the treasury. The split is by receiving wallet, so revenue from before a tool joined the self-funding set reads as Direct - that is what the chain says, not a gap. The wire split is not tracked within this lane, so selecting it resets the wire filter.</p>
    <div class="rvz-wrap"><svg id="rvzSvg" viewBox="0 0 940 300" width="100%" role="img" aria-label="Stacked daily revenue by chain"></svg><div class="rvz-tip" id="rvzTip"></div></div>
    <div class="rvz-legend" id="rvzLegend"></div>
    <details><summary>view as table</summary><div id="rvzTable" style="overflow-x:auto"></div></details>
  </div>
  <script src="/js/revenue-chart.js"></script>`;
}

/** The next step for someone who just read our P&L.
 *
 *  /revenue is the most-visited page on the site - 1,172 views across 508
 *  sessions in 30 days, ahead of the homepage - and it ended on a link to a
 *  third-party index. A reader who has just decided we are credible had
 *  nowhere to go. This is the one honest next step, in the page's own
 *  register: the numbers above came from this rail, and here is the command
 *  that puts a line on it. No claim, no adjectives, a real price and a real
 *  route. The three doors below it are the three audiences the page actually
 *  has: someone who wants to call a tool, someone who wants to be paid, and
 *  someone who wants the finished work rather than the API.
 */
export function revenueNextStep() {
  return `<div style="margin:36px 0 0;border:1px solid var(--hairline);background:var(--card);padding:22px 20px;">
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:22px;letter-spacing:-.01em;margin:0 0 6px;">Put a line on this table.</h2>
    <p style="font-size:14px;line-height:1.6;color:var(--muted);margin:0 0 14px;max-width:68ch;">Every number above is a settlement through the same gate this command hits. It costs a tenth of a cent and needs no account: the 402 comes back with the price and the rails, your client signs, the call is served.</p>
    <pre style="margin:0 0 16px;padding:12px 14px;overflow-x:auto;background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:12.5px;line-height:1.5;"><code>curl -i https://agent402.tools/api/hash?text=hello</code></pre>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <a href="/markets" style="font-family:var(--font-mono);font-size:12.5px;border:1px solid var(--ink);padding:8px 12px;text-decoration:none;color:var(--btn-fg);background:var(--btn-bg);">Tools an agent can call &rarr;</a>
      <a href="/sell" style="font-family:var(--font-mono);font-size:12.5px;border:1px solid var(--hairline);padding:8px 12px;text-decoration:none;color:var(--ink);">Get paid on these rails &rarr;</a>
      <a href="/reports" style="font-family:var(--font-mono);font-size:12.5px;border:1px solid var(--hairline);padding:8px 12px;text-decoration:none;color:var(--ink);">Buy a finished report &rarr;</a>
    </div>
  </div>`;
}

export function revenuePage(baseUrl, snap) {
  const canonical = baseUrl + "/revenue";
  const title = "Transactions - x402 and MPP payment rails, every settle on-chain | Agent402";
  const description =
    `Every payment through the Agent402 rails, external and our own, across both wires (x402 and MPP) and ${RAILS_AMP}, plus Tempo. Each figure links to its on-chain proof.`;
  const chainKeyByLabel = { ...Object.fromEntries(Object.entries(EVM).map(([k, c]) => [c.label, k])), Solana: "solana", Stellar: "stellar", Algorand: "algorand" };
  const at = snap.allTime || {};
  const perChainOf = (r) => at.perChain?.[chainKeyByLabel[r.rail]];
  // One row per x402 rail. Transactions (ours included) is the liveness
  // signal; external count + dollars is the revenue signal; the newest
  // external buy is the one proof link a reader actually opens. The twelve
  // cards this replaced each listed four recent transfers, a scan note and a
  // wallet-explorer link. Per-payment rows are not published at all (publicRevenueSnapshot).
  // Dollar cells: two decimals from $1, three below (sub-cent calls stay legible).
  const usdCell = (n) => { const v = Number(n || 0); return v === 0 ? "$0" : `$${v.toFixed(v >= 1 ? 2 : 3)}`; };
  const railRow = (r) => {
    const c = perChainOf(r);
    // A balance present (fresh or carried forward from the last good read)
    // means the chain is live and settling; only a rail never read is
    // unreachable. Carried-forward reads say "cached" so freshness is honest.
    const hasBalance = r.balance != null;
    const status = !hasBalance ? `<span style="color:var(--accent);">unreachable</span>` : r.staleBalance ? `<span style="color:var(--green);">live</span> <span style="color:var(--muted);">cached</span>` : `<span style="color:var(--green);">live</span>`;
    // The proof link is OUR OWN newest settle (canary or volume run): an
    // outside buyer's tx hash resolves to that buyer's wallet on chain, so it
    // is never published here (see publicRevenueSnapshot).
    const own = r.lastInbound?.internal === true ? r.lastInbound : null;
    const proof = own && own.tx
      ? `<a href="${esc(own.tx)}" rel="noopener">${own.usd != null ? `$${esc(String(own.usd))}` : "settled"}</a>${own.when ? ` <span style="color:var(--muted);">${esc(String(own.when).slice(0, 10))}</span>` : ""}`
      : `<span style="color:var(--muted);">${hasBalance ? "none read yet" : "-"}</span>`;
    return `<tr>
      <td><strong>${esc(r.rail)}</strong> <span style="color:var(--muted);">${esc(r.asset)}</span></td>
      <td class="num">${c ? Number(c.inboundCount).toLocaleString() : "-"}${c && !c.caughtUp ? `<span style="display:block;font-size:10.5px;font-weight:400;color:var(--muted);">still syncing</span>` : ""}</td>
      <td class="num">${c && c.externalCount ? Number(c.externalCount).toLocaleString() : "0"}</td>
      <td class="num">${c ? esc(usdCell(c.externalUsd)) : "$0"}</td>
      <td>${proof}</td>
      <td>${status}</td>
      <td>${r.explorer ? `<a href="${esc(r.explorer)}" rel="noopener">explorer</a>` : "-"}</td>
    </tr>`;
  };
  const railsSorted = [...snap.rails].sort((a, b) => (Number(perChainOf(b)?.inboundCount) || 0) - (Number(perChainOf(a)?.inboundCount) || 0));
  const partialNotes = snap.rails.filter((r) => r.scanNote).length;

  // Hero: two numbers - throughput (every settled transaction, ours included:
  // the rail-stability signal) and distinct paying agents (the demand signal).
  // The dollar figure stays, external-only, one line under them: the decision
  // (the operator, 2026-09-01) was to lead with the counts and never to REMOVE
  // the revenue split. See railThroughput() for why MPP is Tempo-only here.
  const throughput = railThroughput(snap).total;
  // What this page is measuring, said once at the top. Derived from the same
  // snapshot the rest of the page renders, plus the index totals server.js
  // hands in - never typed, or the framing sentence goes stale first.
  const standing = standingBand({ ...(snap.standing || {}), settled: railThroughput(snap).total });
  // External payments across the scanned on-chain rails PLUS Tempo MPP
  // settlements (Tempo is not a scanned chain; ledgerSummary folds it in from
  // the sales ledger). Falls back to the on-chain pair for an older snapshot.
  const extCount = Number(at.allTimeExternalWithTempoCount ?? at.allTimeExternalCount ?? 0);
  const extUsd = Number(at.allTimeExternalWithTempoUsd ?? at.allTimeExternalUsd ?? 0);
  const agents = Number(snap.agents?.buyers || 0);
  const big = (n, label, sub) => `
    <div style="min-width:0;">
      <div style="font-family:var(--font-mono);font-size:40px;font-weight:700;color:var(--accent);line-height:1.05;">${n.toLocaleString()}</div>
      <div style="font-size:14px;color:var(--ink);margin-top:6px;">${label}</div>
      <div style="font-family:var(--font-mono);font-size:11.5px;color:var(--muted);margin-top:3px;">${sub}</div>
    </div>`;
  const hero = throughput ? `
    <div class="ml-2col" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin:22px 0 14px;max-width:720px;">
      ${big(throughput, "settled transactions, all-time", `x402 + MPP, ours included${at.syncing ? " · ledger still backfilling" : ""}`)}
      ${agents ? big(agents, `distinct agent${agents === 1 ? "" : "s"} have paid us on-chain`, `unique outside wallets${snap.agents?.scope?.since ? `, since ${esc(snap.agents.scope.since)}` : ""}${snap.agents?.top5SharePct != null ? ` · top 5 = ${snap.agents.top5SharePct}% of their payments` : ""}`) : ""}
    </div>
    <p style="font-family:var(--font-mono);font-size:13px;color:var(--ink);margin:0 0 4px;"><strong>${extCount.toLocaleString()}</strong> external payment${extCount === 1 ? "" : "s"} · <strong>$${extUsd.toFixed(2)}</strong> revenue, settled on-chain (x402 rails + Tempo MPP)${snap.card?.allTimeCount ? ` · <strong>${Number(snap.card.allTimeCount).toLocaleString()}</strong> card purchase${snap.card.allTimeCount === 1 ? "" : "s"} (${Number(snap.card.allTimeUsd).toFixed(2)}) <span style="color:var(--muted);font-weight:400;">by card, not on-chain</span>` : ""}</p>` : "";

  const body = `
  <div style="max-width:1100px;margin:0 auto;padding:56px 30px;">
    <section>
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/revenue</div>
    <h1 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1.05;letter-spacing:-.02em;margin:0 0 8px;color:var(--ink);">Transactions.</h1>
    <p style="font-size:16px;line-height:1.6;color:var(--muted);max-width:60ch;margin:0;">
      Every payment through our rails, on both wires (<strong>x402</strong> and <strong>MPP</strong>) plus card purchases, read from the chain. Revenue counts only money from others; throughput counts our own canary and volume runs too. <a href="/transparency#revenue-figures">How the two are told apart</a>.
    </p>
    ${standing}
    ${hero}
    <p style="font-size:12px;line-height:1.55;color:var(--muted);margin:2px 0 14px;max-width:72ch;">${agents ? `The wallet count is read from on-chain transfers plus Tempo MPP settlements${snap.agents?.scope?.since ? ` from ${esc(snap.agents.scope.since)}` : ""}, one wallet counted once across rails: it is a floor, not a lifetime total, and it cannot see card or prepaid-credits buyers, or a settlement whose payer is not exposed. ` : ""}Published so these rails can be checked against the chain. Operating history for a payments service, stated for transparency: information only, not an offer, a solicitation, a recommendation or investment advice, and not a projection. <a href="/transparency#revenue-figures">How each figure is derived</a>.</p>
    <p style="font-family:var(--font-mono);font-size:12px;color:var(--muted);margin:0 0 28px;">balances as of ${esc(snap.asOf)}, refreshed hourly · <a href="/api/revenue">/api/revenue</a> · <a href="/api/revenue/mpp">/api/revenue/mpp</a> · <a href="/api/revenue/daily">/api/revenue/daily</a></p>
    </section>
    <section>
    ${revenueChartSection()}
    </section>
    <section>
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:36px 0 6px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:22px;letter-spacing:-.01em;margin:0;">x402 rails <span style="color:var(--muted);font-weight:400;">· by chain</span></h2>
      <span style="font-family:var(--font-mono);font-size:12px;color:var(--muted);"><strong style="color:var(--ink);">${snap.rails.length}</strong> chains, ranked by transactions</span>
    </div>
    <p style="font-size:13.5px;color:var(--muted);margin:0 0 12px;max-width:70ch;">Transactions count every settlement on the rail, ours included. External is money from others. Proof is our own newest settle on the rail (a canary or volume run), linked to its explorer; outside buyers' transactions are counted, never listed, because a transaction hash names its payer on chain.</p>
    <div class="rv-tablewrap"><table class="rv-table">
      <thead><tr><th>Rail</th><th class="num">Transactions</th><th class="num">External</th><th class="num">External $</th><th>Our latest settle</th><th>Status</th><th>Wallet</th></tr></thead>
      <tbody>${railsSorted.map(railRow).join("\n")}</tbody>
    </table></div>
    ${partialNotes ? `<p style="font-family:var(--font-mono);font-size:11.5px;color:var(--muted);margin:8px 0 0;">${partialNotes} rail${partialNotes === 1 ? "" : "s"} read partially from public RPCs this refresh (balances are live; detail in <a href="/api/revenue">/api/revenue</a>).</p>` : ""}
    </section>
    <section>
    ${mppRailsSection(snap.mpp)}
    </section>
    <section>
    ${decideSection(snap.decide)}
    </section>
    <section>
    ${revenueNextStep()}
    </section>
    <section>
    <p style="font-size:13.5px;color:var(--muted);margin-top:30px;max-width:70ch;">Check us independently: <a href="https://www.x402scan.com/server/07eb3020-932a-436d-a739-557b6e47101d" rel="noopener">x402scan indexes our settlements</a>. Their totals include our own traffic, so they read higher than the external figures here; <a href="/transparency#revenue-figures">why the two differ</a>.</p>
    </section>
  </div>
  ${ledgerFooterCompact(baseUrl)}`;
  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "/revenue",
    jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: title, url: canonical, description },
    extraCss: `.rv-tablewrap{overflow-x:auto;border:1px solid var(--hairline);background:var(--card)}
.rv-table{border-collapse:collapse;width:100%;min-width:640px;font-family:var(--font-mono);font-size:12.5px}
.rv-table th,.rv-table td{padding:8px 12px;border-bottom:1px solid var(--dash);text-align:left;white-space:nowrap;vertical-align:baseline}
.rv-table th{font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}
.rv-table th.num,.rv-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.rv-table tbody tr:last-child td{border-bottom:none}`,
    body,
  });
}
// RAILS import keeps this module honest if the rail set changes: a rail in
// rails.js with no read-config here is a wiring bug the test below catches.
export function railsCoveredByLiveView() {
  const covered = new Set([...Object.values(EVM).map((c) => c.label), "Solana", "Stellar", "Algorand"]);
  return RAILS.every((r) => covered.has(r.name));
}
