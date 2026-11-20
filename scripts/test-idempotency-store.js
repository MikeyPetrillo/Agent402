// src/idempotency-store.js: the answers and in-flight claims the idempotency
// middleware keeps. The local store keeps exactly the old Map semantics (TTL,
// FIFO eviction by entries and bytes, one in-flight claim per key). The shared
// store puts both in Redis with the same life, so a retry that lands on
// another container still replays and a duplicate still gets its 409. Both
// are also written to the local store, so a Redis outage (cooldown or a
// throwing client) never forgets an answer or locks a released claim. The Redis
// half runs against REDIS_URL (required under CI).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { createLocalIdempotencyStore, createIdempotencyStore, IDEM_TTL_MS } from "../src/idempotency-store.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- local ------------------------------------------------------------------
{
  const s = createLocalIdempotencyStore({ ttlMs: 300, maxEntries: 3, maxBytes: 1000 });
  ok((await s.get("a")) === null, "local: miss reads null");
  await s.set("a", { v: 1 }, 100);
  ok((await s.get("a")).v === 1, "local: hit replays the body");
  await s.set("b", { v: 2 }, 100); await s.set("c", { v: 3 }, 100); await s.set("d", { v: 4 }, 100);
  ok((await s.get("a")) === null && (await s.get("d")).v === 4 && s.size() === 3, "local: FIFO eviction by entry count");
  await s.set("big", { v: 5 }, 900);
  // b and c go (300 + 900 > 1000 until 100 + 900 fits); d stays: the oldest go first, only as many as needed.
  ok(s.size() === 2 && (await s.get("big")).v === 5 && (await s.get("d")).v === 4 && (await s.get("c")) === null, "local: eviction by total bytes, oldest first, only as many as needed");
  await sleep(350);
  ok((await s.get("big")) === null, "local: an entry expires at the ttl");
  ok(await s.claim("k") === true && await s.claim("k") === false, "local: the second in-flight claim is refused");
  await s.release("k");
  ok(await s.claim("k") === true, "local: a released key can be claimed again");
  s.stop();
  ok(IDEM_TTL_MS === 10 * 60 * 1000, "the shared ttl is ten minutes");
}
// ---- shared, no Redis: falls back to local ------------------------------------
// With no Redis configured the store is per-process, exactly as before Redis:
// a retry that lands on the OTHER container during a deploy overlap finds
// nothing and runs again. That cross-container gap is accepted only for the
// no-Redis case; with Redis configured the answers and claims are written to
// both stores (below), so a Redis outage never weakens the per-process guard.
{
  const local = createLocalIdempotencyStore({ ttlMs: 1000 });
  const s = createIdempotencyStore({ redis: async () => null, local });
  await s.set("x", { v: 9 }, 10);
  ok((await s.get("x")).v === 9 && (await local.get("x")).v === 9, "shared without Redis: the local store serves");
  ok(await s.claim("y") === true && await s.claim("y") === false, "shared without Redis: claims are local");
  await s.release("y");
  // A Redis that answers but misses (an answer stored during its cooldown lives locally) still replays.
  const missing = createIdempotencyStore({ redis: async () => ({ get: async () => null, set: async () => "OK", del: async () => 1, expire: async () => 1 }), local });
  await local.set("cool", { v: 7 }, 10);
  ok((await missing.get("cool")).v === 7, "a Redis miss falls through to the local store");
  ok(await missing.renew("any") === true && await local.renew("any") === true, "renew is accepted by both stores");
  const failing = createIdempotencyStore({ redis: async () => { throw new Error("down"); }, local });
  await failing.set("z", { v: 1 }, 10);
  ok((await failing.get("z")).v === 1, "a Redis client that throws falls back to local, never to no guard");
  s.stop(); failing.stop();
}
// ---- shared, Redis that goes away: never weaker than the local store ---------
{
  const kv = new Map();
  let up = true;
  const deletes = [];
  const fake = {
    get: async (k) => { if (!up) throw new Error("down"); return kv.get(k) ?? null; },
    set: async (k, v, o) => { if (!up) throw new Error("down"); if (o?.NX && kv.has(k)) return null; kv.set(k, v); return "OK"; },
    del: async (k) => { if (!up) throw new Error("down"); deletes.push(k); return kv.delete(k) ? 1 : 0; },
    expire: async () => { if (!up) throw new Error("down"); return 1; },
  };
  // getSharedRedisClient() answers null during its 30 s cooldown; a client
  // whose commands throw is the other shape of the same outage.
  for (const shape of ["cooldown", "throwing"]) {
    up = true; kv.clear();
    const s = createIdempotencyStore({ redis: async () => (shape === "cooldown" && !up ? null : fake), releaseRetryMs: 20 });
    await s.set("ans", { paid: "answer" }, 20);
    up = false;
    ok((await s.get("ans"))?.paid === "answer", `${shape}: an answer stored while Redis was up replays while it is down`);
    up = true;
    ok(await s.claim("c") === true, `${shape}: first claim wins`);
    ok(await s.claim("c") === false, `${shape}: a duplicate in flight is refused`);
    up = false; await s.release("c"); up = true;
    ok(await s.claim("c") === true, `${shape}: a claim released while Redis was down does not lock the key for 120 s`);
    await s.release("c");
    // Released while down, never claimed again: the Redis key is deleted by the retry.
    ok(await s.claim("d") === true, `${shape}: claim d`);
    up = false; await s.release("d"); up = true;
    await sleep(80);
    ok(!kv.has("idem:f:d"), `${shape}: a Redis delete that failed is retried later`);
    // Down while claiming: the local claim still guards this process.
    up = false;
    ok(await s.claim("e") === true && await s.claim("e") === false, `${shape}: with Redis down a duplicate in this process is still refused`);
    await s.release("e"); up = true;
    s.stop();
  }
  // Redis that answers but whose claim this process already holds locally:
  // a same-process duplicate is refused even if Redis lost the key.
  {
    kv.clear(); up = true;
    const s = createIdempotencyStore({ redis: async () => fake });
    ok(await s.claim("g") === true, "claim g");
    kv.delete("idem:f:g");
    ok(await s.claim("g") === false, "a same-process duplicate is refused even when Redis lost the claim");
    await s.release("g"); s.stop();
  }
  // A claim taken locally while Redis was down never deletes the Redis claim
  // another container took for the same key meanwhile.
  {
    kv.clear(); up = false;
    const A = createIdempotencyStore({ redis: async () => fake, releaseRetryMs: 20 });
    const B = createIdempotencyStore({ redis: async () => fake, releaseRetryMs: 20 });
    ok(await A.claim("h") === true, "A claims h locally while Redis is down");
    up = true;
    ok(await B.claim("h") === true, "B claims h in Redis");
    await A.release("h"); await sleep(60);
    ok(kv.has("idem:f:h"), "A's release leaves B's Redis claim in place");
    await B.release("h"); A.stop(); B.stop();
  }
}
// ---- shared, a store that pauses: a claim sent and never answered -----------
// The store holds every command while paused and runs them in order once it
// answers (CLIENT PAUSE). A claim sent while it is paused passes its bound
// (the local claim guards this process) and lands once the pause ends, under
// this call's own token. Its release drops it by that token, so the same
// call sent again once the store answers (an answer that was not a 200 is
// not stored, so it runs again) is claimed, never refused 409 as in flight
// for the claim's whole life. A name another container holds is never
// dropped by a call whose own claim was only sent.
{
  const kv = new Map();
  let paused = false;
  const queued = [];
  const run = (fn) => (paused ? new Promise((r) => queued.push(() => r(fn()))) : Promise.resolve().then(fn));
  const unpause = () => { paused = false; for (const f of queued.splice(0)) f(); };
  const fake = {
    get: (k) => run(() => kv.get(k) ?? null),
    set: (k, v, o = {}) => run(() => { if (o.NX && kv.has(k)) return null; kv.set(k, v); return "OK"; }),
    del: (k) => run(() => (kv.delete(k) ? 1 : 0)),
    expire: () => run(() => 1),
    // The store's own compare-and-delete (one command, as on a real Redis).
    eval: (script, { keys, arguments: args }) => run(() => (/'del'/.test(script) && kv.get(keys[0]) === args[0] ? (kv.delete(keys[0]) ? 1 : 0) : 0)),
  };
  const keep = setInterval(() => {}, 1000); // a command's bound alone does not hold the loop
  try {
    const A = createIdempotencyStore({ redis: async () => fake, opTimeoutMs: 40, releaseRetryMs: 20 });
    paused = true;
    ok(await A.claim("p") === true, "paused store: a claim whose answer never comes is guarded by this process's own claim");
    await A.release("p"); // the run ended on a refusal: nothing was stored for it
    unpause();
    await sleep(10);
    ok(!kv.has("idem:f:p"), `paused store: the claim that landed once the store answered is dropped by its own token (left: ${kv.get("idem:f:p") ?? "none"})`);
    ok(await A.claim("p") === true, "paused store: so the same call sent again is claimed, never refused as still running");
    await A.release("p");
    const B = createIdempotencyStore({ redis: async () => fake, opTimeoutMs: 40, releaseRetryMs: 20 });
    ok(await B.claim("p") === true, "paused store: and another container claims it too once that run is released");
    await B.release("p");
    // The release is the one never answered, and the retry runs before the claim lands: still by token.
    paused = true;
    ok(await A.claim("q") === true, "paused store: claim q");
    await A.release("q");
    await sleep(60); // the release's retry passes its bound too
    unpause();
    await sleep(60);
    ok(!kv.has("idem:f:q") && await B.claim("q") === true, "paused store: a release whose drop passed its bound is retried by token and the name is free");
    await B.release("q");
    // Another container holds the name: a call whose own claim was only sent leaves it in place.
    ok(await B.claim("t") === true, "control: B claims t in the store");
    const heldByB = kv.get("idem:f:t");
    paused = true;
    ok(await A.claim("t") === true, "A's claim of t is never answered (A's own claim guards A)");
    await A.release("t");
    unpause();
    await sleep(60);
    ok(kv.get("idem:f:t") === heldByB, "A's release leaves B's claim of t in place");
    ok(await A.claim("t") === false, "and the same call sent to A while B runs it is refused as in flight");
    await B.release("t");
    A.stop(); B.stop();
  } finally {
    clearInterval(keep);
  }
}
// ---- shared, real Redis -----------------------------------------------------
const url = String(process.env.REDIS_URL || "").trim();
if (!url) {
  if (process.env.CI) { console.error("FAIL - CI needs REDIS_URL for the shared half"); process.exit(1); }
  console.log("SKIP - shared half: no REDIS_URL");
} else {
  const { createClient } = await import("redis");
  const c = createClient({ url }); await c.connect();
  const redis = async () => c;
  const A = createIdempotencyStore({ redis, local: createLocalIdempotencyStore({ ttlMs: 60_000 }) });
  const B = createIdempotencyStore({ redis, local: createLocalIdempotencyStore({ ttlMs: 60_000 }) });
  const key = "t-" + Date.now();
  await A.set(key, { paid: true }, 10);
  ok((await B.get(key))?.paid === true, "a body stored by one container replays from another");
  ok(await A.claim(key + "f") === true && await B.claim(key + "f") === false, "an in-flight claim held by one container refuses the other");
  await A.release(key + "f");
  ok(await B.claim(key + "f") === true, "after release the other container can claim");
  await B.release(key + "f");
  await A.claim(key + "r"); await c.expire("idem:f:" + key + "r", 5);
  await A.renew(key + "r");
  ok((await c.ttl("idem:f:" + key + "r")) > 60, "renew extends a live claim");
  await A.release(key + "r");
  const ttl = await c.pTTL("idem:b:" + key);
  ok(ttl > 0 && ttl <= IDEM_TTL_MS, `the Redis entry carries the ttl (${ttl} ms)`);
  await c.del("idem:b:" + key);
  // The store pauses (CLIENT PAUSE) past a claim's bound: the claim and then
  // its release are each sent and never answered. Once the store answers,
  // the claim lands and its drop runs right after it on the same connection,
  // so another container claims the key at once.
  {
    const admin = createClient({ url }); admin.on("error", () => {}); await admin.connect();
    const P = createIdempotencyStore({ redis, local: createLocalIdempotencyStore({ ttlMs: 60_000 }), opTimeoutMs: 100, releaseRetryMs: 50 });
    const pk = key + "p";
    const keepR = setInterval(() => {}, 1000);
    try {
      await admin.sendCommand(["CLIENT", "PAUSE", "500", "ALL"]);
      const claimed = await P.claim(pk);
      await P.release(pk);
      await admin.ping(); // answers once the pause has ended
      await sleep(100);
      ok(claimed === true && (await c.exists("idem:f:" + pk)) === 0, `real Redis paused past the bound: the claim that landed late is dropped by its token (claimed ${claimed}, left ${await c.get("idem:f:" + pk)})`);
      ok(await B.claim(pk) === true, "real Redis paused past the bound: the same call is claimed by another container, never refused as in flight");
      await B.release(pk);
    } finally {
      clearInterval(keepR);
      try { await admin.sendCommand(["CLIENT", "UNPAUSE"]); } catch { /* not paused */ }
      await admin.quit().catch(() => {});
      P.stop();
    }
  }
  A.stop(); B.stop(); await c.quit();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
