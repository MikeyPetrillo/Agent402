#!/usr/bin/env node
// Does a judged /api/route answer bring a purchase? (src/route-conversion.js)
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

_routeConversionReset();
noteRouteAnswer("203.0.113.7", judgedBody, t0);
let c = noteRoutePurchase("203.0.113.7", "skill-structured-scrape", t0 + 5 * 60_000);
ok(c && c.judged === "reordered" && c.boughtTop && c.topOurs && c.minutes === 5, `a purchase of the judged top row is a conversion (${JSON.stringify(c)})`);
ok(noteRoutePurchase("203.0.113.7", "skill-structured-scrape", t0 + 6 * 60_000) === null, "one conversion per answer");

noteRouteAnswer("198.51.100.9", { results: [{ slug: "hash", seller: "self" }] }, t0);
c = noteRoutePurchase("198.51.100.9", "route-execute", t0 + 60_000);
ok(c && c.judged === "none" && !c.boughtTop && c.viaRouteExecute, "an unjudged answer is the baseline; a route-execute buy is flagged");

noteRouteAnswer("192.0.2.1", judgedBody, t0);
ok(noteRoutePurchase("192.0.2.1", "skill-structured-scrape", t0 + 31 * 60_000) === null, "outside 30 minutes is not attributed");
ok(noteRoutePurchase("192.0.2.99", "hash", t0) === null, "a caller with no answer is not attributed");

flushRouteAnswers();
const events = _testEventsForTest();
const conv = events.filter((e) => e.event === "route_conversion");
const answers = events.filter((e) => e.event === "route_answers");
ok(conv.length === 2 && conv.every((e) => !JSON.stringify(e).includes("203.0.113")), "conversions are captured with no ip in them");
ok(answers.some((e) => e.properties.judged === "reordered" && e.properties.count === 2) && answers.some((e) => e.properties.judged === "none" && e.properties.count === 1), "answers roll up by judged kind with counts");
console.log(`test-route-conversion: ${n} assertions ok`);
