// Exact-output tests for the 39 kit2 tools. Proves each one actually works by
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
{
  const srt = "1\n00:00:01,000 --> 00:00:03,000\nHello world\n\n2\n00:00:03,500 --> 00:00:05,000\nSecond line\n";
  await check("srt-convert", { input: srt, to: "vtt" },
    (o) => o.detected === "srt" && o.count === 2 && o.result.startsWith("WEBVTT\n\n") && o.result.includes("00:00:01.000 --> 00:00:03.000\nHello world") && o.result.includes("00:00:03.500 --> 00:00:05.000"), "srt→vtt");
  await check("srt-convert", { input: srt, to: "text" }, (o) => o.result === "Hello world\nSecond line", "srt→text");
  await check("srt-convert", { input: srt, to: "json" }, (o) => o.count === 2 && o.cues[0].start === 1000 && o.cues[0].end === 3000 && o.cues[1].text === "Second line" && o.cues[1].startTime === "00:00:03,500", "srt→json");
  const vtt = "WEBVTT\n\nNOTE a comment\n\n00:00:01.000 --> 00:00:03.000 align:start\nHello world\n";
  await check("srt-convert", { input: vtt, to: "srt" }, (o) => o.detected === "vtt" && o.count === 1 && o.result === "1\n00:00:01,000 --> 00:00:03,000\nHello world\n", "vtt→srt (drops NOTE + cue settings)");
  await check("srt-convert", { cues: [{ start: 0, end: 1500, text: "Hi" }], to: "srt" }, (o) => o.result === "1\n00:00:00,000 --> 00:00:01,500\nHi\n", "json cues→srt");
}
{
  const ics = [
    "BEGIN:VCALENDAR", "PRODID:-//Agent402//EN", "VERSION:2.0", "X-WR-CALNAME:Team cal",
    "BEGIN:VEVENT", "UID:demo-1", "SUMMARY:Team sync\\, weekly", "DTSTART:20260720T150000Z", "DTEND:20260720T153000Z",
    "LOCATION:Zoom", "STATUS:CONFIRMED", "ORGANIZER;CN=Ada:mailto:ada@example.com",
    "ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:bob@example.com",
    "DESCRIPTION:Line one\\nLine two", "RRULE:FREQ=WEEKLY;COUNT=3",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  await check("ics-parse", { ics }, (o) =>
    o.calendar.prodId === "-//Agent402//EN" && o.calendar.name === "Team cal" && o.count === 1 &&
    o.events[0].uid === "demo-1" && o.events[0].summary === "Team sync, weekly" &&
    o.events[0].location === "Zoom" && o.events[0].status === "CONFIRMED" &&
    o.events[0].description === "Line one\nLine two" &&
    o.events[0].organizer.name === "Ada" && o.events[0].attendees[0].status === "ACCEPTED" &&
    o.events[0].start.iso === "2026-07-20T15:00:00Z" && o.events[0].end.iso === "2026-07-20T15:30:00Z" &&
    o.events[0].rrule.freq === "WEEKLY" && o.events[0].rrule.count === 3, "parse VEVENT + escapes");
  await check("ics-parse", { ics, expand: true }, (o) =>
    o.events[0].occurrences.count === 3 && o.events[0].occurrences.capped === false &&
    o.events[0].occurrences.dates.join("|") === "2026-07-20T15:00:00Z|2026-07-27T15:00:00Z|2026-08-03T15:00:00Z", "expand WEEKLY COUNT=3");
  // Line folding + all-day + BYDAY expansion + UNTIL
  const folded = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:A very long su\r\n mmary line\r\nDTSTART;VALUE=DATE:20260701\r\nRRULE:FREQ=DAILY;UNTIL=20260703\r\nEND:VEVENT\r\nEND:VCALENDAR";
  await check("ics-parse", { ics: folded, expand: true }, (o) =>
    o.events[0].summary === "A very long summary line" && o.events[0].start.allDay === true &&
    o.events[0].occurrences.dates.join("|") === "2026-07-01|2026-07-02|2026-07-03", "unfold + all-day DAILY UNTIL");
  const byday = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Standup\nDTSTART:20260706T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4\nEND:VEVENT\nEND:VCALENDAR";
  await check("ics-parse", { ics: byday, expand: true }, (o) =>
    o.events[0].occurrences.dates.join("|") === "2026-07-06T09:00:00Z|2026-07-08T09:00:00Z|2026-07-13T09:00:00Z|2026-07-15T09:00:00Z", "WEEKLY BYDAY=MO,WE");
  const monthly = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Rent\nDTSTART;VALUE=DATE:20260131\nRRULE:FREQ=MONTHLY;COUNT=3\nEND:VEVENT\nEND:VCALENDAR";
  await check("ics-parse", { ics: monthly, expand: true }, (o) =>
    o.events[0].occurrences.dates.join("|") === "2026-01-31|2026-03-31|2026-05-31", "MONTHLY skips short months (RFC)");
  const complex = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:X\nDTSTART:20260701T090000Z\nRRULE:FREQ=MONTHLY;BYSETPOS=2;BYDAY=MO\nEND:VEVENT\nEND:VCALENDAR";
  await check("ics-parse", { ics: complex, expand: true }, (o) =>
    o.events[0].occurrences.supported === false, "complex RRULE → supported:false, no guessing");
  const uncapped = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Daily\nDTSTART:20260701T090000Z\nRRULE:FREQ=DAILY\nEND:VEVENT\nEND:VCALENDAR";
  await check("ics-parse", { ics: uncapped, expand: true, maxOccurrences: 5 }, (o) =>
    o.events[0].occurrences.count === 5 && o.events[0].occurrences.capped === true, "unbounded RRULE hits the cap");
  await check("ics-parse", { ics: "VALARM inside:\nBEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Real\nDTSTART:20260701T090000Z\nBEGIN:VALARM\nDESCRIPTION:alarm text\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR" },
    (o) => o.count === 1 && o.events[0].summary === "Real" && o.events[0].description === null, "VALARM props don't leak into the event");
}

// Math
await check("calc", { expr: "2 + 3 * (4 - 1) ^ 2" }, (o) => o.result === 29);
await check("calc", { expr: "-5 + 10 / 2" }, (o) => o.result === 0, "unary minus");
await check("calc", { expr: "2 ^ 3 ^ 2" }, (o) => o.result === 512, "right-assoc ^");
await check("calc", { expression: "7 * 6" }, (o) => o.result === 42, "alias: expression");
await check("calc", { formula: "100 / 4" }, (o) => o.result === 25, "alias: formula");
await check("stats", { numbers: [2, 4, 4, 4, 5, 5, 7, 9] }, (o) => o.mean === 5 && o.median === 4.5 && o.mode === 4 && o.stddev === 2);
await check("unit-convert", { value: 100, from: "f", to: "c" }, (o) => Math.abs(o.result - 37.7778) < 0.01);
await check("unit-convert", { value: 1, from: "km", to: "m" }, (o) => o.result === 1000, "km→m");

// THE OBVIOUS OTHER SPELLING IS ACCEPTED (2026-09-21). One real buyer made
// ~18 calls in a day and got a 400 on most of them: "kilopascal" while we
// listed kilopascals, "bar" while we listed bars, "millilitres", "mechanical-
// horsepower", "btu-per-hour", "statute miles" - each a unit we convert, one
// spelling away, refused with a message naming the spelling we wanted. Every
// case below is a verbatim value from that buyer's failures.
await check("unit-convert", { value: 1, from: "kilopascal", to: "pascals" }, (o) => o.result === 1000, "singular: kilopascal → pascals");
await check("unit-convert", { value: 1, from: "bar", to: "pascals" }, (o) => o.result === 100000, "singular: bar → pascals");
await check("unit-convert", { value: 1000, from: "millilitres", to: "liters" }, (o) => Math.abs(o.result - 1) < 1e-9, "British spelling: millilitres → liters");
await check("unit-convert", { value: 1, from: "mechanical-horsepower", to: "watts" }, (o) => Math.abs(o.result - 745.7) < 0.5, "synonym: mechanical-horsepower → watts");
await check("unit-convert", { value: 1, from: "btu-per-hour", to: "watts" }, (o) => Math.abs(o.result - 0.2931) < 0.001, "plural inside x-per-y: btu-per-hour → watts");
await check("unit-convert", { value: 1, from: "statute miles", to: "kilometers" }, (o) => Math.abs(o.result - 1.609344) < 1e-6, "space + qualifier: statute miles → kilometers");
await check("unit-convert", { value: 1, from: "metre", to: "centimeters" }, (o) => o.result === 100, "British singular: metre → centimeters");

// ...AND A NAME THAT RESOLVES NOWHERE STILL GETS THE HONEST 400. The widening
// must never turn an unknown unit into a guess. "poundal", "cubit" and "shaku"
// are units the table does not carry ("pood" and "verst" were on this list
// until the imperial Russian measures were added on 2026-09-25).
{
  const { normalizeUnitId } = await import("../src/tools/kit2.js");
  const { UNIT_CATEGORIES } = await import("../src/tools/convert-gen.js");
  const known = new Set(Object.values(UNIT_CATEGORIES).flatMap((c) => Object.keys(c.units)));
  for (const u of ["poundal", "cubit", "shaku"]) {
    try { await bySlug["unit-convert"].handler({ value: 1, from: u, to: "kilograms" }); fails.push(`unit-convert: "${u}" should be a 400, it converted`); }
    catch (e) { if (e.statusCode === 400 && /Unknown unit/.test(e.message)) { pass++; console.log(`✓ unit-convert        unknown "${u}" is still a self-explaining 400`); } else fails.push(`unit-convert: "${u}" threw ${e.statusCode} ${e.message}`); }
  }
  // The guard that makes the widening safe: whatever the normaliser returns is
  // an id the table has. A fuzz over mangled spellings of every known id.
  let bad = 0, resolved = 0;
  for (const id of known) for (const v of [id.toUpperCase(), id.replace(/s$/, ""), id.replace(/-/g, " "), id + "x", "statute-" + id]) {
    const r = normalizeUnitId(v); if (r === null) continue; resolved++; if (!known.has(r)) bad++;
  }
  if (bad === 0 && resolved > 50) { pass++; console.log(`✓ unit-convert        normaliser only ever returns a KNOWN id (${resolved} resolutions, 0 invented)`); }
  else fails.push(`unit-convert: normaliser returned ${bad} unknown ids across ${resolved} resolutions`);
}
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
await check("json-schema-infer", { json: { name: "Ada", age: 36, active: true, tags: ["x", "y"], joined: "1843-10-18" } },
  (o) => o.schema.$schema === "http://json-schema.org/draft-07/schema#" && o.schema.type === "object"
    && o.schema.properties.age.type === "integer" && o.schema.properties.active.type === "boolean"
    && o.schema.properties.tags.items.type === "string" && o.schema.properties.joined.format === "date"
    && JSON.stringify(o.schema.required) === '["name","age","active","tags","joined"]');
await check("json-schema-infer", { samples: [{ a: 1, b: "x" }, { a: 1.5 }] },
  (o) => o.samples === 2 && o.schema.properties.a.type === "number" && JSON.stringify(o.schema.required) === '["a"]', "merge: integer widens, required intersects");
await check("json-schema-infer", { samples: [{ v: 1 }, { v: "s" }] },
  (o) => JSON.stringify(o.schema.properties.v.type) === '["integer","string"]', "conflicting types → union");
await check("json-schema-infer", { json: '{"email":"a@b.co","when":"2026-07-13T12:00:00Z"}' },
  (o) => o.schema.properties.email.format === "email" && o.schema.properties.when.format === "date-time", "string sample + formats");

console.log(`\n${pass} checks passed, ${fails.length} failed (across ${KIT2.length} tools)`);
if (fails.length) {
  console.error("FAILURES:\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log("kit2: ALL TOOLS VERIFIED ✓");
