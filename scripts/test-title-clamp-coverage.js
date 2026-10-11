// Per-item page titles (/tools/:slug, /skills/:slug, /docs/:slug,
// /guides/:slug) are always whole. Tool names run from 3 chars ("hex") to 50+
// ("EDGAR XBRL company-concept (one tag, full history)"); a 2-line
// -webkit-line-clamp once bounded the H1's height by cutting the longest names
// off with an ellipsis, which hid the page's own title. The H1 now wraps with
// `text-wrap: balance` (two even lines, never a clipped one), and
// scripts/test-wrap-quality.js measures that the result does not rag.
//
// This guards the template: no clamp or ellipsis on the H1, the balanced wrap
// present, and the full name still in the H1's title attribute where the
// template sets one.
//
// Requires a booted server (same TARGET_URL convention as the other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-title-clamp-coverage.js
const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// The H1's own style: an inline style on the tag, or the page's CSS rule for it.
const unclipped = (html, label) => {
  ok(!/-webkit-line-clamp/.test(html), `${label}: no line clamp on the page`);
  ok(/text-wrap:\s*balance/.test(html), `${label}: H1 wraps balanced`);
};
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
async function checkTitle(pathPrefix, slug, escapedName) {
  const html = await (await fetch(`${BASE}${pathPrefix}${slug}`)).text();
  unclipped(html, `${pathPrefix}${slug}`);
  ok(html.includes(`title="${escapedName}"`), `${pathPrefix}${slug}: full name in the H1's title attribute`);
}

// --- /tools/:slug ------------------------------------------------------------
{
  const KNOWN_LONG_SLUG = "edgar-company-concept";
  const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
  const endpoints = pricing.endpoints || [];
  ok(endpoints.length > 400, `catalog has a substantial tool set to check against (got ${endpoints.length})`);
  const longest = endpoints.reduce((a, b) => ((a.name || "").length >= (b.name || "").length ? a : b));
  ok(longest.name.length >= 40, `found a genuinely long tool name (got "${longest.name}", ${longest.name.length} chars)`);
  for (const slug of [longest.slug, KNOWN_LONG_SLUG, "hex", "hash"]) {
    const tool = endpoints.find((e) => e.slug === slug);
    if (tool) await checkTitle("/tools/", slug, escapeHtml(tool.name));
  }
}

// --- /skills/:slug -------------------------------------------------------------
{
  const skillsJson = await (await fetch(`${BASE}/api/skill-packs.json`)).json();
  const packs = skillsJson.packs || [];
  ok(packs.length > 50, `skill-pack set has a substantial catalog to check against (got ${packs.length})`);
  const longest = packs.reduce((a, b) => ((a.title || "").length >= (b.title || "").length ? a : b));
  for (const slug of [longest.slug, "ssl-audit"]) {
    const pack = packs.find((p) => p.slug === slug);
    if (pack) await checkTitle("/skills/", slug, escapeHtml(pack.title));
  }
}

// --- /docs/:slug (wiki pages; the H1 comes from markdown, no title attribute) --
{
  const slugs = ["API-Reference", "AWS-Bedrock-AgentCore", "Architecture", "Code-Execution", "MCP-Connector", "Skill-Packs", "x402-Index-and-Router"];
  let found = 0;
  for (const slug of slugs) {
    const res = await fetch(`${BASE}/docs/${slug}`);
    if (res.status !== 200) continue;
    found++;
    unclipped(await res.text(), `/docs/${slug}`);
  }
  ok(found >= 5, `enough real doc slugs resolved to make this check non-vacuous (got ${found}/${slugs.length})`);
}

// --- /guides/:slug -------------------------------------------------------------
{
  const slugs = ["x402-in-5-minutes", "durable-memory-for-agents", "sell-your-api-over-x402", "create-agent-wallet", "smart-order-router"];
  let found = 0;
  for (const slug of slugs) {
    const res = await fetch(`${BASE}/guides/${slug}`);
    if (res.status !== 200) continue;
    found++;
    const html = await res.text();
    unclipped(html, `/guides/${slug}`);
    ok(/<h1 title="([^"]*)">/.test(html), `/guides/${slug}: full title in the H1's title attribute`);
  }
  ok(found >= 3, `enough real guide slugs resolved to make this check non-vacuous (got ${found}/${slugs.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
