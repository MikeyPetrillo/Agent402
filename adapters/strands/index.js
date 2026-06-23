// agent402-strands — drop-in Strands Agents (TypeScript) tools for Agent402.
//
// Turn the Agent402 catalog (1,280 pay-per-call web tools) into Strands
// `tool({...})` instances the agent can invoke, with payment handled for you
// under the hood by agent402-client (proof-of-work for the free tier,
// x402+USDC for wallet-only tools when you pass a payFetch).
//
//   import { Agent } from "@strands-agents/sdk";
//   import { agent402Tools } from "agent402-strands";
//
//   const { tools } = await agent402Tools({ slugs: ["extract","hash","render"] });
//   const agent = new Agent({ tools });
//   const out = await agent.invoke("Hash 'hello world' with sha256");
//
// Built for AWS Bedrock AgentCore: Strands is the framework AgentCore Payments
// surfaces as its preferred SDK, and AgentCore Payments orchestrates x402 —
// which is exactly what Agent402 speaks. The two halves snap together with
// zero glue beyond this adapter.

import { Agent402 } from "agent402-client";

const DEFAULT_BASE = "https://agent402.tools";

// Strands tool names — function-name shape, conservative.
const sanitizeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/**
 * Fetch the Agent402 catalog and return:
 *   - `tools`:    Strands Tool[] ready to pass to `new Agent({ tools })`
 *   - `execute`:  async (name, args) => result — pays under the hood
 *   - `client`:   the underlying Agent402 client (use for find()/clearCache())
 *
 * @param {object} [opts]
 * @param {string}   [opts.baseUrl="https://agent402.tools"]
 * @param {string[]} [opts.slugs]    Restrict to these slugs (recommended; smaller tool list = better tool-selection)
 * @param {boolean}  [opts.freeOnly=true]  Default: only include compute-payable tools (no wallet needed)
 * @param {typeof fetch} [opts.fetch]      An x402-wrapped fetch (only needed for wallet-only tools)
 */
export async function agent402Tools({ baseUrl = DEFAULT_BASE, slugs, freeOnly = true, fetch: payFetch } = {}) {
  const [strands, zodMod] = await Promise.all([loadStrands(), loadZod()]);
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

  // Strands `tool({...})` accepts a Zod schema directly. Convert from the
  // simple JSON Schema shapes Agent402 emits — keeps users off needing their
  // own conversion step. Strands callbacks can return any JSON-serializable
  // value directly, so no string-wrapping step is needed here.
  const tools = meta.map((m) => strands.tool({
    name: m.name,
    description: m.description,
    inputSchema: jsonSchemaToZod(m.schema, z),
    callback: async (input) => client.call(m.slug, input ?? {}),
  }));

  return { client, tools, execute: makeExecute(client, meta) };
}

async function loadStrands() {
  try {
    return await import("@strands-agents/sdk");
  } catch {
    throw new Error("agent402-strands requires '@strands-agents/sdk' — install it with: npm install @strands-agents/sdk");
  }
}

async function loadZod() {
  try {
    return await import("zod");
  } catch {
    throw new Error("agent402-strands requires 'zod' — install it with: npm install zod");
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
  // agents.
  return z.object(shape).passthrough();
}

function shortDesc(summary, description) {
  const d = (description || summary || "").split("\n\n")[0].trim();
  return d.length > 280 ? d.slice(0, 277) + "..." : d;
}

export default agent402Tools;
