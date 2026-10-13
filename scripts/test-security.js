// Security regressions from the deep audit. Calls handlers directly and asserts
// the hardening holds: no prototype pollution, hostile input yields a clean 4xx
// (not a 500), and the DoS-prone tools stay bounded.
import { KIT2 } from "../src/tools/kit2.js";
import { KIT } from "../src/tools/kit.js";
import { AGENT_TOOLS } from "../src/tools/agent-kit.js";
import { HTML_TOOLS } from "../src/tools/html-kit.js";
import { ENRICH_TOOLS } from "../src/tools/enrich-kit.js";

const bySlug = Object.fromEntries(
  [...KIT2, ...KIT, ...AGENT_TOOLS, ...HTML_TOOLS, ...ENRICH_TOOLS].map((t) => [t.slug, t])
);
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const call = (slug, input) => bySlug[slug].handler(input);

// 1. Prototype pollution via json-flatten (unflatten) must be rejected, and must
//    not pollute Object.prototype.
for (const payload of [{ "__proto__.polluted": "YES" }, { "constructor.prototype.pwned": "X" }]) {
  let threw = false;
  try { await call("json-flatten", { json: payload, mode: "unflatten" }); } catch (e) { threw = true; if (e.statusCode !== 400) fail(`json-flatten should 400 on unsafe key, got statusCode ${e.statusCode}`); }
  if (!threw) fail(`json-flatten must reject path ${JSON.stringify(payload)}`);
}
if (({}).polluted !== undefined || ({}).pwned !== undefined) fail("Object.prototype was polluted!");
console.log("1. json-flatten blocks prototype pollution ✓");

// 2. stats must return a clean 400 (not a 500) on a non-JSON `numbers` string.
let threw = false;
try { await call("stats", { numbers: "AAAA" }); } catch (e) { threw = true; if (e.statusCode !== 400) fail(`stats should 400 on bad input, got statusCode ${e.statusCode}`); }
if (!threw) fail("stats should reject non-array numbers");
console.log("2. stats returns 400 (not 500) on bad input ✓");

// 3. xml-to-json must reject deeply-nested XML fast (no event-loop DoS).
{
  const xml = "<a>".repeat(5000) + "x" + "</a>".repeat(5000);
  const t0 = Date.now();
  let threw = false;
  try { await call("xml-to-json", { xml }); } catch (e) { threw = true; if (e.statusCode !== 400) fail(`xml-to-json should 400 on deep nesting, got ${e.statusCode}`); }
  const ms = Date.now() - t0;
  if (!threw) fail("xml-to-json should reject deeply-nested XML");
  if (ms > 1000) fail(`xml-to-json depth guard too slow: ${ms}ms`);
  console.log(`3. xml-to-json rejects deep nesting fast (${ms}ms) ✓`);
}

// 4. redact / extract-entities email regex must stay bounded on a long no-@ run.
{
  const text = "A".repeat(99000);
  for (const slug of ["redact", "extract-entities"]) {
    const t0 = Date.now();
    await call(slug, { text });
    const ms = Date.now() - t0;
    if (ms > 1000) fail(`${slug} email regex too slow on long input: ${ms}ms`);
    console.log(`4. ${slug} bounded on 99k no-@ input (${ms}ms) ✓`);
  }
}

// 5. Prototype-pollution sweep across every object-building tool. json-flatten
//    (dot-path unflatten) rejects unsafe keys with a 400; json-merge recursively
//    merges caller keys and must strip proto keys instead of writing through to
//    Object.prototype. After every hostile call, Object.prototype must stay clean.
{
  // json-flatten: dot-path setter — must 400 on __proto__/constructor.prototype paths.
  const FLATTEN_POLLUTERS = [{ "__proto__.a5": 1 }, { "constructor.prototype.b5": 1 }, { "constructor.prototype": { c5: 1 } }];
  for (const p of FLATTEN_POLLUTERS) {
    let threw = false;
    try { await call("json-flatten", { json: p, mode: "unflatten" }); } catch (e) { threw = e.statusCode === 400; }
    if (!threw) fail(`json-flatten must 400 on unflatten path ${JSON.stringify(p)}`);
  }
  // json-merge: recursive key merge — must never write a proto key through to the prototype.
  const MERGE_POLLUTERS = [
    { a: JSON.parse('{"__proto__":{"d5":"x"}}'), b: {} },
    { a: {}, b: JSON.parse('{"__proto__":{"e5":"x"}}') },
    { a: JSON.parse('{"constructor":{"prototype":{"f5":"x"}}}'), b: {} },
  ];
  for (const args of MERGE_POLLUTERS) {
    // json-merge sanitizes rather than 400s (it strips proto keys) — the contract
    // here is "no pollution", so we only require it not to throw a 500.
    try { await call("json-merge", args); } catch (e) { if (e.statusCode === undefined || e.statusCode >= 500) fail(`json-merge 500 on ${JSON.stringify(args)}`); }
  }
  for (const k of ["a5", "b5", "c5", "d5", "e5", "f5"]) {
    if (({})[k] !== undefined) fail(`Object.prototype polluted with ${k}!`);
  }
  console.log("5. proto-pollution blocked across json-flatten + json-merge ✓");
}

// 6. ReDoS sweep: every tool that compiles a CALLER-supplied regex must reject the
//    classic catastrophic-backtracking shape (a+)+$ (or sandbox it) and return
//    within 2s on a large hostile input — never freeze the shared event loop.
{
  const evil = "a".repeat(50000) + "!";
  const REGEX_CASES = [
    ["regex", { pattern: "(a+)+$", text: "a".repeat(9000) + "!", flags: "" }], // worker-sandboxed (hard timeout)
    ["json-validate", { data: evil, schema: { type: "string", pattern: "(a+)+$" } }], // compileUserRegex guard
    ["html-links", { html: `<a href="${evil}">x</a>`, filter: "(a+)+$" }], // compileUserRegex guard
  ];
  for (const [slug, input] of REGEX_CASES) {
    const t0 = Date.now();
    try { await call(slug, input); } catch (e) {
      if (e.statusCode === undefined || e.statusCode < 400 || e.statusCode >= 500) fail(`${slug} ReDoS input must 4xx, got statusCode ${e.statusCode}`);
    }
    const ms = Date.now() - t0;
    if (ms > 2000) fail(`${slug} ReDoS: ${ms}ms on hostile input (>2s = event-loop DoS)`);
    console.log(`6. ${slug} bounded on (a+)+$ hostile input (${ms}ms) ✓`);
  }
}

// 7. Path-traversal sweep: github-repo interpolates owner/repo into a /repos/:o/:r
//    URL. "..", absolute paths, and URL-encoded traversal must be rejected with a
//    400 BEFORE any fetch — owner=".." would normalize /repos/../<x> off-path.
{
  const TRAVERSAL_OWNERS = ["..", "../..", "%2e%2e", "../../etc", "/etc/passwd", "a/../b"];
  const TRAVERSAL_REPOS = ["..", "../secret", "%2e%2e", "a/../b"];
  for (const owner of TRAVERSAL_OWNERS) {
    let threw = false;
    try { await call("github-repo", { owner, repo: "x" }); } catch (e) { threw = e.statusCode === 400; }
    if (!threw) fail(`github-repo must 400 on traversal owner ${JSON.stringify(owner)}`);
  }
  for (const repo of TRAVERSAL_REPOS) {
    let threw = false;
    try { await call("github-repo", { owner: "octocat", repo }); } catch (e) { threw = e.statusCode === 400; }
    if (!threw) fail(`github-repo must 400 on traversal repo ${JSON.stringify(repo)}`);
  }
  console.log("7. github-repo rejects path traversal in owner/repo ✓");
}

console.log("\nsecurity regressions: all passed ✓");
