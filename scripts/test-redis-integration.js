#!/usr/bin/env node
// Exercise the REAL redis client against a REAL redis server.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-redis-integration.js
//
// WHY THIS EXISTS (2026-08-07). Nothing in CI had ever connected to a redis.
// test-shared-limit.js injects a fake store on purpose - it is proving "two
// callers share one counter", and a fake proves that exactly - but that means
// the redis CLIENT path was untested: createClient with our socket options,
// connect, the command shapes, quit/destroy. So Dependabot's redis 4 -> 6 bump
// (#708, two majors) arrived with a green CI that could not possibly have
// caught a client regression, which is the same worthless green as the
// tesseract 5 -> 7 trap.
//
// It matters because prod is NOT in-memory: REDIS_URL and RATE_LIMIT_REPLICAS
// are both set on the production service, redis backs src/cache.js and
// src/shared-limit.js, and the shared limiter FAILS CLOSED - a client
// regression refuses trials rather than degrading quietly.
//
// This test REQUIRES a server. It does not skip: a skipped test is what let
// the gap exist, and "no redis configured" in CI means the service container
// is gone, which is the regression.
if (!process.env.REDIS_URL) {
  console.error("FAIL: REDIS_URL is not set. This test needs a real redis (CI provides a service container).");
  console.error("      It deliberately does not skip - a skipped integration test is why redis went untested at all.");
  process.exit(1);
}

const { spend, peek, refund, windowKey, sharedLimitEnabled, connectionState } = await import("../src/shared-limit.js");
const { cacheEnabled, cacheGet, cacheSet, cacheKeyFor } = await import("../src/cache.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Unique per run so a re-run never collides with its own leftovers.
const RUN = `it${process.pid}${Date.now().toString(36)}`;

// --- shared-limit against a live server -------------------------------------
{
  ok(sharedLimitEnabled(), "shared limiting reports available with a real REDIS_URL");

  const key = `${RUN}|caller`;
  const first = await spend(`${RUN}-tool`, key, 1, 60);
  const second = await spend(`${RUN}-tool`, key, 1, 60);
  ok(first.limited === false, "the first caller gets the single grant");
  ok(second.limited === true, "the second is refused - a cap of 1 holds against a real store, not just a fake one");
  // degraded:true is the FAIL-CLOSED path taken when redis is unreachable. If
  // it appears here the client never connected, and every assertion above
  // would be passing for the wrong reason.
  ok(first.degraded === false && second.degraded === false,
    "the results came from redis, not from the fail-closed degraded path");

  const state = connectionState();
  ok(state.connected === true, `the client reports a live connection (got ${JSON.stringify(state)})`);

  // The refused attempt must be handed back, or a rejected caller inflates the
  // counter and extends its own lockout. This is the assertion a client
  // regression on DECR would break.
  const after = await peek(`${RUN}-tool`, key, 1, 60);
  ok(after.count === 1, `an over-limit attempt did not inflate the counter (count=${after.count})`);

  await refund(`${RUN}-tool`, key, 60);
  const refunded = await peek(`${RUN}-tool`, key, 1, 60);
  ok(refunded.count === 0, `refund returns the grant against a real store (count=${refunded.count})`);

  ok(typeof windowKey(`${RUN}-tool`, key, 60) === "string", "windowKey still produces a key");
}

// --- cache against a live server --------------------------------------------
{
  ok(cacheEnabled(), "cache reports enabled with a real REDIS_URL");
  const key = cacheKeyFor(`/api/${RUN}`, { q: "hello" }, ["q"]);
  const miss = await cacheGet(key);
  ok(miss === null || miss === undefined, "a cold key misses");

  const value = { ok: true, n: 42, s: "round trip" };
  await cacheSet(key, value, 30);
  const hit = await cacheGet(key);
  ok(hit && JSON.stringify(hit) === JSON.stringify(value),
    `a value survives a real set/get round trip (got ${JSON.stringify(hit)})`);
}

// --- mppx replay store against a live server ---------------------------------
// The Tempo charge replay claims (src/mppx-store.js): two store objects over
// one redis stand in for two replicas. SET NX with a TTL and the EVAL
// compare-and-set are exactly what a fake cannot prove.
{
  const { createMppxStore, MPPX_STORE_PREFIX } = await import("../src/mppx-store.js");
  const { getSharedRedisClient } = await import("../src/shared-limit.js");
  const a = createMppxStore();
  const b = createMppxStore();
  ok(await a.backend() === "redis", "the mppx store writes to the real redis");
  const key = `mppx:charge:0x${RUN}`;
  const exp = Date.now() + 30_000;
  ok(await a.tryClaim(key, exp) === true, "replica A claims a hash against a real redis");
  ok(await b.tryClaim(key, exp) === false, "replica B is refused the same hash (SET NX across connections' callers)");
  const c = await getSharedRedisClient();
  const pttl = await c.pTTL(`${MPPX_STORE_PREFIX}${key}`);
  ok(pttl > 0 && pttl <= 31_000, `the claim carries a TTL at the challenge expiry (pttl=${pttl})`);
  await a.delete(key);
  ok(await b.tryClaim(key, exp) === true, "a released claim can be made again");
  await a.put(`k:${RUN}`, { n: 1n });
  // Ten concurrent increments through the EVAL compare-and-set: none lost.
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).update(`k:${RUN}`, (cur) => ({ op: "set", value: { n: cur.n + 1n }, result: true }))));
  const v = await b.get(`k:${RUN}`);
  ok(v && v.n === 11n, `ten concurrent updates from two replicas all land (n=${v?.n})`);
  ok(await a.update(`k:${RUN}`, () => ({ op: "delete", result: "gone" })) === "gone" && (await b.get(`k:${RUN}`)) === null, "update can delete against a real redis");
}

console.log(`\n${pass} passed, ${fail} failed`);
// Redis keeps the process alive on an open connection; the assertions are done.
process.exit(fail ? 1 : 0);
