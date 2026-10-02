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
// The runtime owns configuration: runtime.getSetting() reads the character's
// settings/secrets and, in elizaOS, the process environment behind them. The
// plugin reads nothing else, so a host that scopes settings per agent is
// honoured (0.2.0: an earlier process.env fallback here could read another
// agent's ceiling in a multi-agent process).
const setting = (runtime, key) => {
  const v = runtime?.getSetting?.(key);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() ? v.trim() : null;
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
      client.setSpendControls?.(false); // @x402/core 2.23+ defaults to a $1 pegged-assets-only cap; this package bounds spend itself
      registerExactEvmScheme(client, { signer: toClientEvmSigner(privateKeyToAccount(pk)) });
      return wrapFetchWithPayment(fetchImpl, client);
    } catch { return null; } // peers absent: free tier + credits still work
  })();
  payFetchCache = { key: pk, value };
  return value;
}

/** ONE client per runtime, kept for the runtime's lifetime. Settings are still
 *  read on every call so a key rotated in the character config takes effect
 *  without a restart - but the client's rolling-24h spend ledger is CARRIED
 *  across that rebuild. Before 0.2.0 a fresh client was built per call, which
 *  meant AGENT402_DAILY_LIMIT_USD bounded each call alone: the ledger it counts
 *  against was empty every time (registry review, 2026-09-14). */
const clients = new WeakMap(); // runtime -> { sig, client }
async function clientFor(runtime, fetchImpl = globalThis.fetch) {
  const baseUrl = (setting(runtime, "AGENT402_BASE_URL") || DEFAULT_BASE).replace(/\/+$/, "");
  const creditsKey = setting(runtime, "AGENT402_CREDITS_KEY");
  const walletKey = setting(runtime, "AGENT402_WALLET_KEY");
  const maxPerCallUsd = num(setting(runtime, "AGENT402_MAX_PER_CALL_USD"), 1);
  const dailyLimitUsd = num(setting(runtime, "AGENT402_DAILY_LIMIT_USD"), null);
  const sig = JSON.stringify([baseUrl, creditsKey, walletKey, maxPerCallUsd, dailyLimitUsd]);
  const key = runtime && typeof runtime === "object" ? runtime : clientFor;
  const prev = clients.get(key);
  if (prev?.sig === sig) return prev.client;
  const payFetch = creditsKey ? undefined : await payFetchFromKey(walletKey, fetchImpl) || undefined;
  const client = new Agent402({ baseUrl, fetchImpl, fetch: payFetch, creditsKey: creditsKey || null, maxPerCallUsd, dailyLimitUsd });
  // The ledger outlives the client: what was spent under the old settings was
  // still spent. (The client keeps it as a plain array; sharing the array is
  // the whole mechanism.)
  if (prev?.client?._spend?.log && client._spend) client._spend.log = prev.client._spend.log;
  clients.set(key, { sig, client });
  return client;
}

/** Rolling-24h spend as the client sees it (for tests and operators). */
export function spendingSummaryFor(runtime) {
  const c = clients.get(runtime && typeof runtime === "object" ? runtime : clientFor)?.client;
  return c && typeof c.spendingSummary === "function" ? c.spendingSummary() : null;
}

const textOf = (message) => String(message?.content?.text ?? "").trim();
// Structured input first (an agent or a test hands {task}/{slug, params} in
// content); the message text is the fallback for a human typing.
const fieldOf = (message, key) => message?.content?.[key] ?? message?.content?.input?.[key];

// WHAT THE MODEL SEES. In elizaOS 1.x the ACTION_STATE provider renders an
// action result's `text` (and `values`, and `error`) into the next prompt;
// `data` is kept in working memory and the action-result memory but is NOT
// rendered unless `text` is empty. So the tool's result has to ride in `text`
// or the planner never sees it - and it rides COMPLETE. 0.2.0 sent a 12,000-
// character prefix with a notice; the registry review (2026-09-15) was right
// that a notice is not the evidence, so there is no truncation anywhere now.
// A host that must bound its context sets AGENT402_MAX_RESULT_CHARS, and a
// result over that bound is an explicit FAILURE carrying the whole result in
// data.result - never a partial payload presented as the answer.
const MAX_RESULT_CHARS = () => num(process.env.AGENT402_MAX_RESULT_CHARS, null);
function resultText(slug, json) {
  return `Agent402 \`${slug}\` result (complete JSON): ${json}`;
}
// Whole, never sliced: the seller's own 4xx detail is what lets a planner
// correct its input, and a bound here would hide exactly the useful part.
const errorText = (e) => String(e?.message || e);

// Typed failure states, so a consumer can branch on data.errorCode instead of
// parsing prose (registry review, 2026-09-15: "propagate typed invalid/
// unavailable states before any paid dispatch instead of manufacturing
// valid-looking defaults").
const failure = (code, text, extra = {}) => ({ success: false, text, error: text, data: { actionName: "AGENT402_CALL", errorCode: code, ...extra } });

/** The v2 runtime hands extracted parameters in `options.parameters`; a 1.x
 *  runtime hands nothing structured, so a test or another plugin may put them
 *  in the message content. Both are read; content wins only where options has
 *  no value. */
const param = (message, options, key) =>
  options?.parameters?.[key] ?? options?.[key] ?? fieldOf(message, key);

const reply = async (callback, result) => { if (typeof callback === "function") { try { await callback({ text: result.text, ...(result.data ? { data: result.data } : {}) }); } catch { /* the runtime owns delivery */ } } return result; };

export const findAction = {
  name: "AGENT402_FIND",
  similes: ["FIND_TOOL", "SEARCH_AGENT402", "FIND_AGENT402_TOOL", "WHICH_TOOL"],
  description:
    "Find an Agent402 tool for a task (web search, page render, PDFs, OCR, market and crypto data, SEC filings, DNS/TLS " +
    "checks). Returns the best matches with slug, price, whether payment is needed, and an example input. Free: nothing is paid.",
  parameters: [
    { name: "task", description: "What you need done, in plain language", required: true, schema: { type: "string" } },
    { name: "k", description: "How many matches to return (default 5)", required: false, schema: { type: "integer", minimum: 1, maximum: 20 } },
  ],
  examples: [[
    { name: "user", content: { text: "Find a tool that extracts the article text from a URL" } },
    { name: "agent", content: { text: "Agent402 has `extract` ($0.005 per call) for that. I can call it with { url }.", actions: ["AGENT402_FIND"] } },
  ]],
  validate: async () => true,
  handler: async (runtime, message, _state, options, callback) => {
    const task = String(param(message, options, "task") ?? textOf(message)).trim();
    if (!task) return reply(callback, { success: false, text: "Tell me what you need done and I will find the Agent402 tool for it." });
    try {
      const client = await clientFor(runtime);
      const rows = await client.find(task, { k: num(param(message, options, "k"), 5) });
      const results = (rows || []).map((t) => ({
        slug: t.slug, name: t.name, price: t.price, route: t.route,
        needsPayment: t.computePayable === false || t.walletOnly === true,
        description: t.description, example: t.example ?? t.input ?? null,
      }));
      const top = results[0];
      const text = top
        ? `Best Agent402 match: \`${top.slug}\` (${top.price}) - ${top.description}${results.length > 1 ? ` Also: ${results.slice(1, 4).map((r) => `\`${r.slug}\` (${r.price})`).join(", ")}.` : ""}`
        : `No Agent402 tool matched "${task}".`;
      return reply(callback, { success: true, text, data: { actionName: "AGENT402_FIND", task, results } });
    } catch (e) {
      return reply(callback, { success: false, text: `Agent402 find failed: ${errorText(e)}`, error: errorText(e), data: { actionName: "AGENT402_FIND", errorCode: "catalog_unavailable" } });
    }
  },
};

/** Resolve {slug, params} for AGENT402_CALL from, in order: the runtime's
 *  extracted parameters (v2 `options.parameters`), structured content, the
 *  previous AGENT402_FIND result in this run, and finally - the 1.x path - the
 *  message text itself: the catalog is searched (free) and the runtime's own
 *  model is asked to pick the tool and shape its input from the candidates'
 *  declared schemas. Returns { slug, params, via } or { error }. */
export async function resolveCallInput(runtime, message, options, client) {
  const direct = param(message, options, "slug");
  if (direct) {
    const raw = param(message, options, "params") ?? param(message, options, "input");
    let params = raw;
    if (typeof raw === "string") {
      // A string is accepted only if it is valid JSON for an object. Anything
      // else is an INVALID state, reported before any dispatch - never {}.
      try { params = JSON.parse(raw); } catch { return { errorCode: "invalid_parameters", error: `AGENT402_CALL params must be a JSON object; got a string that is not valid JSON: ${raw}` }; }
    }
    if (params == null) params = {};
    if (typeof params !== "object" || Array.isArray(params)) return { errorCode: "invalid_parameters", error: `AGENT402_CALL params must be an object; got ${Array.isArray(params) ? "an array" : typeof params}.` };
    return { slug: String(direct).trim(), params, via: options?.parameters?.slug ? "parameters" : "content" };
  }
  const prevFind = options?.actionContext?.getPreviousResult?.("AGENT402_FIND")
    ?? options?.actionContext?.previousResults?.find((r) => r?.data?.actionName === "AGENT402_FIND");
  const text = textOf(message);
  if (!text) return { errorCode: "invalid_parameters", error: "AGENT402_CALL needs a tool slug and its input, or a message describing the task (AGENT402_FIND lists the slugs)." };
  let candidates;
  if (prevFind?.data?.results?.length) candidates = prevFind.data.results;
  else {
    // A catalog that cannot be read is UNAVAILABLE, which is not "no match":
    // the first is our (or the network's) state, the second is an answer.
    try { candidates = await client.find(text, { k: 5 }); } catch (e) { return { errorCode: "catalog_unavailable", error: `AGENT402_CALL could not search the Agent402 catalog: ${errorText(e)}` }; }
  }
  if (!Array.isArray(candidates) || candidates.length === 0) return { errorCode: "no_match", error: `No Agent402 tool matched "${text}".` };
  if (typeof runtime?.useModel !== "function") {
    return { errorCode: "model_unavailable", error: `AGENT402_CALL could not shape an input for "${text}": this runtime exposes no model to extract parameters with. Provide slug and params directly (candidates: ${candidates.map((c) => c.slug).join(", ")}).` };
  }
  const menu = candidates.slice(0, 5).map((c) => ({ slug: c.slug, description: c.description, price: c.price, example: c.example ?? c.input ?? null, inputSchema: c.inputSchema ?? null }));
  const prompt = [
    "You are choosing ONE tool to run for the user's request and writing its input.",
    `User request: ${JSON.stringify(text)}`,
    "Candidate tools (slug, description, price, an example input, and the input schema where known):",
    JSON.stringify(menu, null, 1),
    'Respond with ONLY a JSON object of the form {"slug": "<one of the candidate slugs>", "params": {<the tool input for THIS request, in the shape of the example>}}.',
    "If no candidate fits, respond with {\"slug\": null, \"reason\": \"<why>\"}.",
  ].join("\n");
  let picked = null;
  try {
    picked = await runtime.useModel("OBJECT_SMALL", { prompt, temperature: 0 });
    if (typeof picked === "string") { const m = picked.match(/\{[\s\S]*\}/); picked = m ? JSON.parse(m[0]) : null; }
  } catch (e) {
    try {
      const raw = await runtime.useModel("TEXT_SMALL", { prompt, temperature: 0 });
      const m = String(raw || "").match(/\{[\s\S]*\}/); picked = m ? JSON.parse(m[0]) : null;
    } catch (e2) { return { errorCode: "extraction_failed", error: `AGENT402_CALL could not extract parameters: ${errorText(e2)}` }; }
  }
  if (!picked || typeof picked !== "object") return { errorCode: "extraction_failed", error: `AGENT402_CALL could not extract parameters: the model returned no JSON object.` };
  if (!picked.slug) return { errorCode: "no_match", error: `No Agent402 tool fits "${text}"${picked?.reason ? `: ${picked.reason}` : ""}.` };
  const slug = String(picked.slug).trim();
  if (!menu.some((c) => c.slug === slug)) return { errorCode: "unoffered_pick", error: `The model picked "${slug}", which is not among the candidates (${menu.map((c) => c.slug).join(", ")}); refusing to call a tool that was not offered.` };
  if (picked.params != null && (typeof picked.params !== "object" || Array.isArray(picked.params))) return { errorCode: "invalid_parameters", error: `The model returned params that are not an object for "${slug}"; refusing to call it.` };
  return { slug, params: picked.params ?? {}, via: "model" };
}

export const callAction = {
  name: "AGENT402_CALL",
  similes: ["CALL_TOOL", "RUN_AGENT402_TOOL", "USE_AGENT402", "CALL_AGENT402"],
  description:
    "Call an Agent402 tool by slug with its input and return the tool's JSON result. Free-tier tools cost nothing " +
    "(proof-of-work); wallet-only tools are paid with the configured credits key or x402 wallet, typically $0.001 to " +
    "$0.05 per call and never above AGENT402_MAX_PER_CALL_USD or the rolling AGENT402_DAILY_LIMIT_USD. If no slug is " +
    "given the tool is chosen from the message and the last AGENT402_FIND result.",
  parameters: [
    { name: "slug", description: "Tool slug from AGENT402_FIND (for example: hash, search, extract, stock-quote)", required: false, schema: { type: "string" } },
    { name: "params", description: "The tool's input object, in the shape of the example AGENT402_FIND returned", required: false, schema: { type: "object", additionalProperties: true } },
  ],
  examples: [[
    { name: "user", content: { text: "Hash 'hello world' with sha256" } },
    { name: "agent", content: { text: "Calling Agent402's hash tool.", actions: ["AGENT402_CALL"] } },
  ]],
  // The planner can only pick an action the ACTIONS provider listed, and that
  // provider lists what validate() admits - so a validate that demands a slug
  // field on the user's message hides this action from every real
  // conversation (registry review, 2026-09-14). Admit it; the handler decides.
  validate: async () => true,
  handler: async (runtime, message, _state, options, callback) => {
    let client;
    try { client = await clientFor(runtime); } catch (e) { return reply(callback, failure("client_error", `Agent402 client failed: ${errorText(e)}`)); }
    const resolved = await resolveCallInput(runtime, message, options, client);
    if (resolved.error) return reply(callback, failure(resolved.errorCode, resolved.error));
    const { slug, params, via } = resolved;
    let out;
    try {
      out = await client.call(slug, params);
    } catch (e) {
      const msg = errorText(e);
      const code = e?.name === "SpendingLimitError" || /exceeds maxPerCallUsd|dailyLimitUsd|maxPerHostUsd/.test(msg) ? "spend_limit"
        : /wallet-only|402|refused by credits/.test(msg) ? "payment_required" : "upstream_error";
      const hint = code === "payment_required" ? " Set AGENT402_CREDITS_KEY (https://agent402.tools/credits) or AGENT402_WALLET_KEY to pay for this tool." : "";
      return reply(callback, failure(code, `Agent402 \`${slug}\` failed: ${msg}${hint}`, { slug, params, resolvedVia: via }));
    }
    const data = out && typeof out === "object" ? out : { result: out };
    const json = JSON.stringify(data);
    const cap = MAX_RESULT_CHARS();
    if (cap != null && json.length > cap) {
      // The host asked for a bound. The answer is whole in data.result; the
      // text says it was NOT delivered rather than delivering part of it.
      return reply(callback, failure("result_too_large", `Agent402 \`${slug}\` returned ${json.length} characters of JSON, over this host's AGENT402_MAX_RESULT_CHARS of ${cap}; the complete result is in this action's data.result and was not placed in the model context.`, { slug, params, resolvedVia: via, result: data, resultChars: json.length }));
    }
    return reply(callback, {
      success: true,
      text: resultText(slug, json),
      values: { agent402LastSlug: slug },
      data: { actionName: "AGENT402_CALL", slug, params, resolvedVia: via, result: data },
    });
  },
};

export const aboutAction = {
  name: "AGENT402_ABOUT",
  similes: ["WHAT_IS_AGENT402", "AGENT402_INFO"],
  description: "What Agent402 is, how it is paid, and how many tools it serves right now. Free.",
  examples: [[
    { name: "user", content: { text: "What is Agent402?" } },
    { name: "agent", content: { text: "Agent402 is a catalog of pay-per-call web tools, paid by card credits or USDC over x402.", actions: ["AGENT402_ABOUT"] } },
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
      return reply(callback, { success: true, text: `Agent402 serves ${data.tools} pay-per-call tools right now (${data.freeTier} on the free tier), paid by card credits or USDC over x402. Docs: ${data.docs}`, data });
    } catch (e) {
      return reply(callback, { success: false, text: `Agent402 is unreachable at ${baseUrl}: ${errorText(e)}`, error: errorText(e) });
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
    const text = `Agent402 (${baseUrl}) is a catalog of pay-per-call web tools. Use AGENT402_FIND with a plain-language task to get a slug and example input, then AGENT402_CALL with that slug and params. Payment mode: ${paid}.`;
    return { text, values: { agent402BaseUrl: baseUrl, agent402PaymentMode: paid }, data: {} };
  },
};

export const agent402Plugin = {
  name: "agent402",
  description: "Find and call Agent402's pay-per-call web tools (search, render, PDFs, market and SEC data), paid by prepaid card credits or USDC over x402; free tier via proof-of-work.",
  actions: [findAction, callAction, aboutAction],
  providers: [agent402Provider],
  init: async (config, runtime) => {
    const hasKey = Boolean(setting(runtime, "AGENT402_CREDITS_KEY") || config?.AGENT402_CREDITS_KEY);
    const hasWallet = /^0x[0-9a-fA-F]{64}$/.test(setting(runtime, "AGENT402_WALLET_KEY") || config?.AGENT402_WALLET_KEY || "");
    if (!hasKey && !hasWallet) console.warn("[agent402] no AGENT402_CREDITS_KEY or AGENT402_WALLET_KEY: free-tier tools only (credits keys: https://agent402.tools/credits)");
  },
};

export default agent402Plugin;
