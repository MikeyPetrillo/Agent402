// /trust - how the hosted service handles data and incidents, one claim per
// line, each linked to the surface or the code that shows it.
//
// Every figure on this page is read from the module that runs it (backup
// hour, retention and staleness from src/backup.js, the cache window from
// src/idempotency-store.js, the HSTS header from src/security-headers.js),
// and scripts/test-trust-page.js pins every other statement to its source:
// each provider named here is named in the privacy policy and called from
// src/, the outside probe's schedule is the Worker's cron, the restore
// suites sit in a CI lane, and the alarm words are the ones the pagers read.
import { siteOrgRef } from "./site-org.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { repoUrl } from "./repo-link.js";
import { backupKeepDays, backupUtcHour, backupStaleHours } from "./backup.js";
import { IDEM_TTL_MS } from "./idempotency-store.js";
import { ALWAYS_HEADERS } from "./security-headers.js";
import { gatewayOfferPublic } from "./gateway-nanopayments.js";
import { COMPANY_MAILBOXES } from "./company.js";

/** The processors the server sends buyer data to, as the privacy policy names
 *  them. `gets` is what each receives; the guard checks every entry of
 *  `providers` against the rendered privacy policy and a call site in src/. */
export function trustSubprocessors() {
  const rows = [
    { category: "Hosting and backup storage", name: "Railway", providers: ["Railway"], gets: "Everything the service stores, and the nightly backups (encrypted before upload)" },
    { category: "Card payments", name: "Stripe", providers: ["Stripe"], gets: "Card details on its hosted checkout, the email entered there" },
    { category: "Transactional email", name: "ZeptoMail, with Resend as a fallback", providers: ["ZeptoMail", "Resend"], gets: "The address and the message: report links, monitor reports, alerts" },
    { category: "AI models", name: "OpenAI, and model operators via OpenRouter", providers: ["OpenAI", "OpenRouter"], gets: "Prompts and inputs to the /v1 endpoints, model-backed tools and report synthesis" },
    { category: "Web search and data", name: "Brave Search API, Exa, the X API", providers: ["Brave Search API", "Exa", "X API"], gets: "The query, URL, handle or post id a search tool is given" },
    { category: "Code sandbox", name: "E2B", providers: ["E2B"], gets: "The code sent to the code-run tools" },
    { category: "Tool routing", name: "TypeSafe", providers: ["TypeSafe"], gets: "The task text given to route and decide" },
    { category: "Payment verification", name: "Coinbase CDP and per-chain facilitators, Tempo's relay", providers: ["Coinbase CDP", "Tempo's relay"], gets: "The signed payment, to verify and settle it" },
    { category: "Sanctions screening", name: "Tempo's transfer data feed", providers: ["Tempo's transfer data feed"], gets: "A paying wallet address, to read its recent inbound transfers" },
    { category: "Site analytics", name: "Google Analytics (advertising features off), PostHog", providers: ["Google Analytics", "PostHog"], gets: "Page visits and browser details; PostHog receives events relayed by our server, without your IP address" },
  ];
  if (gatewayOfferPublic()) rows.push({ category: "Batched payments", name: "Circle Gateway", providers: ["Circle Gateway"], gets: "A batched payment, verified and settled off chain" });
  return rows;
}

const HSTS = (ALWAYS_HEADERS.find(([k]) => k === "Strict-Transport-Security") || [])[1] || "";
/** The HSTS max-age in whole years, read from the header every answer carries. */
export function hstsYears() {
  const m = /max-age=(\d+)/.exec(HSTS);
  return m ? Math.floor(Number(m[1]) / (365 * 86400)) : 0;
}
const NUM = ["zero", "one", "two", "three", "four", "five"];
const words = (n) => NUM[n] || String(n);
const hh = (h) => `${String(h).padStart(2, "0")}:00 UTC`;

export function trustPage(baseUrl) {
  const canonical = `${baseUrl}/trust`;
  const title = "Trust at Agent402";
  const description = "How the hosted service handles data and incidents: the subprocessors that receive buyer data, what is stored and where, encryption, nightly backups and restore tests, status, paging, refunds and security reports.";
  const keep = backupKeepDays(), hour = backupUtcHour(), stale = backupStaleHours();
  const cacheMin = Math.round(IDEM_TTL_MS / 60000);
  const years = hstsYears();
  const link = (href, label) => `<a href="${esc(href)}" style="color:var(--ink);">${label}</a>`;
  const code = (t) => `<code style="font-family:var(--font-mono);font-size:var(--fs-code-inline);">${esc(t)}</code>`;
  const table = (heads, rows) => `<div style="overflow-x:auto;margin:0 0 14px;max-width:820px;"><table class="tr-table">
<thead><tr>${heads.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const subs = trustSubprocessors();
  const SECTIONS = [
    {
      h: "Subprocessors",
      p: [
        `These providers receive buyer data, each only for the purpose listed. The privacy policy describes each in full.`,
        table(["Category", "Provider", "What it receives"], subs.map((s) => [esc(s.category), esc(s.name), esc(s.gets)])),
        `A tool that fetches a URL or reads a public data source sends that site what the lookup needs. When route-and-execute or a decision buys from an outside seller to resell its answer, that seller receives the request it needs to answer, sent and paid for by us.`,
      ],
      links: [["/privacy", "Privacy policy"]],
    },
    {
      h: "What we store, and where",
      p: [
        table(["Store", "What it holds", "Kept"], [
          ["State database (Postgres)", "The sales and refund ledgers, card-purchase records, monitor and alert subscriptions, wallet-keyed memory, async job and task results", `Per record class, as the ${link("/privacy", "privacy policy")} lists`],
          ["Redis", "Shared rate-limit and free-trial counters, the cached answer to an identical retry, and a money record whose database write has not landed yet", `Counters for their window (one hour, or 24 hours for the free trial's daily allowance); cached answers up to ${cacheMin} minutes; a money record until its database write commits`],
          ["Offsite backups (object storage)", "A nightly copy of the state database", `${keep} days`],
          ["Operational logs", "Request paths and status codes", "The hosting platform's log retention"],
        ]),
        `No accounts and no passwords. Tool inputs are processed in memory and not stored, except where the privacy policy says otherwise.`,
      ],
      links: [["/privacy", "Retention"], [repoUrl("blob/main/src/ledger-journal-redis.js"), "Journal code"]],
    },
    {
      h: "Encryption",
      p: [
        `In transit: every answer carries ${code(`Strict-Transport-Security: ${HSTS}`)}, so a browser that has seen it reaches agent402.tools over HTTPS only, for ${words(years)} years.`,
        `At rest: each backup object is encrypted on our server with AES-256-GCM before upload, so the storage holds ciphertext. In production the ${code("backup")} word on ${link("/api/gateway-status", "/api/gateway-status")} reads ${code("unencrypted")} if the key is missing, and that pages. A prepaid credits key is stored only as a hash, and the links we email are HMAC-signed.`,
      ],
      links: [[repoUrl("blob/main/src/security-headers.js"), "Headers code"], [repoUrl("blob/main/src/backup.js"), "Backup code"]],
    },
    {
      h: "Backups and restore tests",
      p: [
        `The server copies every table of the state database to separate object storage once a night, in one consistent snapshot, starting at ${hh(hour)}, and deletes each copy after ${keep} days. The ${code("backup")} word reads ${code("stale")} when no run has succeeded in ${stale} hours, and ${code("failed")} or ${code("held")} when a run did not finish; both outside observers page on each word.`,
        `Every change runs the restore tests before it merges: one decrypts and restores every object shape the nightly run writes, another restores state tables into a fresh Postgres schema and checks they come back equal.`,
      ],
      links: [["/api/gateway-status", "Backup word"], [repoUrl("blob/main/scripts/state-restore.js"), "Restore script"]],
    },
    {
      h: "Incidents and status",
      p: [
        `${link("/status", "/status")} shows only what two observers outside production saw: a scheduled heartbeat and an outside probe that runs every five minutes. A day with no observation shows as no data. Service alarms are public words on ${link("/api/gateway-status", "/api/gateway-status")}, and the observers page the operator on the ones that need a person, one issue per alarm.`,
        `A paid call that was charged but failed is recorded as a debt in the refund ledger and repaid only after the charge is proven on chain. Once a debt has waited past a short grace period, the ${code("refundsOwed")} word reads ${code("owed")} and pages until it is repaid. A card report that fails to generate is refunded to the card.`,
      ],
      links: [["/status", "Status"], ["/api/gateway-status", "Alarm words"]],
    },
    {
      h: "Security reports",
      p: [
        `Report a vulnerability through a private advisory on GitHub or by email to ${link(`mailto:${COMPANY_MAILBOXES.operator}`, esc(COMPANY_MAILBOXES.operator))}. We acknowledge within two business days, fix through the same CI pipeline every change goes through, and note the fix in the ${link("/changelog", "changelog")} once it has shipped. Every heartbeat checks for reports waiting in triage and raises an alert past a set limit.`,
      ],
      links: [["/security", "Security"], [repoUrl("security/advisories/new"), "Private advisory"], ["/.well-known/security.txt", "security.txt"]],
    },
  ];
  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">trust</span></nav>
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:.98;margin:0 0 18px;color:var(--ink);max-width:900px;">Trust at Agent402.</h1>
    <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:820px;margin:0;">How the hosted service handles data and incidents. Each statement links to the page, the live surface or the code that shows it.</p>
  </div>
</header>
${SECTIONS.map((s) => `
<section style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div style="display:grid;grid-template-columns:260px minmax(0,1fr);gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);" class="tr-2col">
    <h2 style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);font-weight:700;margin:4px 0 0;">${esc(s.h)}</h2>
    <div>
      ${s.p.map((p) => p.startsWith("<div") ? p : `<p style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">${p}</p>`).join("")}
      <div class="tr-links" style="display:flex;gap:18px;flex-wrap:wrap;">${s.links.map(([href, label]) => `<a href="${esc(href)}" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">${esc(label)} →</a>`).join("")}</div>
    </div>
  </div>
</section>`).join("")}
${ledgerFooterCompact()}`;
  const extraCss = `@media (max-width:900px){.tr-2col{grid-template-columns:minmax(0,1fr)!important}}
.tr-table{border-collapse:collapse;width:100%;font-size:var(--fs-md);line-height:1.4}
.tr-table th{font-family:var(--font-mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.12em;color:var(--faint);font-weight:500;text-align:left;padding:8px 12px 8px 0;border-bottom:1px solid var(--hairline)}
.tr-table td{color:var(--muted);vertical-align:top;padding:10px 12px 10px 0;border-bottom:1px solid var(--hairline)}
.tr-table td:first-child{color:var(--ink)}`;
  const jsonLd = [
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` }, { "@type": "ListItem", position: 2, name: "Trust", item: canonical }] },
    { "@type": "WebPage", "@id": canonical, name: title, description, publisher: siteOrgRef(baseUrl) },
  ];
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/trust", extraCss, jsonLd, body });
}
