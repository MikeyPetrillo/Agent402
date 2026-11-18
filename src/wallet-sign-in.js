// Wallet sign-in (EIP-4361, "Sign-In with Ethereum") for the identity-bound
// routes: a short-lived session that names an EVM wallet the caller proved it
// controls by signing a one-time message, so a call paid on a rail that
// carries no signed payer (Solana, Stellar, Algorand) can still act as that
// wallet. The route's price is unchanged: the session is identity, never
// payment.
//
// Off unless SIWE_SESSION_SECRET is set (at least 32 characters); off, no
// route is mounted, no header is read and every identity-bound route answers
// exactly as before.
//
// The rules, in the order verify applies them:
//   - the message parses as EIP-4361, at most 2 KB, version 1;
//   - its domain is this server's host and its URI this server's origin
//     (BASE_URL), so a message signed for another site is refused;
//   - its chain id is one of SIWE_CHAIN_IDS (default 8453,1,137,42161,10);
//   - its nonce is one this server issued, unexpired (5 minutes) and unused;
//     the nonce is spent by the first verify that names it, whatever the
//     outcome, so a message is never accepted twice;
//   - Issued At is inside the nonce's life, Expiration Time (when given) is
//     ahead, Not Before (when given) is not;
//   - the signature recovers to the message's address (an EOA signature,
//     65 bytes; contract-wallet signatures are not read).
// The session token is an HMAC-SHA256-signed record of the wallet, chain id,
// audience (this host), scopes, issue and expiry times (SIWE_SESSION_SECONDS,
// default 900, at most 3600, never past the message's own Expiration Time)
// and a random id that sign-out revokes. Sent as `X-Wallet-Session`.
//
// Payer attribution is untouched: when a request carries a signed EVM payer
// (identityPayerOf, src/payer.js) that payer is the identity, and a session
// naming another wallet is refused; sales, refunds and the ledger keep the
// payment's own payer. A proof-of-work or trial call never takes a session.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseSiweMessage } from "viem/siwe";
import { recoverMessageAddress } from "viem";

export const SESSION_HEADER = "x-wallet-session";
export const SESSION_SCOPES = Object.freeze(["my-usage", "receipts", "memory"]);
// Memory routes a session may act on: reads and writes of the wallet's own
// namespace. Grants and revocations (who else may read it) stay payer-only.
export const MEMORY_SESSION_SLUGS = Object.freeze(["memory-write", "memory-read", "memory-incr", "memory-cas", "memory-log", "memory-remember", "memory-grants"]);
export const DEFAULT_CHAIN_IDS = Object.freeze([8453, 1, 137, 42161, 10]);
const NONCE_TTL_MS = 300_000;
const NONCE_MAX = 10_000;
const SKEW_MS = 60_000;
const MAX_MESSAGE = 2048;
const MAX_TOKEN = 1024;
const TOKEN_PREFIX = "a402ws1";
const STATEMENT = "Sign in to read and write this wallet's own usage, receipts and memory on this server. Paid calls are still paid.";

export function walletSignInEnabled(env = process.env) {
  return typeof env.SIWE_SESSION_SECRET === "string" && env.SIWE_SESSION_SECRET.trim().length >= 32;
}
function chainIdsOf(env) {
  const raw = String(env.SIWE_CHAIN_IDS || "").trim();
  if (!raw) return [...DEFAULT_CHAIN_IDS];
  const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
  return ids.length ? ids : [...DEFAULT_CHAIN_IDS];
}
function sessionSecondsOf(env) {
  const n = Number(env.SIWE_SESSION_SECONDS);
  return Number.isInteger(n) && n >= 60 ? Math.min(n, 3600) : 900;
}
// The EIP-4361 layout line by line, anchored: the parser alone finds its
// fields anywhere in the text, so a message with extra lines (a second URI
// line, a field hidden after the resources) is refused here first.
const FIELD_ORDER = ["URI: ", "Version: ", "Chain ID: ", "Nonce: ", "Issued At: "];
const OPTIONAL_ORDER = ["Expiration Time: ", "Not Before: ", "Request ID: "];
export function isStrictSiweLayout(message) {
  if (typeof message !== "string" || message.length > MAX_MESSAGE || message.includes("\r")) return false;
  const lines = message.split("\n");
  let i = 0;
  if (!/^(?:[a-zA-Z][a-zA-Z0-9+.-]{0,20}:\/\/)?[a-zA-Z0-9.-]{1,253}(?::\d{1,5})? wants you to sign in with your Ethereum account:$/.test(lines[i++] || "")) return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(lines[i++] || "")) return false;
  if (lines[i++] !== "") return false;
  // An optional one-line statement, followed by a blank line.
  if (lines[i] !== undefined && !lines[i].startsWith("URI: ")) {
    if (lines[i].includes("\n") || lines[i + 1] !== "") return false;
    i += 2;
  }
  for (const f of FIELD_ORDER) {
    const l = lines[i++];
    if (typeof l !== "string" || !l.startsWith(f) || l.length === f.length) return false;
  }
  for (const f of OPTIONAL_ORDER) if (typeof lines[i] === "string" && lines[i].startsWith(f)) i++;
  if (lines[i] === "Resources:") { i++; while (typeof lines[i] === "string" && lines[i].startsWith("- ") && lines[i].length > 2) i++; }
  return i === lines.length;
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const refuse = (status, code, message) => Object.assign(new Error(message), { statusCode: status, code });

/** One sign-in service bound to an origin. `now` is injectable for tests. */
export function createWalletSignIn({ env = process.env, baseUrl, now = () => Date.now() } = {}) {
  if (!walletSignInEnabled(env)) return null;
  const secret = env.SIWE_SESSION_SECRET.trim();
  const origin = new URL(baseUrl).origin;
  const host = new URL(baseUrl).host.toLowerCase();
  const chainIds = chainIdsOf(env);
  const sessionMs = sessionSecondsOf(env) * 1000;
  const nonces = new Map(); // nonce -> expiry ms
  const revoked = new Map(); // jti -> expiry ms
  const sweep = (map, t) => { for (const [k, exp] of map) if (exp <= t) map.delete(k); };
  const mac = (s) => createHmac("sha256", secret).update(s).digest();

  function issueNonce() {
    const t = now();
    if (nonces.size >= NONCE_MAX) sweep(nonces, t);
    if (nonces.size >= NONCE_MAX) throw refuse(503, "nonce_store_full", "Too many sign-ins are waiting; try again in a minute.");
    // 16 random bytes as 32 hex characters: alphanumeric, as EIP-4361 requires.
    const nonce = randomBytes(16).toString("hex");
    nonces.set(nonce, t + NONCE_TTL_MS);
    return {
      nonce, domain: host, uri: origin, version: "1", chainIds: [...chainIds], statement: STATEMENT,
      issuedAt: new Date(t).toISOString(), expiresAt: new Date(t + NONCE_TTL_MS).toISOString(),
      header: "X-Wallet-Session", scopes: [...SESSION_SCOPES], sessionSeconds: sessionMs / 1000,
    };
  }

  async function verify({ message, signature } = {}) {
    if (typeof message !== "string" || !message || message.length > MAX_MESSAGE) throw refuse(400, "bad_message", `"message" must be an EIP-4361 message of at most ${MAX_MESSAGE} characters`);
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw refuse(400, "bad_signature", '"signature" must be a 65-byte hex signature (0x + 130 hex characters)');
    if (!isStrictSiweLayout(message)) throw refuse(400, "bad_message", "the message is not an EIP-4361 sign-in message (line layout)");
    let m;
    try { m = parseSiweMessage(message); } catch { m = null; }
    if (!m || !m.address || !m.domain || !m.uri || !m.nonce || !m.issuedAt) throw refuse(400, "bad_message", "the message is not an EIP-4361 sign-in message");
    // The nonce is spent first: any message naming it is its one attempt.
    const t = now();
    const exp = nonces.get(m.nonce);
    nonces.delete(m.nonce);
    if (exp == null || exp <= t) throw refuse(401, "nonce_unknown", "the nonce is unknown, already used or expired; ask for a new one");
    if (m.version !== "1") throw refuse(401, "bad_version", "the message version must be 1");
    if (String(m.domain).toLowerCase() !== host || (m.scheme && `${m.scheme}:` !== new URL(origin).protocol)) throw refuse(401, "wrong_domain", `the message was not written for ${host}`);
    let uriOrigin = null;
    try { uriOrigin = new URL(m.uri).origin; } catch { uriOrigin = null; }
    if (uriOrigin !== origin) throw refuse(401, "wrong_uri", `the message URI must be on ${origin}`);
    if (!chainIds.includes(Number(m.chainId))) throw refuse(401, "wrong_chain", `the chain id must be one of ${chainIds.join(", ")}`);
    const issued = m.issuedAt instanceof Date ? m.issuedAt.getTime() : NaN;
    if (!Number.isFinite(issued) || issued > t + SKEW_MS || issued < exp - NONCE_TTL_MS - SKEW_MS) throw refuse(401, "bad_time", "Issued At must be the time the nonce was issued or later, and not in the future");
    if (m.expirationTime !== undefined) {
      const e = m.expirationTime instanceof Date ? m.expirationTime.getTime() : NaN;
      if (!Number.isFinite(e) || e <= t) throw refuse(401, "expired", "the message has expired");
    }
    if (m.notBefore !== undefined) {
      const nb = m.notBefore instanceof Date ? m.notBefore.getTime() : NaN;
      if (!Number.isFinite(nb) || nb > t + SKEW_MS) throw refuse(401, "not_yet_valid", "the message is not valid yet (Not Before)");
    }
    let recovered = null;
    try { recovered = await recoverMessageAddress({ message, signature }); } catch { recovered = null; }
    if (!recovered || recovered.toLowerCase() !== String(m.address).toLowerCase()) throw refuse(401, "bad_signature", "the signature does not recover to the message's address");
    const msgExp = m.expirationTime instanceof Date ? m.expirationTime.getTime() : Infinity;
    const expMs = Math.min(t + sessionMs, msgExp);
    const payload = { v: 1, sub: recovered.toLowerCase(), cid: Number(m.chainId), aud: host, scope: [...SESSION_SCOPES], iat: Math.floor(t / 1000), exp: Math.floor(expMs / 1000), jti: randomBytes(12).toString("hex") };
    const body = `${TOKEN_PREFIX}.${b64u(JSON.stringify(payload))}`;
    return { token: `${body}.${b64u(mac(body))}`, address: payload.sub, chainId: payload.cid, expiresAt: new Date(payload.exp * 1000).toISOString(), scopes: payload.scope, header: "X-Wallet-Session" };
  }

  /** The session a token carries, or { error } naming why it is refused. */
  function sessionOf(token) {
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN) return { error: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { error: "malformed" };
    const body = `${parts[0]}.${parts[1]}`;
    let sig;
    try { sig = Buffer.from(parts[2], "base64url"); } catch { return { error: "malformed" }; }
    const want = mac(body);
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) return { error: "bad_signature" };
    let p;
    try { p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return { error: "malformed" }; }
    const t = now();
    if (!p || p.v !== 1 || typeof p.sub !== "string" || !/^0x[0-9a-f]{40}$/.test(p.sub)) return { error: "malformed" };
    if (p.aud !== host) return { error: "wrong_audience" };
    if (!Number.isFinite(p.exp) || p.exp * 1000 <= t) return { error: "expired" };
    if (!Number.isFinite(p.iat) || p.iat * 1000 > t + SKEW_MS) return { error: "malformed" };
    if (revoked.has(p.jti)) return { error: "signed_out" };
    return { session: { address: p.sub, chainId: p.cid, scopes: Array.isArray(p.scope) ? p.scope : [], jti: p.jti, exp: p.exp } };
  }

  function revoke(token) {
    const r = sessionOf(token);
    if (!r.session) return false;
    const t = now();
    if (revoked.size >= NONCE_MAX) sweep(revoked, t);
    revoked.set(r.session.jti, r.session.exp * 1000);
    return true;
  }

  return { issueNonce, verify, sessionOf, revoke, host, origin, chainIds, _nonceCount: () => nonces.size };
}

// --- the process's service and the route hook ----------------------------------
let service = null;
/** Called once at boot by server.js; returns the service or null (off). */
export function configureWalletSignIn({ env = process.env, baseUrl, now } = {}) {
  service = createWalletSignIn({ env, baseUrl, now });
  return service;
}
export function walletSignInService() { return service; }

const headerOf = (req, name) => {
  try { const v = req?.headers?.[name]; return typeof v === "string" ? v : Array.isArray(v) ? v[0] : null; } catch { return null; }
};
const wasUnpaidCall = (req) => {
  try { return !!(headerOf(req, "x-pow-accepted") || req?.res?.getHeader?.("X-Pow-Accepted") || req?.res?.getHeader?.("X-Trial-Accepted")); } catch { return true; }
};

/**
 * The wallet an identity-bound route acts as. `payer` is identityPayerOf(req).
 * Returns { wallet, via } or { error: { status, message } }. With the switch
 * off, or no session header on the request, the answer is the payer exactly
 * as before.
 */
export function resolveRouteIdentity(req, scope, payer) {
  const svc = service;
  const token = svc ? headerOf(req, SESSION_HEADER) : null;
  if (!svc || token == null) return { wallet: payer || null, via: payer ? "payment" : null };
  if (!SESSION_SCOPES.includes(scope)) return { wallet: payer || null, via: payer ? "payment" : null };
  if (wasUnpaidCall(req)) return { error: { status: 402, message: "A wallet session names who you are, not payment: this route is paid with a wallet payment." } };
  const r = svc.sessionOf(token.trim());
  if (!r.session) return { error: { status: 401, message: `The X-Wallet-Session token is refused (${r.error}). Sign in again at /api/wallet-session/nonce.` } };
  if (!r.session.scopes.includes(scope)) return { error: { status: 403, message: "The wallet session does not cover this route." } };
  if (payer && payer !== r.session.address) return { error: { status: 400, message: "The wallet session names a different wallet than the signed payment. Send one or the other, for the same wallet." } };
  return { wallet: payer || r.session.address, via: payer ? "payment" : "session" };
}

/** Header reader timed by scripts/test-redos-request-headers.js. */
export function sessionHeaderShape(value) {
  if (typeof value !== "string" || value.length > MAX_TOKEN) return null;
  const parts = value.split(".", 4);
  return parts.length === 3 && parts[0] === TOKEN_PREFIX ? parts.length : null;
}

/**
 * Mount the three routes (only when on):
 *   GET    /api/wallet-session/nonce   a nonce and the fields to sign
 *   POST   /api/wallet-session         { message, signature } -> session token
 *   DELETE /api/wallet-session         signs the X-Wallet-Session token out
 */
export function mountWalletSignIn(app, { express, limiter, clientIp }) {
  const svc = service;
  if (!svc) return false;
  const limited = (req, res) => {
    try { if (limiter.check(clientIp(req)).limited) { res.status(429).set("Retry-After", "60").json({ error: "Too many sign-in requests from this address. Try again in a minute." }); return true; } } catch { /* never block on the limiter */ }
    return false;
  };
  app.get("/api/wallet-session/nonce", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (limited(req, res)) return;
    try { res.json(svc.issueNonce()); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  app.post("/api/wallet-session", express.json({ limit: "8kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (limited(req, res)) return;
    try { res.json(await svc.verify(req.body || {})); } catch (e) { res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : "sign-in failed", code: e.code || "error" }); }
  });
  app.delete("/api/wallet-session", (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = headerOf(req, SESSION_HEADER);
    res.json({ signedOut: token ? svc.revoke(token.trim()) : false });
  });
  return true;
}
