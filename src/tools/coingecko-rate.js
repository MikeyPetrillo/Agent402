// One token bucket for EVERY CoinGecko call this server makes.
//
// The Demo plan meters the key at 100 requests a minute, account-wide (docs
// "Demo plan: 100 calls/min", read 2026-09-18; it was 30/min when this shipped
// and the bucket sat at 25 for a month after the plan changed). Two kits
// read it: crypto-markets-kit (the 17 market/RWA tools) kept a private bucket
// at 25/min, and crypto-kit (crypto-price, crypto-market, crypto-history and
// friends) sent the same key with no bucket at all, so under load the two
// together overran the key and every caller of either kit saw 429s. The
// bucket lives here now and both kits draw from it; a caller that finds it
// empty is refused 503 BEFORE any upstream call (a >= 400 cancels settlement,
// nobody pays for the refusal). COINGECKO_MAX_PER_MIN tunes it (default 80,
// under the plan's per-minute limit so the retry-after-429 path keeps a little
// room; the monthly quota is the real ceiling, and CI no longer draws on it).
const cgRatePerMin = () => Math.max(1, parseInt(process.env.COINGECKO_MAX_PER_MIN || "80", 10) || 80);
let cgTokens = null, cgRefilledAt = 0;

/** Take one request's worth of budget; false when the minute is spent. */
export function takeCgToken(now = Date.now()) {
  const cap = cgRatePerMin();
  if (cgTokens === null) { cgTokens = cap; cgRefilledAt = now; }
  const elapsed = now - cgRefilledAt;
  if (elapsed > 0) {
    cgTokens = Math.min(cap, cgTokens + (elapsed / 60_000) * cap);
    cgRefilledAt = now;
  }
  if (cgTokens < 1) return false;
  cgTokens -= 1;
  return true;
}

/** Test seam: refill the bucket (offline suites make dozens of stubbed calls). */
export function resetCgRateLimit() { cgTokens = null; cgRefilledAt = 0; }

/** True for coingecko.com and its subdomains (api., pro-api.) and nothing
 *  else: this decides whether the API KEY rides the request, so a host that
 *  merely ENDS in the letters (evilcoingecko.com) must read false. */
export function isCoinGeckoHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "coingecko.com" || h.endsWith(".coingecko.com");
}
