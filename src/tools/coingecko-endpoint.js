// The one place that names the CoinGecko API host and the header the key
// rides in. A Demo key is accepted only on api.coingecko.com in
// x-cg-demo-api-key; a paid key is accepted only on pro-api.coingecko.com in
// x-cg-pro-api-key (the public host answers 400 to a paid key). The tier is a
// deployment setting, read at call time:
//
//   COINGECKO_API_TIER = demo (default) | pro
//
// "pro" takes effect only while COINGECKO_API_KEY is set: a keyless call
// always goes to the public host with no key header, exactly as before. The
// key travels in a request header only, never in a URL, a log line, an error
// or an answer. Every CoinGecko-calling module builds its URL from cgBase()
// and its key header from cgKeyHeaders() (scripts/test-coingecko-endpoint.js
// fails a src/ file that names a CoinGecko API host anywhere else).

export const CG_DEMO_BASE = "https://api.coingecko.com/api/v3";
export const CG_PRO_BASE = "https://pro-api.coingecko.com/api/v3";

function cgKey() {
  return String(process.env.COINGECKO_API_KEY || "").trim();
}

/** "pro" when COINGECKO_API_TIER is pro and a key is set; otherwise "demo". */
export function cgTier() {
  const t = String(process.env.COINGECKO_API_TIER || "").trim().toLowerCase();
  return t === "pro" && cgKey() ? "pro" : "demo";
}

/** The API base URL (no trailing slash) for the configured tier. */
export function cgBase() {
  return cgTier() === "pro" ? CG_PRO_BASE : CG_DEMO_BASE;
}

/** The key header for the configured tier, or {} when no key is set. */
export function cgKeyHeaders() {
  const key = cgKey();
  if (!key) return {};
  return cgTier() === "pro" ? { "x-cg-pro-api-key": key } : { "x-cg-demo-api-key": key };
}
