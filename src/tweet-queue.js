// The approved tweet queue, posted by the server on the hour.
//
// The queue used to post only from a scheduled GitHub workflow
// (.github/workflows/tweet-queue.yml), and scheduled workflows on this repo
// are delivered sparsely: an hourly schedule fired a handful of times a day,
// so approved slots went out late or aged out unposted. The server is up all
// day, so it posts them itself.
//
// Input is the Railway variable TWEET_QUEUE, the same JSON the workflow reads:
//   [{ "id": "...", "when": "YYYY-MM-DDTHH:00:00Z", "text": "...", "card"?: "..." }]
// Every text was approved verbatim before it was loaded. This module never
// edits, trims or invents copy. An item is REFUSED (never posted, counted on
// the operator read by reason) when its id is malformed or shared with
// another item, its `when` is not a whole UTC hour, its text is empty or over
// X's weighted limit, or it carries a card (a card renders against live
// numbers in the Announce workflow; this poster sends text only).
//
// Rules:
//  - Each tick posts the OLDEST due item (when <= now, inside the catch-up
//    window) that has no record yet.
//  - At most ONE post per clock hour, so a late start never bunches posts:
//    a backlog drains one item per hour and anything that ages past the window
//    is dropped (a counts-only log line; the ids are on the operator read).
//  - The id is recorded as SENDING in the state file BEFORE the request leaves
//    and as its outcome AFTER. A SENDING record found by any later tick (a
//    crash mid-post, or another process mid-post) is never sent again. X's
//    refusal of duplicate text is the belt, not the mechanism.
//  - Anything that may have reached X without a definitive answer (a timeout,
//    a dropped socket, a 5xx) is IN DOUBT and gets exactly ONE retry, at least
//    IN_DOUBT_RETRY_MS later and inside its catch-up window. If the first
//    attempt landed, X refuses the retry as a duplicate and the item is
//    recorded as posted; if it did not, the retry posts it. The retry holds to
//    the one-post-per-hour rule: it takes the slot of the hour it runs in, and
//    in the hour of the first attempt only that same item may use the slot. A
//    retry that is in doubt again is final and never re-sent; if it did not
//    land, re-queue the text under a new id. A SENDING record left by a crash
//    is never retried (nothing says whether its request left or is still in
//    flight).
//  - A refusal X states outright is final for the item (400) or pauses the
//    whole queue (401/402/403/429: credentials, balance or rate limit), and a
//    request that never connected is retried after a short pause.
//  - A lock file serializes read-decide-record across processes that share
//    the volume, and the state file is re-read inside the lock every time.
//  - A state file that exists but cannot be read HALTS posting: an empty
//    reading would re-post everything inside the window.
//  - Only the production server posts. A FREE_MODE boot, a process without
//    NODE_ENV=production (TWEET_QUEUE_FORCE=true overrides that one check)
//    and a process with no /data volume (and no TWEET_QUEUE_STATE_FILE) stay
//    read-only and start no timer. A local boot that copies the production
//    variables must never become a second poster: its record of what was
//    posted would be empty, and X's duplicate refusal would be all that stood
//    between it and a second copy of every post.
//  - alarmStatus() is one bucketed word for /api/gateway-status, so the status
//    Worker can open an issue: halted, no_credentials, refused (X refused the
//    account: credentials or balance) and in_doubt (a post may not have landed
//    and will not be retried again) page; ok and off clear; retrying does
//    neither.
//  - Logs and the operator read carry ids, hours, counts and status codes.
//    Never tweet text, never a credential.
import { randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { X_TWEETS_URL, missingXCredentials, oauthHeader, xCredentialsFromEnv } from "./x-oauth.js";

export const DEFAULT_CATCHUP_HOURS = 12;
export const DEFAULT_MAX_WEIGHTED = 280;
export const DEFAULT_TICK_MS = 3 * 60_000;
export const DEFAULT_FIRST_TICK_MS = 90_000;
export const POST_TIMEOUT_MS = 20_000;
export const LOCK_LEASE_MS = 30_000;
export const IN_DOUBT_RETRY_MS = 10 * 60_000;
const SENDING_STALE_MS = 5 * 60_000; // a SENDING record older than this is a crash, not a post in flight
const LOCK_RETRY_MS = 25;
const MAX_POSTS_TRIED_PER_TICK = 5; // duplicates and 400s move on to the next item inside one tick
const RETAIN_MS = 30 * 24 * 3_600_000; // records of ids no longer in the queue
const SLOT_RETAIN_MS = 3 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const BACKOFF = Object.freeze({ account: 30 * 60_000, rateLimit: 15 * 60_000, notSent: 5 * 60_000, max: 6 * HOUR_MS });

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00:00(?:\.000)?Z$/;
const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const STATES = new Set(["sending", "posted", "duplicate", "rejected", "dropped", "in_doubt"]);
const CONNECT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "ENETUNREACH", "EHOSTUNREACH"]);

/** The UTC hour bucket of an instant, e.g. "2026-09-28T13". */
export const hourOf = (ms) => new Date(ms).toISOString().slice(0, 13);

/**
 * The state file on the production volume, or null when there is no /data.
 * Deliberately no /tmp fallback: a process off the volume would start with an
 * empty record of what production already posted.
 */
export function defaultStatePath(dataDirExists = () => existsSync("/data")) {
  return dataDirExists() ? join("/data", "tweet-queue-state.json") : null;
}

/** Epoch ms of a `when` that names a whole UTC hour, else null. */
export function wholeHourMs(when) {
  if (typeof when !== "string") return null;
  const m = WHEN_RE.exec(when);
  if (!m) return null;
  const [y, mo, d, h] = [+m[1], +m[2] - 1, +m[3], +m[4]];
  const t = Date.UTC(y, mo, d, h);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo || back.getUTCDate() !== d || back.getUTCHours() !== h) return null;
  return t;
}

// ---- X's weighted length (twitter-text v3 rules) ---------------------------
// Code points in these ranges weigh 1, everything else 2; an emoji sequence
// weighs 2 however many code points it has; a link weighs 23 whatever its
// length, and a bare host.tld counts as a link. The one approximation: any
// alphabetic final label counts as a TLD, so a dotted token on a label that is
// not a real TLD counts high. That only ever refuses copy near the limit that
// X would have taken, never the other way round, and the refusal names the
// weighted length.
const WEIGHT_RANGES = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const SCALE = 100;
const DEFAULT_WEIGHT = 200;
const URL_WEIGHT = 23 * SCALE;
const URL_RE = /https?:\/\/[^\s]+|(?<![\p{L}\p{N}_@./-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s]*)?/giu;
const URL_TRAIL_RE = /[.,;:!?'"’”)\]}>]+$/u;
let EMOJI_RE;
try { EMOJI_RE = new RegExp("^\\p{RGI_Emoji}$", "v"); } catch { EMOJI_RE = /\p{Extended_Pictographic}/u; }
const SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
const inRanges = (cp) => WEIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b);

function plainWeight(s) {
  let w = 0;
  for (const { segment } of SEGMENTER.segment(s)) {
    if (EMOJI_RE.test(segment)) { w += DEFAULT_WEIGHT; continue; }
    for (const ch of segment) w += inRanges(ch.codePointAt(0)) ? SCALE : DEFAULT_WEIGHT;
  }
  return w;
}

/** X's weighted character count of a post (280 is the standard limit). */
export function weightedLength(text) {
  const s = String(text ?? "").normalize("NFC");
  let w = 0;
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    const trail = URL_TRAIL_RE.exec(m[0])?.[0] || "";
    const link = m[0].slice(0, m[0].length - trail.length);
    if (!link || /^https?:\/\/$/i.test(link)) continue; // nothing link-shaped left: counted as plain text below
    w += plainWeight(s.slice(last, m.index)) + URL_WEIGHT + plainWeight(trail);
    last = m.index + m[0].length;
  }
  w += plainWeight(s.slice(last));
  return w / SCALE;
}

// ---- the queue --------------------------------------------------------------
/**
 * Parse and validate the queue. Returns the postable items oldest first and
 * the refused ones by index with a reason. A refused item's id is echoed only
 * when it is well formed, so nothing an operator typed by mistake is echoed.
 */
export function parseTweetQueue(raw, { maxWeighted = DEFAULT_MAX_WEIGHTED } = {}) {
  const out = { error: null, total: 0, items: [], refused: [] };
  const src = String(raw ?? "").trim();
  if (!src) return out;
  let q;
  try { q = JSON.parse(src); } catch { out.error = "not_json"; return out; }
  if (!Array.isArray(q)) { out.error = "not_array"; return out; }
  out.total = q.length;
  const goodId = (x) => x && typeof x === "object" && typeof x.id === "string" && ID_RE.test(x.id);
  const seen = new Map();
  for (const x of q) if (goodId(x)) seen.set(x.id, (seen.get(x.id) || 0) + 1);
  q.forEach((x, index) => {
    const refuse = (reason, extra = {}) => { out.refused.push({ index, id: goodId(x) ? x.id : null, reason, ...extra }); };
    if (!x || typeof x !== "object" || Array.isArray(x)) return refuse("not_an_object");
    if (!goodId(x)) return refuse("bad_id");
    if (seen.get(x.id) > 1) return refuse("duplicate_id");
    const when = wholeHourMs(x.when);
    if (when == null) return refuse("when_not_whole_utc_hour");
    if (typeof x.text !== "string" || !x.text.trim()) return refuse("empty_text");
    if (x.card != null && x.card !== "") return refuse("card_not_posted_by_server");
    const weighted = weightedLength(x.text);
    if (weighted > maxWeighted) return refuse("over_weighted_limit", { weighted, limit: maxWeighted });
    out.items.push({ id: x.id, when, hour: hourOf(when), text: x.text });
  });
  out.items.sort((a, b) => a.when - b.when); // stable: same-hour items keep queue order
  return out;
}

// ---- the state file ---------------------------------------------------------
class StoreError extends Error {
  constructor(cls) { super(`tweet-queue state ${cls}`); this.cls = cls; }
}

function readState(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) {
    if (e?.code === "ENOENT") return { records: new Map(), slots: new Map(), fresh: true };
    throw new StoreError("unreadable");
  }
  let j;
  try { j = JSON.parse(raw); } catch { throw new StoreError("corrupt"); }
  if (!j || typeof j !== "object" || j.v !== 1 || !Array.isArray(j.records) || !Array.isArray(j.slots)) throw new StoreError("corrupt");
  const records = new Map();
  const slots = new Map();
  for (const r of j.records) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !ID_RE.test(r.id) || !STATES.has(r.state) || !Number.isFinite(r.at)) throw new StoreError("corrupt");
    records.set(r.id, { ...r });
  }
  for (const s of j.slots) {
    if (!s || typeof s !== "object" || typeof s.hour !== "string" || !HOUR_RE.test(s.hour) || typeof s.id !== "string" || !ID_RE.test(s.id)) throw new StoreError("corrupt");
    slots.set(s.hour, s.id);
  }
  return { records, slots };
}

function writeState(path, st) {
  const body = JSON.stringify({
    v: 1,
    records: [...st.records.values()],
    slots: [...st.slots].map(([hour, id]) => ({ hour, id })),
  });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw new StoreError("unwritable");
  }
  try { const d = openSync(dirname(path), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* best effort on the directory entry */ }
}

// ---- the lock ---------------------------------------------------------------
// Held only around read-decide-record (milliseconds), never across the network
// call: the SENDING record is what keeps a second poster off an item while the
// request is in flight. The lock file is created complete (written aside, then
// hard-linked into place, which fails if a lock exists), and a stale lock is
// taken over by an atomic rename that exactly one contender can win.
function lockAge(lockPath, held) {
  const at = Number(held?.at);
  if (Number.isFinite(at)) return Date.now() - at;
  try { return Date.now() - statSync(lockPath).mtimeMs; } catch { return 0; }
}

function createLockFile(lockPath, token) {
  const body = JSON.stringify({ token, pid: process.pid, at: Date.now() });
  const aside = `${lockPath}.${token}.new`;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(aside, body, { mode: 0o600 });
    try { linkSync(aside, lockPath); return true; }
    catch (e) {
      if (e?.code === "EEXIST") return false;
      // A filesystem without hard links: exclusive create instead.
      try { writeFileSync(lockPath, body, { flag: "wx", mode: 0o600 }); return true; }
      catch (e2) { if (e2?.code === "EEXIST") return false; throw e2; }
    }
  } catch {
    throw new StoreError("lock_unwritable");
  } finally {
    try { unlinkSync(aside); } catch { /* already gone */ }
  }
}

function tryLock(lockPath, token, leaseMs) {
  if (createLockFile(lockPath, token)) return true;
  let held = null;
  try { held = JSON.parse(readFileSync(lockPath, "utf8")); }
  catch (e) { if (e?.code === "ENOENT") return false; held = null; }
  if (lockAge(lockPath, held) < leaseMs) return false; // a live holder
  const moved = `${lockPath}.${token}.stale`;
  try { renameSync(lockPath, moved); } catch { return false; } // another contender took it first
  let movedBody = null;
  try { movedBody = JSON.parse(readFileSync(moved, "utf8")); } catch { movedBody = null; }
  if ((movedBody?.token ?? null) !== (held?.token ?? null)) {
    // The lock was replaced between our read and our rename: we moved a LIVE
    // lock. Put it back (the link fails if yet another lock exists) and step aside.
    try { linkSync(moved, lockPath); } catch { /* someone holds the path already */ }
    try { unlinkSync(moved); } catch { /* */ }
    return false;
  }
  try { unlinkSync(moved); } catch { /* */ }
  return createLockFile(lockPath, token);
}

function unlock(lockPath, token) {
  try {
    const held = JSON.parse(readFileSync(lockPath, "utf8"));
    if (held?.token === token) unlinkSync(lockPath);
  } catch { /* gone or not ours: nothing to release */ }
}

// ---- posting to X -------------------------------------------------------------
const safeCls = (s) => String(s || "unknown").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);

function retryAtFrom(res) {
  const reset = Number(res?.headers?.get?.("x-rate-limit-reset"));
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
}

/**
 * POST /2/tweets for one text, classified into what the queue does next:
 *   posted     X created it (2xx)
 *   duplicate  X refused identical text: it is already on X
 *   rejected   X refused THIS request (4xx): final for the item
 *   account    401/402/403/429: credentials, balance or rate limit - pause the queue
 *   not_sent   the connection never opened: safe to try again later
 *   in_doubt   a timeout, dropped socket or 5xx: it may have landed - one retry, later
 * Only the status and error class are kept; the response body is read for the
 * duplicate marker and the new post's id, and never logged.
 */
export function createXPoster({ creds, fetchImpl = null, timeoutMs = POST_TIMEOUT_MS } = {}) {
  return async function post(text) {
    let res;
    try {
      // Resolved per call, so a fetch wrapper installed after boot (the egress meter) sees it.
      res = await (fetchImpl || globalThis.fetch)(X_TWEETS_URL, {
        method: "POST",
        headers: { Authorization: oauthHeader("POST", X_TWEETS_URL, creds), "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const code = safeCls(e?.cause?.code || e?.code || e?.name || "network");
      return CONNECT_CODES.has(code) ? { kind: "not_sent", cls: code } : { kind: "in_doubt", cls: code };
    }
    const status = Number(res.status);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (status >= 200 && status < 300) {
      const id = body?.data?.id;
      return { kind: "posted", status, tweetId: id != null && /^\d{1,30}$/.test(String(id)) ? String(id) : null };
    }
    const said = [body?.detail, body?.title, body?.errors?.[0]?.message, body?.errors?.[0]?.detail]
      .filter((x) => typeof x === "string").join(" ");
    if (/duplicate/i.test(said)) return { kind: "duplicate", status };
    if (status >= 500) return { kind: "in_doubt", status, cls: `http_${status}` };
    if ([401, 402, 403, 429].includes(status)) return { kind: "account", status, retryAt: retryAtFrom(res) };
    return { kind: "rejected", status };
  };
}

// ---- the scheduler ------------------------------------------------------------
const numEnv = (v, dflt, lo, hi) => {
  const n = Number(v);
  return v != null && String(v).trim() !== "" && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};

/**
 * Options read from the environment (Railway). `freeMode` and `notProduction`
 * keep every process but the production server read-only: FREE_MODE is the
 * mode the local audit and sample recipes boot in with the production
 * variables copied, and NODE_ENV=production comes from the Dockerfile, not
 * from those variables.
 */
export function tweetQueueOptionsFromEnv(env = process.env, { dataDirExists } = {}) {
  return {
    queueJson: env.TWEET_QUEUE || "",
    postingSwitch: env.TWEET_QUEUE_POSTING || "",
    creds: xCredentialsFromEnv(env),
    freeMode: env.FREE_MODE === "true",
    notProduction: env.NODE_ENV !== "production" && env.TWEET_QUEUE_FORCE !== "true",
    storePath: env.TWEET_QUEUE_STATE_FILE || defaultStatePath(dataDirExists),
    catchupHours: numEnv(env.TWEET_QUEUE_CATCHUP_HOURS, DEFAULT_CATCHUP_HOURS, 1, 48),
    maxWeighted: numEnv(env.TWEET_QUEUE_MAX_WEIGHTED, DEFAULT_MAX_WEIGHTED, 1, 25_000),
    firstTickMs: numEnv(env.TWEET_QUEUE_FIRST_TICK_MS, DEFAULT_FIRST_TICK_MS, 50, 3_600_000),
    // An ISO time: on the first run (no state file) items due before it are
    // recorded as dropped instead of posted. Unset or unreadable = the moment
    // of that first run. See claimNext.
    firstRunPostAfter: Number.isFinite(Date.parse(env.TWEET_QUEUE_POST_AFTER || "")) ? Date.parse(env.TWEET_QUEUE_POST_AFTER) : null,
  };
}

/**
 * @param {object} o
 * @param {string} o.queueJson          the TWEET_QUEUE value
 * @param {string} [o.postingSwitch]    TWEET_QUEUE_POSTING ("off" stops posting)
 * @param {object} [o.creds]            X credentials (xCredentialsFromEnv shape)
 * @param {boolean} [o.freeMode]        a FREE_MODE boot: read-only, no timer
 * @param {boolean} [o.notProduction]   not the production server: read-only, no timer
 * @param {string|null} [o.storePath]   the state file (a lock file sits beside it); null = no volume, read-only
 * @param {(text:string)=>Promise<object>} [o.post] replaces the real X poster (tests)
 * @param {Function} [o.fetchImpl]      the fetch the real poster uses (tests stub X here)
 * @param {()=>number} [o.now]          the scheduling clock (tests)
 * @param {()=>boolean} [o.isDraining]  true once the process is shutting down
 */
export function createTweetQueue({
  queueJson = "", postingSwitch = "", creds = {}, storePath = defaultStatePath(),
  freeMode = false, notProduction = false, firstTickMs = DEFAULT_FIRST_TICK_MS,
  catchupHours = DEFAULT_CATCHUP_HOURS, maxWeighted = DEFAULT_MAX_WEIGHTED,
  post = null, fetchImpl, now = () => Date.now(), log = console.log, isDraining = () => false,
  leaseMs = LOCK_LEASE_MS,
  firstRunPostAfter = null,
  testHoldMs = 0, // tests only: hold the critical section open to widen a cross-process race
} = {}) {
  const lockPath = `${storePath}.lock`;
  const windowMs = catchupHours * HOUR_MS;
  const parsed = parseTweetQueue(queueJson, { maxWeighted });
  const queueIds = new Set(parsed.items.map((it) => it.id));
  const itemById = new Map(parsed.items.map((it) => [it.id, it]));
  // An in-doubt record still owed its one retry (inside the item's window),
  // and whether that retry is due at t.
  const retryPending = (r, it, t) => r?.state === "in_doubt" && Number.isFinite(r.retryAt) && !r.retried && t - it.when <= windowMs;
  const retryDue = (r, it, t) => retryPending(r, it, t) && t >= r.retryAt;
  const configured = String(queueJson || "").trim() !== "";
  const switchedOff = /^(off|false|0|no)$/i.test(String(postingSwitch || "").trim());
  const missing = missingXCredentials(creds);
  const poster = post || createXPoster({ creds, fetchImpl });

  let timer = null;
  let ticking = false;
  let storeError = null;
  let backoffUntil = 0;
  let lastError = null;
  let lastTickAt = null;
  let accountRefused = null; // the last X answer was a 401/402/403, until a post goes through

  function mode() {
    if (!configured) return "off";
    if (parsed.error) return "queue_invalid";
    if (switchedOff) return "switched_off";
    if (freeMode) return "free_mode";
    if (notProduction) return "not_production";
    if (!storePath) return "no_store";
    if (missing.length) return "no_credentials";
    if (storeError) return "store_unreadable";
    return "posting";
  }

  const noteError = (cls, extra = {}) => { lastError = { class: safeCls(cls), at: new Date(now()).toISOString(), ...extra }; };

  function persist(st) {
    const t = now();
    for (const [id, r] of st.records) {
      if (!queueIds.has(id) && t - r.at > RETAIN_MS) st.records.delete(id);
    }
    for (const hour of st.slots.keys()) {
      if (t - Date.parse(`${hour}:00:00Z`) > SLOT_RETAIN_MS) st.slots.delete(hour);
    }
    writeState(storePath, st);
  }

  async function withLock(fn, tries) {
    const token = randomBytes(8).toString("hex");
    for (let i = 0; i < tries; i++) {
      if (tryLock(lockPath, token, leaseMs)) {
        try { return { ok: true, value: fn() }; } finally { unlock(lockPath, token); }
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
    return { ok: false };
  }

  // Under the lock: drop what aged out, then claim the oldest due item for
  // this clock hour by writing its SENDING record before anything is sent.
  function claimNext() {
    const st = readState(storePath);
    storeError = null;
    if (testHoldMs > 0) { const until = Date.now() + testHoldMs; while (Date.now() < until) { /* widen the race window */ } }
    const t = now();
    const hour = hourOf(t);
    let dropped = 0;
    // No state file yet: this server has never posted, but the workflow it
    // replaces may already have posted anything already due, and its record
    // does not carry over. Items due before `firstRunPostAfter` (default: this
    // first run) are recorded as dropped - a missed post, never a second copy.
    if (st.fresh) {
      const after = Number.isFinite(firstRunPostAfter) ? firstRunPostAfter : t + 1;
      let skipped = 0;
      for (const it of parsed.items) {
        if (st.records.has(it.id) || it.when >= after) continue;
        st.records.set(it.id, { id: it.id, state: "dropped", at: t, hour: it.hour, firstRun: true });
        skipped++;
      }
      if (skipped) log(`[tweet-queue] first run: ${skipped} item(s) due before ${new Date(after).toISOString()} were not posted (the workflow may have posted them)`);
      // Written even when nothing was skipped: without the file every later
      // tick would read as a first run and skip what it came to post.
      st.fresh = false;
      persist(st);
    }
    for (const it of parsed.items) {
      if (st.records.has(it.id) || t - it.when <= windowMs) continue;
      st.records.set(it.id, { id: it.id, state: "dropped", at: t, hour: it.hour });
      dropped++;
    }
    if (dropped) log(`[tweet-queue] dropped ${dropped} item(s) past the ${catchupHours} h catch-up window`);
    // A used hour is open only to its own in-doubt item's retry: if the first
    // attempt landed in this hour the retry is refused as a duplicate, and if
    // it did not, the retry is this hour's one post.
    const holder = st.slots.get(hour);
    let pick = null;
    if (holder) {
      const it = itemById.get(holder);
      if (it && retryDue(st.records.get(holder), it, t)) pick = it;
    } else {
      pick = parsed.items.find((it) => {
        const r = st.records.get(it.id);
        return r ? retryDue(r, it, t) : it.when <= t;
      }) || null;
    }
    if (!pick) {
      if (dropped) persist(st);
      return { dropped, item: null, why: holder ? "hour_used" : "nothing_due" };
    }
    const prior = st.records.has(pick.id) ? { ...st.records.get(pick.id) } : null; // set only for a retry
    st.records.set(pick.id, { id: pick.id, state: "sending", at: t, hour, ...(prior ? { retry: true, firstHour: prior.hour ?? null } : {}) });
    st.slots.set(hour, pick.id);
    persist(st);
    return { dropped, item: pick, hour, prior };
  }

  // Under the lock: turn the SENDING record into its outcome. The file is
  // re-read, and if it no longer holds our record (restored from a backup, or
  // replaced by hand mid-post) the outcome is written anyway: anything that
  // may have posted must stay recorded, or the next tick would send it again.
  function recordOutcome(item, hour, out, prior = null) {
    const st = readState(storePath);
    const id = item.id;
    const ours = st.records.get(id)?.state === "sending";
    const t = now();
    const releaseSlot = () => { if (st.slots.get(hour) === id) st.slots.delete(hour); };
    const holdSlot = () => { if (!st.slots.has(hour)) st.slots.set(hour, id); };
    if (prior) {
      // The one retry of an in-doubt item. The slot of the first attempt's hour
      // is never released: that attempt may have landed in it.
      const firstHour = prior.hour ?? hour;
      const releaseRetrySlot = () => { if (hour !== firstHour) releaseSlot(); };
      const stillInDoubt = (retryCls) => st.records.set(id, { id, state: "in_doubt", at: t, hour: firstHour, cls: prior.cls ?? null, retried: true, retryHour: hour, retryCls: safeCls(retryCls) });
      if (out.kind === "posted") { st.records.set(id, { id, state: "posted", at: t, hour, retried: true, firstHour, ...(out.tweetId ? { tweetId: out.tweetId } : {}) }); holdSlot(); }
      else if (out.kind === "duplicate") { st.records.set(id, { id, state: "posted", at: t, hour: firstHour, retried: true, via: "duplicate_on_retry" }); releaseRetrySlot(); }
      else if (out.kind === "rejected") { stillInDoubt(`http_${out.status}`); releaseRetrySlot(); }
      else if (out.kind === "account" || out.kind === "not_sent") {
        // X created nothing: the retry is still owed. Put the in-doubt record back.
        if (ours || !st.records.has(id)) st.records.set(id, prior);
        releaseRetrySlot();
      } else { stillInDoubt(out.cls || `http_${out.status}`); holdSlot(); }
      persist(st);
      return true;
    }
    if (out.kind === "posted") { st.records.set(id, { id, state: "posted", at: t, hour, ...(out.tweetId ? { tweetId: out.tweetId } : {}) }); holdSlot(); }
    else if (out.kind === "duplicate") { st.records.set(id, { id, state: "duplicate", at: t, hour }); releaseSlot(); }
    else if (out.kind === "rejected") { st.records.set(id, { id, state: "rejected", at: t, status: out.status }); releaseSlot(); }
    else if (out.kind === "account" || out.kind === "not_sent") { if (ours) st.records.delete(id); releaseSlot(); }
    else { st.records.set(id, { id, state: "in_doubt", at: t, hour, cls: safeCls(out.cls || `http_${out.status}`), retryAt: t + IN_DOUBT_RETRY_MS }); holdSlot(); }
    persist(st);
    return true;
  }

  async function safePost(text) {
    try {
      const out = await poster(text);
      return out && typeof out.kind === "string" ? out : { kind: "in_doubt", cls: "no_outcome" };
    } catch (e) {
      return { kind: "in_doubt", cls: safeCls(e?.name || "threw") }; // it may have gone out
    }
  }

  function report(item, hour, out, prior = null) {
    const t = now();
    if (out.kind === "posted" || out.kind === "duplicate") accountRefused = null;
    if (prior) {
      const firstHour = prior.hour ?? hour;
      if (out.kind === "posted") { log(`[tweet-queue] posted ${item.id} on its retry in hour ${hour}: the attempt in hour ${firstHour} had not landed`); return; }
      if (out.kind === "duplicate") { log(`[tweet-queue] ${item.id} was already on X (its retry was refused as a duplicate): the attempt in hour ${firstHour} landed, recorded as posted`); return; }
      if (out.kind === "rejected" || out.kind === "in_doubt") {
        const cls = out.kind === "rejected" ? `http_${out.status}` : safeCls(out.cls || `http_${out.status}`);
        noteError("in_doubt", { cls, retried: true });
        log(`[tweet-queue] ${item.id} is still IN DOUBT after its one retry (${cls}): never re-sent; re-queue it under a new id if it did not land`);
        return;
      }
    }
    if (out.kind === "posted") { log(`[tweet-queue] posted ${item.id} in hour ${hour}`); return; }
    if (out.kind === "duplicate") { log(`[tweet-queue] ${item.id} is already on X (duplicate refused): recorded, not re-sent`); return; }
    if (out.kind === "rejected") { noteError("rejected", { status: out.status }); log(`[tweet-queue] X rejected ${item.id} (HTTP ${out.status}): not retried`); return; }
    if (out.kind === "account") {
      const dflt = out.status === 429 ? BACKOFF.rateLimit : BACKOFF.account;
      const until = out.retryAt && out.retryAt > t ? Math.min(out.retryAt, t + BACKOFF.max) : t + dflt;
      backoffUntil = until;
      if (out.status !== 429) accountRefused = { status: out.status, at: t };
      noteError("refused_account", { status: out.status });
      log(`[tweet-queue] X refused the post (HTTP ${out.status}): queue paused until ${new Date(until).toISOString()}, ${item.id} stays queued${prior ? " (its retry is still owed)" : ""}`);
      return;
    }
    if (out.kind === "not_sent") {
      backoffUntil = t + BACKOFF.notSent;
      noteError("not_sent", { cls: safeCls(out.cls) });
      log(`[tweet-queue] could not reach X (${safeCls(out.cls)}): ${item.id} stays queued${prior ? " (its retry is still owed)" : ""}`);
      return;
    }
    noteError("in_doubt", { cls: safeCls(out.cls || `http_${out.status}`) });
    log(`[tweet-queue] ${item.id} is IN DOUBT (${safeCls(out.cls || `http_${out.status}`)}): one retry in ${IN_DOUBT_RETRY_MS / 60_000} min or later (refused as a duplicate if the first attempt landed), then never re-sent`);
  }

  async function tick() {
    const m = mode();
    if (m !== "posting" && m !== "store_unreadable") return { skipped: m };
    if (ticking) return { skipped: "busy" };
    if (isDraining()) return { skipped: "draining" };
    const t0 = now();
    if (backoffUntil && t0 < backoffUntil) return { skipped: "backoff" };
    ticking = true;
    lastTickAt = t0;
    const result = { posted: 0, dropped: 0, duplicate: 0, rejected: 0, inDoubt: 0, retried: 0 };
    try {
      for (let n = 0; n < MAX_POSTS_TRIED_PER_TICK; n++) {
        const claim = await withLock(claimNext, 40);
        if (!claim.ok) { result.skipped = "locked"; break; }
        const c = claim.value;
        result.dropped += c.dropped;
        if (!c.item) { result.idle = c.why; break; }
        const out = await safePost(c.item.text);
        let recorded;
        try { recorded = await withLock(() => recordOutcome(c.item, c.hour, out, c.prior), 120); }
        catch (e) { recorded = { ok: false, error: e }; }
        if (!recorded.ok || !recorded.value) {
          // The outcome could not be written: the SENDING record stands, so the
          // item is treated as in doubt and never sent again. Safe direction.
          noteError("record_failed", { outcome: out.kind });
          log(`[tweet-queue] could not record the outcome for ${c.item.id} (${out.kind}): its record stays as it was, and it is never re-sent`);
          if (recorded.error instanceof StoreError) storeError = recorded.error.cls;
          break;
        }
        report(c.item, c.hour, out, c.prior);
        if (c.prior) result.retried++;
        if (out.kind === "duplicate") { result.duplicate++; continue; }
        if (out.kind === "rejected") { result.rejected++; continue; }
        if (out.kind === "posted") result.posted++;
        if (out.kind === "in_doubt") result.inDoubt++;
        break;
      }
    } catch (e) {
      if (e instanceof StoreError) {
        if (storeError !== e.cls) log(`[tweet-queue] state file ${e.cls}: posting halted until it reads cleanly`);
        storeError = e.cls;
        noteError(`store_${e.cls}`);
      } else {
        noteError("internal");
        log(`[tweet-queue] tick failed (${safeCls(e?.name)})`);
      }
      result.error = lastError?.class;
    } finally {
      ticking = false;
    }
    return result;
  }

  /** Counts, the next item and the last post, for the operator read. No text. */
  function status() {
    const t = now();
    let st = null;
    let readError = null;
    if (storePath) {
      try { st = readState(storePath); } catch (e) { readError = e instanceof StoreError ? e.cls : "unreadable"; }
    }
    const records = st ? st.records : new Map();
    const counts = { posted: 0, duplicate: 0, rejected: 0, dropped: 0, inDoubt: 0, retryPending: 0, sending: 0, due: 0, upcoming: 0, pastWindow: 0 };
    let nextDue = null;
    let nextUpcoming = null;
    const inDoubt = [];
    for (const it of parsed.items) {
      const r = records.get(it.id);
      if (r) {
        if (r.state === "in_doubt") {
          counts.inDoubt++;
          const pending = retryPending(r, it, t);
          if (pending) counts.retryPending++;
          inDoubt.push({ id: it.id, hour: r.hour || null, class: r.cls || null, retry: pending ? "pending" : r.retried ? "used" : "none", ...(pending ? { retryAt: new Date(r.retryAt).toISOString() } : {}) });
        }
        else if (r.state === "sending") { counts.sending++; inDoubt.push({ id: it.id, hour: r.hour || null, class: "sending", retry: "none" }); }
        else counts[r.state]++;
        continue;
      }
      if (it.when > t) { counts.upcoming++; nextUpcoming ??= { id: it.id, hour: it.hour }; }
      else if (t - it.when > windowMs) counts.pastWindow++;
      else { counts.due++; nextDue ??= { id: it.id, hour: it.hour }; }
    }
    let lastPosted = null;
    for (const r of records.values()) {
      if (r.state === "posted" && (!lastPosted || r.at > lastPosted.atMs)) lastPosted = { id: r.id, hour: r.hour || null, tweetId: r.tweetId || null, atMs: r.at };
    }
    if (lastPosted) { lastPosted.at = new Date(lastPosted.atMs).toISOString(); delete lastPosted.atMs; }
    const refusedByReason = {};
    for (const r of parsed.refused) refusedByReason[r.reason] = (refusedByReason[r.reason] || 0) + 1;
    const hour = hourOf(t);
    return {
      mode: readError && mode() === "posting" ? "store_unreadable" : mode(),
      alarm: alarmStatus().status,
      missingCredentials: configured ? missing : [],
      queueError: parsed.error,
      catchupHours,
      maxWeighted,
      queue: { items: parsed.total, valid: parsed.items.length, refused: parsed.refused.length, refusedByReason, refusedItems: parsed.refused },
      counts,
      nextDue,
      nextUpcoming,
      currentHour: { hour, used: st ? st.slots.has(hour) : null, id: st?.slots.get(hour) || null },
      lastPosted,
      inDoubt,
      lastError,
      storeError: readError || storeError,
      backoffUntil: backoffUntil > t ? new Date(backoffUntil).toISOString() : null,
      lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
    };
  }

  /**
   * One bucketed word for /api/gateway-status (public: the word only; the
   * operator also gets the mode and counts, never an id or text):
   *   off             not configured, switched off, or not the production server
   *   ok              posting, nothing in doubt
   *   retrying        an in-doubt post is waiting for its one retry
   *   in_doubt        a post may not have landed and will not be retried again
   *   refused         X's last answer was 401/402/403 (credentials or balance)
   *   no_credentials  an X key is missing
   *   halted          the queue or the state file cannot be read, or no volume
   * Removing an in-doubt id from TWEET_QUEUE (after checking X) clears it.
   */
  function alarmStatus({ full = false } = {}) {
    const m = mode();
    const t = now();
    let status;
    let finalInDoubt = 0;
    let pending = 0;
    if (m === "off" || m === "switched_off" || m === "free_mode" || m === "not_production") status = "off";
    else if (m === "no_credentials") status = "no_credentials";
    else if (m !== "posting" && m !== "store_unreadable") status = "halted";
    else {
      let st = null;
      try { st = readState(storePath); } catch { st = null; }
      if (!st || storeError) status = "halted";
      else {
        for (const it of parsed.items) {
          const r = st.records.get(it.id);
          if (r?.state === "in_doubt") { if (retryPending(r, it, t)) pending++; else finalInDoubt++; }
          else if (r?.state === "sending" && t - r.at > SENDING_STALE_MS) finalInDoubt++;
        }
        status = finalInDoubt ? "in_doubt" : accountRefused ? "refused" : pending ? "retrying" : "ok";
      }
    }
    return full ? { status, mode: m, inDoubt: finalInDoubt, retryPending: pending, ...(accountRefused ? { refusedStatus: accountRefused.status } : {}) } : { status };
  }

  function start({ intervalMs = DEFAULT_TICK_MS, firstMs = firstTickMs } = {}) {
    if (timer) return false;
    const m = mode();
    if (configured) {
      const reasons = Object.entries(parsed.refused.reduce((a, r) => { a[r.reason] = (a[r.reason] || 0) + 1; return a; }, {}))
        .map(([k, v]) => `${k} ${v}`).join(", ");
      log(`[tweet-queue] ${m}: ${parsed.items.length} postable item(s), ${parsed.refused.length} refused${reasons ? ` (${reasons})` : ""}, catch-up ${catchupHours} h`
        + (m === "no_credentials" ? `, missing ${missing.join(" ")}` : ""));
    }
    if (m !== "posting") return false;
    const run = () => { tick().catch(() => { /* tick records its own errors */ }); };
    timer = setInterval(run, intervalMs);
    timer.unref?.();
    const first = setTimeout(run, firstMs);
    first.unref?.();
    return true;
  }

  function stopTimer() { if (timer) clearInterval(timer); timer = null; }

  return { tick, status, alarmStatus, start, stopTimer, mode };
}
