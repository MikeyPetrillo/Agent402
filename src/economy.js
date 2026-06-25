// /economy — daily x402 ecosystem report, rendered from the same leaderboard
// snapshot the on-chain crawler already maintains. Zero new infra: the
// hourly Bazaar+Base USDC scan in src/leaderboard.js feeds this page.
//
// Why this page exists separately from /leaderboard: /leaderboard ranks
// sellers, which is a comparison tool. /economy is a state-of-the-ecosystem
// summary — total volume, concentration, network split — the shape an
// agent (or a journalist) wants when the question is "is this thing
// actually growing?" not "who sells stock data?".
//
// We deliberately do not name competing sellers anywhere in user-facing
// copy. Rank is enough.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { rankBy } from "./leaderboard.js";

const fmtUsd = (n) => {
  const v = Number(n) || 0;
  if (v >= 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
};

const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
const fmtPct = (n) => `${(Number(n) || 0).toFixed(1)}%`;

// Compute summary metrics off the ranked leaderboard array. Pure data
// transformation; no side effects, easy to test if we ever decide to.
// `sortMode` controls the lens — "usd" measures concentration of revenue,
// "calls" measures concentration of activity. Totals are sort-agnostic.
function summarize(rows, sortMode = "usd") {
  const total = rows.reduce((s, r) => s + (r.totalUsd || 0), 0);
  const totalCalls = rows.reduce((s, r) => s + (r.callsSettled || 0), 0);
  const activeSellers = rows.filter((r) => r.callsSettled > 0).length;
  const avgCallUsd = totalCalls > 0 ? total / totalCalls : 0;

  // HHI-style concentration in the *chosen* metric: when the page is showing
  // "top-10 sellers by calls", the top-N share answers "what % of all calls
  // do those top sellers serve?" — coherent with the displayed ranking. Same
  // when sortMode === "usd" (the original behaviour).
  const metric = sortMode === "calls" ? "callsSettled" : "totalUsd";
  const denom = sortMode === "calls" ? totalCalls : total;
  const sorted = [...rows].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  const sumTop = (n) => sorted.slice(0, n).reduce((s, r) => s + (r[metric] || 0), 0);
  const top1Share = denom > 0 ? (sumTop(1) / denom) * 100 : 0;
  const top5Share = denom > 0 ? (sumTop(5) / denom) * 100 : 0;
  const top10Share = denom > 0 ? (sumTop(10) / denom) * 100 : 0;

  // Network split — how much of the volume settles on each chain.
  const byNet = new Map();
  for (const r of rows) {
    const net = r.network || "unknown";
    byNet.set(net, (byNet.get(net) || 0) + (r.totalUsd || 0));
  }
  const networks = [...byNet.entries()]
    .map(([net, usd]) => ({ net, usd, share: total > 0 ? (usd / total) * 100 : 0 }))
    .sort((a, b) => b.usd - a.usd);

  // Find Agent402's row by canonical host so we can show "our share"
  // without naming anyone else. If we're not yet on the board (cold start)
  // this is null and the section just hides.
  const ourRow = rows.find(
    (r) => /agent402/i.test(r.homepage || "") || /agent402/i.test(r.name || "")
  );

  return {
    total,
    totalCalls,
    activeSellers,
    avgCallUsd,
    top1Share,
    top5Share,
    top10Share,
    networks,
    ourRow,
    top10: sorted.slice(0, 10),
  };
}

const ECON_CSS = `
  .ec-wrap { max-width:1180px; margin:0 auto; padding:56px 30px; }
  .ec-wrap h1 { font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 8px; }
  .ec-wrap h2 { font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em; }
  .crumb { font-family:var(--font-mono); font-size:.85rem; color:var(--faint); margin-bottom:18px; }
  .crumb a { color:var(--faint); text-decoration:none; }
  .crumb a:hover { color:var(--accent); }
  .sub { color:var(--muted); max-width:680px; line-height:1.6; }
  .sub a { color:var(--accent); }
  code { font-family:var(--font-mono); font-size:.85em; }
  .stat-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; margin:24px 0; }
  @media (min-width:680px) { .stat-grid { grid-template-columns:repeat(4,1fr); } }
  .stat { background:var(--card); border:1.5px solid var(--ink); padding:16px; }
  .stat .label { color:var(--faint); font-family:var(--font-mono); font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }
  .stat .val { font-size:1.6rem; font-family:var(--font-mono); color:var(--ink); margin-top:4px; }
  .stat .sub-text { color:var(--faint); font-size:.78rem; margin-top:4px; }
  .panel { background:var(--card); border:1.5px solid var(--ink); padding:18px 20px; margin:18px 0; }
  .panel h2 { font-size:1.1rem; margin:0 0 12px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--hairline); font-size:.92rem; }
  .row:last-child { border-bottom:none; }
  .row .rk { color:var(--faint); font-family:var(--font-mono); margin-right:8px; min-width:26px; display:inline-block; }
  .row .nm { color:var(--ink); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .val { color:var(--accent); font-family:var(--font-mono); }
  .bar { background:var(--ink); border-radius:0; height:8px; overflow:hidden; margin-top:4px; }
  .bar > div { background:var(--accent); height:100%; }
  .our-share { background:var(--card); border:1.5px solid var(--accent); }
  .meta { color:var(--faint); font-size:.82rem; margin-top:24px; }
  .meta a { color:var(--accent); }
  .warming { background:var(--card); border:1.5px solid var(--accent); color:var(--muted); padding:12px 16px; }
  .sort-toggle { display:inline-flex; gap:0; border:1.5px solid var(--ink); padding:3px; margin:0 0 18px; background:var(--card); }
  .sort-toggle a { padding:6px 14px; color:var(--faint); text-decoration:none; font-family:var(--font-mono); font-size:.85rem; transition:color .12s, background .12s; }
  .sort-toggle a:hover { color:var(--ink); }
  .sort-toggle a.active { background:var(--ink); color:var(--cream); }
`;

export function economyPage(baseUrl, snapshot, { sort } = {}) {
  const sortMode = sort === "calls" ? "calls" : "usd";
  // Both sort variants are views on the same page — canonicalize to the
  // default URL so we don't split SEO signal across ?sort= query params.
  const canonical = `${baseUrl}/economy`;
  const title = "x402 economy — daily volume, concentration, network split | Agent402";
  const description =
    "Daily report on the x402 pay-per-call API economy: total USDC volume settled across every public seller, call counts, top-5 and top-10 concentration, and per-chain breakdown. Computed hourly from on-chain Base USDC transfers and the Bazaar discovery index.";

  if (snapshot?.warming || !snapshot?.leaderboard?.length) {
    const warmBody = `<div class="ec-wrap">
        <div class="crumb"><a href="/">Agent402</a> / economy</div>
        <h1>x402 economy</h1>
        <div class="warming">Snapshot warming up. The leaderboard pipeline runs hourly and pre-warms on boot — refresh in a moment.</div>
      </div>
${ledgerFooterCompact()}`;

    return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", extraCss: ECON_CSS, body: warmBody });
  }

  const ranked = rankBy(snapshot.leaderboard, sortMode);
  const s = summarize(ranked, sortMode);
  const sortToggle = `<div class="sort-toggle" role="tablist" aria-label="Rank by">
    <a href="/economy" class="${sortMode === "usd" ? "active" : ""}"${sortMode === "usd" ? ' aria-current="page"' : ""}>USDC earned</a>
    <a href="/economy?sort=calls" class="${sortMode === "calls" ? "active" : ""}"${sortMode === "calls" ? ' aria-current="page"' : ""}>Total calls</a>
  </div>`;
  const windowLabel = snapshot.windowLabel || "24h";
  const asOf = snapshot.asOf || new Date().toISOString();

  const networkBars = s.networks
    .map(
      (n) => `<div class="row">
        <div><span class="nm">${esc(n.net)}</span></div>
        <div class="val">${fmtUsd(n.usd)} · ${fmtPct(n.share)}</div>
      </div>
      <div class="bar"><div style="width:${Math.max(2, Math.min(100, n.share))}%"></div></div>`
    )
    .join("");

  const topRows = s.top10
    .map(
      (r, i) => `<div class="row">
        <div><span class="rk">#${i + 1}</span><span class="nm">${esc(r.name || "Unnamed seller")}</span></div>
        <div class="val">${fmtUsd(r.totalUsd)} · ${fmtInt(r.callsSettled)} calls</div>
      </div>`
    )
    .join("");

  const ourShareBlock = s.ourRow
    ? `<div class="panel our-share">
        <h2>Agent402's share of the ${esc(windowLabel)} economy</h2>
        <div class="row">
          <div><span class="nm">Volume settled</span></div>
          <div class="val">${fmtUsd(s.ourRow.totalUsd)} · rank #${s.ourRow.rank}</div>
        </div>
        <div class="row">
          <div><span class="nm">Calls served</span></div>
          <div class="val">${fmtInt(s.ourRow.callsSettled)}</div>
        </div>
        <div class="row">
          <div><span class="nm">Share of total</span></div>
          <div class="val">${fmtPct((s.ourRow.totalUsd / Math.max(s.total, 1e-9)) * 100)}</div>
        </div>
      </div>`
    : "";

  const mainBody = `<div class="ec-wrap">
    <div class="crumb"><a href="/">Agent402</a> / economy</div>
    <h1>The x402 economy, last ${esc(windowLabel)}</h1>
    <p class="sub">Total per-call USDC settled across every public x402 seller our crawler can see, aggregated from on-chain transfers on Base. Sellers are discovered via the public Bazaar index; per-call settlements are filtered to a $0.50 ceiling so funding moves and swaps don't pollute the ranking. Refreshes hourly. Machine-readable: <a href="/api/leaderboard">/api/leaderboard</a>.</p>

    ${sortToggle}

    <div class="stat-grid">
      <div class="stat">
        <div class="label">Total volume</div>
        <div class="val">${fmtUsd(s.total)}</div>
        <div class="sub-text">across ${fmtInt(s.activeSellers)} active sellers</div>
      </div>
      <div class="stat">
        <div class="label">Total calls</div>
        <div class="val">${fmtInt(s.totalCalls)}</div>
        <div class="sub-text">avg ${fmtUsd(s.avgCallUsd)} per call</div>
      </div>
      <div class="stat">
        <div class="label">Top-5 share</div>
        <div class="val">${fmtPct(s.top5Share)}</div>
        <div class="sub-text">top-1 ${fmtPct(s.top1Share)} · top-10 ${fmtPct(s.top10Share)}</div>
      </div>
      <div class="stat">
        <div class="label">Networks</div>
        <div class="val">${s.networks.length}</div>
        <div class="sub-text">chains with volume</div>
      </div>
    </div>

    ${ourShareBlock}

    <div class="panel">
      <h2>Top 10 sellers by ${sortMode === "calls" ? "call count" : "volume"}</h2>
      ${topRows}
      <div class="meta">Full ranking: <a href="/leaderboard">/leaderboard</a></div>
    </div>

    <div class="panel">
      <h2>Volume by network</h2>
      ${networkBars}
    </div>

    <div class="meta">As of ${esc(asOf)} · window ${esc(windowLabel)} · ${fmtInt(snapshot.scannedBlocks || 0)} blocks scanned</div>
  </div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", extraCss: ECON_CSS, body: mainBody });
}
