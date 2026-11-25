// /accessibility - the accessibility statement: the standard the site aims
// at, what is checked and how, the known limits, and where to report a
// barrier. Every check named here is a suite in scripts/ that runs in CI
// (test-text-contrast, test-a11y-controls, test-focus-visible,
// test-heading-order, test-single-main-landmark); keep this page in step with
// them, and name a limit here as soon as one is known.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { COMPANY_MAILBOXES } from "./company.js";

export const ACCESSIBILITY_STATEMENT_DATE = "2026-11-25";

export function accessibilityPage(baseUrl) {
  const canonical = `${baseUrl}/accessibility`;
  const title = "Accessibility statement - Agent402";
  const description = "Agent402 accessibility statement: WCAG 2.2 AA is the standard we aim at, how pages are checked, known limits, and how to report a barrier.";
  const help = COMPANY_MAILBOXES.operator;
  const extraCss = `
.ac-wrap{max-width:760px;margin:0 auto;padding:56px 30px}
.ac-eyebrow{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:18px}
.ac-h1{font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px}
.ac-updated{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--faint);margin:0 0 32px}
.ac-body p,.ac-body li{font-size:var(--fs-prose);line-height:1.6;color:var(--muted)}
.ac-body p{margin:0 0 14px}
.ac-body ul{margin:0 0 18px;padding:0 0 0 22px}
.ac-body li{margin-bottom:8px}
.ac-body h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-3xl);line-height:1;letter-spacing:-.02em;margin:36px 0 14px;color:var(--ink)}
.ac-body a{color:var(--accent);text-decoration:none}
.ac-body a:hover{text-decoration:underline}
.ac-body b{color:var(--ink);font-weight:600}
@media(max-width:600px){.ac-h1{font-size:var(--fs-3xl) !important}}
`;
  const body = `
<div class="ac-wrap">
<section>
<div class="ac-eyebrow">$ GET /accessibility</div>
<h1 class="ac-h1">Accessibility statement</h1>
<p class="ac-updated">Agent402 - updated ${ACCESSIBILITY_STATEMENT_DATE}.</p>
</section>
<section>
<div class="ac-body">
<p>We want every page on agent402.tools to work for everyone, including people who use a screen reader, a keyboard
alone, magnification or high contrast. The standard we aim at is the
<a href="https://www.w3.org/TR/WCAG22/" rel="noopener">Web Content Accessibility Guidelines (WCAG) 2.2</a>, level AA.</p>

<h2>How the pages are checked</h2>
<ul>
  <li><b>Text contrast:</b> the visible text on the served pages is measured in a real browser against the background it sits on, in the light and dark themes, at phone and desktop widths.</li>
  <li><b>Keyboard and focus:</b> a skip link is the first focusable element and lands on the main content, and every focusable control shows a visible focus ring with enough contrast against its background.</li>
  <li><b>Structure:</b> each page has one main landmark, and its headings run in order without skipped levels.</li>
  <li><b>Themes and motion:</b> pages follow the system light or dark setting, and animation is reduced when the system asks for reduced motion.</li>
</ul>
<p>These checks run on every change before it ships. Automated checks cannot find every barrier, so we also read
reports from the people who use the site.</p>

<h2>Known limits</h2>
<ul>
  <li><b>Charts and the live payments view</b> are visual. The figures behind them are also published as text and as JSON from the public API (for example <a href="/api/stats">/api/stats</a>).</li>
  <li><b>Card checkout</b> runs on Stripe's hosted page, which we do not control.</li>
  <li><b>Reports</b> are written in whole or in part by AI models and are delivered without a person reviewing their structure or reading level.</li>
</ul>

<h2>Report a barrier</h2>
<p>If something on the site does not work for you, email <a href="mailto:${help}">${help}</a> with the page address
and what happened. We read every report, and where we cannot fix a page quickly we will try to get you the same
information or help you complete the same task another way.</p>
</div>
</section>
</div>
${ledgerFooterCompact()}`;
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/accessibility", extraCss, body });
}
