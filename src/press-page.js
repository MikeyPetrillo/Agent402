// /press - the brand kit a directory, a writer or an answer engine reads:
// what the service is, how to write its name, the logo and the social card as
// served files, the operating company and one press mailbox. The maintainer is
// the company, never a person; nothing here is a figure that is not read from
// the running server.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { COMPANY_MAILBOXES } from "./company.js";
import { COMPANY_NAME, mppOffered } from "./site-org.js";
import { REPO_URL } from "./repo-link.js";
import { X_PROFILE_URL } from "./org-profiles.js";
import { leadSentence, SUPPORT_LINE } from "./positioning.js";
import { receiptsServed } from "./receipt-signing.js";

const LINK = "font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;";

const row = (h, inner) => `
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div class="pr-2col" style="display:grid;grid-template-columns:220px minmax(0,1fr);gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);">
    <h2 style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);font-weight:700;margin:4px 0 0;">${esc(h)}</h2>
    <div>${inner}</div>
  </div>
</section>`;
const para = (html) => `<p class="ml-measure" style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);margin:0 0 14px;">${html}</p>`;
const links = (pairs) => `<div class="pr-links" style="display:flex;gap:18px;flex-wrap:wrap;">${pairs.map(([href, label]) => `<a href="${esc(href)}" style="${LINK}">${esc(label)} →</a>`).join("")}</div>`;

export function pressPage(baseUrl, { mpp = mppOffered() } = {}) {
  const canonical = `${baseUrl}/press`;
  const host = (() => { try { return new URL(baseUrl).host; } catch { return String(baseUrl); } })();
  const press = COMPANY_MAILBOXES.operator;
  const title = "Agent402 press kit";
  const description = `Agent402.Tools press kit: how to write the name, the logo and social card files, the operating company and the press contact.`;
  const names = [
    ["Agent402.Tools", "The service, in running text"],
    ["Agent402", "Short form, once the full name is given"],
    [host, "The hosted service"],
  ];
  const files = [
    ["/logo.svg", "Logo, SVG, 512 by 512"],
    ["/logo.png", "Logo, PNG, 512 by 512"],
    ["/favicon.svg", "Mark at icon size, SVG"],
    ["/card.png", "Social card, PNG, 1200 by 630"],
    ["/card-1280.png", "Social card, PNG, 1280 by 640"],
  ];
  const table = (rows, code) => `<table class="pr-table" style="border-collapse:collapse;margin:0 0 14px;"><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${code ? `<a href="${esc(k)}" style="color:var(--ink);">${esc(k)}</a>` : esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>`;
  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">press</span></nav>
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:.98;margin:0 0 18px;color:var(--ink);max-width:900px;">Press kit.</h1>
    <p class="ml-measure" style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);margin:0;">${esc(leadSentence({ mpp, receipts: receiptsServed() }))} ${esc(SUPPORT_LINE)} It is built and operated by <a href="/company" style="color:var(--ink);">${esc(COMPANY_NAME)}</a>.</p>
  </div>
</header>
${row("What it is", `${para(`Each tool is an HTTP endpoint and an MCP tool. A call without payment answers HTTP 402 with the price, and the agent pays from its own wallet in USDC. The server is open source under AGPL-3.0 and the client packages under MIT, so anyone can run their own.`)}${links([["/101", "How it works"], [REPO_URL, "Source"]])}`)}
${row("Names", table(names, false))}
${row("Logo and card", `<img src="/logo.svg" width="96" height="96" alt="Agent402 logo" style="display:block;margin:0 0 18px;border-radius:var(--radius);">${table(files, true)}`)}
${row("Company", `${para(`${esc(COMPANY_NAME)} operates ${esc(host)} and publishes the agent402 packages. Entity details, proof and every contact are on the company page.`)}${links([["/company", "Company"]])}`)}
${row("Contact", `${para(`Press and listings: <a href="mailto:${esc(press)}" style="color:var(--ink);">${esc(press)}</a>. Updates: <a href="${esc(X_PROFILE_URL)}" rel="noopener" style="color:var(--ink);">@Agent402Tools</a>.`)}`)}
<div style="height:48px;"></div>
${ledgerFooterCompact()}`;
  const extraCss = `@media (max-width:900px){.pr-2col{grid-template-columns:minmax(0,1fr)!important}}
.pr-table th{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);font-weight:700;text-align:left;vertical-align:top;padding:6px 22px 6px 0;white-space:nowrap}
.pr-table td{font-size:var(--fs-md);line-height:1.55;color:var(--muted);padding:6px 0}
@media (max-width:600px){.pr-table tr{display:block;padding:6px 0}.pr-table th,.pr-table td{display:block;padding:0}}`;
  const jsonLd = [
    { "@type": "WebPage", "@id": canonical, url: canonical, name: "Agent402.Tools press kit", description, about: { "@id": `${baseUrl}/#organization` }, primaryImageOfPage: { "@type": "ImageObject", url: `${baseUrl}/logo.png` } },
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` }, { "@type": "ListItem", position: 2, name: "Press", item: canonical }] },
  ];
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/press", extraCss, jsonLd, body });
}
