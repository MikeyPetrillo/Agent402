#!/usr/bin/env node
// Offline: the model-drift workflow's REDACT_RATES program, run exactly as the
// workflow runs it (perl -pe), on the lines the live guard prints, and the
// stale-high grader (scripts/lib/cost-row-drift.js) on stub rows.
//   - a dollar figure, a bare decimal and an exponent figure never survive;
//   - a stale-high finding keeps its row key, unit, direction and percent;
//   - a family row is graded against the dearest servable model it owns;
//   - the workflow runs every 6 hours, pipes the guard and the issue text
//     through the program, and its issue text names both directions.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { noteOwnedPrice, staleHighRows, describeStaleHigh, overridesOf, longContextGaps, describeLongContext } from "./lib/cost-row-drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const wf = readFileSync(new URL("../.github/workflows/model-drift.yml", import.meta.url), "utf8");
// The folded (>-) scalar: every more-indented line after the key, joined by spaces.
const lines = wf.split("\n");
const at = lines.findIndex((l) => /^\s*REDACT_RATES:\s*>-\s*$/.test(l));
ok(at >= 0, "model-drift.yml defines REDACT_RATES as a folded scalar");
const indent = (l) => l.match(/^\s*/)[0].length;
const body = [];
for (let i = at + 1; i < lines.length && lines[i].trim() && indent(lines[i]) > indent(lines[at]); i++) body.push(lines[i].trim());
const PROGRAM = body.join(" ");
ok(body.length >= 4, `REDACT_RATES carries its rules (${body.length})`);

const redact = (text) => {
  const r = spawnSync("perl", ["-pe", PROGRAM], { input: text, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`perl failed: ${r.stderr}`);
  return r.stdout;
};

// A dollar figure, a bare decimal and an exponent figure in one line.
{
  const out = redact("FAIL - deepseek/ prompt row is off: $0.42 vs 0.00042 and 3e-7, also 12.5 alone\n");
  ok(!/0\.42|0\.00042|3e-7|12\.5/.test(out) && !/\$[0-9]/.test(out), `a dollar figure, a bare decimal and an exponent figure are redacted (${out.trim()})`);
  ok(out.includes("deepseek/"), "the row key around them survives");
}
// The workflow's own canary line leaves no digit.
{
  const m = wf.match(/printf '%s\\n' '([^']+)' \| perl -pe "\$REDACT_RATES"/);
  ok(!!m, "the workflow's redactor self-check line is readable");
  if (m) ok(!/[0-9]/.test(redact(`${m[1]}\n`)), "the self-check canary leaves no digit");
}
// The under-direction line in its full (local) form loses every amount.
{
  const out = redact("    openai/gpt-6-luna dearest routable endpoint $1.25 (openai) / $10 (azure) vs table $1.1/$9 (v1-chat-base; 3 endpoint price(s) read)\n");
  ok(!/\$[0-9]/.test(out) && !/1\.25|1\.1\b/.test(out), `an under-direction line keeps no amount (${out.trim()})`);
}

// The stale-high grader on stub rows (prices per 1M tokens, invented).
{
  const owned = new Map();
  const fam = { prompt: 3, completion: 9 }; // rows under "fake/"
  // A family row owning a cheap and a dear model: judged by the dear one.
  noteOwnedPrice(owned, "fake/vendora-", fam, "fake/vendora-cheap", { prompt: 0.5, completion: 1 });
  noteOwnedPrice(owned, "fake/vendora-", fam, "fake/vendora-dear", { prompt: 2.9, completion: 8.5 });
  // A row well above its only model on prompt: stale high, completion fine.
  noteOwnedPrice(owned, "fake/vendorb-model-2.5", { prompt: 2, completion: 4 }, "fake/vendorb-model-2.5", { prompt: 1, completion: 4 });
  // A row inside the tolerance (10% above): fine.
  noteOwnedPrice(owned, "fake/vendorc-x", { prompt: 1.1, completion: 2.2 }, "fake/vendorc-x", { prompt: 1, completion: 2 });
  // The same model graded on two tiers: the dearer reading counts.
  noteOwnedPrice(owned, "fake/vendord-y", { prompt: 1, completion: 1 }, "fake/vendord-y", { prompt: 0.5, completion: 0.5 });
  noteOwnedPrice(owned, "fake/vendord-y", { prompt: 1, completion: 1 }, "fake/vendord-y", { prompt: 1, completion: 1 });
  // A priced row over a free listing.
  noteOwnedPrice(owned, "fake/vendore-free", { prompt: 0.1, completion: 0 }, "fake/vendore-free", { prompt: 0, completion: 0 });
  const high = staleHighRows(owned);
  const keys = high.map((f) => `${f.key}:${f.unit}`);
  ok(JSON.stringify(keys) === JSON.stringify(["fake/vendorb-model-2.5:prompt", "fake/vendore-free:prompt"]), `only the rows above every model they own are stale high (${keys.join(", ")})`);
  ok(high[0].pct === 100 && high[1].pct === null, `the finding carries a whole percent (${high[0].pct}) or none over a zero price`);
  const fam2 = new Map();
  noteOwnedPrice(fam2, "fake/vendora-", fam, "fake/vendora-cheap", { prompt: 0.5, completion: 1 });
  ok(staleHighRows(fam2).length === 2, "the same family row with only its cheap member servable is stale high on both units");
  // The public line: key, unit, direction, percent; nothing the redactor must touch.
  const line = describeStaleHigh(high[0]);
  ok(/^fake\/vendorb-model-2\.5 prompt: stale high, above /.test(line) && !/%|\d+\s*percent/.test(line), `the line names key, unit and direction, never a percent (${line})`);
  const out = redact(`    ${line}\n`);
  ok(out.trim() === line, `the stale-high line passes the redactor unchanged (${out.trim()})`);
  ok(!/\$|\b0\.\d|\d+e-\d/.test(line), "the stale-high line carries no rate");
}

// The long-context grader on stub endpoint data (placeholder prices, per token
// as the live endpoint list carries them, per 1M after overridesOf).
{
  // One endpoint as the live list shapes it: a base price and overrides from a prompt size on.
  const pricing = { prompt: "0.000001", completion: "0.000002", overrides: [{ min_prompt_tokens: 1000, prompt: "0.000002", completion: "0.000004" }, { min_prompt_tokens: 5000, prompt: "0.000003", completion: "0.000006" }] };
  const ov = overridesOf(pricing);
  ok(ov.length === 2 && ov[0].minPromptTokens === 1000 && Math.abs(ov[0].prompt - 2) < 1e-9 && Math.abs(ov[1].completion - 6) < 1e-9, "overridesOf reads min_prompt_tokens and both units per 1M tokens");
  ok(overridesOf({ prompt: "0.000001" }).length === 0 && overridesOf({ overrides: [{ prompt: "0.1" }] }).length === 0, "no overrides, or one without a threshold, reads as none");
  const tier = (aboveTokens, prompt, completion) => ({ aboveTokens, prompt, completion });
  const row = (tiers) => ({ prompt: 1, completion: 2, ...(tiers ? { tiers } : {}) }); // rows under "fake/"
  const k = (fs) => fs.map((f) => `${f.unit}:${f.kind}:${f.aboveTokens}`).join(",");
  ok(k(longContextGaps(row(), ov)) === "prompt:missing:1000,completion:missing:1000", `a row without tiers is missing both units from the first threshold (${k(longContextGaps(row(), ov))})`);
  ok(longContextGaps(row([tier(1000, 2, 4), tier(5000, 3, 6)]), ov).length === 0, "tiers matching every threshold cover it");
  ok(longContextGaps(row([tier(500, 3, 6)]), ov).length === 0, "one dearer tier from a lower size covers every threshold above it");
  ok(k(longContextGaps(row([tier(1000, 2, 4)]), ov)) === "prompt:under:5000,completion:under:5000", "a tier short of the second threshold is under from there");
  ok(k(longContextGaps(row([tier(1001, 2, 4), tier(5000, 3, 6)]), ov)) === "prompt:under:1000,completion:under:1000", "a tier that starts one token late is under at the upstream threshold");
  ok(k(longContextGaps(row([tier(1000, 2, 3.9), tier(5000, 3, 6)]), ov)) === "completion:under:1000", "each unit is graded on its own");
  ok(longContextGaps(row(), ov, 999).length === 0, "a threshold above the prompt size the tier admits is not graded");
  ok(k(longContextGaps(row(), ov, 1000)) === "prompt:missing:1000,completion:missing:1000", "a threshold AT the admitted size is graded");
  // Two endpoints: the dearer override at each size counts.
  const two = [...ov, ...overridesOf({ overrides: [{ min_prompt_tokens: 1000, prompt: "0.0000025", completion: "0.000004" }] })];
  ok(k(longContextGaps(row([tier(1000, 2, 4), tier(5000, 3, 6)]), two)) === "prompt:under:1000", "the dearest endpoint's override at a size is the one graded");
  ok(longContextGaps(row(), []).length === 0 && longContextGaps(null, ov).length === 0, "no overrides, or no row, grades nothing");
  // Public lines: key, unit, direction, prompt size; no rate, no percent, unchanged by the redactor.
  for (const f of [{ unit: "prompt", kind: "missing", aboveTokens: 200000 }, { unit: "completion", kind: "under", aboveTokens: 272000 }]) {
    const line = describeLongContext("fake/vendorf-long", f);
    ok(f.kind === "missing" ? /long-context tier missing/.test(line) : /under at >=272000 prompt tokens/.test(line), `the ${f.kind} line names its direction (${line})`);
    ok(!/\$|%|\b0\.\d|\d+e-\d|percent/.test(line), "the long-context line carries no rate or percent");
    const out = redact(`    ${line}\n`);
    ok(out.trim() === line, `the long-context line passes the redactor unchanged (${out.trim()})`);
  }
}

// Wiring.
ok(/cron:\s*"53 \*\/6 \* \* \*"/.test(wf), "model-drift.yml runs every 6 hours");
ok(!/^\s*push:/m.test(wf), "model-drift.yml never runs on a push");
ok(/node scripts\/test-gateway-model-ids\.js 2>&1 \| perl -pe "\$REDACT_RATES"/.test(wf), "the guard's whole output passes through REDACT_RATES before the log");
ok(/FAILS=\$\(printf '%s\\n' "\$FAILS" \| perl -pe "\$REDACT_RATES"\)/.test(wf), "the issue text passes through REDACT_RATES again");
ok(/UNDER its dearest live endpoint/.test(wf) && /ABOVE the dearest live endpoint/.test(wf), "the issue text names both directions");
const guard = readFileSync(new URL("./test-gateway-model-ids.js", import.meta.url), "utf8");
ok(/staleHighRows\(owned\)/.test(guard) && /describeStaleHigh/.test(guard), "the live guard grades the stale-high direction through the shared grader");
ok(/longContextGaps\(table, overrides, admittedTokensFor\(/.test(guard) && /describeLongContext\(key, f\)/.test(guard) && /overridesOf\(e\?\.pricing\)/.test(guard) && /overridesOf\(m\.pricing\)/.test(guard), "the live guard grades long-context overrides (endpoints and headline) through the shared grader");

console.log(`\ntest-model-drift-redaction: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
