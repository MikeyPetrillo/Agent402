// Unit tests for the demand-kit pure transforms (no network).
import { textToMarkdown } from "../src/tools/demand-kit.js";

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


console.log("\ndemand-kit: all assertions passed");
process.exit(0);
