// The Base unproven lane's per-seller daily cap (src/base-unproven.js) holds
// ACROSS replicas on a REAL Redis: two processes, each its own module
// instance, reserve for one seller at the same moment, and the seller's
// shared window never holds more than the cap (the reservation is one script
// on Redis over the seller's payTo and origin windows, not a read and a
// separate add). Controls: a seller filled on one replica is refused on the
// other; a released reservation gives its room back to the other replica; a
// different seller is untouched. Requires REDIS_URL (under CI a missing one
// fails).
import { spawn } from "node:child_process";
import { childJson } from "./lib/child-json.js";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REDIS = String(process.env.REDIS_URL || "").trim();
if (!REDIS) {
  const msg = "test-base-unproven-cap-redis: no REDIS_URL; start a local Redis (redis-server --port 26379 --save '') and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`); process.exit(0);
}
const EACH = 50000n, PER_PROC = 4; // $0.05 a call; the default cap ($0.25) fits five

if (process.argv[2] === "child") {
  // One replica: PER_PROC reservations for the seller at XC_AT, all in flight
  // at once; XC_RELEASE=1 gives every granted one back before exiting.
  delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;
  const U = await import("../src/base-unproven.js");
  const at = Number(process.env.XC_AT) || 0;
  await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
  const seller = { payTo: process.env.XC_PAYTO, origin: process.env.XC_ORIGIN };
  const n = Number(process.env.XC_N || PER_PROC);
  const out = await Promise.all(Array.from({ length: n }, () => U.reserveUnprovenSellerSpend({ ...seller, atomic: EACH })));
  const granted = out.filter((d) => d?.ok).length;
  const shared = out.every((d) => !d?.ok || d.handle?.shared === true);
  if (process.env.XC_RELEASE === "1") for (const d of out) if (d?.ok) U.releaseUnprovenSellerSpend(d.handle);
  await new Promise((r) => setTimeout(r, 300));
  const { closeSharedRedis } = await import("../src/shared-limit.js");
  await closeSharedRedis();
  console.log(JSON.stringify({ granted, shared, sharedMode: U.__sharedUnprovenSellerLedger }));
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const PREFIX = `bucr${process.pid}${Date.now().toString(36)}`;
const replica = (env) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [SELF, "child"], { env: { ...process.env, SHARED_LIMITS_PREFIX: PREFIX, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; c.stdout.on("data", (d) => { out += d; });
  c.on("close", (code) => { try { resolve(childJson(out)); } catch { reject(new Error(`replica exited ${code}: ${out}`)); } });
});
const fresh = () => ({ XC_PAYTO: `0x${randomBytes(20).toString("hex")}`, XC_ORIGIN: `https://s${randomBytes(4).toString("hex")}.example` });

for (let i = 0; i < 3; i++) {
  const s = fresh();
  const at = String(Date.now() + 2500);
  const rs = await Promise.all([replica({ ...s, XC_AT: at }), replica({ ...s, XC_AT: at })]);
  const total = rs[0].granted + rs[1].granted;
  ok(rs.every((r) => r.sharedMode === true && r.shared === true), `race ${i + 1}: both replicas reserved on the shared store`);
  ok(total === 5, `race ${i + 1}: two replicas reserving $0.05 x ${PER_PROC} each for one seller grant ${total} (${rs[0].granted}+${rs[1].granted}), exactly the $0.25 cap`);
}
{
  const s = fresh();
  const a = await replica({ ...s, XC_N: "5" });
  const b = await replica({ ...s, XC_N: "1" });
  ok(a.granted === 5 && b.granted === 0, `a seller filled on replica A is refused on replica B (${a.granted} then ${b.granted})`);
  const sameWallet = await replica({ XC_PAYTO: s.XC_PAYTO, XC_ORIGIN: "https://another-front.example", XC_N: "1" });
  ok(sameWallet.granted === 0, "...and its wallet behind another origin is refused on B too");
  const sameOrigin = await replica({ XC_PAYTO: `0x${randomBytes(20).toString("hex")}`, XC_ORIGIN: s.XC_ORIGIN, XC_N: "1" });
  ok(sameOrigin.granted === 0, "...and another wallet behind its origin is refused on B too");
  const other = await replica({ ...fresh(), XC_N: "1" });
  ok(other.granted === 1, "a different seller is untouched");
}
{
  const s = fresh();
  const a = await replica({ ...s, XC_N: "5", XC_RELEASE: "1" });
  const b = await replica({ ...s, XC_N: "5" });
  ok(a.granted === 5 && b.granted === 5, `reservations released on A free the seller's room for B (${a.granted} then ${b.granted})`);
}

console.log(`\ntest-base-unproven-cap-redis: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
