// /security - the page a security reviewer or an investor reads first.
//
// Every sentence here names a control that exists in this repository or a
// surface that can be checked; nothing aspirational. Keep it in step with
// SECURITY.md and the Security-Model wiki page (test-static-pages renders it,
// test-surface-copy keeps the house style).
import { creditsPrepaymentPhrase } from "./credits-sales.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

import { REPO_URL, repoUrl } from "./repo-link.js";
import { backupKeepDays } from "./backup.js";
const SECTIONS = [
  {
    h: "Report a vulnerability",
    p: [
      `Open a private advisory on GitHub or email <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>. We acknowledge within two business days, fix through the same CI pipeline every change goes through, and note the fix in the changelog once it has shipped.`,
      `Good-faith research inside the scope below will not be met with legal action. Scope: agent402.tools, the /mcp connector, the /v1 gateway, the x402 and MPP paywall on every paid route, the prepaid credits gate (for keys already issued), the card front door (/reports, /monitors, the Stripe webhook) and the published packages. Out of scope: the payment protocols themselves, third-party facilitators and chains, and volumetric denial of service.`,
    ],
    links: [[repoUrl("security/advisories/new"), "Private advisory"], ["/.well-known/security.txt", "security.txt"], [repoUrl("blob/main/SECURITY.md"), "SECURITY.md"]],
  },
  {
    h: "What we hold",
    p: [
      `No accounts and no passwords. Agents pay per call from their own wallets; what we keep is the wallet address and transaction id, both already public on-chain. A card purchase leaves the email Stripe collected, the session id, the input and the finished report, held while the report link or subscription is live. Wallet-keyed memory belongs to its owner and lives until they delete it. Free email alerts send a signed confirmation link to the address given, delete an unconfirmed signup after three days, and drop an address the moment it unsubscribes.`,
      `Operational logs carry request paths and status codes and are kept for our hosting platform's log retention period. The full inventory, retention per class and the erasure path are in the privacy policy.`,
    ],
    links: [["/privacy", "Privacy policy"]],
  },
  {
    h: "Key handling",
    p: [
      `Payments on the crypto rails are non-custodial: buyers sign with their own keys, settlement goes to public addresses we publish (the treasury, and for the router tiers our spending wallets), and no customer key ever reaches the server. One card path is not, and we say so rather than let the word cover it: ${creditsPrepaymentPhrase()}. A card report is an ordinary card charge: taken at checkout, and refunded to the card automatically if the report fails to generate. The wallets the service spends from are dedicated, low-balance and alarmed; the treasury never signs a request. Production secrets live only in the hosting platform's variable store, are never committed, and CI signing and publishing keys are scoped Actions secrets with npm publishing on OIDC provenance. Links we email (confirmations, unsubscribes, monitor management) are HMAC-signed with dedicated secrets and verified in constant time.`,
    ],
    links: [["/transparency", "Disclosures"]],
  },
  {
    h: "Controls in the serving path",
    p: [
      `Every tool that fetches a caller-supplied URL goes through a DNS-pinned SSRF guard that refuses private, link-local and metadata addresses and re-validates on redirects; on agent402.tools the headless browser and media parsers run in a separate worker that holds no secrets, behind the same egress guard, and the server refuses to start without it (a self-hosted instance runs them in-process unless it configures the worker). The free tier is a signed, single-use, slug-scoped proof-of-work token. Settlement runs after the handler, so on x402 an error is not charged, and a settled receipt that arrives on a failed response is ledgered as a debt with an on-chain proof step before any refund leaves. Per-IP and shared rate limits fail closed; a wallet blocklist is enforced before settlement; every page carries a content security policy that allows no inline scripts (the one exception is the sandboxed, network-less frame of the SDK playground), and every response carries HSTS.`,
    ],
    links: [["/#why", "Why pay here"], ["/proof", "Receipts"]],
  },
  {
    h: "Controls on the code",
    p: [
      `The server is open source under AGPL-3.0, so every control on this page can be read. Every pull request runs CodeQL, gitleaks secret scanning with a planted-canary self-check and the full test lanes, and every one is a required check before merge; Socket dependency review runs on every push to our own branches; outside contributions also need DCO sign-off and the maintainer's code-owner review on the payment, gating and CI paths; every GitHub Action is pinned to a full commit SHA; the container image is pinned by digest and runs as a non-root user.`,
    ],
    links: [[REPO_URL, "Source"], [repoUrl("wiki/Security-Model"), "Security model"]],
  },
  {
    h: "Redact before you send",
    p: [
      "Agents often hold text you would rather not share. The Redact PII tool masks email addresses, phone numbers, card-like numbers, IP addresses and US social security numbers before the text goes anywhere else, and returns the masked text with a count of each type it masked.",
      "It is a priced tool like the rest of the catalog, with the price shown on its page. Run it on your side before a prompt, a log line or a support ticket leaves your system.",
    ],
    links: [["/tools/redact", "Redact tool"]],
  },
  {
    h: "Availability",
    p: [
      `Uptime is measured from outside production by two independent observers on separate infrastructure, and the status page renders only what they observed: a day with no observation is shown as no data, never as uptime. A real-money canary buys through every on-chain payment rail daily. Nightly backups of the state database and the data volume go to separate object storage and are deleted after ${backupKeepDays()} days.`,
    ],
    links: [["/status", "Status"]],
  },
];

export function securityPage(baseUrl) {
  const canonical = `${baseUrl}/security`;
  const title = "Security at Agent402";
  const description = "How the hosted service is built and secured: vulnerability disclosure with safe harbor, what data is held and for how long, non-custodial key handling, the controls in the serving path and on the code, and how availability is measured.";
  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">security</span></nav>
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:.98;margin:0 0 18px;color:var(--ink);max-width:900px;">Security at Agent402.</h1>
    <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:820px;margin:0;">Agent402.Tools is operated by <a href="https://havok.holdings" rel="noopener" style="color:var(--ink);">Havok Holdings LLC</a>. This page states how the hosted service is built, what it holds, and how to report a problem. Every control named here is in the open-source server and can be read.</p>
  </div>
</header>
${SECTIONS.map((s) => `
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div style="display:grid;grid-template-columns:260px 1fr;gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);" class="sec-2col">
    <h2 style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);font-weight:700;margin:4px 0 0;">${esc(s.h)}</h2>
    <div>
      ${s.p.map((p) => `<p style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">${p}</p>`).join("")}
      <div style="display:flex;gap:18px;flex-wrap:wrap;">${s.links.map(([href, label]) => `<a href="${esc(href)}" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">${esc(label)} →</a>`).join("")}</div>
    </div>
  </div>
</section>`).join("")}
${ledgerFooterCompact()}`;
  const extraCss = `@media (max-width:900px){.sec-2col{grid-template-columns:minmax(0,1fr)!important}}`;
  const jsonLd = [
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` }, { "@type": "ListItem", position: 2, name: "Security", item: canonical }] },
    { "@type": "WebPage", "@id": canonical, name: title, description, publisher: { "@type": "Organization", name: "Havok Holdings LLC", url: "https://havok.holdings" } },
  ];
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/security", extraCss, jsonLd, body });
}
