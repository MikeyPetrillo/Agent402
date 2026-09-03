// A documented path is not a callable URL.
//
// We publish crawled seller routes to buyers. A path the seller never
// substitutes - "/stock/{symbol}", "/api/v1/hosts/:domain" - is documentation,
// and handing an agent that URL as if it were payable spends its money and its
// time on a 422 that will never become a 402.
//
// The brace dialect was handled. Two others were not, and both reached
// production: a seller using Express-style ":domain", and a manifest that
// URL-encoded its own braces to "%7Bdomain%7D". Reported 2026-08-30 by the
// seller himself, whose row we published with TWO placeholder routes priced at
// $0.02 while the one working URL sat beside them. His second point is the one
// we could not have seen from here: a prober that tries the documented path
// records the SELLER as unpayable, for a service that answers 402 correctly.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
const line = /const URL_TEMPLATE_RE = (\/.*\/);/.exec(src);
ok(!!line, "URL_TEMPLATE_RE is still declared where the test can read it");
const RE = new RegExp(/const URL_TEMPLATE_RE = \/(.*)\/;/.exec(src)[1]);

// Templates: uncallable, must be flagged.
for (const p of [
  "/stock/{symbol}",
  "/v1/x/{arg}",
  "/api/v1/hosts/:domain",
  "/api/v1/hosts/:domain/refresh",
  "/api/v1/hosts/%7Bdomain%7D?refresh=1",
  "/api/v1/hosts/%7bdomain%7d",
]) ok(RE.test(p), `template flagged: ${p}`);

// Concrete URLs: callable, must NOT be flagged. A false positive here hides a
// real seller's real route, which is worse than the bug being fixed.
for (const p of [
  "/api/v1/hosts/allbirds.com?refresh=1",
  "/api/uuid",
  "/v1/chat/completions",
  "/api/time/12:30",              // a colon that is not a path parameter
  "/api/ratio/16:9",
  "/api/hash",
]) ok(!RE.test(p), `concrete route not flagged: ${p}`);

// The row still has to SAY which parameters it wants - we return the row rather
// than hiding the seller, so the agent needs to know what to substitute.
const g = /const URL_TEMPLATE_RE_G = \/(.*)\/g;/.exec(src);
ok(!!g, "the extraction regex is declared");
const REG = new RegExp(g[1], "g");
const names = (route) => [...route.matchAll(REG)].map((m) => m[1] || m[2] || m[3]).filter(Boolean);
ok(names("/stock/{symbol}")[0] === "symbol", "brace parameter name extracted");
ok(names("/api/v1/hosts/:domain")[0] === "domain", "colon parameter name extracted");
ok(names("/api/v1/hosts/%7Bdomain%7D")[0] === "domain", "encoded parameter name extracted");

// STATEFULNESS: the predicate must not be /g. A global regex advances lastIndex
// between .test() calls and alternates true/false, which the file already warns
// about - so re-assert it, because widening the pattern is exactly when someone
// would paste the /g version into both places.
ok(!/const URL_TEMPLATE_RE = \/.*\/[a-z]*g/.test(src), "the predicate regex is NOT global (a /g .test() alternates)");
const twice = ["/stock/{symbol}", "/stock/{symbol}"].map((p) => RE.test(p));
ok(twice[0] === true && twice[1] === true, "the same template tests true twice in a row");

// EVERY accessor that publishes a route must say when it is a template.
// The flag first shipped inside routeQuery only, so /api/route knew and
// /api/index did not - and /api/index is the seller-detail view, where the
// placeholder was still advertised at $0.02 with nothing to mark it. This file
// already carried the warning for a sibling field: "Rides with originResponded
// on ALL THREE accessors on purpose: this file has twice shipped a field
// present on two of three, which is inert on whichever surface happens to
// render." Same trap, third time.
ok(/function urlTemplateProjection\(t\)/.test(src), "the projection is shared, not inlined in one accessor");
const callSites = (src.match(/\.\.\.urlTemplateProjection\(t\),/g) || []).length;
ok(callSites >= 2, `every crawled-seller projection uses it (${callSites} call sites)`);
ok(/\.\.\.priceConflictProjection\(t\),\n\s*\.\.\.urlTemplateProjection\(t\),/.test(src),
   "sellerDetail (/api/index?seller=) carries the flag beside its sibling projection");
ok(!/URL_TEMPLATE_RE\.test\(t\.route \|\| ""\) \?/.test(src),
   "the inline copy inside routeQuery is gone - one definition, not two");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
