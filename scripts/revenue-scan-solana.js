// Scan USDC (SPL) received by the Solana revenue wallet and identify genuine
// external x402 payments for tools — the Solana counterpart of revenue-scan.js.
// revenue-scan.js reads Base's USDC Transfer logs; nothing there (or in the
// probe/heartbeat jobs) can see Solana settlements, so Solana revenue was
// invisible to all reporting until this scan existed.
//
// Two layers, cheapest first:
//   1. Current USDC balance of the wallet's token account(s) — nothing spends
//      from the revenue wallet, so balance > 0 is the headline "did we make
//      any money on Solana" answer even when tx enumeration is rate-limited.
//   2. Recent transaction history on each USDC token account, decoding the
//      wallet's net USDC delta per tx from pre/postTokenBalances. Incoming
//      deltas within the per-call price range from a wallet not in
//      OUR_SOLANA_WALLETS are counted as external payments (same semantics
//      as revenue-scan.js: larger inbound is funding/tests, not a tool buy).
//
// Payer = the owner of the token account whose USDC decreased in the same tx
// (the buyer/authorizer under the x402 SVM exact scheme — facilitator only
// submits). Best-effort: unknown when the source account isn't in the tx meta.
//
// Prints a human summary to stderr; emits machine-readable JSON on stdout:
//   { balanceUsd, payments, totalUsd, external: [{ when, usd, payer, tx }] }
//
// Best-effort: flaky public RPCs → partial/empty result, exit 0 (never fail
// the heartbeat or the probe).
//
// Run: SOLANA_REVENUE_WALLET=<base58 owner address> node scripts/revenue-scan-solana.js
// Optional env:
//   OUR_SOLANA_WALLETS   comma-separated owner addresses to exclude (our burners)
//   MAX_CALL_USD         external-payment ceiling (default 0.5, same as Base scan)
//   SIG_LIMIT            signatures scanned per token account (default 100)
//   SOLANA_RPCS          comma-separated JSON-RPC endpoints
import { fileURLToPath } from "node:url";

const WALLET = (process.env.SOLANA_REVENUE_WALLET || "").trim();
const OUR_WALLETS = new Set(
  (process.env.OUR_SOLANA_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean)
);
const MAX_CALL_USD = parseFloat(process.env.MAX_CALL_USD || "0.5");
const SIG_LIMIT = Math.min(parseInt(process.env.SIG_LIMIT || "100", 10), 1000);

// Circle's canonical USDC mint on Solana mainnet.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPCS = (process.env.SOLANA_RPCS || [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pure helpers (unit-tested in scripts/test-revenue-scan-solana.js) ------

/** Net USDC change (in UI units, i.e. dollars) for `owner` in one transaction,
 *  computed from the tx meta's pre/postTokenBalances. Positive = received. */
export function usdcDeltaForOwner(meta, owner, mint = USDC_MINT) {
  if (!meta) return 0;
  const sum = (rows) =>
    (rows || [])
      .filter((b) => b && b.owner === owner && b.mint === mint)
      .reduce((s, b) => s + (Number(b.uiTokenAmount?.uiAmount) || 0), 0);
  return sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
}

/** The owner whose USDC decreased in this tx (the buyer under the x402 SVM
 *  exact scheme). Picks the largest negative delta that isn't `owner`;
 *  null when the source account isn't present in the tx meta. */
export function payerFromMeta(meta, owner, mint = USDC_MINT) {
  if (!meta) return null;
  const deltas = new Map();
  for (const [rows, sign] of [[meta.preTokenBalances, -1], [meta.postTokenBalances, 1]]) {
    for (const b of rows || []) {
      if (!b || b.mint !== mint || !b.owner || b.owner === owner) continue;
      const amt = Number(b.uiTokenAmount?.uiAmount) || 0;
      deltas.set(b.owner, (deltas.get(b.owner) || 0) + sign * amt);
    }
  }
  let payer = null;
  let most = -1e-9; // strictly negative deltas only
  for (const [who, d] of deltas) {
    if (d < most) {
      most = d;
      payer = who;
    }
  }
  return payer;
}

/** Same contract as revenue-scan.js: external = not one of our wallets AND
 *  within the per-call price range. Unknown payers stay countable — on Solana
 *  the source account can be absent from meta, and an incoming per-call-sized
 *  transfer is still revenue. */
export function isExternalPayment(row, { ourWallets, maxUsd }) {
  if (!row) return false;
  if (row.payer && ourWallets.has(row.payer)) return false;
  if (!(row.usd > 0) || row.usd > maxUsd) return false;
  return true;
}

// --- RPC --------------------------------------------------------------------

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
  if (!WALLET) {
    log("SOLANA_REVENUE_WALLET is not set — nothing to scan.");
    console.log(JSON.stringify({ balanceUsd: null, payments: 0, totalUsd: 0, external: [], scanSkipped: true, reason: "no SOLANA_REVENUE_WALLET" }, null, 2));
    return;
  }

  const bailSoft = (reason, partial = {}) => {
    log(`solana revenue scan skipped (transient): ${reason}`);
    console.log(JSON.stringify({ balanceUsd: null, payments: 0, totalUsd: 0, external: [], ...partial, scanSkipped: true, reason }, null, 2));
    process.exit(0);
  };

  // Layer 1: token accounts + current balance (one cheap call).
  let accounts;
  try {
    const res = await rpc("getTokenAccountsByOwner", [
      WALLET,
      { mint: USDC_MINT },
      { encoding: "jsonParsed" },
    ]);
    accounts = res?.value || [];
  } catch (e) {
    bailSoft(e.message);
  }
  const balanceUsd = accounts.reduce(
    (s, a) => s + (Number(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount) || 0),
    0
  );
  log(`USDC balance of ${WALLET} on Solana: $${balanceUsd.toFixed(4)} across ${accounts.length} token account(s)`);
  if (!accounts.length) {
    console.log(JSON.stringify({ balanceUsd: 0, payments: 0, totalUsd: 0, maxCallUsd: MAX_CALL_USD, external: [], note: "wallet has no USDC token account — it has never received USDC on Solana" }, null, 2));
    return;
  }

  // Layer 2: recent history per token account (best-effort; rate-limit friendly).
  try {
    const rows = [];
    let total = 0;
    for (const a of accounts) {
      const tokenAccount = a.pubkey;
      const sigs = await rpc("getSignaturesForAddress", [tokenAccount, { limit: SIG_LIMIT }]);
      for (const s of sigs || []) {
        if (!s || s.err) continue;
        await sleep(150); // public-RPC politeness
        let tx;
        try {
          tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
        } catch {
          continue; // single flaky tx fetch must not kill the scan
        }
        const usd = usdcDeltaForOwner(tx?.meta, WALLET);
        if (!(usd > 0)) continue; // outgoing / non-USDC / failed
        total += usd;
        rows.push({
          when: new Date((s.blockTime || tx?.blockTime || 0) * 1000).toISOString(),
          usd: +usd.toFixed(6),
          payer: payerFromMeta(tx?.meta, WALLET),
          tx: s.signature,
        });
      }
    }
    rows.sort((a, b) => a.when.localeCompare(b.when));

    log(`USDC into ${WALLET} over last ${SIG_LIMIT} signatures/account: ${rows.length} transfer(s), $${total.toFixed(4)}`);
    for (const r of rows) {
      const ext = isExternalPayment(r, { ourWallets: OUR_WALLETS, maxUsd: MAX_CALL_USD });
      const tag = r.payer && OUR_WALLETS.has(r.payer) ? "(our wallet)"
        : r.usd > MAX_CALL_USD ? `(ignored: $${r.usd} > $${MAX_CALL_USD} ceiling — not a per-call buy)`
        : ext ? "  <-- EXTERNAL" : "";
      log(`  $${r.usd} from ${r.payer || "unknown"} ${tag}`);
    }

    const external = rows.filter((r) => isExternalPayment(r, { ourWallets: OUR_WALLETS, maxUsd: MAX_CALL_USD }));
    console.log(JSON.stringify({
      balanceUsd: +balanceUsd.toFixed(6),
      payments: rows.length,
      totalUsd: +total.toFixed(6),
      scannedSignatures: SIG_LIMIT,
      maxCallUsd: MAX_CALL_USD,
      external,
    }, null, 2));
  } catch (e) {
    // Balance already known — report it even when history enumeration failed.
    bailSoft(e.message, { balanceUsd: +balanceUsd.toFixed(6) });
  }
}

// Run only as a CLI; importing for tests must not hit the network.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
