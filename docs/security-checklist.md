# Security checklist

Each item of a standard pre-launch web security checklist, mapped to the mechanism in this
repository that holds it and the test or workflow that fails when the mechanism goes away.
`scripts/test-security-checklist.js` (run in CI) checks that every guard named for a covered item
still exists, still holds its assertion and is still run by CI, so a covered item cannot quietly
become uncovered. Procedures (deploys, key rotation, refunds) are in [runbook.md](runbook.md);
every setting is listed in [configuration.md](configuration.md). To report a vulnerability, see
`SECURITY.md`.

## Access

| Item | Mechanism | Guard |
| --- | --- | --- |
| Authentication | Buyers have no accounts: each paid call carries a signed payment, verified before any work, and identity-bound routes (memory, my-usage, attest, feedback) key on the signed EIP-3009 payer only (`src/payer.js`). The operator authenticates with a token compared in constant time (`src/operator.js`), sent as a header or exchanged at `POST /__operator/login` for a session; a query-string token is ignored. | `scripts/test-operator-auth.js`, `scripts/test-payment-identity-rails.js` |
| Password hashing | Not applicable: no password is stored. The operator credential is a token exchanged for an opaque session id, and buyers authenticate by signature. | `scripts/test-security-checklist.js` (no password library or password column in `src/`) |
| Admin routes | Every operator route lives under `/__operator/*`, is registered on the app itself so `/__operator/routes.json` lists it (`src/operator-routes.js`), and answers 404 without the token. The operator view of a public surface reads `X-Operator-Token` only and is `private, no-store`. | `scripts/test-operator-routes-refuse.js`, `scripts/test-cors.js` |
| Session cookies | HttpOnly, SameSite=Strict, Secure over HTTPS, scoped to `Path=/__operator`, ended after an idle window (`OPERATOR_SESSION_IDLE_SECONDS`) inside an 8-hour absolute lifetime, and revocable on the server. | `scripts/test-operator-auth.js` |
| Reset and emailed links | No password reset exists. Emailed manage links are signed and expire (7 days); an unconfirmed alert signup is forgotten; manage tokens are kept out of caches and referrers. | `scripts/test-monitor-manage-link.js`, `scripts/test-free-alerts.js`, `scripts/test-mpp-manage-token.js` |

## Secrets

| Item | Mechanism | Guard |
| --- | --- | --- |
| Secrets out of code | Every key and token is a host variable or an Actions secret. Upstream rates load from a private table (`src/upstream-costs.js`) and are never committed, printed in CI or typed in a test; secrets are blanked in every step that installs packages. | `scripts/test-upstream-costs.js`, `scripts/test-ci-secretless-install.js` |
| Git-history secret scan | gitleaks, pinned and checksum-verified, scans the full history (merge commits included) and the working tree on every push. | `.github/workflows/secret-scan.yml`, `.gitleaks.toml` |
| Secrets in answers and logs | A configured secret never reaches a buyer answer, a tool error or a log line; payment logs print a wallet by its first characters only. | `scripts/test-tool-error-redaction.js`, `scripts/test-leak-guard.js`, `scripts/test-mcp-error-redaction.js`, `scripts/test-log-safe.js`, `scripts/test-log-payer-short.js` |
| Public surfaces | Public answers carry counts and status words, never a buyer's identity or a credential; the operator view of a surface needs the operator token. | `scripts/test-public-surface-leak.js`, `scripts/test-gateway-status-privacy.js` |
| Environment review | Every variable `src/` reads has a purpose line in `docs/configuration.json`, rendered to `docs/configuration.md`; a new read without one, or a line no code reads, fails CI. | `scripts/test-config-reference.js` |
| Key rotation process | Written procedure: issue the new credential, set it on the host and in the matching Actions secret, verify the boot, revoke the old one; a published signing key rotates by key id with the old public key kept. | `docs/runbook.md` ("Rotate a key") |

## Data

| Item | Mechanism | Guard |
| --- | --- | --- |
| Database security | Postgres connections verify TLS on any host off the private network and fail closed on an unparseable URL (`src/db-ssl.js`); every pool in `src/` takes that policy. The state database runs with statement and idle-in-transaction timeouts (`src/state-db.js`). | `scripts/test-db-ssl.js` |
| Parameterized queries | SQL values are bound parameters; no template literal or concatenation interpolates a caller's value. The onchain-sql tool runs caller SQL through its own parser guard. | `scripts/test-sql-interpolation.js`, `scripts/test-sql-guard.js` |
| Server-side validation | Each tool checks its own inputs; an uncoercible value answers 400 naming the field (`src/caller-input-errors.js`); hostile strings and structured corpora are sent to every free tool's fields with the event loop timed; outbound fetches refuse private and metadata addresses, literal IPs and redirect hops included (`src/tools/fetch-guard.js`). | `scripts/test-security.js`, `scripts/test-redos-free-tier.js`, `scripts/test-redos-request-headers.js`, `scripts/test-free-tier-egress.js`, `scripts/test-ssrf-literal-ip.js`, `scripts/test-ssrf-redirect-hops.js` |
| Upload limits | Size and type limits on every parser: JSON, multipart, the large-body routes (`src/large-body-gate.js`) and capped reads of upstream bodies (`src/capped-body.js`). | `scripts/test-large-body-gate.js`, `scripts/test-multipart.js`, `scripts/test-capped-body-reads.js` |
| Server-side price checks | The price in every 402 is the catalog's; no caller field changes it, and a payment on other terms never reaches the facilitator (`src/payments.js`). | `scripts/test-price-from-catalog.js`, `scripts/test-paid-price.js` |

## Web

| Item | Mechanism | Guard |
| --- | --- | --- |
| HTTPS | HSTS, nosniff and a referrer policy on every answer, a parser-refused request included (`src/security-headers.js`). | `scripts/test-security-header-surfaces.js`, `scripts/test-security-headers-unit.js` |
| XSS | Pages build HTML through shared escapers, under a `script-src 'self'` content security policy. | `scripts/test-escape-quotes.js`, `scripts/test-security-header-surfaces.js` |
| CSRF | No buyer state rides on a cookie. An operator write carrying the session cookie needs `Sec-Fetch-Site: same-origin` or an Origin equal to the configured base URL; a header-token caller needs neither. | `scripts/test-operator-auth.js` |
| CORS | API surfaces answer with a wildcard origin and no credentials; operator and probe routes get no CORS headers (`src/cors.js`). | `scripts/test-cors.js`, `scripts/test-security-headers.js` |
| Security headers | Set per surface class (pages, API, binary answers, errors); `X-Powered-By` is removed. | `scripts/test-security-header-surfaces.js`, `scripts/test-security-headers.js` |
| Rate limits | Unpaid surfaces are limited (card checkout, the free MCP tier, operator login, proof-of-work challenges; `src/rate-limit.js`); paid calls are never limited. | `scripts/test-checkout-limiter.js`, `scripts/test-mcp-limits.js`, `scripts/test-operator-auth.js`, `scripts/test-pow-challenge-envelope.js` |

## Before launch

| Item | Mechanism | Guard |
| --- | --- | --- |
| Debug off in production | Error answers carry no stack, module path or framework fingerprint, and no source map is served. Debug and test switches (`*_DEBUG`, `*_TEST_*`) are read through `src/test-seams.js` or a test-only gate, so a production boot never honors them. | `scripts/test-exposed-files.js`, `scripts/test-debug-off-in-production.js` |
| Dependency audit | Dependabot and code scanning run on the repository; a security advisory left in triage pages through the heartbeat. `npm audit --omit=dev` reports no known vulnerability in the production dependency tree as of this document's last edit. | `.github/dependabot.yml`, `.github/workflows/codeql.yml`, `scripts/test-advisory-triage.js` |
| Unused packages | Every declared dependency is imported by the code that ships it. | `scripts/test-unused-deps.js` |
| Software bill of materials | `node scripts/sbom.js` writes a CycloneDX 1.5 SBOM from `package-lock.json`, offline and deterministic. | `scripts/test-sbom.js` |
| Exposed files | No repository, build, environment, state or backup file is served: requests for `/.git/config`, `/.env` and the like answer without file content. | `scripts/test-exposed-files.js` |
| Monitoring | Production is measured from outside: the scheduled heartbeat, the status Worker and a daily paid canary; every word on `/api/gateway-status` has a pager, and repeated wrong operator credentials are counted, published as a word and paged. | `scripts/test-status-word-pagers.js`, `.github/workflows/heartbeat.yml`, `scripts/test-operator-auth.js` |
| Tests | Every tool answers its own published example, and each guard above runs in a CI lane listed in `scripts/ci/lanes/` that gates every deploy. | `scripts/test-all.js`, `scripts/test-ci-gating.js`, `scripts/test-security-checklist.js` |
