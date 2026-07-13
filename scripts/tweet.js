// Post to X (Twitter) from the CLI — an ops utility for release and changelog
// announcements, in the spirit of scripts/marketplace-register.js. Deterministic,
// dependency-free: signs the request with OAuth 1.0a (HMAC-SHA1) using Node's
// built-in crypto and posts to POST /2/tweets.
//
// The four credentials come from an X developer App (developer.x.com — create a
// Project + App, set permissions to Read and write, generate keys and tokens).
// Set them in the environment — never commit them.
//
// Env:
//   X_API_KEY         App API Key       (aka Consumer Key).    Required.
//   X_API_SECRET      App API Key Secret (aka Consumer Secret). Required.
//   X_ACCESS_TOKEN    Access Token for the posting account.    Required.
//   X_ACCESS_SECRET   Access Token Secret.                     Required.
//   (TWITTER_* names are accepted as fallbacks for each of the above.)
//   DRY_RUN=1         Print the request that would be sent; do not post.
//
// Usage:
//   node scripts/tweet.js --text "gm. Agent402 now ships 1,410 tools."
//   node scripts/tweet.js --file path/to/tweet.txt
//   echo "posting from stdin" | node scripts/tweet.js
//   node scripts/tweet.js --text "part 2 of the thread" --reply-to 1234567890
//   node scripts/tweet.js --text "commentary" --quote 1234567890   # quote tweet
//   DRY_RUN=1 node scripts/tweet.js --text "dry run, nothing leaves the box"
//   node scripts/tweet.js --text "over 280 on purpose…" --force   # skip length guard
//   node scripts/tweet.js --verify   # read-only credential check (GET /2/users/me); posts nothing
//
// Exit codes: 0 posted (or dry-run/verify OK), 1 usage/credential/length error, 2 API error.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const API_URL = "https://api.twitter.com/2/tweets";

const cred = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  return "";
};
const CONSUMER_KEY = cred("X_API_KEY", "TWITTER_API_KEY");
const CONSUMER_SECRET = cred("X_API_SECRET", "TWITTER_API_SECRET");
const ACCESS_TOKEN = cred("X_ACCESS_TOKEN", "TWITTER_ACCESS_TOKEN");
const ACCESS_SECRET = cred("X_ACCESS_SECRET", "TWITTER_ACCESS_SECRET");
const DRY = process.env.DRY_RUN === "1";

// ---- args -----------------------------------------------------------------
function parseArgs(argv) {
  const out = { force: false, replyTo: null, quote: null, media: null, text: null, file: null, dryRun: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text" || a === "-t") out.text = argv[++i];
    else if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--reply-to" || a === "-r") out.replyTo = argv[++i];
    else if (a === "--quote" || a === "-q") out.quote = argv[++i];
    else if (a === "--media" || a === "-m") out.media = argv[++i];
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--verify") out.verify = true;
    else if (!a.startsWith("-") && out.text == null) out.text = a; // positional
  }
  return out;
}

function resolveText(args) {
  if (args.text != null) return args.text;
  if (args.file) return readFileSync(args.file, "utf8");
  // stdin (piped)
  if (!process.stdin.isTTY) {
    try { return readFileSync(0, "utf8"); } catch { /* no stdin */ }
  }
  return "";
}

// ---- OAuth 1.0a (HMAC-SHA1, three-legged, user context) -------------------
// RFC 3986 percent-encoding (encodeURIComponent leaves !*'() — encode them too).
const pct = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method, url, bodyParams = {}) {
  const oauth = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(32).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  // Signature base string. For a JSON body only the oauth_* params (and any
  // query params — none here) are signed; for form-encoded bodies (the v1.1
  // media upload) the body params must be included too.
  const all = { ...oauth, ...bodyParams };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${pct(k)}=${pct(all[k])}`)
    .join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const signingKey = `${pct(CONSUMER_SECRET)}&${pct(ACCESS_SECRET)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");

  const header =
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
      .join(", ");
  return header;
}

// Upload an image via the v1.1 media endpoint (form-encoded base64 — the same
// signed-form pattern as profile-image updates); returns a media_id string for
// attaching to the v2 tweet.
async function uploadMedia(path) {
  const MEDIA_URL = "https://upload.twitter.com/1.1/media/upload.json";
  const media_data = readFileSync(path).toString("base64");
  const res = await fetch(MEDIA_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader("POST", MEDIA_URL, { media_data }),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `media_data=${pct(media_data)}`,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.media_id_string) {
    console.error(`media upload ${res.status}:`, JSON.stringify(json).slice(0, 300));
    process.exit(2);
  }
  return json.media_id_string;
}

function requireCredentials() {
  let ok = true;
  for (const [name, v] of Object.entries({ X_API_KEY: CONSUMER_KEY, X_API_SECRET: CONSUMER_SECRET, X_ACCESS_TOKEN: ACCESS_TOKEN, X_ACCESS_SECRET: ACCESS_SECRET })) {
    if (!v) { console.error(`${name} is required (from an X developer App with Read-and-write permissions). Set it in the environment; do not commit it.`); ok = false; }
  }
  if (!ok) process.exit(1);
}

// Read-only credential check: GET /2/users/me under the same OAuth 1.0a user
// context used for posting. Confirms the four keys are valid and shows which
// account they belong to — nothing is written to the timeline.
async function verifyCredentials() {
  requireCredentials();
  const ME_URL = "https://api.twitter.com/2/users/me";
  let res, json;
  try {
    res = await fetch(ME_URL, { headers: { Authorization: authHeader("GET", ME_URL) } });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    console.error("Network error reaching X:", e.message);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`X API ${res.status}:`, JSON.stringify(json));
    // 401 → bad/expired credentials or clock skew; 403 → app/account access-level issue.
    process.exit(2);
  }
  const u = json?.data || {};
  console.log(`Credentials OK ✓ authenticated as @${u.username} (${u.name}, id ${u.id})`);
  console.log("Note: /2/users/me proves the keys sign correctly; posting additionally requires the App's Read-and-write permission.");
}

// ---- main -----------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.verify) return verifyCredentials();

  const text = resolveText(args).replace(/\s+$/, "");

  if (!text) {
    console.error("No tweet text. Pass --text \"...\", --file <path>, or pipe via stdin.");
    process.exit(1);
  }

  // Length guard. Standard limit is 280; premium accounts can exceed it — use
  // --force to bypass. Counting is by JS string length (a good-enough proxy;
  // X weights CJK/emoji differently, but this catches accidental overruns).
  if (text.length > 280 && !args.force) {
    console.error(`Tweet is ${text.length} chars (> 280). Trim it, or pass --force if your account allows long posts.`);
    process.exit(1);
  }

  const body = { text };
  if (args.replyTo) body.reply = { in_reply_to_tweet_id: String(args.replyTo) };
  if (args.quote) body.quote_tweet_id = String(args.quote);

  if (DRY || args.dryRun) {
    console.log("DRY RUN — would POST", API_URL);
    if (args.media) console.log(`with media: ${args.media}`);
    console.log(JSON.stringify(body, null, 2));
    console.log(`(${text.length} chars)`);
    return;
  }

  requireCredentials();

  if (args.media) body.media = { media_ids: [await uploadMedia(args.media)] };

  let res, json;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader("POST", API_URL),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    console.error("Network error posting to X:", e.message);
    process.exit(2);
  }

  if (!res.ok) {
    console.error(`X API ${res.status}:`, JSON.stringify(json));
    // 401 → bad/expired credentials or clock skew; 403 → app lacks write perm or duplicate content.
    process.exit(2);
  }

  const id = json?.data?.id;
  console.log("Posted ✓", id ? `https://x.com/i/web/status/${id}` : JSON.stringify(json));
}

main();
