// /company - who operates the service, what it sells, where the proof is,
// and how to reach the right mailbox. The maintainer is always the company,
// never a person (house rule), and every claim links to the surface that
// shows it.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { fitTitle } from "./seo-meta.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";

import { REPO_URL, repoUrl } from "./repo-link.js";
import { ORG_SAME_AS } from "./org-profiles.js";
import { ERC8004_IDENTITY_REGISTRY, erc8004AgentId } from "./tools/a2a-card.js";
import { companyPostalLine } from "./email.js";
import { mppOffered } from "./site-org.js";
import { LEGAL_ENTITY_NAME, LEGAL_ENTITY_SENTENCE } from "./legal-entity.js";
import { OFFICIAL_SENTENCE, OFFICIAL_DATA_PATH, OFFICIAL_LIST_CSS, officialSurfacesRows } from "./official-surfaces.js";
const usd0 = (cents) => `$${(cents / 100).toFixed(0)}`;
// The business's public contact points, by role: the help address for
// support, billing, legal and abuse, the security address for vulnerability
// reports, the company mailbox for partnerships. The copyright agent's
// address on /terms is the one registered for that agent and is kept there. The phone is the business voice line; the postal address
// is COMPANY_POSTAL_ADDRESS, the same value every outbound email ends with.
export const COMPANY_PHONE = Object.freeze({ display: "(704) 313-8483", tel: "+17043138483" });
export const COMPANY_MAILBOXES = Object.freeze({ operator: "help@agent402.tools", security: "security@agent402.tools", company: "hello@havok.holdings" });
export { LEGAL_ENTITY_SENTENCE } from "./legal-entity.js";

export function companyPage(baseUrl) {
  const canonical = `${baseUrl}/company`;
  const cardCents = Object.values(HUMAN_PRODUCTS).map((p) => Number(p.price)).filter((n) => n > 0);
  const lo = cardCents.length ? Math.min(...cardCents) : 200, hi = cardCents.length ? Math.max(...cardCents) : 500;
  const mon = Object.values(MONITOR_PRODUCTS).map((p) => Number(p.price)).filter((n) => n > 0);
  const monUsd = mon.length ? usd0(Math.min(...mon)) : "$5";
  // The on-chain identity is read through the same reader the registration
  // file publishes from, so this page and the chain cannot disagree.
  const agentId = erc8004AgentId(baseUrl);
  const reg = ERC8004_IDENTITY_REGISTRY;
  const regLink = `<a href="https://basescan.org/address/${esc(reg.address)}" rel="noopener" style="color:var(--ink);">ERC-8004 Identity Registry</a>`;
  const files = `<a href="/.well-known/agent-registration.json" style="color:var(--ink);">/.well-known/agent-registration.json</a>, which names this service, its endpoints and its payment support; an A2A agent card sits beside it at <a href="/.well-known/agent-card.json" style="color:var(--ink);">/.well-known/agent-card.json</a>`;
  const identityText = agentId
    ? `The operator is identified on-chain as well as on this page: Agent402 is <strong>agent ${esc(agentId)}</strong> in the ${regLink} on Base, owned by the treasury wallet that receives payment. The registration points at ${files}. An agent can resolve who operates this catalog from the chain rather than taking a web page's word for it.`
    : `This instance publishes ${files}. It has no on-chain registration in the ${regLink} configured, so the file carries no agent id.`;
  // The entity page names the product it operates, so a search for either
  // name finds it; the h1 says the same.
  const title = fitTitle(["Havok Holdings LLC, the company behind Agent402.Tools", "Havok Holdings LLC, the company behind Agent402"]);
  // The wires follow the MPP switch, as the home h1 does (src/positioning.js).
  const description = `Havok Holdings LLC builds and runs Agent402.Tools, the payment and trust layer for agentic commerce over ${mppOffered() ? "x402 and MPP" : "x402"}, with tools, reports and monitors.`;
  const row = (h, body, links = []) => `
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div class="co-2col" style="display:grid;grid-template-columns:220px 1fr;gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);">
    <h2 style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);font-weight:700;margin:4px 0 0;">${esc(h)}</h2>
    <div><p style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">${body}</p>
    <div class="co-links" style="display:flex;gap:18px;flex-wrap:wrap;">${links.map(([href, label]) => `<a href="${esc(href)}" style="display:inline-flex;align-items:flex-end;min-height:24px;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">${esc(label)} →</a>`).join("")}</div></div>
  </div>
</section>`;
  const op = COMPANY_MAILBOXES.operator, co = COMPANY_MAILBOXES.company, sec = COMPANY_MAILBOXES.security;
  const mail = (a) => `<a href="mailto:${esc(a)}" style="color:var(--ink);">${esc(a)}</a>`;
  const postal = companyPostalLine();
  const contacts = [
    ["Email", `${mail(op)}<br><span style="font-size:var(--fs-base);">Support, billing and refunds, legal and abuse.</span>`],
    ["Security", `A <a href="${repoUrl("security/advisories/new")}" rel="noopener" style="color:var(--ink);">private advisory</a> (preferred, see /security), or email ${mail(sec)}.`],
    ["Partnerships and investors", mail(co)],
    ["Phone", `<a href="tel:${COMPANY_PHONE.tel}" style="color:var(--ink);">${esc(COMPANY_PHONE.display)}</a>`],
    ...(postal ? [["Mail", esc(postal)]] : []),
  ];
  const contactRow = `
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div class="co-2col" style="display:grid;grid-template-columns:220px 1fr;gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);">
    <h2 style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);font-weight:700;margin:4px 0 0;">Contact</h2>
    <div><table class="co-contacts" style="border-collapse:collapse;max-width:820px;margin:0 0 14px;"><tbody>${contacts.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join("")}</tbody></table>
    <p style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">Updates and quick questions: <a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--ink);">@Agent402Tools</a>; bugs and contributions: <a href="${REPO_URL}" rel="noopener" style="color:var(--ink);">the repository</a>.</p>
    <div class="co-links" style="display:flex;gap:18px;flex-wrap:wrap;">${[["/trust", "Trust"], ["/press", "Press kit"], ["https://havok.holdings", "havok.holdings"], [REPO_URL, "Source"], ["https://x.com/Agent402Tools", "X"]].map(([href, label]) => `<a href="${esc(href)}" style="display:inline-flex;align-items:flex-end;min-height:24px;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">${esc(label)} →</a>`).join("")}</div></div>
  </div>
</section>`;
  // The official packages and endpoints (src/official-surfaces.js): the one
  // list the discovery manifest and the README also carry.
  const officialRow = `
<section id="official" style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div class="co-2col" style="display:grid;grid-template-columns:220px 1fr;gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);">
    <h2 style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);font-weight:700;margin:4px 0 0;">Official packages</h2>
    <div><p style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">${esc(OFFICIAL_SENTENCE)}</p>
    <table class="co-contacts co-official" style="border-collapse:collapse;max-width:820px;margin:0 0 14px;"><tbody>${officialSurfacesRows().map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join("")}</tbody></table>
    <div class="co-links" style="display:flex;gap:18px;flex-wrap:wrap;"><a href="${OFFICIAL_DATA_PATH}" style="display:inline-flex;align-items:flex-end;min-height:24px;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">The list as data →</a></div></div>
  </div>
</section>`;
  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">company</span></nav>
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:.98;margin:0 0 18px;color:var(--ink);max-width:900px;text-wrap:balance;">Havok Holdings LLC, the company behind Agent402.</h1>
    <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:820px;margin:0;">Agent402.Tools, the payment and trust layer for agentic commerce, is built and operated by ${LEGAL_ENTITY_NAME} (doing business as <a href="https://havok.holdings" rel="noopener" style="color:var(--ink);">Havok Holdings LLC</a>), a North Carolina company. We run the hosted service at agent402.tools, publish the server under AGPL-3.0 and the client packages under MIT, and settle paid calls on public blockchains, or by card through Stripe.</p>
  </div>
</header>
${row("What we sell", `Per-call tools and metered models to AI agents, paid in USDC over x402 and MPP. Finished, cited reports (${esc(usd0(lo))} to ${esc(usd0(hi))}) and monitors (${esc(monUsd)} a month) to people, by card. An open-source pay-per-crawl gate, the tollbooth, for site owners who want to charge crawlers and agents for their content.`, [["/reports", "Reports"], ["/pricing", "Pricing"], ["/wholesale", "Wholesale"], ["/tollbooth", "Tollbooth"]])}
${row("Proof", `Uptime from two outside observers at /status. Every settled transaction by rail and wire at /revenue. Metered receipts against their quotes at /proof. Material disclosures with on-chain receipts at /transparency. The status, transaction and receipt figures are computed from observations and ledgers; the disclosures link to the on-chain records they describe.`, [["/status", "Status"], ["/revenue", "Transactions"], ["/proof", "Receipts"], ["/transparency", "Disclosures"]])}
${row("Security", `Non-custodial on the payment rails (a buyer signs with their own key and no customer key or crypto balance is held; prepaid card credits are a held balance, stated plainly), open source end to end, with vulnerability disclosure, safe harbor, the data inventory and the controls in the serving path and on the code stated on one page.`, [["/security", "Security"], ["/privacy", "Privacy"], ["/terms", "Terms"]])}
${row("Entity", `${LEGAL_ENTITY_SENTENCE}, a North Carolina limited liability company. <span class="ml-nowrap">D-U-N-S</span> number 142233542. Company site: <a href="https://havok.holdings" rel="noopener" style="color:var(--ink);">havok.holdings</a>. Operator of agent402.tools and publisher of the agent402 npm packages (author field on every package).`, [["https://havok.holdings", "havok.holdings"], ["https://www.npmjs.com/package/agent402-mcp", "npm"]])}
${row("Identity", identityText, [["/.well-known/agent-registration.json", "registration"], ["/.well-known/agent-card.json", "agent card"]])}
${officialRow}
<div id="contact"></div>
${contactRow}
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 48px;">
  <div class="co-form" style="max-width:640px;background:var(--card);border:1px solid var(--hairline);padding:28px 28px 24px;">
    <h2 style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);margin:0 0 6px;">Send a message.</h2>
    <p style="color:var(--muted);font-size:var(--fs-md);margin:0 0 20px;">Opens in your email app, pre-filled and ready to send.</p>
    <form id="contactForm" action="mailto:${esc(COMPANY_MAILBOXES.operator)}" method="POST" enctype="text/plain">
      <div class="co-field"><label for="ct-name">Name</label><input type="text" id="ct-name" name="name" required placeholder="Your name"></div>
      <div class="co-field"><label for="ct-email">Email</label><input type="email" id="ct-email" name="email" required placeholder="you@example.com"></div>
      <div class="co-field"><label for="ct-msg">Message</label><textarea id="ct-msg" name="message" required placeholder="What's on your mind?"></textarea></div>
      <button type="submit" class="btn btn-secondary co-submit">Send message &rarr;</button>
    </form>
  </div>
</section>
${ledgerFooterCompact()}`;
  const extraCss = `@media (max-width:900px){.co-2col{grid-template-columns:minmax(0,1fr)!important}}@media (max-width:600px){.co-links{display:grid!important;grid-template-columns:repeat(2,max-content);gap:8px 28px!important}}
.co-field{display:block;margin-bottom:16px}
.co-field label{display:block;font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink);margin-bottom:6px;font-weight:700}
.co-field input,.co-field textarea{width:100%;padding:11px 14px;background:var(--paper);border:1px solid var(--control);color:var(--ink);font-family:var(--font-body);font-size:var(--fs-md);outline:none}
.co-field input:focus,.co-field textarea:focus{border-color:var(--accent)}
.co-field textarea{min-height:120px;resize:vertical}
.co-submit{align-self:flex-start}
.co-submit:hover{opacity:.85}
.co-contacts th{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);font-weight:700;text-align:left;vertical-align:top;padding:6px 22px 6px 0;white-space:nowrap}
.co-contacts td{font-size:var(--fs-lg);line-height:1.55;color:var(--muted);padding:4px 0}
.co-official td{font-size:var(--fs-base);overflow-wrap:break-word}
${OFFICIAL_LIST_CSS}
@media (max-width:600px){.co-contacts tr{display:block;padding:6px 0}.co-contacts th,.co-contacts td{display:block;padding:0}}`;
  const jsonLd = [
    { "@type": "Organization", "@id": `${baseUrl}/#org`, name: "Havok Holdings LLC", legalName: LEGAL_ENTITY_NAME, duns: "142233542", foundingLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressRegion: "NC", addressCountry: "US" } }, url: "https://havok.holdings", sameAs: ["https://havok.holdings", ...ORG_SAME_AS], brand: { "@type": "Brand", name: "Agent402", alternateName: "Agent402.Tools", url: baseUrl }, contactPoint: [{ "@type": "ContactPoint", contactType: "customer support", email: op, telephone: COMPANY_PHONE.tel }, { "@type": "ContactPoint", contactType: "security", email: sec }, { "@type": "ContactPoint", contactType: "billing support", email: op }, { "@type": "ContactPoint", contactType: "investor relations", email: co }, { "@type": "ContactPoint", contactType: "partnerships", email: co }], telephone: COMPANY_PHONE.tel },
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` }, { "@type": "ListItem", position: 2, name: "Company", item: canonical }] },
  ];
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/company", extraCss, jsonLd, body });
}
