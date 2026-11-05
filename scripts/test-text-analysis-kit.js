// Tests for text-analysis-kit (readability-score). Pure functions, no server needed.
// word-frequency, text-similarity, lorem-ipsum and slug-generate were retired 2026-08-25.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { TEXT_ANALYSIS_TOOLS } from "../src/tools/text-analysis-kit.js";

const tool = (slug) => TEXT_ANALYSIS_TOOLS.find((t) => t.slug === slug);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (slug, input) => tool(slug).handler(input);

// --- readability-score ---

// Validation: rejects short text
let threw = false;
try { run("readability-score", { text: "short" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "readability-score rejects text < 10 chars");

// Validation: rejects empty text
threw = false;
try { run("readability-score", { text: "" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "readability-score rejects empty text");

// Known input shape
let r = run("readability-score", { text: "The cat sat on the mat. It was a very good cat. The mat was red." });
ok(typeof r.words === "number" && r.words > 0, `readability-score returns word count (${r.words})`);
ok(typeof r.sentences === "number" && r.sentences > 0, `readability-score returns sentence count (${r.sentences})`);
ok(typeof r.syllables === "number" && r.syllables > 0, `readability-score returns syllable count (${r.syllables})`);
ok(typeof r.fleschReadingEase === "number", `readability-score returns fleschReadingEase (${r.fleschReadingEase})`);
ok(typeof r.fleschKincaidGrade === "number", `readability-score returns fleschKincaidGrade (${r.fleschKincaidGrade})`);
ok(typeof r.gunningFog === "number", `readability-score returns gunningFog (${r.gunningFog})`);
ok(typeof r.automatedReadability === "number", `readability-score returns automatedReadability (${r.automatedReadability})`);

// Deterministic: same input, same output
const r2 = run("readability-score", { text: "The cat sat on the mat. It was a very good cat. The mat was red." });
ok(JSON.stringify(r) === JSON.stringify(r2), "readability-score is deterministic");

// Simple text should have high reading ease (easy to read)
ok(r.fleschReadingEase > 50, `readability-score simple text has high reading ease (${r.fleschReadingEase})`);


console.log(`\ntext-analysis-kit: ${pass}/${pass + fail} PASS`);
if (fail) { console.error(`${fail} assertion(s) FAILED`); process.exit(1); }

