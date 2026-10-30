// Machine Ledger — Docs landing page (/docs)
// Quickstart, a #why pointer to the home page (/why redirects to /#why), payment flow, three ways in, free tier,
// examples (#examples; /use-cases redirects to it), badges (#badges; /badges redirects to it), reference endpoints -
// rendered inside the SAME sidebar+content shell every /docs/:slug wiki page
// uses (src/docs.js), so the docs surface reads as one site with persistent
// navigation instead of two unrelated layouts a click apart. Before this,
// landing on /docs showed an anchor-only mini-TOC scoped to this one page;
// clicking into any real wiki doc suddenly revealed a completely different
// layout with a real navigation tree - the opposite of what a GitBook-style
// docs hub should feel like.

import { ledgerShell, ledgerFooterCompact, fmtNum } from "./ledger-chrome.js";
import { docsLayoutHtml, DOCS_LAYOUT_CSS, docPrevNextHtml, DOCS_SEARCH_SCRIPT } from "./docs.js";
import { RAILS_PAREN } from "./rails.js";
import { toolList } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { decideConfig } from "./decide/config.js";
import { whyDocsStubHtml } from "./why.js";
import { examplesSectionHtml, examplesJsonLd, EXAMPLES_SECTION_CSS } from "./use-cases.js";
import { badgesSectionHtml, BADGES_SECTION_CSS } from "./badges.js";


// One price format for every figure this page quotes: at least two decimals,
// three below a cent ("$0.003", "$0.08", "$3.30").
export function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return "$" + (v > 0 && v < 0.01 ? v.toFixed(3) : v.toFixed(2));
}

// Price of a catalog entry by slug, as a number (null when the route is not served here).
function slugPrice(catalog, slug) {
  for (const def of Object.values(catalog || {})) {
    if (def && def.slug === slug) {
      const n = Number(String(def.price ?? "").replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

// The /v1 rows this page lists, each read from the catalog; a row whose route
// is not served on this instance (an env-gated one) is left out.
const GATEWAY_ROWS = [
  { slug: "v1-chat-metered", path: "/v1/metered/chat/completions", note: (p) => `from ${p} &middot; quoted per request from its body, settles what the call used under that quote` },
  { slug: "v1-chat-metered-messages", path: "/v1/metered/messages", note: (p) => `from ${p} &middot; the same quote-then-settle-actual pricing on the Anthropic Messages wire` },
  { slug: "v1-chat-metered-responses", path: "/v1/metered/responses", note: (p) => `from ${p} &middot; the same pricing on the OpenAI Responses wire (Agents SDK, Codex CLI)` },
  { slug: "v1-chat", path: "/v1/chat/completions", note: (p, c) => `${p} &middot; base tier (${c.nano}&ndash;${c.premium} across the nano&hellip;premium paths)` },
  { slug: "v1-chat-auto", path: "/v1/auto/chat/completions", note: (p) => `${p} &middot; model optional, auto-routed` },
  { slug: "v1-embeddings", path: "/v1/embeddings", note: (p) => `${p} &middot; free repeat within 10 min` },
  { slug: "v1-images", path: "/v1/images/generations", note: (p) => `${p} per image` },
  { slug: "v1-audio-speech", path: "/v1/audio/speech", note: (p) => `${p} &middot; mp3/pcm bytes out` },
];

function gatewayHtml(catalog) {
  const p = (slug) => { const n = slugPrice(catalog, slug); return n == null ? null : fmtUsd(n); };
  const tiers = { nano: p("v1-chat-nano"), premium: p("v1-chat-premium"), auto: p("v1-chat-auto"), embed: p("v1-embeddings"), image: p("v1-images") };
  const rows = GATEWAY_ROWS.filter((r) => p(r.slug) != null);
  const listed = new Set(rows.map((r) => r.slug));
  const more = Object.values(catalog || {}).filter((d) => d && d.category === "llm" && String(d.route || "").includes(" /v1/") && !listed.has(d.slug)).length;
  const chatTiers = tiers.nano && tiers.premium ? `Chat has flat quality tiers (${tiers.nano} nano to ${tiers.premium} premium)${tiers.auto ? ` plus a ${tiers.auto} auto tier that routes on your prompt with no model required` : ""}` : "Chat has flat quality tiers";
  const extras = [tiers.embed ? `embeddings are ${tiers.embed} with a default-on cache` : "", tiers.image ? `image generation is ${tiers.image} per image` : ""].filter(Boolean).join("; ");
  const rowHtml = rows.map((r, i) => `        <div class="ml-ref-row"${i < rows.length - 1 || more ? ' style="border-bottom:1px solid var(--hairline);"' : ""}><span style="color:var(--accent);font-weight:700;">POST</span><span>${r.path}</span><span style="color:var(--faint);">${r.note(p(r.slug), tiers)}</span></div>`).join("\n");
  const moreHtml = more ? `\n        <div class="ml-ref-row"><span></span><span><a href="/tools/category/llm" style="color:var(--ink);text-decoration:underline;text-underline-offset:3px;">and ${more} more /v1 routes</a></span><span style="color:var(--faint);">every /v1 route with its price</span></div>` : "";
  return { prose: `${chatTiers}${extras ? `; ${extras}` : ""}.`, rows: rowHtml + moreHtml };
}

export function ledgerDocsPage(baseUrl, catalog) {
  const tools = toolList(catalog);
  const totalCount = tools.length;
  const freeCount = tools.filter(isComputePayable).length;
  const gateway = gatewayHtml(catalog);
  const extractPrice = slugPrice(catalog, "extract");
  const canonical = baseUrl + "/docs";
  const title = "Docs - Agent402 x402 + MCP server";
  const description = `Add ${fmtNum(totalCount)} x402 tools, most of them deterministic code, plus an OpenAI-compatible /v1 gateway to your agent in about a minute. No signup, no API key - start free with proof-of-work, settle ${RAILS_PAREN} when you scale.`;

  const articleLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    name: "Agent402.Tools Documentation",
    url: canonical,
    description,
    publisher: {
      "@type": "Organization",
      name: "Agent402.Tools",
      url: baseUrl,
    },
  };
  // The "Why pay here" points live on the home page (/#why); this page keeps
  // an id="why" pointer so old /docs#why links still land on something.
  const jsonLd = [articleLd, examplesJsonLd(baseUrl)];

  const extraCss = `${DOCS_LAYOUT_CSS}
  #quickstart, #why, #how, #add, #free, #gateway, #endpoints { scroll-margin-top: 110px; }${EXAMPLES_SECTION_CSS}${BADGES_SECTION_CSS}`;

  const main = `
      <section>
      <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px;">Quickstart.</h1>
      <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:76ch;margin:0 0 30px;">Add ${fmtNum(totalCount)} tools - plus an open cross-seller Index, Smart Order Router, and an OpenAI-compatible /v1 gateway - to your agent in about a minute. No signup, no API key - start free with proof-of-work, settle ${RAILS_PAREN} when you scale.</p>

      <div id="quickstart" style="border:1px solid var(--hairline);background:var(--panel);margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:7px;padding:11px 15px;border-bottom:1px solid var(--panel-rule-2);font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--on-panel-dim);">terminal</div>
        <pre style="margin:0;padding:18px;font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.85;color:var(--on-panel);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--on-panel-faint);"># one file, no install - pays with COMPUTE (no wallet)
</span>curl -s https://agent402.tools/demo.js -o demo.js
node demo.js

<span style="color:var(--on-panel-faint);"># or settle USDC on Base with a funded EVM key (four packages, same file)
</span>npm i @x402/core @x402/evm @x402/fetch viem
<span style="color:var(--on-panel-faint);"># Use a new wallet holding only a few dollars of USDC. Never your main wallet.
</span>AGENT_KEY=0xYOUR_FUNDED_KEY node demo.js</pre>
      </div>
      <p style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--faint);margin:0 0 14px;">// an autonomous buyer discovers the catalog, gets quoted over HTTP 402, settles, and uses the result - zero humans.</p>
      <p style="font-size:var(--fs-md);color:var(--muted);max-width:76ch;margin:0 0 44px;">The demo signs on the EVM rails. To pay on Solana, Stellar or Algorand, see <a href="/docs/Paying-with-x402" style="color:var(--ink);text-decoration:underline;text-underline-offset:3px;">Paying with x402</a>.</p>
      </section>

      ${whyDocsStubHtml()}      <!-- HOW -->
      <section>
      <h2 id="how" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 18px;">How payment works.</h2>
      <div style="border:1px solid var(--hairline);background:var(--card);margin-bottom:44px;">
        <div style="display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 20px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:var(--fs-lg);">01</span><span style="font-size:var(--fs-base);line-height:1.5;color:var(--muted);">Your agent calls a paid endpoint and receives <strong>HTTP 402 Payment Required</strong> with the price and payment details.</span></div>
        <div style="display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 20px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:var(--fs-lg);">02</span><span style="font-size:var(--fs-base);line-height:1.5;color:var(--muted);">An x402 client (<span style="font-family:var(--font-mono);font-size:var(--fs-sm);">@x402/fetch</span>, axios, or any framework adapter) signs a USDC payment from its wallet and retries.</span></div>
        <div style="display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 20px;"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:var(--fs-lg);">03</span><span style="font-size:var(--fs-base);line-height:1.5;color:var(--muted);">Payment settles on-chain (Base or any rail the 402 offers) and the response comes back. Total overhead: <strong>one extra round trip</strong>.</span></div>
      </div>
      </section>

      <!-- THREE WAYS -->
      <section>
      <h2 id="add" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 18px;">Three ways in.</h2>

      <div class="ml-meta" style="font-size:var(--fs-xs);color:var(--accent);margin:0 0 8px;"><span>A / MCP</span><span>Claude &amp; any MCP client</span></div>
      <div style="border:1px solid var(--hairline);background:var(--panel);margin-bottom:22px;"><pre style="margin:0;padding:16px;font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.8;color:var(--on-panel);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--on-panel-faint);"># Claude Code - hosted connector (no install; free proof-of-work tools, paid tools need a wallet client)
</span>claude mcp add --transport http agent402 https://agent402.tools/mcp

<span style="color:var(--on-panel-faint);"># Claude Code - npm server with a funded EVM key (paid tools settle via x402)
# Use a new wallet holding only a few dollars of USDC. Never your main wallet.
</span>claude mcp add agent402 -s user -e AGENT_KEY=0xYOUR_FUNDED_KEY -- npx -y agent402-mcp@0.13.25

<span style="color:var(--on-panel-faint);"># Cursor - ~/.cursor/mcp.json
</span>{
  "mcpServers": {
    "agent402": { "url": "https://agent402.tools/mcp" }
  }
}</pre></div>
      <p style="font-size:var(--fs-md);color:var(--muted);margin:-12px 0 22px;">Every other host, each block read from its own docs: <a href="/guides/agent-hosts" style="color:var(--ink);text-decoration:underline;text-underline-offset:3px;">VS Code, Windsurf, Cline, Roo Code, OpenAI Codex CLI, Gemini CLI, Continue, ElizaOS, Bedrock AgentCore, any OpenAI or Anthropic SDK</a>. Shortlinks: <span style="font-family:var(--font-mono);">agent402.sh/cursor</span>, <span style="font-family:var(--font-mono);">agent402.sh/vscode</span>, <span style="font-family:var(--font-mono);">agent402.sh/codex</span>; one-shot install <span style="font-family:var(--font-mono);">curl -fsSL agent402.sh/install | sh</span>.</p>

      <div class="ml-meta" style="font-size:var(--fs-xs);color:var(--accent);margin:0 0 8px;"><span>B / x402 client</span><span>pay in code</span></div>
      <div style="border:1px solid var(--hairline);background:var(--panel);margin-bottom:22px;"><pre style="margin:0;padding:16px;font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.8;color:var(--on-panel);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--on-panel-faint);">// npm i @x402/core @x402/evm @x402/fetch viem
</span>import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
client.setSpendControls?.(false);  <span style="color:var(--on-panel-faint);">// your own code bounds spend</span>
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("https://agent402.tools/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com" })
});
console.log(await res.json());</pre></div>

      <div class="ml-meta" style="font-size:var(--fs-xs);color:var(--accent);margin:0 0 8px;"><span>C / SDK</span><span>resolves a task &amp; pays automatically</span></div>
      <div style="border:1px solid var(--hairline);background:var(--panel);margin-bottom:44px;"><pre style="margin:0;padding:16px;font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.8;color:var(--on-panel);white-space:pre-wrap;word-break:break-word;">npm install agent402-client
import { Agent402 } from "agent402-client";
const a = new Agent402();           <span style="color:var(--on-panel-faint);">// free tier (proof-of-work)</span>
const out = await a.call("hash", { text: "hello", algo: "sha256" });</pre></div>
      </section>

      <!-- FREE -->
      <section>
      <h2 id="free" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 14px;">Free tier - proof-of-work.</h2>
      <p style="font-size:var(--fs-base);line-height:1.55;color:var(--muted);max-width:76ch;margin:0 0 18px;">The ${fmtNum(freeCount)} pure-CPU tools (of ${fmtNum(totalCount)} in the catalog) work with no wallet. Instead of paying USDC, your machine solves a short sha256 puzzle - a fraction of a second of CPU - and the call goes through. Nothing here consumes AI tokens.</p>
      <div style="border:1px solid var(--hairline);background:var(--card);font-family:var(--font-mono);font-size:var(--fs-sm);margin-bottom:44px;"><div class="ml-ref-row"><span style="color:var(--ok);font-weight:700;">GET</span><span style="color:var(--ink);text-decoration:underline;text-underline-offset:3px;">/api/pow/challenge?slug=&lt;tool&gt;</span><span style="color:var(--faint);">returns a challenge; solve it and resend the call with X-Pow-Solution; free, rate-limited</span></div></div>
      </section>

      <!-- GATEWAY -->
      <section>
      <h2 id="gateway" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 14px;">/v1 - OpenAI-compatible LLM gateway.</h2>
      <p style="font-size:var(--fs-base);line-height:1.55;color:var(--muted);max-width:76ch;margin:0 0 18px;">Point any OpenAI SDK at <code>base_url https://agent402.tools/v1</code> and pay per call in USDC over x402 - no API key, no signup, same wallet-is-the-identity model as every other tool. These routes are model-backed. ${gateway.prose} A flat-tier answer carries <code>agent402_metered</code> whenever the same body would have been materially cheaper on the metered route, with the two figures and the endpoint to point at.</p>
      <div style="border:1px solid var(--hairline);background:var(--card);font-family:var(--font-mono);font-size:var(--fs-sm);margin-bottom:44px;">
${gateway.rows}
      </div>
      </section>

      ${catalog["POST /api/decide"] ? (() => { const c = decideConfig(); return `<!-- DECIDE -->
      <section>
      <h2 id="decide" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 14px;">Decide - a plan for any job.</h2>
      <p style="font-size:var(--fs-base);line-height:1.55;color:var(--muted);max-width:76ch;margin:0 0 12px;">Describe a job and get a call-ready plan over this catalog and indexed x402/MPP sellers with a recent live 402. Each step names its tool, endpoint, price and fallbacks, with params that validate against the tool's input schema. Needs no indexed tool covers come back as gaps.</p>
      <p style="font-size:var(--fs-base);line-height:1.55;color:var(--muted);max-width:76ch;margin:0 0 12px;">Every candidate is scored by one formula with the same weights: fit, observed reliability, price, schema quality and a freshness pass mark, with no term for who sells the tool. An outside tool is eligible when a live 402 was seen in the last ${Math.round(c.liveWithinHours / 24)} days and its input schema is known. Every tool in a plan carries <code>firstParty</code>, so you always see whose tool it is.</p>
      <p style="font-size:var(--fs-base);line-height:1.55;color:var(--muted);max-width:76ch;margin:0 0 18px;">A decide fee paid with a wallet comes back as a credit, valid ${c.credit.ttlHours} hours, toward running that plan with <code>/api/decide/execute</code>. First-party steps run at list price; third-party steps are bought from the seller and resold at the seller's price plus a ${c.routingFeePct}% markup. Spend stops at your budget, and any unspent amount returns as credit until the decision's window closes.</p>
      <div style="border:1px solid var(--hairline);background:var(--card);font-family:var(--font-mono);font-size:var(--fs-sm);margin-bottom:44px;">
        <div class="ml-ref-row" style="border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/decide</span><span style="color:var(--faint);">quick $${c.prices.quick} &middot; plan $${c.prices.plan} &middot; full $${c.prices.full}</span></div>
        <div class="ml-ref-row" style="border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/decide/execute</span><span style="color:var(--faint);">plan budget less credit</span></div>
        <div class="ml-ref-row"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/decide/feedback</span><span style="color:var(--faint);">free</span></div>
      </div>
      </section>

`; })() : ""}      ${examplesSectionHtml(catalog)}
      ${badgesSectionHtml(baseUrl)}
      <!-- ENDPOINTS -->
      <section>
      <h2 id="endpoints" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 18px;">Reference endpoints.</h2>
      <div style="border:1px solid var(--hairline);background:var(--card);font-family:var(--font-mono);font-size:var(--fs-sm);">
        <div class="ml-ref-row" style="border-bottom:1px solid var(--hairline);"><span style="color:var(--ok);font-weight:700;">GET</span><span>/api/pricing</span><span style="color:var(--faint);">machine-readable catalog</span></div>
        <div class="ml-ref-row" style="border-bottom:1px solid var(--hairline);"><span style="color:var(--ok);font-weight:700;">GET</span><span>/openapi.json</span><span style="color:var(--faint);">full OpenAPI 3.1 spec</span></div>
        <div class="ml-ref-row" style="border-bottom:1px solid var(--hairline);"><span style="color:var(--ok);font-weight:700;">GET</span><span>/api/stats</span><span style="color:var(--faint);">live counts &amp; receiving wallet</span></div>
        <div class="ml-ref-row" style="border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/extract</span><span style="color:var(--faint);">${extractPrice != null ? `${fmtUsd(extractPrice)} &middot; ` : ""}url &rarr; clean markdown</span></div>
        <div class="ml-ref-row"><span style="color:var(--ok);font-weight:700;">GET</span><span>/llms.txt</span><span style="color:var(--faint);">agent-readable site map</span></div>
      </div>
      ${docPrevNextHtml("Home")}
      </section>`;

  const body = `
  <div style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;">
    ${docsLayoutHtml("Home", main)}
  </div>

  ${ledgerFooterCompact()}
  ${DOCS_SEARCH_SCRIPT}
  <script src="/js/copy-buttons.js"></script>`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/docs",
    jsonLd,
    extraCss,
    body,
  });
}
