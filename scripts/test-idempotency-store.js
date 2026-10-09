// src/idempotency-store.js: the answers and in-flight claims the idempotency
// middleware keeps. The local store keeps exactly the old Map semantics (TTL,
// FIFO eviction by entries and bytes, one in-flight claim per key). The shared
// store puts both in Redis with the same life, so a retry that lands on
// another container still replays and a duplicate still gets its 409; every
// Redis failure falls back to the local store, never to no guard. The Redis
// half runs against REDIS_URL (required under CI).
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
{
  const local = createLocalIdempotencyStore({ ttlMs: 1000 });
  const s = createIdempotencyStore({ redis: async () => null, local });
  await s.set("x", { v: 9 }, 10);
  ok((await s.get("x")).v === 9 && (await local.get("x")).v === 9, "shared without Redis: the local store serves");
  ok(await s.claim("y") === true && await s.claim("y") === false, "shared without Redis: claims are local");
  await s.release("y");
  const failing = createIdempotencyStore({ redis: async () => { throw new Error("down"); }, local });
  await failing.set("z", { v: 1 }, 10);
  ok((await failing.get("z")).v === 1, "a Redis client that throws falls back to local, never to no guard");
  s.stop(); failing.stop();
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
  const ttl = await c.pTTL("idem:b:" + key);
  ok(ttl > 0 && ttl <= IDEM_TTL_MS, `the Redis entry carries the ttl (${ttl} ms)`);
  await c.del("idem:b:" + key);
  A.stop(); B.stop(); await c.quit();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
