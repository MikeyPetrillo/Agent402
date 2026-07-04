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
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { RAILS } from "./rails.js";
// Pure, main-guarded helpers shared with the daily scanners — one
// classification rule everywhere: a transfer is external revenue only if the
// payer isn't one of OUR wallets (canary/test burners) AND the amount is a
// plausible per-call price. Internal test money is shown but never counted.
import { usdcDeltaForOwner, payerFromMeta, isExternalPayment } from "../scripts/revenue-scan-solana.js";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Same envs (and defaults) as scripts/revenue-scan{,-solana}.js.
export const MAX_CALL_USD = parseFloat(process.env.MAX_CALL_USD || "0.5");
export const OUR_EVM_WALLETS = new Set(
  (process.env.OUR_WALLETS || "0xfeda7403aabe9a492ed70e810b396d8548a4a022")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
);
// Default = the canary's Solana burner (public address; the key lives only
// in CI secrets) — its daily $0.05 self-buys are internal, not revenue.
export const OUR_SOLANA_WALLETS = new Set(
  (process.env.OUR_SOLANA_WALLETS || "9EMAayAfBR32J5d3ApEAG3NdKArRBtAqN7LA8c2WRM5o")
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
      "https://mainnet.base.org", "https://base.llamarpc.com", "https://base.drpc.org",
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
      "https://polygon.drpc.org", "https://polygon.llamarpc.com", "https://polygon-rpc.com",
    ],
    explorer: (a) => `https://polygonscan.com/address/${a}#tokentxns`,
    tx: (h) => `https://polygonscan.com/tx/${h}`,
  },
  arbitrum: {
    label: "Arbitrum", asset: "USDC", span: 90000,
    token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://arb1.arbitrum.io/rpc", "https://arbitrum.llamarpc.com", "https://arbitrum.drpc.org",
    ],
    explorer: (a) => `https://arbiscan.io/address/${a}#tokentxns`,
    tx: (h) => `https://arbiscan.io/tx/${h}`,
  },
  robinhood: {
    label: "Robinhood Chain", asset: "USDG", span: 30000,
    token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    rpcs: [
      ...(process.env.ALCHEMY_API_KEY ? [`https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
      "https://rpc.mainnet.chain.robinhood.com",
    ],
    explorer: (a) => `https://robinhoodchain.blockscout.com/address/${a}`,
    tx: (h) => `https://robinhoodchain.blockscout.com/tx/${h}`,
  },
};
export const SOLANA_RPCS = ["https://api.mainnet-beta.solana.com"];

export const pad = (a) => "0x" + "0".repeat(24) + a.toLowerCase().replace(/^0x/, "");

export async function rpcCall(urls, method, params, timeoutMs = 5000) {
  let lastErr;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
      lastErr = new Error(JSON.stringify(j.error ?? j).slice(0, 120));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all RPCs failed");
}

// One eth_getLogs over the whole span trips free-RPC range/"archive" caps
// (that's an RPC-provider upsell, not a real constraint), so the transfer
// scan walks BACKWARD from the head in span/4 chunks — newest first, early
// stop once 8 transfers are in hand, hard 12s budget. A failed chunk is a
// partial window, never an error: the balance (a cheap head read) stays up
// and the card says the scan was partial instead of parroting vendor text.
const LOG_CHUNKS = 4;
async function recentInbound(c, wallet, latest) {
  const chunk = Math.ceil(c.span / LOG_CHUNKS);
  const deadline = Date.now() + 12_000;
  const logs = [];
  let missed = 0;
  for (let i = 0; i < LOG_CHUNKS && logs.length < 8 && Date.now() < deadline; i++) {
    const to = latest - i * chunk;
    if (to <= 0) break;
    const from = Math.max(0, to - chunk + 1);
    try {
      const part = await rpcCall(c.rpcs, "eth_getLogs", [{
        address: c.token,
        topics: [TRANSFER_TOPIC, null, pad(wallet)],
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
      }], 4000);
      if (Array.isArray(part)) logs.push(...part);
    } catch {
      missed++;
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
  // Best-effort block timestamps — one RPC call per transfer (8 max).
  for (const t of recent) {
    try {
      const blk = await rpcCall(c.rpcs, "eth_getBlockByNumber", ["0x" + t.block.toString(16), false], 3000);
      if (blk?.timestamp) t.when = new Date(parseInt(blk.timestamp, 16) * 1000).toISOString();
    } catch { /* timestamp is nice-to-have, not required */ }
  }
  return { recent, missed };
}

async function evmRail(name, wallet) {
  const c = EVM[name];
  const out = { rail: c.label, asset: c.asset, wallet: wallet || null, explorer: wallet ? c.explorer(wallet) : null, balance: null, recent: [], error: null, scanNote: null };
  if (!wallet) { out.error = "WALLET_ADDRESS unset"; return out; }
  try {
    const balHex = await rpcCall(c.rpcs, "eth_call", [{ to: c.token, data: "0x70a08231" + pad(wallet).slice(2) }, "latest"]);
    out.balance = Number(BigInt(balHex && balHex !== "0x" ? balHex : "0x0")) / 1e6;
    const latest = parseInt(await rpcCall(c.rpcs, "eth_blockNumber", []), 16);
    const { recent, missed } = await recentInbound(c, wallet, latest);
    out.recent = recent;
    out.externalUsd = Number(recent.filter((t) => t.external).reduce((s, t) => s + t.usd, 0).toFixed(6));
    out.windowBlocks = c.span;
    if (missed) out.scanNote = `transfer scan partial: ${missed}/${LOG_CHUNKS} windows unavailable from public RPCs (balance is live)`;
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
  }
  return out;
}

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
    out.externalUsd = Number(out.recent.filter((t) => t.external).reduce((s, t) => s + t.usd, 0).toFixed(6));
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
  }
  return out;
}

// Stellar — read USDC balance + recent payments via Horizon API.
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
async function stellarRail(wallet) {
  const out = { rail: "Stellar", asset: "USDC", wallet: wallet || null, explorer: wallet ? `https://stellar.expert/explorer/public/account/${wallet}` : null, balance: null, recent: [], error: null };
  if (!wallet) { out.error = "STELLAR_WALLET_ADDRESS unset"; return out; }
  try {
    // Balance
    const res = await fetch(`https://horizon.stellar.org/accounts/${wallet}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) { out.error = `Horizon HTTP ${res.status}`; return out; }
    const acct = await res.json();
    const usdcBalance = acct.balances?.find((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
    out.balance = usdcBalance ? Number(usdcBalance.balance) : 0;
    // Recent payments (incoming USDC)
    try {
      const payRes = await fetch(
        `https://horizon.stellar.org/accounts/${wallet}/payments?order=desc&limit=10`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (payRes.ok) {
        const payData = await payRes.json();
        const records = payData?._embedded?.records || [];
        for (const r of records) {
          // x402 settlements are invoke_host_function (Soroban); wallet funding
          // can be path_payment_strict_send or payment. Accept all that carry USDC.
          if (r.type === "payment" || r.type === "path_payment_strict_send" || r.type === "path_payment_strict_receive") {
            if (r.to !== wallet) continue;
            if (r.asset_code !== "USDC") continue;
            out.recent.push({
              tx: `https://stellar.expert/explorer/public/tx/${r.transaction_hash}`,
              when: r.created_at || null,
              usd: Number(r.amount) || 0,
              from: r.from || null,
            });
          } else if (r.type === "invoke_host_function") {
            // Soroban x402 settlement — no amount/asset in the operation itself,
            // but it's a confirmed interaction with this wallet. Show it.
            out.recent.push({
              tx: `https://stellar.expert/explorer/public/tx/${r.transaction_hash}`,
              when: r.created_at || null,
              usd: null, // amount not directly available from the operation
              from: r.source_account || null,
            });
          }
        }
      }
    } catch { /* payment scan is best-effort */ }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 120);
  }
  return out;
}

// 60s snapshot cache — refresh costs at most one scan per minute regardless
// of page traffic, and a burst of refreshes can't hammer public RPCs.
let cached = null;
let cachedAt = 0;
export async function revenueSnapshot({ walletAddress, solanaWallet }) {
  if (cached && Date.now() - cachedAt < 60_000) return cached;
  const stellarWallet = (process.env.STELLAR_WALLET_ADDRESS || "").trim();
  const [base, polygon, arbitrum, robinhood, solana, stellar] = await Promise.all([
    evmRail("base", walletAddress),
    evmRail("polygon", walletAddress),
    evmRail("arbitrum", walletAddress),
    evmRail("robinhood", walletAddress),
    solanaRail(solanaWallet),
    stellarRail(stellarWallet),
  ]);
  const rails = [base, solana, polygon, arbitrum, stellar, robinhood];
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
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

// "What's selling" — the sales ledger's merchant view (src/sales-ledger.js):
// external paid calls BY NAME. The on-chain cards above prove the money;
// this section names the products. Renders nothing until the first
// externally-paid call lands (recording started 2026-07-04).
const SALE_TX_URL = {
  base: (h) => `https://basescan.org/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
  "robinhood (USDG)": (h) => `https://robinhoodchain.blockscout.com/tx/${h}`,
  solana: (h) => `https://solscan.io/tx/${h}`,
};
function salesSection(sales) {
  if (!sales) return "";
  const rows = sales.topExternal || [];
  const recent = sales.recentExternal || [];
  const internal = sales.recentInternal || [];
  const since = sales.recordingSince ? new Date(sales.recordingSince).toISOString().slice(0, 10) : null;
  const empty = !rows.length && !recent.length && !internal.length;
  return `
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:26px;margin:44px 0 6px;">What's selling</h2>
    <p style="font-size:14px;color:var(--muted);margin:0 0 16px;">Every paid call recorded by name at settle time${since ? ` (recording since ${esc(since)})` : ""} — external demand plus internal canary/test activity. Machine-readable: <a href="/api/sales">/api/sales</a>.</p>
    ${empty
      ? `<p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);">no paid calls recorded yet — the ledger names each one as it lands</p>`
      : `<div class="ml-2col" style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px;">
      <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
        <div style="font-weight:800;font-size:15px;border-bottom:1px dashed #b3a98f;padding-bottom:8px;margin-bottom:10px;">top bought (30d) — $${(sales.totals?.external?.revenueUsd ?? 0).toFixed(4)} external</div>
        <div style="font-family:var(--font-mono);font-size:12.5px;display:grid;gap:6px;">
          ${rows.map((r) => `<div><a href="/tools/${esc(r.slug)}">${esc(r.slug)}</a> × ${r.sales} · $${r.revenueUsd.toFixed(4)}</div>`).join("") || '<div style="color:var(--muted);">—</div>'}
        </div>
      </div>
      <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
        <div style="font-weight:800;font-size:15px;border-bottom:1px dashed #b3a98f;padding-bottom:8px;margin-bottom:10px;">recent external sales</div>
        <div style="font-family:var(--font-mono);font-size:12.5px;display:grid;gap:6px;">
          ${recent.slice(0, 10).map((s) => {
            const link = s.tx && SALE_TX_URL[s.network] ? ` · <a href="${esc(SALE_TX_URL[s.network](s.tx))}" rel="noopener">tx</a>` : "";
            return `<div><a href="/tools/${esc(s.slug)}">${esc(s.slug)}</a> $${s.priceUsd} · ${esc((s.network || s.rail))}${s.payer ? ` · <code>${esc(short(s.payer))}</code>` : ""}${link} · ${esc(s.at.slice(0, 16))}Z</div>`;
          }).join("") || '<div style="color:var(--muted);">—</div>'}
        </div>
      </div>
      <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
        <div style="font-weight:800;font-size:15px;border-bottom:1px dashed #b3a98f;padding-bottom:8px;margin-bottom:10px;">recent internal (canary/test) — $${(sales.totals?.internal?.revenueUsd ?? 0).toFixed(4)}</div>
        <div style="font-family:var(--font-mono);font-size:12.5px;display:grid;gap:6px;">
          ${internal.slice(0, 10).map((s) => {
            const link = s.tx && SALE_TX_URL[s.network] ? ` · <a href="${esc(SALE_TX_URL[s.network](s.tx))}" rel="noopener">tx</a>` : "";
            return `<div style="opacity:.62;"><a href="/tools/${esc(s.slug)}">${esc(s.slug)}</a> $${s.priceUsd} · ${esc((s.network || s.rail))}${s.payer ? ` · <code>${esc(short(s.payer))}</code>` : ""}${link} · ${esc(s.at.slice(0, 16))}Z</div>`;
          }).join("") || '<div style="color:var(--muted);">—</div>'}
        </div>
      </div>
    </div>`}`;
}

export function revenuePage(baseUrl, snap) {
  const canonical = baseUrl + "/revenue";
  const title = "Live revenue — Agent402";
  const description =
    "Consolidated live view of the Agent402 revenue wallets across every payment rail — USDC on Base, Solana, Polygon & Arbitrum, plus USDG on Robinhood Chain. One page instead of three explorer tabs; every figure links to its on-chain proof.";
  const chainKeyByLabel = { ...Object.fromEntries(Object.entries(EVM).map(([k, c]) => [c.label, k])), Solana: "solana" };
  const railCard = (r) => {
    const at = snap.allTime?.perChain?.[chainKeyByLabel[r.rail]];
    return `
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:18px 20px;">
      <div style="display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px dashed #b3a98f;padding-bottom:10px;margin-bottom:12px;">
        <span style="font-weight:800;font-size:17px;">${esc(r.rail)} <span style="font-family:var(--font-mono);font-size:12px;color:var(--muted);">· ${esc(r.asset)}</span></span>
        <span style="font-family:var(--font-mono);text-align:right;"><span style="font-size:20px;font-weight:700;">${r.balance == null ? "—" : "$" + r.balance.toFixed(4)}</span><span style="display:block;font-size:11px;color:var(--muted);">balance${Number.isFinite(r.externalUsd) ? ` · external in window $${r.externalUsd}` : ""}${at ? ` · all-time $${at.externalUsd}${at.caughtUp ? "" : "↺"}` : ""}</span></span>
      </div>
      ${r.error
        ? `<div style="font-family:var(--font-mono);font-size:12px;color:var(--muted);">rail read unavailable — public RPC error (detail in <a href="/api/revenue">/api/revenue</a>)</div>`
        : r.recent.length
          ? `<div style="font-family:var(--font-mono);font-size:12.5px;display:grid;gap:6px;">${r.recent
              .map((t) => {
                const tag = t.usd === undefined ? ""
                  : t.external ? ` · <strong style="color:var(--accent);">external</strong>`
                  : t.internal ? ` · <span style="color:var(--muted);">internal canary/test</span>`
                  : ` · <span style="color:var(--muted);">not a per-call buy</span>`;
                const dim = t.usd !== undefined && !t.external ? "opacity:.62;" : "";
                const when = t.when ? ` · <span style="color:var(--muted);">${esc(t.when.slice(0, 16))}Z</span>` : "";
                return t.usd !== undefined
                  ? `<div style="${dim}">+$${t.usd} from <code>${esc(short(t.from))}</code> · <a href="${esc(t.tx)}" rel="noopener">tx</a>${tag}${when}</div>`
                  : `<div><a href="${esc(t.tx)}" rel="noopener">tx</a>${when}${t.err ? " · failed" : ""}</div>`;
              })
              .join("")}</div>`
          : `<div style="font-family:var(--font-mono);font-size:12px;color:var(--muted);">no inbound transfers in the recent window</div>`}
      ${r.scanNote ? `<div style="margin-top:8px;font-family:var(--font-mono);font-size:11.5px;color:var(--muted);">${esc(r.scanNote)}</div>` : ""}
      ${r.explorer ? `<div style="margin-top:12px;font-family:var(--font-mono);font-size:12px;"><a href="${esc(r.explorer)}" rel="noopener">open in explorer →</a></div>` : ""}
    </div>`;
  };
  const body = `
  <main style="max-width:1100px;margin:0 auto;padding:56px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/revenue</div>
    <h1 style="font-family:var(--font-body);font-weight:800;font-size:44px;line-height:1.05;letter-spacing:-.02em;margin:0 0 8px;color:var(--ink);">Live revenue.</h1>
    <p style="font-size:16px;line-height:1.6;color:var(--muted);max-width:640px;margin:0 0 8px;">
      Every rail's wallet, one page — refreshed from public RPCs (60s cache), every figure verifiable at its explorer link.
      Machine-readable: <a href="/api/revenue">/api/revenue</a>.
    </p>
    ${snap.allTime ? `<p style="font-family:var(--font-mono);font-size:15px;margin:0 0 6px;">external revenue, all-time: <strong style="color:var(--accent);font-size:22px;">$${snap.allTime.allTimeExternalUsd.toFixed(4)}</strong> <span style="color:var(--muted);">across ${snap.allTime.allTimeExternalCount} payment${snap.allTime.allTimeExternalCount === 1 ? "" : "s"}${snap.allTime.syncing ? " · ledger backfilling — total still rising" : ""}</span></p>` : ""}
    <p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);margin:0 0 30px;">as of ${esc(snap.asOf)} · combined balance <strong style="color:var(--ink);">$${snap.totalUsd.toFixed(4)}</strong> · external in recent window <strong style="color:var(--accent);">$${(snap.windowExternalUsd ?? 0).toFixed(4)}</strong><br>balances include our own canary/test money — only transfers classified <strong style="color:var(--accent);">external</strong> count as revenue</p>
    <div class="ml-2col" style="display:grid;grid-template-columns:repeat(2,1fr);gap:16px;">
      ${snap.rails.map(railCard).join("\n")}
    </div>
    <p style="font-size:13.5px;color:var(--muted);margin-top:26px;">Recent-window transfers are the last few hours of inbound stablecoin on each rail, classified with the same rule as the daily revenue digest: a payment is <strong>external</strong> only if it comes from a wallet that isn't ours (canary/test burners are excluded) and is per-call-sized (≤ $${MAX_CALL_USD}); bigger inbound is funding or tests, not a buy. Rails read best-effort: a flaky public RPC marks that rail unavailable without hiding the others.</p>
    ${salesSection(snap.sales)}
  </main>
  ${ledgerFooterCompact(baseUrl)}`;
  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "/revenue",
    jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: title, url: canonical, description },
    body,
  });
}
// RAILS import keeps this module honest if the rail set changes: a rail in
// rails.js with no read-config here is a wiring bug the test below catches.
export function railsCoveredByLiveView() {
  const covered = new Set([...Object.values(EVM).map((c) => c.label), "Solana", "Stellar"]);
  return RAILS.every((r) => covered.has(r.name));
}
