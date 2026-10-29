// Machine Ledger — Catalog page (/tools), Aug 2026 revamp.
// Tab strip (Tools / Skill packs / Playground / Pricing / Integrations),
// live search, "browse by category" table with a real cpu/usdc/mixed
// pays-with column, free-tier + paid-tools explainer, closing CTA.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable, powCostPhrase } from "./pow.js";

import { ORG_SAME_AS } from "./repo-link.js";
const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

const TABS = [
  ["Tools", "/tools"],
  ["Skill packs", "/skills"],
  ["Playground", "/playground"],
  ["Pricing", "/pricing"],
  ["Integrations", "/integrations"],
];

export function ledgerCatalogPage(baseUrl, catalog, skillPacks) {
  const tools = toolList(catalog);
  const count = tools.length;
  const freeCount = tools.filter(isComputePayable).length;
  // The cheapest price the catalog charges, read from the catalog (the stat
  // strip and the paid-tools copy must not carry a typed floor).
  const floorUsd = (() => {
    const nums = tools.map((t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, ""))).filter((n) => Number.isFinite(n) && n > 0);
    return nums.length ? Math.min(...nums) : 0;
  })();
  const floorLabel = floorUsd ? String(floorUsd) : "-";
  const packCount = Array.isArray(skillPacks) ? skillPacks.length : 42;

  // ---- category data, with a REAL per-category "pays with" derivation ----
  // Categories are not homogeneous: real data shows several (crypto, data,
  // payments, skill-pack, time, validation, web, api) mix free and paid
  // tools. A hardcoded per-category CPU/USDC guess would misrepresent that -
  // e.g. "time" is 9 free + 1 paid, not purely free. Derived here from
  // isComputePayable() per tool, the same source src/ledger-home.js already
  // uses for the sitewide free-tier count, so it can't drift into a second,
  // competing classification.
  const catEntries = Object.entries(CATEGORIES);
  const catData = catEntries.map(([key, { label, blurb }]) => {
    const inCat = tools.filter((t) => t.category === key);
    if (!inCat.length) return null;
    const cpuCount = inCat.filter(isComputePayable).length;
    const pays = cpuCount === inCat.length ? "cpu" : cpuCount === 0 ? "usdc" : "mixed";
    const payColor = pays === "cpu" ? "var(--ok)" : pays === "usdc" ? "var(--accent)" : "var(--muted)";
    const payLabel = pays === "mixed" ? "cpu + usdc" : pays;
    return { key, label, blurb, count: inCat.length, href: key === "skill-pack" ? "/skills" : `/tools/category/${key}`, pays, payLabel, payColor };
  }).filter(Boolean);

  // ---- SEO ----
  const canonical = baseUrl + "/tools";
  const title = `${fmtNum(count)} pay-per-call tools for AI agents - Agent402 Tools`;
  const description = `${fmtNum(count)} tools an AI agent can call and pay for per request in USDC. ${fmtNum(freeCount)} run free on proof-of-work. No signup, no API keys. Browse by category, or describe a task and let the router resolve it.`;

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, sameAs: ORG_SAME_AS };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Our tools", item: canonical },
  ] };
  const pageLd = { "@type": "CollectionPage", "@id": `${canonical}#page`, name: "Agent402 Tools", url: canonical, description, isPartOf: { "@id": `${baseUrl}/#organization` }, mainEntity: { "@id": `${canonical}#categories` } };
  const listLd = { "@type": "ItemList", "@id": `${canonical}#categories`, name: "Tool categories", itemListOrder: "https://schema.org/ItemListUnordered", itemListElement: catData.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.label, url: `${baseUrl}${c.href}` })) };
  const appLd = { "@type": "SoftwareApplication", "@id": `${canonical}#app`, name: "Agent402 Tools", applicationCategory: "DeveloperApplication", operatingSystem: "HTTP, MCP (streamable HTTP)", offers: { "@type": "AggregateOffer", offerCount: String(count), lowPrice: "0.001", highPrice: "1.50", priceCurrency: "USD", description: "Per-call micropayments in USDC, or free via single-use sha256 proof-of-work on pure-CPU tools" } };

  const extraCss = `
.cat-scroll{overflow-x:auto}
.cat-scroll table{min-width:780px}
table{border-collapse:collapse;width:100%}
/* A phone reads each category as a card: its name and tool count on one line, the blurb under them, then
   how it is paid. Sideways scrolling hid the blurb, which is the part that says what is in the category. */
@media (max-width:600px){
.cat-scroll table{min-width:0}
.cat-scroll table,.cat-scroll tbody{display:block}
.cat-scroll thead{display:none}
.cat-row{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;padding:14px 16px}
.cat-row>th,.cat-row>td{display:block;padding:0!important;text-align:left!important;min-width:0}
.cat-row>th{grid-column:1/-1}
.cat-row>td:nth-child(3){grid-column:2;grid-row:3;text-align:right!important;white-space:nowrap;margin-top:6px}
.cat-row>td:nth-child(3)::after{content:" tools"}
.cat-row>.cat-blurb{grid-column:1/-1;margin-top:4px}
.cat-row>td:nth-child(4){grid-column:1;grid-row:3;margin-top:6px}
}
@media (max-width:900px){.cat-2col{grid-template-columns:minmax(0,1fr)!important}}
.cat-search-wrap{border:1px solid var(--hairline)}
.cat-search-wrap:focus-within{border-color:var(--accent)}
`;

  const tabsHtml = TABS.map(([label, href]) =>
    href === "/tools"
      ? `<span style="padding:13px 16px;color:var(--ink);font-weight:700;border-bottom:2px solid var(--accent);white-space:nowrap;">${esc(label)}</span>`
      : `<a href="${href}" style="padding:13px 16px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap;">${esc(label)}</a>`
  ).join("") + `<a href="/marketplace/tools" style="padding:13px 16px;color:var(--faint);text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap;">All indexed tools ↗</a>`;

  const catRowsHtml = catData.map((c) =>
    `<tr class="cat-row" data-cat="${esc(c.key)}" style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:14px 18px;color:var(--ink);font-size:var(--fs-base);"><a href="${esc(c.href)}" style="color:var(--ink);text-decoration:none;">${esc(c.label)}</a></th><td class="cat-blurb" style="padding:14px 18px;color:var(--muted);font-size:var(--fs-md);line-height:1.5;">${esc(c.blurb)}</td><td style="padding:14px 18px;text-align:right;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--muted);font-variant-numeric:tabular-nums;">${fmtNum(c.count)}</td><td style="padding:14px 18px;text-align:right;font-family:var(--font-mono);font-size:var(--fs-xs);white-space:nowrap;"><span style="color:${c.payColor};">${esc(c.payLabel)}</span></td></tr>`
  ).join("");

  const body = `
<div style="border-bottom:1px solid var(--hairline);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:0 30px;display:flex;gap:0;overflow-x:auto;font-family:var(--font-mono);font-size:var(--fs-sm);">${tabsHtml}</div>
</div>

<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:36px 30px 34px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-bottom:18px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">our tools</span>
    </nav>
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:1;margin:0 0 12px;color:var(--ink);">Our tools</h1>
    <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);margin:0;max-width:76ch;">${fmtNum(count)} tools an agent can call and pay for per request. ${fmtNum(freeCount)} of them run free on proof-of-work. These are <em style="color:var(--ink);font-style:normal;font-weight:500;">our own</em> tools; for every tool in the index, ours and other sellers', see <a href="/marketplace/tools" style="color:var(--ink);border-bottom:1px solid var(--accent);text-decoration:none;">all indexed tools</a>.</p>

    <div class="cat-search-wrap" style="display:flex;gap:0;background:var(--card);max-width:760px;margin:22px 0 0;">
      <label for="cat-search" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);">Search tools</label>
      <span style="font-family:var(--font-mono);color:var(--accent);padding:0 12px;display:flex;align-items:center;font-weight:700;">⌕</span>
      <input id="cat-search" type="text" placeholder="Describe a task: decode a JWT, OCR an image, verify a settlement…" style="flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--ink);font-family:var(--font-mono);font-size:var(--fs-md);padding:15px 0;" aria-label="Describe a task: decode a JWT, OCR an image, verify a settlement…">
    </div>
    <p style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin:11px 0 0;">Searches every tool as you type - same free <span style="color:var(--muted);white-space:nowrap;">GET /api/find</span> agents call, no wallet.</p>
    <div id="cat-results" style="display:none;max-width:760px;margin:14px 0 0;border:1px solid var(--hairline);background:var(--card);"></div>

    <div style="display:flex;flex-wrap:wrap;margin-top:30px;border-top:1px dashed var(--dash);">
      <div style="flex:1 1 140px;padding:16px 20px 16px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:var(--fs-xl);line-height:1;font-variant-numeric:tabular-nums;">${fmtNum(count)}</div><div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;white-space:nowrap;">tools</div></div>
      <div style="flex:1 1 140px;padding:16px 20px 16px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:var(--fs-xl);line-height:1;font-variant-numeric:tabular-nums;color:var(--ok);">${fmtNum(freeCount)}</div><div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;white-space:nowrap;">free · proof-of-work</div></div>
      <div style="flex:1 1 140px;padding:16px 20px 16px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:var(--fs-xl);line-height:1;font-variant-numeric:tabular-nums;"><span style="color:var(--accent);">$</span>${esc(floorLabel)}</div><div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;white-space:nowrap;">floor price</div></div>
      <div style="flex:1 1 140px;padding:16px 20px 16px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:var(--fs-xl);line-height:1;font-variant-numeric:tabular-nums;">${catData.length}</div><div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;white-space:nowrap;">categories</div></div>
      <div style="flex:1 1 140px;padding:16px 0;"><div style="font-family:var(--font-mono);font-weight:700;font-size:var(--fs-xl);line-height:1;font-variant-numeric:tabular-nums;">0</div><div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;white-space:nowrap;">api keys needed</div></div>
    </div>
  </div>
</header>

<section style="max-width:1180px;margin:0 auto;padding:52px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:12px;">$ GET /api/pricing</div>
  <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0;color:var(--ink);">Browse by category.</h2>
  <div class="ml-meta" style="margin:10px 0 14px;"><span>counts from the live catalog</span></div>
  <div class="cat-scroll" style="border:1px solid var(--hairline);background:var(--card);">
    <table style="font-size:var(--fs-md);">
      <thead>
        <tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);">
          <th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;width:250px;">category</th>
          <th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">what is in it</th>
          <th scope="col" style="text-align:right;font-weight:700;padding:12px 18px;white-space:nowrap;">tools</th>
          <th scope="col" style="text-align:right;font-weight:700;padding:12px 18px;white-space:nowrap;">pays with</th>
        </tr>
      </thead>
      <tbody id="cat-body">${catRowsHtml}</tbody>
    </table>
  </div>
  <p id="cat-empty" style="display:none;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--faint);padding:20px 0;text-align:center;">No categories match "<span id="cat-empty-q"></span>" - try <a href="/api/find" style="color:var(--accent);">GET /api/find</a> for a task-level search across every tool.</p>
  <p style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin:14px 0 0;">A tool can appear under more than one category, so the column does not sum to ${fmtNum(count)}. <span style="color:var(--ok);">cpu</span> means every tool in it is payable in compute via proof-of-work; <span style="color:var(--accent);">usdc</span> means all of them cost real money; <span style="color:var(--muted);">cpu + usdc</span> means the category mixes both.</p>
</section>

<section style="max-width:1180px;margin:0 auto;padding:52px 30px 0;">
  <div class="cat-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);">
    <div style="padding:28px;border-right:1px solid var(--hairline);background:var(--footer-bg);">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ok);margin-bottom:14px;">FREE TIER</div>
      <h2 style="font-weight:700;font-size:var(--fs-2xl);margin:0 0 14px;color:var(--ink);">Pay with CPU, not USDC</h2>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0 0 16px;">Every pure-CPU tool is payable in compute. Your machine solves a single-use sha256 puzzle - ${esc(powCostPhrase())} - and the call goes through. No wallet, no funding, no signup.</p>
      <pre style="margin:0 0 16px;background:var(--panel);border:1px solid var(--panel-rule);color:var(--on-panel);padding:14px;font-family:var(--font-mono);font-size:var(--fs-xs);line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--on-panel-faint);"># the MCP connector solves it for you
</span>claude mcp add --transport http \
  agent402 https://agent402.tools/mcp</pre>
      <a href="/playground" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--ok);padding-bottom:1px;">watch it run in the playground →</a>
    </div>
    <div style="padding:28px;background:var(--footer-bg);">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);margin-bottom:14px;">PAID TOOLS</div>
      <h2 style="font-weight:700;font-size:var(--fs-2xl);margin:0 0 14px;color:var(--ink);">Quoted before you're charged</h2>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0 0 16px;">Anything that costs us money to run - live search, browser rendering, inference, stored memory - is priced per call and states its price in the 402 challenge. A failed x402 call is not charged, and there is no key to leak.</p>
      <pre style="margin:0 0 16px;background:var(--panel);border:1px solid var(--panel-rule);color:var(--on-panel);padding:14px;font-family:var(--font-mono);font-size:var(--fs-xs);line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--on-panel-faint);"># price, asset and rail, before paying
</span>curl -i "https://agent402.tools/api/search?q=x402+adoption"</pre>
      <a href="/pricing" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">the full price list →</a>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:44px 30px 52px;">
  <div class="ml-cta-panel" style="background:var(--panel);border:1px solid var(--hairline);padding:46px 40px;position:relative;overflow:hidden;">
    <div style="position:relative;">
      <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 14px;color:var(--on-panel);">Don't browse. Just ask.</h2>
      <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--on-panel-muted);margin:0 0 26px;max-width:64ch;">Paste the MCP URL and describe the job: the hosted connector picks the tool, solves the proof-of-work for the free tools and hands back the result. Install agent402-mcp with a wallet key and it signs the payment for every other tool too.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a class="btn btn-primary on-panel" href="/docs#add">Add to your agent →</a>
        <a class="btn btn-secondary on-panel" href="/playground">Try the playground</a>
        <a class="btn btn-secondary on-panel" href="/skills">Bigger jobs → skill packs</a>
      </div>
    </div>
  </div>
</section>
${ledgerFooterCompact()}

<script src="/js/catalog-search.js"></script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/tools", jsonLd: [orgLd, breadcrumbLd, pageLd, listLd, appLd], extraCss, body });
}
