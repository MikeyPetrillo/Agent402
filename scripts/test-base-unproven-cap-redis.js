// The Base unproven lane's per-seller daily cap (src/base-unproven.js) holds
// ACROSS replicas on a REAL Redis: two processes, each its own module
// instance, reserve for one seller at the same moment, and the seller's
// shared window never holds more than the cap (the reservation is one script
// on Redis over the seller's payTo and origin windows, not a read and a
// separate add). Controls: a seller filled on one replica is refused on the
// other; a released reservation gives its room back to the other replica; a
// different seller is untouched. The lane's cap across all sellers
// (SOR_BASE_UNPROVEN_DAILY_USD) is one more window in the same script: two
// replicas reserving for distinct sellers at once never pass it, and a lane
// filled on one replica refuses a fresh seller on the other. The running
// sums stay equal to their windows when an older build (no running sum)
// writes during a deploy overlap or after a rollback: the windows are
// versioned, a sum that cannot be right (negative, above what its window
// could hold) is rebuilt in the same call, and a reserve never renews the
// sum's expiry. Requires REDIS_URL (under CI a missing one fails).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
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

// The reserve script of the build before the running sums: it adds to the
// window it names and prunes it, and keeps no sum.
const OLD_RESERVE = `
local n = #KEYS
local w = tonumber(ARGV[5])
for i = 1, n do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', ARGV[1])
  local items = redis.call('ZRANGE', KEYS[i], 0, -1)
  local sum = 0
  for j = 1, #items do sum = sum + (tonumber(string.match(items[j], '^(%-?%d+)|')) or 1) end
  local base = math.max(sum, tonumber(ARGV[4 + 2 * i]))
  if base + w > tonumber(ARGV[5 + 2 * i]) then return { 0, i, base } end
end
for i = 1, n do
  redis.call('ZADD', KEYS[i], ARGV[4], ARGV[3])
  redis.call('PEXPIRE', KEYS[i], ARGV[2])
end
return { 1, 0, 0 }`;
// What that build's window is named: the unversioned name, under the store's prefix.
const legacyWindowOf = async (k) => (await import("../src/shared-limits.js")).keyOf("base-unproven-seller", k);
const oldReserve = async (c, keys, micro, member, now, DAY) => {
  const W = await Promise.all(keys.map(legacyWindowOf));
  return c.eval(OLD_RESERVE, { keys: W, arguments: [now - DAY, DAY, `${micro}|${member}`, now, micro, ...W.flatMap(() => [0, 1e12])].map(String) });
};
const EACH = 50000n, PER_PROC = 4; // $0.05 a call; the default cap ($0.25) fits five

if (process.argv[2] === "fuzz") {
  // The running sums (src/base-unproven.js) against the windows they stand
  // for: a seeded random walk of reserves (some refused), releases (some of
  // them repeats), clock jumps past expiry and dropped sums, on three sellers that share a
  // payTo or an origin and the lane. After every step each window's settled
  // sum, its stored sum and the sum of its unexpired entries agree.
  const U = await import("../src/base-unproven.js");
  const { getSharedRedisClient, closeSharedRedis } = await import("../src/shared-limit.js");
  const c = await getSharedRedisClient();
  let seed = Number(process.env.XC_SEED) || 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const W1 = `0x${"a1".repeat(20)}`, W2 = `0x${"b2".repeat(20)}`;
  const sellers = [{ payTo: W1, origin: "https://f1.example/x" }, { payTo: W1, origin: "https://f2.example/x" }, { payTo: W2, origin: "https://f2.example/x" }];
  const keys = [...new Set(sellers.flatMap((s) => U.unprovenSellerKeys(s))), "lane:base"];
  const DAY = 24 * 3600_000;
  let now = 1_800_000_000_000;
  const handles = [];
  let mismatches = 0, steps = 0, reserved = 0, refused = 0, released = 0, expired = 0, dropped = 0, corrupted = 0, legacy = 0;
  const first = [];
  for (let i = 0; i < Number(process.env.XC_STEPS || 400); i++) {
    const r = rnd();
    if (r < 0.55) {
      const out = await U.reserveUnprovenSellerSpend({ ...pick(sellers), atomic: BigInt(1 + Math.floor(rnd() * 60000)), now, capUsd: pick([0.25, 0.5, 1000]), laneCapUsd: pick([1, 1000]) });
      if (out.ok) { reserved++; handles.push(out.handle); } else refused++;
    } else if (r < 0.8 && handles.length) {
      const h = pick(handles);
      await U.releaseUnprovenSellerSpend(h);
      released++;
    } else if (r > 0.97) {
      // A sum missing beside a live window (its expiry passed) is rebuilt
      // from the window.
      await c.del(U.__unprovenStoreKeys(pick(keys)).sum);
      dropped++;
    } else if (r > 0.94) {
      // A sum that cannot be right (below zero, or more than the window
      // could hold) is rebuilt on the next settle.
      await c.set(U.__unprovenStoreKeys(pick(keys)).sum, pick(["-1", "-750000", "999999999999"]));
      corrupted++;
    } else if (r > 0.91) {
      // The older build (no running sum) reserves into its own window.
      const sl = pick(sellers);
      await oldReserve(c, [...U.unprovenSellerKeys(sl), "lane:base"], 1 + Math.floor(rnd() * 60000), `old-${i}`, now, DAY);
      legacy++;
    } else {
      const before = now;
      now += pick([60_000, 3600_000, 6 * 3600_000, DAY + 1]);
      if (now - before > DAY) expired++;
    }
    steps++;
    const settled = await U.__unprovenWindowSums(keys, now);
    for (let j = 0; j < keys.length; j++) {
      const { window, sum } = U.__unprovenStoreKeys(keys[j]);
      const entries = await c.zRangeByScore(window, `(${now - DAY}`, "+inf");
      const want = entries.reduce((t, e) => t + (Number(String(e).split("|")[0]) || 1), 0);
      const stored = Number((await c.get(sum)) ?? 0);
      if (settled[j] !== want || stored !== want) { mismatches++; if (first.length < 3) first.push({ step: i, key: keys[j], settled: settled[j], stored, want }); }
    }
  }
  await closeSharedRedis();
  console.log(JSON.stringify({ steps, mismatches, first, reserved, refused, released, expired, dropped, corrupted, legacy }));
  process.exit(0);
}


if (process.argv[2] === "drift") {
  // An older build beside this one (deploy overlap, rollback), and sums that
  // cannot be right. Simulated clock; one process, so each scenario seeds
  // what "another replica" booked straight into the store, never through
  // this process's own rows (they would floor the figure and hide a bad sum).
  delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD; delete process.env.SOR_BASE_UNPROVEN_DAILY_USD;
  const U = await import("../src/base-unproven.js");
  const { getSharedRedisClient, closeSharedRedis } = await import("../src/shared-limit.js");
  const c = await getSharedRedisClient();
  const H = 3600_000, DAY = 24 * H, CAP = 250_000;
  const out = {};
  const truthOf = async (k, now) => (await c.zRangeByScore(U.__unprovenStoreKeys(k).window, `(${now - DAY}`, "+inf")).reduce((t, e) => t + Number(String(e).split("|")[0]), 0);
  const sumOf = async (k) => Number(await c.get(U.__unprovenStoreKeys(k).sum));
  const reserve = (seller, micro, now, capUsd = 0.25) => U.reserveUnprovenSellerSpend({ ...seller, atomic: BigInt(micro), now, capUsd, laneCapUsd: null });
  const sellerOf = (tag) => ({ payTo: `0x${tag.repeat(20)}`, origin: `https://${tag}.drift.example/x` });
  const { keyOf } = await import("../src/shared-limits.js");
  out.versioned = U.__unprovenStoreKeys("payto:x").window !== await legacyWindowOf("payto:x") && U.__unprovenStoreKeys("payto:x").sum !== keyOf("base-unproven-seller-sum", "payto:x");

  { // The review's replay: a $0.01 reserve, the older build reserves $0.20 for
    // the same seller a second later, new reserves keep the window alive every
    // 6 h for 36 h (past the old entry's expiry), then a minute-apart run of
    // $0.01 reserves at the $0.25 cap.
    const s = sellerOf("d1"); const keys = U.unprovenSellerKeys(s);
    let now = 1_900_000_000_000;
    await reserve(s, 10_000, now);
    await oldReserve(c, keys, 200_000, "old-1", now + 1000, DAY);
    let drift = 0;
    for (let t = 1; t <= 6; t++) { now += 6 * H; await reserve(s, 10_000, now, 1000); await U.__unprovenWindowSums(keys, now); for (const k of keys) if (await sumOf(k) !== await truthOf(k, now)) drift++; }
    // The cap run happens in a fresh process (no rows of its own to floor
    // the shared figure), as a newly started replica would.
    await c.set(U.__unprovenStoreKeys("replay-now").sum, String(now));
    out.replay = { drift };
  }
  { // The older build's spend never lands in a window this build sums: a $0.05
    // reserve, the older build's $0.20 a second later, a $0.20 reserve 12 h on.
    const s = sellerOf("d2"); const keys = U.unprovenSellerKeys(s);
    let now = 1_900_000_000_000;
    await reserve(s, 50_000, now);
    await oldReserve(c, keys, 200_000, "old-2", now + 1000, DAY);
    now += 12 * H;
    const r = await reserve(s, 200_000, now);
    let worst = 0; for (const k of keys) worst = Math.max(worst, await truthOf(k, now));
    out.overlap = { granted: r.ok, worst };
  }
  { // Cutover: what the older build booked before this build's first touch
    // counts (folded in by the rebuild), so a deploy is not a fresh day.
    const s = sellerOf("d3"); const keys = U.unprovenSellerKeys(s);
    let now = 1_900_000_000_000;
    await oldReserve(c, keys, 200_000, "old-3", now, DAY);
    now += H;
    const a = await reserve(s, 100_000, now);
    const b = await reserve(s, 50_000, now + 1);
    const aged = await reserve(s, 100_000, now - H + DAY + 1);
    out.cutover = { refused: !a.ok, spentUsd: a.spentUsd, fits: b.ok, aged: aged.ok, sum: await sumOf(keys[0]), truth: await truthOf(keys[0], now - H + DAY + 1) };
  }
  { // A negative sum is rebuilt in the same call: another replica booked $0.10
    // (straight into the store), the sum reads -$0.50, and a $0.20 reserve is
    // refused on the window's true $0.10.
    const s = sellerOf("d4"); const keys = U.unprovenSellerKeys(s);
    const now = 1_900_000_000_000;
    for (const k of keys) { const { window, sum } = U.__unprovenStoreKeys(k); await c.zAdd(window, { score: now, value: "100000|other:1" }); await c.set(sum, "-500000"); }
    const r = await reserve(s, 200_000, now + 1000);
    out.negative = { refused: !r.ok, spentUsd: r.spentUsd, first: await sumOf(keys[0]), read: await U.__unprovenWindowSums(keys, now + 1000) };
    // A sum above what its window could hold (one entry, $10 against a $0.25
    // cap) is rebuilt too, and a $0.05 reserve that fits is granted.
    for (const k of keys) await c.set(U.__unprovenStoreKeys(k).sum, "10000000");
    const g = await reserve(s, 50_000, now + 2000);
    out.oversized = { granted: g.ok, sums: await Promise.all(keys.map(sumOf)), truth: await truthOf(keys[0], now + 2000) };
  }
  { // A reserve never renews the sum's expiry: it is set when the sum is
    // built (about a day), and an add keeps whatever is left of it.
    const s = sellerOf("d5"); const keys = U.unprovenSellerKeys(s); const { sum } = U.__unprovenStoreKeys(keys[0]);
    const now = 1_900_000_000_000;
    await reserve(s, 10_000, now);
    const built = await c.pTTL(sum);
    await c.pExpire(sum, 5000);
    await reserve(s, 10_000, now + 1000);
    const after = await c.pTTL(sum);
    out.ttl = { built, after };
  }
  await closeSharedRedis();
  console.log(JSON.stringify(out));
  process.exit(0);
}

if (process.argv[2] === "replay") {
  // The replay's cap run, in a fresh process: $0.01 reserves a minute apart at the $0.25 cap.
  delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD; delete process.env.SOR_BASE_UNPROVEN_DAILY_USD;
  const U = await import("../src/base-unproven.js");
  const { getSharedRedisClient, closeSharedRedis } = await import("../src/shared-limit.js");
  const c = await getSharedRedisClient();
  const DAY = 24 * 3600_000;
  const s = { payTo: `0x${"d1".repeat(20)}`, origin: "https://d1.drift.example/x" }; const keys = U.unprovenSellerKeys(s);
  let now = Number(await c.get(U.__unprovenStoreKeys("replay-now").sum));
  const truthOf = async (k) => (await c.zRangeByScore(U.__unprovenStoreKeys(k).window, `(${now - DAY}`, "+inf")).reduce((t, e) => t + Number(String(e).split("|")[0]), 0);
  const before = await truthOf(keys[0]);
  let granted = 0, worst = 0, drift = 0;
  for (let i = 0; i < 60; i++) { now += 60_000; if ((await U.reserveUnprovenSellerSpend({ ...s, atomic: 10_000n, now, capUsd: 0.25, laneCapUsd: null })).ok) granted++; for (const k of keys) worst = Math.max(worst, await truthOf(k)); }
  const sums = await U.__unprovenWindowSums(keys, now);
  for (let j = 0; j < keys.length; j++) if (sums[j] !== await truthOf(keys[j])) drift++;
  await closeSharedRedis();
  console.log(JSON.stringify({ before, granted, worst, drift, want: (250_000 - before) / 10_000 }));
  process.exit(0);
}

if (process.argv[2] === "child") {
  // One replica: PER_PROC reservations for the seller at XC_AT, all in flight
  // at once; XC_RELEASE=1 gives every granted one back before exiting.
  delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;
  if (process.env.XC_LANE) process.env.SOR_BASE_UNPROVEN_DAILY_USD = process.env.XC_LANE; else delete process.env.SOR_BASE_UNPROVEN_DAILY_USD;
  const U = await import("../src/base-unproven.js");
  const at = Number(process.env.XC_AT) || 0;
  await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
  const seller = { payTo: process.env.XC_PAYTO, origin: process.env.XC_ORIGIN };
  const n = Number(process.env.XC_N || PER_PROC);
  // XC_DISTINCT=1: every reservation is its own seller (a fresh wallet and origin).
  const sellerFor = () => (process.env.XC_DISTINCT === "1" ? { payTo: `0x${randomBytes(20).toString("hex")}`, origin: `https://d${randomBytes(4).toString("hex")}.example` } : seller);
  const out = await Promise.all(Array.from({ length: n }, () => U.reserveUnprovenSellerSpend({ ...sellerFor(), atomic: EACH })));
  const granted = out.filter((d) => d?.ok).length;
  const laneRefused = out.filter((d) => d?.ok === false && d.code === "unproven_lane_daily_cap").length;
  const shared = out.every((d) => !d?.ok || d.handle?.shared === true);
  if (process.env.XC_RELEASE === "1") for (const d of out) if (d?.ok) U.releaseUnprovenSellerSpend(d.handle);
  await new Promise((r) => setTimeout(r, 300));
  const { closeSharedRedis } = await import("../src/shared-limit.js");
  await closeSharedRedis();
  console.log(JSON.stringify({ granted, laneRefused, shared, sharedMode: U.__sharedUnprovenSellerLedger }));
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

// The lane cap across all sellers, each run on its own prefix so the spend
// above never counts. $0.30 fits six $0.05 reservations.
for (let i = 0; i < 2; i++) {
  const lanePrefix = `${PREFIX}l${i}`;
  const at = String(Date.now() + 2500);
  const rs = await Promise.all([0, 1].map(() => replica({ SHARED_LIMITS_PREFIX: lanePrefix, XC_LANE: "0.30", XC_DISTINCT: "1", XC_N: "5", XC_AT: at })));
  const total = rs[0].granted + rs[1].granted;
  ok(rs.every((r) => r.sharedMode === true && r.shared === true), `lane race ${i + 1}: both replicas reserved on the shared store`);
  ok(total === 6 && rs[0].laneRefused + rs[1].laneRefused === 4, `lane race ${i + 1}: two replicas reserving $0.05 x 5 for ten distinct sellers grant ${total} (${rs[0].granted}+${rs[1].granted}), exactly the $0.30 lane cap, and name the lane on the rest`);
}
{
  const lanePrefix = `${PREFIX}lf`;
  const a = await replica({ SHARED_LIMITS_PREFIX: lanePrefix, XC_LANE: "0.30", XC_DISTINCT: "1", XC_N: "6" });
  const b = await replica({ SHARED_LIMITS_PREFIX: lanePrefix, XC_LANE: "0.30", ...fresh(), XC_N: "1" });
  ok(a.granted === 6 && b.granted === 0 && b.laneRefused === 1, `a lane filled on replica A refuses a fresh seller on replica B (${a.granted} then ${b.granted}, lane-refused ${b.laneRefused})`);
  const off = await replica({ SHARED_LIMITS_PREFIX: lanePrefix, XC_LANE: "off", ...fresh(), XC_N: "1" });
  ok(off.granted === 1, "...and with the lane cap switched off the same fresh seller is reserved");
  const relA = await replica({ SHARED_LIMITS_PREFIX: `${PREFIX}lr`, XC_LANE: "0.30", XC_DISTINCT: "1", XC_N: "6", XC_RELEASE: "1" });
  const relB = await replica({ SHARED_LIMITS_PREFIX: `${PREFIX}lr`, XC_LANE: "0.30", XC_DISTINCT: "1", XC_N: "6" });
  ok(relA.granted === 6 && relB.granted === 6, `lane reservations released on A free the lane's room for B (${relA.granted} then ${relB.granted})`);
}

// The running sums equal the summed windows through a random walk of
// reserves, refusals, releases (repeats included), expiries and dropped sums.
for (const seed of [7, 4242, 90001]) {
  const r = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [SELF, "fuzz"], { env: { ...process.env, SHARED_LIMITS_PREFIX: `${PREFIX}fz${seed}`, XC_SEED: String(seed) }, stdio: ["ignore", "pipe", "inherit"] });
    let out = ""; c.stdout.on("data", (d) => { out += d; });
    c.on("close", (code) => { try { resolve(childJson(out)); } catch { reject(new Error(`fuzz exited ${code}: ${out}`)); } });
  });
  ok(r.mismatches === 0 && r.reserved > 20 && r.refused > 0 && r.released > 10 && r.expired > 2 && r.dropped > 2 && r.corrupted > 2 && r.legacy > 2, `running sums (seed ${seed}): ${r.steps} steps (${r.reserved} reserved, ${r.refused} refused, ${r.released} released, ${r.expired} expiries, ${r.dropped} sums dropped, ${r.corrupted} corrupted, ${r.legacy} older-build reserves), every settled and stored sum equals the summed window (${r.mismatches} mismatches ${JSON.stringify(r.first)})`);
}

// An older build beside this one, and sums that cannot be right.
{
  const d = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [SELF, "drift"], { env: { ...process.env, SHARED_LIMITS_PREFIX: `${PREFIX}dr` }, stdio: ["ignore", "pipe", "inherit"] });
    let out = ""; c.stdout.on("data", (x) => { out += x; });
    c.on("close", (code) => { try { resolve(childJson(out)); } catch { reject(new Error(`drift exited ${code}: ${out}`)); } });
  });
  ok(d.versioned === true, "the window and sum names carry the format version, apart from the older build's window");
  const rp = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [SELF, "replay"], { env: { ...process.env, SHARED_LIMITS_PREFIX: `${PREFIX}dr` }, stdio: ["ignore", "pipe", "inherit"] });
    let out = ""; c.stdout.on("data", (x) => { out += x; });
    c.on("close", (code) => { try { resolve(childJson(out)); } catch { reject(new Error(`replay exited ${code}: ${out}`)); } });
  });
  ok(d.replay.drift === 0 && rp.drift === 0 && rp.worst <= 250_000 && rp.granted === rp.want, `replay of the overlap drift: an older-build $0.20 reserve, 36 h of 6-hourly reserves past its expiry, then a fresh process's $0.01 reserves at the $0.25 cap: every sum equals its window (${d.replay.drift}+${rp.drift} drifted), ${rp.granted} granted (want ${rp.want}), the window peaks at $${rp.worst / 1e6}`);
  ok(d.overlap.worst <= 250_000, `the older build's reserve never lands in a window this build sums: after its $0.20 the window this build sums holds $${d.overlap.worst / 1e6} (cap $0.25; granted ${d.overlap.granted})`);
  const cu = d.cutover;
  ok(cu.refused && Math.abs(cu.spentUsd - 0.2) < 1e-9 && cu.fits && cu.aged && cu.sum === cu.truth, `cutover: the older build's unexpired $0.20 counts at the first touch ($0.10 refused at $${cu.spentUsd}, $0.05 fits: ${cu.fits}), and ages out on schedule (${cu.aged}; sum ${cu.sum} = window ${cu.truth})`);
  ok(d.negative.refused && Math.abs(d.negative.spentUsd - 0.1) < 1e-9 && d.negative.first === 100_000 && d.negative.read.every((v) => v === 100_000), `a negative sum is rebuilt in the same call: a $0.20 reserve is refused on the window's $0.10 (read $${d.negative.spentUsd}; refusing window's sum ${d.negative.first}; a read rebuilds the rest: ${d.negative.read})`);
  ok(d.oversized.granted && d.oversized.sums.every((v) => v === d.oversized.truth) && d.oversized.truth === 150_000, `a sum above what its window could hold is rebuilt: a $0.05 reserve that fits is granted (sums ${d.oversized.sums}, window ${d.oversized.truth})`);
  ok(d.ttl.built > 23 * 3600_000 && d.ttl.after > 0 && d.ttl.after <= 5000, `a reserve never renews the sum's expiry (built with ${d.ttl.built} ms; ${d.ttl.after} ms left after a reserve on a sum with 5000 ms left)`);
}

console.log(`\ntest-base-unproven-cap-redis: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
