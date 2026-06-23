// Tests for text-analysis-kit (readability-score, word-frequency, text-similarity,
// lorem-ipsum, slug-generate). Pure functions, no server needed.
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

// --- word-frequency ---

// Validation: rejects empty text
threw = false;
try { run("word-frequency", { text: "" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "word-frequency rejects empty text");

// Known input
r = run("word-frequency", { text: "the quick brown fox jumps over the lazy dog. The dog barked at the fox.", top: 5 });
ok(Array.isArray(r.words) && r.words.length > 0, `word-frequency returns words array (${r.words.length})`);
ok(Array.isArray(r.bigrams), `word-frequency returns bigrams array`);
ok(typeof r.totalWords === "number" && r.totalWords > 0, `word-frequency returns totalWords (${r.totalWords})`);
ok(typeof r.uniqueWords === "number", `word-frequency returns uniqueWords (${r.uniqueWords})`);

// "fox" and "dog" appear twice (stop words "the" filtered out)
const foxEntry = r.words.find((w) => w.word === "fox");
const dogEntry = r.words.find((w) => w.word === "dog");
ok(foxEntry && foxEntry.count === 2, `word-frequency counts "fox" = 2 (got ${foxEntry?.count})`);
ok(dogEntry && dogEntry.count === 2, `word-frequency counts "dog" = 2 (got ${dogEntry?.count})`);

// Stop words should be filtered
ok(!r.words.find((w) => w.word === "the"), "word-frequency filters stop word 'the'");

// Words are sorted descending by count
const sorted = r.words.every((w, i) => i === 0 || r.words[i - 1].count >= w.count);
ok(sorted, "word-frequency words are sorted descending by count");

// Deterministic
const r3 = run("word-frequency", { text: "the quick brown fox jumps over the lazy dog. The dog barked at the fox.", top: 5 });
ok(JSON.stringify(r) === JSON.stringify(r3), "word-frequency is deterministic");

// --- text-similarity ---

// Validation: rejects missing params
threw = false;
try { run("text-similarity", { a: "hello" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "text-similarity rejects missing 'b'");

threw = false;
try { run("text-similarity", { b: "hello" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "text-similarity rejects missing 'a'");

threw = false;
try { run("text-similarity", { a: "", b: "hello" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "text-similarity rejects empty 'a'");

// Identical texts: perfect similarity
r = run("text-similarity", { a: "the quick brown fox", b: "the quick brown fox" });
ok(r.jaccard === 1, `text-similarity identical texts jaccard=1 (got ${r.jaccard})`);
ok(r.sorensen === 1, `text-similarity identical texts sorensen=1 (got ${r.sorensen})`);
ok(r.overlap === 1, `text-similarity identical texts overlap=1 (got ${r.overlap})`);
ok(r.uniqueA.length === 0, "text-similarity identical texts no uniqueA");
ok(r.uniqueB.length === 0, "text-similarity identical texts no uniqueB");

// Partially overlapping texts
r = run("text-similarity", { a: "the quick brown fox jumps over the lazy dog", b: "the fast brown fox leaps over the lazy cat" });
ok(r.jaccard > 0 && r.jaccard < 1, `text-similarity partial jaccard in (0,1) (got ${r.jaccard})`);
ok(r.sorensen >= r.jaccard, `text-similarity sorensen >= jaccard (${r.sorensen} >= ${r.jaccard})`);
ok(r.shared.length > 0, `text-similarity has shared words (${r.shared.length})`);
ok(r.uniqueA.length > 0, `text-similarity has uniqueA words (${r.uniqueA.length})`);
ok(r.uniqueB.length > 0, `text-similarity has uniqueB words (${r.uniqueB.length})`);
ok(r.sharedCount === r.shared.length, "text-similarity sharedCount matches shared array");

// Completely disjoint texts
r = run("text-similarity", { a: "alpha beta gamma", b: "delta epsilon zeta" });
ok(r.jaccard === 0, `text-similarity disjoint jaccard=0 (got ${r.jaccard})`);
ok(r.sorensen === 0, `text-similarity disjoint sorensen=0 (got ${r.sorensen})`);
ok(r.overlap === 0, `text-similarity disjoint overlap=0 (got ${r.overlap})`);

// Deterministic
const rSim1 = run("text-similarity", { a: "hello world", b: "hello earth" });
const rSim2 = run("text-similarity", { a: "hello world", b: "hello earth" });
ok(JSON.stringify(rSim1) === JSON.stringify(rSim2), "text-similarity is deterministic");

// --- lorem-ipsum ---

// Default mode (paragraphs)
r = run("lorem-ipsum", {});
ok(r.mode === "paragraphs", `lorem-ipsum default mode is paragraphs`);
ok(r.count === 3, `lorem-ipsum default count is 3 (got ${r.count})`);
ok(typeof r.text === "string" && r.text.length > 50, "lorem-ipsum returns text");
ok(r.text.includes("\n\n"), "lorem-ipsum paragraphs mode has paragraph separators");

// Sentences mode
r = run("lorem-ipsum", { mode: "sentences", sentences: 3 });
ok(r.mode === "sentences", "lorem-ipsum sentences mode");
ok(r.count === 3, `lorem-ipsum sentences count = 3 (got ${r.count})`);
ok(!r.text.includes("\n\n"), "lorem-ipsum sentences mode has no paragraph separators");

// Deterministic
const r4 = run("lorem-ipsum", { paragraphs: 2 });
const r5 = run("lorem-ipsum", { paragraphs: 2 });
ok(r4.text === r5.text, "lorem-ipsum is deterministic");

// Rejects invalid mode
threw = false;
try { run("lorem-ipsum", { mode: "invalid" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "lorem-ipsum rejects invalid mode");

// Each sentence ends with a period
const periods = r4.text.match(/\./g);
ok(periods && periods.length > 0, "lorem-ipsum sentences end with periods");

// --- slug-generate ---

// Validation: rejects empty text
threw = false;
try { run("slug-generate", { text: "" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "slug-generate rejects empty text");

// Basic slug
r = run("slug-generate", { text: "Hello World!" });
ok(r.slug === "hello-world", `slug-generate basic (got "${r.slug}")`);
ok(r.original === "Hello World!", "slug-generate returns original");
ok(r.length === r.slug.length, "slug-generate returns correct length");

// Accented characters
r = run("slug-generate", { text: "Cafe avec creme brulee" });
ok(r.slug === "cafe-avec-creme-brulee", `slug-generate accented (got "${r.slug}")`);

r = run("slug-generate", { text: "El nino espanol" });
ok(r.slug === "el-nino-espanol", `slug-generate accented spanish (got "${r.slug}")`);

// Unicode diacritics via NFD
r = run("slug-generate", { text: "\u00e9\u00e8\u00ea\u00eb" }); // e-acute, e-grave, e-circumflex, e-diaeresis
ok(r.slug === "eeee", `slug-generate strips diacritics (got "${r.slug}")`);

// Multiple special chars collapse to single hyphen
r = run("slug-generate", { text: "hello   ---   world" });
ok(r.slug === "hello-world", `slug-generate collapses hyphens (got "${r.slug}")`);

// Leading/trailing hyphens trimmed
r = run("slug-generate", { text: "---hello---" });
ok(r.slug === "hello", `slug-generate trims edge hyphens (got "${r.slug}")`);

// Max-length with word-boundary truncation
r = run("slug-generate", { text: "Hello World This Is A Test", maxLength: 15 });
ok(r.slug.length <= 15, `slug-generate respects maxLength (${r.slug.length} <= 15)`);
ok(!r.slug.endsWith("-"), "slug-generate maxLength does not end with hyphen");

// Deterministic
const r6 = run("slug-generate", { text: "Hello World!" });
ok(r6.slug === "hello-world", "slug-generate is deterministic");

// --- catalog checks ---
ok(TEXT_ANALYSIS_TOOLS.length === 5, `exports 5 tools (got ${TEXT_ANALYSIS_TOOLS.length})`);
for (const t of TEXT_ANALYSIS_TOOLS) {
  ok(typeof t.route === "string" && t.route.includes("/api/"), `${t.slug} has route`);
  ok(typeof t.name === "string" && t.name.length > 0, `${t.slug} has name`);
  ok(typeof t.slug === "string" && t.slug.length > 0, `${t.slug} has slug`);
  ok(t.category === "text", `${t.slug} category is "text"`);
  ok(t.price === "$0.001", `${t.slug} price is $0.001`);
  ok(typeof t.handler === "function", `${t.slug} has handler`);
  ok(Array.isArray(t.tags) && t.tags.length > 0, `${t.slug} has tags`);
  ok(t.discovery && t.discovery.inputSchema, `${t.slug} has discovery.inputSchema`);
}

// --- summary ---
console.log(`\ntext-analysis-kit: ${pass}/${pass + fail} PASS`);
if (fail) { console.error(`${fail} assertion(s) FAILED`); process.exit(1); }
