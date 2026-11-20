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
// SIGN-OUT ACROSS CONTAINERS. The token is portable (every container holds
// the secret), so its sign-out is too: `revoke` records the token's id in
// this process's map and in the shared flag store (`revocations`, the server
// hands it src/shared-limits.js when Redis is configured), valued and expiring
// with the token's own expiry, so the store holds at most an hour of
// sign-outs and nothing after. The map is the cache the synchronous
// `sessionOf` reads; `syncRevocation` refreshes it from the store, and the
// mounted middleware awaits that before any route resolves a session, so a
// container that never saw the DELETE, or started after it, refuses the token.
// Only a token this server signed, unexpired and not already known signed
// out, reaches the store: one bounded read per request that carries one.
//   - A store that does not take the WRITE: the token is refused by this
//     process at once, and the DELETE answers 503 (`signedOut: false`,
//     `signedOutHere: true`) so the caller repeats it; a repeat writes again.
//   - A store that does not answer a READ: this process's own record decides
//     and the session is served (decided, not an oversight). Refusing
//     instead would turn every shared-store miss into a refusal of every
//     valid session on every container, for a read-only identity whose
//     token lives at most an hour; what stays open is a token signed out on
//     ANOTHER container, for as long as the store is unreadable and no
//     longer than the token's remaining life. The miss is reported
//     (`onStoreMiss`), which feeds the sharedLimits word the pagers read.
// With no shared store (one process, no Redis) the map alone is the record.
//
// Payer attribution is untouched: when a request carries a signed EVM payer
// (identityPayerOf, src/payer.js) that payer is the identity, and a session
// naming another wallet is refused; sales, refunds and the ledger keep the
// payment's own payer. A proof-of-work or trial call never takes a session.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseSiweMessage } from "viem/siwe";
import { recoverMessageAddress } from "viem";
import { isIPv4 } from "node:net";
import { limiterKey } from "./rate-limit.js";

export const SESSION_HEADER = "x-wallet-session";
// A session is read-only: it names the wallet for reads of the wallet's own
// usage, receipts and memory. Every write (memory writes, grants,
// revocations, attest, feedback) acts only on a payment's signed payer.
export const SESSION_SCOPES = Object.freeze(["my-usage", "receipts", "memory-read"]);
// Memory routes a session may act on: the value read and the grants listing.
export const MEMORY_SESSION_SLUGS = Object.freeze(["memory-read", "memory-grants"]);
// Memory routes that change state: they pass WRITE_SCOPE, which a session
// never covers; a session sent to one with no signed payer is refused (403).
export const MEMORY_WRITE_SLUGS = Object.freeze(["memory-write", "memory-incr", "memory-cas", "memory-log", "memory-remember", "memory-forget", "memory-grant", "memory-revoke"]);
export const WRITE_SCOPE = "write";
/** The session scope a memory route passes to resolveRouteIdentity. */
export function memoryScopeOf(slug) {
  return MEMORY_SESSION_SLUGS.includes(slug) ? "memory-read" : MEMORY_WRITE_SLUGS.includes(slug) ? WRITE_SCOPE : "";
}
export const DEFAULT_CHAIN_IDS = Object.freeze([8453, 1, 137, 42161, 10]);
const NONCE_TTL_MS = 300_000;
// Outstanding nonces are bounded three ways, and a full bound expires the
// oldest nonce in it early instead of refusing anyone: each caller (its
// address, an IPv6 /64 folded as the rate limiter folds it) holds at most
// NONCE_PER_CALLER_MAX, each network (an IPv4 /24, an IPv6 /48) at most
// NONCE_PER_NETWORK_MAX, and the whole map at most NONCE_MAX, where the
// oldest nonce of the network holding the most goes first. A caller spread
// over many addresses and networks therefore loses its own oldest nonces
// before a fresh caller's, and no sign-in is ever refused for a full map.
export const NONCE_MAX = 10_000;
export const NONCE_PER_CALLER_MAX = 16;
export const NONCE_PER_NETWORK_MAX = 64;
/** The network a caller key belongs to: an IPv4 /24, an IPv6 /48, else the key. */
export function nonceNetworkOf(caller) {
  const k = String(caller ?? "");
  const v4 = k.startsWith("::ffff:") ? k.slice(7) : k;
  if (isIPv4(v4)) return `${v4.split(".").slice(0, 3).join(".")}.0/24`;
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/i.exec(k);
  return m ? `${m[1]}:${m[2]}:${m[3]}::/48` : k;
}
const SKEW_MS = 60_000;
const MAX_MESSAGE = 2048;
const MAX_TOKEN = 1024;
const TOKEN_PREFIX = "a402ws1";
const JTI_RE = /^[0-9a-f]{24}$/;
const STATEMENT = "Sign in to read this wallet's own usage, receipts and memory on this server. Read-only: writes still need a signed payment. Paid calls are still paid.";

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
export function createWalletSignIn({ env = process.env, baseUrl, now = () => Date.now(), revocations = null, onStoreMiss = null } = {}) {
  if (!walletSignInEnabled(env)) return null;
  const secret = env.SIWE_SESSION_SECRET.trim();
  const origin = new URL(baseUrl).origin;
  const host = new URL(baseUrl).host.toLowerCase();
  const chainIds = chainIdsOf(env);
  const sessionMs = sessionSecondsOf(env) * 1000;
  const nonces = new Map(); // nonce -> { exp, caller, net }, oldest first
  const byCaller = new Map(); // caller key -> Set of its nonces, oldest first
  const byNet = new Map(); // network -> Set of its nonces, oldest first
  const revoked = new Map(); // jti -> expiry ms
  const sweep = (map, t) => { for (const [k, exp] of map) if (exp <= t) map.delete(k); };
  const mac = (s) => createHmac("sha256", secret).update(s).digest();
  const store = revocations && typeof revocations.put === "function" && typeof revocations.get === "function" ? revocations : null;
  const storeMiss = (op, r) => { try { onStoreMiss?.(op, r); } catch { /* reporting never decides */ } };
  const markRevoked = (jti, expMs) => {
    if (revoked.size >= NONCE_MAX) sweep(revoked, now());
    revoked.set(jti, expMs);
  };

  const unindex = (index, key, nonce) => {
    const set = key == null ? null : index.get(key);
    if (!set) return;
    set.delete(nonce);
    if (set.size === 0) index.delete(key);
  };
  /** Forget one nonce everywhere; its entry, or undefined. */
  function dropNonce(nonce) {
    const e = nonces.get(nonce);
    if (!e) return undefined;
    nonces.delete(nonce);
    unindex(byCaller, e.caller, nonce);
    unindex(byNet, e.net, nonce);
    return e;
  }
  const oldestOf = (set) => set.values().next().value;
  function sweepNonces(t) {
    for (const [n, e] of nonces) if (e.exp <= t) dropNonce(n);
  }
  /** Make room in the full map: the oldest nonce of the network holding the
   *  most (with every network holding one, the oldest nonce of all). */
  function evictForRoom() {
    let worst = null, most = 1;
    for (const set of byNet.values()) if (set.size > most) { most = set.size; worst = set; }
    dropNonce(worst ? oldestOf(worst) : nonces.keys().next().value);
  }

  /** A nonce for one sign-in. `caller` is the client address the route
   *  names; without one only the global bound applies (a direct caller in
   *  this process, never the HTTP route). */
  function issueNonce({ caller = null } = {}) {
    const t = now();
    const callerKey = caller == null || caller === "" ? null : limiterKey(String(caller).trim()) || "?";
    const net = callerKey == null ? null : nonceNetworkOf(callerKey);
    if (callerKey != null) {
      const mine = byCaller.get(callerKey);
      if (mine && mine.size >= NONCE_PER_CALLER_MAX) { sweepNonces(t); while (byCaller.get(callerKey)?.size >= NONCE_PER_CALLER_MAX) dropNonce(oldestOf(byCaller.get(callerKey))); }
      const ours = byNet.get(net);
      if (ours && ours.size >= NONCE_PER_NETWORK_MAX) { sweepNonces(t); while (byNet.get(net)?.size >= NONCE_PER_NETWORK_MAX) dropNonce(oldestOf(byNet.get(net))); }
    }
    if (nonces.size >= NONCE_MAX) sweepNonces(t);
    while (nonces.size >= NONCE_MAX) evictForRoom();
    // 16 random bytes as 32 hex characters: alphanumeric, as EIP-4361 requires.
    const nonce = randomBytes(16).toString("hex");
    nonces.set(nonce, { exp: t + NONCE_TTL_MS, caller: callerKey, net });
    if (callerKey != null) {
      if (!byCaller.has(callerKey)) byCaller.set(callerKey, new Set());
      byCaller.get(callerKey).add(nonce);
      if (!byNet.has(net)) byNet.set(net, new Set());
      byNet.get(net).add(nonce);
    }
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
    const exp = dropNonce(m.nonce)?.exp;
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

  /** The record a token carries when this server signed it and it has not
   *  expired, whether or not it was signed out; else { error }. */
  function readToken(token) {
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
    if (typeof p.jti !== "string" || !JTI_RE.test(p.jti)) return { error: "malformed" };
    return { session: { address: p.sub, chainId: p.cid, scopes: Array.isArray(p.scope) ? p.scope : [], jti: p.jti, exp: p.exp } };
  }

  /** The session a token carries, or { error } naming why it is refused.
   *  Synchronous: sign-outs are read from this process's map, which
   *  syncRevocation keeps current with the shared store. */
  function sessionOf(token) {
    const r = readToken(token);
    if (r.session && revoked.has(r.session.jti)) return { error: "signed_out" };
    return r;
  }

  /** Read the shared sign-out record for this token into the map. Resolves to
   *  "revoked", "clean", "unread" (the store did not answer: the map stands)
   *  or "skipped" (no store, or not a live token of ours). Never throws. */
  async function syncRevocation(token) {
    const r = readToken(token);
    if (!r.session) return "skipped";
    if (revoked.has(r.session.jti)) return "revoked";
    if (!store) return "skipped";
    let got;
    try { got = await store.get(r.session.jti); } catch (e) { got = { ok: false, error: String(e?.message || e) }; }
    if (!got?.ok) { storeMiss("read", got); return "unread"; }
    if (!(Number(got.until) > now())) return "clean";
    markRevoked(r.session.jti, r.session.exp * 1000);
    return "revoked";
  }

  /** Sign a token out. Resolves to { signedOut, shared }: `signedOut` false
   *  when the token is not a live session of ours; `shared` true once the
   *  shared store took the record, false when it did not (this process
   *  refuses the token either way), null with no shared store. A token
   *  already signed out is written again, so a repeat completes a sign-out
   *  the store missed. Never throws. */
  async function revoke(token) {
    const r = readToken(token);
    if (!r.session) return { signedOut: false, shared: null };
    const expMs = r.session.exp * 1000;
    markRevoked(r.session.jti, expMs);
    if (!store) return { signedOut: true, shared: null };
    let put;
    try { put = await store.put(r.session.jti, expMs); } catch (e) { put = { ok: false, error: String(e?.message || e) }; }
    if (!put?.ok) storeMiss("write", put);
    return { signedOut: true, shared: !!put?.ok };
  }

  return { issueNonce, verify, sessionOf, syncRevocation, revoke, host, origin, chainIds, _nonceCount: () => nonces.size, _nonceIndexSizes: () => ({ callers: byCaller.size, networks: byNet.size }) };
}

// --- the process's service and the route hook ----------------------------------
let service = null;
/** Called once at boot by server.js; returns the service or null (off). */
export function configureWalletSignIn({ env = process.env, baseUrl, now, revocations = null, onStoreMiss = null } = {}) {
  service = createWalletSignIn({ env, baseUrl, now, revocations, onStoreMiss });
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
  if (scope === WRITE_SCOPE && !payer) return { error: { status: 403, message: "A wallet session is read-only: this route changes state and acts only on a signed payment's payer." } };
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
 * and, ahead of every route registered after this call, the read of the
 * shared sign-out record for a request that carries a session token.
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
    try { res.json(svc.issueNonce({ caller: clientIp(req) || "?" })); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
  app.post("/api/wallet-session", express.json({ limit: "8kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (limited(req, res)) return;
    try { res.json(await svc.verify(req.body || {})); } catch (e) { res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : "sign-in failed", code: e.code || "error" }); }
  });
  app.delete("/api/wallet-session", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = headerOf(req, SESSION_HEADER);
    const out = token ? await svc.revoke(token.trim()) : { signedOut: false, shared: null };
    // The shared store did not take the record: this container refuses the
    // token already, another may not yet, so the caller is asked to repeat it.
    if (out.signedOut && out.shared === false) return res.status(503).set("Retry-After", "5").json({ signedOut: false, signedOutHere: true, error: "The sign-out is recorded on this server and could not be confirmed on every server. Send the same request again.", retryable: true });
    res.json({ signedOut: out.signedOut });
  });
  // A sign-out taken by another container (or before this one started) is
  // read from the shared store before any route resolves the session. Only a
  // request carrying the header pays for it, and only a token this server
  // signed reaches the store (syncRevocation).
  app.use((req, res, next) => {
    const token = headerOf(req, SESSION_HEADER);
    if (token == null) return next();
    svc.syncRevocation(token.trim()).then(() => next(), () => next());
  });
  return true;
}
