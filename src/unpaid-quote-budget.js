// A per-client hourly budget for unpaid requests to priced catalog routes.
//
// An unpaid request to a priced route is a price check: it earns a 402 with the
// route's challenges. Those are free to read, and every indexer and first-time
// buyer starts with one. What this bounds is the BURST: one client walking every
// priced route many times an hour learns nothing the published documents
// (/.well-known/x402, /openapi.json, /api/pricing) did not already say, and each
// 402 costs us a challenge build. The default sits far above any steady
// indexer's rate on purpose. A 429 to an indexer reads as "down" in its listing,
// which is worse than the load, so the job is to stop bursts and never to
// penalize a steady monitor.
//
// Counted: GET/HEAD/POST to a priced catalog route that carries no plausible
// payment, credits or proof-of-work credential and is not one of our own signed
// probes. Keyed by client ip AND the User-Agent product token, so two programs
// behind one address are two clients. Fixed UTC-hour windows: the 429 says
// exactly when the count resets.
// Never counted: named indexers and search/AI crawlers, our own User-Agents,
// /mcp and the MCP connector's own loopback, the discovery surfaces, any route
// that is not priced, a client that has already settled a payment this hour,
// and every request under FREE_MODE (the server does not mount this there).
// Memory is bounded: at most `keyCap` keys, least recently seen dropped first.
// Counted in THIS process: like every limiter in src/rate-limit.js the budget
// is divided by RATE_LIMIT_REPLICAS (perReplica), so two containers enforce
// the published figure between them rather than twice it. A client pinned to
// one container gets its share, never more than the whole; the published
// figure (the 429 hint, /crawler) stays the system-wide one.
//
// Two shapes of bypass this had to close, both found by probing a paid boot:
// a path spelled differently still reached the paywall and built its challenge
// while an exact catalog lookup read it as unpriced, so the path is normalized
// the way the router and the paywall resolve it before the lookup; and any
// non-blank Authorization counted as a credential, so junk bought an exemption
// (the same class the metered quote limiter closed in its own review). A
// credential must now LOOK like one - the gates still decide whether it really
// is.
import { DISCOVERY_PATHS, OWN_UA, indexerFor, uaToken } from "./traffic-classifier.js";
import { perReplica } from "./rate-limit.js";
import { cacheGet, cacheSet, cacheEnabled } from "./cache.js";
import { createHash } from "node:crypto";

export const DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR = 3000;
export const UNPAID_QUOTE_BUDGET_KEY_CAP = 20_000;
const HOUR_MS = 3_600_000;
// How many distinct clients we name in the log and count as throttled inside
// one hour. Past this the throttling continues and the count stops rising, so
// stats() flags that it is capped rather than reporting a number that is not one.
export const UNPAID_QUOTE_BUDGET_LOG_CAP = 1000;

/** The configured budget. "0" or "off" disables (returns 0); a malformed or
 *  negative value reads as unset, never as off, because off is the one setting
 *  a typo must not select. */
export function unpaidQuoteBudgetPerHour(env = process.env) {
  const raw = String(env?.UNPAID_QUOTE_BUDGET_PER_HOUR ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR;
  if (raw === "0" || raw === "off") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR;
  return Math.floor(n);
}

/** The path a catalog lookup should use. Express routes case-insensitively and
 *  with an optional trailing slash, and the paywall resolves a percent-escaped
 *  or doubled-slash spelling too, so an exact lookup on `req.path` as written
 *  reads a differently spelled request as unpriced while the paywall still
 *  builds its challenge. Normalizing a little WIDER than the router is the safe
 *  direction here: at worst a spelling that ends in a 404 is counted, and that
 *  request cost a challenge build, which is what this bounds. */
export function normalizeCatalogPath(path) {
  let p = String(path || "");
  try { p = decodeURIComponent(p); } catch { /* a malformed escape stays as written */ }
  p = p.toLowerCase().replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  return p || "/";
}

const headerText = (v) => (Array.isArray(v) ? v[0] : v);

/** A PLAUSIBLE payment or credits credential. Deliberately the same shapes the
 *  metered quote limiter accepts (server.js): a credits key, an MPP `Payment`
 *  credential, or a payment header long enough to be one. Shape, not validity:
 *  the gates verify, and this only decides whether a request is a price check. */
export function looksLikePayment(headers = {}) {
  const a = String(headerText(headers?.authorization) ?? "");
  if (/^Bearer\s+a402_[A-Za-z0-9_-]{8,}/.test(a) || /^Payment\s+\S{16,}/i.test(a)) return true;
  for (const k of ["payment-signature", "x-payment"]) {
    const v = headerText(headers?.[k]);
    if (typeof v === "string" && v.length >= 32) return true;
  }
  return false;
}

/** A PLAUSIBLE proof-of-work solution: the `<token>:<nonce>` shape pow.js
 *  parses, where the token is the five dot-separated signed parts it issued. */
export function looksLikePowSolution(value) {
  const s = String(headerText(value) ?? "");
  const sep = s.lastIndexOf(":");
  if (sep < 1 || !s.slice(sep + 1)) return false;
  const parts = s.slice(0, sep).split(".");
  return parts.length === 5 && parts.every((p) => p.length > 0);
}

/** Whether this request is a payment or proof-of-work attempt rather than a
 *  price check. */
export function hasCredentialHeader(headers = {}) {
  return looksLikePayment(headers) || looksLikePowSolution(headers?.["x-pow-solution"]);
}

/** Named indexers, search and AI crawlers, and our own User-Agents are never budgeted. */
export function isExemptUserAgent(ua) {
  const s = String(ua || "");
  return OWN_UA.test(s) || !!indexerFor(s);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** The MCP connector replays a tool call to our own route over loopback and
 *  marks it. The header alone is caller-settable, so it counts only when the
 *  socket itself is local: a request arriving through the edge proxy never is. */
export function isMcpLoopback(req) {
  const via = String(req?.headers?.["x-agent402-via"] || "").trim().toLowerCase();
  if (via !== "mcp") return false;
  return LOOPBACK.has(String(req?.socket?.remoteAddress || ""));
}

export function isExemptPath(path) {
  const p = normalizeCatalogPath(path);
  return p === "/mcp" || p.startsWith("/mcp/") || DISCOVERY_PATHS.has(p);
}

/** A settlement receipt on this response: the x402 settle receipt, or the MPP
 *  and Tempo mirror of it. Only a receipt on a response the buyer was actually
 *  served counts, and an x402 receipt that reports failure is not one. */
export function hasSettlementReceipt(res) {
  try {
    if (!res || res.statusCode >= 400) return false;
    if (res.getHeader?.("Payment-Receipt")) return true;
    const h = res.getHeader?.("PAYMENT-RESPONSE") || res.getHeader?.("X-PAYMENT-RESPONSE");
    if (typeof h !== "string" || !h) return false;
    try { return JSON.parse(Buffer.from(h, "base64").toString("utf-8"))?.success !== false; } catch { return true; }
  } catch { return false; }
}

export const secondsToHourBoundary = (now = Date.now()) => Math.max(1, Math.ceil((HOUR_MS - (now % HOUR_MS)) / 1000));

/**
 * @param {object} o
 * @param {number} o.budget          requests per client per UTC hour; 0 disables
 * @param {(method:string, path:string) => boolean} o.isPriced  true for a priced catalog route
 * @param {(req:any) => boolean} [o.isSynthetic]  our own signed probes
 * @param {string} [o.policyUrl]     where the 429 points
 * @param {number} [o.keyCap]
 * @param {() => number} [o.now]
 * @param {(line:string) => void} [o.log]
 */
// Which clients have paid this hour, shared by every container through the
// Redis cache (src/cache.js). Keys are a digest of the address and User-Agent
// plus the hour, never the address itself, and expire with the hour. Without
// Redis there is no shared record and each container keeps its own, as before.
export function redisSharedSettled(now = Date.now) {
  if (!cacheEnabled()) return null;
  const slot = (key) => `a402:uqb:${createHash("sha256").update(String(key)).digest("hex").slice(0, 32)}:${Math.floor(now() / HOUR_MS)}`;
  return {
    mark: (key) => { void cacheSet(slot(key), 1, 3600); },
    has: async (key) => (await cacheGet(slot(key))) !== null,
  };
}

export function createUnpaidQuoteBudget({ budget, isPriced, isSynthetic = () => false, policyUrl = "/crawler", keyCap = UNPAID_QUOTE_BUDGET_KEY_CAP, now = Date.now, log = console.warn, replicas = null , sharedSettled = null} = {}) {
  // `published` is the configured, system-wide figure; `limit` is this
  // process's share of it (RATE_LIMIT_REPLICAS, or `replicas` when given).
  const published = Number(budget) || 0;
  const share = (n) => (replicas == null ? perReplica(n) : Math.max(1, Math.floor(n / Math.max(1, Number(replicas) || 1))));
  const limit = published > 0 ? share(published) : 0;
  let hour = -1;
  const counts = new Map();       // `${ip}|${uaToken}` -> requests this hour, least recently seen first
  const logged = new Set();       // keys already logged as throttled this hour
  const settled = new Set();      // keys that settled a payment this hour
  let throttled = 0;

  /** Windows are fixed UTC hours; everything keyed to one is dropped together. */
  function rollover(t) {
    const h = Math.floor(t / HOUR_MS);
    if (h !== hour) { hour = h; counts.clear(); logged.clear(); settled.clear(); }
    return h;
  }

  /** Count one request for `key`; returns { limited, count, retryAfterSeconds }. */
  function hit(key, t = now()) {
    rollover(t);
    const n = (counts.get(key) || 0) + 1;
    counts.delete(key);
    counts.set(key, n);
    while (counts.size > keyCap) counts.delete(counts.keys().next().value);
    return { limited: limit > 0 && n > limit, count: n, retryAfterSeconds: secondsToHourBoundary(t) };
  }

  /** A client that settles a payment stops being counted for the rest of the
   *  hour. Every stock x402 purchase opens with an unpaid bare request (a spend
   *  cap adds a second, as a preflight), so a buyer spends this budget on its
   *  own purchases; past it the 429 would land on that bare request and the
   *  buyer would never see the 402 it came for. One settlement is proof this
   *  client is not the burst the budget is about. */
  function noteSettled(key, t = now()) {
    if (!key) return;
    rollover(t);
    if (settled.size >= keyCap) return;
    settled.add(key);
    counts.delete(key);
    // Shared with the other containers (src/cache.js), so a client that paid
    // on one replica is exempt on the other too. Best-effort and never
    // awaited: without Redis the exemption is per container, as before.
    try { sharedSettled?.mark?.(key); } catch { /* never break a response */ }
  }

  /** The method and path half: is this a request to a priced catalog route at
   *  all? Split from the rest so a paying client's own requests can be watched
   *  for a receipt even though they are never counted. */
  function isCountablePath(req, path) {
    const method = req.method === "HEAD" ? "GET" : req.method;
    if (method !== "GET" && method !== "POST") return false;
    if (isExemptPath(path)) return false;
    // A POST on a GET-only route (and the reverse) runs the other verb's gate
    // chain, so a route priced under either verb is a price check here.
    return isPriced("GET", path) || isPriced("POST", path);
  }

  /** Whether this request is a countable unpaid price check. */
  function isCounted(req) {
    const path = normalizeCatalogPath(req.path);
    if (!isCountablePath(req, path)) return false;
    if (hasCredentialHeader(req.headers)) return false;
    if (isExemptUserAgent(req.headers?.["user-agent"])) return false;
    if (isMcpLoopback(req)) return false;
    try { if (isSynthetic(req)) return false; } catch { /* an unreadable token is not ours */ }
    return true;
  }

  // Printable ASCII only: the token is caller text and reaches the log line below.
  const keyOf = (req) => `${req.ip || req.socket?.remoteAddress || "-"}|${uaToken(req.headers?.["user-agent"]).replace(/[^\x20-\x7e]/g, "?")}`;

  function middleware(req, res, next) {
    if (limit <= 0) return next();
    let verdict;
    let ua = "-";
    let key = null;
    const refuse = () => {
      throttled += 1;
      if (!logged.has(key) && logged.size < UNPAID_QUOTE_BUDGET_LOG_CAP) {
        logged.add(key);
        try { log(`[unpaid-budget] ${ua} passed ${limit} unpaid price checks on this container this hour (budget ${published} per hour); answering 429 until the hour turns`); } catch { /* logging never breaks a response */ }
      }
      res.set("Retry-After", String(verdict.retryAfterSeconds)).set("Cache-Control", "no-store");
      return res.status(429).json({
        ok: false,
        error: "rate-limited",
        hint: `Too many unpaid price checks from one client this hour (budget ${published} per hour, per address and User-Agent). Every route and price is published at /.well-known/x402, /openapi.json and /api/pricing, and a request carrying a payment, a credits key or a proof-of-work solution is never counted. A client that settles a payment stops being counted for the rest of the hour. See ${policyUrl}`,
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    };
    try {
      const path = normalizeCatalogPath(req.path);
      if (!isCountablePath(req, path)) return next();
      key = keyOf(req);
      ua = key.slice(key.indexOf("|") + 1);
      // Armed on every request to a priced route, paid or not: the receipt goes
      // out on the PAID retry, which carries a credential and is never counted.
      if (!settled.has(key)) res.once?.("finish", () => { if (hasSettlementReceipt(res)) noteSettled(key); });
      if (settled.has(key)) return next();
      if (hasCredentialHeader(req.headers)) return next();
      if (isExemptUserAgent(req.headers?.["user-agent"])) return next();
      if (isMcpLoopback(req)) return next();
      try { if (isSynthetic(req)) return next(); } catch { /* an unreadable token is not ours */ }
      verdict = hit(key);
      if (!verdict.limited) return next();
    } catch { return next(); }
    // About to refuse: this client may have paid on another container. The
    // shared check runs only here, on the rare refusal path.
    if (!sharedSettled?.has) return refuse();
    return Promise.resolve().then(() => sharedSettled.has(key)).catch(() => false).then((paidElsewhere) => {
      if (paidElsewhere) { noteSettled(key); return next(); }
      return refuse();
    });
  }

  // Counts only: never a key, so never an address or a User-Agent. The window
  // is cleared lazily by the next counted request, so a read taken in a new
  // hour before one arrives reports this hour truthfully: zero.
  const stats = (t = now()) => {
    const stale = Math.floor(t / HOUR_MS) !== hour;
    return {
      budget: published,
      perReplicaBudget: limit,
      clientsThisHour: stale ? 0 : counts.size,
      clientsSettledThisHour: stale ? 0 : settled.size,
      clientsThrottledThisHour: stale ? 0 : logged.size,
      clientsThrottledCapAt: UNPAID_QUOTE_BUDGET_LOG_CAP,
      clientsThrottledCapped: !stale && logged.size >= UNPAID_QUOTE_BUDGET_LOG_CAP,
      throttledSinceBoot: throttled,
    };
  };
  return { middleware, hit, isCounted, noteSettled, stats };
}
