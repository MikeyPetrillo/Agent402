import { isIPv6 } from "node:net";
// Shared per-IP sliding-window rate limiter used by both the hosted MCP free
// tier (src/mcp-http.js) and the direct HTTP PoW redemption path
// (src/server.js). One implementation, one quota: a client that exhausts the
// MCP free tier cannot then keep hammering /api/* with PoW solutions to get
// effectively unlimited free calls. The default window/burst are tuned for
// $0.001-grade CPU tools; the same env knobs that lift the MCP cap for
// internal sweeps also lift the HTTP path.

const WINDOW_MS = 60 * 60 * 1000;
const BURST_WINDOW_MS = 60 * 1000;

export const MAX_CALLS_PER_WINDOW =
  Number(process.env.AGENT402_MCP_MAX_PER_HOUR) || 120;
export const MAX_CALLS_PER_BURST =
  Number(process.env.AGENT402_MCP_MAX_PER_MIN) || 20;

// One bucket table per logical surface so the MCP free tier and the direct
// HTTP free tier each get their own per-IP history. They use the SAME limits,
// but mixing them in one bucket would mean an MCP burst silently throttles a
// later x402-paid call on the same IP (because some routes are PoW-eligible
// even for buyers). Separate buckets, shared policy.
// Buckets live in THIS process's memory, so every replica keeps its own copy
// and the effective system-wide limit is (configured limit x replica count).
// Scaling from 1 to 2 replicas silently doubled every limit here - including
// the operator credential-guessing bound - and no test could catch it, because
// every test runs a single process.
//
// Dividing the budget by the replica count keeps the SYSTEM-WIDE total equal to
// the configured intent. It is an approximation, and deliberately the
// conservative one: a client pinned to a single replica gets its share rather
// than the whole budget, so the limiter is never MORE permissive than
// configured. For a security bound that is the right direction to be wrong in.
//
// The real fix is shared state (Redis is provisioned), but `check` is called
// synchronously from auth paths; making it async is a wider change than this
// warrants tonight. RATE_LIMIT_REPLICAS must be kept in step with the deployed
// replica count - if it drifts low, limits loosen.
const REPLICAS = Math.max(1, Number(process.env.RATE_LIMIT_REPLICAS) || 1);
/** Per-replica share of a system-wide budget. Never below 1. */
export const perReplica = (n) => Math.max(1, Math.floor(Number(n) / REPLICAS));

// A client that rotates addresses inside one IPv6 /64 (which a single host is
// routinely assigned) used to get a fresh bucket per address. IPv6 keys fold
// to their /64; IPv4 and non-IP keys are used as given. Every spelling of one
// address is one key: hextets are read as numbers (case and leading zeros do
// not count, "::" may stand anywhere), and an IPv4-mapped address
// (::ffff:a.b.c.d in any spelling) is its IPv4 address
// (scripts/test-limiter-identity.js).
function ipv6Hextets(addr) {
  let s = addr.toLowerCase();
  // A trailing dotted IPv4 part is two hextets.
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) s = `${v4[1]}${((Number(v4[2]) << 8) | Number(v4[3])).toString(16)}:${((Number(v4[4]) << 8) | Number(v4[5])).toString(16)}`;
  const [left, right] = s.includes("::") ? s.split("::") : [s, null];
  const l = left ? left.split(":") : [];
  const r = right === null ? [] : (right ? right.split(":") : []);
  const fill = right === null ? [] : Array(Math.max(0, 8 - l.length - r.length)).fill("0");
  return [...l, ...fill, ...r].map((h) => parseInt(h, 16));
}
export function limiterKey(key) {
  const k = String(key ?? "");
  // Only a bare IPv6 address folds; a composite key (ip|tool, ...) is used as given.
  const bare = k.split("%")[0];
  if (!isIPv6(bare)) return k;
  const h = ipv6Hextets(bare);
  if (h.length !== 8 || h.some((x) => !Number.isInteger(x))) return k;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  return `${h.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
/** A wider network than limiterKey: an IPv6 address by its /48, an IPv4
 *  address by its /24 (a composite or unparsed key is used as given). For an
 *  allowance one network gets once, so rotating addresses inside a provider's
 *  usual allocation does not multiply it. */
export function wideNetworkKey(key) {
  const k = limiterKey(key);
  const v6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/i.exec(k);
  if (v6) return `${v6[1]}:${v6[2]}:${v6[3]}::/48`.toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(k);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  return k;
}
// Most keys one limiter holds. Past it the oldest-inserted key is dropped, so
// address rotation costs memory at a fixed ceiling rather than without bound.
const MAX_KEYS = Number(process.env.RATE_LIMIT_MAX_KEYS) || 20_000;

export function createLimiter(name = "default", { perMin = MAX_CALLS_PER_BURST, perHour = MAX_CALLS_PER_WINDOW } = {}) {
  perMin = perReplica(perMin);
  perHour = perReplica(perHour);
  const buckets = new Map(); // ip -> number[] timestamps
  const prune = (hits, now) => { while (hits.length && hits[0] < now - WINDOW_MS) hits.shift(); };
  const over = (hits, now) =>
    hits.length >= perHour || hits.filter((t) => t > now - BURST_WINDOW_MS).length >= perMin;
  function check(rawKey) {
    const ip = limiterKey(rawKey);
    const now = Date.now();
    let hits = buckets.get(ip);
    if (!hits) {
      if (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value);
      buckets.set(ip, (hits = []));
    }
    prune(hits, now);
    if (over(hits, now)) return { limited: true, name, retryAfterSeconds: retryAfter(hits, now) };
    hits.push(now);
    return { limited: false, name };
  }
  // Whole seconds until this key has room again: the later of the moment the
  // hour window and the burst window each drop the hit that keeps them full.
  function retryAfter(hits, now) {
    let freeAt = now;
    if (hits.length >= perHour) freeAt = Math.max(freeAt, hits[hits.length - perHour] + WINDOW_MS);
    const burst = hits.filter((t) => t > now - BURST_WINDOW_MS);
    if (burst.length >= perMin) freeAt = Math.max(freeAt, burst[burst.length - perMin] + BURST_WINDOW_MS);
    return Math.max(1, Math.ceil((freeAt - now) / 1000));
  }
  // Is this key ALREADY over budget, WITHOUT spending any of it?
  //
  // check() is test-and-record in one step, which is right when every call is
  // the thing being metered. It is wrong when the budget must be consulted on a
  // request that should not itself count - notably an auth gate that meters only
  // FAILURES: calling check() there would charge the successful operator for
  // every page load and lock them out of their own dashboard.
  function peek(rawKey) {
    const ip = limiterKey(rawKey);
    const now = Date.now();
    const hits = buckets.get(ip);
    if (!hits) return { limited: false, name };
    prune(hits, now);
    const limited = over(hits, now);
    return { limited, name, ...(limited ? { retryAfterSeconds: retryAfter(hits, now) } : {}) };
  }
  // Forget a key's history. For flows where a stronger proof of identity
  // supersedes the failures counted so far (e.g. a successful login), so a
  // legitimate operator always has a way back in.
  const reset = (ip) => { buckets.delete(limiterKey(ip)); };
  /**
   * Give back the most recent charge for a key.
   *
   * For budgets that meter a GRANT rather than an attempt: if the granted thing
   * then failed, the caller never received what they paid for. The trial charged
   * at grant time, so a malformed request that returned 400 burned the caller's
   * one free call and their first CORRECT call hit the paywall - the opposite of
   * what the feature is for, and inconsistent with settlement ordering, where a
   * >=400 means a paying buyer is not charged either.
   */
  const refund = (ip) => {
    const hits = buckets.get(limiterKey(ip));
    if (Array.isArray(hits) && hits.length) hits.pop();
  };
  // Bound the table: drop empty/stale buckets occasionally.
  setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [ip, hits] of buckets) {
      while (hits.length && hits[0] < cutoff) hits.shift();
      if (!hits.length) buckets.delete(ip);
    }
  }, 10 * 60 * 1000).unref();
  return { check, peek, reset, refund, size: () => buckets.size };
}

export const LIMITS_LABEL = `${MAX_CALLS_PER_BURST}/min, ${MAX_CALLS_PER_WINDOW}/hour per client`;
