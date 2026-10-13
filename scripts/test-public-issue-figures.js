#!/usr/bin/env node
// A public issue body carries reasons and ids, never a money figure.
//
// Two places write them. The workflows hand text to `gh issue` directly, and
// two paid runners (scripts/tempo-volume.js, scripts/mpp-probe.js) print log
// lines that their workflows grep into the issue by prefix. A balance, a
// floor or a price typed into either is published the moment the alarm
// fires, so both are read here as the public text they become.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/shipped-files.js";
import { issueBodyTexts } from "./lib/issue-bodies.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A dollar sign followed by a digit is a figure; "$VAR" and "${VAR}" are not.
const FIGURE = /\$\d/;

// --- workflow issue bodies ----------------------------------------------------
{
  ok(issueBodyTexts('gh issue create --body "burner holds under $0.50"').some((t) => FIGURE.test(t)), "control: a typed figure in an issue body is seen");
  ok(!FIGURE.test('BODY="burner under its floor ($MIN_BALANCE_USD, ${FLOOR})"'.replace(/\$\{?[A-Z_]+\}?/g, "")), "control: a shell variable is not a figure");
  const wfDir = join(ROOT, ".github", "workflows");
  const bad = [];
  let bodies = 0;
  for (const f of readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
    for (const t of issueBodyTexts(readFileSync(join(wfDir, f), "utf8"))) {
      bodies++;
      if (FIGURE.test(t)) bad.push(`${f}: "${t.replace(/\s+/g, " ").slice(0, 80)}"`);
    }
  }
  ok(bodies >= 20, `read ${bodies} issue bodies across the workflows`);
  ok(bad.length === 0, `no workflow issue body types a dollar figure${bad.length ? `:\n    ${bad.join("\n    ")}` : ""}`);
}

// --- the runner log lines a workflow quotes -----------------------------------
// tempo-volume.yml greps `^(tempo-volume:|REFUSING|...)` and mpp-probe.yml greps
// `^(mpp-probe:|OK |FAIL |REFUSING)` out of the run log into the issue. Those
// lines are read from the runners' source: a literal figure, or the floor
// interpolated beside a dollar sign (`$${MIN_BALANCE_USD}`), is refused.
{
  const quoted = (src, prefixes) => src.split("\n").filter((l) => /console\.(log|error)\(/.test(l) && prefixes.some((p) => l.includes(p)));
  const leaks = (line) => FIGURE.test(line) || /\$\$\{/.test(line) || /[<>]=?\$/.test(line);
  ok(leaks("console.error(`REFUSING to run: burner holds under $${MIN_BALANCE_USD}`)"), "control: an interpolated floor beside a dollar sign is caught");
  ok(leaks('console.log(`burner ${v >= 10 ? ">=$10" : "<$10"}`)'), "control: a bucket boundary typed as a figure is caught");
  ok(!leaks('console.log(`burner ${v >= MIN ? "above the floor" : "below the floor"}`)'), "control: words pass");
  for (const [file, prefixes] of [
    ["scripts/tempo-volume.js", ["tempo-volume:", "REFUSING", "TEMPO VOLUME UNDER", "10 failures"]],
    ["scripts/mpp-probe.js", ["mpp-probe:", "REFUSING", "OK ", "FAIL "]],
  ]) {
    const lines = quoted(readFileSync(join(ROOT, file), "utf8"), prefixes);
    ok(lines.length >= 2, `${file}: ${lines.length} quoted log line(s) found`);
    const bad = lines.filter(leaks);
    ok(bad.length === 0, `${file}: no quoted log line carries a dollar figure${bad.length ? `:\n    ${bad.map((l) => l.trim().slice(0, 100)).join("\n    ")}` : ""}`);
  }
}

console.log(`\ntest-public-issue-figures: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
