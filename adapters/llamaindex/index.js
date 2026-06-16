// agent402-llamaindex — drop-in LlamaIndex TS tools for Agent402.
//
// Turn the Agent402 catalog (~1,100 pay-per-call web tools) into LlamaIndex
// `FunctionTool` instances any agent can invoke, with payment handled for you
// under the hood by agent402-client (proof-of-work for the free tier,
// x402+USDC for wallet-only tools when you pass a payFetch).
//
//   import { OpenAIAgent } from "llamaindex";
//   import { agent402Tools } from "agent402-llamaindex";
//
//   const { tools } = await agent402Tools({ slugs: ["extract","hash","render"] });
//   const agent = new OpenAIAgent({ tools });
//   const res = await agent.chat({ message: "Hash 'hello world' with SHA-256" });
//
// Works with any LlamaIndex agent runner (OpenAIAgent, AnthropicAgent,
// ReActAgent) and with the lower-level Workflow API.

import { Agent402 } from "agent402-client";

const DEFAULT_BASE = "https://agent402.tools";

const sanitizeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/**
 * Fetch the Agent402 catalog and return:
 *   - `tools`:    FunctionTool[] ready to pass to a LlamaIndex agent
 *   - `execute`:  async (name, args) => result — pays under the hood
 *   - `client`:   the underlying Agent402 client (use for find()/clearCache())
 */
export async function agent402Tools({ baseUrl = DEFAULT_BASE, slugs, freeOnly = true, fetch: payFetch } = {}) {
  const llama = await loadLlamaIndex();
  const client = new Agent402({ baseUrl, fetch: payFetch });
  const r = await (globalThis.fetch)(`${baseUrl}/openapi.json`);
  if (!r.ok) throw new Error(`Could not load ${baseUrl}/openapi.json: HTTP ${r.status}`);
  const spec = await r.json();

  const wanted = slugs ? new Set(slugs) : null;
  const meta = [];

  for (const [, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      const slug = op.operationId?.replace(/Get$/, "");
      if (!slug) continue;
      if (wanted && !wanted.has(slug)) continue;

      const schema = method.toLowerCase() === "get"
        ? {
            type: "object",
            properties: Object.fromEntries((op.parameters || []).map((p) => [p.name, { type: p.schema?.type || "string", description: p.description }])),
            required: (op.parameters || []).filter((p) => p.required).map((p) => p.name),
          }
        : op.requestBody?.content?.["application/json"]?.schema || { type: "object", properties: {} };
      if (schema && !schema.type) schema.type = "object";

      meta.push({ name: sanitizeName(slug), slug, schema, description: shortDesc(op.summary, op.description) });
    }
  }

  if (freeOnly) {
    const pr = await (globalThis.fetch)(`${baseUrl}/api/pricing`);
    if (!pr.ok) throw new Error(`Could not load ${baseUrl}/api/pricing: HTTP ${pr.status}`);
    const pricing = await pr.json();
    const free = new Set((pricing.endpoints || []).filter((e) => e.computePayable).map((e) => e.slug));
    for (let i = meta.length - 1; i >= 0; i--) if (!free.has(meta[i].slug)) meta.splice(i, 1);
  }

  // LlamaIndex's FunctionTool.from() accepts a raw JSON Schema in `parameters`.
  // Use the modern `tool()` helper when available (newer llamaindex), falling
  // back to FunctionTool.from() for older versions.
  const make = typeof llama.tool === "function"
    ? (fn, metadata) => llama.tool(fn, metadata)
    : (fn, metadata) => llama.FunctionTool.from(fn, metadata);

  const tools = meta.map((m) => make(
    async (input) => client.call(m.slug, input ?? {}),
    { name: m.name, description: m.description, parameters: m.schema },
  ));

  return { client, tools, execute: makeExecute(client, meta) };
}

async function loadLlamaIndex() {
  try {
    return await import("llamaindex");
  } catch {
    throw new Error("agent402-llamaindex requires the 'llamaindex' package — install it with: npm install llamaindex");
  }
}

function makeExecute(client, meta) {
  const nameToSlug = new Map(meta.map((m) => [m.name, m.slug]));
  return async function execute(name, args) {
    const slug = nameToSlug.get(name) || name;
    return client.call(slug, args ?? {});
  };
}

/**
 * Standalone executor for users who built their tool list a different way.
 * Returns an `execute(name, args)` that calls Agent402 with PoW or x402 payment.
 */
export function agent402Execute({ baseUrl = DEFAULT_BASE, fetch: payFetch } = {}) {
  const client = new Agent402({ baseUrl, fetch: payFetch });
  return async function execute(name, args) {
    return client.call(name, args ?? {});
  };
}

function shortDesc(summary, description) {
  const d = (description || summary || "").split("\n\n")[0].trim();
  return d.length > 280 ? d.slice(0, 277) + "..." : d;
}

export default agent402Tools;
