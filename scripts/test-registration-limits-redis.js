#!/usr/bin/env node
// Seller registration limits across replicas, on a REAL redis
// (src/registration-limits.js):
//   1. two limiter instances (two replicas' local floors) on one Redis: an
//      IP's five registrations on A refuse its sixth on B, the global cap is
//      one budget across both, a given-back slot is given back on both, and a
//      store that does not answer leaves each its own floor;
//   2. two real servers on one Redis: an IP's five MPP registrations on A make
//      its next one on B a 429, and the same for the x402 route.
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-registration-limits-redis.js
// Deliberately does not skip without REDIS_URL (CI provides the service container).
import { bootServer } from "./lib/boot-server.js";

if (!process.env.REDIS_URL) {
  console.error("FAIL: REDIS_URL is not set. This test needs a real redis; it deliberately does not skip.");
  process.exit(1);
}
const PREFIX = `reg${process.pid}${Date.now().toString(36)}`;
process.env.SHARED_LIMITS_PREFIX = PREFIX;
process.env.SHARED_LIMITS = "on";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { createRegistrationLimiter } = await import("../src/registration-limits.js");
const sl = await import("../src/shared-limits.js");
ok(sl.sharedLimitsMode() === "redis", "the shared store is Redis (not process memory)");

// ---- 1. two limiter instances ------------------------------------------------------
{
  const A = createRegistrationLimiter({ name: "t1", perIpMax: 5, globalMax: 8 });
  const B = createRegistrationLimiter({ name: "t1", perIpMax: 5, globalMax: 8 });
  const ip = "203.0.113.7";
  for (let i = 0; i < 5; i++) ok((await A.take(ip)).ok === true, `A takes registration ${i + 1} for the IP`);
  ok(B._localCounts(ip).ip === 0, "B's own floor has seen none of them");
  ok((await B.ipAllowed(ip)) === false, "B refuses the IP's sixth before validation (ipAllowed)");
  const t6 = await B.take(ip);
  ok(t6.ok === false && t6.reason === "ip", `B refuses the IP's sixth slot (${JSON.stringify(t6)})`);
  // Global: three more IPs fill 8 across both.
  ok((await B.take("198.51.100.1")).ok && (await A.take("198.51.100.2")).ok, "two more registrations from other IPs, one on each");
  const s9 = await B.take("198.51.100.3");
  ok(s9.ok === true, "the eighth registration lands");
  const s10 = await A.take("198.51.100.4");
  ok(s10.ok === false && s10.reason === "global", `the global cap is one budget across both (${JSON.stringify(s10)})`);
  B.giveBackGlobal(s9.slot);
  await wait(100);
  ok((await A.take("198.51.100.4")).ok === true, "a slot B gives back is free on A");
}
// ---- the floor: a store that does not answer ------------------------------------------
{
  const dead = { windowRead: async () => ({ ok: false, error: "down" }), windowAdd: async () => ({ ok: false, error: "down" }), windowRemove: async () => ({ ok: false, error: "down" }) };
  const L = createRegistrationLimiter({ name: "t2", perIpMax: 2, globalMax: 100, store: dead, enabled: true });
  ok((await L.take("192.0.2.1")).ok && (await L.take("192.0.2.1")).ok, "with the store down, the process's own count admits up to the limit");
  const third = await L.take("192.0.2.1");
  ok(third.ok === false && third.reason === "ip" && (await L.ipAllowed("192.0.2.1")) === false, "and refuses past it (the in-memory floor)");
}

// ---- 2. two real servers -----------------------------------------------------------------
{
  // PORT=0 boots (scripts/lib/boot-server.js): each server's port is the one it bound.
  const env = { SHARED_LIMITS_PREFIX: `${PREFIX}srv`, FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" };
  const boots = await Promise.allSettled([bootServer({ env, stores: "reg-limits" }), bootServer({ env, stores: "reg-limits" })]);
  const [A, B] = boots.map((b) => (b.status === "fulfilled" ? b.value : null));
  try {
    ok(A && B, "two servers booted on one Redis");
    if (!(A && B)) for (const b of boots) if (b.status === "rejected") console.error(String(b.reason?.message || b.reason).slice(-800));
    if (A && B) {
      // Both servers see the request from 127.0.0.1: one IP.
      const reg = (srv, path, origin) => fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin }) });
      for (const path of ["/api/mpp-index/register", "/api/index/register"]) {
        const codes = [];
        for (let i = 0; i < 5; i++) codes.push((await reg(A, path, `https://seller-${i}.invalid`)).status);
        ok(codes.every((c) => c !== 429), `${path}: five registrations on A are admitted (${codes.join(",")})`);
        const sixth = await reg(B, path, "https://seller-6.invalid");
        ok(sixth.status === 429, `${path}: the IP's sixth, on B, is refused (${sixth.status})`);
      }
    }
  } finally { await Promise.all([A?.stop(), B?.stop()]); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
