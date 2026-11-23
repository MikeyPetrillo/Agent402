#!/usr/bin/env node
// Parse kit (src/tools/parse-kit.js) and the two tools it extends in kit.js:
// number-words, encoding-detect, log-timestamps, csv-aggregate, json-lint,
// time-convert's zones list and csv-to-json's named delimiters. Known-answer
// vectors, the 400 that names each bad field, the input caps, and a parity
// check of json-lint against JSON.parse. Pure functions, no server.
//
//   node scripts/test-parse-kit.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { gzipSync, deflateSync } from "node:zlib";
import { PARSE_TOOLS } from "../src/tools/parse-kit.js";
import { KIT } from "../src/tools/kit.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tool = (slug) => [...PARSE_TOOLS, ...KIT].find((t) => t.slug === slug);
const call = async (slug, input) => tool(slug).handler(input);
const err = async (slug, input) => { try { await call(slug, input); return null; } catch (e) { return e; } };
const refuses = async (slug, input, field, label) => {
  const e = await err(slug, input);
  ok(e?.statusCode === 400 && e.message.startsWith(`"${field}"`), `${slug}: ${label} answers 400 naming "${field}" (${e?.statusCode} ${e?.message?.slice(0, 90)})`);
};

// ---- registration -----------------------------------------------------------
for (const slug of ["number-words", "encoding-detect", "log-timestamps", "csv-aggregate", "json-lint"]) {
  const t = tool(slug);
  ok(t && FREE_TIER_SLUGS.has(slug) && !WALLET_ONLY_SLUGS.has(slug), `${slug}: defined and on the proof-of-work tier`);
  ok(/^\$0\.00[12]$/.test(t.price) && !/—/.test(t.description), `${slug}: priced like the utility tools, no em dash in the description`);
}

// ---- number-words -----------------------------------------------------------
const nw = async (text) => call("number-words", { text });
for (const [text, digits] of [
  ["forty-two thousand and seven", "42007"], ["one hundred forty-seven", "147"], ["thirty-five", "35"],
  ["two hundred one thousand", "201000"], ["nineteen hundred eighty-four", "1984"], ["a hundred", "100"],
  ["one million two hundred thousand three", "1200003"], ["zero", "0"], ["minus seventeen", "-17"],
  ["three point five", "3.5"], ["point two five", "0.25"], ["seven point oh one", "7.01"],
  ["Twenty One", "21"], ["3 million 250 thousand", "3250000"],
  ["nine quadrillion seven trillion one hundred ninety-nine billion two hundred fifty-four million seven hundred forty thousand nine hundred ninety-one", "9007199254740991"],
]) {
  const r = await nw(text);
  ok(r.digits === digits && r.number === Number(digits) && r.direction === "words-to-digits", `number-words: "${text}" -> ${digits} (${r.digits})`);
}
for (const [text, digits, suffix] of [["twenty-first", "21", "21st"], ["one hundred twelfth", "112", "112th"], ["forty-second", "42", "42nd"], ["third", "3", "3rd"], ["one thousandth", "1000", "1000th"]]) {
  const r = await nw(text);
  ok(r.ordinal === true && r.digits === digits && r.ordinalDigits === suffix, `number-words: ordinal "${text}" -> ${suffix} (${r.ordinalDigits})`);
}
for (const [text, words, ordinal, check] of [
  ["42007", "forty-two thousand seven", "forty-two thousand seventh", "Forty-two thousand seven and 00/100"],
  ["1,250.5", "one thousand two hundred fifty point five", undefined, "One thousand two hundred fifty and 50/100"],
  ["-21", "minus twenty-one", "minus twenty-first", undefined],
  ["0", "zero", "zeroth", "Zero and 00/100"],
  ["112", "one hundred twelve", "one hundred twelfth", "One hundred twelve and 00/100"],
]) {
  const r = await nw(text);
  ok(r.direction === "digits-to-words" && r.words === words && r.ordinal === ordinal && r.check === check, `number-words: ${text} -> "${r.words}" / ${r.ordinal} / ${r.check}`);
}
ok((await call("number-words", { text: 90 })).words === "ninety", "number-words: a JSON number reads as digits");
for (const w of ["forty-two thousand and seven", "one hundred forty-seven", "nineteen hundred eighty-four", "three point five"]) {
  const r = await nw(w);
  ok((await nw(r.digits)).digits === r.digits && (await nw((await nw(r.digits)).words)).digits === r.digits, `number-words: "${w}" round-trips through digits and words`);
}
for (const [text, label] of [["forty-two apples", "a word that is not a number word"], ["one two", "two units in a row"], ["twenty eleven", "a teen after a ten"],
  ["one thousand two thousand", "a repeated scale"], ["one million one billion", "a rising scale"], ["three point", "point with no digits"],
  ["first second", "a word after the ordinal"], ["ten quadrillion", "a value past the bound"], ["99999999999999999", "digits past the bound"],
  ["one " + "one ".repeat(90), "more words than the bound"], ["and five", "a leading and"]]) {
  await refuses("number-words", { text }, "text", label);
}
await refuses("number-words", {}, "text", "a missing field");
await refuses("number-words", { text: "x".repeat(501) }, "text", "text past 500 characters");
await refuses("number-words", { text: ["one"] }, "text", "a list");

// ---- encoding-detect --------------------------------------------------------
const ed = async (text) => call("encoding-detect", { text });
const best = async (text) => (await ed(text)).candidates[0];
const phrase = "The quick brown fox jumps over the lazy dog";
for (const [enc, encoded] of [
  ["base64", Buffer.from(phrase).toString("base64")],
  ["hex", Buffer.from(phrase).toString("hex")],
  ["url", encodeURIComponent("name=Ada Lovelace&role=engineer/analyst")],
  ["base64+gzip", gzipSync(Buffer.from(phrase.repeat(3))).toString("base64")],
  ["base64+zlib", deflateSync(Buffer.from(phrase)).toString("base64")],
  ["hex+gzip", gzipSync(Buffer.from(phrase)).toString("hex")],
  ["base64url", Buffer.from("subjects?>>and~~more??").toString("base64url")],
]) {
  const b = await best(encoded);
  ok(b?.encoding === enc && b.validUtf8 && b.text.length > 10, `encoding-detect: ${enc} ranks first (${b?.encoding}, ${b?.confidence}) "${b?.text?.slice(0, 30)}"`);
}
{
  const b32 = (await ed("JBSWY3DPEBLW64TMMQQQ====")).candidates.find((c) => c.encoding === "base32");
  ok(b32?.text === "Hello World!", `encoding-detect: base32 decodes ("${b32?.text}")`);
  const b58 = (await ed("2NEpo7TZRRrLZSi2U")).candidates.find((c) => c.encoding === "base58");
  ok(b58?.text === "Hello World!", `encoding-detect: base58 decodes ("${b58?.text}")`);
  const qp = await best("caf=C3=A9 au lait =3D tasty");
  ok(qp?.encoding === "quoted-printable" && qp.text === "café au lait = tasty", `encoding-detect: quoted-printable ranks first ("${qp?.text}")`);
  const bin = (await ed(Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 7, 8]).toString("base64"))).candidates[0];
  ok(bin && bin.text === undefined && /^00010203/.test(bin.hexPreview) && bin.confidence < 0.5, `encoding-detect: binary bytes come back as a hex preview with low confidence (${bin?.confidence})`);
  const none = await ed("hello, world! this is plain text.");
  ok(none.count === 0 && none.best === null && Array.isArray(none.candidates), "encoding-detect: plain text has no candidate");
  // A compression bomb: 50 MB of zeros gzipped is about 50 KB; the inflate stops at the cap.
  const bomb = gzipSync(Buffer.alloc(50_000_000)).toString("base64");
  ok(bomb.length <= 100_000, `encoding-detect: the bomb fits the input cap (${bomb.length} chars)`);
  const t0 = performance.now();
  const r = await ed(bomb);
  const ms = performance.now() - t0;
  const row = r.candidates.find((c) => c.encoding.startsWith("base64"));
  ok(row && row.encoding === "base64" && /inflates past/.test(row.note || "") && ms < 2000, `encoding-detect: a gzip bomb stops at the inflate cap and is shown undecompressed (${row?.encoding}, ${Math.round(ms)} ms)`);
  const big = await ed(Buffer.from("x".repeat(60_000)).toString("base64").slice(0, 100_000));
  ok(big.candidates[0].text.length === 2000 && big.candidates[0].textTruncated === true, "encoding-detect: decoded text is capped at 2,000 characters and says so");
}
await refuses("encoding-detect", { text: "a".repeat(100_001) }, "text", "text past the cap");
await refuses("encoding-detect", {}, "text", "a missing field");
await refuses("encoding-detect", { text: 12 }, "text", "a number");

// ---- log-timestamps ---------------------------------------------------------
const lt = async (input) => call("log-timestamps", input);
{
  const r = await lt({ text: tool("log-timestamps").discovery.input.text, year: 2026 });
  ok(r.count === 4 && r.timestamps.map((t) => t.format).join() === "iso8601,syslog,clf,epoch-seconds", `log-timestamps: the example reads four formats (${r.timestamps.map((t) => t.format)})`);
  const text = [
    "Sun, 01 Nov 2026 09:00:00 -0500 mail queued",
    "2026-11-01 14:00:01.250 worker up",
    "2026/11/01 14:00:02 slash form",
    "ts=1793541600123 ms epoch",
    "2026-11-01T13:59:00+01:00 earlier, out of order",
    "id 4294967295 is not a date; 2026-13-01T00:00:00Z is not either",
  ].join("\n");
  const s = await lt({ text });
  const isos = s.timestamps.map((t) => t.iso);
  ok(JSON.stringify(isos) === JSON.stringify(["2026-11-01T14:00:00.000Z", "2026-11-01T14:00:01.250Z", "2026-11-01T14:00:02.000Z", "2026-11-01T14:00:00.123Z", "2026-11-01T12:59:00.000Z"]), `log-timestamps: RFC 2822, ISO with fraction, slash form, epoch ms and an offset normalize to UTC (${isos})`);
  ok(s.outOfOrder === 2 && s.skippedInvalid === 1 && s.earliest === "2026-11-01T12:59:00.000Z" && s.latest === "2026-11-01T14:00:02.000Z", `log-timestamps: out-of-order and invalid stamps are counted (${s.outOfOrder}, ${s.skippedInvalid})`);
  const span = s.timestamps[1];
  ok(text.slice(span.start, span.end) === span.text && span.line === 2 && span.column === 1, "log-timestamps: each stamp carries its original span, line and column");
  const ny = await lt({ text: "2026-07-04 12:00:00 local\nJul  4 12:00:00 syslog\n2026-12-25 12:00:00 winter", assumeZone: "America/New_York", year: 2026 });
  ok(ny.timestamps.map((t) => t.iso).join() === "2026-07-04T16:00:00.000Z,2026-07-04T16:00:00.000Z,2026-12-25T17:00:00.000Z" && ny.timestamps.every((t) => t.zone === "assumed"), `log-timestamps: zone-less stamps read in assumeZone across DST (${ny.timestamps.map((t) => t.iso)})`);
  const noEpoch = await lt({ text: "a 1793628490 b 2026-11-02T00:00:00Z", epoch: false });
  ok(noEpoch.count === 1 && noEpoch.timestamps[0].format === "iso8601", "log-timestamps: epoch: false leaves 10- and 13-digit numbers alone");
  const many = await lt({ text: "2026-11-02T00:00:00Z\n".repeat(3000), limit: 10 });
  ok(many.count === 3000 && many.timestamps.length === 10 && many.truncated === true && many.matched === 3000 && many.returned === 10, "log-timestamps: a capped list says so in fields");
}
await refuses("log-timestamps", { text: "x", assumeZone: "Mars/Olympus" }, "assumeZone", "an unknown zone");
await refuses("log-timestamps", { text: "x", year: 1800 }, "year", "a year out of range");
await refuses("log-timestamps", { text: "x", limit: 5000 }, "limit", "a limit past 2000");
await refuses("log-timestamps", { text: "x", epoch: "maybe" }, "epoch", "a flag that is not true or false");
await refuses("log-timestamps", { text: "x".repeat(100_001) }, "text", "text past the cap");
{
  // Linear on long adversarial runs: digits, dashes, colons and month names.
  for (const [label, s] of [["digits", "1".repeat(100_000)], ["date-ish", "2026-11-0".repeat(11_000)], ["months", "Nov 1 ".repeat(16_000)], ["colons", "12:".repeat(33_000)]]) {
    const t0 = performance.now();
    await lt({ text: s });
    const ms = performance.now() - t0;
    ok(ms < 500, `log-timestamps: a 100,000-character run of ${label} reads in ${Math.round(ms)} ms`);
  }
}

// ---- csv-aggregate ----------------------------------------------------------
{
  const r = await call("csv-aggregate", tool("csv-aggregate").discovery.input);
  ok(r.rows === 5 && r.columns.units.sum === 35 && r.columns.units.mean === 7 && r.columns.price.max === 9.99 && r.columns.product.distinct === 2, "csv-aggregate: whole-table stats on the example");
  ok(r.groups[0].key === "west" && r.groups[0].rows === 3 && r.groups[0].columns.units.sum === 23 && r.groups[1].columns.units.min === 5 && r.complete === true, "csv-aggregate: grouped stats, largest group first");
  const semi = await call("csv-aggregate", { csv: "a;b\n1;x\n2;\n1,000;y\n", delimiter: "semicolon", columns: "a,b" });
  ok(semi.delimiter === ";" && semi.columns.a.sum === 1003 && semi.columns.b.empty === 1 && semi.columns.b.distinct === 2 && semi.columns.b.sum === undefined, `csv-aggregate: semicolon, thousands separators and empty cells (${JSON.stringify(semi.columns)})`);
  const tab = await call("csv-aggregate", { csv: "k\tv\nx\t0.1\nx\t0.2\n", delimiter: "tab", groupBy: "k" });
  ok(tab.groups[0].columns.v.sum === 0.3, `csv-aggregate: sums are tidied (${tab.groups[0].columns.v.sum})`);
  const lots = "g,v\n" + Array.from({ length: 1500 }, (_, i) => `g${i},${i}`).join("\n");
  const capped = await call("csv-aggregate", { csv: lots, groupBy: "g", limit: 5 });
  ok(capped.groups.length === 5 && capped.matched === 1500 && capped.truncated === true, "csv-aggregate: a capped group list says so in fields");
  const dup = await call("csv-aggregate", { csv: "a,a,\n1,2,3\n" });
  ok(Object.keys(dup.columns).join() === "a,a (2),column3", `csv-aggregate: duplicate and blank headers get distinct names (${Object.keys(dup.columns)})`);
}
await refuses("csv-aggregate", { csv: "a,b\n1,2\n", groupBy: "c" }, "groupBy", "a groupBy column that is not there");
await refuses("csv-aggregate", { csv: "a,b\n1,2\n", columns: ["a", "z"] }, "columns", "a column that is not there");
{
  const r = await call("csv-aggregate", { csv: "a,b\n1,2\n", delimiter: "::" });
  ok(r.delimiter === "," && /comma used/.test(r.delimiterNote || "") && r.columns.b.sum === 2, "csv-aggregate: an unrecognized delimiter reads as a comma and says so");
  ok((await call("csv-aggregate", { csv: "a;b\n1;2\n", delimiter: ";" })).delimiterNote === undefined, "csv-aggregate: a recognized delimiter carries no note");
}
await refuses("csv-aggregate", { csv: "a,b\n1,2\n", columns: { a: 1 } }, "columns", "columns that are not a list");
await refuses("csv-aggregate", { csv: "x".repeat(100_001) }, "csv", "CSV past the cap");
await refuses("csv-aggregate", { csv: Array.from({ length: 201 }, (_, i) => `c${i}`).join(",") + "\n" }, "csv", "more than 200 columns");
await refuses("csv-aggregate", { csv: "a\n1\n", groupBy: "a", limit: 0 }, "limit", "a limit of 0");

// ---- json-lint --------------------------------------------------------------
const jl = async (json) => call("json-lint", { json });
{
  const ex = await jl(tool("json-lint").discovery.input.json);
  ok(ex.valid === false && ex.syntaxError.line === 3 && ex.syntaxError.column === 26 && ex.syntaxError.message.includes("Trailing comma") && ex.syntaxError.path === "$.tags[2]", "json-lint: the example's trailing comma is found at line 3, column 26");
  for (const [text, line, column, re] of [
    ['{"a": 1 "b": 2}', 1, 9, /Expected "," or "}"/],
    ["{'a': 1}", 1, 2, /single quotes/],
    ['{"a": 1, // note\n"b": 2}', 1, 10, /comments/],
    ['[1, 2, 3', 1, 9, /unclosed bracket/],
    ['{\n  "a": [1, 2}\n}', 2, 13, /Mismatched "}"/],
    ['{"a": tru}', 1, 7, /Unexpected word "tru"/],
    ['{"a": "x\\q"}', 1, 9, /Invalid escape/],
    ['{"a": 01}', 1, 8, /leading zero/],
    ['{"a": 1}}', 1, 9, /after the end/],
    ["", 1, 1, /Empty input/],
    ['"abc', 1, 1, /Unterminated string/],
    ['{"a":\n\t"line\nbreak"}', 2, 7, /Unescaped a line break/],
  ]) {
    const r = await jl(text);
    ok(r.valid === false && r.syntaxError.line === line && r.syntaxError.column === column && re.test(r.syntaxError.message), `json-lint: ${JSON.stringify(text).slice(0, 34)} -> ${line}:${column} ${r.syntaxError?.message} (${r.syntaxError?.line}:${r.syntaxError?.column})`);
  }
  const good = await jl('{"a": {"b": [1, {"c": 2}]}, "a": 3, "d": {"x": 1, "x": 2}}');
  ok(good.valid === true && good.type === "object" && good.maxDepth === 4 && good.duplicateKeyCount === 2 && good.duplicateKeys.map((d) => d.path).join() === "$.a,$.d.x", `json-lint: valid JSON reports its duplicate keys with paths (${good.duplicateKeys.map((d) => d.path)})`);
  ok((await jl("  42 ")).type === "number" && (await jl("[[]]")).type === "array" && (await jl("﻿{}")).valid === true, "json-lint: scalar, nested and BOM-led roots");
  const deep = await jl("[".repeat(50_000) + "]".repeat(50_000));
  ok(deep.valid === true && deep.maxDepth === 50_000, "json-lint: 50,000 levels of nesting read without recursion");
  // Parity with JSON.parse on mutated documents: valid exactly when JSON.parse accepts.
  const seed = JSON.stringify({ a: [1, -2.5e3, "x\\y\"z", true, null, { b: "é\n" }], c: 0, "d e": [[], {}] });
  const alphabet = ['"', ",", ":", "[", "]", "{", "}", "1", "0", "-", ".", "e", "\\", " ", "\n", "t", "n", "x", "u"];
  let seedRng = 7;
  const rnd = (n) => { seedRng = (seedRng * 1103515245 + 12345) & 0x7fffffff; return seedRng % n; };
  let mismatches = 0, invalid = 0;
  for (let k = 0; k < 4000; k++) {
    let s = seed;
    for (let m = 0; m < 1 + rnd(3); m++) {
      const at = rnd(s.length + 1), op = rnd(3);
      s = op === 0 ? s.slice(0, at) + s.slice(at + 1) : op === 1 ? s.slice(0, at) + alphabet[rnd(alphabet.length)] + s.slice(at) : s.slice(0, at) + alphabet[rnd(alphabet.length)] + s.slice(at + 1);
    }
    let parses = true;
    try { JSON.parse(s); } catch { parses = false; }
    const r = await jl(s);
    if (!parses) invalid++;
    if (r.valid !== parses) { mismatches++; if (mismatches <= 3) console.error("  parity:", JSON.stringify(s), r.valid, parses); }
  }
  ok(mismatches === 0 && invalid > 1000, `json-lint: agrees with JSON.parse on 4,000 mutated documents (${invalid} invalid, ${mismatches} disagreements)`);
}
await refuses("json-lint", {}, "json", "a missing field");
await refuses("json-lint", { json: " ".repeat(100_001) }, "json", "text past the cap");
await refuses("json-lint", { json: { a: 1 } }, "json", "an object");

// ---- time-convert zones -----------------------------------------------------
{
  const tc = tool("time-convert");
  const single = JSON.stringify(await tc.handler({ value: 1781172000, tz: "Asia/Tokyo" }));
  ok(single === '{"utc":"2026-06-11T10:00:00.000Z","epochSeconds":1781172000,"epochMillis":1781172000000,"timezone":"Asia/Tokyo","local":"2026-06-11, 19:00:00 GMT+9","localIso":"2026-06-11T19:00:00+09:00","utcOffset":"+09:00"}', "time-convert: a single tz answers byte for byte as before");
  ok(JSON.stringify(await tc.handler({ value: 1781172000 })) === '{"utc":"2026-06-11T10:00:00.000Z","epochSeconds":1781172000,"epochMillis":1781172000000}', "time-convert: no tz, no zones answers as before");
  const multi = await tc.handler({ value: "2026-03-03T14:00:00Z", zones: ["America/New_York", "Europe/London", "Asia/Tokyo", "Asia/Kolkata"] });
  ok(multi.zones.map((z) => z.localIso).join() === "2026-03-03T09:00:00-05:00,2026-03-03T14:00:00+00:00,2026-03-03T23:00:00+09:00,2026-03-03T19:30:00+05:30", `time-convert: zones returns the instant in every zone (${multi.zones.map((z) => z.localIso)})`);
  const both = await tc.handler({ value: 1781172000, tz: "UTC", zones: "Europe/Paris, Australia/Sydney" });
  ok(both.timezone === "UTC" && both.zones.length === 2 && both.zones[1].utcOffset === "+10:00", "time-convert: a comma-separated zones string works beside tz");
  await refuses("time-convert", { value: 1, zones: ["Asia/Tokyo", "Nowhere/City"] }, "zones", "an unknown zone in the list");
  await refuses("time-convert", { value: 1, zones: Array(51).fill("UTC") }, "zones", "more than 50 zones");
  await refuses("time-convert", { value: 1, zones: [{ a: 1 }] }, "zones", "a list holding an object");
}

// ---- csv-to-json delimiter --------------------------------------------------
{
  const cj = tool("csv-to-json");
  ok(JSON.stringify(await cj.handler({ csv: "name,age\nAda,36\n" })) === '{"rows":[{"name":"Ada","age":"36"}],"count":1}', "csv-to-json: the comma default answers as before");
  for (const [delimiter, csv] of [["semicolon", "name;age\nAda;36\n"], ["tab", "name\tage\nAda\t36\n"], ["\\t", "name\tage\nAda\t36\n"], ["pipe", "name|age\nAda|36\n"], ["|", "name|age\nAda|36\n"], ["~", "name~age\nAda~36\n"], ["\t", "name\tage\nAda\t36\n"]]) {
    const r = await cj.handler({ csv, delimiter });
    ok(r.rows[0]?.age === "36", `csv-to-json: delimiter ${JSON.stringify(delimiter)} splits the columns`);
  }
  // A value that is not read falls back to a comma, as it always did, and the answer says so.
  for (const delimiter of ["ab", '"', "\n", 5, ["x"]]) {
    const r = await cj.handler({ csv: "name,age\nAda,36\n", delimiter });
    ok(r.rows[0]?.age === "36" && r.delimiterUsed === "," && /comma used/.test(r.delimiterNote || ""), `csv-to-json: delimiter ${JSON.stringify(delimiter)} is not refused; comma is used and named`);
  }
  ok(JSON.stringify(await cj.handler({ csv: "name;age\nAda;36\n", delimiter: "semicolon" })) === '{"rows":[{"name":"Ada","age":"36"}],"count":1}', "csv-to-json: a recognized delimiter adds no field");
  ok(/semicolon, tab, pipe/.test(cj.description) && /semicolon, tab, pipe/.test(cj.discovery.inputSchema.properties.delimiter.description), "csv-to-json: the description and schema name the delimiters");
}

// ---- review round: loop time, answer size and stated limits ---------------
{
  // A non-UTC zone converts every stamp: a dense log stays fast (one
  // formatter per zone, not two per stamp). Best of three.
  const lt = tool("log-timestamps");
  for (const [tz, unit] of [["America/New_York", "2026-11-02 14:03:07 x\n"], ["Asia/Kolkata", "Nov  2 14:05:11 host a\n"]]) {
    const text = unit.repeat(Math.floor(95_000 / unit.length));
    let best = Infinity, r = null;
    for (let i = 0; i < 3; i++) { const t = performance.now(); r = lt.handler({ text, assumeZone: tz, year: 2026 }); best = Math.min(best, performance.now() - t); }
    ok(r.count > 4000 && best < 120, `log-timestamps: ${r.count} stamps in ${tz} in ${best.toFixed(0)} ms (under 120)`);
  }
  // json-lint: a long key does not repeat into every duplicate's path.
  const big = "k".repeat(98_000);
  const doc = `{"${big}":{${Array.from({ length: 150 }, () => '"a":1').join(",")}}}`;
  const jr = tool("json-lint").handler({ json: doc });
  const size = JSON.stringify(jr).length;
  ok(jr.duplicateKeyCount === 149 && size < 150_000, `json-lint: 149 duplicates under a 98,000-character key answer ${size.toLocaleString("en-US")} characters (under 150,000)`);
  ok(jr.duplicateKeys.every((d) => d.path.length <= 300) && jr.duplicateKeys[0].pathTruncated === true, "json-lint: each duplicate's path is capped and marked");
  const dupLong = tool("json-lint").handler({ json: `{"${"q".repeat(40_000)}":1,"${"q".repeat(40_000)}":2}` });
  ok(dupLong.duplicateKeys[0].key.length <= 200 && dupLong.duplicateKeys[0].keyTruncated === true && dupLong.duplicateKeys[0].keyLength === 40_000, "json-lint: a long duplicate key is cut to 200 characters, marked, with its length");
  // The request body limit is stated where the text limit is.
  for (const slug of ["log-timestamps", "csv-aggregate", "json-lint", "encoding-detect"]) {
    const d = tool(slug).description;
    if (!/100,000 characters/.test(d)) continue;
    ok(/request body of at most 100 KB/.test(d), `${slug}: the description states the 100 KB request body beside its character limit`);
  }
  // Delimiters: any single character other than a quote or a line break.
  for (const slug of ["csv-to-json", "csv-aggregate"]) {
    const t = tool(slug);
    ok(t.description.includes("any single character other than a quote or a line break") && t.discovery.inputSchema.properties.delimiter.description.includes("any single character other than a quote or a line break"), `${slug}: the delimiter text names what a delimiter cannot be`);
  }
  // One spelling of "time zones" in the prose of the new descriptions.
  const tc = tool("time-convert");
  const prose = [tc.description, tc.discovery.inputSchema.properties.zones.description, lt.description, lt.discovery.inputSchema.properties.assumeZone.description].join(" ");
  ok(!/\btimezones?\b(?!,)/i.test(prose.replace(/with tz, timezone,/, "")), "the new descriptions write time zone(s), never timezone(s)");
}

// ---- CSV answers are bounded before they are built --------------------------
{
  const errOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const many = `g,${"x".repeat(90_000)}\n` + Array.from({ length: 1000 }, (_, i) => `k${i},1`).join("\n");
  const t0 = performance.now();
  const e1 = errOf(() => tool("csv-aggregate").handler({ csv: many, groupBy: "g", limit: 1000 }));
  ok(e1 && e1.statusCode === 413 && /answer would be/.test(e1.message) && performance.now() - t0 < 200, `csv-aggregate: a long column name over 1,000 groups answers 413 before it is built (${e1?.statusCode}: ${e1?.message?.slice(0, 120)})`);
  const small = tool("csv-aggregate").handler({ csv: `g,${"x".repeat(2_000)}\n` + Array.from({ length: 50 }, (_, i) => `k${i},1`).join("\n"), groupBy: "g", limit: 1000 });
  ok(small.groups.length === 50, "csv-aggregate: the same shape at a modest size is answered");
  const wide = Array.from({ length: 2000 }, (_, i) => `column_name_${i}`).join(",") + "\n" + "1\n".repeat(2000);
  const t1 = performance.now();
  const e2 = errOf(() => tool("csv-to-json").handler({ csv: wide }));
  ok(e2 && e2.statusCode === 413 && /answer would be/.test(e2.message) && performance.now() - t1 < 200, `csv-to-json: a wide header over many rows answers 413 before it is built (${e2?.statusCode}: ${e2?.message?.slice(0, 120)})`);
  const rows = tool("csv-to-json").handler({ csv: wide, header: false });
  ok(rows.count === 2001, "csv-to-json: the same CSV without header objects is answered");
  // Names are measured as they are written in JSON: a control character
  // takes six bytes there, so a 6 KB input with such a header is refused too.
  const ctl = "\u0001".repeat(4_000) + "\n" + "1\n".repeat(1_200);
  const e3 = errOf(() => tool("csv-to-json").handler({ csv: ctl }));
  ok(e3 && e3.statusCode === 413, `csv-to-json: a control-character header over 1,200 rows answers 413 (${e3?.statusCode ?? "answered"})`);
  const ctlAgg = `g,${"\u0001".repeat(15_000)}\n` + Array.from({ length: 1000 }, (_, i) => `k${i},1`).join("\n");
  const e4 = errOf(() => tool("csv-aggregate").handler({ csv: ctlAgg, groupBy: "g", limit: 1000 }));
  ok(e4 && e4.statusCode === 413, `csv-aggregate: a control-character column name over 1,000 groups answers 413 (${e4?.statusCode ?? "answered"})`);
  for (const slug of ["csv-to-json", "csv-aggregate"]) {
    const t = tool(slug);
    const r = t.handler({ ...t.discovery.input });
    ok(r && !(r instanceof Error), `${slug}: its published example is still answered`);
  }
}

// ---- log-timestamps claims the formats it reads ----
ok(tool("log-timestamps").description.startsWith("Find each timestamp in the formats below in log text"), "log-timestamps: the description claims the listed formats, not every timestamp");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
