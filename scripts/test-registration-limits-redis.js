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
import { spawn } from "node:child_process";
import { getFreePorts } from "./lib/free-port.js";

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
  const [pa, pb] = await getFreePorts(2);
  const children = [];
  const boot = (port) => {
    const c = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, SHARED_LIMITS_PREFIX: `${PREFIX}srv`, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" }, stdio: ["ignore", "pipe", "pipe"] });
    c.log = ""; c.stdout.on("data", (d) => { c.log += d; }); c.stderr.on("data", (d) => { c.log += d; });
    children.push(c); return c;
  };
  const A = boot(pa), B = boot(pb);
  try {
    const up = async (port) => { for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* */ } await wait(500); } return false; };
    const [ua, ub] = await Promise.all([up(pa), up(pb)]);
    ok(ua && ub, "two servers booted on one Redis");
    if (!(ua && ub)) console.error(A.log.slice(-800), B.log.slice(-800));
    // Both servers see the request from 127.0.0.1: one IP.
    const reg = (port, path, origin) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin }) });
    for (const path of ["/api/mpp-index/register", "/api/index/register"]) {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await reg(pa, path, `https://seller-${i}.invalid`)).status);
      ok(codes.every((c) => c !== 429), `${path}: five registrations on A are admitted (${codes.join(",")})`);
      const sixth = await reg(pb, path, "https://seller-6.invalid");
      ok(sixth.status === 429, `${path}: the IP's sixth, on B, is refused (${sixth.status})`);
    }
  } finally { for (const c of children) { try { c.kill("SIGKILL"); } catch { /* */ } } }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
