// elizaOS plugin for Agent402: three actions (find / call / about) and one
// context provider. No runtime import of @elizaos/core (types only), so the
// package installs with nothing but agent402-client.
//
// Payment: a prepaid card-credits key (AGENT402_CREDITS_KEY) or an x402 wallet
// (AGENT402_WALLET_KEY, with @x402/fetch + @x402/evm + viem present). Free-tier
// tools pay with proof-of-work and need neither. Spend bounds ride with every
// paid call (AGENT402_MAX_PER_CALL_USD, default $1; AGENT402_DAILY_LIMIT_USD).
import { Agent402 } from "agent402-client";

const DEFAULT_BASE = "https://agent402.tools";
const setting = (runtime, key) => {
  const v = runtime?.getSetting?.(key);
  return typeof v === "string" && v.trim() ? v.trim() : (process.env[key] || "").trim() || null;
};
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

let payFetchCache = null; // key -> Promise<fetch|null>
async function payFetchFromKey(pk, fetchImpl) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk || "")) return null;
  if (payFetchCache && payFetchCache.key === pk) return payFetchCache.value;
  const value = (async () => {
    try {
      const [{ wrapFetchWithPayment, x402Client }, { privateKeyToAccount }, { toClientEvmSigner }, { registerExactEvmScheme }] = await Promise.all([
        import("@x402/fetch"), import("viem/accounts"), import("@x402/evm"), import("@x402/evm/exact/client"),
      ]);
      const client = new x402Client();
      registerExactEvmScheme(client, { signer: toClientEvmSigner(privateKeyToAccount(pk)) });
      return wrapFetchWithPayment(fetchImpl, client);
    } catch { return null; } // peers absent: free tier + credits still work
  })();
  payFetchCache = { key: pk, value };
  return value;
}

/** One client per runtime call: settings are read at call time so a key
 *  rotated in the character config takes effect without a restart. */
async function clientFor(runtime, fetchImpl = globalThis.fetch) {
  const baseUrl = (setting(runtime, "AGENT402_BASE_URL") || DEFAULT_BASE).replace(/\/+$/, "");
  const creditsKey = setting(runtime, "AGENT402_CREDITS_KEY");
  const walletKey = setting(runtime, "AGENT402_WALLET_KEY");
  const payFetch = creditsKey ? undefined : await payFetchFromKey(walletKey, fetchImpl) || undefined;
  return new Agent402({
    baseUrl, fetchImpl, fetch: payFetch, creditsKey: creditsKey || null,
    maxPerCallUsd: num(setting(runtime, "AGENT402_MAX_PER_CALL_USD"), 1),
    dailyLimitUsd: num(setting(runtime, "AGENT402_DAILY_LIMIT_USD"), null),
  });
}

const textOf = (message) => String(message?.content?.text ?? "").trim();
// Structured input first (an agent or a test hands {task}/{slug, params} in
// content); the message text is the fallback for a human typing.
const fieldOf = (message, key) => message?.content?.[key] ?? message?.content?.input?.[key];

const reply = async (callback, result) => { if (typeof callback === "function") { try { await callback({ text: result.text, ...(result.data ? { data: result.data } : {}) }); } catch { /* the runtime owns delivery */ } } return result; };

export const findAction = {
  name: "AGENT402_FIND",
  similes: ["FIND_TOOL", "SEARCH_AGENT402", "FIND_AGENT402_TOOL", "WHICH_TOOL"],
  description:
    "Find an Agent402 tool for a task. Agent402 is a catalog of 500+ deterministic pay-per-call web tools (web search, " +
    "browser render, PDFs, OCR, market and crypto data, SEC filings, DNS/TLS checks, memory). Returns the best matches " +
    "with slug, price, whether a wallet or credits key is needed, and a ready example input. Free: nothing is paid.",
  examples: [[
    { name: "user", content: { text: "Find a tool that extracts the article text from a URL" } },
    { name: "agent", content: { text: "Agent402 has `extract` ($0.005 per call) for that. I can call it with { url }.", actions: ["AGENT402_FIND"] } },
  ]],
  validate: async () => true,
  handler: async (runtime, message, _state, options, callback) => {
    const task = String(fieldOf(message, "task") ?? options?.task ?? textOf(message)).trim();
    if (!task) return reply(callback, { success: false, text: "Tell me what you need done and I will find the Agent402 tool for it." });
    try {
      const client = await clientFor(runtime);
      const rows = await client.find(task, { k: num(fieldOf(message, "k") ?? options?.k, 5) });
      const results = (rows || []).map((t) => ({
        slug: t.slug, name: t.name, price: t.price, route: t.route,
        needsPayment: t.computePayable === false || t.walletOnly === true,
        description: t.description, example: t.example ?? t.input ?? null,
      }));
      const top = results[0];
      const text = top
        ? `Best Agent402 match: \`${top.slug}\` (${top.price}) - ${top.description}${results.length > 1 ? ` Also: ${results.slice(1, 4).map((r) => `\`${r.slug}\` (${r.price})`).join(", ")}.` : ""}`
        : `No Agent402 tool matched "${task}".`;
      return reply(callback, { success: true, text, data: { task, results } });
    } catch (e) {
      return reply(callback, { success: false, text: `Agent402 find failed: ${String(e?.message || e).slice(0, 200)}` });
    }
  },
};

export const callAction = {
  name: "AGENT402_CALL",
  similes: ["CALL_TOOL", "RUN_AGENT402_TOOL", "USE_AGENT402", "CALL_AGENT402"],
  description:
    "Call an Agent402 tool by slug (from AGENT402_FIND) with its input and return the tool's JSON result. Pays for the " +
    "call: proof-of-work for free-tier tools; the configured credits key (card) or x402 wallet (USDC) for wallet-only " +
    "tools, typically $0.001 to $0.05, never above AGENT402_MAX_PER_CALL_USD. Provide `slug` and `params` in the content.",
  examples: [[
    { name: "user", content: { text: "Hash 'hello world' with sha256", slug: "hash", params: { text: "hello world", algo: "sha256" } } },
    { name: "agent", content: { text: "sha256(\"hello world\") = b94d27b9…", actions: ["AGENT402_CALL"] } },
  ]],
  validate: async (_runtime, message) => Boolean(fieldOf(message, "slug")),
  handler: async (runtime, message, _state, options, callback) => {
    const slug = String(fieldOf(message, "slug") ?? options?.slug ?? "").trim();
    if (!slug) return reply(callback, { success: false, text: "AGENT402_CALL needs a tool slug (use AGENT402_FIND first)." });
    const params = fieldOf(message, "params") ?? options?.params ?? {};
    try {
      const client = await clientFor(runtime);
      const out = await client.call(slug, params && typeof params === "object" ? params : {});
      const data = out && typeof out === "object" ? out : { result: out };
      const preview = JSON.stringify(data);
      return reply(callback, { success: true, text: `Agent402 \`${slug}\` returned: ${preview.length > 600 ? `${preview.slice(0, 600)}…` : preview}`, data: { slug, params, result: data } });
    } catch (e) {
      const msg = String(e?.message || e);
      const hint = /wallet-only|402/.test(msg) ? " Set AGENT402_CREDITS_KEY (buy a pack at https://agent402.tools/credits) or AGENT402_WALLET_KEY to pay for this tool." : "";
      return reply(callback, { success: false, text: `Agent402 \`${slug}\` failed: ${msg.slice(0, 200)}${hint}` });
    }
  },
};

export const aboutAction = {
  name: "AGENT402_ABOUT",
  similes: ["WHAT_IS_AGENT402", "AGENT402_INFO"],
  description: "What Agent402 is, how it is paid, and how many tools it serves right now. Free.",
  examples: [[
    { name: "user", content: { text: "What is Agent402?" } },
    { name: "agent", content: { text: "Agent402 is a catalog of 500+ pay-per-call web tools, paid by card credits or USDC over x402.", actions: ["AGENT402_ABOUT"] } },
  ]],
  validate: async () => true,
  handler: async (runtime, _message, _state, _options, callback) => {
    const baseUrl = (setting(runtime, "AGENT402_BASE_URL") || DEFAULT_BASE).replace(/\/+$/, "");
    try {
      const r = await fetch(`${baseUrl}/api/pricing`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const p = await r.json();
      const endpoints = p.endpoints || [];
      const data = {
        name: "Agent402", baseUrl, tools: endpoints.length, freeTier: endpoints.filter((e) => e.computePayable).length,
        pay: "prepaid card credits (AGENT402_CREDITS_KEY) or USDC over x402 from a wallet (AGENT402_WALLET_KEY); free-tier tools pay with proof-of-work",
        discover: `${baseUrl}/api/find?q=<task>`, docs: `${baseUrl}/llms.txt`, why: `${baseUrl}/why`,
      };
      return reply(callback, { success: true, text: `Agent402 serves ${data.tools} deterministic pay-per-call tools (${data.freeTier} on the free tier), paid by card credits or USDC over x402. Docs: ${data.docs}`, data });
    } catch (e) {
      return reply(callback, { success: false, text: `Agent402 is unreachable at ${baseUrl}: ${String(e?.message || e).slice(0, 120)}` });
    }
  },
};

/** Context the agent sees on every turn: that the catalog exists and how to use it. */
export const agent402Provider = {
  name: "AGENT402",
  description: "Agent402 pay-per-call tool catalog: how to find and call a tool.",
  get: async (runtime) => {
    const baseUrl = (setting(runtime, "AGENT402_BASE_URL") || DEFAULT_BASE).replace(/\/+$/, "");
    const paid = setting(runtime, "AGENT402_CREDITS_KEY") ? "card credits" : /^0x[0-9a-fA-F]{64}$/.test(setting(runtime, "AGENT402_WALLET_KEY") || "") ? "x402 wallet" : "free tier only (no credits key or wallet configured)";
    const text = `Agent402 (${baseUrl}) offers 500+ deterministic pay-per-call web tools. Use AGENT402_FIND with a plain-language task to get a slug and example input, then AGENT402_CALL with that slug and params. Payment mode: ${paid}.`;
    return { text, values: { agent402BaseUrl: baseUrl, agent402PaymentMode: paid }, data: {} };
  },
};

export const agent402Plugin = {
  name: "agent402",
  description: "Find and call 500+ pay-per-call web tools from Agent402, paid by prepaid card credits or USDC over x402.",
  actions: [findAction, callAction, aboutAction],
  providers: [agent402Provider],
  init: async (config, runtime) => {
    const hasKey = Boolean(setting(runtime, "AGENT402_CREDITS_KEY") || config?.AGENT402_CREDITS_KEY);
    const hasWallet = /^0x[0-9a-fA-F]{64}$/.test(setting(runtime, "AGENT402_WALLET_KEY") || config?.AGENT402_WALLET_KEY || "");
    if (!hasKey && !hasWallet) console.warn("[agent402] no AGENT402_CREDITS_KEY or AGENT402_WALLET_KEY: free-tier tools only (buy credits at https://agent402.tools/credits)");
  },
};

export default agent402Plugin;
