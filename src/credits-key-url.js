// A credits key is a bearer credential: it travels only in the Authorization
// header. A URL is kept in browser history, proxy logs and referrers, so a
// request whose path or query holds a key (raw or percent-encoded) is refused
// before any other middleware reads the URL, and the answer never repeats it.
// Leaf module: no imports from the server.
const KEY_IN_TEXT = /a402_[A-Za-z0-9_-]{32,64}/;

/** Whether a request URL carries a credits key anywhere (path or query). */
export function urlCarriesCreditsKey(url) {
  const raw = String(url || "");
  if (!/a402(_|%5f)/i.test(raw)) return false;
  if (KEY_IN_TEXT.test(raw)) return true;
  let decoded = raw;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(decoded); i++) {
    try { decoded = decodeURIComponent(decoded); } catch { decoded = decoded.replace(/%5f/gi, "_"); break; }
  }
  return KEY_IN_TEXT.test(decoded);
}

export const KEY_IN_URL_ANSWER = {
  error: "A credits key is accepted only in the Authorization header (Authorization: Bearer <key>), never in a URL. A key that was sent in a URL may be recorded along the way: revoke it with POST /api/credits/revoke and issue a new one from your balance page.",
  reason: "key_in_url",
};

export function refuseCreditsKeyInUrl() {
  return (req, res, next) => {
    if (!urlCarriesCreditsKey(req.originalUrl || req.url)) return next();
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    res.status(400).json(KEY_IN_URL_ANSWER);
  };
}
