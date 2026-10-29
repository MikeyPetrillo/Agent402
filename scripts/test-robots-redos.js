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

// 1b. Rules inside the wildcard cap are matched without a regex: three
// wildcards per rule, many rules, against a long non-matching path stays fast,
// and so does a robots.txt holding thousands of such rules.
{
  const groups = parseRobots(["User-agent: *", "Disallow: /*a*a*a!", "Disallow: /*a*a*a@", "Disallow: /*a*a*a%"].join("\n"));
  const start = Date.now();
  const result = robotsAllows(groups, "test-agent", "/" + "a".repeat(8000));
  const elapsed = Date.now() - start;
  ok(elapsed < 100, `three-wildcard rules against an 8000-char path resolve in <100ms (got ${elapsed}ms)`);
  ok(result.allowed === true, "a three-wildcard rule that does not match leaves the path allowed");
  const many = ["User-agent: *"];
  for (let i = 0; i < 4999; i++) many.push(`Disallow: /*a*a*a!${i}`);
  const big = parseRobots(many.join("\n"));
  const t2 = Date.now();
  robotsAllows(big, "test-agent", "/" + "a".repeat(2000));
  const e2 = Date.now() - t2;
  ok(e2 < 200, `thousands of three-wildcard rules against a 2000-char path resolve in <200ms (got ${e2}ms)`);
  const anchored = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /x*y*z\n");
  ok(robotsAllows(anchored, "t", "/a/b.pdf").allowed === false && robotsAllows(anchored, "t", "/a/b.pdf?x").allowed === true,
    "a trailing $ anchors the end; without it the rule is a prefix match");
  ok(robotsAllows(anchored, "t", "/x1y2z3").allowed === false && robotsAllows(anchored, "t", "/x1z2y").allowed === true,
    "wildcard segments must appear in order");
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

// 2. One group keeps at most 2,000 rules, so a robots.txt of thousands of
// rules costs a bounded scan per path; the first 2,000 still apply.
{
  const lines = ["User-agent: *"];
  for (let i = 0; i < 4500; i++) lines.push(`Disallow: /p${i}/`);
  const groups = parseRobots(lines.join("\n"));
  ok(groups.length === 1 && groups[0].rules.length === 2000, `a group keeps at most 2,000 rules (got ${groups[0]?.rules.length})`);
  ok(robotsAllows(groups, "test-agent", "/p1999/x").allowed === false && robotsAllows(groups, "test-agent", "/p2000/x").allowed === true,
    "the rules inside the cap apply; the ones past it are not read");
}

console.log(`\n${pass} passed`);
process.exit(0);
