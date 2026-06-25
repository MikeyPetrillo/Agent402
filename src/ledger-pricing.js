// Machine Ledger — Pricing page
// Two-plan split (FREE / PAID), price-by-category receipt table, "beat the
// token math" comparison card, CTA, compact footer.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable } from "./pow.js";

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

export function ledgerPricingPage(baseUrl, catalog) {
  const tools = toolList(catalog);
  const totalCount = tools.length;
  const freeCount = tools.filter(isComputePayable).length;

  const canonical = baseUrl + "/pricing";
  const title = `Pricing — Agent402 (${fmtNum(totalCount)} tools)`;
  const description = `Two ways to pay: free via proof-of-work or USDC on Base from $0.001/call. No subscription, no signup, no minimum. ${fmtNum(freeCount)} tools free, all ${fmtNum(totalCount)} tools from $0.001.`;

  // -- feature-list helpers --------------------------------------------------
  const check = (text) =>
    `<div style="display:flex;gap:9px;"><span style="color:var(--accent);font-family:var(--font-mono);font-weight:700;">\u2713</span> ${esc(text)}</div>`;
  const dim = (text) =>
    `<div style="display:flex;gap:9px;"><span style="color:var(--faint);font-family:var(--font-mono);font-weight:700;">\u00b7</span> <span style="color:var(--faint);">${esc(text)}</span></div>`;

  // -- price-by-category receipt rows ----------------------------------------
  const receiptRow = (label, price, isLast) =>
    `<div style="display:flex;align-items:baseline;gap:8px;padding:12px 18px;${isLast ? "" : "border-bottom:1px solid var(--hairline);"}"><span>${esc(label)}</span><span style="flex:1;border-bottom:1.5px dotted #b3a98f;transform:translateY(-4px);"></span><span style="font-weight:700;color:var(--accent);">${esc(price)}</span></div>`;

  const receiptRows = [
    ["Most tools \u2014 text, math, encoding, time, validation, convert", "$0.001"],
    ["Agent memory \u2014 write, recall, grant, audit", "$0.002"],
    ["Payments & x402 \u2014 decode, verify, settle", "$0.002"],
    ["Article extract \u2014 clean markdown out", "$0.004"],
    ["Headless browser \u2014 render & screenshot (real Chromium)", "$0.02"],
  ];

  const extraCss = `
@media (max-width: 900px) {
  .ml-pricing-plans { grid-template-columns: 1fr !important; }
  .ml-pricing-plans > div:first-child { border-right: none !important; border-bottom: 1.5px solid var(--ink) !important; }
  .ml-token-math { grid-template-columns: 1fr !important; }
  .ml-token-math > div:last-child { border-left: none !important; border-top: 1px dashed #b3a98f !important; padding-left: 0 !important; padding-top: 24px !important; }
}
`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Agent402 Pricing",
    url: canonical,
    description,
    isPartOf: { "@type": "WebSite", name: "Agent402.Tools", url: baseUrl + "/" },
  };

  const body = `
  <!-- HEAD -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:14px;">$ GET /pricing</div>
    <h1 style="font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;">Two ways to pay.<br>No subscription, ever.</h1>
    <p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:600px;margin:0;">Pay in compute with a proof-of-work puzzle, or settle micro-amounts of USDC on Base per call. No card, no signup, no minimum, no monthly fee. The wallet is the identity.</p>
  </section>

  <!-- TWO PLANS -->
  <section style="max-width:1180px;margin:0 auto;padding:0 30px;">
    <div class="ml-pricing-plans" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1.5px solid var(--ink);">
      <!-- FREE -->
      <div style="padding:30px;border-right:1.5px solid var(--ink);background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--muted);letter-spacing:.08em;margin-bottom:12px;">FREE \u00b7 PROOF-OF-WORK</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px;">
          <span style="font-family:var(--font-body);font-weight:900;font-size:56px;letter-spacing:-.03em;">$0.00</span>
          <span style="font-family:var(--font-mono);font-size:13px;color:var(--faint);">/ call</span>
        </div>
        <p style="font-size:14.5px;line-height:1.5;color:var(--muted);margin:0 0 20px;">Solve a short sha256 puzzle \u2014 a few seconds of CPU \u2014 instead of paying. No wallet at all.</p>
        <div style="display:flex;flex-direction:column;gap:10px;font-size:14px;border-top:1px solid var(--hairline);padding-top:18px;">
          ${check(`${fmtNum(freeCount)} pure-CPU tools`)}
          ${check("No wallet, no funds, no account")}
          ${check("Hosted MCP connector runs these free")}
          ${dim("Rate-limited; browser/GPU tools excluded")}
        </div>
      </div>
      <!-- USDC -->
      <div style="padding:30px;background:var(--ink);position:relative;">
        <div style="position:absolute;top:14px;right:18px;font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;color:var(--accent);border:1.5px solid var(--accent);padding:3px 8px;">x402</div>
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--dk-muted);letter-spacing:.08em;margin-bottom:12px;">PAID \u00b7 USDC ON BASE</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px;">
          <span style="font-family:var(--font-body);font-weight:900;font-size:56px;letter-spacing:-.03em;color:var(--card);">$0.001</span>
          <span style="font-family:var(--font-mono);font-size:13px;color:var(--dk-muted);">/ call &amp; up</span>
        </div>
        <p style="font-size:14.5px;line-height:1.5;color:var(--dk-muted2);margin:0 0 20px;">An x402 client signs USDC from the agent's own wallet and retries. Settles on Base in seconds.</p>
        <div style="display:flex;flex-direction:column;gap:10px;font-size:14px;color:var(--cream);border-top:1px solid var(--dark-border2);padding-top:18px;">
          ${check(`All ${fmtNum(totalCount)} tools, including browser & memory`)}
          ${check("Flat per-call price \u2014 pay exactly what you use")}
          ${check("Non-custodial \u2014 Agent402 never holds funds")}
          ${check("Spend caps refuse a runaway model before paying")}
        </div>
      </div>
    </div>
  </section>

  <!-- PRICE BY CATEGORY -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">// from-price by category</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 22px;">What each call costs.</h2>
    <div style="border:1.5px solid var(--ink);background:var(--card);font-family:var(--font-mono);font-size:14px;">
      ${receiptRows.map((r, i) => receiptRow(r[0], r[1], i === receiptRows.length - 1)).join("\n      ")}
    </div>
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:12px;">live machine-readable prices: GET /api/pricing \u00b7 GET /openapi.json</div>
  </section>

  <!-- TOKEN MATH NOTE -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <div class="ml-token-math" style="border:1.5px solid var(--ink);background:var(--card);padding:28px 30px;display:grid;grid-template-columns:1fr 1fr;gap:30px;">
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--accent);letter-spacing:.1em;margin-bottom:10px;">WHY IT'S CHEAP</div>
        <h3 style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 8px;">Beat the token math.</h3>
        <p style="font-size:14.5px;line-height:1.55;color:var(--muted);margin:0;">Writing, testing and debugging a CSV parser or cron calculator mid-task burns thousands of tokens \u2014 easily 10\u2013100\u00d7 the price of a tested $0.001 call. Reimplementation is the expensive path.</p>
      </div>
      <div style="border-left:1px dashed #b3a98f;padding-left:30px;display:flex;flex-direction:column;justify-content:center;font-family:var(--font-mono);font-size:14px;">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px;"><span style="color:var(--muted);">build it yourself</span><span style="flex:1;border-bottom:1.5px dotted #b3a98f;transform:translateY(-4px);"></span><span style="font-weight:700;">~5,000 tokens</span></div>
        <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">call the tested endpoint</span><span style="flex:1;border-bottom:1.5px dotted #b3a98f;transform:translateY(-4px);"></span><span style="font-weight:700;color:var(--accent);">$0.001</span></div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 64px;">
    <div style="border:1.5px solid var(--ink);background:var(--ink);padding:32px 30px;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:28px;line-height:1;letter-spacing:-.02em;margin:0;color:var(--card);">Start on the free tier. No wallet.</h2>
      <div style="display:flex;gap:11px;">
        <a href="/docs" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 20px;">QUICKSTART \u2192</a>
        <a href="/tools" style="background:transparent;border:1.5px solid #4a4738;color:var(--cream);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;">BROWSE TOOLS</a>
      </div>
    </div>
  </section>

${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/pricing",
    jsonLd,
    extraCss,
    body,
  });
}
