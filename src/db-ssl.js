// Postgres TLS policy by connection route (audit F11).
//
// Agent402's databases (DATABASE_URL, analytics) run on Railway. There are
// two ways to reach a Railway Postgres:
//
//   * PRIVATE networking — `*.railway.internal`. The connection rides Railway's
//     encrypted internal mesh and is never exposed to the public internet, so
//     there is no man-in-the-middle position. Certificate verification is moot
//     here; we keep the working relaxed setting so prod behaviour is unchanged.
//   * PUBLIC proxy — `*.proxy.rlwy.net` (or any other host). This IS reachable
//     over the internet, so an active network attacker could impersonate the DB.
//     There we REQUIRE a verified certificate (rejectUnauthorized: true) and
//     FAIL CLOSED rather than silently accept a self-signed cert — the exact
//     exposure the audit flagged. If a public URL ever legitimately needs a
//     custom CA, add `sslmode=verify-full` + the CA rather than relaxing this.
//
// Returns a value suitable for pg Pool's `ssl` option.
export function dbSsl(connectionString) {
  const url = String(connectionString || "");
  if (/sslmode=disable/.test(url)) return false;
  let host = "";
  try { host = new URL(url).hostname; } catch { /* unparseable — treat as public and verify */ }
  // Private Railway mesh: no MITM position; keep the working relaxed setting.
  if (host.endsWith(".railway.internal")) return { rejectUnauthorized: false };
  // Public / proxied / unknown: verify the certificate, fail closed.
  return { rejectUnauthorized: true };
}
