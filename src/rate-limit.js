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
export function createLimiter(name = "default") {
  const buckets = new Map(); // ip -> number[] timestamps
  function check(ip) {
    const now = Date.now();
    let hits = buckets.get(ip);
    if (!hits) buckets.set(ip, (hits = []));
    while (hits.length && hits[0] < now - WINDOW_MS) hits.shift();
    const inBurst = hits.filter((t) => t > now - BURST_WINDOW_MS).length;
    if (
      hits.length >= MAX_CALLS_PER_WINDOW ||
      inBurst >= MAX_CALLS_PER_BURST
    ) {
      return { limited: true, name };
    }
    hits.push(now);
    return { limited: false, name };
  }
  // Bound the table: drop empty/stale buckets occasionally.
  setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [ip, hits] of buckets) {
      while (hits.length && hits[0] < cutoff) hits.shift();
      if (!hits.length) buckets.delete(ip);
    }
  }, 10 * 60 * 1000).unref();
  return { check };
}

export const LIMITS_LABEL = `${MAX_CALLS_PER_BURST}/min, ${MAX_CALLS_PER_WINDOW}/hour per client`;
