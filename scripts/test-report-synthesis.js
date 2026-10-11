#!/usr/bin/env node
// A report synthesis that stops for length is retried once inside the budget
// and, failing that, trimmed to a complete block and marked. Offline.
import { DOMAIN_AUDIT_TIERS } from "../src/tools/domain-audit-kit.js";
import { RECALL_TIERS } from "../src/tools/recall-report-kit.js";
import { FILING_TIERS } from "../src/tools/filing-watch-kit.js";
import { TOKEN_BRIEF_TIERS } from "../src/tools/token-brief-kit.js";
import { TICKER_PACK_TIERS } from "../src/tools/ticker-pack-kit.js";
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
// Budget headroom: these tiers' first synthesis stopped for length at about 3
// output tokens per target word (tables, recall numbers, figures), and the
// domain audit and recall report stopped again on the retry, so a sold report
// shipped shortened. Each cap now carries at least 3.5 tokens per target word.
for (const [slug, t] of Object.entries({ ...DOMAIN_AUDIT_TIERS, ...RECALL_TIERS, ...FILING_TIERS, ...TOKEN_BRIEF_TIERS, ...TICKER_PACK_TIERS })) {
  const words = Number(String(t.words).replace(/[^0-9]/g, ""));
  ok(words > 0 && t.synthMaxTokens / words >= 3.5, `${slug}: synthesis cap ${t.synthMaxTokens} carries >= 3.5 tokens per target word (${t.words})`);
}
// ...and the synthesis call sends that cap: a call site that lowers it ships the
// shortened report the floor above exists to prevent.
for (const kit of ["domain-audit-kit", "recall-report-kit", "filing-watch-kit", "token-brief-kit", "ticker-pack-kit"]) {
  const src = (await import("node:fs")).readFileSync(new URL(`../src/tools/${kit}.js`, import.meta.url), "utf8");
  const caps = [...src.matchAll(/max_tokens: ([^,}]+)/g)].map((m) => m[1].trim());
  ok(caps.length > 0 && caps.every((c) => c === "t.synthMaxTokens"), `${kit}: every synthesis call sends max_tokens: t.synthMaxTokens (${caps.join(" | ")})`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
