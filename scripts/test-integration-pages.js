#!/usr/bin/env node
// /integrations and /integrations/<slug>: what each page tells a developer to
// install and run must work, and its payment copy must read the switch that
// sells credits.
//   - every package a code block imports is in that page's install line (or an
//     "npm install" note in the same block);
//   - with credit sales off, no page offers prepaid credits, and the MCP page's
//     example does not ask for a credits key;
//   - the hub's shape note names the packages that have each shape;
//   - tool cards mark model-backed tools and show prices in one form.
// Offline (credit sales switch read from env, as the server reads it).
delete process.env.CREDITS_SALES;
const { INTEGRATIONS, integrationPage, displayPrice } = await import("../src/integration-pages.js");
const { ledgerIntegrationsPage } = await import("../src/ledger-integrations.js");
const { creditsSalesEnabled } = await import("../src/credits-sales.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const strip = (h) => h.replace(/<\/?(code|a|strong|em|span)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const BUILTIN = /^(node:|fs$|path$|crypto$)/;
const pkgRoot = (s) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);

ok(creditsSalesEnabled() === false, "credit sales are off for this run (CREDITS_SALES unset)");

// A fake catalog row per tool slug a page lists: answer is model-backed, and
// prices come in the two spellings the catalog uses.
const catalog = {};
for (const i of INTEGRATIONS) for (const slug of i.tools || []) catalog[`POST /api/${slug}`] = { slug, name: slug, price: slug === "extract" ? "$0.010" : "$0.01", modelBacked: slug === "answer" };

for (const i of INTEGRATIONS) {
  // --- installs carry what the examples import (JS packages only) ---
  if (!["python", "json", "bash"].includes(i.lang)) {
    for (const [label, block] of [["example", i.example], ["noWalletExample", i.noWalletExample], ["walletExample", i.walletExample]]) {
      if (!block) continue;
      const imports = [...block.matchAll(/from "([^"]+)"/g)].map((m) => pkgRoot(m[1])).filter((p) => !BUILTIN.test(p));
      const notes = [...block.matchAll(/npm install ([^\n]+)/g)].flatMap((m) => m[1].split(/\s+/));
      const have = new Set([...i.install.split(/\s+/), ...notes]);
      const missing = [...new Set(imports)].filter((p) => !have.has(p));
      ok(missing.length === 0, `${i.slug} ${label}: every imported package is installed${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
    }
  }
  // --- credits copy reads the switch ---
  const html = integrationPage("https://agent402.tools", i.slug, catalog, {});
  const text = strip(html);
  ok(!/prepaid credits key|prepaid `?a402_|or prepaid credits|by prepaid credits|buy a credits pack/i.test(text), `${i.slug}: no prepaid-credits offer while credit sales are off`);
  // --- seller pages do not carry the buyer footer ---
  if (i.slug === "tollbooth") ok(text.includes("Your x402 middleware settles a payment only after your handler answers below 400") && !text.includes("settlement runs after the tool"), "tollbooth: the settlement line is the seller's side");
  // --- tool cards ---
  if ((i.tools || []).includes("answer")) ok(/answer\s*model-backed/.test(text), `${i.slug}: the model-backed answer tool is marked model-backed`);
  if ((i.tools || []).includes("extract")) ok(text.includes("$0.01") && !text.includes("$0.010"), `${i.slug}: prices show in one form ($0.010 reads $0.01)`);
}
{
  const mcp = INTEGRATIONS.find((i) => i.slug === "mcp");
  ok(!/AGENT402_CREDITS_KEY/.test(mcp.example) && /"AGENT_KEY"/.test(mcp.example), "mcp: the primary example pays from a wallet key, not a credits key no new user can buy");
  ok(!/prepaid/.test(mcp.meta), "mcp: the meta description offers no prepaid credits");
}
ok(displayPrice("$0.010") === "$0.01" && displayPrice("$0.004") === "$0.004" && displayPrice("$0.08") === "$0.08" && displayPrice("$3") === "$3.00" && displayPrice("metered") === "metered", "displayPrice keeps value, trims to the shortest two-plus-decimal form");

// --- the hub ---
const hub = strip(ledgerIntegrationsPage("https://agent402.tools"));
ok(!/prepaid credits key/.test(hub) && hub.includes("a credits key bought earlier"), "hub lede: credits named as a key bought earlier while sales are off");
ok(!/zero-dep/.test(hub), "hub: no zero-dependency claim (most packages have dependencies)");
ok(!/\w\.\.(?!\.)/.test(hub), "hub: no doubled periods");
ok(/The per-slug adapters \(OpenAI, Anthropic, LlamaIndex and Strands\) share this shape\./.test(hub) && /AgentKit, elizaOS, MCP, agent402-client, Tollbooth and OpenClaw have their own shapes/.test(hub),
  "hub: the shape note names the packages that have each shape");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
