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
import { readFileSync, readdirSync } from "node:fs";
import { RAILS } from "../src/rails.js";
import { execFileSync } from "node:child_process";
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
  [/^scripts\/(?!.*card.*\.js$)/, "tests and ops scripts quote the forbidden sentences as fixtures; card generators ARE surfaces and stay in"],
  [/^\.github\//, "CI configuration, not copy"],
  [/^CLAUDE\.md$/, "the rulebook quotes the forbidden sentences to forbid them"],
  [/(^|\/)CHANGELOG\.md$/, "dated history records what shipped when, including the old wording"],
  [/(^|\/)package-lock\.json$|(^|\/)node_modules\//, "generated"],
  [/^facilitator\/test|\.test\.js$|(^|\/)test[^/]*\.js$/, "test fixtures"],
];
const TEXT = /\.(?:js|mjs|cjs|md|json|toml|txt|ya?ml|html)$/;
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
const files = tracked.filter((f) => TEXT.test(f) && !NOT_SURFACES.some(([re]) => re.test(f)));
const read = (rel) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return null; } };

// Rail counts are DERIVED here from src/rails.js, so a rail added there moves
// what the rule accepts. Package descriptions said "USDC on Base + 11 more
// chains, or USDG on Robinhood Chain (12 chains total)" (thirteen chains by
// its own arithmetic) and the MCP package said "USDC on 12 chains": twelve is
// every chain including Robinhood's USDG, eleven carry USDC.
const USDC_RAILS = RAILS.filter((r) => r.asset === "USDC").length;
const ALL_RAILS = RAILS.length;
const FORBIDDEN = [
  {
    re: new RegExp(`\\bUSDC on (?!${USDC_RAILS}\\b)\\d+ chains\\b|\\bUSDC on Base \\+ (?!${USDC_RAILS - 1}\\b)\\d+ more chains\\b|\\b(?!${ALL_RAILS}\\b)\\d+ chains total\\b`, "i"),
    why: `src/rails.js lists ${USDC_RAILS} USDC chains and ${ALL_RAILS} chains in all; derive the figure from RAILS or drop it`,
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
    re: /\b(?:only|exclusively)\b[^.]{0,60}sellers?[^.]{0,80}proven|\bproven\b[^.]{0,60}sellers?[^.]{0,40}\bonly\b/i,
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
];

function sweep(entries) {
  const found = [];
  for (const [rel, text] of entries) {
    if (text == null) continue;
    const lines = text.split("\n");
    for (const { re, why, scopedBy, exempt, requires, scopeWindow = 0 } of FORBIDDEN) {
      if (exempt?.has(rel)) continue;
      for (let i = 0; i < lines.length; i++) {
        const sentence = `${lines[i]} ${lines[i + 1] || ""}`;
        const m = sentence.match(re);
        if (!m) continue;
        if (requires && !requires.test(sentence)) continue;      // a different subject entirely
        const near = scopeWindow
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
                       ["<control>", "Flat pricing for ${n} deterministic web tools."],
                       ["<control>", "Every tool is deterministic."],
                       ["<control>", "If it was, the charge is recorded as owed and refunded automatically."],
                       ["<control>", "500+ pay-per-call tools. Every one deterministic, priced, and settled on chain."],
                       ["<control>", "Pay in USDC on Base + 11 more chains, or USDG on Robinhood Chain (12 chains total)."],
                       ["<control>", "over x402 (USDC on 12 chains) or MPP"],
                       ["<control>", "500+ strong: 400+ pay-per-call tools (x402 or MPP) + 70+ skill packs"]]);
const CONTROL_EXPECTED = 11;
ok(control.length === CONTROL_EXPECTED, `control: the sweep reports all 9 planted lines (${CONTROL_EXPECTED} rule hits; a line can match more than one determinism rule) through its real code path (got ${control.length})`);

for (const hit of sweep(files.map((rel) => [rel, read(rel)]))) { fail++; console.error(`FAIL - ${hit}`); }
ok(files.length >= 300, `swept ${files.length} copy surfaces (a collapsed file list must fail, not pass quietly)`);
ok((read("src/why.js") || "").length > 500 && (read("adapters/agentkit/README.md") || "").length > 500,
   "...and the sweep really reached both a served page and a published package README");
// Coverage is asserted, not inferred: with the tree clean, dropping a whole
// CLASS of file from the walk changes no result, so the only way that regresses
// loudly is to name the class here.
ok(files.some((f) => /^scripts\/.*card.*\.js$/.test(f)),
   "...and the card generators, which render public submission and announcement artifacts");

// --- the routing sentence is derived, and honest in BOTH directions --------
{
  const mod = await import("../src/routing-proof.js");
  const before = process.env.SOR_SVM_UNPROVEN_MAX_USD;
  const beforeBase = process.env.SOR_BASE_UNPROVEN_MAX_USD;

  delete process.env.SOR_SVM_UNPROVEN_MAX_USD;   // the shipped defaults
  delete process.env.SOR_BASE_UNPROVEN_MAX_USD;
  const live = mod.routingProofSentence();
  ok(/proven on-chain settlement/.test(live), "the sentence still leads with the proof requirement");
  ok(/one exception/.test(live) && /\$0\.01/.test(live),
     "with the tier on its live default the sentence NAMES the exception and its ceiling");
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

  if (before === undefined) delete process.env.SOR_SVM_UNPROVEN_MAX_USD;
  else process.env.SOR_SVM_UNPROVEN_MAX_USD = before;
  if (beforeBase === undefined) delete process.env.SOR_BASE_UNPROVEN_MAX_USD;
  else process.env.SOR_BASE_UNPROVEN_MAX_USD = beforeBase;

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
  // `modelBacked: true` on its definition (server.js folds it in). exa-answer
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
  ];
  const hits = (t) => sweep([["<case>", t]]).length;
  const missed = MUST_FAIL.filter((t) => hits(t) === 0);
  const wrong = MUST_PASS.filter((t) => hits(t) > 0);
  ok(missed.length === 0, `every known phrasing of the class is caught${missed.length ? ` - MISSED: ${missed.join(" | ")}` : ""}`);
  ok(wrong.length === 0, `honest, scoped phrasings are NOT caught${wrong.length ? ` - FALSE POSITIVE: ${wrong.join(" | ")}` : ""}`);
}

console.log(`test-copy-absolutes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
