// Exact-output tests for the 36 kit2 tools. Proves each one actually works by
// asserting a known input produces the expected result.
import { KIT2 } from "../src/tools/kit2.js";

const bySlug = Object.fromEntries(KIT2.map((t) => [t.slug, t]));
let pass = 0;
const fails = [];

async function check(slug, input, assertFn, label = "") {
  const tool = bySlug[slug];
  if (!tool) return fails.push(`${slug}: NOT FOUND`);
  try {
    const out = await tool.handler(input);
    const ok = assertFn(out);
    if (ok) {
      pass++;
      console.log(`✓ ${slug.padEnd(18)} ${label}`);
    } else {
      fails.push(`${slug}: assertion failed — got ${JSON.stringify(out)}`);
      console.log(`✗ ${slug.padEnd(18)} got ${JSON.stringify(out)}`);
    }
  } catch (e) {
    fails.push(`${slug}: threw ${e.message}`);
    console.log(`✗ ${slug.padEnd(18)} threw ${e.message}`);
  }
}

// Encoding
await check("base58", { text: "Hello World" }, (o) => o.result === "JxF12TrwUP45BMd");
await check("base58", { text: "JxF12TrwUP45BMd", mode: "decode" }, (o) => o.result === "Hello World", "round-trip");
await check("base32", { text: "hello" }, (o) => o.result === "NBSWY3DP");
await check("base32", { text: "NBSWY3DP", mode: "decode" }, (o) => o.result === "hello", "round-trip");
await check("crc32", { text: "hello world" }, (o) => o.hex === "0d4a1185");
await check("rot13", { text: "Hello" }, (o) => o.result === "Uryyb");
await check("rot13", { text: "Uryyb" }, (o) => o.result === "Hello", "self-inverse");
await check("morse", { text: "SOS" }, (o) => o.result === "... --- ...");
await check("morse", { text: "... --- ...", mode: "decode" }, (o) => o.result === "SOS", "round-trip");
await check("html-entities", { text: '<a href="x">' }, (o) => o.result === "&lt;a href=&quot;x&quot;&gt;");
await check("html-entities", { text: "&lt;a&gt; &amp; &#39;b&#39;", mode: "decode" }, (o) => o.result === "<a> & 'b'");
{
  const { createHmac } = await import("node:crypto");
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const tok = `${b({ alg: "HS256", typ: "JWT" })}.${b({ sub: "1", exp: 9999999999 })}`;
  const sig = createHmac("sha256", "secret").update(tok).digest("base64url");
  await check("jwt-verify", { token: `${tok}.${sig}`, secret: "secret" }, (o) => o.valid === true && o.expired === false, "valid sig");
  await check("jwt-verify", { token: `${tok}.${sig}`, secret: "wrong" }, (o) => o.valid === false, "bad secret");
}

// Text
await check("count", { text: "the cat sat on the mat", find: "the" }, (o) => o.words === 6 && o.occurrences === 2);
await check("truncate", { text: "The quick brown fox", length: 9, words: true }, (o) => o.result === "The quick…" && o.truncated);
await check("sort-lines", { text: "banana\napple\ncherry" }, (o) => o.result === "apple\nbanana\ncherry");
await check("sort-lines", { text: "10\n2\n1", order: "numeric" }, (o) => o.result === "1\n2\n10", "numeric");
await check("dedupe-lines", { text: "a\nb\na\nc\nb" }, (o) => o.result === "a\nb\nc" && o.removed === 2);
await check("levenshtein", { a: "kitten", b: "sitting" }, (o) => o.distance === 3);
await check("redact", { text: "mail ada@x.com or 555-123-4567" }, (o) => o.result.includes("[EMAIL]") && o.result.includes("[PHONE]"));
await check("extract-entities", { text: "ping @ada at ada@x.com see https://x.com #news" }, (o) => o.emails[0] === "ada@x.com" && o.hashtags[0] === "#news" && o.mentions[0] === "@ada");
await check("readability", { text: "The cat sat on the mat. It was warm." }, (o) => o.readingEase > 80 && o.words === 9 && o.sentences === 2);

// Conversion
await check("csv-to-md", { csv: "name,age\nAda,36" }, (o) => o.markdown === "| name | age |\n| --- | --- |\n| Ada | 36 |");
await check("json-flatten", { json: { a: { b: 1 } } }, (o) => JSON.stringify(o.result) === '{"a.b":1}');
await check("json-flatten", { json: { "a.b": 1 }, mode: "unflatten" }, (o) => o.result.a.b === 1, "unflatten");
await check("json-merge", { a: { x: 1, n: { p: 1 } }, b: { y: 2, n: { q: 2 } } }, (o) => o.result.n.p === 1 && o.result.n.q === 2 && o.result.y === 2);
await check("querystring", { value: "a=1&b=hello%20world&a=2" }, (o) => o.result.b === "hello world" && JSON.stringify(o.result.a) === '["1","2"]');
await check("base-convert", { value: "ff", from: 16, to: 2 }, (o) => o.result === "11111111");
await check("base-convert", { value: "255", from: 10, to: 16 }, (o) => o.result === "ff", "dec→hex");
await check("roman", { value: 2024 }, (o) => o.result === "MMXXIV");
await check("roman", { value: "MMXXIV" }, (o) => o.result === 2024, "roman→int");

// Math
await check("calc", { expr: "2 + 3 * (4 - 1) ^ 2" }, (o) => o.result === 29);
await check("calc", { expr: "-5 + 10 / 2" }, (o) => o.result === 0, "unary minus");
await check("calc", { expr: "2 ^ 3 ^ 2" }, (o) => o.result === 512, "right-assoc ^");
await check("stats", { numbers: [2, 4, 4, 4, 5, 5, 7, 9] }, (o) => o.mean === 5 && o.median === 4.5 && o.mode === 4 && o.stddev === 2);
await check("unit-convert", { value: 100, from: "f", to: "c" }, (o) => Math.abs(o.result - 37.7778) < 0.01);
await check("unit-convert", { value: 1, from: "km", to: "m" }, (o) => o.result === 1000, "km→m");
await check("percentage", { op: "change", a: 80, b: 100 }, (o) => o.result === 25);
await check("percentage", { op: "of", a: 25, b: 200 }, (o) => o.result === 50, "of");
await check("number-format", { value: 1234567.891, decimals: 2 }, (o) => o.result === "1,234,567.89");
await check("cidr", { cidr: "192.168.1.0/24", contains: "192.168.1.42" }, (o) => o.network === "192.168.1.0" && o.broadcast === "192.168.1.255" && o.usableHosts === 254 && o.contains === true);
await check("finance", { op: "loan", principal: 20000, annualRatePct: 6, months: 60 }, (o) => Math.abs(o.monthlyPayment - 386.66) < 0.5);

// Time
await check("business-days", { from: "2026-06-01", to: "2026-06-08" }, (o) => o.businessDays === 5, "Mon→Mon = 5");
await check("age", { birthdate: "1990-05-20", asOf: "2026-06-11" }, (o) => o.years === 36 && o.months === 0);
await check("relative-time", { time: "2026-06-11T09:00:00Z", from: "2026-06-11T12:00:00Z" }, (o) => o.result === "3 hours ago" && o.seconds === -10800);
await check("add-time", { date: "2026-06-11T12:00:00Z", duration: "2d 3h" }, (o) => o.result === "2026-06-13T15:00:00.000Z");

// Validation
await check("isbn-validate", { isbn: "978-0-306-40615-7" }, (o) => o.valid === true && o.format === "ISBN-13");
await check("isbn-validate", { isbn: "0-306-40615-2" }, (o) => o.valid === true && o.format === "ISBN-10", "ISBN-10");
await check("password-strength", { password: "Tr0ub4dour&3xtra" }, (o) => o.score >= 3 && o.entropyBits > 60);
await check("json-pointer", { json: { items: [{ name: "a" }, { name: "b" }] }, pointer: "/items/1/name" }, (o) => o.found && o.value === "b");
await check("uuid-validate", { uuid: "0190a1b2-3c4d-7e6f-8a9b-0c1d2e3f4a5b" }, (o) => o.valid && o.version === 7);

console.log(`\n${pass} checks passed, ${fails.length} failed (across ${KIT2.length} tools)`);
if (fails.length) {
  console.error("FAILURES:\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log("kit2: ALL TOOLS VERIFIED ✓");
