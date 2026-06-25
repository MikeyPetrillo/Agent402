import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

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

/* ── index page ──────────────────────────────────────────────────────── */

export function adapterDocsIndex(baseUrl) {
  const canonical = `${baseUrl}/docs/adapters`;
  const title = "Framework Adapters \u2014 Agent402 Docs";
  const description = "Adapter documentation for every supported agent framework: OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, OpenAI Agents SDK, and AWS Strands.";

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
  .ml-ad-card{background:var(--card);border:1.5px solid var(--ink);padding:1.5rem 1.6rem;text-decoration:none;color:var(--ink);transition:border-color .15s;display:block}
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
  const title = `${adapter.name} Adapter \u2014 Agent402 Docs`;
  const description = `${adapter.desc} Install ${adapter.pkg} and start using Agent402 tools in your ${adapter.name} project.`;

  const tocItems = [
    { id: "install", label: "install" },
    { id: "quickstart", label: "quick start" },
  ];
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
    `<span style="background:var(--card);border:1.5px solid var(--ink);color:var(--muted);font-size:.82rem;padding:4px 12px;font-family:var(--font-mono);">${esc(w)}</span>`
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
      <div style="display:flex;flex-direction:column;gap:11px;border-left:1.5px solid var(--ink);padding-left:16px;">
        ${tocLinks}
        <a href="/docs/adapters" style="color:var(--faint);text-decoration:none;">&larr; all adapters</a>
      </div>
    </aside>

    <!-- CONTENT -->
    <main>
      <p style="font-size:.85rem;color:var(--faint);margin:0 0 20px;"><a href="/" style="color:var(--faint);text-decoration:none;">Home</a> &rsaquo; <a href="/docs" style="color:var(--faint);text-decoration:none;">Docs</a> &rsaquo; <a href="/docs/adapters" style="color:var(--faint);text-decoration:none;">Adapters</a> &rsaquo; ${esc(adapter.name)}</p>
      <h1 style="font-family:var(--font-body);font-weight:800;font-size:42px;line-height:1;letter-spacing:-.02em;margin:0 0 10px;">${esc(adapter.name)} Adapter</h1>
      <span style="display:inline-block;font-family:var(--font-mono);font-size:.85rem;color:var(--accent);margin-bottom:18px;">${esc(adapter.pkg)}</span>
      <p style="color:var(--muted);font-size:1rem;line-height:1.7;margin:0 0 36px;max-width:720px;">${esc(adapter.desc)}</p>

      <!-- Install -->
      <div id="install" style="margin-bottom:36px;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Install</h2>
        <div style="position:relative;">
          <pre style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0;overflow-x:auto;"><code>${esc(adapter.install)}</code></pre>
          <button class="ml-adp-copy" aria-label="Copy" style="position:absolute;top:8px;right:8px;background:var(--dark-border);border:1px solid var(--dark-border2);color:var(--dk-muted);font-size:.72rem;padding:4px 10px;cursor:pointer;font-family:var(--font-mono);">Copy</button>
        </div>
      </div>

      <!-- Quick start -->
      <div id="quickstart" style="margin-bottom:36px;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Quick start</h2>
        <div style="position:relative;">
          <pre style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0;overflow-x:auto;"><code>${esc(adapter.quickstart)}</code></pre>
          <button class="ml-adp-copy" aria-label="Copy" style="position:absolute;top:8px;right:8px;background:var(--dark-border);border:1px solid var(--dark-border2);color:var(--dk-muted);font-size:.72rem;padding:4px 10px;cursor:pointer;font-family:var(--font-mono);">Copy</button>
        </div>
      </div>

      <!-- Configuration -->
      ${adapter.config && adapter.config.length ? `<div id="config" style="margin-bottom:36px;">
        <h2 style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Configuration</h2>
        <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:.88rem;">
          <thead>
            <tr><th style="text-align:left;color:var(--faint);font-weight:500;padding:8px 10px;border-bottom:1.5px solid var(--ink);font-size:.82rem;text-transform:uppercase;letter-spacing:.03em;font-family:var(--font-mono);">Option</th><th style="text-align:left;color:var(--faint);font-weight:500;padding:8px 10px;border-bottom:1.5px solid var(--ink);font-size:.82rem;text-transform:uppercase;letter-spacing:.03em;font-family:var(--font-mono);">Type</th><th style="text-align:left;color:var(--faint);font-weight:500;padding:8px 10px;border-bottom:1.5px solid var(--ink);font-size:.82rem;text-transform:uppercase;letter-spacing:.03em;font-family:var(--font-mono);">Description</th></tr>
          </thead>
          <tbody>
${configRows}
          </tbody>
        </table>
        <div style="position:relative;">
          <pre style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0;overflow-x:auto;"><code>${configExamples}</code></pre>
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
      <div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:36px;padding-top:20px;border-top:1.5px solid var(--ink);">
        <a href="/docs/adapters" style="color:var(--accent);text-decoration:none;font-size:.92rem;font-weight:600;">&larr; All adapters</a>
        <a href="/integrations" style="color:var(--accent);text-decoration:none;font-size:.92rem;font-weight:600;">Integrations overview</a>
        <a href="${esc(adapter.github)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:.92rem;font-weight:600;">GitHub source &rarr;</a>
      </div>
    </main>
  </div>
  ${ledgerFooterCompact()}

  <script>
  (function(){
    document.querySelectorAll(".ml-adp-copy").forEach(function(btn){
      btn.addEventListener("click",function(){
        var code=btn.parentElement.querySelector("code");
        var text=code.textContent;
        navigator.clipboard.writeText(text).then(function(){
          btn.textContent="Copied!";
          btn.style.color="var(--accent)";
          setTimeout(function(){btn.textContent="Copy";btn.style.color="";},1500);
        });
      });
    });
  })();
  </script>`;

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
