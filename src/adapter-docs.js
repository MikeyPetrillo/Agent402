import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const ADAPTERS = [
  {
    slug: "openai",
    name: "OpenAI",
    pkg: "agent402-openai-tools",
    tagline: "OpenAI function calling integration",
    desc: "Drop-in tool definitions for OpenAI chat.completions, Assistants v2, and the Responses API. Returns native function objects with JSON Schema parameters.",
    install: "npm install agent402-openai-tools",
    quickstart: `import { agent402Tools } from "agent402-openai-tools";
import OpenAI from "openai";

const openai = new OpenAI();
const { tools, execute } = await agent402Tools();

const res = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hash 'hello world' with SHA-256" }],
  tools,
});

// When the model returns a tool_call, run it:
const call = res.choices[0].message.tool_calls[0];
const result = await execute(call.function.name, JSON.parse(call.function.arguments));
console.log(result);`,
    config: [
      { option: "categories", type: "string[]", desc: "Filter tools by category.", example: `agent402Tools({ categories: ["search", "crypto"] })` },
      { option: "slugs", type: "string[]", desc: "Load only specific tools by slug.", example: `agent402Tools({ slugs: ["hash", "geocode"] })` },
      { option: "baseUrl", type: "string", desc: "Point to a self-hosted Agent402 instance.", example: `agent402Tools({ baseUrl: "https://my-agent402.example.com" })` },
      { option: "agentKey", type: "string", desc: "Private key for wallet-only (paid) tools.", example: `agent402Tools({ agentKey: process.env.AGENT_KEY })` },
    ],
    worksWith: ["GPT-4o", "GPT-4o-mini", "GPT-4.1", "o3", "OpenAI Assistants v2", "OpenAI Responses API"],
    github: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/openai-tools",
  },
  {
    slug: "anthropic",
    name: "Anthropic",
    pkg: "agent402-anthropic-tools",
    tagline: "Anthropic tool use integration",
    desc: "Native tool_use blocks for the Anthropic Messages API. Returns tool definitions with input_schema matching the Anthropic format.",
    install: "npm install agent402-anthropic-tools",
    quickstart: `import { agent402Tools } from "agent402-anthropic-tools";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();
const { tools, execute } = await agent402Tools();

const res = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hash 'hello world' with SHA-256" }],
  tools,
});

// When the model returns a tool_use block, run it:
const block = res.content.find(b => b.type === "tool_use");
const result = await execute(block.name, block.input);
console.log(result);`,
    config: [
      { option: "categories", type: "string[]", desc: "Filter tools by category.", example: `agent402Tools({ categories: ["search"] })` },
      { option: "slugs", type: "string[]", desc: "Load only specific tools by slug.", example: `agent402Tools({ slugs: ["hash", "extract"] })` },
      { option: "baseUrl", type: "string", desc: "Point to a self-hosted Agent402 instance.", example: `agent402Tools({ baseUrl: "https://my-agent402.example.com" })` },
      { option: "agentKey", type: "string", desc: "Private key for wallet-only (paid) tools.", example: `agent402Tools({ agentKey: process.env.AGENT_KEY })` },
    ],
    worksWith: ["Claude Sonnet 4", "Claude Opus 4", "Claude Haiku 3.5", "Anthropic Messages API", "Anthropic Batch API"],
    github: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/anthropic-tools",
  },
  {
    slug: "ai-sdk",
    name: "Vercel AI SDK",
    pkg: "agent402-ai-sdk",
    tagline: "Vercel AI SDK integration",
    desc: "Drop-in tool objects for the Vercel AI SDK. Works with streamText, generateText, and generateObject across any supported provider.",
    install: "npm install agent402-ai-sdk",
    quickstart: `import { agent402Tools } from "agent402-ai-sdk";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const { tools, execute } = await agent402Tools();

const { text, toolCalls } = await generateText({
  model: openai("gpt-4o"),
  prompt: "Hash 'hello world' with SHA-256",
  tools,
});

// Tool calls are executed automatically by the AI SDK,
// or handle them manually:
for (const call of toolCalls) {
  const result = await execute(call.toolName, call.args);
  console.log(result);
}`,
    config: [
      { option: "categories", type: "string[]", desc: "Filter tools by category.", example: `agent402Tools({ categories: ["pdf"] })` },
      { option: "slugs", type: "string[]", desc: "Load only specific tools by slug.", example: `agent402Tools({ slugs: ["pdf-to-markdown", "extract"] })` },
      { option: "baseUrl", type: "string", desc: "Point to a self-hosted Agent402 instance.", example: `agent402Tools({ baseUrl: "https://my-agent402.example.com" })` },
      { option: "agentKey", type: "string", desc: "Private key for wallet-only (paid) tools.", example: `agent402Tools({ agentKey: process.env.AGENT_KEY })` },
    ],
    worksWith: ["OpenAI (via @ai-sdk/openai)", "Anthropic (via @ai-sdk/anthropic)", "Google (via @ai-sdk/google)", "Mistral (via @ai-sdk/mistral)", "streamText", "generateText", "generateObject"],
    github: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/ai-sdk",
  },
  {
    slug: "langchain",
    name: "LangChain",
    pkg: "agent402-langchain",
    tagline: "LangChain tool integration",
    desc: "DynamicStructuredTool instances for LangChain agents and LangGraph nodes. Compatible with createReactAgent, createToolCallingAgent, and custom chains.",
    install: "npm install agent402-langchain",
    quickstart: `import { agent402Tools } from "agent402-langchain";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const { tools } = await agent402Tools();

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: "gpt-4o" }),
  tools,
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "Hash 'hello world' with SHA-256" }],
});
console.log(result);`,
    config: [
      { option: "categories", type: "string[]", desc: "Filter tools by category.", example: `agent402Tools({ categories: ["search", "gov"] })` },
      { option: "slugs", type: "string[]", desc: "Load only specific tools by slug.", example: `agent402Tools({ slugs: ["search", "answer"] })` },
      { option: "baseUrl", type: "string", desc: "Point to a self-hosted Agent402 instance.", example: `agent402Tools({ baseUrl: "https://my-agent402.example.com" })` },
      { option: "agentKey", type: "string", desc: "Private key for wallet-only (paid) tools.", example: `agent402Tools({ agentKey: process.env.AGENT_KEY })` },
    ],
    worksWith: ["LangChain JS", "LangGraph", "createReactAgent", "createToolCallingAgent", "Any LangChain-compatible LLM"],
    github: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/langchain",
  },
  {
    slug: "llamaindex",
    name: "LlamaIndex",
    pkg: "agent402-llamaindex",
    tagline: "LlamaIndex tool integration",
    desc: "FunctionTool instances for LlamaIndex agents. Works with OpenAIAgent, ReActAgent, and custom query engines.",
    install: "npm install agent402-llamaindex",
    quickstart: `import { agent402Tools } from "agent402-llamaindex";
import { OpenAIAgent } from "llamaindex";

const { tools } = await agent402Tools();

const agent = new OpenAIAgent({ tools });

const response = await agent.chat({
  message: "Hash 'hello world' with SHA-256",
});
console.log(response.toString());`,
    config: [
      { option: "categories", type: "string[]", desc: "Filter tools by category.", example: `agent402Tools({ categories: ["finance"] })` },
      { option: "slugs", type: "string[]", desc: "Load only specific tools by slug.", example: `agent402Tools({ slugs: ["stock-quote", "stock-history"] })` },
      { option: "baseUrl", type: "string", desc: "Point to a self-hosted Agent402 instance.", example: `agent402Tools({ baseUrl: "https://my-agent402.example.com" })` },
      { option: "agentKey", type: "string", desc: "Private key for wallet-only (paid) tools.", example: `agent402Tools({ agentKey: process.env.AGENT_KEY })` },
    ],
    worksWith: ["LlamaIndex TS", "OpenAIAgent", "ReActAgent", "FunctionTool", "Any LlamaIndex query engine"],
    github: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/llamaindex",
  },
  {
    slug: "google-adk",
    name: "Google ADK",
    pkg: "agent402-google-adk",
    tagline: "Google Agent Development Kit integration",
    desc: "FunctionTool for Gemini agents via Google's Agent Development Kit. Ships 4 meta-tools: find, route, call, and about.",
    install: "npm install agent402-google-adk",
    quickstart: `import { agent402Tools } from "agent402-google-adk";
import { LlmAgent } from "@google/adk";

const tools = await agent402Tools();

const agent = new LlmAgent({
  model: "gemini-2.0-flash",
  name: "my-agent",
  tools,
});

// The agent can now discover and call any Agent402 tool
// via the find, route, call, and about meta-tools.`,
    config: [
      { option: "baseUrl", type: "string", desc: "Point to a self-hosted Agent402 instance.", example: `agent402Tools({ baseUrl: "https://my-agent402.example.com" })` },
      { option: "agentKey", type: "string", desc: "Private key for wallet-only (paid) tools.", example: `agent402Tools({ agentKey: process.env.AGENT_KEY })` },
    ],
    worksWith: ["Gemini 2.0 Flash", "Gemini 2.5 Pro", "Google Agent Development Kit", "LlmAgent", "SequentialAgent"],
    github: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/google-adk",
  },
  {
    slug: "openai-agents",
    name: "OpenAI Agents SDK",
    pkg: "agent402-openai-agents",
    tagline: "OpenAI Agents SDK integration",
    desc: "Tool adapters for OpenAI's Agents SDK. JS adapter around the Python-style agent loop with automatic tool execution.",
    install: "npm install agent402-openai-agents",
    quickstart: `import { agent402Tools } from "agent402-openai-agents";
import { Agent, Runner } from "openai-agents";

const tools = await agent402Tools();

const agent = new Agent({
  name: "my-agent",
  instructions: "You are a helpful assistant.",
  tools,
});

const result = await Runner.run(agent, "Hash 'hello world' with SHA-256");
console.log(result.finalOutput);`,
    config: [
      { option: "categories", type: "string[]", desc: "Filter tools by category.", example: `agent402Tools({ categories: ["search"] })` },
      { option: "slugs", type: "string[]", desc: "Load only specific tools by slug.", example: `agent402Tools({ slugs: ["search", "extract"] })` },
      { option: "baseUrl", type: "string", desc: "Point to a self-hosted Agent402 instance.", example: `agent402Tools({ baseUrl: "https://my-agent402.example.com" })` },
      { option: "agentKey", type: "string", desc: "Private key for wallet-only (paid) tools.", example: `agent402Tools({ agentKey: process.env.AGENT_KEY })` },
    ],
    worksWith: ["OpenAI Agents SDK", "GPT-4o", "GPT-4o-mini", "Agent", "Runner"],
    github: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/openai-agents",
  },
  {
    slug: "strands",
    name: "AWS Strands",
    pkg: "agent402-strands",
    tagline: "AWS Strands Agents integration",
    desc: "Tool instances for Amazon's Strands agent framework. Plug Agent402 tools into Strands-based agents with automatic discovery and execution.",
    install: "npm install agent402-strands",
    quickstart: `import { agent402Tools } from "agent402-strands";
import { Agent } from "@strands/agents";

const tools = await agent402Tools();

const agent = new Agent({
  tools,
});

const result = await agent.run("Hash 'hello world' with SHA-256");
console.log(result);`,
    config: [
      { option: "categories", type: "string[]", desc: "Filter tools by category.", example: `agent402Tools({ categories: ["data"] })` },
      { option: "slugs", type: "string[]", desc: "Load only specific tools by slug.", example: `agent402Tools({ slugs: ["csv-lint", "json-lint"] })` },
      { option: "baseUrl", type: "string", desc: "Point to a self-hosted Agent402 instance.", example: `agent402Tools({ baseUrl: "https://my-agent402.example.com" })` },
      { option: "agentKey", type: "string", desc: "Private key for wallet-only (paid) tools.", example: `agent402Tools({ agentKey: process.env.AGENT_KEY })` },
    ],
    worksWith: ["AWS Strands Agents", "Amazon Bedrock", "Claude (via Bedrock)", "Any Strands-compatible model"],
    github: "https://github.com/MikeyPetrillo/Agent402/tree/main/adapters/strands",
  },
];

/* ── shared CSS ──────────────────────────────────────────────────────── */

const SHARED_CSS = `
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;line-height:1.6}
.ad-wrap{max-width:960px;margin:0 auto;padding:2rem 1.25rem 4rem}
.ad-breadcrumb{font-size:.85rem;color:var(--muted);margin-bottom:1.5rem}
.ad-breadcrumb a{color:var(--accent);text-decoration:none}
.ad-breadcrumb a:hover{text-decoration:underline}
.ad-title{font-size:2rem;font-weight:700;margin:0 0 .5rem;line-height:1.2}
.ad-subtitle{color:var(--muted);font-size:1.05rem;margin:0 0 2.5rem}
@media(max-width:600px){.ad-title{font-size:1.5rem}}
`;

/* ── index page ──────────────────────────────────────────────────────── */

export function adapterDocsIndex(baseUrl) {
  const canonical = `${baseUrl}/docs/adapters`;
  const title = "Framework Adapters \u2014 Agent402 Docs";
  const description = "Adapter documentation for every supported agent framework: OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, OpenAI Agents SDK, and AWS Strands.";

  const cards = ADAPTERS.map((a) => `
    <a class="ad-card" href="/docs/adapters/${esc(a.slug)}">
      <h3 class="ad-card-name">${esc(a.name)}</h3>
      <code class="ad-card-pkg">${esc(a.pkg)}</code>
      <p class="ad-card-desc">${esc(a.tagline)}</p>
      <span class="ad-card-link">View docs &rarr;</span>
    </a>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${CHROME_HEAD_LINKS}
<style>
${CHROME_CSS}
${SHARED_CSS}
.ad-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1.25rem;margin-bottom:3rem}
@media(max-width:680px){.ad-grid{grid-template-columns:1fr}}
.ad-card{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.5rem 1.6rem;text-decoration:none;color:var(--text);transition:border-color .15s,transform .15s;display:block}
.ad-card:hover{border-color:var(--accent);transform:translateY(-2px)}
.ad-card-name{margin:0 0 .4rem;font-size:1.1rem;font-weight:600;color:var(--text)}
.ad-card-pkg{display:inline-block;font-family:var(--mono);font-size:.8rem;color:var(--accent);background:rgba(74,222,128,.08);padding:.15rem .5rem;border-radius:4px;margin-bottom:.6rem}
.ad-card-desc{margin:0 0 .75rem;color:var(--muted);font-size:.9rem;line-height:1.5}
.ad-card-link{color:var(--accent);font-size:.88rem;font-weight:500}
.ad-cta{text-align:center;margin:2rem 0 0}
.ad-cta a{color:var(--accent);font-weight:600;text-decoration:none;font-size:1rem}
.ad-cta a:hover{text-decoration:underline}
</style>
</head>
<body>
${renderHeader("/docs")}
<div class="ad-wrap">

<div class="ad-breadcrumb"><a href="/">Home</a> &rsaquo; <a href="/docs">Docs</a> &rsaquo; Adapters</div>
<h1 class="ad-title">Framework Adapters</h1>
<p class="ad-subtitle">Plug Agent402 into your agent framework. Each adapter returns native tool objects and handles payment underneath.</p>

<div class="ad-grid">
${cards}
</div>

<div class="ad-cta"><a href="/integrations">See all integrations (MCP, SDKs, and more) &rarr;</a></div>

</div>
${renderFooter()}
</body>
</html>`;
}

/* ── individual adapter page ─────────────────────────────────────────── */

export function adapterDocPage(baseUrl, slug) {
  const adapter = ADAPTERS.find((a) => a.slug === slug);
  if (!adapter) return null;

  const canonical = `${baseUrl}/docs/adapters/${adapter.slug}`;
  const title = `${adapter.name} Adapter \u2014 Agent402 Docs`;
  const description = `${adapter.desc} Install ${adapter.pkg} and start using Agent402 tools in your ${adapter.name} project.`;

  const configRows = (adapter.config || []).map((c) => `
        <tr>
          <td class="adp-cfg-opt"><code>${esc(c.option)}</code></td>
          <td class="adp-cfg-type"><code>${esc(c.type)}</code></td>
          <td class="adp-cfg-desc">${esc(c.desc)}</td>
        </tr>`).join("\n");

  const configExamples = (adapter.config || []).map((c) => `// ${esc(c.desc)}\n${esc(c.example)}`).join("\n\n");

  const worksWithTags = (adapter.worksWith || []).map((w) =>
    `<span class="adp-tag">${esc(w)}</span>`
  ).join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${CHROME_HEAD_LINKS}
<style>
${CHROME_CSS}
${SHARED_CSS}

.adp-desc{color:var(--muted);font-size:1rem;line-height:1.7;margin:0 0 2rem;max-width:720px}
.adp-pkg{display:inline-block;font-family:var(--mono);font-size:.85rem;color:var(--accent);background:rgba(74,222,128,.08);padding:.2rem .6rem;border-radius:4px;margin-bottom:1.5rem}

/* sections */
.adp-section{margin-bottom:2.5rem}
.adp-section h2{font-size:1.25rem;font-weight:600;margin:0 0 1rem;color:var(--text)}

/* code blocks */
.adp-code-wrap{position:relative;margin-bottom:1.5rem}
.adp-code-wrap pre{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:1.25rem;overflow-x:auto;margin:0;font-family:var(--mono);font-size:.82rem;line-height:1.55;color:var(--text)}
.adp-copy{position:absolute;top:.6rem;right:.6rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:var(--muted);font-size:.72rem;padding:.3rem .6rem;border-radius:4px;cursor:pointer;font-family:inherit;transition:all .15s}
.adp-copy:hover{color:var(--text);background:rgba(255,255,255,.1)}
.adp-copy.copied{color:var(--accent);border-color:var(--accent)}

/* config table */
.adp-cfg-table{width:100%;border-collapse:collapse;margin-bottom:1rem;font-size:.88rem}
.adp-cfg-table th{text-align:left;color:var(--muted);font-weight:500;padding:.6rem .75rem;border-bottom:1px solid rgba(255,255,255,.08);font-size:.82rem;text-transform:uppercase;letter-spacing:.03em}
.adp-cfg-table td{padding:.6rem .75rem;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:top}
.adp-cfg-opt code{font-family:var(--mono);color:var(--accent);font-size:.84rem}
.adp-cfg-type code{font-family:var(--mono);color:var(--muted);font-size:.82rem}
.adp-cfg-desc{color:var(--text);font-size:.88rem}

/* tags */
.adp-tags{display:flex;flex-wrap:wrap;gap:.5rem}
.adp-tag{background:var(--card);border:1px solid rgba(255,255,255,.08);color:var(--muted);font-size:.82rem;padding:.3rem .7rem;border-radius:999px}

/* links */
.adp-links{display:flex;flex-wrap:wrap;gap:1rem;margin-top:2rem;padding-top:1.5rem;border-top:1px solid rgba(255,255,255,.06)}
.adp-link{color:var(--accent);text-decoration:none;font-size:.92rem;font-weight:500}
.adp-link:hover{text-decoration:underline}
</style>
</head>
<body>
${renderHeader("/docs")}
<div class="ad-wrap">

<div class="ad-breadcrumb"><a href="/">Home</a> &rsaquo; <a href="/docs">Docs</a> &rsaquo; <a href="/docs/adapters">Adapters</a> &rsaquo; ${esc(adapter.name)}</div>
<h1 class="ad-title">${esc(adapter.name)} Adapter</h1>
<span class="adp-pkg">${esc(adapter.pkg)}</span>
<p class="adp-desc">${esc(adapter.desc)}</p>

<!-- Install -->
<div class="adp-section">
  <h2>Install</h2>
  <div class="adp-code-wrap">
    <pre><code>${esc(adapter.install)}</code></pre>
    <button class="adp-copy" aria-label="Copy">Copy</button>
  </div>
</div>

<!-- Quick start -->
<div class="adp-section">
  <h2>Quick start</h2>
  <div class="adp-code-wrap">
    <pre><code>${esc(adapter.quickstart)}</code></pre>
    <button class="adp-copy" aria-label="Copy">Copy</button>
  </div>
</div>

<!-- Configuration -->
${adapter.config && adapter.config.length ? `<div class="adp-section">
  <h2>Configuration</h2>
  <table class="adp-cfg-table">
    <thead>
      <tr><th>Option</th><th>Type</th><th>Description</th></tr>
    </thead>
    <tbody>
${configRows}
    </tbody>
  </table>
  <div class="adp-code-wrap">
    <pre><code>${configExamples}</code></pre>
    <button class="adp-copy" aria-label="Copy">Copy</button>
  </div>
</div>` : ""}

<!-- Works with -->
${adapter.worksWith && adapter.worksWith.length ? `<div class="adp-section">
  <h2>Works with</h2>
  <div class="adp-tags">
    ${worksWithTags}
  </div>
</div>` : ""}

<!-- Navigation links -->
<div class="adp-links">
  <a class="adp-link" href="/docs/adapters">&larr; All adapters</a>
  <a class="adp-link" href="/integrations">Integrations overview</a>
  <a class="adp-link" href="${esc(adapter.github)}" target="_blank" rel="noopener">GitHub source &rarr;</a>
</div>

</div>
${renderFooter()}

<script>
(function(){
  document.querySelectorAll(".adp-copy").forEach(function(btn){
    btn.addEventListener("click",function(){
      var code=btn.parentElement.querySelector("code");
      var text=code.textContent;
      navigator.clipboard.writeText(text).then(function(){
        btn.textContent="Copied!";
        btn.classList.add("copied");
        setTimeout(function(){btn.textContent="Copy";btn.classList.remove("copied")},1500);
      });
    });
  });
})();
</script>
</body>
</html>`;
}
