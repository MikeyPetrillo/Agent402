// Operator-published /.well-known documents — short-lived verification files
// served WITHOUT a redeploy. The concrete need (2026-08-05): a directory's
// domain-control challenge gives 15 minutes to publish a JSON document at
// /.well-known/<name>-verification/<id>, and a deploy cycle cannot be on
// that critical path. The same shape covers any future "prove you control
// this domain by serving a file" flow.
//
// Deliberately memory-only: verification documents are ephemeral by nature
// (such challenges expire in minutes; the TTL here is a generous 24h), so a
// redeploy dropping them is fine — re-publish and re-verify. Nothing here
// ever holds a secret: registration is operator-gated, and the documents are
// meant to be world-readable the moment they exist (a challenge's own claim
// secret must NEVER appear in the hosted file — it stays with the operator
// who requested the challenge).

const MAX_ENTRIES = 16;
const MAX_BYTES = 16 * 1024; // challenge fetchers bound their reads to a few KiB; 16K covers them
const TTL_MS = 24 * 60 * 60 * 1000;

// Paths with dedicated routes in server.js — refuse them here so an operator
// typo can never sit in the store silently shadowed (the serving catch-all
// falls through when the store misses, so a reserved-name entry would simply
// never serve; rejecting at write time makes the mistake loud instead).
const RESERVED = new Set(["x402", "security.txt", "glama.json"]);

// One clean path segment: no dot-prefix (blocks "." / ".."), no separators
// beyond the explicit "/" between segments — path traversal is structurally
// impossible, not filtered.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const store = new Map(); // path -> { body, contentType, at }

export function validWellKnownPath(path) {
  if (typeof path !== "string" || !path || path.length > 512) return false;
  const segments = path.split("/");
  if (segments.length > 4) return false;
  return segments.every((s) => SEGMENT.test(s) && !s.startsWith("."));
}

/** Register (or overwrite) a document. Throws Error with .statusCode on any
 *  invalid input — the operator route returns the message verbatim. */
export function registerWellKnown(path, body, contentType = "application/json") {
  const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });
  if (!validWellKnownPath(path)) throw bad("path must be 1-4 clean segments (letters, digits, . _ -), e.g. example-verification/<id>");
  if (RESERVED.has(path)) throw bad(`"${path}" has a dedicated route - the store cannot serve it`);
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (!text || Buffer.byteLength(text, "utf8") > MAX_BYTES) throw bad(`body required, max ${MAX_BYTES} bytes`);
  // Allowlist, not a shape check: domain-verification documents are JSON or
  // plain text everywhere this flow exists. Refusing everything else makes
  // markup serving structurally impossible - an operator cannot register a
  // text/html body even by mistake, so the public catch-all can never emit
  // anything a browser would execute.
  if (contentType !== "application/json" && contentType !== "text/plain") {
    throw bad('contentType must be "application/json" or "text/plain"');
  }
  prune();
  if (!store.has(path) && store.size >= MAX_ENTRIES) throw bad(`store full (${MAX_ENTRIES} entries) - remove one first`);
  store.set(path, { body: text, contentType, at: Date.now() });
  return { path, bytes: Buffer.byteLength(text, "utf8"), expiresInMs: TTL_MS };
}

export function removeWellKnown(path) {
  return store.delete(path);
}

/** Serving read: null on miss or expiry (the route falls through to 404). */
export function getWellKnown(path) {
  const hit = store.get(path);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    store.delete(path);
    return null;
  }
  return hit;
}

export function listWellKnown() {
  prune();
  return [...store.entries()].map(([path, e]) => ({ path, contentType: e.contentType, ageMs: Date.now() - e.at }));
}

function prune() {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.at > TTL_MS) store.delete(k);
}
