// Served pages for the monitoring subscriptions: the /monitors
// storefront and the /monitors/thanks confirmation. Rendered through the
// shared ledger shell (2026-08-22 redesign); shares REPORTS_CSS with the
// one-shot reports pages. External JS (site CSP drops inline script).
import { MONITOR_PRODUCTS, RENEWAL_TERMS } from "./stripe-subscriptions.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { REPORTS_CSS } from "./human-reports-page.js";
import { MAX_FULL_PER_SUB_30D, MIN_FULL_GAP_MS } from "./monitor-scheduler.js";

// The per-subscription report cap, read from the scheduler that enforces it.
// The blurbs promise a fresh report on change; past this many in 30 days, or a
// second change inside the gap, the scheduler sends an alert email instead.
const CAP_NOTE = `Each monitor delivers up to ${MAX_FULL_PER_SUB_30D} full reports in any 30 days, the first one included. A change past that arrives as an alert email naming what changed, without a new report, and so does a domain or token change within ${Math.round(MIN_FULL_GAP_MS / 3_600_000)} hours of the last report. The research monitor sends no alerts: past the cap it waits until the oldest report ages out of the 30 days.`;

// The renewal line under each Subscribe button and the "Already subscribed?"
// form. Page-local rules, tokens only.
const MONITORS_CSS = `
  .pcard p.renew{font-size:var(--fs-sm);line-height:1.5;color:var(--faint);margin:10px 0 0;font-weight:400}
  .pcard p.renew a{color:var(--ink)}
  .manage{margin:56px 0 0;padding:24px;border:1px solid var(--hairline);border-radius:var(--radius);background:var(--card)}
  .manage h2{font-weight:700;font-size:var(--fs-xl);letter-spacing:-.02em;margin:0 0 8px;color:var(--ink)}
  .manage p{color:var(--muted);font-size:var(--fs-base);line-height:1.5;margin:0 0 14px;max-width:76ch}
  .manage .field{max-width:560px;margin-bottom:8px}
  .manage .field input{font-size:var(--fs-base)}
  .manage .msg{color:var(--muted);font-size:var(--fs-md);min-height:18px;margin:0}
`;

// `prefill` = {product, target} from the query string (see the /monitors route).
// It ONLY fills the form in: the deep link a delivered report or a delivery
// email carries must never be able to start a checkout on someone's behalf, so
// nothing here touches Stripe. The target is escaped into the value attribute,
// and only the matching product's field is filled.
export function monitorsPage(baseUrl = "https://agent402.tools", prefill = null) {
  // DERIVED, never typed: this is the meta + og description. It said "$3 a
  // month" for a full day after the 2026-08-23 repricing moved every monitor to
  // $5, because the prose that quotes a price is not where prices live.
  const monthly = Object.values(MONITOR_PRODUCTS).map((p) => p.price / 100).filter((n) => Number.isFinite(n));
  const monthlyLo = Math.min(...monthly), monthlyHi = Math.max(...monthly);
  const wanted = prefill && Object.hasOwn(MONITOR_PRODUCTS, String(prefill.product || "")) ? String(prefill.product) : null;
  const wantedTarget = wanted ? String(prefill.target ?? "").trim().slice(0, 200) : "";
  const cards = Object.entries(MONITOR_PRODUCTS).map(([key, p]) => `
    <div class="pcard${key === wanted ? " sel" : ""}" data-product="${esc(key)}"${key === wanted ? ' id="prefilled"' : ""}>
      <div class="k">${esc(p.kind)} monitor</div>
      <h3>${esc(p.label)}</h3>
      <div style="font-family:var(--font-mono);font-size:var(--fs-xl);color:var(--ink);margin:6px 0 8px;">$${(p.price / 100).toFixed(0)}<span style="font-size:var(--fs-xs);color:var(--faint);letter-spacing:.04em;"> / month</span></div>
      <p>${esc(p.blurb)}</p>
      <div class="field"><input id="in-${esc(key)}" type="text" aria-label="${esc(p.label)}: ${esc(p.inputLabel)}" placeholder="${esc(p.inputLabel)}"${key === wanted && wantedTarget ? ` value="${esc(wantedTarget)}" autofocus` : ""}></div>
      <div class="err" id="err-${esc(key)}"></div>
      <button class="btn btn-primary" style="width:100%;justify-content:center" data-sub="${esc(key)}">Subscribe →</button>
      <p class="renew">${esc(RENEWAL_TERMS)} <a href="/terms">Terms</a></p>
    </div>`).join("");
  const body = `
<div class="wrap">
  <section class="hero">
    <div class="eyebrow eyebrow-tags"><span>Recurring monitoring</span><span>cancel anytime</span></div>
    <h1>Set it once. <em>We watch it for you.</em></h1>
    <p class="lede">Standing reports that re-run on their own and email you when something changes. <b>No account</b> beyond your card, self-serve cancel any time.</p>
  </section>
  <section>
    <h2 class="sr-section">Every monitor you can subscribe to</h2>
    <div class="products">${cards}</div>
    <p class="note">${esc(CAP_NOTE)}</p>
    <p class="note">Monthly subscription · card via Stripe · cancel anytime from the link in your email · one-off reports at <a href="/reports" style="color:var(--ink);">/reports</a></p>
  </section>
  <section class="manage" id="manage">
    <h2>Already subscribed? Manage or cancel</h2>
    <p>Enter the email you used at checkout. If it has an active card subscription, we email you a new link to change your card or cancel.</p>
    <form class="manage-form" method="post" action="/monitors/manage-link">
      <div class="field"><input type="email" name="email" required autocomplete="email" maxlength="254" placeholder="you@example.com" aria-label="Email you used at checkout"><button class="btn btn-secondary" type="submit">Email me a link</button></div>
      <p class="msg" role="status"></p>
    </form>
    <p>Subscribed with a wallet over MPP? Use the manage link in your monitor emails, or the manage token returned when the subscription started.</p>
  </section>
</div>
${ledgerFooterCompact()}
<script src="/js/monitors.js"></script>`;
  return ledgerShell({
    title: "Agent402 Monitors: domain, 13F, recall, insider, IPO watch",
    description: `$${monthlyLo}${monthlyLo === monthlyHi ? "" : ` to $${monthlyHi}`} a month monitors: ${Object.values(MONITOR_PRODUCTS).map((p) => p.label.replace(/ (watch|monitor)$/i, "")).join(", ")}. Re-run on their own, emailed on change, card via Stripe, cancel anytime.`,
    canonical: `${baseUrl}/monitors`, baseUrl, activePath: "/monitors", extraCss: REPORTS_CSS + MONITORS_CSS, body,
    // A prefilled variant is the same page with a form filled in: keep one
    // canonical URL and keep the variants out of the index.
    ...(wanted ? { robots: "noindex, follow" } : {}),
    jsonLd: { "@context": "https://schema.org", "@type": "ItemList", "@id": `${baseUrl}/monitors#products`, name: "Agent402 monitors", itemListElement: Object.entries(MONITOR_PRODUCTS).map(([key, p], i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "Product", name: p.label, description: p.blurb, image: `${baseUrl}/tools/${p.slug}/card.png`, url: `${baseUrl}/monitors`, brand: { "@type": "Brand", name: "Agent402" }, offers: { "@type": "Offer", url: `${baseUrl}/monitors`, priceCurrency: "USD", price: (p.price / 100).toFixed(2), priceSpecification: { "@type": "UnitPriceSpecification", price: (p.price / 100).toFixed(2), priceCurrency: "USD", billingDuration: "P1M" }, availability: "https://schema.org/InStock", seller: { "@type": "Organization", name: "Havok Holdings LLC" } } } })) },
  });
}

export function monitorThanksPage(sessionId, baseUrl = "https://agent402.tools") {
  const body = `
<div class="wrap" style="padding-top:28px;">
  <div id="app" data-session="${esc(sessionId)}"><div class="status"><h2><span class="spin"></span>Confirming your subscription…</h2><p>One moment.</p></div></div>
</div>
${ledgerFooterCompact()}
<script src="/js/monitor-thanks.js"></script>`;
  return ledgerShell({
    title: "Subscription active - Agent402",
    description: "Your Agent402 monitor is being confirmed.",
    canonical: `${baseUrl}/monitors`, baseUrl, activePath: "/monitors", extraCss: REPORTS_CSS, body, robots: "noindex, nofollow",
  });
}
