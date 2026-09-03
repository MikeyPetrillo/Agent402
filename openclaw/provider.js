// The OpenClaw ProviderPlugin. Its `models` getter always points at the local
// proxy URL - the configured port before the proxy is up, the live one after -
// so OpenClaw persists a loopback baseUrl and never the remote gateway (which
// would 402 without the proxy's payment step in between).
import { providerModelsConfig, routesFromCatalog } from "./models.js";

// The MODEL PROVIDER id: what a user writes in openclaw.json ("agent402/auto").
// User-facing and stable - renaming it would break every existing config.
export const PROVIDER_ID = "agent402";
// The PLUGIN id, which is a different thing: OpenClaw keys plugins.entries by
// the MANIFEST id, and since 2026.8.1 it requires that id to equal the npm
// package name ("Plugin manifest id ... differs from npm package name ...").
// They were both "agent402", so nothing distinguished them until the host
// started checking. Writing config under the provider id while the host reads
// it under the manifest id is the same defect as the 2026-08-26 --port bug,
// where setup moved the baseUrl and the service kept reading the old key.
export const PLUGIN_ID = "agent402";
export const DEFAULT_PORT = 8412;

let activeProxy = null;
let cachedRoutes = null;
export function setActiveProxy(p) { activeProxy = p; }
export function getActiveProxy() { return activeProxy; }
export function setCachedRoutes(r) { cachedRoutes = r; }

/** Minimal offline route table so the provider registers even before /v1/models is read. */
export const BOOTSTRAP_ROUTES = routesFromCatalog({ data: [
  { id: "auto", x402: { tier: "v1-chat-auto", endpoint: "/v1/auto/chat/completions", priceUsd: 0.01, maxTokens: 1024, maxInputChars: 32_000 } },
] });

export function buildProvider({ port = DEFAULT_PORT } = {}) {
  return {
    id: PROVIDER_ID,
    label: "Agent402",
    docsPath: "https://agent402.tools/guides/openclaw-model-provider",
    aliases: ["a402"],
    envVars: ["AGENT402_CREDITS_KEY", "AGENT402_WALLET_KEY"],
    get models() {
      const base = activeProxy ? activeProxy.baseUrl : `http://127.0.0.1:${port}`;
      return providerModelsConfig(base, cachedRoutes || BOOTSTRAP_ROUTES);
    },
    // No provider auth: the proxy carries the credits key or signs the payment.
    auth: [],
  };
}
