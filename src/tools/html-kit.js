// HTML kit — deterministic structured-extraction utilities for raw HTML
// strings (the partner to extract.js/render.js, which work on URLs).
//
// The common agent pattern is: call render(url) or fetch a page some other
// way, then drill into a specific selector, table, or link list. Today
// agents do that with brittle regex; these five tools make it a single
// deterministic call against a real DOM (jsdom — already a dep used by
// extract.js's Readability path, so no new packages).
//
// All pure-CPU, no network, no LLM → proof-of-work eligible (free tier).
// Covered by scripts/test-html-kit.js.
import { JSDOM } from "jsdom";

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
function need(input, field, type = "string") {
  const v = input[field];
  if (v === undefined || v === null || (type === "string" && typeof v !== "string")) throw bad(`Missing or invalid "${field}"`);
  return v;
}

// Cap input size — jsdom parses everything in memory and can spend seconds on
// pathological pages. 5MB is generous (a typical large news article HTML is
// ~200KB; a heavy SPA's pre-render is ~1-2MB). Refuse rather than burn CPU.
const MAX_HTML_BYTES = 5 * 1024 * 1024;
function parseHtml(html) {
  if (typeof html !== "string") throw bad('"html" must be a string');
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw bad(`"html" exceeds ${MAX_HTML_BYTES} byte limit`);
  // contentType=text/html so jsdom uses the HTML parser (lenient) not XML.
  // No resourceLoader — we never fetch sub-resources from a tool handler.
  return new JSDOM(html, { contentType: "text/html" });
}

const trimText = (s, max = 4000) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
};

// Validate a CSS selector by trying it against a synthetic empty doc.
// Throws a 400 with the underlying message so callers see "Invalid selector"
// instead of an opaque DOMException.
function validateSelector(selector) {
  try {
    new JSDOM("<!doctype html><html><body></body></html>").window.document.querySelector(selector);
  } catch (e) {
    throw bad(`invalid CSS selector "${selector}": ${e.message}`);
  }
}

// Collect element attributes into a plain object (small, JSON-safe).
function attrsOf(el) {
  const out = {};
  for (const a of el.attributes) out[a.name] = a.value;
  return out;
}

// Resolve a possibly-relative href against an optional base URL. Returns the
// original string if the base is missing or the URL doesn't parse — never
// throws, since one bad link in a thousand shouldn't fail the whole call.
function resolveHref(href, base) {
  if (!base) return href;
  try { return new URL(href, base).href; } catch { return href; }
}

export const HTML_TOOLS = [
  // -------------------------------------------------------------------------
  {
    route: "POST /api/html-select", name: "HTML select", slug: "html-select",
    category: "web", price: "$0.001",
    description:
      "Run a CSS selector against an HTML string and return the matches (text, attrs, and optionally outerHTML for each). The deterministic alternative to regex when you already have the HTML and know the selector — pairs with /api/render or any page you've fetched yourself.",
    tags: ["html", "css-selector", "queryselector", "dom", "scrape", "extract"],
    discovery: {
      bodyType: "json",
      input: { html: "<html><body><h1>One</h1><h1>Two</h1></body></html>", selector: "h1", limit: 25 },
      inputSchema: {
        properties: {
          html: { type: "string", description: "Raw HTML string to query (max 5MB)" },
          selector: { type: "string", description: "CSS selector (e.g. \"h1\", \".price\", \"article > p:first-of-type\")" },
          limit: { type: "number", description: "Max matches to return, 1-200 (default 25)" },
          attr: { type: "string", description: "When set, return only this attribute's value per match (e.g. \"href\", \"data-id\") — keeps responses compact" },
          includeHtml: { type: "boolean", description: "Include outerHTML of each match (default false — text + attrs only)" },
        },
        required: ["html", "selector"],
      },
      output: { example: { count: 2, matches: [{ text: "One", attrs: {} }, { text: "Two", attrs: {} }] } },
    },
    handler: (i) => {
      const html = need(i, "html");
      const selector = need(i, "selector");
      validateSelector(selector);
      const rawLimit = i.limit === undefined ? 25 : Number(i.limit);
      if (!Number.isFinite(rawLimit) || rawLimit < 1 || rawLimit > 200) throw bad(`"limit" must be 1-200`);
      const limit = Math.floor(rawLimit);
      const attr = i.attr ? String(i.attr) : null;
      const includeHtml = Boolean(i.includeHtml);

      const doc = parseHtml(html).window.document;
      const all = doc.querySelectorAll(selector);
      const matches = [];
      for (let n = 0; n < all.length && matches.length < limit; n++) {
        const el = all[n];
        if (attr) {
          // Single-attr mode keeps responses tight when you just want hrefs/ids.
          const v = el.getAttribute(attr);
          if (v !== null) matches.push({ [attr]: v });
        } else {
          const out = { text: trimText(el.textContent), attrs: attrsOf(el) };
          if (includeHtml) out.html = el.outerHTML;
          matches.push(out);
        }
      }
      return { count: all.length, returned: matches.length, matches };
    },
  },
  // -------------------------------------------------------------------------
  {
    route: "POST /api/html-table", name: "HTML table to JSON/CSV", slug: "html-table",
    category: "web", price: "$0.001",
    description:
      "Extract a <table> from an HTML string as JSON rows (header-keyed) or CSV. Useful for prices, schedules, sports stats, or anything an agent has already fetched as HTML. If multiple tables match, the first is used.",
    tags: ["html", "table", "csv", "tabular", "scrape", "extract"],
    discovery: {
      bodyType: "json",
      input: {
        html: "<table><thead><tr><th>City</th><th>Pop</th></tr></thead><tbody><tr><td>NYC</td><td>8.3M</td></tr><tr><td>LA</td><td>3.9M</td></tr></tbody></table>",
        format: "json",
      },
      inputSchema: {
        properties: {
          html: { type: "string", description: "Raw HTML string containing the table (max 5MB)" },
          selector: { type: "string", description: "CSS selector for the table (default \"table\")" },
          format: { type: "string", description: "\"json\" (default — rows as header-keyed objects) | \"csv\"" },
        },
        required: ["html"],
      },
      output: { example: { rows: [{ City: "NYC", Pop: "8.3M" }, { City: "LA", Pop: "3.9M" }], headers: ["City", "Pop"], format: "json", count: 2 } },
    },
    handler: (i) => {
      const html = need(i, "html");
      const selector = (i.selector || "table").toString();
      validateSelector(selector);
      const format = (i.format || "json").toLowerCase();
      if (format !== "json" && format !== "csv") throw bad(`"format" must be "json" or "csv"`);

      const doc = parseHtml(html).window.document;
      const table = doc.querySelector(selector);
      if (!table) throw bad(`no element matched selector "${selector}"`);
      if (table.tagName !== "TABLE") throw bad(`selector "${selector}" matched <${table.tagName.toLowerCase()}>, not <table>`);

      // Header row: explicit <thead>, else first <tr> that contains any <th>,
      // else first <tr>. Matches the heuristics CSV-to-JSON libraries use.
      const allRows = [...table.querySelectorAll("tr")];
      if (!allRows.length) return { rows: [], headers: [], format, count: 0 };
      const headerRow =
        table.querySelector("thead tr") ||
        allRows.find((r) => r.querySelector("th")) ||
        allRows[0];
      const headers = [...headerRow.children].map((c, idx) => trimText(c.textContent, 200) || `col${idx + 1}`);
      const bodyRows = allRows.filter((r) => r !== headerRow);

      const rows = bodyRows.map((tr) => {
        const cells = [...tr.children].map((c) => trimText(c.textContent, 1000));
        if (format === "csv") return cells;
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ""; });
        return obj;
      });

      if (format === "csv") {
        // RFC 4180 quoting: wrap in quotes if cell contains a comma, quote, or
        // newline; double any internal quotes.
        const csvEscape = (s) => /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        const lines = [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
        return { csv: lines.join("\n"), headers, format, count: rows.length };
      }
      return { rows, headers, format, count: rows.length };
    },
  },
  // -------------------------------------------------------------------------
  {
    route: "POST /api/html-strip", name: "HTML strip to text", slug: "html-strip",
    category: "web", price: "$0.001",
    description:
      "Strip all HTML tags and return plain text. Preserves block-level structure (paragraphs and headings become newline-separated). Faster and more predictable than running extract on a raw HTML string when you already have it.",
    tags: ["html", "strip", "tags", "plaintext", "text"],
    discovery: {
      bodyType: "json",
      input: { html: "<h1>Title</h1><p>First paragraph.</p><p>Second.</p>" },
      inputSchema: {
        properties: {
          html: { type: "string", description: "Raw HTML string to strip (max 5MB)" },
          selector: { type: "string", description: "Optional CSS selector — strip only within this element (default: whole document)" },
        },
        required: ["html"],
      },
      output: { example: { text: "Title\n\nFirst paragraph.\n\nSecond.", chars: 30 } },
    },
    handler: (i) => {
      const html = need(i, "html");
      const selector = i.selector ? String(i.selector) : null;
      if (selector) validateSelector(selector);
      const doc = parseHtml(html).window.document;
      const root = selector ? doc.querySelector(selector) : doc.body || doc.documentElement;
      if (!root) return { text: "", chars: 0 };
      // Remove <script> and <style> — their contents aren't visible text.
      root.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
      // Block-level newlines: insert a marker after every block element so
      // textContent gives us paragraph separation without spelunking the tree.
      const BLOCK = "ARTICLE,SECTION,HEADER,FOOTER,NAV,ASIDE,MAIN,DIV,P,H1,H2,H3,H4,H5,H6,UL,OL,LI,BLOCKQUOTE,PRE,HR,TR,BR,TABLE,FIGURE,FIGCAPTION";
      const win = doc.defaultView;
      root.querySelectorAll(BLOCK).forEach((el) => el.appendChild(win.document.createTextNode("\n\n")));
      const text = (root.textContent || "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .split("\n").map((l) => l.trim()).join("\n")
        .trim();
      return { text, chars: text.length };
    },
  },
  // -------------------------------------------------------------------------
  {
    route: "POST /api/html-links", name: "HTML links", slug: "html-links",
    category: "web", price: "$0.001",
    description:
      "Enumerate every <a href> in an HTML string with its anchor text and rel attribute. Optionally resolves relative hrefs against a base URL and filters by a regex on the href. The deterministic way to crawl a page's outlinks without writing a regex.",
    tags: ["html", "links", "anchor", "outlinks", "scrape"],
    discovery: {
      bodyType: "json",
      input: { html: "<a href=\"/about\">About</a><a href=\"https://example.com\">External</a>", base: "https://agent402.tools" },
      inputSchema: {
        properties: {
          html: { type: "string", description: "Raw HTML string to scan (max 5MB)" },
          base: { type: "string", description: "Optional base URL to resolve relative hrefs against" },
          filter: { type: "string", description: "Optional regex applied to the href — only matching links are returned" },
          limit: { type: "number", description: "Max links to return, 1-1000 (default 200)" },
          unique: { type: "boolean", description: "Deduplicate by href (default true)" },
        },
        required: ["html"],
      },
      output: { example: { count: 2, links: [{ href: "https://agent402.tools/about", text: "About", rel: "" }, { href: "https://example.com/", text: "External", rel: "" }] } },
    },
    handler: (i) => {
      const html = need(i, "html");
      const base = i.base ? String(i.base) : null;
      let filterRe = null;
      if (i.filter) {
        try { filterRe = new RegExp(String(i.filter)); } catch (e) { throw bad(`"filter" is not a valid regex: ${e.message}`); }
      }
      const rawLimit = i.limit === undefined ? 200 : Number(i.limit);
      if (!Number.isFinite(rawLimit) || rawLimit < 1 || rawLimit > 1000) throw bad(`"limit" must be 1-1000`);
      const limit = Math.floor(rawLimit);
      const unique = i.unique !== false;

      const doc = parseHtml(html).window.document;
      const out = [];
      const seen = new Set();
      for (const a of doc.querySelectorAll("a[href]")) {
        const raw = a.getAttribute("href") || "";
        const href = resolveHref(raw, base);
        if (filterRe && !filterRe.test(href)) continue;
        if (unique && seen.has(href)) continue;
        seen.add(href);
        out.push({
          href,
          text: trimText(a.textContent, 200),
          rel: a.getAttribute("rel") || "",
        });
        if (out.length >= limit) break;
      }
      return { count: out.length, links: out };
    },
  },
  // -------------------------------------------------------------------------
  {
    route: "POST /api/html-meta", name: "HTML meta (from string)", slug: "html-meta",
    category: "web", price: "$0.001",
    description:
      "Extract <title>, <meta description>, OpenGraph/Twitter cards, canonical URL, and JSON-LD blocks from an HTML string. Distinct from /api/meta which fetches a URL — feed this the HTML you already have (from /api/render, /api/extract.body, or your own fetch).",
    tags: ["html", "meta", "opengraph", "twitter", "json-ld", "seo"],
    discovery: {
      bodyType: "json",
      input: { html: "<html><head><title>Hi</title><meta name=\"description\" content=\"x\"><meta property=\"og:title\" content=\"Hi OG\"></head><body></body></html>" },
      inputSchema: {
        properties: {
          html: { type: "string", description: "Raw HTML string to inspect (max 5MB)" },
        },
        required: ["html"],
      },
      output: { example: { title: "Hi", description: "x", og: { title: "Hi OG" }, twitter: {}, canonical: null, jsonLd: [] } },
    },
    handler: (i) => {
      const html = need(i, "html");
      const doc = parseHtml(html).window.document;
      const head = doc.head || doc.documentElement;
      const title = (doc.querySelector("title")?.textContent || "").trim() || null;
      const og = {}, twitter = {};
      let description = null;
      for (const m of head.querySelectorAll("meta")) {
        const name = (m.getAttribute("name") || "").toLowerCase();
        const prop = (m.getAttribute("property") || "").toLowerCase();
        const content = m.getAttribute("content") || "";
        if (!content) continue;
        if (name === "description" && !description) description = content;
        if (prop.startsWith("og:")) og[prop.slice(3)] = content;
        if (name.startsWith("twitter:")) twitter[name.slice(8)] = content;
      }
      const canonical = head.querySelector('link[rel="canonical"]')?.getAttribute("href") || null;
      // JSON-LD blocks: parse each <script type="application/ld+json">, skip
      // anything that doesn't parse (don't blow up the whole call on one bad
      // block). Cap to avoid pathological pages stuffing megabytes here.
      const jsonLd = [];
      for (const s of head.querySelectorAll('script[type="application/ld+json"]')) {
        if (jsonLd.length >= 25) break;
        const raw = (s.textContent || "").trim();
        if (!raw) continue;
        try { jsonLd.push(JSON.parse(raw)); } catch { /* skip malformed block */ }
      }
      return { title, description, og, twitter, canonical, jsonLd };
    },
  },
];
