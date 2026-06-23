// agent402-langchain — turn Agent402 into LangChain.js tools the agent can
// pick up directly. Four meta tools, all free to discover:
//
//   agent402_find    — local catalog resolver  (POST /api/find)
//   agent402_route   — cross-seller x402 router  (POST /api/route)
//   agent402_call    — call a tool by slug, auto-pays (PoW free / x402 paid)
//   agent402_about   — service manifest  (GET /.well-known/x402)
//
// Why four and not "one tool per slug"? Frameworks balk at registering 1,293
// tools at once and the LLM can't reason over that many entries. Routing-as-
// discovery means the LLM picks a task, the router picks the seller, and the
// caller handles payment — exactly the wedge that makes Agent402 the default.
//
//   import { agent402Tools } from "agent402-langchain";
//   const tools = await agent402Tools();              // free tier (PoW)
//   // or, for wallet-required tools, supply an x402 fetch:
//   const tools = await agent402Tools({ fetch: payFetch });
//
// `agent402ToolSpecs()` returns the same four entries as framework-agnostic
// specs (plain JSON Schemas, plain async `execute`). Useful if you don't want
// the LangChain dep, or if you're wrapping the tools yourself.
//
// Implementation note: we inline the proof-of-work solver + call orchestration
// (~30 LoC) instead of depending on agent402-client at runtime, so this package
// stays zero-dep beyond its (optional) framework peers.
import { createHash } from "node:crypto";

const DEFAULT_BASE = "https://agent402.tools";

const leadingZeroBits = (buf) => {
  let n = 0;
  for (const b of buf) {
    if (b === 0) { n += 8; continue; }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
};

// Solve a proof-of-work challenge (from /api/pow/challenge) into the
// X-Pow-Solution header value the paywall expects.
function solvePow({ challenge, difficulty, token }) {
  let n = 0;
  while (leadingZeroBits(createHash("sha256").update(`${challenge}:${n}`).digest()) < difficulty) n++;
  return `${token}:${n}`;
}

/**
 * Framework-agnostic tool specs. `execute(input)` returns the JSON result
 * (or throws on HTTP error).
 */
export function agent402ToolSpecs({ baseUrl = DEFAULT_BASE, fetch: payFetch, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("No fetch available — pass { fetchImpl } on Node < 18");
  const base = String(baseUrl).replace(/\/$/, "");
  const getJSON = async (path) => {
    const r = await fetchImpl(`${base}${path}`);
    if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
    return r.json();
  };
  const postJSON = async (path, body) => {
    const r = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path}: HTTP ${r.status}`);
    return r.json();
  };
  return [
    {
      name: "agent402_find",
      description:
        "Resolve a plain-language task to the best Agent402 tool — returns slug, route, price, input schema, and a ready example so you skip the explore step. Local catalog only; for cross-seller use agent402_route.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: 'What you want to do, e.g. "extract the article from this URL"' },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["task"],
      },
      execute: ({ task, limit }) => getJSON(`/api/find?q=${encodeURIComponent(task)}&k=${limit || 5}`),
    },
    {
      name: "agent402_route",
      description:
        "Cross-seller x402 router: rank matching tools across every x402 seller (Agent402's catalog + competitors auto-discovered from the Coinbase CDP Bazaar). Filters out unhealthy sellers, tiebreaks on health then price. include='external' excludes Agent402 itself — use as a neutral discovery API over the rest of the ecosystem.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: 'Task description, e.g. "ocr image to text"' },
          top: { type: "number", description: "Max results (default 5)" },
          include: { type: "string", enum: ["all", "external", "local"], description: "all (default) | external (exclude Agent402) | local (Agent402 only)" },
        },
        required: ["query"],
      },
      execute: ({ query, top, include }) => postJSON(`/api/route`, { query, top: top || 5, include: include || "all" }),
    },
    {
      name: "agent402_call",
      description:
        "Call an Agent402 tool by slug. Pays automatically: pure-CPU tools settle via built-in proof-of-work (no wallet), wallet-only tools settle via the x402 fetch you configured (USDC on Base). Returns the parsed JSON result.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: 'Tool slug, e.g. "hash" or "extract"' },
          params: { type: "object", description: "Tool input, matching the tool's inputSchema (use agent402_find to discover)" },
        },
        required: ["slug"],
      },
      execute: async ({ slug, params }) => callTool({ base, slug, params: params || {}, payFetch, fetchImpl }),
    },
    {
      name: "agent402_about",
      description:
        "Return the Agent402 service manifest (/.well-known/x402): identity, payment options (x402 networks + proof-of-work), capability map, MCP connector, the neutral cross-seller discovery surface, and trust signals.",
      parametersJsonSchema: { type: "object", properties: {} },
      execute: () => getJSON(`/.well-known/x402`),
    },
  ];
}

// One-shot tool invocation: resolve the slug → call the route, auto-paying via
// proof-of-work (free tier) or the user's x402 fetch (wallet-required tools).
// Mirrors agent402-client.call() behavior so this package stays zero-dep.
async function callTool({ base, slug, params, payFetch, fetchImpl }) {
  const pricingRes = await fetchImpl(`${base}/api/pricing`);
  if (!pricingRes.ok) throw new Error(`could not load catalog: HTTP ${pricingRes.status}`);
  const pricing = await pricingRes.json();
  const entry = (pricing.endpoints || []).find((e) => e.slug === slug);
  if (!entry) throw new Error(`unknown tool "${slug}" — use agent402_find or agent402_route to discover one`);

  const idem = `a402lc-${createHash("sha256").update(`${slug}:${JSON.stringify(params)}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24)}`;
  const send = (extraHeaders = {}, useFetch = fetchImpl) => {
    const headers = { "Idempotency-Key": idem, ...extraHeaders };
    let url = `${base}${entry.path}`;
    const init = { method: entry.method, headers };
    if (entry.method === "GET") {
      const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])).toString();
      if (qs) url += `?${qs}`;
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(params);
    }
    return useFetch(url, init);
  };

  // Wallet-only tool: route through the user's x402 fetch.
  if (!entry.computePayable) {
    const r = payFetch ? await send({}, payFetch) : await send();
    if (!r.ok) {
      throw new Error(
        payFetch
          ? `call "${slug}" failed: HTTP ${r.status}`
          : `call "${slug}" needs a wallet — construct with { fetch: payFetch } (an @x402/fetch-wrapped fetch)`,
      );
    }
    return r.json();
  }

  // Compute-payable tool: try unpaywalled first (FREE_MODE instance), fall back
  // to proof-of-work using the server-issued challenge.
  let r = await send();
  if (!r.ok) {
    const challengeRes = await fetchImpl(`${base}/api/pow/challenge?slug=${encodeURIComponent(slug)}`);
    if (!challengeRes.ok) throw new Error(`proof-of-work challenge for "${slug}" failed: HTTP ${challengeRes.status}`);
    const chal = await challengeRes.json();
    r = await send({ "X-Pow-Solution": solvePow(chal) });
  }
  if (!r.ok) throw new Error(`call "${slug}" failed after proof-of-work: HTTP ${r.status}`);
  return r.json();
}

/**
 * Framework-native LangChain.js tools. Dynamically imports `@langchain/core`
 * and `zod` (both peer dependencies) so the spec path works without them.
 */
export async function agent402Tools(opts) {
  const [{ tool }, { z }] = await Promise.all([
    import("@langchain/core/tools"),
    import("zod"),
  ]);
  const specs = agent402ToolSpecs(opts);
  return specs.map((s) =>
    tool(s.execute, {
      name: s.name,
      description: s.description,
      schema: jsonSchemaToZod(s.parametersJsonSchema, z),
    }),
  );
}

// Minimal JSON-Schema → Zod converter for the shapes we emit. Not a general
// solution — it covers `object` with primitive/enum/object properties and the
// `required` list. Keeps a zero-fat dep on zod's surface.
function jsonSchemaToZod(schema, z) {
  if (!schema || schema.type !== "object") return z.object({});
  const shape = {};
  const required = new Set(schema.required || []);
  for (const [k, prop] of Object.entries(schema.properties || {})) {
    let s;
    if (prop.enum) s = z.enum(prop.enum);
    else if (prop.type === "string") s = z.string();
    else if (prop.type === "number") s = z.number();
    else if (prop.type === "boolean") s = z.boolean();
    else if (prop.type === "object") s = z.record(z.any());
    else s = z.any();
    if (prop.description) s = s.describe(prop.description);
    if (!required.has(k)) s = s.optional();
    shape[k] = s;
  }
  return z.object(shape);
}

export default agent402Tools;
