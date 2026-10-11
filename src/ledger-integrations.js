// Machine Ledger — Integrations page
// Every published package (one row per /integrations/<slug> page), shared code example, CTA, compact footer.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { INTEGRATIONS, NO_WALLET_NOTE, CREDITS_HELD } from "./integration-pages.js";

// Rows are derived from the per-package pages, so the hub lists exactly the
// packages that have an /integrations/<slug> page.
const ADAPTERS = INTEGRATIONS.map((i) => ({ name: i.name, desc: i.what.split(". ")[0].replace(/\.$/, "").replace(/`([^`]+)`/g, '<span style="font-family:var(--font-mono);font-size:var(--fs-xs);">$1</span>') + ".", pkg: i.pkg, slug: i.slug, registry: i.registry }));

// Which packages share which shape, read from each page's own `exposes` list
// (PER_SLUG_EXPOSES / META_EXPOSES in integration-pages.js), so the note names
// exactly the packages that have the shape it describes.
const shapeOf = (i) => (i.exposes.some((e) => e.startsWith("One native tool per catalog slug")) ? "perSlug" : i.exposes.filter((e) => /^`agent402_(find|route|call|about)`/.test(e)).length === 4 ? "meta" : "other");
const namesOf = (shape) => INTEGRATIONS.filter((i) => shapeOf(i) === shape).map((i) => i.short);
const listJoin = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const SHAPE_NOTE = `The per-slug adapters (${listJoin(namesOf("perSlug"))}) share this shape. ${listJoin(namesOf("meta"))} expose four meta tools: find, route, call and about. ${listJoin(namesOf("other"))} have their own shapes. See each package's page.`;

function adapterRow(a, isLast) {
  return `<div class="ml-adapter-row" style="display:grid;grid-template-columns:220px 1fr auto;gap:18px;align-items:center;padding:16px 20px;${isLast ? "" : "border-bottom:1px solid var(--hairline);"}"><div style="font-weight:700;font-size:var(--fs-lg);"><a href="/integrations/${a.slug}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">${a.name}</a></div><div style="font-size:var(--fs-md);color:var(--muted);">${a.desc}</div><code style="font-family:var(--font-mono);font-size:var(--fs-xs);background:var(--panel);color:var(--on-panel);padding:6px 10px;white-space:nowrap;">${a.pkg}</code></div>`;
}

export function ledgerIntegrationsPage(baseUrl) {
  const canonical = baseUrl + "/integrations";
  const title = "Integrations - Agent402";
  const description = "Packages that turn the Agent402 catalog into native tools for OpenAI, Anthropic, the Vercel AI SDK, LangChain, LlamaIndex, Google ADK, the OpenAI Agents SDK, Strands, AgentKit, elizaOS and MCP, plus the buyer SDK, the tollbooth and the OpenClaw provider.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    url: canonical,
    description,
    isPartOf: { "@type": "WebSite", name: "Agent402.Tools", url: baseUrl },
  };

  const extraCss = `
@media (max-width: 900px) {
  .ml-adapter-row { grid-template-columns: 1fr !important; gap: 8px !important; }
  .ml-adapter-row code { white-space: normal !important; overflow-wrap: anywhere; justify-self: start; }
}`;

  const body = `
  <!-- HEAD -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 30px;">
    <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:14px;">$ GET /integrations</div>
    <h1 class="ml-h1" style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px;">Framework adapters.<br>One surface underneath.</h1>
    <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:76ch;margin:0;">Packages that turn the catalog into native tool objects for your stack, with payment handled underneath: proof-of-work for free tools, x402 or MPP for paid ones, or ${CREDITS_HELD}. Each package has its own page with the install line, a working example and how it pays. New to the protocols? Start with <a href="/learn" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">the explainers</a>.</p>
  </section>

  <!-- ADAPTERS -->
  <section style="max-width:1180px;margin:0 auto;padding:0 30px;">
    <div style="border:1px solid var(--hairline);background:var(--card);">
      ${ADAPTERS.map((a, i) => adapterRow(a, i === ADAPTERS.length - 1)).join("\n      ")}
    </div>
  </section>

  <!-- EXAMPLE -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:12px;">// same shape everywhere</div>
    <h2 style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-3xl);line-height:1;letter-spacing:-.02em;margin:0 0 22px;">Install, get tools, pass them in.</h2>
    <div style="border:1px solid var(--hairline);background:var(--panel);"><pre style="margin:0;padding:18px;font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.85;color:var(--on-panel);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--on-panel-faint);"># pick your stack
</span>npm install agent402-openai-tools @x402/fetch @x402/core @x402/evm viem

import { agent402Tools } from "agent402-openai-tools";
<span style="color:var(--on-panel-faint);">// web search, then a cited answer, paid per call from a wallet (payFetch: an @x402/fetch fetch)
</span>const { tools, execute } = await agent402Tools({ slugs: ["search","answer"], freeOnly: false, fetch: payFetch });
<span style="color:var(--on-panel-faint);">// pass tools to openai.chat.completions.create({ tools })
// call execute(name, args) on each tool_call; the wallet pays underneath.</span></pre></div>
    <p style="font-size:var(--fs-md);line-height:1.6;color:var(--muted);margin:14px 0 10px;"><strong style="color:var(--ink);">No wallet yet?</strong> ${NO_WALLET_NOTE}</p>
    <div style="border:1px solid var(--hairline);background:var(--panel);"><pre style="margin:0;padding:18px;font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.85;color:var(--on-panel);white-space:pre-wrap;word-break:break-word;">const { tools, execute } = await agent402Tools({ slugs: ["hash","markdown-to-html","text-stats"] });
<span style="color:var(--on-panel-faint);">// no fetch: proof-of-work pays these underneath</span></pre></div>
    <p style="font-size:var(--fs-sm);line-height:1.6;color:var(--faint);margin:12px 0 0;max-width:76ch;">${esc(SHAPE_NOTE)}</p>
  </section>

  <!-- CTA -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 64px;">
    <div style="border:1px solid var(--hairline);background:var(--card);padding:32px 30px;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;">
      <div>
        <h2 style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);line-height:1;letter-spacing:-.02em;margin:0 0 6px;">Wire it into your framework.</h2>
        <p class="ml-meta" style="color:var(--muted);margin:0;"><span>open source (MIT)</span><span>non-custodial</span><span>proof-of-work or USDC</span></p>
      </div>
      <div style="display:flex;gap:11px;">
        <a class="btn btn-secondary" href="/docs">Quickstart &rarr;</a>
        <a class="btn btn-secondary" href="/tools">Browse tools</a>
      </div>
    </div>
  </section>

  ${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss, body });
}
