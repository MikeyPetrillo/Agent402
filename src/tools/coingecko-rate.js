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

// A hard daily ceiling sits under the minute bucket, so a steady caller cannot
// use up the key's allowance early. Applies while a key is configured.
// Counted per UTC day, in memory. COINGECKO_DAILY_MAX tunes it.
const cgDailyMax = () => Math.max(1, parseInt(process.env.COINGECKO_DAILY_MAX || "300", 10) || 300);
const cgDay = { day: "", used: 0 };
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

/** Take one request's worth of budget. Returns null when taken, else the
 *  reason it was refused: "day" (daily ceiling spent) or "minute". */
export function cgTokenRefusal(now = Date.now()) {
  const d = utcDay(now);
  if (cgDay.day !== d) { cgDay.day = d; cgDay.used = 0; }
  const keyed = Boolean((process.env.COINGECKO_API_KEY || "").trim());
  if (keyed && cgDay.used >= cgDailyMax()) return "day";
  const cap = cgRatePerMin();
  if (cgTokens === null) { cgTokens = cap; cgRefilledAt = now; }
  const elapsed = now - cgRefilledAt;
  if (elapsed > 0) {
    cgTokens = Math.min(cap, cgTokens + (elapsed / 60_000) * cap);
    cgRefilledAt = now;
  }
  if (cgTokens < 1) return "minute";
  cgTokens -= 1;
  if (keyed) cgDay.used += 1;
  return null;
}

/** Take one request's worth of budget; false when the minute or the day is spent. */
export function takeCgToken(now = Date.now()) { return cgTokenRefusal(now) === null; }

/** Buyer-facing refusal text for a cgTokenRefusal reason (never a count). */
export function cgRefusalMessage(reason, label = "CoinGecko") {
  return reason === "day"
    ? `${label} is temporarily unavailable, retry later. You were not charged.`
    : `${label} is rate limited right now, retry in a few seconds. You were not charged.`;
}

/** Test seam: refill the bucket (offline suites make dozens of stubbed calls). */
export function resetCgRateLimit() { cgTokens = null; cgRefilledAt = 0; cgDay.day = ""; cgDay.used = 0; }

/** True for coingecko.com and its subdomains (api., pro-api.) and nothing
 *  else: this decides whether the API KEY rides the request, so a host that
 *  merely ENDS in the letters (evilcoingecko.com) must read false. */
export function isCoinGeckoHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "coingecko.com" || h.endsWith(".coingecko.com");
}
