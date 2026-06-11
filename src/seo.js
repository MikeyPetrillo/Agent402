export function robotsTxt(baseUrl) {
  return `User-agent: *
Allow: /
Disallow: /api/memory

Sitemap: ${baseUrl}/sitemap.xml
`;
}

export function sitemapXml(baseUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${baseUrl}/llms.txt</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>${baseUrl}/api/pricing</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
</urlset>
`;
}

export function llmsTxt(baseUrl, catalog) {
  const lines = Object.entries(catalog).map(([route, { price, description }]) => {
    return `- \`${route}\` — ${price}/call. ${description}`;
  });
  return `# Agent402

> Pay-per-call web tools for AI agents, paid in USDC on Base via the x402 payment protocol (v2). No signup, no API keys: call an endpoint, receive an HTTP 402 challenge with payment requirements in the PAYMENT-REQUIRED header, pay with any x402 v2 client (e.g. @x402/fetch + @x402/evm), and retry to get the result.

Base URL: ${baseUrl}

## Paid endpoints

${lines.join("\n")}

## Free endpoints

- \`GET /api/pricing\` — machine-readable catalog (JSON) of all endpoints and prices.
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
- All endpoints publish full input/output schemas via the x402 Bazaar discovery extension.
`;
}
