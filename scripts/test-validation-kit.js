// Tests for validation-kit (phone-format, xml-validate, csv-lint,
// base-detect, ipv6-expand). Pure functions, no server needed.
import { VALIDATION_TOOLS } from "../src/tools/validation-kit.js";

const tool = (slug) => VALIDATION_TOOLS.find((t) => t.slug === slug);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (slug, input) => tool(slug).handler(input);

// --- phone-format ---

// Validation: rejects empty/missing phone
let threw = false;
try { run("phone-format", {}); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "phone-format rejects missing phone");

threw = false;
try { run("phone-format", { phone: "" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "phone-format rejects empty phone");

// US number
let r = run("phone-format", { phone: "+1 (555) 234-5678" });
ok(r.e164 === "+15552345678", `phone-format US e164 (got "${r.e164}")`);
ok(r.country === "US", `phone-format US country (got "${r.country}")`);
ok(r.valid === true, "phone-format US valid");

// UK number
r = run("phone-format", { phone: "+44 7911 123456" });
ok(r.country === "UK", `phone-format UK country (got "${r.country}")`);

// With country hint
r = run("phone-format", { phone: "5552345678", country: "US" });
ok(r.valid === true, "phone-format with country hint valid");
ok(r.country === "US", `phone-format country hint applied (got "${r.country}")`);

// Deterministic
const r2 = run("phone-format", { phone: "+1 (555) 234-5678" });
ok(JSON.stringify(run("phone-format", { phone: "+1 (555) 234-5678" })) === JSON.stringify(r2), "phone-format is deterministic");

// --- xml-validate ---

// Validation: rejects empty xml
threw = false;
try { run("xml-validate", {}); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "xml-validate rejects missing xml");

threw = false;
try { run("xml-validate", { xml: "" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "xml-validate rejects empty xml");

// Valid XML
r = run("xml-validate", { xml: "<root><item>Hello</item></root>" });
ok(r.valid === true, "xml-validate valid XML");
ok(r.rootTag === "root", `xml-validate rootTag (got "${r.rootTag}")`);

// Invalid XML (unclosed tag)
r = run("xml-validate", { xml: "<root><item>Hello</root>" });
ok(r.valid === false, "xml-validate invalid XML (unclosed tag)");
ok(Array.isArray(r.errors) && r.errors.length > 0, `xml-validate errors array non-empty (${r.errors.length})`);

// Self-closing tags
r = run("xml-validate", { xml: "<br/>" });
ok(r.valid === true, "xml-validate self-closing tag valid");

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

// --- base-detect ---

// Validation: rejects empty text
threw = false;
try { run("base-detect", {}); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "base-detect rejects missing text");

threw = false;
try { run("base-detect", { text: "" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "base-detect rejects empty text");

// Base64 string
r = run("base-detect", { text: "SGVsbG8=" });
ok(r.detected === "base64", `base-detect base64 (got "${r.detected}")`);

// Hex string
r = run("base-detect", { text: "48656C6C6F" });
ok(r.detected === "hex", `base-detect hex (got "${r.detected}")`);

// Binary string
r = run("base-detect", { text: "01001000 01101001" });
ok(r.detected === "binary", `base-detect binary (got "${r.detected}")`);

// Plain text
r = run("base-detect", { text: "Hello, this is plain text with spaces!" });
ok(r.detected === "plaintext", `base-detect plaintext (got "${r.detected}")`);

// --- ipv6-expand ---

// Validation: rejects empty address
threw = false;
try { run("ipv6-expand", {}); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "ipv6-expand rejects missing address");

threw = false;
try { run("ipv6-expand", { address: "" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "ipv6-expand rejects empty address");

// Standard expansion
r = run("ipv6-expand", { address: "2001:db8::1" });
ok(r.expanded === "2001:0db8:0000:0000:0000:0000:0000:0001", `ipv6-expand expanded (got "${r.expanded}")`);
ok(r.valid === true, "ipv6-expand valid");

// Loopback
r = run("ipv6-expand", { address: "::1" });
ok(r.valid === true, "ipv6-expand loopback valid");
ok(r.expanded.endsWith(":0001"), `ipv6-expand loopback ends with :0001 (got "${r.expanded}")`);

// Full address round-trip: expand then compress
r = run("ipv6-expand", { address: "2001:0db8:0000:0000:0000:0000:0000:0001" });
const compressed = r.compressed;
const r3 = run("ipv6-expand", { address: compressed });
ok(r3.expanded === r.expanded, "ipv6-expand round-trip expand→compress→expand");

// Invalid address throws
threw = false;
try { run("ipv6-expand", { address: "not-an-ipv6-address" }); } catch (e) { threw = e.statusCode === 400; }
ok(threw, "ipv6-expand invalid address throws 400");

// --- catalog checks ---
ok(VALIDATION_TOOLS.length === 5, `exports 5 tools (got ${VALIDATION_TOOLS.length})`);
for (const t of VALIDATION_TOOLS) {
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
console.log(`\nvalidation-kit: ${pass}/${pass + fail} PASS`);
if (fail) { console.error(`${fail} assertion(s) FAILED`); process.exit(1); }
