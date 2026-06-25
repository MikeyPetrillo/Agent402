// Machine Ledger — Integrations page
// 8 framework adapters, shared code example, CTA, compact footer.

import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";

const ADAPTERS = [
  { name: "OpenAI",          desc: 'Function-calling tools for chat.completions &mdash; pass <span style="font-family:var(--font-mono);font-size:12px;">tools</span>, call <span style="font-family:var(--font-mono);font-size:12px;">execute</span> on a tool_call.', pkg: "agent402-openai-tools" },
  { name: "Anthropic",       desc: "Messages API tool_use blocks &mdash; native tool objects with auto-payment.", pkg: "agent402-anthropic-tools" },
  { name: "Vercel AI SDK",   desc: 'Drop into <span style="font-family:var(--font-mono);font-size:12px;">streamText</span> / <span style="font-family:var(--font-mono);font-size:12px;">generateText</span>.', pkg: "agent402-ai-sdk" },
  { name: "LangChain JS",    desc: "Tool objects for LangChain &amp; LangGraph agents.", pkg: "agent402-langchain" },
  { name: "LlamaIndex TS",   desc: "Native FunctionTool wrappers for LlamaIndex agents.", pkg: "agent402-llamaindex" },
  { name: "Google ADK",      desc: "Tools for Gemini agents on the Agent Development Kit.", pkg: "agent402-google-adk" },
  { name: "AWS Strands",     desc: "Native tool objects for the Strands agent runtime.", pkg: "agent402-strands" },
  { name: "MCP (any client)", desc: 'Hosted connector or <span style="font-family:var(--font-mono);font-size:12px;">npx agent402-mcp</span> &mdash; Claude, and any MCP client.', pkg: "agent402-mcp" },
];

function adapterRow(a, isLast) {
  return `<div style="display:grid;grid-template-columns:220px 1fr auto;gap:18px;align-items:center;padding:16px 20px;${isLast ? "" : "border-bottom:1px solid var(--hairline);"}"><div style="font-weight:700;font-size:16px;">${a.name}</div><div style="font-size:13.5px;color:var(--muted);">${a.desc}</div><code style="font-family:var(--font-mono);font-size:11.5px;background:var(--ink);color:var(--cream);padding:6px 10px;white-space:nowrap;">${a.pkg}</code></div>`;
}

export function ledgerIntegrationsPage(baseUrl) {
  const canonical = baseUrl + "/integrations";
  const title = "Integrations — Agent402";
  const description = "8 zero-dependency npm adapters that turn the Agent402 catalog into native tool objects for OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, AWS Strands, and MCP.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    url: canonical,
    description,
    isPartOf: { "@type": "WebSite", name: "Agent402", url: baseUrl },
  };

  const extraCss = `
@media (max-width: 900px) {
  .ml-adapter-row { grid-template-columns: 1fr !important; gap: 8px !important; }
}`;

  const body = `
  <!-- HEAD -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:14px;">$ GET /integrations</div>
    <h1 class="ml-h1" style="font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;">8 framework adapters.<br>One surface underneath.</h1>
    <p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:620px;margin:0;">Zero-dependency npm packages that turn the catalog into native tool objects for your stack &mdash; payment handled underneath (proof-of-work for free tools, USDC via x402 for paid).</p>
  </section>

  <!-- ADAPTERS -->
  <section style="max-width:1180px;margin:0 auto;padding:0 30px;">
    <div style="border:1.5px solid var(--ink);background:var(--card);">
      ${ADAPTERS.map((a, i) => adapterRow(a, i === ADAPTERS.length - 1)).join("\n      ")}
    </div>
  </section>

  <!-- EXAMPLE -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">// same shape everywhere</div>
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 22px;">Install, get tools, pass them in.</h2>
    <div style="border:1.5px solid var(--ink);background:var(--ink);"><pre style="margin:0;padding:18px;font-family:var(--font-mono);font-size:13px;line-height:1.85;color:var(--cream);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># pick your stack
</span>npm install agent402-openai-tools

import { agent402Tools } from "agent402-openai-tools";
const { tools, execute } = await agent402Tools({ slugs: ["extract","hash","render"] });
<span style="color:var(--dk-muted3);">// pass tools to openai.chat.completions.create({ tools })
// call execute(name, args) on a tool_call. payment handled underneath.</span></pre></div>
    <div style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:12px;">all 8 adapters share the surface: zero-dep, native tool objects, non-custodial payment underneath.</div>
  </section>

  <!-- CTA -->
  <section style="max-width:1180px;margin:0 auto;padding:56px 30px 64px;">
    <div style="border:1.5px solid var(--ink);background:var(--card);padding:32px 30px;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;">
      <div>
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:28px;line-height:1;letter-spacing:-.02em;margin:0 0 6px;">Wire it into your framework.</h2>
        <p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);margin:0;">zero-dep &middot; non-custodial &middot; proof-of-work or USDC</p>
      </div>
      <div style="display:flex;gap:11px;">
        <a href="/docs" style="background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 20px;">QUICKSTART &rarr;</a>
        <a href="/tools" style="background:transparent;border:1.5px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;">BROWSE TOOLS</a>
      </div>
    </div>
  </section>

  ${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss, body });
}
