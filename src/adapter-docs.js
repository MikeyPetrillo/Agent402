import { repoUrl } from "./repo-link.js";
import { ledgerShell, ledgerFooterCompact, esc, breadcrumbTrail } from "./ledger-chrome.js";
import { INTEGRATIONS, ADAPTER_CONFIG } from "./integration-pages.js";

// /docs/adapters is the docs section's index of the framework adapters. Each
// adapter has one page, /integrations/<slug> (src/integration-pages.js):
// install, examples, what it exposes, payment, the configuration table and
// what it works with. /docs/adapters/<slug> answers a 301 to it.
const BASE = [
  { slug: "openai", name: "OpenAI", tagline: "OpenAI function calling integration" },
  { slug: "anthropic", name: "Anthropic", tagline: "Anthropic tool use integration" },
  { slug: "ai-sdk", name: "Vercel AI SDK", tagline: "Vercel AI SDK integration" },
  { slug: "langchain", name: "LangChain", tagline: "LangChain tool integration" },
  { slug: "llamaindex", name: "LlamaIndex", tagline: "LlamaIndex tool integration" },
  { slug: "google-adk", name: "Google ADK", tagline: "Google Agent Development Kit integration" },
  { slug: "openai-agents", name: "OpenAI Agents SDK", tagline: "OpenAI Agents SDK integration" },
  { slug: "strands", name: "Strands Agents", tagline: "Strands Agents integration" },
];

export const ADAPTERS = BASE.map((a) => {
  const i = INTEGRATIONS.find((x) => x.docsSlug === a.slug);
  if (!i) throw new Error(`adapter-docs: no /integrations entry for ${a.slug}`);
  return {
    ...a,
    pkg: i.pkg,
    install: i.install,
    quickstart: i.example,
    walletExample: i.walletExample || null,
    noWalletExample: i.noWalletExample || null,
    worksWith: i.worksWith || [],
    config: ADAPTER_CONFIG[i.shape] || [],
    href: `/integrations/${i.slug}`,
    github: repoUrl(`tree/main/${i.dir}`),
  };
});

/* ── index page ──────────────────────────────────────────────────────── */

export function adapterDocsIndex(baseUrl) {
  const canonical = `${baseUrl}/docs/adapters`;
  const title = "Framework Adapters - Agent402 Docs";
  const description = "Adapter documentation for every supported agent framework: OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, OpenAI Agents SDK, and Strands Agents.";

  const cards = ADAPTERS.map((a) => `
    <a class="ml-ad-card" href="${esc(a.href)}">
      <h3 style="margin:0 0 6px;font-size:var(--fs-lg);font-weight:600;color:var(--ink);">${esc(a.name)}</h3>
      <code style="display:inline-block;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:8px;">${esc(a.pkg)}</code>
      <p style="margin:0 0 10px;color:var(--muted);font-size:var(--fs-md);line-height:1.5;">${esc(a.tagline)}</p>
      <span style="color:var(--accent);font-size:var(--fs-md);font-weight:600;">View docs &rarr;</span>
    </a>`).join("\n");

  const extraCss = `
  .ml-ad-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1.25rem;margin-bottom:3rem}
  @media(max-width:680px){.ml-ad-grid{grid-template-columns:1fr}}
  .ml-ad-card{background:var(--card);border:1px solid var(--hairline);padding:1.5rem 1.6rem;text-decoration:none;color:var(--ink);transition:border-color .15s;display:block}
  .ml-ad-card:hover{border-color:var(--accent)}`;

  const crumbs = breadcrumbTrail(baseUrl, [["Home", "/"], ["Docs", "/docs"], ["Adapters", "/docs/adapters"]]);
  const body = `
  <div style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;">
    ${crumbs.nav}
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px;">Framework Adapters.</h1>
    <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:620px;margin:0 0 36px;">Plug Agent402 into your agent framework. Each adapter returns native tool objects: free tools pay with proof-of-work, and paid tools pay through the payment fetch you pass in. More integrations (Coinbase AgentKit, ElizaOS and the Python LangChain toolkit) are on <a href="/integrations" style="color:var(--ink);">/integrations</a>.</p>

    <div class="ml-ad-grid">
${cards}
    </div>

    <div style="text-align:center;margin:2rem 0 0;"><a href="/integrations" style="color:var(--accent);font-weight:600;text-decoration:none;font-size:var(--fs-lg);">See all integrations (MCP, SDKs, and more) &rarr;</a></div>
  </div>
  ${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/docs",
    extraCss,
    jsonLd: crumbs.ld,
    body,
  });
}

/** Where /docs/adapters/<slug> moved: the adapter's /integrations page, or null. */
export function adapterRedirectTarget(slug) {
  return ADAPTERS.find((a) => a.slug === slug)?.href || null;
}
