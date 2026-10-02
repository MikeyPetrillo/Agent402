// Machine Ledger — Integrations page
// Every published package (one row per /integrations/<slug> page), shared code example, CTA, compact footer.

import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { INTEGRATIONS } from "./integration-pages.js";

// Rows are derived from the per-package pages, so the hub lists exactly the
// packages that have an /integrations/<slug> page.
const ADAPTERS = INTEGRATIONS.map((i) => ({ name: i.name, desc: i.what.split(". ")[0].replace(/`([^`]+)`/g, '<span style="font-family:var(--font-mono);font-size:12px;">$1</span>') + ".", pkg: i.pkg, slug: i.slug, registry: i.registry }));

function adapterRow(a, isLast) {
  return `<div class="ml-adapter-row" style="display:grid;grid-template-columns:220px 1fr auto;gap:18px;align-items:center;padding:16px 20px;${isLast ? "" : "border-bottom:1px solid var(--hairline);"}"><div style="font-weight:700;font-size:16px;"><a href="/integrations/${a.slug}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">${a.name}</a></div><div style="font-size:13.5px;color:var(--muted);">${a.desc}</div><code style="font-family:var(--font-mono);font-size:11.5px;background:var(--surface);color:var(--on-dark);padding:6px 10px;white-space:nowrap;">${a.pkg}</code></div>`;
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
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:14px;">$ GET /integrations</div>
    <h1 class="ml-h1" style="font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;">Framework adapters.<br>One surface underneath.</h1>
    <p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:620px;margin:0;">Packages that turn the catalog into native tool objects for your stack, with payment handled underneath: proof-of-work for free tools, x402 or MPP for paid ones, or a prepaid credits key. Each package has its own page with the install line, a working example and how it pays. New to the protocols? Start with <a href="/learn" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">the explainers</a>.</p>
  </section>

  <!-- ADAPTERS -->
  <section style="max-width:1180px;margin:0 auto;padding:0 30px;">
    <div style="border:1px solid var(--hairline);background:var(--card);">
      ${ADAPTERS.map((a, i) => adapterRow(a, i === ADAPTERS.length - 1)).join("\n      ")}
    </div>
  </section>

  <!-- EXAMPLE -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">// same shape everywhere</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 22px;">Install, get tools, pass them in.</h2>
    <div style="border:1px solid var(--hairline);background:var(--surface);"><pre style="margin:0;padding:18px;font-family:var(--font-mono);font-size:13px;line-height:1.85;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># pick your stack
</span>npm install agent402-openai-tools

import { agent402Tools } from "agent402-openai-tools";
const { tools, execute } = await agent402Tools({ slugs: ["hash","markdown-to-html","text-stats"] });
<span style="color:var(--dk-muted3);">// pass tools to openai.chat.completions.create({ tools })
// call execute(name, args) on a tool_call. proof-of-work pays these underneath;
// wallet-only tools need freeOnly: false plus a paying fetch.</span></pre></div>
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:12px;">the per-slug adapters (OpenAI, Anthropic, LlamaIndex, Strands) share this shape; the others expose four meta tools. See each package's page.</div>
  </section>

  <!-- CTA -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 64px;">
    <div style="border:1px solid var(--hairline);background:var(--card);padding:32px 30px;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;">
      <div>
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:28px;line-height:1;letter-spacing:-.02em;margin:0 0 6px;">Wire it into your framework.</h2>
        <p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);margin:0;">zero-dep &middot; non-custodial &middot; proof-of-work or USDC</p>
      </div>
      <div style="display:flex;gap:11px;">
        <a href="/docs" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 20px;">QUICKSTART &rarr;</a>
        <a href="/tools" style="background:transparent;border:1px solid var(--hairline);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;">Browse tools</a>
      </div>
    </div>
  </section>

  ${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss, body });
}
