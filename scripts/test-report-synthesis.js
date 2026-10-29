#!/usr/bin/env node
// A report synthesis that stops for length is retried once inside the budget
// and, failing that, trimmed to a complete block and marked. Offline.
import { readFileSync, readdirSync } from "node:fs";
import { REPORT_TIERS } from "../src/report-tiers.js";
import { LINKEDIN_WORDS } from "../src/tools/linkedin-article-kit.js";
import { stoppedForLength, trimToCompleteBlock, completeSynthesis, proseOf, SHORTENED_NOTE, lengthRetryNote, settleWithin } from "../src/report-synthesis.js";
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
// Budget headroom: report syntheses stopped for length at about 3 output
// tokens per target word (tables, recall numbers, figures), stopped again on
// the retry, and a sold report shipped shortened. Every tier in the registry
// of priced reports (src/report-tiers.js, so a new report kit is covered the
// moment it is priced) carries at least 3.5 tokens per target word. The
// LinkedIn article takes a length option, so its longest target is the one
// checked.
const wordsOf = (w) => Number(String(w ?? "").replace(/[^0-9]/g, ""));
const tierWords = (slug, t) => (t.words ? wordsOf(t.words) : slug === "linkedin-article" ? Math.max(...Object.values(LINKEDIN_WORDS).map(wordsOf)) : 0);
const reportSlugs = Object.keys(REPORT_TIERS);
ok(reportSlugs.length >= 18, `the report-tier registry lists every priced report (${reportSlugs.length})`);
for (const [slug, t] of Object.entries(REPORT_TIERS)) {
  const words = tierWords(slug, t);
  ok(Number.isInteger(t.synthMaxTokens) && words > 0 && t.synthMaxTokens / words >= 3.5,
    `${slug}: synthesis cap ${t.synthMaxTokens} carries >= 3.5 tokens per target word (${words} words, ${(t.synthMaxTokens / words).toFixed(2)})`);
}
// ...and the synthesis call sends that cap: a call site that lowers it ships the
// shortened report the floor above exists to prevent. The kits are the ones the
// registry imports, plus any kit that uses the shared synthesis helper, so a
// report kit cannot sit outside the check. In each, every max_tokens is either
// t.synthMaxTokens or a literal on a grounded-search or planning call (a
// non-synthesis model named in the kit).
const SRC = new URL("../src/", import.meta.url);
const registryKits = [...readFileSync(new URL("report-tiers.js", SRC), "utf8").matchAll(/from "\.\/tools\/([a-z0-9-]+)\.js"/g)].map((m) => m[1]);
const helperKits = readdirSync(new URL("tools/", SRC)).filter((f) => f.endsWith(".js") && /report-synthesis\.js|synthMaxTokens/.test(readFileSync(new URL(`tools/${f}`, SRC), "utf8"))).map((f) => f.replace(/\.js$/, ""));
ok(registryKits.length >= 11 && helperKits.every((k) => registryKits.includes(k)), `every kit with a synthesis cap is in the report-tier registry (${helperKits.filter((k) => !registryKits.includes(k)).join(", ") || "all"})`);
const NON_SYNTH = new Set(["GROUND", "M.ground", "M.plan"]);
for (const kit of registryKits) {
  const src = readFileSync(new URL(`tools/${kit}.js`, SRC), "utf8");
  const sites = [...src.matchAll(/max_tokens: ([^,}\n]+)/g)].map((m) => {
    const before = src.slice(Math.max(0, m.index - 1500), m.index);
    const models = [...before.matchAll(/model: ([A-Za-z0-9_.]+)/g)];
    return { cap: m[1].trim(), model: models.length ? models[models.length - 1][1] : "?" };
  });
  const synth = sites.filter((x) => !NON_SYNTH.has(x.model));
  const other = sites.filter((x) => NON_SYNTH.has(x.model));
  ok(synth.length > 0 && synth.every((x) => x.cap === "t.synthMaxTokens"),
    `${kit}: every synthesis call sends max_tokens: t.synthMaxTokens (${synth.map((x) => `${x.model}=${x.cap}`).join(" | ")})`);
  ok(other.every((x) => /^\d[\d_]*$/.test(x.cap)), `${kit}: search and planning calls carry a fixed literal cap (${other.map((x) => `${x.model}=${x.cap}`).join(" | ") || "none"})`);
  const helpers = [...src.matchAll(/(?:const GROUND = |\b(?:ground|plan): )"([^"]+)"/g)].map((m) => m[1]);
  ok(helpers.every((id) => !/^anthropic\//.test(id)), `${kit}: the search and planning models are not the synthesis model (${helpers.join(", ") || "none"})`);
}
// settleWithin: a data leg never throws, and a leg that settles early leaves
// no timer behind to hold the process for the rest of its timeout.
{
  const timers = () => process.getActiveResourcesInfo().filter((t) => t === "Timeout").length;
  const before = timers();
  const okLeg = await settleWithin(Promise.resolve(7), 60_000);
  const badLeg = await settleWithin(Promise.reject(Object.assign(new Error("upstream down"), { statusCode: 503 })), 60_000);
  ok(okLeg.ok === true && okLeg.data === 7 && badLeg.ok === false && badLeg.error === "upstream down" && badLeg.status === 503, "a leg settles to {ok,data} or {ok:false,error,status}");
  ok(timers() === before, `a settled leg leaves no timer pending (${timers() - before} left)`);
  const slow = await settleWithin(new Promise(() => {}), 20);
  ok(slow.ok === false && slow.error === "timeout" && slow.status === 504, "a leg past its timeout fails as a 504 timeout");
  const sync = await settleWithin(() => { throw Object.assign(new Error("bad input"), { statusCode: 400 }); }, 1000);
  ok(sync.ok === false && sync.error === "bad input" && sync.status === 400 && timers() === before, "a function leg that throws synchronously is a failed leg");
  const plain = await settleWithin(Promise.reject("x"));
  ok(plain.ok === false && plain.error === "x" && plain.status === null, "a non-Error rejection reads as its string, with no status");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
