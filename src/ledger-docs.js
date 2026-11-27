// Machine Ledger — Docs landing page (/docs)
// Short answers first, then links: quickstart, payment flow, three ways in, free tier,
// /v1, the "Why pay here" rows (#why), examples (#examples; /use-cases redirects to it)
// and badges (#badges; /badges redirects to it) collapsed as optional detail, reference endpoints -
// rendered inside the SAME sidebar+content shell every /docs/:slug wiki page
// uses (src/docs.js), so the docs surface reads as one site with persistent
// navigation instead of two unrelated layouts a click apart. Before this,
// landing on /docs showed an anchor-only mini-TOC scoped to this one page;
// clicking into any real wiki doc suddenly revealed a completely different
// layout with a real navigation tree - the opposite of what a GitBook-style
// docs hub should feel like.

import { getWalletHtml } from "./get-a-wallet.js";
import { startApps } from "./start-page.js";
import { siteOrgRef } from "./site-org.js";
import { ledgerShell, ledgerFooterCompact, fmtNum, codeBlock, esc } from "./ledger-chrome.js";
import { docsLayoutHtml, DOCS_LAYOUT_CSS, docPrevNextHtml, DOCS_SEARCH_SCRIPT } from "./docs.js";
import { toolList } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { decideConfig } from "./decide/config.js";
import { whyDocsSectionHtml, whyJsonLd, WHY_SECTION_CSS } from "./why.js";
import { examplesSectionHtml, examplesJsonLd, EXAMPLES_SECTION_CSS } from "./use-cases.js";
import { badgesSectionHtml, BADGES_SECTION_CSS } from "./badges.js";
import { articleDates } from "./page-dates.js";
import { RAILS_OR } from "./rails.js";
import { gatewayProductHtml } from "./gateway-product-copy.js";
import { receiptsServed } from "./receipt-signing.js";

// A link in the docs page's own style (the get-a-wallet step).
const DOC_LINK = (href, label) => `<a href="${esc(href)}" style="color:var(--ink);text-decoration:underline;text-underline-offset:3px;">${esc(label)}</a>`;

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
  { slug: "v1-chat-metered", path: "/v1/metered/chat/completions", note: (p) => `from ${p} &middot; quoted from the body` },
  { slug: "v1-chat-metered-messages", path: "/v1/metered/messages", note: (p) => `from ${p} &middot; Messages wire` },
  { slug: "v1-chat-metered-responses", path: "/v1/metered/responses", note: (p) => `from ${p} &middot; Responses wire` },
  { slug: "v1-chat", path: "/v1/chat/completions", note: (p, c) => `${p} &middot; base tier (${c.nano}&ndash;${c.premium})` },
  { slug: "v1-chat-auto", path: "/v1/auto/chat/completions", note: (p) => `${p} &middot; auto-routed` },
  { slug: "v1-embeddings", path: "/v1/embeddings", note: (p) => `${p}` },
  { slug: "v1-images", path: "/v1/images/generations", note: (p) => `${p} per image` },
  { slug: "v1-audio-speech", path: "/v1/audio/speech", note: (p) => `${p}` },
];

function gatewayHtml(catalog) {
  const p = (slug) => { const n = slugPrice(catalog, slug); return n == null ? null : fmtUsd(n); };
  const tiers = { nano: p("v1-chat-nano"), premium: p("v1-chat-premium") };
  const rows = GATEWAY_ROWS.filter((r) => p(r.slug) != null);
  const listed = new Set(rows.map((r) => r.slug));
  const more = Object.values(catalog || {}).filter((d) => d && d.category === "llm" && String(d.route || "").includes(" /v1/") && !listed.has(d.slug)).length;
  const rowHtml = rows.map((r, i) => `        <div class="ml-ref-row"${i < rows.length - 1 || more ? ' style="border-bottom:1px solid var(--hairline);"' : ""}><span style="color:var(--accent);font-weight:700;">POST</span><span>${r.path}</span><span style="color:var(--faint);">${r.note(p(r.slug), tiers)}</span></div>`).join("\n");
  const moreHtml = more ? `\n        <div class="ml-ref-row"><span></span><span><a href="/tools/category/llm" style="color:var(--ink);text-decoration:underline;text-underline-offset:3px;">and ${more} more /v1 routes</a></span><span></span></div>` : "";
  return { rows: rowHtml + moreHtml };
}

export function ledgerDocsPage(baseUrl, catalog) {
  // The no-terminal path first: the custom connector step /start gives Claude desktop.
  const CONNECTOR_APP = startApps(baseUrl).find((a) => a.id === "claude-desktop");
  const tools = toolList(catalog);
  const totalCount = tools.length;
  const freeCount = tools.filter(isComputePayable).length;
  const gateway = gatewayHtml(catalog);
  const extractPrice = slugPrice(catalog, "extract");
  const canonical = baseUrl + "/docs";
  const title = "Docs - Agent402 x402 + MCP server";
  const description = `The Agent402 docs: add ${fmtNum(totalCount)} x402 tools, most of them deterministic code, plus an OpenAI-compatible /v1 gateway to your agent. Start free with proof-of-work, then pay per call in USDC over x402 or MPP.`;

  const articleLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    name: "Agent402.Tools Documentation",
    headline: "Agent402.Tools Documentation",
    url: canonical,
    description,
    publisher: siteOrgRef(baseUrl),
  };
  // The "Why pay here" points render in full here (#why); the home page shows
  // three short claims that link to them.
  const jsonLd = [articleLd, examplesJsonLd(baseUrl), whyJsonLd(baseUrl)];

  const extraCss = `${DOCS_LAYOUT_CSS}${WHY_SECTION_CSS}
  #quickstart, #why, #how, #add, #free, #gateway, #endpoints { scroll-margin-top: 110px; }
  .doc-more { border:1px solid var(--hairline);background:var(--card);margin:0 0 44px; }
  .doc-more > summary { cursor:pointer;padding:14px 18px;font-weight:600;font-size:var(--fs-base);color:var(--ink); }
  .doc-more[open] > summary { border-bottom:1px solid var(--hairline); }
  .doc-more .ex-grid { margin:14px; }
  .doc-more .why-cmp-wrap { border:0; }${EXAMPLES_SECTION_CSS}${BADGES_SECTION_CSS}`;

  // Short answers first, then links: each section answers in a sentence or
  // two and points at the page that holds the detail (the /docs/:slug guides,
  // /pricing, /start), so the hub stays a hub (scripts/test-hub-page-words.js).
  const H2 = (id, text, mb = 14) => `<h2 id="${id}" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 ${mb}px;">${text}</h2>`;
  const P = (html, mb = 18) => `<p style="font-size:var(--fs-base);line-height:1.55;color:var(--muted);max-width:76ch;margin:0 0 ${mb}px;">${html}</p>`;
  const STEP = (n, html, last = false) => `<div style="display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 20px;${last ? "" : "border-bottom:1px solid var(--hairline);"}"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:var(--fs-lg);">${n}</span><span style="font-size:var(--fs-base);line-height:1.5;color:var(--muted);">${html}</span></div>`;
  const main = `
      <section>
      <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px;">Docs</h1>
      <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:76ch;margin:0 0 30px;">Add ${fmtNum(totalCount)} tools, the cross-seller index and router, and an OpenAI-compatible /v1 gateway to your agent. Start free with proof-of-work, then pay per call over x402 or MPP.</p>

      <div id="quickstart">${codeBlock(`<span style="color:var(--on-panel-faint);"># one file, no install - pays with COMPUTE (no wallet)
</span>curl -s https://agent402.tools/demo.js -o demo.js
node demo.js

<span style="color:var(--on-panel-faint);"># or settle USDC on Base with a funded EVM key (four packages, same file)
</span>npm i @x402/core @x402/evm @x402/fetch viem
<span style="color:var(--on-panel-faint);"># Use a new wallet holding only a few dollars of USDC. Never your main wallet.
</span>AGENT_KEY=0xYOUR_FUNDED_KEY node demo.js`, { label: "terminal", name: "the terminal commands", html: true, wrap: true, style: "margin-bottom:14px" })}</div>
      ${P(`The demo signs on the EVM chains; to pay on Solana, Stellar or Algorand, see ${DOC_LINK("/docs/Paying-with-x402", "Paying with x402")}.`, 44)}
      </section>

      <!-- HOW -->
      <section>
      ${H2("how", "How payment works.", 18)}
      <div style="border:1px solid var(--hairline);background:var(--card);margin-bottom:44px;">
        ${STEP("01", "Your agent calls a paid endpoint and gets <strong>HTTP 402</strong> with the price.")}
        ${STEP("02", `An x402 client (<span style="font-family:var(--font-mono);font-size:var(--fs-sm);">@x402/fetch</span> or any adapter) signs the payment and retries.`)}
        ${STEP("03", "It settles on chain and the answer comes back: <strong>one extra round trip</strong>.", true)}
      </div>
      <details class="doc-more" style="margin-top:-30px;"><summary>The chains x402 settles on</summary><p style="font-size:var(--fs-md);line-height:1.55;color:var(--muted);max-width:76ch;margin:0;padding:14px 18px;">x402 settles in ${esc(RAILS_OR)}.</p></details>
      </section>

      <!-- THREE WAYS -->
      <section>
      ${H2("add", "Three ways in.", 18)}

      <div class="ml-meta" style="font-size:var(--fs-xs);color:var(--accent);margin:0 0 8px;"><span>A / MCP</span><span>Claude &amp; any MCP client</span></div>
      <p style="font-size:var(--fs-md);color:var(--muted);max-width:76ch;margin:0 0 14px;"><strong style="color:var(--ink);">No terminal, in Claude desktop or claude.ai:</strong> ${esc(CONNECTOR_APP.step)} <code style="font-family:var(--font-mono);font-size:var(--fs-code-inline);">${esc(CONNECTOR_APP.copy)}</code>.</p>
      ${codeBlock(`<span style="color:var(--on-panel-faint);"># Claude Code - hosted connector (no install; free proof-of-work tools, paid tools need a wallet client)
</span>claude mcp add --transport http -s user agent402 https://agent402.tools/mcp

<span style="color:var(--on-panel-faint);"># Claude Code - npm server with a funded EVM key (paid tools settle via x402)
# Use a new wallet holding only a few dollars of USDC. Never your main wallet.
</span>claude mcp add agent402 -s user -e AGENT_KEY=0xYOUR_FUNDED_KEY -- npx -y agent402-mcp@0.17.1

<span style="color:var(--on-panel-faint);"># Cursor - ~/.cursor/mcp.json
</span>{
  "mcpServers": {
    "agent402": { "url": "https://agent402.tools/mcp" }
  }
}

<span style="color:var(--on-panel-faint);"># any host, one-shot install
</span>curl -fsSL agent402.sh/install | sh`, { name: "the MCP setup", html: true, wrap: true, style: "margin-bottom:22px" })}
      <p style="font-size:var(--fs-md);color:var(--muted);max-width:76ch;margin:-12px 0 22px;">${getWalletHtml({ link: DOC_LINK })}</p>
      <p style="font-size:var(--fs-md);color:var(--muted);margin:-12px 0 22px;">Other apps and hosts: ${DOC_LINK("/start", "Start here")} and ${DOC_LINK("/guides/agent-hosts", "the host guide")}.</p>

      <div class="ml-meta" style="font-size:var(--fs-xs);color:var(--accent);margin:0 0 8px;"><span>B / x402 client</span><span>pay in code</span></div>
      ${codeBlock(`<span style="color:var(--on-panel-faint);">// npm i @x402/core @x402/evm @x402/fetch viem
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
console.log(await res.json());`, { name: "the x402 client code", html: true, wrap: true, style: "margin-bottom:22px" })}

      <div class="ml-meta" style="font-size:var(--fs-xs);color:var(--accent);margin:0 0 8px;"><span>C / SDK</span><span>resolves a task &amp; pays automatically</span></div>
      ${codeBlock(`npm install agent402-client
import { Agent402 } from "agent402-client";
const a = new Agent402();           <span style="color:var(--on-panel-faint);">// free tier (proof-of-work)</span>
const out = await a.call("hash", { text: "hello", algo: "sha256" });`, { name: "the SDK code", html: true, wrap: true, style: "margin-bottom:44px" })}
      </section>

      <!-- FREE -->
      <section>
      ${H2("free", "Free tier - proof-of-work.")}
      ${P(`The ${fmtNum(freeCount)} pure-CPU tools need no wallet: your machine solves a short sha256 puzzle instead of paying. Details: ${DOC_LINK("/docs/Paying-with-Compute", "Paying with compute")}.`)}
      <div style="border:1px solid var(--hairline);background:var(--card);font-family:var(--font-mono);font-size:var(--fs-sm);margin-bottom:44px;"><div class="ml-ref-row"><span style="color:var(--ok);font-weight:700;">GET</span><span style="color:var(--ink);text-decoration:underline;text-underline-offset:3px;">/api/pow/challenge?slug=&lt;tool&gt;</span><span style="color:var(--faint);">solve, then resend with X-Pow-Solution</span></div></div>
      </section>

      <!-- GATEWAY -->
      <section>
      ${H2("gateway", "/v1 - OpenAI-compatible LLM gateway.")}
      ${P(`Point any OpenAI SDK at <code>base_url https://agent402.tools/v1</code> and pay per call, with no API key. These routes are model-backed. ${gatewayProductHtml({ receipts: receiptsServed() })} Wires and timeouts: ${DOC_LINK("/docs/LLM-Gateway", "LLM Gateway")}.`)}
      <details class="doc-more"><summary>The /v1 routes and their prices</summary>
      <div style="font-family:var(--font-mono);font-size:var(--fs-sm);">
${gateway.rows}
      </div>
      </details>
      </section>

      ${catalog["POST /api/decide"] ? (() => { const c = decideConfig(); return `<!-- DECIDE -->
      <section>
      ${H2("decide", "Decide - a plan for any job.")}
      ${P(`Describe a job and get a call-ready plan, each step with its tool, price and fallbacks; third-party steps cost the seller's price plus a ${c.routingFeePct}% markup. Rules: ${DOC_LINK("/docs/Decide", "Decide")}.`)}
      <div style="border:1px solid var(--hairline);background:var(--card);font-family:var(--font-mono);font-size:var(--fs-sm);margin-bottom:44px;">
        <div class="ml-ref-row" style="border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/decide</span><span style="color:var(--faint);">quick $${c.prices.quick} &middot; plan $${c.prices.plan} &middot; full $${c.prices.full}</span></div>
        <div class="ml-ref-row" style="border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/decide/execute</span><span style="color:var(--faint);">plan budget less credit</span></div>
        <div class="ml-ref-row"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/decide/feedback</span><span style="color:var(--faint);">free</span></div>
      </div>
      </section>

`; })() : ""}      ${whyDocsSectionHtml()}      ${examplesSectionHtml(catalog)}
      ${badgesSectionHtml(baseUrl)}
      <!-- ENDPOINTS -->
      <section>
      ${H2("endpoints", "Reference endpoints.", 18)}
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
  ${DOCS_SEARCH_SCRIPT}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/docs",
    article: articleDates("/docs"),
    jsonLd,
    extraCss,
    body,
  });
}
