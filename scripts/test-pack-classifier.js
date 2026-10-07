#!/usr/bin/env node
// What the pack sweep excuses, and what it must never excuse.
//
// The sweep drives all 85 packs against their own published examples and is
// the guard that caught nine packs selling broken for two months. Its whole
// value rests on one line - NOT_OURS - deciding which failures are a third
// party's and which are ours. Too narrow and a CDN blip fails an unrelated
// build; too wide and the guard stops being able to fail at all, which is the
// worse direction and the harder one to notice.
//
// Both edges are pinned here because the line has now been wrong in the narrow
// direction (2026-09-12: a TLS handshake refused to the runner was graded as
// our defect and blocked a merge that touched nothing near it, while ECONN and
// ENOTFOUND one layer down were correctly reported) and probe-classify has
// been wrong in the wide direction (it once matched "upstream"/"timeout"/
// "aborted" inside a 4xx, because our own messages carry those words).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./test-pack-examples.js", import.meta.url), "utf8");
// NOT_OURS_BASE is excused for every pack; ACCESS_REFUSED only for a pack
// whose input does not name our own site (2026-10-07).
const grab = (name) => {
  const m = src.match(new RegExp(`const ${name} = (\\/.+\\/i);`));
  if (!m) { console.error(`FAIL - could not find ${name} in test-pack-examples.js`); process.exit(1); }
  return new RegExp(m[1].slice(1, -2), "i");
};
const BASE = grab("NOT_OURS_BASE"), ACCESS_REFUSED = grab("ACCESS_REFUSED");
const NOT_OURS = { test: (s) => BASE.test(s) || ACCESS_REFUSED.test(s) }; // a third-party target
const NOT_OURS_OWN_SITE = BASE; // a pack that targets agent402.tools

let n = 0;
const ok = (c, msg) => { assert.ok(c, msg); n++; };

// --- theirs: reported, never fatal -----------------------------------------
for (const [msg, why] of [
  ["Could not connect to source URL: fetch failed (ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE)", "a refused TLS handshake (the 2026-09-12 case: the same URL answered 200 elsewhere the same minute)"],
  ["write EPROTO 12345:error:0A000410:SSL routines:ssl3_read_bytes", "an EPROTO/SSL transport error"],
  ["ECONNREFUSED 1.2.3.4:443", "connection refused"],
  ["getaddrinfo ENOTFOUND api.example.com", "DNS failure"],
  ["socket hang up", "a dropped connection"],
  ["upstream returned HTTP 503", "an upstream 5xx"],
  ["rate-limited by the provider", "a provider rate limit"],
  ["HTTP 429", "too many requests"],
  ["not configured", "a key this boot deliberately lacks"],
]) ok(NOT_OURS.test(msg), `excused as upstream: ${why}`);

// --- OURS: must still fail the build ---------------------------------------
// This half is the one that matters. A classifier that excuses too much reads
// green forever, and the packs it guards sold broken for two months the last
// time nothing could see them.
for (const [msg, why] of [
  ["missing required field: url", "our own 400 on our own published example"],
  ["0/3 steps succeeded", "a pack that delivered nothing"],
  ["Cannot read properties of undefined (reading 'map')", "a programming error in our handler"],
  ["todo: step not implemented", "an unimplemented step - the exact shape of the four packs that sold broken"],
  ["spec is required", "a missing input our own step should have supplied"],
  ["invalid JSON in response", "our own parse failure"],
]) ok(!NOT_OURS.test(msg), `still OURS, still fails: ${why}`);

// A third party refusing the runner is theirs; the same refusal from our own
// site is ours. A wrong URL is ours either way.
const refused = "The host refused this server's request (HTTP 403) - this is access, not a bad URL";
ok(NOT_OURS.test(refused), "excused as upstream: a third-party host refusing the runner (seo-audit, 2026-10-07)");
ok(!NOT_OURS_OWN_SITE.test(refused), "still OURS: the same refusal when the pack targets our own site");
ok(!NOT_OURS.test("Source URL returned HTTP 404 - check the URL is correct and publicly reachable"), "still OURS: a 404 means the example URL is wrong");
ok(!NOT_OURS.test("The host refused this server's request (HTTP 404)"), "the access excuse covers 401/403/407/451 only");

// The words our own messages carry must not become an excuse on their own.
ok(!NOT_OURS.test("the tool aborted early"), "the bare word 'aborted' is not an excuse - probe-classify was corrected for exactly this");
ok(!NOT_OURS.test("network of nodes could not be built"), "the bare word 'network' is not an excuse either");

console.log(`test-pack-classifier: ${n} assertions OK`);
