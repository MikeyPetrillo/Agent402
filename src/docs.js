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
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIKI_DIR = join(__dirname, "..", "wiki");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
    if (sec.title) parts.push(`<div class="docs-side-h">${esc(sec.title)}</div>`);
    parts.push('<ul class="docs-side-ul">');
    for (const it of sec.items) {
      if (it.kind === "doc") {
        const active = it.slug === currentSlug ? " active" : "";
        // Home in the wiki sidebar links to /docs (the index), not /docs/Home.
        const href = it.slug === "Home" ? "/docs" : `/docs/${it.slug}`;
        parts.push(`<li><a class="docs-side-a${active}" href="${href}">${esc(it.display)}</a></li>`);
      } else {
        parts.push(`<li><a class="docs-side-a" href="${esc(it.href)}" rel="noopener">${esc(it.display)} ↗</a></li>`);
      }
    }
    parts.push("</ul>");
  }
  // Extras — machine-readable surfaces and the live API reference. Keeps the
  // "everything in one place" promise of a docs hub without us having to
  // re-render the openapi catalog inline.
  const apiActive = currentSlug === "__api__" ? " active" : "";
  parts.push(`<div class="docs-side-h">Reference</div>
<ul class="docs-side-ul">
  <li><a class="docs-side-a${apiActive}" href="/docs/api">API Reference</a></li>
  <li><a class="docs-side-a" href="/openapi.json">OpenAPI JSON</a></li>
  <li><a class="docs-side-a" href="/llms.txt">llms.txt</a></li>
  <li><a class="docs-side-a" href="/api/pricing">Pricing</a></li>
  <li><a class="docs-side-a" href="/api/find">Find (/api/find)</a></li>
</ul>`);
  return parts.join("\n");
}

function shell(baseUrl, title, description, path, body, currentSlug) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Agent402 Docs</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${baseUrl}${path}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${baseUrl}/card.png">
<meta name="twitter:card" content="summary_large_image">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --line:#1e2638; --line2:#2a3550; --panel:#0f1420; }
  body { background:var(--bg); color:var(--fg); font:16px/1.7 system-ui,-apple-system,sans-serif; margin:0; }
  a { color:var(--accent); }
  .docs-wrap { max-width:1200px; margin:0 auto; padding:32px 20px 24px; }
  .docs-layout { display:block; }
  .docs-side { display:none; }
  .docs-main { min-width:0; }
  .docs-main h1 { font-size:1.9rem; line-height:1.25; margin:0 0 18px; }
  .docs-main h2 { font-size:1.2rem; margin-top:36px; color:var(--accent); }
  .docs-main h3 { font-size:1.02rem; margin-top:26px; }
  .docs-main p, .docs-main li { color:var(--fg); }
  .docs-main .muted { color:var(--muted); }
  .docs-main pre { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; overflow-x:auto; font-size:.85rem; line-height:1.55; }
  .docs-main code { font-family:ui-monospace,Menlo,monospace; }
  .docs-main p > code, .docs-main li > code, .docs-main td > code, .docs-main h3 > code { background:var(--panel); padding:1px 6px; border-radius:6px; font-size:.85em; }
  .docs-main table { border-collapse:collapse; width:100%; margin:18px 0; font-size:.92rem; }
  .docs-main th, .docs-main td { border:1px solid var(--line); padding:8px 12px; text-align:left; vertical-align:top; }
  .docs-main th { background:var(--panel); color:var(--accent); font-weight:600; }
  .docs-main blockquote { border-left:3px solid var(--accent); margin:16px 0; padding:4px 16px; color:var(--muted); background:rgba(74,222,128,.04); }
  .docs-main hr { border:0; border-top:1px solid var(--line); margin:32px 0; }
  .docs-crumbs { color:var(--muted); font-size:.85rem; margin-bottom:14px; }
  .docs-crumbs a { color:var(--muted); text-decoration:none; }
  .docs-crumbs a:hover { color:var(--accent); }
  .docs-side-h { font-size:.7rem; letter-spacing:.18em; text-transform:uppercase; color:var(--muted); margin:18px 0 6px; }
  .docs-side-ul { list-style:none; padding:0; margin:0 0 8px; }
  .docs-side-ul li { margin:0; }
  .docs-side-a { display:block; padding:5px 10px; margin:1px 0; border-radius:6px; color:var(--fg); text-decoration:none; font-size:.92rem; line-height:1.35; }
  .docs-side-a:hover { background:var(--panel); }
  .docs-side-a.active { background:var(--panel); color:var(--accent); border-left:2px solid var(--accent); padding-left:8px; }
  .docs-api-cat { margin:28px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line); color:var(--accent); font-size:1.05rem; }
  .docs-api-row { display:grid; grid-template-columns:1.2fr 2fr .5fr; gap:14px; padding:8px 0; border-bottom:1px solid var(--line); font-size:.9rem; }
  .docs-api-row .slug { font-family:ui-monospace,Menlo,monospace; color:var(--fg); }
  .docs-api-row .desc { color:var(--muted); }
  .docs-api-row .price { color:var(--accent); text-align:right; font-family:ui-monospace,Menlo,monospace; font-size:.85rem; }
  @media (min-width:900px) {
    .docs-layout { display:grid; grid-template-columns:260px 1fr; gap:36px; align-items:start; }
    .docs-side { display:block; position:sticky; top:64px; max-height:calc(100vh - 80px); overflow-y:auto; padding-right:8px; }
  }
  ${CHROME_CSS}
</style>
</head>
<body>${renderHeader("/docs")}<div class="docs-wrap"><div class="docs-layout">
<aside class="docs-side">${renderSidebar(currentSlug)}</aside>
<main class="docs-main">${body}</main>
</div></div>${renderFooter()}</body></html>`;
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
  const crumbs = `<div class="docs-crumbs"><a href="/docs">Docs</a> · ${esc(title)}</div>`;
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
      const price = t.price === 0 ? "free" : (typeof t.price === "number" ? `$${t.price.toFixed(4)}` : esc(String(t.price ?? "—")));
      return `<div class="docs-api-row"><div class="slug">${slug}</div><div class="desc">${desc}</div><div class="price">${esc(price)}</div></div>`;
    }).join("");
    return `<h2 class="docs-api-cat">${esc(cat)} <span class="muted" style="font-size:.75rem; font-weight:400">· ${tools.length}</span></h2>${rows}`;
  }).join("\n");

  const body = `<div class="docs-crumbs"><a href="/docs">Docs</a> · API Reference</div>
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
