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
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { safeFetch } from "./tools/fetch-guard.js";
import { noteWebBotAuth } from "./posthog-observability.js";

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
function componentValue(req, item, parsed, label) {
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
    case "@authority": return authorityOf(req);
    case "@scheme": return schemeOf(req);
    case "@target-uri": return `${schemeOf(req)}://${authorityOf(req)}${target}`;
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
export function signatureBase(req, inner, parsed, label) {
  const lines = [];
  for (const item of inner.v) {
    if (item.t !== "string") return null;
    const value = componentValue(req, item, parsed, label);
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

export function createWebBotAuth({ fetchDirectory = defaultFetchDirectory, now = () => Date.now(), note = noteWebBotAuth } = {}) {
  const dirs = new Map(); // fetchUrl -> { keys: Map|null, exp }
  const pending = new Set();
  const nonces = new Map(); // `${identity}|${nonce}` -> expiry ms
  let fetchWindow = { start: 0, n: 0 };

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
    let label = null, inner = null;
    let n = 0;
    for (const [l, m] of parsed.inputs) {
      if (++n > MAX_SIGS) break;
      if (m.t === "inner" && paramOf(m.params, "tag")?.v === "web-bot-auth") { label = l; inner = m; break; }
    }
    if (!inner) return { verified: false, reason: "no-web-bot-auth-tag" };
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

  function middleware() {
    return function webBotAuthMiddleware(req, _res, next) {
      try {
        if (req.headers?.["signature-input"] && req.headers?.signature) {
          const r = check(req);
          req.webBotAuth = r;
          note({ agent: r.agent, verified: r.verified, reason: r.verified ? "ok" : r.reason });
        }
      } catch { /* recording never touches the request */ }
      next();
    };
  }
  return { check, middleware, _dirs: dirs, _pending: pending };
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
