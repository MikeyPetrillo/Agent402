// Web-content kit — link-level web utilities for agents: Wayback Machine
// snapshot lookup (archive-snapshot), RSS/Atom feed parsing (feed-parse), and
// redirect-chain resolution (unshorten-url).
//
// Every upstream is KEYLESS — no new env vars. All three tools reach the
// network and live in WALLET_ONLY_SLUGS.
//
// SSRF: feed-parse fetches a caller URL and rides safeFetch/assertPublicUrl
// end-to-end. unshorten-url follows a caller URL's redirect chain manually —
// EVERY hop is re-validated with assertPublicUrl before its request is made,
// and every connect (including any transparent hop) goes through
// ssrfDispatcher's guardedLookup, so a public URL that redirects into a
// private address is blocked at the hop, not just at the front door.
// archive-snapshot only ever connects to fixed public archive hosts —
// archive.org, or its Memento-aggregator fallback memgator.cs.odu.edu (the
// caller URL rides as a query parameter / path segment, it is never fetched)
// — but still parses/validates it and rides the guarded dispatcher by
// convention.
//
// Parsing is pure and deterministic (jsdom DOMParser, the same XML path
// xml-to-json uses in kit.js) — no LLM anywhere.
//
// Covered by scripts/test-web-kit.js (offline validation; live upstream
// checks opt-in via WEB_LIVE_TEST=1).

import { JSDOM } from "jsdom";
import { ssrfDispatcher, safeFetch, assertPublicUrl, isSsrfBlock, retryTransient } from "./fetch-guard.js";

import { REPO_URL } from "../repo-link.js";
const USER_AGENT = "Mozilla/5.0 (compatible; Agent402/1.0; +${REPO_URL})";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Caller-supplied URL: trim, cap, require http(s) shape. Full public-address
// validation happens in assertPublicUrl / safeFetch at fetch time — this is
// just the cheap syntactic gate shared by all three handlers. Returns the
// TRIMMED ORIGINAL string, not the re-serialized URL: `new URL().href`
// appends a trailing slash to bare origins, and the Wayback availability API
// treats "https://example.com/" and "https://example.com" as different keys
// (the slashed form can return an empty result where the raw form matches).
function takeUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw bad('"url" is required');
  if (s.length > 2048) throw bad('"url" is capped at 2048 characters');
  let url;
  try { url = new URL(s); } catch { throw bad('"url" is not a valid absolute URL'); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw bad("Only http(s) URLs are supported");
  return s;
}

// ============================================================================
// archive-snapshot — Wayback Machine availability API (keyless), with ODU's
// MemGator Memento aggregator as a diverse fallback.
// ============================================================================
const WAYBACK_TIMEOUT_MS = 12_000;
const MEMENTO_TIMEOUT_MS = 20_000;

async function waybackAvailable(url, timestamp) {
  const api = new URL("https://archive.org/wayback/available");
  api.searchParams.set("url", url);
  if (timestamp) api.searchParams.set("timestamp", timestamp);
  let res;
  try {
    res = await fetch(api, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(WAYBACK_TIMEOUT_MS),
      dispatcher: ssrfDispatcher,
    });
  } catch (err) {
    // Log the real transport cause before mapping to a buyer-facing 504 —
    // this catch used to be bare and discarded the evidence.
    console.warn(`[archive-snapshot] archive.org fetch failed: ${err.name}: ${err.message}`);
    throw bad("Wayback Machine did not respond - try again shortly", 504);
  }
  if (res.status === 429) throw bad("Wayback Machine rate limit reached - retry shortly", 503);
  if (!res.ok) throw bad(`Wayback Machine error (HTTP ${res.status})`, 502);
  try { return await res.json(); } catch { throw bad("Wayback Machine returned non-JSON", 502); }
}

// Fallback: MemGator at memgator.cs.odu.edu — a public Memento aggregator
// (same API family as the retired timetravel.mementoweb.org, which is NXDOMAIN
// as of 2026-07 — verified live) fanning out to ~13 web archives
// (archive.today, arquivo.pt, Perma.cc, several national libraries, and
// archive.org itself). Diverse infrastructure: even with archive.org fully
// down it answers from the other archives. Quirks, all verified live
// 2026-07-21: its front-end merges consecutive slashes so a scheme-carrying
// URI-R 404s — the scheme must be stripped; a datetime path segment is
// REQUIRED (current UTC time = "closest to now" = most recent) and must be an
// even-length YYYY[MM[DD[hh[mm[ss]]]]] prefix; response datetimes are ISO
// 8601; the archived HTTP status is not exposed (→ snapshot.status null). A
// MemGator 404 means "no archive holds a memento", not an outage → null.
async function mementoClosest(url, timestamp) {
  const ts = timestamp || new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const dt = ts.slice(0, ts.length - (ts.length % 2));
  const bare = url.replace(/^https?:\/\//i, "");
  let res;
  try {
    res = await fetch(`https://memgator.cs.odu.edu/memento/json/${dt}/${bare}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(MEMENTO_TIMEOUT_MS),
      dispatcher: ssrfDispatcher,
    });
  } catch (err) {
    console.warn(`[archive-snapshot] memgator.cs.odu.edu fetch failed: ${err.name}: ${err.message}`);
    throw bad("Memento aggregator did not respond - try again shortly", 504);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw bad(`Memento aggregator error (HTTP ${res.status})`, 502);
  try { return await res.json(); } catch { throw bad("Memento aggregator returned non-JSON", 502); }
}

// ============================================================================
// feed-parse — fetch + parse RSS 2.0 / Atom / RSS 1.0 (RDF) into normal JSON.
// ============================================================================
const FEED_MAX_BYTES = 3 * 1024 * 1024;
const FEED_MAX_ITEMS = 50;
const FEED_DEFAULT_ITEMS = 20;
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
// kit.js xml-to-json: DOMParser is superlinear in depth and a hostile feed
// could block the event loop.
function assertSaneNesting(text) {
  let depth = 0, maxDepth = 0;
  for (const m of text.matchAll(/<(\/)?[A-Za-z!?][^>]*?(\/)?>/g)) {
    if (m[1]) depth = Math.max(0, depth - 1);
    else if (!m[2] && !m[0].startsWith("<!") && !m[0].startsWith("<?")) { depth++; if (depth > maxDepth) maxDepth = depth; }
  }
  if (maxDepth > 256) throw bad("Feed XML nesting too deep (max 256 levels)", 422);
}

function parseFeedXml(text, warnings) {
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

// ============================================================================
// unshorten-url — follow a redirect chain manually, re-guarding every hop.
// ============================================================================
const MAX_REDIRECTS = 5;
const HOP_TIMEOUT_MS = 8_000;
const CHAIN_BUDGET_MS = 20_000;

async function fetchHop(url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: ssrfDispatcher,
    });
  } catch (err) {
    if (isSsrfBlock(err)) throw bad("URL resolves to a private address");
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    throw bad(timedOut ? "A hop in the redirect chain did not respond in time" : `Could not connect to a hop in the redirect chain: ${err.message}`, 504);
  }
  // Headers are all we need — never download the body.
  try { res.body?.cancel()?.catch?.(() => {}); } catch { /* already settled */ }
  return { status: res.status, location: res.headers.get("location") };
}

// ============================================================================
export const WEB_TOOLS = [
  {
    route: "POST /api/archive-snapshot",
    name: "Wayback Machine snapshot",
    slug: "archive-snapshot", aliases: ["wayback", "website-history", "site-history"],
    category: "web",
    price: "$0.003",
    description:
      "Look up a URL in the Internet Archive's Wayback Machine: returns the archived snapshot closest to an optional timestamp (default: most recent), with the snapshot URL, capture time, and archived HTTP status. Useful for citations, dead-link recovery, and checking what a page said at a point in time. URLs never archived return {available:false}.",
    tags: ["web", "archive", "wayback", "snapshot", "history", "citation", "research"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "The URL to look up in the Wayback Machine" },
          timestamp: { type: "string", description: "Optional target time, 4-14 digits (YYYY, YYYYMM, YYYYMMDD, … up to YYYYMMDDhhmmss) - returns the snapshot closest to it" },
        },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://example.com",
          requestedTimestamp: null,
          available: true,
          snapshot: { url: "http://web.archive.org/web/20260101000000/https://example.com/", timestamp: "20260101000000", status: "200" },
          source: "web.archive.org",
        },
      },
    },
    handler: async (i) => {
      const url = takeUrl(i.url);
      let timestamp = null;
      if (i.timestamp !== undefined && i.timestamp !== null && i.timestamp !== "") {
        timestamp = String(i.timestamp).trim();
        if (!/^\d{4,14}$/.test(timestamp)) throw bad('"timestamp" must be 4-14 digits (e.g. 2020, 202001, 20200115)');
      }
      let data;
      try {
        data = await waybackAvailable(url, timestamp);
      } catch (err) {
        console.warn(`[archive-snapshot] archive.org failed (${err.message}) - falling back to memgator.cs.odu.edu`);
        let m;
        try {
          m = await mementoClosest(url, timestamp);
        } catch (err2) {
          // Both archives down — keep the Wayback error's status semantics
          // (504/503/502) but carry both causes in the message.
          throw bad(`${err.message}; Memento fallback also failed: ${err2.message}`, err.statusCode || 502);
        }
        const mClosest = m?.mementos?.closest;
        const mAvailable = typeof mClosest?.uri === "string" && mClosest.uri.length > 0;
        return {
          url,
          requestedTimestamp: timestamp,
          available: mAvailable,
          snapshot: mAvailable
            ? {
                url: mClosest.uri,
                // ISO 8601 → Wayback's 14-digit form, matching the primary path.
                timestamp: mClosest.datetime ? mClosest.datetime.replace(/\D/g, "").slice(0, 14) : null,
                status: null,
              }
            : null,
          source: "memgator.cs.odu.edu",
        };
      }
      const closest = data?.archived_snapshots?.closest;
      const available = closest?.available === true && typeof closest?.url === "string";
      if (!available) {
        // An EMPTY Wayback answer is not "never archived": the availability
        // API returns `archived_snapshots: {}` under load and answered exactly
        // that for wikipedia.org@2015 on the 2026-09-07 nightly (5.1 s, a 200),
        // while the same query answers a 2015-12-31 capture on retry. So an
        // empty answer asks the Memento aggregator before it is believed; a
        // memento found there is the answer, and only two archives agreeing
        // on "nothing" reads as not archived - named as such in `source`.
        let m = null, mementoAsked = false;
        try { m = await mementoClosest(url, timestamp); mementoAsked = true; }
        catch (err) { console.warn(`[archive-snapshot] archive.org answered empty and memgator failed (${err.message}) - answering empty`); }
        const mClosest = m?.mementos?.closest;
        if (typeof mClosest?.uri === "string" && mClosest.uri.length > 0) {
          return {
            url,
            requestedTimestamp: timestamp,
            available: true,
            snapshot: {
              url: mClosest.uri,
              timestamp: mClosest.datetime ? mClosest.datetime.replace(/\D/g, "").slice(0, 14) : null,
              status: null,
            },
            source: "memgator.cs.odu.edu",
          };
        }
        return {
          url,
          requestedTimestamp: timestamp,
          available: false,
          snapshot: null,
          source: mementoAsked ? "web.archive.org+memgator.cs.odu.edu" : "web.archive.org",
          note: mementoAsked
            ? "neither web.archive.org nor the Memento aggregator (13 archives) holds a capture"
            : "web.archive.org holds no capture and the Memento aggregator could not be reached",
        };
      }
      return {
        url,
        requestedTimestamp: timestamp,
        available,
        snapshot: { url: closest.url, timestamp: closest.timestamp ?? null, status: closest.status ?? null },
        source: "web.archive.org",
      };
    },
  },

  {
    route: "POST /api/feed-parse",
    name: "RSS/Atom feed parser",
    slug: "feed-parse",
    category: "web",
    price: "$0.004",
    description:
      "Fetch an RSS 2.0, Atom, or RSS 1.0 feed URL and parse it into normalized JSON: feed title/description/link plus items (title, link, id, published, author, plain-text summary, categories). Deterministic pure-XML parse with a lenient recovery pass for common malformations (reported in a warnings array). Item count is bounded (default 20, max 50). SSRF-guarded.",
    tags: ["web", "rss", "atom", "feed", "parse", "monitoring", "news"],
    discovery: {
      bodyType: "json",
      input: { url: "https://hnrss.org/frontpage", limit: 5 },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Feed URL (RSS 2.0, Atom, or RSS 1.0/RDF)" },
          limit: { type: "number", description: "Max items to return, 1-50 (default 20)" },
        },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://hnrss.org/frontpage",
          format: "rss2",
          title: "Hacker News: Front Page",
          description: "Hacker News RSS",
          link: "https://news.ycombinator.com/",
          updated: null,
          itemCount: 30,
          items: [
            { title: "Show HN: …", link: "https://example.com/post", id: "https://news.ycombinator.com/item?id=1", published: "Mon, 13 Jul 2026 12:00:00 +0000", author: "someone", summary: "Article summary…", categories: [] },
          ],
          warnings: [],
        },
      },
    },
    handler: async (i) => {
      const url = takeUrl(i.url);
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || FEED_DEFAULT_ITEMS, 1), FEED_MAX_ITEMS);
      // One retry on a transient 502/503/504 - added 2026-08-12 after
      // feed-parse hit exactly this shape live in CI (a plain 15s timeout on
      // a caller-supplied feed URL, zero retries previously). Safe for a
      // caller-supplied URL too: retryTransient never retries a deterministic
      // 4xx, so a genuinely wrong/dead URL still fails fast.
      const { finalUrl, html: text } = await retryTransient(() => safeFetch(url, {
        maxBytes: FEED_MAX_BYTES,
        headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      }));
      assertSaneNesting(text);
      const warnings = [];
      const doc = parseFeedXml(text, warnings);
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
    },
  },

  {
    route: "POST /api/unshorten-url",
    name: "URL unshortener",
    slug: "unshorten-url",
    category: "web",
    price: "$0.002",
    description:
      "Follow a short link's redirect chain (bit.ly, t.co, youtu.be, tracking links, …) without downloading any page body: returns the final URL, the final HTTP status, and every hop with its status code and Location target. Capped at 5 redirects; every hop is SSRF-re-validated, so chains that dive into private networks are blocked. Lets agents pre-flight links before fetching or citing them.",
    tags: ["web", "url", "redirect", "unshorten", "short-link", "safety", "preflight"],
    discovery: {
      bodyType: "json",
      input: { url: "https://youtu.be/dQw4w9WgXcQ" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "The (short) URL whose redirect chain to follow" },
        },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://youtu.be/dQw4w9WgXcQ",
          finalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be",
          finalStatus: 200,
          redirects: 1,
          truncated: false,
          hops: [
            { url: "https://youtu.be/dQw4w9WgXcQ", status: 303, location: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be" },
            { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be", status: 200, location: null },
          ],
        },
      },
    },
    handler: async (i) => {
      const original = takeUrl(i.url);
      const deadline = Date.now() + CHAIN_BUDGET_MS;
      const hops = [];
      const seen = new Set();
      let current = original;
      let note;
      let truncated = false;

      for (let n = 0; ; n++) {
        // Re-validate EVERY hop (scheme + public DNS answer) before requesting
        // it; the guarded dispatcher then re-checks at connect time, closing
        // the rebinding race. The first hop's failure is the caller's error;
        // a later hop failing means the chain led somewhere blocked — report
        // the chain so far instead of erroring, that IS the pre-flight answer.
        let hopUrl;
        try {
          hopUrl = (await assertPublicUrl(current)).href;
        } catch (e) {
          if (n === 0) throw e;
          truncated = true;
          note = `Stopped at hop ${n}: ${e.message}`;
          break;
        }
        if (seen.has(hopUrl)) { truncated = true; note = "Redirect loop detected"; break; }
        seen.add(hopUrl);

        const budget = Math.min(HOP_TIMEOUT_MS, deadline - Date.now());
        if (budget <= 0) throw bad("Redirect chain exceeded the 20s time budget", 504);
        const { status, location } = await fetchHop(hopUrl, budget);
        const isRedirect = status >= 300 && status < 400 && !!location;
        let next = null;
        if (isRedirect) {
          try { next = new URL(location, hopUrl).href; } catch { next = null; }
        }
        hops.push({ url: hopUrl, status, location: next ?? (isRedirect ? location : null) });
        if (!isRedirect || next === null) break;
        if (next.startsWith("http:") === false && next.startsWith("https:") === false) {
          truncated = true;
          note = `Stopped: redirect target uses a non-http(s) scheme (${next.split(":")[0]}:)`;
          break;
        }
        if (n >= MAX_REDIRECTS) { truncated = true; note = `Stopped after ${MAX_REDIRECTS} redirects (cap)`; break; }
        current = next;
      }

      const last = hops[hops.length - 1];
      const finalUrl = truncated ? (last?.location || last?.url || original) : (last?.url || original);
      return {
        url: original,
        finalUrl,
        finalStatus: truncated ? null : (last?.status ?? null),
        redirects: hops.filter((h) => h.status >= 300 && h.status < 400).length,
        truncated,
        ...(note ? { note } : {}),
        hops,
      };
    },
  },
];
