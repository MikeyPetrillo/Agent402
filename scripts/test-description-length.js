// A catalog description is read whole on tool pages, /api/pricing,
// /openapi.json, /llms.txt, the connector's tool listings and marketplace
// listings, so its length is held:
//
//   1. No description in the catalog is over MAX_WORDS words. The ceiling is
//      the longest description in the catalog rounded up to the next ten (the
//      run prints the three longest): lower it when that one is trimmed, and
//      never raise it.
//   2. Each description in TRIMMED is at most TRIMMED_MAX_WORDS words, and
//      its first sentence (what the tool page leads with) is at most
//      FIRST_SENTENCE_MAX_WORDS words. A tool whose description is rewritten
//      to fit joins the list.
//
// Words are runs of non-space characters in the text /api/pricing serves, so
// a note the server appends (a run-time note, a source credit) is counted.
// Boots a free-mode server with the switched tool families listed.
//
//   node scripts/test-description-length.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";

export const MAX_WORDS = 200;
export const TRIMMED_MAX_WORDS = 120;
export const FIRST_SENTENCE_MAX_WORDS = 40;
export const TRIMMED = [
  "html-frames", "token-risk", "price-webhook", "token-brief", "page-speed", "dex-pool-health", "redact-chat",
  "sol-token-report", "demand-radar", "token-risk-pro", "linkedin-article", "seller-dossier", "attest", "ticker-pack",
  "token-safety", "onchain-sql", "email-guard", "filing-report", "loop-gate", "insider-report",
];

export const wordCount = (text) => String(text || "").trim().split(/\s+/).filter(Boolean).length;
// The sentence a tool page leads with (firstSentence in src/pages.js): up to
// the first period, question mark or exclamation mark that ends the text or
// is followed by a capital, a bracket or a quote.
export function firstSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.+?[.!?])(?=\s+[A-Z(`"]|$)/);
  return m ? m[1] : s;
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; if (process.env.VERBOSE) console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

ok(wordCount("  one two\n three  ") === 3 && wordCount("") === 0, "words are runs of non-space characters");
ok(firstSentence("Reads window.renderAt(t). The tool renders it.") === "Reads window.renderAt(t)." && firstSentence("Costs 0.5 units a call. Next.") === "Costs 0.5 units a call." && firstSentence("no end") === "no end", "the first sentence ends at a period before a capital, not inside a name or a number");
ok(new Set(TRIMMED).size === TRIMMED.length && TRIMMED.length >= 20, `the trimmed list names each tool once (${TRIMMED.length})`);

const srv = await bootServer({ stores: "description-length", env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", KALSHI_TOOLS: "on", RUGCHECK_TOOLS: "on" } });
try {
  const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
  const tools = pricing.endpoints || [];
  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  ok(tools.length >= 400, `the catalog is read (${tools.length} tools)`);

  const sized = tools.map((t) => ({ slug: t.slug, words: wordCount(t.description) })).sort((a, b) => b.words - a.words);
  const over = sized.filter((t) => t.words > MAX_WORDS);
  ok(over.length === 0, `no description is over ${MAX_WORDS} words${over.length ? ` (${over.map((t) => `${t.slug} ${t.words}`).join(", ")})` : ""}`);
  ok(tools.every((t) => wordCount(t.description) >= 3), "every tool has a description");

  for (const slug of TRIMMED) {
    const t = bySlug.get(slug);
    ok(!!t, `${slug} is in the catalog`);
    if (!t) continue;
    const words = wordCount(t.description);
    const lead = wordCount(firstSentence(t.description));
    ok(words <= TRIMMED_MAX_WORDS, `${slug}: ${words} words (at most ${TRIMMED_MAX_WORDS})`);
    ok(lead <= FIRST_SENTENCE_MAX_WORDS, `${slug}: the first sentence is ${lead} words (at most ${FIRST_SENTENCE_MAX_WORDS})`);
  }
  console.log(`longest: ${sized.slice(0, 3).map((t) => `${t.slug} ${t.words}`).join(", ")}`);
} finally {
  await srv.stop();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
