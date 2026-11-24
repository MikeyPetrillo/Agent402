#!/usr/bin/env node
// THIRD_PARTY_NOTICES.txt matches what scripts/gen-third-party-notices.js
// builds from the committed lockfiles and manifests, so a dependency change
// that skips the regeneration fails here; every shipped package's license is
// permissive or listed in LICENSE_EXCEPTIONS with a reason; and the list of
// published packages is derived from the tracked package.json files, so a new
// adapter is picked up without editing the generator.
//
//   node scripts/test-third-party-notices.js
//
// Offline: reads the lockfiles, manifests and `git ls-files`.
import { readFileSync } from "node:fs";
import { buildNotices, OUT, licenseVerdict, LICENSE_EXCEPTIONS, shippedRows, classifyPackages, packageClassification } from "./gen-third-party-notices.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const built = buildNotices();
let committed = "";
try { committed = readFileSync(OUT, "utf8"); } catch {}
ok(committed === built, "THIRD_PARTY_NOTICES.txt is current (else: node scripts/gen-third-party-notices.js --write)");

for (const t of ["Server image", "Facilitator image", "agent402-mcp", "Other published npm packages", "Published Python packages", "Outside npm"]) {
  ok(built.includes(t), `covers: ${t}`);
}

// ---- the license policy -------------------------------------------------------
for (const [lic, want] of [
  ["MIT", true], ["Apache-2.0", true], ["(MIT AND Zlib)", true], ["(Unlicense OR Apache-2.0)", true],
  ["(MIT OR GPL-3.0-or-later)", true], ["Apache-2.0 WITH LLVM-exception", true],
  ["BUSL-1.1", false], ["CC-BY-SA-4.0", false], ["SSPL-1.0", false], ["SEE LICENSE IN LICENSE", false],
  ["UNLICENSED", false], ["UNKNOWN", false], ["", false], ["GPL-3.0-only", false], ["LGPL-3.0-or-later", false],
  ["OSL-3.0", false], ["Some-Custom-1.0", false], ["(MIT AND GPL-2.0-only)", false], ["(MIT OR BUSL-1.1) AND SSPL-1.0", false],
]) {
  ok(licenseVerdict(lic).ok === want, `policy: "${lic}" is ${want ? "accepted" : "refused"}`);
}

const rows = shippedRows();
ok(rows.length > 300, `reads the shipped packages (${rows.length} rows)`);
const refused = rows.filter((r) => !licenseVerdict(r.effective).ok && !LICENSE_EXCEPTIONS[`${r.name}@${r.version}`]);
ok(refused.length === 0, `every shipped package is permissive or listed with a reason${refused.length ? ":\n    " + refused.map((r) => `${r.name}@${r.version} ${r.license} (${r.lock})`).join("\n    ") : ""}`);
const keys = new Set(rows.map((r) => `${r.name}@${r.version}`));
const stale = Object.keys(LICENSE_EXCEPTIONS).filter((k) => !keys.has(k) || licenseVerdict(rows.find((r) => `${r.name}@${r.version}` === k).effective).ok);
ok(stale.length === 0, `every license exception names a shipped package that needs it${stale.length ? ": " + stale.join(", ") : ""}`);
ok(Object.values(LICENSE_EXCEPTIONS).every((why) => typeof why === "string" && why.trim().length >= 10), "every license exception carries a reason");

// ---- the package list is derived --------------------------------------------
const manifests = {
  "package.json": { private: true, dependencies: { a: "1" } },
  "mcp/package.json": { name: "agent402-mcp" },
  "facilitator/package.json": { private: true, dependencies: { a: "1" } },
  "client/package.json": { name: "agent402-client" },
  "adapters/newone/package.json": { name: "agent402-newone", dependencies: { zod: "^3" } },
  "examples/demo/package.json": { private: true, dependencies: { a: "1" } },
  "services/live/package.json": { private: true },
  "services/newsvc/package.json": { private: true, dependencies: { express: "^5" } },
};
const c = classifyPackages(Object.keys(manifests), (f) => manifests[f]);
ok(c.published.includes("adapters/newone") && c.published.includes("client"), "a new adapter's package.json is picked up as a published package");
ok(!c.published.includes("mcp") && !c.published.includes(""), "the lockfile sections are not listed twice");
ok(JSON.stringify(c.unclassified) === JSON.stringify(["services/newsvc"]), "a private package with dependencies that no section covers is reported");
const live = packageClassification();
ok(live.unclassified.length === 0, `every tracked package.json with dependencies is covered${live.unclassified.length ? ": " + live.unclassified.join(", ") : ""}`);
for (const dir of live.published) {
  const name = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), "utf8")).name;
  ok(built.includes(`  ${name} (`), `lists the published package ${name}`);
}
ok(/agent402-structured-tools \(adapters\/langchain-py\/\)\n {4}dependencies: requests/.test(built), "the Python package's dependencies are read from its pyproject.toml");

const unknown = built.split("\n").filter((l) => /^ {2}\S+@\S+ {2}/.test(l) && /UNKNOWN/.test(l));
ok(unknown.every((l) => built.includes(`${l.trim().split(/\s+/)[0]} declares no license`)), "a package with no declared license is called out in the notes");
ok(readFileSync(new URL("../NOTICE", import.meta.url), "utf8").includes("THIRD_PARTY_NOTICES.txt"), "NOTICE points at THIRD_PARTY_NOTICES.txt");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
