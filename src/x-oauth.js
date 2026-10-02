// OAuth 1.0a request signing for the X API (HMAC-SHA1, user context).
//
// One implementation shared by scripts/tweet.js (the CLI the Actions workflows
// run) and src/tweet-queue.js (the server's approved-queue poster), so the two
// posters can never sign differently. Dependency-free on purpose: the
// workflows run tweet.js on a bare runner with no `npm ci`, so this file may
// import nothing but node built-ins.
//
// The four credentials come from an X developer App with Read-and-write
// permission. They are read from the environment and never logged here.
import crypto from "node:crypto";

export const X_TWEETS_URL = "https://api.twitter.com/2/tweets";

/** RFC 3986 percent-encoding (encodeURIComponent leaves !*'() - encode them too). */
export const pct = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** The four credentials from an environment: X_* first, TWITTER_* as fallbacks. */
export function xCredentialsFromEnv(env = process.env) {
  const cred = (...names) => {
    for (const n of names) if (env[n]) return env[n];
    return "";
  };
  return {
    consumerKey: cred("X_API_KEY", "TWITTER_API_KEY"),
    consumerSecret: cred("X_API_SECRET", "TWITTER_API_SECRET"),
    accessToken: cred("X_ACCESS_TOKEN", "TWITTER_ACCESS_TOKEN"),
    accessSecret: cred("X_ACCESS_SECRET", "TWITTER_ACCESS_SECRET"),
  };
}

/** The env names of the credentials that are missing (empty when all four are set). */
export function missingXCredentials(creds = {}) {
  const need = { X_API_KEY: creds.consumerKey, X_API_SECRET: creds.consumerSecret, X_ACCESS_TOKEN: creds.accessToken, X_ACCESS_SECRET: creds.accessSecret };
  return Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
}

/**
 * The Authorization header for one request.
 *
 * For a JSON body only the oauth_* params (and any query params) are signed;
 * for a form-encoded body (the v1.1 media upload) the body params must be
 * passed in `params` too. `nonce` and `timestamp` exist for test vectors only.
 */
export function oauthHeader(method, url, creds, params = {}, { nonce, timestamp } = {}) {
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce ?? crypto.randomBytes(32).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const all = { ...oauth, ...params };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${pct(k)}=${pct(all[k])}`)
    .join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const signingKey = `${pct(creds.consumerSecret)}&${pct(creds.accessSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
      .join(", ")
  );
}
