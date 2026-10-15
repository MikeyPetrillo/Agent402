// Farcaster social kit - read-only Farcaster content via the Neynar API:
// cast search, channel feeds, trending channels, a user's casts, a single
// cast, a cast's replies, channel details, user search, and cast-volume
// metrics for a query.
//
// Why this kit: social data (search, timelines, mention volume) is among the
// most-bought agent inputs, and Farcaster is the one social graph with an
// open, keyed, cloud-friendly API. The onchain-identity kit already answers
// "who is this fid/address?" (farcaster-profile, farcaster-by-address); this
// kit answers "what is being said, by whom, where, how much?" and never
// duplicates those two slugs.
//
// Env-gated: NEYNAR_API_KEY (legacy alias WARPCAST_API_KEY, same as the
// identity kit). A handler called without a key throws a self-explaining 503
// BEFORE any fetch. Every tool reaches the network and is WALLET-ONLY (the
// key is a metered upstream quota; never PoW-eligible).
//
// Upstream status mapping (never relays upstream error bodies):
//   401/402/403 -> 503 "not configured" (key rejected / plan does not cover it)
//   429         -> 503 with a retry hint from x-ratelimit-reset
//   404         -> 404 (unknown cast / channel)
//   other 4xx   -> 400 (the request itself was invalid) - parameter NAME only
//   5xx         -> 502; deadline or unreachable -> 503 naming the step
//
// Plan awareness: Neynar's per-minute allowance rides back in
// x-ratelimit-limit / -remaining / -reset; every response carries it as
// `rateLimit` so an agent can pace itself. Feed-shaped reads (channel feed,
// trending, cast metrics) are cached in-process for 60 s and cast search for
// 15 s, keyed by the exact upstream URL; concurrent identical reads of any
// endpoint share one request - a burst of identical reads costs one call.
//
// Output is compact by design: a cast is {hash, author{fid, username,
// displayName, followerCount}, text, timestamp, channel, parentHash,
// reactions{likes, recasts}, replies, embeds (urls only), url}.
//
// Covered by scripts/test-farcaster-social-kit.js (offline, stubbed fetch).
// Live calls need a real key and are not exercised in CI.

import { markUntrusted } from "./provenance.js";
import { createTtlCache } from "./ttl-dedupe.js";
const NEYNAR_API = "https://api.neynar.com/v2/farcaster";
import { upstreamFetch, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";
// DEADLINES (src/upstream-deadline.js): one read per handler under its own
// cap and the handler budget; a read that outlives it is a 503 naming the
// upstream and the step, never a 504.
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
// Cast search is metered at about 120 calls a minute on the plan this kit
// runs on, and agents repeat a search while they page through a task. 15 s:
// an identical search (same query, filters and cursor) inside that window
// costs one call, while a newest-first search is never more than 15 s behind
// the network. A different cursor is a different URL, so paging is unaffected.
const CAST_SEARCH_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 256;
const USER_AGENT = "Agent402/1.0 (+https://agent402.tools)";

const HASH_RE = /^0x[0-9a-fA-F]{40}$/;
// fnames are 1-16 lowercase letters/digits/hyphens (no leading hyphen);
// ENS names (dwr.eth, base.base.eth) are also valid Farcaster usernames.
const USERNAME_RE = /^(?:[a-z0-9][a-z0-9-]{0,15}|[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62})?\.eth)$/;
const CHANNEL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const CURSOR_RE = /^[A-Za-z0-9_=%+/.-]{1,512}$/;
const CAST_URL_HOSTS = new Set(["warpcast.com", "www.warpcast.com", "farcaster.xyz", "www.farcaster.xyz"]);

const SEARCH_MODES = new Set(["literal", "semantic", "hybrid"]);
const SEARCH_SORTS = new Set(["desc_chron", "chron"]);
const REPLY_SORTS = new Set(["chron", "desc_chron", "algorithmic"]);
const TRENDING_WINDOWS = new Set(["1d", "7d", "30d"]);
const METRIC_INTERVALS = new Set(["1d", "7d", "30d", "90d", "180d"]);

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const apiKey = () => (process.env.NEYNAR_API_KEY || process.env.WARPCAST_API_KEY || "").trim();

export function farcasterSocialEnabled() {
  return apiKey().length > 0;
}

function requireKey() {
  const k = apiKey();
  if (!k) throw bad("Farcaster social tools are not configured on this deployment (NEYNAR_API_KEY unset)", 503);
  return k;
}

const nowIso = () => new Date().toISOString();

// --- input helpers ---------------------------------------------------------
function takeText(raw, field, { min = 1, max = 256 } = {}) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length < min || s.length > max) throw bad(`"${field}" must be a string of ${min}-${max} characters`);
  return s;
}

function takeLimit(raw, { min = 1, max, dflt }) {
  if (raw === undefined || raw === null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`"limit" must be an integer between ${min} and ${max}`);
  return n;
}

function takeCursor(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !CURSOR_RE.test(raw)) {
    throw bad('"cursor" must be the opaque pagination cursor returned by a previous call');
  }
  return raw;
}

function takeBool(raw, field, dflt) {
  if (raw === undefined || raw === null || raw === "") return dflt;
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === "false") return raw === "true";
  throw bad(`"${field}" must be a boolean`);
}

function takeEnum(raw, field, allowed, dflt) {
  if (raw === undefined || raw === null || raw === "") return dflt;
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!allowed.has(s)) throw bad(`"${field}" must be one of: ${[...allowed].join(", ")}`);
  return s;
}

function takeFid(raw, field = "fid") {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 2_147_483_647) throw bad(`"${field}" must be a positive integer Farcaster ID`);
  return n;
}

function takeOptionalFid(raw, field) {
  if (raw === undefined || raw === null || raw === "") return null;
  return takeFid(raw, field);
}

function takeUsername(raw, field = "username") {
  const u = typeof raw === "string" ? raw.trim().replace(/^@/, "").toLowerCase() : "";
  if (!USERNAME_RE.test(u)) throw bad(`"${field}" must be a Farcaster username (letters, digits, hyphens or dots, optional leading @)`);
  return u;
}

function takeChannelId(raw, field = "channel") {
  const c = typeof raw === "string" ? raw.trim().replace(/^\//, "").toLowerCase() : "";
  if (!CHANNEL_ID_RE.test(c)) throw bad(`"${field}" must be a Farcaster channel id (e.g. "base"), optional leading /`);
  return c;
}

function takeOptionalChannelId(raw, field) {
  if (raw === undefined || raw === null || raw === "") return null;
  return takeChannelId(raw, field);
}

// A cast identifier is either a 0x-prefixed 20-byte hash or a warpcast.com /
// farcaster.xyz cast URL; Neynar resolves both (type=hash|url).
function parseIdentifier(raw, field = "identifier") {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw bad(`"${field}" is required: a cast hash (0x + 40 hex) or a warpcast.com / farcaster.xyz cast URL`);
  if (HASH_RE.test(s)) return { identifier: s.toLowerCase(), type: "hash" };
  let u;
  try { u = new URL(s); } catch { u = null; }
  if (u && u.protocol === "https:" && CAST_URL_HOSTS.has(u.hostname.toLowerCase()) && u.pathname.length > 1) {
    return { identifier: s, type: "url" };
  }
  throw bad(`"${field}" must be a cast hash (0x + 40 hex) or an https warpcast.com / farcaster.xyz cast URL`);
}

// A channel reference is a channel id ("base") or its FIP-2 parent URL.
function parseChannelRef(raw, field = "id") {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw bad(`"${field}" is required: a channel id (e.g. "base") or its parent URL`);
  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { u = null; }
    if (!u || u.protocol !== "https:") throw bad(`"${field}" parent URL must be an https URL`);
    // Keep the buyer's exact string: FIP-2 parent URLs match byte-for-byte
    // upstream (URL normalization would add a trailing slash and miss).
    return { id: s, type: "parent_url" };
  }
  return { id: takeChannelId(s, field), type: "id" };
}

// --- cache -----------------------------------------------------------------
// One TTL store with in-flight dedupe (src/tools/ttl-dedupe.js), keyed by the
// exact upstream URL. Every read dedupes: concurrent identical calls share one
// upstream request. Only reads that opt in are stored (feeds 60 s, cast
// search CAST_SEARCH_TTL_MS).
const cache = createTtlCache({ maxEntries: CACHE_MAX_ENTRIES });

// --- upstream --------------------------------------------------------------
function readRateLimit(headers) {
  const num = (n) => { const v = headers?.get?.(n); return v === null || v === undefined || v === "" ? NaN : Number(v); };
  const limit = num("x-ratelimit-limit");
  const remaining = num("x-ratelimit-remaining");
  const reset = num("x-ratelimit-reset");
  if (!Number.isFinite(limit) && !Number.isFinite(remaining)) return null;
  return {
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
  };
}

// GET a Neynar endpoint. Returns { data, rateLimit, fetchedAt, cached }.
// `notFound` is the buyer-facing message for an upstream 404; `cacheable`
// opts the exact URL into the 60 s in-process cache.
async function neynarGet(path, params = {}, { notFound = "Not found on Farcaster", cacheable = false } = {}) {
  const key = requireKey();
  const url = new URL(NEYNAR_API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const href = url.toString();
  // `cacheable`: true for the 60 s feed window, a number for its own TTL.
  const ttlMs = cacheable === true ? CACHE_TTL_MS : Number.isFinite(cacheable) && cacheable > 0 ? cacheable : 0;
  const { value, cached } = await cache.get(href, ttlMs, () => neynarFetch(href, path, key, notFound));
  return cached ? { ...value, cached: true } : value;
}

async function neynarFetch(href, path, key, notFound) {
  const res = await upstreamFetch(href, {
    headers: { "x-api-key": key, accept: "application/json", "user-agent": USER_AGENT },
  }, { label: "Farcaster upstream", step: String(path).replace(/^\//, "").split("/").filter((seg) => /^[a-z_-]+$/.test(seg)).join(" ").replace(/[_-]/g, " ") || "lookup", timeoutMs: TIMEOUT_MS, tag: "[farcaster-social]" });

  const rateLimit = readRateLimit(res.headers);

  if (res.status === 401 || res.status === 402 || res.status === 403) {
    // The key was refused or the plan does not cover this endpoint. Either
    // way it is our configuration, not the buyer's request.
    throw bad("Farcaster social tools are not configured on this deployment (API key rejected upstream)", 503);
  }
  if (res.status === 429) {
    const reset = Number(res.headers?.get?.("x-ratelimit-reset"));
    const inSec = Number.isFinite(reset) && reset > 0 ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : null;
    const retryAfter = Number(res.headers?.get?.("retry-after"));
    const wait = inSec ?? (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
    const hint = wait ? ` - the window resets in about ${wait}s` : " - retry shortly";
    throw bad(`Farcaster upstream rate cap reached${hint}`, 503);
  }
  if (res.status === 404) throw bad(notFound, 404);
  if (res.status >= 500) throw bad(`Farcaster upstream error (HTTP ${res.status})`, 502);
  if (!res.ok) {
    // Surface only the offending parameter NAME (a bare identifier), never
    // the upstream message body.
    let prop = null;
    try {
      const j = await res.json();
      if (typeof j?.property === "string" && /^[a-z_]{1,32}$/.test(j.property)) prop = j.property;
    } catch { /* body is not our concern */ }
    throw bad(`Farcaster upstream rejected the request (HTTP ${res.status})${prop ? ` - check "${prop}"` : " - check the parameters"}`, 400);
  }

  let data;
  try { data = await res.json(); } catch { throw bad("Farcaster upstream returned non-JSON", 502); }
  if (!data || typeof data !== "object") throw bad("Farcaster upstream returned an unexpected payload", 502);

  return { data, rateLimit, fetchedAt: nowIso(), cached: false };
}

// --- mappers (compact output) ----------------------------------------------
function mapAuthor(u) {
  if (!u || typeof u !== "object") return null;
  return {
    fid: u.fid ?? null,
    username: u.username ?? null,
    displayName: u.display_name ?? null,
    followerCount: Number.isFinite(u.follower_count) ? u.follower_count : null,
  };
}

function castUrl(c) {
  const user = c?.author?.username;
  const hash = typeof c?.hash === "string" ? c.hash : "";
  if (!user || !hash) return null;
  return `https://warpcast.com/${user}/${hash.slice(0, 10)}`;
}

function mapCast(c) {
  if (!c || typeof c !== "object") return null;
  const embeds = Array.isArray(c.embeds)
    ? c.embeds.map((e) => (typeof e?.url === "string" ? e.url : null)).filter(Boolean)
    : [];
  return {
    hash: c.hash ?? null,
    author: mapAuthor(c.author),
    text: typeof c.text === "string" ? c.text : "",
    timestamp: c.timestamp ?? null,
    channel: c.channel?.id ?? null,
    parentHash: c.parent_hash ?? null,
    reactions: {
      likes: Number.isFinite(c.reactions?.likes_count) ? c.reactions.likes_count : 0,
      recasts: Number.isFinite(c.reactions?.recasts_count) ? c.reactions.recasts_count : 0,
    },
    replies: Number.isFinite(c.replies?.count) ? c.replies.count : 0,
    embeds,
    url: castUrl(c),
  };
}

function mapChannel(ch) {
  if (!ch || typeof ch !== "object") return null;
  return {
    id: ch.id ?? null,
    name: ch.name ?? null,
    description: ch.description ?? null,
    parentUrl: ch.parent_url ?? ch.url ?? null,
    imageUrl: ch.image_url ?? null,
    followerCount: Number.isFinite(ch.follower_count) ? ch.follower_count : null,
    memberCount: Number.isFinite(ch.member_count) ? ch.member_count : null,
    publicCasting: typeof ch.public_casting === "boolean" ? ch.public_casting : null,
    createdAt: ch.created_at ?? null,
    lead: mapAuthor(ch.lead),
    moderatorFids: Array.isArray(ch.moderator_fids) ? ch.moderator_fids : [],
    pinnedCastHash: ch.pinned_cast_hash ?? null,
    url: ch.id ? `https://warpcast.com/~/channel/${ch.id}` : null,
  };
}

function mapUser(u) {
  if (!u || typeof u !== "object") return null;
  return {
    fid: u.fid ?? null,
    username: u.username ?? null,
    displayName: u.display_name ?? null,
    bio: u.profile?.bio?.text ?? null,
    pfpUrl: u.pfp_url ?? null,
    followerCount: Number.isFinite(u.follower_count) ? u.follower_count : null,
    followingCount: Number.isFinite(u.following_count) ? u.following_count : null,
    powerBadge: !!u.power_badge,
    score: Number.isFinite(u.score) ? u.score : null,
    primaryEthAddress: u.verified_addresses?.primary?.eth_address ?? null,
    url: u.username ? `https://warpcast.com/${u.username}` : null,
  };
}

const nextCursor = (data) => (typeof data?.next?.cursor === "string" && data.next.cursor ? data.next.cursor : null);

function envelope(r, extra) {
  return { source: "neynar", fetchedAt: r.fetchedAt, cached: r.cached, rateLimit: r.rateLimit, ...extra };
}

// Resolve a username to a fid with one upstream call (fid input skips it).
async function resolveFid({ fid, username } = {}) {
  if (fid !== undefined && fid !== null && fid !== "") return takeFid(fid);
  if (username !== undefined && username !== null && username !== "") {
    const u = takeUsername(username);
    const r = await neynarGet("/user/by_username", { username: u }, { notFound: `Farcaster user "${u}" not found` });
    const f = r.data?.user?.fid;
    if (!Number.isInteger(f)) throw bad(`Farcaster user "${u}" not found`, 404);
    return f;
  }
  throw bad('"fid" (integer) or "username" (string) is required');
}

// --- handlers --------------------------------------------------------------
async function fcCastSearch(input = {}) {
  const q = takeText(input.q ?? input.query, "q", { max: 256 });
  const mode = takeEnum(input.mode, "mode", SEARCH_MODES, "literal");
  const sort = takeEnum(input.sort, "sort", SEARCH_SORTS, "desc_chron");
  const authorFid = takeOptionalFid(input.authorFid, "authorFid");
  const channel = takeOptionalChannelId(input.channel, "channel");
  const limit = takeLimit(input.limit, { max: 100, dflt: 25 });
  const cursor = takeCursor(input.cursor);
  const r = await neynarGet("/cast/search", {
    q, mode, sort_type: sort, author_fid: authorFid, channel_id: channel, limit, cursor,
  }, { cacheable: CAST_SEARCH_TTL_MS });
  const casts = Array.isArray(r.data?.result?.casts) ? r.data.result.casts.map(mapCast) : [];
  return envelope(r, {
    query: q, mode, sort, authorFid, channel,
    count: casts.length, casts, nextCursor: nextCursor(r.data?.result),
  });
}

async function fcChannelFeed(input = {}) {
  let ids;
  if (Array.isArray(input.channels)) {
    if (!input.channels.length || input.channels.length > 10) throw bad('"channels" must be an array of 1-10 channel ids');
    ids = input.channels.map((c) => takeChannelId(c, "channels[]"));
  } else {
    ids = [takeChannelId(input.channel ?? input.channels, "channel")];
  }
  const withReplies = takeBool(input.withReplies, "withReplies", false);
  const withRecasts = takeBool(input.withRecasts, "withRecasts", true);
  const limit = takeLimit(input.limit, { max: 100, dflt: 25 });
  const cursor = takeCursor(input.cursor);
  const r = await neynarGet("/feed/channels", {
    channel_ids: ids.join(","), with_replies: withReplies, with_recasts: withRecasts, limit, cursor,
  }, { cacheable: true });
  const casts = Array.isArray(r.data?.casts) ? r.data.casts.map(mapCast) : [];
  return envelope(r, { channels: ids, withReplies, withRecasts, count: casts.length, casts, nextCursor: nextCursor(r.data) });
}

function mapTrendingChannel(row) {
  const ch = mapChannel(row?.channel);
  if (!ch) return null;
  const n = (v) => (v === undefined || v === null ? null : Number(v));
  return { ...ch, castCount: { "1d": n(row.cast_count_1d), "7d": n(row.cast_count_7d), "30d": n(row.cast_count_30d) } };
}

async function fcTrending(input = {}) {
  const timeWindow = takeEnum(input.timeWindow, "timeWindow", TRENDING_WINDOWS, "1d");
  const limit = takeLimit(input.limit, { max: 25, dflt: 10 });
  const cursor = takeCursor(input.cursor);
  const r = await neynarGet("/channel/trending/", { time_window: timeWindow, limit, cursor }, { cacheable: true });
  const channels = Array.isArray(r.data?.channels) ? r.data.channels.map(mapTrendingChannel).filter(Boolean) : [];
  return envelope(r, { timeWindow, count: channels.length, channels, nextCursor: nextCursor(r.data) });
}

async function fcUserCasts(input = {}) {
  const fid = await resolveFid(input);
  const includeReplies = takeBool(input.includeReplies, "includeReplies", false);
  const channel = takeOptionalChannelId(input.channel, "channel");
  const limit = takeLimit(input.limit, { max: 100, dflt: 25 });
  const cursor = takeCursor(input.cursor);
  const r = await neynarGet("/feed/user/casts", {
    fid, include_replies: includeReplies, channel_id: channel, limit, cursor,
  }, { notFound: `Farcaster user fid=${fid} not found` });
  const casts = Array.isArray(r.data?.casts) ? r.data.casts.map(mapCast) : [];
  return envelope(r, { fid, includeReplies, channel, count: casts.length, casts, nextCursor: nextCursor(r.data) });
}

async function fcCast(input = {}) {
  const { identifier, type } = parseIdentifier(input.identifier ?? input.hash ?? input.url);
  const r = await neynarGet("/cast", { identifier, type }, { notFound: "Cast not found on Farcaster" });
  const cast = mapCast(r.data?.cast);
  if (!cast || !cast.hash) throw bad("Cast not found on Farcaster", 404);
  return envelope(r, { cast });
}

// Flatten Neynar's nested direct_replies tree into one list carrying depth.
function flattenReplies(cast, depth, maxDepth, out) {
  const kids = Array.isArray(cast?.direct_replies) ? cast.direct_replies : [];
  for (const k of kids) {
    const m = mapCast(k);
    if (!m) continue;
    out.push({ depth, ...m });
    if (depth < maxDepth) flattenReplies(k, depth + 1, maxDepth, out);
  }
  return out;
}

async function fcCastReplies(input = {}) {
  const { identifier, type } = parseIdentifier(input.identifier ?? input.hash ?? input.url);
  const depth = takeLimit(input.depth, { max: 5, dflt: 1 });
  const limit = takeLimit(input.limit, { max: 50, dflt: 20 });
  const sort = takeEnum(input.sort, "sort", REPLY_SORTS, "chron");
  const cursor = takeCursor(input.cursor);
  const r = await neynarGet("/cast/conversation", {
    identifier, type, reply_depth: depth, limit, sort_type: sort, cursor,
  }, { notFound: "Cast not found on Farcaster" });
  const root = r.data?.conversation?.cast;
  const cast = mapCast(root);
  if (!cast || !cast.hash) throw bad("Cast not found on Farcaster", 404);
  const replies = flattenReplies(root, 1, depth, []);
  return envelope(r, { cast, depth, sort, count: replies.length, replies, nextCursor: nextCursor(r.data) });
}

async function fcChannel(input = {}) {
  const { id, type } = parseChannelRef(input.id ?? input.channel ?? input.parentUrl);
  const r = await neynarGet("/channel", { id, type }, { notFound: `Farcaster channel "${id}" not found` });
  const channel = mapChannel(r.data?.channel);
  if (!channel || !channel.id) throw bad(`Farcaster channel "${id}" not found`, 404);
  return envelope(r, { channel });
}

async function fcUserSearch(input = {}) {
  const q = takeText(input.q ?? input.query, "q", { max: 100 });
  const limit = takeLimit(input.limit, { max: 10, dflt: 5 });
  const cursor = takeCursor(input.cursor);
  const r = await neynarGet("/user/search", { q, limit, cursor });
  const users = Array.isArray(r.data?.result?.users) ? r.data.result.users.map(mapUser) : [];
  return envelope(r, { query: q, count: users.length, users, nextCursor: nextCursor(r.data?.result) });
}

async function fcCastMetrics(input = {}) {
  const q = takeText(input.q ?? input.query, "q", { max: 256 });
  const interval = takeEnum(input.interval, "interval", METRIC_INTERVALS, "7d");
  const authorFid = takeOptionalFid(input.authorFid, "authorFid");
  const channel = takeOptionalChannelId(input.channel, "channel");
  const r = await neynarGet("/cast/metrics", {
    q, interval, author_fid: authorFid, channel_id: channel,
  }, { cacheable: true });
  const rows = Array.isArray(r.data?.metrics) ? r.data.metrics : [];
  const buckets = rows.map((m) => ({
    start: m?.start ?? null,
    count: Number.isFinite(m?.cast_count) ? m.cast_count : 0,
  }));
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const resolutionSeconds = Number.isFinite(rows[0]?.resolution_in_seconds) ? rows[0].resolution_in_seconds : null;
  return envelope(r, { query: q, interval, authorFid, channel, resolutionSeconds, total, bucketCount: buckets.length, buckets });
}

// --- catalog ---------------------------------------------------------------
const CAST_EXAMPLE = {
  hash: "0xab5aca846db8af6fa3dc2d25dc66171cd040def4",
  author: { fid: 3117427, username: "askew-ai", displayName: "askew-ai", followerCount: 12 },
  text: "Paid an x402 endpoint for the first time today.",
  timestamp: "2026-08-22T12:49:27.000Z",
  channel: "ai-agents",
  parentHash: null,
  reactions: { likes: 4, recasts: 1 },
  replies: 2,
  embeds: ["https://example.com/post"],
  url: "https://warpcast.com/askew-ai/0xab5aca84",
};

const CHANNEL_EXAMPLE = {
  id: "base",
  name: "Base",
  description: "Bringing the world onchain - a community of builders on Base",
  parentUrl: "https://onchainsummer.xyz",
  imageUrl: "https://warpcast.com/~/channel-images/base.png",
  followerCount: 481202,
  memberCount: 813,
  publicCasting: false,
  createdAt: "2023-08-17T19:23:11.150Z",
  lead: { fid: 12142, username: "base.base.eth", displayName: "Base", followerCount: 194536 },
  moderatorFids: [12142, 15211, 99],
  pinnedCastHash: null,
  url: "https://warpcast.com/~/channel/base",
};

const USER_EXAMPLE = {
  fid: 3,
  username: "example-user",
  displayName: "Example User",
  bio: "Example profile used only to show the response shape.",
  pfpUrl: "https://imagedelivery.net/.../original",
  followerCount: 630338,
  followingCount: 77,
  powerBadge: false,
  score: 0.99,
  primaryEthAddress: "0x6ce09ed5526de4afe4a981ad86d17b2f5c92fea5",
  url: "https://warpcast.com/dwr",
};

const RATE_LIMIT_EXAMPLE = { limit: 300, remaining: 299, resetAt: "2026-08-22T13:20:00.000Z" };
const ENVELOPE_EXAMPLE = { source: "neynar", fetchedAt: "2026-08-22T13:19:12.000Z", cached: false, rateLimit: RATE_LIMIT_EXAMPLE };

const CURSOR_PROP = { type: "string", description: "Opaque pagination cursor from a previous call's nextCursor." };

export const FARCASTER_SOCIAL_TOOLS = [
  {
    route: "POST /api/fc-cast-search",
    name: "Farcaster cast search",
    slug: "fc-cast-search",
    category: "web",
    price: "$0.005",
    description:
      "Search Farcaster casts by keyword (literal, semantic or hybrid match), newest first, optionally filtered to one author or channel. Returns compact casts: hash, author (fid, username, follower count), text, timestamp, channel, reactions, reply count, embed URLs. Use for mention monitoring, sentiment sampling, or finding discussion of a token, product or topic.",
    tags: ["farcaster", "social", "search", "casts", "mentions", "sentiment"],
    discovery: {
      bodyType: "json",
      input: { q: "x402", limit: 10 },
      inputSchema: {
        type: "object",
        required: ["q"],
        properties: {
          q: { type: "string", description: "Search text (1-256 chars)." },
          mode: { type: "string", enum: ["literal", "semantic", "hybrid"], description: "Match mode (default literal)." },
          sort: { type: "string", enum: ["desc_chron", "chron"], description: "Newest first (default) or oldest first." },
          authorFid: { type: "integer", description: "Only casts by this fid." },
          channel: { type: "string", description: "Only casts in this channel id (e.g. base)." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default 25)." },
          cursor: CURSOR_PROP,
        },
      },
      output: {
        example: {
          ...ENVELOPE_EXAMPLE,
          query: "x402", mode: "literal", sort: "desc_chron", authorFid: null, channel: null,
          count: 1, casts: [CAST_EXAMPLE], nextCursor: "eyJ0aW1lc3RhbXAiOi...",
        },
      },
    },
    handler: fcCastSearch,
  },
  {
    route: "POST /api/fc-channel-feed",
    name: "Farcaster channel feed",
    slug: "fc-channel-feed",
    category: "web",
    price: "$0.004",
    description:
      "Latest casts in one or more Farcaster channels (e.g. base, farcaster, ethereum), newest first, with optional replies. Compact cast shape with author, reactions, reply count and embed URLs. Cached 60 s per identical request. Use to watch a community, sample what builders are posting, or feed a digest.",
    tags: ["farcaster", "social", "channel", "feed", "timeline"],
    discovery: {
      bodyType: "json",
      input: { channel: "base", limit: 10 },
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel id (e.g. base). One of channel/channels required." },
          channels: { type: "array", items: { type: "string" }, maxItems: 10, description: "Up to 10 channel ids merged into one feed." },
          withReplies: { type: "boolean", description: "Include replies (default false)." },
          withRecasts: { type: "boolean", description: "Include recasts (default true)." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default 25)." },
          cursor: CURSOR_PROP,
        },
      },
      output: {
        example: {
          ...ENVELOPE_EXAMPLE,
          channels: ["base"], withReplies: false, withRecasts: true,
          count: 1, casts: [{ ...CAST_EXAMPLE, channel: "base" }], nextCursor: "eyJ0aW1lc3RhbXAiOi...",
        },
      },
    },
    handler: fcChannelFeed,
  },
  {
    route: "POST /api/fc-trending",
    name: "Farcaster trending channels",
    slug: "fc-trending",
    category: "web",
    price: "$0.004",
    description:
      "Trending Farcaster channels ranked by casting activity over 1d, 7d or 30d, with cast counts for all three windows, follower and member counts, and the channel lead. Cached 60 s. Use to spot where attention is moving on Farcaster right now, then pull the feed with fc-channel-feed.",
    tags: ["farcaster", "social", "trending", "channels", "discovery"],
    discovery: {
      bodyType: "json",
      input: { timeWindow: "1d", limit: 10 },
      inputSchema: {
        type: "object",
        properties: {
          timeWindow: { type: "string", enum: ["1d", "7d", "30d"], description: "Ranking window (default 1d)." },
          limit: { type: "integer", minimum: 1, maximum: 25, description: "Results per page (default 10)." },
          cursor: CURSOR_PROP,
        },
      },
      output: {
        example: {
          ...ENVELOPE_EXAMPLE,
          timeWindow: "1d", count: 1,
          channels: [{ ...CHANNEL_EXAMPLE, castCount: { "1d": 120, "7d": 800, "30d": 3100 } }],
          nextCursor: "eyJ0aW1lc3RhbXAiOi...",
        },
      },
    },
    handler: fcTrending,
  },
  {
    route: "POST /api/fc-user-casts",
    name: "Farcaster user casts",
    slug: "fc-user-casts",
    category: "web",
    price: "$0.004",
    description:
      "A Farcaster user's recent casts by fid or username, newest first, optionally including replies or limited to one channel. Compact cast shape with reactions, reply count and embed URLs. Use to read what a founder, builder or KOL has been posting, or to build a per-account timeline.",
    tags: ["farcaster", "social", "user", "timeline", "casts", "kol"],
    discovery: {
      bodyType: "json",
      // FID, not username: fids are permanent, usernames rename out from under an example.
      input: { fid: 3, limit: 10 },
      inputSchema: {
        type: "object",
        properties: {
          fid: { type: "integer", description: "Farcaster ID (one of fid/username required)." },
          username: { type: "string", description: "Farcaster username, optional leading @ (one of fid/username required; costs one extra upstream lookup)." },
          includeReplies: { type: "boolean", description: "Include the user's replies (default false)." },
          channel: { type: "string", description: "Only casts in this channel id." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default 25)." },
          cursor: CURSOR_PROP,
        },
      },
      output: {
        example: {
          ...ENVELOPE_EXAMPLE,
          fid: 3, includeReplies: false, channel: null, count: 1,
          casts: [{ ...CAST_EXAMPLE, author: { fid: 3, username: "dwr", displayName: "Dan Romero", followerCount: 630338 }, channel: null }],
          nextCursor: "eyJ0aW1lc3RhbXAiOi...",
        },
      },
    },
    handler: fcUserCasts,
  },
  {
    route: "POST /api/fc-cast",
    name: "Farcaster cast lookup",
    slug: "fc-cast",
    category: "web",
    price: "$0.003",
    description:
      "Fetch one Farcaster cast by hash or warpcast.com / farcaster.xyz URL. Returns the compact cast: author (fid, username, follower count), text, timestamp, channel, parent hash, likes, recasts, reply count, embed URLs. Use to resolve a shared link, verify a quote, or enrich a cast hash from another tool.",
    tags: ["farcaster", "social", "cast", "lookup", "url"],
    discovery: {
      bodyType: "json",
      input: { identifier: "0x322c451ed6ff1674328c6164b92166b3d15f2b7d" },
      inputSchema: {
        type: "object",
        required: ["identifier"],
        properties: {
          identifier: { type: "string", description: "Cast hash (0x + 40 hex) or an https warpcast.com / farcaster.xyz cast URL." },
        },
      },
      output: {
        example: {
          ...ENVELOPE_EXAMPLE,
          cast: {
            hash: "0x322c451ed6ff1674328c6164b92166b3d15f2b7d",
            author: { fid: 3, username: "dwr", displayName: "Dan Romero", followerCount: 630338 },
            text: "quick let's all open up fc app to cast about fc dead",
            timestamp: "2026-08-20T00:58:40.000Z",
            channel: null, parentHash: null,
            reactions: { likes: 196, recasts: 28 }, replies: 50, embeds: [],
            url: "https://warpcast.com/dwr/0x322c451e",
          },
        },
      },
    },
    handler: fcCast,
  },
  {
    route: "POST /api/fc-cast-replies",
    name: "Farcaster cast replies",
    slug: "fc-cast-replies",
    category: "web",
    price: "$0.005",
    description:
      "The reply thread under a Farcaster cast (by hash or URL): the root cast plus replies flattened with their depth (1-5 levels) and parent hash, in chronological, newest-first or algorithmic order. Compact cast shape. Use to read reactions to an announcement, summarize a discussion, or trace who replied to whom.",
    tags: ["farcaster", "social", "replies", "thread", "conversation"],
    discovery: {
      bodyType: "json",
      input: { identifier: "0x322c451ed6ff1674328c6164b92166b3d15f2b7d", depth: 1, limit: 10 },
      inputSchema: {
        type: "object",
        required: ["identifier"],
        properties: {
          identifier: { type: "string", description: "Cast hash (0x + 40 hex) or an https warpcast.com / farcaster.xyz cast URL." },
          depth: { type: "integer", minimum: 1, maximum: 5, description: "Reply depth to include (default 1 = direct replies)." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Direct replies per page (default 20)." },
          sort: { type: "string", enum: ["chron", "desc_chron", "algorithmic"], description: "Reply order (default chron)." },
          cursor: CURSOR_PROP,
        },
      },
      output: {
        example: {
          ...ENVELOPE_EXAMPLE,
          cast: {
            hash: "0x322c451ed6ff1674328c6164b92166b3d15f2b7d",
            author: { fid: 3, username: "dwr", displayName: "Dan Romero", followerCount: 630338 },
            text: "quick let's all open up fc app to cast about fc dead",
            timestamp: "2026-08-20T00:58:40.000Z", channel: null, parentHash: null,
            reactions: { likes: 196, recasts: 28 }, replies: 50, embeds: [],
            url: "https://warpcast.com/dwr/0x322c451e",
          },
          depth: 1, sort: "chron", count: 1,
          replies: [{ depth: 1, ...CAST_EXAMPLE, parentHash: "0x322c451ed6ff1674328c6164b92166b3d15f2b7d", channel: null }],
          nextCursor: null,
        },
      },
    },
    handler: fcCastReplies,
  },
  {
    route: "POST /api/fc-channel",
    name: "Farcaster channel details",
    slug: "fc-channel",
    category: "web",
    price: "$0.003",
    description:
      "Details for one Farcaster channel by id (e.g. base) or FIP-2 parent URL: name, description, follower and member counts, public-casting flag, creation date, lead and moderator fids, pinned cast. Use to validate a channel id before pulling its feed, or to size a community.",
    tags: ["farcaster", "social", "channel", "community", "metadata"],
    discovery: {
      bodyType: "json",
      input: { id: "base" },
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "Channel id (e.g. base) or its https parent URL." },
        },
      },
      output: { example: { ...ENVELOPE_EXAMPLE, channel: CHANNEL_EXAMPLE } },
    },
    handler: fcChannel,
  },
  {
    route: "POST /api/fc-user-search",
    name: "Farcaster user search",
    slug: "fc-user-search",
    category: "web",
    price: "$0.003",
    description:
      "Search Farcaster users by name or username fragment. Returns up to 10 compact profiles: fid, username, display name, bio, follower and following counts, account quality score, primary verified Ethereum address. Use to resolve a person or brand to a fid before fc-user-casts, or to find who to follow on a topic.",
    tags: ["farcaster", "social", "user", "search", "profile"],
    discovery: {
      bodyType: "json",
      input: { q: "example", limit: 3 },
      inputSchema: {
        type: "object",
        required: ["q"],
        properties: {
          q: { type: "string", description: "Name or username fragment (1-100 chars)." },
          limit: { type: "integer", minimum: 1, maximum: 10, description: "Results per page (default 5)." },
          cursor: CURSOR_PROP,
        },
      },
      output: { example: { ...ENVELOPE_EXAMPLE, query: "example", count: 1, users: [USER_EXAMPLE], nextCursor: null } },
    },
    handler: fcUserSearch,
  },
  {
    route: "POST /api/fc-cast-metrics",
    name: "Farcaster cast volume",
    slug: "fc-cast-metrics",
    category: "web",
    price: "$0.005",
    description:
      "Cast volume over time for a search query: how many Farcaster casts matched per bucket across the last 1d, 7d, 30d, 90d or 180d (hourly or daily buckets), optionally limited to one author or channel, plus the total. Cached 60 s. Use to chart mention volume for a token, product or event and detect spikes.",
    tags: ["farcaster", "social", "metrics", "volume", "mentions", "timeseries"],
    discovery: {
      bodyType: "json",
      input: { q: "x402", interval: "7d" },
      inputSchema: {
        type: "object",
        required: ["q"],
        properties: {
          q: { type: "string", description: "Search text (1-256 chars)." },
          interval: { type: "string", enum: ["1d", "7d", "30d", "90d", "180d"], description: "Lookback window (default 7d)." },
          authorFid: { type: "integer", description: "Only casts by this fid." },
          channel: { type: "string", description: "Only casts in this channel id." },
        },
      },
      output: {
        example: {
          ...ENVELOPE_EXAMPLE,
          query: "x402", interval: "7d", authorFid: null, channel: null,
          resolutionSeconds: 3600, total: 42, bucketCount: 168,
          buckets: [{ start: "2026-08-15T15:00:00.000Z", count: 1 }, { start: "2026-08-15T16:00:00.000Z", count: 7 }],
        },
      },
    },
    handler: fcCastMetrics,
  },
];

// Test-only exports
export const __test = {
  NEYNAR_API,
  CACHE_TTL_MS,
  CAST_SEARCH_TTL_MS,
  clearCache: () => cache.clear(),
  cacheSize: () => cache.size(),
  parseIdentifier,
  parseChannelRef,
  takeUsername,
  takeChannelId,
  takeLimit,
  takeCursor,
  mapCast,
  mapChannel,
  mapUser,
  flattenReplies,
  readRateLimit,
};

// Free text in these results is written by third parties (headlines, posts,
// casts, token names and descriptions, page titles). Anyone can mint a token or
// publish a post, so this is the cheapest prompt-injection delivery vehicle in
// the catalog: flag it as data, never instructions, the way site-crawl does.
const UNTRUSTED_TEXT_SLUGS = new Set(["fc-cast-search", "fc-channel-feed", "fc-trending", "fc-user-casts", "fc-cast", "fc-cast-replies", "fc-channel", "fc-user-search"]);
for (const t of FARCASTER_SOCIAL_TOOLS) {
  if (!UNTRUSTED_TEXT_SLUGS.has(t.slug)) continue;
  const inner = t.handler;
  t.handler = async (...args) => markUntrusted(await inner(...args));
}

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(FARCASTER_SOCIAL_TOOLS, PAYMENT_WINDOW_BUDGET_MS);
