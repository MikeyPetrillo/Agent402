// What public copy says about a data source's arrangement matches the record.
//   - Nager.Date: the holiday data is used under a sponsorship held for this
//     service; no changelog item, credit or attribution comment says the
//     company itself is the sponsor (the sponsor account is not the
//     company's), and the credit sentence stays as the terms ask;
//   - the wholesale compute family does not say it has no outside data
//     source: it holds tools that compute over public facts (published
//     exchange calendars, sellers' own published listings), and its source
//     line says so.
//
//   node scripts/test-attribution-wording.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const { CHANGELOG_ENTRIES } = await import("../src/changelog.js");
const { NAGER_ATTRIBUTION } = await import("../src/data-attribution.js");
const { WHOLESALE_FAMILIES } = await import("../src/wholesale.js");
const { FREE_TIER_SLUGS } = await import("../src/free-tier.js").catch(() => ({}));

// A sentence that makes the company the sponsor.
const COMPANY_SPONSORS = /\b(Agent402|Havok Holdings(?: LLC)?|we)\s+(?:also\s+)?sponsors?\b|\bsponsored by (?:Agent402|Havok Holdings)/i;
const nagerItems = CHANGELOG_ENTRIES.flatMap((e) => e.items).filter((i) => /Nager\.Date/.test(i));
ok(nagerItems.length > 0, `the changelog credits Nager.Date (${nagerItems.length} item(s))`);
ok(nagerItems.every((i) => !COMPANY_SPONSORS.test(i)), `no /changelog item says the company sponsors Nager.Date${nagerItems.filter((i) => COMPANY_SPONSORS.test(i)).map((i) => `\n    ${i.slice(0, 120)}`).join("")}`);
const md = read("CHANGELOG.md").replace(/\n\s*/g, " ");
const mdHits = md.split(/ - /).filter((s) => /Nager\.Date/.test(s) && COMPANY_SPONSORS.test(s));
ok(mdHits.length === 0, `no CHANGELOG.md item says the company sponsors Nager.Date${mdHits.map((s) => `\n    ${s.slice(0, 120)}`).join("")}`);
// README and every other tracked markdown file (wiki/, docs/, the package
// READMEs) say the same: the sponsorship is held for this service.
{
  const { execFileSync } = await import("node:child_process");
  const files = execFileSync("git", ["ls-files", "*.md"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).split("\n").filter((f) => f && f !== "CHANGELOG.md");
  const hits = files.filter((f) => COMPANY_SPONSORS.test(read(f).replace(/\n\s*/g, " ")));
  ok(files.includes("README.md") && hits.length === 0, `no markdown file says the company sponsors a source (${hits.join(", ") || `${files.length} files read`})`);
}
const attr = read("src/data-attribution.js");
ok(!COMPANY_SPONSORS.test(attr), "src/data-attribution.js does not say the company sponsors a source");
ok(nagerItems.some((i) => /sponsorship (?:held )?for this service/.test(i)), "the changelog's Nager.Date credit says the sponsorship is held for this service");
ok(NAGER_ATTRIBUTION === "Holiday data by Nager.Date.", `the credit sentence itself is unchanged (${NAGER_ATTRIBUTION})`);
// Control: the pattern reads the old wording.
ok(COMPANY_SPONSORS.test("Holiday data by Nager.Date, which Agent402 sponsors; every tool that serves it carries the credit."), "control: the old wording is caught");

const compute = WHOLESALE_FAMILIES.find((f) => f.id === "compute");
ok(!!compute, "the wholesale surface has a compute family");
ok(!/no outside data/i.test(compute.source), `the compute family does not say it has no outside data source (${compute.source})`);
ok(/public facts/i.test(compute.source) && /calendar/i.test(compute.source) && /listing/i.test(compute.source), `the compute family's source names the public facts some of its tools read (${compute.source})`);
// The facts the source line names are in the proof-of-work set it is built from.
const free = new Set(FREE_TIER_SLUGS || (read("src/free-tier.js").match(/"[a-z0-9-]+"/g) || []).map((s) => s.slice(1, -1)));
ok(free.has("market-calendar") && (free.has("seller-trust") || free.has("x402-market-pulse")), "control: a calendar tool and a listings tool are proof-of-work tools, so the compute family holds them");

console.log(`\ntest-attribution-wording: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
