// The Redis journal's claim (src/ledger-journal-redis.js) is exclusive and
// lapses: while one holder drains a journal no other holder claims anything
// from it (not even an entry added after the first claim, which would land
// ahead of an earlier one it depends on); an entry a holder claimed stays
// its own even if the drain lease is gone; and a holder that dies stops
// renewing, so its drain and its entries are claimed by the next holder once
// the lease lapses. Requires REDIS_URL (under CI a missing one fails).
import { randomBytes } from "node:crypto";
import { createClient } from "redis";

const URL = String(process.env.REDIS_URL || "").trim();
if (!URL) {
  const msg = "test-ledger-journal-claim-redis: no REDIS_URL; start a local Redis (redis-server --port 26379 --save '' --appendonly no) and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`); process.exit(0);
}
process.env.LEDGER_JOURNAL_LEASE_MS = "5000";
const jr = await import("../src/ledger-journal-redis.js");
const client = createClient({ url: URL }); client.on("error", () => {}); await client.connect();
jr.__setJournalRedisForTest(async () => client);
// The journal unrefs the client it is handed; this keeps the test alive until it is done.
const keepAlive = setInterval(() => {}, 1000);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const entry = (id) => ({ id, kind: "k", payload: { id }, at: Date.now() });
const ids = (list) => list.map((e) => e.id).join(",");
const keys = [];
const journal = (owner, key) => { keys.push(key); return jr.createRedisJournal({ key, owner }); };

try {
  {
    const key = `claim-test-${randomBytes(4).toString("hex")}`;
    const A = journal("A", key), B = journal("B", key);
    await A.add(entry("1"));
    ok(ids(await A.claim()) === "1", "A claims the free entry");
    await A.add(entry("2")); // written while A drains
    ok((await B.claim()).length === 0, "while A drains, B claims nothing, not even an entry added after A's claim");
    // A's drain lease is gone (A stalled past it) while its entry lease stands.
    await client.del(`a402:journal:{${key}}:drain`);
    const b = await B.claim();
    ok(!b.some((e) => e.id === "1"), `an entry A claimed stays A's when the drain lease is gone (B got ${ids(b)})`);
    ok(b.some((e) => e.id === "2"), "control: B claims the free entry");
  }
  {
    process.env.LEDGER_JOURNAL_LEASE_MS = "300";
    const key = `claim-lapse-${randomBytes(4).toString("hex")}`;
    const C = journal("C", key), D = journal("D", key);
    await C.add(entry("x"));
    ok(ids(await C.claim()) === "x", "C claims the entry, then dies (never renews, never releases)");
    ok((await D.claim()).length === 0, "control: inside C's lease, D claims nothing");
    await new Promise((r) => setTimeout(r, 450));
    ok(ids(await D.claim()) === "x", "once C's lease lapses, D claims C's entry");
  }
} finally {
  for (const k of keys) {
    const p = `a402:journal:{${k}}`;
    await client.del(["items", "seq", "lease", "owner", "pend", "drain", "n"].map((s) => `${p}:${s}`)).catch(() => {});
  }
  await client.quit().catch(() => {});
  clearInterval(keepAlive);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
