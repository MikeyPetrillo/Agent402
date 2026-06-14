// Scan recent USDC transfers into the revenue wallet on Base and decode the
// REAL payer of each (x402 settles via transferWithAuthorization — the buyer
// is the first word of calldata, not tx.from, which is the facilitator).
// Prints a human summary to stderr; emits machine-readable JSON on stdout:
//   { payments, totalUsd, external: [{ when, usd, payer, tx }] }
// "external" = payments from any wallet not in OUR_WALLETS (our test burners).
//
// This is a best-effort background scan: if the public RPCs are flaky (they
// return HTML rate-limit pages, time out, etc.) we emit an empty result and
// exit 0 rather than crash — a missed cycle self-corrects on the next run, and
// a transient RPC hiccup must never fail the heartbeat / page the operator.
const WALLET = (process.env.REVENUE_WALLET || "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0").toLowerCase();
const OUR_WALLETS = new Set(
  (process.env.OUR_WALLETS || "0xfeda7403aabe9a492ed70e810b396d8548a4a022")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
);
const SPAN = parseInt(process.env.SPAN_BLOCKS || "12000", 10); // ~6.5h of Base blocks

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + "0".repeat(24) + a.replace(/^0x/, "");
// Public Base RPCs that support eth_getLogs (some free endpoints don't, or
// restrict it — those are excluded). An optional BASESCAN_API_KEY path could be
// added later for higher reliability.
const RPCS = (process.env.BASE_RPCS || [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://base.drpc.org",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Best-effort: any RPC/transport failure → empty result, exit 0 (no false page).
function bailSoft(reason) {
  log(`revenue scan skipped (transient): ${reason}`);
  console.log(JSON.stringify({ payments: 0, totalUsd: 0, scannedBlocks: SPAN, external: [], scanSkipped: true, reason }, null, 2));
  process.exit(0);
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
  bailSoft(e.message);
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
    const tx = await rpc("eth_getTransactionByHash", [l.transactionHash]);
    const input = tx?.input || "0x";
    rows.push({
      when: new Date((await blockTs(l.blockNumber)) * 1000).toISOString(),
      usd: Number(amt) / 1e6,
      payer: input.length >= 10 + 64 ? ("0x" + input.slice(10 + 24, 10 + 64)).toLowerCase() : null,
      tx: l.transactionHash,
    });
  }
  rows.sort((a, b) => a.when.localeCompare(b.when));

  log(`USDC into ${WALLET} over last ${SPAN} blocks: ${rows.length} payment(s), $${(Number(total) / 1e6).toFixed(4)}`);
  const byPayer = {};
  for (const r of rows) byPayer[r.payer || "unknown"] = (byPayer[r.payer || "unknown"] || 0) + 1;
  for (const [p, n] of Object.entries(byPayer).sort((a, b) => b[1] - a[1])) {
    log(`  ${n} from ${p}${OUR_WALLETS.has(p) ? " (our burner)" : p === "unknown" ? "" : "  <-- EXTERNAL"}`);
  }

  const external = rows.filter((r) => r.payer && !OUR_WALLETS.has(r.payer));
  console.log(JSON.stringify({
    payments: rows.length,
    totalUsd: Number((Number(total) / 1e6).toFixed(6)),
    scannedBlocks: SPAN,
    external,
  }, null, 2));
} catch (e) {
  // Partial failure mid-decode (e.g. an RPC died after the log fetch) is still
  // best-effort — don't fail the heartbeat over it.
  bailSoft(e.message);
}
