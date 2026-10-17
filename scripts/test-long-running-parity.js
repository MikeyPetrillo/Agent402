// The Algorand sweep's "expected no AVM accept" rule must match the SERVER's.
//
// A tool advertises no algorand accept for two legitimate reasons, and the
// weekly sweep has to know both or it reports a design decision as a rail that
// silently went away. On 2026-08-24 it did exactly that for three media tiers:
// the sweep was right to ask, and the answer lived in a local const inside
// server.js that it had no way to reach.
//
// Both predicates are now imported from the server. This pins that they are
// imported rather than restated, because a copy is what drifts.
import { readFileSync } from "node:fs";
import { isLongRunningSlug, EXPENSIVE_COMPOSITE_SLUGS, LONG_RUNNING_SLUGS } from "../src/composite-spend-guard.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// --- the predicate itself ---------------------------------------------------
for (const slug of ["v1-images-fast", "v1-images-pro", "v1-images-edit", "v1-videos"]) {
  ok(isLongRunningSlug(slug), `${slug} is long-running, so EVM exact only and no AVM accept is CORRECT`);
}
ok(isLongRunningSlug("research-max") && isLongRunningSlug("dossier"),
  "the report composites are long-running too");
ok(!isLongRunningSlug("uuid") && !isLongRunningSlug("hash") && !isLongRunningSlug(""),
  "an ordinary tool is not, so a missing AVM accept there is still a real regression");
// The union covers both sets. Note that today they OVERLAP - v1-videos is in
// each - so LONG_RUNNING_SLUGS is currently redundant. That is worth stating
// rather than asserting a tidier fiction: the union is the rule, and the second
// set exists so a future route can be long-running without being an expensive
// composite, which is a different reason for the same restriction.
for (const slug of [...EXPENSIVE_COMPOSITE_SLUGS, ...LONG_RUNNING_SLUGS]) {
  if (!isLongRunningSlug(slug)) { ok(false, `${slug} is in a set but not covered by the predicate`); break; }
}
ok([...EXPENSIVE_COMPOSITE_SLUGS, ...LONG_RUNNING_SLUGS].every((s) => isLongRunningSlug(s)),
  "the predicate covers the union of both sets, whichever reason a route is in");

// --- ONE definition, imported by both ---------------------------------------
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const canary = readFileSync(new URL("./algorand-rail-canary.js", import.meta.url), "utf8");

  ok(/import \{[^}]*isLongRunningSlug[^}]*\} from "\.\/composite-spend-guard\.js"/.test(server),
    "server.js imports the predicate instead of keeping its own set");
  ok(!/const LONG_RUNNING_SLUGS = new Set/.test(server),
    "and no longer defines a local copy - the local const is what the sweep could not see");
  ok(/import \{ isLongRunningSlug \} from "\.\.\/src\/composite-spend-guard\.js"/.test(canary),
    "the sweep imports the same predicate");
  ok(/isIdentityBoundRoute\(t\) \|\| isLongRunningSlug\(t\.slug\)/.test(canary),
    "and treats BOTH legitimate reasons as expected, not just the identity-bound one");
  ok(/def\.longRunning = true/.test(server) && /isLongRunningSlug\(def\.slug\)/.test(server),
    "the server still marks routes longRunning from that same predicate, so the accepts and the sweep agree");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
