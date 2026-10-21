// The shared HTML escapers escape the single quote as well as & < > ", so a
// value is inert in a single-quoted attribute too, and a list of notes is
// escaped per note, never as one string that holds the markup between them.
//
// Run: node scripts/test-escape-quotes.js
import { readFileSync } from "node:fs";
import { esc } from "../src/ledger-chrome.js";
import { solanaSectionHtml } from "../src/ledger-leaderboard.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const SAMPLE = `a&b<c>d"e'f`;
const WANT = "a&amp;b&lt;c&gt;d&quot;e&#39;f";

ok(esc(SAMPLE) === WANT, `ledger-chrome esc escapes all five characters (${esc(SAMPLE)})`);
ok(esc("x' onmouseover='y").includes("&#39;") && !esc("x' onmouseover='y").includes("'"), "a single quote never survives esc");

// The browser-side escaper in the credits thanks script, evaluated as written.
{
  const src = readFileSync(new URL("../assets/js/credits-thanks.js", import.meta.url), "utf8");
  const m = src.match(/function esc\(s\) \{[^\n]*\}/);
  ok(!!m, "credits-thanks.js defines esc on one line");
  const clientEsc = m ? new Function(`${m[0]}; return esc;`)() : () => "";
  ok(clientEsc(SAMPLE) === WANT, `credits-thanks.js esc escapes all five characters (${clientEsc(SAMPLE)})`);
  ok(clientEsc(null) === "", "credits-thanks.js esc still maps null to empty");
}

// Solana leaderboard notes: each note escaped, the separators kept as markup.
{
  const html = solanaSectionHtml({ rows: [], scanCoversAll: false, scanCandidates: 10, scanned: 5, stale: true, window: "7d" });
  ok(html.includes("</span><span>stale</span>"), "the separators between notes render as markup");
  ok(!html.includes("&lt;/span&gt;"), "no separator is escaped into visible text");
  ok(html.includes("scanned 5 of 10 seller payTos"), "the first note renders");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
