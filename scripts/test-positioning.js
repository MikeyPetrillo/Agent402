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
import { LEAD_SENTENCE, CATEGORY_LINE, SUPPORT_LINE, leadSentence, categoryLine } from "../src/positioning.js";
import { receiptsServed } from "../src/receipt-signing.js";
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
// The owner's line, its receipt clause scoped to what is signed
// (src/receipt-signing.js; a /ref/ copy, a plain stream and a failed call are not):
// the payment and trust layer leads, and the catalog's size is the
// supporting line, never the lead.
const APPROVED = "Agent402 is the payment and trust layer for agentic commerce: agents find, pay for and verify paid calls to Agent402, across x402 and MPP, with signed receipts on successful direct calls.";
ok(LEAD_SENTENCE === APPROVED, "the published lead sentence is the approved line, word for word");
// The receipt clause claims only what is signed (src/receipt-signing.js): a
// settled 200 (so not a failed or charged-failed call, a free or trial answer)
// on a direct route (not a /ref/ copy); a stream that cannot carry its receipt
// gets it fetchable at GET /api/receipt/<token>. No "every" over calls.
ok(/\bsigned receipts on successful direct calls\.$/.test(LEAD_SENTENCE) && !/\bevery\b|\beach one\b/.test(LEAD_SENTENCE), "the receipt clause is scoped to successful direct calls");
ok(!/\d/.test(LEAD_SENTENCE.replace(/x402|Agent402/g, "")) && !/tools|catalog/i.test(LEAD_SENTENCE), "the lead sentence carries no catalog size and no tool count");
ok(SUPPORT_LINE === "500+ ready tools on the same rails.", "the catalog is the supporting line, evergreen 500+");
ok(!/—/.test(LEAD_SENTENCE + CATEGORY_LINE + SUPPORT_LINE), "no em dash in the lead, the category line or the supporting line");
ok(leadSentence({ mpp: false }).includes("paid calls to Agent402, across x402, with signed receipts on successful direct calls.") && !/MPP/.test(leadSentence({ mpp: false })), "with MPP off the sentence offers x402 alone");
ok(leadSentence({ receipts: false }) === "Agent402 is the payment and trust layer for agentic commerce: agents find, pay for and verify paid calls to Agent402 across x402 and MPP." && !/every paid call/.test(leadSentence({ receipts: false })), "with no signing key the sentence drops the signed-receipt clause and claims no receipt for every call");
ok(!/signed receipt/.test(leadSentence({ mpp: false, receipts: false })) && /across x402\.$/.test(leadSentence({ mpp: false, receipts: false })), "MPP off and receipts off: x402 alone, no receipt clause");
ok(receiptsServed() === false, "control: this offline process loads no signing key, so the served surfaces below render the key-off line");
ok(/^[A-Z][^.]*\.$/.test(CATEGORY_LINE) && !/Agentic Finance|AIFI/.test(CATEGORY_LINE), "the category line is one plain sentence, not the category acronym");
ok(/\bx402 and MPP\b/.test(CATEGORY_LINE) && categoryLine({ mpp: false }) === "Payments and trust for AI agents, over x402." , "the category line names the wires (x402, and MPP only while it is offered)");

// --- home page: h1 is the category line, the lede is the sentence ----------------
{
  const html = ledgerHomePage("https://agent402.tools", {}, {}, {}, []);
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "";
  ok(pageText(h1).trim() === CATEGORY_LINE, `home h1 is the category line (got "${pageText(h1).trim()}")`);
  const noMpp = ledgerHomePage("https://agent402.tools", {}, {}, {}, [], { mpp: false });
  const h1NoMpp = pageText((noMpp.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "").trim();
  ok(h1NoMpp === categoryLine({ mpp: false }) && !/MPP/.test(h1NoMpp), `with MPP off the home h1 offers x402 alone ("${h1NoMpp}")`);
  const lede = (html.match(/<p class="hm-lede"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "";
  ok(pageText(stripInlineTags(lede)).trim() === leadSentence({ receipts: false }), "home hero lede is the lead sentence, word for word (no signing key: no receipt clause)");
  const signed = ledgerHomePage("https://agent402.tools", {}, {}, {}, [], { receipts: true });
  const signedLede = pageText(stripInlineTags((signed.match(/<p class="hm-lede"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "")).trim();
  ok(signedLede === LEAD_SENTENCE, `with receipts signed the home lede is the full approved line ("${signedLede}")`);
  ok(/every paid call over x402 and MPP, each with a signed receipt/.test((signed.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "") && !/signed receipt/.test((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || ""), "the home meta description names the signed receipt only while receipts are signed");
  const support = pageText(stripInlineTags((html.match(/<p class="hm-support"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || ""));
  ok(support.includes(SUPPORT_LINE.replace(/\.$/, "")) && html.indexOf('class="hm-support"') > html.indexOf('class="hm-lede"'), "the catalog's size is a supporting line under the lede");
  ok(!/\d+\+? (ready )?tools/.test(pageText(h1)) && !/\d+\+? (ready )?tools/.test((html.match(/<title>([^<]*)<\/title>/) || [])[1] || ""), "neither the h1 nor the title leads with a tool count");
  ok((html.match(/<h1\b/g) || []).length === 1, "the home page has one h1");
  // The wires follow the MPP switch the "/" route passes.
  const off = ledgerHomePage("https://agent402.tools", {}, {}, {}, [], { mpp: false });
  const offLede = pageText(stripInlineTags((off.match(/<p class="hm-lede"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "")).trim();
  ok(offLede === leadSentence({ mpp: false, receipts: false }) && !/MPP/.test(offLede), `with MPP off the home lede offers x402 alone ("${offLede}")`);
  ok(/href="\/what-is-x402"/.test((off.match(/<p class="hm-lede"[^>]*>[\s\S]*?<\/p>/) || [""])[0]), "with MPP off the x402 wire name stays linked");
  ok(/ledgerHomePage\([^;]*mpp: mppMethodsSummary\(\)\.enabled \}\)/.test(read("src/server.js")), "the \"/\" route passes the MPP switch to the hero");
  ok(/receipts = receiptsServed\(\) \} = \{\}\) \{/.test(read("src/ledger-home.js")), "the hero's receipt clause defaults to the served switch (receiptsServed)");
}

// --- machine surfaces ----------------------------------------------------------------
{
  const llms = llmsTxt("https://example.test", {});
  const summary = (llms.match(/^> (.*)$/m) || [])[1] || "";
  ok(summary.startsWith(leadSentence({ mpp: mppMethodsSummary().enabled, receipts: receiptsServed() })), "/llms.txt's summary line opens with the lead sentence (wires and receipts from their switches)");
  ok(summary.includes(SUPPORT_LINE), "/llms.txt's summary carries the supporting line");
}
ok(HOSTED_DESC.startsWith(`${LEAD_SENTENCE} ${SUPPORT_LINE}`) && STDIO_DESC.startsWith(`${LEAD_SENTENCE} ${SUPPORT_LINE}`), "MCP serverInfo description (hosted and stdio) opens with the lead sentence, then the supporting line");
for (const [name, fn] of [["hosted", hostedInstructions], ["stdio", stdioInstructions]]) {
  ok(fn("https://example.test").split("\n")[0].startsWith(LEAD_SENTENCE), `MCP initialize instructions (${name}) open with the lead sentence`);
}
// The hosted connector's copies follow the MPP switch; the published (stdio)
// copies keep both wires.
for (const mpp of [true, false]) {
  for (const receipts of [true, false]) {
    const d = mcpServerDescription({ mpp, receipts });
    ok(d.startsWith(leadSentence({ mpp, receipts })) && (mpp ? /x402 and MPP/.test(d) : !/MPP/.test(d)) && /signed receipt/.test(d) === receipts, `hosted serverInfo description with MPP ${mpp ? "on" : "off"}, receipts ${receipts ? "on" : "off"}: ${mpp ? "both wires" : "x402 alone"}, receipt clause ${receipts ? "present" : "absent"}`);
    const first = hostedInstructions("https://example.test", { mppOffered: mpp, receipts }).split("\n")[0];
    ok(first.startsWith(leadSentence({ mpp, receipts })) && (mpp || !/MPP/.test(first)) && /signed receipt/.test(first) === receipts, `hosted initialize instructions with MPP ${mpp ? "on" : "off"}, receipts ${receipts ? "on" : "off"} open with that lead sentence`);
  }
}
ok(mcpServerDescription() === HOSTED_DESC && HOSTED_DESC === STDIO_DESC, "the default description is the published one, identical to the stdio package's");
{
  const src = read("src/mcp-http.js");
  ok(/description: (?:plainText\()?mcpServerDescription\(\{ mpp: payWires \? Boolean\(payWires\.mpp\) : mppMethodsSummary\(\)\.enabled, receipts: receiptsServed\(\), stock: stockQuoteEnabled\(\) \}\)/.test(src), "the hosted connector's description reads the mount's pay wires (the MPP switch without them) and the receipt switch");
  // The initialize lead names MPP from the mount's own pay wires (the boot's
  // account, src/connector-pay.js), and from the MPP switch on a mount given none.
  ok(/mppOffered: payWires \? Boolean\(payWires\.mpp\) : mppMethodsSummary\(\)\.enabled, receipts: receiptsServed\(\) \}/.test(src), "the hosted connector's initialize lead reads the mount's pay wires (the MPP switch without them) and the receipt switch");
  ok(/import \{ leadSentence, SUPPORT_LINE \} from "\.\/positioning\.js";/.test(src) && /positioning: `\$\{leadSentence\(\{ mpp: mppMethodsSummary\(\)\.enabled, receipts: receiptsServed\(\) \}\)\} \$\{SUPPORT_LINE\} /.test(src), "hosted server.describe positioning opens with the lead sentence for the MPP and receipt switches, then the supporting line, read from the module");
  const stdio = read("mcp/index.js");
  const lines = stdio.match(/positioning: `[^`]*`/g) || [];
  ok(lines.length >= 2 && lines.every((l) => l.startsWith(`positioning: \`${LEAD_SENTENCE} ${SUPPORT_LINE} `)), `stdio server.describe positioning (both aliases) opens with the lead sentence and the supporting line (${lines.length} payloads)`);
}

// --- READMEs and package descriptions ------------------------------------------------
for (const p of ["README.md", "mcp/README.md", "client/README.md", "tollbooth/README.md", "openclaw/README.md"]) {
  const top = mdText(read(p).slice(0, 3000));
  ok(top.includes(LEAD_SENTENCE), `${p} carries the lead sentence near the top`);
  ok(!/catalog of 500\+/.test(top) && /500\+ ready tools/.test(top) && top.indexOf("500+ ready tools") > top.indexOf(LEAD_SENTENCE), `${p}: the catalog's size follows the lead sentence as a supporting line`);
}
ok(!/\d/.test(read("README.md").split("\n")[0].replace(/Agent402/g, "")), "the README H1 names no count");
for (const p of ["package.json", "mcp/package.json"]) {
  const d = JSON.parse(read(p)).description || "";
  ok(d.includes(LEAD_SENTENCE) && d.indexOf(LEAD_SENTENCE) < 40, `${p} description leads with the lead sentence`);
}

// The changelog says where the sentence is: the package READMEs in this
// repository; the registry pages change only with a package release.
for (const file of ["CHANGELOG.md", "src/changelog.js"]) {
  const text = read(file).replace(/\s+/g, " ");
  const entry = (text.match(/One lead sentence describes Agent402 on (.*?)\.(?=\s|"|$)/i) || [])[1] || "";
  ok(entry.includes("package READMEs in the repository") && !/package pages/.test(entry), `${file}: the lead-sentence entry names the repository READMEs, not the package pages ("${entry}")`);
  ok(/payment and trust layer for agent(?:ic)? commerce/.test(text), `${file}: an entry records the payment and trust layer lead`);
}
// The registry entry and package descriptions lead with the layer, not the count.
{
  const reg = JSON.parse(read("mcp/server.json")).description;
  ok(/^Payment and trust layer for agentic commerce/.test(reg) && reg.length <= 100 && !/\d+\+? (agent |ready )?tools/.test(reg), `mcp/server.json description leads with the layer, no tool count, 100 characters at most (${reg.length})`);
}

// /company names the product it operates in its title and h1, and the wires in its description.
{
  const { companyPage } = await import("../src/company.js");
  const html = companyPage("https://agent402.tools");
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  const h1 = pageText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "").trim();
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
  ok(/Havok Holdings LLC/.test(title) && /Agent402/.test(title) && /Havok Holdings LLC/.test(h1) && /Agent402/.test(h1), `/company title and h1 name the company and Agent402 ("${title}" / "${h1}")`);
  ok(/payment and trust layer for agentic commerce/.test(desc), "/company description states the layer");
  // The wires follow the MPP switch, as the home h1 does.
  const keep = process.env.MPP_SECRET_KEY;
  const descOf = () => (companyPage("https://agent402.tools").match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
  process.env.MPP_SECRET_KEY = "test-mpp-secret";
  const on = descOf();
  delete process.env.MPP_SECRET_KEY;
  const off = descOf();
  if (keep === undefined) delete process.env.MPP_SECRET_KEY; else process.env.MPP_SECRET_KEY = keep;
  ok(/over x402 and MPP,/.test(on) && /over x402,/.test(off) && !/MPP/.test(off), `/company names MPP only while MPP is offered ("${off.slice(0, 120)}")`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
