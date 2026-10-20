#!/usr/bin/env node
// Does a /api/route or /api/find answer bring a settled call? (src/route-conversion.js)
// Offline: PostHog in test-capture mode, a fixed caller-hash secret.
import assert from "node:assert/strict";
process.env.POSTHOG_TEST_CAPTURE = "1";
process.env.POW_SECRET = "test-secret";
const { noteRouteAnswer, noteRoutePurchase, flushRouteAnswers, _routeConversionReset } = await import("../src/route-conversion.js");
const { _testEventsForTest } = await import("../src/posthog.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const t0 = Date.parse("2026-09-24T12:00:00Z");
const judgedBody = { results: [{ slug: "skill-structured-scrape", seller: "self" }, { slug: "pdf-extract-pages", seller: "self" }], judged: { method: "judged", confidence: 0.99 } };
const tieBody = { results: [{ slug: "hash", seller: "self" }, { slug: "sha256", seller: "self" }], judged: { method: "judged-tie", confidence: 0.9, tiedWith: "sha256", tieBrokenBy: "price" } };
const PAID = { rail: "usdc", wire: "x402", paid: true };
const POW = { rail: "pow", wire: null, paid: false };

_routeConversionReset();
noteRouteAnswer("203.0.113.7", judgedBody, t0);
let c = noteRoutePurchase("203.0.113.7", "skill-structured-scrape", t0 + 5 * 60_000, PAID);
ok(c && c.judged === "reordered" && c.boughtTop && c.boughtAnyRow && c.topOurs && c.minutes === 5, `a purchase of the judged top row is a conversion (${JSON.stringify(c)})`);
ok(c.source === "route" && c.rail === "usdc" && c.wire === "x402" && c.paid === true, "the conversion carries the surface and the sale's rail, wire and paid flag");
ok(noteRoutePurchase("203.0.113.7", "skill-structured-scrape", t0 + 6 * 60_000, PAID) === null, "one paid conversion per answer");

noteRouteAnswer("198.51.100.9", { results: [{ slug: "hash", seller: "self" }] }, t0);
c = noteRoutePurchase("198.51.100.9", "route-execute", t0 + 60_000, PAID);
ok(c && c.judged === "none" && !c.boughtTop && !c.boughtAnyRow && c.viaRouteExecute, "an unjudged answer is the baseline; a route-execute buy is flagged");

noteRouteAnswer("192.0.2.1", judgedBody, t0);
ok(noteRoutePurchase("192.0.2.1", "skill-structured-scrape", t0 + 31 * 60_000, PAID) === null, "outside 30 minutes is not attributed");
ok(noteRoutePurchase("192.0.2.99", "hash", t0, PAID) === null, "a caller with no answer is not attributed");

// A judged tie is a judged answer: its own kind, never the lexical bucket.
noteRouteAnswer("192.0.2.10", tieBody, t0);
c = noteRoutePurchase("192.0.2.10", "sha256", t0 + 2 * 60_000, PAID);
ok(c && c.judged === "tie" && !c.boughtTop && c.boughtAnyRow, `a judged-tie answer is counted as "tie"; the second row bought sets boughtAnyRow only (${JSON.stringify(c)})`);

// A free PoW call after an answer is noted once, unpaid, and leaves the answer
// open for the purchase that follows it.
noteRouteAnswer("192.0.2.20", judgedBody, t0);
c = noteRoutePurchase("192.0.2.20", "skill-structured-scrape", t0 + 60_000, POW);
ok(c && c.paid === false && c.rail === "pow" && c.wire === null, "a PoW call is a conversion with paid=false");
ok(noteRoutePurchase("192.0.2.20", "skill-structured-scrape", t0 + 2 * 60_000, POW) === null, "a second free call on the same answer is not noted again");
c = noteRoutePurchase("192.0.2.20", "pdf-extract-pages", t0 + 3 * 60_000, { rail: "credits", wire: null, paid: true });
ok(c && c.paid === true && c.rail === "credits" && c.boughtAnyRow && !c.boughtTop, "the paid call after the free try still attributes, as paid");
ok(noteRoutePurchase("192.0.2.20", "pdf-extract-pages", t0 + 4 * 60_000, PAID) === null, "the paid call closed the answer");
ok(noteRoutePurchase("192.0.2.20", "hash", t0 + 4 * 60_000, POW) === null, "closed for free calls too");

// A synthetic answer (heartbeat, status probe) is tallied as synthetic and
// never attributes a purchase.
noteRouteAnswer("192.0.2.30", judgedBody, t0, { source: "route", synthetic: true });
ok(noteRoutePurchase("192.0.2.30", "skill-structured-scrape", t0 + 60_000, PAID) === null, "a synthetic answer is not remembered for attribution");

// /api/find is the control: same window, same hashed caller, source "find".
// A find row carries no seller field and is ours.
const findBody = { query: "hash a string", count: 2, results: [{ slug: "hash", name: "Hash", route: "POST /api/hash", price: 0.001 }, { slug: "sha256", name: "SHA-256", route: "POST /api/sha256", price: 0.001 }] };
noteRouteAnswer("192.0.2.40", findBody, t0, { source: "find" });
c = noteRoutePurchase("192.0.2.40", "sha256", t0 + 4 * 60_000, PAID);
ok(c && c.source === "find" && c.judged === "none" && c.topOurs && !c.boughtTop && c.boughtAnyRow && c.minutes === 4, `a find answer attributes with source "find" (${JSON.stringify(c)})`);
noteRouteAnswer("192.0.2.41", findBody, t0, { source: "find" });
ok(noteRoutePurchase("192.0.2.41", "hash", t0 + 31 * 60_000, PAID) === null, "find uses the same 30-minute window");
noteRouteAnswer("192.0.2.42", findBody, t0, { source: "find", synthetic: true });
ok(noteRoutePurchase("192.0.2.42", "hash", t0 + 60_000, PAID) === null, "a synthetic find answer is not remembered either");

flushRouteAnswers();
const events = _testEventsForTest();
const conv = events.filter((e) => e.event === "route_conversion");
const answers = events.filter((e) => e.event === "route_answers");
const ips = ["203.0.113", "198.51.100", "192.0.2"];
ok(conv.length === 6 && !events.some((e) => ips.some((ip) => JSON.stringify(e).includes(ip))), `conversions and answers are captured with no ip in them (${conv.length})`);
ok(conv.every((e) => typeof e.properties.paid === "boolean" && typeof e.properties.rail === "string" && typeof e.properties.boughtAnyRow === "boolean" && ["route", "find"].includes(e.properties.source)), "every conversion event carries source, rail, paid and boughtAnyRow");
ok(conv.filter((e) => e.properties.paid).length === 5 && conv.filter((e) => e.properties.rail === "pow").length === 1, "paid conversions are separable from free ones by the event's own fields");
const tallyOf = (f) => answers.filter(f).reduce((s, e) => s + e.properties.count, 0);
ok(tallyOf((e) => e.properties.source === "route" && e.properties.judged === "reordered" && !e.properties.synthetic) === 3, "route answers roll up by judged kind with counts");
ok(tallyOf((e) => e.properties.source === "route" && e.properties.judged === "tie" && !e.properties.synthetic) === 1, "ties roll up under their own kind");
ok(tallyOf((e) => e.properties.source === "route" && e.properties.judged === "none" && !e.properties.synthetic) === 1, "lexical route answers roll up as none");
ok(tallyOf((e) => e.properties.source === "route" && e.properties.synthetic) === 1 && tallyOf((e) => e.properties.source === "find" && e.properties.synthetic) === 1, "synthetic answers are tallied apart, on both surfaces");
ok(tallyOf((e) => e.properties.source === "find" && !e.properties.synthetic && e.properties.topOurs) === 2, "find answers roll up under source find");
ok(answers.every((e) => typeof e.properties.synthetic === "boolean" && ["route", "find"].includes(e.properties.source)), "every answers event carries source and synthetic");
console.log(`test-route-conversion: ${n} assertions ok`);
