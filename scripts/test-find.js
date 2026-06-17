// Unit tests for the one-call tool resolver (/api/find). Pure, no network.
import { findTools } from "../src/find.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const CATALOG = {
  "POST /api/extract": { name: "Extract article", slug: "extract", category: "web", price: "$0.005", description: "Extract the main article content from any URL as clean markdown.", tags: ["scraping", "markdown", "content"], discovery: { inputSchema: { properties: { url: { type: "string" } }, required: ["url"] }, input: { url: "https://example.com/article" } } },
  "POST /api/qr": { name: "QR code", slug: "qr", category: "identifiers", price: "$0.001", description: "Generate a QR code PNG from text or a URL.", tags: ["qr", "barcode"], discovery: { inputSchema: { properties: { text: { type: "string" } } }, input: { text: "hello" } } },
  "GET /api/convert/miles-to-kilometers": { name: "miles to kilometers", slug: "convert-miles-to-kilometers", category: "convert", price: "$0.001", description: "Convert miles to kilometers.", tags: ["distance", "length"], discovery: { example: { value: 5 } } },
  "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "Hash text with sha256/md5/etc.", tags: ["sha256", "crypto"], discovery: { inputSchema: { properties: { text: { type: "string" } }, required: ["text"] }, input: { text: "hi", algo: "sha256" } } },
};
const POW = new Set(["qr", "hash", "convert-miles-to-kilometers"]);

// Exact slug term wins.
let r = findTools(CATALOG, "extract", { baseUrl: "https://agent402.tools", powSlugs: POW });
ok(r.results[0].slug === "extract", `"extract" → extract first (got ${r.results[0]?.slug})`);
ok(r.results[0].route === "POST /api/extract" && r.results[0].price === "$0.005", "result carries route + price");
ok(r.results[0].inputSchema && r.results[0].example?.url, "result carries inputSchema + example");
ok(r.results[0].docs === "https://agent402.tools/tools/extract", "result carries docs link");
ok(r.results[0].computePayable === false, "extract flagged not compute-payable");

// Natural-language task resolves to the right tool.
r = findTools(CATALOG, "convert miles to kilometers", {});
ok(r.results[0].slug === "convert-miles-to-kilometers", `NL task → convert tool (got ${r.results[0]?.slug})`);

r = findTools(CATALOG, "make a qr code for a url", { powSlugs: POW });
ok(r.results[0].slug === "qr", `"qr code" → qr (got ${r.results[0]?.slug})`);
ok(r.results[0].computePayable === true, "qr flagged compute-payable");

// Description/tag hit still matches (no slug overlap).
r = findTools(CATALOG, "sha256 checksum", {});
ok(r.results.length > 0 && r.results[0].slug === "hash", `tag match → hash (got ${r.results[0]?.slug})`);

// Stopwords are stripped: a stopword-only query matches nothing.
ok(findTools(CATALOG, "the", {}).count === 0, "single stopword → no results");
ok(findTools(CATALOG, "of in on to for", {}).count === 0, "all-stopword query → no results");

// Stopwords don't poison NL queries — intent words still rank correctly.
r = findTools(CATALOG, "i would like to extract an article from the web", {});
ok(r.results[0]?.slug === "extract", `NL with stopwords → extract still wins (got ${r.results[0]?.slug})`);

// Exact tag match outranks a description-only hit. "barcode" is a tag on qr,
// not in qr's slug/name; "notes" mentions barcode only in description text.
const TAG_CATALOG = {
  "POST /api/qr": { name: "QR code", slug: "qr", category: "identifiers", price: "$0.001", description: "Generate a QR code PNG.", tags: ["qr", "barcode"], discovery: { input: { text: "hi" } } },
  "POST /api/notes": { name: "Notes", slug: "notes", category: "misc", price: "$0.001", description: "Plain text notes. Discusses barcode formats in passing.", tags: [], discovery: { input: { text: "hi" } } },
};
r = findTools(TAG_CATALOG, "barcode", {});
ok(r.results[0]?.slug === "qr", `exact tag match outranks description-only hit (got ${r.results[0]?.slug})`);

// Empty / no-match / k limit / guards.
ok(findTools(CATALOG, "", {}).count === 0, "empty query → no results");
ok(findTools(CATALOG, "   ", {}).count === 0, "whitespace query → no results");
ok(findTools(CATALOG, "zzzzznomatch", {}).count === 0, "no-match query → empty");
r = findTools(CATALOG, "convert hash qr extract", { k: 2 });
ok(r.results.length === 2, `k=2 caps results (got ${r.results.length})`);
ok(findTools(CATALOG, null, {}).count === 0, "null query handled");
// Pathological long input must not throw.
ok(findTools(CATALOG, "x ".repeat(5000) + "extract", {}).results.length >= 0, "long input handled without throwing");

// Serializes cleanly (served as JSON).
JSON.parse(JSON.stringify(findTools(CATALOG, "extract", { baseUrl: "https://agent402.tools", powSlugs: POW })));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
