// agent402-ai-sdk — drop-in Vercel AI SDK tools for Agent402.
//
// Turn the Agent402 catalog (~1,100 pay-per-call web tools) into Vercel AI SDK
// `tool()` instances the model can invoke, with payment handled for you under
// the hood by agent402-client (proof-of-work for the free tier, x402+USDC for
// wallet-only tools when you pass a payFetch).
//
//   import { streamText } from "ai";
//   import { openai } from "@ai-sdk/openai";
//   import { agent402Tools } from "agent402-ai-sdk";
//
//   const { tools } = await agent402Tools({ slugs: ["extract","hash","render"] });
//
//   const result = await streamText({
//     model: openai("gpt-4o-mini"),
//     tools,
//     prompt: "Get the title of https://example.com/article",
//   });
//
// Works with any AI SDK provider (OpenAI, Anthropic, Google, etc.) and with
// every entry point that takes `tools`: streamText, generateText, generateObject,
// the agent helpers, and the React useChat() hook on the server.

import { Agent402 } from "agent402-client";

const DEFAULT_BASE = "https://agent402.tools";

// Vercel AI SDK tool names: ^[a-zA-Z0-9_-]+$ (the model providers' constraints).
const sanitizeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/**
 * Fetch the Agent402 catalog and return:
 *   - `tools`:    Record<name, tool()> ready to pass to streamText({tools})
 *   - `execute`:  async (name, args) => result — pays under the hood
 *   - `client`:   the underlying Agent402 client (use for find()/clearCache())
 */
export async function agent402Tools({ baseUrl = DEFAULT_BASE, slugs, freeOnly = true, fetch: payFetch } = {}) {
  const ai = await loadAiSdk();
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

  // The AI SDK consumes tools as a Record<string, ReturnType<typeof tool>>.
  // We wrap the JSON Schema with `jsonSchema()` so the SDK doesn't try to
  // convert a Zod schema — and so users don't need a Zod dependency.
  const tools = {};
  for (const m of meta) {
    tools[m.name] = ai.tool({
      description: m.description,
      parameters: ai.jsonSchema(m.schema),
      execute: async (input) => client.call(m.slug, input ?? {}),
    });
  }

  return { client, tools, execute: makeExecute(client, meta) };
}

async function loadAiSdk() {
  try {
    return await import("ai");
  } catch {
    throw new Error("agent402-ai-sdk requires the 'ai' package — install it with: npm install ai");
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
