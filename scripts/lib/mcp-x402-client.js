// A small client for the hosted connector's x402 MCP wire, for the listing
// scripts: connect to `${target}/mcp` over Streamable HTTP, ask a tool for its
// x402 offer (an unpaid tools/call), and buy one MCP tool listing exactly once.
// The MCP SDK is loaded lazily, so a dry run needs no install.
import { mcpOfferProblems, mcpSignableOffer, MCP_OFFER_MAX_VALIDITY_SECONDS } from "./mcp-listings.js";

export const X402_PAYMENT_META = "x402/payment";
export const X402_PAYMENT_RESPONSE_META = "x402/payment-response";

/** Connect to the connector. `headers()` is read for every request (the
 *  keep-alive's heartbeat token is minted per minute). Returns
 *  { callTool(name, args, meta?), close() }. */
export async function connectMcp(target, { headers = () => ({}), name = "agent402-listing-scripts", fetchImpl = fetch, timeoutMs = 240_000 } = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const withHeaders = (url, init = {}) => {
    const h = new Headers(init.headers || {});
    for (const [k, v] of Object.entries(headers() || {})) h.set(k, v);
    return fetchImpl(url, { ...init, headers: h });
  };
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${String(target).replace(/\/+$/, "")}/mcp`), { fetch: withHeaders }));
  return {
    callTool: (toolName, args, meta) => client.callTool({ name: toolName, arguments: args || {}, ...(meta ? { _meta: meta } : {}) }, undefined, { timeout: timeoutMs }),
    close: async () => { try { await client.close(); } catch { /* closed */ } },
  };
}

const textOf = (r) => (Array.isArray(r?.content) ? r.content : []).map((c) => (typeof c?.text === "string" ? c.text : "")).join(" ").replace(/\s+/g, " ").trim();

/** The x402 offer an unpaid call of a tool answers:
 *  { offer } (the PaymentRequired), or { offer: null, why }. */
export async function askMcpOffer(callTool, toolName, args) {
  const ask = await callTool(toolName, args);
  // The transport's required form: the PaymentRequired as JSON in the first
  // text block. structuredContent (its optional copy) is read when present.
  let pr = ask?.structuredContent;
  if (!(pr && typeof pr === "object" && Array.isArray(pr.accepts))) {
    const first = Array.isArray(ask?.content) ? ask.content[0] : null;
    try { pr = first?.type === "text" ? JSON.parse(first.text) : null; } catch { pr = null; }
  }
  if (ask?.isError === true && pr && typeof pr === "object" && !Array.isArray(pr) && Array.isArray(pr.accepts)) return { offer: pr };
  if (ask?.isError !== true) return { offer: null, why: "the tool answered without asking for a payment" };
  return { offer: null, why: `the tool's refusal carries no x402 offer (${textOf(ask).slice(0, 120) || "no text"})` };
}

/** Why a signed payment is not the one the checked offer asked for ([] when
 *  it is): the authorization pays `payTo` exactly `micros`, and expires
 *  within the bounded window (a minute of clock skew allowed). */
export function signedPaymentProblems(payment, { micros, payTo, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const auth = payment?.payload?.authorization;
  if (!auth || typeof auth !== "object") return ["no readable transfer authorization"];
  const out = [];
  if (String(auth.to ?? "").toLowerCase() !== String(payTo ?? "").toLowerCase()) out.push("the authorization pays another address");
  if (String(auth.value) !== String(micros)) out.push("the authorization is not for the list price");
  const until = Number(auth.validBefore);
  if (!Number.isFinite(until) || until - nowSeconds > MCP_OFFER_MAX_VALIDITY_SECONDS + 60) out.push("the authorization is valid for longer than the bounded window");
  return out;
}

/**
 * Buy one MCP tool listing, once: ask for the offer, refuse it unless it is
 * that tool's MCP listing offer on `origin` at the list price, paying `payTo`
 * (the server's published receiving address; required) inside the bounded
 * validity window, sign one payment against the one checked accept
 * (`signPayment`, the capped x402 client's createPaymentPayload), read the
 * signed authorization back, and send it once in _meta["x402/payment"].
 * Nothing is sent twice: a paid call that fails or times out is reported,
 * never retried, since a payment that was sent may still settle.
 * Returns { ok, signed, sent, why?, receipt? }.
 */
export async function buyMcpListing({ callTool, signPayment, route, args = {}, origin, payTo }) {
  if (!payTo) return { ok: false, signed: false, sent: false, why: "no published receiving address to hold the offer to" };
  let asked;
  try { asked = await askMcpOffer(callTool, route.toolName, args); } catch (e) {
    return { ok: false, signed: false, sent: false, why: `the offer could not be read (${String(e?.message || e).slice(0, 120)})` };
  }
  if (!asked.offer) return { ok: false, signed: false, sent: false, why: asked.why };
  const problems = mcpOfferProblems(asked.offer, { toolName: route.toolName, origin, micros: route.micros, payTo });
  if (problems.length) return { ok: false, signed: false, sent: false, why: `the offer is not this tool's MCP listing offer: ${problems.join("; ")}` };
  const signable = mcpSignableOffer(asked.offer);
  if (!signable) return { ok: false, signed: false, sent: false, why: "the offer holds no single accept to sign" };
  let payment;
  try { payment = await signPayment(signable); } catch (e) {
    return { ok: false, signed: false, sent: false, why: `no payment was signed (${String(e?.message || e).slice(0, 160)})` };
  }
  const signedProblems = signedPaymentProblems(payment, { micros: route.micros, payTo });
  if (signedProblems.length) return { ok: false, signed: true, sent: false, why: `the signed payment was not sent: ${signedProblems.join("; ")}` };
  let paid;
  try { paid = await callTool(route.toolName, args, { [X402_PAYMENT_META]: payment }); } catch (e) {
    return { ok: false, signed: true, sent: true, why: `the paid call did not answer (${String(e?.message || e).slice(0, 120)}); it may still have settled, and it is not sent again` };
  }
  const receipt = paid?._meta?.[X402_PAYMENT_RESPONSE_META] || null;
  if (paid?.isError !== true && receipt?.success === true) return { ok: true, signed: true, sent: true, receipt };
  const settled = receipt?.success === true;
  return {
    ok: false, signed: true, sent: true, receipt,
    why: `${settled ? "the payment settled but the tool answered an error" : "the payment did not settle"} (${textOf(paid).slice(0, 160) || "no text"}); not sent again`,
  };
}
