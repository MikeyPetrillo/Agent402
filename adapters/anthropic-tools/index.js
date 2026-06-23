// agent402-anthropic-tools — drop-in Anthropic tool-use tools for Agent402.
//
// Turn the Agent402 catalog (1,280 pay-per-call web tools) into Claude tool
// definitions the model can invoke, with payment handled for you under the
// hood by agent402-client (proof-of-work for the free tier, x402+USDC for
// wallet-only tools when you pass a payFetch).
//
//   import Anthropic from "@anthropic-ai/sdk";
//   import { agent402Tools } from "agent402-anthropic-tools";
//
//   const client = new Anthropic();
//   const { tools, execute } = await agent402Tools({ slugs: ["extract","hash","render"] });
//
//   const res = await client.messages.create({
//     model: "claude-sonnet-4-6",
//     max_tokens: 1024,
//     tools,
//     messages: [{ role: "user", content: "Get the title of https://example.com/article" }],
//   });
//   // when the model returns a tool_use block:
//   //   const out = await execute(block.name, block.input);

import { Agent402 } from "agent402-client";

const DEFAULT_BASE = "https://agent402.tools";

// Anthropic tool names: ^[a-zA-Z0-9_-]{1,64}$ (same as OpenAI). Slugs already conform.
const sanitizeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/**
 * Fetch the Agent402 catalog and return:
 *   - `tools`:    Anthropic tool definitions (array of { name, description, input_schema })
 *   - `execute`:  async (name, input) => result — pays under the hood
 *   - `client`:   the underlying Agent402 client (use for find()/clearCache())
 *
 * @param {object} [opts]
 * @param {string}   [opts.baseUrl="https://agent402.tools"]
 * @param {string[]} [opts.slugs]    Restrict to these slugs (recommended; smaller tool list = better tool-selection)
 * @param {boolean}  [opts.freeOnly=true]  Default: only include compute-payable tools (no wallet needed)
 * @param {typeof fetch} [opts.fetch]      An x402-wrapped fetch (only needed for wallet-only tools)
 */
export async function agent402Tools({ baseUrl = DEFAULT_BASE, slugs, freeOnly = true, fetch: payFetch } = {}) {
  const client = new Agent402({ baseUrl, fetch: payFetch });
  // Bounded discovery fetch: caller picks baseUrl, so cap the wait. Node ≥18
  // exposes AbortSignal.timeout() (declared in package.json engines).
  const r = await (globalThis.fetch)(`${baseUrl}/openapi.json`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Could not load ${baseUrl}/openapi.json: HTTP ${r.status}`);
  const spec = await r.json();

  const wanted = slugs ? new Set(slugs) : null;
  const tools = [];
  const slugByName = new Map();

  for (const [, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      const slug = op.operationId?.replace(/Get$/, "");
      if (!slug) continue;
      if (wanted && !wanted.has(slug)) continue;

      const input_schema = method.toLowerCase() === "get"
        ? {
            type: "object",
            properties: Object.fromEntries((op.parameters || []).map((p) => [p.name, { type: p.schema?.type || "string", description: p.description }])),
            required: (op.parameters || []).filter((p) => p.required).map((p) => p.name),
          }
        : op.requestBody?.content?.["application/json"]?.schema || { type: "object", properties: {} };

      // Anthropic requires `type: "object"` at the top level; harmless on JSON-schema bodies that already have it.
      if (input_schema && !input_schema.type) input_schema.type = "object";

      const name = sanitizeName(slug);
      slugByName.set(name, slug);
      tools.push({
        name,
        description: shortDesc(op.summary, op.description),
        input_schema,
      });
    }
  }

  // /openapi.json doesn't carry computePayable, but /api/pricing does.
  if (freeOnly) {
    const pr = await (globalThis.fetch)(`${baseUrl}/api/pricing`, { signal: AbortSignal.timeout(15000) });
    if (!pr.ok) throw new Error(`Could not load ${baseUrl}/api/pricing: HTTP ${pr.status}`);
    const pricing = await pr.json();
    const free = new Set((pricing.endpoints || []).filter((e) => e.computePayable).map((e) => e.slug));
    return {
      client,
      tools: tools.filter((t) => free.has(slugByName.get(t.name))),
      execute: makeExecute(client, slugByName),
    };
  }

  return { client, tools, execute: makeExecute(client, slugByName) };
}

function makeExecute(client, slugByName) {
  return async function execute(name, input) {
    const slug = slugByName.get(name) || name;
    return client.call(slug, input ?? {});
  };
}

/**
 * Standalone executor for users who built their tool list a different way.
 * Returns an `execute(name, input)` that calls Agent402 with PoW or x402 payment.
 */
export function agent402Execute({ baseUrl = DEFAULT_BASE, fetch: payFetch } = {}) {
  const client = new Agent402({ baseUrl, fetch: payFetch });
  return async function execute(name, input) {
    return client.call(name, input ?? {});
  };
}

function shortDesc(summary, description) {
  const d = (description || summary || "").split("\n\n")[0].trim();
  return d.length > 280 ? d.slice(0, 277) + "..." : d;
}

export default agent402Tools;
