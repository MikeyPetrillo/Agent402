import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const INTEGRATIONS = [
  {
    name: "MCP (Hosted Connector)",
    pkg: null,
    icon: "\u{1F310}",
    desc: "Zero-install: paste the remote MCP URL into Claude, Cursor, ChatGPT Pro+, or VS Code. Free tier via rate-limited proof-of-work.",
    install: "# no install \u2014 just paste the URL into your MCP client config\nhttps://agent402.tools/mcp",
    snippet: `// Claude Desktop \u2192 Settings \u2192 MCP Servers \u2192 Add
{
  "mcpServers": {
    "agent402": { "url": "https://agent402.tools/mcp" }
  }
}`,
    link: "https://agent402.tools/mcp",
    linkLabel: "Endpoint"
  },
  {
    name: "MCP (npm)",
    pkg: "agent402-mcp",
    icon: "\u{1F4E6}",
    desc: "Full catalog with payment underneath. Run via npx. Set AGENT_KEY for wallet-only tools, AGENT402_BUDGET for a spend cap.",
    install: "npx -y agent402-mcp",
    snippet: `{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT_KEY": "0x..." }
    }
  }
}`,
    link: "https://github.com/MikeyPetrillo/Agent402/tree/main/mcp",
    linkLabel: "GitHub"
  },
  {
    name: "OpenAI",
    pkg: "agent402-openai-tools",
    icon: "\u{1F916}",
    desc: "Function-calling for chat.completions, Assistants v2, and the Responses API. Returns OpenAI-native tool definitions.",
    install: "npm install agent402-openai-tools",
    snippet: `import { agent402Tools } from "agent402-openai-tools";
const { tools, execute } = await agent402Tools();
// pass tools to chat.completions or Assistants`,
    link: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/openai-tools",
    linkLabel: "GitHub"
  },
  {
    name: "Anthropic",
    pkg: "agent402-anthropic-tools",
    icon: "\u{1F9E0}",
    desc: "tool_use blocks for the Anthropic Messages API. Returns native tool definitions with input_schema.",
    install: "npm install agent402-anthropic-tools",
    snippet: `import { agent402Tools } from "agent402-anthropic-tools";
const { tools, execute } = await agent402Tools();
// pass tools to messages.create()`,
    link: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/anthropic-tools",
    linkLabel: "GitHub"
  },
  {
    name: "Vercel AI SDK",
    pkg: "agent402-ai-sdk",
    icon: "\u25B2",
    desc: "Works with streamText, generateText, and generateObject. Drop-in tool objects for the Vercel AI SDK.",
    install: "npm install agent402-ai-sdk",
    snippet: `import { agent402Tools } from "agent402-ai-sdk";
const { tools, execute } = await agent402Tools();
// pass tools to streamText() or generateText()`,
    link: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/ai-sdk",
    linkLabel: "GitHub"
  },
  {
    name: "LangChain / LangGraph",
    pkg: "agent402-langchain",
    icon: "\u{1F517}",
    desc: "DynamicStructuredTool instances for LangChain agents and LangGraph nodes.",
    install: "npm install agent402-langchain",
    snippet: `import { agent402Tools } from "agent402-langchain";
const { tools, execute } = await agent402Tools();
// pass tools to createReactAgent()`,
    link: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/langchain",
    linkLabel: "GitHub"
  },
  {
    name: "LlamaIndex",
    pkg: "agent402-llamaindex",
    icon: "\u{1F999}",
    desc: "FunctionTool instances for LlamaIndex agents.",
    install: "npm install agent402-llamaindex",
    snippet: `import { agent402Tools } from "agent402-llamaindex";
const { tools, execute } = await agent402Tools();
// pass tools to new OpenAIAgent({ tools })`,
    link: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/llamaindex",
    linkLabel: "GitHub"
  },
  {
    name: "Google ADK",
    pkg: "agent402-google-adk",
    icon: "\u{1F48E}",
    desc: "FunctionTool for Gemini agents. Ships 4 meta-tools: find, route, call, and about.",
    install: "npm install agent402-google-adk",
    snippet: `import { agent402Tools } from "agent402-google-adk";
const tools = await agent402Tools();
// pass to new LlmAgent({ tools })`,
    link: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/google-adk",
    linkLabel: "GitHub"
  },
  {
    name: "OpenAI Agents SDK",
    pkg: "agent402-openai-agents",
    icon: "\u{1F916}",
    desc: "Tool adapters for OpenAI's Agents SDK. JS adapter around the Python-style agent loop.",
    install: "npm install agent402-openai-agents",
    snippet: `import { agent402Tools } from "agent402-openai-agents";
const tools = await agent402Tools();
// pass to new Agent({ tools })`,
    link: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/openai-agents",
    linkLabel: "GitHub"
  },
  {
    name: "AWS Strands",
    pkg: "agent402-strands",
    icon: "\u{1F9F6}",
    desc: "Tool instances for Amazon's Strands agent framework.",
    install: "npm install agent402-strands",
    snippet: `import { agent402Tools } from "agent402-strands";
const tools = await agent402Tools();
// pass to new Agent({ tools })`,
    link: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/strands",
    linkLabel: "GitHub"
  },
  {
    name: "Client SDK",
    pkg: "agent402-client",
    icon: "\u{1F527}",
    desc: "Direct programmatic access. find() resolves tasks, call() auto-pays (PoW free / x402 paid).",
    install: "npm install agent402-client",
    snippet: `import { Agent402 } from "agent402-client";
const a = new Agent402();
const out = await a.call("hash", { text: "hello" });`,
    link: "https://github.com/MikeyPetrillo/Agent402/tree/main/client",
    linkLabel: "GitHub"
  }
];

export function integrationsPage(baseUrl) {
  const canonical = `${baseUrl}/integrations`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Agent402 Integrations",
    description: "Adapters and SDKs for connecting Agent402 to any agent framework.",
    url: canonical,
    numberOfItems: INTEGRATIONS.length,
    itemListElement: INTEGRATIONS.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      url: it.link
    }))
  };

  const cards = INTEGRATIONS.map((it) => `
      <div class="int-card">
        <h3><span class="int-icon">${esc(it.icon)}</span> ${esc(it.name)}</h3>
        <p class="int-desc">${esc(it.desc)}</p>
        <pre class="int-install"><code>${esc(it.install)}</code></pre>
        <pre class="int-snippet"><code>${esc(it.snippet)}</code></pre>
        <div class="int-footer">
          ${it.pkg ? `<span class="int-pkg">${esc(it.pkg)}</span>` : ""}
          <a href="${esc(it.link)}" class="int-link" target="_blank" rel="noopener">${esc(it.linkLabel)} &rarr;</a>
        </div>
      </div>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Integrations \u2014 connect Agent402 to any agent framework</title>
<meta name="description" content="Agent402 adapters for MCP, OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, AWS Strands, and more. Zero-dependency, native tool objects, automatic payment.">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="Integrations \u2014 connect Agent402 to any agent framework">
<meta property="og:description" content="Agent402 plugs into every major agent framework. Each adapter is zero-dependency, returns native tool objects, and handles payment underneath.">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Integrations \u2014 connect Agent402 to any agent framework">
<meta name="twitter:description" content="Agent402 plugs into every major agent framework. Each adapter is zero-dependency, returns native tool objects, and handles payment underneath.">
${CHROME_HEAD_LINKS}
<style>
${CHROME_CSS}
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
.crumb{font-size:.85rem;color:var(--muted);margin-bottom:1.5rem}
.crumb a{color:var(--accent);text-decoration:none}
.int-intro{color:var(--muted);line-height:1.7;max-width:52rem;margin-bottom:2.5rem;font-size:.95rem}
.int-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1.25rem;margin-bottom:3rem}
@media(max-width:740px){.int-grid{grid-template-columns:1fr}}
.int-card{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:.75rem;padding:1.25rem 1.5rem;display:flex;flex-direction:column;gap:.65rem}
.int-card h3{margin:0;font-size:1.05rem;color:var(--text);font-weight:600}
.int-icon{margin-right:.35rem}
.int-desc{margin:0;font-size:.85rem;color:var(--muted);line-height:1.55}
.int-install,.int-snippet{margin:0;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.04);border-radius:.45rem;padding:.55rem .75rem;font-family:var(--mono);font-size:.78rem;color:var(--text);overflow-x:auto;white-space:pre;line-height:1.45}
.int-install{font-size:.75rem;color:var(--accent)}
.int-footer{display:flex;align-items:center;justify-content:space-between;margin-top:auto;padding-top:.35rem}
.int-pkg{font-family:var(--mono);font-size:.75rem;color:var(--muted);background:rgba(255,255,255,.04);padding:.15rem .45rem;border-radius:.25rem}
.int-link{font-size:.8rem;color:var(--accent);text-decoration:none;font-weight:500}
.int-link:hover{text-decoration:underline}
</style>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body style="background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;margin:0;padding:0">
${renderHeader("/integrations")}
<main style="max-width:72rem;margin:0 auto;padding:2rem 1.5rem">
<div class="crumb"><a href="/">Agent402</a> / integrations</div>
<h1 style="font-size:1.75rem;margin:0 0 1rem">Integrations</h1>
<p class="int-intro">Agent402 plugs into every major agent framework &mdash; MCP, OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, AWS Strands. Each adapter is zero-dependency, returns native tool objects, and handles payment underneath (proof-of-work for free tools, USDC via x402 for wallet-only). Pick your stack.</p>
<div class="int-grid">
${cards}
</div>
</main>
${renderFooter()}
</body>
</html>`;
}
