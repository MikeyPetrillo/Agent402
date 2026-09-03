// Scan recent stablecoin transfers into the revenue wallet on an EVM chain
// (Base USDC by default; SCAN_NETWORK=polygon|arbitrum for the other USDC
// chains, SCAN_NETWORK=robinhood for USDG on Robinhood Chain) and
// identify genuine external x402 payments for tools. Solana has its own
// scanner (revenue-scan-solana.js — different tx model).
//
// Payer = the Transfer event's `from` (topics[1]) — the on-chain truth of whose
// USDC actually moved. For x402 (EIP-3009 transferWithAuthorization) that is the
// buyer/authorizer, NOT the facilitator that submits the tx. We do NOT decode the
// first word of calldata anymore: that mis-read non-transferWithAuthorization
// transfers (routers, direct sends, funding) as a bogus `0x..0040` payer and
// reported them as "external customers".
//
// "external" = a transfer from a wallet not in OUR_WALLETS whose amount is within
// the per-call price range. Catalog prices now top out at $0.65 (skill packs, route-execute-max $0.55), so a
// single real settlement cannot plausibly exceed MAX_CALL_USD; larger inbound
// (wallet funding, manual tests, swaps) is not a tool purchase and is excluded.
//
// Prints a human summary to stderr; emits machine-readable JSON on stdout:
//   { payments, totalUsd, external: [{ when, usd, payer, tx }] }
//
// Best-effort: flaky public RPCs → empty result, exit 0 (never fail the heartbeat).
import { fileURLToPath } from "node:url";

const WALLET = (process.env.REVENUE_WALLET || "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0").toLowerCase();
const OUR_WALLETS = new Set(
  // Canary/burner EVM addresses (public; keys live only in CI). Rotated
  // 2026-07-17: 0xfeda7403… retired (drained), 0x902dcf34… is the current
  // burner. 0x77065d81… is the Base x402 SPENDING wallet (X402_UPSTREAM_BUYER_ADDRESS
  // on Railway) — its sweeps to the treasury are internal moves, never revenue.
  // All stay listed so historical AND ongoing self-flows classify internal.
  (process.env.OUR_WALLETS || "0xfeda7403aabe9a492ed70e810b396d8548a4a022,0x902dcf34e53695bdea2ffb354b1a2e58bd598256,0x77065d81e18ad403bcd6e9a0616b288e16744121")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
);
// A genuine per-call settlement can't exceed the max tool price ($0.02); the
// ceiling is generous headroom. Anything bigger is funding/tests/swaps, not a buy.
const MAX_CALL_USD = parseFloat(process.env.MAX_CALL_USD || "0.75");

// Which EVM chain to scan. Default base — the heartbeat's existing behavior.
// SCAN_NETWORK=polygon|arbitrum reuses the same scan against the other chains
// x402 accepts (same 0x payTo, different native-USDC contract) — without this
// their settlements are as invisible as Solana's were. Native Circle USDC
// addresses + RPC lists mirror src/tools/x402-kit.js.
// Alchemy first (reliable getLogs) — free public RPCs rate-limit cloud IPs,
// which is why this scanner's Polygon reads flaked from the GitHub Actions
// runner even though the chunked-scan fix was in place. One Alchemy key works
// across every network via its subdomain; when unset we fall back to the free
// RPCs unchanged. Same pattern as src/revenue-live.js.
const ALCHEMY = process.env.ALCHEMY_API_KEY;
const alchemy = (sub) => (ALCHEMY ? [`https://${sub}.g.alchemy.com/v2/${ALCHEMY}`] : []);

// An RPC key must never ride along in an error string — this scan's stdout JSON
// (including `reason`) is machine-readable and could be logged publicly. Strip the
// exact key and any `/v2/<token>` segment before any URL/message is surfaced.
const redact = (s) => {
  let out = String(s);
  if (ALCHEMY) out = out.split(ALCHEMY).join("***");
  return out.replace(/\/v2\/[A-Za-z0-9_-]{8,}/g, "/v2/***");
};

const EVM_NETWORKS = {
  base: {
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    rpcs: [...alchemy("base-mainnet"), "https://mainnet.base.org", "https://base.drpc.org"],
    spanBlocks: 12000, // ~6.5h at 2s blocks
  },
  polygon: {
    usdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    rpcs: [...alchemy("polygon-mainnet"), "https://polygon.drpc.org", "https://polygon-rpc.com"],
    spanBlocks: 9500, // ~5.5h at 2.1s blocks — free-tier RPCs cap getLogs ranges at 10k blocks
  },
  arbitrum: {
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    rpcs: [...alchemy("arb-mainnet"), "https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"],
    spanBlocks: 90000, // ~6h at 0.25s blocks (address-filtered getLogs stays cheap)
  },
  avalanche: {
    usdc: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
    rpcs: [...alchemy("avax-mainnet"), "https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
    spanBlocks: 10800, // ~6h at 2s blocks
  },
  sei: {
    usdc: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392",
    rpcs: ["https://evm-rpc.sei-apis.com", "https://sei-evm-rpc.publicnode.com"],
    spanBlocks: 40000, // ~4.4h at 0.4s blocks
    chunkBlocks: 1900, // sei-apis caps getLogs ranges at ~2,000 blocks (2026-07-28)
  },
  optimism: {
    usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    rpcs: [...alchemy("opt-mainnet"), "https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
    spanBlocks: 10800, // ~6h at 2s blocks
  },
  monad: {
    usdc: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    rpcs: [...alchemy("monad-mainnet"), "https://rpc.monad.xyz", "https://rpc2.monad.xyz"],
    spanBlocks: 43000, // ~6h at 0.5s blocks
  },
  celo: {
    usdc: "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
    rpcs: [...alchemy("celo-mainnet"), "https://forno.celo.org"],
    spanBlocks: 21600, // ~6h at 1s blocks
  },
  // Robinhood Chain settles USDG (Global Dollar), not USDC — same 6 decimals,
  // same ERC-20 Transfer scan, so the field keeps the `usdc` name (it is
  // "the stablecoin contract to scan"); `token` fixes the log labels.
  robinhood: {
    usdc: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    token: "USDG",
    rpcs: [...alchemy("robinhood-mainnet"), "https://rpc.mainnet.chain.robinhood.com"],
    // Measured ~0.15s blocks (block 4.04M seven days after the 2026-07-01
    // launch) — NOT the 2s Orbit default first assumed. 12k blocks was only
    // ~30 real minutes; the daily canary settle only appeared in the digest
    // because the digest happens to run 24 minutes after the canary.
    spanBlocks: 140000, // ~6h at 0.15s blocks
  },
};
const SCAN_NETWORK = (process.env.SCAN_NETWORK || "base").toLowerCase();
const NET = EVM_NETWORKS[SCAN_NETWORK];
if (!NET) {
  console.error(`revenue-scan: unknown SCAN_NETWORK "${SCAN_NETWORK}" (known: ${Object.keys(EVM_NETWORKS).join(", ")})`);
  process.exit(2);
}
const SPAN = parseInt(process.env.SPAN_BLOCKS || String(NET.spanBlocks), 10);

const USDC = NET.usdc;
const TOKEN = NET.token || "USDC";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + "0".repeat(24) + a.replace(/^0x/, "");
// Public RPCs that support eth_getLogs (some free endpoints don't, or
// restrict it — those are excluded). BASE_RPCS overrides for any network
// (name kept for heartbeat back-compat).
const RPCS = (process.env.BASE_RPCS || NET.rpcs.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pure helpers (unit-tested in scripts/test-revenue-scan.js) -------------

/** The Transfer event's `from` (topics[1]) as a lowercase 0x-address. */
export function payerFromLog(l) {
  const t = l?.topics?.[1];
  return t && t.length >= 40 ? ("0x" + t.slice(-40)).toLowerCase() : null;
}

/** A transfer is a real external payment only if it's from a wallet that isn't
 *  ours AND the amount is within the per-call price range. Larger inbound
 *  (funding, manual tests, swaps) is not a tool purchase.
 *
 *  SIBLING COPY: scripts/revenue-scan-solana.js has a parallel isExternalPayment.
 *  The two differ ON PURPOSE — this EVM version lowercases the payer (hex is
 *  case-insensitive) and treats a null payer as non-external (EVM Transfer logs
 *  always carry topics[1]); the Solana version must NOT lowercase (base58 is
 *  case-sensitive) and counts null-source rows (the source can be absent from
 *  meta). src/revenue-live.js imports the SOLANA copy and pre-lowercases EVM
 *  payers before calling it, so all three surfaces classify identically today.
 *  Keep the amount/ownership logic in sync across both — a change here that isn't
 *  mirrored will drift the daily digest from the live /revenue page. */
export function isExternalPayment(row, { ourWallets, maxUsd }) {
  if (!row || !row.payer) return false;
  const p = row.payer.toLowerCase();
  if (ourWallets.has(p)) return false;
  if (!(row.usd > 0) || row.usd > maxUsd) return false;
  return true;
}

// --- RPC --------------------------------------------------------------------

// Try every RPC, up to PASSES times, with backoff. Reads the body as text first
// so an HTML error page yields a clean handled error instead of a thrown
// SyntaxError mid-parse.
async function rpc(method, params, { passes = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < passes; attempt++) {
    for (const url of RPCS) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(20000),
        });
        const text = await r.text();
        let j;
        try { j = JSON.parse(text); }
        catch { lastErr = new Error(`${redact(url)}: non-JSON (${r.status})`); continue; }
        if (j.result !== undefined) return j.result;
        lastErr = new Error(`${redact(url)}: ${JSON.stringify(j.error ?? j).slice(0, 120)}`);
      } catch (e) {
        lastErr = e;
      }
    }
    if (attempt < passes - 1) await sleep(1500 * (attempt + 1));
  }
  throw new Error(redact(`All RPCs failed for ${method}: ${lastErr?.message}`));
}

async function main() {
  // Best-effort: any RPC/transport failure → empty result, exit 0 (no false page).
  const bailSoft = (reason, partial = {}) => {
    log(`revenue scan skipped (transient): ${reason}`);
    console.log(JSON.stringify({ network: SCAN_NETWORK, balanceUsd: null, payments: 0, totalUsd: 0, scannedBlocks: SPAN, external: [], ...partial, scanSkipped: true, reason }, null, 2));
    process.exit(0);
  };

  // Current USDC balance — the headline "has this wallet ever received money
  // on this chain" answer even when the recent-blocks window misses transfers
  // (nothing spends from the revenue wallet). Best-effort: null on RPC flake.
  let balanceUsd = null;
  try {
    const hex = await rpc("eth_call", [{ to: USDC, data: "0x70a08231" + pad(WALLET).slice(2) }, "latest"]);
    balanceUsd = Number(BigInt(hex && hex !== "0x" ? hex : "0x0")) / 1e6;
    log(`${TOKEN} balance of ${WALLET} on ${SCAN_NETWORK}: ${balanceUsd.toFixed(4)}`);
  } catch (e) {
    log(`balance read failed (continuing): ${e.message}`);
  }

  let latest;
  let logs = [];
  let missedChunks = 0;
  // Chunked scan: one whole-span eth_getLogs trips free-RPC range caps and
  // "archive" upsells (the 2026-07-03 digest skipped Base/Polygon this way).
  // Chunks are capped at 9,000 blocks — Alchemy rejects getLogs ranges over
  // 10k on some chains (Robinhood, verified 2026-07-08) — with a minimum of
  // 4 chunks; a failed chunk degrades to a partial scan, never skips the rail.
  // Per-net chunk cap: default 9,000 (Alchemy bound); nets whose RPCs enforce
  // tighter getLogs ranges declare chunkBlocks (Sei: 1,900).
  const LOG_CHUNKS = Math.max(4, Math.ceil(SPAN / (NET.chunkBlocks || 9000)));
  try {
    latest = parseInt(await rpc("eth_blockNumber", []), 16);
  } catch (e) {
    bailSoft(e.message, { balanceUsd });
  }
  const chunkSize = Math.ceil(SPAN / LOG_CHUNKS);
  for (let i = 0; i < LOG_CHUNKS; i++) {
    const from = Math.max(0, latest - SPAN + i * chunkSize);
    const to = Math.min(latest, from + chunkSize - 1);
    try {
      const part = await rpc("eth_getLogs", [{
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
        address: USDC,
        topics: [TRANSFER, null, pad(WALLET)],
      }]);
      if (Array.isArray(part)) logs.push(...part);
    } catch (e) {
      missedChunks++;
      log(`getLogs chunk ${i + 1}/${LOG_CHUNKS} failed (continuing): ${e.message}`);
    }
  }
  if (missedChunks === LOG_CHUNKS) bailSoft("all getLogs chunks failed", { balanceUsd });

  try {
    const tsCache = {};
    const blockTs = async (blk) => {
      if (!tsCache[blk]) tsCache[blk] = parseInt((await rpc("eth_getBlockByNumber", [blk, false])).timestamp, 16);
      return tsCache[blk];
    };

    let total = 0n;
    const rows = [];
    for (const l of logs) {
      const amt = BigInt(l.data);
      total += amt;
      rows.push({
        when: new Date((await blockTs(l.blockNumber)) * 1000).toISOString(),
        usd: Number(amt) / 1e6,
        payer: payerFromLog(l),
        tx: l.transactionHash,
      });
    }
    rows.sort((a, b) => a.when.localeCompare(b.when));

    log(`${TOKEN} into ${WALLET} over last ${SPAN} blocks: ${rows.length} transfer(s), ${(Number(total) / 1e6).toFixed(4)}`);
    for (const r of rows) {
      const ext = isExternalPayment(r, { ourWallets: OUR_WALLETS, maxUsd: MAX_CALL_USD });
      const tag = OUR_WALLETS.has((r.payer || "").toLowerCase()) ? "(our wallet)"
        : r.usd > MAX_CALL_USD ? `(ignored: $${r.usd} > $${MAX_CALL_USD} ceiling — not a per-call buy)`
        : ext ? "  <-- EXTERNAL" : "";
      log(`  $${r.usd} from ${r.payer || "unknown"} ${tag}`);
    }

    const external = rows.filter((r) => isExternalPayment(r, { ourWallets: OUR_WALLETS, maxUsd: MAX_CALL_USD }));
    console.log(JSON.stringify({
      network: SCAN_NETWORK,
      balanceUsd,
      payments: rows.length,
      totalUsd: Number((Number(total) / 1e6).toFixed(6)),
      scannedBlocks: SPAN,
      ...(missedChunks ? { partialChunks: missedChunks } : {}),
      maxCallUsd: MAX_CALL_USD,
      external,
    }, null, 2));
  } catch (e) {
    // Partial failure mid-decode is still best-effort — don't fail the heartbeat.
    bailSoft(e.message, { balanceUsd });
  }
}

// Run only as a CLI; importing for tests must not hit the network.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
