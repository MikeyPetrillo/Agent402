// Web-content kit — link-level web utilities for agents: Wayback Machine
// snapshot links (archive-snapshot), RSS/Atom feed parsing (feed-parse), and
// redirect-chain resolution (unshorten-url).
//
// Every upstream is KEYLESS — no new env vars. feed-parse and unshorten-url
// reach the network; archive-snapshot computes its link and reaches none. All
// three are in WALLET_ONLY_SLUGS.
//
// SSRF: feed-parse fetches a caller URL and rides safeFetch/assertPublicUrl
// end-to-end. unshorten-url follows a caller URL's redirect chain manually —
// EVERY hop is re-validated with assertPublicUrl before its request is made,
// and every connect (including any transparent hop) goes through
// ssrfDispatcher's guardedLookup, so a public URL that redirects into a
// private address is blocked at the hop, not just at the front door.
// archive-snapshot connects to nothing: it validates the caller URL and
// answers the Wayback Machine link for it.
//
// Parsing is pure and deterministic (jsdom DOMParser, the same XML path
// xml-to-json uses in kit.js) — no LLM anywhere.
//
// Covered by scripts/test-web-kit.js (offline validation; live upstream
// checks opt-in via WEB_LIVE_TEST=1).

import { runHtml } from "./html-pool.js";
import { underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";
import { ssrfDispatcher, safeFetch, assertPublicUrl, isSsrfBlock, retryTransient } from "./fetch-guard.js";
import { assertRobotsAllow } from "./robots-gate.js";

// A tool fetching for its caller says so (src/user-agents.js).
import { FETCH_UA as USER_AGENT } from "../user-agents.js";
import { noteHostRequest } from "../seller-load.js"; // the request log /crawler describes

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
// archive-snapshot — the Wayback Machine link for a URL, computed here: the
// archive is not asked whether it holds a capture (no egress), so the answer
// says so (available null, checked false). Opening the link, the Wayback
// Machine serves the capture closest to the timestamp in it, or the most
// recent one for "2" (any capture from the year 2000 on is closer than none).
// ============================================================================
export const ARCHIVE_LINK_NOTE = "A link, not a lookup: the archive was not asked whether it holds a capture.";
export function waybackLink(url, timestamp) {
  return `https://web.archive.org/web/${timestamp || "2"}/${url}`;
}

// ============================================================================
// feed-parse — fetch + parse RSS 2.0 / Atom / RSS 1.0 (RDF) into normal JSON.
// ============================================================================
const FEED_MAX_BYTES = 3 * 1024 * 1024;
const FEED_MAX_ITEMS = 50;
const FEED_DEFAULT_ITEMS = 20;
// The parse and the walk run in the HTML worker (feedFromXml in
// ./xml-dom-ops.js, through runHtml), so the main thread never imports jsdom.

// ============================================================================
// unshorten-url — follow a redirect chain manually, re-guarding every hop.
// ============================================================================
const MAX_REDIRECTS = 5;
const HOP_TIMEOUT_MS = 8_000;
const CHAIN_BUDGET_MS = 20_000;

async function fetchHop(url, timeoutMs) {
  let res;
  try {
    noteHostRequest(String(url), "fetch");
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
      "Build the Internet Archive Wayback Machine link for a URL: snapshot.url opens the capture closest to an optional timestamp (default: the most recent). The link is computed here without querying the archive, so available is null and checked is false; opened, the Wayback Machine picks the capture or says the URL was never archived. For citations and dead-link recovery.",
    tags: ["web", "archive", "wayback", "snapshot", "history", "citation", "research"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com" },
      inputSchema: {
        properties: {
          url: { type: "string", maxLength: 2048, description: "The URL to build the Wayback Machine link for" },
          timestamp: { type: "string", description: "Optional target time, 4-14 digits (YYYY, YYYYMM, YYYYMMDD, … up to YYYYMMDDhhmmss) - the link opens the capture closest to it" },
        },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://example.com",
          requestedTimestamp: null,
          available: null,
          checked: false,
          snapshot: { url: "https://web.archive.org/web/2/https://example.com", timestamp: null, status: null },
          source: "web.archive.org",
          note: ARCHIVE_LINK_NOTE,
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
      // The same keys as the lookup this replaced; what only a lookup knows
      // (whether a capture exists, its time and archived status) reads null.
      return {
        url,
        requestedTimestamp: timestamp,
        available: null,
        checked: false,
        snapshot: { url: waybackLink(url, timestamp), timestamp: null, status: null },
        source: "web.archive.org",
        note: ARCHIVE_LINK_NOTE,
      };
    },
  },

  {
    route: "POST /api/feed-parse",
    name: "RSS/Atom feed parser",
    slug: "feed-parse",
    category: "web",
    price: "$0.001",
    description:
      "Fetch an RSS 2.0, Atom, or RSS 1.0 feed URL and parse it into normalized JSON: feed title/description/link plus items (title, link, id, published, author, plain-text summary, categories). Deterministic pure-XML parse with a lenient recovery pass for common malformations (reported in a warnings array). Item count is bounded (default 20, max 50). SSRF-guarded.",
    tags: ["web", "rss", "atom", "feed", "parse", "monitoring", "news"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools/changelog.xml", limit: 5 },
      inputSchema: {
        properties: {
          url: { type: "string", maxLength: 2048, description: "Feed URL (RSS 2.0, Atom, or RSS 1.0/RDF)" },
          limit: { type: "number", description: "Max items to return, 1-50 (default 20)" },
        },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://agent402.tools/changelog.xml",
          format: "rss2",
          title: "Agent402 Changelog",
          description: "Recent additions to Agent402: new tools, skill packs, framework adapters, and platform features.",
          link: "https://agent402.tools/changelog",
          updated: null,
          itemCount: 36,
          items: [
            { title: "Live payments view", link: "https://agent402.tools/changelog", id: "agent402-changelog-2026-09-30", published: "Wed, 30 Sep 2026 12:00:00 GMT", author: null, summary: "Item summary…", categories: [] },
          ],
          warnings: [],
        },
      },
    },
    handler: async (i) => {
      const url = takeUrl(i.url);
      const limit = Math.min(Math.max(parseInt(i.limit, 10) || FEED_DEFAULT_ITEMS, 1), FEED_MAX_ITEMS);
      await assertRobotsAllow(url);
      // One retry on a transient 502/503/504 - added 2026-08-12 after
      // feed-parse hit exactly this shape live in CI (a plain 15s timeout on
      // a caller-supplied feed URL, zero retries previously). Safe for a
      // caller-supplied URL too: retryTransient never retries a deterministic
      // 4xx, so a genuinely wrong/dead URL still fails fast.
      const { finalUrl, html: text } = await retryTransient(() => safeFetch(url, {
        maxBytes: FEED_MAX_BYTES,
        headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      }));
      return runHtml("feed", { text, finalUrl, limit }, Buffer.byteLength(String(text ?? "")));
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
      input: { url: "https://www.agent402.tools/" },
      inputSchema: {
        properties: {
          url: { type: "string", maxLength: 2048, description: "The (short) URL whose redirect chain to follow" },
        },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://www.agent402.tools/",
          finalUrl: "https://agent402.tools/",
          finalStatus: 200,
          redirects: 1,
          truncated: false,
          hops: [
            { url: "https://www.agent402.tools/", status: 301, location: "https://agent402.tools/" },
            { url: "https://agent402.tools/", status: 200, location: null },
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

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(WEB_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
