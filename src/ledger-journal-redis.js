// The shared half of the local money journals (src/ledger-mirror.js
// createDeadLetter): with REDIS_URL set, a journal entry (a sale, a refund
// debt, a card checkout's final record, a subscription record, a decide
// write, an outbound payment record) is kept in Redis instead of on the
// container's disk, so it outlives the container and any container can land it.
//
// Per journal, under one hash-tagged prefix:
//   items  HASH  id -> the entry as JSON ({ id, kind, payload, at })
//   seq    ZSET  id -> insertion sequence (the replay order)
//   lease  ZSET  id -> ms until which a holder has it (0: free to claim)
//   owner  HASH  id -> the holder that wrote, claimed or released it last
//   pend   ZSET  id -> lease of an entry whose write its writer still has queued
//   drain  STR   the one holder draining this journal (PX lease)
//   n      STR   the sequence counter
// Every step is one Lua script, so each is atomic on the server and every
// lease is read against the server's clock (TIME), never a container's.
//
// A write-ahead entry is added with a lease (its writer's queued write is
// about to land it) and renewed while that write waits; a released entry (the
// write failed) has lease 0. A replay CLAIMS: only one holder drains a journal
// at a time (the drain lease), and the claim takes every free entry in
// insertion order and leases each to the claimant. An entry is removed only
// after its database write committed. A holder that dies stops renewing: its
// drain lease and its entries' leases lapse and the next claim takes them.
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { getSharedRedisClient } from "./shared-limit.js";

/**
 * Journals in Redis only when LEDGER_JOURNAL_REDIS=on and REDIS_URL is set.
 * Opt-in: Redis holds a journal durably only with append-only persistence on,
 * so the switch is set after that is confirmed; unset keeps them on local disk.
 */
export function redisJournalConfigured(env = process.env) {
  return Boolean(String(env.REDIS_URL || "").trim()) && /^(1|on|true|yes)$/i.test(String(env.LEDGER_JOURNAL_REDIS ?? "").trim());
}
/** How long a holder keeps an entry (or the drain) without renewing it. */
export const JOURNAL_LEASE_MS = () => Math.max(200, Number(process.env.LEDGER_JOURNAL_LEASE_MS) || 60_000);
/** A Redis command that neither answers nor fails within this is a failure. */
const OP_MS = () => Math.max(50, Number(process.env.LEDGER_JOURNAL_REDIS_OP_MS) || 1_500);
/** After a failed command, adds go straight to local disk for this long (the replay keeps probing). */
const DOWN_MS = () => Math.max(0, Number(process.env.LEDGER_JOURNAL_REDIS_DOWN_MS) || 10_000);

const NOW = `local t = redis.call('TIME'); local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;
// KEYS: items, seq, lease, owner, pend, drain, n
const ADD = `${NOW}
local id, body, pending, lease, owner = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5]
redis.call('HSET', KEYS[1], id, body)
redis.call('ZADD', KEYS[2], redis.call('INCR', KEYS[7]), id)
if pending == '1' then
  redis.call('ZADD', KEYS[3], now + lease, id)
  redis.call('ZADD', KEYS[5], now + lease, id)
else
  redis.call('ZADD', KEYS[3], 0, id)
end
redis.call('HSET', KEYS[4], id, owner)
return 1`;
const CLAIM = `${NOW}
local owner, lease, limit = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])
local cur = redis.call('GET', KEYS[6])
if cur and cur ~= owner then return {} end
redis.call('SET', KEYS[6], owner, 'PX', lease)
local ids = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now)
local list = {}
for _, id in ipairs(ids) do
  table.insert(list, { tonumber(redis.call('ZSCORE', KEYS[2], id) or '0'), id })
end
table.sort(list, function(a, b) return a[1] < b[1] end)
local out = {}
local n = 0
for _, e in ipairs(list) do
  if n >= limit then break end
  local id = e[2]
  local body = redis.call('HGET', KEYS[1], id)
  if body then
    redis.call('ZADD', KEYS[3], now + lease, id)
    redis.call('HSET', KEYS[4], id, owner)
    redis.call('ZREM', KEYS[5], id)
    table.insert(out, id)
    table.insert(out, body)
    n = n + 1
  else
    redis.call('ZREM', KEYS[3], id); redis.call('ZREM', KEYS[2], id); redis.call('ZREM', KEYS[5], id); redis.call('HDEL', KEYS[4], id)
  end
end
return out`;
const RENEW = `${NOW}
local owner, lease = ARGV[1], tonumber(ARGV[2])
if redis.call('GET', KEYS[6]) == owner then redis.call('PEXPIRE', KEYS[6], lease) end
local n = 0
for i = 3, #ARGV do
  local id = ARGV[i]
  if redis.call('HGET', KEYS[4], id) == owner and redis.call('ZSCORE', KEYS[3], id) then
    redis.call('ZADD', KEYS[3], now + lease, id)
    if redis.call('ZSCORE', KEYS[5], id) then redis.call('ZADD', KEYS[5], now + lease, id) end
    n = n + 1
  end
end
return n`;
const RELEASE = `
local owner, unlock = ARGV[1], ARGV[2]
local n = 0
for i = 3, #ARGV do
  local id = ARGV[i]
  if redis.call('HGET', KEYS[4], id) == owner and redis.call('ZSCORE', KEYS[3], id) then
    redis.call('ZADD', KEYS[3], 0, id)
    redis.call('ZREM', KEYS[5], id)
    n = n + 1
  end
end
if unlock == '1' and redis.call('GET', KEYS[6]) == owner then redis.call('DEL', KEYS[6]) end
return n`;
const REMOVE = `
for i = 1, #ARGV do
  local id = ARGV[i]
  redis.call('HDEL', KEYS[1], id); redis.call('ZREM', KEYS[2], id); redis.call('ZREM', KEYS[3], id)
  redis.call('HDEL', KEYS[4], id); redis.call('ZREM', KEYS[5], id)
end
return #ARGV`;
const STATE = `${NOW}
local total = redis.call('HLEN', KEYS[1])
local pend = redis.call('ZCOUNT', KEYS[5], '(' .. now, '+inf')
local first = redis.call('ZRANGE', KEYS[2], 0, 0)
local body = false
if first[1] then body = redis.call('HGET', KEYS[1], first[1]) end
return { total, pend, body or '' }`;

/**
 * One journal in Redis. `key`: the journal's identity (the state schema and
 * the journal's name), shared by every container on that database. Every
 * method throws on a Redis failure; the caller (createDeadLetter) falls back
 * to local disk.
 */
// The journal's timers and reads never keep a process alive on their own
// (a script or a test that is done exits; a server is held by its listener).
const unrefd = new WeakSet();
const letExit = (c) => { if (c && !unrefd.has(c)) { unrefd.add(c); try { c.unref?.(); } catch { /* best effort */ } } return c; };
// The client every journal uses: the shared one (src/shared-limit.js). A test
// may hand its own getter (one it can cut and reconnect at will).
let clientOf = getSharedRedisClient;
export function __setJournalRedisForTest(fn) { clientOf = fn || getSharedRedisClient; }
export function createRedisJournal({ key, redis = () => clientOf(), owner = `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}` } = {}) {
  const p = `a402:journal:{${key}}`;
  const KEYS = ["items", "seq", "lease", "owner", "pend", "drain", "n"].map((k) => `${p}:${k}`);
  let downUntil = 0;
  const op = (promise) => new Promise((resolve, reject) => {
    // Not unref'd: a command in flight keeps the process alive until it
    // answers or times out (the client itself is unref'd, see letExit).
    const t = setTimeout(() => reject(new Error("redis journal: command timed out")), OP_MS());
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  async function run(script, args) {
    let c = null;
    try { c = letExit(await redis()); } catch { c = null; }
    // No client (not configured, connecting, or the shared client's own
    // cooldown): this call fails at once; only a command that failed opens
    // the down window.
    if (!c) throw new Error("redis journal: not reachable");
    try { return await op(c.eval(script, { keys: KEYS, arguments: args.map(String) })); }
    catch (e) { downUntil = Date.now() + DOWN_MS(); throw e; }
  }
  return {
    owner,
    key,
    /** True while a recent command failed: an add goes straight to local disk. */
    down: () => Date.now() < downUntil,
    async add(entry, { pending = false } = {}) {
      await run(ADD, [entry.id, JSON.stringify(entry), pending ? "1" : "0", JOURNAL_LEASE_MS(), owner]);
    },
    /** Every free entry, oldest first, leased to this holder; [] while another holder drains. */
    async claim(limit = 1000) {
      const flat = await run(CLAIM, [owner, JOURNAL_LEASE_MS(), limit]);
      const out = [];
      for (let i = 0; i + 1 < (flat?.length || 0); i += 2) {
        try { const e = JSON.parse(flat[i + 1]); if (e && e.id === flat[i]) out.push(e); } catch { /* unreadable: left for the operator */ }
      }
      return out;
    },
    async renew(ids) { return run(RENEW, [owner, JOURNAL_LEASE_MS(), ...ids]); },
    /** Free these entries for the next claim (a write that failed, a claim left unlanded); `unlock` ends this holder's drain. */
    async release(ids, { unlock = false } = {}) { return run(RELEASE, [owner, unlock ? "1" : "0", ...ids]); },
    /** Only after the entry's database write committed. */
    async remove(ids) { if (ids.length) await run(REMOVE, ids); },
    /** { total, pending (writes still queued by a live writer), oldestAt }. */
    async state() {
      const [total, pend, body] = await run(STATE, []);
      let oldestAt = null;
      if (body) { try { oldestAt = Number(JSON.parse(body).at) || null; } catch { /* none */ } }
      return { total: Number(total) || 0, pending: Number(pend) || 0, oldestAt };
    },
    /** Every entry (a read, no claim), oldest first. */
    async entries() {
      const c = letExit(await redis());
      if (!c) throw new Error("redis journal: not reachable");
      const [all, order] = await op(Promise.all([c.hGetAll(KEYS[0]), c.zRange(KEYS[1], 0, -1)]));
      const out = [];
      for (const id of order || []) { const raw = all?.[id]; if (!raw) continue; try { out.push(JSON.parse(raw)); } catch { /* skipped */ } }
      return out;
    },
  };
}
