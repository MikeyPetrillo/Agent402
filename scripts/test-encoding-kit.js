// Tests for encoding-kit (punycode-convert, nato-phonetic, soundex,
// binary-text, braille-convert). Pure functions, no server needed.
import { ENCODING_TOOLS } from "../src/tools/encoding-kit.js";

const tool = (slug) => ENCODING_TOOLS.find((t) => t.slug === slug);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (slug, input) => tool(slug).handler(input);

// --- punycode-convert ---

// Validation: rejects empty domain
let threw = false;
try { run("punycode-convert", { domain: "" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "punycode-convert rejects empty domain");

threw = false;
try { run("punycode-convert", {}); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "punycode-convert rejects missing domain");

// Encode IDN domain
let r = run("punycode-convert", { domain: "münchen.de" });
ok(r.result.startsWith("xn--"), `punycode-convert encode starts with xn-- (got "${r.result}")`);
ok(r.mode === "encode", `punycode-convert mode is encode`);

// Round-trip: encode then decode
const encoded = r.result;
const r2 = run("punycode-convert", { domain: encoded, decode: true });
ok(r2.result === "münchen.de", `punycode-convert round-trip (got "${r2.result}")`);

// ASCII domain stays unchanged
r = run("punycode-convert", { domain: "example.com" });
ok(r.result === "example.com", `punycode-convert ASCII unchanged (got "${r.result}")`);

// --- nato-phonetic ---

// Validation: rejects unmapped character
threw = false;
try { run("nato-phonetic", { text: "@#$" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "nato-phonetic rejects unmapped characters");

// SOS encode
r = run("nato-phonetic", { text: "SOS" });
ok(r.result.includes("Sierra"), `nato-phonetic SOS includes Sierra (got "${r.result}")`);
ok(r.result.includes("Oscar"), `nato-phonetic SOS includes Oscar (got "${r.result}")`);

// Round-trip: encode then decode
const natoEncoded = r.result;
const r3 = run("nato-phonetic", { text: natoEncoded, decode: true });
ok(r3.result === "SOS", `nato-phonetic round-trip (got "${r3.result}")`);

// Numbers
r = run("nato-phonetic", { text: "42" });
ok(r.result.includes("Four"), `nato-phonetic 42 includes Four (got "${r.result}")`);
ok(r.result.includes("Two"), `nato-phonetic 42 includes Two (got "${r.result}")`);

// --- soundex ---

// Validation: rejects empty text
threw = false;
try { run("soundex", {}); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "soundex rejects missing text");

threw = false;
try { run("soundex", { text: "" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "soundex rejects empty text");

// Robert and Rupert same soundex code
r = run("soundex", { text: "Robert Rupert" });
ok(r.codes[0].soundex === r.codes[1].soundex, `soundex Robert/Rupert match (${r.codes[0].soundex} === ${r.codes[1].soundex})`);
ok(r.match === true, "soundex Robert/Rupert match true");

// Smith soundex
r = run("soundex", { text: "Smith" });
ok(r.codes[0].soundex === "S530", `soundex Smith = S530 (got "${r.codes[0].soundex}")`);

// Single word match is false
ok(r.match === false, "soundex single word match false");

// --- binary-text ---

// Encode Hi
r = run("binary-text", { text: "Hi" });
ok(r.result === "01001000 01101001", `binary-text encode Hi (got "${r.result}")`);
ok(r.mode === "encode", "binary-text mode is encode");

// Round-trip: encode then decode
const binEncoded = r.result;
const r4 = run("binary-text", { text: binEncoded, decode: true });
ok(r4.result === "Hi", `binary-text round-trip (got "${r4.result}")`);

// Decode invalid binary throws
threw = false;
try { run("binary-text", { text: "not-binary", decode: true }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "binary-text decode invalid binary throws");

// --- braille-convert ---

// Encode hello
r = run("braille-convert", { text: "hello" });
ok(r.result.length > 0, "braille-convert result is non-empty");
ok(r.result !== "hello", "braille-convert result differs from input");

// Round-trip: encode then decode
const brailleEncoded = r.result;
const r5 = run("braille-convert", { text: brailleEncoded, decode: true });
ok(r5.result === "hello", `braille-convert round-trip (got "${r5.result}")`);

// Result contains Unicode Braille characters (U+2800-U+283F)
const hasBraille = [...r.result].some((ch) => {
  const cp = ch.codePointAt(0);
  return cp >= 0x2800 && cp <= 0x283F;
});
ok(hasBraille, "braille-convert result contains Braille Unicode characters");

// --- catalog checks ---
ok(ENCODING_TOOLS.length === 5, `exports 5 tools (got ${ENCODING_TOOLS.length})`);
for (const t of ENCODING_TOOLS) {
  ok(typeof t.route === "string" && t.route.includes("/api/"), `${t.slug} has route`);
  ok(typeof t.name === "string" && t.name.length > 0, `${t.slug} has name`);
  ok(typeof t.slug === "string" && t.slug.length > 0, `${t.slug} has slug`);
  ok(typeof t.category === "string", `${t.slug} has category`);
  ok(t.price === "$0.001", `${t.slug} price is $0.001`);
  ok(typeof t.handler === "function", `${t.slug} has handler`);
  ok(Array.isArray(t.tags) && t.tags.length > 0, `${t.slug} has tags`);
  ok(t.discovery && t.discovery.inputSchema, `${t.slug} has discovery.inputSchema`);
}

// --- summary ---
console.log(`\nencoding-kit: ${pass}/${pass + fail} PASS`);
if (fail) { console.error(`${fail} assertion(s) FAILED`); process.exit(1); }
