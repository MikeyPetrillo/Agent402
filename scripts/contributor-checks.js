// `npm test`: the fast offline checks a contributor's change most often
// trips, run one after another with a summary. No server, no network, no key;
// about half a minute. The full suite is the CI lanes (scripts/ci/lanes/), and
// the catalog sweeps need a booted server (CONTRIBUTING.md, "Test your change").
//
//   npm test
//   node scripts/contributor-checks.js --list   (print the suites, run nothing)
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

// [suite, what it holds a change to]
export const CONTRIBUTOR_SUITES = [
  ["scripts/test-kit2.js", "exact outputs of the pure-CPU tools"],
  ["scripts/test-convert.js", "the conversion tools"],
  ["scripts/test-memory.js", "the memory store"],
  ["scripts/test-retired-routes.js", "every published route is live, key-gated or retired (node scripts/published-slugs.js --write after adding a tool)"],
  ["scripts/test-page-dates.js", "sitemap dates are current (node scripts/gen-page-dates.js --write after editing a page module or kit)"],
  ["scripts/test-config-reference.js", "every environment variable is documented (node scripts/gen-config-reference.js --write)"],
  ["scripts/test-price-prose.js", "prices in prose are derived from the catalog"],
  ["scripts/test-copy-absolutes.js", "public claims are scoped"],
  ["scripts/test-us-spelling.js", "US spelling"],
  ["scripts/test-no-em-dash-shipped.js", "no em dashes in shipped copy"],
  ["scripts/test-hidden-chars.js", "no hidden characters in instruction files"],
  ["scripts/test-upstream-costs.js", "no upstream rate in the tree"],
  ["scripts/test-port-hygiene.js", "tests bind port 0"],
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--list")) {
    for (const [s, why] of CONTRIBUTOR_SUITES) console.log(`${s}  ${why}`);
    process.exit(0);
  }
  const failed = [];
  for (const [suite, why] of CONTRIBUTOR_SUITES) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [suite], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status === 0) console.log(`pass  ${suite} (${secs} s)`);
    else {
      failed.push(suite);
      console.log(`FAIL  ${suite} (${secs} s): ${why}`);
      const tail = `${r.stdout || ""}${r.stderr || ""}`.split("\n").filter((l) => /FAIL|Error|error/.test(l)).slice(0, 12);
      for (const l of tail) console.log(`      ${l.slice(0, 300)}`);
    }
  }
  console.log(`\n${CONTRIBUTOR_SUITES.length - failed.length} of ${CONTRIBUTOR_SUITES.length} suites passed${failed.length ? `; failing: ${failed.join(", ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}
