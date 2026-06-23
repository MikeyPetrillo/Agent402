// agent402-openai-tools — drop-in OpenAI function-calling tools for Agent402.
//
// Turn the Agent402 catalog (1,275 pay-per-call web tools) into OpenAI tool
// definitions the model can invoke, with payment handled for you under the
// hood by agent402-client (proof-of-work for the free tier, x402+USDC for
// wallet-only tools when you pass a payFetch).
//
//   import OpenAI from "openai";
//   import { agent402Tools, agent402Execute } from "agent402-openai-tools";
//
//   const openai = new OpenAI();
//   const { tools, execute } = await agent402Tools({ slugs: ["extract","hash","render"] });
//
//   const res = await openai.chat.completions.create({
//     model: "gpt-4o-mini",
//     messages: [{ role: "user", content: "Get the title of https://example.com/article" }],
//     tools,
//   });
//   // when the model returns a tool call:
//   //   const out = await execute(call.function.name, JSON.parse(call.function.arguments));
//
// Works with chat.completions, the Assistants v2 API, and the Responses API —
// they all consume the same OpenAI function-calling JSON shape.

import { Agent402 } from "agent402-client";

const DEFAULT_BASE = "https://agent402.tools";

// OpenAI's function-calling spec requires names matching ^[a-zA-Z0-9_-]{1,64}$.
// Agent402 slugs already conform, but be defensive in case of self-hosted catalogs.
const sanitizeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/**
 * Fetch the Agent402 catalog and return:
 *   - `tools`:    OpenAI function-calling tool definitions (array)
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
  const client = new Agent402({ baseUrl, fetch: payFetch });
  // Bounded discovery fetch: caller picks baseUrl, so cap the wait. Node ≥18
  // exposes AbortSignal.timeout() (declared in package.json engines).
  const r = await (globalThis.fetch)(`${baseUrl}/openapi.json`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Could not load ${baseUrl}/openapi.json: HTTP ${r.status}`);
  const spec = await r.json();

  const wanted = slugs ? new Set(slugs) : null;
  const tools = [];
  const slugByName = new Map();

  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      const slug = op.operationId?.replace(/Get$/, "");
      if (!slug) continue;
      if (wanted && !wanted.has(slug)) continue;

      const parameters = method.toLowerCase() === "get"
        ? {
            type: "object",
            properties: Object.fromEntries((op.parameters || []).map((p) => [p.name, { type: p.schema?.type || "string", description: p.description }])),
            required: (op.parameters || []).filter((p) => p.required).map((p) => p.name),
          }
        : op.requestBody?.content?.["application/json"]?.schema || { type: "object", properties: {} };

      const computePayable = !!op["x-compute-payable"] || op.summary?.includes("FREE");
      // If freeOnly and we can't tell, fall back to /api/pricing for the truth.
      // We do that lookup once below.
      const name = sanitizeName(slug);
      slugByName.set(name, slug);
      tools.push({
        type: "function",
        function: {
          name,
          description: shortDesc(op.summary, op.description),
          parameters,
        },
      });
    }
  }

  // Authoritative freeOnly filter: /openapi.json doesn't carry computePayable,
  // but /api/pricing does. One extra HTTP call, cached for the life of the result.
  if (freeOnly) {
    const pr = await (globalThis.fetch)(`${baseUrl}/api/pricing`, { signal: AbortSignal.timeout(15000) });
    if (!pr.ok) throw new Error(`Could not load ${baseUrl}/api/pricing: HTTP ${pr.status}`);
    const pricing = await pr.json();
    const free = new Set((pricing.endpoints || []).filter((e) => e.computePayable).map((e) => e.slug));
    return {
      client,
      tools: tools.filter((t) => free.has(slugByName.get(t.function.name))),
      execute: makeExecute(client, slugByName),
    };
  }

  return { client, tools, execute: makeExecute(client, slugByName) };
}

function makeExecute(client, slugByName) {
  return async function execute(name, args) {
    const slug = slugByName.get(name) || name;
    return client.call(slug, args ?? {});
  };
}

/**
 * Standalone executor for users who built their tool list a different way
 * (e.g. generated server-side, persisted in a database). Returns an
 * `execute(name, args)` that calls Agent402 with PoW or x402 payment.
 */
export function agent402Execute({ baseUrl = DEFAULT_BASE, fetch: payFetch } = {}) {
  const client = new Agent402({ baseUrl, fetch: payFetch });
  return async function execute(name, args) {
    return client.call(name, args ?? {});
  };
}

function shortDesc(summary, description) {
  // OpenAI tool descriptions should be concise — long descriptions hurt
  // tool-selection. Take the first sentence of the description.
  const d = (description || summary || "").split("\n\n")[0].trim();
  return d.length > 280 ? d.slice(0, 277) + "..." : d;
}

export default agent402Tools;
