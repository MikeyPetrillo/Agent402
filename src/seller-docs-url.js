// A seller's documentation link (an OpenAPI operation's `externalDocs.url`),
// as the index keeps it: seller-supplied and unverified, never fetched, and
// read for nothing but display on the exact seller record. It changes no
// price, quote, routing or payment.
//
// A link is kept only when it is a short printable-ASCII https URL with no
// fragment and no credentials, on exactly the seller origin's host and port
// (under its own path for a seller listed with a path), and when no reading
// of it trips the listing screen. The stored value is URL's serialization.
import { listingInjectionFinding } from "./listing-screen.js";

export const SELLER_DOCS_URL_MAX = 200;
export const SELLER_DOCS_URL_LEGEND = "sellerDocsUrl is a seller-supplied documentation link, read from the seller's own OpenAPI operation (externalDocs.url). It is unverified: the index never fetches it, and it changes no price, quote, routing or payment. It is kept only as an https link on the seller's exact host (under the seller's own path for a seller listed with a path), and a row the listing screen flags is served without it.";

// Printable ASCII with no space: what a kept link may hold, as written and as
// serialized.
const PRINTABLE = /^[\x21-\x7e]+$/;
const MAX_DECODE_LEVELS = 4;
// A "%" that does not start an escape.
const BARE_PERCENT = /%(?![0-9a-fA-F]{2})/;
// An escape of a dot, a slash or a backslash.
const PATH_ESCAPE = /%(?:2e|2f|5c)/i;
const NON_WORD_RUN = /[^\p{L}\p{N}]+/gu;
const CAMEL = /(\p{Ll})(\p{Lu})/gu;

/** The text with every run of non-letter, non-digit characters as a space. */
const asWords = (s) => s.replace(NON_WORD_RUN, " ").trim();

/** The link as written and each percent-decoded level until it is stable (at
 *  most MAX_DECODE_LEVELS decodes), or null when it needs more levels, holds
 *  a "%" that is not an escape, or decodes to bytes that are not UTF-8. */
function decodedLevels(raw) {
  const levels = [raw];
  let cur = raw;
  for (let i = 0; i <= MAX_DECODE_LEVELS; i++) {
    if (!cur.includes("%")) return levels;
    if (i === MAX_DECODE_LEVELS) return null;
    if (BARE_PERCENT.test(cur)) return null;
    let next;
    try { next = decodeURIComponent(cur); } catch { return null; }
    if (next === cur) return levels;
    levels.push(next);
    cur = next;
  }
  return levels;
}

/** True when any reading of the link reads as an instruction to the listing
 *  screen: as written, each decoded level, each with its punctuation read as
 *  spaces, and each of those with camelCase boundaries split into words. */
function readsAsInstruction(link) {
  const levels = decodedLevels(link);
  if (!levels) return true;
  for (const level of levels) {
    const words = asWords(level);
    const readings = new Set([level, words, asWords(level.replace(CAMEL, "$1 $2"))]);
    for (const r of readings) if (r && listingInjectionFinding(r)) return true;
  }
  return false;
}

/** The seller key's own path ("" for a bare origin), with no trailing slash. */
function sellerPathOf(origin) {
  return origin.pathname.replace(/\/+$/, "");
}

/**
 * The link to keep for `raw` on a row of the seller `originUrl`, as URL's
 * serialization, or null when the link is refused.
 */
export function sellerDocsUrlFor(raw, originUrl) {
  if (typeof raw !== "string" || !raw || raw.length > SELLER_DOCS_URL_MAX) return null;
  if (!PRINTABLE.test(raw) || raw.includes("#")) return null;
  if (typeof originUrl !== "string" || !originUrl) return null;
  let origin, url;
  try { origin = new URL(originUrl); } catch { return null; }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return null;
  // An absolute https link only: a relative or protocol-relative one would
  // resolve against nothing here, and URL refuses it without a base.
  if (!/^https:\/\//i.test(raw)) return null;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  if (url.host !== origin.host) return null;
  const prefix = sellerPathOf(origin);
  if (prefix) {
    // A path seller shares its host: the link stays under its own path, read
    // after dot segments are resolved, with no escaped separator or dot and
    // no backslash that could spell its way out.
    if (raw.includes("\\") || PATH_ESCAPE.test(url.pathname) || PATH_ESCAPE.test(raw.split("?")[0])) return null;
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  }
  const href = url.href;
  if (href.length > SELLER_DOCS_URL_MAX || !PRINTABLE.test(href) || href.includes("#")) return null;
  if (readsAsInstruction(raw) || (href !== raw && readsAsInstruction(href))) return null;
  return href;
}

/** `{ sellerDocsUrl }` from an OpenAPI operation's externalDocs, or {}.
 *  `externalDocs.description` is never read. */
export function sellerDocsFieldOf(op, originUrl) {
  const docs = op?.externalDocs;
  if (!docs || typeof docs !== "object" || Array.isArray(docs)) return {};
  const url = sellerDocsUrlFor(docs.url, originUrl);
  return url ? { sellerDocsUrl: url } : {};
}

// One check per stored row and origin, remembered with the row: a repeated
// lookup of the same record does no link work, and a changed link or origin
// is checked again.
const checked = new WeakMap();
/** `{ sellerDocsUrl }` for a stored row of `originUrl`, or {}. */
export function storedSellerDocsField(row, originUrl) {
  if (!row || typeof row !== "object") return {};
  const raw = row.sellerDocsUrl;
  if (raw === undefined) return {};
  const memo = checked.get(row);
  if (memo && memo.raw === raw && memo.origin === originUrl) return memo.field;
  const url = sellerDocsUrlFor(raw, originUrl);
  const field = url ? { sellerDocsUrl: url } : {};
  checked.set(row, { raw, origin: originUrl, field });
  return field;
}
