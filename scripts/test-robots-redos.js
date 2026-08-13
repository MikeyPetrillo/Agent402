// SECURITY REGRESSION: robots-check's wildcard-to-regex translation used to
// let a single caller control both sides of a catastrophic-backtracking
// regex (a chained-wildcard Disallow rule from the TARGET SITE'S OWN
// robots.txt, matched against the CALLER'S OWN request path) — a single
// $0.002 request could freeze the whole server's shared event loop.
// Fixed by capping wildcards per rule in src/tools/kit.js's robotsAllows().
// This proves the fix stays fast on the pathological shape AND that normal
// robots.txt behavior (0-3 wildcards) is completely unaffected.
import { parseRobots, robotsAllows } from "../src/tools/kit.js";

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

// 1. The pathological shape must resolve near-instantly, not hang. Before the
// fix, 7 chained wildcards alone measured ~1.6s and 8+ effectively hung;
// this uses 20 against a long deliberately-non-matching path — many times
// past where the pre-fix code was already unusable.
{
  const evilPath = "/" + "a*".repeat(20) + "!";
  const groups = parseRobots(`User-agent: *\nDisallow: ${evilPath}\n`);
  const longNonMatch = "/" + "a".repeat(500) + "X";
  const start = Date.now();
  const result = robotsAllows(groups, "test-agent", longNonMatch);
  const elapsed = Date.now() - start;
  ok(elapsed < 200, `pathological wildcard rule resolves in <200ms (got ${elapsed}ms)`);
  // The over-wildcarded rule is skipped entirely (treated as absent), so with
  // no other rule the default is allow — not a false "blocked" verdict either.
  ok(result.allowed === true && result.matchedRule === null,
    "over-wildcarded rule is skipped (safe default: allowed, no match) rather than silently blocking");
}

// 2. Normal, real-world robots.txt behavior is unaffected (0-2 wildcards).
{
  const groups = parseRobots([
    "User-agent: *",
    "Disallow: /admin/",
    "Disallow: /private/*.pdf",
    "Allow: /private/public.pdf",
    "Disallow: /search*results*",
  ].join("\n"));

  ok(robotsAllows(groups, "test-agent", "/admin/secret").allowed === false,
    "plain (no-wildcard) Disallow rule still blocks");
  ok(robotsAllows(groups, "test-agent", "/blog/post-1").allowed === true,
    "path outside any rule is still allowed");
  ok(robotsAllows(groups, "test-agent", "/private/secret.pdf").allowed === false,
    "single-wildcard Disallow rule still blocks");
  ok(robotsAllows(groups, "test-agent", "/private/public.pdf").allowed === true,
    "more-specific Allow rule still overrides a shorter Disallow (longest-match-wins preserved)");
  ok(robotsAllows(groups, "test-agent", "/search?q=x&results=1").allowed === false,
    "two-wildcard Disallow rule still blocks (within the new cap, unaffected)");
}

// 3. A rule at exactly the cap boundary (3 wildcards) still applies; one over
// (4) is the first to be skipped — confirms the cap is where the fix intends.
{
  const groups = parseRobots([
    "User-agent: *",
    "Disallow: /a*b*c*d",
    "Disallow: /w*x*y*z*q",
  ].join("\n"));
  ok(robotsAllows(groups, "test-agent", "/a1b2c3d").allowed === false,
    "rule with exactly 3 wildcards (at the cap) still matches and blocks");
  ok(robotsAllows(groups, "test-agent", "/w1x2y3z4q").allowed === true,
    "rule with 4 wildcards (over the cap) is skipped, so an otherwise-matching path is allowed");
}

console.log(`\n${pass} passed`);
process.exit(0);
