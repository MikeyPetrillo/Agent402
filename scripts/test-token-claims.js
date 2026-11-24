#!/usr/bin/env node
// The token tools state facts, never a judgment of a token (owner decision
// 2026-11-24).
//
//   node scripts/test-token-claims.js
//
// Three things are pinned here:
//   1. The deterministic claim check (src/token-claims.js), both ways: a
//      sentence that calls a token safe, legitimate, trustworthy, low-risk, a
//      scam (or not one), a rug or fraudulent, or tells the reader to buy,
//      sell or avoid it, fails; a factual sentence and the required
//      can-not-detect caveat pass.
//   2. The model-written token reports (token-risk, token-risk-pro) run the
//      check: a judging draft is written once more with the violation named,
//      and a second judging draft is withheld with a 502 (never settled), and
//      every answer carries the fixed notice.
//   3. The copy guard: no token tool's name, description, tags, aliases or
//      published example (nor the listing and storefront copy that sells them)
//      judges a token, and every token answer example carries the notice.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { tokenClaimViolations, checkedTokenProse, TOKEN_FACTS_NOTICE, TOKEN_CLAIM_RULE } from "../src/token-claims.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- 1. the checker --------------------------------------------------------
const PASSES = [
  "The source is verified on Sourcify.",
  "The simulated sell went through with a 0% sell tax.",
  "A honeypot reading: the simulated sell reverted.",
  "On-chain data cannot detect off-chain fraud, social-engineering scams or a rug pull.",
  "This data does not detect off-chain fraud.",
  "This brief is evidence from public Solana data sources, not investment advice.",
  "The owner holds 4.1% of supply in a Gnosis Safe.",
  "The contract uses SafeMath and safeTransfer.",
  "The mint authority is live, so new supply can be minted.",
  "The top 10 wallets hold 66.1% of supply, excluding pool accounts.",
  "Liquidity is $3.5M across 12 pairs.",
];
const FAILS = [
  "This token appears safe.",
  "The token is safe to buy.",
  "It is not a scam.",
  "This is not a rug.",
  "The contract looks legitimate.",
  "The project is trustworthy.",
  "The token is low-risk.",
  "This token is a scam.",
  "Looks like a rug.",
  "The token is fraudulent.",
  "This cannot be a scam.",
  "Investors should avoid this token.",
  "You should buy now.",
  "We recommend selling.",
  "Buy this token while liquidity is deep.",
  "A strong buy signal.",
  "This is a safe token for a small position.",
];
for (const t of PASSES) ok(tokenClaimViolations(t).length === 0, `passes: "${t}" (${JSON.stringify(tokenClaimViolations(t))})`);
for (const t of FAILS) ok(tokenClaimViolations(t).length > 0, `fails: "${t}"`);
ok(tokenClaimViolations("SafeCoin (SAFE) has a live mint authority.", { names: ["SafeCoin", "SAFE"] }).length === 0 && tokenClaimViolations("Safe (SAFE) has a live mint authority.").length > 0, "the token's own name and symbol are not a claim; the same words otherwise are");
ok(tokenClaimViolations("Earlier text cannot see everything. This token is not a scam.").length > 0, "a caveat in one sentence does not excuse a claim in the next");
ok(/cannot detect off-chain fraud/.test(TOKEN_CLAIM_RULE) && tokenClaimViolations("On-chain data cannot detect off-chain fraud.").length === 0, "the caveat the prompt asks for passes the check");
// A long clause is read in linear time: the caveat is found once per clause,
// not once per judgment word (a 32 KB clause of judgment words took ~150 ms
// when every word re-read its prefix).
{
  const words = "fraud scam rug ".repeat(Math.ceil(32768 / 15)).slice(0, 32768);
  const timed = (text) => { let best = Infinity; for (let k = 0; k < 3; k++) { const t0 = performance.now(); tokenClaimViolations(text); best = Math.min(best, performance.now() - t0); } return best; };
  const bare = timed(words), caveat = timed(`On-chain data cannot detect ${words}`);
  ok(bare < 25 && caveat < 25, `a 32 KB clause is checked in under 25 ms, best of 3 (no caveat ${bare.toFixed(1)} ms, with caveat ${caveat.toFixed(1)} ms)`);
  ok(tokenClaimViolations(`On-chain data cannot detect ${words}`).length === 0 && tokenClaimViolations(words).length > 0, "the long clause is still judged: excused after a caveat, flagged without one");
  ok(tokenClaimViolations("This token is a rug. On-chain data cannot detect fraud.").length > 0 && tokenClaimViolations("Scams exist; data cannot detect a scam").length > 0, "a caveat excuses only the words after it, in its own clause");
}
ok(TOKEN_FACTS_NOTICE === "These are facts read from the chain and named public sources. No flags does not mean a token is legitimate; off-chain fraud cannot be detected here. Not investment advice.", "the notice is the owner's sentence, word for word");

// checkedTokenProse: once more with the violation named, then withheld.
{
  const notes = [];
  const r = await checkedTokenProse(async (note) => { notes.push(note); return { prose: notes.length === 1 ? "It appears safe." : "The source is verified." }; });
  ok(r.prose === "The source is verified." && r.rewrites === 1 && notes[0] === "" && /appears safe/.test(notes[1]) && /REJECTED/.test(notes[1]), "a judging draft is rewritten once with the violation named");
  let n = 0;
  const e = await checkedTokenProse(async () => { n++; return { prose: "It is not a scam." }; }).then(() => null, (x) => x);
  ok(e?.statusCode === 502 && /withheld/.test(e.message) && n === 2, `a second judging draft is withheld with a 502 after exactly two drafts (${e?.statusCode}, ${n})`);
  const clean = await checkedTokenProse(async () => ({ prose: "Facts only." }));
  ok(clean.rewrites === 0, "a clean first draft is returned as is");
}

// --- 2. token-risk and token-risk-pro run the check --------------------------
{
  process.env.OPENROUTER_API_KEY ||= "test-key-not-real";
  const { makeTokenRiskHandler } = await import("../src/tools/token-risk-kit.js");
  const facts = { totalSupply: 1000, tokenName: "Fixture", tokenSymbol: "FIX", verification: { verified: true }, sources: [], limits: [], dex: null, topHolders: [] };
  for (const tier of ["token-risk", "token-risk-pro"]) {
    const prompts = [];
    const drafts = ["## Snapshot\nFixture appears safe and is not a scam.", "## Snapshot\nThe source is verified. On-chain data cannot detect off-chain fraud."];
    const chat = async (body) => {
      if (body.plugins) return { choices: [{ message: { content: "No credible reports found." } }] };
      prompts.push(body.messages[0].content);
      return { choices: [{ message: { content: drafts[Math.min(prompts.length - 1, drafts.length - 1)] } }], usage: { cost: 0.1 } };
    };
    const h = makeTokenRiskHandler(tier, { probeTokenFacts: async () => facts, chat, tool: () => async () => ({ findings: [] }) });
    const r = await h({ address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", chain: "base" });
    ok(prompts.length === 2 && /REJECTED/.test(prompts[1]) && /appears safe/.test(prompts[1]), `${tier}: a judging report is written once more with the violation named`);
    ok(r.report.startsWith("## Snapshot\nThe source is verified") && r.notice === TOKEN_FACTS_NOTICE && r.meta.claim_check.rewrites === 1, `${tier}: the clean draft is returned with the notice`);
    ok(prompts[0].includes(TOKEN_CLAIM_RULE), `${tier}: the prompt carries the same rule the check enforces`);
    const stuck = makeTokenRiskHandler(tier, { probeTokenFacts: async () => facts, chat: async (body) => (body.plugins ? { choices: [{ message: { content: "" } }] } : { choices: [{ message: { content: "This token is a scam." } }] }), tool: () => async () => ({ findings: [] }) });
    const e = await stuck({ address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", chain: "base" }).then(() => null, (x) => x);
    ok(e?.statusCode === 502 && /withheld/.test(e.message), `${tier}: a report that judges the token twice is withheld (502, not settled)`);
  }
}

// --- 3. the copy guard -------------------------------------------------------
{
  const { TOKEN_SAFETY_TOOLS } = await import("../src/tools/token-safety-kit.js");
  const { TOKEN_RISK_TOOLS } = await import("../src/tools/token-risk-kit.js");
  const { TOKEN_BRIEF_TOOLS } = await import("../src/tools/token-brief-kit.js");
  const { SOLANA_INTEL_TOOLS } = await import("../src/tools/solana-intel-kit.js");
  const TOKEN_TOOLS = [...TOKEN_SAFETY_TOOLS, ...TOKEN_RISK_TOOLS, ...TOKEN_BRIEF_TOOLS, ...SOLANA_INTEL_TOOLS];
  const ANSWERS_WITH_NOTICE = new Set(["token-safety", "token-risk", "token-risk-pro", "token-brief", "sol-token-safety", "sol-token-report", "sol-token-holders"]);
  // The notice and the disclaimer it rides beside are the one place the
  // word "legitimate" stands, as a negation; they are lifted out first.
  const lift = (s) => String(s).split(TOKEN_FACTS_NOTICE).join(" ");
  const JUDGE_WORD = /\b(?:safe|unsafe|scam|scams|rug|rugs|rugpull|rug-pull|rugged)\b/i;
  for (const t of TOKEN_TOOLS) {
    const copy = [t.name, t.description, ...(t.tags || []), ...(t.aliases || [])].join("\n");
    const v = tokenClaimViolations(lift(copy));
    ok(v.length === 0 && !JUDGE_WORD.test(copy), `${t.slug}: name, description, tags and aliases judge no token${v.length ? ` (${JSON.stringify(v)})` : JUDGE_WORD.test(copy) ? ` (${copy.match(JUDGE_WORD)[0]})` : ""}`);
    const ex = t.discovery?.output?.example;
    if (ex) {
      const text = lift(JSON.stringify(ex)).replace(/\\n/g, "\n");
      const ev = tokenClaimViolations(text);
      ok(ev.length === 0 && !JUDGE_WORD.test(text), `${t.slug}: the published example judges no token${ev.length ? ` (${JSON.stringify(ev)})` : ""}`);
      if (ANSWERS_WITH_NOTICE.has(t.slug)) ok(ex.notice === TOKEN_FACTS_NOTICE && !("verdict" in ex) && !("riskLevel" in ex), `${t.slug}: the example carries the notice and no verdict or risk level`);
    }
  }
  // The listing and storefront copy that sells them.
  const bazaar = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8").split("\n").find((l) => /^\s*"sol-token-safety": [`"]/.test(l)) || "";
  ok(bazaar && tokenClaimViolations(bazaar).length === 0 && !JUDGE_WORD.test(bazaar.replace(/sol-token-safety/g, "")), "the sol-token-safety listing description judges no token");
  const { HUMAN_PRODUCTS } = await import("../src/human-checkout.js").catch(() => ({}));
  const subs = readFileSync(new URL("../src/stripe-subscriptions.js", import.meta.url), "utf8");
  const tokenSub = subs.slice(subs.indexOf('"token-monitor"'), subs.indexOf("},", subs.indexOf('"token-monitor"')));
  ok(tokenSub && !JUDGE_WORD.test(tokenSub) && !/risk flags|risk watch/i.test(tokenSub), "the token watch's label and blurb judge no token");
  const page = readFileSync(new URL("../src/human-reports-page.js", import.meta.url), "utf8");
  const card = page.slice(page.indexOf('data-kind="token"'), page.indexOf("Get the brief"));
  ok(card && !JUDGE_WORD.test(card) && !/risk flag/i.test(card), "the token brief storefront card judges no token");
  void HUMAN_PRODUCTS;
}

console.log(`test-token-claims: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
