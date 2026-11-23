// The credits failed-key bound keeps the shared store O(1) per client
// (src/credits.js noteBadKey): a flood of failed lookups from one client
// writes one fixed counter (an increment and an expiry), never one entry per
// lookup, and writes nothing more once the client is held. A valid key is
// still served throughout.
//
// Run on the memory backend, and with REDIS_URL on a REAL Redis as well
// (the CI lane runs it with REDIS_URL; under CI a missing one fails).
//
//   node scripts/test-credits-badkey-redis.js
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-credits-badkey-redis.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { guardsTable } from "./lib/credits-guards-table.js"; // a random private credits table (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const redisUrl = process.env.REDIS_URL || "";
if (!redisUrl && process.env.CI) { console.error("FAIL - REDIS_URL is required under CI (a skipped integration test is not coverage)"); process.exit(1); }
delete process.env.STATE_DATABASE_URL;
const TMP = mkdtempSync(join(tmpdir(), "badkey-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
process.env.CREDITS_DIR = TMP;
const BAD = 10_000;
// The bound and its window come from the private table drawn for this run.
const { failedMax: max, windowMs: WINDOW_MS } = guardsTable().badKey;

const { createCredits } = await import("../src/credits.js");
const { shared } = await import("../src/shared-limits.js");
const { limiterKey } = await import("../src/rate-limit.js");
const SECRET = "test-tag-secret";
const cr = createCredits({ stripe: {}, baseUrl: "https://agent402.tools", storeDir: TMP, tagSecret: SECRET, log: () => {} });
const tagOf = (v) => createHmac("sha256", SECRET).update(`credits-badkey|${v}`).digest("hex").slice(0, 24);
const settle = () => new Promise((r) => setTimeout(r, 50));

// Fresh clients each run, so a store an earlier run wrote to reads nothing of theirs.
const r8 = () => Math.floor(Math.random() * 250) + 1, h16 = () => Math.floor(Math.random() * 0xffff).toString(16);
const V6 = `2001:db8:${h16()}:${h16()}`;
for (const client of [`203.0.${r8()}.${r8()}`, `${V6}:aaaa::1`]) {
  const tag = tagOf(limiterKey(client));
  for (let i = 0; i < BAD; i++) { cr.noteBadKey(client); if (i % 500 === 0) await settle(); }
  await settle();
  const c = await shared.counterGet("credits-badkey", tag);
  ok(c?.ok && Number(c.value) <= max + 1, `${redisUrl ? "redis" : "memory"}: ${BAD} failed lookups from ${client} leave one counter at the bound (${c?.value}), not one entry each`);
  const w = await shared.windowRead("credits-badkey", tag, { windowMs: WINDOW_MS });
  ok(!w?.ok || Number(w.count) === 0, `${redisUrl ? "redis" : "memory"}: no per-lookup window entries are written (${w?.count ?? "none"})`);
  ok(await cr.badKeyHeld(client), `${redisUrl ? "redis" : "memory"}: the client is held past the bound`);
}
// The same /64 counts as one client.
ok(await cr.badKeyHeld(`${V6}:bbbb::9`), "another address in the same IPv6 /64 is the same client");

if (redisUrl) {
  const { getSharedRedisClient } = await import("../src/shared-limit.js");
  const client = await getSharedRedisClient?.();
  if (client) {
    const keys = await client.keys("*credits-badkey*");
    const types = await Promise.all(keys.map((k) => client.type(k)));
    ok(keys.length > 0 && types.every((t) => t === "string"), `redis: the failed-key state is fixed counters only (${keys.length} key(s): ${[...new Set(types)].join(",")})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
