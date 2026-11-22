#!/usr/bin/env node
// wiki/Why-Pay-Here.md must equal what scripts/why-wiki.js renders from
// WHY_POINTS (src/why.js). The wiki page once said it was a copy of that list
// and had drifted from it; now it is generated, and this keeps it generated.
// Offline. Run with the router's unproven-tier env unset (the shipped defaults),
// as CI does, since one point renders that ceiling.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
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
// The settle-first exception reads in order: the rule, then what such a
// call answers, with the field in backticks, on the page and in the wiki.
{
  const { SETTLE_FIRST_SENTENCE } = await import("../src/settle-first-copy.js");
  const pair = `${SETTLE_FIRST_SENTENCE} A call paid before it ran answers \`charged: true\`.`;
  const p = WHY_POINTS.find((w) => w.id === "never-charged")?.p || "";
  ok(SETTLE_FIRST_SENTENCE && p.includes(pair) && p.split("A call paid before it ran").length === 2, "the never-charged point says what a call paid before it ran answers right after the settle-first sentence, once, with `charged: true` in backticks");
  ok(have.includes(pair), "and the wiki carries the same pair");
}
// Control: a drifted copy is reported through the same comparison.
ok(want.replace(WHY_POINTS[0].p, WHY_POINTS[0].p + " Extra.") !== want, "control: an edited point would not match");

console.log(`\ntest-why-wiki: ${pass} passed`);
