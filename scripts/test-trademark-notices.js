// Third-party names and marks: every surface that names another party's mark
// in a title says, near it, that the mark is its owner's and that Agent402 is
// independent of it. /terms carries the general clause and the owners'
// notices, the footer links it, and the repository's own legal text says the
// same. Offline: pages are rendered in process.
//
//   node scripts/test-trademark-notices.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const flat = (f) => read(f).replace(/\s+/g, " ");
const text = (html) => String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const GENERAL = "All other product and company names are trademarks of their respective owners.";
const { AWS_MARK_NOTICE, EDGAR_MARK_NOTICE, CLAUDE_MARK_NOTICE } = await import("../src/mark-notices.js");

// /terms: the section, the owners' notices it carries, and the footer link to it.
{
  const { termsPage } = await import("../src/terms.js");
  const html = termsPage("https://agent402.tools");
  const t = text(html);
  ok(/<h2 id="trademarks">Third-party names and marks<\/h2>/.test(html), "/terms has the trademarks section at #trademarks");
  for (const s of ["does not mean that any of them sponsors, endorses or is affiliated with Agent402", "Amazon Bedrock AgentCore are trademarks of Amazon.com, Inc. or its affiliates", "Stellar is a trademark of the Stellar Development Foundation", "Arc is a trademark of Circle Internet Group, Inc. and/or its affiliates", "EDGAR is a registered trademark of the U.S. Securities and Exchange Commission", GENERAL]) ok(t.includes(s), `/terms says: ${s.slice(0, 60)}`);
  const { ledgerFooterCompact } = await import("../src/ledger-chrome.js");
  ok(ledgerFooterCompact().includes('href="/terms#trademarks"'), "the site footer links /terms#trademarks");
}

// The repository's own legal text.
ok(/^## Other marks$/m.test(read("TRADEMARKS.md")) && flat("TRADEMARKS.md").includes(GENERAL), "TRADEMARKS.md has an Other marks section");
ok(flat("README.md").includes(GENERAL), "README.md Legal names other marks as their owners'");
ok(read("wiki/_Footer.md").includes(GENERAL), "the wiki footer carries the line on every page");

// Pages whose owners publish the notice they ask for.
ok(read("wiki/AWS-Bedrock-AgentCore.md").includes(AWS_MARK_NOTICE) && !/snaps into AgentCore|first-class tool source/.test(read("wiki/AWS-Bedrock-AgentCore.md")), "wiki AgentCore page: AWS notice, no embellished relationship");
for (const f of ["wiki/Arc.md", "wiki/Circle-Gateway.md"]) ok(read(f).includes("trademarks of Circle Internet Group, Inc. and/or its affiliates"), `${f}: Circle attribution`);
ok(read("wiki/Stellar.md").includes("is a trademark of the Stellar Development Foundation") && read("wiki/Stellar.md").includes("not affiliated with, sponsored or endorsed by the Stellar Development Foundation"), "wiki/Stellar.md: the SDF sentences");
ok(/^# Using Agent402 with Cloudflare Agents$/m.test(read("docs/cloudflare-agents.md")), "the Cloudflare guide leads with our name in a relational title");
{
  const { agentcorePage } = await import("../src/agentcore-page.js");
  ok(text(agentcorePage("https://x.test", {}, { tempo: false, env: {} })).includes(AWS_MARK_NOTICE), "/integrations/agentcore prints the AWS notice");
  const src = read("src/aws-start-page.js");
  ok(src.includes("${esc(AWS_MARK_NOTICE)}") && !/aw-eyebrow/.test(src), "/aws/start prints the AWS notice and no AWS eyebrow above our title");
  ok(read("src/managed-agents-page.js").includes("${esc(CLAUDE_MARK_NOTICE)}"), "the Claude Managed Agents page prints the Anthropic notice");
}

// Chain pages: our name leads, and the line under the H1 says the network is its owner's.
{
  const { CHAIN_PAGES, marketPage, chainMarkNotice } = await import("../src/market-page.js");
  for (const key of Object.keys(CHAIN_PAGES)) {
    const C = CHAIN_PAGES[key];
    const t = text(marketPage(key, "https://x.test", { snapshot: { sellers: [] }, rail: null, activity: null }));
    ok(t.includes(`Agent402 on ${C.chainName}`) && t.includes(chainMarkNotice(C)) && !t.includes(`${C.chainName} x402 marketplace`), `/${key}: "Agent402 on ${C.chainName}" with its independence line`);
  }
  ok(chainMarkNotice(CHAIN_PAGES.arc).includes("Circle Internet Group") && chainMarkNotice(CHAIN_PAGES.stellar).includes("Stellar Development Foundation"), "Arc and Stellar carry their owners' own sentences");
}

// Integration pages for a third-party framework: our name first, the owner's mark disclaimed.
{
  const { INTEGRATIONS, integrationPage, integrationMarkNotice } = await import("../src/integration-pages.js");
  for (const i of INTEGRATIONS.filter((x) => x.markOwner)) {
    const html = integrationPage("https://x.test", i.slug, {});
    ok(/<title>Agent402 for /.test(html) && text(html).includes(integrationMarkNotice(i)), `/integrations/${i.slug}: "Agent402 for ..." with the owner's mark disclaimed`);
  }
  const strands = INTEGRATIONS.find((x) => x.slug === "strands");
  ok(strands && integrationMarkNotice(strands).includes(AWS_MARK_NOTICE), "the Strands page carries the AWS notice too");
}

// The SEC filing tools' pages and the filing-built report pages name EDGAR as the SEC's mark.
{
  const { toolPage } = await import("../src/pages.js");
  const tool = { slug: "edgar-filings", name: "SEC filings", method: "GET", path: "/api/edgar-filings", route: "GET /api/edgar-filings", category: "data", price: "$0.003", description: "d", tags: [], discovery: { input: {}, inputSchema: { properties: {} } } };
  ok(text(toolPage("https://x.test", tool, [])).includes(EDGAR_MARK_NOTICE), "an edgar-* tool page prints the EDGAR notice");
  ok(read("src/programmatic-pages.js").includes("${EDGAR_MARK_NOTICE}"), "the filing-built report pages' note carries the EDGAR notice");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
