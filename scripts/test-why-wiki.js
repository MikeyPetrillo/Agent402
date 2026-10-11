#!/usr/bin/env node
// wiki/Why-Pay-Here.md must equal what scripts/why-wiki.js renders from
// WHY_POINTS (src/why.js). The wiki page once said it was a copy of that list
// and had drifted from it; now it is generated, and this keeps it generated.
// Offline. Run with the router's unproven-tier env unset (the shipped defaults),
// as CI does, since one point renders that ceiling.
import { readFileSync } from "node:fs";
import { whyWikiMarkdown } from "./why-wiki.js";
import { WHY_POINTS } from "../src/why.js";

let pass = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } pass++; console.log("ok -", m); };

const have = readFileSync(new URL("../wiki/Why-Pay-Here.md", import.meta.url), "utf8");
const want = whyWikiMarkdown();
ok(WHY_POINTS.length >= 3, `WHY_POINTS has ${WHY_POINTS.length} points`);
for (const w of WHY_POINTS) ok(want.includes(w.p), `the generated page carries point "${w.kicker}" word for word`);
ok(have === want, "wiki/Why-Pay-Here.md is current (regenerate with: node scripts/why-wiki.js --write)");
ok(!/copied from it/.test(have), "the page no longer claims to be a hand copy");
// Control: a drifted copy is reported through the same comparison.
ok(want.replace(WHY_POINTS[0].p, WHY_POINTS[0].p + " Extra.") !== want, "control: an edited point would not match");

console.log(`\ntest-why-wiki: ${pass} passed`);
