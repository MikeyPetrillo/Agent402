// Machine Ledger — Catalog page (/tools), Aug 2026 revamp.
// Tab strip (Tools / Skill packs / Playground / Pricing / Integrations),
// live search, "browse by category" table with a real cpu/usdc/mixed
// pays-with column, free-tier + paid-tools explainer, closing CTA.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { RAILS_SHORT } from "./rails.js";

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
    const payColor = pays === "cpu" ? "var(--green)" : pays === "usdc" ? "var(--accent)" : "var(--muted)";
    const payLabel = pays === "mixed" ? "cpu + usdc" : pays;
    return { key, label, blurb, count: inCat.length, href: key === "skill-pack" ? "/skills" : `/tools/category/${key}`, pays, payLabel, payColor };
  }).filter(Boolean);

  // ---- SEO ----
  const canonical = baseUrl + "/tools";
  const title = `${fmtNum(count)} pay-per-call tools for AI agents - the Agent402 catalog`;
  const description = `${fmtNum(count)} tools an AI agent can call and pay for per request in USDC. ${fmtNum(freeCount)} run free on proof-of-work. No signup, no API keys. Browse by category, or describe a task and let the router resolve it.`;

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, sameAs: [`https://github.com/MikeyPetrillo/Agent402`, "https://x.com/Agent402Tools"] };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Our tools", item: canonical },
  ] };
  const pageLd = { "@type": "CollectionPage", "@id": `${canonical}#page`, name: "Agent402 tool catalog", url: canonical, description, isPartOf: { "@id": `${baseUrl}/#organization` }, mainEntity: { "@id": `${canonical}#categories` } };
  const listLd = { "@type": "ItemList", "@id": `${canonical}#categories`, name: "Tool categories", itemListOrder: "https://schema.org/ItemListUnordered", itemListElement: catData.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.label, url: `${baseUrl}${c.href}` })) };
  const appLd = { "@type": "SoftwareApplication", "@id": `${canonical}#app`, name: "Agent402 tool catalog", applicationCategory: "DeveloperApplication", operatingSystem: "HTTP, MCP (streamable HTTP)", offers: { "@type": "AggregateOffer", offerCount: String(count), lowPrice: "0.001", highPrice: "1.50", priceCurrency: "USD", description: "Per-call micropayments in USDC, or free via single-use sha256 proof-of-work on pure-CPU tools" } };

  const extraCss = `
.cat-scroll{overflow-x:auto}
.cat-scroll table{min-width:780px}
table{border-collapse:collapse;width:100%}
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
    `<tr class="cat-row" data-cat="${esc(c.key)}" style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:14px 18px;color:var(--ink);font-size:15px;"><a href="${esc(c.href)}" style="color:var(--ink);text-decoration:none;">${esc(c.label)}</a></th><td class="cat-blurb" style="padding:14px 18px;color:var(--muted);font-size:13.5px;line-height:1.5;">${esc(c.blurb)}</td><td style="padding:14px 18px;text-align:right;font-family:var(--font-mono);font-size:13px;color:var(--on-dark2);font-variant-numeric:tabular-nums;">${fmtNum(c.count)}</td><td style="padding:14px 18px;text-align:right;font-family:var(--font-mono);font-size:11.5px;white-space:nowrap;"><span style="color:${c.payColor};">${esc(c.payLabel)}</span></td></tr>`
  ).join("");

  const body = `
<div style="border-bottom:1px solid var(--hairline);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:0 30px;display:flex;gap:0;overflow-x:auto;font-family:var(--font-mono);font-size:12.5px;">${tabsHtml}</div>
</div>

<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:36px 30px 34px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:18px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">our tools</span>
    </nav>
    <h1 style="font-weight:800;font-size:46px;line-height:1;letter-spacing:-.03em;margin:0 0 12px;color:var(--ink);">Our tools</h1>
    <p style="font-size:16.5px;line-height:1.55;color:var(--muted);margin:0;max-width:640px;">${fmtNum(count)} tools an agent can call and pay for per request. Around ${fmtNum(freeCount)} of them run free on proof-of-work. This is <em style="color:var(--on-dark2);">our own</em> catalog - for every tool in the index, ours and other sellers', see <a href="/marketplace/tools" style="color:var(--ink);border-bottom:1px solid var(--accent);text-decoration:none;">all indexed tools</a>.</p>

    <div class="cat-search-wrap" style="display:flex;gap:0;background:var(--card);max-width:760px;margin:22px 0 0;">
      <label for="cat-search" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);">Search tools</label>
      <span style="font-family:var(--font-mono);color:var(--accent);padding:0 12px;display:flex;align-items:center;font-weight:700;">⌕</span>
      <input id="cat-search" type="text" placeholder="Describe a task: decode a JWT, OCR an image, verify a settlement…" style="flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--ink);font-family:var(--font-mono);font-size:14px;padding:15px 0;">
    </div>
    <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:11px 0 0;">Searches every tool as you type - same free <span style="color:var(--muted);">GET /api/find</span> agents call, no wallet.</p>
    <div id="cat-results" style="display:none;max-width:760px;margin:14px 0 0;border:1px solid var(--hairline);background:var(--card);"></div>

    <div style="display:flex;flex-wrap:wrap;margin-top:30px;border-top:1px dashed var(--dash);">
      <div style="flex:1 1 140px;padding:16px 20px 16px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:21px;line-height:1;font-variant-numeric:tabular-nums;">${fmtNum(count)}</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;">tools</div></div>
      <div style="flex:1 1 140px;padding:16px 20px 16px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:21px;line-height:1;font-variant-numeric:tabular-nums;color:var(--green);">${fmtNum(freeCount)}</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;">free · proof-of-work</div></div>
      <div style="flex:1 1 140px;padding:16px 20px 16px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:21px;line-height:1;font-variant-numeric:tabular-nums;"><span style="color:var(--accent);">$</span>0.001</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;">floor price</div></div>
      <div style="flex:1 1 140px;padding:16px 20px 16px 0;margin-right:20px;border-right:1px dashed var(--dash);"><div style="font-family:var(--font-mono);font-weight:700;font-size:21px;line-height:1;font-variant-numeric:tabular-nums;">${catData.length}</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;">categories</div></div>
      <div style="flex:1 1 140px;padding:16px 0;"><div style="font-family:var(--font-mono);font-weight:700;font-size:21px;line-height:1;font-variant-numeric:tabular-nums;">0</div><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-top:6px;">api keys needed</div></div>
    </div>
  </div>
</header>

<section style="max-width:1180px;margin:0 auto;padding:52px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/pricing</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 style="font-weight:800;font-size:36px;line-height:1.02;letter-spacing:-.025em;margin:0;color:var(--ink);">Browse by category.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">counts from the live catalog</span>
  </div>
  <div class="cat-scroll" style="border:1px solid var(--hairline);background:var(--card);">
    <table style="font-size:14px;">
      <thead>
        <tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);">
          <th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;width:250px;">category</th>
          <th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">what is in it</th>
          <th scope="col" style="text-align:right;font-weight:700;padding:12px 18px;white-space:nowrap;">tools</th>
          <th scope="col" style="text-align:right;font-weight:700;padding:12px 18px;white-space:nowrap;">pays with</th>
        </tr>
      </thead>
      <tbody id="cat-body">${catRowsHtml}</tbody>
    </table>
  </div>
  <p id="cat-empty" style="display:none;font-family:var(--font-mono);font-size:13px;color:var(--faint);padding:20px 0;text-align:center;">No categories match "<span id="cat-empty-q"></span>" - try <a href="/api/find" style="color:var(--accent);">GET /api/find</a> for a task-level search across every tool.</p>
  <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:14px 0 0;">A tool can appear under more than one category, so the column does not sum to ${fmtNum(count)}. <span style="color:var(--green);">cpu</span> means every tool in it is payable in compute via proof-of-work; <span style="color:var(--accent);">usdc</span> means all of them cost real money; <span style="color:var(--muted);">cpu + usdc</span> means the category mixes both.</p>
</section>

<section style="max-width:1180px;margin:0 auto;padding:52px 30px 0;">
  <div class="cat-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);">
    <div style="padding:28px;border-right:1px solid var(--hairline);background:var(--footer-bg);">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--green);margin-bottom:14px;">FREE TIER</div>
      <h2 style="font-weight:800;font-size:25px;margin:0 0 14px;color:var(--ink);">Pay with CPU, not USDC</h2>
      <p style="font-size:15px;line-height:1.6;color:var(--muted);margin:0 0 16px;">Every pure-CPU tool is payable in compute. Your machine solves a single-use sha256 puzzle - about 85,000 hashes, a tenth of a second - and the call goes through. No wallet, no funding, no signup.</p>
      <pre style="margin:0 0 16px;background:var(--surface);border:1px solid var(--dark-border);color:var(--on-dark);padding:14px;font-family:var(--font-mono);font-size:11.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># the MCP connector solves it for you
</span>claude mcp add --transport http \
  agent402 https://agent402.tools/mcp</pre>
      <a href="/playground" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--green);padding-bottom:1px;">watch it run in the playground →</a>
    </div>
    <div style="padding:28px;background:var(--footer-bg);">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">PAID TOOLS</div>
      <h2 style="font-weight:800;font-size:25px;margin:0 0 14px;color:var(--ink);">Quoted before you're charged</h2>
      <p style="font-size:15px;line-height:1.6;color:var(--muted);margin:0 0 16px;">Anything that costs us money to run - live search, browser rendering, inference, stored memory - is priced per call and states its price in the 402 challenge. A failed call is never charged, and there is no key to leak.</p>
      <pre style="margin:0 0 16px;background:var(--surface);border:1px solid var(--dark-border);color:var(--on-dark);padding:14px;font-family:var(--font-mono);font-size:11.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># price, asset and rail, before paying
</span>curl -i https://agent402.tools/api/search \
  -d '{"q":"x402 adoption"}'</pre>
      <a href="/pricing" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">the full price list →</a>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:44px 30px 52px;">
  <div style="background:var(--surface);border:1px solid var(--hairline);padding:46px 40px;position:relative;overflow:hidden;">
    <div style="position:absolute;right:24px;top:-32px;font-weight:900;font-size:210px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff10;pointer-events:none;">402</div>
    <div style="position:relative;">
      <h2 style="font-weight:800;font-size:36px;line-height:1.02;letter-spacing:-.025em;margin:0 0 14px;color:var(--on-dark);">Don't browse. Just ask.</h2>
      <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);margin:0 0 26px;max-width:520px;">Paste the MCP URL and describe the job. The connector picks the tool, solves the proof-of-work or signs the payment, and hands back the result.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a href="/docs#add" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">Add to your agent →</a>
        <a href="/playground" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">TRY THE PLAYGROUND</a>
        <a href="/skills" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--dk-muted);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">BIGGER JOBS → SKILL PACKS</a>
      </div>
    </div>
  </div>
</section>
${ledgerFooterCompact()}

<script src="/js/catalog-search.js"></script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/tools", jsonLd: [orgLd, breadcrumbLd, pageLd, listLd, appLd], extraCss, body });
}
