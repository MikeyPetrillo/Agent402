// Server-rendered docs hub at /docs — a single navigable surface for the wiki
// content that already lives in /wiki, plus a /docs/api page rendered from the
// in-process catalog. The wiki MDs are the source of truth (CI syncs them to
// the GitHub wiki); this module just reads them at boot, transforms wikilinks
// (`[[Page]]` and `[[Display|Slug]]`) into local `/docs/<slug>` hrefs, and
// renders each page inside a 2-column shell with a sticky sidebar.
//
// Why server-rendered: same pattern as guides.js / pages.js — no SPA, no
// client JS required, indexable by search engines, fast on cold paint.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIKI_DIR = join(__dirname, "..", "wiki");

// One-shot load at module init — these files only change on deploy.
// Tolerant of a missing wiki/ directory: in deployment artifacts that don't
// include it, docs renders an empty hub rather than crashing server boot.
function loadWikiFiles() {
  const files = {};
  let entries;
  try {
    entries = readdirSync(WIKI_DIR);
  } catch {
    return files;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    if (name.startsWith("_")) continue; // _Sidebar / _Footer handled separately
    const slug = name.replace(/\.md$/, "");
    files[slug] = readFileSync(join(WIKI_DIR, name), "utf8");
  }
  return files;
}

function loadSidebarRaw() {
  try {
    return readFileSync(join(WIKI_DIR, "_Sidebar.md"), "utf8");
  } catch {
    return "";
  }
}

const WIKI = loadWikiFiles();
const SIDEBAR_RAW = loadSidebarRaw();
const VALID_SLUGS = new Set(Object.keys(WIKI));

// Wikilink transform: `[[Display|Slug]]` and `[[Page Name]]`. GitHub-style
// wikilinks use spaces in the rendered text but hyphens in the filename
// (`Pay-per-crawl.md`). We mirror that here.
function slugFromPageName(name) {
  return name.trim().replace(/\s+/g, "-");
}

function transformWikilinks(md) {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_m, display, target) => {
      const slug = target.trim();
      return `[${display.trim()}](/docs/${slug})`;
    })
    .replace(/\[\[([^\]]+)\]\]/g, (_m, name) => {
      const slug = slugFromPageName(name);
      return `[${name.trim()}](/docs/${slug})`;
    });
}

// Parse the GitHub-flavored _Sidebar.md into a normalized structure we can
// re-render inside the docs shell. Recognized line shapes:
//   **[[Home]]**                              → top-level link
//   **Group title**                           → section header
//   - [[Page]]                                → page link in current group
//   - [[Display|Slug]]                        → page link in current group
//   - [Markdown text](url) — optional prose   → external link in current group
//   ---                                       → end of sidebar (we stop here)
// Anything else is ignored. Robust to extra whitespace and trailing prose
// after `—`.
function parseSidebar(raw) {
  const sections = [];
  let current = null;
  const flush = () => { if (current) sections.push(current); current = null; };
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("---")) break;

    // **[[Page]]**  → standalone top-level link, becomes its own 1-item section
    const standalone = t.match(/^\*\*\[\[([^\]]+)\]\]\*\*$/);
    if (standalone) {
      flush();
      const name = standalone[1];
      const display = name.includes("|") ? name.split("|")[0].trim() : name.trim();
      const slug = name.includes("|") ? name.split("|")[1].trim() : slugFromPageName(name);
      sections.push({ title: null, items: [{ kind: "doc", display, slug }] });
      continue;
    }

    // **Group title**
    const header = t.match(/^\*\*([^*]+)\*\*$/);
    if (header) {
      flush();
      current = { title: header[1].trim(), items: [] };
      continue;
    }

    // bullet items
    const bullet = t.match(/^-\s+(.*)$/);
    if (bullet && current) {
      const body = bullet[1];
      // strip trailing prose after `—`
      const main = body.split(/\s+[—–-]\s+/)[0];
      const wiki = main.match(/^\[\[([^\]]+)\]\]$/);
      if (wiki) {
        const name = wiki[1];
        const display = name.includes("|") ? name.split("|")[0].trim() : name.trim();
        const slug = name.includes("|") ? name.split("|")[1].trim() : slugFromPageName(name);
        current.items.push({ kind: "doc", display, slug });
        continue;
      }
      const md = main.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (md) {
        current.items.push({ kind: "link", display: md[1].trim(), href: md[2].trim() });
        continue;
      }
    }
  }
  flush();
  return sections;
}

const SIDEBAR_SECTIONS = parseSidebar(SIDEBAR_RAW);

function renderSidebar(currentSlug) {
  const parts = [];
  for (const sec of SIDEBAR_SECTIONS) {
    if (sec.title) parts.push(`<div class="ml-docs-side-h">${esc(sec.title)}</div>`);
    parts.push('<ul class="ml-docs-side-ul">');
    for (const it of sec.items) {
      if (it.kind === "doc") {
        const active = it.slug === currentSlug ? " active" : "";
        // Home in the wiki sidebar links to /docs (the index), not /docs/Home.
        const href = it.slug === "Home" ? "/docs" : `/docs/${it.slug}`;
        parts.push(`<li><a class="ml-docs-side-a${active}" href="${href}">${esc(it.display)}</a></li>`);
      } else {
        parts.push(`<li><a class="ml-docs-side-a" href="${esc(it.href)}" rel="noopener">${esc(it.display)} &#8599;</a></li>`);
      }
    }
    parts.push("</ul>");
  }
  // Extras — machine-readable surfaces and the live API reference. Keeps the
  // "everything in one place" promise of a docs hub without us having to
  // re-render the openapi catalog inline.
  const apiActive = currentSlug === "__api__" ? " active" : "";
  parts.push(`<div class="ml-docs-side-h">Reference</div>
<ul class="ml-docs-side-ul">
  <li><a class="ml-docs-side-a${apiActive}" href="/docs/api">API Reference</a></li>
  <li><a class="ml-docs-side-a" href="/openapi.json">OpenAPI JSON</a></li>
  <li><a class="ml-docs-side-a" href="/llms.txt">llms.txt</a></li>
  <li><a class="ml-docs-side-a" href="/api/pricing">Pricing</a></li>
  <li><a class="ml-docs-side-a" href="/api/find">Find (/api/find)</a></li>
</ul>`);
  return parts.join("\n");
}

function shell(baseUrl, title, description, path, body, currentSlug) {
  const extraCss = `
  .ml-docs-layout { display:block; }
  .ml-docs-side { display:none; }
  .ml-docs-main { min-width:0; }
  .ml-docs-main h1 { font-family:var(--font-body);font-weight:800;font-size:42px;line-height:1;letter-spacing:-.02em;margin:0 0 18px; }
  .ml-docs-main h2 { font-size:1.2rem;margin-top:36px;color:var(--accent);font-weight:700; }
  .ml-docs-main h3 { font-size:1.02rem;margin-top:26px;font-weight:700; }
  .ml-docs-main p, .ml-docs-main li { color:var(--ink);line-height:1.7; }
  .ml-docs-main .muted { color:var(--muted); }
  .ml-docs-main pre { background:var(--ink);color:var(--cream);font-family:var(--font-mono);border:0;padding:14px 16px;overflow-x:auto;font-size:.85rem;line-height:1.55; }
  .ml-docs-main code { font-family:var(--font-mono); }
  .ml-docs-main p > code, .ml-docs-main li > code, .ml-docs-main td > code, .ml-docs-main h3 > code { background:var(--card);border:1px solid var(--hairline);padding:1px 6px;font-size:.85em; }
  .ml-docs-main table { border-collapse:collapse;width:100%;margin:18px 0;font-size:.92rem; }
  .ml-docs-main th, .ml-docs-main td { border:1px solid var(--hairline);padding:8px 12px;text-align:left;vertical-align:top; }
  .ml-docs-main th { background:var(--card);color:var(--accent);font-weight:600; }
  .ml-docs-main blockquote { border-left:3px solid var(--accent);margin:16px 0;padding:4px 16px;color:var(--muted);background:rgba(214,60,26,.04); }
  .ml-docs-main hr { border:0;border-top:1px solid var(--hairline);margin:32px 0; }
  .ml-docs-main a { color:var(--accent);text-decoration:none; }
  .ml-docs-main a:hover { text-decoration:underline; }
  .ml-docs-main img { max-width:100%; }
  .ml-docs-crumbs { color:var(--faint);font-size:.85rem;margin-bottom:14px; }
  .ml-docs-crumbs a { color:var(--faint);text-decoration:none; }
  .ml-docs-crumbs a:hover { color:var(--accent); }
  .ml-docs-side-h { font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:18px 0 6px; }
  .ml-docs-side-ul { list-style:none;padding:0;margin:0 0 8px; }
  .ml-docs-side-ul li { margin:0; }
  .ml-docs-side-a { display:block;padding:5px 10px;margin:1px 0;color:var(--ink);text-decoration:none;font-size:.92rem;line-height:1.35; }
  .ml-docs-side-a:hover { background:var(--card); }
  .ml-docs-side-a.active { background:var(--card);color:var(--accent);border-left:2px solid var(--accent);padding-left:8px;font-weight:600; }
  .ml-docs-api-cat { font-family:var(--font-body);font-weight:800;font-size:22px;letter-spacing:-.02em;margin:28px 0 8px;padding-bottom:6px;border-bottom:1.5px solid var(--ink);color:var(--ink); }
  .ml-docs-api-row { display:grid;grid-template-columns:1.2fr 2fr .5fr;gap:14px;padding:8px 0;border-bottom:1px solid var(--hairline);font-size:.9rem; }
  .ml-docs-api-row .slug { font-family:var(--font-mono);color:var(--ink); }
  .ml-docs-api-row .desc { color:var(--muted); }
  .ml-docs-api-row .price { color:var(--accent);text-align:right;font-family:var(--font-mono);font-size:.85rem;font-weight:700; }
  @media (min-width:900px) {
    .ml-docs-layout { display:grid;grid-template-columns:240px 1fr;gap:44px;align-items:start; }
    .ml-docs-side { display:block;position:sticky;top:92px;max-height:calc(100vh - 100px);overflow-y:auto;padding-right:8px; }
  }`;

  const pageBody = `
  <div style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;">
    <div class="ml-docs-layout">
      <aside class="ml-docs-side">${renderSidebar(currentSlug)}</aside>
      <main class="ml-docs-main">${body}</main>
    </div>
  </div>
  ${ledgerFooterCompact()}`;

  return ledgerShell({
    title: `${title} \u2014 Agent402 Docs`,
    description,
    canonical: `${baseUrl}${path}`,
    baseUrl,
    activePath: "/docs",
    extraCss,
    body: pageBody,
  });
}

function renderMarkdown(md) {
  return marked.parse(transformWikilinks(md));
}

export function docsIndex(baseUrl) {
  const home = WIKI["Home"];
  if (!home) {
    return shell(
      baseUrl,
      "Docs",
      "Agent402 documentation.",
      "/docs",
      `<h1>Docs</h1><p class="muted">Wiki content unavailable.</p>`,
      "Home"
    );
  }
  return shell(
    baseUrl,
    "Agent402 Docs",
    "Open-source x402 + MCP server: 1,323 pay-per-call tools for AI agents. Browse the docs — getting started, paying with x402, MCP connector, Tollbooth pay-per-crawl, architecture, and security.",
    "/docs",
    renderMarkdown(home),
    "Home"
  );
}

export function docsPage(baseUrl, slug) {
  const md = WIKI[slug];
  if (!md) return null;
  const title = slug.replace(/-/g, " ");
  const firstPara = (md.replace(/^#.*$/m, "").match(/\n\n([^\n#][^\n]+)/) || [])[1] || `Agent402 documentation: ${title}.`;
  const description = firstPara.replace(/\s+/g, " ").trim().slice(0, 200);
  const crumbs = `<div class="ml-docs-crumbs"><a href="/docs">Docs</a> &rsaquo; ${esc(title)}</div>`;
  return shell(
    baseUrl,
    title,
    description,
    `/docs/${slug}`,
    `${crumbs}${renderMarkdown(md)}`,
    slug
  );
}

// API reference: flat catalog grouped by category. Built from the live tool
// list rather than a frozen markdown page, so it stays in sync with whatever
// the server actually exposes.
export function docsApi(baseUrl, catalog) {
  const byCat = new Map();
  for (const t of catalog) {
    const cat = t.category || "uncategorized";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(t);
  }
  const cats = [...byCat.keys()].sort();
  const sections = cats.map((cat) => {
    const tools = byCat.get(cat).slice().sort((a, b) => (a.slug || "").localeCompare(b.slug || ""));
    const rows = tools.map((t) => {
      const slug = esc(t.slug || t.route || "");
      const desc = esc((t.description || "").replace(/\s+/g, " ").trim().slice(0, 220));
      const price = t.price === 0 ? "free" : (typeof t.price === "number" ? `$${t.price.toFixed(4)}` : esc(String(t.price ?? "\u2014")));
      return `<div class="ml-docs-api-row"><div class="slug">${slug}</div><div class="desc">${desc}</div><div class="price">${esc(price)}</div></div>`;
    }).join("");
    return `<h2 class="ml-docs-api-cat">${esc(cat)} <span style="font-size:13px;font-weight:400;color:var(--faint);font-family:var(--font-mono);">&middot; ${tools.length}</span></h2>${rows}`;
  }).join("\n");

  const body = `<div class="ml-docs-crumbs"><a href="/docs">Docs</a> &rsaquo; API Reference</div>
<h1>API Reference</h1>
<p class="muted">Every tool the server exposes, grouped by category. The same list is available as machine-readable JSON at <a href="/openapi.json">/openapi.json</a> and <a href="/api/pricing">/api/pricing</a>, or as plain text at <a href="/llms.txt">/llms.txt</a>. Call any of them over HTTP, MCP, or the <a href="/docs/MCP-Connector">MCP connector</a>.</p>
<p class="muted"><b>${catalog.length}</b> tools across <b>${cats.length}</b> categories.</p>
${sections}`;
  return shell(
    baseUrl,
    "API Reference",
    `Full Agent402 API catalog: ${catalog.length} tools across ${cats.length} categories. Machine-readable at /openapi.json and /llms.txt.`,
    "/docs/api",
    body,
    "__api__"
  );
}

export const docsSlugs = () => Object.keys(WIKI);
export const docsHasSlug = (slug) => VALID_SLUGS.has(slug);
