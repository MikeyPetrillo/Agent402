// agent402-langchain — drop-in LangChain JS tools for Agent402.
//
// Turn the Agent402 catalog (~1,100 pay-per-call web tools) into LangChain
// `DynamicStructuredTool` instances the agent can invoke, with payment handled
// for you under the hood by agent402-client (proof-of-work for the free tier,
// x402+USDC for wallet-only tools when you pass a payFetch).
//
//   import { createReactAgent } from "@langchain/langgraph/prebuilt";
//   import { ChatOpenAI } from "@langchain/openai";
//   import { agent402Tools } from "agent402-langchain";
//
//   const { tools } = await agent402Tools({ slugs: ["extract","hash","render"] });
//   const agent = createReactAgent({ llm: new ChatOpenAI({ model: "gpt-4o-mini" }), tools });
//   const res = await agent.invoke({ messages: [{ role: "user", content: "Hash 'hello'" }] });
//
// Works with LangGraph, LCEL chains, and any agent-runner that accepts a
// LangChain Tool[] array.

import { Agent402 } from "agent402-client";

const DEFAULT_BASE = "https://agent402.tools";

// LangChain tool names — function-name shape, conservative.
const sanitizeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/**
 * Fetch the Agent402 catalog and return:
 *   - `tools`:    LangChain Tool[] ready to pass to an agent
 *   - `execute`:  async (name, args) => result — pays under the hood
 *   - `client`:   the underlying Agent402 client (use for find()/clearCache())
 */
export async function agent402Tools({ baseUrl = DEFAULT_BASE, slugs, freeOnly = true, fetch: payFetch } = {}) {
  const [lc, zodMod] = await Promise.all([loadLangChain(), loadZod()]);
  const z = zodMod.z || zodMod.default?.z || zodMod;
  const client = new Agent402({ baseUrl, fetch: payFetch });
  // Bounded discovery fetch: caller picks baseUrl, so cap the wait. Node ≥18
  // exposes AbortSignal.timeout() (declared in package.json engines).
  const r = await (globalThis.fetch)(`${baseUrl}/openapi.json`, { signal: AbortSignal.timeout(15000) });
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
    const pr = await (globalThis.fetch)(`${baseUrl}/api/pricing`, { signal: AbortSignal.timeout(15000) });
    if (!pr.ok) throw new Error(`Could not load ${baseUrl}/api/pricing: HTTP ${pr.status}`);
    const pricing = await pr.json();
    const free = new Set((pricing.endpoints || []).filter((e) => e.computePayable).map((e) => e.slug));
    for (let i = meta.length - 1; i >= 0; i--) if (!free.has(meta[i].slug)) meta.splice(i, 1);
  }

  // LangChain's DynamicStructuredTool wants a Zod schema. Convert from the
  // simple JSON Schema shapes Agent402 emits — keeps users off needing their
  // own Zod conversion step.
  const tools = meta.map((m) => new lc.DynamicStructuredTool({
    name: m.name,
    description: m.description,
    schema: jsonSchemaToZod(m.schema, z),
    // LangChain tool funcs must return a string — agents pipe this back into
    // the model. Stringify the structured JSON result.
    func: async (input) => JSON.stringify(await client.call(m.slug, input ?? {})),
  }));

  return { client, tools, execute: makeExecute(client, meta) };
}

async function loadLangChain() {
  try {
    return await import("@langchain/core/tools");
  } catch {
    throw new Error("agent402-langchain requires '@langchain/core' — install it with: npm install @langchain/core");
  }
}

async function loadZod() {
  try {
    return await import("zod");
  } catch {
    throw new Error("agent402-langchain requires 'zod' (a transitive dep of @langchain/core) — install it with: npm install zod");
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

// Minimal JSON Schema → Zod converter for the shapes Agent402 emits. Object
// schemas with primitive/array/object properties cover every tool in the
// catalog; anything we don't recognize falls back to z.any().
function jsonSchemaToZod(schema, z) {
  if (!schema || schema.type !== "object" || !schema.properties) return z.object({}).passthrough();
  const shape = {};
  const required = new Set(schema.required || []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    let s;
    switch (prop?.type) {
      case "string": s = z.string(); break;
      case "number": case "integer": s = z.number(); break;
      case "boolean": s = z.boolean(); break;
      case "array": s = z.array(z.any()); break;
      case "object": s = z.record(z.any()); break;
      default: s = z.any();
    }
    if (prop?.description) s = s.describe(prop.description);
    if (!required.has(key)) s = s.optional();
    shape[key] = s;
  }
  // passthrough() lets extra fields the model invents pass through to the
  // tool — Agent402 ignores unknowns anyway, and over-strict schemas confuse
  // LangChain agents.
  return z.object(shape).passthrough();
}

function shortDesc(summary, description) {
  const d = (description || summary || "").split("\n\n")[0].trim();
  return d.length > 280 ? d.slice(0, 277) + "..." : d;
}

export default agent402Tools;
