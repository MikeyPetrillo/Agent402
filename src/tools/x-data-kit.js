// X data kit - read-only X (Twitter) API v2 lookups with an app-only bearer
// token: recent tweet search, a user profile, a user's timeline, a single
// tweet, and a bulk username lookup.
//
// Env-gated: X_BEARER_TOKEN. `X_DATA_TOOLS` is exported unconditionally;
// `xDataEnabled()` is the listing predicate the server uses (true iff the
// bearer is set). A handler called without the bearer throws a
// self-explaining 503. Every tool reaches the network and is WALLET-ONLY
// (the bearer is a metered upstream quota; never PoW-eligible).
//
// Upstream status mapping (never relays upstream error bodies):
//   401/403 -> 503 "not configured" (bearer rejected / app lacks access)
//   429     -> 503 with a retry hint from x-rate-limit-reset
//   404     -> 404 (unknown user / tweet)
//   other 4xx -> 400 (the request itself was invalid: bad query syntax)
//   5xx     -> 502, timeout -> 504
//
// Covered by scripts/test-x-data-kit.js (offline, stubbed fetch). Live
// calls need a real bearer and are not exercised in CI.

import { markUntrusted } from "./provenance.js";
// The upstream bills per POST RETURNED, not per request, so the page size is
// the real cost lever: a 100-post page at our per-call price would be sold far
// below cost. Priced 2026-08-27 against X's published pay-per-use rate card
// ($0.005 per post read, $0.010 per user read; resources deduplicated within a
// UTC day, so repeats cost us nothing): a 10-post page is $0.05 upstream, so
// the search and timeline tools sell at $0.08 (upstream <= 70% of price, the
// gateway's own margin rule) with the page capped at 10; a single post read
// is $0.008, a user read $0.015, a 10-username lookup $0.15.
const X_MAX_POSTS_PER_CALL = () => Math.max(5, Math.min(100, parseInt(process.env.X_MAX_POSTS_PER_CALL || "10", 10) || 10));
const X_MAX_USERS_PER_LOOKUP = 10;

const X_API = "https://api.x.com/2";
const TIMEOUT_MS = 12_000;
const USER_AGENT = "Agent402/1.0 (+https://agent402.tools)";

const TWEET_FIELDS = "created_at,public_metrics,author_id,lang,conversation_id,possibly_sensitive";
const USER_FIELDS = "created_at,description,public_metrics,verified,verified_type,location,url,protected,profile_image_url";

const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const ID_RE = /^\d{1,20}$/;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const bearer = () => (process.env.X_BEARER_TOKEN || "").trim();

export function xDataEnabled() {
  return bearer().length > 0;
}

function requireBearer() {
  const b = bearer();
  if (!b) throw bad("X data tools are not configured on this deployment (X_BEARER_TOKEN unset)", 503);
  return b;
}

// --- input helpers ---------------------------------------------------------
function takeUsername(raw, field = "username") {
  const u = typeof raw === "string" ? raw.trim().replace(/^@/, "") : "";
  if (!USERNAME_RE.test(u)) throw bad(`"${field}" must be an X username (1-15 letters, digits or underscores, optional leading @)`);
  return u;
}

function takeId(raw, field = "id") {
  const s = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!ID_RE.test(s)) throw bad(`"${field}" must be a numeric X id (digits only)`);
  return s;
}

function takeMaxResults(raw, { min, max, dflt }) {
  if (raw === undefined || raw === null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`"max_results" must be an integer between ${min} and ${max}`);
  return n;
}

function takeToken(raw, field) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw bad(`"${field}" must be the opaque pagination token returned by a previous call`);
  }
  return raw;
}

function takeBool(raw, field) {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === "false") return raw === "true";
  throw bad(`"${field}" must be a boolean`);
}

// --- upstream --------------------------------------------------------------
async function xGet(path, params = {}) {
  const token = requireBearer();
  const url = new URL(X_API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[x-data] api.x.com unreachable: ${err?.name ?? err?.code ?? err?.message}`);
    throw bad("X API did not respond in time - try again shortly", 504);
  }

  if (res.status === 401 || res.status === 403) {
    // The bearer was refused or the app's access level does not cover this
    // endpoint. Either way it is our configuration, not the buyer's request.
    throw bad("X data tools are not configured on this deployment (bearer rejected upstream)", 503);
  }
  if (res.status === 429) {
    const reset = Number(res.headers?.get?.("x-rate-limit-reset"));
    const inSec = Number.isFinite(reset) && reset > 0 ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : null;
    const hint = inSec ? ` - the window resets in about ${inSec}s` : " - retry shortly";
    throw bad(`X API rate cap reached upstream${hint}`, 503);
  }
  if (res.status === 404) throw bad("Not found on X", 404);
  if (res.status >= 500) throw bad(`X API upstream error (HTTP ${res.status})`, 502);
  if (!res.ok) throw bad(`X API rejected the request (HTTP ${res.status}) - check the query syntax and parameters`, 400);

  let data;
  try { data = await res.json(); } catch { throw bad("X API returned non-JSON", 502); }
  if (!data || typeof data !== "object") throw bad("X API returned an unexpected payload", 502);
  return data;
}

// --- shaping -----------------------------------------------------------------
function shapeMetrics(m) {
  if (!m || typeof m !== "object") return null;
  const num = (v) => (typeof v === "number" ? v : null);
  return {
    likes: num(m.like_count),
    retweets: num(m.retweet_count),
    replies: num(m.reply_count),
    quotes: num(m.quote_count),
    bookmarks: num(m.bookmark_count),
    impressions: num(m.impression_count),
  };
}

function shapeUser(u) {
  if (!u || typeof u !== "object") return null;
  const pm = u.public_metrics || {};
  const num = (v) => (typeof v === "number" ? v : null);
  return {
    id: u.id ?? null,
    username: u.username ?? null,
    name: u.name ?? null,
    description: u.description ?? null,
    createdAt: u.created_at ?? null,
    verified: Boolean(u.verified),
    verifiedType: u.verified_type ?? null,
    location: u.location ?? null,
    url: u.url ?? null,
    protected: Boolean(u.protected),
    profileImageUrl: u.profile_image_url ?? null,
    metrics: {
      followers: num(pm.followers_count),
      following: num(pm.following_count),
      tweets: num(pm.tweet_count),
      listed: num(pm.listed_count),
    },
    profileUrl: u.username ? `https://x.com/${u.username}` : null,
  };
}

function authorIndex(includes) {
  const map = new Map();
  for (const u of includes?.users || []) if (u?.id) map.set(u.id, u);
  return map;
}

function shapeTweet(t, authors) {
  if (!t || typeof t !== "object") return null;
  const a = authors?.get(t.author_id);
  return {
    id: t.id ?? null,
    text: t.text ?? null,
    createdAt: t.created_at ?? null,
    lang: t.lang ?? null,
    authorId: t.author_id ?? null,
    author: a ? { username: a.username ?? null, name: a.name ?? null, verified: Boolean(a.verified) } : null,
    conversationId: t.conversation_id ?? null,
    possiblySensitive: Boolean(t.possibly_sensitive),
    metrics: shapeMetrics(t.public_metrics),
    url: a?.username && t.id ? `https://x.com/${a.username}/status/${t.id}` : (t.id ? `https://x.com/i/status/${t.id}` : null),
  };
}

const nowIso = () => new Date().toISOString();

async function resolveUserId(username) {
  const data = await xGet(`/users/by/username/${encodeURIComponent(username)}`, { "user.fields": USER_FIELDS });
  if (!data.data?.id) throw bad("Not found on X", 404);
  return data.data;
}

// --- tools -------------------------------------------------------------------
const TWEET_EXAMPLE = {
  id: "1800000000000000000",
  text: "x402 lets an agent pay for an API call with one HTTP round trip.",
  createdAt: "2026-08-20T14:05:00.000Z",
  lang: "en",
  authorId: "1234567890",
  author: { username: "example_dev", name: "Example Dev", verified: false },
  conversationId: "1800000000000000000",
  possiblySensitive: false,
  metrics: { likes: 12, retweets: 3, replies: 1, quotes: 0, bookmarks: 2, impressions: 1400 },
  url: "https://x.com/example_dev/status/1800000000000000000",
};

const USER_EXAMPLE = {
  id: "574032254",
  username: "coinbase",
  name: "Coinbase",
  description: "The future of money is here.",
  createdAt: "2012-05-07T23:46:41.000Z",
  verified: true,
  verifiedType: "business",
  location: "Global",
  url: "https://coinbase.com",
  protected: false,
  profileImageUrl: "https://pbs.twimg.com/profile_images/.../normal.jpg",
  metrics: { followers: 6400000, following: 250, tweets: 19000, listed: 9000 },
  profileUrl: "https://x.com/coinbase",
};

const SHARED_TAGS = ["x", "twitter", "social", "x-api", "tweets"];

export const X_DATA_TOOLS = [
  {
    route: "POST /api/x-search-recent",
    name: "X recent tweet search",
    slug: "x-search-recent",
    category: "web",
    price: "$0.08",
    description:
      "Search public tweets from the last 7 days on X (Twitter) by query, using X API v2 search operators (keywords, from:, #hashtag, lang:, -is:retweet). Returns up to 10 tweets per call with text, created time, language, engagement metrics (likes, retweets, replies, quotes, impressions) and the author's username flattened onto each row, plus a next_token for paging.",
    tags: [...SHARED_TAGS, "search", "recent"],
    discovery: {
      bodyType: "json",
      input: { query: "x402 -is:retweet", max_results: 10 },
      inputSchema: {
        properties: {
          query: { type: "string", description: "X search query (max 512 chars). Supports X operators: from:user, #tag, lang:en, -is:retweet, has:links." },
          max_results: { type: "number", description: "Tweets per page, up to 10 (default 10). The upstream bills per post returned, so the page size is capped." },
          sort_order: { type: "string", description: "recency (default) or relevancy." },
          next_token: { type: "string", description: "Pagination token from a previous response." },
        },
        required: ["query"],
      },
      output: {
        example: {
          source: "x-api-v2",
          fetchedAt: "2026-08-20T14:10:00.000Z",
          query: "x402 -is:retweet",
          count: 1,
          tweets: [TWEET_EXAMPLE],
          nextToken: "b26v89c19zqg8o3fpzbl7xxxxx",
        },
      },
    },
    handler: async (i) => {
      const query = typeof i.query === "string" ? i.query.trim() : "";
      if (!query) throw bad('"query" is required - an X search query, e.g. "x402 -is:retweet"');
      if (query.length > 512) throw bad(`"query" is too long (${query.length} chars, max 512)`);
      const maxResults = takeMaxResults(i.max_results, { min: 10, max: Math.max(10, X_MAX_POSTS_PER_CALL()), dflt: 10 });
      const sort = i.sort_order === undefined || i.sort_order === null || i.sort_order === "" ? "recency" : String(i.sort_order);
      if (sort !== "recency" && sort !== "relevancy") throw bad('"sort_order" must be "recency" or "relevancy"');
      const nextToken = takeToken(i.next_token, "next_token");

      const data = await xGet("/tweets/search/recent", {
        query,
        max_results: maxResults,
        sort_order: sort,
        next_token: nextToken,
        "tweet.fields": TWEET_FIELDS,
        expansions: "author_id",
        "user.fields": "username,name,verified",
      });
      const authors = authorIndex(data.includes);
      const tweets = (Array.isArray(data.data) ? data.data : []).map((t) => shapeTweet(t, authors)).filter(Boolean);
      return {
        source: "x-api-v2",
        fetchedAt: nowIso(),
        query,
        count: tweets.length,
        tweets,
        nextToken: data.meta?.next_token ?? null,
      };
    },
  },

  {
    route: "POST /api/x-user",
    name: "X user profile",
    slug: "x-user",
    category: "web",
    price: "$0.015",
    description:
      "Look up one X (Twitter) account by username: id, display name, bio, account creation date, verification status and type, location, link, protected flag, and public metrics (followers, following, tweet count, listed count).",
    tags: [...SHARED_TAGS, "user", "profile", "followers"],
    discovery: {
      bodyType: "json",
      input: { username: "coinbase" },
      inputSchema: {
        properties: {
          username: { type: "string", description: "X username, with or without the leading @ (1-15 chars)." },
        },
        required: ["username"],
      },
      output: { example: { source: "x-api-v2", fetchedAt: "2026-08-20T14:10:00.000Z", user: USER_EXAMPLE } },
    },
    handler: async (i) => {
      const username = takeUsername(i.username);
      const u = await resolveUserId(username);
      return { source: "x-api-v2", fetchedAt: nowIso(), user: shapeUser(u) };
    },
  },

  {
    route: "POST /api/x-user-tweets",
    name: "X user timeline",
    slug: "x-user-tweets",
    category: "web",
    price: "$0.08",
    description:
      "Fetch an X (Twitter) account's most recent tweets by user id or username (username is resolved first). Options to exclude retweets and replies, page with pagination_token, or fetch only tweets newer than since_id. Each tweet carries text, created time, language and engagement metrics.",
    tags: [...SHARED_TAGS, "timeline", "user-tweets"],
    discovery: {
      bodyType: "json",
      input: { username: "coinbase", max_results: 10, exclude_retweets: true, exclude_replies: true },
      inputSchema: {
        properties: {
          id: { type: "string", description: "Numeric X user id. Provide id OR username." },
          username: { type: "string", description: "X username (resolved to an id first). Provide id OR username." },
          max_results: { type: "number", description: "Tweets per page, 5-10 (default 10). The upstream bills per post returned, so the page size is capped." },
          exclude_retweets: { type: "boolean", description: "Drop retweets (default false)." },
          exclude_replies: { type: "boolean", description: "Drop replies (default false)." },
          since_id: { type: "string", description: "Only tweets with an id greater than this." },
          pagination_token: { type: "string", description: "Pagination token from a previous response." },
        },
      },
      output: {
        example: {
          source: "x-api-v2",
          fetchedAt: "2026-08-20T14:10:00.000Z",
          user: { id: "574032254", username: "coinbase", name: "Coinbase", verified: true },
          count: 1,
          tweets: [{ ...TWEET_EXAMPLE, authorId: "574032254", author: { username: "coinbase", name: "Coinbase", verified: true }, url: "https://x.com/coinbase/status/1800000000000000000" }],
          nextToken: "7140dibdnow9c7btw4xxxxx",
        },
      },
    },
    handler: async (i) => {
      const hasId = i.id !== undefined && i.id !== null && i.id !== "";
      const hasUsername = typeof i.username === "string" && i.username.trim() !== "";
      if (!hasId && !hasUsername) throw bad('Provide "id" (numeric X user id) or "username"');
      const maxResults = takeMaxResults(i.max_results, { min: 5, max: X_MAX_POSTS_PER_CALL(), dflt: 10 });
      const excludeRetweets = takeBool(i.exclude_retweets, "exclude_retweets");
      const excludeReplies = takeBool(i.exclude_replies, "exclude_replies");
      const sinceId = i.since_id === undefined || i.since_id === null || i.since_id === "" ? null : takeId(i.since_id, "since_id");
      const paginationToken = takeToken(i.pagination_token, "pagination_token");

      let user;
      if (hasId) {
        user = { id: takeId(i.id, "id"), username: null, name: null, verified: false };
      } else {
        const u = await resolveUserId(takeUsername(i.username));
        user = { id: u.id, username: u.username ?? null, name: u.name ?? null, verified: Boolean(u.verified) };
      }

      const exclude = [excludeRetweets && "retweets", excludeReplies && "replies"].filter(Boolean).join(",");
      const data = await xGet(`/users/${encodeURIComponent(user.id)}/tweets`, {
        max_results: maxResults,
        exclude: exclude || undefined,
        since_id: sinceId,
        pagination_token: paginationToken,
        "tweet.fields": TWEET_FIELDS,
        expansions: "author_id",
        "user.fields": "username,name,verified",
      });
      const authors = authorIndex(data.includes);
      // A lookup by id carries no profile; take it from the expansion when present.
      if (!user.username) {
        const a = authors.get(user.id);
        if (a) user = { id: user.id, username: a.username ?? null, name: a.name ?? null, verified: Boolean(a.verified) };
      }
      const tweets = (Array.isArray(data.data) ? data.data : []).map((t) => shapeTweet(t, authors)).filter(Boolean);
      return {
        source: "x-api-v2",
        fetchedAt: nowIso(),
        user,
        count: tweets.length,
        tweets,
        nextToken: data.meta?.next_token ?? null,
      };
    },
  },

  {
    route: "POST /api/x-tweet",
    name: "X tweet lookup",
    slug: "x-tweet",
    category: "web",
    price: "$0.008",
    description:
      "Fetch one public tweet on X (Twitter) by id: text, created time, language, conversation id, engagement metrics (likes, retweets, replies, quotes, bookmarks, impressions) and the author's username, name and verification.",
    tags: [...SHARED_TAGS, "tweet", "status"],
    discovery: {
      bodyType: "json",
      input: { id: "1800000000000000000" },
      inputSchema: {
        properties: {
          id: { type: "string", description: "Numeric tweet id (the trailing number of a status URL)." },
        },
        required: ["id"],
      },
      output: { example: { source: "x-api-v2", fetchedAt: "2026-08-20T14:10:00.000Z", tweet: TWEET_EXAMPLE } },
    },
    handler: async (i) => {
      const id = takeId(i.id, "id");
      const data = await xGet(`/tweets/${encodeURIComponent(id)}`, {
        "tweet.fields": TWEET_FIELDS,
        expansions: "author_id",
        "user.fields": "username,name,verified",
      });
      if (!data.data?.id) throw bad("Not found on X", 404);
      const tweet = shapeTweet(data.data, authorIndex(data.includes));
      return { source: "x-api-v2", fetchedAt: nowIso(), tweet };
    },
  },

  {
    route: "POST /api/x-users-lookup",
    name: "X bulk user lookup",
    slug: "x-users-lookup",
    category: "web",
    price: "$0.15",
    description:
      "Look up up to 10 X (Twitter) accounts by username in one call. Returns each found profile with public metrics (followers, following, tweets, listed), verification status and bio, plus the list of usernames X did not resolve.",
    tags: [...SHARED_TAGS, "users", "bulk", "lookup"],
    discovery: {
      bodyType: "json",
      input: { usernames: ["coinbase", "base"] },
      inputSchema: {
        properties: {
          usernames: { type: "array", items: { type: "string" }, description: "1-10 usernames (array, or a comma-separated string)." },
        },
        required: ["usernames"],
      },
      output: {
        example: {
          source: "x-api-v2",
          fetchedAt: "2026-08-20T14:10:00.000Z",
          count: 1,
          users: [USER_EXAMPLE],
          notFound: ["nosuchuser_xyz"],
        },
      },
    },
    handler: async (i) => {
      let raw = i.usernames;
      if (typeof raw === "string") raw = raw.split(",");
      if (!Array.isArray(raw) || raw.length === 0) throw bad('"usernames" is required - an array of 1-100 X usernames');
      if (raw.length > X_MAX_USERS_PER_LOOKUP) throw bad(`Too many usernames (${raw.length}); the cap is ${X_MAX_USERS_PER_LOOKUP} per call`);
      const usernames = [...new Set(raw.map((u, idx) => takeUsername(u, `usernames[${idx}]`)))];

      const data = await xGet("/users/by", { usernames: usernames.join(","), "user.fields": USER_FIELDS });
      const users = (Array.isArray(data.data) ? data.data : []).map(shapeUser).filter(Boolean);
      const found = new Set(users.map((u) => String(u.username || "").toLowerCase()));
      // X lists unresolved handles under `errors`; fall back to a set difference.
      const notFound = usernames.filter((u) => !found.has(u.toLowerCase()));
      return { source: "x-api-v2", fetchedAt: nowIso(), count: users.length, users, notFound };
    },
  },
];

export const __test = { takeUsername, takeId, takeMaxResults, takeToken, shapeTweet, shapeUser, X_API };

// Free text in these results is written by third parties (headlines, posts,
// casts, token names and descriptions, page titles). Anyone can mint a token or
// publish a post, so this is the cheapest prompt-injection delivery vehicle in
// the catalog: flag it as data, never instructions, the way site-crawl does.
const UNTRUSTED_TEXT_SLUGS = new Set(["x-search-recent", "x-user", "x-user-tweets", "x-tweet", "x-users-lookup"]);
for (const t of X_DATA_TOOLS) {
  if (!UNTRUSTED_TEXT_SLUGS.has(t.slug)) continue;
  const inner = t.handler;
  t.handler = async (...args) => markUntrusted(await inner(...args));
}
