// Fonts are redistributed here, and every one is under the SIL Open Font
// License 1.1, whose condition 2 requires the copyright notice and the licence
// to be distributed WITH the font files.
//
// These are subsetted woff2 builds: the name table that would normally carry
// the licence is stripped to save bytes, so the licence cannot travel inside
// the binary and has to travel beside it. A font added without one is a licence
// violation that no other check in this repository would catch - it is not a
// test failure, a lint warning or a broken page, just a quiet breach.
//
// The family->licence match is deliberately loose (first token of the filename)
// because filenames are `geist-mono-500-latin.woff2` and licence files are
// `Geist-OFL.txt`. Loose matching risks a false PASS, so the control below
// proves the rule rejects a family with no licence before any clean run is
// believed.
import { readdirSync, existsSync, readFileSync } from "node:fs";

const DIR = new URL("../assets/fonts/", import.meta.url);
const LICDIR = new URL("../assets/fonts/licenses/", import.meta.url);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const fonts = readdirSync(DIR).filter((f) => /\.woff2?$/i.test(f));
ok(fonts.length > 0, `fonts present (${fonts.length})`);
ok(existsSync(LICDIR), "assets/fonts/licenses/ exists");
ok(existsSync(new URL("../assets/fonts/README.md", import.meta.url)),
  "assets/fonts/README.md records each family's copyright and upstream");

const licenceFiles = existsSync(LICDIR) ? readdirSync(LICDIR) : [];
const familyOf = (f) => f.replace(/\.woff2?$/i, "").split("-")[0].toLowerCase();
const families = [...new Set(fonts.map(familyOf))];
ok(families.length > 0, `families detected: ${families.join(", ")}`);

const covered = (fam) => licenceFiles.some((l) => l.toLowerCase().includes(fam));
for (const fam of families) ok(covered(fam), `${fam}: a licence file ships alongside the font`);

// Each licence must be the real thing, not a stub: the grant and condition 2.
for (const l of licenceFiles) {
  const t = readFileSync(new URL(l, LICDIR), "utf8");
  ok(/Permission is hereby granted/i.test(t) && /must be distributed entirely under this license/i.test(t),
    `${l} is the complete OFL text (grant + condition 2)`);
  ok(/^copyright/im.test(t), `${l} carries its copyright line`);
}

// The NOTICE must say the fonts are third-party, or the inventory is incomplete
// at the one place a reader looks first.
{
  const notice = readFileSync(new URL("../NOTICE", import.meta.url), "utf8");
  ok(/assets\/fonts/.test(notice) && /Open Font License/i.test(notice),
    "NOTICE records the fonts as third-party under the OFL");
}

// CONTROL: the rule must reject a family with no licence, or a clean sweep
// above proves nothing.
ok(!covered("nosuchfamilyxyz"), "control: a family with no licence file is NOT reported as covered");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
