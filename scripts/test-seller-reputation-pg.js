// Seller reputation on the state database (src/seller-reputation.js): the
// pass writes the whole record as one row in pieces built across turns and
// reads it back whole; a pass held by another holder's lease is skipped and
// the replica reads the holder's row instead; delivery outcomes from two
// processes are merged into one row, neither dropping the other's.
// Requires STATE_DATABASE_URL (CI fails without it).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { requireTestPg } from "./lib/test-pg.js";
import { EventEmitter } from "node:events";
requireTestPg({ label: "test-seller-reputation-pg" });
process.env.X402_INDEX_CRAWL = "off";
const sdb = await import("../src/state-db.js");
const R = await import("../src/seller-reputation.js");
const { requestTimingMiddleware, currentRequestScope } = await import("../src/request-timing.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const now = Date.now();
const DAY = 86_400_000;

// An index of 1,000 sellers, each with a crawl, a paywall reading and a priced row.
const entries = () => Array.from({ length: 1000 }, (_, i) => [`https://s${i}.example`, {
  fetchedAt: now - 1000, error: null, originResponded: true,
  paywall: { ok: i % 10 !== 0, status: i % 10 ? 402 : 500, at: now - 500, ms: 100 + i },
  tools: [{ method: "GET", route: "/a", price: 0.01, originDeclaredPrice: 0.01, quoteObservedAt: now - DAY }],
}]);

const r1 = await R.reputationPassUnleased({ entries, now });
ok(r1.ok && r1.sellers === 1000, `the pass folds the index and saves (${r1.sellers} sellers)`);
const row = await sdb.documents.get(R.REPUTATION_DOC);
ok(row && Object.keys(row.body.sellers).length === 1000 && row.body.sellers["https://s7.example"].lc === now - 1000, "the row holds every seller, written in pieces and read back whole");
ok(row.body.updatedAt === now && typeof row.body.since === "number", "the row carries when it was computed and when records began");

// A second pass with the same readings records nothing twice.
await R.reputationPassUnleased({ entries, now: now + 1000 });
const again = await sdb.documents.get(R.REPUTATION_DOC);
ok(R.seriesTotals(again.body.sellers["https://s7.example"].c, now + 1000).n === 1, "a second pass over the same crawl records it once");

// Another holder's lease: the leased pass is skipped and this replica reads the row.
const held = await sdb.leases.acquire("seller-reputation-pass", { owner: "other-replica", ttlMs: 60_000 });
ok(held === true, "another replica holds the pass's lease");
const leasedPass = sdb.leased("seller-reputation-pass", { ttlMs: 60_000, log: () => {} }, () => R.reputationPassUnleased({ entries, now: now + 2000 }));
const skipped = await leasedPass();
ok(skipped?.skipped === "leased", `a pass under another holder's lease is skipped (${JSON.stringify(skipped)})`);
R.__resetReputationForTest();
const reload = await R.reloadReputation();
ok(reload.ok && R.reputationStatus().sellers === 1000, "the replica that did not run the pass reads the holder's row");
const rep = R.sellerReputation("https://s3.example", { now: now + 2000 });
ok(rep.metrics.manifestUptime.sampleSize === 1 && rep.metrics.manifestUptime.status === "not-enough-data", "a lookup reads the stored record");

// Delivery outcomes from two processes merge into one row.
const inRequest = (fn) => new Promise((resolve) => {
  const res = new EventEmitter(); res.statusCode = 200; res.writableFinished = true; res.headersSent = true; res.locals = {};
  requestTimingMiddleware(() => "t")({ ip: "127.0.0.1" }, res, () => { currentRequestScope().isOurs = () => false; resolve(fn()); });
});
R.__setReputationEnabledForTest(true);
for (let i = 0; i < 3; i++) await inRequest(() => R.noteSellerDeliveryOutcome("https://s1.example", { ok: true, url: "https://s1.example/a" }));
const f1 = await R.flushDeliveryOutcomes({ now });
// The other process's flush, applied as its own update of the same row.
const { createJsonDocument } = await import("../src/json-document.js");
const other = createJsonDocument({ name: R.DELIVERY_DOC, log: () => {} });
const f2 = await other.update((b) => R.mergeDelivery(b, { "https://s1.example": { d: [Math.floor(now / DAY), 0, 2], r: {} } }, now), { fallback: null });
await inRequest(() => R.noteSellerDeliveryOutcome("https://s1.example", { ok: true, url: "https://s1.example/a" }));
const f3 = await R.flushDeliveryOutcomes({ now });
const d = await sdb.documents.get(R.DELIVERY_DOC);
const s1 = d?.body?.o?.["https://s1.example"];
ok(f1.ok && f2.ok && f3.ok && s1 && s1.d[1] === 4 && s1.d[2] === 6, `two processes' outcomes add up in one row (${s1 ? `${s1.d[1]}/${s1.d[2]}` : "none"})`);
ok(s1?.r?.["GET /a"]?.[2] === 4, "the route's own count holds this process's outcomes");

await sdb.__dropStateSchema();
await sdb.closeStateDb();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
