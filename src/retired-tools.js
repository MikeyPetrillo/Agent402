// Retired catalog routes answer 410 Gone, naming the replacement.
//
// A retired tool used to answer the generic 404 the unknown-/api handler
// serves for guessed slugs. Third-party indexes and probes keep a route long
// after we retire it (the Bazaar carries a row until it ages out, census
// crawlers grade what the Bazaar once listed), and a 404 reads to them as a
// broken seller: "no 402, no envelope, no challenge" is the verdict one census
// mailed us on 2026-09-22 for a route retired two days earlier. A 410 says
// "gone on purpose", which is the truth, and carries the replacement so a
// buyer holding the old route can move in one step. The retired pairwise
// converters already answer this way (server.js, RETIRED_CONVERT_API_RE);
// this registry covers every other retirement.
//
// Two rules, both checked at boot by assertRetiredRegistryConsistent: a slug
// listed here must NOT be live in the catalog (a restored tool must leave
// this list, or its route would be shadowed), and a named replacement MUST be
// live (a 410 that points at another 404 is worse than no pointer).
//
// A third rule is checked in CI (scripts/test-retired-routes.js against
// scripts/published-slugs.json): every route we ever published is live,
// listed only with a key, or listed here. Retiring a route without an entry
// here fails that test.

/** Tools: /api/<slug>. `replacement` is a live catalog slug or null. */
export const RETIRED_TOOLS = Object.freeze({
  // 2026-09-24: the Polymarket tools. The nearest live question is a Kalshi
  // read; a Kalshi market is a different venue, so each names the closest tool.
  "polymarket-search": { retiredAt: "2026-09-24", replacement: "kalshi-markets" },
  "polymarket-market": { retiredAt: "2026-09-24", replacement: "kalshi-event" },
  "polymarket-orderbook": { retiredAt: "2026-09-24", replacement: "kalshi-markets" },
  "polymarket-price-history": { retiredAt: "2026-09-24", replacement: "kalshi-live-data" },
  // 2026-09-22: the paid explorer upstream these five bought per call was
  // removed. Where another live tool answers the nearest question it is named;
  // no live EVM tool ranks a token's holders, so token-holders names none.
  "contract-inspect": { retiredAt: "2026-09-22", replacement: "contract-source" },
  "address-profile": { retiredAt: "2026-09-22", replacement: "wallet-balance" },
  "token-info": { retiredAt: "2026-09-22", replacement: "token-metadata" },
  "token-holders": { retiredAt: "2026-09-22", replacement: null },
  "tx-inspect": { retiredAt: "2026-09-22", replacement: "tx-receipt" },
  // 2026-09-20: equities moved onto a licensed feed that serves none of these.
  "options-chain": { retiredAt: "2026-09-20", replacement: "crypto-options-chain" },
  "premarket-quote": { retiredAt: "2026-09-20", replacement: "stock-quote" },
  "stock-dividends": { retiredAt: "2026-09-20", replacement: null },
  "earnings-calendar": { retiredAt: "2026-09-20", replacement: null },
  "dividend-calendar": { retiredAt: "2026-09-20", replacement: null },
  // 2026-09-11: a composite that never sold; the company-dossier pack runs the
  // same five calls.
  "research-company": { retiredAt: "2026-09-11", replacement: "skill-company-dossier" },
  // 2026-09-03: outbound messaging, withdrawn the day it shipped.
  "email-send": { retiredAt: "2026-09-03", replacement: null },
  "sms-send": { retiredAt: "2026-09-03", replacement: null },
  "voice-call": { retiredAt: "2026-09-03", replacement: null },
  // 2026-08-26: the upstream went key-only.
  "price-pyth": { retiredAt: "2026-08-26", replacement: "price-coingecko" },
  // 2026-08-25: the free-tier retirement (zero external use in 30 days).
  "calendar-diff": { retiredAt: "2026-08-25", replacement: "business-days" },
  "case-convert": { retiredAt: "2026-08-25", replacement: null },
  "char-frequency": { retiredAt: "2026-08-25", replacement: null },
  "cron-explain": { retiredAt: "2026-08-25", replacement: "cron-next" },
  "jaccard-similarity": { retiredAt: "2026-08-25", replacement: null },
  "lorem-ipsum": { retiredAt: "2026-08-25", replacement: null },
  "slug-generate": { retiredAt: "2026-08-25", replacement: "slugify" },
  "string-similarity": { retiredAt: "2026-08-25", replacement: null },
  "text-similarity": { retiredAt: "2026-08-25", replacement: null },
  "word-frequency": { retiredAt: "2026-08-25", replacement: null },
  "word-wrap": { retiredAt: "2026-08-25", replacement: null },
  "workday-count": { retiredAt: "2026-08-25", replacement: "business-days" },
  // The same cut emptied the encoding, math, string and color kits.
  "color-convert": { retiredAt: "2026-08-25", replacement: "color" },
  "xml-validate": { retiredAt: "2026-08-25", replacement: "xml-to-json" },
  ...Object.fromEntries([
    "base-detect", "binary-text", "braille-convert", "color-blindness", "color-contrast", "color-name",
    "color-palette", "combinatorics", "constant-compare", "gcd-lcm", "group-by", "hkdf-expand", "ipv6-expand",
    "json-to-xml", "matrix-multiply", "mod-arithmetic", "nato-phonetic", "pbkdf2", "phone-format",
    "prime-factorize", "punycode-convert", "scrypt-derive", "soundex", "uuid-v5",
  ].map((s) => [s, { retiredAt: "2026-08-25", replacement: null }])),
  // 2026-08-19: the upstream removed the endpoint.
  "nft-sales": { retiredAt: "2026-08-19", replacement: null },
  // 2026-06-12: the spreadsheet parser dependency was removed.
  "xlsx-to-csv": { retiredAt: "2026-06-12", replacement: null },
  "xlsx-to-json": { retiredAt: "2026-06-12", replacement: null },
});

/** Skill packs: /api/skill/<slug>. The catalog slug is `skill-<slug>`. */
export const RETIRED_PACKS = Object.freeze({
  "market-open": { retiredAt: "2026-09-20", replacement: null },
  "agent-outreach": { retiredAt: "2026-09-03", replacement: null },
  ...Object.fromEntries([
    "a11y-audit", "content-clean", "content-quality", "csv-profile", "data-convert", "data-interchange",
    "finance-calc", "identity-mint", "investment-decision", "jwt-forensics", "meeting-scheduler", "rag-prep",
    "regex-test", "retirement-planning", "savings-goal", "validator-suite", "webhook-debug", "xml-json",
  ].map((s) => [s, { retiredAt: "2026-08-25", replacement: null }])),
  // 2026-07-06: packs that wrapped one tool, withdrawn two days after launch.
  // Where that one tool is live it is named.
  "checksum-suite": { retiredAt: "2026-07-06", replacement: "checksum" },
  "hash-verify": { retiredAt: "2026-07-06", replacement: "checksum" },
  "lorem-gen": { retiredAt: "2026-07-06", replacement: "lorem" },
  "password-audit": { retiredAt: "2026-07-06", replacement: "password-strength" },
  "qr-gen": { retiredAt: "2026-07-06", replacement: "qr" },
  "semver-check": { retiredAt: "2026-07-06", replacement: "semver" },
  "text-transform": { retiredAt: "2026-07-06", replacement: "case" },
  "uuid-suite": { retiredAt: "2026-07-06", replacement: "uuid" },
  "color-palette": { retiredAt: "2026-07-06", replacement: null },
  "date-math": { retiredAt: "2026-07-06", replacement: null },
  "encoding-suite": { retiredAt: "2026-07-06", replacement: null },
  "math-suite": { retiredAt: "2026-07-06", replacement: null },
});

/** The retired entry a request path names, or null. Reads the first path
 *  segment after /api/ (or /api/skill/), so a trailing segment or query does
 *  not turn a retired route back into a 404. */
export function retiredEntryFor(path) {
  const m = /^\/api\/(skill\/)?([a-z0-9-]+)/i.exec(String(path || ""));
  if (!m) return null;
  const slug = m[2].toLowerCase();
  if (m[1]) return Object.hasOwn(RETIRED_PACKS, slug) ? { kind: "pack", slug, ...RETIRED_PACKS[slug] } : null;
  return Object.hasOwn(RETIRED_TOOLS, slug) ? { kind: "tool", slug, ...RETIRED_TOOLS[slug] } : null;
}

/** Boot guard. `liveSlugs` is the set of catalog slugs (packs as `skill-<slug>`). */
export function assertRetiredRegistryConsistent(liveSlugs) {
  const live = liveSlugs instanceof Set ? liveSlugs : new Set(liveSlugs || []);
  for (const [slug, e] of Object.entries(RETIRED_TOOLS)) {
    if (live.has(slug)) throw new Error(`retired-tools: "${slug}" is listed as retired but is live in the catalog; remove it from RETIRED_TOOLS`);
    if (e.replacement && !live.has(e.replacement)) throw new Error(`retired-tools: "${slug}" names replacement "${e.replacement}", which is not a live catalog slug`);
  }
  for (const [slug, e] of Object.entries(RETIRED_PACKS)) {
    if (live.has(`skill-${slug}`)) throw new Error(`retired-tools: pack "${slug}" is listed as retired but is live in the catalog; remove it from RETIRED_PACKS`);
    if (e.replacement && !live.has(e.replacement)) throw new Error(`retired-tools: pack "${slug}" names replacement "${e.replacement}", which is not a live catalog slug`);
  }
  return true;
}
