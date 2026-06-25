// Machine Ledger — Catalog page (/tools)
// Full tool index with live search, category filters, sample endpoints,
// skill packs grid, and bottom CTA.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable } from "./pow.js";

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
const fmtPrice = (p) => {
  const n = parseFloat(String(p).replace("$", ""));
  return `$${n}`;
};

// ---------------------------------------------------------------------------
// Sample endpoints — static showcase rows for the dark table
// ---------------------------------------------------------------------------

const SAMPLE_ENDPOINTS = [
  { method: "POST", route: "/api/extract", note: "$0.004 \u00b7 clean markdown out" },
  { method: "POST", route: "/api/render", note: "$0.02 \u00b7 headless browser, JS executed" },
  { method: "GET", route: "/api/convert/miles-to-kilometers?value=5", note: "$0.001" },
  { method: "POST", route: "/api/memory", note: "$0.002 \u00b7 durable, wallet-keyed" },
  { method: "POST", route: "/api/hash", note: "free \u00b7 proof-of-work" },
  { method: "GET", route: "/api/leaderboard", note: "free \u00b7 on-chain ranking" },
];

// ---------------------------------------------------------------------------
// Exported page renderer
// ---------------------------------------------------------------------------

export function ledgerCatalogPage(baseUrl, catalog, skillPacks) {
  const tools = toolList(catalog);
  const count = tools.length;
  const freeCount = tools.filter(isComputePayable).length;
  const packCount = Array.isArray(skillPacks) ? skillPacks.length : 42;

  // ---- category data ----
  const catEntries = Object.entries(CATEGORIES);
  const catData = catEntries.map(([key, { label, blurb }]) => {
    const inCat = tools.filter((t) => t.category === key);
    if (!inCat.length) return null;
    const cheapest = inCat.reduce((a, t) => Math.min(a, parseFloat(String(t.price).replace("$", ""))), Infinity);
    return { key, label, blurb, count: inCat.length, price: `$${cheapest}` };
  }).filter(Boolean);
  const mid = Math.ceil(catData.length / 2);
  const leftCats = catData.slice(0, mid);
  const rightCats = catData.slice(mid);

  // Short blurb for index table (truncate to a manageable subtitle)
  const shortBlurb = (b) => (b.length > 50 ? b.slice(0, 50) + "\u2026" : b);

  // ---- category row renderer ----
  const catRow = (c, last) =>
    `<div class="ml-cat-row" data-cat="${esc(c.key)}" style="display:grid;grid-template-columns:1fr auto auto;gap:14px;align-items:center;padding:13px 18px;${last ? "" : "border-bottom:1px solid var(--hairline);"}${c.key === "convert" ? "background:var(--card-zebra);" : ""}"><div><div style="font-weight:700;font-size:15px;">${esc(c.label)}</div><div style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">${esc(shortBlurb(c.blurb))}</div></div><span style="font-family:var(--font-mono);font-weight:700;font-size:15px;">${fmtNum(c.count)}</span><span style="font-family:var(--font-mono);font-size:11px;color:var(--accent);width:56px;text-align:right;">${c.price}</span></div>`;

  // ---- sample endpoint row ----
  const endpointRow = (ep, last) => {
    const methodColor = ep.method === "GET" ? "var(--green)" : "var(--accent)";
    return `<div style="display:grid;grid-template-columns:64px 1fr auto;gap:14px;align-items:center;padding:12px 18px;${last ? "" : "border-bottom:1px solid var(--dark-border);"}"><span style="color:${methodColor};font-weight:700;">${ep.method}</span><span style="color:var(--cream);">${esc(ep.route)}</span><span style="color:var(--dk-muted);">${esc(ep.note)}</span></div>`;
  };

  // ---- skill packs grid cells ----
  const packs = Array.isArray(skillPacks) ? skillPacks : [];
  const firstFive = packs.slice(0, 5);
  const packCell = (p, isLastInRow) => {
    const borderRight = isLastInRow ? "" : "border-right:1.5px solid var(--ink);";
    return `<div style="padding:20px;${borderRight}border-bottom:1.5px solid var(--ink);background:var(--card);"><div style="font-family:var(--font-mono);font-size:11px;color:var(--accent);margin-bottom:8px;">${esc(p.slug)}</div><div style="font-weight:700;font-size:15px;margin-bottom:5px;">${esc(p.title)}</div><div style="font-size:13px;color:var(--muted);line-height:1.45;">${esc(p.tagline)}</div></div>`;
  };

  // Build 2-row x 3-col grid: row 1 = packs[0..2], row 2 = packs[3..4] + browse-all
  const packCells = [];
  firstFive.forEach((p, i) => {
    const col = i % 3;
    const isLastInRow = col === 2;
    packCells.push(packCell(p, isLastInRow));
  });
  // 6th cell: dark "Browse all" CTA
  packCells.push(`<a href="/skills" style="padding:20px;background:var(--ink);text-decoration:none;display:flex;flex-direction:column;justify-content:center;border-bottom:1.5px solid var(--ink);"><span style="font-family:var(--font-mono);font-weight:700;font-size:14px;color:var(--cream);">Browse all ${packCount} packs \u2192</span><span style="font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);margin-top:6px;">prompts/list \u2192 prompts/get</span></a>`);

  // ---- filter chip data (all + each category with tools) ----
  const chipData = [{ key: "all", label: "all", count }];
  catData.forEach((c) => chipData.push({ key: c.key, label: c.key, count: c.count }));

  // ---- SEO ----
  const canonical = baseUrl + "/tools";
  const title = `Tool Catalog \u2014 ${fmtNum(count)} tools | Agent402`;
  const description = `Browse all ${fmtNum(count)} deterministic, pay-per-call API tools. ${fmtNum(freeCount)} free via proof-of-work, the rest from $0.001/call in USDC on Base. No signup, no API key.`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `Agent402 Tool Catalog`,
    url: canonical,
    description,
    isPartOf: { "@type": "WebSite", name: "Agent402.Tools", url: baseUrl },
  };

  // ---- extra CSS for responsive + search highlight ----
  const extraCss = `
  .ml-cat-row[data-cat].ml-hidden { display: none !important; }
  @media (max-width: 900px) {
    .ml-catalog-grid { grid-template-columns: 1fr !important; }
    .ml-catalog-left { border-right: none !important; border-bottom: 1.5px solid var(--ink); }
    .ml-packs-grid { grid-template-columns: 1fr !important; }
    .ml-packs-grid > * { border-right: none !important; }
  }
  @media (max-width: 600px) {
    .ml-catalog-h1 { font-size: 36px !important; }
    .ml-endpoint-grid { grid-template-columns: 48px 1fr !important; }
    .ml-endpoint-note { display: none !important; }
  }
  `;

  // ---- body ----
  const body = `
  <!-- PAGE HEAD -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:14px;">$ GET /tools</div>
    <h1 class="ml-catalog-h1" style="font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;color:var(--ink);">The index.<br>${fmtNum(count)} tools, ${catData.length} categories.</h1>
    <p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:600px;margin:0 0 30px;">Every tool is deterministic code \u2014 parsers, hashes, a real browser \u2014 priced flat, with no LLM in the serving path. One real HTTP endpoint each. Free via proof-of-work; USDC on Base from $0.001/call.</p>

    <!-- search bar -->
    <div style="display:flex;align-items:center;gap:0;border:1.5px solid var(--ink);background:var(--card);max-width:560px;margin-bottom:16px;">
      <span style="font-family:var(--font-mono);color:var(--accent);padding:0 12px;font-weight:700;">\u2315</span>
      <input id="ml-search" type="text" placeholder="search ${fmtNum(count)} tools \u2014 e.g. &quot;extract pdf&quot;, &quot;geocode&quot;" style="flex:1;border:none;background:transparent;font-family:var(--font-mono);font-size:14px;color:var(--ink);padding:13px 0;outline:none;" />
    </div>

    <!-- category chips -->
    <div id="ml-chips" style="display:flex;flex-wrap:wrap;gap:7px;">
      ${chipData.map((c, i) =>
        `<button data-filter="${c.key}" class="ml-chip${i === 0 ? " ml-chip-active" : ""}" style="font-family:var(--font-mono);font-size:11.5px;border:1.5px solid var(--ink);padding:5px 10px;cursor:pointer;background:${i === 0 ? "var(--ink)" : "transparent"};color:${i === 0 ? "var(--cream)" : "var(--ink)"};">${esc(c.label)}${c.count ? " \u00b7 " + fmtNum(c.count) : ""}</button>`
      ).join("\n      ")}
    </div>
  </section>

  <!-- INDEX TABLE -->
  <section style="max-width:1180px;margin:0 auto;padding:0 30px;">
    <div id="ml-index" style="border:1.5px solid var(--ink);background:var(--card);">
      <div class="ml-catalog-grid" style="display:grid;grid-template-columns:1fr 1fr;">
        <div class="ml-catalog-left" style="border-right:1.5px solid var(--ink);">
          ${leftCats.map((c, i) => catRow(c, i === leftCats.length - 1)).join("\n          ")}
        </div>
        <div>
          ${rightCats.map((c, i) => catRow(c, false)).join("\n          ")}
          <div id="ml-total-row" style="display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center;padding:14px 18px;background:var(--ink);"><span style="font-family:var(--font-mono);font-weight:700;font-size:14px;color:var(--cream);">total \u00b7 <span id="ml-total-count">${fmtNum(count)}</span> tools</span><span style="font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);">+${packCount} skill packs</span></div>
        </div>
      </div>
    </div>
  </section>

  <!-- SAMPLE ENDPOINTS -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">// sample endpoints</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 22px;">Call any of them in one round trip.</h2>
    <div style="border:1.5px solid var(--ink);background:var(--ink);font-family:var(--font-mono);font-size:13px;">
      ${SAMPLE_ENDPOINTS.map((ep, i) => endpointRow(ep, i === SAMPLE_ENDPOINTS.length - 1)).join("\n      ")}
    </div>
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:12px;">full machine-readable catalog: GET /api/pricing \u00b7 GET /openapi.json</div>
  </section>

  <!-- SKILL PACKS -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /skills</div>
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px;">
      <h2 style="font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0;">${packCount} multi-tool skill packs.</h2>
      <span style="font-family:var(--font-mono);font-size:12px;color:var(--faint);">curated workflows \u00b7 callable as an MCP prompt or plain HTTP</span>
    </div>
    <div class="ml-packs-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1.5px solid var(--ink);">
      ${packCells.join("\n      ")}
    </div>
  </section>

  <!-- CTA BAR -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 64px;">
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:32px 30px;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;">
      <div>
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:28px;line-height:1;letter-spacing:-.02em;margin:0 0 6px;">Wire the catalog into your agent.</h2>
        <p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);margin:0;">npx -y agent402-mcp \u00b7 or paste the hosted connector</p>
      </div>
      <div style="display:flex;gap:11px;">
        <a href="/docs" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 20px;">QUICKSTART \u2192</a>
        <a href="/pricing" style="background:transparent;border:1.5px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;">PRICING</a>
      </div>
    </div>
  </section>

  ${ledgerFooterCompact()}

  <!-- CLIENT-SIDE SEARCH + FILTER -->
  <script>
  (function() {
    var search = document.getElementById('ml-search');
    var chips = document.querySelectorAll('.ml-chip');
    var rows = document.querySelectorAll('.ml-cat-row');
    var totalEl = document.getElementById('ml-total-count');
    var activeFilter = 'all';

    // Category metadata for search matching
    var catMeta = ${JSON.stringify(catData.map((c) => ({ key: c.key, label: c.label, blurb: c.blurb, count: c.count })))};

    function applyFilters() {
      var q = (search.value || '').toLowerCase().trim();
      var visibleCount = 0;

      rows.forEach(function(row) {
        var cat = row.getAttribute('data-cat');
        var meta = catMeta.find(function(m) { return m.key === cat; });
        if (!meta) { row.classList.add('ml-hidden'); return; }

        var matchesCat = activeFilter === 'all' || activeFilter === cat;
        var matchesSearch = !q || meta.label.toLowerCase().indexOf(q) !== -1 || meta.blurb.toLowerCase().indexOf(q) !== -1 || meta.key.toLowerCase().indexOf(q) !== -1;

        if (matchesCat && matchesSearch) {
          row.classList.remove('ml-hidden');
          visibleCount += meta.count;
        } else {
          row.classList.add('ml-hidden');
        }
      });

      if (totalEl) {
        totalEl.textContent = visibleCount.toLocaleString('en-US');
      }
    }

    chips.forEach(function(chip) {
      chip.addEventListener('click', function() {
        activeFilter = chip.getAttribute('data-filter');
        chips.forEach(function(c) {
          var isActive = c === chip;
          c.classList.toggle('ml-chip-active', isActive);
          c.style.background = isActive ? 'var(--ink)' : 'transparent';
          c.style.color = isActive ? 'var(--cream)' : 'var(--ink)';
        });
        applyFilters();
      });
    });

    search.addEventListener('input', applyFilters);
  })();
  </script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/tools", jsonLd, extraCss, body });
}
