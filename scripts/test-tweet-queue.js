#!/usr/bin/env node
// The server-side tweet queue (src/tweet-queue.js) and the X signer it shares
// with scripts/tweet.js (src/x-oauth.js). Offline: X is a stub fetch, the clock
// is a stub, every state file lives in a temp dir, and the booted legs run the
// real server with fetch to X replaced by a preload stub, so nothing here can
// reach X.
//
// Pins: one post per clock hour, oldest first; a backlog after downtime drains
// one item per hour instead of bunching; items past the catch-up window are
// dropped with a counts-only log line; the id is recorded BEFORE the request
// leaves, so a process that dies mid-post never re-sends it (a real child
// process is killed inside the post); two processes sharing the volume post
// once (real child processes racing a widened critical section); the kill
// switch, missing credentials and a bad queue post nothing; malformed items
// are refused; X's answers are classified (duplicate and 400 move on, 5xx and
// timeouts are in doubt, 401/429 pause the queue, a refused connection
// retries); an in-doubt post gets exactly one retry at least ten minutes
// later, inside its window and inside the one-post-per-hour rule, and a
// duplicate refusal of that retry records it as posted; the alarm word on
// /api/gateway-status pages on halted, missing keys, an X account refusal and
// a final in-doubt post; an unreadable state file halts posting; a live lock
// blocks and a stale one is taken over; only the production server posts (a
// FREE_MODE boot, a process without NODE_ENV=production and a process with no
// volume stay read-only - proven on booted servers against a control boot that
// does post to the stub); and no tweet text or credential ever reaches a log
// line or the operator read.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import { oauthHeader, xCredentialsFromEnv, missingXCredentials, pct } from "../src/x-oauth.js";
import {
  createTweetQueue, createXPoster, parseTweetQueue, weightedLength, wholeHourMs, hourOf, tweetQueueOptionsFromEnv, defaultStatePath,
} from "../src/tweet-queue.js";
import { getFreePort } from "./lib/free-port.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error(`FAIL: ${m}`); process.exit(1); } };
const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 10); // a whole UTC hour
const when = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const text = (n) => `PLACEHOLDER COPY ${n} zq9 not a real post`;
const CREDS = { consumerKey: "ck-LEAKCANARY-a", consumerSecret: "cs-LEAKCANARY-b", accessToken: "at-LEAKCANARY-c", accessSecret: "as-LEAKCANARY-d" };
const CRED_VALUES = Object.values(CREDS);
const ALL_LOGS = [];
const ALL_STATUS = [];
const SRC_QUEUE = pathToFileURL(resolve("src/tweet-queue.js")).href;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A stub of POST /2/tweets. Each call takes the next scripted answer (default
// 201 with a new id, echoing the text back the way X does).
function stubX(script = []) {
  const calls = [];
  let nextId = 1900000000000000000n;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: init.method, auth: init.headers.Authorization, text: body.text });
    const step = script.length ? script.shift() : { status: 201 };
    if (step.throw) throw step.throw();
    const status = step.status;
    const payload = step.body ?? (status < 300 ? { data: { id: String(nextId++), text: body.text } } : { title: "Refused", detail: step.detail || "refused", status });
    return new Response(JSON.stringify(payload), { status, headers: step.headers || { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

function mk(items, { clock = T0 + MIN, script = [], raw = null, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tweetq-"));
  const storePath = join(dir, "state.json");
  const logs = [];
  let t = clock;
  const x = stubX(script);
  const q = createTweetQueue({
    queueJson: raw ?? JSON.stringify(items), creds: CREDS, storePath, fetchImpl: x.fetchImpl,
    now: () => t, log: (l) => { logs.push(String(l)); ALL_LOGS.push(String(l)); }, firstRunPostAfter: 0, ...extra,
  });
  const status = () => { const s = q.status(); ALL_STATUS.push(JSON.stringify(s)); return s; };
  return { q, x, logs, dir, storePath, status, set: (ms) => { t = ms; } };
}

// ---- 1. the shared signer ----------------------------------------------------
{
  // RFC 5849 section 3.4.1 by hand, independently of the module: the base
  // string is METHOD & enc(url) & enc(sorted, encoded params), keyed with
  // enc(consumer secret) & enc(token secret).
  const url = "https://api.twitter.com/2/tweets";
  const h = oauthHeader("POST", url, CREDS, {}, { nonce: "n0nce-fixed", timestamp: 1767607200 });
  const params = `oauth_consumer_key=${CREDS.consumerKey}&oauth_nonce=n0nce-fixed&oauth_signature_method=HMAC-SHA1&oauth_timestamp=1767607200&oauth_token=${CREDS.accessToken}&oauth_version=1.0`;
  const base = `POST&${encodeURIComponent(url)}&${encodeURIComponent(params)}`;
  const want = createHmac("sha1", `${CREDS.consumerSecret}&${CREDS.accessSecret}`).update(base).digest("base64");
  ok(h.includes(`oauth_signature="${pct(want)}"`), "the signature matches an independent RFC 5849 construction");
  ok(/^OAuth oauth_consumer_key="[^"]+", oauth_nonce="n0nce-fixed", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1767607200", oauth_token="[^"]+", oauth_version="1.0"$/.test(h), "the header keeps tweet.js's sorted, quoted shape");
  const withBody = oauthHeader("POST", url, CREDS, { media_data: "abc" }, { nonce: "n", timestamp: 1 });
  const without = oauthHeader("POST", url, CREDS, {}, { nonce: "n", timestamp: 1 });
  ok(withBody !== without, "form body params are signed (the media upload path)");
  ok(pct("a!*'()b") === "a%21%2A%27%28%29b", "RFC 3986 encoding covers the characters encodeURIComponent leaves");
  const env = xCredentialsFromEnv({ TWITTER_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t", TWITTER_ACCESS_SECRET: "a" });
  ok(env.consumerKey === "k" && env.accessSecret === "a" && missingXCredentials(env).length === 0, "credentials read X_* first with TWITTER_* fallbacks");
  ok(missingXCredentials(xCredentialsFromEnv({})).join(",") === "X_API_KEY,X_API_SECRET,X_ACCESS_TOKEN,X_ACCESS_SECRET", "missing credentials are named, never valued");
  const tweetJs = readFileSync("scripts/tweet.js", "utf8");
  ok(/from "\.\.\/src\/x-oauth\.js"/.test(tweetJs) && !/createHmac/.test(tweetJs), "tweet.js signs through the shared module, not a copy");
  const env0 = { PATH: process.env.PATH, HOME: process.env.HOME || "" };
  const dry = spawnSync(process.execPath, ["scripts/tweet.js", "--text", text("dry")], { env: { ...env0, DRY_RUN: "1" }, encoding: "utf8" });
  ok(dry.status === 0 && /DRY RUN/.test(dry.stdout), "tweet.js dry run behaves as before");
  const noCreds = spawnSync(process.execPath, ["scripts/tweet.js", "--text", text("nocreds")], { env: env0, encoding: "utf8" });
  ok(noCreds.status === 1 && /X_API_KEY is required/.test(noCreds.stderr), "tweet.js still refuses without credentials (exit 1)");
}

// ---- 2. weighted length and item validation ---------------------------------
{
  ok(weightedLength("a".repeat(280)) === 280 && weightedLength("a".repeat(281)) === 281, "Latin text weighs one per character");
  ok(weightedLength("字".repeat(140)) === 280, "CJK weighs two per character");
  ok(weightedLength("agent402.tools") === 23 && weightedLength("see agent402.tools.") === 28, "a bare host counts as a 23-character link, trailing punctuation outside it");
  ok(weightedLength(`${"x".repeat(250)} https://agent402.tools/a/long/path/that/goes/on/and/on/for/a/while`) === 274, "a long link weighs 23 whatever its length");
  ok(weightedLength("\u{1F468}‍\u{1F469}‍\u{1F467}") === 2, "an emoji sequence weighs 2");
  ok(weightedLength("e.g. $0.003 i.e.") === 16 && weightedLength("a@b.co") === 6, "abbreviations, prices and an email address are not links");
  ok(wholeHourMs("2026-01-05T10:00:00Z") === T0 && wholeHourMs("2026-01-05T10:00:00.000Z") === T0, "a whole UTC hour parses in both spellings");
  ok(wholeHourMs("2026-01-05T10:30:00Z") === null && wholeHourMs("2026-02-30T10:00:00Z") === null && wholeHourMs("2026-01-05T24:00:00Z") === null && wholeHourMs("2026-01-05T10:00:00+01:00") === null, "a half hour, an impossible date, hour 24 and an offset are refused");

  const items = [
    { id: "ok-1", when: when(T0), text: text(1) },
    { id: "empty", when: when(T0), text: "   " },
    { id: "half", when: "2026-01-05T10:30:00Z", text: text(2) },
    { id: "dup", when: when(T0), text: text(3) },
    { id: "dup", when: when(T0 + H), text: text(4) },
    { id: "long", when: when(T0), text: "a".repeat(281) },
    { id: "carded", when: when(T0), text: text(5), card: "proof" },
    { id: "__proto__", when: when(T0), text: text(6) },
    "not an object",
    { id: "no-text", when: when(T0) },
  ];
  const p = parseTweetQueue(JSON.stringify(items));
  const reasons = Object.fromEntries(p.refused.map((r) => [`${r.index}`, r.reason]));
  ok(p.items.length === 1 && p.items[0].id === "ok-1", "only the well-formed item is postable");
  ok(reasons[1] === "empty_text" && reasons[2] === "when_not_whole_utc_hour" && reasons[3] === "duplicate_id" && reasons[4] === "duplicate_id"
    && reasons[5] === "over_weighted_limit" && reasons[6] === "card_not_posted_by_server" && reasons[7] === "bad_id" && reasons[8] === "not_an_object" && reasons[9] === "empty_text",
  "empty text, a non-hour when, BOTH copies of a shared id, over-limit text, a card, a bad id and a non-object are refused");
  ok(p.refused.find((r) => r.index === 5).weighted === 281, "an over-limit refusal names the weighted length");
  ok(p.refused.find((r) => r.index === 7).id === null, "a malformed id is not echoed");
  ok(parseTweetQueue("{not json").error === "not_json" && parseTweetQueue('{"a":1}').error === "not_array", "a queue that is not a JSON array is an error, not an empty queue");

  const s = mk(items, { clock: T0 + MIN });
  for (let k = 0; k < 6; k++) { s.set(T0 + k * H + MIN); await s.q.tick(); }
  ok(s.x.calls.length === 1 && s.x.calls[0].text === text(1), "refused items are never posted, however many hours pass");
  ok(s.x.calls[0].text === items[0].text, "the approved text is sent byte for byte");
  const st = s.status();
  ok(st.queue.items === 10 && st.queue.valid === 1 && st.queue.refused === 9 && st.queue.refusedByReason.duplicate_id === 2, "the operator read counts refusals by reason");
  const bad = mk(null, { raw: "{not json" });
  ok((await bad.q.tick()).skipped === "queue_invalid" && bad.x.calls.length === 0 && bad.status().mode === "queue_invalid", "an unparseable queue posts nothing and says why");
}

// ---- 3. once per hour, oldest first -------------------------------------------
{
  const items = [
    { id: "c", when: when(T0 + H), text: text("c") },
    { id: "a", when: when(T0), text: text("a") },
    { id: "b", when: when(T0), text: text("b") },
    { id: "d", when: when(T0 + 2 * H), text: text("d") },
  ];
  const s = mk(items);
  s.set(T0 - 5 * MIN);
  ok((await s.q.tick()).idle === "nothing_due" && s.x.calls.length === 0, "nothing posts before its hour");
  s.set(T0 + MIN); await s.q.tick();
  ok(s.x.calls.length === 1 && s.x.calls[0].text === text("a"), "the first due item posts at the top of its hour");
  ok(/^OAuth .*oauth_signature="/.test(s.x.calls[0].auth) && s.x.calls[0].url === "https://api.twitter.com/2/tweets" && s.x.calls[0].method === "POST", "the request is a signed POST /2/tweets");
  s.set(T0 + 10 * MIN);
  ok((await s.q.tick()).idle === "hour_used" && s.x.calls.length === 1, "a second item due in the same hour waits for the next hour");
  s.set(T0 + H + MIN); await s.q.tick();
  s.set(T0 + H + 30 * MIN); await s.q.tick();
  s.set(T0 + 2 * H + MIN); await s.q.tick();
  s.set(T0 + 3 * H + MIN); await s.q.tick();
  s.set(T0 + 4 * H + MIN); await s.q.tick();
  ok(s.x.calls.map((c) => c.text).join("|") === [text("a"), text("b"), text("c"), text("d")].join("|"), "one post per hour, oldest first, queue order breaking a tie");
  const st = s.status();
  ok(st.counts.posted === 4 && st.lastPosted.id === "d" && st.lastPosted.hour === hourOf(T0 + 3 * H) && /^\d+$/.test(st.lastPosted.tweetId), "the operator read carries the last post's id, hour and post id");
  ok(s.logs.some((l) => l === `[tweet-queue] posted a in hour ${hourOf(T0 + MIN)}`), "a post logs its id and hour");
}

// ---- 4. catch-up after downtime, without bunching ---------------------------
{
  const items = [0, 1, 2, 3].map((k) => ({ id: `h${k}`, when: when(T0 + k * H), text: text(`h${k}`) }));
  const s = mk(items);
  const postedAt = [];
  const tickAt = async (ms) => { s.set(ms); const before = s.x.calls.length; await s.q.tick(); if (s.x.calls.length > before) postedAt.push(hourOf(ms)); };
  for (let m = 5; m < 60; m += 3) await tickAt(T0 + 4 * H + m * MIN); // the server came back at 14:05 with four items due
  ok(s.x.calls.length === 1 && s.x.calls[0].text === text("h0"), "coming back to four due items posts ONE, the oldest, in the first hour");
  for (let h = 5; h < 9; h++) for (let m = 1; m < 60; m += 7) await tickAt(T0 + h * H + m * MIN);
  ok(s.x.calls.map((c) => c.text).join("|") === items.map((i) => i.text).join("|"), "the backlog drains in order");
  ok(new Set(postedAt).size === postedAt.length, "no two posts share a clock hour");
}

// ---- 5. past the catch-up window: dropped, counted, never posted ------------
{
  const items = [
    { id: "stale", when: when(T0 - 13 * H), text: text("stale") },
    { id: "edge", when: when(T0 - 12 * H), text: text("edge") },
    { id: "fresh", when: when(T0), text: text("fresh") },
  ];
  const s = mk(items, { clock: T0 });
  await s.q.tick();
  ok(s.x.calls.length === 1 && s.x.calls[0].text === text("edge"), "an item exactly at the window edge is still due and posts first");
  const line = s.logs.find((l) => /dropped/.test(l));
  ok(line === "[tweet-queue] dropped 1 item(s) past the 12 h catch-up window", "the drop is one counts-only log line");
  for (let k = 1; k < 20; k++) { s.set(T0 + k * H); await s.q.tick(); }
  ok(!s.x.calls.some((c) => c.text === text("stale")) && s.status().counts.dropped >= 1, "a dropped item never posts");
  const s2 = mk([{ id: "old", when: when(T0), text: text("old") }], { catchupHours: 2, clock: T0 + 2 * H + MIN });
  await s2.q.tick();
  ok(s2.x.calls.length === 0 && s2.status().counts.dropped === 1, "the window is configurable");
  const env = tweetQueueOptionsFromEnv({ TWEET_QUEUE: "[]", TWEET_QUEUE_CATCHUP_HOURS: "nonsense" });
  ok(env.catchupHours === 12 && tweetQueueOptionsFromEnv({ TWEET_QUEUE_CATCHUP_HOURS: "6" }).catchupHours === 6, "a malformed window falls back to the default");
}

// ---- 6. a crash between the record and the post does not double-post --------
{
  const dir = mkdtempSync(join(tmpdir(), "tweetq-crash-"));
  const storePath = join(dir, "state.json");
  const marker = join(dir, "seen-at-post.json");
  const items = [{ id: "one", when: when(T0), text: text("one") }, { id: "two", when: when(T0 + H), text: text("two") }];
  const child = join(dir, "crash.mjs");
  writeFileSync(child, `
    import { readFileSync, writeFileSync } from "node:fs";
    import { createTweetQueue } from ${JSON.stringify(SRC_QUEUE)};
    const [storePath, marker] = process.argv.slice(2);
    const q = createTweetQueue({ queueJson: process.env.Q, creds: ${JSON.stringify(CREDS)}, storePath, now: () => ${T0 + MIN}, log: () => {}, firstRunPostAfter: 0,
      post: async () => { writeFileSync(marker, readFileSync(storePath, "utf8")); process.exit(137); } });
    await q.tick();
    process.exit(0);
  `);
  const r = spawnSync(process.execPath, [child, storePath, marker], { env: { PATH: process.env.PATH, Q: JSON.stringify(items) }, encoding: "utf8" });
  ok(r.status === 137 && existsSync(marker), "the child process died inside the post");
  const atPost = JSON.parse(readFileSync(marker, "utf8"));
  ok(atPost.records.some((x) => x.id === "one" && x.state === "sending"), "the id was recorded as sending BEFORE the request left");
  const x = stubX();
  let t = T0 + 5 * MIN;
  const logs = [];
  const q = createTweetQueue({ firstRunPostAfter: 0, queueJson: JSON.stringify(items), creds: CREDS, storePath, fetchImpl: x.fetchImpl, now: () => t, log: (l) => { logs.push(l); ALL_LOGS.push(l); } });
  await q.tick();
  ok(x.calls.length === 0, "the restarted server posts nothing more in the crashed hour");
  for (let k = 1; k < 14; k++) { t = T0 + k * H + MIN; await q.tick(); }
  ok(x.calls.length === 1 && x.calls[0].text === text("two"), "the crashed item is never re-sent; the queue moves on to the next one");
  const st = q.status();
  ALL_STATUS.push(JSON.stringify(st));
  ok(st.counts.sending === 1 && st.inDoubt.some((d) => d.id === "one" && d.class === "sending"), "the operator read lists the crashed id as in doubt");
}

// ---- 7. two processes sharing the store post once ---------------------------
{
  const s = mk([{ id: "solo", when: when(T0), text: text("solo") }]);
  const shared = [];
  const mkTwin = () => createTweetQueue({ firstRunPostAfter: 0, queueJson: JSON.stringify([{ id: "solo", when: when(T0), text: text("solo") }]), creds: CREDS, storePath: s.storePath, now: () => T0 + MIN, log: () => {}, post: async (tx) => { shared.push(tx); await wait(30); return { kind: "posted", tweetId: "1" }; } });
  await Promise.all([mkTwin().tick(), mkTwin().tick(), mkTwin().tick()]);
  ok(shared.length === 1, "three schedulers in one process sharing a store post once");

  // Real processes. Each holds its critical section for 150 ms, so without the
  // lock both would read "nothing recorded" and both would post.
  const child = join(s.dir, "racer.mjs");
  writeFileSync(child, `
    import { appendFileSync } from "node:fs";
    import { createTweetQueue } from ${JSON.stringify(SRC_QUEUE)};
    const [storePath, postsLog, startAt, name] = process.argv.slice(2);
    const q = createTweetQueue({ queueJson: process.env.Q, creds: ${JSON.stringify(CREDS)}, storePath, now: () => ${T0 + MIN}, log: () => {}, firstRunPostAfter: 0, testHoldMs: 150,
      post: async () => { appendFileSync(postsLog, name + "\\n"); return { kind: "posted", tweetId: "7" }; } });
    while (Date.now() < Number(startAt)) { /* line both processes up */ }
    const r = await q.tick();
    process.stdout.write(JSON.stringify(r));
  `);
  const Q = JSON.stringify([{ id: "race", when: when(T0), text: text("race") }]);
  let rounds = 0;
  for (let round = 0; round < 4; round++) {
    const dir = mkdtempSync(join(tmpdir(), "tweetq-race-"));
    const postsLog = join(dir, "posts.log");
    writeFileSync(postsLog, "");
    const startAt = Date.now() + 400;
    const run = (name) => new Promise((res) => {
      const c = spawn(process.execPath, [child, join(dir, "state.json"), postsLog, String(startAt), name], { env: { PATH: process.env.PATH, Q } });
      let out = ""; c.stdout.on("data", (d) => { out += d; });
      c.on("close", (code) => res({ code, out }));
    });
    const [ra, rb] = await Promise.all([run("A"), run("B")]);
    const posts = readFileSync(postsLog, "utf8").trim().split("\n").filter(Boolean);
    if (ra.code === 0 && rb.code === 0 && posts.length === 1) rounds++;
    else console.error(`round ${round}: posts=${posts.length} A=${ra.out} B=${rb.out}`);
  }
  ok(rounds === 4, "two real processes racing the same hour post exactly once (4 of 4 rounds)");
}

// ---- 8. the kill switch, missing credentials, no queue ----------------------
{
  const items = [{ id: "k1", when: when(T0), text: text("k1") }];
  const off = mk(items, { postingSwitch: "off" });
  ok(off.q.start({ firstMs: 1, intervalMs: 5 }) === false, "switched off: no timer is started");
  ok((await off.q.tick()).skipped === "switched_off" && off.x.calls.length === 0, "switched off: a tick posts nothing");
  const st = off.status();
  ok(st.mode === "switched_off" && st.nextDue?.id === "k1" && st.nextDue.hour === hourOf(T0), "switched off: the operator read still previews the next item");
  ok(off.logs.some((l) => l === "[tweet-queue] switched_off: 1 postable item(s), 0 refused, catch-up 12 h"), "the boot line states the mode and counts");
  const envOff = tweetQueueOptionsFromEnv({ TWEET_QUEUE: JSON.stringify(items), TWEET_QUEUE_POSTING: "OFF", X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_SECRET: "d" });
  ok(createTweetQueue({ ...envOff, log: () => {} }).mode() === "switched_off", "TWEET_QUEUE_POSTING=off from the environment switches it off");
  ok(createTweetQueue({ ...tweetQueueOptionsFromEnv({}), log: () => {} }).mode() === "off", "no TWEET_QUEUE: off by default");
  const quiet = [];
  ok(createTweetQueue({ ...tweetQueueOptionsFromEnv({}), log: (l) => quiet.push(l) }).start() === false && quiet.length === 0, "no TWEET_QUEUE: no timer and not a line of log");
  const noCreds = mk(items, { creds: { consumerKey: "only-one" } });
  ok((await noCreds.q.tick()).skipped === "no_credentials" && noCreds.x.calls.length === 0 && noCreds.status().missingCredentials.length === 3, "missing credentials: nothing is attempted and the missing names are listed");
  const drain = mk(items, { isDraining: () => true });
  ok((await drain.q.tick()).skipped === "draining" && drain.x.calls.length === 0, "a draining process starts no post");
  const on = mk(items);
  ok(on.q.start({ firstMs: 10, intervalMs: 60_000 }) === true, "configured with credentials: the timer starts");
  await wait(60);
  on.q.stopTimer();
  ok(on.x.calls.length === 1, "the first tick fires after the boot delay");

  // Only the production server posts. The local audit and sample recipes copy
  // every production variable (TWEET_QUEUE and the X keys included) into a
  // FREE_MODE boot, and NODE_ENV=production comes from the Dockerfile, not
  // from those variables.
  const gateDir = mkdtempSync(join(tmpdir(), "tweetq-gate-"));
  const prodEnv = {
    TWEET_QUEUE: JSON.stringify(items), NODE_ENV: "production", TWEET_QUEUE_STATE_FILE: join(gateDir, "state.json"),
    X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_SECRET: "d",
  };
  const gated = (env, extra = {}) => {
    const x = stubX();
    const lines = [];
    const q = createTweetQueue({ firstRunPostAfter: 0, ...tweetQueueOptionsFromEnv(env, extra), fetchImpl: x.fetchImpl, now: () => T0 + MIN, log: (l) => { lines.push(l); ALL_LOGS.push(l); } });
    return { q, x, lines };
  };
  const prod = gated(prodEnv);
  ok(prod.q.mode() === "posting", "control: the production environment posts");
  const free = gated({ ...prodEnv, FREE_MODE: "true" });
  ok(free.q.mode() === "free_mode" && free.q.start({ firstMs: 1 }) === false, "FREE_MODE: read-only and no timer, even with NODE_ENV=production");
  ok((await free.q.tick()).skipped === "free_mode" && free.x.calls.length === 0 && !existsSync(join(gateDir, "state.json")), "FREE_MODE: a tick posts nothing and writes nothing");
  ok(free.lines.some((l) => /^\[tweet-queue\] free_mode: 1 postable item\(s\)/.test(l)), "FREE_MODE: the boot line names the mode");
  const { NODE_ENV: _dropped, ...noNodeEnv } = prodEnv;
  const dev = gated(noNodeEnv);
  ok(dev.q.mode() === "not_production" && dev.q.start({ firstMs: 1 }) === false && (await dev.q.tick()).skipped === "not_production" && dev.x.calls.length === 0, "no NODE_ENV=production: read-only, no timer, nothing posted");
  ok(gated({ ...prodEnv, NODE_ENV: "development" }).q.mode() === "not_production", "any other NODE_ENV is not production");
  ok(gated({ ...noNodeEnv, TWEET_QUEUE_FORCE: "true" }).q.mode() === "posting", "TWEET_QUEUE_FORCE=true is the escape hatch for a bare-metal production run");
  ok(gated({ ...noNodeEnv, TWEET_QUEUE_FORCE: "1" }).q.mode() === "not_production", "only the exact word true forces it");
  ok(gated({ ...prodEnv, FREE_MODE: "true", TWEET_QUEUE_FORCE: "true" }).q.mode() === "free_mode", "the escape hatch never overrides FREE_MODE");
  ok(defaultStatePath(() => false) === null && defaultStatePath(() => true) === "/data/tweet-queue-state.json", "the default state file is on /data, with no /tmp fallback");
  const { TWEET_QUEUE_STATE_FILE: _f, ...noFile } = prodEnv;
  const offVolume = gated(noFile, { dataDirExists: () => false });
  ok(offVolume.q.mode() === "no_store" && offVolume.q.start({ firstMs: 1 }) === false && (await offVolume.q.tick()).skipped === "no_store" && offVolume.x.calls.length === 0, "no /data and no state file: read-only, no timer, nothing posted");
  const offRead = offVolume.q.status();
  ALL_STATUS.push(JSON.stringify(offRead));
  ok(offRead.mode === "no_store" && offRead.nextDue?.id === "k1" && offRead.currentHour.used === null, "no /data: the operator read still previews the next item");
  ok(tweetQueueOptionsFromEnv(noFile, { dataDirExists: () => true }).storePath === "/data/tweet-queue-state.json", "on the volume the state file is /data/tweet-queue-state.json");
  ok(tweetQueueOptionsFromEnv({ TWEET_QUEUE_FIRST_TICK_MS: "300" }).firstTickMs === 300 && tweetQueueOptionsFromEnv({ TWEET_QUEUE_FIRST_TICK_MS: "5" }).firstTickMs === 90_000, "the first-tick delay is configurable within bounds");
  const serverSrc = readFileSync("src/server.js", "utf8");
  ok(/createTweetQueue\(\{ \.\.\.tweetQueueOptionsFromEnv\(process\.env\), isDraining: \(\) => draining \}\)/.test(serverSrc), "the server builds its queue from the environment gate and overrides none of it");
}

// ---- 9. what X answers ---------------------------------------------------------
{
  const three = [0, 1, 2].map((k) => ({ id: `x${k}`, when: when(T0), text: text(`x${k}`) }));

  const dup = mk(three, { script: [{ status: 403, detail: "You are not allowed to create a Tweet with duplicate content." }] });
  await dup.q.tick();
  ok(dup.x.calls.length === 2 && dup.x.calls[1].text === text("x1"), "a duplicate refusal is recorded and the next item posts in the same tick");
  ok(dup.status().counts.duplicate === 1 && dup.status().counts.posted === 1, "the duplicate is counted apart from posts");
  dup.set(T0 + H + MIN); await dup.q.tick();
  ok(dup.x.calls.length === 3 && dup.x.calls[2].text === text("x2"), "a duplicate is never re-sent");

  const rej = mk(three, { script: [{ status: 400, detail: "Invalid Request" }] });
  await rej.q.tick();
  ok(rej.x.calls.length === 2 && rej.status().counts.rejected === 1 && rej.status().lastError.class === "rejected" && rej.status().lastError.status === 400, "a 400 is final for the item and the queue moves on");

  const five = mk(three, { script: [{ status: 503 }] });
  await five.q.tick();
  ok(five.x.calls.length === 1 && five.status().counts.inDoubt === 1, "a 5xx leaves the item in doubt and nothing else posts that hour");
  ok(five.logs.some((l) => /x0 is IN DOUBT \(http_503\)/.test(l)), "the in-doubt line names the id and the class");

  const slow = mk(three, { script: [{ throw: () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) }] });
  await slow.q.tick();
  ok(slow.x.calls.length === 1 && slow.status().inDoubt[0]?.class === "TimeoutError", "a timeout after sending is in doubt");

  const auth = mk(three, { script: [{ status: 401, detail: "Unauthorized" }] });
  await auth.q.tick();
  ok(auth.x.calls.length === 1 && auth.status().counts.due === 3 && auth.status().backoffUntil, "a 401 pauses the queue and the item stays queued");
  auth.set(T0 + 10 * MIN);
  ok((await auth.q.tick()).skipped === "backoff" && auth.x.calls.length === 1, "nothing is tried during the pause");
  auth.set(T0 + 40 * MIN); await auth.q.tick();
  ok(auth.x.calls.length === 2 && auth.x.calls[1].text === text("x0"), "after the pause the same item posts, still inside its hour");

  const reset = Math.floor((T0 + 50 * MIN) / 1000);
  const rl = mk(three, { script: [{ status: 429, detail: "Too Many Requests", headers: { "x-rate-limit-reset": String(reset) } }] });
  await rl.q.tick();
  ok(rl.status().backoffUntil === new Date(reset * 1000).toISOString(), "a 429 pauses until X's reset time");

  const paid = mk(three, { script: [{ status: 402, detail: "Payment Required" }] });
  await paid.q.tick();
  ok(paid.status().counts.due === 3 && paid.status().backoffUntil, "a 402 (balance) pauses the queue without consuming the item");

  const dns = mk(three, { script: [{ throw: () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }) }] });
  await dns.q.tick();
  ok(dns.status().counts.due === 3 && dns.status().lastError.class === "not_sent", "a request that never connected is not in doubt");
  dns.set(T0 + 7 * MIN); await dns.q.tick();
  ok(dns.x.calls.length === 2 && dns.status().counts.posted === 1, "it is retried after a short pause");

  const reset2 = mk(three, { script: [{ throw: () => Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }) }] });
  await reset2.q.tick();
  ok(reset2.status().counts.inDoubt === 1, "a socket dropped after connecting is in doubt");

  const thrower = mk(three, { post: async () => { throw new Error("boom"); } });
  await thrower.q.tick();
  ok(thrower.status().counts.inDoubt === 1, "a poster that throws is in doubt");

  // The state file is replaced mid-post (a restore from a backup): the post
  // that went out must still be recorded, or the next tick sends it again.
  const swapPath = join(mkdtempSync(join(tmpdir(), "tweetq-swap-")), "state.json");
  let swapSent = 0;
  const swapQ = createTweetQueue({ firstRunPostAfter: 0, queueJson: JSON.stringify(three), creds: CREDS, storePath: swapPath, now: () => T0 + MIN, log: () => {},
    post: async () => { swapSent++; writeFileSync(swapPath, JSON.stringify({ v: 1, records: [], slots: [] })); return { kind: "posted", tweetId: "42" }; } });
  await swapQ.tick();
  const afterSwap = JSON.parse(readFileSync(swapPath, "utf8"));
  ok(swapSent === 1 && afterSwap.records.some((r) => r.id === "x0" && r.state === "posted") && afterSwap.slots.some((sl) => sl.id === "x0"), "a post is recorded even when the state file was replaced while it was in flight");
  await swapQ.tick();
  ok(swapSent === 1, "and it is not sent again");

  const poster = createXPoster({ creds: CREDS, fetchImpl: async () => new Response("not json", { status: 201 }) });
  const out = await poster(text("p"));
  ok(out.kind === "posted" && out.tweetId === null, "a 2xx without a readable body still counts as posted");
}

// ---- 9b. an in-doubt post: one retry, then final; the alarm word -----------
// A 5xx, a timeout or a dropped socket may or may not have created the post.
// It gets ONE retry at least ten minutes later: X refuses the retry as a
// duplicate if the first attempt landed (recorded as posted), and the retry
// posts it if it did not. A retry that is in doubt again is final.
{
  const three = [0, 1, 2].map((k) => ({ id: `r${k}`, when: when(T0), text: text(`r${k}`) }));
  const DUP = { status: 403, detail: "You are not allowed to create a Tweet with duplicate content." };
  const sentOf = (s, id) => s.x.calls.filter((c) => c.text === text(id)).length;

  // The first attempt landed behind a 503: the retry is refused as a duplicate.
  const landed = mk(three, { script: [{ status: 503 }, DUP] });
  await landed.q.tick();
  ok(landed.q.alarmStatus().status === "retrying" && landed.status().counts.retryPending === 1 && landed.status().inDoubt[0].retry === "pending", "in doubt with its retry owed: the word is retrying and the read says pending");
  landed.set(T0 + 9 * MIN); await landed.q.tick();
  ok(landed.x.calls.length === 1, "no retry before ten minutes have passed");
  landed.set(T0 + 12 * MIN); const rr = await landed.q.tick();
  ok(landed.x.calls.length === 2 && sentOf(landed, "r0") === 2 && rr.retried === 1, "the retry runs in the same hour, the one item allowed to use that hour");
  let st = landed.status();
  ok(st.counts.posted === 1 && st.counts.inDoubt === 0 && st.lastPosted?.id === "r0" && st.lastPosted.hour === hourOf(T0), "a duplicate refusal of the retry records it as posted in the first attempt's hour");
  ok(landed.logs.some((l) => /r0 was already on X \(its retry was refused as a duplicate\)/.test(l)), "and says so");
  ok(landed.x.calls.length === 2, "nothing else posts in the hour the first attempt used");
  for (let h = 1; h < 6; h++) { landed.set(T0 + h * H + MIN); await landed.q.tick(); }
  ok(sentOf(landed, "r0") === 2 && landed.x.calls.map((c) => c.text).slice(2).join("|") === [text("r1"), text("r2")].join("|"), "it is never sent a third time; the queue moves on one per hour");
  ok(landed.q.alarmStatus().status === "ok", "then the word is ok");

  // The first attempt did NOT land: the retry posts it, and that is the hour's one post.
  const lost = mk(three, { script: [{ status: 503 }, { status: 201 }] });
  await lost.q.tick();
  lost.set(T0 + 15 * MIN); await lost.q.tick();
  st = lost.status();
  ok(sentOf(lost, "r0") === 2 && st.counts.posted === 1 && lost.logs.some((l) => /posted r0 on its retry in hour/.test(l)), "a post that did not land is posted by its retry");
  lost.set(T0 + 40 * MIN); await lost.q.tick();
  ok(lost.x.calls.length === 2, "the next item still waits for the next hour");

  // In doubt twice: final, never sent again, and the alarm pages.
  const twice = mk(three, { script: [{ status: 503 }, { throw: () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) }] });
  await twice.q.tick();
  twice.set(T0 + 11 * MIN); await twice.q.tick();
  for (let h = 1; h < 8; h++) { twice.set(T0 + h * H + 20 * MIN); await twice.q.tick(); }
  st = twice.status();
  ok(sentOf(twice, "r0") === 2, "a retry that is in doubt again is final: two sends at most");
  ok(st.counts.inDoubt === 1 && st.counts.retryPending === 0 && st.inDoubt.find((d) => d.id === "r0")?.retry === "used", "the read says its retry is used");
  ok(twice.logs.some((l) => /r0 is still IN DOUBT after its one retry \(TimeoutError\)/.test(l)), "the final in-doubt line names the id and the class");
  ok(twice.q.alarmStatus().status === "in_doubt" && st.alarm === "in_doubt", "the word is in_doubt, on the operator read too");
  const pub = twice.q.alarmStatus();
  ok(Object.keys(pub).join() === "status", "the public word carries nothing else");
  const full = twice.q.alarmStatus({ full: true });
  ok(full.inDoubt === 1 && full.mode === "posting" && !JSON.stringify(full).includes("r0"), "the operator word carries counts and never an id");
  // The operator checks X, re-queues the text under a new id if it did not
  // land, and removes the old id: that clears the word.
  const cleared = createTweetQueue({ firstRunPostAfter: 0, queueJson: JSON.stringify(three.slice(1)), creds: CREDS, storePath: twice.storePath, now: () => T0 + 8 * H, log: () => {} });
  ok(cleared.alarmStatus().status === "ok", "removing the in-doubt id from the queue clears the word");

  // A retry across an hour boundary: the first attempt's hour keeps its slot;
  // a duplicate frees the new hour for the next item in the same tick.
  const late = mk(three, { clock: T0 + 55 * MIN, script: [{ status: 502 }, DUP] });
  await late.q.tick();
  late.set(T0 + H + 6 * MIN); await late.q.tick();
  ok(late.x.calls.map((c) => c.text).join("|") === [text("r0"), text("r0"), text("r1")].join("|"), "a retry refused as a duplicate in a later hour lets the next item take that hour");
  const late2 = mk(three, { clock: T0 + 55 * MIN, script: [{ status: 502 }, { status: 201 }] });
  await late2.q.tick();
  late2.set(T0 + H + 6 * MIN); await late2.q.tick();
  late2.set(T0 + H + 30 * MIN); await late2.q.tick();
  ok(late2.x.calls.length === 2, "a retry that posts in a later hour is that hour's one post");

  // An hour another item already posted in is closed to a different item's
  // retry, even once that retry is due.
  const busy = mk(three, { clock: T0 + 55 * MIN, script: [{ status: 503 }] });
  await busy.q.tick();
  busy.set(T0 + H + MIN); await busy.q.tick();
  ok(busy.x.calls.map((c) => c.text).join("|") === [text("r0"), text("r1")].join("|"), "before r0's retry is due, the next item takes the next hour");
  busy.set(T0 + H + 20 * MIN); await busy.q.tick();
  ok(busy.x.calls.length === 2, "r0's retry does not share an hour r1 already posted in");
  busy.set(T0 + 2 * H + MIN); await busy.q.tick();
  ok(busy.x.calls.length === 3 && busy.x.calls[2].text === text("r0"), "it runs in the next free hour, ahead of the newer item");

  // An outright refusal of the retry (401) creates nothing: the retry is still owed.
  const acct = mk(three, { script: [{ status: 503 }, { status: 401, detail: "Unauthorized" }, DUP] });
  await acct.q.tick();
  acct.set(T0 + 11 * MIN); await acct.q.tick();
  ok(acct.status().inDoubt[0]?.retry === "pending" && acct.q.alarmStatus().status === "refused", "a 401 on the retry keeps it owed, and the word is refused");
  acct.set(T0 + 45 * MIN); await acct.q.tick();
  ok(sentOf(acct, "r0") === 3 && acct.status().counts.posted === 1 && acct.q.alarmStatus().status === "ok", "after the pause the retry runs; a duplicate records it posted and clears the word");

  // A record that says its retry is used is never retried again, whatever
  // else it carries (a state file restored or edited by hand).
  const used = mk([{ id: "u0", when: when(T0), text: text("u0") }], { clock: T0 + 30 * MIN });
  writeFileSync(used.storePath, JSON.stringify({ v: 1, records: [{ id: "u0", state: "in_doubt", at: T0 + MIN, hour: hourOf(T0), cls: "http_503", retryAt: T0 + 11 * MIN, retried: true }], slots: [{ hour: hourOf(T0), id: "u0" }] }));
  for (let k = 0; k < 5; k++) { used.set(T0 + k * H + 30 * MIN); await used.q.tick(); }
  ok(used.x.calls.length === 0 && used.q.alarmStatus().status === "in_doubt", "a used retry is never run again, and it pages");

  // The retry stays inside the catch-up window.
  const edge = mk([{ id: "w0", when: when(T0), text: text("w0") }], { catchupHours: 1, clock: T0 + 55 * MIN, script: [{ status: 503 }] });
  await edge.q.tick();
  edge.set(T0 + 66 * MIN); await edge.q.tick();
  ok(edge.x.calls.length === 1 && edge.status().inDoubt[0]?.retry === "none" && edge.q.alarmStatus().status === "in_doubt", "past the window the retry is not sent and the post is final in doubt");

  // A SENDING record (a crash mid-post, including mid-retry) is never retried;
  // once it is older than a post in flight could be, it pages.
  const crash = mk([{ id: "c0", when: when(T0), text: text("c0") }], { clock: T0 + 3 * MIN });
  writeFileSync(crash.storePath, JSON.stringify({ v: 1, records: [{ id: "c0", state: "sending", at: T0 + MIN, hour: hourOf(T0), retry: true }], slots: [{ hour: hourOf(T0), id: "c0" }] }));
  ok(crash.q.alarmStatus().status === "ok", "a SENDING record younger than a post in flight is not an alarm");
  for (let k = 0; k < 6; k++) { crash.set(T0 + k * H + 20 * MIN); await crash.q.tick(); }
  ok(crash.x.calls.length === 0 && crash.q.alarmStatus().status === "in_doubt", "a crash-left SENDING record is never retried, and it pages");

  // The other words.
  const words = async (items, extra, pre) => { const q = mk(items, extra); if (pre) await pre(q); return q.q.alarmStatus().status; };
  ok(await words(three) === "ok", "posting with nothing in doubt: ok");
  ok(await words(three, { postingSwitch: "off" }) === "off" && await words(three, { freeMode: true }) === "off" && await words(three, { notProduction: true }) === "off" && await words(null, { raw: "" }) === "off", "switched off, FREE_MODE, not production and no queue: off");
  ok(await words(three, { creds: {} }) === "no_credentials", "a missing X key: no_credentials");
  ok(await words(null, { raw: "{nope" }) === "halted" && await words(three, { storePath: null }) === "halted", "an invalid queue or no volume: halted");
  ok(await words(three, {}, async (s) => { writeFileSync(s.storePath, "{corrupt"); }) === "halted", "a corrupt state file: halted");
  ok(await words(three, { script: [{ status: 402, detail: "Payment Required" }] }, (s) => s.q.tick()) === "refused", "X refusing the account (402): refused");
  ok(await words(three, { script: [{ status: 429, detail: "Too Many Requests" }] }, (s) => s.q.tick()) === "ok", "a rate limit alone is not an alarm");
}

// ---- 10. an unreadable state file halts posting; the lock -------------------
{
  const items = [{ id: "s1", when: when(T0), text: text("s1") }];
  const s = mk(items);
  writeFileSync(s.storePath, "{not json");
  await s.q.tick();
  ok(s.x.calls.length === 0 && s.status().mode === "store_unreadable", "a corrupt state file posts nothing");
  ok(s.logs.some((l) => l === "[tweet-queue] state file corrupt: posting halted until it reads cleanly"), "and says so once");
  writeFileSync(s.storePath, JSON.stringify({ v: 1, records: [{ id: "s1", state: "bogus", at: 1 }], slots: [] }));
  await s.q.tick();
  ok(s.x.calls.length === 0, "a record in an unknown state is corrupt too");
  writeFileSync(s.storePath, JSON.stringify({ v: 1, records: [], slots: [] }));
  await s.q.tick();
  ok(s.x.calls.length === 1 && s.status().mode === "posting", "posting resumes once the file reads cleanly");

  const blocker = join(s.dir, "a-file");
  writeFileSync(blocker, "x");
  let sent = 0;
  const nw = createTweetQueue({ firstRunPostAfter: 0, queueJson: JSON.stringify(items), creds: CREDS, storePath: join(blocker, "state.json"), now: () => T0 + MIN, log: () => {}, post: async () => { sent++; return { kind: "posted" }; } });
  const r = await nw.tick();
  ok(sent === 0 && /^store_/.test(r.error || ""), "a state file that cannot be written means nothing is sent");

  const l = mk(items);
  writeFileSync(`${l.storePath}.lock`, JSON.stringify({ token: "another-process", pid: 1, at: Date.now() }));
  ok((await l.q.tick()).skipped === "locked" && l.x.calls.length === 0, "a live lock held by another process blocks the tick");
  writeFileSync(`${l.storePath}.lock`, JSON.stringify({ token: "crashed-process", pid: 1, at: Date.now() - 10 * MIN }));
  await l.q.tick();
  ok(l.x.calls.length === 1 && !existsSync(`${l.storePath}.lock`), "a stale lock is taken over and released");
  writeFileSync(`${l.storePath}.lock`, "");
  ok((await l.q.tick()).skipped === "locked", "an unreadable lock that is fresh on disk still blocks");
}

// ---- 11. booted servers: only production posts --------------------------------
// Three real servers, each with the X keys, a queue item due this hour, a short
// first tick and fetch to X replaced by a preload stub that logs each request.
// The CONTROL boot (paid mode, NODE_ENV=production) must post exactly once, so
// the stub is proven to see a post; then a FREE_MODE boot and a boot without
// NODE_ENV=production must post nothing for well past the time the control took.
{
  const dir = mkdtempSync(join(tmpdir(), "tweetq-boot-"));
  const TOKEN = "operator-test-secret-tweetq";
  const preload = join(dir, "x-stub.mjs");
  writeFileSync(preload, `
    import { appendFileSync } from "node:fs";
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url?.url || url);
      if (u.startsWith("https://api.twitter.com/")) {
        appendFileSync(process.env.TQ_STUB_LOG, (init?.method || "GET") + " " + u + "\\n");
        return new Response(JSON.stringify({ data: { id: "1900000000000000001" } }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return real(url, init);
    };
  `);
  const thisHour = Math.floor(Date.now() / H) * H;
  const items = [{ id: "boot-1", when: when(thisHour), text: text("boot-1") }, { id: "boot-2", when: when(thisHour + 5 * H), text: text("boot-2") }, { id: "boot-bad", when: "soon", text: text("boot-bad") }];
  const baseEnv = () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(TWEET_QUEUE|X_|TWITTER_)/.test(k) || k === "NODE_ENV" || k === "FREE_MODE") delete env[k];
    return {
      ...env, AGENT402_OPERATOR_TOKEN: TOKEN, X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
      FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off", X402_SYNC_ON_START: "false",
      TWEET_QUEUE: JSON.stringify(items), TWEET_QUEUE_FIRST_TICK_MS: "300",
      X_API_KEY: CREDS.consumerKey, X_API_SECRET: CREDS.consumerSecret, X_ACCESS_TOKEN: CREDS.accessToken, X_ACCESS_SECRET: CREDS.accessSecret,
    };
  };
  // Paid mode needs a payTo and no volume guards; nothing here pays anything.
  const PAID = {
    FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: "http://127.0.0.1:9", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
    POW_ALLOW_EPHEMERAL: "true", STATS_ALLOW_EPHEMERAL: "true", MEMORY_ALLOW_EPHEMERAL: "true",
  };
  async function boot(name, extraEnv) {
    const stubLog = join(dir, `${name}-x.log`);
    const statePath = join(dir, `${name}-state.json`);
    writeFileSync(stubLog, "");
    const PORT = await getFreePort();
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "src/server.js"], {
      env: { ...baseEnv(), PORT: String(PORT), TQ_STUB_LOG: stubLog, TWEET_QUEUE_STATE_FILE: statePath, TWEET_QUEUE_POST_AFTER: "2000-01-01T00:00:00Z", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    const base = `http://127.0.0.1:${PORT}`;
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { /* booting */ }
      if (!up) await wait(500);
    }
    const posts = () => readFileSync(stubLog, "utf8").split("\n").filter(Boolean);
    const read = async () => {
      const r = await fetch(`${base}/__operator/tweet-queue.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const bodyText = await r.text();
      ALL_STATUS.push(bodyText);
      return { res: r, j: JSON.parse(bodyText) };
    };
    return { up, base, posts, read, statePath, spawnedAt, log: () => log, stop: () => { ALL_LOGS.push(log); child.kill("SIGKILL"); } };
  }

  // CONTROL: the production shape posts, once, to the stub.
  const ctl = await boot("control", { ...PAID, NODE_ENV: "production" });
  let controlMs = 0;
  try {
    ok(ctl.up, "control server booted (paid mode, NODE_ENV=production)");
    while (ctl.posts().length === 0 && Date.now() - ctl.spawnedAt < 60_000) await wait(100);
    controlMs = Date.now() - ctl.spawnedAt;
    await wait(1_000); // a second post would be a defect of its own
    ok(ctl.posts().length === 1 && ctl.posts()[0] === "POST https://api.twitter.com/2/tweets", `control: the production server posted the due item to the stub, once (${controlMs} ms after spawn)`);
    const { j } = await ctl.read();
    ok(j.mode === "posting" && j.counts.posted === 1 && j.lastPosted?.id === "boot-1", "control: the operator read shows it posted");
    ok(/\[tweet-queue\] posting: 2 postable item\(s\), 1 refused/.test(ctl.log()), "control: the boot line says posting");
    const pubText = await (await fetch(`${ctl.base}/api/gateway-status`)).text();
    ALL_STATUS.push(pubText);
    ok(JSON.stringify(JSON.parse(pubText).tweetQueue) === '{"status":"ok"}', "control: /api/gateway-status publishes the word ok and nothing else");
    ok(!pubText.includes("boot-1") && !pubText.includes("boot-2"), "the public status never names a queue id");
    const opText = await (await fetch(`${ctl.base}/api/gateway-status`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    ALL_STATUS.push(opText);
    const op = JSON.parse(opText).tweetQueue;
    ok(op.status === "ok" && op.mode === "posting" && op.inDoubt === 0, "the operator's gateway status adds the mode and counts");
  } finally { ctl.stop(); }
  // Each negative boot is watched until well past the moment the control had
  // posted, counted from its own spawn.
  const quietUntil = (b) => b.spawnedAt + Math.max(2 * controlMs, controlMs + 3_000);

  // FREE_MODE with every production variable: read-only.
  const free = await boot("free", { FREE_MODE: "true", NODE_ENV: "production" });
  try {
    ok(free.up, "FREE_MODE server booted with the queue and the X keys");
    ok((await fetch(`${free.base}/__operator/tweet-queue.json`)).status === 404, "the operator read is hidden without credentials");
    await wait(Math.max(0, quietUntil(free) - Date.now()));
    ok(free.posts().length === 0, `FREE_MODE: nothing reached X in ${Date.now() - free.spawnedAt} ms (the control posted ${controlMs} ms after spawn)`);
    ok(!existsSync(free.statePath), "FREE_MODE: no state file was written");
    const { res, j } = await free.read();
    ok(res.status === 200 && res.headers.get("cache-control") === "no-store", "the operator read answers with no-store");
    ok(j.mode === "free_mode" && j.queue.items === 3 && j.queue.valid === 2 && j.queue.refusedByReason.when_not_whole_utc_hour === 1, "FREE_MODE: it reports the mode and the queue counts");
    ok(j.nextDue?.id === "boot-1" && j.nextUpcoming?.id === "boot-2" && j.lastPosted === null, "FREE_MODE: it still previews the next item and hour");
    ok(/\[tweet-queue\] free_mode: 2 postable item\(s\), 1 refused \(when_not_whole_utc_hour 1\), catch-up 12 h/.test(free.log()), "FREE_MODE: the boot log line names the mode, counts only");
    ok((await (await fetch(`${free.base}/api/gateway-status`)).json()).tweetQueue?.status === "off", "FREE_MODE: the public word is off, which never pages");
  } finally { free.stop(); }

  // Paid mode without NODE_ENV=production (a bare local boot): read-only.
  const bare = await boot("bare", { ...PAID });
  try {
    ok(bare.up, "a paid-mode server without NODE_ENV=production booted");
    await wait(Math.max(0, quietUntil(bare) - Date.now()));
    ok(bare.posts().length === 0 && !existsSync(bare.statePath), `no NODE_ENV=production: nothing reached X in ${Date.now() - bare.spawnedAt} ms and nothing was written`);
    const { j } = await bare.read();
    ok(j.mode === "not_production", "no NODE_ENV=production: the operator read says not_production");
  } finally { bare.stop(); }
}

// ---- 12. nothing that was approved as copy, and no credential, ever leaks ---
{
  const secretish = [/PLACEHOLDER COPY/, /zq9/, ...CRED_VALUES.map((v) => new RegExp(v)), /oauth_signature/, /oauth_token/];
  const leakedLog = ALL_LOGS.find((l) => secretish.some((re) => re.test(l)));
  ok(ALL_LOGS.length > 20 && !leakedLog, `no log line carries tweet text or a credential (${ALL_LOGS.length} lines checked)`);
  const leakedStatus = ALL_STATUS.find((sj) => secretish.some((re) => re.test(sj)));
  ok(ALL_STATUS.length > 20 && !leakedStatus, `no operator read carries tweet text or a credential (${ALL_STATUS.length} reads checked)`);
  // The source never passes item text or a response body to the logger.
  const src = readFileSync("src/tweet-queue.js", "utf8");
  const logCalls = src.split("\n").filter((l) => /\blog\(/.test(l));
  ok(logCalls.length > 5 && !logCalls.some((l) => /\.text\b|body|said|creds|Authorization/.test(l)), "no log call in the module references text, a body or a credential");
}

// The first run on an empty store (the cutover from the workflow, whose
// posted-id record does not carry over) posts nothing already due: those
// items are recorded as dropped, a missed post and never a second copy.
// TWEET_QUEUE_POST_AFTER moves that line; a later item still posts.
{
  const items = [{ id: "old", when: when(T0), text: text("old") }, { id: "new", when: when(T0 + 2 * H), text: text("new") }];
  const s = mk(items, { clock: T0 + MIN, firstRunPostAfter: undefined });
  await s.q.tick();
  ok(s.x.calls.length === 0 && s.logs.some((l) => /first run: 1 item/.test(l)), "first run: an item already due is not posted and the log says so");
  s.set(T0 + 2 * H + MIN); await s.q.tick();
  ok(s.x.calls.length === 1 && s.x.calls[0].text === text("new"), "first run: the store is written, so a later item posts on its own hour");
  const e = tweetQueueOptionsFromEnv({ TWEET_QUEUE_POST_AFTER: "2026-01-05T09:00:00Z" });
  ok(e.firstRunPostAfter === Date.parse("2026-01-05T09:00:00Z") && tweetQueueOptionsFromEnv({ TWEET_QUEUE_POST_AFTER: "soon" }).firstRunPostAfter === null, "TWEET_QUEUE_POST_AFTER is read as an ISO time; anything else is unset");
}

console.log(`\ntest-tweet-queue: ${pass} passed`);
process.exit(0);
