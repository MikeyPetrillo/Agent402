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
// probes. Keyed by the client address alone (req.ip, which src/cdn-client-ip.js
// resolves, folded to its /64 for IPv6 by limiterKey as every limiter in
// src/rate-limit.js does): the User-Agent is caller text, so a key that read it
// was a fresh budget per User-Agent, and an exemption that read it was a pass
// for anyone who typed a crawler's name. It is kept only for the log line.
// The one exception is Cloudflare's shared Worker egress address
// (WORKER_EGRESS_ADDRESSES below), keyed per User-Agent under a whole-address
// ceiling.
// A self-declared named indexer or search/AI crawler (a User-Agent
// traffic-classifier.js names) is still counted, against
// NAMED_CLIENT_BUDGET_MULTIPLIER times the budget on the same address count:
// a real crawler keeps reading, a forged name buys a bounded allowance, never
// a pass. Our own probes are exempt only by their signed marker (isSynthetic),
// never by the User-Agent they send. Fixed UTC-hour windows: the 429 says
// exactly when the count resets.
// Never counted: our own signed probes, /mcp and the MCP connector's own
// loopback, the discovery surfaces, any route that is not priced, a client
// that has already settled a payment this hour, and every request under
// FREE_MODE (the server does not mount this there).
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
import { DISCOVERY_PATHS, indexerFor, uaToken } from "./traffic-classifier.js";
import { limiterKey, perReplica } from "./rate-limit.js";
import { cacheGet, cacheSet, cacheEnabled } from "./cache.js";
import { decodesAsMppCredential, decodesAsX402Payment } from "./payment-attempt.js";
import { createHash } from "node:crypto";
import { isMcpLoopback } from "./mcp-loopback.js";

export const DEFAULT_UNPAID_QUOTE_BUDGET_PER_HOUR = 3000;
export const UNPAID_QUOTE_BUDGET_KEY_CAP = 20_000;
// A self-declared named indexer or crawler reads against this many times the
// budget, on the same per-address count as everything else from that address.
export const NAMED_CLIENT_BUDGET_MULTIPLIER = 10;
// The 429 body's `reason`: the machine-readable mark that a refusal is this
// budget's, so an observer of ours (workers/status-probe, the heartbeat) reads
// it as "not observed this time" rather than as the paywall failing.
export const UNPAID_QUOTE_BUDGET_REASON = "unpaid-quote-budget";
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
 *  credential that decodes, or an x402 payment header that decodes to a
 *  payload naming an offered network (src/payment-attempt.js, the gateway
 *  cache's reader too). Shape, not validity: the gates verify, and this only
 *  decides whether a request is a price check. */
export function looksLikePayment(headers = {}) {
  const a = String(headerText(headers?.authorization) ?? "");
  if (/^Bearer\s+a402_[A-Za-z0-9_-]{8,}/.test(a) || decodesAsMppCredential(a)) return true;
  for (const k of ["payment-signature", "x-payment"]) {
    if (decodesAsX402Payment(headerText(headers?.[k]))) return true;
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

/** A User-Agent that names an indexer, search engine or AI crawler we list
 *  (traffic-classifier.js). Self-declared, so it buys a larger bucket on its
 *  address, never an exemption. Our own User-Agents are not named here: our
 *  probes are recognized by their signed marker only. */
export function isNamedClientUserAgent(ua) {
  return !!indexerFor(String(ua || ""));
}

// SHARED WORKER EGRESS. A Cloudflare Worker's request to another Cloudflare
// zone (this one, behind the CDN proxy) arrives with one fixed client
// address for every Worker of every account: "In cross-zone subrequests from
// one Cloudflare zone to another Cloudflare zone, the CF-Connecting-IP value
// will be set to the Worker client IP address '2a06:98c0:3600::103'"
// (https://developers.cloudflare.com/fundamentals/reference/http-headers/,
// "CF-Connecting-IP in Worker subrequests"). Keyed on the address alone, one
// busy Worker would spend the budget of every Worker-hosted buyer. From that
// address the key is the address plus the User-Agent token, and the address
// as a whole reads against WORKER_EGRESS_ADDRESS_MULTIPLIER times the budget,
// so rotating User-Agents buys a bounded allowance, never an unbounded one.
export const WORKER_EGRESS_ADDRESSES = Object.freeze(["2a06:98c0:3600::103"]);
export const WORKER_EGRESS_ADDRESS_MULTIPLIER = 10;
const canonicalV6 = (ip) => {
  const s = String(ip || "").trim();
  if (!s.includes(":") || s.includes("%")) return null;
  try { return new URL(`http://[${s}]/`).hostname.slice(1, -1); } catch { return null; }
};
const WORKER_EGRESS = new Set(WORKER_EGRESS_ADDRESSES.map(canonicalV6));
/** Whether this client address is Cloudflare's shared Worker egress address. */
export function isWorkerEgressAddress(ip) {
  const c = canonicalV6(ip);
  return c != null && WORKER_EGRESS.has(c);
}

/** The budget's key: the client address, an IPv6 address folded to its /64;
 *  from the shared Worker egress address, that plus the User-Agent token. */
export function clientKeyOf(req) {
  const ip = req?.ip || req?.socket?.remoteAddress || "-";
  const base = limiterKey(ip);
  if (!isWorkerEgressAddress(ip)) return base;
  return `${base}|ua:${uaToken(req?.headers?.["user-agent"]).toLowerCase()}`;
}
/** The whole-address key a Worker egress client also counts against, or null. */
export function workerEgressAddressKeyOf(req) {
  const ip = req?.ip || req?.socket?.remoteAddress || "-";
  return isWorkerEgressAddress(ip) ? `${limiterKey(ip)}|worker-egress` : null;
}

/** The MCP connector replays a tool call to our own route over loopback and
 *  marks it with a per-process secret; the marker counts only with that
 *  secret on a local socket (src/mcp-loopback.js). */
export { isMcpLoopback };

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
// Redis cache (src/cache.js). Keys are a digest of the client address (the
// budget's key) plus the hour, never the address itself, and expire with the hour. Without
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
  const namedLimit = published > 0 ? share(published * NAMED_CLIENT_BUDGET_MULTIPLIER) : 0;
  let hour = -1;
  const counts = new Map();       // client address (IPv6 /64) -> requests this hour, least recently seen first
  const logged = new Set();       // keys already logged as throttled this hour
  const settled = new Set();      // keys that settled a payment this hour
  let throttled = 0;

  /** Windows are fixed UTC hours; everything keyed to one is dropped together. */
  function rollover(t) {
    const h = Math.floor(t / HOUR_MS);
    if (h !== hour) { hour = h; counts.clear(); logged.clear(); settled.clear(); }
    return h;
  }

  /** Count one request for `key` against `cap` (this process's share of the
   *  budget, or of the named-client allowance); returns
   *  { limited, count, retryAfterSeconds }. */
  function hit(key, t = now(), cap = limit) {
    rollover(t);
    const n = (counts.get(key) || 0) + 1;
    counts.delete(key);
    counts.set(key, n);
    while (counts.size > keyCap) counts.delete(counts.keys().next().value);
    return { limited: cap > 0 && n > cap, count: n, retryAfterSeconds: secondsToHourBoundary(t) };
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
    if (isMcpLoopback(req)) return false;
    try { if (isSynthetic(req)) return false; } catch { /* an unreadable token is not ours */ }
    return true;
  }

  // Printable ASCII only: the token is caller text and reaches the log line below.
  const uaOf = (req) => uaToken(req.headers?.["user-agent"]).replace(/[^\x20-\x7e]/g, "?");

  function middleware(req, res, next) {
    if (limit <= 0) return next();
    let verdict;
    let ua = "-";
    let key = null;
    let named = false;
    const refuse = () => {
      throttled += 1;
      if (!logged.has(key) && logged.size < UNPAID_QUOTE_BUDGET_LOG_CAP) {
        logged.add(key);
        try { log(`[unpaid-budget] a client (last User-Agent ${ua}${named ? ", a self-declared named client" : ""}) passed ${named ? namedLimit : limit} unpaid price checks from one address on this container this hour (budget ${published} per hour); answering 429 until the hour turns`); } catch { /* logging never breaks a response */ }
      }
      res.set("Retry-After", String(verdict.retryAfterSeconds)).set("Cache-Control", "no-store");
      return res.status(429).json({
        ok: false,
        error: "rate-limited",
        reason: UNPAID_QUOTE_BUDGET_REASON,
        hint: `Too many unpaid price checks from one address this hour (budget ${published} per hour per client address, whatever the User-Agent; an IPv6 /64 is one address; a named indexer or search crawler reads against ${(published * NAMED_CLIENT_BUDGET_MULTIPLIER).toLocaleString("en-US")}). Every route and price is published at /.well-known/x402, /openapi.json and /api/pricing, and a request carrying a payment, a credits key or a proof-of-work solution is never counted. A client that settles a payment stops being counted for the rest of the hour. See ${policyUrl}`,
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    };
    try {
      const path = normalizeCatalogPath(req.path);
      if (!isCountablePath(req, path)) return next();
      key = clientKeyOf(req);
      ua = uaOf(req);
      // Armed on every request to a priced route, paid or not: the receipt goes
      // out on the PAID retry, which carries a credential and is never counted.
      if (!settled.has(key)) res.once?.("finish", () => { if (hasSettlementReceipt(res)) noteSettled(key); });
      if (settled.has(key)) return next();
      if (hasCredentialHeader(req.headers)) return next();
      if (isMcpLoopback(req)) return next();
      try { if (isSynthetic(req)) return next(); } catch { /* an unreadable token is not ours */ }
      named = isNamedClientUserAgent(req.headers?.["user-agent"]);
      verdict = hit(key, now(), named ? namedLimit : limit);
      // From the shared Worker egress address the whole address also counts,
      // against a multiple of the budget (see WORKER_EGRESS_ADDRESSES).
      const addressKey = workerEgressAddressKeyOf(req);
      if (addressKey && !verdict.limited) {
        const whole = hit(addressKey, now(), limit * WORKER_EGRESS_ADDRESS_MULTIPLIER);
        if (whole.limited) verdict = whole;
      }
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
      namedClientMultiplier: NAMED_CLIENT_BUDGET_MULTIPLIER,
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
