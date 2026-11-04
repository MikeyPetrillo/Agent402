// Tests for validation-kit (csv-lint). Pure functions, no server needed.
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


console.log(`\nvalidation-kit: ${pass}/${pass + fail} PASS`);
if (fail) { console.error(`${fail} assertion(s) FAILED`); process.exit(1); }

