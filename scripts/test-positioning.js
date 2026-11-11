// The lead sentence and the category line (src/positioning.js) on every
// first-contact surface. Surfaces that render in this repo read the sentence
// from the module; the ones that cannot import it (the README, the stdio MCP
// package, the package READMEs and descriptions) carry it verbatim. A surface
// that rewords it, or drops it, fails here.
//
// Offline: reads the repo and calls the pure renderers; no server, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LEAD_SENTENCE, CATEGORY_LINE, leadSentence } from "../src/positioning.js";
import { ledgerHomePage } from "../src/ledger-home.js";
import { llmsTxt } from "../src/seo.js";
import { mppMethodsSummary } from "../src/mpp-offers.js";
import { MCP_SERVER_DESCRIPTION as HOSTED_DESC, mcpInitializeInstructions as hostedInstructions, mcpServerDescription } from "../src/mcp-flagship.js";
import { MCP_SERVER_DESCRIPTION as STDIO_DESC, mcpInitializeInstructions as stdioInstructions } from "../mcp/output-schemas.js";
import { pageText, stripInlineTags } from "./lib/html-text.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const read = (p) => readFileSync(join(ROOT, p), "utf8");
// Markdown as a reader sees it: links by their text, no emphasis marks, one space.
const mdText = (s) => String(s).replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1").replace(/\*\*/g, "").replace(/\s+/g, " ");

// --- the sentence itself ---------------------------------------------------------
ok(/^Agent402 is /.test(LEAD_SENTENCE) && LEAD_SENTENCE.includes("500+ tools") && /x402 or MPP/.test(LEAD_SENTENCE), "the lead sentence names the product, the evergreen 500+ count and both wires");
ok(LEAD_SENTENCE.length <= 160 && !/—/.test(LEAD_SENTENCE + CATEGORY_LINE), `the lead sentence is one short sentence (${LEAD_SENTENCE.length} chars) with no em dash`);
ok(leadSentence({ mpp: false }).includes("over x402,") && !/MPP/.test(leadSentence({ mpp: false })), "with MPP off the sentence offers x402 alone");
ok(/^[A-Z][^.]*\.$/.test(CATEGORY_LINE) && !/Agentic Finance|AIFI/.test(CATEGORY_LINE), "the category line is one plain sentence, not the category acronym");

// --- home page: h1 is the category line, the lede is the sentence ----------------
{
  const html = ledgerHomePage("https://agent402.tools", {}, {}, {}, []);
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "";
  ok(pageText(h1).trim() === CATEGORY_LINE, `home h1 is the category line (got "${pageText(h1).trim()}")`);
  const lede = (html.match(/<p class="hm-lede"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "";
  ok(pageText(stripInlineTags(lede)).trim() === LEAD_SENTENCE, "home hero lede is the lead sentence, word for word");
  ok((html.match(/<h1\b/g) || []).length === 1, "the home page has one h1");
  // The wires follow the MPP switch the "/" route passes.
  const off = ledgerHomePage("https://agent402.tools", {}, {}, {}, [], { mpp: false });
  const offLede = pageText(stripInlineTags((off.match(/<p class="hm-lede"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "")).trim();
  ok(offLede === leadSentence({ mpp: false }) && !/MPP/.test(offLede), `with MPP off the home lede offers x402 alone ("${offLede}")`);
  ok(/href="\/what-is-x402"/.test((off.match(/<p class="hm-lede"[^>]*>[\s\S]*?<\/p>/) || [""])[0]), "with MPP off the x402 wire name stays linked");
  ok(/ledgerHomePage\([^;]*mpp: mppMethodsSummary\(\)\.enabled \}\)/.test(read("src/server.js")), "the \"/\" route passes the MPP switch to the hero");
}

// --- machine surfaces ----------------------------------------------------------------
{
  const llms = llmsTxt("https://example.test", {});
  const summary = (llms.match(/^> (.*)$/m) || [])[1] || "";
  ok(summary.startsWith(leadSentence({ mpp: mppMethodsSummary().enabled })), "/llms.txt's summary line opens with the lead sentence (wires from the MPP switch)");
}
ok(HOSTED_DESC.startsWith(LEAD_SENTENCE) && STDIO_DESC.startsWith(LEAD_SENTENCE), "MCP serverInfo description (hosted and stdio) opens with the lead sentence");
for (const [name, fn] of [["hosted", hostedInstructions], ["stdio", stdioInstructions]]) {
  ok(fn("https://example.test").split("\n")[0].startsWith(LEAD_SENTENCE), `MCP initialize instructions (${name}) open with the lead sentence`);
}
// The hosted connector's copies follow the MPP switch; the published (stdio)
// copies keep both wires.
for (const mpp of [true, false]) {
  const d = mcpServerDescription({ mpp });
  ok(d.startsWith(leadSentence({ mpp })) && (mpp ? /x402 or MPP/.test(d) : !/MPP/.test(d)), `hosted serverInfo description with MPP ${mpp ? "on" : "off"} names ${mpp ? "both wires" : "x402 alone"}`);
  const first = hostedInstructions("https://example.test", { mppOffered: mpp }).split("\n")[0];
  ok(first.startsWith(leadSentence({ mpp })) && (mpp || !/MPP/.test(first)), `hosted initialize instructions with MPP ${mpp ? "on" : "off"} open with that lead sentence`);
}
ok(mcpServerDescription() === HOSTED_DESC && HOSTED_DESC === STDIO_DESC, "the default description is the published one, identical to the stdio package's");
{
  const src = read("src/mcp-http.js");
  ok(/description: mcpServerDescription\(\{ mpp: mppMethodsSummary\(\)\.enabled \}\)/.test(src) && /mppOffered: mppMethodsSummary\(\)\.enabled/.test(src), "the hosted connector passes the MPP switch to its description and instructions");
  ok(/import \{ leadSentence \} from "\.\/positioning\.js";/.test(src) && /positioning: `\$\{leadSentence\(\{ mpp: mppMethodsSummary\(\)\.enabled \}\)\} /.test(src), "hosted server.describe positioning opens with the lead sentence for the MPP switch, read from the module");
  const stdio = read("mcp/index.js");
  const lines = stdio.match(/positioning: `[^`]*`/g) || [];
  ok(lines.length >= 2 && lines.every((l) => l.startsWith(`positioning: \`${LEAD_SENTENCE} `)), `stdio server.describe positioning (both aliases) opens with the lead sentence (${lines.length} payloads)`);
}

// --- READMEs and package descriptions ------------------------------------------------
for (const p of ["README.md", "mcp/README.md", "client/README.md", "tollbooth/README.md", "openclaw/README.md"]) {
  ok(mdText(read(p).slice(0, 3000)).includes(LEAD_SENTENCE), `${p} carries the lead sentence near the top`);
}
for (const p of ["package.json", "mcp/package.json"]) {
  const d = JSON.parse(read(p)).description || "";
  ok(d.includes(LEAD_SENTENCE) && d.indexOf(LEAD_SENTENCE) < 40, `${p} description leads with the lead sentence`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
