// Tests for validation-kit (csv-lint, vat-validate). Pure functions, no server needed.
// phone-format, xml-validate, base-detect and ipv6-expand were retired 2026-08-25.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { VALIDATION_TOOLS } from "../src/tools/validation-kit.js";

const tool = (slug) => VALIDATION_TOOLS.find((t) => t.slug === slug);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (slug, input) => tool(slug).handler(input);

let r, threw = false;
// --- csv-lint ---

// Validation: rejects empty text
threw = false;
try { run("csv-lint", {}); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "csv-lint rejects missing text");

threw = false;
try { run("csv-lint", { text: "" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "csv-lint rejects empty text");

// Valid CSV
r = run("csv-lint", { text: "name,age\nAlice,30\nBob,25" });
ok(r.valid === true, "csv-lint valid CSV");
ok(r.rows === 3, `csv-lint rows (got ${r.rows})`);
ok(r.columns === 2, `csv-lint columns (got ${r.columns})`);

// Invalid CSV (inconsistent columns)
r = run("csv-lint", { text: "a,b,c\n1,2\n3,4,5" });
ok(r.valid === false, "csv-lint invalid CSV (inconsistent columns)");

// Custom delimiter
r = run("csv-lint", { text: "a;b;c\n1;2;3", delimiter: ";" });
ok(r.valid === true, "csv-lint custom delimiter valid");

// --- vat-validate ---
// Every vector is synthetic: a counting-pattern body whose check character was
// computed from the national rule (cross-checked against an independent
// implementation of the same published rules), never a company's number. The
// invalid twin differs only in its check character.
const VAT_VECTORS = [
  ["AT", "U12345675", "U12345670"], ["BE", "0123456749", "0123456700"],
  ["BG", "123456786", "123456780"], ["BG", "7503151233", "7503151230"],
  ["CY", "10234567S", "10234567A"], ["CZ", "12345679", "12345670"],
  ["CZ", "612345670", "612345671"], ["CZ", "8553151233", "8553151230"],
  ["CZ", "10000071", "10000070"],
  ["DE", "123456788", "123456780"], ["DK", "12345674", "12345670"],
  ["EE", "102345676", "102345670"], ["EL", "123456783", "123456780"],
  ["ES", "12345678Z", "12345678A"], ["ES", "X1234567L", "X1234567A"],
  ["ES", "B12345674", "B12345670"], ["ES", "P1234567D", "P1234567A"],
  ["FI", "12345671", "12345670"], ["FR", "11123456782", "00123456782"],
  ["FR", "AC123456782", "AA123456782"], ["HR", "12345678903", "12345678900"],
  ["HU", "12345676", "12345670"], ["IE", "1234567T", "1234567A"],
  ["IE", "1234567FA", "1234567AA"], ["IE", "1A23456W", "1A23456A"],
  ["IT", "12345670017", "12345670010"], ["LT", "123456715", "123456710"],
  ["LT", "123456789011", "123456789010"], ["LU", "12345613", "12345600"],
  ["LV", "41234567891", "41234567890"], ["MT", "12345634", "12345600"],
  ["NL", "123456782B01", "123456780B01"], ["NL", "123456789B13", "123456789B01"],
  ["PL", "1123456784", "1123456780"], ["PT", "123456789", "123456780"],
  ["RO", "12345674", "12345670"], ["SE", "123456789701", "123456789001"],
  ["SI", "12345679", "12345670"], ["SK", "2023456787", "2023456780"],
  ["XI", "123456782", "123456780"],
];
const vat = (input) => run("vat-validate", input);
const vatCodes = new Set(VAT_VECTORS.map(([c]) => c));
ok(vatCodes.size === 28, `vat vectors cover 27 member states plus XI (got ${vatCodes.size})`);
for (const [code, good, wrong] of VAT_VECTORS) {
  r = vat({ vat: code + good });
  ok(r.valid === true && r.formatValid === true && r.checksumValid === true && r.country === code && r.normalized === code + good,
    `vat ${code}${good} passes (got ${JSON.stringify(r)})`);
  r = vat({ vat: code + wrong });
  ok(r.valid === false && r.checksumValid === false && r.formatValid === true && typeof r.reason === "string",
    `vat ${code}${wrong} fails its check digit (got ${JSON.stringify(r)})`);
  r = vat({ vat: good, country: code.toLowerCase() });
  ok(r.valid === true && r.normalized === code + good, `vat ${code} national part with country passes`);
}
// Number types with no check digit answer null, never true.
for (const [v, kind] of [["CZ450315123", "natural person"], ["XIGD123", "government department"], ["XIHA567", "health authority"]]) {
  r = vat({ vat: v });
  ok(r.valid === true && r.formatValid === true && r.checksumValid === null && r.kind.startsWith(kind), `vat ${v}: no check digit, checksumValid null (got ${JSON.stringify(r)})`);
}
ok(vat({ vat: "XIGD567" }).formatValid === false, "vat XI GD numbers stop at 499");
// Format failures carry checksumValid null and a reason.
for (const v of ["DE012345678", "DE12345678", "ATX12345675", "CY12345678S", "NL123456782B00", "IT00000000017", "SE123456789702", "FR1I123456782"]) {
  r = vat({ vat: v });
  ok(r.valid === false && r.formatValid === false && r.checksumValid === null && typeof r.reason === "string", `vat ${v} is a format failure (got ${JSON.stringify(r)})`);
}
// Normalization: separators, case, the GR alias, an optional own prefix.
r = vat({ vat: " de 123.456-788 " });
ok(r.valid === true && r.normalized === "DE123456788" && r.input === " de 123.456-788 ", "vat separators and case are ignored, input echoed");
r = vat({ vat: "GR 123456783" });
ok(r.valid === true && r.country === "EL" && r.countryName === "Greece" && r.normalized === "EL123456783", "vat GR prefix reads as EL");
r = vat({ vat: "EL123456783", country: "GR" });
ok(r.valid === true && r.normalized === "EL123456783", "vat country GR strips an EL prefix");
r = vat({ vat: "12345670", country: "EL" });
ok(r.valid === true && r.normalized === "EL12345670", "vat 8-digit Greek form is read with a leading zero");
r = vat({ vat: "DE123456788", country: "DE" });
ok(r.valid === true && r.normalized === "DE123456788", "vat own prefix with country is stripped once");
r = vat({ vat: "US123456789" });
ok(r.valid === false && r.formatValid === false && r.country === "US" && r.countryName === null && /not an EU VAT prefix/.test(r.reason), "vat non-EU prefix answers invalid with a reason");
ok(vat({ vat: "DE123456788" }).registryChecked === false, "vat answer says no registry was checked");
// Example published in discovery answers with its documented output.
{
  const t = tool("vat-validate");
  ok(JSON.stringify(vat(t.discovery.input)) === JSON.stringify(t.discovery.output.example), "vat published example answers its documented output");
  ok(/does not query any registry/.test(t.description) && /does not confirm/.test(t.description), "vat description scopes the claim");
}
// Bad input: 400 naming the field.
for (const [input, field] of [[{}, "vat"], [{ vat: "" }, "vat"], [{ vat: " .- " }, "vat"], [{ vat: { a: 1 } }, "vat"], [{ vat: ["DE1"] }, "vat"],
  [{ vat: "DE" + "1".repeat(39) }, "vat"], [{ vat: "123456788" }, "country"], [{ vat: "123456788", country: "US" }, "country"], [{ vat: "123456788", country: 5 }, "country"]]) {
  let e = null;
  try { vat(input); } catch (err) { e = err; }
  ok(e && e.statusCode === 400 && e.message.includes(`"${field}"`), `vat ${JSON.stringify(input).slice(0, 40)} -> 400 naming ${field} (got ${e ? e.statusCode + " " + e.message : "no error"})`);
}
// Bounded work: the longest accepted input and a hostile one answer fast.
{
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 2000; i++) { try { vat({ vat: "DE" + " -".repeat(19) }); } catch {} try { vat({ vat: "x".repeat(100000) }); } catch {} }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(ms < 2000, `vat 4000 hostile calls in ${ms.toFixed(0)} ms`);
}


// The description scopes the check-digit rule to numbers that carry one: a
// Northern Ireland GD/HA number and a Czech birth number before 1954 have
// none and answer checksumValid: null, valid: true.
{
  const desc = String(tool("vat-validate").description);
  const noDigit = ["XIGD100", "XIHA500", "CZ530101123"].map((v) => vat({ vat: v }));
  ok(noDigit.every((r) => r.checksumValid === null && r.valid === true) && /the published check-digit rule where the number carries one/.test(desc),
    `vat-validate's description scopes the check-digit rule to numbers that carry one (${JSON.stringify(noDigit.map((r) => r.checksumValid))})`);
}


console.log(`\nvalidation-kit: ${pass}/${pass + fail} PASS`);
if (fail) { console.error(`${fail} assertion(s) FAILED`); process.exit(1); }

