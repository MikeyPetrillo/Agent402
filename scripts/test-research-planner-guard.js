// The research pipeline must never SELL a report whose plan collapsed.
//
// Found 2026-09-11 by reading a $1.10 research-max: meta said searches_run 1
// and sources_listed 5 against a tier configured for 12 searches and 40
// sources. Two defects stacked, and both are pinned here from source because
// neither is visible in the response shape - the report reads fine, it is
// simply built on a twelfth of the evidence the buyer paid for.
//
//   1. The planner's catch was EMPTY, so an upstream 429, a timeout and a
//      malformed JSON body were indistinguishable from each other.
//   2. `need` (the evidence floor) is a THIRD of however many sub-questions
//      survived. When the fallback collapsed that to 1, the floor became 1, so
//      one search cleared the guard that exists to refuse thin reports - the
//      same failure disarmed its own check, at full price, on a tier that had
//      then done less work than the $0.60 one plans.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { RESEARCH_TIERS } from "../src/tools/research-deep-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const src = readFileSync(new URL("../src/tools/research-deep-kit.js", import.meta.url), "utf8");

// --- the refusal, pinned from source -----------------------------------------
ok(/const plannerFellBack = !subQuestions\.length/.test(src),
  "the fallback is recorded, not just applied - a silent substitution cannot be reasoned about");
ok(/if \(plannerFellBack && t\.subQ > 1\) \{[\s\S]{0,400}?throw bad\(/.test(src),
  "a tier that plans more than one sub-question REFUSES when planning produced none");
ok(/Not charged; please retry\.`, 502\)/.test(src.slice(src.indexOf("plannerFellBack && t.subQ > 1"))),
  "and it refuses with a 502, which cancels settlement, so the buyer pays nothing");

// --- the reason is kept ------------------------------------------------------
ok(!/\} catch \{\s*\n\s*plan = null;/.test(src), "the planner's catch is no longer empty");
ok(/planError = String\(e\?\.message \|\| e\)/.test(src) && /console\.warn\(`\[research\]/.test(src),
  "the failure reason is captured and logged, so a rate limit is distinguishable from an outage");

// --- the floor is still derived, and the single-search tier still works ------
ok(/const need = Math\.max\(1, Math\.ceil\(toRun\.length \/ 3\)\)/.test(src),
  "the thin-evidence floor is unchanged for the case it was written for (some searches failing)");
const singles = Object.entries(RESEARCH_TIERS).filter(([, t]) => t.subQ === 1);
ok(singles.length === 0, `no tier plans a single sub-question today, so the refusal cannot fire on a healthy run (checked ${Object.keys(RESEARCH_TIERS).length} tiers)`);
for (const [name, t] of Object.entries(RESEARCH_TIERS)) {
  ok(t.searches >= 3 && t.subQ >= 3, `${name} plans ${t.subQ} sub-questions / ${t.searches} searches - well clear of the fallback`);
}

// --- the ladder the finding was measured against -----------------------------
ok(RESEARCH_TIERS["research-max"].searches > RESEARCH_TIERS["research"].searches,
  "the top tier plans strictly more searches than the base tier - the property the defect inverted");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
