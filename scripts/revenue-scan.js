// Scan recent USDC transfers into the revenue wallet on an EVM chain (Base by
// default; SCAN_NETWORK=polygon|arbitrum for the other accepted chains) and
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
// the per-call price range. Agent402 prices are flat $0.001–$0.02 per call, so a
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
  (process.env.OUR_WALLETS || "0xfeda7403aabe9a492ed70e810b396d8548a4a022")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
);
// A genuine per-call settlement can't exceed the max tool price ($0.02); the
// ceiling is generous headroom. Anything bigger is funding/tests/swaps, not a buy.
const MAX_CALL_USD = parseFloat(process.env.MAX_CALL_USD || "0.5");

// Which EVM chain to scan. Default base — the heartbeat's existing behavior.
// SCAN_NETWORK=polygon|arbitrum reuses the same scan against the other chains
// x402 accepts (same 0x payTo, different native-USDC contract) — without this
// their settlements are as invisible as Solana's were. Native Circle USDC
// addresses + RPC lists mirror src/tools/x402-kit.js.
const EVM_NETWORKS = {
  base: {
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://base.drpc.org"],
    spanBlocks: 12000, // ~6.5h at 2s blocks
  },
  polygon: {
    usdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    rpcs: ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com", "https://polygon.llamarpc.com", "https://polygon.drpc.org"],
    spanBlocks: 9500, // ~5.5h at 2.1s blocks — free-tier RPCs cap getLogs ranges at 10k blocks
  },
  arbitrum: {
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.llamarpc.com", "https://arbitrum.drpc.org"],
    spanBlocks: 90000, // ~6h at 0.25s blocks (address-filtered getLogs stays cheap)
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
 *  (funding, manual tests, swaps) is not a tool purchase. */
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
        catch { lastErr = new Error(`${url}: non-JSON (${r.status})`); continue; }
        if (j.result !== undefined) return j.result;
        lastErr = new Error(`${url}: ${JSON.stringify(j.error ?? j).slice(0, 120)}`);
      } catch (e) {
        lastErr = e;
      }
    }
    if (attempt < passes - 1) await sleep(1500 * (attempt + 1));
  }
  throw new Error(`All RPCs failed for ${method}: ${lastErr?.message}`);
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
    log(`USDC balance of ${WALLET} on ${SCAN_NETWORK}: $${balanceUsd.toFixed(4)}`);
  } catch (e) {
    log(`balance read failed (continuing): ${e.message}`);
  }

  let latest, logs;
  try {
    latest = parseInt(await rpc("eth_blockNumber", []), 16);
    logs = await rpc("eth_getLogs", [{
      fromBlock: "0x" + (latest - SPAN).toString(16),
      toBlock: "latest",
      address: USDC,
      topics: [TRANSFER, null, pad(WALLET)],
    }]);
  } catch (e) {
    bailSoft(e.message, { balanceUsd });
  }

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

    log(`USDC into ${WALLET} over last ${SPAN} blocks: ${rows.length} transfer(s), $${(Number(total) / 1e6).toFixed(4)}`);
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
