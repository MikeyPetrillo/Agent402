// Local proxy: OpenClaw (or any client) talks to http://127.0.0.1:<port>, the
// proxy pays Agent402 and forwards. Two wires:
//   OpenAI     POST /v1/chat/completions -> the tier the model id names
//   Anthropic  POST /v1/messages         -> the gateway's metered Messages
//              route (/v1/metered/messages), so Claude Code and the Anthropic
//              SDK pay from a wallet too (ANTHROPIC_BASE_URL=http://127.0.0.1:<port>).
//
// Two ways to pay, chosen at start:
//   creditsKey  - a prepaid card-credits key (a402_...) sent as a Bearer; the
//                 gateway authorizes against the balance before the handler and
//                 debits only on a final 200. No wallet, no chain.
//   payFetch    - an x402-paying fetch (e.g. @x402/fetch wrapped around a
//                 wallet signer) used for the upstream call; the gateway's 402
//                 is settled per call in USDC. The proxy never sees a key.
// With neither, paid calls answer a 402-shaped JSON that says how to set up.
//
// Routing: the model id decides the upstream tier endpoint, read from the
// gateway's own GET /v1/models at start (never a hand-typed table). "auto"
// goes to the routed tier with the model field omitted.
//
// Idempotency: a client-supplied Idempotency-Key is passed through so an
// x402 retry with the same key replays the paid answer server-side; without
// one each forwarded call gets a fresh key (a safety for the fetch layer's
// own 402->pay retry), which does NOT make two client calls one payment.
// Streams pass through byte for byte.
//
// Refusals: a refused paid call's 402 from an x402 v2 seller carries the whole
// payment offer in its JSON body (Agent402 mirrors its PAYMENT-REQUIRED header
// there) beside the refusal's own reason, hint and retry. OpenClaw's model
// client builds its error message from `error.message`, else from the whole
// body, so relaying that body put kilobytes of accepts and schemas into the
// agent's error text in place of the one sentence that says what to fix. Such
// a body is answered in the OpenAI error shape instead (refusalAsOpenAIError);
// every other upstream body passes through byte for byte.
//
// Loopback only, and browser-hostile on purpose: any web page can POST to
// 127.0.0.1 with a "simple" no-cors request, and this proxy spends the
// user's key, so a request carrying an Origin header (browsers always send
// one on cross-origin POSTs; native clients send none) or a Host that is
// not loopback is refused before anything is forwarded.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AUTO_ID, routesFromCatalog, stripTrailingSlashes } from "./models.js";

export const DEFAULT_UPSTREAM = "https://agent402.tools";
export const PKG_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const MAX_BODY = 2 * 1024 * 1024;

export async function loadRoutes(upstream, fetchImpl = fetch, { pricing = "metered" } = {}) {
  const r = await fetchImpl(`${upstream}/v1/models`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`GET /v1/models -> HTTP ${r.status}`);
  return routesFromCatalog(await r.json(), { pricing });
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// The x402 offer keys a refusal body may carry beside its own fields.
const OFFER_KEYS = ["x402Version", "resource", "accepts", "extensions"];
const text = (v) => (typeof v === "string" && v.trim() ? v : null);

/** An upstream error body that carries an x402 offer (a numeric x402Version),
 *  as an OpenAI-shaped error: the explanation (a problem's detail, else the
 *  hint, else the error sentence) as error.message, the retry class or reason as
 *  error.code, the refusal's own fields beside it, and no offer. Null for any
 *  other body, which the caller relays unchanged. */
export function refusalAsOpenAIError(status, doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || typeof doc.x402Version !== "number") return null;
  const ours = { ...doc };
  for (const k of OFFER_KEYS) delete ours[k];
  const { error, ...fields } = ours;
  const message = text(fields.detail) || text(fields.hint) || text(error) || text(fields.title) || `Agent402 answered HTTP ${status}`;
  return {
    error: { message, type: status === 402 ? "payment_required" : "upstream_error", code: text(fields.retry) || text(fields.reason) || null },
    ...fields,
  };
}

/** The same refusal in the Anthropic error shape ({type:"error", error:{type,
 *  message}}), which Anthropic clients read their error text from. Null for any
 *  other body, which the caller relays unchanged. */
export function refusalAsAnthropicError(status, doc) {
  const o = refusalAsOpenAIError(status, doc);
  if (!o) return null;
  const { error, ...fields } = o;
  return { type: "error", error: { type: status === 402 ? "payment_required" : "api_error", message: error.message }, ...fields };
}

// The gateway's metered Anthropic Messages route: quoted per request from the
// body, any model id the gateway lists (dated Claude ids resolve to the live one).
export const MESSAGES_UPSTREAM_PATH = "/v1/metered/messages";

const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(obj));
};

/**
 * @param {object} o
 * @param {string} [o.upstream]      gateway origin (default https://agent402.tools)
 * @param {string} [o.creditsKey]    prepaid credits key (a402_...)
 * @param {Function} [o.payFetch]    x402-paying fetch for wallet payment
 * @param {Function} [o.fetch]       plain fetch (tests inject one)
 * @param {number} [o.port]          0 = ephemeral
 * @param {string} [o.host]          default 127.0.0.1 (loopback only: anyone who can reach the port spends your key)
 * @param {Map} [o.routes]           pre-loaded routes (tests); else loaded from upstream
 * @param {"metered"|"flat"} [o.pricing]  metered (default): explicit models pay per-request quotes; flat: home tiers
 * @param {(msg:string)=>void} [o.log]
 */
export async function startProxy({ upstream = DEFAULT_UPSTREAM, creditsKey = null, payFetch = null, fetch: fetchImpl = fetch, port = 0, host = "127.0.0.1", routes = null, pricing = "metered", log = () => {} } = {}) {
  upstream = stripTrailingSlashes(upstream);
  pricing = pricing === "flat" ? "flat" : "metered";
  const key = typeof creditsKey === "string" && /^a402_[A-Za-z0-9_-]{16,80}$/.test(creditsKey) ? creditsKey : null;
  const paid = key ? fetchImpl : payFetch;
  const mode = key ? "credits" : payFetch ? "x402" : "unpaid";
  let table = routes || await loadRoutes(upstream, fetchImpl, { pricing });
  const stats = { requests: 0, forwarded: 0, errors: 0, startedAt: new Date().toISOString() };

  // Pays and forwards one call. Streams pass through byte for byte; a refused
  // paid call's offer-carrying JSON body is answered in the client wire's own
  // error shape (mapRefusal); every other upstream body is relayed as sent.
  async function forward(req, res, endpoint, outbound, extraHeaders, mapRefusal) {
    const clientIdem = typeof req.headers["idempotency-key"] === "string" && /^[\w.:-]{8,128}$/.test(req.headers["idempotency-key"]) ? req.headers["idempotency-key"] : null;
    const headers = { "content-type": "application/json", accept: req.headers.accept || "application/json", "idempotency-key": clientIdem || randomUUID(), "user-agent": `agent402-openclaw/${PKG_VERSION}`, ...extraHeaders };
    if (key) headers.authorization = `Bearer ${key}`;
    const up = await paid(`${upstream}${endpoint}`, { method: "POST", headers, body: JSON.stringify(outbound), signal: AbortSignal.timeout(300_000) });
    stats.forwarded++;
    const passthrough = {};
    for (const h of ["content-type", "x-credits-balance", "payment-receipt", "x-cache", "cache-control"]) { const v = up.headers.get(h); if (v) passthrough[h] = v; }
    if (!up.ok && /json/i.test(passthrough["content-type"] || "")) {
      const raw = await up.text();
      let doc = null;
      try { doc = JSON.parse(raw); } catch { /* not JSON after all: relayed as sent */ }
      const mapped = mapRefusal(up.status, doc);
      if (mapped) {
        const { "content-type": _ct, ...rest } = passthrough;
        return json(res, up.status, mapped, rest);
      }
      res.writeHead(up.status, passthrough);
      return res.end(raw);
    }
    res.writeHead(up.status, passthrough);
    if (!up.body) return res.end();
    const reader = up.body.getReader();
    req.on("close", () => { reader.cancel().catch(() => {}); });
    for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    return res.end();
  }

  const server = createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.headers.origin !== undefined) {
        return json(res, 403, { error: { message: "Browser-origin requests are refused: this proxy spends a payment key and answers native clients only.", type: "forbidden" } });
      }
      const hostName = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      if (hostName && !["127.0.0.1", "localhost", "::1"].includes(hostName)) {
        return json(res, 403, { error: { message: `Host "${hostName.slice(0, 64)}" is not loopback; refused.`, type: "forbidden" } });
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, upstream, mode, pricing, models: table.size, stats });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return json(res, 200, { object: "list", data: [...table.values()].filter((r) => !r.stealth).map((r) => ({ id: r.id, object: "model", owned_by: "agent402", agent402: { endpoint: r.endpoint, priceUsd: r.priceUsd, tier: r.tier, metered: !!r.metered } })) });
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { return json(res, 400, { error: { message: "Request body must be JSON", type: "invalid_request_error" } }); }
        const requested = typeof body.model === "string" && body.model.trim() ? body.model.trim().replace(/^agent402\//, "") : AUTO_ID;
        const route = table.get(requested);
        if (!route) {
          return json(res, 400, { error: { message: `Unknown model "${requested}". Use "auto" or an id from GET /v1/models (${table.size} available).`, type: "invalid_request_error", code: "model_not_found" } });
        }
        if (!paid) {
          return json(res, 402, { error: { message: "No payment method configured. Run `agent402-openclaw setup` to generate an x402 wallet, set AGENT402_WALLET_KEY, or set AGENT402_CREDITS_KEY to a credits key already issued.", type: "payment_required", code: "agent402_unconfigured" }, topup: `${upstream}/credits`, priceUsd: route.priceUsd });
        }
        const outbound = { ...body };
        if (requested === AUTO_ID) delete outbound.model; else outbound.model = route.id;
        return forward(req, res, route.endpoint, outbound, {}, refusalAsOpenAIError);
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Request body must be JSON" } }); }
        if (typeof body.model !== "string" || !body.model.trim()) {
          return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "\"model\" is required (any id from GET /v1/models, or a Claude id such as claude-sonnet-5)" } });
        }
        if (!paid) {
          return json(res, 402, { type: "error", error: { type: "payment_required", message: "No payment method configured. Set AGENT402_WALLET_KEY to an EVM key holding USDC on Base (or run `agent402-openclaw setup`), or set AGENT402_CREDITS_KEY to a credits key already issued." } });
        }
        const outbound = { ...body, model: body.model.trim().replace(/^agent402\//, "") };
        const extra = {};
        for (const h of ["anthropic-version", "anthropic-beta"]) { const v = req.headers[h]; if (typeof v === "string" && v.length <= 512) extra[h] = v; }
        return forward(req, res, MESSAGES_UPSTREAM_PATH, outbound, extra, refusalAsAnthropicError);
      }
      return json(res, 404, { error: { message: `No route for ${req.method} ${url.pathname}`, type: "invalid_request_error" } });
    } catch (e) {
      stats.errors++;
      log(`[agent402-openclaw] ${req.method} ${url.pathname}: ${e?.message || e}`);
      if (!res.headersSent) return json(res, 502, { error: { message: `Upstream error: ${String(e?.message || e).slice(0, 200)}`, type: "upstream_error" } });
      try { res.end(); } catch { /* ignore */ }
    }
  });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const actualPort = server.address().port;
  const baseUrl = `http://${host}:${actualPort}`;
  log(`[agent402-openclaw] proxy on ${baseUrl}/v1 -> ${upstream} (${mode}, ${pricing} pricing, ${table.size} models)`);
  return {
    baseUrl, port: actualPort, mode, upstream, pricing,
    stats: () => ({ ...stats }),
    refreshModels: async () => { table = await loadRoutes(upstream, fetchImpl, { pricing }); return table.size; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
