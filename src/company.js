// /company - who operates the service, what it sells, where the proof is,
// and how to reach the right mailbox. The maintainer is always the company,
// never a person (house rule), and every claim links to the surface that
// shows it.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";

import { REPO_URL, ORG_SAME_AS } from "./repo-link.js";
const usd0 = (cents) => `$${(cents / 100).toFixed(0)}`;

export function companyPage(baseUrl) {
  const canonical = `${baseUrl}/company`;
  const cardCents = Object.values(HUMAN_PRODUCTS).map((p) => Number(p.price)).filter((n) => n > 0);
  const lo = cardCents.length ? Math.min(...cardCents) : 200, hi = cardCents.length ? Math.max(...cardCents) : 500;
  const mon = Object.values(MONITOR_PRODUCTS).map((p) => Number(p.price)).filter((n) => n > 0);
  const monUsd = mon.length ? usd0(Math.min(...mon)) : "$5";
  const title = "Havok Holdings LLC";
  const description = `Agent402.Tools is built and operated by Havok Holdings LLC: per-call tools and metered models for AI agents over x402 and MPP, finished reports (${usd0(lo)} to ${usd0(hi)}) and monitors (${monUsd} a month) for people by card, and a pay-per-crawl gate for site owners. Proof, security and contact.`;
  const row = (h, body, links = []) => `
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div class="co-2col" style="display:grid;grid-template-columns:220px 1fr;gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);">
    <h2 style="font-family:var(--font-mono);font-size:13px;color:var(--accent);font-weight:600;margin:4px 0 0;">${esc(h)}</h2>
    <div><p style="font-size:16px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">${body}</p>
    <div style="display:flex;gap:18px;flex-wrap:wrap;">${links.map(([href, label]) => `<a href="${esc(href)}" style="font-family:var(--font-mono);font-size:13px;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">${esc(label)} →</a>`).join("")}</div></div>
  </div>
</section>`;
  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">company</span></nav>
    <h1 style="font-weight:800;font-size:46px;line-height:.98;letter-spacing:-.035em;margin:0 0 18px;color:var(--ink);max-width:900px;">Havok Holdings LLC.</h1>
    <p style="font-size:18px;line-height:1.55;color:var(--muted);max-width:820px;margin:0;">Agent402.Tools is built and operated by <a href="https://havok.holdings" rel="noopener" style="color:var(--ink);">Havok Holdings LLC</a>, a North Carolina company. We run the hosted service at agent402.tools, publish the server under AGPL-3.0 and the client packages under MIT, and settle paid calls on public blockchains, or by card through Stripe.</p>
  </div>
</header>
${row("What we sell", `Per-call tools and metered models to AI agents, paid in USDC over x402 and MPP. Finished, cited reports (${esc(usd0(lo))} to ${esc(usd0(hi))}) and monitors (${esc(monUsd)} a month) to people, by card. A pay-per-crawl gate, the tollbooth, to site owners who want to charge crawlers and agents for their content.`, [["/reports", "Reports"], ["/pricing", "Pricing"], ["/tollbooth", "Tollbooth"]])}
${row("Proof", `Uptime from two outside observers at /status. Every settled transaction by rail and wire at /revenue. Metered receipts against their quotes at /proof. Material disclosures with on-chain receipts at /transparency. All of it is computed from observations and ledgers, none of it is typed by hand.`, [["/status", "Status"], ["/revenue", "Transactions"], ["/proof", "Receipts"], ["/transparency", "Disclosures"]])}
${row("Security", `Non-custodial on the payment rails (a buyer signs with their own key and no customer key or crypto balance is held; prepaid card credits are a held balance, stated plainly), open source end to end, with vulnerability disclosure, safe harbor, the data inventory and the controls in the serving path and on the code stated on one page.`, [["/security", "Security"], ["/privacy", "Privacy"], ["/terms", "Terms"]])}
${row("Entity", `Havok Holdings LLC, a North Carolina limited liability company. D-U-N-S number 142233542. Company site: <a href="https://havok.holdings" rel="noopener" style="color:var(--ink);">havok.holdings</a>. Operator of agent402.tools and publisher of the agent402 npm packages (author field on every package).`, [["https://havok.holdings", "havok.holdings"], ["https://www.npmjs.com/package/agent402-mcp", "npm"]])}
${row("Identity", `The operator is identified on-chain as well as on this page: Agent402 is <strong>agent 94639</strong> in the <a href="https://basescan.org/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" rel="noopener" style="color:var(--ink);">ERC-8004 Identity Registry</a> on Base, owned by the treasury wallet that receives payment. The registration points at <a href="/.well-known/agent-registration.json" style="color:var(--ink);">/.well-known/agent-registration.json</a>, which names this service, its endpoints and its payment support; an A2A agent card sits beside it at <a href="/.well-known/agent-card.json" style="color:var(--ink);">/.well-known/agent-card.json</a>. An agent can resolve who operates this catalog from the chain rather than taking a web page's word for it.`, [["/.well-known/agent-registration.json", "registration"], ["/.well-known/agent-card.json", "agent card"]])}
<div id="contact"></div>
${row("Contact", `General, security, legal and abuse: <a href="mailto:mike@agent402.tools" style="color:var(--ink);">mike@agent402.tools</a> (security reports: the private advisory on GitHub is preferred, see /security). Investors and partnerships: <a href="mailto:hello@havok.holdings" style="color:var(--ink);">hello@havok.holdings</a>. Updates and quick questions: <a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--ink);">@Agent402Tools</a>; bugs and contributions: <a href="${REPO_URL}" rel="noopener" style="color:var(--ink);">the repository</a>.`, [["https://havok.holdings", "havok.holdings"], [REPO_URL, "Source"], ["https://x.com/Agent402Tools", "X"]])}
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 48px;">
  <div class="co-form" style="max-width:640px;background:var(--card);border:1px solid var(--hairline);padding:28px 28px 24px;">
    <h2 style="font-family:var(--font-body);font-weight:800;font-size:24px;margin:0 0 6px;">Send a message.</h2>
    <p style="color:var(--muted);font-size:14px;margin:0 0 20px;">Opens in your email app, pre-filled and ready to send.</p>
    <form id="contactForm" action="mailto:mike@agent402.tools" method="POST" enctype="text/plain">
      <div class="co-field"><label for="ct-name">Name</label><input type="text" id="ct-name" name="name" required placeholder="Your name"></div>
      <div class="co-field"><label for="ct-email">Email</label><input type="email" id="ct-email" name="email" required placeholder="you@example.com"></div>
      <div class="co-field"><label for="ct-msg">Message</label><textarea id="ct-msg" name="message" required placeholder="What's on your mind?"></textarea></div>
      <button type="submit" class="co-submit">Send message &rarr;</button>
    </form>
    <p style="color:var(--faint);font-size:12.5px;margin:14px 0 0;line-height:1.5;">No email app on this device? Copy the address instead: <a href="mailto:mike@agent402.tools" style="color:var(--muted);">mike@agent402.tools</a></p>
  </div>
</section>
${ledgerFooterCompact()}`;
  const extraCss = `@media (max-width:900px){.co-2col{grid-template-columns:minmax(0,1fr)!important}}
.co-field{display:block;margin-bottom:16px}
.co-field label{display:block;font-family:var(--font-mono);font-size:12px;color:var(--ink);margin-bottom:6px;font-weight:700}
.co-field input,.co-field textarea{width:100%;padding:11px 14px;background:var(--paper);border:1px solid var(--hairline);color:var(--ink);font-family:var(--font-body);font-size:14px;outline:none}
.co-field input:focus,.co-field textarea:focus{border-color:var(--accent)}
.co-field textarea{min-height:120px;resize:vertical}
.co-submit{background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;border:none;padding:12px 24px;cursor:pointer}
.co-submit:hover{opacity:.85}`;
  const jsonLd = [
    { "@type": "Organization", "@id": `${baseUrl}/#org`, name: "Havok Holdings LLC", legalName: "Havok Holdings LLC", duns: "142233542", foundingLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressRegion: "NC", addressCountry: "US" } }, url: "https://havok.holdings", sameAs: ["https://havok.holdings", ...ORG_SAME_AS], brand: { "@type": "Brand", name: "Agent402", alternateName: "Agent402.Tools", url: baseUrl }, contactPoint: [{ "@type": "ContactPoint", contactType: "customer support", email: "mike@agent402.tools" }, { "@type": "ContactPoint", contactType: "security", email: "mike@agent402.tools" }, { "@type": "ContactPoint", contactType: "investor relations", email: "hello@havok.holdings" }] },
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` }, { "@type": "ListItem", position: 2, name: "Company", item: canonical }] },
  ];
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/company", extraCss, jsonLd, body });
}
