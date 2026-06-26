import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable } from "./pow.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parsePrice(priceStr) {
  const m = String(priceStr).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : 0;
}

export function pricingPage(baseUrl, catalog) {
  const tools = toolList(catalog);
  const totalTools = tools.length;

  /* --- category breakdown --- */
  const byCategory = {};
  for (const t of tools) {
    const cat = t.category || "other";
    if (!byCategory[cat]) byCategory[cat] = { tools: [], freeCount: 0, prices: [] };
    byCategory[cat].tools.push(t);
    const p = parsePrice(t.price);
    byCategory[cat].prices.push(p);
    if (isComputePayable(t)) byCategory[cat].freeCount++;
  }

  const allPrices = tools.map(t => parsePrice(t.price)).filter(p => p > 0);
  const globalLow = allPrices.length ? Math.min(...allPrices) : 0;
  const globalHigh = allPrices.length ? Math.max(...allPrices) : 0;
  const totalFree = tools.filter(t => isComputePayable(t)).length;

  const categoryRows = Object.keys(CATEGORIES)
    .filter(k => byCategory[k])
    .map(k => {
      const c = byCategory[k];
      const paid = c.prices.filter(p => p > 0);
      const lo = paid.length ? Math.min(...paid) : 0;
      const hi = paid.length ? Math.max(...paid) : 0;
      const range = lo === hi
        ? (lo === 0 ? "free" : `$${lo}`)
        : `$${lo}\u2013$${hi}`;
      return `<tr>
        <td><a href="/tools#${esc(k)}">${esc(CATEGORIES[k]?.label || k)}</a></td>
        <td>${c.tools.length}</td>
        <td class="mono">${range}</td>
        <td>${c.freeCount}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pricing - Agent402</title>
<meta name="description" content="Flat per-call pricing for ${totalTools} deterministic web tools. Pay in USDC on Base, Solana, Polygon & Arbitrum via x402, or use proof-of-work for free.">
<link rel="canonical" href="${baseUrl}/pricing">
<meta property="og:type" content="website">
<meta property="og:url" content="${baseUrl}/pricing">
<meta property="og:site_name" content="Agent402.Tools">
<meta property="og:title" content="Pricing — Agent402">
<meta property="og:description" content="Flat per-call pricing for ${totalTools} deterministic web tools. No tiers, no subscriptions.">
<meta name="twitter:card" content="summary">
${CHROME_HEAD_LINKS}
<style>
${CHROME_CSS}
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;line-height:1.6}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.crumb{max-width:960px;margin:0 auto;padding:1rem 1.5rem;font-size:.85rem;color:var(--muted)}
.crumb a{color:var(--muted)}
.wrap{max-width:960px;margin:0 auto;padding:0 1.5rem 4rem}

/* hero */
.hero{text-align:center;padding:3rem 0 2.5rem}
.hero h1{font-size:2rem;font-weight:700;line-height:1.2;margin-bottom:1rem}
.hero p{color:var(--muted);max-width:600px;margin:0 auto;font-size:1.05rem}

/* tier cards */
.tiers{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin:2.5rem 0}
@media(max-width:640px){.tiers{grid-template-columns:1fr}}
.tier{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:2rem;position:relative}
.tier h2{font-size:1.25rem;margin-bottom:.5rem}
.tier .price{font-size:2rem;font-weight:700;color:var(--accent);margin-bottom:.75rem}
.tier ul{list-style:none;color:var(--muted);font-size:.95rem}
.tier ul li{padding:.25rem 0}
.tier ul li::before{content:"\u2713 ";color:var(--accent)}
.badge{display:inline-block;font-size:.7rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:var(--accent);color:var(--bg);padding:2px 8px;border-radius:4px;vertical-align:middle;margin-left:.5rem}

/* category table */
.cat-section{margin:3rem 0}
.cat-section h2{font-size:1.4rem;margin-bottom:1rem}
table{width:100%;border-collapse:collapse;font-size:.95rem}
th{text-align:left;color:var(--muted);font-weight:600;padding:.6rem .75rem;border-bottom:1px solid rgba(255,255,255,.08)}
td{padding:.6rem .75rem;border-bottom:1px solid rgba(255,255,255,.04)}
td a{color:var(--accent)}
.mono{font-family:var(--mono);font-size:.85rem}
tr:hover td{background:rgba(255,255,255,.02)}

/* how it works */
.how{margin:3rem 0}
.how h2{font-size:1.4rem;margin-bottom:1.25rem}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:1.25rem}
@media(max-width:640px){.steps{grid-template-columns:1fr}}
.step{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.5rem}
.step .num{font-size:1.5rem;font-weight:700;color:var(--accent);margin-bottom:.5rem}
.step h3{font-size:1rem;margin-bottom:.4rem}
.step p{color:var(--muted);font-size:.9rem}

/* links */
.links{margin:3rem 0}
.links h2{font-size:1.2rem;margin-bottom:.75rem}
.links ul{list-style:none;font-size:.95rem}
.links ul li{padding:.3rem 0}
.links ul li::before{content:"\u2192 ";color:var(--accent)}
</style>
<script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "WebPage",
  "name": "Agent402 Pricing",
  "url": `${baseUrl}/pricing`,
  "description": `Flat per-call pricing for ${totalTools} deterministic web tools.`,
  "offers": {
    "@type": "AggregateOffer",
    "priceCurrency": "USD",
    "lowPrice": globalLow,
    "highPrice": globalHigh,
    "offerCount": totalTools
  }
})}
</script>
</head>
<body>
${renderHeader("/pricing")}
<div class="crumb"><a href="/">Agent402</a> / pricing</div>
<div class="wrap">

<div class="hero">
  <h1>Flat per-call pricing, no tiers, no subscriptions</h1>
  <p>Every tool has a flat price. Pay per call in USDC on Base, Solana, Polygon, or Arbitrum via the x402 protocol. No accounts, no API keys, no monthly bills.</p>
</div>

<div class="tiers">
  <div class="tier">
    <h2>Free Tier <span class="badge">FREE</span></h2>
    <div class="price">$0</div>
    <ul>
      <li>Solve a sub-second sha256 puzzle</li>
      <li>No wallet needed</li>
      <li>Available on all pure-CPU tools</li>
      <li>${totalFree} tools eligible</li>
    </ul>
  </div>
  <div class="tier">
    <h2>USDC Tier (x402)</h2>
    <div class="price">$${globalLow}\u2013$${globalHigh}/call</div>
    <ul>
      <li>Pay from your agent's own wallet</li>
      <li>Settles on Base in seconds</li>
      <li>Gas sponsored by facilitator</li>
      <li>All ${totalTools} tools available</li>
    </ul>
  </div>
</div>

<div class="cat-section">
  <h2>Pricing by category</h2>
  <table>
    <thead>
      <tr><th>Category</th><th>Tools</th><th>Price range</th><th>Free (PoW)</th></tr>
    </thead>
    <tbody>
      ${categoryRows}
    </tbody>
  </table>
</div>

<div class="how">
  <h2>How payment works</h2>
  <div class="steps">
    <div class="step">
      <div class="num">1</div>
      <h3>Call endpoint</h3>
      <p>Send a request to any tool endpoint. If payment is required, you get back HTTP 402 with the price and payment details.</p>
    </div>
    <div class="step">
      <div class="num">2</div>
      <h3>Sign and retry</h3>
      <p>Your x402 client signs a USDC payment from your agent's wallet and retries the request with the payment header.</p>
    </div>
    <div class="step">
      <div class="num">3</div>
      <h3>Settle and respond</h3>
      <p>Payment settles on Base, the tool executes, and the response comes back. The whole flow takes seconds.</p>
    </div>
  </div>
</div>

<div class="links">
  <h2>Machine-readable pricing</h2>
  <ul>
    <li><a href="/api/pricing">/api/pricing</a> \u2014 full pricing as JSON</li>
    <li><a href="/openapi.json">/openapi.json</a> \u2014 OpenAPI spec with all tool schemas</li>
    <li><a href="/llms.txt">/llms.txt</a> \u2014 LLM-optimized tool listing</li>
  </ul>
</div>

</div>
${renderFooter()}
</body>
</html>`;
}
