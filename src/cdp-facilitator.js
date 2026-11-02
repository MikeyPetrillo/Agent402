// CDP facilitator client config: the { url, createAuthHeaders } object that
// HTTPFacilitatorClient (@x402/core) takes. It reproduces what
// @coinbase/x402 2.1.0's createFacilitatorConfig returns, on the JWT minter
// the CDP kit already uses (src/tools/cdp-kit.js mintCdpJwt, node:crypto),
// so the facilitator path no longer installs @coinbase/cdp-sdk and its
// nested zod 3 copies. Same URL, the same four header groups, the same
// Correlation-Context string, and a fresh JWT per path and per call whose
// claims match generateJwt in @coinbase/cdp-sdk 1.51.0 (sub, iss, uris, iat,
// nbf, exp + 120 s, no aud; header alg, kid, typ, nonce). The 1.29.0 named in
// the Correlation-Context below hard-coded aud ["cdp_service"]. Only the auth headers are built here: the
// payment payloads are still validated by @x402/core. Pinned by
// scripts/test-cdp-facilitator.js.
import { mintCdpJwt } from "./tools/cdp-kit.js";

export const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";
export const CDP_FACILITATOR_ROUTE = "/platform/v2/x402";
export const CDP_FACILITATOR_URL = `https://${CDP_FACILITATOR_HOST}${CDP_FACILITATOR_ROUTE}`;

// The values @coinbase/x402 2.1.0 sends, kept verbatim so the facilitator
// reads this traffic the way it read the package's.
const CORRELATION = { sdk_version: "1.29.0", sdk_language: "typescript", source: "x402", source_version: "2.1.0" };

export function cdpCorrelationHeader() {
  return Object.keys(CORRELATION).map((k) => `${k}=${encodeURIComponent(CORRELATION[k])}`).join(",");
}

const bearer = async (apiKeyId, apiKeySecret, method, path) =>
  `Bearer ${await mintCdpJwt({ method, path: `${CDP_FACILITATOR_ROUTE}${path}`, apiKeyId, apiKeySecret, host: CDP_FACILITATOR_HOST })}`;

export function cdpAuthHeaders(apiKeyId, apiKeySecret) {
  return async () => {
    const id = apiKeyId ?? process.env.CDP_API_KEY_ID;
    const secret = apiKeySecret ?? process.env.CDP_API_KEY_SECRET;
    const correlation = () => ({ "Correlation-Context": cdpCorrelationHeader() });
    const headers = { verify: correlation(), settle: correlation(), supported: correlation(), list: correlation() };
    if (id && secret) {
      headers.verify.Authorization = await bearer(id, secret, "POST", "/verify");
      headers.settle.Authorization = await bearer(id, secret, "POST", "/settle");
      headers.supported.Authorization = await bearer(id, secret, "GET", "/supported");
    }
    return headers;
  };
}

export function cdpFacilitatorConfig(apiKeyId, apiKeySecret) {
  return { url: CDP_FACILITATOR_URL, createAuthHeaders: cdpAuthHeaders(apiKeyId, apiKeySecret) };
}
