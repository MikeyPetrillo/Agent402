// scripts/test-farcaster-social-kit.js
// Offline tests for src/tools/farcaster-social-kit.js. No key, no network:
// globalThis.fetch is stubbed. Pins: catalog envelope, no-key 503 WITHOUT a
// fetch, the x-api-key header, input validation, upstream status mapping
// (401/402/403 -> 503, 429 -> 503 + hint, 404 -> 404, 4xx -> 400 name-only,
// 5xx -> 502, a deadline -> 503 naming the step), the 60 s in-process cache, and the compact
// output mapping against fixtures shaped like the live Neynar payloads.

import { FARCASTER_SOCIAL_TOOLS, farcasterSocialEnabled, __test } from "../src/tools/farcaster-social-kit.js";

const {
  NEYNAR_API, clearCache, cacheSize, parseIdentifier, parseChannelRef, takeUsername,
  takeChannelId, takeLimit, takeCursor, mapCast, mapChannel, mapUser, flattenReplies, readRateLimit,
} = __test;

const h = (slug) => FARCASTER_SOCIAL_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

async function throws(promise, status, label, msgRe) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && (!msgRe || msgRe.test(e.message))) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}${msgRe ? ` /${msgRe.source}/` : ""}, got ${e.statusCode} (${e.message})`); }
  }
}

// ----------------------------------------------------------------------------
// Fetch stub
// ----------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let calls = [];
let responder = null; // (url, init) => { status, json, headers }
function jsonRes(status, body, headers = {}) {
  const hdrs = new Map(Object.entries({ "content-type": "application/json", ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (n) => hdrs.get(String(n).toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  if (!responder) throw new Error("unexpected fetch: " + url);
  return responder(String(url), init);
};
const RL = { "x-ratelimit-limit": "300", "x-ratelimit-remaining": "299", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 45) };
const lastUrl = () => new URL(calls[calls.length - 1].url);

// ----------------------------------------------------------------------------
// Fixtures shaped like live Neynar payloads (trimmed)
// ----------------------------------------------------------------------------
const AUTHOR = {
  object: "user", fid: 3, username: "dwr", display_name: "Dan Romero", pfp_url: "https://img/x.png",
  profile: { bio: { text: "Interested in technology and other stuff." } },
  follower_count: 630338, following_count: 77, power_badge: false, score: 0.99,
  verified_addresses: { eth_addresses: ["0x6ce0"], primary: { eth_address: "0x6ce09ed5526de4afe4a981ad86d17b2f5c92fea5", sol_address: null } },
};
const CAST = {
  object: "cast", hash: "0x322c451ed6ff1674328c6164b92166b3d15f2b7d", author: AUTHOR,
  thread_hash: "0x322c451ed6ff1674328c6164b92166b3d15f2b7d", parent_hash: null, parent_url: null,
  text: "quick let's all open up fc app", timestamp: "2026-08-20T00:58:40.000Z",
  embeds: [{ url: "https://example.com/a" }, { cast_id: { fid: 1, hash: "0xabc" } }, { url: "https://example.com/b" }],
  channel: { object: "channel_dehydrated", id: "base", name: "Base" },
  reactions: { likes_count: 196, recasts_count: 28, likes: [], recasts: [] },
  replies: { count: 50 }, mentioned_profiles: [],
};
const REPLY = { ...CAST, hash: "0x3351e22a524ed8c134d83890cb2edae0c4eb0bd6", parent_hash: CAST.hash, text: "reply 1", reactions: { likes_count: 7, recasts_count: 0 }, replies: { count: 1 }, channel: null, embeds: [] };
const REPLY2 = { ...REPLY, hash: "0x4451e22a524ed8c134d83890cb2edae0c4eb0bd7", parent_hash: REPLY.hash, text: "reply 1.1" };
const CHANNEL = {
  object: "channel", id: "base", url: "https://onchainsummer.xyz", name: "Base", image_url: "https://warpcast.com/~/channel-images/base.png",
  description: "Bringing the world onchain", public_casting: false, follower_count: 481202, member_count: 813, pinned_cast_hash: null,
  created_at: "2023-08-17T19:23:11.150Z", parent_url: "https://onchainsummer.xyz", moderator_fids: [12142, 15211], lead: { ...AUTHOR, fid: 12142, username: "base.base.eth", display_name: "Base", follower_count: 194536 },
};

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
const expectedSlugs = ["fc-cast-search", "fc-channel-feed", "fc-trending", "fc-user-casts", "fc-cast", "fc-cast-replies", "fc-channel", "fc-user-search", "fc-cast-metrics"];
ok(FARCASTER_SOCIAL_TOOLS.length === expectedSlugs.length, `${expectedSlugs.length} tools exported (got ${FARCASTER_SOCIAL_TOOLS.length})`);
for (const slug of expectedSlugs) ok(!!FARCASTER_SOCIAL_TOOLS.find((t) => t.slug === slug), `slug present: ${slug}`);
ok(new Set(FARCASTER_SOCIAL_TOOLS.map((t) => t.slug)).size === FARCASTER_SOCIAL_TOOLS.length, "slugs unique");
ok(new Set(FARCASTER_SOCIAL_TOOLS.map((t) => t.route)).size === FARCASTER_SOCIAL_TOOLS.length, "routes unique");
for (const t of FARCASTER_SOCIAL_TOOLS) {
  ok(t.route === `POST /api/${t.slug}`, `${t.slug}: route POST /api/<slug>`);
  ok(t.category === "web", `${t.slug}: category=web`);
  const price = Number(String(t.price).replace("$", ""));
  ok(/^\$\d/.test(t.price) && price >= 0.003 && price <= 0.008, `${t.slug}: priced in band (${t.price})`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.bodyType === "json" && d.input && d.inputSchema?.type === "object" && d.output?.example, `${t.slug}: full discovery envelope`);
  ok(Array.isArray(t.tags) && t.tags.includes("farcaster"), `${t.slug}: tagged farcaster`);
  ok(!/—/.test(t.description) && !/—/.test(t.name), `${t.slug}: no em dash in copy`);
  ok(d.output.example.source === "neynar" && "fetchedAt" in d.output.example && "rateLimit" in d.output.example, `${t.slug}: example carries source/fetchedAt/rateLimit`);
}
ok(NEYNAR_API === "https://api.neynar.com/v2/farcaster", "NEYNAR_API constant");

// ----------------------------------------------------------------------------
// No key -> 503 WITHOUT any fetch (every tool)
// ----------------------------------------------------------------------------
delete process.env.NEYNAR_API_KEY; delete process.env.WARPCAST_API_KEY;
ok(farcasterSocialEnabled() === false, "farcasterSocialEnabled() false without key");
for (const t of FARCASTER_SOCIAL_TOOLS) {
  calls = [];
  await throws(t.handler(structuredClone(t.discovery.input)), 503, `${t.slug}: no key -> 503`, /not configured/);
  ok(calls.length === 0, `${t.slug}: no fetch without key`);
}
// Legacy alias is honoured.
process.env.WARPCAST_API_KEY = "legacy-key-000000";
ok(farcasterSocialEnabled() === true, "farcasterSocialEnabled() true via WARPCAST_API_KEY alias");
calls = []; responder = () => jsonRes(200, { channel: CHANNEL }, RL);
await h("fc-channel")({ id: "base" });
ok(calls[0].init.headers["x-api-key"] === "legacy-key-000000", "alias key sent as x-api-key");
delete process.env.WARPCAST_API_KEY;
process.env.NEYNAR_API_KEY = "test-key-123456789";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
ok(parseIdentifier("0x322C451ED6FF1674328C6164B92166B3D15F2B7D").type === "hash", "parseIdentifier: hash");
ok(parseIdentifier("0x322C451ED6FF1674328C6164B92166B3D15F2B7D").identifier === "0x322c451ed6ff1674328c6164b92166b3d15f2b7d", "parseIdentifier: hash lowercased");
ok(parseIdentifier("https://warpcast.com/dwr/0x322c451e").type === "url", "parseIdentifier: warpcast url");
ok(parseIdentifier("https://farcaster.xyz/dwr/0x322c451e").type === "url", "parseIdentifier: farcaster.xyz url");
ok(parseIdentifier("https://warpcast.com/dwr/0x322c451e").identifier === "https://warpcast.com/dwr/0x322c451e", "parseIdentifier: url kept verbatim");
for (const badId of ["", "0x1234", "http://warpcast.com/dwr/0x1", "https://example.com/dwr/0x1", "https://warpcast.com/", 42]) {
  try { parseIdentifier(badId); fail++; console.error(`ASSERT FAIL - parseIdentifier(${JSON.stringify(badId)}) should throw`); }
  catch (e) { ok(e.statusCode === 400, `parseIdentifier(${JSON.stringify(badId)}) -> 400`); }
}
ok(parseChannelRef("base").type === "id" && parseChannelRef("/Base").id === "base", "parseChannelRef: id (leading slash, case)");
ok(parseChannelRef("https://onchainsummer.xyz").type === "parent_url" && parseChannelRef("https://onchainsummer.xyz").id === "https://onchainsummer.xyz", "parseChannelRef: parent url verbatim (no trailing slash added)");
try { parseChannelRef("http://onchainsummer.xyz"); fail++; console.error("ASSERT FAIL - http parent url"); } catch (e) { ok(e.statusCode === 400, "parseChannelRef: http -> 400"); }
try { parseChannelRef("bad channel!"); fail++; console.error("ASSERT FAIL - bad channel id"); } catch (e) { ok(e.statusCode === 400, "parseChannelRef: bad id -> 400"); }
ok(takeUsername("@DWR") === "dwr", "takeUsername: strips @, lowercases");
ok(takeUsername("base.base.eth") === "base.base.eth", "takeUsername: ENS subname ok");
ok(takeUsername("dwr.eth") === "dwr.eth", "takeUsername: .eth ok");
for (const u of ["", "-bad", "a".repeat(17), "a.b.c.eth", "has space", "x.com"]) {
  try { takeUsername(u); fail++; console.error(`ASSERT FAIL - takeUsername(${JSON.stringify(u)}) should throw`); }
  catch (e) { ok(e.statusCode === 400, `takeUsername(${JSON.stringify(u)}) -> 400`); }
}
ok(takeChannelId("/Base") === "base", "takeChannelId: strips leading slash, lowercases");
ok(takeLimit(undefined, { max: 100, dflt: 25 }) === 25, "takeLimit: default");
ok(takeLimit("10", { max: 100, dflt: 25 }) === 10, "takeLimit: numeric string");
for (const l of [0, 101, 1.5, "x"]) {
  try { takeLimit(l, { max: 100, dflt: 25 }); fail++; console.error(`ASSERT FAIL - takeLimit(${l})`); }
  catch (e) { ok(e.statusCode === 400, `takeLimit(${JSON.stringify(l)}) -> 400`); }
}
ok(takeCursor("eyJ0aW1lc3RhbXAiOi%3D%3D") === "eyJ0aW1lc3RhbXAiOi%3D%3D", "takeCursor: neynar-shaped cursor ok");
try { takeCursor("bad cursor with spaces"); fail++; console.error("ASSERT FAIL - takeCursor"); } catch (e) { ok(e.statusCode === 400, "takeCursor: junk -> 400"); }
ok(readRateLimit({ get: (n) => ({ "x-ratelimit-limit": "300", "x-ratelimit-remaining": "12", "x-ratelimit-reset": "1787404719" })[n] ?? null })?.remaining === 12, "readRateLimit: parses headers");
ok(readRateLimit({ get: () => null }) === null, "readRateLimit: null when absent");

// ----------------------------------------------------------------------------
// Mapping (compact output)
// ----------------------------------------------------------------------------
const mc = mapCast(CAST);
ok(mc.hash === CAST.hash && mc.text === CAST.text && mc.timestamp === CAST.timestamp, "mapCast: hash/text/timestamp");
ok(mc.author.fid === 3 && mc.author.username === "dwr" && mc.author.displayName === "Dan Romero" && mc.author.followerCount === 630338, "mapCast: compact author");
ok(Object.keys(mc.author).length === 4, "mapCast: author has exactly 4 keys (no pfp/bio/addresses)");
ok(mc.channel === "base" && mc.parentHash === null, "mapCast: channel id + parentHash");
ok(mc.reactions.likes === 196 && mc.reactions.recasts === 28 && mc.replies === 50, "mapCast: reactions + reply count");
ok(JSON.stringify(mc.embeds) === JSON.stringify(["https://example.com/a", "https://example.com/b"]), "mapCast: embeds are URLs only (cast embeds dropped)");
ok(mc.url === "https://warpcast.com/dwr/0x322c451e", "mapCast: warpcast url");
ok(mapCast({ hash: "0xab", author: null }).reactions.likes === 0 && mapCast({ hash: "0xab" }).embeds.length === 0, "mapCast: tolerates missing fields");
ok(mapCast(null) === null, "mapCast: null in -> null out");
const mch = mapChannel(CHANNEL);
ok(mch.id === "base" && mch.name === "Base" && mch.followerCount === 481202 && mch.memberCount === 813 && mch.parentUrl === "https://onchainsummer.xyz", "mapChannel: core fields");
ok(mch.lead.fid === 12142 && mch.lead.username === "base.base.eth" && mch.moderatorFids.length === 2 && mch.url === "https://warpcast.com/~/channel/base", "mapChannel: lead/moderators/url");
const mu = mapUser(AUTHOR);
ok(mu.fid === 3 && mu.bio === AUTHOR.profile.bio.text && mu.followingCount === 77 && mu.score === 0.99 && mu.primaryEthAddress === "0x6ce09ed5526de4afe4a981ad86d17b2f5c92fea5" && mu.url === "https://warpcast.com/dwr", "mapUser: fields");
const flat = flattenReplies({ direct_replies: [{ ...REPLY, direct_replies: [REPLY2] }] }, 1, 2, []);
ok(flat.length === 2 && flat[0].depth === 1 && flat[1].depth === 2 && flat[1].parentHash === REPLY.hash, "flattenReplies: depth-tagged, parent hashes kept");
ok(flattenReplies({ direct_replies: [{ ...REPLY, direct_replies: [REPLY2] }] }, 1, 1, []).length === 1, "flattenReplies: respects maxDepth");

// ----------------------------------------------------------------------------
// Input validation (no fetch on a 400)
// ----------------------------------------------------------------------------
responder = () => { throw new Error("should not fetch"); };
calls = [];
await throws(h("fc-cast-search")({}), 400, "fc-cast-search: missing q");
await throws(h("fc-cast-search")({ q: "x".repeat(257) }), 400, "fc-cast-search: q too long");
await throws(h("fc-cast-search")({ q: "x402", mode: "fuzzy" }), 400, "fc-cast-search: bad mode");
await throws(h("fc-cast-search")({ q: "x402", sort: "hot" }), 400, "fc-cast-search: bad sort");
await throws(h("fc-cast-search")({ q: "x402", limit: 101 }), 400, "fc-cast-search: limit > 100");
await throws(h("fc-cast-search")({ q: "x402", authorFid: -1 }), 400, "fc-cast-search: bad authorFid");
await throws(h("fc-cast-search")({ q: "x402", channel: "bad channel" }), 400, "fc-cast-search: bad channel");
await throws(h("fc-channel-feed")({}), 400, "fc-channel-feed: missing channel");
await throws(h("fc-channel-feed")({ channels: [] }), 400, "fc-channel-feed: empty channels");
await throws(h("fc-channel-feed")({ channels: new Array(11).fill("base") }), 400, "fc-channel-feed: > 10 channels");
await throws(h("fc-channel-feed")({ channel: "base", withReplies: "yes" }), 400, "fc-channel-feed: bad bool");
await throws(h("fc-trending")({ timeWindow: "24h" }), 400, "fc-trending: bad timeWindow");
await throws(h("fc-trending")({ limit: 26 }), 400, "fc-trending: limit > 25");
await throws(h("fc-user-casts")({}), 400, "fc-user-casts: missing fid/username");
await throws(h("fc-user-casts")({ fid: 0 }), 400, "fc-user-casts: bad fid");
await throws(h("fc-user-casts")({ username: "-bad" }), 400, "fc-user-casts: bad username");
await throws(h("fc-user-casts")({ fid: 3, limit: 101 }), 400, "fc-user-casts: limit > 100");
await throws(h("fc-cast")({}), 400, "fc-cast: missing identifier");
await throws(h("fc-cast")({ identifier: "https://example.com/x/0x1" }), 400, "fc-cast: foreign url");
await throws(h("fc-cast-replies")({ identifier: CAST.hash, depth: 6 }), 400, "fc-cast-replies: depth > 5");
await throws(h("fc-cast-replies")({ identifier: CAST.hash, limit: 51 }), 400, "fc-cast-replies: limit > 50");
await throws(h("fc-cast-replies")({ identifier: CAST.hash, sort: "best" }), 400, "fc-cast-replies: bad sort");
await throws(h("fc-channel")({}), 400, "fc-channel: missing id");
await throws(h("fc-user-search")({}), 400, "fc-user-search: missing q");
await throws(h("fc-user-search")({ q: "dwr", limit: 11 }), 400, "fc-user-search: limit > 10");
await throws(h("fc-cast-metrics")({}), 400, "fc-cast-metrics: missing q");
await throws(h("fc-cast-metrics")({ q: "x402", interval: "1h" }), 400, "fc-cast-metrics: bad interval");
ok(calls.length === 0, "validation failures never fetch");

// ----------------------------------------------------------------------------
// Upstream status mapping
// ----------------------------------------------------------------------------
clearCache();
for (const [status, want, re] of [[401, 503, /not configured/], [402, 503, /not configured/], [403, 503, /not configured/], [500, 502, /upstream error/], [503, 502, /upstream error/]]) {
  responder = () => jsonRes(status, { message: "SECRET upstream body" }, RL);
  await throws(h("fc-channel")({ id: "base" }), want, `upstream ${status} -> ${want}`, re);
}
responder = () => jsonRes(429, { message: "slow down" }, RL);
await throws(h("fc-channel")({ id: "base" }), 503, "upstream 429 -> 503 with reset hint", /resets in about \d+s/);
responder = () => jsonRes(429, { message: "slow down" }, { "retry-after": "7" });
await throws(h("fc-channel")({ id: "base" }), 503, "upstream 429 -> 503 with retry-after hint", /about 7s/);
responder = () => jsonRes(429, {}, {});
await throws(h("fc-channel")({ id: "base" }), 503, "upstream 429 -> 503 generic hint", /retry shortly/);
responder = () => jsonRes(404, { message: "Channel with id nope not found" }, RL);
await throws(h("fc-channel")({ id: "nope" }), 404, "upstream 404 -> 404", /channel "nope" not found/);
responder = () => jsonRes(404, { code: "NotFound", message: "cast not found" }, RL);
await throws(h("fc-cast")({ identifier: CAST.hash }), 404, "fc-cast: upstream 404 -> 404");
await throws(h("fc-cast-replies")({ identifier: CAST.hash }), 404, "fc-cast-replies: upstream 404 -> 404");
responder = () => jsonRes(400, { code: "InvalidField", message: "Invalid hash SECRET-DETAIL", property: "hash" }, RL);
await throws(h("fc-cast")({ identifier: CAST.hash }), 400, "upstream 400 -> 400 naming the parameter only", /check "hash"/);
try { await h("fc-cast")({ identifier: CAST.hash }); } catch (e) { ok(!/SECRET/.test(e.message), "upstream 400 body never relayed"); }
responder = () => jsonRes(400, { message: "bad", property: "<script>" }, RL);
await throws(h("fc-cast")({ identifier: CAST.hash }), 400, "upstream 400 with junk property -> generic", /check the parameters/);
responder = () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; };
await throws(h("fc-channel")({ id: "base" }), 503, "deadline -> 503 naming the upstream and the step", /^Farcaster upstream did not answer the channel read within \d+ s \(upstream deadline\)/);
responder = () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new Error("nope"); } });
await throws(h("fc-channel")({ id: "base" }), 502, "non-JSON 200 -> 502");
responder = () => jsonRes(200, { channel: null }, RL);
await throws(h("fc-channel")({ id: "base" }), 404, "200 with null channel -> 404");
responder = () => jsonRes(200, { cast: {} }, RL);
await throws(h("fc-cast")({ identifier: CAST.hash }), 404, "200 with empty cast -> 404");
responder = () => jsonRes(200, { user: {} }, RL);
await throws(h("fc-user-casts")({ username: "zzqqxxnouser77" }), 404, "username resolve: no fid -> 404");

// ----------------------------------------------------------------------------
// Wire: header, URL, params per tool
// ----------------------------------------------------------------------------
clearCache();
responder = (url) => {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith("/cast/search")) return jsonRes(200, { result: { casts: [CAST], next: { cursor: "abc%3D" } } }, RL);
  if (p.endsWith("/feed/channels")) return jsonRes(200, { casts: [CAST, CAST], next: { cursor: null } }, RL);
  if (p.endsWith("/channel/trending/")) return jsonRes(200, { channels: [{ object: "channel_activity", cast_count_1d: "2", cast_count_7d: "8", cast_count_30d: "44", channel: CHANNEL }], next: { cursor: null } }, RL);
  if (p.endsWith("/feed/user/casts")) return jsonRes(200, { casts: [CAST], next: { cursor: "zzz" } }, RL);
  if (p.endsWith("/user/by_username")) return jsonRes(200, { user: AUTHOR }, RL);
  if (p.endsWith("/cast/conversation")) return jsonRes(200, { conversation: { cast: { ...CAST, direct_replies: [{ ...REPLY, direct_replies: [REPLY2] }] } }, next: { cursor: null } }, RL);
  if (p.endsWith("/cast")) return jsonRes(200, { cast: CAST }, RL);
  if (p.endsWith("/channel")) return jsonRes(200, { channel: CHANNEL }, RL);
  if (p.endsWith("/user/search")) return jsonRes(200, { result: { users: [AUTHOR], next: { cursor: null } } }, RL);
  if (p.endsWith("/cast/metrics")) return jsonRes(200, { metrics: [{ start: "2026-08-15T15:00:00.000Z", resolution_in_seconds: 3600, cast_count: 1 }, { start: "2026-08-15T16:00:00.000Z", resolution_in_seconds: 3600, cast_count: 7 }] }, RL);
  return jsonRes(404, { message: "route" }, RL);
};

calls = [];
let out = await h("fc-cast-search")({ q: "x402", mode: "hybrid", sort: "chron", authorFid: 3, channel: "/Base", limit: 10, cursor: "c1" });
ok(calls[0].init.headers["x-api-key"] === "test-key-123456789", "x-api-key header sent");
ok(typeof calls[0].init.signal === "object" && calls[0].init.signal !== null, "AbortSignal attached");
ok(lastUrl().origin + lastUrl().pathname === `${NEYNAR_API}/cast/search`, "fc-cast-search: path");
ok(lastUrl().searchParams.get("q") === "x402" && lastUrl().searchParams.get("mode") === "hybrid" && lastUrl().searchParams.get("sort_type") === "chron" && lastUrl().searchParams.get("author_fid") === "3" && lastUrl().searchParams.get("channel_id") === "base" && lastUrl().searchParams.get("limit") === "10" && lastUrl().searchParams.get("cursor") === "c1", "fc-cast-search: params");
ok(out.source === "neynar" && typeof out.fetchedAt === "string" && out.cached === false && out.rateLimit.limit === 300 && out.rateLimit.remaining === 299 && typeof out.rateLimit.resetAt === "string", "fc-cast-search: envelope (source, fetchedAt, cached, rateLimit)");
ok(out.count === 1 && out.casts[0].hash === CAST.hash && out.nextCursor === "abc%3D" && out.mode === "hybrid", "fc-cast-search: body");
out = await h("fc-cast-search")({ q: "x402" });
ok(lastUrl().searchParams.get("mode") === "literal" && lastUrl().searchParams.get("sort_type") === "desc_chron" && lastUrl().searchParams.get("limit") === "25" && !lastUrl().searchParams.has("author_fid") && !lastUrl().searchParams.has("cursor"), "fc-cast-search: defaults, empty params omitted");

out = await h("fc-channel-feed")({ channels: ["Base", "farcaster"], withReplies: true, limit: 5 });
ok(lastUrl().pathname.endsWith("/feed/channels") && lastUrl().searchParams.get("channel_ids") === "base,farcaster" && lastUrl().searchParams.get("with_replies") === "true" && lastUrl().searchParams.get("with_recasts") === "true" && lastUrl().searchParams.get("limit") === "5", "fc-channel-feed: params");
ok(out.count === 2 && JSON.stringify(out.channels) === JSON.stringify(["base", "farcaster"]) && out.nextCursor === null, "fc-channel-feed: body");
out = await h("fc-channel-feed")({ channel: "base" });
ok(lastUrl().searchParams.get("with_replies") === "false" && lastUrl().searchParams.get("limit") === "25", "fc-channel-feed: defaults (replies off)");

out = await h("fc-trending")({ timeWindow: "7d", limit: 5 });
ok(lastUrl().pathname.endsWith("/channel/trending/") && lastUrl().searchParams.get("time_window") === "7d" && lastUrl().searchParams.get("limit") === "5", "fc-trending: params");
ok(out.count === 1 && out.channels[0].id === "base" && out.channels[0].castCount["1d"] === 2 && out.channels[0].castCount["30d"] === 44 && out.channels[0].lead.fid === 12142, "fc-trending: channel + castCount mapping");
out = await h("fc-trending")({});
ok(lastUrl().searchParams.get("time_window") === "1d" && lastUrl().searchParams.get("limit") === "10", "fc-trending: defaults");

calls = [];
out = await h("fc-user-casts")({ fid: 3, includeReplies: true, channel: "base", limit: 7 });
ok(calls.length === 1 && lastUrl().pathname.endsWith("/feed/user/casts") && lastUrl().searchParams.get("fid") === "3" && lastUrl().searchParams.get("include_replies") === "true" && lastUrl().searchParams.get("channel_id") === "base" && lastUrl().searchParams.get("limit") === "7", "fc-user-casts: fid path, one call, params");
ok(out.fid === 3 && out.count === 1 && out.nextCursor === "zzz", "fc-user-casts: body");
calls = [];
out = await h("fc-user-casts")({ username: "@DWR" });
ok(calls.length === 2 && new URL(calls[0].url).pathname.endsWith("/user/by_username") && new URL(calls[0].url).searchParams.get("username") === "dwr" && lastUrl().searchParams.get("fid") === "3", "fc-user-casts: username resolves via by_username then fetches by fid");
ok(lastUrl().searchParams.get("include_replies") === "false", "fc-user-casts: includeReplies defaults false");

out = await h("fc-cast")({ identifier: "https://warpcast.com/dwr/0x322c451e" });
ok(lastUrl().pathname.endsWith("/cast") && lastUrl().searchParams.get("type") === "url" && lastUrl().searchParams.get("identifier") === "https://warpcast.com/dwr/0x322c451e", "fc-cast: url identifier");
ok(out.cast.hash === CAST.hash && out.cast.author.username === "dwr" && out.cast.embeds.length === 2, "fc-cast: body");
out = await h("fc-cast")({ hash: CAST.hash.toUpperCase().replace("0X", "0x") });
ok(lastUrl().searchParams.get("type") === "hash" && lastUrl().searchParams.get("identifier") === CAST.hash, "fc-cast: hash alias + lowercased");

out = await h("fc-cast-replies")({ identifier: CAST.hash, depth: 2, limit: 5, sort: "desc_chron" });
ok(lastUrl().pathname.endsWith("/cast/conversation") && lastUrl().searchParams.get("reply_depth") === "2" && lastUrl().searchParams.get("limit") === "5" && lastUrl().searchParams.get("sort_type") === "desc_chron" && lastUrl().searchParams.get("type") === "hash", "fc-cast-replies: params");
ok(out.cast.hash === CAST.hash && out.count === 2 && out.replies[0].depth === 1 && out.replies[1].depth === 2 && out.replies[0].parentHash === CAST.hash && out.replies[1].parentHash === REPLY.hash, "fc-cast-replies: root + flattened replies with depth");
out = await h("fc-cast-replies")({ identifier: CAST.hash });
ok(lastUrl().searchParams.get("reply_depth") === "1" && lastUrl().searchParams.get("sort_type") === "chron" && out.count === 1, "fc-cast-replies: defaults (depth 1 trims nested)");

out = await h("fc-channel")({ id: "https://onchainsummer.xyz" });
ok(lastUrl().pathname.endsWith("/channel") && lastUrl().searchParams.get("type") === "parent_url" && lastUrl().searchParams.get("id") === "https://onchainsummer.xyz", "fc-channel: parent_url verbatim");
out = await h("fc-channel")({ id: "Base" });
ok(lastUrl().searchParams.get("type") === "id" && lastUrl().searchParams.get("id") === "base" && out.channel.id === "base" && out.channel.memberCount === 813, "fc-channel: id + body");

out = await h("fc-user-search")({ q: "dwr", limit: 3 });
ok(lastUrl().pathname.endsWith("/user/search") && lastUrl().searchParams.get("q") === "dwr" && lastUrl().searchParams.get("limit") === "3", "fc-user-search: params");
ok(out.count === 1 && out.users[0].fid === 3 && out.users[0].primaryEthAddress && !("verifications" in out.users[0]), "fc-user-search: compact users");

out = await h("fc-cast-metrics")({ q: "x402", interval: "30d", authorFid: 3, channel: "base" });
ok(lastUrl().pathname.endsWith("/cast/metrics") && lastUrl().searchParams.get("interval") === "30d" && lastUrl().searchParams.get("author_fid") === "3" && lastUrl().searchParams.get("channel_id") === "base", "fc-cast-metrics: params");
ok(out.total === 8 && out.bucketCount === 2 && out.resolutionSeconds === 3600 && out.buckets[1].count === 7, "fc-cast-metrics: total/buckets");

// ----------------------------------------------------------------------------
// Cache: feed-shaped reads are served from cache for 60 s; others never cached
// ----------------------------------------------------------------------------
clearCache();
calls = [];
const a1 = await h("fc-channel-feed")({ channel: "base", limit: 10 });
const a2 = await h("fc-channel-feed")({ channel: "base", limit: 10 });
ok(calls.length === 1 && a1.cached === false && a2.cached === true && a2.fetchedAt === a1.fetchedAt, "fc-channel-feed: identical repeat served from cache (one fetch)");
await h("fc-channel-feed")({ channel: "base", limit: 11 });
ok(calls.length === 2, "fc-channel-feed: different params miss the cache");
calls = [];
await h("fc-trending")({}); const t2 = await h("fc-trending")({});
ok(calls.length === 1 && t2.cached === true, "fc-trending: cached");
calls = [];
await h("fc-cast-metrics")({ q: "x402" }); const m2 = await h("fc-cast-metrics")({ q: "x402" });
ok(calls.length === 1 && m2.cached === true, "fc-cast-metrics: cached");
calls = [];
await h("fc-cast-search")({ q: "x402" }); await h("fc-cast-search")({ q: "x402" });
await h("fc-cast")({ identifier: CAST.hash }); await h("fc-cast")({ identifier: CAST.hash });
ok(calls.length === 4, "search + cast lookups are never cached");
// Errors are never cached (a 5xx followed by a 200 fetches twice).
clearCache(); calls = [];
const good = responder;
responder = () => jsonRes(500, {}, RL);
await throws(h("fc-trending")({}), 502, "fc-trending: 5xx before cache test");
responder = good;
await h("fc-trending")({});
ok(calls.length === 2, "errors are not cached");
// TTL: an entry older than 60 s is refetched.
clearCache(); calls = [];
const realNow = Date.now;
await h("fc-trending")({});
Date.now = () => realNow() + __test.CACHE_TTL_MS + 1;
await h("fc-trending")({});
Date.now = realNow;
ok(calls.length === 2, "cache entry expires after 60 s");
ok(cacheSize() >= 1, "cacheSize exposed");

// ----------------------------------------------------------------------------
// Discovery examples answer against the fixture wire (shape sanity)
// ----------------------------------------------------------------------------
clearCache();
for (const t of FARCASTER_SOCIAL_TOOLS) {
  const res = await t.handler(structuredClone(t.discovery.input));
  const ex = t.discovery.output.example;
  const missing = Object.keys(ex).filter((k) => !(k in res));
  ok(missing.length === 0, `${t.slug}: response carries every example key${missing.length ? ` (missing ${missing.join(",")})` : ""}`);
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
