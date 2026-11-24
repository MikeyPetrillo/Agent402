// The token tools report on-chain facts and never a judgment of a token.
//
// Two parts, shared by every token tool (token-safety, token-risk and its pro
// tier, the Solana token reads, the token brief and its card report):
//
//   * TOKEN_FACTS_NOTICE rides on every answer, word for word.
//   * tokenClaimViolations(text) is the deterministic check a model-written
//     report passes before it is returned: a report that calls a token safe,
//     legitimate, trustworthy, low-risk, a scam (or not one), a rug, or
//     fraudulent, or tells the reader to buy, sell or avoid it, is a
//     violation. checkedTokenProse() asks the model once more with the
//     violation named, then withholds the report (a 502 the paywall never
//     settles; the same failure path as an empty synthesis).
//
// The words below are judged two ways. A FIXED phrase ("is safe", "not a
// scam", "you should buy") fails wherever it appears. A judgment WORD on its
// own ("scam", "rug", "fraud") is allowed only inside a clause that says what
// the data cannot detect ("on-chain data cannot detect off-chain fraud"),
// because that caveat is required and names no token. The token's own name
// and symbol are removed first: a token called "Safe" is not a claim.
import { notChargedHere } from "./not-charged.js";

export const TOKEN_FACTS_NOTICE = "These are on-chain facts only. No flags does not mean a token is legitimate; off-chain fraud cannot be detected here. Not investment advice.";

// The wording rule the report prompts carry, so the model is told the same
// rule the checker enforces.
export const TOKEN_CLAIM_RULE = "Never describe this token (or any token) as safe, unsafe, legitimate, legit, trustworthy, low-risk, risk-free, a scam, not a scam, a rug, a rug pull or fraudulent, and never tell the reader to buy, sell, hold or avoid it. Do not use those words at all except in one caveat sentence of the form \"on-chain data cannot detect off-chain fraud\". Report each fact and what it shows; the reader draws the conclusion.";

const JUDGE = "(?:safe|unsafe|legitimate|legit|trustworthy|low[- ]risk|risk[- ]free|scam|scams|scammy|rug|rugs|rugged|rugpull|rug[- ]pull|fraud|fraudulent|ponzi)";
// Phrases that are a judgment wherever they appear.
const FIXED = [
  { rule: "calls the token safe, legitimate, trustworthy or low-risk, or a scam, rug or fraud",
    re: new RegExp(`\\b(?:is|are|was|were|be|being|been|appears?|appeared|seems?|seemed|looks?|looked|remains?|stays?|considered|deemed|reads? as|counts? as|isn't|aren't|wasn't)\\s+(?:not\\s+)?(?:to be\\s+)?(?:likely\\s+|probably\\s+|clearly\\s+|definitely\\s+|relatively\\s+|fairly\\s+|generally\\s+|largely\\s+|reasonably\\s+|very\\s+|quite\\s+|most likely\\s+|almost certainly\\s+)?(?:an?\\s+)?${JUDGE}\\b`, "i") },
  { rule: "says the token is not a scam, rug or fraud",
    re: /\bnot\s+(?:an?\s+)?(?:scam|rug|rugpull|rug[- ]pull|fraud|ponzi)\b/i },
  { rule: "names the token safe, legitimate, trustworthy or low-risk",
    re: new RegExp(`\\b(?:an?|the)\\s+(?:${"safe|unsafe|legitimate|legit|trustworthy|low[- ]risk|risk[- ]free|scam|fraudulent"})\\s+(?:token|coin|project|asset|investment|contract|bet|buy|play)\\b`, "i") },
  { rule: "calls buying, holding or trading the token safe",
    re: /\bsafe\s+to\s+(?:buy|hold|trade|use|invest|swap|ape)\b/i },
  { rule: "tells the reader to buy, sell, hold or avoid",
    re: /\b(?:you|investors?|buyers?|readers?|holders?|traders?|users?|one)\s+(?:should|must|may want to|might want to|ought to|need to|would be wise to)\s+(?:not\s+)?(?:buy|sell|avoid|hold|exit|invest|accumulate|dump|stay away|ape)\b/i },
  { rule: "tells the reader to buy, sell, hold or avoid",
    re: /\b(?:we|i)\s+(?:strongly\s+)?(?:recommend|advise|suggest)(?:s|ed)?\s+(?:against\s+)?(?:buying|selling|avoiding|holding|investing|exiting)\b/i },
  { rule: "tells the reader to buy, sell, hold or avoid",
    re: /(?:^|[.!?:;\n]\s*|\b(?:do not|don't|never)\s+)(?:buy|sell|avoid|hold)\s+(?:this|the|these)\s+(?:token|coin|tokens|coins|project)\b/i },
  { rule: "tells the reader to buy, sell, hold or avoid",
    re: /\b(?:strong\s+)?(?:buy|sell|avoid|hold)\s+(?:rating|signal|recommendation)\b|\bstrong\s+(?:buy|sell)\b/i },
];
// A judgment word alone fails unless its clause is a can-not-detect caveat.
const WORD = new RegExp(`\\b${JUDGE}\\b`, "gi");
const CAVEAT = /\b(?:cannot|can't|can not|could not|couldn't|does not|doesn't|do not|don't|is unable to|are unable to|unable to|no on-chain (?:check|data|read)s?\s+(?:can|could))\s+(?:\w+\s+){0,3}?(?:detect|see|rule out|identify|capture|catch|reveal|exclude|show|tell|prove)\b/i;
// Proper names that hold a judgment word and name no token: the Safe multisig.
const PROPER = /\b(?:Gnosis\s+Safe|Safe\s*\{\s*Wallet\s*\}|Safe\s+(?:multisig|wallet|smart account|contract wallet)s?)\b/gi;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every judgment the text makes about a token: [{ phrase, rule }], [] when
 *  none. `names` are the token's own name and symbol, removed first. */
export function tokenClaimViolations(text, { names = [] } = {}) {
  let t = String(text || "").replace(PROPER, " ");
  for (const n of names) {
    const s = String(n || "").trim();
    if (s.length >= 2) t = t.replace(new RegExp(`(?<![\\w$])${escapeRe(s)}(?![\\w])`, "gi"), " ");
  }
  const out = [];
  const seen = new Set();
  const push = (phrase, rule) => {
    const p = phrase.replace(/\s+/g, " ").trim().slice(0, 120);
    const k = `${p.toLowerCase()}|${rule}`;
    if (!seen.has(k)) { seen.add(k); out.push({ phrase: p, rule }); }
  };
  for (const { re, rule } of FIXED) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of t.matchAll(g)) push(m[0], rule);
  }
  // Clause by clause for a bare judgment word.
  for (const clause of t.split(/[.;!?\n]+/)) {
    WORD.lastIndex = 0;
    for (const m of clause.matchAll(WORD)) {
      const before = clause.slice(0, m.index);
      if (CAVEAT.test(before)) continue;
      push(m[0], "uses a judgment word outside a can-not-detect caveat");
    }
  }
  return out;
}

/** The retry note naming what the last draft said. */
export function tokenClaimRetryNote(violations) {
  const list = violations.slice(0, 6).map((v) => `"${v.phrase}" (${v.rule})`).join("; ");
  return `\n\nYOUR PREVIOUS DRAFT WAS REJECTED because it judged the token: ${list}. Write the whole report again without any such wording. ${TOKEN_CLAIM_RULE}`;
}

/**
 * A model-written token report, checked: `draft(note)` writes the report
 * (note is "" the first time) and resolves { prose, ...extra }; a draft that
 * judges the token is written once more with the violation named, and a second
 * one that still does is withheld with a 502 (not charged: the paywall settles
 * only a < 400 answer). Resolves { prose, rewrites, ...extra } of the draft
 * that passed.
 */
export async function checkedTokenProse(draft, { names = [], label = "token report" } = {}) {
  const first = await draft("");
  const v1 = tokenClaimViolations(first.prose, { names });
  if (!v1.length) return { ...first, rewrites: 0 };
  const second = await draft(tokenClaimRetryNote(v1));
  const v2 = tokenClaimViolations(second.prose, { names });
  if (!v2.length) return { ...second, rewrites: 1 };
  throw Object.assign(new Error(`The ${label} was withheld: twice it judged the token (${v2.slice(0, 3).map((v) => `"${v.phrase}"`).join(", ")}) instead of reporting facts.${notChargedHere()} Try again shortly.`), { statusCode: 502, attribution: "ours", hint: "internal", withheld: true });
}
