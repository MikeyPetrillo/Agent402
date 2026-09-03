// Native MPP on the hosted MCP connector (/mcp) - mppx's MCP wire, our
// settlement authority.
//
// Wire (mppx/dist/mcp/server/Transport.js + mcp/client/McpClient.js):
//   - the client sends a credential in tools/call `_meta["org.paymentauth/
//     credential"]` as the DESERIALIZED {challenge, payload} object;
//   - a server asks for payment with JSON-RPC error -32042 whose `data` is
//     {httpStatus: 402, challenges: [Challenge...], problem?} (the client also
//     accepts a tool RESULT carrying `_meta["org.paymentauth/payment-required"]`);
//   - a paid result carries `_meta["org.paymentauth/receipt"]` = the receipt
//     object (+ challengeId).
//
// Settlement authority is UNCHANGED: the MCP handler never verifies or settles
// anything itself. It replays the call as a LOOPBACK HTTP request to this
// process's own paid route with `Authorization: Payment <credential>` and lets
// the real gates decide - the evm shim + @x402/express for USDC on Base/Celo,
// the tempo gate + Tempo relay for native Tempo - then translates: 402 ->
// -32042 with the fresh challenges from that 402's WWW-Authenticate header
// (and its RFC 9457 body as `problem`); 200 + Payment-Receipt -> result +
// receipt meta; any other status -> an isError text result. Every paywall
// invariant (HMAC challenge binding, replay guard, payer attribution,
// settle-after-handler, Idempotency-Key) therefore applies verbatim, and a
// paid MCP call lands in /api/stats as what it is: a paid call over the MPP
// wire. The buyer's IP rides X-Forwarded-For so per-IP limits see the buyer,
// not 127.0.0.1 (trust proxy is 1 hop).
import { Challenge, Credential, Receipt } from "mppx";

export const MCP_PAYMENT_REQUIRED_CODE = -32042;
// mppx 0.9.1+ ("Fixed MCP payment errors to use the specification-defined
// JSON-RPC codes"): a PRESENTED credential that is refused is -32043, not a
// fresh -32042. Both codes carry the same data shape ({httpStatus, challenges,
// problem}); the 0.9.x client reads challenges from either, an 0.8.x client
// reads only -32042 and so stops re-paying a refused credential on its own -
// which is the spec's intent for a refusal (a tampered credential should not
// be silently retried with money).
export const MCP_PAYMENT_VERIFICATION_FAILED_CODE = -32043;
export const MCP_CREDENTIAL_META = "org.paymentauth/credential";
export const MCP_RECEIPT_META = "org.paymentauth/receipt";
export const MCP_PAYMENT_REQUIRED_META = "org.paymentauth/payment-required";

/** `Authorization: Payment ...` header value from the object the mppx MCP
 *  client puts in _meta. null when absent/unusable (then the call is unpaid). */
export function credentialHeaderFromMeta(meta) {
  const cred = meta && typeof meta === "object" ? meta[MCP_CREDENTIAL_META] : null;
  if (!cred) return null;
  if (typeof cred === "string") return /^payment\s/i.test(cred) ? cred : `Payment ${cred}`;
  if (typeof cred !== "object" || !cred.challenge || !cred.payload) return null;
  try { return Credential.serialize(cred); } catch { return null; }
}

/** Plain challenge objects from a 402's WWW-Authenticate header (mppx codec). */
export function challengesFromHeader(wwwAuth) {
  if (!wwwAuth) return [];
  try {
    return Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": String(wwwAuth) })).map((c) => JSON.parse(JSON.stringify(c)));
  } catch { return []; }
}

/** Receipt object from a Payment-Receipt header (mppx codec); null if unreadable. */
export function receiptFromHeader(h) {
  if (!h) return null;
  try { return JSON.parse(JSON.stringify(Receipt.deserialize(String(h)))); } catch { return null; }
}

/** challengeId of the credential the client sent (for the receipt meta). */
export function challengeIdFromMeta(meta) {
  const cred = meta && typeof meta === "object" ? meta[MCP_CREDENTIAL_META] : null;
  const id = cred && typeof cred === "object" ? cred.challenge?.id : null;
  return typeof id === "string" ? id : undefined;
}

/** Build the loopback caller. `port`/`host` are this process's own listener;
 *  `fetchImpl` is injectable for tests. */
export function createMcpMppLoopback({ port, host = "127.0.0.1", fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  if (!port) throw new Error("createMcpMppLoopback: port is required");
  const base = `http://${host}:${port}`;
  // `timeoutMs` may be overridden PER CALL: a task-shaped composite run outlives
  // the default 60s bound (30s to 4 min), and the loopback is the paid request,
  // so cutting it short would abort work the buyer is waiting for.
  return async function payCall({ def, params, credentialHeader, ip, signal, idempotencyKey, timeoutMs: callTimeoutMs } = {}) {
    const [method, path] = String(def.route || "POST /").split(" ");
    const m = (method || "POST").toUpperCase();
    let url = base + path;
    const headers = { Accept: "application/json, */*", "X-Forwarded-For": String(ip || "127.0.0.1"), "X-Agent402-Via": "mcp" };
    if (credentialHeader) headers.Authorization = credentialHeader;
    if (idempotencyKey) headers["Idempotency-Key"] = String(idempotencyKey);
    let body;
    if (m === "GET" || m === "HEAD") {
      const qp = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) { if (v == null) continue; qp.set(k, typeof v === "object" ? JSON.stringify(v) : String(v)); }
      const qs = qp.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params || {});
    }
    const effectiveTimeout = Number(callTimeoutMs) > 0 ? Number(callTimeoutMs) : timeoutMs;
    const signals = [AbortSignal.timeout(effectiveTimeout)];
    if (signal) signals.push(signal);
    const res = await fetchImpl(url, { method: m, headers, body, signal: AbortSignal.any(signals), redirect: "manual" });
    const contentType = res.headers.get("content-type") || "";
    const out = { status: res.status, headers: res.headers, contentType, json: undefined, text: undefined, bytes: undefined };
    if (/application\/(problem\+)?json/i.test(contentType)) {
      const t = await res.text();
      try { out.json = JSON.parse(t); } catch { out.text = t; }
    } else if (/^(image|audio|video)\//i.test(contentType) || /octet-stream/i.test(contentType)) {
      out.bytes = Buffer.from(await res.arrayBuffer());
    } else {
      out.text = await res.text();
    }
    return out;
  };
}
