// /security - the page a security reviewer or an investor reads first.
//
// Every sentence here names a control that exists in this repository or a
// surface that can be checked; nothing aspirational. Keep it in step with
// SECURITY.md and the Security-Model wiki page (test-static-pages renders it,
// test-surface-copy keeps the house style).
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const SECTIONS = [
  {
    h: "Report a vulnerability",
    p: [
      `Open a private advisory on GitHub or email <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>. We acknowledge within two business days, fix through the same CI pipeline every change goes through, and note the fix in the changelog once it has shipped.`,
      `Good-faith research inside the scope below will not be met with legal action. Scope: agent402.tools, the /mcp connector, the /v1 gateway, the x402 and MPP paywall on every paid route, the prepaid credits gate, the card front door (/reports, /monitors, /credits, the Stripe webhook) and the published packages. Out of scope: the payment protocols themselves, third-party facilitators and chains, and volumetric denial of service.`,
    ],
    links: [["https://github.com/MikeyPetrillo/Agent402/security/advisories/new", "Private advisory"], ["/.well-known/security.txt", "security.txt"], ["https://github.com/MikeyPetrillo/Agent402/blob/main/SECURITY.md", "SECURITY.md"]],
  },
  {
    h: "What we hold",
    p: [
      `No accounts and no passwords. Agents pay per call from their own wallets; what we keep is the wallet address and transaction id, both already public on-chain. A card purchase leaves the email Stripe collected, the session id, the input and the finished report, held while the report link or subscription is live. Wallet-keyed memory belongs to its owner and lives until they delete it. Free email alerts hold an address only after it is confirmed by a signed link and drop it the moment it unsubscribes.`,
      `Operational logs carry request paths and status codes for days, not months. The full inventory, retention per class and the erasure path are in the privacy policy.`,
    ],
    links: [["/privacy", "Privacy policy"]],
  },
  {
    h: "Key handling",
    p: [
      `Payments on the crypto rails are non-custodial: buyers sign with their own keys, settlement goes to a public treasury address, and no customer key ever reaches the server. Two card paths are not, and we say so rather than let the word cover them: a prepaid credits balance is money we hold until it is spent, and a card report purchase is held by the payment processor until the report is delivered or refunded. The wallets the service spends from are dedicated, low-balance and alarmed; the treasury never signs a request. Production secrets live only in the hosting platform's variable store, are never committed, and CI signing and publishing keys are scoped Actions secrets with npm publishing on OIDC provenance. Links we email (confirmations, unsubscribes, monitor management) are HMAC-signed with dedicated secrets and verified in constant time.`,
    ],
    links: [["/transparency", "Disclosures"]],
  },
  {
    h: "Controls in the serving path",
    p: [
      `Every tool that fetches a caller-supplied URL goes through a DNS-pinned SSRF guard that refuses private, link-local and metadata addresses and re-validates on redirects; the headless browser runs in a separate secretless worker behind the same egress guard. The free tier is a signed, single-use, slug-scoped proof-of-work token. Settlement runs after the handler, so an error is never charged, and a settled receipt that arrives on a failed response is ledgered as a debt with an on-chain proof step before any refund leaves. Per-IP and shared rate limits fail closed; a wallet blocklist is enforced before settlement; every response carries a strict content security policy, HSTS and no inline scripts.`,
    ],
    links: [["/why", "Why pay here"], ["/proof", "Receipts"]],
  },
  {
    h: "Controls on the code",
    p: [
      `The server is open source under AGPL-3.0, so every control on this page can be read. Every pull request runs CodeQL, gitleaks secret scanning with a planted-canary self-check, Socket dependency review, DCO sign-off and the full test lanes, and every one is a required check before merge; every GitHub Action is pinned to a full commit SHA; the payment, gating and CI paths require code-owner review; the container image is pinned by digest and runs as a non-root user.`,
    ],
    links: [["https://github.com/MikeyPetrillo/Agent402", "Source"], ["https://github.com/MikeyPetrillo/Agent402/wiki/Security-Model", "Security model"]],
  },
  {
    h: "Availability",
    p: [
      `Uptime is measured from outside production by two independent observers on separate infrastructure, and the status page renders only what they observed: a day with no observation is shown as no data, never as uptime. A real-money canary buys through every payment rail daily. Backups of the data volume go offsite nightly with bounded retention.`,
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
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">security</span></nav>
    <h1 style="font-weight:800;font-size:46px;line-height:.98;letter-spacing:-.035em;margin:0 0 18px;color:var(--ink);max-width:900px;">Security at Agent402.</h1>
    <p style="font-size:18px;line-height:1.55;color:var(--muted);max-width:820px;margin:0;">Agent402.Tools is operated by <a href="https://havok.holdings" rel="noopener" style="color:var(--ink);">Havok Holdings LLC</a>. This page states how the hosted service is built, what it holds, and how to report a problem. Every control named here is in the open-source server and can be read.</p>
  </div>
</header>
${SECTIONS.map((s) => `
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div style="display:grid;grid-template-columns:220px 1fr;gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);" class="sec-2col">
    <h2 style="font-family:var(--font-mono);font-size:13px;color:var(--accent);font-weight:600;margin:4px 0 0;">${esc(s.h)}</h2>
    <div>
      ${s.p.map((p) => `<p style="font-size:16px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">${p}</p>`).join("")}
      <div style="display:flex;gap:18px;flex-wrap:wrap;">${s.links.map(([href, label]) => `<a href="${esc(href)}" style="font-family:var(--font-mono);font-size:13px;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">${esc(label)} →</a>`).join("")}</div>
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
