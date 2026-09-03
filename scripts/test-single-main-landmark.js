// Every page must have exactly one <main> landmark. ledgerShell() (the
// shared chrome every page-serving module imports) already wraps every
// page's body in its own <main>...</main> - a page-level renderer that ALSO
// emits its own inner <main> creates an invalid nested-landmark structure
// (screen readers/assistive tech expect at most one <main> per document).
//
// Found in an internal audit (2026-08-16): /docs/:slug and /revenue both did
// this. Grepping the whole src/ tree for the same shape while fixing it
// turned up two more instances the audit's own spot-check missed
// (/docs/adapters/:slug via adapter-docs.js, /docs/webhooks via
// webhooks.js) - both fixed the same way. integrations.js also has its own
// <main>, but it renders through the OLDER src/chrome.js shell, which never
// wraps in <main> at all, so that one is not nested and is correctly left
// alone (checked directly, not assumed).
//
// Requires a booted server (same TARGET_URL convention as other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-single-main-landmark.js
const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The two pages the audit named, the two more found while fixing this class,
// plus a handful of other page types as a sanity sweep against a regression
// introduced elsewhere.
const PATHS = [
  "/docs/Architecture", "/revenue", "/docs/adapters/openai", "/docs/webhooks",
  "/", "/marketplace", "/tools", "/sell", "/leaderboard", "/skills", "/what-is-x402",
  "/status", "/pricing", "/playground", "/integrations", "/markets", "/security", "/company",
];

for (const path of PATHS) {
  const res = await fetch(`${BASE}${path}`);
  if (res.status !== 200) { console.log(`skip - ${path} returned ${res.status}, not 200 (may not exist as a static slug)`); continue; }
  const html = await res.text();
  const count = (html.match(/<main[\s>]/g) || []).length;
  ok(count === 1, `${path}: exactly one <main> landmark (got ${count})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
