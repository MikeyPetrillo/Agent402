#!/usr/bin/env node
// Four false absolutes, and the guard that stops the class coming back.
//
//   node scripts/test-copy-absolutes.js        (offline, no server)
//
// An absolute is the most expensive kind of sentence to write, because it is
// true on the day it ships and stops being true the day a feature widens the
// service. Four of ours had already stopped:
//
//   1. "N deterministic tools" on /api/pricing, where N was the WHOLE catalog
//      count and 37 of those entries plus every /v1 tier are model-backed.
//   2. "Every tool is deterministic, no model in the serving path" on /why and
//      /faq and as a BOOLEAN `deterministic: true` on the service manifest -
//      false since the gateway tiers and the report products shipped.
//   3. "Only sellers with proven on-chain settlement are routable" on four
//      pages - false since the unproven Solana tier shipped 2026-09-02, which
//      is LIVE on its default.
//   4. "Agent402 never holds, receives, signs, or sends funds" - false since
//      prepaid credits shipped, and the correctly scoped version was already
//      being served on /security, /company, /terms and /api/reliability while
//      these pages kept the absolute.
//
// Every one was caught by reading, not by a test, and three of them had a
// correct scoped twin somewhere else on the same site - which is the tell that
// the problem is copies, not judgment. So: the routing sentence is DERIVED
// from the router's own constant (nothing may type it), the manifest fields
// are strings that state their own scope (a boolean cannot), and the phrasings
// that were wrong are forbidden outright in served copy.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync } from "node:fs";
import { RAILS } from "../src/rails.js";
import { failedCallFootnote } from "../src/settlement-footnote.js";
import { execFileSync } from "node:child_process";
import { childJson } from "./lib/child-json.js";
import { notChargedClaims } from "./lib/not-charged-claims.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Everything a reader or an agent can actually be shown. This walks
// RECURSIVELY and includes the published package READMEs, because the first
// version of this guard read `src/*.js` at the top level only and `README.md`
// for four packages - and the very sweep that shipped it left a forbidden
// string live in `adapters/agentkit/README.md` (a published npm package) and
// three copies of the count claim on /pricing. A guard that names its scope
// narrower than the claim's scope is a guard that certifies the gap.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "assets"]);
function walk(rel, out, depth = 0) {
  let names = [];
  try { names = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    if (SKIP_DIRS.has(d.name)) continue;
    const next = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) { if (depth < 4) walk(next, out, depth + 1); }
    else if (/\.(js|md)$/.test(d.name)) out.push(next);
  }
  return out;
}
// EVERY tracked text file, not a list of folders. The folder list certified
// its own gap twice: skills/openclaw/agent402/SKILL.md (displayed in full by a
// plugin registry) and .cursor-plugin/plugin.json (a published manifest) both
// carried forbidden claims for months because neither folder was on the list.
// What is left out is named, with the reason.
const NOT_SURFACES = [
  [/^scripts\/(?!.*card.*\.js$|build-fixtures\.js$)/, "tests and ops scripts quote the forbidden sentences as fixtures; card generators and the sample document builder ARE surfaces and stay in"],
  [/^\.github\/(?!ISSUE_TEMPLATE\/|workflows\/heartbeat\.yml$)/, "CI configuration, not copy; the issue forms and the heartbeat's issue bodies are read by people and stay in"],
  [/^CLAUDE\.md$/, "the rulebook quotes the forbidden sentences to forbid them"],
  [/(^|\/)CHANGELOG\.md$/, "dated history records what shipped when, including the old wording"],
  [/(^|\/)package-lock\.json$|(^|\/)node_modules\//, "generated"],
  [/^facilitator\/test|\.test\.js$|(^|\/)test[^/]*\.js$/, "test fixtures"],
];
const TEXT = /\.(?:js|mjs|cjs|md|json|toml|txt|ya?ml|html)$/;
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
// The sample document is a PDF whose text streams are stored plain, so it is
// read like any page (scripts/build-fixtures.js writes it).
const SAMPLE_PDF = "assets/fixtures/sample-report.pdf";
const files = tracked.filter((f) => (TEXT.test(f) || f === SAMPLE_PDF) && !NOT_SURFACES.some(([re]) => re.test(f)));
const read = (rel) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return null; } };

// Rail counts are DERIVED here from src/rails.js, so a rail added there moves
// what the rule accepts. Package descriptions said "USDC on Base + 11 more
// chains, or USDG on Robinhood Chain (12 chains total)" (thirteen chains by
// its own arithmetic) and the MCP package said "USDC on 12 chains": twelve is
// every chain including Robinhood's USDG, eleven carry USDC.
const USDC_RAILS = RAILS.filter((r) => r.asset === "USDC").length;
const ALL_RAILS = RAILS.length;
// A sentence about charging names the rail it holds on (x402, MPP evm, card,
// credits), or the push exception. A bare "MPP" is not a rail: MPP carries
// the Tempo push method the claim is false for. "Owed" beside the claim is
// not the exception either, and a free tier (proof-of-work) says nothing
// about what a paid rail charges. A style token (var(--card)) is not the rail.
const NOT_CHARGED_SCOPE = /\bx402\b|\bTempo\b|(?<!-)\bcard\b|\bcredits?\b|\bStripe\b|\bEVM\b|\bMPP evm\b|\bpush\b|\bunpaid\b/i;
// The "settles only" form of the claim takes the same scope words, the
// protocol library's own name (a sentence about what @x402/express does), and
// Circle Gateway (a batched payment is judged on its own page), and the
// shared exception clause where a module prints it (src/tempo-push-debts.js).
const SETTLES_ONLY_SCOPE = new RegExp(`${NOT_CHARGED_SCOPE.source}|@x402\\/|\\bevm method\\b|\\bCircle Gateway\\b|PUSH_EXCEPTION|\\bpushClause\\(`, "i");
// A wiki or README paragraph is one line, so "the same line" is too wide a
// scope for these two rules and "the same sentence" too narrow (the rail is
// often named in the clause before): the scope word counts within this many
// characters before and after the claim, the line above included. After the
// claim the scope ends with the claim's own clause, at the first ".", ";", ": " or ", and":
// a rail named in the sentence that follows is about something else.
const SCOPE_NEAR = [240, 160];
const clauseEnd = (after) => { const at = after.search(/[.;]|:\s|,\s+and\b/); return at < 0 ? after : after.slice(0, at); };
// "Recorded as owed" says a debt exists, not what becomes of it: the same
// clause, or the one beside it, says how it is repaid (the shared words are
// OWED_REPAID in src/tempo-push-debts.js) or points at /terms.
const OWED_REPAID_SCOPE = /\brepa(?:id|y|ys|yment)\b|\brefund(?!Owed)|\/terms\b|OWED_REPAID|PUSH_EXCEPTION|\bretried\b/i;
// "A failed x402 call is not charged" holds with two exceptions /terms lists
// (a payment that lands on chain after the error answer, a batched payment
// still settling): the claim carries one beside it, or points at /terms.
const X402_EXCEPTION_SCOPE = /\bexceptions?\b|\blands? (?:late|later|after)\b|\/terms\b|\bowed\b|\brepaid\b|LATE_SETTLE_EXCEPTION/i;
// The published packages' code pays over x402 or a credits key only, and
// neither is final before the call; their READMEs are read like any page.
const PACKAGE_CODE = ["mcp/index.js", "mcp/async-job.js", "client/index.js", "client/async-job.js", "client/reset-retry.js"];
const PACKAGE_CODE_WHY = "package code: the package pays over x402 or a credits key, never with a transfer sent before the call";
// Copy surfaces: every tracked text file outside src, every markdown file,
// and the src modules that render pages or documents rather than answer a
// paid request (their names say so). Pinned below against the known ones.
const COPY_SURFACES = /\.md$|^(?!src\/)|^src\/[\w-]*(?:page|pages|guides?|learn|seo|blog|skill-md|how-to-pay|what-is-x402|webhooks|terms|privacy|company|glossary|faq|why|docs|integration|front-door)[\w-]*\.js$/;
const FORBIDDEN = [
  {
    // "Never charged" is true of x402 (settlement runs after the handler) and
    // false for a Tempo push credential or a hang-up after settle, which are
    // recorded as refunds owed. Say "not charged on x402" (or scope it).
    re: /\b(?:failed|failing) (?:call|request|generation)s? (?:is|are) never charged\b|\ban error is never charged\b|\b4xx\S*\s*\S*5xx\S* never charges\b/i,
    why: "unscoped: a Tempo push payment or a hang-up after settle is charged and recorded as owed; scope it to x402",
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // The same class in its "not charged" form, which the rule above missed:
    // "a failed or timed-out generation is never charged" (a word between the
    // adjective and the noun) and "a failed call is not charged and the receipt
    // proves it" (no rail named) were both served. The rail must be named IN
    // THE SAME SENTENCE: a line that says "over x402" in its first sentence and
    // "never charged" in its third is not scoped.
    re: /\b(?:failed|failing|errored|timed-out)\b(?:\s+or\s+[\w-]+)?\s+(?:[\w-]+\s+)?(?:call|request|generation|run|job)s?\s+(?:is|are|was|were)\s+(?:not|never)\s+charged\b/i,
    why: "unscoped: a Tempo push payment is final before the call runs; name the rail where it holds (x402, card, credits)",
    scopedBy: /\bx402\b|\bTempo\b|\bcard\b|\bcredits?\b|\bStripe\b|\bEVM\b/i,
    scopeSentence: true,
  },
  {
    // The noun forms the two rules above missed: "Failures are not charged",
    // "a run where no step succeeds is not charged", "a 4xx or 5xx is never
    // charged", "answers 422 and is not charged", "so nothing is charged",
    // and the bare sentences "Nothing was charged" / "You were not charged" /
    // "Not charged" with no rail named beside them, and the status form "an
    // answer of 400 or above is never charged". A Tempo push transfer is
    // final before the call and a failure on it is booked as owed, so the
    // claim holds only with its rail (x402, MPP evm, card, credits) or the
    // push exception in the same line or the next. A handler's refusal line
    // (bad(...), throw, res.status(n).json) is not copy: the Tempo push gate
    // restates it for that payer at send (src/push-refusal-body.js), which
    // the block below proves against every such phrasing in the tree.
    re: /\b(?:failures?|errors?|refusals?|timeouts?|(?:a |an |any |every |each |the )?(?:failed|failing|errored|timed-out|refused|cancell?ed|rejected|unsuccessful)(?:\s+or\s+[\w-]+)?\s+(?:[\w-]+\s+)?(?:call|request|generation|run|job|step|attempt|buy|purchase)s?|(?:a |any |every |the )?(?:call|run|request|job|step|attempt|generation)s? (?:that|which|where) (?:fails?|errors?|times? out|no step succeeds)|a 4xx or 5xx|4xx\S*\s*(?:or|\/)\s*5xx\S*|[45]xx(?:es)?|(?:an? |any |every |the )?(?:answer|response)s? of [45]\d\d or (?:above|over|higher|more))\b[^.;]{0,40}?\b(?:is|are|was|were|get|gets) (?:not|never) charged\b|\b(?:fails?|failing|errors?|times? out|is refused|refused|cancels? settlement|answers? (?:a |an )?\S*[45]\d\d\S*)[^.;]{0,30}?\b(?:so |and |[-:,] )?(?:nothing|no charge|not|never)\s*(?:is|was|has been)?\s*charged\b|\bnothing is charged\b[^.]{0,30}\b(?:fail|error|[45]xx)|\bno charge is applied\b/i,
    why: "unscoped: a Tempo push transfer is final before the call and a failure on it is recorded as owed; name the rail (x402, MPP evm, card, credits) or the push exception in the same sentence",
    scopedBy: NOT_CHARGED_SCOPE,
    scopeWindow: 0,
    skipComments: true,
    skipLine: /\bbad\(|\bthrow\b|new Error\(|\.status\(\d{3}\)\.json\(|mppProblem\(/,
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // The bare sentence forms ("Nothing was charged.", "You were not
    // charged.", "Not charged.") on a COPY surface: a page, a guide, a wiki
    // page, a README, an example. In a served module that answers requests
    // the same sentence is a refusal body, and the Tempo push gate restates
    // it for that payer at send (proven below), so those modules are read by
    // the handler-line rule above, not this one.
    re: /\b(?:nothing (?:was|is|has been) charged|you (?:were|are) not charged|not charged)\b(?! (?:on|over) x402)/i,
    why: "unscoped on a copy surface: name the rail (x402, MPP evm, card, credits) or the push exception in the same sentence",
    scopedBy: NOT_CHARGED_SCOPE,
    scopeWindow: 0,
    skipComments: true,
    skipLine: /\bbad\(|\bthrow\b|new Error\(|\.status\(\d{3}\)\.json\(|mppProblem\(/,
    only: COPY_SURFACES,
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // The same claim stated from the other side: "payment settles only when
    // the result is ready", "settled only on a successful response", "charged
    // only if it succeeds". True where settlement runs after the handler
    // (x402, MPP evm, a Tempo pull credential, a card, credits) and false for a
    // Tempo transfer the buyer sent before the call, which is final before the
    // handler runs. The sentence names the rail it holds on, or that exception.
    re: /\b(?:settle[sd]?|settlement (?:happens|runs))\s+(?:the (?:x402 )?payment\s+|a payment\s+)?only\b|\bonly\b[^.;]{0,30}\b(?:is|are|gets?) settled\b|\b(?:charged|billed) only (?:if|when|on|once|after|for)\b|\bonly (?:charged|billed) (?:if|when|on|once|after|for)\b|\b(?:call|request|run|payment)s?\b[^.;]{0,90}\b(?:is|are) not settled\b/i,
    why: "unscoped: a Tempo transfer sent before the call is final before the handler runs; name the rail (x402, MPP evm, card, credits) or that exception in the same sentence",
    scopedBy: SETTLES_ONLY_SCOPE,
    scopeNear: SCOPE_NEAR,
    ownLine: true,
    skipComments: true,
    exempt: new Map([
      ["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"],
      ...PACKAGE_CODE.map((f) => [f, PACKAGE_CODE_WHY]),
    ]),
  },
  {
    // "Uncharged" is the same claim as an adjective: "it fails uncharged",
    // "an uncharged error", "so no buyer is charged".
    re: /\b(?:fails?|failures?|errors?|refus\w+|[45]\d\d)\b[^.;]{0,40}\buncharged\b|\buncharged (?:error|failure|refusal|answer)s?\b|\bno buyer is charged\b/i,
    why: "unscoped: a Tempo transfer sent before the call is recorded as owed when the call fails; name the rail (x402, MPP evm, card, credits) or that exception in the same sentence",
    scopedBy: SETTLES_ONLY_SCOPE,
    scopeNear: SCOPE_NEAR,
    ownLine: true,
    skipComments: true,
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // No rail makes this one true, so no scope word excuses it: a payment
    // that settles after the buyer's connection closed (no forgiveness ticket,
    // or a close during the settle call) is charged and recorded as owed, and
    // so is a Tempo transfer sent before a call that fails.
    re: /\bpay only for (?:delivered|successful|completed) (?:results?|answers?|calls?|work)\b|\bonly (?:ever )?pay for (?:delivered|successful|what you (?:get|receive))\b|\bnever pay for (?:a |an )?(?:failed|failure|error)/i,
    why: "false on every rail: a payment that settles after the buyer's connection closed, or a Tempo transfer sent before a call that fails, is charged and recorded as owed; say what happens to it instead",
    skipComments: true,
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // The same claim about buyers, in a pager body or a page: the rail is
    // named right beside it ("x402 buyers are not charged"), since a wallet's
    // name earlier in the sentence is about something else.
    re: /\bbuyers? (?:(?:is|are) )?(?:not|never) charged\b|[;(]\s*(?:never|not) charged\b/i,
    why: "unscoped: a Tempo transfer sent before the call is recorded as owed when the call fails; name the rail right beside the claim (x402 buyers are not charged; not charged on x402)",
    scopedBy: SETTLES_ONLY_SCOPE,
    scopeNear: [24, 40],
    ownLine: true,
    only: /^(?!src\/|services\/)/,
    skipComments: true,
    skipLine: /\bbad\(|\bthrow\b|new Error\(|\.status\(\d{3}\)\.json\(|mppProblem\(/,
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // A storefront card is charged at Checkout and refunded when the report
    // fails; it does not settle on delivery.
    re: /\bcard\b[^.;]{0,40}\bpayments?\s+settles?\s+only\b/i,
    why: "false for a storefront card: Checkout charges first and a failed report is refunded; name the rails that settle after the run",
    skipComments: true,
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // A debt named with no word on its repayment.
    re: /(?<!\bnot )\brecorded as owed\b(?! and repaid)/i,
    why: "says a payment is recorded as owed and not how it is repaid: use the shared clause (OWED_REPAID, src/tempo-push-debts.js: recorded as owed and repaid after on-chain proof) or point at /terms",
    scopedBy: OWED_REPAID_SCOPE,
    scopeNear: [200, 200, "open"],
    ownLine: true,
    skipComments: true,
    skipLine: /console\.(?:warn|log|error)\(|\blog\(|\bline\(/,
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // The x402 claim with nothing beside it on the payments /terms excepts.
    re: /\bfailed x402 (?:call|request|run)s? (?:is|are) (?:not|never) charged\b/i,
    why: "absolute: /terms lists exceptions (a payment that lands on chain after the error answer is recorded as owed and repaid); say so beside the claim or point at /terms",
    scopedBy: X402_EXCEPTION_SCOPE,
    scopeLines: 3,
    ownLine: true,
    skipComments: true,
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // A rating or an assurance someone could rely on, not evidence: a token
    // "safe to touch", a "safety watch", a "graded safety read", or a page that
    // "meets WCAG". Say what the output contains or what was checked instead.
    re: /\bsafe to (?:touch|trade|buy|hold)\b|\btoken safety (?:watch|check)\b|\bgraded safety read\b|\b(?:meets?|meeting|conforms? to|complian(?:t|ce) with)\s+WCAG\b/i,
    why: "a rating or conformance claim; describe the evidence returned or the checks made",
  },
  {
    re: new RegExp(`\\bUSDC on (?!${USDC_RAILS}\\b)\\d+ chains\\b|\\bUSDC on Base \\+ (?!${USDC_RAILS - 1}\\b)\\d+ more chains\\b|\\b(?!${ALL_RAILS}\\b)\\d+ chains total\\b`, "i"),
    why: `src/rails.js lists ${USDC_RAILS} USDC chains and ${ALL_RAILS} chains in all; derive the figure from RAILS or drop it`,
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // A rail count typed into a SERVED page ("Twelve chains.", "plus eleven
    // more rails", "all twelve chains", "12 chains in total"). Served copy
    // derives the count from the live offer (src/rails.js
    // resolveRailCountTokens), so a gated rail joining it moves the figure;
    // a typed word stays wrong the moment it does. Comments are not copy.
    re: /\b(?:eleven|twelve|thirteen|fourteen|fifteen|1[0-9]) (?:x402 )?(?:chains|rails|networks)\b(?! (?:of|from)\b)|\ball (?:eleven|twelve|thirteen|fourteen|1[0-9]) (?:chains|rails)\b|\b1[0-9] chains in total\b|\bplus (?:eleven|twelve|thirteen|1[0-9]) more (?:rails|chains)\b/i,
    why: "a served page types a rail count; write {{railCount}} / {{railsMore}} and resolve it with resolveRailCountTokens so it follows the live offer",
    only: /^src\//,
    skipComments: true,
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // The static-surface count is "500+ tools" (CLAUDE.md). Package
    // descriptions carried a hand-typed lower floor ("400+ pay-per-call
    // tools") beside it, which reads as a second, contradicting count.
    // A SUBSET count ("150+ pure-CPU tools") is a different, true claim, so
    // only the catalog-level phrasings are matched.
    re: /\b[1-4]\d\d\+ (?:(?:pay-per-call|paid|priced|web) ){0,2}(?:tools|endpoints)\b/,
    why: "static surfaces say \"500+ tools\", never a different hand-typed floor",
    exempt: new Map([["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"]]),
  },
  {
    // THE CLASS, not one string. The first cut matched the exact sentence
    // "Only sellers with proven on-chain settlement are routable" and passed
    // green over three more live phrasings of the same claim: /x402-101 said
    // "proven settlement" (no "on-chain"), the README said "routes only to
    // sellers with proven on-chain settled volume", and the resolver's own
    // comment said "we route ONLY to sellers with proven settled volume". A
    // claim has as many phrasings as people who write it down, so this matches
    // the SHAPE: an exclusivity word near "seller" near "proven".
    // Third word order ("Sellers qualify only with proven on-chain settled
    // volume", the MCP wiki page) slipped past the first two alternatives.
    re: /\b(?:only|exclusively)\b[^.]{0,60}sellers?[^.]{0,80}proven|\bproven\b[^.]{0,60}sellers?[^.]{0,40}\bonly\b|\bsellers?\b[^.]{0,30}\b(?:only|exclusively) (?:with|on|if|when|after)\b[^.]{0,30}\bproven\b/i,
    why: "the unproven Solana tier makes the exclusive form false; render routingProofSentence() or name the chain it is true of",
    // The claim is always about ROUTING or ELIGIBILITY. Without this the rule
    // also read a payTo-mismatch comment ("we only refuse on a positive
    // MISMATCH, so sellers proven by a source...") as the same claim.
    requires: /\brout|eligib|dispatch/i,
    // True as written when it names the rail it is scoped to, IN THE SAME
    // SENTENCE: a chain named three lines away is prose, not a scope.
    scopedBy: /\bBase\b|\bSolana\b|\bTempo\b|\bAlgorand\b/,
    scopeWindow: 0,
    exempt: new Map([
      ["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"],
      ["src/routing-proof.js", "the module that renders the honest sentence quotes the old one to explain it"],
    ]),
  },
  {
    // Same shape for the no-model claim. Every honest use on the site scopes it
    // ("of the utility tools", "the deterministic tools"); the README's
    // hand-written /why copy did not, and said the service runs no model at all.
    // "no large language model runs in that serving path" (/terms) slipped
    // past the first form of this rule: the model was named in full.
    re: /\bno (?:model|LLM|large language model)\b[^.]{0,30}serving path/i,
    why: "the /v1 tiers, the reports and the media tools run models; scope the claim to the utility or deterministic tools",
    // A scope names WHICH tools. A bare "deterministic" was accepted here, and a
    // file whose neighbouring line was the false count claim ("500+ deterministic
    // web tools") had its no-model claim certified by that very claim.
    scopedBy: /\b(?:the|these|those|our|its|each|every) (?:utility|deterministic|pure[- ]CPU)\b|\butility tools?\b|\b(?:deterministic )?utilities\b|\bthese tools\b|\bthose tools\b|\bthis kit\b|\bpure[- ]CPU tools\b/i,
    scopeWindow: 3,
  },
  {
    re: /Agent402 never holds(?:,| ) ?(?:receives|signs|sends|funds)/,
    why: "a prepaid credits balance is money we hold; scope the subject to the tools",
  },
  {
    re: /never holds, receives, signs, or sends\s+funds/,
    why: "same absolute, hyphen-wrapped in markdown; scope the subject to the tools",
  },
  {
    // Same claim in other words (truth audit 2026-10-02): route-execute and
    // decide.execute pay outside sellers from our own wallets.
    re: /\bAgent402 never touch(?:es)? (?:your |any )?funds\b/i,
    why: "route-execute and decide.execute pay sellers from our wallets; scope the subject to the tools",
  },
  {
    re: /\bnon-custodial and never hold your funds\b/,
    why: "scope it: say what does not happen on THIS rail",
  },
  {
    // AN AUTOMATIC-REFUND PROMISE IS TRUE OF ONE PATH ONLY. The card
    // storefront refunds a failed report through Stripe in the failure path
    // itself (src/human-checkout.js), so "refunded automatically" is right
    // there and stays. A settled charge on the x402 and MPP rails that reached
    // no buyer is recorded as owed in the refund ledger and repaid by the
    // dispatch-only refund job after review (scripts/refund-run.js: dry by
    // default, capped, approved per run). A buyer told "automatically" waits
    // for money that arrives on a review cycle, so the claim is allowed only
    // where the same passage names the card path.
    re: /\b(?:refunded|repaid|reimbursed)\s+automatically\b|\bautomatic(?:ally)?[- ](?:refund|repa|reimburs)|\bauto-?refund|\b(?:refunds?|repayments?)\b[^.]{0,40}\b(?:is|are) automatic\b/i,
    why: "only the card path refunds on its own; a charge on the x402/MPP rails is recorded as owed in the refund ledger and repaid after review",
    // A card passage names its rail within a line or two (the wiki states the
    // Stripe-verified session one bullet above its refund bullet).
    scopedBy: /\bcard\b|\bStripe\b|\bCheckout\b/i,
    scopeWindow: 2,
  },
  {
    // "500+ deterministic web tools" slipped past this for months: the "+"
    // between the count and the word broke the old digit-then-space match.
    re: /(?:\d\+?|\}\+?|\b[Aa]ll|\b[Ee]very) deterministic (?:\w+ )?tools\b/,
    why: "the catalog count includes model-backed entries; say priced endpoints",
  },
  {
    re: /[Ee]very tool is deterministic/,
    why: "the /v1 tiers, the report products and the media tools are model-backed",
  },
  {
    // The same claim about the catalog, written as "500+ tools ... Every one
    // deterministic" on /101 and /agentic-finance. Neither earlier rule saw it:
    // the count and the adjective sat in different sentences.
    re: /\b[Ee]very one(?: of them)?,? (?:is )?deterministic\b|\b(?:[Tt]ool )?[Oo]utput is deterministic for the same input\b/,
    why: "the catalog includes model-backed and live-data tools; say priced per call and name the model-backed ones",
  },
  {
    // The same claim with a word in the middle, which the rule above missed on
    // the blog for months: "Every Agent402 tool is deterministic", "every one
    // deterministic", "Every one of those tools is deterministic".
    re: /\b[Ee]very (?:one|(?:\w+ )?tool)\b[^.]{0,30}\bdeterministic\b/,
    why: "the catalog holds model-backed tools; scope it to the utility tools",
    // A dated correction note quotes the old claim to retract it.
    scopedBy: /\bCorrection\b|\butility\b|\bclaimed\b/,
    scopeWindow: 0,
  },
  {
    // A COMPLETENESS CLAIM ABOUT A SURFACE THAT ANSWERS WITH A PAGE.
    //
    // Three live instances before this rule existed, all the same shape - the
    // DATA was right and the CONTRACT was quiet, so a consumer read a partial
    // answer as the whole set:
    //
    //   1. llms.txt called GET /api/index "a JSON snapshot of every seller
    //      indexed". It returns 250 of 4,473. A seller's checker searched the
    //      one page it was given, did not find them, and reported them missing
    //      from the index; they were on page 15 of 18.
    //   2. /api/index?seller= cut the tool list at 500 with nothing saying so,
    //      on the surface we tell sellers to self-diagnose with.
    //   3. /api/leaderboard was described on ten surfaces as "the on-chain
    //      ranking of EVERY x402 seller". It answers with 25 rows, ceiling 50.
    //
    // The rule matches the SHAPE, not any one sentence, because the claim has
    // as many phrasings as people who wrote it down: a totality word next to
    // one of the paginated surfaces. It is satisfied - and must be - by saying
    // which part you get, so the honest forms below all pass.
    re: /\b(?:every|all|each|the whole|entire|complete|full)\b[^.|]{0,70}\b(?:seller|tool|row|origin|endpoint|histor(?:y|ies))s?\b[^.|]{0,90}\/api\/(?:index|leaderboard)|\/api\/(?:index|leaderboard)\b[^.|]{0,90}\b(?:every|all|the whole|entire|complete|full)\b[^.|]{0,40}\b(?:seller|tool|row|origin|endpoint|histor(?:y|ies))s?\b|\b(?:ranking|snapshot|list(?:ing)?|index)\b[^.|]{0,20}\bof every\b[^.|]{0,30}\b(?:seller|tool|origin)s?\b|\/api\/index\b[^.]{0,60}\bsnapshot\b|\bsnapshot\b[^.]{0,60}\/api\/index/i,
    why: "/api/index and /api/leaderboard both answer with ONE PAGE (250 sellers max; 25 leaderboard rows, ceiling 50) - say which part the caller gets, and name the field carrying the total (sellerCount / totalSellers)",
    // The totality word has to govern WHAT THE SURFACE RETURNS. Without this
    // the rule also read four pieces of honest copy as the same claim: a
    // JSON-LD list item NAMING the marketplace page, a legend saying which
    // field a reason appears in ("on each row and on /api/index"), a dated
    // comment about a bug that published network:null for every seller, and
    // the README's dispatch-labelling guarantee. Each puts a totality word
    // near the path while claiming nothing about completeness, and a guard
    // that flags those gets suppressed by the next author.
    // `\W{0,4}` between the noun and "of" is load-bearing: the claim ships in
    // markdown tables as "**On-chain ranking** of every x402 seller", and a
    // literal /ranking of/ misses it because of the emphasis markers. A
    // mutation restoring that exact README row SURVIVED this rule until the
    // tolerance was added - which is why the mutation is run, not assumed.
    requires: /\b(?:returns?|answers?|serves?|exposes?|drill-down|is in|are in|is the (?:public|live|open))\b|\b(?:ranking|snapshot|listing|index)\W{0,4}of\b/i,
    // True as written when the same sentence says it is a part. Naming the
    // paging field counts: that is the contract a machine actually reads.
    scopedBy: /\b(?:top[- ]?N|top \d|first \d|one page|a page|per page|paginat|page at a time|head of|slice|truncat|not the whole|never the whole|sellerCount|totalSellers|complete: false|rel="next"|\?seller=)\b/i,
    scopeWindow: 0,
    exempt: new Map([
      ["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"],
      ["src/index-paging.js", "the module that implements the paging contract quotes the old claim to explain why it exists"],
      ["scripts/test-copy-absolutes.js", "this rule's own comment and its MUST_FAIL table quote the claims verbatim"],
    ]),
  },
  {
    // Copy written for every reader says "plain language": naming one
    // language for clear writing leaves out readers of every other. Hyphen or
    // space, any case, in copy and in comments alike.
    re: /\bplain[- ]english\b/i,
    why: 'say "plain language": the phrase names one language for clear writing',
    exempt: new Map([
      ["src/changelog.js", "dated release notes are a historical record: each entry describes what shipped on its date"],
      ["src/x402-index.js", "a comment quotes a placeholder value a listing may carry, as written"],
    ]),
  },
];

// The one sentence holding a match: from the last ". " (or "; ") before it to
// the first one after it.
function sentenceAround(text, at, len) {
  const before = text.slice(0, at);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "), before.lastIndexOf("? ")) + 1;
  const rest = text.slice(at + len);
  const ends = [rest.indexOf(". "), rest.indexOf("; "), rest.indexOf("? ")].filter((x) => x >= 0);
  const end = ends.length ? at + len + Math.min(...ends) : text.length;
  // Within the sentence, a scope word counts only near the claim: "...by card"
  // closing a long list is about something else.
  return text.slice(Math.max(start, at - 80), Math.min(end, at + len + 80));
}

function sweep(entries) {
  const found = [];
  for (const [rel, text] of entries) {
    if (text == null) continue;
    const lines = text.split("\n");
    for (const { re, why, scopedBy, exempt, requires, scopeWindow = 0, scopeSentence = false, only = null, skipComments = false, skipLine = null, ownLine = false, scopeNear = null, scopeLines = 0 } of FORBIDDEN) {
      if (exempt?.has(rel)) continue;
      if (only && !only.test(rel)) continue;
      for (let i = 0; i < lines.length; i++) {
        const isComment = (l) => skipComments && /^\s*(?:\/\/|\*|\/\*)/.test(l || "");
        if (isComment(lines[i])) continue;
        if (skipLine && skipLine.test(lines[i])) continue;
        const sentence = `${lines[i]} ${isComment(lines[i + 1]) ? "" : lines[i + 1] || ""}`;
        const m = sentence.match(re);
        if (!m) continue;
        if (requires && !requires.test(sentence)) continue;      // a different subject entirely
        // A claim that begins on the next line is judged there, with that
        // line's own neighbors as its scope.
        if (ownLine && m.index > lines[i].length) continue;
        const above = i > 0 && !isComment(lines[i - 1]) ? `${lines[i - 1]} ` : "";
        const near = scopeNear
          ? `${above}${sentence}`.slice(Math.max(0, above.length + m.index - scopeNear[0]), above.length + m.index + m[0].length)
            + (scopeNear[2] === "open" ? (x) => x : clauseEnd)(sentence.slice(m.index + m[0].length, m.index + m[0].length + scopeNear[1]))
          : scopeLines
          ? lines.slice(Math.max(0, i - 1), i + 1 + scopeLines).filter((l) => !isComment(l)).join(" ")
          : scopeSentence
          ? sentenceAround(sentence, m.index, m[0].length)
          : scopeWindow
            ? lines.slice(Math.max(0, i - scopeWindow), i + 2).join(" ")
            : sentence;
        if (scopedBy?.test(near)) continue;                      // scoped in its own sentence
        found.push(`${rel} carries "${m[0].trim()}" (${why})`);
        break;
      }
    }
  }
  return found;
}

// Control FIRST: a planted file must be reported by the same code path the
// real sweep uses, or a clean run proves nothing.
const control = sweep([["<control>", "Only sellers with proven on-chain settlement are routable."],
                       ["<control>", "Agent402 never holds funds."],
                       ["<control>", "The agent signs - Agent402 never touches funds."],
                       ["<control>", "A failed call is never charged."],
                       ["<control>", "- **Failures are not charged.** Any 4xx/5xx - no match, over-cap, seller down - cancels your settlement."],
                       ["<control>", "Spend stops at your budget, fallbacks run in order, and a run where no step succeeds is not charged."],
                       ["<control>", "The decision could not be made. Nothing was charged."],
                       ["<control>", "A run where no step succeeds is not charged over MPP."],
                       ["<control>", "A 4xx is never charged, nothing owed."],
                       ["<control>", "Any failed call is not charged (we accept proof-of-work)."],
                       ["<control>", "If the seller does not answer, nothing is charged."],
                       ["<control>", "Branch on the code; the message text may change. An answer of 400 or above is never charged."],
                       ["<control>", "Flat pricing for ${n} deterministic web tools."],
                       ["<control>", "Every tool is deterministic."],
                       ["<control>", "If it was, the charge is recorded as owed and refunded automatically."],
                       ["<control>", "500+ pay-per-call tools. Every one deterministic, priced, and settled on chain."],
                       ["<control>", "Pay in USDC on Base + 9 more chains, or USDG on Robinhood Chain (10 chains total)."],
                       ["<control>", "over x402 (USDC on 10 chains) or MPP"],
                       ["<control>", "500+ strong: 400+ pay-per-call tools (x402 or MPP) + 70+ skill packs"],
                       ["<control>", "Text-to-video over x402 - one clip. The call returns when ready; a failed or timed-out generation is never charged."],
                       ["<control>", "Why pay here (a failed call is not charged and the receipt proves it, keyed retries never pay twice, one key for tools + models + reports, or a report by card)"],
                       ["<control>", "Poll the job link until it is completed. Payment settles only on a delivered result."],
                       ["<control>", "The server runs your call and settles only on a successful result."],
                       ["<control>", "A 200 is charged only if its settlement then succeeds."],
                       ["<control>", "A call that timed out is not retried; it fails uncharged."],
                       ["<control>", "Over x402 a failure cancels settlement. You pay only for delivered results."],
                       ["<control>", "<h3>Is this Solana token safe to touch</h3>"],
                       ["<control>", "Site pages meet WCAG 2.1 AA on contrast, labels, links and keyboard access."],
                       ["<control>", "x402 and MPP explained in plain English, for people."],
                       ["<control>", "A Plain-English guide to the terms."],
                       ["src/<control>.js", "<p><strong>Twelve chains.</strong> A buyer pays on whichever chain"],
                       ["src/<control>.js", "settling USDC on Base (plus eleven more rails), across all twelve chains"],
                       ["src/<control>.js", "// a comment that says twelve chains is not served copy"]]);
const CONTROL_EXPECTED = 41;
ok(control.length === CONTROL_EXPECTED, `control: the sweep reports all 32 planted copy lines (and skips the planted comment) (${CONTROL_EXPECTED} rule hits; a line can match more than one rule) through its real code path (got ${control.length})`);

for (const hit of sweep(files.map((rel) => [rel, read(rel)]))) { fail++; console.error(`FAIL - ${hit}`); }
ok(files.length >= 300, `swept ${files.length} copy surfaces (a collapsed file list must fail, not pass quietly)`);
ok((read("src/why.js") || "").length > 500 && (read("adapters/agentkit/README.md") || "").length > 500,
   "...and the sweep really reached both a served page and a published package README");
// Coverage is asserted, not inferred: with the tree clean, dropping a whole
// CLASS of file from the walk changes no result, so the only way that regresses
// loudly is to name the class here.
ok(files.some((f) => /^scripts\/.*card.*\.js$/.test(f)),
   "...and the card generators, which render public submission and announcement artifacts");
ok(["src/guides.js", "src/seo.js", "src/pages.js", "src/learn.js", "src/skill-md.js", "src/decide-page.js", "src/integration-pages.js", "src/human-reports-page.js", "wiki/FAQ.md", "README.md", "mcp/README.md"].every((f) => COPY_SURFACES.test(f)) && !COPY_SURFACES.test("src/tools/decide-kit.js") && !COPY_SURFACES.test("src/server.js"),
   "the copy-surface pattern reaches the page modules, the wiki, the READMEs, and not the modules that answer paid requests");

// --- the routing sentence is derived, and honest in BOTH directions --------
{
  const mod = await import("../src/routing-proof.js");
  const before = process.env.SOR_SVM_UNPROVEN_MAX_USD;
  const beforeBase = process.env.SOR_BASE_UNPROVEN_MAX_USD;

  delete process.env.SOR_SVM_UNPROVEN_MAX_USD;   // the shipped defaults
  delete process.env.SOR_BASE_UNPROVEN_MAX_USD;
  const beforeDay = process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;
  delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;
  const live = mod.routingProofSentence();
  ok(/proven on-chain settlement/.test(live), "the sentence still leads with the proof requirement");
  ok(/one exception/.test(live) && /\$0\.05 a call on Base/.test(live) && /\$0\.01 a call on Solana/.test(live),
     "with the tier on its live default the sentence NAMES the exception and each chain's ceiling");
  ok(/at most \$0\.25 a day per seller, \$5\.00 a day in all/.test(live), "...and Base's per-seller and lane-wide daily caps beside Base's figure");
  // README cannot call the function, so its typed figures are pinned to the defaults here.
  {
    const { BASE_UNPROVEN_DEFAULT_USD, BASE_UNPROVEN_SELLER_DAILY_DEFAULT_USD, BASE_UNPROVEN_LANE_DAILY_DEFAULT_USD } = await import("../src/base-unproven.js");
    const { svmUnprovenAllowanceAtomic } = await import("../src/solana-buyer.js");
    const { usdFigure: fig } = await import("../src/price-usd.js");
    const readme = (read("README.md") || "").replace(/\n> ?/g, " ").replace(/\s+/g, " ");
    ok(readme.includes(`calls priced at ${fig(BASE_UNPROVEN_DEFAULT_USD)} or less on Base (up to ${fig(BASE_UNPROVEN_SELLER_DAILY_DEFAULT_USD)} a day per seller and ${fig(BASE_UNPROVEN_LANE_DAILY_DEFAULT_USD)} a day in all) or ${fig(Number(svmUnprovenAllowanceAtomic()) / 1e6)} or less on Solana`),
       "README's seller line quotes the shipped unproven ceilings, the per-seller daily cap and the lane total, each in usdFigure's format");
  }
  ok(/after every proven candidate/.test(live) && /flagged unproven/.test(live),
     "...and says the two things that make the exception bounded: ordering and the receipt flag");
  ok(/on Base/.test(live) && /on Solana/.test(live), "both chains' tiers are named while both are on");

  process.env.SOR_SVM_UNPROVEN_MAX_USD = "off";
  ok(/on Base/.test(mod.routingProofSentence()) && !/on Solana/.test(mod.routingProofSentence()), "switching one chain's tier off drops only that chain from the sentence");
  process.env.SOR_BASE_UNPROVEN_MAX_USD = "off";
  const off = mod.routingProofSentence();
  ok(!/exception/.test(off), "switch the tier off and the absolute comes back on its own, rather than being stale in the other direction");

  process.env.SOR_SVM_UNPROVEN_MAX_USD = "0.25";
  ok(/\$0\.25/.test(mod.routingProofSentence()), "the ceiling is read from the env the router reads, not typed");
  delete process.env.SOR_SVM_UNPROVEN_MAX_USD;
  process.env.SOR_BASE_UNPROVEN_MAX_USD = "0.03";
  ok(/\$0\.03 a call on Base/.test(mod.routingProofSentence()), "the Base ceiling is read from its own env too");
  process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD = "0.4";
  ok(/at most \$0\.40 a day per seller/.test(mod.routingProofSentence()), "the per-seller daily cap is read from its env");
  process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD = "off";
  ok(!/a day per seller/.test(mod.routingProofSentence()), "switched off, the daily cap is not claimed");
  process.env.SOR_BASE_UNPROVEN_DAILY_USD = "12";
  ok(/\$12\.00 a day in all/.test(mod.routingProofSentence()), "the lane-wide daily cap is read from its env");
  process.env.SOR_BASE_UNPROVEN_DAILY_USD = "off";
  ok(!/a day in all/.test(mod.routingProofSentence()), "switched off, the lane-wide cap is not claimed");
  delete process.env.SOR_BASE_UNPROVEN_DAILY_USD;
  delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;

  if (before === undefined) delete process.env.SOR_SVM_UNPROVEN_MAX_USD;
  else process.env.SOR_SVM_UNPROVEN_MAX_USD = before;
  if (beforeBase === undefined) delete process.env.SOR_BASE_UNPROVEN_MAX_USD;
  else process.env.SOR_BASE_UNPROVEN_MAX_USD = beforeBase;
  if (beforeDay !== undefined) process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD = beforeDay;

  // Every page that makes the claim must call the function. A page that
  // reworded the absolute by hand would pass the regex sweep above.
  for (const rel of ["src/why.js", "src/glossary.js", "src/agentic-finance.js", "src/blog.js", "src/guides.js"]) {
    ok(/routingProofSentence\(\)/.test(read(rel) || ""), `${rel} renders the routing claim from the shared function`);
  }
}

// --- the manifest states its own scope, which a boolean cannot -------------
{
  const { serviceManifest } = await import("../src/discovery.js");
  const m = serviceManifest({
    baseUrl: "https://agent402.tools", network: "base", networks: ["base"],
    wallet: "0x0000000000000000000000000000000000000000", walletName: "agent402.base.eth",
    catalog: {}, toolCount: 0, powSlugs: [], powDifficulty: 16, prices: {},
  });
  const flat = JSON.stringify(m);
  const grab = (k) => {
    const seen = [];
    const walk = (o, d = 0) => {
      if (d > 6 || !o || typeof o !== "object" || seen.includes(o)) return undefined;
      seen.push(o);
      if (Object.hasOwn(o, k)) return o[k];
      for (const v of Object.values(o)) { const r = walk(v, d + 1); if (r !== undefined) return r; }
      return undefined;
    };
    return walk(m);
  };
  for (const k of ["deterministic", "testedBeforeEveryDeploy", "nonCustodial"]) {
    const v = grab(k);
    ok(typeof v === "string" && v.length > 40,
       `${k} is a sentence that states its own exceptions, not a boolean that cannot (${typeof v})`);
  }
  ok(/model-backed/.test(flat) && /metered/.test(flat) && /credits/.test(flat),
     "...and those sentences actually name what is excluded (the model-backed tools, the metered routes, the prepaid credits)");
}

// --- the catalog knows which of its own entries are model-backed -----------
// /api/pricing publishes `modelBacked` per row, which is a MACHINE-READABLE
// claim on 580+ endpoints and so a worse place to be wrong than the prose this
// guard started with. The first cut asserted only that the symbols EXIST, with
// a comment claiming a new model-backed kit "cannot be counted as deterministic
// by omission" - and that was false: dropping a whole kit from
// MODEL_BACKED_KITS published modelBacked:false for every one of its tools and
// left all guards green (measured). Membership is derived from the kits' own
// SOURCE here instead: a file that reaches a model upstream must have its tool
// array in the list, directly or through one alias hop.
{
  const server = read("src/server.js") || "";
  ok(/MODEL_BACKED_SLUGS/.test(server) && /export function isModelBacked/.test(server),
     "the catalog derives modelBacked from the kits rather than a hand-kept slug list");

  const MODEL_UPSTREAM = /openrouter\.ai|api\.openai\.com|callOpenRouter|OPENROUTER_API_KEY|anthropic\.com\/v1\/messages/;
  const kitFiles = files.filter((f) => f.startsWith("src/tools/") && MODEL_UPSTREAM.test(read(f) || ""));
  ok(kitFiles.length >= 15, `found ${kitFiles.length} kits that reach a model upstream (a collapsed list must not pass)`);

  // `const NAME = [ ...A, ...B ];` in server.js, so one alias hop resolves -
  // GATEWAY_TOOLS_ENABLED is really the gateway plus the Messages and Responses
  // kits, and without the hop those three would read as uncovered.
  const spreadsIn = (name) => {
    const m = server.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`));
    return m ? new Set(m[1].match(/\.\.\.([A-Z0-9_]+)/g)?.map((x) => x.slice(3)) || []) : new Set();
  };
  const listed = spreadsIn("MODEL_BACKED_KITS");
  ok(listed.size > 0, "MODEL_BACKED_KITS is readable from source");
  const reachable = new Set(listed);
  for (const n of listed) for (const inner of spreadsIn(n)) reachable.add(inner);

  // A function, so the control drives the SAME code path: an "assert no
  // findings" check with no control passes just as happily when it is broken.
  const exportsOf = (f) => ((read(f) || "").match(/^export const ([A-Z0-9_]+_TOOLS[A-Z0-9_]*)/gm) || [])
    .map((x) => x.replace("export const ", ""));
  function uncovered(kits, inList, exports = exportsOf) {
    const out = [];
    for (const f of kits) {
      const ex = exports(f);
      if (!ex.length) continue;                     // helper-only module
      if (ex.some((n) => inList.has(n))) continue;  // covered, directly or via an alias
      out.push(`${f} exports ${ex.join(", ")}`);
    }
    return out;
  }
  ok(uncovered(["<control>"], reachable, () => ["NOT_IN_THE_LIST_TOOLS"]).length === 1,
     "control: a model-reaching kit absent from MODEL_BACKED_KITS is reported by this exact code path");

  const missing = uncovered(kitFiles, reachable);
  ok(missing.length === 0,
     `every kit that reaches a model upstream is in MODEL_BACKED_KITS${missing.length ? ` - MISSING: ${missing.join(" | ")}` : ""}`);

  // Two shapes the check above could not see (2026-10-02): a kit that reaches
  // its model through an internal SERVICE it calls over HTTP (decide-kit ->
  // DECIDE_SERVICE_URL -> services/decide/llm.js), and a kit that BUILDS its
  // tools in a function (`export function buildDecideTools`) rather than
  // exporting a *_TOOLS const - both read as "helper-only" and were skipped,
  // so decide published modelBacked:false.
  const serviceKits = files.filter((f) => f.startsWith("src/tools/")).filter((f) => {
    const svc = [...(read(f) || "").matchAll(/process\.env\.([A-Z]+)_SERVICE_URL/g)].map((m) => m[1].toLowerCase());
    return svc.some((name) => files.some((g) => g.startsWith(`services/${name}/`) && MODEL_UPSTREAM.test(read(g) || "")));
  });
  ok(serviceKits.includes("src/tools/decide-kit.js"), `a kit that calls a model-running service is detected (found: ${serviceKits.join(", ") || "none"})`);
  const builderExports = (f) => {
    const src = read(f) || "";
    const consts = (src.match(/^export const ([A-Z0-9_]+_TOOLS[A-Z0-9_]*)/gm) || []).map((x) => x.replace("export const ", ""));
    const builders = (src.match(/^export function (build[A-Za-z0-9]*Tools)\b/gm) || []).map((x) => x.replace("export function ", ""));
    // A builder is covered when server.js binds its result to a const that is listed.
    const bound = builders.flatMap((b) => [...server.matchAll(new RegExp(`const ([A-Z0-9_]+)\\s*=[^;\\n]*\\b${b}\\(`, "g"))].map((m) => m[1]));
    return [...consts, ...bound, ...(builders.length && !bound.length ? builders : [])];
  };
  ok(uncovered(["<control>"], reachable, () => ["DECIDE_LIKE_UNLISTED"]).length === 1, "control: an unlisted builder-bound kit is reported");
  const missing2 = uncovered([...new Set([...kitFiles, ...serviceKits])], reachable, builderExports);
  ok(missing2.length === 0,
     `every kit that reaches a model (directly or through its service), incl. builder-made tools, is in MODEL_BACKED_KITS${missing2.length ? ` - MISSING: ${missing2.join(" | ")}` : ""}`);

  // A tool whose OWN description says its output is generated must say so in
  // the catalog too: such a tool inside an otherwise deterministic kit declares
  // `modelBacked: true` on its definition (server.js folds it in). One such tool
  // said "Model-backed" in its description and published modelBacked:false.
  ok(/def\?\.modelBacked === true/.test(server), "server.js folds a definition's own modelBacked:true into MODEL_BACKED_SLUGS");
  const GENERATED = /Model-backed|AI-generated|answer text is generated/;
  const undeclared = [];
  for (const f of files.filter((x) => x.startsWith("src/tools/"))) {
    const src = read(f) || "";
    if (exportsOf(f).some((n) => reachable.has(n))) continue; // whole kit is listed
    const parts = src.split(/\n\s+slug: "/).slice(1);
    for (const seg of parts) {
      const slug = seg.slice(0, seg.indexOf('"'));
      if (GENERATED.test(seg) && !/\bmodelBacked: true\b/.test(seg)) undeclared.push(`${f}:${slug}`);
    }
  }
  ok(undeclared.length === 0, `a tool describing generated output declares modelBacked: true${undeclared.length ? ` - MISSING: ${undeclared.join(", ")}` : ""}`);

  // Packs inherit: a pack running a model-backed tool is model-backed.
  ok(/modelBackedPackSlugs\(SKILL_PACKS, isModelBacked\)/.test(server), "skill packs derive modelBacked from the tools they run");
}

// --- the class rules are pinned in BOTH directions -------------------------
// A shape-matching rule earns its keep only if the honest phrasings are proven
// to pass; otherwise the next author suppresses it and the guard is decoration.
{
  const MUST_FAIL = [
    // The "settles only" and "uncharged" forms, each as it shipped.
    "Poll GET /api/jobs/{id} (free) until status is completed or failed. Payment settles only on a delivered result.",
    "is. Payment settles only on the answer.",
    "Either way the payment settles only on a delivered report.",
    "Because settlement happens only after a call succeeds, the ordinary failure case costs nothing and needs no refund.",
    "4. agent402.tools returns the real, structured result, and settles only on success",
    "A call that timed out or came back empty is not retried, since it may already have been generated; it fails uncharged.",
    "none: one model at one price, and an upstream failure is an uncharged error",
    "the route answers 503 before any upstream call (a >=400 cancels settlement, so no buyer is charged)",
    // A rail named a paragraph away does not scope the claim (SCOPE_NEAR).
    `The npm server pays over x402 from a key you give it. ${"A caller that sends a progressToken gets progress notifications from the job's stage, steps and ETA. ".repeat(3)}Payment settles only on the delivered answer.`,
    "it fails uncharged. `/api/gateway-status` reports `speechUpstream` as `ok`, `cooling` or `probing`.",
    "cancels your settlement, and a Tempo transfer sent before the call is recorded as owed. You pay only for delivered results.",
    // A rail named in the NEXT sentence does not scope the claim: each of
    // these is a served line with its exception clause taken out.
    "say where it is. Payment settles only on the delivered answer; agent402-client and agent402-mcp do this on their own. **Making many calls? Pay once instead of signing each one.** Exact x402 is one signature and one settlement per request.",
    "until status is completed or failed (state shows queued, running, succeeded or failed). Payment settles only when the result is ready; on x402 a failed run is not charged.",
    "payment settles only when the result is ready, and\na refused payment ends the job with its 402. On x402 a failed run is not charged.",
    "your payment and **settles only when the answer is ready**: a failed run is not charged on x402, and a refused payment ends the job with its `402`.",
    "runs the call with your payment, and settles only on a successful result. A run that fails is not charged on x402, and the job says so.</p>",
    // A style token beside the claim is not a rail.
    "<code style=\"font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);\">GET /api/jobs/{id}</code> until it is completed or failed. Payment settles only when the result is ready.</p>",
    // The same rule said as "is not settled", with no rail beside it.
    "The settlement rule is the same everywhere: a call that answers an error\nstatus, or whose payment does not match the offer, is not settled, on any of",
    // A storefront card is charged at Checkout, not on delivery.
    "Either way an x402, MPP evm or card payment settles only on a delivered report.",
    // A debt with no word on how it is repaid.
    "- **Failures are not charged on x402.** Any 4xx/5xx - no match, over-cap, seller\n  down - cancels your settlement, and a Tempo transfer sent before the call is recorded as owed.",
    "Payment settles only when the result is ready, except a Tempo transfer sent before the call, which is recorded as owed if the run fails.",
    // The x402 claim with neither exception /terms lists beside it.
    "the signature, runs the tool, and settles an x402 payment only when the\ntool succeeded. A failed x402 call is not charged.",
    "authorization from its own wallet and retries, and the server settles only when\nthe response succeeds, so a failed x402 call is not charged. The headers, step",
    // The issue form and a pager body, as they read before they named a rail.
    "A failed call is never charged, so a receipt on a non-200 is itself a bug.",
    "When it empties, route-execute external buys and seller-payability refuse (buyers are never charged, but those paths go dark).",
    "the Smart Order Router resolves the best-matching external seller. Sellers qualify only with proven on-chain settled volume.",
    // The two sentences a plugin registry displayed in full from SKILL.md.
    "500+ deterministic web tools an agent can call over plain HTTP, paid per call.\nNo LLM sits in the serving path on Agent402's side; every response is a",
    "Pay-per-call access to Agent402.Tools: 500+ deterministic web tools (browser rendering",
    "Only sellers with proven on-chain settlement are routable.",
    "Only sellers with proven settlement are routable.",
    "it routes only to sellers with proven on-chain settled volume",
    "So we route ONLY to sellers with proven settled volume",
    "open source and self-hostable, no model in the tool serving path.",
    "no LLM in the serving path - the same input always yields the same output",
    // Wrapped across lines, the way a comment or a paragraph really wraps.
    // Without joining the pair the claim is invisible to a line-by-line match.
    "// So we route ONLY to sellers with\n// proven settled volume: the leaderboard is real deliveries",
    // A chain named three lines EARLIER is prose, not a scope: still a failure.
    // (The window reads backward, so this is the side that pins scopeWindow 0.)
    "We settle on Base.\nOne payment in, result out.\nPrices are flat.\nOnly sellers with proven settlement are routable.",
    // The completeness class. Every one of these was live copy.
    "GET /api/index: a JSON snapshot of every seller indexed",
    "`GET /api/leaderboard` returns the live on-chain ranking of every x402 seller by Base USDC settled volume",
    "| `GET /api/index` | JSON snapshot of the same data: per-seller health, routable, rolling history, totals |",
    // The real two-line shape this shipped in: the path on one line, the claim
    // wrapped onto the next. A line-by-line match cannot see it.
    "app.get(\"/api/index\", (req, res) => {\n  // the per-seller drill-down (full tool list, paid\n  // flags) so a seller can self-diagnose",
    "GET /api/index exposes every seller's health, routable flag, and rolling history",
    "The full history is in /api/index for anyone to verify",
    "public on-chain ranking of every seller by Base USDC settled volume (/api/leaderboard)",
    // Wrapped, the way a table row or a paragraph really wraps.
    "the on-chain ranking of every x402 seller\nby Base USDC settled volume - see /api/leaderboard",
    // The automatic-refund class: the two connector messages as they shipped,
    // and the other phrasings of the same promise.
    "The call may still have completed and been charged. If it was, the charge is recorded as owed and refunded automatically. Do not retry blindly: a retry is a new paid call.",
    "Cancelled at your request. The run may still have completed and been charged; if it was, the charge is recorded as owed and refunded automatically.",
    "A charge that reached no answer is automatically refunded to the paying wallet.",
    "Undelivered calls are auto-refunded on chain.",
    "Refunds for a failed paid call are automatic.",
    // The noun forms of the not-charged claim, each as it shipped.
    "A 4xx or 5xx is never charged.",
    "one whose duration cannot be read answers `422` and is not charged.",
    "a request whose quote would exceed the cap is refused with a `400` naming the cap (a `4xx` cancels settlement, so nothing is charged)",
    "A run that fails is not charged, and the job says so.",
    "whoseFault: \"not your input - a third party this tool depends on refused or failed our request, and you were not charged\"",
    "- **400** - your input failed validation; the body says what to fix. Not charged.",
    // The catalog-wide determinism claim as it shipped on /101, /agentic-finance,
    // SKILL.md and /terms.
    "Every one deterministic, priced, tested, settled on chain over x402 or MPP.",
    "Every one deterministic, priced, and settled on chain, over x402 or MPP.",
    "- **200 + JSON** - the result. Tool output is deterministic for the same input.",
    "small, deterministic web tools - same input, same output; no large language model runs in that serving path.",
    // The determinism class with a word in the middle (all three were blog copy).
    "Every Agent402 tool is deterministic: same input, same output, every time.",
    "The Agent402 catalog passed the 500-tool mark - every one deterministic, tested in CI",
    "Every one of those tools is deterministic, tested in CI, and callable with a single HTTP request.",
  ];
  const MUST_PASS = [
    "On Base we route ONLY to sellers with proven settled volume",
    "Sellers are routable on proven on-chain settlement, with one exception: a Solana seller with no settlement history yet is tried only after every proven candidate.",
    "no LLM in the serving path of the utility tools - the same input always yields the same output",
    "The deterministic tools run no model in their serving path",
    "the leaderboard ranks sellers by settlements actually observed on chain",
    "UNKNOWN does not block - we only refuse on a positive MISMATCH, so sellers proven by a source that cannot name an address are unaffected",
    "instead of USDC - no money and no AI tokens (no model in the serving path of these tools)",
    // The no-model rule DOES read a small window: its honest uses open a
    // paragraph with the scope and qualify a clause a line or three below.
    "Agent-kit - the deterministic tools an agent needs most:\nexact token counting and chunking. All pure-CPU,\nno network,\nno LLM in the serving path.",
    // The completeness class, said honestly. Each of these is a shipped fix:
    // the claim survives, scoped to the part the caller is actually handed.
    "GET /api/index: the seller index, PAGINATED - one page, 250 max, never the whole set. sellerCount carries the total",
    "GET /api/leaderboard returns the top N of the ranking of x402 sellers; totalSellers carries the full count",
    "| `GET /api/index` | The same data as JSON, one page at a time (250 max): per-seller health, routable, totals |",
    "GET /api/index exposes each seller's health and routable flag, a page at a time; the rolling history is on ?seller=<host>",
    "Top N of the on-chain ranking of sellers by Base USDC settled volume (25 default, 50 ceiling)",
    // A totality claim about something that really is whole must keep passing,
    // or the rule pushes authors into hedging true sentences.
    "every route and price is in /openapi.json and /api/pricing",
    "The catalog is capped - every tool here earns its place and answers its own example on every deploy",
    "Every one priced per call and settled on chain over x402 or MPP; the model-backed ones are marked as such.",
    // The card path really does refund on its own, and says so in these forms.
    "<span> If a report fails, you're auto-refunded</span><span><span class=\"dot\"></span> Secured by Stripe</span>",
    "Payment is verified before anything is generated; if generation fails after payment, the card is refunded automatically and the x402 settlement is cancelled.",
    "- No report is generated without a Stripe-verified paid session, and a session generates **once**.\n- A run that fails is **refunded automatically**; a refund that could not be issued is recorded as owed and retried.",
    "Checkout, generate-once per paid session, auto-refund on failure, report at",
    // What the connector says now.
    "The call may still have completed and been charged. If it was, the charge is recorded as owed in our refund ledger and repaid after review. Do not retry blindly: a retry is a new paid call.",
    "The utility tools are deterministic: same input, same output, every time.",
    "Correction (2026-10-02): this post called every tool deterministic. The utility tools are.",
    // Rail counts that match src/rails.js, and the evergreen catalog count.
    `pay in USDC on ${USDC_RAILS} chains or USDG on Robinhood Chain (${ALL_RAILS} chains total)`,
    `USDC on Base + ${USDC_RAILS - 1} more chains, or USDG on Robinhood Chain`,
    "500+ pay-per-call tools and skill packs",
    "the 150+ pure-CPU tools are free via proof-of-work",
    // The same claims with their rail, or the push exception, beside them.
    "- **Failures are not charged on x402.** Any 4xx/5xx - no match, over-cap, seller\n  down - cancels your settlement, and a Tempo transfer sent before the call is recorded as owed and repaid after on-chain proof.",
    "and a run where no step succeeds is not charged, except a Tempo transfer sent before the call, which is recorded as owed and repaid after on-chain proof.",
    "A 4xx/5xx is not charged on x402: settlement runs after the handler and only on a response under 400.",
    "A paid call that ends in any status of 400 or above is not charged over x402, MPP and a prepaid credits key: settlement is canceled when the tool fails.",
    // The shared footnote (src/settlement-footnote.js) every tool and integration page renders.
    "A paid call that ends in any status of 400 or above is not charged over x402, MPP or a prepaid credits key: settlement runs after the tool and only on a successful response.",
    "An unpaid 402 charges nothing.",
    // The shared footnote as each page renders it, built by the module itself.
    failedCallFootnote(),
    failedCallFootnote({ rails: ["x402", "MPP"], tempoPush: true }),
    // A handler's refusal is restated per rail at send, so its line is not copy.
    "    throw bad(\"The decision service failed - not charged; retry shortly\", 502);",
    // The "settles only" form with its rail or the push exception beside it.
    "Payment settles only when the result is ready, except a Tempo transfer sent before the call, which is repaid after on-chain proof if the run fails.",
    "The x402 payment settles only on the delivered answer.",
    "Either way an x402 or MPP evm payment settles only on a delivered report.",
    "   `@x402/express` verifies the payment, runs the handler, and settles only a\n   response below 400.",
    "a prepaid credits key is debited only on success",
    "it fails, and on x402 that failure is not charged.",
    "export AGENT402_NETWORKS=solana       # pay only on these chains, in this order",
    "Pay for what the model used, with the ceiling quoted first.",
  ];
  const hits = (t) => sweep([["<case>", t]]).length;
  const missed = MUST_FAIL.filter((t) => hits(t) === 0);
  const wrong = MUST_PASS.filter((t) => hits(t) > 0);
  ok(missed.length === 0, `every known phrasing of the class is caught${missed.length ? ` - MISSED: ${missed.join(" | ")}` : ""}`);
  ok(wrong.length === 0, `honest, scoped phrasings are NOT caught${wrong.length ? ` - FALSE POSITIVE: ${wrong.join(" | ")}` : ""}`);

  // The shared exception clauses are read as the sentences they print. A line
  // that names PUSH_EXCEPTION is scoped by the token (the definitions too), so
  // the sweep never reads the words behind it: each value is swept here in the
  // sentence a module builds with it, and must say how the transfer is repaid.
  const { OWED_REPAID, PUSH_EXCEPTION, JOB_PUSH_EXCEPTION } = await import("../src/tempo-push-debts.js");
  const REPAID = /\brepaid after on-chain proof\b/;
  const printed = [
    ["OWED_REPAID", OWED_REPAID, `A Tempo transfer sent before the call is ${OWED_REPAID}.`],
    ["PUSH_EXCEPTION", PUSH_EXCEPTION, `This call was refused before any payment was taken${PUSH_EXCEPTION}.`],
    ["JOB_PUSH_EXCEPTION", JOB_PUSH_EXCEPTION, `Payment settles only when the result is ready${JOB_PUSH_EXCEPTION}.`],
  ];
  const unrepaid = printed.filter(([, value, sentence]) => typeof value !== "string" || !REPAID.test(value) || hits(sentence) > 0).map(([name, value]) => `${name}: ${value}`);
  ok(PUSH_EXCEPTION.includes(OWED_REPAID) && unrepaid.length === 0, `each shared exception clause says how the transfer is repaid, read from its own value${unrepaid.length ? ` - ${unrepaid.join(" | ")}` : ""}`);
}

// --- a handler's "not charged" is restated for a Tempo push payer at send -----
// The rule above leaves a handler's refusal line alone because the Tempo push
// gate rewrites that sentence for the one rail it is false on. That holds only
// while the rewriter recognizes every phrasing the tree actually throws, so
// each unscoped one in a served module is run through it here.
{
  const { rewriteNotChargedForPush } = await import("../src/push-refusal-body.js");
  const PHRASE = /\b(?:not|never) charged\b|\bnothing (?:is|was|has been) charged\b|\bno charge\b/i;
  const SCOPED = /\bx402\b|\bTempo\b|\bcard\b|\bcredits?\b|\bStripe\b|\bEVM\b|\bMPP\b|\bpush\b|\bowed\b|\bunpaid\b/i;
  const unhandled = [];
  const unrepaid = [];
  let checked = 0;
  for (const rel of files.filter((f) => /^src\/.*\.js$/.test(f) && f !== "src/push-refusal-body.js")) {
    const text = read(rel) || "";
    for (const line of text.split("\n")) {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line) || !PHRASE.test(line) || SCOPED.test(line)) continue;
      checked++;
      const restated = rewriteNotChargedForPush(line);
      if (restated === line) unhandled.push(`${rel}: ${line.trim().slice(0, 100)}`);
      else if (/\brecorded as owed\b(?! and repaid after on-chain proof)/.test(restated)) unrepaid.push(`${rel}: ${restated.trim().slice(0, 140)}`);
    }
  }
  ok(rewriteNotChargedForPush("Bad input. Nothing was charged.") !== "Bad input. Nothing was charged." && rewriteNotChargedForPush("This call is not charged on x402.") === "This call is not charged on x402.", "control: the push rewriter restates an unscoped sentence and keeps a scoped one");
  ok(checked >= 40, `the push rewriter was run against ${checked} unscoped handler phrasings (a collapsed count must fail)`);
  ok(unhandled.length === 0, `every unscoped "not charged" a served module throws is one the push gate restates${unhandled.length ? ` - UNHANDLED: ${unhandled.join(" | ")}` : ""}`);
  const clause = rewriteNotChargedForPush("The upstream did not answer in time, so nothing was charged.");
  ok(clause === "The upstream did not answer in time, so the transfer you sent is recorded as owed and repaid after on-chain proof." && unrepaid.length === 0,
    `a restated clause that says the transfer is recorded as owed says how it is repaid (${clause})${unrepaid.length ? ` - NO REPAYMENT: ${unrepaid.join(" | ")}` : ""}`);
}

// --- a converted module says "not charged" through the shared sentence only ---
// The route binder adds the Tempo push exception to one exact sentence
// (src/not-charged.js NOT_CHARGED), and a handler called request-less (a
// skill-pack, decide or route-execute step) runs inside a charged answer,
// where the claim is false. So in a module converted to notChargedOn(req),
// a refusal (bad, refuse, new Error, or a *MESSAGE constant) carries the
// claim only through notChargedOn / NOT_CHARGED, never as typed words. The
// span read is the whole call, so a message split across lines is read too.
{
  const CONVERTED = ["src/tools/decide-kit.js", "src/tools/route-execute.js", "src/tools/llm-gateway-kit.js", "src/bound-request-url.js", "src/tools/stt-kit.js", "src/tools/ocr-kit.js"];
  // A typed claim kept on purpose, each with why it can never print request-less.
  const KEEP = new Map([
    ["src/tools/llm-gateway-kit.js:Input too large", "the claim is on the metered branch only, and a metered tier is never dispatched request-less (dispatchable refuses a def.quote tool); the same error is the pre-payment refusal server.js answers"],
    ["src/tools/decide-kit.js:Unknown decisionId", "also the pre-payment 404 server.js answers before any gate, and decide-execute is never a step (it is long-running, which dispatchable refuses)"],
  ]);
  const CLAIM = /\b(?:not|never) charged\b|\bnothing (?:is|was|has been) charged\b|\bno charge\b|\b(?:run|spent) or charged\b|\bwere not charged\b/i;
  // The text of each refusal call: from "bad(" (or refuse(, new Error() to its
  // matching paren, read past string and template literals.
  function refusalSpans(src) {
    const out = [];
    const starts = /\b(?:bad|refuse|new Error)\(|\bconst [A-Z_]*MESSAGE[A-Z_]* =/g;
    let m;
    while ((m = starts.exec(src))) {
      let i = m.index + m[0].length, depth = m[0].endsWith("(") ? 1 : 0;
      const stack = [];
      for (; i < src.length; i++) {
        const c = src[i], q = stack[stack.length - 1];
        if (q === "'" || q === '"') { if (c === "\\") i++; else if (c === q) stack.pop(); continue; }
        if (q === "`") { if (c === "\\") i++; else if (c === "`") stack.pop(); else if (c === "$" && src[i + 1] === "{") { stack.push("${"); i++; } continue; }
        if (c === "'" || c === '"' || c === "`") { stack.push(c); continue; }
        if (q === "${") { if (c === "{") stack.push("{"); else if (c === "}") stack.pop(); continue; }
        if (q === "{") { if (c === "}") stack.pop(); else if (c === "{") stack.push("{"); continue; }
        if (depth === 0 && (c === ";" || c === "\n")) break;
        if (c === "(") depth++;
        else if (c === ")" && --depth === 0) { i++; break; }
      }
      out.push(src.slice(m.index, i));
    }
    return out;
  }
  const typedClaims = (rel, src) => refusalSpans(src)
    .filter((span) => CLAIM.test(span) && ![...KEEP.keys()].some((k) => k.startsWith(`${rel}:`) && span.includes(k.slice(rel.length + 1))))
    .map((span) => `${rel}: ${span.replace(/\s+/g, " ").slice(0, 110)}`);
  const found = [];
  let spans = 0;
  for (const rel of CONVERTED) {
    const src = read(rel) || "";
    spans += refusalSpans(src).length;
    found.push(...typedClaims(rel, src));
  }
  ok(spans >= 150, `read ${spans} refusal spans across the converted modules (a collapsed reader must fail)`);
  ok(typedClaims("<control>", 'throw bad("The service failed - not charged; retry shortly", 503);').length === 1
     && typedClaims("<control>", "throw bad(cond\n  ? \"a - not charged\"\n  : \"b\", 504);").length === 1
     && typedClaims("<control>", 'export const WALLET_LOW_MESSAGE = "Unavailable. Nothing was charged; retry later.";').length === 1
     && typedClaims("<control>", "throw bad(`The service failed.${notChargedOn(req)} Retry shortly.`, 503);").length === 0,
     "control: a typed claim in a one-line, a split and a constant refusal is caught; the shared sentence is not");
  const unusedKeep = [...KEEP.keys()].filter((k) => { const rel = k.split(":")[0]; return !refusalSpans(read(rel) || "").some((sp) => CLAIM.test(sp) && sp.includes(k.slice(rel.length + 1))); });
  ok(unusedKeep.length === 0, `every kept typed claim still exists (a stale entry would excuse a new one)${unusedKeep.length ? `: ${unusedKeep.join(" | ")}` : ""}`);
  ok(found.length === 0, `converted modules type no "not charged" claim in a refusal${found.length ? ` - TYPED: ${found.join(" | ")}` : ""}`);
  for (const rel of CONVERTED) ok(/from "(?:\.\.?\/)+not-charged\.js"/.test(read(rel) || ""), `${rel} imports the shared sentence`);
}

// --- the shared sentence composes with the push rewrite, in every refusal ----
// The route binder adds the push exception to the shared sentence for a push
// credential, and the Tempo gate's send wrapper then restates the body for a
// claimed transfer. Two rewrites of one sentence, so every refusal that
// prints it through notChargedOn is rendered here the way the server renders
// it: a claimed push payer reads the sentence replaced whole by the owed
// note, and every other payer reads the message as written.
{
  const { renderRefusal, expectedForPush, malformed } = await import("./lib/push-refusal-render.js");
  // The template literal around each notChargedOn call, with the call printed
  // as on a route call and every other interpolation as a plain word.
  function sharedSentenceMessages(src) {
    const out = [];
    for (const line of src.split("\n")) {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      const printed = line.replace(/\$\{notChargedOn\(\w+\)\}/g, " Nothing was charged.");
      let at = -1;
      while ((at = printed.indexOf("Nothing was charged.", at + 1)) !== -1) {
        const open = printed.lastIndexOf("`", at), close = printed.indexOf("`", at);
        const inner = printed.slice(open + 1, close === -1 ? printed.length : close);
        let msg = inner;
        for (let prev = ""; prev !== msg;) { prev = msg; msg = msg.replace(/\$\{[^{}]*\}/g, "X"); }
        // An interpolation that holds a string of its own ends the literal
        // early: what is left is still the text around the sentence.
        out.push(msg.replace(/^[^A-Z"]*/, "").replace(/\$\{.*$/, "").trim());
      }
    }
    return out;
  }
  const bad = [];
  let rendered = 0;
  // The changelog quotes the sentence in prose; it is never a refusal.
  for (const rel of files.filter((f) => /^src\/.*\.js$/.test(f) && f !== "src/not-charged.js" && f !== "src/changelog.js")) {
    for (const msg of sharedSentenceMessages(read(rel) || "")) {
      rendered++;
      const push = renderRefusal(msg, "push"), other = renderRefusal(msg, "other"), unclaimed = renderRefusal(msg, "push-unclaimed");
      const lower = (t) => (t.match(/[.!?] [a-z]/g) || []).length;
      const why = push !== expectedForPush(msg) ? "the push rendering is not the sentence replaced by the owed note"
        : other !== msg ? "a non-push payer does not read it as written"
        : /nothing was charged|not charged/i.test(push) ? "a claimed push payer is told nothing was charged"
        : (push.match(/\bowed\b/g) || []).length !== (msg.match(/\bowed\b/g) || []).length + 1 ? "the push rendering does not say \"owed\" exactly once"
        : (unclaimed.match(/\bowed\b/g) || []).length !== (msg.match(/\bowed\b/g) || []).length + 1 ? "the exception form does not say \"owed\" exactly once"
        : lower(push) > lower(msg) || lower(unclaimed) > lower(msg) ? "a rewrite starts a sentence in lower case"
        : null;
      if (why) bad.push(`${rel}: ${why}: ${push.slice(0, 160)}`);
    }
  }
  const sample = "The decision service did not answer in time. Nothing was charged. Retry shortly.";
  ok(sharedSentenceMessages("    throw bad(`The decision service did not answer in time.${notChargedOn(req)} Retry shortly.`, 503);")[0] === sample
     && malformed("The decision service did not answer in time. the transfer you sent is recorded as owed, except a Tempo transfer sent before the call, which is recorded as owed and repaid after on-chain proof. Retry shortly.", "push") !== null
     && malformed(renderRefusal(sample, "push"), "push") === null,
     "control: a refusal's message is read from its template, a doubled clause is malformed, and the composed rendering is not");
  ok(rendered >= 45, `rendered ${rendered} shared-sentence refusals for each payer class (a collapsed reader must fail)`);
  ok(bad.length === 0, `every refusal that prints the shared sentence reads as one statement to each payer class${bad.length ? ` - ${bad.join(" | ")}` : ""}`);
}

// A success:false receipt is not always "not charged, safe to retry": a
// settle chain that ended unconfirmed (settlement_unconfirmed) may still
// move money, and a settle whose transfer was already booked owed
// (settled_refund_owed) was charged. Every copy surface that says such a receipt was not
// charged, moved nothing or is safe to retry carries the shared clause
// (src/front-door.js UNCONFIRMED_RECEIPT_EXCEPTION) right after the claim: by
// interpolation in a module, word for word in markdown.
{
  const { UNCONFIRMED_RECEIPT_EXCEPTION: UNC } = await import("../src/front-door.js");
  const CLAIM = /success: ?false\\?`?[\s\S]{0,200}?(?:not charged|nothing moved|moved no money|safe to retry|retry with a fresh authorization)/gi;
  const carries = (after) => after.includes(UNC) || after.includes("${UNCONFIRMED_RECEIPT_EXCEPTION}");
  let claims = 0;
  const bare = [];
  for (const rel of files.filter((f) => COPY_SURFACES.test(f))) {
    const text = read(rel);
    if (!text) continue;
    for (const m of text.matchAll(CLAIM)) {
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index);
      // A comment line is skipped in a module only: a markdown paragraph that
      // opens in bold (`**Heading.**`) is copy.
      if (rel.endsWith(".js") && /^\s*(?:\/\/|\/?\*)/.test(line)) continue;
      claims++;
      const after = text.slice(m.index, m.index + m[0].length + 1300).replace(/\\?\n\s*/g, " ");
      if (!carries(after)) bare.push(`${rel}:${text.slice(0, m.index).split("\n").length}`);
    }
  }
  // duplicate_authorization is not named: its receipt asks for a new payment
  // (src/settlement-claims.js), and a re-sent unconfirmed payment is answered
  // from its stored answer before it could reach that refusal.
  ok(/settlement_unconfirmed/.test(UNC) && !/duplicate_authorization/.test(UNC) && /do not sign a new authorization/.test(UNC) && /check-wallet/.test(UNC) && /watch-transaction/.test(UNC)
    && /authorizationValidBefore/.test(UNC) && /lastValidRound/.test(UNC) && /expirationLedger/.test(UNC) && /names none, before the paying wallet shows/.test(UNC)
    && /settled_refund_owed was charged/.test(UNC) && /booked as owed/.test(UNC) && /refundStatusUrl/.test(UNC),
    "the shared clause names the unconfirmed and the owed receipts, the instruction scoped to the answer's expiry or the wallet, and both retry verbs");
  ok(claims >= 8, `the success:false not-charged claim is found where it is made (${claims} places)`);
  ok(bare.length === 0, `every success:false not-charged claim carries the unconfirmed-receipt clause${bare.length ? ` (missing: ${bare.join(", ")})` : ""}`);
  ok("a PAYMENT-RESPONSE with success: false means settlement was refused, you were not charged on x402.".match(CLAIM) && !carries("receipt success:false, safe to retry."),
    "control: the unscoped sentence is matched and is not taken as carrying the clause");
}

// "A failed call is not charged" has one more exception: some model calls
// are paid before they run (src/settle-first.js). Every copy surface that says a failed call, an
// error answer or a 4xx/5xx is not charged (or is not settled) carries the
// shared sentence (src/settle-first-copy.js) beside the claim: by
// interpolation in a module, word for word in markdown. A refusal of the
// payment itself ("refusals are free") happens before any settlement and is
// not this claim.
{
  const fam = await import("../src/settle-first-copy.js");
  const GENERAL = notChargedClaims();
  // Served copy outside COPY_SURFACES' names: the /tools ledger, the discovery
  // manifest, the 202 job message, the MCP task notices and /what-is-mpp.
  const EXTRA = new Set(["src/settlement-footnote.js", "src/refund-terms.js", "src/refund-terms-doc.js", "src/conformance.js", "src/mcp-http.js", "mcp/index.js", "src/agentcore-page.js",
    "src/ledger-catalog.js", "src/discovery.js", "src/async-jobs.js", "src/mcp-tasks.js", "src/what-is-mpp.js",
    // The job advice a slow route's 402, description and sync-window refusals carry.
    "src/slow-routes.js", "src/evm-validity.js", "src/cdn-sync-window.js", "src/slow-sync-window.js"]);
  // A per-route sentence carries it through settleFirstClause(def): the
  // sentence on a route that may settle first, nothing on any other.
  const carries = (near) => near.includes(fam.SETTLE_FIRST_MARK) || /\$\{(?:SETTLE_FIRST_|FAILED_CALL_SENTENCE)/.test(near) || /\bsettleFirstClause\(/.test(near);
  // Every surface that describes this server's charging: pages, markdown,
  // published manifests (.codex-plugin, server.json), the issue forms, the
  // adapters, examples and the plan service's prompt. Left out: tollbooth
  // (a site owner's own gate, which settles on its own middleware), the
  // workers and the facilitator (operator side), tests and the rulebook.
  const scanned = files.filter((f) => (COPY_SURFACES.test(f) || EXTRA.has(f)) && /\.(?:md|js|mjs|json|ya?ml|txt)$/.test(f) && !/^(?:scripts|tollbooth|workers|facilitator|\.claude)\//.test(f) && !/^\.github\/(?!ISSUE_TEMPLATE\/)/.test(f) && !/CHANGELOG/.test(f) && f !== "src/changelog.js" && f !== "CLAUDE.md");
  let claims = 0, homeCard = false;
  const bare = [], drift = [];
  for (const rel of scanned) {
    const text = read(rel);
    if (!text) continue;
    for (const m of text.matchAll(GENERAL)) {
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index);
      // A comment line is skipped in a module only: a markdown paragraph that
      // opens in bold (`**Heading.**`) is copy.
      if (rel.endsWith(".js") && /^\s*(?:\/\/|\/?\*)/.test(line)) continue;
      if (/\b[Rr]efusals? (?:are|is) free\b/.test(text.slice(Math.max(0, m.index - 120), m.index))) continue;
      // A home card (16 words at most, test-static-pages) prints the sentence as
      // its note (checked below, and on the served page by
      // scripts/test-not-charged-rendered.js).
      if (rel === "src/why.js" && /link: \["\/docs#why-never-charged"/.test(text.slice(m.index, text.indexOf("\n", m.index)))) { homeCard = true; continue; }
      claims++;
      // A claim in a table row is carried by the sentence right under that
      // table (a markdown table, or a page module's row([...]) list).
      let end = m.index + 1500;
      const lineAt = (i) => text.slice(text.lastIndexOf("\n", i - 1) + 1, (text.indexOf("\n", i) + 1 || text.length + 1) - 1);
      const isRow = (l) => /^\s*\|/.test(l) || /^\s*(?:\.\.\.\(.*)?\brow\(\[/.test(l) || /^\s*\$\{table\(\[/.test(l);
      if (isRow(lineAt(m.index))) {
        let pos = text.indexOf("\n", m.index);
        while (pos !== -1 && isRow(lineAt(pos + 1))) pos = text.indexOf("\n", pos + 1);
        end = Math.max(end, (pos === -1 ? text.length : pos) + 600);
      }
      // A claim in the front door's recovery list (/agents.md, /llms.txt) is
      // carried by the list: its first item states the failed-call rule with
      // the sentence, and /llms.txt has no room to print it twice.
      const list = text.lastIndexOf("recovery: [", m.index);
      const listEnd = list < 0 ? -1 : text.indexOf("\n    ],", list);
      if (list >= 0 && listEnd > m.index && carries(text.slice(list, listEnd))) continue;
      if (!carries(text.slice(Math.max(0, m.index - 800), end))) bare.push(`${rel}:${text.slice(0, m.index).split("\n").length}`);
    }
    // Word for word: every copy of the family's words is one of its sentences.
    if (rel !== "src/settle-first-copy.js") {
      const flat = text.replace(/\s*\n\s*/g, " ");
      for (const m of flat.matchAll(new RegExp(fam.SETTLE_FIRST_MARK, "g"))) {
        const around = flat.slice(Math.max(0, m.index - 40), m.index + 400);
        if (![fam.SETTLE_FIRST_TEXT, fam.FAILED_CALL_TEXT].some((x) => around.includes(x.slice(x.indexOf(fam.SETTLE_FIRST_MARK))))) drift.push(rel);
      }
    }
  }
  ok(fam.FAILED_CALL_TEXT === "Some calls are paid before they run. If one fails, send the same payment again to retry it free, or it is refunded."
    && fam.SETTLE_FIRST_TEXT === "Some calls are paid before they run; a failed one can be retried free with the same payment, or is refunded."
    && fam.FAILED_CALL_TEXT.includes(fam.SETTLE_FIRST_MARK) && fam.SETTLE_FIRST_TEXT.includes(fam.SETTLE_FIRST_MARK)
    && ![fam.FAILED_CALL_TEXT, fam.SETTLE_FIRST_TEXT].some((x) => /not charged|automatic/i.test(x)),
    "the shared sentences are the approved wording: which calls are paid first, and what a failure gets (the same payment again, or a refund), with no restated promise and no 'automatically'");
  // The tools that settle first (src/settle-first-tools.js, the lists
  // server.js arms from): a description that says a failure is not charged
  // carries the sentence too.
  {
    const sft = await import("../src/settle-first-tools.js");
    const tools = [...sft.SETTLE_FIRST_GATEWAY_TOOLS, ...sft.SETTLE_FIRST_SHARED_TOOLS, ...sft.SETTLE_FIRST_CATALOG_TOOLS];
    const srv = readFileSync(join(root, "src/server.js"), "utf8");
    ok(/const SETTLE_FIRST_SLUGS = settleFirstSlugs\(GATEWAY_TOOLS_ENABLED\);/.test(srv) && /new Set\(SETTLE_FIRST_CATALOG_TOOLS\.map/.test(srv)
      && ["v1-images-edit", "dub"].every((slug) => tools.some((t) => t.slug === slug)),
      "the description check reads the lists server.js arms settle-first from (images edit and dub included)");
    const claimers = tools.filter((t) => /\b(?:fail\w*|errors?)\b[^.]{0,160}\bnot charged\b/i.test(String(t.description || "")));
    const bareTools = claimers.filter((t) => !String(t.description).includes(fam.SETTLE_FIRST_MARK)).map((t) => t.slug);
    ok(tools.length >= 6 && claimers.length >= 2 && bareTools.length === 0, `every settle-first tool description that says a failure is not charged carries the settle-first sentence (${claimers.length} of ${tools.length}${bareTools.length ? `; bare: ${bareTools.join(", ")}` : ""})`);
  }
  // A per-route job sentence ("payment settles only on a delivered result")
  // carries the sentence on a route that may settle first, and only there:
  // server.js marks each such definition from the same slugs it arms.
  {
    const { runTimeNote } = await import("../src/evm-validity.js");
    const { asyncAdvice } = await import("../src/slow-routes.js");
    const srv = readFileSync(join(root, "src/server.js"), "utf8");
    const sf = { slug: "sf", settlesFirst: true, asyncProfile: { slow: true, expectedSeconds: 40, maxSeconds: 75 } };
    const plain = { slug: "plain", asyncProfile: { slow: true, expectedSeconds: 40, maxSeconds: 75 } };
    ok(fam.settleFirstClause(sf) === ` ${fam.SETTLE_FIRST_SENTENCE}` && fam.settleFirstClause(plain) === "" && fam.settleFirstClause({ settlesFirst: "yes" }) === "" && fam.settleFirstClause(null) === "",
      "settleFirstClause: the short form on a route marked settlesFirst, nothing on any other");
    ok(runTimeNote(75, { settlesFirst: true }).includes(fam.SETTLE_FIRST_TEXT) && runTimeNote(20, { settlesFirst: true }).includes(fam.SETTLE_FIRST_TEXT)
      && !runTimeNote(75).includes(fam.SETTLE_FIRST_MARK) && !runTimeNote(20).includes(fam.SETTLE_FIRST_MARK),
      "a slow route's run-time note carries the sentence when the route may settle first, and not otherwise");
    ok(asyncAdvice(sf).how.includes(fam.SETTLE_FIRST_TEXT) && !asyncAdvice(plain).how.includes(fam.SETTLE_FIRST_MARK) && !/\s{2}/.test(asyncAdvice(sf).how),
      "the job advice (402, /api/pricing, /openapi.json) carries the sentence on a settle-first route only");
    ok(/const SETTLE_FIRST_COPY_SLUGS = settleFirstSlugs\(GATEWAY_TOOLS_ENABLED\);/.test(srv)
      && /if \(SETTLE_FIRST_COPY_SLUGS\.has\(def\.slug\)\) Object\.defineProperty\(def, "settlesFirst", \{ value: true/.test(srv)
      && /runTimeNote\(runS, \{ settlesFirst: def\.settlesFirst === true \}\)/.test(srv)
      && srv.indexOf("SETTLE_FIRST_COPY_SLUGS.has(def.slug)") < srv.indexOf("runTimeNote(runS,"),
      "server.js marks every settle-first definition, from the slugs it arms, before the run-time note is written");
  }
  {
    const { WHY_POINTS, whyHomeClaims } = await import("../src/why.js");
    ok(homeCard && whyHomeClaims().find((c) => c.id === "never-charged")?.note === fam.SETTLE_FIRST_TEXT
      && String(WHY_POINTS.find((w) => w.id === "never-charged")?.p || "").includes(fam.SETTLE_FIRST_TEXT),
      "the never-charged home card prints the settle-first sentence as its note, and its /docs#why point carries it");
  }
  ok(claims >= 40, `the failed-call not-charged claim is found where it is made (${claims} places)`);
  ok(bare.length === 0, `every failed-call not-charged claim carries the settle-first sentence${bare.length ? ` (missing: ${bare.join(", ")})` : ""}`);
  ok(drift.length === 0, `every copy of the settle-first words is one of the shared sentences, word for word${drift.length ? ` (drifted: ${[...new Set(drift)].join(", ")})` : ""}`);
  ok([..."A failed x402 call is not charged.".matchAll(GENERAL)].length === 1 && !carries("A failed x402 call is not charged. Retry later."),
    "control: the bare claim is matched and is not taken as carrying the sentence");  ok(["so on x402 a 4xx or 5xx (a text over the cap, a format the tier does not serve, an upstream that could not answer) is not charged.",
    "| 502 | a source answered with a failure | retry later; not charged on x402 |", "On x402 a call the tool fails is not charged: settlement runs after the tool.",
    "the ordinary failure case costs nothing and needs no refund.", "An error cancels settlement; a Tempo payment sent first is recorded as a refund owed.",
    "Any `4xx`/`5xx` (a bad input, a capacity `503`, an upstream `502`) **cancels settlement**, so the x402 buyer is not charged for a failure.",
    "only a successful answer is settled on x402: an answer with an error status is not settled.", "Not charged: the error cancels settlement before any facilitator call.",
    "A failed call (an error, a timeout, an upstream outage) is not charged on x402", "You were not charged: payment settles only on a delivered result.",
    "returns the real, structured result, and settles the x402 payment only on success", "The x402 payment settles only on the delivered answer.",
    "The call was paid for as a job; payment settles only if the answer is delivered.", "payment still settles only when the answer is ready",
    "it fails, and on x402 that failure is not charged.", "On Agent402 endpoints, a 4xx or 5xx is not charged on x402 or MPP evm"]
    .every((x) => [...x.matchAll(GENERAL)].length >= 1),
    "control: the long-parenthetical, table-cell, manifest and job-notice phrasings are matched");

  // The scope of a failed call's evidence: "no receipt, or success:false"
  // describes the run that settles after it answers; a run paid before it
  // ran answers charged: true, and the sentence says so beside the claim.
  {
    const RECEIPT = /\b(?:answered with )?no (?:payment )?receipt(?: header)?, or (?:with )?(?:an? )?(?:x402 )?receipt (?:marked|that reads)/g;
    const sites = [...scanned, "README.md", "wiki/Why-Pay-Here.md"].filter((f, i, a) => a.indexOf(f) === i);
    let n = 0; const missing = [];
    for (const rel of sites) {
      const text = read(rel);
      if (!text) continue;
      for (const m of text.matchAll(RECEIPT)) {
        n++;
        if (!/A call paid before it ran answers (?:\\?`)?(?:\$\{C\("charged: true"\)\}|charged: true)/.test(text.slice(m.index, m.index + 1600))) missing.push(`${rel}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    ok(n >= 4 && missing.length === 0, `every "no receipt, or success:false" claim says a call paid before it ran answers charged: true (${n} places${missing.length ? `; missing: ${missing.join(", ")}` : ""})`);
  }

  // Served surfaces print the sentence only while runs can settle first: no
  // module under src/ types the words (each interpolates the switch-reading
  // constant), and with GATEWAY_SETTLE_FIRST=off the constants and a rendered
  // surface carry none of them.
  {
    const typed = tracked.filter((f) => /^src\/.*\.js$/.test(f) && f !== "src/settle-first-copy.js")
      .filter((f) => (read(f) || "").includes(fam.SETTLE_FIRST_MARK));
    ok(typed.length === 0, `no served module types the settle-first words; each interpolates the switch-reading sentence${typed.length ? ` (typed: ${typed.join(", ")})` : ""}`);
    const probe = `
      const f = await import(${JSON.stringify(join(root, "src/settle-first-copy.js"))});
      const { failedCallFootnote } = await import(${JSON.stringify(join(root, "src/settlement-footnote.js"))});
      const { WHY_POINTS } = await import(${JSON.stringify(join(root, "src/why.js"))});
      const { SETTLE_FIRST_CATALOG_TOOLS } = await import(${JSON.stringify(join(root, "src/settle-first-tools.js"))});
      const seen = [f.FAILED_CALL_SENTENCE, f.SETTLE_FIRST_SENTENCE, failedCallFootnote(["x402"]), JSON.stringify(WHY_POINTS), SETTLE_FIRST_CATALOG_TOOLS.map((t) => t.description).join(" ")].join(" ");
      console.log(JSON.stringify({ on: f.settleFirstCopyOn(), mark: seen.includes(f.SETTLE_FIRST_MARK) }));`;
    const run = (v) => { try { return childJson(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, GATEWAY_SETTLE_FIRST: v, REDIS_URL: "", STATE_DATABASE_URL: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return null; } };
    const off = run("off"), on = run("auto");
    ok(off?.on === false && off.mark === false && on?.on === true && on.mark === true,
      `GATEWAY_SETTLE_FIRST=off prints no settle-first sentence on a served surface, and the default prints it (off: ${JSON.stringify(off)}, on: ${JSON.stringify(on)})`);
    // With the sentence gone, the text around it closes up: no double space
    // and no trailing space where it stood.
    const spacing = `
      const { refundClauses } = await import(${JSON.stringify(join(root, "src/refund-terms.js"))});
      const { failedCallFootnote } = await import(${JSON.stringify(join(root, "src/settlement-footnote.js"))});
      const { refundTermsFullDocument } = await import(${JSON.stringify(join(root, "src/refund-terms-doc.js"))});
      const texts = { ...Object.fromEntries(refundClauses().map((c) => ["clause " + c.id, c.text])), "footnote": failedCallFootnote({ rails: ["x402"], tempoPush: true }), "footnote, no push": failedCallFootnote({ rails: ["x402"] }), "refund terms legend": refundTermsFullDocument("").legend.chargedOnErrorAnswer };
      console.log(JSON.stringify(Object.entries(texts).filter(([, t]) => typeof t === "string" && (/ {2}/.test(t) || /\\s$/.test(t) || /^\\s/.test(t))).map(([k]) => k)));`;
    const spaced = (v) => { try { return childJson(execFileSync(process.execPath, ["--input-type=module", "-e", spacing], { env: { ...process.env, GATEWAY_SETTLE_FIRST: v, REDIS_URL: "", STATE_DATABASE_URL: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return null; } };
    for (const v of ["off", "auto"]) {
      const bad = spaced(v);
      ok(Array.isArray(bad) && bad.length === 0, `GATEWAY_SETTLE_FIRST=${v}: the refund clauses, the failed-call footnote and the refund terms legend carry no double, leading or trailing space (${bad === null ? "probe failed" : bad.join(", ") || "none"})`);
    }
    const { settleFirstEnabled } = await import("../src/gateway-settle-breaker.js");
    const { settleFirstCopyOn } = fam;
    ok(typeof settleFirstCopyOn === "function" && ["off", " OFF ", "", "auto", "always", "on"].every((v) => settleFirstCopyOn({ GATEWAY_SETTLE_FIRST: v }) === settleFirstEnabled({ GATEWAY_SETTLE_FIRST: v })),
      "the copy reads the same switch the settle-first path reads");
  }
}

// The retry verbs a refused payment names (src/tool-error-fields.js
// PAYMENT_RETRY_VERBS_NOTE) reach every surface an agent reads them on: the
// served 402 description in /openapi.json, /llms-full.txt, the front door's
// recovery list on /agents.md, and the hand-written copies in the client README and the
// wiki. A surface that drops the note teaches a buyer to sign a second
// payment for a call whose transfer may still land.
{
  const { PAYMENT_RETRY_VERBS_NOTE: NOTE } = await import("../src/tool-error-fields.js");
  const { openapiSpec } = await import("../src/pages.js");
  const { llmsFullTxt } = await import("../src/seo.js");
  const { frontDoor, agentsMd } = await import("../src/front-door.js");
  const B = "http://unit.test";
  const c = { "GET /api/front-door-probe": { slug: "front-door-probe", route: "GET /api/front-door-probe", price: "$0.01", category: "web", description: "probe", tags: [] } };
  const flat = (s) => String(s).replace(/\s+/g, " ");
  ok(/same-payment/.test(NOTE) && /watch-transaction/.test(NOTE) && /check-wallet/.test(NOTE) && /fresh-authorization/.test(NOTE) && /settlement-unconfirmed/.test(NOTE),
    "the retry-verbs note names same-payment, watch-transaction, check-wallet and fresh-authorization");
  let spec = null; try { spec = openapiSpec(B, c); } catch (e) { spec = { error: String(e?.message || e) }; }
  ok(JSON.stringify(spec).includes(JSON.stringify(NOTE).slice(1, -1)), "/openapi.json's 402 description carries the retry-verbs note");
  let full = ""; try { full = llmsFullTxt(B, c); } catch (e) { full = String(e?.message || e); }
  ok(full.includes(NOTE), "/llms-full.txt carries the retry-verbs note");
  let door = null; try { door = frontDoor(c, B); } catch { door = null; }
  let agents = ""; try { agents = agentsMd(B, c); } catch (e) { agents = String(e?.message || e); }
  ok(Array.isArray(door?.recovery) && door.recovery.includes(NOTE) && agents.includes(NOTE), "the front door's recovery list, as /agents.md serves it, carries the retry-verbs note");
  const readme = flat(readFileSync(join(root, "client/README.md"), "utf8"));
  ok(/A refused payment's body names a `retry` verb: `watch-transaction` or `check-wallet` \(`reason: "settlement-unconfirmed"`\) means the settlement is not confirmed/.test(readme)
    && /`same-payment` means send the same payment again, and `fresh-authorization` means sign a new one/.test(readme),
    "the client README names the retry verbs and the unconfirmed settlement");
  const wiki = flat(readFileSync(join(root, "wiki/Paying-with-x402.md"), "utf8"));
  ok(/`same-payment` means send the same payment again after `Retry-After`, with no new signature; `watch-transaction` \(the body lists `transactions`\) and `check-wallet` \(it lists none\) mean the settlement is not confirmed/.test(wiki)
    && /`fresh-authorization` means sign a new payment/.test(wiki),
    "the wiki's Paying-with-x402 page names the retry verbs and the unconfirmed settlement");
  // The owed answer (settled-refund-owed) is named wherever the verbs are:
  // that payment was charged, its transfer is owed back, and a new one makes the call.
  ok(/reason settled-refund-owed the earlier transfer of that payment landed and is booked as owed to the paying wallet, repaid after on-chain proof \(transactions names it, refundStatusUrl shows where the repayment stands\), so that call was charged and not served/.test(NOTE),
    "the retry-verbs note names settled-refund-owed: charged, owed back, the transfer and its refund lookup");
  ok(/`reason: "settled-refund-owed"` the earlier transfer of that payment landed and is booked as owed to the paying wallet, repaid after on-chain proof/.test(readme)
    && /`reason: "settled-refund-owed"` the earlier transfer of that payment landed and is booked as owed to the paying wallet, repaid after on-chain proof/.test(wiki),
    "the client README and the wiki name settled-refund-owed");
}

console.log(`test-copy-absolutes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
