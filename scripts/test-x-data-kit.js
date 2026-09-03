// scripts/test-x-data-kit.js
// Offline tests for src/tools/x-data-kit.js. No bearer, no network: every
// upstream call is served by a stubbed globalThis.fetch. Covers: the catalog
// envelope, the gating predicate, no-key -> 503, input validation (400),
// fixture output shapes, and the 429 / 401 / 404 / 5xx / timeout mapping.
// Live calls need a real X_BEARER_TOKEN and are not exercised here.

import { X_DATA_TOOLS, xDataEnabled, __test } from "../src/tools/x-data-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const h = (slug) => X_DATA_TOOLS.find((t) => t.slug === slug).handler;

async function throws(promise, status, label, re) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && (!re || re.test(e.message))) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}${re ? ` /${re.source}/` : ""}, got ${e.statusCode} (${e.message})`); }
  }
}

const realFetch = globalThis.fetch;
const jsonRes = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
// Priced 2026-08-27 against X's published pay-per-use rate card ($0.005/post read, $0.010/user read; page cap 10).
const EXPECTED = { "x-search-recent": "$0.08", "x-user": "$0.015", "x-user-tweets": "$0.08", "x-tweet": "$0.008", "x-users-lookup": "$0.15" };
ok(X_DATA_TOOLS.length === 5, `5 tools exported (got ${X_DATA_TOOLS.length})`);
for (const t of X_DATA_TOOLS) {
  ok(EXPECTED[t.slug] === t.price, `${t.slug}: priced ${t.price}`);
  ok(t.route === `POST /api/${t.slug}`, `${t.slug}: POST /api/${t.slug}`);
  ok(typeof t.handler === "function" && typeof t.name === "string" && typeof t.description === "string" && Array.isArray(t.tags), `${t.slug}: envelope`);
  ok(t.discovery?.input && t.discovery?.inputSchema?.properties && t.discovery?.output?.example, `${t.slug}: discovery input + schema + example`);
  ok(!/\u2014/.test(t.description), `${t.slug}: no em dashes in description`);
}

// ----------------------------------------------------------------------------
// Gating predicate reflects env
// ----------------------------------------------------------------------------
const stashed = process.env.X_BEARER_TOKEN;
delete process.env.X_BEARER_TOKEN;
ok(xDataEnabled() === false, "xDataEnabled(): false without X_BEARER_TOKEN");
process.env.X_BEARER_TOKEN = "   ";
ok(xDataEnabled() === false, "xDataEnabled(): whitespace-only token is not configured");
process.env.X_BEARER_TOKEN = "test-bearer-token-0123456789";
ok(xDataEnabled() === true, "xDataEnabled(): true with X_BEARER_TOKEN");

// ----------------------------------------------------------------------------
// No key -> 503 (never reaches fetch)
// ----------------------------------------------------------------------------
delete process.env.X_BEARER_TOKEN;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; return jsonRes(200, {}); };
await throws(h("x-search-recent")({ query: "x402" }), 503, "x-search-recent: 503 without bearer", /X_BEARER_TOKEN/);
await throws(h("x-user")({ username: "coinbase" }), 503, "x-user: 503 without bearer");
await throws(h("x-user-tweets")({ username: "coinbase" }), 503, "x-user-tweets: 503 without bearer");
await throws(h("x-tweet")({ id: "1800000000000000000" }), 503, "x-tweet: 503 without bearer");
await throws(h("x-users-lookup")({ usernames: ["coinbase"] }), 503, "x-users-lookup: 503 without bearer");
ok(fetchCalls === 0, "no-key path never calls fetch");

// ----------------------------------------------------------------------------
// Input validation (400) - checked BEFORE the key, so no bearer needed
// ----------------------------------------------------------------------------
await throws(h("x-search-recent")({}), 400, "x-search-recent: missing query");
await throws(h("x-search-recent")({ query: "a".repeat(513) }), 400, "x-search-recent: query over 512 chars");
await throws(h("x-search-recent")({ query: "x402", max_results: 5 }), 400, "x-search-recent: max_results below 10");
await throws(h("x-search-recent")({ query: "x402", max_results: 101 }), 400, "x-search-recent: max_results above 100");
await throws(h("x-search-recent")({ query: "x402", max_results: 10.5 }), 400, "x-search-recent: non-integer max_results");
await throws(h("x-search-recent")({ query: "x402", sort_order: "newest" }), 400, "x-search-recent: bad sort_order");
await throws(h("x-search-recent")({ query: "x402", next_token: "bad token!" }), 400, "x-search-recent: bad next_token charset");
await throws(h("x-user")({}), 400, "x-user: missing username");
await throws(h("x-user")({ username: "way_too_long_username_xyz" }), 400, "x-user: username over 15 chars");
await throws(h("x-user")({ username: "bad name" }), 400, "x-user: username with space");
await throws(h("x-user-tweets")({}), 400, "x-user-tweets: neither id nor username");
await throws(h("x-user-tweets")({ id: "abc" }), 400, "x-user-tweets: non-numeric id");
await throws(h("x-user-tweets")({ username: "coinbase", max_results: 4 }), 400, "x-user-tweets: max_results below 5");
await throws(h("x-user-tweets")({ username: "coinbase", exclude_retweets: "maybe" }), 400, "x-user-tweets: non-boolean exclude_retweets");
await throws(h("x-user-tweets")({ username: "coinbase", since_id: "x" }), 400, "x-user-tweets: non-numeric since_id");
await throws(h("x-tweet")({}), 400, "x-tweet: missing id");
await throws(h("x-tweet")({ id: "12ab" }), 400, "x-tweet: non-numeric id");
await throws(h("x-users-lookup")({}), 400, "x-users-lookup: missing usernames");
await throws(h("x-users-lookup")({ usernames: [] }), 400, "x-users-lookup: empty usernames");
await throws(h("x-users-lookup")({ usernames: Array.from({ length: 101 }, (_, i) => `u${i}`) }), 400, "x-users-lookup: over 100 usernames");
await throws(h("x-users-lookup")({ usernames: ["coinbase", "bad name"] }), 400, "x-users-lookup: one invalid username rejects the call");
ok(fetchCalls === 0, "validation failures never call fetch");

// Pure helpers
ok(__test.takeUsername("@Coinbase") === "Coinbase", "takeUsername strips a leading @");
ok(__test.takeId(1800000000000000000n.toString()) === "1800000000000000000", "takeId accepts a 19-digit id string");

// ----------------------------------------------------------------------------
// Fixture shapes (bearer set, fetch stubbed)
// ----------------------------------------------------------------------------
process.env.X_BEARER_TOKEN = "test-bearer-token-0123456789";
let lastUrl = null, lastInit = null;
const SEARCH_FIXTURE = {
  data: [
    { id: "1800000000000000001", text: "x402 is neat", created_at: "2026-08-20T14:05:00.000Z", author_id: "111", lang: "en", conversation_id: "1800000000000000001", possibly_sensitive: false, public_metrics: { retweet_count: 3, reply_count: 1, like_count: 12, quote_count: 0, bookmark_count: 2, impression_count: 1400 } },
    { id: "1800000000000000002", text: "no author in includes", created_at: "2026-08-20T14:06:00.000Z", author_id: "999", lang: "en", public_metrics: { retweet_count: 0, reply_count: 0, like_count: 0, quote_count: 0 } },
  ],
  includes: { users: [{ id: "111", username: "example_dev", name: "Example Dev", verified: false }] },
  meta: { newest_id: "1800000000000000002", oldest_id: "1800000000000000001", result_count: 2, next_token: "b26v89c19zqg8o3fpzbl7" },
};
globalThis.fetch = async (url, init) => { fetchCalls++; lastUrl = new URL(String(url)); lastInit = init; return jsonRes(200, SEARCH_FIXTURE); };

{
  fetchCalls = 0;
  const out = await h("x-search-recent")({ query: "x402 -is:retweet", max_results: 10, sort_order: "relevancy" });
  ok(lastUrl.origin + lastUrl.pathname === "https://api.x.com/2/tweets/search/recent", "search: hits /2/tweets/search/recent");
  ok(lastUrl.searchParams.get("query") === "x402 -is:retweet" && lastUrl.searchParams.get("max_results") === "10" && lastUrl.searchParams.get("sort_order") === "relevancy", "search: query/max_results/sort_order on the wire");
  ok(lastUrl.searchParams.get("expansions") === "author_id" && /public_metrics/.test(lastUrl.searchParams.get("tweet.fields")) && /username/.test(lastUrl.searchParams.get("user.fields")), "search: author expansion + tweet/user fields requested");
  ok(lastInit.headers.Authorization === "Bearer test-bearer-token-0123456789", "search: app-only bearer on the request");
  ok(lastInit.signal instanceof AbortSignal, "search: request carries an abort signal (timeout)");
  ok(out.source === "x-api-v2" && typeof out.fetchedAt === "string" && !Number.isNaN(Date.parse(out.fetchedAt)), "search: source + fetchedAt");
  ok(out.count === 2 && out.tweets.length === 2 && out.nextToken === "b26v89c19zqg8o3fpzbl7", "search: count + tweets + nextToken");
  const t0 = out.tweets[0];
  ok(t0.id === "1800000000000000001" && t0.text === "x402 is neat" && t0.lang === "en" && t0.createdAt === "2026-08-20T14:05:00.000Z", "search: tweet core fields");
  ok(t0.author?.username === "example_dev" && t0.author.name === "Example Dev" && t0.author.verified === false, "search: author flattened from includes.users");
  ok(t0.metrics.likes === 12 && t0.metrics.retweets === 3 && t0.metrics.replies === 1 && t0.metrics.quotes === 0 && t0.metrics.bookmarks === 2 && t0.metrics.impressions === 1400, "search: public_metrics mapped");
  ok(t0.url === "https://x.com/example_dev/status/1800000000000000001", "search: status URL built from author + id");
  const t1 = out.tweets[1];
  ok(t1.author === null && t1.url === "https://x.com/i/status/1800000000000000002" && t1.metrics.impressions === null, "search: missing author -> null author + /i/status URL; missing metric -> null");
  ok(fetchCalls === 1, "search: exactly one upstream call");
}

// x-user
const USER_FIXTURE = { data: { id: "574032254", name: "Coinbase", username: "coinbase", created_at: "2012-05-07T23:46:41.000Z", description: "The future of money is here.", verified: true, verified_type: "business", location: "Global", url: "https://coinbase.com", protected: false, profile_image_url: "https://pbs.twimg.com/x.jpg", public_metrics: { followers_count: 6400000, following_count: 250, tweet_count: 19000, listed_count: 9000, like_count: 5 } } };
globalThis.fetch = async (url) => { fetchCalls++; lastUrl = new URL(String(url)); return jsonRes(200, USER_FIXTURE); };
{
  fetchCalls = 0;
  const out = await h("x-user")({ username: "@Coinbase" });
  ok(lastUrl.pathname === "/2/users/by/username/Coinbase" && /public_metrics/.test(lastUrl.searchParams.get("user.fields")), "x-user: /2/users/by/username/:u with user.fields (leading @ stripped)");
  ok(out.source === "x-api-v2" && out.user.id === "574032254" && out.user.username === "coinbase" && out.user.verified === true && out.user.verifiedType === "business", "x-user: core profile fields");
  ok(out.user.metrics.followers === 6400000 && out.user.metrics.following === 250 && out.user.metrics.tweets === 19000 && out.user.metrics.listed === 9000, "x-user: public metrics mapped");
  ok(out.user.description === "The future of money is here." && out.user.createdAt === "2012-05-07T23:46:41.000Z" && out.user.profileUrl === "https://x.com/coinbase", "x-user: description/createdAt/profileUrl");
  ok(!("like_count" in (out.user.metrics || {})), "x-user: unmapped upstream metric is not leaked");
}

// x-user-tweets by username: resolve first, then timeline
const TIMELINE_FIXTURE = {
  data: [{ id: "1800000000000000005", text: "hello from coinbase", created_at: "2026-08-20T15:00:00.000Z", author_id: "574032254", lang: "en", public_metrics: { retweet_count: 1, reply_count: 2, like_count: 3, quote_count: 4 } }],
  includes: { users: [{ id: "574032254", username: "coinbase", name: "Coinbase", verified: true }] },
  meta: { result_count: 1, next_token: "7140dibdnow9c7btw4" },
};
let urls = [];
globalThis.fetch = async (url) => {
  fetchCalls++;
  const u = new URL(String(url));
  urls.push(u);
  if (u.pathname.startsWith("/2/users/by/username/")) return jsonRes(200, USER_FIXTURE);
  if (/^\/2\/users\/\d+\/tweets$/.test(u.pathname)) return jsonRes(200, TIMELINE_FIXTURE);
  return jsonRes(404, { errors: [{ title: "Not Found" }] });
};
{
  fetchCalls = 0; urls = [];
  const out = await h("x-user-tweets")({ username: "coinbase", max_results: 5, exclude_retweets: true, exclude_replies: "true", since_id: "1700000000000000000" });
  ok(urls.length === 2 && urls[0].pathname === "/2/users/by/username/coinbase" && urls[1].pathname === "/2/users/574032254/tweets", "x-user-tweets: username resolved first, then /2/users/:id/tweets");
  ok(urls[1].searchParams.get("exclude") === "retweets,replies" && urls[1].searchParams.get("max_results") === "5" && urls[1].searchParams.get("since_id") === "1700000000000000000", "x-user-tweets: exclude/max_results/since_id on the wire");
  ok(out.user.id === "574032254" && out.user.username === "coinbase" && out.user.verified === true, "x-user-tweets: resolved user echoed");
  ok(out.count === 1 && out.tweets[0].text === "hello from coinbase" && out.tweets[0].author.username === "coinbase" && out.nextToken === "7140dibdnow9c7btw4", "x-user-tweets: tweets + nextToken");
}
{
  fetchCalls = 0; urls = [];
  const out = await h("x-user-tweets")({ id: "574032254" });
  ok(urls.length === 1 && urls[0].pathname === "/2/users/574032254/tweets" && urls[0].searchParams.get("exclude") === null && urls[0].searchParams.get("max_results") === "10", "x-user-tweets by id: no resolve hop, default max_results 10, no exclude");
  ok(out.user.username === "coinbase", "x-user-tweets by id: username filled from the author expansion");
}

// x-tweet
const TWEET_FIXTURE = { data: { id: "1800000000000000001", text: "x402 is neat", created_at: "2026-08-20T14:05:00.000Z", author_id: "111", lang: "en", public_metrics: { retweet_count: 3, reply_count: 1, like_count: 12, quote_count: 0 } }, includes: { users: [{ id: "111", username: "example_dev", name: "Example Dev", verified: false }] } };
globalThis.fetch = async (url) => { fetchCalls++; lastUrl = new URL(String(url)); return jsonRes(200, TWEET_FIXTURE); };
{
  const out = await h("x-tweet")({ id: 1800000000000000001n.toString() });
  ok(lastUrl.pathname === "/2/tweets/1800000000000000001" && lastUrl.searchParams.get("expansions") === "author_id", "x-tweet: /2/tweets/:id with author expansion");
  ok(out.tweet.id === "1800000000000000001" && out.tweet.author.username === "example_dev" && out.tweet.metrics.likes === 12 && out.tweet.url === "https://x.com/example_dev/status/1800000000000000001", "x-tweet: tweet + author + metrics + url");
}
// x-tweet: 200 with no data (deleted / protected) -> 404
globalThis.fetch = async () => jsonRes(200, { errors: [{ title: "Not Found Error", resource_type: "tweet" }] });
await throws(h("x-tweet")({ id: "1" }), 404, "x-tweet: 200 envelope with no data -> 404");

// x-users-lookup
const BULK_FIXTURE = { data: [USER_FIXTURE.data, { id: "2", username: "base", name: "Base", verified: true, public_metrics: { followers_count: 10 } }], errors: [{ value: "nosuchuser_xyz", detail: "Could not find user", title: "Not Found Error" }] };
globalThis.fetch = async (url) => { fetchCalls++; lastUrl = new URL(String(url)); return jsonRes(200, BULK_FIXTURE); };
{
  const out = await h("x-users-lookup")({ usernames: ["coinbase", "@base", "nosuchuser_xyz", "coinbase"] });
  ok(lastUrl.pathname === "/2/users/by" && lastUrl.searchParams.get("usernames") === "coinbase,base,nosuchuser_xyz", "x-users-lookup: /2/users/by?usernames= (deduped, @ stripped)");
  ok(out.count === 2 && out.users[0].username === "coinbase" && out.users[1].metrics.followers === 10 && out.users[1].metrics.following === null, "x-users-lookup: users shaped, missing metrics null");
  ok(out.notFound.length === 1 && out.notFound[0] === "nosuchuser_xyz", "x-users-lookup: unresolved handles listed in notFound");
  const out2 = await h("x-users-lookup")({ usernames: "coinbase, base" });
  ok(lastUrl.searchParams.get("usernames") === "coinbase,base" && out2.count === 2, "x-users-lookup: comma-separated string accepted");
}

// ----------------------------------------------------------------------------
// Upstream status mapping
// ----------------------------------------------------------------------------
const resetAt = Math.floor(Date.now() / 1000) + 120;
globalThis.fetch = async () => jsonRes(429, { title: "Too Many Requests" }, { "x-rate-limit-reset": String(resetAt) });
await throws(h("x-search-recent")({ query: "x402" }), 503, "429 -> 503 with reset hint", /rate cap.*resets in about 1\d\ds/);
globalThis.fetch = async () => jsonRes(429, {});
await throws(h("x-user")({ username: "coinbase" }), 503, "429 without reset header -> 503 retry shortly", /retry shortly/);
globalThis.fetch = async () => jsonRes(401, { title: "Unauthorized" });
await throws(h("x-user")({ username: "coinbase" }), 503, "401 -> 503 not configured", /not configured/);
globalThis.fetch = async () => jsonRes(403, { title: "Forbidden", detail: "SECRET-UPSTREAM-TEXT" });
await throws(h("x-tweet")({ id: "1" }), 503, "403 -> 503 not configured", /not configured/);
globalThis.fetch = async () => jsonRes(404, { title: "Not Found", detail: "SECRET-UPSTREAM-TEXT" });
await throws(h("x-user")({ username: "nobody_here" }), 404, "404 -> 404");
globalThis.fetch = async () => jsonRes(400, { errors: [{ message: "SECRET-UPSTREAM-TEXT" }] });
await throws(h("x-search-recent")({ query: "((" }), 400, "upstream 400 -> 400 (bad query syntax)", /check the query syntax/);
globalThis.fetch = async () => jsonRes(500, { detail: "SECRET-UPSTREAM-TEXT" });
await throws(h("x-search-recent")({ query: "x402" }), 502, "500 -> 502");
globalThis.fetch = async () => jsonRes(503, {});
await throws(h("x-users-lookup")({ usernames: ["coinbase"] }), 502, "503 -> 502");
globalThis.fetch = async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
await throws(h("x-search-recent")({ query: "x402" }), 504, "timeout -> 504");
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("bad json"); } });
await throws(h("x-search-recent")({ query: "x402" }), 502, "non-JSON 200 -> 502");
// Upstream bodies are never relayed
{
  const msgs = [];
  for (const st of [400, 403, 404, 500]) {
    globalThis.fetch = async () => jsonRes(st, { errors: [{ message: "SECRET-UPSTREAM-TEXT" }], detail: "SECRET-UPSTREAM-TEXT" });
    try { await h("x-search-recent")({ query: "x402" }); } catch (e) { msgs.push(e.message); }
  }
  ok(msgs.length === 4 && msgs.every((m) => !m.includes("SECRET-UPSTREAM-TEXT")), "upstream error bodies never reach the buyer message");
}
// The timeline's resolve hop maps the same way
globalThis.fetch = async () => jsonRes(404, {});
await throws(h("x-user-tweets")({ username: "nobody_here" }), 404, "x-user-tweets: unknown username -> 404 at the resolve hop");

// ----------------------------------------------------------------------------
globalThis.fetch = realFetch;
if (stashed === undefined) delete process.env.X_BEARER_TOKEN; else process.env.X_BEARER_TOKEN = stashed;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
