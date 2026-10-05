// The free tier (proof-of-work, no wallet) is an ALLOWLIST: a tool is free only
// when its slug is here. Until 2026-10-04 it was the reverse - free unless named
// in WALLET_ONLY_SLUGS (src/pow.js) - so a new kit that calls an upstream and was
// left off that list was free forever, and the egress probe exists because that
// happened. Now forgetting a slug makes a tool wallet-only (safe), never free.
//
// Only pure-CPU tools belong here: no network egress, no API key, no model call.
// scripts/test-free-tier-egress.js boots the server and proves every slug here
// makes zero outbound calls on its own example. WALLET_ONLY_SLUGS stays as a
// reviewed override and wins over this list.
//
// Seeded from production's /api/pricing computePayable set (166 routes, 2026-10-04).
export const FREE_TIER_SLUGS = new Set([
  "a2a-card-validate", "add-time", "address-label", "age", "amortization", "annuity",
  "b20-feature-id", "barcode-decode", "base-convert", "base32", "base58", "base64",
  "black-scholes", "bond-price", "bond-ytm", "break-even", "brotli-compress", "brotli-decompress",
  "business-days", "cagr", "calc", "captcha-generate", "card-validate", "case",
  "checksum", "cidr", "color", "compound-interest", "compress-compare", "correlation",
  "count", "country-info", "crc32", "cron-next", "csv-lint", "csv-to-json",
  "csv-to-md", "date-diff", "date-format", "day-of-year", "dedupe-lines", "duration",
  "easter-date", "effective-annual-rate", "epoch-convert", "extract-entities", "feedback-summary", "finance",
  "forecast-eval", "forecast-holt", "forecast-holt-winters", "forecast-naive", "forecast-ses", "geo-distance",
  "gunzip", "gzip", "hash", "hex", "hmac", "html-entities",
  "html-links", "html-meta", "html-select", "html-strip", "html-table", "html-to-markdown",
  "iban-validate", "ics-parse", "image-convert", "image-resize", "image-thumbnail", "irr",
  "isbn-validate", "iso-week", "json-diff", "json-flatten", "json-format", "json-merge",
  "json-pointer", "json-query", "json-schema-infer", "json-to-csv", "json-to-yaml", "json-validate",
  "jsonl", "jwt-decode", "jwt-sign", "jwt-verify", "keywords", "leap-year",
  "levenshtein", "linear-regression", "loan-payment", "lorem", "markdown-to-html", "mime",
  "morse", "moving-average", "npv", "number-format", "openapi-diff", "openapi-extract",
  "openapi-lint", "openapi-mock-response", "openapi-redact", "openapi-required-params", "openapi-resolve-refs", "openapi-search",
  "openapi-security-summary", "openapi-to-curl", "openapi-validate-payload", "outliers", "password", "password-strength",
  "percentage", "qr", "querystring", "random", "readability", "readability-score",
  "redact", "regex", "relative-time", "roman", "rot13", "seller-trust",
  "semver", "sharpe-ratio", "skill-decode-blob", "skill-json-pipeline", "skill-jwt-toolkit", "skill-loan-comparison",
  "skill-markdown-convert", "skill-number-crunch", "skill-schema-guard", "skill-text-analyze", "skill-text-hygiene", "skill-timezone-planner",
  "skill-webhook-intake", "slugify", "solidity-scan", "sort-lines", "sql-cert-verify", "srt-convert",
  "stats", "stats-summary", "text-chunk", "text-diff", "text-stats", "time",
  "time-convert", "timezone-convert", "token-count", "totp", "truncate", "ulid",
  "unit-convert", "url-code", "url-parse", "user-agent", "uuid", "uuid-validate",
  "webhook-verify", "x402-market-pulse", "xml-to-json", "yaml-to-json",
]);
