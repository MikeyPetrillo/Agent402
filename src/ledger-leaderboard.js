// Machine Ledger — Leaderboard page
// Full ranked table of x402 sellers by on-chain USDC settlement volume.
// Reads the cached leaderboard snapshot and renders the design-system chrome
// with LIVE pulse, totals strip, dark ranked table, methodology, and CTA.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

const fmtUsd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

const shortAddr = (a) =>
  typeof a === "string" && a.length > 12
    ? `${a.slice(0, 6)}\u2026${a.slice(-4)}`
    : a || "\u2014";

/** Only allow http(s) — seller-supplied homepage data, defense in depth. */
const safeHref = (u) =>
  typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ledgerLeaderboardPage(baseUrl, snapshot) {
  const board = Array.isArray(snapshot?.leaderboard)
    ? snapshot.leaderboard
    : [];
  const hasData = board.length > 0;

  // Aggregate totals
  const totalUsd = board.reduce((s, r) => s + (Number(r.totalUsd) || 0), 0);
  const totalCalls = board.reduce(
    (s, r) => s + (Number(r.callsSettled) || 0),
    0,
  );
  const totalBuyers = board.reduce(
    (s, r) => s + (Number(r.uniqueBuyers) || 0),
    0,
  );
  const scannedSellers = snapshot?.scannedSellers ?? 0;

  // --- Ranked table rows ---------------------------------------------------

  const tableRows = board
    .map((r) => {
      const rank = String(r.rank ?? "").padStart(2, "0");
      const isFirst = rank === "01";
      const href = safeHref(r.homepage);
      const nameHtml = href
        ? `<a href="${esc(href)}" target="_blank" rel="noopener nofollow" style="color:var(--cream);text-decoration:none;border-bottom:1px solid transparent;">${esc(r.name)}</a>`
        : esc(r.name);

      // Pick the primary wallet for display
      const allWallets =
        Array.isArray(r.wallets) && r.wallets.length
          ? r.wallets
          : r.wallet
            ? [r.wallet]
            : [];
      const displayWallet = allWallets[0] || "";

      const rowBg = isFirst
        ? " background: linear-gradient(90deg, #d63c1a22, transparent);"
        : "";
      const rankColor = isFirst ? "var(--accent)" : "#7c7768";
      const borderBottom =
        r === board[board.length - 1]
          ? ""
          : " border-bottom: 1px solid #2a2920;";

      return `<div style="display: grid; grid-template-columns: 36px 1fr 110px 90px 64px; gap: 12px; padding: 13px 20px; color: #ECE4D2;${borderBottom}${rowBg}"><span style="color: ${rankColor}; font-weight: 700;">${esc(rank)}</span><span>${nameHtml} <span style="color:#7c7768;">\u00b7 ${esc(shortAddr(displayWallet))}</span></span><span style="text-align: right; color: #F4EEDE; font-weight: 700;">${fmtUsd(r.totalUsd)}</span><span style="text-align: right;">${fmtNum(r.callsSettled)}</span><span style="text-align: right; color: #b9b1a0;">${fmtNum(r.uniqueBuyers)}</span></div>`;
    })
    .join("\n      ");

  // --- Empty / warming state -----------------------------------------------

  const warmingHtml = `<div style="padding: 40px 20px; text-align: center; color: #7c7768; font-family: var(--font-mono); font-size: 13px;">Warming up \u2014 first snapshot in progress. Refresh in a few seconds.</div>`;

  // --- Page body -----------------------------------------------------------

  const body = `
  <!-- HEAD -->
  <section style="max-width: 1180px; margin: 0 auto; padding: 56px 30px 30px;">
    <div style="display: flex; align-items: center; gap: 12px; font-family: var(--font-mono); font-size: 13px; color: var(--accent); margin-bottom: 14px;"><span>$ GET /api/leaderboard</span><span style="display: flex; align-items: center; gap: 6px; color: var(--ink);"><span style="width: 6px; height: 6px; border-radius: 50%; background: var(--accent); display: inline-block; animation: ml-pulse 1.8s ease-in-out infinite;"></span>LIVE</span></div>
    <h1 class="lb-h1" style="font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 58px; line-height: .96; letter-spacing: -.03em; margin: 0 0 14px;">Ranked by real<br>on-chain USDC.</h1>
    <p style="font-size: 17px; line-height: 1.55; color: var(--muted); max-width: 620px; margin: 0;">Not vanity metrics \u2014 settled Base USDC volume, read straight off the chain. The pipeline walks every page of the Coinbase CDP Bazaar and aggregates per-call settlements for each seller\u2019s payTo. Hourly snapshot, free to query.</p>
  </section>

  <!-- TOTALS (light receipt strip) -->
  <section style="max-width: 1180px; margin: 0 auto; padding: 0 30px 30px;">
    <div class="lb-totals" style="display: grid; grid-template-columns: repeat(4, 1fr); border: 1.5px solid var(--ink); background: var(--card);">
      <div style="padding: 20px 22px; border-right: 1.5px solid var(--ink);"><div style="font-family: var(--font-mono); font-size: 28px; font-weight: 700; color: var(--accent);">${fmtUsd(totalUsd)}</div><div style="font-family: var(--font-mono); font-size: 12px; color: var(--faint); margin-top: 4px;">total settled</div></div>
      <div style="padding: 20px 22px; border-right: 1.5px solid var(--ink);"><div style="font-family: var(--font-mono); font-size: 28px; font-weight: 700; color: var(--ink);">${fmtNum(totalCalls)}</div><div style="font-family: var(--font-mono); font-size: 12px; color: var(--faint); margin-top: 4px;">calls served</div></div>
      <div style="padding: 20px 22px; border-right: 1.5px solid var(--ink);"><div style="font-family: var(--font-mono); font-size: 28px; font-weight: 700; color: var(--ink);">${fmtNum(totalBuyers)}</div><div style="font-family: var(--font-mono); font-size: 12px; color: var(--faint); margin-top: 4px;">unique buyers</div></div>
      <div style="padding: 20px 22px;"><div style="font-family: var(--font-mono); font-size: 28px; font-weight: 700; color: var(--ink);">${fmtNum(scannedSellers)}</div><div style="font-family: var(--font-mono); font-size: 12px; color: var(--faint); margin-top: 4px;">x402 sellers tracked</div></div>
    </div>
  </section>

  <!-- FULL TABLE (dark printout) -->
  <section style="max-width: 1180px; margin: 0 auto; padding: 0 30px;">
    <div style="border: 1.5px solid var(--ink); background: var(--ink); font-family: var(--font-mono); font-size: 13px;">
      <div style="display: grid; grid-template-columns: 36px 1fr 110px 90px 64px; gap: 12px; padding: 12px 20px; color: var(--dk-muted3); border-bottom: 1px solid var(--dark-border);"><span>#</span><span>seller \u00b7 payTo</span><span style="text-align: right;">usdc settled</span><span style="text-align: right;">calls</span><span style="text-align: right;">buyers</span></div>
      ${hasData ? tableRows : warmingHtml}
    </div>
    <div style="font-family: var(--font-mono); font-size: 12px; color: var(--faint); margin-top: 12px;">live values from GET /api/leaderboard \u00b7 ?include=external to exclude Agent402</div>
  </section>

  <!-- METHODOLOGY (light framed) -->
  <section style="max-width: 1180px; margin: 0 auto; padding: 56px 30px 0;">
    <div style="font-family: var(--font-mono); font-size: 13px; color: var(--accent); margin-bottom: 12px;">// methodology</div>
    <h2 style="font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 34px; line-height: 1; letter-spacing: -.02em; margin: 0 0 22px;">How the ranking is computed.</h2>
    <div class="lb-method" style="border: 1.5px solid var(--ink); background: var(--card); display: grid; grid-template-columns: repeat(4, 1fr);">
      <div style="padding: 20px; border-right: 1.5px solid var(--ink);"><div style="font-family: var(--font-mono); color: var(--accent); font-weight: 700; font-size: 18px; margin-bottom: 8px;">01</div><div style="font-size: 13.5px; line-height: 1.5; color: var(--muted);">Walk every page of the Coinbase CDP Bazaar discovery API.</div></div>
      <div style="padding: 20px; border-right: 1.5px solid var(--ink);"><div style="font-family: var(--font-mono); color: var(--accent); font-weight: 700; font-size: 18px; margin-bottom: 8px;">02</div><div style="font-size: 13.5px; line-height: 1.5; color: var(--muted);">Query eth_getLogs on Base USDC for each seller\u2019s payTo address.</div></div>
      <div style="padding: 20px; border-right: 1.5px solid var(--ink);"><div style="font-family: var(--font-mono); color: var(--accent); font-weight: 700; font-size: 18px; margin-bottom: 8px;">03</div><div style="font-size: 13.5px; line-height: 1.5; color: var(--muted);">Filter per-call settlements under a $0.50 ceiling \u2014 larger inbound is funding, not buys.</div></div>
      <div style="padding: 20px;"><div style="font-family: var(--font-mono); color: var(--accent); font-weight: 700; font-size: 18px; margin-bottom: 8px;">04</div><div style="font-size: 13.5px; line-height: 1.5; color: var(--muted);">Aggregate calls, totalUsd and unique buyers per seller. Hourly snapshot.</div></div>
    </div>
  </section>

  <!-- CTA -->
  <section style="max-width: 1180px; margin: 0 auto; padding: 56px 30px 64px;">
    <div class="lb-cta-wrap" style="border: 1.5px solid var(--ink); background: var(--ink); padding: 32px 30px; display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap;">
      <div>
        <h2 style="font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 28px; line-height: 1; letter-spacing: -.02em; margin: 0 0 6px; color: var(--cream2);">Route across every x402 seller.</h2>
        <p style="font-family: var(--font-mono); font-size: 13px; color: var(--dk-muted); margin: 0;">the neutral Smart Order Router \u2014 not just ours</p>
      </div>
      <div style="display: flex; gap: 11px;">
        <a href="/api/route" style="background: var(--accent); color: #fff; font-family: var(--font-mono); font-weight: 700; font-size: 14px; text-decoration: none; padding: 13px 20px;">/api/route \u2192</a>
        <a href="/docs" style="background: transparent; border: 1.5px solid #4a4738; color: var(--cream); font-family: var(--font-mono); font-weight: 700; font-size: 14px; text-decoration: none; padding: 12px 20px;">READ THE DOCS</a>
      </div>
    </div>
  </section>

  ${ledgerFooterCompact()}`;

  const canonical = baseUrl + "/leaderboard";
  const title = "x402 Leaderboard \u2014 Agent402";
  const description =
    "Public on-chain ranking of every x402 seller by Base USDC settled volume \u2014 calls, totalUsd, uniqueBuyers per seller. Hourly snapshot, free to query.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    url: canonical,
    description,
    isPartOf: { "@type": "WebSite", name: "Agent402", url: baseUrl },
  };

  const extraCss = `
@media (max-width: 900px) {
  .lb-totals { grid-template-columns: repeat(2, 1fr) !important; }
  .lb-method { grid-template-columns: repeat(2, 1fr) !important; }
}
@media (max-width: 600px) {
  .lb-totals { grid-template-columns: 1fr !important; }
  .lb-method { grid-template-columns: 1fr !important; }
  .lb-h1 { font-size: 40px !important; }
  .lb-cta-wrap { flex-direction: column !important; align-items: flex-start !important; }
}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/leaderboard",
    jsonLd,
    extraCss,
    body,
  });
}
