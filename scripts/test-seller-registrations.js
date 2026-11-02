// Locks the self-serve seller conversion/churn table (2026-08-16 audit).
// Before this, submittedSeeds (POST /api/index/register) was a bare
// Set<origin> with no timestamps at all - no way to answer "of everyone who
// registered via /sell, how many are still live, and how many ever actually
// settled a payment" without hand-diffing crawl-cache JSON snapshots.
//
// Two layers tested:
//   1. stats.js's seller_registrations table directly: first_seen is set once
//      and never moves, last_routable_seen always advances, last_settled_seen
//      is sticky (a later "not settled this cycle" call must never erase a
//      previously-observed settlement).
//   2. x402-index.js's registerOrigin() wiring: a fresh self-serve
//      registration creates a row; re-registering an already-known origin
//      (the early-return cache-hit path) still records an observation.
//
// Offline - no network, no server boot. registerOrigin uses an injected fake
// crawler (same pattern as test-index-register.js); getLeaderboardSnapshot()
// naturally returns its cold "warming, empty leaderboard" shape with no
// server boot, so originHasSettled() is exercised (returns false) without
// needing a real on-chain snapshot.
//
//   node scripts/test-seller-registrations.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { registerOrigin, __testResetSubmitted } from "../src/x402-index.js";
import { recordSellerRegistrationSeen, getSellerRegistrations } from "../src/stats.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. stats.js layer, directly ---
const origin1 = `https://seller-reg-test-1-${Date.now()}.example`;
recordSellerRegistrationSeen(origin1, { settled: false });
let row = getSellerRegistrations().find((r) => r.origin === origin1);
ok(!!row, "a fresh origin gets a seller_registrations row");
ok(typeof row.first_seen === "number" && row.first_seen > 0, "first_seen is stamped");
ok(row.last_routable_seen === row.first_seen, "last_routable_seen matches first_seen on first observation");
ok(row.last_settled_seen === null, "last_settled_seen stays null when not settled");

const firstSeenOriginal = row.first_seen;
await wait(5);
recordSellerRegistrationSeen(origin1, { settled: true });
row = getSellerRegistrations().find((r) => r.origin === origin1);
ok(row.first_seen === firstSeenOriginal, "first_seen is immutable across repeated observations");
ok(row.last_routable_seen > firstSeenOriginal, "last_routable_seen advances on a later observation");
ok(typeof row.last_settled_seen === "number" && row.last_settled_seen > firstSeenOriginal, "last_settled_seen is stamped once a settlement is observed");

const settledAt = row.last_settled_seen;
await wait(5);
recordSellerRegistrationSeen(origin1, { settled: false }); // this cycle saw no settlement
row = getSellerRegistrations().find((r) => r.origin === origin1);
ok(row.last_settled_seen === settledAt, "last_settled_seen is STICKY - a later non-settled observation never erases a prior settlement");
ok(row.last_routable_seen > settledAt, "last_routable_seen still advances even when settled is false this cycle");

// --- 2. x402-index.js registerOrigin() wiring ---
__testResetSubmitted();
const origin2 = `https://seller-reg-test-2-${Date.now()}.example`;
const goodCrawl = async (o) => ({ manifest: { name: "Ext" }, tools: [{ slug: "a" }], error: null, history: [true] });

let r = await registerOrigin(origin2, { crawl: goodCrawl });
ok(r.listed === true, "sanity: the injected registration succeeds");
row = getSellerRegistrations().find((x) => x.origin === origin2);
ok(!!row, "a real self-serve registration via registerOrigin() creates a seller_registrations row");
ok(row.last_settled_seen === null, "no leaderboard match in this offline run -> never recorded as settled");

const firstSeen2 = row.first_seen;
await wait(5);
r = await registerOrigin(origin2, { crawl: goodCrawl }); // cache hit - the early-return path
ok(r.listed === true, "re-registering an already-known origin still succeeds (cache-hit path)");
row = getSellerRegistrations().find((x) => x.origin === origin2);
ok(row.first_seen === firstSeen2, "re-registration does not reset first_seen");
ok(row.last_routable_seen > firstSeen2, "re-registration (cache-hit path) still advances last_routable_seen");

__testResetSubmitted();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
