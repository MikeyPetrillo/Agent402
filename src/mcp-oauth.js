// Connector sign-in (OAuth 2.1) for the hosted MCP connector: a person adds
// the connector to an app, signs in with a code emailed to the address that
// holds their prepaid credits, picks a balance and a daily cap, and the app's
// paid tool calls are paid from that balance. Off unless MCP_OAUTH=on
// (exactly) AND credits are on sale (CREDITS_SALES) on a server with card
// credits configured; off, every route here falls through (404) and /mcp
// answers exactly as it does without this module.
//
// What a grant can do: pay for priced catalog routes from ONE credits key,
// under its daily cap, through the credits gate (hold before the handler,
// debit only on a final 200). Never: read or move the balance, show the key,
// a wallet-identity-bound route (memory, my-usage, attest, feedback) or a
// route that buys from an outside seller (the gate refuses both, as for a
// key). The access token is never a credits key: the connector replays a
// paid call to its own route with a one-call handle (src/mcp-loopback.js).
//
// Protocol: authorization code with PKCE S256 only (plain refused), public
// clients registered dynamically (RFC 7591), exact redirect_uri match, state
// required, codes single-use and short-lived, access tokens short-lived,
// refresh tokens rotated on use with reuse detection (a spent refresh token
// or code presented again revokes the whole grant), RFC 7009 revocation,
// RFC 8414 and RFC 9728 metadata. Every token and code is stored as a
// SHA-256 digest; the email code as an HMAC.
//
// Where the connector is: /mcp answers without a token as before; a token
// of ours makes its paid calls payable from credits, and an expired or
// revoked one is a 401 that names the metadata. /mcp/credits is the same
// connector that asks for sign-in (401 without a token), for apps that only
// start a sign-in when the server asks for one.
//
// State: one document (src/json-document.js; a row in the state database,
// updated by compare-and-swap so replicas never drop each other's writes).
// Limits: counters in the shared store (src/shared-limits.js), each falling
// back to this process's own count when the shared store does not answer.
// Thresholds come from the environment (see docs/configuration.md); a
// refusal never says which check refused.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { SKIP_UPDATE } from "./json-document.js";
import { shared, createMemoryLimits } from "./shared-limits.js";
import { envPositive } from "./env-num.js";
import { escapeHtml, headerText } from "./email-text.js";
import { creditsSalesEnabled, creditsSalesSwitch, creditsBalanceMaxCents, mcpOAuthSwitch, mcpOAuthGuards, CONNECTED_APP_KEEP_DAYS, CREDITS_CONNECTOR_PATH } from "./credits-sales.js";
import { limiterKey } from "./rate-limit.js";
import { sellablePacks } from "./credits.js";
import { normEmail, validEmail, sameOriginWrite, readCookie, ACCOUNT_PATH, ACCOUNT_COOKIE } from "./credits-account.js";
import { consentPage, consentErrorPage, OAUTH_CONSENT_PATH } from "./mcp-oauth-page.js";

export const ACCESS_PREFIX = "a402m_";
export const REFRESH_PREFIX = "a402r_";
export const SCOPE = "credits:spend";
export const AUTH_MCP_PATH = CREDITS_CONNECTOR_PATH;
const OAUTH_COOKIE = "a402_oauth";
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const ID_RE = /^[0-9a-f]{32}$/;
const CLIENT_RE = /^c_[0-9a-f]{32}$/;
const TOKEN_RE = /^a402[mr]_[A-Za-z0-9_-]{43}$/;
const COOKIE_RE = /^[A-Za-z0-9_-]{43}$/;

export { mcpOAuthSwitch };

// ---- lifetimes (call-time reads) and limits ---------------------------------
// The sign-in's limits (code tries, sends, lockout, per-address rates, the
// bad-token bound, the pending-request cap and the store's size) come from
// the private table (src/credits-guards.js mcpOAuth); without it the sign-in
// is off, so a limit is only read while the table is complete.
const guard = (k) => {
  const v = mcpOAuthGuards()?.[k];
  if (!(Number(v) > 0)) throw Object.assign(new Error("connector sign-in limits are not set"), { statusCode: 503 });
  return Number(v);
};
const cfg = {
  accessTtlMs: () => envPositive("MCP_OAUTH_ACCESS_TTL_SECONDS", 3600) * 1000,
  refreshTtlMs: () => envPositive("MCP_OAUTH_REFRESH_TTL_DAYS", 30) * 86_400_000,
  codeTtlMs: () => Math.min(envPositive("MCP_OAUTH_AUTH_CODE_TTL_SECONDS", 60), 600) * 1000,
  emailCodeTtlMs: () => envPositive("MCP_OAUTH_EMAIL_CODE_TTL_SECONDS", 600) * 1000,
  requestTtlMs: () => envPositive("MCP_OAUTH_REQUEST_TTL_MINUTES", 60) * 60_000,
  defaultCapUsd: () => envPositive("MCP_OAUTH_DEFAULT_CAP_USD", 5),
  emailCodeTries: () => guard("emailCodeTries"),
  sendsPerEmail: () => guard("sendsPerEmail"),
  sendsPerIp: () => guard("sendsPerIp"),
  failsPerEmail: () => guard("failsPerEmail"),
  lockoutMs: () => guard("lockoutMs"),
  tokenPerIp: () => guard("tokenPerIp"),
  authorizePerIp: () => guard("authorizePerIp"),
  registerPerIp: () => guard("registerPerIp"),
  windowMs: () => guard("windowMs"),
  badTokenMax: () => guard("badTokenMax"),
  pendingMax: () => guard("pendingMax"),
  documentMaxBytes: () => guard("documentMaxBytes"),
};
// A client address is counted by its limiter key (an IPv6 address by its /64).
const netKey = (ip) => limiterKey(String(ip || "?"));
const GRANTS_PER_EMAIL = 20;
const CLIENTS_MAX = 20_000;
const CLIENT_IDLE_MS = 30 * 86_400_000;
const REVOKED_KEEP_MS = CONNECTED_APP_KEEP_DAYS * 86_400_000;
const TOUCH_MS = 5 * 60_000;
const ACCESS_CACHE_MS = 15_000;

const digest = (s) => createHash("sha256").update(String(s)).digest("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sameBytes = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const hex = (n) => randomBytes(n).toString("hex");
const s256 = (verifier) => createHash("sha256").update(String(verifier)).digest("base64url");
const str = (v, max = 2000) => (typeof v === "string" && v.length <= max ? v : null);

/** The Authorization header's reading here: null (no token of ours: the
 *  request is not ours to read), "" (ours, malformed), or the token. */
export function bearerShape(value) {
  if (typeof value !== "string" || value.length > 300 || !/^Bearer\s{1,8}a402m_/i.test(value)) return value === undefined || typeof value !== "string" || !/^Bearer\s{1,8}a402m_/i.test(value.slice(0, 40)) ? null : "";
  const tok = value.replace(/^Bearer\s{1,8}/i, "").trim();
  return TOKEN_RE.test(tok) && tok.startsWith(ACCESS_PREFIX) ? tok : "";
}

/** A coarse network for the audit list: the first two parts of the address. */
export function coarseNetwork(ip) {
  const s = String(ip || "").replace(/^::ffff:/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return `${s.split(".").slice(0, 2).join(".")}.x.x`;
  if (s.includes(":")) return `${s.split(":").slice(0, 2).join(":")}::/32`;
  return null;
}

/** A redirect URI a client may register: https, or http on this machine; no fragment. */
export function redirectUriAllowed(u) {
  if (typeof u !== "string" || u.length > 500) return false;
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function buildCodeEmail({ code, appName }) {
  const subject = "Your Agent402 sign-in code";
  const lead = `Your code to connect ${appName} to your Agent402 credits balance is ${code}. It works once, for a few minutes.`;
  const why = "You are getting this because someone asked to connect an app to the credits balance on this email at agent402.tools. If that was not you, ignore this email; nothing is connected without the code.";
  // design-tokens: literal-start (email HTML)
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#111315"><h2 style="font-weight:700">${escapeHtml(subject)}</h2><p style="color:#3A3F45;line-height:1.55">${escapeHtml(lead)}</p><p style="font-family:monospace;font-size:28px;letter-spacing:.2em;color:#111315">${escapeHtml(code)}</p><p style="color:#626970;font-size:12px;margin-top:26px">${escapeHtml(why)}</p></div>`;
  // design-tokens: literal-end
  const text = `${subject}\n\n${lead}\n\n${code}\n\n${why}\n\nAgent402`;
  return { subject, html, text };
}

/**
 * @param {object} d
 * @param {object} d.credits   createCredits() (balancesForEmail, createCheckout, claim, sessionOwner, grantSpentToday)
 * @param {object} d.account   createCreditsAccount() (sessionEmail), for the balance page's list
 * @param {object} d.store     a json-document for clients, requests, grants and tokens
 * @param {Buffer|string} d.secret
 */
export function createMcpOAuth({ credits, account = null, store, secret, baseUrl, sendEmail, limits = shared, now = () => Date.now(), log = console.log }) {
  const local = createMemoryLimits({ keyCap: 20_000 });
  // Its own key, derived from the one handed in, so no other surface's token verifies here.
  const own = secret ? createHmac("sha256", secret).update("mcp-oauth").digest() : null;
  const mac = (purpose, body) => createHmac("sha256", own).update(`${purpose}|${body}`).digest("base64url");
  const resources = new Set([`${baseUrl}/mcp`, `${baseUrl}${AUTH_MCP_PATH}`]);
  const enabled = () => mcpOAuthSwitch() && creditsSalesEnabled() && Boolean(secret);
  // Both switches set but the private table missing or incomplete: the
  // sign-in does not start, and its routes answer a generic 503.
  const waiting = () => mcpOAuthSwitch() && creditsSalesSwitch() && !creditsSalesEnabled();

  // ---- limits: one hit on a shared fixed-window counter (local on a miss) ----
  async function over(name, key, limit, windowMs = cfg.windowMs()) {
    const k = digest(`${name}|${key}`).slice(0, 40);
    let r = await limits.counterAdd(`mcpo-${name}`, k, 1, windowMs).catch(() => ({ ok: false }));
    if (!r?.ok) r = await local.counterAdd(`mcpo-${name}`, k, 1, windowMs);
    return Number(r.value) > limit;
  }
  async function locked(email) {
    const k = digest(`lock|${email}`).slice(0, 40);
    let r = await limits.counterGet("mcpo-fails", k).catch(() => ({ ok: false }));
    if (!r?.ok) r = await local.counterGet("mcpo-fails", k);
    return Number(r.value) >= cfg.failsPerEmail();
  }
  async function noteFail(email) {
    const k = digest(`lock|${email}`).slice(0, 40);
    const r = await limits.counterAdd("mcpo-fails", k, 1, cfg.lockoutMs()).catch(() => ({ ok: false }));
    if (!r?.ok) await local.counterAdd("mcpo-fails", k, 1, cfg.lockoutMs());
  }

  // ---- the store -------------------------------------------------------------
  const shape = (b) => {
    const o = b && typeof b === "object" ? b : {};
    for (const k of ["clients", "reqs", "codes", "grants", "tokens"]) if (!o[k] || typeof o[k] !== "object") o[k] = {};
    return o;
  };
  const prune = (b, t) => {
    for (const [k, r] of Object.entries(b.reqs)) if (!(r.exp > t)) delete b.reqs[k];
    for (const [k, c] of Object.entries(b.codes)) if (!(c.exp > t - 600_000)) delete b.codes[k];
    for (const [k, x] of Object.entries(b.tokens)) if (!(x.exp > t) || !b.grants[x.g] || b.grants[x.g].revokedAt) delete b.tokens[k];
    for (const [k, g] of Object.entries(b.grants)) if (g.revokedAt && t - Date.parse(g.revokedAt) > REVOKED_KEEP_MS) delete b.grants[k];
    const inUse = new Set(Object.values(b.grants).filter((g) => !g.revokedAt).map((g) => g.clientId));
    for (const [k, c] of Object.entries(b.clients)) if (!inUse.has(k) && t - (Number(c.usedAt) || Number(c.at) || 0) > CLIENT_IDLE_MS) delete b.clients[k];
    return b;
  };
  // `grows`: a change that adds a record (a client, a pending request) is
  // refused (503) once the document would pass its size cap.
  const FULL = Symbol("full");
  async function change(fn, { grows = false } = {}) {
    let out;
    const r = await store.update((raw) => {
      const b = prune(shape(raw), now());
      const v = fn(b);
      if (v === SKIP_UPDATE) { out = undefined; return SKIP_UPDATE; }
      if (v === FULL) { out = FULL; return SKIP_UPDATE; }
      if (grows && Buffer.byteLength(JSON.stringify(b)) > cfg.documentMaxBytes()) { out = FULL; return SKIP_UPDATE; }
      out = v;
      return b;
    }, { fallback: {} });
    if (!r?.ok || out === FULL) throw Object.assign(new Error("connector sign-in store unavailable"), { statusCode: 503 });
    return out;
  }
  async function view() {
    const r = await store.read();
    if (!r?.ok) throw Object.assign(new Error("connector sign-in store unavailable"), { statusCode: 503 });
    return shape(r.body);
  }

  // A verified access token's grant, kept briefly in this process (a revoke
  // here clears it; another replica's revoke is seen within ACCESS_CACHE_MS).
  const accessCache = new Map();
  const forgetGrant = (gid) => { for (const [k, v] of accessCache) if (v.grant.id === gid) accessCache.delete(k); };

  function grantView(g, id) { return { id, keyId: g.keyId, capUsd: g.capUsd, clientId: g.clientId, scope: g.scope }; }

  function issueTokens(b, gid, fam) {
    const t = now();
    const access = `${ACCESS_PREFIX}${b64url(randomBytes(32))}`;
    const refresh = `${REFRESH_PREFIX}${b64url(randomBytes(32))}`;
    b.tokens[digest(access)] = { g: gid, k: "a", exp: t + cfg.accessTtlMs() };
    b.tokens[digest(refresh)] = { g: gid, k: "r", exp: t + cfg.refreshTtlMs(), fam };
    return { access_token: access, token_type: "Bearer", expires_in: Math.floor(cfg.accessTtlMs() / 1000), refresh_token: refresh, scope: SCOPE };
  }
  function revokeIn(b, gid, why) {
    const g = b.grants[gid];
    if (!g || g.revokedAt) return false;
    g.revokedAt = new Date(now()).toISOString();
    g.revokedWhy = why;
    for (const [k, x] of Object.entries(b.tokens)) if (x.g === gid) delete b.tokens[k];
    for (const [k, c] of Object.entries(b.codes)) if (c.grantId === gid) delete b.codes[k];
    return true;
  }

  /** The grant behind a presented access token: { grant } or { invalid: true }; null when no token of ours is presented. */
  async function resolveBearer(req) {
    const tok = bearerShape(req.headers?.authorization);
    if (tok === null) return null;
    if (!tok) return { invalid: true };
    const key = digest(tok);
    const hit = accessCache.get(key);
    const t = now();
    if (hit && hit.until > t && hit.exp > t) return { grant: hit.grant };
    accessCache.delete(key);
    let b;
    try { b = await view(); } catch { return { unavailable: true }; }
    const x = b.tokens[key];
    const g = x && x.k === "a" && x.exp > t ? b.grants[x.g] : null;
    if (!g || g.revokedAt) {
      // Every token is looked up; only a failed lookup is counted, and a
      // client address past the bound gets its failed lookups answered 429
      // (a valid token is never refused here).
      const ipKey = digest(`bad|${netKey(req.ip)}`).slice(0, 40);
      let r = await limits.counterAdd("mcpo-bearer-bad", ipKey, 1, cfg.windowMs()).catch(() => ({ ok: false }));
      if (!r?.ok) r = await local.counterAdd("mcpo-bearer-bad", ipKey, 1, cfg.windowMs());
      return Number(r.value) > cfg.badTokenMax() ? { invalid: true, busy: true } : { invalid: true };
    }
    const grant = grantView(g, x.g);
    if (accessCache.size > 5000) accessCache.delete(accessCache.keys().next().value);
    accessCache.set(key, { until: t + ACCESS_CACHE_MS, exp: x.exp, grant });
    if (t - (Date.parse(g.lastUsedAt || 0) || 0) > TOUCH_MS) {
      const net = coarseNetwork(req.ip);
      change((bb) => { const gg = bb.grants[x.g]; if (!gg || gg.revokedAt) return SKIP_UPDATE; gg.lastUsedAt = new Date(t).toISOString(); if (net) gg.lastNetwork = net; return true; })
        .catch(() => { /* the audit time is advisory */ });
    }
    return { grant };
  }

  // ---- grants for the balance page --------------------------------------------
  async function grantsForEmail(email) {
    const e = normEmail(email);
    const b = await view();
    const out = [];
    for (const [id, g] of Object.entries(b.grants)) {
      if (g.email !== e || g.revokedAt) continue;
      out.push({ id, app: g.clientName, keyId: g.keyId, capUsd: g.capUsd, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt || null, lastNetwork: g.lastNetwork || null, spentTodayUsd: await credits.grantSpentToday(g.keyId, id).catch(() => null) });
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async function revokeForEmail(email, id) {
    const e = normEmail(email);
    if (!ID_RE.test(String(id || ""))) return false;
    const ok = await change((b) => (b.grants[id]?.email === e ? revokeIn(b, id, "owner") : false));
    if (ok) forgetGrant(id);
    return Boolean(ok);
  }
  const capOf = (v) => {
    const n = Number(String(v ?? "").trim());
    const max = creditsBalanceMaxCents() / 100;
    return Number.isFinite(n) && n >= 0.01 && n <= max && Math.round(n * 100) === n * 100 ? n : null;
  };
  async function setCapForEmail(email, id, capRaw) {
    const e = normEmail(email);
    const cap = capOf(capRaw);
    if (cap == null || !ID_RE.test(String(id || ""))) return { ok: false, status: 400 };
    const ok = await change((b) => { const g = b.grants[id]; if (!g || g.email !== e || g.revokedAt) return false; g.capUsd = cap; return true; });
    if (ok) forgetGrant(id);
    return ok ? { ok: true, capUsd: cap } : { ok: false, status: 404 };
  }

  // ---- the consent request -------------------------------------------------------
  const csrfOf = (rid, cookie) => mac("csrf", `${rid}|${digest(cookie)}`);
  async function sendCode(rid, email, ip, appName) {
    // Every address gets a code, as every address gets a sign-in link on the
    // balance page: a purchase is made signed in, so a first purchase starts
    // here the same way. The answer is the same for every address.
    if (await over("send-ip", netKey(ip), cfg.sendsPerIp()) || await over("send-email", email, cfg.sendsPerEmail()) || await locked(email)) return false;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const t = now();
    const set = await change((b) => {
      const r = b.reqs[rid];
      if (!r) return false;
      r.otp = { h: mac("otp", `${rid}|${email}|${code}`), email, exp: t + cfg.emailCodeTtlMs(), tries: 0 };
      return true;
    });
    if (!set) return false;
    const m = buildCodeEmail({ code, appName });
    const sent = await sendEmail({ to: email, subject: headerText(m.subject), html: m.html, text: m.text }).catch(() => false);
    if (!sent) log("[mcp-oauth] a sign-in code email was not sent");
    return sent;
  }

  function mount(app, { express, clientIp }) {
    // Switches set, private table missing: the sign-in's own routes answer a
    // generic 503 (nothing names what is missing); /mcp itself is untouched.
    const OWN = /^\/(oauth\/|\.well-known\/oauth-|mcp\/credits(\/|$))/;
    app.use((req, res, next) => {
      if (!OWN.test(req.path) || !waiting()) return next();
      res.set("Cache-Control", "no-store").set("Retry-After", "300");
      return res.status(503).json({ error: "temporarily_unavailable", error_description: "Connecting an app to credits is unavailable right now. Try again later." });
    });
    const form = express.urlencoded({ extended: false, limit: "8kb" });
    const json = express.json({ limit: "16kb" });
    const secure = /^https:/i.test(baseUrl);
    const siteOrigin = (() => { try { return new URL(baseUrl).origin; } catch { return ""; } })();
    const noStore = (res) => res.set("Cache-Control", "no-store").set("Pragma", "no-cache").set("X-Robots-Tag", "noindex, nofollow");
    const cors = (res) => res.set("Access-Control-Allow-Origin", "*").set("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version").set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    const oauthErr = (res, status, error, description) => noStore(res).status(status).json({ error, ...(description ? { error_description: description } : {}) });
    const busy = (res) => { noStore(res).set("Retry-After", "60"); return res.status(429).json({ error: "invalid_request", error_description: "Too many requests. Try again later." }); };
    const resourceMeta = (resource) => ({ resource, authorization_servers: [baseUrl], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "Agent402 MCP connector", resource_documentation: `${baseUrl}/llms.txt` });
    const challenge = (path, invalid) => `Bearer realm="agent402", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${path}", scope="${SCOPE}"${invalid ? ', error="invalid_token"' : ""}`;
    const unauthorized = (res, path, invalid) => {
      noStore(res).set("WWW-Authenticate", challenge(path, invalid)).set("Access-Control-Allow-Origin", "*").set("Access-Control-Expose-Headers", "WWW-Authenticate");
      return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: invalid ? "The access token is expired or revoked. Sign in again." : "Sign in to pay for tool calls from your Agent402 credits." }, id: null });
    };
    // The consent answers: never framed, forms only to this site, the card
    // checkout and the app's own return address.
    const pageHeaders = (res, returnOrigin = null) => {
      noStore(res).set("X-Frame-Options", "DENY").set("Referrer-Policy", "no-referrer");
      res.set("Content-Security-Policy", `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self' https://checkout.stripe.com${returnOrigin ? ` ${returnOrigin}` : ""}; frame-ancestors 'none'`);
      return res;
    };
    const cookieOut = (v, maxAgeS) => `${OAUTH_COOKIE}=${v}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
    const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
    const hostOf = (u) => { try { return new URL(u).host; } catch { return "?"; } };
    const errPage = (res, status, title, text) => pageHeaders(res).status(status).type("html").send(consentErrorPage(baseUrl, title, text));
    const redirectWith = (res, uri, params) => {
      const u = new URL(uri);
      for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
      noStore(res).redirect(303, u.toString());
    };

    // ---- metadata (RFC 9728, RFC 8414) ----
    const prm = (resource) => (req, res, next) => { if (!enabled()) return next(); cors(res).set("Cache-Control", "public, max-age=300").json(resourceMeta(resource)); };
    app.get("/.well-known/oauth-protected-resource", prm(`${baseUrl}/mcp`));
    app.get("/.well-known/oauth-protected-resource/mcp", prm(`${baseUrl}/mcp`));
    app.get(`/.well-known/oauth-protected-resource${AUTH_MCP_PATH}`, prm(`${baseUrl}${AUTH_MCP_PATH}`));
    app.get("/.well-known/oauth-authorization-server", (req, res, next) => {
      if (!enabled()) return next();
      cors(res).set("Cache-Control", "public, max-age=300").json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        revocation_endpoint: `${baseUrl}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [SCOPE],
        authorization_response_iss_parameter_supported: true,
        service_documentation: `${baseUrl}/llms.txt`,
      });
    });
    for (const p of ["/oauth/register", "/oauth/token", "/oauth/revoke"]) app.options(p, (req, res, next) => { if (!enabled()) return next(); cors(res).status(204).end(); });

    // ---- dynamic client registration (RFC 7591), public clients only ----
    app.post("/oauth/register", json, async (req, res, next) => {
      if (!enabled()) return next();
      cors(res);
      if (await over("register", netKey(clientIp(req)), cfg.registerPerIp())) return busy(res);
      const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : null;
      if (!uris || !uris.length || uris.length > 5 || !uris.every(redirectUriAllowed)) return oauthErr(res, 400, "invalid_redirect_uri", "redirect_uris: one to five https addresses, or http on localhost, with no fragment.");
      if (b.token_endpoint_auth_method != null && b.token_endpoint_auth_method !== "none") return oauthErr(res, 400, "invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are registered.");
      const gts = b.grant_types == null ? ["authorization_code", "refresh_token"] : b.grant_types;
      if (!Array.isArray(gts) || !gts.every((g) => g === "authorization_code" || g === "refresh_token")) return oauthErr(res, 400, "invalid_client_metadata", "grant_types: authorization_code and refresh_token only.");
      const rts = b.response_types == null ? ["code"] : b.response_types;
      if (!Array.isArray(rts) || !rts.every((r) => r === "code")) return oauthErr(res, 400, "invalid_client_metadata", "response_types: code only.");
      const name = String(typeof b.client_name === "string" ? b.client_name : "An app").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "").trim().slice(0, 80) || "An app";
      const id = `c_${hex(16)}`;
      const t = now();
      try {
        await change((s) => {
          const ids = Object.keys(s.clients);
          if (ids.length >= CLIENTS_MAX) delete s.clients[ids.sort((x, y) => (s.clients[x].usedAt || s.clients[x].at) - (s.clients[y].usedAt || s.clients[y].at))[0]];
          s.clients[id] = { name, redirectUris: [...uris], at: t };
          return true;
        }, { grows: true });
      } catch { return oauthErr(res, 503, "temporarily_unavailable"); }
      noStore(res).status(201).json({ client_id: id, client_id_issued_at: Math.floor(t / 1000), client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: gts, response_types: ["code"], scope: SCOPE });
    });

    // ---- authorize ----
    app.get("/oauth/authorize", async (req, res, next) => {
      if (!enabled()) return next();
      if (await over("authorize", netKey(clientIp(req)), cfg.authorizePerIp())) return errPage(res, 429, "Too many requests", "Try again later.");
      const q = req.query || {};
      const clientId = str(q.client_id, 40), redirectUri = str(q.redirect_uri, 500);
      let s;
      try { s = await view(); } catch { return errPage(res, 503, "Sign-in is unavailable", "Try again in a moment."); }
      const client = clientId && CLIENT_RE.test(clientId) && Object.hasOwn(s.clients, clientId) ? s.clients[clientId] : null;
      if (!client) return errPage(res, 400, "Unknown app", "This app is not registered here. Remove the connector and add it again.");
      if (!redirectUri || !client.redirectUris.includes(redirectUri)) return errPage(res, 400, "Unknown return address", "This app asked to return to an address it did not register, so nothing was sent to it.");
      const state = str(q.state, 500);
      // A request this server will not start is answered here, never by a
      // redirect: any app can register a return address, so an error sent
      // there would make this site a redirector for it.
      const bad = (error, description) => errPage(res, 400, "This sign-in request is not valid", `${description} (${error})`);
      if (q.response_type !== "code") return bad("unsupported_response_type", "response_type must be code.");
      if (!state) return bad("invalid_request", "state is required.");
      if (q.code_challenge_method !== "S256") return bad("invalid_request", "PKCE with code_challenge_method S256 is required.");
      if (!CHALLENGE_RE.test(String(q.code_challenge || ""))) return bad("invalid_request", "code_challenge must be a base64url SHA-256 digest.");
      if (q.scope != null && String(q.scope).split(/\s+/).filter(Boolean).some((x) => x !== SCOPE)) return bad("invalid_scope", `The only scope is ${SCOPE}.`);
      const resource = q.resource == null ? null : str(q.resource, 500);
      if (q.resource != null && (!resource || !resources.has(resource))) return bad("invalid_target", "resource must name this server's MCP connector.");
      const rid = hex(16);
      const cookie = b64url(randomBytes(32));
      try {
        // Pending requests are capped: past the cap no new one starts (503).
        await change((b) => {
          if (Object.keys(b.reqs).length >= cfg.pendingMax()) return FULL;
          b.reqs[rid] = { clientId, redirectUri, challenge: q.code_challenge, state, resource, cookie: digest(cookie), at: now(), exp: now() + cfg.requestTtlMs() };
          if (b.clients[clientId]) b.clients[clientId].usedAt = now();
          return true;
        }, { grows: true });
      } catch { return errPage(res, 503, "Sign-in is unavailable", "Try again in a moment."); }
      res.setHeader("Set-Cookie", cookieOut(cookie, Math.floor(cfg.requestTtlMs() / 1000)));
      noStore(res).redirect(303, `${OAUTH_CONSENT_PATH}?rid=${rid}`);
    });

    // The pending request this browser started, or null.
    async function pending(req, rid) {
      if (!ID_RE.test(String(rid || ""))) return null;
      const cookie = readCookie(req, OAUTH_COOKIE);
      if (!COOKIE_RE.test(cookie)) return null;
      const s = await view();
      const r = s.reqs[rid];
      if (!r || !(r.exp > now()) || !sameBytes(r.cookie, digest(cookie))) return null;
      const client = s.clients[r.clientId];
      if (!client) return null;
      return { r, client, cookie };
    }
    async function render(res, rid, p, { message = "", error = "", status = 200 } = {}) {
      const { r, client, cookie } = p;
      const step = r.email ? "choose" : r.otp && r.otp.exp > now() ? "code" : "email";
      const balances = r.email ? await credits.balancesForEmail(r.email).catch(() => []) : [];
      const packs = Object.entries(sellablePacks()).map(([id, x]) => ({ id, usd: x.cents / 100 }));
      pageHeaders(res, originOf(r.redirectUri)).status(status).type("html").send(consentPage(baseUrl, {
        step, rid, csrf: csrfOf(rid, cookie), client: { name: client.name, returnHost: hostOf(r.redirectUri) },
        email: r.email || r.otp?.email || "", balances, packs, salesOn: creditsSalesEnabled(), capUsd: cfg.defaultCapUsd(), capMaxUsd: creditsBalanceMaxCents() / 100,
        message: message || (step === "code" ? "A six-digit code is on its way to this email." : ""), error,
      }));
    }
    const expired = (res) => errPage(res, 400, "This sign-in has expired", "Go back to the app and connect again.");

    app.get(OAUTH_CONSENT_PATH, async (req, res, next) => {
      if (!enabled()) return next();
      let p;
      try { p = await pending(req, req.query.rid); } catch { return errPage(res, 503, "Sign-in is unavailable", "Try again in a moment."); }
      if (!p) return expired(res);
      return render(res, String(req.query.rid), p);
    });

    // Back from a card purchase started here: the key is claimed, and a code
    // goes to the email the purchase was made with.
    app.get(`${OAUTH_CONSENT_PATH}/bought`, async (req, res, next) => {
      if (!enabled()) return next();
      const rid = String(req.query.rid || "");
      let p;
      try { p = await pending(req, rid); } catch { return errPage(res, 503, "Sign-in is unavailable", "Try again in a moment."); }
      if (!p) return expired(res);
      const session = String(req.query.session || "");
      let message = "";
      if (p.r.email && /^cs_[A-Za-z0-9_]{1,200}$/.test(session)) {
        const c = await credits.claim(session).catch(() => ({ status: "error" }));
        const owner = c && (c.status === "minted" || c.status === "claimed") ? await credits.sessionOwner(session).catch(() => null) : null;
        if (owner && normEmail(owner.email) === p.r.email) {
          message = "Your credits are ready. Pick the balance below.";
        } else if (owner) {
          message = "That purchase was made with another email. Sign in with it to use the balance.";
        } else {
          message = c?.status === "unpaid" || c?.status === "error" ? "The purchase is not confirmed yet. Reload this page in a moment." : "The purchase did not load a balance. Check your email for the receipt or refund.";
        }
      }
      try { p = await pending(req, rid); } catch { return errPage(res, 503, "Sign-in is unavailable", "Try again in a moment."); }
      if (!p) return expired(res);
      return render(res, rid, p, { message });
    });

    app.post(OAUTH_CONSENT_PATH, form, async (req, res, next) => {
      if (!enabled()) return next();
      const rid = String(req.body?.rid || "");
      if (!sameOriginWrite(req, siteOrigin)) return errPage(res, 403, "Open the sign-in again", "Go back to the app and connect again.");
      let p;
      try { p = await pending(req, rid); } catch { return errPage(res, 503, "Sign-in is unavailable", "Try again in a moment."); }
      if (!p) return expired(res);
      const csrf = String(req.body?.csrf || "");
      if (!sameBytes(csrf, csrfOf(rid, p.cookie))) return errPage(res, 403, "Open the sign-in again", "Go back to the app and connect again.");
      const action = String(req.body?.action || "");
      const ip = clientIp(req);
      const { r } = p;

      if (action === "deny") {
        await change((b) => { delete b.reqs[rid]; return true; }).catch(() => {});
        res.setHeader("Set-Cookie", cookieOut("", 0));
        return redirectWith(res, r.redirectUri, { error: "access_denied", state: r.state, iss: baseUrl });
      }
      if (action === "restart") {
        await change((b) => { if (b.reqs[rid]) { delete b.reqs[rid].otp; delete b.reqs[rid].email; } return true; }).catch(() => {});
        return render(res, rid, await pending(req, rid));
      }
      if (action === "email") {
        const email = normEmail(req.body?.email);
        if (!validEmail(email)) return render(res, rid, p, { error: "Enter the email address that holds your credits.", status: 400 });
        await sendCode(rid, email, ip, p.client.name).catch((e) => log(`[mcp-oauth] code send failed: ${String(e?.message || e).slice(0, 120)}`));
        const again = await pending(req, rid);
        if (!again) return expired(res);
        if (!again.r.otp) return render(res, rid, again, { error: "Too many requests. Try again later.", status: 429 });
        return render(res, rid, again);
      }
      if (action === "code") {
        const otp = r.otp;
        const code = String(req.body?.code || "").trim();
        if (!otp || !(otp.exp > now())) return render(res, rid, p, { error: "That code has expired. Ask for a new one.", status: 400 });
        if (await locked(otp.email)) return render(res, rid, p, { error: "Too many requests. Try again later.", status: 429 });
        let verdict = "bad";
        await change((b) => {
          const rr = b.reqs[rid];
          if (!rr?.otp || rr.otp.h !== otp.h) { verdict = "bad"; return SKIP_UPDATE; }
          rr.otp.tries = (Number(rr.otp.tries) || 0) + 1;
          const good = Boolean(rr.otp.h) && /^\d{6}$/.test(code) && sameBytes(rr.otp.h, mac("otp", `${rid}|${rr.otp.email}|${code}`));
          if (good) { rr.email = rr.otp.email; rr.signedInAt = now(); delete rr.otp; verdict = "ok"; return true; }
          if (rr.otp.tries >= cfg.emailCodeTries()) { delete rr.otp; verdict = "spent"; } else verdict = "bad";
          return true;
        }).catch(() => { verdict = "error"; });
        if (verdict === "error") return errPage(res, 503, "Sign-in is unavailable", "Try again in a moment.");
        if (verdict !== "ok") await noteFail(otp.email);
        const again = await pending(req, rid);
        if (!again) return expired(res);
        if (verdict === "ok") return render(res, rid, again);
        return render(res, rid, again, { error: verdict === "spent" ? "That code no longer works. Ask for a new one." : "That code did not match.", status: 400 });
      }
      if (action === "buy") {
        if (!creditsSalesEnabled()) return render(res, rid, p, { error: "Credits are not on sale right now.", status: 400 });
        // A purchase is made signed in (the emailed code), bound to that email,
        // through the same checkout the balance page starts: the purchase
        // checks, card authentication and limits in credits.createCheckout.
        if (!r.email) return render(res, rid, p, { error: "Sign in with your email first.", status: 400 });
        if (await over("buy", netKey(ip), cfg.sendsPerIp())) return render(res, rid, p, { error: "Too many requests. Try again later.", status: 429 });
        try {
          const co = await credits.createCheckout(String(req.body?.pack || ""), { email: r.email, ip, returnTo: { success: `${baseUrl}${OAUTH_CONSENT_PATH}/bought?rid=${rid}&session={CHECKOUT_SESSION_ID}`, cancel: `${baseUrl}${OAUTH_CONSENT_PATH}?rid=${rid}` } });
          return noStore(res).redirect(303, co.url);
        } catch (e) {
          if (e?.buyerSafe) return render(res, rid, p, { error: String(e.message).slice(0, 200), status: e.statusCode === 429 ? 429 : 400 });
          log(`[mcp-oauth] checkout failed: ${String(e?.message || e).slice(0, 120)}`);
          return render(res, rid, p, { error: "Could not start checkout. Try again in a moment.", status: 503 });
        }
      }
      if (action === "approve") {
        if (!r.email) return render(res, rid, p, { status: 400 });
        const keyId = String(req.body?.keyId || "");
        const cap = capOf(req.body?.capUsd);
        if (cap == null) return render(res, rid, p, { error: `Enter a daily cap between $0.01 and $${(creditsBalanceMaxCents() / 100).toFixed(2)}.`, status: 400 });
        const held = await credits.balancesForEmail(r.email).catch(() => []);
        const b0 = held.find((x) => x.keyId === keyId);
        if (!b0 || b0.disabled || b0.refund || b0.frozen) return render(res, rid, p, { error: "Pick an open balance on this email.", status: 400 });
        const code = b64url(randomBytes(32));
        const gid = hex(16);
        const t = now();
        let ok = false, full = false;
        try {
          await change((b) => {
            const rr = b.reqs[rid];
            if (!rr || rr.email !== r.email) return SKIP_UPDATE;
            if (Object.values(b.grants).filter((g) => g.email === r.email && !g.revokedAt).length >= GRANTS_PER_EMAIL) { full = true; return SKIP_UPDATE; }
            const client = b.clients[rr.clientId];
            b.grants[gid] = { clientId: rr.clientId, clientName: client?.name || "An app", email: r.email, keyId, capUsd: cap, scope: SCOPE, resource: rr.resource, createdAt: new Date(t).toISOString(), lastUsedAt: null, lastNetwork: coarseNetwork(ip) };
            b.codes[digest(code)] = { grantId: gid, clientId: rr.clientId, redirectUri: rr.redirectUri, challenge: rr.challenge, resource: rr.resource, exp: t + cfg.codeTtlMs(), used: false };
            delete b.reqs[rid];
            ok = true;
            return true;
          });
        } catch { return errPage(res, 503, "Sign-in is unavailable", "Try again in a moment."); }
        if (full) return render(res, rid, p, { error: `This email already has ${GRANTS_PER_EMAIL} connected apps. Disconnect one on your balance page first.`, status: 400 });
        if (!ok) return expired(res);
        res.setHeader("Set-Cookie", cookieOut("", 0));
        log(`[mcp-oauth] a connector grant was made for key ${keyId}`);
        return redirectWith(res, r.redirectUri, { code, state: r.state, iss: baseUrl });
      }
      return render(res, rid, p, { status: 400 });
    });

    // ---- token ----
    app.post("/oauth/token", form, json, async (req, res, next) => {
      if (!enabled()) return next();
      cors(res);
      const b = req.body && typeof req.body === "object" ? req.body : {};
      const clientId = str(b.client_id, 40);
      if (await over("token", netKey(clientIp(req)), cfg.tokenPerIp()) || (clientId && await over("token-client", clientId, cfg.tokenPerIp()))) return busy(res);
      if (!clientId || !CLIENT_RE.test(clientId)) return oauthErr(res, 401, "invalid_client", "client_id is required.");
      const gt = b.grant_type;
      let out = null;
      try {
        if (gt === "authorization_code") {
          const code = str(b.code, 200), verifier = str(b.code_verifier, 200), redirectUri = str(b.redirect_uri, 500);
          if (!code || !verifier || !VERIFIER_RE.test(verifier)) return oauthErr(res, 400, "invalid_request", "code and a PKCE code_verifier are required.");
          const resource = b.resource == null ? null : str(b.resource, 500);
          out = await change((s) => {
            if (!s.clients[clientId]) return { err: [401, "invalid_client"] };
            const k = digest(code);
            const c = s.codes[k];
            if (!c) return { err: [400, "invalid_grant"] };
            if (c.used) { revokeIn(s, c.grantId, "code-reuse"); return { err: [400, "invalid_grant"], revoked: c.grantId }; }
            c.used = true;
            if (!(c.exp > now()) || c.clientId !== clientId || c.redirectUri !== redirectUri || !sameBytes(s256(verifier), c.challenge)) { revokeIn(s, c.grantId, "code-refused"); return { err: [400, "invalid_grant"], revoked: c.grantId }; }
            if (resource != null && !(resources.has(resource) && (c.resource == null || c.resource === resource))) { revokeIn(s, c.grantId, "code-refused"); return { err: [400, "invalid_target"], revoked: c.grantId }; }
            const g = s.grants[c.grantId];
            if (!g || g.revokedAt) return { err: [400, "invalid_grant"] };
            s.clients[clientId].usedAt = now();
            return { ok: issueTokens(s, c.grantId, hex(8)) };
          });
        } else if (gt === "refresh_token") {
          const rt = str(b.refresh_token, 200);
          if (!rt || !TOKEN_RE.test(rt) || !rt.startsWith(REFRESH_PREFIX)) return oauthErr(res, 400, "invalid_grant");
          out = await change((s) => {
            const k = digest(rt);
            const x = s.tokens[k];
            if (!x || x.k !== "r") {
              // A rotated refresh token presented again: the whole grant ends.
              const spent = Object.entries(s.grants).find(([, g]) => Array.isArray(g.spentRefresh) && g.spentRefresh.includes(k));
              if (spent) { revokeIn(s, spent[0], "refresh-reuse"); return { err: [400, "invalid_grant"], revoked: spent[0] }; }
              return { err: [400, "invalid_grant"] };
            }
            const g = s.grants[x.g];
            if (!g || g.revokedAt || !(x.exp > now())) return { err: [400, "invalid_grant"] };
            if (g.clientId !== clientId) return { err: [400, "invalid_grant"] };
            delete s.tokens[k];
            g.spentRefresh = [...(Array.isArray(g.spentRefresh) ? g.spentRefresh : []), k].slice(-50);
            return { ok: issueTokens(s, x.g, x.fam) };
          });
        } else {
          return oauthErr(res, 400, "unsupported_grant_type");
        }
      } catch { return oauthErr(res, 503, "temporarily_unavailable"); }
      if (out?.revoked) { forgetGrant(out.revoked); log("[mcp-oauth] a connector grant was revoked: a spent code or refresh token was presented again"); }
      if (!out?.ok) return oauthErr(res, out?.err?.[0] || 400, out?.err?.[1] || "invalid_grant");
      noStore(res).json(out.ok);
    });

    // ---- revoke (RFC 7009): the whole grant behind the token ends ----
    app.post("/oauth/revoke", form, json, async (req, res, next) => {
      if (!enabled()) return next();
      cors(res);
      if (await over("token", netKey(clientIp(req)), cfg.tokenPerIp())) return busy(res);
      const tok = str(req.body?.token, 200);
      if (tok && TOKEN_RE.test(tok)) {
        const gid = await change((s) => { const x = s.tokens[digest(tok)]; if (!x) return SKIP_UPDATE; revokeIn(s, x.g, "client"); return x.g; }).catch(() => null);
        if (gid) forgetGrant(gid);
      }
      noStore(res).status(200).json({});
    });

    // ---- /mcp: a token of ours pays from credits; /mcp/credits asks for one ----
    app.post("/mcp", async (req, res, next) => {
      if (!enabled()) return next();
      const r = await resolveBearer(req);
      if (!r) return next();
      if (r.unavailable) return noStore(res).status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "Sign-in is unavailable right now; retry shortly. Nothing was charged." }, id: req.body?.id ?? null });
      if (r.busy) { noStore(res).set("Retry-After", "60"); return res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests. Try again later." }, id: req.body?.id ?? null }); }
      if (r.invalid) return unauthorized(res, "/mcp", true);
      req.mcpCreditsGrant = r.grant;
      next();
    });
    app.all(AUTH_MCP_PATH, async (req, res, next) => {
      if (!enabled()) return next();
      const rest = req.url.slice(AUTH_MCP_PATH.length);
      if (req.method !== "OPTIONS") {
        const r = await resolveBearer(req);
        if (r?.busy) { noStore(res).set("Retry-After", "60"); return res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests. Try again later." }, id: req.body?.id ?? null }); }
        if (!r || r.invalid) return unauthorized(res, AUTH_MCP_PATH, Boolean(r?.invalid));
        if (r.unavailable) return noStore(res).status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "Sign-in is unavailable right now; retry shortly. Nothing was charged." }, id: req.body?.id ?? null });
        req.mcpCreditsGrant = r.grant;
      }
      req.url = `/mcp${rest}`;
      next();
    });

    // ---- the balance page's connected apps (session of /credits/account) ----
    const who = async (req, res) => {
      const email = account ? await account.sessionEmail(readCookie(req, ACCOUNT_COOKIE)).catch(() => null) : null;
      if (!email) { noStore(res).status(401).json({ error: "Sign in to manage your balance.", signIn: ACCOUNT_PATH }); return null; }
      return email;
    };
    const writeOk = (req, res) => {
      if (sameOriginWrite(req, siteOrigin)) return true;
      noStore(res).status(403).json({ error: "This request must come from the balance page." });
      return false;
    };
    app.get(`${ACCOUNT_PATH}/connected.json`, async (req, res, next) => {
      if (!enabled()) return next();
      const email = await who(req, res);
      if (!email) return;
      try { noStore(res).json({ apps: await grantsForEmail(email), capMaxUsd: creditsBalanceMaxCents() / 100 }); }
      catch { noStore(res).status(503).json({ error: "Could not read connected apps right now." }); }
    });
    app.post(`${ACCOUNT_PATH}/connected/revoke`, json, async (req, res, next) => {
      if (!enabled()) return next();
      if (!writeOk(req, res)) return;
      const email = await who(req, res);
      if (!email) return;
      try { const ok = await revokeForEmail(email, req.body?.id); noStore(res).status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "No connected app with that id is on this account." }); }
      catch { noStore(res).status(503).json({ error: "Could not disconnect right now; try again." }); }
    });
    app.post(`${ACCOUNT_PATH}/connected/cap`, json, async (req, res, next) => {
      if (!enabled()) return next();
      if (!writeOk(req, res)) return;
      const email = await who(req, res);
      if (!email) return;
      try {
        const r = await setCapForEmail(email, req.body?.id, req.body?.capUsd);
        if (r.ok) return noStore(res).json(r);
        noStore(res).status(r.status).json({ error: r.status === 400 ? `Enter a daily cap between $0.01 and $${(creditsBalanceMaxCents() / 100).toFixed(2)}.` : "No connected app with that id is on this account." });
      } catch { noStore(res).status(503).json({ error: "Could not change the cap right now; try again." }); }
    });
  }

  return { enabled, mount, resolveBearer, grantsForEmail, revokeForEmail, setCapForEmail, _view: view };
}
