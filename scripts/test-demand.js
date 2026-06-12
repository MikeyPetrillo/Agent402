// Unit tests for the demand-kit pure transforms (no network).
import * as XLSX from "xlsx";
import { textToMarkdown, workbookToJson } from "../src/tools/demand-kit.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

// --- textToMarkdown -------------------------------------------------------
const md = textToMarkdown(
  "INTRODUCTION\n\nThis is the first paragraph of the document,\nwrapped across lines.\n\n2.1 Methods\nWe did things.\n\n• first bullet\n• second bullet\n\na lowercase line that ends with punctuation."
);
if (!md.includes("## INTRODUCTION")) fail(`caps heading missed:\n${md}`);
if (!md.includes("## 2.1 Methods")) fail(`numbered heading missed:\n${md}`);
if (!md.includes("This is the first paragraph of the document, wrapped across lines.")) fail(`paragraph join broken:\n${md}`);
if (!md.includes("- first bullet") || !md.includes("- second bullet")) fail(`bullets missed:\n${md}`);
console.log("textToMarkdown ✓ (headings, numbered sections, paragraphs, bullets)");

// --- workbookToJson -------------------------------------------------------
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["name", "qty"], ["widget", 4], ["gadget", 7]]), "Inventory");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["k", "v"], ["a", 1]]), "Other");
const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

const all = workbookToJson(buf);
if (JSON.stringify(all.sheetNames) !== JSON.stringify(["Inventory", "Other"])) fail("sheet names wrong");
if (all.sheets[0].rows !== 2 || all.sheets[0].data[1].qty !== 7) fail(`xlsx rows wrong: ${JSON.stringify(all.sheets[0])}`);
const one = workbookToJson(buf, { sheet: "Other" });
if (one.sheets.length !== 1 || one.sheets[0].data[0].k !== "a") fail("single-sheet select wrong");
let threw = false;
try { workbookToJson(buf, { sheet: "Nope" }); } catch { threw = true; }
if (!threw) fail("missing sheet should throw");
try { workbookToJson(Buffer.from("not a workbook at all")); } catch { /* csv fallback may parse; accept either */ }
console.log("workbookToJson ✓ (multi-sheet, select, missing-sheet rejected)");

console.log("\ndemand-kit: all assertions passed");
process.exit(0);
