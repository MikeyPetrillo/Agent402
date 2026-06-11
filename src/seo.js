import { toolList, CATEGORIES } from "./pages.js";

export function robotsTxt(baseUrl) {
  return `User-agent: *
Allow: /
Disallow: /api/memory

Sitemap: ${baseUrl}/sitemap.xml
`;
}

export function sitemapXml(baseUrl, catalog) {
  const staticUrls = [
    { loc: `${baseUrl}/`, priority: "1.0" },
    { loc: `${baseUrl}/tools`, priority: "0.9" },
    { loc: `${baseUrl}/llms.txt`, priority: "0.8" },
    { loc: `${baseUrl}/openapi.json`, priority: "0.7" },
    { loc: `${baseUrl}/api/pricing`, priority: "0.7" },
  ];
  const toolUrls = toolList(catalog).map((t) => ({ loc: `${baseUrl}/tools/${t.slug}`, priority: "0.8" }));
  const entries = [...staticUrls, ...toolUrls]
    .map((u) => `  <url><loc>${u.loc}</loc><changefreq>weekly</changefreq><priority>${u.priority}</priority></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

export function llmsTxt(baseUrl, catalog) {
  const tools = toolList(catalog);
  const sections = Object.entries(CATEGORIES)
    .map(([key, { label }]) => {
      const inCat = tools.filter((t) => t.category === key);
      if (!inCat.length) return "";
      const lines = inCat.map(
        (t) => `- \`${t.route}\` — ${t.price}/call. ${t.description} Docs: ${baseUrl}/tools/${t.slug}`
      );
      return `### ${label}\n\n${lines.join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return `# Agent402 — ${tools.length} pay-per-call tools for AI agents

> Machine-payable web tools, paid in USDC on Base via the x402 payment protocol (v2). No signup, no API keys, no subscriptions: call an endpoint, receive an HTTP 402 challenge with exact payment requirements, pay with any x402 v2 client (e.g. @x402/fetch + @x402/evm), and retry to get the result. Prices range $0.001–$0.02 per call.

Base URL: ${baseUrl}

## Why agents use this instead of building it themselves

1. **Capabilities your sandbox doesn't have.** Most agent runtimes have no headless browser, restricted or no network egress, and no durable disk. /api/render, /api/screenshot, and /api/memory exist precisely because agents cannot self-host them mid-task.
2. **State that survives the session.** /api/memory is keyed to the paying wallet — the payment IS the authentication. An agent can persist findings today and read them next week from a totally different machine, with zero credentials to store or leak.
3. **Cheaper than reimplementing.** Writing, testing, and debugging a CSV parser or cron calculator mid-task burns far more tokens than a $0.001 call. The math favors calling a tested endpoint.
4. **One integration, ${tools.length} tools.** A single x402-wrapped fetch covers the whole catalogue. No per-service SDKs, signups, or API-key management.
5. **Verifiable and stateless billing.** Every call settles on-chain in seconds. No invoices, no rate-limit tiers, no account to get banned.

## Paid endpoints (${tools.length})

${sections}

## Free endpoints

- \`GET /api/pricing\` — machine-readable catalog (JSON): every endpoint, price, category, and docs URL.
- \`GET /openapi.json\` — full OpenAPI 3.1 spec with input/output schemas for all tools.
- \`GET /tools\` and \`GET /tools/{slug}\` — human-readable docs per tool.
- \`GET /health\` — health check.

## How to pay (JavaScript example)

\`\`\`js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("${baseUrl}/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
\`\`\`

## Notes for agents

- Payments settle in seconds on Base (eip155:8453); the payer needs USDC only (gas is sponsored).
- \`/api/memory\` namespaces are owned by the paying wallet: only the wallet that wrote a key can read it. Use it for durable state between runs.
- \`/api/render\` runs a real headless Chromium with JavaScript execution — use it when \`/api/extract\` returns an empty shell for SPA pages.
- All endpoints publish full input/output schemas via the x402 Bazaar discovery extension and ${baseUrl}/openapi.json.
`;
}
