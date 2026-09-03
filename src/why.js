// /why - what is actually different about paying here, in one page, every
// claim linked to the surface that proves it. Written for the agent-facing
// surfaces (llms.txt, MCP instructions, package READMEs) to point at, so the
// seven points live in ONE place and read the same everywhere. First-party
// claims only: no comparisons, no third-party names, evergreen "500+" counts.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export const WHY_POINTS = [
  {
    id: "actual",
    kicker: "01 / PRICE",
    h: "Pay for what the model used, with the ceiling quoted first.",
    p: "On the metered gateway every 402 quotes this exact request from its own body. A wallet that can pay upto settles the actual usage under that ceiling; provider discounts such as prompt-cache reads pass through at cost. Every settled x402 or MPP response carries a receipt.",
    links: [["/tools/v1-chat-metered", "the metered tier"], ["/guides/openclaw-model-provider", "OpenClaw setup"]],
  },
  {
    id: "never-charged",
    kicker: "02 / FAILURE",
    h: "A failed call is not charged, and the response proves it.",
    p: "Settlement runs after the handler answers and an error status cancels it, so a response with no payment receipt, or a receipt marked success:false, moved no money. A retry that carries the same idempotency key and the same payment credential replays the paid answer instead of paying again. The one residual case, a settled receipt on an error response, is detected by our own alarm and recorded as a debt in a refund ledger, never written off silently.",
    links: [["/status", "uptime measured from outside"], ["/guides/x402-and-mpp", "how the paywall settles"]],
  },
  {
    id: "one-key",
    kicker: "03 / ONE KEY",
    h: "One key buys everything.",
    p: "The same wallet or credits key pays for five LLM tiers on three wires (OpenAI chat, OpenAI Responses, Anthropic Messages), embeddings, rerank, images, video, speech, transcription, grounded answers with citations, 500+ tools, wallet-keyed memory and finished reports. One paywall, one key.",
    links: [["/tools", "the catalog"], ["/v1/models", "gateway models"], ["/reports", "reports"]],
  },
  {
    id: "no-wallet",
    kicker: "04 / NO WALLET",
    h: "No wallet required.",
    p: "Prepaid credits by card, cards over MPP, and card checkout for reports sit beside USDC or USDG on twelve chains and native MPP on Tempo. An agent with no crypto can be buying in minutes; an agent with a wallet never needs an account.",
    links: [["/credits", "prepaid credits"], ["/reports", "buy a report by card"]],
  },
  {
    id: "deliverables",
    kicker: "05 / DELIVERABLES",
    h: "Finished work, ready to use.",
    p: "Company dossiers, insider flow, 13F holdings, filing reports, IPO digests, domain audits, token risk, deep research, market briefs, recall watch and a LinkedIn article package, grounded in primary sources with a data appendix. Monitors probe daily for free and re-run the paid report when the facts change.",
    links: [["/reports", "report products"], ["/monitors", "monitors"]],
  },
  {
    id: "route",
    kicker: "06 / ROUTING",
    h: "We buy on your behalf.",
    p: "Route-and-execute resolves a task to the best seller across the whole ecosystem, ours or anyone else's, pays them from our own wallet on the agent's behalf and relays the result under one receipt. Only sellers with proven on-chain settlement are routable.",
    links: [["/tools/route-execute", "route-and-execute"], ["/marketplace", "the seller index"]],
  },
  {
    id: "proof",
    kicker: "07 / PROOF",
    h: "Everything is checkable.",
    p: "Uptime is observed by two probes outside production, a real-money canary buys through every rail daily, transactions are published by rail and by wire, and the whole server is open source and self-hostable. Tools are deterministic: no model in the serving path.",
    links: [["/proof", "receipts"], ["/status", "status"], ["/revenue", "transactions"], ["https://github.com/MikeyPetrillo/Agent402", "source"]],
  },
];

/** One-line-per-point plain text for agent surfaces (llms.txt, MCP instructions). */
export function whyPointsPlain() {
  return WHY_POINTS.map((w) => `${w.h} ${w.p}`);
}

export function whyPage(baseUrl) {
  const canonical = `${baseUrl}/why`;
  const title = "Why pay here: seven things that are different about Agent402";
  const description =
    "What is different about buying tools, models and reports from Agent402: pay actual usage under a quoted ceiling, failed calls not charged with the receipt as proof, one key for everything, no wallet needed, finished reports, routing that buys on your behalf, and proof you can check.";

  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Why pay here", item: canonical },
  ] };
  const listLd = { "@type": "ItemList", "@id": `${canonical}#list`, name: title, itemListElement: WHY_POINTS.map((w, i) => ({ "@type": "ListItem", position: i + 1, name: w.h, description: w.p, url: `${canonical}#${w.id}` })) };
  const articleLd = { "@type": "Article", "@id": `${canonical}#article`, headline: title, description, publisher: { "@type": "Organization", name: "Agent402", url: baseUrl }, mainEntityOfPage: canonical };

  const extraCss = `
@media (max-width:900px){.why-2col{grid-template-columns:minmax(0,1fr)!important}}
`;
  const linkHtml = (href, label) =>
    `<a href="${esc(href)}" style="font-family:var(--font-mono);font-size:13px;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">${esc(label)} →</a>`;
  const pointsHtml = WHY_POINTS.map((w) => `
<section id="${w.id}" style="max-width:1180px;margin:0 auto;padding:44px 30px 0;">
  <div class="why-2col" style="display:grid;grid-template-columns:220px 1fr;gap:30px;padding-bottom:44px;border-bottom:1px solid var(--hairline);">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);">${esc(w.kicker)}</div>
    <div>
      <h2 style="font-weight:800;font-size:30px;line-height:1.08;letter-spacing:-.02em;margin:0 0 14px;color:var(--ink);">${esc(w.h)}</h2>
      <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;">${esc(w.p)}</p>
      <div style="display:flex;gap:18px;flex-wrap:wrap;">${w.links.map(([href, label]) => linkHtml(href, label)).join("")}</div>
    </div>
  </div>
</section>`).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">why pay here</span>
    </nav>
    <h1 style="font-weight:800;font-size:52px;line-height:.96;letter-spacing:-.035em;margin:0 0 22px;color:var(--ink);max-width:900px;">Seven things that are different about paying here.</h1>
    <p style="font-size:18px;line-height:1.55;color:var(--muted);max-width:820px;margin:0;">Every claim on this page links to the surface that proves it: what the server does, measured on the server, on the open protocols anyone can build on, x402 and MPP.</p>
  </div>
</header>
${pointsHtml}
<section style="max-width:1180px;margin:0 auto;padding:56px 30px 56px;">
  <div style="background:var(--surface);border:1px solid var(--hairline);padding:44px 40px;">
    <h2 style="font-weight:800;font-size:32px;line-height:1.05;letter-spacing:-.025em;margin:0 0 14px;color:var(--on-dark);">Start with one call.</h2>
    <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);margin:0 0 24px;max-width:600px;">Add the hosted MCP connector, buy prepaid credits by card, or pay per call in USDC from a wallet. All three reach the same catalog. Selling into it is open too: the tollbooth charges agents per request on your own API over both protocols.</p>
    <div style="display:flex;gap:11px;flex-wrap:wrap;">
      <a href="/docs#add" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">ADD TO YOUR AGENT →</a>
      <a href="/credits" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">PREPAID CREDITS</a>
      <a href="/reports" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">GET A REPORT</a>
      <a href="/sell" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">SELL YOUR API</a>
    </div>
  </div>
</section>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/why", extraCss, jsonLd: [breadcrumbLd, listLd, articleLd], body });
}
