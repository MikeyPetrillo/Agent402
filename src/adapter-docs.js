import { repoUrl } from "./repo-link.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { INTEGRATIONS, NO_WALLET_NOTE } from "./integration-pages.js";

// The option tables are the adapters' own parameter lists, by shape:
// per-slug adapters destructure { baseUrl, slugs, freeOnly, fetch } and return
// { tools, execute, client }; meta-tool adapters destructure
// { baseUrl, fetch, fetchImpl } and return the four meta tools. The install
// line and every code sample come from the matching /integrations entry
// (src/integration-pages.js), so the two pages cannot drift apart, and
// scripts/test-doc-snippets.js checks both against the adapters' exports.
const PER_SLUG_CONFIG = [
  { option: "slugs", type: "string[]", desc: "Load only these tools (a short list gives the model better tool selection).", example: `agent402Tools({ slugs: ["hash", "markdown-to-html"] })` },
  { option: "freeOnly", type: "boolean", desc: "Default true: keep only compute-payable tools, paid with proof-of-work. Set false to include wallet-only tools.", example: `agent402Tools({ slugs: ["extract", "hash"], freeOnly: false, fetch: payFetch })` },
  { option: "fetch", type: "typeof fetch", desc: "A payment-wrapped fetch (@x402/fetch for x402, mppx for MPP) that pays wallet-only tools.", example: `agent402Tools({ freeOnly: false, fetch: payFetch })` },
  { option: "baseUrl", type: "string", desc: "Point to a self-hosted Agent402 instance.", example: `agent402Tools({ baseUrl: "https://my-agent402.example.com" })` },
];
const META_CONFIG = [
  { option: "fetch", type: "typeof fetch", desc: "A payment-wrapped fetch (@x402/fetch for x402, mppx for MPP) that agent402_call uses for wallet-only tools.", example: `agent402Tools({ fetch: payFetch })` },
  { option: "fetchImpl", type: "typeof fetch", desc: "The plain fetch used for the unpaid lookups (find, route, about) and proof-of-work calls. Defaults to the global fetch.", example: `agent402Tools({ fetchImpl: globalThis.fetch })` },
  { option: "baseUrl", type: "string", desc: "Point to a self-hosted Agent402 instance.", example: `agent402Tools({ baseUrl: "https://my-agent402.example.com" })` },
];

const BASE = [
  { slug: "openai", name: "OpenAI", tagline: "OpenAI function calling integration", shape: "per-slug",
    desc: "Tool definitions for OpenAI chat.completions, Assistants v2, and the Responses API: native function objects with JSON Schema parameters, plus an execute helper that runs and pays for a tool call.",
    worksWith: ["OpenAI chat.completions", "OpenAI Assistants v2", "OpenAI Responses API"] },
  { slug: "anthropic", name: "Anthropic", tagline: "Anthropic tool use integration", shape: "per-slug",
    desc: "Tool definitions for the Anthropic Messages API (input_schema format), plus an execute helper that runs and pays for a tool_use block.",
    worksWith: ["Anthropic Messages API", "Any Claude model with tool use"] },
  { slug: "ai-sdk", name: "Vercel AI SDK", tagline: "Vercel AI SDK integration", shape: "meta",
    desc: "Four meta tools (find, route, call, about) as AI SDK tool objects, keyed by name for generateText and streamText on any provider the SDK supports.",
    worksWith: ["generateText", "streamText", "Any AI SDK provider"] },
  { slug: "langchain", name: "LangChain", tagline: "LangChain tool integration", shape: "meta",
    desc: "Four meta tools (find, route, call, about) as LangChain.js tool objects for LangChain agents and LangGraph nodes.",
    worksWith: ["LangChain JS", "LangGraph", "createReactAgent", "Any LangChain chat model with tool calling"] },
  { slug: "llamaindex", name: "LlamaIndex", tagline: "LlamaIndex tool integration", shape: "per-slug",
    desc: "FunctionTool instances for LlamaIndex TS agents and workflows, built from the catalog's JSON Schema.",
    worksWith: ["LlamaIndex TS", "@llamaindex/workflow agent()", "FunctionTool"] },
  { slug: "google-adk", name: "Google ADK", tagline: "Google Agent Development Kit integration", shape: "meta",
    desc: "Four meta tools (find, route, call, about) as FunctionTool instances for Gemini agents on Google's Agent Development Kit.",
    worksWith: ["Google Agent Development Kit", "LlmAgent", "Gemini models"] },
  { slug: "openai-agents", name: "OpenAI Agents SDK", tagline: "OpenAI Agents SDK integration", shape: "meta",
    desc: "Four meta tools (find, route, call, about) for the OpenAI Agents SDK (@openai/agents), built from the adapter's framework-agnostic specs. The SDK's run loop executes them.",
    worksWith: ["@openai/agents", "Agent", "run()"] },
  { slug: "strands", name: "Strands Agents", tagline: "Strands Agents integration", shape: "per-slug",
    desc: "Strands tool instances for TypeScript agents, including Strands agents on AWS Bedrock AgentCore.",
    worksWith: ["@strands-agents/sdk", "AWS Bedrock AgentCore", "Any Strands-compatible model"] },
];

export const ADAPTERS = BASE.map((a) => {
  const i = INTEGRATIONS.find((x) => x.docsSlug === a.slug);
  if (!i) throw new Error(`adapter-docs: no /integrations entry for ${a.slug}`);
  return {
    ...a,
    pkg: i.pkg,
    install: i.install,
    quickstart: i.example,
    walletExample: i.walletExample || null,
    noWalletExample: i.noWalletExample || null,
    config: a.shape === "per-slug" ? PER_SLUG_CONFIG : META_CONFIG,
    github: repoUrl(`tree/main/${i.dir}`),
  };
});

/* ── index page ──────────────────────────────────────────────────────── */

export function adapterDocsIndex(baseUrl) {
  const canonical = `${baseUrl}/docs/adapters`;
  const title = "Framework Adapters - Agent402 Docs";
  const description = "Adapter documentation for every supported agent framework: OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, OpenAI Agents SDK, and Strands Agents.";

  const cards = ADAPTERS.map((a) => `
    <a class="ml-ad-card" href="/docs/adapters/${esc(a.slug)}">
      <h3 style="margin:0 0 6px;font-size:1.1rem;font-weight:700;color:var(--ink);">${esc(a.name)}</h3>
      <code style="display:inline-block;font-family:var(--font-mono);font-size:.8rem;color:var(--accent);margin-bottom:8px;">${esc(a.pkg)}</code>
      <p style="margin:0 0 10px;color:var(--muted);font-size:.9rem;line-height:1.5;">${esc(a.tagline)}</p>
      <span style="color:var(--accent);font-size:.88rem;font-weight:600;">View docs &rarr;</span>
    </a>`).join("\n");

  const extraCss = `
  .ml-ad-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1.25rem;margin-bottom:3rem}
  @media(max-width:680px){.ml-ad-grid{grid-template-columns:1fr}}
  .ml-ad-card{background:var(--card);border:1px solid var(--hairline);padding:1.5rem 1.6rem;text-decoration:none;color:var(--ink);transition:border-color .15s;display:block}
  .ml-ad-card:hover{border-color:var(--accent)}`;

  const body = `
  <div style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;">
    <p style="font-size:.85rem;color:var(--faint);margin:0 0 20px;"><a href="/" style="color:var(--faint);text-decoration:none;">Home</a> &rsaquo; <a href="/docs" style="color:var(--faint);text-decoration:none;">Docs</a> &rsaquo; Adapters</p>
    <h1 style="font-family:var(--font-body);font-weight:800;font-size:52px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;">Framework Adapters.</h1>
    <p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:620px;margin:0 0 36px;">Plug Agent402 into your agent framework. Each adapter returns native tool objects and handles payment underneath.</p>

    <div class="ml-ad-grid">
${cards}
    </div>

    <div style="text-align:center;margin:2rem 0 0;"><a href="/integrations" style="color:var(--accent);font-weight:600;text-decoration:none;font-size:1rem;">See all integrations (MCP, SDKs, and more) &rarr;</a></div>
  </div>
  ${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/docs",
    extraCss,
    body,
  });
}

/* ── individual adapter page ─────────────────────────────────────────── */

export function adapterDocPage(baseUrl, slug) {
  const adapter = ADAPTERS.find((a) => a.slug === slug);
  if (!adapter) return null;

  const canonical = `${baseUrl}/docs/adapters/${adapter.slug}`;
  const title = `${adapter.name} Adapter - Agent402 Docs`;
  const description = `${adapter.desc} Install ${adapter.pkg} and start using Agent402 tools in your ${adapter.name} project.`;

  const tocItems = [
    { id: "install", label: "install" },
    { id: "quickstart", label: "quick start" },
  ];
  if (adapter.noWalletExample) tocItems.push({ id: "no-wallet", label: "no wallet yet?" });
  if (adapter.walletExample) tocItems.push({ id: "paid", label: "paid tools" });
  if (adapter.config && adapter.config.length) tocItems.push({ id: "config", label: "configuration" });
  if (adapter.worksWith && adapter.worksWith.length) tocItems.push({ id: "compat", label: "works with" });

  const tocLinks = tocItems.map((t) =>
    `<a href="#${t.id}" style="color:var(--muted);text-decoration:none;">${t.label}</a>`
  ).join("\n        ");

  const configRows = (adapter.config || []).map((c) => `
        <tr>
          <td style="font-family:var(--font-mono);color:var(--accent);font-size:.84rem;"><code>${esc(c.option)}</code></td>
          <td style="font-family:var(--font-mono);color:var(--faint);font-size:.82rem;"><code>${esc(c.type)}</code></td>
          <td style="color:var(--ink);font-size:.88rem;">${esc(c.desc)}</td>
        </tr>`).join("\n");

  const configExamples = (adapter.config || []).map((c) => `// ${esc(c.desc)}\n${esc(c.example)}`).join("\n\n");

  const worksWithTags = (adapter.worksWith || []).map((w) =>
    `<span style="background:var(--card);border:1px solid var(--hairline);color:var(--muted);font-size:.82rem;padding:4px 12px;font-family:var(--font-mono);">${esc(w)}</span>`
  ).join("\n        ");

  const extraCss = `
  @media (max-width: 900px) {
    .ml-adp-grid { grid-template-columns: 1fr !important; }
    .ml-adp-toc  { position: static !important; }
  }`;

  const body = `
  <div class="ml-adp-grid" style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;display:grid;grid-template-columns:200px 1fr;gap:44px;align-items:start;">

    <!-- TOC -->
    <aside class="ml-adp-toc" style="position:sticky;top:92px;font-family:var(--font-mono);font-size:13px;">
      <div style="font-size:11px;color:var(--accent);letter-spacing:.1em;margin-bottom:14px;">ADAPTER</div>
      <div style="display:flex;flex-direction:column;gap:11px;border-left:1px solid var(--hairline);padding-left:16px;">
        ${tocLinks}
        <a href="/docs/adapters" style="color:var(--faint);text-decoration:none;">&larr; all adapters</a>
      </div>
    </aside>

    <!-- CONTENT -->
    <div>
      <p style="font-size:.85rem;color:var(--faint);margin:0 0 20px;"><a href="/" style="color:var(--faint);text-decoration:none;">Home</a> &rsaquo; <a href="/docs" style="color:var(--faint);text-decoration:none;">Docs</a> &rsaquo; <a href="/docs/adapters" style="color:var(--faint);text-decoration:none;">Adapters</a> &rsaquo; ${esc(adapter.name)}</p>
      <h1 style="font-family:var(--font-body);font-weight:800;font-size:42px;line-height:1;letter-spacing:-.02em;margin:0 0 10px;">${esc(adapter.name)} Adapter</h1>
      <span style="display:inline-block;font-family:var(--font-mono);font-size:.85rem;color:var(--accent);margin-bottom:18px;">${esc(adapter.pkg)}</span>
      <p style="color:var(--muted);font-size:1rem;line-height:1.7;margin:0 0 36px;max-width:720px;">${esc(adapter.desc)}</p>

      <!-- Install -->
      <div id="install" style="margin-bottom:36px;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Install</h2>
        <div style="position:relative;">
          <pre style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0;overflow-x:auto;"><code>${esc(adapter.install)}</code></pre>
          <button class="ml-adp-copy" aria-label="Copy" style="position:absolute;top:8px;right:8px;background:var(--dark-border);border:1px solid var(--dark-border2);color:var(--dk-muted);font-size:.72rem;padding:4px 10px;cursor:pointer;font-family:var(--font-mono);">Copy</button>
        </div>
      </div>

      <!-- Quick start -->
      <div id="quickstart" style="margin-bottom:36px;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Quick start</h2>
        <div style="position:relative;">
          <pre style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0;overflow-x:auto;"><code>${esc(adapter.quickstart)}</code></pre>
          <button class="ml-adp-copy" aria-label="Copy" style="position:absolute;top:8px;right:8px;background:var(--dark-border);border:1px solid var(--dark-border2);color:var(--dk-muted);font-size:.72rem;padding:4px 10px;cursor:pointer;font-family:var(--font-mono);">Copy</button>
        </div>
      </div>

      ${adapter.noWalletExample ? `<div id="no-wallet" style="margin-bottom:36px;">
        <p style="color:var(--muted);font-size:.95rem;line-height:1.6;margin:0 0 12px;"><strong style="color:var(--ink);">No wallet yet?</strong> ${esc(NO_WALLET_NOTE)}</p>
        <div style="position:relative;">
          <pre style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0;overflow-x:auto;"><code>${esc(adapter.noWalletExample)}</code></pre>
          <button class="ml-adp-copy" aria-label="Copy" style="position:absolute;top:8px;right:8px;background:var(--dark-border);border:1px solid var(--dark-border2);color:var(--dk-muted);font-size:.72rem;padding:4px 10px;cursor:pointer;font-family:var(--font-mono);">Copy</button>
        </div>
      </div>` : ""}

      ${adapter.walletExample ? `<div id="paid" style="margin-bottom:36px;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Paid tools</h2>
        <div style="position:relative;">
          <pre style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0;overflow-x:auto;"><code>${esc(adapter.walletExample)}</code></pre>
          <button class="ml-adp-copy" aria-label="Copy" style="position:absolute;top:8px;right:8px;background:var(--dark-border);border:1px solid var(--dark-border2);color:var(--dk-muted);font-size:.72rem;padding:4px 10px;cursor:pointer;font-family:var(--font-mono);">Copy</button>
        </div>
      </div>` : ""}

      <!-- Configuration -->
      ${adapter.config && adapter.config.length ? `<div id="config" style="margin-bottom:36px;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Configuration</h2>
        <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:.88rem;">
          <thead>
            <tr><th style="text-align:left;color:var(--faint);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--hairline);font-size:.82rem;text-transform:uppercase;letter-spacing:.03em;font-family:var(--font-mono);">Option</th><th style="text-align:left;color:var(--faint);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--hairline);font-size:.82rem;text-transform:uppercase;letter-spacing:.03em;font-family:var(--font-mono);">Type</th><th style="text-align:left;color:var(--faint);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--hairline);font-size:.82rem;text-transform:uppercase;letter-spacing:.03em;font-family:var(--font-mono);">Description</th></tr>
          </thead>
          <tbody>
${configRows}
          </tbody>
        </table>
        <div style="position:relative;">
          <pre style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0;overflow-x:auto;"><code>${configExamples}</code></pre>
          <button class="ml-adp-copy" aria-label="Copy" style="position:absolute;top:8px;right:8px;background:var(--dark-border);border:1px solid var(--dark-border2);color:var(--dk-muted);font-size:.72rem;padding:4px 10px;cursor:pointer;font-family:var(--font-mono);">Copy</button>
        </div>
      </div>` : ""}

      <!-- Works with -->
      ${adapter.worksWith && adapter.worksWith.length ? `<div id="compat" style="margin-bottom:36px;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Works with</h2>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${worksWithTags}
        </div>
      </div>` : ""}

      <!-- Navigation links -->
      <div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:36px;padding-top:20px;border-top:1px solid var(--hairline);">
        <a href="/docs/adapters" style="color:var(--accent);text-decoration:none;font-size:.92rem;font-weight:600;">&larr; All adapters</a>
        <a href="/integrations" style="color:var(--accent);text-decoration:none;font-size:.92rem;font-weight:600;">Integrations overview</a>
        <a href="${esc(adapter.github)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:.92rem;font-weight:600;">GitHub source &rarr;</a>
      </div>
    </div>
  </div>
  ${ledgerFooterCompact()}

  <script src="/js/copy-buttons.js"></script>`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/docs",
    extraCss,
    body,
  });
}
