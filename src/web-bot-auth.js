// Web Bot Auth: verify a signing agent's HTTP Message Signature (RFC 9421)
// and record who it is. Verification only, behind WEB_BOT_AUTH=on (exactly;
// off by default): the protocol is still an Internet-Draft
// (draft-ietf-webbotauth-httpsig-protocol, read 2026-11-18, with
// draft-meunier-webbotauth-httpsig-protocol-02 before it), so this server
// signs nothing and publishes no directory of its own.
//
// Never required and never refusing: a request is served exactly the same
// whether its signature verifies, fails or is absent. The outcome is put on
// the request (`req.webBotAuth`: { verified, agent, keyid } or { verified:
// false, reason }) and counted in PostHog per agent (the `web_bot_auth`
// rollup in src/posthog-observability.js; an unverified claim is counted
// without the agent it names).
//
// What is checked, per the draft:
//   - Signature-Input, Signature and Signature-Agent are RFC 9651 dictionaries
//     (each header at most 4 KB); Signature-Agent's member for the label is an
//     https URI string with no parameters (the legacy bare string is read as
//     that member);
//   - the signature tagged `web-bot-auth` covers "@authority" or
//     "@target-uri", and covers its Signature-Agent member;
//   - `created` and `expires` are present, created not in the future (60 s
//     skew), expires ahead, and expires - created at most 24 hours;
//   - `keyid` is the key's JWK SHA-256 thumbprint (RFC 8037 A.3 for Ed25519)
//     inside the directory the Signature-Agent URL names, and `alg`, when
//     present, is ed25519 (the only algorithm read here);
//   - a `nonce`, when present, is accepted once until the signature expires.
// The directory is the Signature-Agent URL itself, or its origin's
// /.well-known/http-message-signatures-directory when the URL has no path.
// It is fetched over https through the outbound guard (src/tools/fetch-guard.js:
// public addresses only), redirects not followed, 200 only, at most 64 KB and
// 20 keys, in the background: a request whose agent's keys are not cached
// yet reads `directory-pending`, and the keys serve later requests for an
// hour (a failed fetch is not retried for 10 minutes). At most 30 fetches a
// minute and 4 at once, 500 directories cached.
//
// A second branch reads the Trusted Agent Protocol signatures Visa CLI agents
// send (tags `agent-browser-auth` and `agent-payer-auth`), written here from
// RFC 9421 and RFC 9530 (no vendor code). It is a LABEL only, like the branch
// above: a pass sets `req.visaCliAgent` and the rollup's agent "visa-cli", and
// nothing reads either to price, admit, limit or skip a check (proof of work,
// rate limits and payment run the same for a signed request;
// scripts/test-visa-tap.js). What is checked:
//   - Ed25519 only (`alg` ed25519, when present); `keyid` is a 43-character
//     JWK SHA-256 thumbprint whose key is read from the pinned registry
//     origin (TAP_REGISTRY_ORIGIN + /v1/tap/registry/keys/{keyid}), never from
//     a URL the request names; the listing must be active, not simulated, and
//     hold that key active, ed25519, unexpired, with a thumbprint equal to the
//     keyid. Fetched in the background (redirects refused, 200 only, 16 KB, 5 s),
//     cached at most 60 s (a miss 60 s too), 30 fetches a minute, 4 at once, 500
//     cached; a request whose key is not cached yet reads `tap-registry-pending`,
//     a registry that fails reads unverified, and no request ever waits on it;
//   - covered components: @method @authority @path and content-digest for
//     agent-browser-auth (plus @scheme and @query), @method @authority @path for
//     agent-payer-auth, plus content-digest when the request has a body and
//     every payment credential header the request carries (authorization,
//     payment-signature, x-payment); agent-browser-auth never covers
//     authorization or cookie;
//   - @authority and @scheme come from BASE_URL, not the Host header;
//   - created/expires: agent-browser-auth at most 60 s apart and created at most
//     30 s ahead; agent-payer-auth at most 480 s apart and created at most 60 s
//     ahead; expires still ahead;
//   - Content-Digest (sha-256) is computed over the raw request body as it is
//     read (at most 1 MiB), never by reading it here;
//   - a Signature-Agent, when present, is one of the two Visa directory origins
//     (compared, never fetched);
//   - the nonce (required for agent-browser-auth) is used once, claimed in the
//     shared store after everything else passes; a store that does not answer
//     leaves the request unverified.
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { safeFetch } from "./tools/fetch-guard.js";
import { noteWebBotAuth } from "./posthog-observability.js";
import { shared } from "./shared-limits.js";

export const WELL_KNOWN = "/.well-known/http-message-signatures-directory";
export const DIRECTORY_MEDIA_TYPE = "application/http-message-signatures-directory+json";
const MAX_HEADER = 4096;
const MAX_SIGS = 4;
const SKEW_S = 60;
const MAX_WINDOW_S = 86_400;
const DIR_TTL_MS = 3_600_000;
const DIR_FAIL_TTL_MS = 600_000;
const DIR_MAX = 500;
const DIR_MAX_BYTES = 65_536;
const DIR_MAX_KEYS = 20;
const FETCH_PER_MIN = 30;
const FETCH_INFLIGHT = 4;
const NONCE_MAX = 20_000;

export function webBotAuthEnabled(env = process.env) { return env.WEB_BOT_AUTH === "on"; }

// --- Trusted Agent Protocol (Visa CLI) constants ------------------------------------
export const TAP_REGISTRY_ORIGIN = "https://auth.visacli.sh";
export const TAP_TAGS = Object.freeze(["agent-browser-auth", "agent-payer-auth"]);
export const TAP_SIGNATURE_AGENTS = Object.freeze(["https://agenticdirectory.visa.com", "https://sbx.agenticdirectory.visa.com"]);
const TAP_PROFILE = {
  "agent-browser-auth": { maxWindowS: 60, maxAheadS: 30, required: ["@method", "@scheme", "@authority", "@path", "@query", "content-digest"], nonceRequired: true },
  "agent-payer-auth": { maxWindowS: 480, maxAheadS: 60, required: ["@method", "@authority", "@path"], nonceRequired: false },
};
const TAP_PAYMENT_HEADERS = ["authorization", "payment-signature", "x-payment"];
const TAP_KEY_TTL_MS = 60_000;
const TAP_MISS_TTL_MS = 60_000;
const TAP_KEYS_MAX = 500;
const TAP_FETCH_PER_MIN = 30;
const TAP_FETCH_INFLIGHT = 4;
const TAP_REGISTRY_MAX_BYTES = 16_384;
export const TAP_BODY_MAX = 1_048_576;
const TAP_KEYID_RE = /^[A-Za-z0-9_-]{43}$/;

// --- RFC 9651 dictionary (the subset these headers use) ------------------------
// A linear scan over at most MAX_HEADER characters; anything it does not read
// returns null (the header is then ignored).
function parseKey(s, i) {
  const m = /^[a-z*][a-z0-9_\-.*]{0,63}/.exec(s.slice(i, i + 64));
  return m ? [m[0], i + m[0].length] : null;
}
function parseBare(s, i) {
  const c = s[i];
  if (c === '"') {
    let out = "";
    for (let j = i + 1; j < s.length; j++) {
      const ch = s[j];
      if (ch === "\\") { const n = s[j + 1]; if (n !== '"' && n !== "\\") return null; out += n; j++; continue; }
      if (ch === '"') return [{ t: "string", v: out }, j + 1];
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) return null;
      out += ch;
    }
    return null;
  }
  if (c === ":") {
    const end = s.indexOf(":", i + 1);
    if (end < 0) return null;
    const b = s.slice(i + 1, end);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b)) return null;
    return [{ t: "bytes", v: Buffer.from(b, "base64") }, end + 1];
  }
  if (c === "?") { if (s[i + 1] === "1") return [{ t: "bool", v: true }, i + 2]; if (s[i + 1] === "0") return [{ t: "bool", v: false }, i + 2]; return null; }
  const num = /^-?\d{1,15}(?:\.\d{1,3})?/.exec(s.slice(i, i + 20));
  if (num) return [{ t: num[0].includes(".") ? "decimal" : "integer", v: Number(num[0]) }, i + num[0].length];
  const tok = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]{0,255}/.exec(s.slice(i, i + 256));
  if (tok) return [{ t: "token", v: tok[0] }, i + tok[0].length];
  return null;
}
function parseParams(s, i) {
  const params = [];
  while (s[i] === ";") {
    i++;
    while (s[i] === " ") i++;
    const k = parseKey(s, i);
    if (!k) return null;
    i = k[1];
    let v = { t: "bool", v: true };
    if (s[i] === "=") { const b = parseBare(s, i + 1); if (!b) return null; [v, i] = b; }
    if (params.length >= 16) return null;
    params.push([k[0], v]);
  }
  return [params, i];
}
function parseItemOrInner(s, i) {
  if (s[i] === "(") {
    i++;
    const items = [];
    for (;;) {
      while (s[i] === " ") i++;
      if (s[i] === ")") { i++; break; }
      if (items.length >= 32) return null;
      const b = parseBare(s, i);
      if (!b) return null;
      const p = parseParams(s, b[1]);
      if (!p) return null;
      items.push({ ...b[0], params: p[0] });
      i = p[1];
      if (s[i] !== " " && s[i] !== ")") return null;
    }
    const p = parseParams(s, i);
    if (!p) return null;
    return [{ t: "inner", v: items, params: p[0] }, p[1]];
  }
  const b = parseBare(s, i);
  if (!b) return null;
  const p = parseParams(s, b[1]);
  if (!p) return null;
  return [{ ...b[0], params: p[0] }, p[1]];
}
/** A dictionary header as an ordered Map, or null. */
export function parseDictionary(value) {
  if (typeof value !== "string" || value.length > MAX_HEADER) return null;
  const s = value.trim();
  const out = new Map();
  let i = 0;
  while (i < s.length) {
    const k = parseKey(s, i);
    if (!k) return null;
    i = k[1];
    let member;
    if (s[i] === "=") { const r = parseItemOrInner(s, i + 1); if (!r) return null; [member, i] = r; }
    else { const p = parseParams(s, i); if (!p) return null; member = { t: "bool", v: true, params: p[0] }; i = p[1]; }
    if (out.size >= 16 && !out.has(k[0])) return null;
    out.set(k[0], member);
    while (s[i] === " " || s[i] === "\t") i++;
    if (i >= s.length) break;
    if (s[i] !== ",") return null;
    i++;
    while (s[i] === " " || s[i] === "\t") i++;
    if (i >= s.length) return null;
  }
  return out;
}
function serializeBare(item) {
  if (item.t === "string") return `"${item.v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (item.t === "integer" || item.t === "decimal") return String(item.v);
  if (item.t === "bool") return item.v ? "?1" : "?0";
  if (item.t === "token") return item.v;
  if (item.t === "bytes") return `:${item.v.toString("base64")}:`;
  return "";
}
function serializeParams(params) {
  return params.map(([k, v]) => (v.t === "bool" && v.v === true ? `;${k}` : `;${k}=${serializeBare(v)}`)).join("");
}
function serializeInner(inner) {
  return `(${inner.v.map((it) => serializeBare(it) + serializeParams(it.params || [])).join(" ")})${serializeParams(inner.params || [])}`;
}
const paramOf = (params, name) => { for (const [k, v] of params || []) if (k === name) return v; return undefined; };

/** Header reader timed by scripts/test-redos-request-headers.js: never throws. */
export function readSignatureHeaders(headers = {}) {
  try {
    const h = (n) => { const v = headers[n]; return typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : null; };
    const input = h("signature-input"), sig = h("signature"), agent = h("signature-agent");
    if (!input || !sig) return null;
    const inputs = parseDictionary(input), sigs = parseDictionary(sig);
    if (!inputs || !sigs) return null;
    let agents = agent ? parseDictionary(agent) : null;
    let legacyAgent = null;
    if (agent && !agents) {
      const bare = parseBare(agent.trim().slice(0, MAX_HEADER), 0);
      if (bare && bare[0].t === "string" && bare[1] === agent.trim().length) legacyAgent = bare[0].v;
    }
    return { inputs, sigs, agents, legacyAgent, agentRaw: agent };
  } catch { return null; }
}

// --- signature base (RFC 9421 section 2.5) -------------------------------------
function authorityOf(req) {
  const raw = String(req.headers?.host || "").trim().toLowerCase();
  return raw.replace(/:(443|80)$/, (m, p) => ((p === "443" && schemeOf(req) === "https") || (p === "80" && schemeOf(req) === "http") ? "" : m));
}
function schemeOf(req) { return req.protocol === "https" || req.secure ? "https" : (req.protocol || "http"); }
function targetOf(req) { return String(req.originalUrl || req.url || "/"); }
function componentValue(req, item, parsed, label, origin) {
  const name = item.v;
  const params = item.params || [];
  const target = targetOf(req);
  const q = target.indexOf("?");
  if (name === "signature-agent") {
    const key = paramOf(params, "key");
    if (params.some(([k]) => k !== "key")) return null;
    if (key) {
      if (key.t !== "string" || !parsed.agents) return null;
      const m = parsed.agents.get(key.v);
      if (!m || m.t !== "string" || (m.params && m.params.length)) return null;
      return serializeBare(m);
    }
    return parsed.agentRaw == null ? null : String(parsed.agentRaw).trim();
  }
  if (params.length) return null; // sf, bs, req, tr, name: not read here
  switch (name) {
    case "@method": return String(req.method || "GET").toUpperCase();
    case "@authority": return origin ? origin.authority : authorityOf(req);
    case "@scheme": return origin ? origin.scheme : schemeOf(req);
    case "@target-uri": return origin ? `${origin.scheme}://${origin.authority}${target}` : `${schemeOf(req)}://${authorityOf(req)}${target}`;
    case "@request-target": return target;
    case "@path": return (q < 0 ? target : target.slice(0, q)) || "/";
    case "@query": return q < 0 ? "?" : target.slice(q);
    default: {
      if (name.startsWith("@") || !/^[a-z0-9!#$%&'*+\-.^_`|~]{1,64}$/.test(name)) return null;
      const v = req.headers?.[name];
      if (v == null) return null;
      return (Array.isArray(v) ? v.join(", ") : String(v)).trim();
    }
  }
}
export function signatureBase(req, inner, parsed, label, origin = null) {
  const lines = [];
  for (const item of inner.v) {
    if (item.t !== "string") return null;
    const value = componentValue(req, item, parsed, label, origin);
    if (value == null) return null;
    lines.push(`${serializeBare(item)}${serializeParams(item.params || [])}: ${value}`);
  }
  lines.push(`"@signature-params": ${serializeInner(inner)}`);
  return lines.join("\n");
}

// --- key directories --------------------------------------------------------------
/** RFC 8037 A.3 thumbprint of an Ed25519 public JWK. */
export function ed25519Thumbprint(x) {
  return createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");
}
/** The directory URL a Signature-Agent value names, and the identity it is
 *  recorded under (no query, no fragment), or null when it is not https. */
export function directoryOf(agentUrl) {
  let u;
  try { u = new URL(agentUrl); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (/^\[|^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) return null; // names only, never an address literal
  const noPath = u.pathname === "/" || u.pathname === "";
  const fetchUrl = noPath ? `${u.origin}${WELL_KNOWN}` : u.href.split("#")[0];
  const identity = noPath ? u.origin : `${u.origin}${u.pathname}`;
  return { fetchUrl, identity };
}
export function keysFromDirectory(text, now = Date.now()) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || !Array.isArray(doc.keys)) return null;
  const keys = new Map();
  for (const jwk of doc.keys.slice(0, DIR_MAX_KEYS)) {
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)) continue;
    if (jwk.nbf != null && Number(jwk.nbf) * 1000 > now + SKEW_S * 1000) continue;
    if (jwk.exp != null && Number(jwk.exp) * 1000 <= now) continue;
    try { keys.set(ed25519Thumbprint(jwk.x), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" })); } catch { /* skip */ }
  }
  return keys;
}

/** The authority and scheme a TAP signature is checked against: BASE_URL's,
 *  never the request's Host. Null when BASE_URL is unset or unreadable. */
export function pinnedOrigin(baseUrl = process.env.BASE_URL) {
  let u;
  try { u = new URL(String(baseUrl || "")); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return { authority: u.host.toLowerCase(), scheme: u.protocol.slice(0, -1) };
}
/** The key a registry listing holds for `keyid`, or null: the listing is active
 *  and not simulated, the key is active, ed25519, unexpired, and its JWK
 *  thumbprint is the keyid. */
export function tapKeyFromListing(text, keyid, now = Date.now()) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== "object" || doc.isActive !== true || doc.simulated === true || !Array.isArray(doc.keys)) return null;
  for (const k of doc.keys.slice(0, DIR_MAX_KEYS)) {
    if (!k || (k.jkt !== keyid && k.keyName !== keyid)) continue;
    if (k.status !== "active" || String(k.algorithm || "").toLowerCase() !== "ed25519") continue;
    const exp = Date.parse(k.expirationDate);
    if (k.expirationDate != null && !(exp > now)) continue;
    try {
      const pem = Buffer.from(String(k.publicKey || ""), "base64").toString("utf8");
      if (pem.length > 1024 || !pem.includes("PUBLIC KEY")) continue;
      const key = createPublicKey(pem);
      const jwk = key.export({ format: "jwk" });
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || ed25519Thumbprint(jwk.x) !== keyid) continue;
      const directoryOrigin = typeof k.directory?.directoryOrigin === "string" ? k.directory.directoryOrigin : null;
      return { key, agentId: typeof doc.id === "string" ? doc.id.slice(0, 128) : null, directory: directoryOrigin === TAP_SIGNATURE_AGENTS[0] ? "production" : directoryOrigin === TAP_SIGNATURE_AGENTS[1] ? "sandbox" : "unknown" };
    } catch { /* not a usable key */ }
  }
  return null;
}
/** True when a Content-Digest header holds a sha-256 member equal to `digest` (the body's SHA-256 bytes). */
export function contentDigestMatches(header, digest) {
  const d = parseDictionary(typeof header === "string" ? header : "");
  const m = d?.get("sha-256");
  return !!(m && m.t === "bytes" && Buffer.isBuffer(digest) && m.v.length === 32 && m.v.equals(digest));
}
const EMPTY_SHA256 = createHash("sha256").digest();
function hasBody(req) {
  const len = Number(req.headers?.["content-length"]);
  return (Number.isFinite(len) && len > 0) || req.headers?.["transfer-encoding"] != null;
}

// The registry read a server uses; a boot test's preload replaces it
// (scripts/lib/tap-registry-preload.js), since the outbound guard refuses a
// loopback stub and a test never reads the real registry.
let registryFetch = (url) => defaultFetchRegistryKey(url);
/** @internal test hook (a preload only). */
export function _setTapRegistryFetchForTest(fn) { registryFetch = typeof fn === "function" ? fn : (url) => defaultFetchRegistryKey(url); }

export function createWebBotAuth({ fetchDirectory = defaultFetchDirectory, now = () => Date.now(), note = noteWebBotAuth, fetchRegistryKey = (url) => registryFetch(url), registryOrigin = TAP_REGISTRY_ORIGIN, nonceStore = shared, origin = () => pinnedOrigin() } = {}) {
  const dirs = new Map(); // fetchUrl -> { keys: Map|null, exp }
  const pending = new Set();
  const nonces = new Map(); // `${identity}|${nonce}` -> expiry ms
  let fetchWindow = { start: 0, n: 0 };
  const tapKeys = new Map(); // keyid -> { entry: {key, agentId, directory}|null, exp, at }
  const tapPending = new Set();
  let tapWindow = { start: 0, n: 0 };

  function scheduleTap(keyid) {
    if (tapPending.has(keyid) || tapPending.size >= TAP_FETCH_INFLIGHT) return;
    const t = now();
    if (t - tapWindow.start >= 60_000) tapWindow = { start: t, n: 0 };
    if (tapWindow.n >= TAP_FETCH_PER_MIN) return;
    tapWindow.n++;
    tapPending.add(keyid);
    const url = `${registryOrigin}/v1/tap/registry/keys/${keyid}`;
    Promise.resolve().then(() => fetchRegistryKey(url)).then((out) => {
      const text = typeof out === "string" ? out : out?.text;
      const entry = typeof text === "string" ? tapKeyFromListing(text, keyid, now()) : null;
      const maxAge = out?.maxAgeS == null ? NaN : Number(out.maxAgeS);
      const ttl = entry ? Math.min(TAP_KEY_TTL_MS, Number.isFinite(maxAge) && maxAge >= 0 ? maxAge * 1000 : TAP_KEY_TTL_MS) : TAP_MISS_TTL_MS;
      storeTap(keyid, entry, ttl);
    }, () => storeTap(keyid, null, TAP_MISS_TTL_MS)).finally(() => tapPending.delete(keyid));
  }
  function storeTap(keyid, entry, ttl) {
    if (tapKeys.size >= TAP_KEYS_MAX && !tapKeys.has(keyid)) tapKeys.delete(tapKeys.keys().next().value);
    tapKeys.delete(keyid);
    tapKeys.set(keyid, { entry, exp: now() + ttl, at: now() });
  }

  /** The synchronous half of a TAP check: everything but the body's digest and
   *  the nonce claim. { fail } or { ctx }. */
  function tapPrecheck(req, parsed, label, inner, tag) {
    const fail = (reason) => ({ fail: `tap-${reason}` });
    const prof = TAP_PROFILE[tag];
    const sigItem = parsed.sigs.get(label);
    if (!sigItem || sigItem.t !== "bytes") return fail("no-signature");
    const p = (k) => paramOf(inner.params, k);
    const created = p("created")?.v, expires = p("expires")?.v, keyid = p("keyid")?.v, alg = p("alg")?.v, nonce = p("nonce")?.v;
    if (!Number.isInteger(created) || !Number.isInteger(expires) || typeof keyid !== "string") return fail("missing-params");
    if (alg !== undefined && (typeof alg !== "string" || alg.toLowerCase() !== "ed25519")) return fail("unsupported-alg");
    if (!TAP_KEYID_RE.test(keyid)) return fail("unsupported-keyid");
    if (prof.nonceRequired && !(typeof nonce === "string" && nonce)) return fail("no-nonce");
    if (nonce !== undefined && (typeof nonce !== "string" || nonce.length > 200)) return fail("bad-nonce");
    const t = Math.floor(now() / 1000);
    if (created > t + prof.maxAheadS) return fail("created-in-future");
    if (expires <= t) return fail("expired");
    if (expires - created > prof.maxWindowS || expires <= created) return fail("window-too-long");
    const names = inner.v.map((it) => it.v);
    for (const n of prof.required) if (!names.includes(n)) return fail("component-not-covered");
    const body = hasBody(req);
    if (body && !names.includes("content-digest")) return fail("component-not-covered");
    if (tag === "agent-payer-auth") { for (const h of TAP_PAYMENT_HEADERS) if (req.headers?.[h] != null && !names.includes(h)) return fail("payment-header-not-covered"); }
    else if (names.includes("authorization") || names.includes("cookie")) return fail("credential-covered");
    if (names.includes("content-digest") && typeof req.headers?.["content-digest"] !== "string") return fail("no-content-digest");
    // A Signature-Agent is compared with the directory origins, never fetched.
    if (parsed.agentRaw != null) {
      const m = parsed.agents ? parsed.agents.get(label) : null;
      const v = m ? (m.t === "string" ? m.v : null) : parsed.legacyAgent;
      if (!v || !TAP_SIGNATURE_AGENTS.includes(v)) return fail("signature-agent-not-allowed");
    }
    const o = origin();
    if (!o) return fail("no-base-url");
    const cached = tapKeys.get(keyid);
    if (!cached || cached.exp <= now()) {
      scheduleTap(keyid);
      if (!cached || cached.exp <= now()) return fail("registry-pending");
    }
    if (!cached.entry) return fail("unknown-key");
    const base = signatureBase(req, inner, parsed, label, o);
    if (base == null) return fail("unsupported-component");
    let good = false;
    try { good = sigItem.v.length === 64 && cryptoVerify(null, Buffer.from(base, "utf8"), cached.entry.key, sigItem.v); } catch { good = false; }
    if (!good) {
      // A key the registry has since replaced is read again (the fetch budget bounds this).
      if (now() - cached.at >= 5_000) tapKeys.delete(keyid);
      return fail("bad-signature");
    }
    return { ctx: { tag, keyid, nonce: typeof nonce === "string" ? nonce : null, expires, entry: cached.entry, digestHeader: names.includes("content-digest") ? req.headers["content-digest"] : null } };
  }
  /** The asynchronous half: the body's digest, then the nonce claim. */
  async function tapFinish(ctx, digest, bodyFailure = null) {
    if (bodyFailure) return { verified: false, reason: `tap-${bodyFailure}`, scheme: "visa-tap" };
    if (ctx.digestHeader != null && !contentDigestMatches(ctx.digestHeader, digest)) return { verified: false, reason: "tap-digest-mismatch", scheme: "visa-tap" };
    if (ctx.nonce) {
      const ttl = Math.max(1_000, ctx.expires * 1000 - now() + SKEW_S * 1000);
      let r = null;
      try { r = await nonceStore.counterAdd("tap-nonce", createHash("sha256").update(`${ctx.keyid}|${ctx.nonce}`).digest("base64url"), 1, ttl); } catch { r = null; }
      if (!r?.ok) return { verified: false, reason: "tap-nonce-store-unavailable", scheme: "visa-tap" };
      if (r.value !== 1) return { verified: false, reason: "tap-replayed", scheme: "visa-tap" };
    }
    return { verified: true, scheme: "visa-tap", agent: "visa-cli", tag: ctx.tag, keyid: ctx.keyid, agentId: ctx.entry.agentId, directory: ctx.entry.directory };
  }
  /** A whole TAP check with the body given (tests, and any caller that holds the body). Never throws. */
  async function checkTap(req, body = Buffer.alloc(0)) {
    try {
      const parsed = readSignatureHeaders(req.headers || {});
      const found = parsed && findTagged(parsed);
      if (!found || !found.tap) return { verified: false, reason: "tap-no-tag", scheme: "visa-tap" };
      const pre = tapPrecheck(req, parsed, found.label, found.inner, found.tag);
      if (pre.fail) return { verified: false, reason: pre.fail, scheme: "visa-tap" };
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
      if (buf.length > TAP_BODY_MAX) return tapFinish(pre.ctx, null, "body-too-large");
      return tapFinish(pre.ctx, createHash("sha256").update(buf).digest());
    } catch { return { verified: false, reason: "tap-error", scheme: "visa-tap" }; }
  }
  function findTagged(parsed) {
    let n = 0;
    for (const [l, m] of parsed.inputs) {
      if (++n > MAX_SIGS) break;
      if (m.t !== "inner") continue;
      const tag = paramOf(m.params, "tag")?.v;
      if (tag === "web-bot-auth") return { label: l, inner: m, tag, tap: false };
      if (TAP_TAGS.includes(tag)) return { label: l, inner: m, tag, tap: true };
    }
    return null;
  }
  /** Hash the request body as whatever reads it reads it (a passive tap on
   *  the stream's own events: nothing here reads, pauses or resumes it), then
   *  call done(digest) or done(null, reason). */
  function digestBodyAsRead(req, res, done) {
    let finished = false, size = 0;
    const h = createHash("sha256");
    const end = (digest, reason) => { if (finished) return; finished = true; done(digest, reason); };
    const emit = req.emit;
    req.emit = function tapBodyEmit(ev, ...args) {
      if (!finished) {
        try {
          if (ev === "data") {
            const c = args[0];
            const b = Buffer.isBuffer(c) ? c : Buffer.from(typeof c === "string" ? c : c ?? "");
            size += b.length;
            if (size > TAP_BODY_MAX) end(null, "body-too-large"); else h.update(b);
          } else if (ev === "end") end(h.digest());
          else if (ev === "error" || ev === "aborted") end(null, "body-unread");
        } catch { end(null, "body-unread"); }
      }
      return emit.apply(this, [ev, ...args]);
    };
    const unread = () => end(null, "body-unread");
    res?.once?.("finish", unread);
    res?.once?.("close", unread);
  }

  function schedule(fetchUrl) {
    if (pending.has(fetchUrl) || pending.size >= FETCH_INFLIGHT) return;
    const t = now();
    if (t - fetchWindow.start >= 60_000) fetchWindow = { start: t, n: 0 };
    if (fetchWindow.n >= FETCH_PER_MIN) return;
    fetchWindow.n++;
    pending.add(fetchUrl);
    Promise.resolve().then(() => fetchDirectory(fetchUrl)).then((text) => {
      const keys = typeof text === "string" ? keysFromDirectory(text, now()) : null;
      store(fetchUrl, keys && keys.size ? keys : null);
    }, () => store(fetchUrl, null)).finally(() => pending.delete(fetchUrl));
  }
  function store(fetchUrl, keys) {
    if (dirs.size >= DIR_MAX && !dirs.has(fetchUrl)) dirs.delete(dirs.keys().next().value);
    dirs.delete(fetchUrl);
    dirs.set(fetchUrl, { keys, exp: now() + (keys ? DIR_TTL_MS : DIR_FAIL_TTL_MS) });
  }

  /** Verify one request. Never throws; never refuses. */
  function check(req) {
    const parsed = readSignatureHeaders(req.headers || {});
    if (!parsed) return { verified: false, reason: "malformed" };
    const found = findTagged(parsed);
    if (!found || found.tap) return { verified: false, reason: "no-web-bot-auth-tag" };
    const { label, inner } = found;
    const sigItem = parsed.sigs.get(label);
    if (!sigItem || sigItem.t !== "bytes") return { verified: false, reason: "no-signature" };
    const p = (k) => paramOf(inner.params, k);
    const created = p("created")?.v, expires = p("expires")?.v, keyid = p("keyid")?.v, alg = p("alg")?.v, nonce = p("nonce")?.v;
    if (!Number.isInteger(created) || !Number.isInteger(expires) || typeof keyid !== "string") return { verified: false, reason: "missing-params" };
    if (alg !== undefined && alg !== "ed25519") return { verified: false, reason: "unsupported-alg" };
    const t = Math.floor(now() / 1000);
    if (created > t + SKEW_S) return { verified: false, reason: "created-in-future" };
    if (expires <= t) return { verified: false, reason: "expired" };
    if (expires - created > MAX_WINDOW_S) return { verified: false, reason: "window-too-long" };
    const names = inner.v.map((it) => it.v);
    if (!names.includes("@authority") && !names.includes("@target-uri")) return { verified: false, reason: "authority-not-covered" };
    // The agent's URL: the member for this label (or the legacy bare string).
    let agentUrl = null;
    if (parsed.agents) {
      const m = parsed.agents.get(label);
      if (m && m.t === "string" && !(m.params && m.params.length)) agentUrl = m.v;
    } else if (parsed.legacyAgent) agentUrl = parsed.legacyAgent;
    if (!agentUrl) return { verified: false, reason: "no-signature-agent" };
    const coversAgent = inner.v.some((it) => it.v === "signature-agent" && (parsed.agents ? paramOf(it.params, "key")?.v === label : !(it.params || []).length));
    if (!coversAgent) return { verified: false, reason: "signature-agent-not-covered" };
    const dir = directoryOf(agentUrl);
    if (!dir) return { verified: false, reason: "agent-not-https" };
    const cached = dirs.get(dir.fetchUrl);
    if (!cached || cached.exp <= now()) {
      schedule(dir.fetchUrl);
      if (!cached) return { verified: false, reason: "directory-pending" };
    }
    if (!cached.keys) return { verified: false, reason: "directory-unavailable" };
    const key = cached.keys.get(keyid);
    if (!key) return { verified: false, reason: "unknown-key" };
    const base = signatureBase(req, inner, parsed, label);
    if (base == null) return { verified: false, reason: "unsupported-component" };
    let good = false;
    try { good = sigItem.v.length === 64 && cryptoVerify(null, Buffer.from(base, "utf8"), key, sigItem.v); } catch { good = false; }
    if (!good) return { verified: false, reason: "bad-signature" };
    if (typeof nonce === "string" && nonce) {
      const nk = `${dir.identity}|${nonce.slice(0, 200)}`;
      const seen = nonces.get(nk);
      if (seen != null && seen > now()) return { verified: false, reason: "replayed" };
      if (nonces.size >= NONCE_MAX) { const tt = now(); for (const [k, e] of nonces) if (e <= tt) nonces.delete(k); }
      if (nonces.size < NONCE_MAX) nonces.set(nk, expires * 1000);
    }
    return { verified: true, agent: dir.identity, keyid };
  }

  // A TAP outcome lands when the body has been read, after next(): the label
  // reads `tap-pending` until then, and nothing waits on it.
  function recordTap(req, r) {
    req.webBotAuth = r;
    if (r.verified) req.visaCliAgent = { tag: r.tag, keyid: r.keyid, agentId: r.agentId, directory: r.directory };
    note({ agent: r.agent, verified: r.verified, reason: r.verified ? "ok" : r.reason });
  }
  function middleware() {
    return function webBotAuthMiddleware(req, res, next) {
      try {
        if (req.headers?.["signature-input"] && req.headers?.signature) {
          const parsed = readSignatureHeaders(req.headers || {});
          const found = parsed && findTagged(parsed);
          if (found?.tap) {
            const pre = tapPrecheck(req, parsed, found.label, found.inner, found.tag);
            if (pre.fail) recordTap(req, { verified: false, reason: pre.fail, scheme: "visa-tap" });
            else {
              req.webBotAuth = { verified: false, reason: "tap-pending", scheme: "visa-tap" };
              const land = (digest, reason) => { tapFinish(pre.ctx, digest, reason).then((r) => recordTap(req, r), () => recordTap(req, { verified: false, reason: "tap-error", scheme: "visa-tap" })); };
              if (hasBody(req)) digestBodyAsRead(req, res, land);
              else land(EMPTY_SHA256);
            }
          } else {
            const r = check(req);
            req.webBotAuth = r;
            note({ agent: r.agent, verified: r.verified, reason: r.verified ? "ok" : r.reason });
          }
        }
      } catch { /* recording never touches the request */ }
      next();
    };
  }
  return { check, checkTap, middleware, _dirs: dirs, _pending: pending, _tapKeys: tapKeys, _tapPending: tapPending };
}

async function defaultFetchDirectory(url) {
  const out = await safeFetch(url, {
    binary: true, maxBytes: DIR_MAX_BYTES, timeoutMs: 3_000,
    headers: { Accept: `${DIRECTORY_MEDIA_TYPE}, application/json;q=0.5` },
    beforeRedirect: () => { throw new Error("redirect not followed"); },
  });
  const type = String(out.contentType || "").split(";")[0].trim().toLowerCase();
  if (type !== DIRECTORY_MEDIA_TYPE && type !== "application/json") throw new Error("not a key directory");
  return out.buffer.toString("utf8");
}

/** The registry read: { text, maxAgeS } on a 200, else a throw. */
async function defaultFetchRegistryKey(url) {
  const out = await safeFetch(url, {
    binary: true, maxBytes: TAP_REGISTRY_MAX_BYTES, timeoutMs: 5_000,
    headers: { Accept: "application/json" },
    beforeRedirect: () => { throw new Error("redirect not followed"); },
  });
  const type = String(out.contentType || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new Error("not a registry listing");
  return { text: out.buffer.toString("utf8"), maxAgeS: null };
}
