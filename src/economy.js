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

import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
function summarize(rows) {
  const total = rows.reduce((s, r) => s + (r.totalUsd || 0), 0);
  const totalCalls = rows.reduce((s, r) => s + (r.callsSettled || 0), 0);
  const activeSellers = rows.filter((r) => r.callsSettled > 0).length;
  const avgCallUsd = totalCalls > 0 ? total / totalCalls : 0;

  // HHI-style concentration: the share of the top 1, top 5, top 10.
  const sorted = [...rows].sort((a, b) => (b.totalUsd || 0) - (a.totalUsd || 0));
  const sumTop = (n) =>
    sorted.slice(0, n).reduce((s, r) => s + (r.totalUsd || 0), 0);
  const top1Share = total > 0 ? (sumTop(1) / total) * 100 : 0;
  const top5Share = total > 0 ? (sumTop(5) / total) * 100 : 0;
  const top10Share = total > 0 ? (sumTop(10) / total) * 100 : 0;

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
  .stat-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; margin:24px 0; }
  @media (min-width:680px) { .stat-grid { grid-template-columns:repeat(4,1fr); } }
  .stat { background:var(--card); border:1px solid #1e2638; border-radius:12px; padding:16px; }
  .stat .label { color:var(--muted); font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }
  .stat .val { font-size:1.6rem; font-family:var(--mono); color:var(--text); margin-top:4px; }
  .stat .sub { color:var(--muted); font-size:.78rem; margin-top:4px; }
  .panel { background:var(--card); border:1px solid #1e2638; border-radius:12px; padding:18px 20px; margin:18px 0; }
  .panel h2 { font-size:1.1rem; margin:0 0 12px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px dashed #1e2638; font-size:.92rem; }
  .row:last-child { border-bottom:none; }
  .row .rk { color:var(--muted); font-family:var(--mono); margin-right:8px; min-width:26px; display:inline-block; }
  .row .nm { color:var(--text); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .val { color:var(--accent); font-family:var(--mono); }
  .bar { background:#10162a; border-radius:6px; height:8px; overflow:hidden; margin-top:4px; }
  .bar > div { background:var(--accent); height:100%; }
  .our-share { background:#10210f; border:1px solid #1f4a1d; }
  .meta { color:var(--muted); font-size:.82rem; margin-top:24px; }
  .warming { background:#2a1d10; border:1px solid #4a371d; color:#e0b27a; padding:12px 16px; border-radius:10px; }
`;

export function economyPage(baseUrl, snapshot) {
  const canonical = `${baseUrl}/economy`;
  const title = "x402 economy — daily volume, concentration, network split | Agent402";
  const description =
    "Daily report on the x402 pay-per-call API economy: total USDC volume settled across every public seller, call counts, top-5 and top-10 concentration, and per-chain breakdown. Computed hourly from on-chain Base USDC transfers and the Bazaar discovery index.";

  if (snapshot?.warming || !snapshot?.leaderboard?.length) {
    return baseHtml({
      title,
      description,
      canonical,
      body: `<div class="wrap">
        <div class="crumb"><a href="/">Agent402</a> / economy</div>
        <h1>x402 economy</h1>
        <div class="warming">Snapshot warming up. The leaderboard pipeline runs hourly and pre-warms on boot — refresh in a moment.</div>
      </div>`,
    });
  }

  const s = summarize(snapshot.leaderboard);
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

  const body = `<div class="wrap">
    <div class="crumb"><a href="/">Agent402</a> / economy</div>
    <h1>The x402 economy, last ${esc(windowLabel)}</h1>
    <p class="sub">Total per-call USDC settled across every public x402 seller our crawler can see, aggregated from on-chain transfers on Base. Sellers are discovered via the public Bazaar index; per-call settlements are filtered to a $0.50 ceiling so funding moves and swaps don't pollute the ranking. Refreshes hourly. Machine-readable: <a href="/api/leaderboard">/api/leaderboard</a>.</p>

    <div class="stat-grid">
      <div class="stat">
        <div class="label">Total volume</div>
        <div class="val">${fmtUsd(s.total)}</div>
        <div class="sub">across ${fmtInt(s.activeSellers)} active sellers</div>
      </div>
      <div class="stat">
        <div class="label">Total calls</div>
        <div class="val">${fmtInt(s.totalCalls)}</div>
        <div class="sub">avg ${fmtUsd(s.avgCallUsd)} per call</div>
      </div>
      <div class="stat">
        <div class="label">Top-5 share</div>
        <div class="val">${fmtPct(s.top5Share)}</div>
        <div class="sub">top-1 ${fmtPct(s.top1Share)} · top-10 ${fmtPct(s.top10Share)}</div>
      </div>
      <div class="stat">
        <div class="label">Networks</div>
        <div class="val">${s.networks.length}</div>
        <div class="sub">chains with volume</div>
      </div>
    </div>

    ${ourShareBlock}

    <div class="panel">
      <h2>Top 10 sellers by volume</h2>
      ${topRows}
      <div class="meta">Full ranking: <a href="/leaderboard">/leaderboard</a></div>
    </div>

    <div class="panel">
      <h2>Volume by network</h2>
      ${networkBars}
    </div>

    <div class="meta">As of ${esc(asOf)} · window ${esc(windowLabel)} · ${fmtInt(snapshot.scannedBlocks || 0)} blocks scanned</div>
  </div>`;

  return baseHtml({ title, description, canonical, body });
}

function baseHtml({ title, description, canonical, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${CHROME_HEAD_LINKS}
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="Agent402">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta name="twitter:card" content="summary">
<style>
  :root { --bg:#0b0e14; --card:#131826; --text:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:16px/1.6 system-ui,-apple-system,sans-serif; }
  .wrap { max-width:920px; margin:0 auto; padding:40px 20px 80px; }
  a { color:var(--accent); }
  h1 { font-size:1.9rem; line-height:1.2; margin-bottom:8px; }
  .crumb { font-size:.85rem; color:var(--muted); margin-bottom:18px; }
  .sub { color:var(--muted); max-width:680px; }
  code { font-family:var(--mono); font-size:.85em; color:#a5b4d4; }
  ${ECON_CSS}
  ${CHROME_CSS}
</style>
</head>
<body>
${renderHeader("/economy")}
${body}
${renderFooter()}
</body>
</html>`;
}
