// The XML and selector work that needs a DOM (jsdom), run as named operations
// of the HTML worker (./html-worker-ops.js, reached through runHtml in
// ./html-pool.js), so the main thread never imports jsdom: the import alone is
// one synchronous turn of about 200 ms on a laptop (more on a slower core), and
// a parse of a large feed is tens of milliseconds more. Moved here unchanged
// from web-kit.js (feed-parse), kit.js (xml-to-json) and page-change-kit.js
// (the selector check); every result is plain data.
import { loadJsdom } from "./lazy-deps.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// ============================================================================
// feed-parse: RSS 2.0 / Atom / RSS 1.0 (RDF) into normal JSON.
// ============================================================================
const TEXT_CAP = 2000;

// Match children by XML localName so namespace prefixes never matter
// (dc:creator → "creator", atom:link → "link", content:encoded → "encoded").
const childrenOf = (el, name) => Array.from(el.children ?? []).filter((c) => c.localName === name);
const firstChild = (el, ...names) => {
  for (const name of names) {
    const hit = childrenOf(el, name)[0];
    if (hit) return hit;
  }
  return null;
};
const childText = (el, ...names) => {
  const hit = firstChild(el, ...names);
  const s = hit?.textContent?.trim();
  return s ? s : null;
};

// Deterministic HTML-strip for description/summary fields — feeds routinely
// embed markup there and agents want prose, not tags.
function stripTags(s) {
  if (!s) return null;
  const out = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return out ? out.slice(0, TEXT_CAP) : null;
}

// Atom <link> is an attribute carrier: prefer rel="alternate" (or no rel),
// fall back to the first link with an href.
function atomLink(el) {
  const links = childrenOf(el, "link");
  const alt = links.find((l) => !l.getAttribute("rel") || l.getAttribute("rel") === "alternate");
  return (alt || links[0])?.getAttribute("href") || null;
}

// Cheap O(n) nesting guard before jsdom sees the document — same rationale as
// xml-to-json below: DOMParser is superlinear in depth and a hostile feed
// could hold the thread.
function assertSaneNesting(text) {
  let depth = 0, maxDepth = 0;
  for (const m of text.matchAll(/<(\/)?[A-Za-z!?][^>]*?(\/)?>/g)) {
    if (m[1]) depth = Math.max(0, depth - 1);
    else if (!m[2] && !m[0].startsWith("<!") && !m[0].startsWith("<?")) { depth++; if (depth > maxDepth) maxDepth = depth; }
  }
  if (maxDepth > 256) throw bad("Feed XML nesting too deep (max 256 levels)", 422);
}

async function parseFeedXml(text, warnings) {
  const JSDOM = await loadJsdom();
  const dom = new JSDOM("");
  const parse = (t) => {
    const doc = new dom.window.DOMParser().parseFromString(t, "text/xml");
    return doc.querySelector("parsererror") ? null : doc;
  };
  let doc = parse(text);
  if (!doc) {
    // Lenient recovery pass for the two malformations that dominate real-world
    // feeds: raw control characters and unescaped ampersands. Deterministic —
    // same input always yields the same recovered document.
    const repaired = text
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, "&amp;");
    doc = parse(repaired);
    if (doc) warnings.push("Feed XML was malformed (control characters or unescaped ampersands) - recovered with a lenient pass.");
  }
  if (!doc) throw bad("URL did not return parseable RSS/Atom XML", 422);
  return doc;
}

function rssItem(item) {
  return {
    title: childText(item, "title"),
    link: childText(item, "link") || firstChild(item, "link")?.getAttribute?.("href") || null,
    id: childText(item, "guid") || null,
    published: childText(item, "pubDate", "date") || null,
    author: childText(item, "creator", "author") || null,
    summary: stripTags(childText(item, "description", "encoded")),
    categories: childrenOf(item, "category").map((c) => c.textContent.trim()).filter(Boolean).slice(0, 10),
  };
}

function atomItem(entry) {
  const author = firstChild(entry, "author");
  return {
    title: childText(entry, "title"),
    link: atomLink(entry),
    id: childText(entry, "id"),
    published: childText(entry, "published", "updated"),
    author: (author && childText(author, "name")) || null,
    summary: stripTags(childText(entry, "summary", "content")),
    categories: childrenOf(entry, "category").map((c) => c.getAttribute("term") || c.textContent.trim()).filter(Boolean).slice(0, 10),
  };
}

/** feed-parse's answer for a fetched feed body: `{ url, format, title, ... }`. */
export async function feedFromXml(text, finalUrl, limit) {
  assertSaneNesting(text);
  const warnings = [];
  const doc = await parseFeedXml(text, warnings);
  const root = doc.documentElement;
  const rootName = root.localName;

  let format, title, description, link, updated, allItems, mapItem;
  if (rootName === "rss") {
    const channel = firstChild(root, "channel");
    if (!channel) throw bad("RSS document has no <channel> element", 422);
    format = "rss2";
    title = childText(channel, "title");
    description = childText(channel, "description");
    link = childText(channel, "link");
    updated = childText(channel, "lastBuildDate", "pubDate");
    allItems = childrenOf(channel, "item");
    mapItem = rssItem;
  } else if (rootName === "feed") {
    format = "atom";
    title = childText(root, "title");
    description = childText(root, "subtitle");
    link = atomLink(root);
    updated = childText(root, "updated");
    allItems = childrenOf(root, "entry");
    mapItem = atomItem;
  } else if (rootName === "RDF") {
    // RSS 1.0: <channel> metadata + <item> siblings, all direct children of rdf:RDF.
    const channel = firstChild(root, "channel");
    format = "rss1";
    title = channel ? childText(channel, "title") : null;
    description = channel ? childText(channel, "description") : null;
    link = channel ? childText(channel, "link") : null;
    updated = channel ? childText(channel, "date") : null;
    allItems = childrenOf(root, "item");
    mapItem = rssItem;
  } else {
    throw bad(`URL returned XML, but not a recognizable feed (root element <${rootName}> - expected <rss>, <feed>, or <rdf:RDF>)`, 422);
  }

  return {
    url: finalUrl,
    format,
    title: title ?? null,
    description: description ?? null,
    link: link ?? null,
    updated: updated ?? null,
    itemCount: allItems.length,
    items: allItems.slice(0, limit).map(mapItem),
    warnings,
  };
}

// ============================================================================
// xml-to-json: an XML document as a JSON object tree.
// ============================================================================
function xmlNodeToJson(node) {
  const children = [...node.children];
  const attrs = {};
  for (const a of node.attributes ?? []) attrs[a.name] = a.value;
  const base = Object.keys(attrs).length ? { _attrs: attrs } : {};
  if (!children.length) {
    const text = node.textContent.trim();
    return Object.keys(base).length ? { ...base, _text: text } : text;
  }
  const out = { ...base };
  for (const child of children) {
    const val = xmlNodeToJson(child);
    if (out[child.tagName] === undefined) out[child.tagName] = val;
    else {
      if (!Array.isArray(out[child.tagName])) out[child.tagName] = [out[child.tagName]];
      out[child.tagName].push(val);
    }
  }
  return out;
}

/** xml-to-json's answer `{ json }`, serialized: the tree is built on plain
 *  objects keyed by element names, so an element named like an Object
 *  method (constructor, toString) can put a function in it, which a thread
 *  message cannot carry and which JSON writes as null. The caller parses the
 *  text back, so the answer it sends is the bytes it sent before. */
export async function xmlToJsonText(text) {
  // Guard against deeply-nested XML: JSDOM's parse is superlinear in depth and
  // can hold the thread for tens of seconds. Reject pathological nesting
  // cheaply (single O(n) scan) before handing it to the parser.
  let depth = 0, maxDepth = 0;
  for (const m of text.matchAll(/<(\/)?[A-Za-z!?][^>]*?(\/)?>/g)) {
    if (m[1]) depth = Math.max(0, depth - 1);
    else if (!m[2] && !m[0].startsWith("<!") && !m[0].startsWith("<?")) { depth++; if (depth > maxDepth) maxDepth = depth; }
  }
  if (maxDepth > 256) throw bad("XML nesting too deep (max 256 levels)");
  const JSDOM = await loadJsdom();
  const dom = new JSDOM("");
  const doc = new dom.window.DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw bad("XML parse error");
  const root = doc.documentElement;
  return JSON.stringify({ json: { [root.tagName]: xmlNodeToJson(root) } });
}

// ============================================================================
// A CSS selector checked against an empty document (page-change).
// ============================================================================
export async function checkSelector(s) {
  const JSDOM = await loadJsdom();
  try { new JSDOM("<!doctype html><html><body></body></html>").window.document.querySelector(s); }
  catch (e) { throw bad(`invalid CSS selector "${s}": ${e.message}`); }
  return true;
}
