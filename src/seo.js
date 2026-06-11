import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable, POW_DIFFICULTY } from "./pow.js";

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
    { loc: `${baseUrl}/api/stats`, priority: "0.6" },
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
      // Summarize very large generated families instead of listing every endpoint.
      if (inCat.length > 40) {
        const sample = inCat.slice(0, 6).map((t) => `\`${t.route.split(" ")[1]}\``).join(", ");
        return `### ${label}\n\n- ${inCat.length} endpoints, all \`GET /api/convert/{from}-to-{to}?value=N\` at ${inCat[0].price}/call. Examples: ${sample}. Full list: ${baseUrl}/api/pricing (or ${baseUrl}/openapi.json).`;
      }
      const lines = inCat.map(
        (t) => `- \`${t.route}\` — ${t.price}/call. ${t.description} Docs: ${baseUrl}/tools/${t.slug}`
      );
      return `### ${label}\n\n${lines.join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return `# Agent402 — where agents pay agents (machine-to-machine payments)

> A live node in the machine-to-machine economy. Autonomous agents pay per call over HTTP — no human, no signup, no API key. Call an endpoint, receive an HTTP 402 with exact payment requirements, settle from your own wallet in USDC via the x402 protocol (v2, e.g. @x402/fetch + @x402/evm) — or, on ${tools.filter(isComputePayable).length} of the ${tools.length} tools, pay with proof-of-work (CPU) and skip the wallet entirely. Retry with the proof and get the result. The payment IS the identity. Prices range $0.001–$0.02 per call.

Base URL: ${baseUrl}

## This is machine-to-machine commerce, and you can verify it

- Run the full loop yourself with no human and no funds: \`node scripts/demo-payment.js\` — an autonomous agent discovers the catalog, gets quoted over HTTP 402, pays with compute, and uses the result. (Set AGENT_KEY=0x… to settle in real USDC instead.)
- Live economy stats and the receiving wallet: \`${baseUrl}/api/stats\`. Settled revenue is trustless and public — every paid call lands on-chain, verifiable on Basescan at the wallet shown there.
- The payment is the authentication: /api/memory namespaces are owned by the paying wallet, and wallets can grant each other access to coordinate — agents transacting AND coordinating with payment identity as the primitive.

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
- \`GET /api/pow\` — describes the proof-of-work option below.
- \`GET /api/pow/challenge?slug={tool}\` — get a challenge to pay with CPU instead of USDC.
- \`GET /health\` — health check.

## No wallet? Pay with compute (proof-of-work)

Agents that cannot pay USDC can access the **pure-CPU tools** by spending CPU
instead. The network/browser/storage tools (extract, meta, dns, render,
screenshot, pdf, memory, http-check, tls-cert, whois, robots-check, sitemap,
email-validate, ip-info) stay wallet-only; everything else accepts proof-of-work.

1. \`GET ${baseUrl}/api/pow/challenge?slug=hash\` → returns \`{ challenge, difficulty, token, ... }\`.
2. Find an integer \`nonce\` such that \`sha256(challenge + ":" + nonce)\` has at least
   \`difficulty\` (${POW_DIFFICULTY}) leading zero bits.
3. Resend the tool request with header \`X-Pow-Solution: <token>:<nonce>\`.

Each challenge is single-use and expires quickly. Example:

\`\`\`js
import { createHash } from "node:crypto";
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const c = await (await fetch("${baseUrl}/api/pow/challenge?slug=hash")).json();
let n = 0;
while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) < c.difficulty) n++;
const res = await fetch("${baseUrl}/api/hash", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Pow-Solution": c.token + ":" + n },
  body: JSON.stringify({ text: "hello world" }),
});
\`\`\`

## How to pay with USDC (JavaScript example)

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
