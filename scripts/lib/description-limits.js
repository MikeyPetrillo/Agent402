// The description limits two suites share: scripts/test-description-length.js
// (which states and checks the rules) and scripts/test-tool-page-words.js
// (which budgets the Details paragraph of each tool page by them).
//
// MAX_WORDS: the ceiling for a catalog description with no pageSummary.
// PAGE_MAX_WORDS: the most words a pageSummary's page text holds.
// PAGE_SUMMARY: the tools that set `pageSummary` (the description-length
// suite fails when the kits and this list disagree).
export const MAX_WORDS = 230;
export const PAGE_MAX_WORDS = 120;
export const FIRST_SENTENCE_MAX_WORDS = 40;
export const PAGE_SUMMARY = [
  "html-frames", "token-risk", "price-webhook", "token-brief", "page-speed", "dex-pool-health", "redact-chat",
  "sol-token-report", "demand-radar", "token-risk-pro", "linkedin-article", "seller-dossier", "attest", "ticker-pack",
  "token-safety", "onchain-sql", "email-guard", "filing-report", "loop-gate", "insider-report",
];
