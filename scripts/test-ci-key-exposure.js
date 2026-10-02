// Which PAID upstream keys can CI actually spend, and is every tool that
// reaches one bounded?
//
// WHY THIS IS DERIVED AND NOT A LIST. The CI-spend leak has happened four
// times - Brave (three times), E2B, CoinGecko - and each fix added one name to
// a hand-maintained set in test-brave-leak.js. A list only ever knows about
// the leaks that already happened; it cannot know about the kit somebody adds
// next month, which is exactly how Brave recurred after being "fixed".
//
// So this derives both sides from source:
//   left  = every credential a kit reads from process.env
//   right = every credential the deploy workflow hands to a TEST lane
// The intersection is what CI can spend. For each of those, every slug in the
// kit that reads it must be excluded from the catalog sweeps (METERED_SLUGS),
// or the sweep buys on every push.
//
// The finding that justified writing it: 36 slugs across seven kits read
// ALCHEMY_API_KEY, which is pay-as-you-go and IS a repository secret. They are
// safe today only because no test lane passes that key, so they fall back to
// public RPCs. That is a configuration accident, not a guarantee - one `env:`
// line away from burning CU on every push, with nothing to catch it.
import { readFileSync, readdirSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const deploy = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const nonMetered = readFileSync(new URL("./test-non-metered-examples.js", import.meta.url), "utf8");
// METERED_SLUGS lives in src/metered-slugs.js (the server publishes its count).
const meteredSrc = readFileSync(new URL("../src/metered-slugs.js", import.meta.url), "utf8");

// --- METERED_SLUGS, the set both catalog sweeps skip -----------------------
// Balanced-bracket scan, not indexOf("]);"): the set literal contains nested
// brackets in comments, and the naive cut read 24 of 147 slugs - a guard that
// silently sees a sixth of the set would have "found" leaks everywhere.
const mStart = meteredSrc.indexOf("METERED_SLUGS = new Set([");
let depth = 0, mEnd = mStart;
for (let i = meteredSrc.indexOf("[", mStart); i < meteredSrc.length; i++) {
  const ch = meteredSrc[i];
  if (ch === "[") depth++;
  else if (ch === "]") { depth--; if (depth === 0) { mEnd = i; break; } }
}
const mBody = meteredSrc.slice(mStart, mEnd);
const METERED = new Set([...mBody.matchAll(/"([a-z0-9][a-z0-9-]*)"/g)].map((m) => m[1]));
ok(METERED.size > 100, `read METERED_SLUGS from source (${METERED.size} slugs)`);

// EXCLUSION IS NOT THE ONLY LEGITIMATE BOUND. CoinGecko is deliberately kept
// bounded by SAMPLING rather than exclusion: the sweeps drive two of the
// family per commit so somebody exercises them, and the family is handed over
// as one unit (coingeckoFamilyKeys, 2026-09-07). That is a real bound with its
// own guard in test-brave-leak rule 7, so treating it as unbounded here would
// be a false alarm - and a guard that cries wolf gets suppressed by the next
// author, which is worse than not having it.
const cgStart = nonMetered.indexOf("COINGECKO_SLUGS = new Set([");
let cgDepth = 0, cgEnd = cgStart;
for (let i = nonMetered.indexOf("[", cgStart); i < nonMetered.length && cgStart > -1; i++) {
  const ch = nonMetered[i];
  if (ch === "[") cgDepth++;
  else if (ch === "]") { cgDepth--; if (cgDepth === 0) { cgEnd = i; break; } }
}
const SAMPLED = new Set(cgStart > -1 ? [...nonMetered.slice(cgStart, cgEnd).matchAll(/"([a-z0-9][a-z0-9-]*)"/g)].map((m) => m[1]) : []);
ok(SAMPLED.size > 10, `read the sampled CoinGecko family from source (${SAMPLED.size} slugs)`);
// Attribution here is FILE-LEVEL: a slug is credited with every paid
// credential its kit file reads. That over-reports, because kits are grouped by
// subject and not by upstream - so a tool can sit in a file that reads a key it
// never calls. Each exemption below was verified by reading the handler's own
// outbound host, and carries that host as its reason. A future entry must do
// the same: "it looked fine" is not a reason.
const NOT_REACHED = new Map([
  ["crypto-orderbook", "CoinGecko: calls api.exchange.coinbase.com, verified in the handler"],
  ["defi-tvl", "CoinGecko: calls api.llama.fi, verified in the handler - and test-non-metered already asserts !COINGECKO_SLUGS.has(\"defi-tvl\")"],
]);
const bounded = (slug) => METERED.has(slug) || SAMPLED.has(slug) || NOT_REACHED.has(slug);

// --- credentials handed to a TEST lane -------------------------------------
// Only `env:` entries inside a job that runs test steps count. The deploy and
// publish jobs legitimately carry many more, and they run no sweeps.
const testLaneEnv = new Set();
for (const m of deploy.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*\$\{\{\s*secrets\.([A-Z][A-Z0-9_]*)\s*\}\}/gm)) {
  testLaneEnv.add(m[1]);
}
ok(testLaneEnv.size > 0, `read the workflow's secret->env bindings (${testLaneEnv.size})`);

// --- PAID upstreams. A key that costs money when called, per call or quota. --
// Settlement/infra credentials (RAILWAY_TOKEN, burner keys, POW_SECRET) are
// NOT here: they are not spent by driving a catalog route, which is the only
// thing a sweep does.
const PAID = new Set([
  "BRAVE_API_KEY", "BRAVE_ANSWERS_API_KEY", "BRAVE_SUGGEST_API_KEY",
  "E2B_API_KEY", "COINGECKO_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY",
  "ALCHEMY_API_KEY", "EXA_API_KEY", "EXA_KEY", "X_BEARER_TOKEN",
  "HUNTER_API_KEY", "APOLLO_API_KEY", "NEYNAR_API_KEY", "WARPCAST_API_KEY",
]);

// --- which kit reads which credential, and what slugs it owns ---------------
const kitDir = new URL("../src/tools/", import.meta.url);
const readers = new Map(); // credential -> Set(slug)
for (const f of readdirSync(kitDir).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(new URL(f, kitDir), "utf8");
  const creds = new Set([...src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]).filter((c) => PAID.has(c)));
  if (!creds.size) continue;
  const slugs = [...src.matchAll(/slug:\s*"([a-z0-9][a-z0-9-]*)"/g)].map((m) => m[1]);
  for (const c of creds) {
    if (!readers.has(c)) readers.set(c, new Set());
    for (const s of slugs) readers.get(c).add(s);
  }
}
ok(readers.size > 0, `resolved which kits read a paid credential (${readers.size} credentials)`);

// --- THE RULE ---------------------------------------------------------------
// For every paid credential CI can spend, every slug reaching it must be
// excluded from the sweeps. A tool that is NOT in METERED_SLUGS is driven by
// both catalog sweeps on every push.
const spendable = [...readers.keys()].filter((c) => testLaneEnv.has(c));
console.log(`\n  paid credentials a TEST lane can spend: ${spendable.length ? spendable.join(", ") : "(none)"}`);
for (const cred of spendable) {
  const unswept = [...readers.get(cred)].filter((s) => !bounded(s));
  ok(unswept.length === 0,
    `${cred}: every slug reaching it is bounded (excluded or sampled)${unswept.length ? ` - UNBOUNDED: ${unswept.slice(0, 12).join(", ")}` : ""}`);
}

// --- the ones that are safe only because no lane carries the key ------------
// Reported, not asserted: this is the standing hazard, and naming it is how
// the next person adding an `env:` line learns what it would cost.
const dormant = [...readers.keys()].filter((c) => !testLaneEnv.has(c));
console.log(`\n  paid credentials NO test lane carries (safe by configuration, not by guard):`);
for (const cred of dormant.sort()) {
  const unswept = [...readers.get(cred)].filter((s) => !bounded(s));
  const note = unswept.length
    ? `${unswept.length} swept slug(s) would start spending if a lane ever sets it`
    : "all its slugs are already excluded from the sweeps";
  console.log(`    ${cred.padEnd(24)} ${note}`);
}

console.log(`\ntest-ci-key-exposure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
