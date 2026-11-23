// The robots.txt gate for the catalog tools that return a caller-named page's
// content (extract, meta, render, screenshot, the PDF, image, media and audio
// readers that take a URL, feed-parse, fetch-json, favicon-grab, page-change,
// page-speed, html-frames' baseline read, site-map and the skill packs that
// read a page). Before the content fetch, the URL's origin's /robots.txt is
// read once (kept an hour per origin) and the URL's path is checked for the
// product token those tools send (Agent402-Fetch, src/user-agents.js) with
// kit.js's parseRobots/robotsAllows (RFC 9309: the longest matching rule
// decides, an Allow wins a tie). A group applies when its User-agent line
// names that token exactly (case-insensitive), or the brand token Agent402
// that names all of our agents, else the `*` groups do: a group for another
// product whose name is a part of ours (`Fetch`) is not ours. A disallowed
// path answers 403 with the rule that decided it, before anything else is
// fetched, so the call is never settled. A robots.txt that cannot be read (absent, an error status, a
// timeout, over the size cap, a host the address guard refuses) leaves the
// URL allowed and the tool's own fetch gives the answer it always gave.
//
// What is kept: per origin, in this process, the rules of the groups that can
// apply to our tokens (those naming us and the `*` groups), an hour (an
// unreadable file ten minutes); a set of rules over ROBOTS_CACHE_ENTRY_CHARS
// is used for its call and not kept. No page content passes through here.
// Covered by scripts/test-robots-gate.js.
//
// The parser is kit.js's, imported when first needed: kit.js imports this
// module, and extract.js (which render.js, and so the browser worker, loads)
// does too, so a static import would load the whole kit into the worker.
import { safeFetch } from "./fetch-guard.js";
import { FETCH_TOKEN, FETCH_UA, SITE_CRAWL_TOKEN, SITE_CRAWL_UA } from "../user-agents.js";
import { ceilingPassed, ceilingCutError } from "../run-ceiling.js";

export const ROBOTS_CACHE_MS = 60 * 60 * 1000;
export const ROBOTS_UNREADABLE_CACHE_MS = 10 * 60 * 1000;
export const ROBOTS_MAX_BYTES = 500 * 1024;
export const ROBOTS_TIMEOUT_MS = 4000;
export const ROBOTS_CACHE_MAX_ORIGINS = 2000;
export const ROBOTS_CACHE_ENTRY_CHARS = 32 * 1024;
/** The reason code a refusal carries (src/tool-error-fields.js). */
export const ROBOTS_DISALLOWED = "robots_disallowed";
const RULE_MAX_CHARS = 200;
/** A group naming the brand alone applies to every one of our agents. */
export const ROBOTS_BRAND_TOKEN = "Agent402";

/** The catalog tools whose URL read passes this gate (the skill packs built
 *  on them inherit it, and the packs' own page and file reads pass it too).
 *  scripts/test-robots-gate.js drives each one against a disallowed URL. */
export const ROBOTS_GATED_SLUGS = Object.freeze([
  "extract", "meta", "render", "screenshot", "pdf", "pdf-to-markdown", "pdf-summarize",
  "pdf-info", "pdf-merge", "pdf-extract-pages", "pdf-rotate", "images-to-pdf",
  "media-info", "audio-convert", "audio-normalize", "transcribe", "transcribe-pro", "transcribe-long",
  "image-ocr", "image-exif", "image-dominant-color", "image-crop",
  "feed-parse", "fetch-json", "favicon-grab", "page-change", "page-speed", "html-frames", "site-map",
]);

let robotsLib = null;
const robotsParser = async () => (robotsLib ||= await import("./kit.js"));

const cache = new Map(); // origin -> { groups | null, expires }
const inflight = new Map(); // origin -> Promise<groups | null>
let fetchRobots = defaultFetchRobots;

// robots.txt is read with the string of the tool asking: site-map's own
// (it reads the start page as the site-crawl agent), else the fetch string.
async function defaultFetchRobots(robotsUrl, token = FETCH_TOKEN) {
  const { html } = await safeFetch(robotsUrl, {
    maxBytes: ROBOTS_MAX_BYTES,
    timeoutMs: ROBOTS_TIMEOUT_MS,
    userAgent: token === SITE_CRAWL_TOKEN ? SITE_CRAWL_UA : FETCH_UA,
    headers: { Accept: "text/plain, */*;q=0.5" },
  });
  return String(html ?? "");
}

// The groups any of our tokens can match: those naming a token of ours
// (exactly, or the brand) and the `*` groups. The rest are dropped before
// anything is kept.
const OUR_TOKENS = new Set([ROBOTS_BRAND_TOKEN, FETCH_TOKEN, SITE_CRAWL_TOKEN].map((t) => t.toLowerCase()));
function ourGroups(groups) {
  return groups.filter((g) => g.agents.some((a) => a === "*" || OUR_TOKENS.has(String(a).split(/[\s/]/)[0])));
}
const sizeOf = (groups) => groups.reduce((n, g) => n + g.agents.join("").length + g.rules.reduce((m, r) => m + r.path.length + 1, 0), 0);

function remember(origin, groups, now) {
  if (groups && sizeOf(groups) > ROBOTS_CACHE_ENTRY_CHARS) return;
  if (cache.size >= ROBOTS_CACHE_MAX_ORIGINS && !cache.has(origin)) {
    // Oldest first (Map keeps insertion order).
    cache.delete(cache.keys().next().value);
  }
  cache.delete(origin);
  cache.set(origin, { groups, expires: now + (groups ? ROBOTS_CACHE_MS : ROBOTS_UNREADABLE_CACHE_MS) });
}

/** The parsed robots.txt groups for an origin, or null when it cannot be read. */
async function groupsFor(origin, token) {
  const now = Date.now();
  const hit = cache.get(origin);
  if (hit && hit.expires > now) return hit.groups;
  let p = inflight.get(origin);
  if (!p) {
    p = (async () => {
      try {
        const text = await fetchRobots(`${origin}/robots.txt`, token);
        const groups = ourGroups((await robotsParser()).parseRobots(text));
        remember(origin, groups, Date.now());
        return groups;
      } catch (e) {
        // A read the run's ceiling ended (src/run-ceiling.js) says nothing
        // about the file: not kept, and each waiter decides by its own run.
        if (e?.ceilingCut || ceilingPassed()) return undefined;
        remember(origin, null, Date.now());
        return null;
      }
    })();
    inflight.set(origin, p);
    p.finally(() => { if (inflight.get(origin) === p) inflight.delete(origin); }).catch(() => {});
  }
  const groups = await p;
  if (groups === undefined) {
    if (ceilingPassed()) throw ceilingCutError();
    return null;
  }
  return groups;
}

function printableRule(rule) {
  const s = String(rule ?? "").replace(/[^\x20-\x7e]/g, "?");
  return s.length > RULE_MAX_CHARS ? `${s.slice(0, RULE_MAX_CHARS - 3)}...` : s;
}

// The groups that speak to `token`: each group's agents narrowed to the ones
// that name it exactly (its product token: the line's value up to a space or
// "/"), the brand token or "*". robotsAllows then reads named groups first and
// the "*" groups only when no group names us, as before.
export function groupsForToken(groups, token) {
  const want = new Set([String(token).toLowerCase(), ROBOTS_BRAND_TOKEN.toLowerCase()]);
  return groups.map((g) => ({
    ...g,
    agents: g.agents.filter((a) => a === "*" || want.has(String(a).split(/[\s/]/)[0])).map((a) => (a === "*" ? a : String(token).toLowerCase())),
  }));
}

/** The 403 a disallowed URL answers. */
export function robotsRefusal({ robotsUrl, rule, token = FETCH_TOKEN }) {
  const r = printableRule(rule);
  return Object.assign(
    new Error(`This site's robots.txt (${robotsUrl}) does not allow ${token} to read this URL (${r}), so it was not fetched`),
    {
      statusCode: 403,
      hint: "robots-disallowed",
      robotsDisallowed: true,
      robotsRule: r,
      robotsUrl,
      fix: `The site asks ${token} not to read this path. Send a URL whose robots.txt allows ${token}.`,
    },
  );
}

/**
 * Refuse (403, before any content fetch) a caller-named URL whose origin's
 * robots.txt disallows `token` for its path. A value that is not an absolute
 * http(s) URL is left to the tool's own input check, so its answer does not
 * change. Returns { allowed, rule } when allowed.
 */
export async function assertRobotsAllow(rawUrl, { token = FETCH_TOKEN } = {}) {
  let url;
  try { url = new URL(String(rawUrl ?? "").trim()); } catch { return { allowed: true, rule: null, checked: false }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { allowed: true, rule: null, checked: false };
  const groups = await groupsFor(url.origin, token);
  if (!groups) return { allowed: true, rule: null, checked: true };
  const { allowed, matchedRule } = (await robotsParser()).robotsAllows(groupsForToken(groups, token), token, url.pathname + url.search);
  if (!allowed) throw robotsRefusal({ robotsUrl: `${url.origin}/robots.txt`, rule: matchedRule, token });
  return { allowed: true, rule: matchedRule, checked: true };
}

/** True when an error is this gate's refusal. */
export function isRobotsRefusal(err) {
  return err?.robotsDisallowed === true;
}

export const __test = {
  setFetchRobots(fn) { fetchRobots = typeof fn === "function" ? fn : defaultFetchRobots; },
  clear() { cache.clear(); inflight.clear(); },
  cacheSize: () => cache.size,
  cacheEntry: (origin) => cache.get(origin) || null,
};
