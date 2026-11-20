#!/usr/bin/env node
// The pre-launch security checklist, item by item, with the guard that holds
// each one.
//
//   node scripts/test-security-checklist.js
//
// Offline and cheap: nothing is booted. For every item marked covered, each
// named guard must still exist, still hold the assertion it is listed for (a
// fixed text or pattern inside it), and still be run by CI (a lane script under
// scripts/ci/lanes/ or a workflow under .github/workflows/). A guard that is
// deleted, renamed, emptied of that assertion or dropped from every lane fails
// here, so a covered item cannot quietly become uncovered. An item marked n/a
// carries its reason and a check that the reason still holds.
//
// When a guard moves, update its entry here in the same change.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// guard: [file, ...anchors]; an anchor is a fixed string or a RegExp the file must hold.
const CHECKLIST = [
  // Access
  { area: "access", item: "operator authentication (header token, session cookie; no query token)", guards: [
    ["scripts/test-operator-auth.js", "?token= query is ignored", "session cookie authenticates the dashboard"],
    ["scripts/test-operator-routes-refuse.js", "operatorRoutesOf"],
  ] },
  { area: "access", item: "identity-bound routes take identity from the signed EVM authorization only", guards: [
    ["scripts/test-payment-identity-rails.js", "identity-bound routes"],
  ] },
  { area: "access", item: "every /__operator route refuses a caller without the token", guards: [
    ["scripts/test-operator-routes-refuse.js", "/__operator"],
    ["scripts/test-cors.js", "/__operator"],
  ] },
  { area: "access", item: "session cookie: HttpOnly, SameSite=Strict, Secure over HTTPS, Path scope, idle and absolute lifetime, server-side revocation", guards: [
    ["scripts/test-operator-auth.js", "cookie is HttpOnly", "SameSite=Strict (CSRF-safe)", "a login over HTTPS sets a Secure, HttpOnly, SameSite=Strict cookie", "scoped to Path=/__operator", "a session unused for longer than the idle window has ended", "the cookie keeps the 8-hour absolute lifetime"],
  ] },
  { area: "access", item: "emailed links expire or are signed (manage link 7 days, unconfirmed alert signup forgotten, manage token kept out of caches and referrers)", guards: [
    ["scripts/test-monitor-manage-link.js", "the link expires in 7 days", "refuses an expired or unsigned sub link"],
    ["scripts/test-free-alerts.js", "unconfirmed signups are forgotten after their TTL"],
    ["scripts/test-mpp-manage-token.js", "MANAGE_RESPONSE_HEADERS"],
  ] },
  // Secrets
  { area: "secrets", item: "no keys in code: gitleaks over the full history (merge commits included) and the working tree on every push", guards: [
    // Every download in the scan retries a dropped connection (a reset is not a finding).
    [".github/workflows/secret-scan.yml", '--log-opts="--all -m"', "--no-git", "--redact", /(?<![\s\S])(?![\s\S]*^[ \t]*curl\b(?![^\n]*--retry 3 --retry-all-errors))/m],
    [".gitleaks.toml", "[allowlist]"],
  ], ci: false },
  { area: "secrets", item: "no configured secret in a buyer answer, a tool error or a log line", guards: [
    ["scripts/test-tool-error-redaction.js", "redactSecrets"],
    ["scripts/test-leak-guard.js", "no configured secret"],
    ["scripts/test-mcp-error-redaction.js"],
    ["scripts/test-log-safe.js", "Log-injection guard"],
  ] },
  { area: "secrets", item: "upstream rates never committed, printed in CI or typed in a test; secrets blanked where packages install", guards: [
    ["scripts/test-upstream-costs.js"],
    ["scripts/test-ci-secretless-install.js"],
  ] },
  { area: "secrets", item: "public surfaces carry counts and words, never buyer identity or credentials", guards: [
    ["scripts/test-public-surface-leak.js"],
    ["scripts/test-gateway-status-privacy.js", "the PUBLIC view carries no live failure counter"],
  ] },
  // Data
  { area: "data", item: "SQL values are bound parameters; no template or concatenation interpolates a caller's value", guards: [
    ["scripts/test-sql-interpolation.js", "control: the reader flags"],
  ] },
  { area: "data", item: "hostile and uncoercible input answers 4xx, bounded in time and size", guards: [
    ["scripts/test-security.js", "prototype pollution"],
    ["scripts/test-redos-free-tier.js"],
    ["scripts/test-redos-request-headers.js"],
    ["scripts/test-free-tier-egress.js"],
  ] },
  { area: "data", item: "body size and type limits on every parser (JSON, multipart, large-body routes, capped reads)", guards: [
    ["scripts/test-large-body-gate.js"],
    ["scripts/test-multipart.js"],
    ["scripts/test-capped-body-reads.js"],
  ] },
  { area: "data", item: "the price asked is the catalog's; caller fields cannot change it and a payment on other terms never reaches the facilitator", guards: [
    ["scripts/test-price-from-catalog.js", "price-shaped caller fields leave the offer byte-identical", "with no verify and no settle"],
    ["scripts/test-paid-price.js"],
  ] },
  // Web
  { area: "web", item: "HTTPS: HSTS on every answer (parser refusals included)", guards: [
    ["scripts/test-security-header-surfaces.js", "strict-transport-security"],
    ["scripts/test-security-headers-unit.js"],
  ] },
  { area: "web", item: "XSS: shared escapers and a script-src 'self' content security policy on every page", guards: [
    ["scripts/test-escape-quotes.js"],
    ["scripts/test-security-header-surfaces.js", "content-security-policy"],
  ] },
  { area: "web", item: "CSRF: an operator write on the session cookie needs same-origin", guards: [
    ["scripts/test-operator-auth.js", "from another origin on the session cookie is refused", "a cookie POST with neither Origin nor Sec-Fetch-Site is refused"],
  ] },
  { area: "web", item: "CORS: API surfaces are wildcard and credential-free; operator and probe routes get no CORS", guards: [
    ["scripts/test-cors.js", "never allows credentials"],
    ["scripts/test-security-headers.js", "credential-free"],
  ] },
  { area: "web", item: "security headers per surface class", guards: [
    ["scripts/test-security-header-surfaces.js", "x-content-type-options"],
    ["scripts/test-security-headers.js", "X-Powered-By"],
  ] },
  // Paid calls carry no per-caller rate limit, but capacity limits do refuse
  // them: the onchain-sql in-flight cap answers 429, a daily upstream ceiling
  // answers 503. The item names both, with the guards that hold them.
  { area: "web", item: "rate limits on unpaid surfaces (checkout, MCP free tier, operator login, proof-of-work); no per-caller rate limit on paid calls, and the capacity limits that can refuse one (the onchain-sql in-flight cap 429, a daily upstream ceiling 503)", guards: [
    ["scripts/test-checkout-limiter.js", "this is a ceiling, not a wall"],
    ["scripts/test-mcp-limits.js"],
    ["scripts/test-operator-auth.js", "login is rate-limited"],
    ["scripts/test-pow-challenge-envelope.js"],
    ["scripts/test-cdp-kit.js", "is refused 429 busy"],
    ["scripts/test-upstream-hard-caps.js", "calls past the ceiling are refused with 503"],
  ] },
  // Before launch
  { area: "launch", item: "no stack, module path or framework fingerprint in an error answer; no source map served", guards: [
    ["scripts/test-exposed-files.js", "the error answer carries no stack", "names no source map"],
  ] },
  { area: "launch", item: "no repository, build, state or backup file is served", guards: [
    ["scripts/test-exposed-files.js", "/.git/config", "/.env", "the body holds no file content"],
  ] },
  { area: "launch", item: "dependencies: Dependabot, code scanning and the advisory-triage pager", guards: [
    [".github/dependabot.yml"],
    [".github/workflows/codeql.yml"],
    ["scripts/test-advisory-triage.js"],
  ], ci: false },
  { area: "launch", item: "debug and test switches are off on a production boot (no debug field in an answer, no crash or hang hook)", guards: [
    ["scripts/test-debug-off-in-production.js", "a production process with every seam set reads none of them", "control: a planted ungated debug read is caught"],
    ["src/test-seams.js", "isProductionEnv(env)"],
  ] },
  { area: "launch", item: "environment review: every variable the server reads is documented, none documented that no code reads", guards: [
    ["scripts/test-config-reference.js", "every environment variable src/ reads has a purpose line", "control: a new variable with no purpose line is reported"],
    ["docs/configuration.md", "# Configuration reference"],
  ] },
  { area: "launch", item: "unused packages: every declared dependency is imported", guards: [
    ["scripts/test-unused-deps.js", "every runtime dependency is imported by src/ or services/"],
  ] },
  { area: "data", item: "database connections verify TLS off the private network; every pool takes the shared TLS policy", guards: [
    ["scripts/test-db-ssl.js", "every Postgres pool in src/ sets ssl: dbSsl(...)", "an unparseable URL defaults to verify"],
  ] },
  { area: "secrets", item: "key rotation is a written procedure (new credential, host and Actions secret, verify, revoke)", guards: [
    ["docs/runbook.md", "## Rotate a key", "Revoke the old credential"],
  ] },
  { area: "launch", item: "suspicious activity pages: wrong operator credentials counted shared, published as a word, paged by the heartbeat", guards: [
    ["scripts/test-operator-auth.js", "wrong operator credentials are counted"],
    [".github/workflows/heartbeat.yml", ".operatorAuth.status", "Operator token guessing ELEVATED"],
  ] },
];

const NOT_APPLICABLE = [
  { area: "access", item: "password hashing", why: "no password is stored: the operator credential is a token compared in constant time and exchanged for an opaque session id; buyers authenticate by signed payment",
    holds: () => !/\b(?:import|require)\b[^\n]*\b(?:bcrypt|argon2|scrypt-js)\b/.test(srcText()) && !/CREATE TABLE[^;]*\bpassword\b/i.test(srcText()) },
  { area: "secrets", item: "exposed-key response", why: "issuing and revoking a credential is an owner action at its issuer; the history scan above is the detector and docs/runbook.md the procedure",
    holds: () => existsSync(join(ROOT, "docs/runbook.md")) },
];

let _src = null;
function srcText() {
  if (_src !== null) return _src;
  const parts = [];
  const walk = (d) => { for (const f of readdirSync(join(ROOT, d), { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p); else if (/\.(?:m?js|cjs)$/.test(f.name)) parts.push(read(p)); } };
  walk("src");
  return (_src = parts.join("\n"));
}

// Every script CI runs: lane lists and workflow files.
const ciText = [
  ...readdirSync(join(ROOT, "scripts/ci/lanes")).filter((f) => f.endsWith(".sh")).map((f) => read(`scripts/ci/lanes/${f}`)),
  ...readdirSync(join(ROOT, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => read(`.github/workflows/${f}`)),
].join("\n");

ok(CHECKLIST.length >= 20, `the checklist lists ${CHECKLIST.length} covered items`);
for (const entry of CHECKLIST) {
  for (const [file, ...anchors] of entry.guards) {
    const there = existsSync(join(ROOT, file));
    ok(there, `[${entry.area}] ${entry.item}: ${file} exists`);
    if (!there) continue;
    const text = read(file);
    for (const a of anchors) {
      const hit = a instanceof RegExp ? a.test(text) : text.includes(a);
      ok(hit, `[${entry.area}] ${file} still holds ${a instanceof RegExp ? a : JSON.stringify(a)}`);
    }
    if (entry.ci !== false && file.startsWith("scripts/")) ok(ciText.includes(file), `[${entry.area}] ${file} is run by CI`);
  }
}
for (const n of NOT_APPLICABLE) ok(n.holds(), `[${n.area}] ${n.item} is n/a: ${n.why}`);

// The written mapping (docs/security-checklist.md) names only files that exist,
// and names every guard file this checklist lists.
{
  const doc = read("docs/security-checklist.md");
  const named = [...doc.matchAll(/`((?:scripts|src|\.github)\/[^`\s]+|\.gitleaks\.toml|SECURITY\.md)`/g)].map((m) => m[1]);
  const missing = [...new Set(named)].filter((f) => !existsSync(join(ROOT, f)));
  ok(named.length >= 30 && missing.length === 0, `docs/security-checklist.md names ${named.length} files, all present${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
  const unlisted = [...new Set(CHECKLIST.flatMap((e) => e.guards.map(([f]) => f)))].filter((f) => f !== "docs/security-checklist.md" && f !== "docs/runbook.md" && f !== "docs/configuration.md" && !doc.includes(f));
  ok(unlisted.length === 0, `every guard in this checklist is named in docs/security-checklist.md${unlisted.length ? `: ${unlisted.join(", ")}` : ""}`);
  // A capacity limit refuses a paid call (429 busy, 503 at a daily ceiling),
  // so the mapping never says a paid call is never limited.
  const ABSOLUTE = /\bpaid calls?\b[^|]{0,40}\b(?:are|is)\s+never\s+(?:rate[- ])?limited/i;
  ok(ABSOLUTE.test("| Rate limits | Unpaid surfaces are limited; paid calls are never limited. |") && !ABSOLUTE.test("| Rate limits | paid calls carry no per-caller rate limit; a capacity limit can refuse one |"), "control: the absolute is read, the scoped wording is not");
  const absolute = doc.split("\n").find((l) => ABSOLUTE.test(l));
  ok(!absolute, `docs/security-checklist.md states no "paid calls are never limited" absolute${absolute ? `: "${absolute.slice(0, 160)}"` : ""}`);
}

// This guard runs in exactly one lane.
const lanes = readdirSync(join(ROOT, "scripts/ci/lanes")).filter((f) => f.endsWith(".sh") && read(`scripts/ci/lanes/${f}`).includes("scripts/test-security-checklist.js"));
ok(lanes.length === 1, `this guard runs in exactly one CI lane (${lanes.join(", ") || "none"})`);

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
