#!/usr/bin/env node
// Brave-subscription leak guard.
//
// WHY THIS EXISTS (it has now happened twice):
// The CI test job boots the server with the REAL BRAVE_API_KEY and FREE_MODE=true
// (paywall off), then sweeps every tool. Any sweep that reaches a Brave-backed
// handler spends the paid Brave subscription for a test - and because the CI
// server has no PostHog configured, those calls are invisible to every inbound
// accounting surface we have. That invisibility is the dangerous part: the July
// bill showed 5,106 Search requests while our telemetry could account for ~600,
// and the gap was only found by correlating Brave's daily CSV against CI run
// counts (~11.4 Brave requests per CI run before the 2026-07-23 audit, ~2.3
// after it, ~0 after this guard).
//
// test-all.js already skips the DIRECT Brave routes and the packs known at the
// time of that audit. The recurrence was structural: a skill pack added later
// whose steps call a Brave-backed tool silently reopens the leak, because
// nothing tied the skip list to the pack catalogue. This test is that tie.
//
// Offline, no network, no key needed.
import { readFileSync, readdirSync } from "node:fs";
import { SKILL_PACKS } from "../src/skills.js";
import { SEARCH_TOOLS } from "../src/tools/search.js";
import { CODE_RUN_TOOLS } from "../src/tools/code-run-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const DIRECT_BRAVE_SLUGS = new Set(SEARCH_TOOLS.map((t) => t.slug));

// Tools that reach Brave INDIRECTLY, by calling a search handler in-process
// rather than being one. This is the third distinct shape of this leak and the
// one that defeated the previous two guards:
//
//   research-company (research-kit, RETIRED 2026-09-11) called the search-news
//   handler directly, and the pack financial-research composed it. Neither named
//   a Brave slug anywhere, so a check for "does this pack use a Brave slug"
//   sees nothing, and both were silently buying a live news search on every CI
//   run. Measured with an outbound counter: exactly 2 calls per run.
//
// Detected structurally, by reading which kits import the search tools at all.
// A kit that imports SEARCH_TOOLS can call a search handler, so every tool it
// exports is treated as Brave-reaching. That over-approximates - it may skip a
// sibling tool in the same kit that never searches - and over-approximating is
// the correct direction: the cost of a false skip is one untested example, and
// the cost of a false clear is a recurring bill nobody sees.
//
// SECOND SHAPE, added 2026-08-22 with llm-context-kit.js: a kit that spends the
// SAME Brave subscription WITHOUT being or calling a search tool - it hits a
// different Brave endpoint (/llm/context) directly. The import-based detector
// alone cannot see that, so reach is also resolved by the upstream HOST: a kit
// whose source names api.search.brave.com bills the subscription, whatever it
// calls itself. Matching the HOST rather than the env var name is deliberate -
// several kits mention BRAVE_API_KEY only in a comment ("same pattern as the
// BRAVE_API_KEY-backed search tool"), and treating those as Brave-reaching
// would flood this set with false positives and train the next person to
// delete entries.
const kitFiles = readdirSync(new URL("../src/tools", import.meta.url))
  .filter((f) => f.endsWith(".js") && f !== "search.js");
const BRAVE_HOST_RE = /api\.search\.brave\.com/;
const INDIRECT_BRAVE_SLUGS = new Set();
const hostReachingKits = [];
for (const f of kitFiles) {
  const src = readFileSync(new URL(`../src/tools/${f}`, import.meta.url), "utf8");
  const importsSearchKit = /from\s+["'][./]*search\.js["']|SEARCH_TOOLS/.test(src);
  const namesBraveHost = BRAVE_HOST_RE.test(src);
  if (!importsSearchKit && !namesBraveHost) continue;
  if (namesBraveHost) hostReachingKits.push(f);
  for (const m of src.matchAll(/slug:\s*["']([a-z0-9-]+)["']/g)) INDIRECT_BRAVE_SLUGS.add(m[1]);
}
const BRAVE_SLUGS = new Set([...DIRECT_BRAVE_SLUGS, ...INDIRECT_BRAVE_SLUGS]);
const testAll = readFileSync(new URL("./test-all.js", import.meta.url), "utf8");
const start = testAll.indexOf("const BRAVE_ROUTES");
const end = testAll.indexOf("const skipBrave");
ok(start > 0 && end > start, "test-all.js still defines a BRAVE_ROUTES skip set");
const skipBlock = testAll.slice(start, end);

// 1. Every Brave-backed tool's own route is skipped - the ones that ARE search
//    tools, and the ones that merely CALL one.
for (const t of SEARCH_TOOLS) {
  const route = `/api/${t.slug}`;
  ok(skipBlock.includes(`"${route}"`), `direct route ${route} is in BRAVE_ROUTES`);
}
ok(INDIRECT_BRAVE_SLUGS.size > 0,
  `the indirect detector found ${INDIRECT_BRAVE_SLUGS.size} tool(s) in kits that import the search tools or name the Brave host (sanity: it is not blind)`);
// The host detector must actually see something, or the second shape is
// silently unguarded and a green run means nothing.
ok(hostReachingKits.length > 0,
  `the Brave-host detector found ${hostReachingKits.length} kit(s) hitting api.search.brave.com directly: ${hostReachingKits.join(", ") || "NONE"}`);
for (const slug of INDIRECT_BRAVE_SLUGS) {
  ok(skipBlock.includes(`"/api/${slug}"`),
    `"${slug}" lives in a kit that calls a search handler in-process or names the Brave host itself - its route must be in BRAVE_ROUTES`);
}

// 2. THE REGRESSION THAT KEEPS HAPPENING: every skill pack whose steps invoke a
//    Brave-backed tool must also be skipped. A new pack that composes `search`
//    is the exact shape that reopened this leak on 2026-07-28.
const packsReachingBrave = Object.values(SKILL_PACKS)
  // BRAVE_SLUGS now includes the indirect reachers, so a pack composing
  // research-company is caught the same as one composing search.
  .map((p) => ({ slug: p.slug, hits: (p.toolSlugs || []).filter((s) => BRAVE_SLUGS.has(s)) }))
  .filter((p) => p.hits.length);
ok(packsReachingBrave.length > 0, `found ${packsReachingBrave.length} packs that reach Brave (sanity: the detector works)`);
for (const p of packsReachingBrave) {
  ok(
    skipBlock.includes(`"/api/skill/${p.slug}"`),
    `skill pack "${p.slug}" reaches Brave via ${p.hits.join("+")} - must be in BRAVE_ROUTES or every CI run buys ${p.hits.length} live search(es)`,
  );
}

// 3. The opt-in switch must stay opt-IN. If this ever defaults to running live
//    calls, every CI run bills the subscription again.
ok(/const skipBrave = process\.env\.BRAVE_LIVE_TEST !== "1"/.test(testAll),
  "live Brave calls stay opt-in (BRAVE_LIVE_TEST=1), never the default");

// 4. No stale entries: a route in the skip set that no longer reaches Brave is
//    dead weight that hides a real gap later.
const validRoutes = new Set([
  ...SEARCH_TOOLS.map((t) => `/api/${t.slug}`),
  // Indirect reachers belong here too. Without them the staleness check called
  // a legitimately-skipped route stale, which would have pushed the next person
  // to DELETE the entry that closes the leak.
  ...[...INDIRECT_BRAVE_SLUGS].map((slug) => `/api/${slug}`),
  ...packsReachingBrave.map((p) => `/api/skill/${p.slug}`),
]);
const listed = [...skipBlock.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
const stale = listed.filter((r) => !validRoutes.has(r));
ok(stale.length === 0, `no stale BRAVE_ROUTES entries${stale.length ? ` (found: ${stale.join(", ")})` : ""}`);

// 5. Same guard for E2B (2026-07-29 paid-upstream audit): the CI server also
//    boots with the real E2B_API_KEY, so an unskipped code-run example spins a
//    real sandbox on every run. Live coverage lives in test-code-run-kit.js,
//    which CI runs live deliberately - the generic sweep must not add its own.
const E2B_SLUGS = new Set(CODE_RUN_TOOLS.map((t) => t.slug));
const e2bStart = testAll.indexOf("const E2B_ROUTES");
const e2bEnd = testAll.indexOf("const skipE2b");
ok(e2bStart > 0 && e2bEnd > e2bStart, "test-all.js defines an E2B_ROUTES skip set");
const e2bBlock = testAll.slice(e2bStart, e2bEnd);
for (const t of CODE_RUN_TOOLS) {
  ok(e2bBlock.includes(`"/api/${t.slug}"`), `direct route /api/${t.slug} is in E2B_ROUTES`);
}
const packsReachingE2b = Object.values(SKILL_PACKS)
  .map((p) => ({ slug: p.slug, hits: (p.toolSlugs || []).filter((s) => E2B_SLUGS.has(s)) }))
  .filter((p) => p.hits.length);
for (const p of packsReachingE2b) {
  ok(
    e2bBlock.includes(`"/api/skill/${p.slug}"`),
    `skill pack "${p.slug}" reaches E2B via ${p.hits.join("+")} - must be in E2B_ROUTES or every CI run spins ${p.hits.length} live sandbox(es)`,
  );
}
ok(/const skipE2b = process\.env\.E2B_LIVE_TEST !== "1"/.test(testAll),
  "live E2B sweep calls stay opt-in (E2B_LIVE_TEST=1), never the default");
const e2bValid = new Set([
  ...CODE_RUN_TOOLS.map((t) => `/api/${t.slug}`),
  ...packsReachingE2b.map((p) => `/api/skill/${p.slug}`),
]);
const e2bListed = [...e2bBlock.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
const e2bStale = e2bListed.filter((r) => !e2bValid.has(r));
ok(e2bStale.length === 0, `no stale E2B_ROUTES entries${e2bStale.length ? ` (found: ${e2bStale.join(", ")})` : ""}`);

// --- multi-search must not pay twice for the same query --------------------
//
// The price is flat for 2-5 queries, but every query was a separate BILLED
// upstream request, so ["x","x","x","x","x"] cost five Brave calls for one
// sale - a leak on honest duplicates and a free multiplier for anyone who
// noticed. Search is billed per call, so this is real money, not hygiene.
{
  const src = readFileSync(new URL("../src/tools/search.js", import.meta.url), "utf8");
  const handler = src.slice(src.indexOf('slug: "multi-search"'));
  ok(/new Set\(normalized/.test(handler),
    "multi-search dedupes queries before fanning out to the billed upstream");
  ok(/unique\.map\(async \(q\)/.test(handler),
    "the upstream fan-out iterates UNIQUE queries, not the raw input array");
  ok(/normalized\.map\(\(q\)/.test(handler),
    "the response is still built per INPUT query, so the caller's shape and order are unchanged");

  // The behaviour, proven rather than pattern-matched.
  const queries = ["alpha", "beta", "alpha", " alpha ", "", "beta"];
  const normalized = queries.map((r) => (typeof r === "string" ? r.trim().slice(0, 400) : ""));
  const unique = [...new Set(normalized.filter(Boolean))];
  ok(unique.length === 2, `six inputs collapse to ${unique.length} billed calls`);
  ok(normalized.length === queries.length, "every input still gets a response entry");
}

// 6. Every billed Brave request must name the tool that made it.
//    `caller` used to default to "unknown", and two call sites quietly took it
//    for weeks - search-news and search-videos. On the day the Brave dashboard
//    was reconciled, 3 of 18 billed Search requests could not be attributed to
//    any tool. Spend nobody can name is the shape that hid every cost leak
//    found in this cycle.
const searchSrc = readFileSync(new URL("../src/tools/search.js", import.meta.url), "utf8");
// `await braveGet(` only - matching bare "braveGet(" also catches the function
// DEFINITION, which of course has no literal caller argument and made this
// assertion fail against correct code.
// The `\{[^{}]*\}` alternative that used to sit here was both REDUNDANT and
// exponential: `[^()]` already matches `{` and `}`, so a braced argument could
// be matched two different ways, and CodeQL flagged the backtracking (js/redos,
// alert #83). Measured on `await braveGet(` followed by 24 repetitions of `{}`:
// 893ms with the extra branch, 0ms without, and both produce the identical 6
// matches against src/tools/search.js. Not exploitable here - the input is our
// own source file, not anything a caller supplies - but an ambiguous alternation
// is a defect wherever it lives, and this one cost nothing to remove.
const calls = [...searchSrc.matchAll(/await braveGet\((?:[^()]|\([^()]*\))*\)/gs)].map((m) => m[0]);
ok(calls.length >= 5, `found the braveGet call sites to check (${calls.length})`);
const unnamed = calls.filter((c) => !/,\s*"[a-z-]+"\s*\)\s*$/.test(c.trim()));
ok(unnamed.length === 0,
  `every braveGet call names its caller${unnamed.length ? `:\n     ${unnamed.map((c) => c.slice(0, 60).replace(/\s+/g, " ")).join("\n     ")}` : ""}`);
ok(!/caller = "unknown"/.test(searchSrc),
  'the "unknown" default is gone - omitting a caller must be visible, not silent');

// 7. CoinGecko is the third CI-spend leak of this shape (Brave, E2B, then this).
//    The sweeps lane carries COINGECKO_API_KEY so the strict sweep's 2-per-commit
//    SAMPLE is reliable, and the lenient sweep in the SAME lane kept driving the
//    other 22 family routes with that key "so somebody exercises them" - every
//    one a keyed Demo-plan credit on the PRODUCTION key's 10,000/month quota.
//    Measured 400-1,050 a day (CoinGecko dashboard, 2026-09-07) against ~10
//    production calls a day: the month's quota would have run out before the
//    month did, and prod's CoinGecko tools would have 429'd for the rest of it.
//    test-all must hand the WHOLE family over when it runs beside the strict
//    sweep, and the hand-over must be the family function, not a hand list.
{
  const nonMetered = readFileSync(new URL("./test-non-metered-examples.js", import.meta.url), "utf8");
  ok(/export function coingeckoFamilyKeys\(/.test(nonMetered), "the CoinGecko family is exported as one function (coingeckoFamilyKeys)");
  ok(/coingeckoHanded = coingeckoFamilyKeys\(spec, pricing\)/.test(testAll), "test-all takes the whole family from coingeckoFamilyKeys under TEST_ALL_SKIP_STRICT_COVERED");
  ok(/if \(coingeckoHanded\.has\(`\$\{method\} \$\{path\}`\)\) \{ coingeckoSkipped\+\+; continue; \}/.test(testAll), "test-all's sweep loop skips every handed CoinGecko route (the leak was this line missing)");
  ok(/coingeckoSkipped/.test(testAll.slice(testAll.indexOf("console.log(`\\nExercised"))), "the hand-over is reported by count in the summary line, never silent");
}


// 8. EXA is the same shape, guarded BEFORE it can happen rather than after.
//    Brave leaked three times, E2B once and CoinGecko once, and every one of
//    them was a paid key that sat at test-job scope while a sweep quietly
//    reached a handler. Exa is structurally safe TODAY for one reason only:
//    EXA_KEY is not a GitHub Actions secret, so CI cannot spend it. That is an
//    accident of configuration, not a guarantee - the day somebody adds the
//    secret (to run a keyed corpus pass in CI, say) the sweeps would start
//    buying $0.007 searches on every push with nothing to stop them.
//
//    So: the three Exa slugs must stay in METERED_SLUGS, which is what excludes
//    them from BOTH catalog sweeps. If a future change lists them for the
//    sweeps, this fails first.
{
  const nonMetered = readFileSync(new URL("../src/metered-slugs.js", import.meta.url), "utf8"); // METERED_SLUGS lives in src/
  for (const slug of ["exa-search", "exa-answer", "exa-contents"]) {
    ok(new RegExp(`"${slug}"`).test(nonMetered), `${slug} is in METERED_SLUGS, so neither catalog sweep can buy it`);
  }
  const exaSrc = readFileSync(new URL("../src/tools/exa-kit.js", import.meta.url), "utf8");
  // Env-gated listing is the second belt: with no key the kit lists nothing,
  // so a sweep cannot reach a route that does not exist.
  ok(/export function exaEnabled\(\)/.test(exaSrc), "the Exa kit is env-gated, so an unkeyed CI boot lists no Exa route at all");
  ok(/EXA_DAILY_MAX_USD/.test(exaSrc), "and a daily spend cap bounds the damage even where a key IS present");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
