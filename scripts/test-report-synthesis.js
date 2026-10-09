#!/usr/bin/env node
// A report synthesis that stops for length is retried once inside the budget
// and, failing that, trimmed to a complete block and marked. Offline.
import { stoppedForLength, trimToCompleteBlock, completeSynthesis, proseOf, SHORTENED_NOTE, lengthRetryNote } from "../src/report-synthesis.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const resp = (content, finish, cost = 0.01) => ({ choices: [{ message: { content }, finish_reason: finish }], usage: { cost } });

ok(stoppedForLength(resp("x", "length")) && !stoppedForLength(resp("x", "stop")) && !stoppedForLength(null), "a length stop is recognised and nothing else is");
ok(trimToCompleteBlock("## A\n\nDone here.\n\n5. **CAA - check your DNS panel first, and") === "## A\n\nDone here.", "a trailing half sentence is dropped at the last blank line");
ok(trimToCompleteBlock("## A\n\nDone here.") === "## A\n\nDone here.", "text that ends cleanly is untouched");
ok(trimToCompleteBlock("| a | b |\n|---|---|\n| 1 | 2 |") === "| a | b |\n|---|---|\n| 1 | 2 |", "a complete table row is a clean end");
ok(trimToCompleteBlock("only a partial line with no break") === "only a partial line with no break", "with no earlier block the text is kept rather than emptied");

{
  const calls = [];
  const r = await completeSynthesis(async (note) => { calls.push(note); return resp("full report.", "stop"); }, "~1,200");
  ok(calls.length === 1 && calls[0] === "" && r.cutShort === false && r.calls.length === 1, "a clean stop is one call, no retry");
  ok(proseOf(r.sd, r.cutShort) === "full report.", "clean prose ships as is");
}
{
  const calls = [];
  const r = await completeSynthesis(async (note) => { calls.push(note); return calls.length === 1 ? resp("long draft cut mid", "length", 0.02) : resp("tight complete report.", "stop", 0.015); }, "~1,200");
  ok(calls.length === 2 && /under 1,200 words/.test(calls[1]) && /finish every numbered item/.test(calls[1]), `a length stop is retried once with the word budget in the note (${JSON.stringify(calls[1]).slice(0, 60)})`);
  ok(r.sd.choices[0].message.content === "tight complete report." && r.cutShort === false && r.calls.length === 2, "the retry's complete answer is the report and both calls are returned for cost");
}
{
  const r = await completeSynthesis(async () => resp("## Fixes\n\n1. Done.\n\n2. **CAA - check your", "length"), "~1,200");
  ok(r.cutShort === true && r.calls.length === 2, "two length stops leave the report cut");
  const p = proseOf(r.sd, r.cutShort);
  ok(p === `## Fixes\n\n1. Done.\n\n${SHORTENED_NOTE}`, `a still-cut report is trimmed to its last complete block and marked (${JSON.stringify(p).slice(0, 60)})`);
}
{
  const r = await completeSynthesis(async (note) => (note ? resp("", "length") : resp("first draft cut", "length")), null);
  ok(r.sd.choices[0].message.content === "first draft cut" && r.cutShort === true, "an empty retry keeps the first draft");
  ok(/shorter/.test(lengthRetryNote(null)) && !/undefined|null/.test(lengthRetryNote(null)), "without a word budget the note still asks for shorter");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
