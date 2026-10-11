// Tollbooth Cloud waitlist + partner intake form. A single page that collects
// structured intent (name, email, role, number of sites, plan, message) and
// submits it as a GitHub issue against the public repo. The form runs on
// agent402.tools so the experience feels like a real product funnel rather than
// a "click and you land in GitHub's issue editor" handoff. The destination is
// still a labeled GitHub issue, but the body is well-formed and the visitor
// never sees raw markdown.
//
// Query params:
//   ?plan=solo|team|agency|enterprise|partner   pre-selects the plan radio
//   ?kind=enterprise|partner                    swaps copy/CTA wording
//
// Submission POSTs to /api/tollbooth/waitlist and is stored privately in
// Postgres. On any failure the form fails CLOSED with a retry message (audit
// F10): the lead's PII is NEVER placed in a URL or an external fallback, so it
// cannot leak into browser history, referrers, or a public issue.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const PLAN_COPY = {
  solo: { label: "Cloud Solo · $19/mo", h: "Join the Cloud Solo waitlist", lead: "One domain, hosted dashboard, weekly digest, spike alerts." },
  team: { label: "Cloud Team · $99/mo", h: "Join the Cloud Team waitlist", lead: "Up to 25 sites, multi-instance dashboard, per-site tagging, 90-day retention." },
  agency: { label: "Cloud Agency · $299/mo", h: "Join the Cloud Agency waitlist", lead: "Up to 250 sites, white-label sub-domain, per-client alert thresholds, monthly exports." },
  enterprise: { label: "Enterprise", h: "Talk to us about Enterprise", lead: "SSO, custom retention, SLA, signed audit log. Your wallet still settles USDC directly." },
  partner: { label: "Partner program", h: "Apply as a partner agency", lead: "20% lifetime recurring on every Team or Agency plan you refer. Stripe rev-share, settled monthly." },
};

// Plan / kind come from query string. Clamp to allow-lists at the function
// boundary so no attacker-controlled value ever reaches the HTML output —
// every interpolation of `plan` and `kind` below depends on that guarantee
// (see the canonical link, form `selected` matchers, and the inline script).
const ALLOWED_PLANS = new Set(["solo", "team", "agency", "enterprise", "partner"]);
const ALLOWED_KINDS = new Set(["waitlist", "enterprise", "partner"]);
export function tollboothWaitlistPage(baseUrl, { plan = "team", kind = "waitlist" } = {}) {
  plan = ALLOWED_PLANS.has(plan) ? plan : "team";
  kind = ALLOWED_KINDS.has(kind) ? kind : "waitlist";
  const p = PLAN_COPY[plan];
  const isPartner = plan === "partner" || kind === "partner";
  const isEnterprise = plan === "enterprise" || kind === "enterprise";

  const title = `${p.h} - Agent402 Tollbooth Cloud`;
  const description = `${p.lead} Hosted on top of open-source agent402-tollbooth. Non-custodial - your wallet collects USDC directly.`;
  const canonical = `${baseUrl}/tollbooth/waitlist?plan=${plan}`;

  const extraCss = `
  .tw-wrap { max-width:680px; margin:0 auto; padding:56px 30px 60px; }
  .crumbs { color:var(--faint); font-family:var(--font-mono); font-size:var(--fs-md); margin-bottom:14px; }
  .crumbs a { color:var(--faint); text-decoration:none; }
  .crumbs a:hover { color:var(--accent); }
  h1 { font-family:var(--font-body);font-weight:800;font-size:var(--fs-3xl);line-height:1;letter-spacing:-.02em;margin:0 0 8px; }
  .lede { color:var(--muted); margin:0 0 24px; line-height:1.55; }
  form { background:var(--card); border:1px solid var(--hairline); padding:22px; display:grid; gap:16px; }
  label { display:grid; gap:6px; font-size:var(--fs-base); }
  label .k { color:var(--faint); font-family:var(--font-mono); font-size:var(--fs-sm); letter-spacing:.02em; text-transform:uppercase; }
  input, select, textarea {
    background:var(--paper); border:1px solid var(--hairline);
    color:var(--ink); padding:10px 12px; font:inherit; font-family:var(--font-body); outline:none;
  }
  input:focus, select:focus, textarea:focus { border-color:var(--accent); }
  textarea { min-height:88px; resize:vertical; }
  .grid2 { display:grid; gap:12px; grid-template-columns:1fr 1fr; }
  @media (max-width:560px){ .grid2 { grid-template-columns:1fr; } }
  .cta:hover { opacity:.9; }
  .alt { color:var(--faint); font-size:var(--fs-md); text-align:center; margin-top:6px; }
  .alt a { color:var(--accent); }
  .note { color:var(--faint); font-size:var(--fs-sm); margin-top:14px; }
  .badge { display:inline-block; background:var(--card); border:1px solid var(--hairline); padding:2px 10px; color:var(--accent); font-family:var(--font-mono); font-size:var(--fs-xs); letter-spacing:.04em; text-transform:uppercase; margin-bottom:10px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  code { font-family:var(--font-mono); font-size:var(--fs-md); }
  `;

  const body = `<div class="tw-wrap">
<div class="crumbs"><a href="/tollbooth">Tollbooth</a> · <a href="/tollbooth/cloud">Cloud</a> · <span style="color:var(--ink);">${isPartner ? "Partner" : isEnterprise ? "Enterprise" : "Waitlist"}</span></div>
<span class="badge">${isPartner ? "Partner program" : isEnterprise ? "Enterprise" : "Cloud · early access"}</span>
<h1>${esc(p.h)}</h1>
<p class="lede">${esc(p.lead)}</p>

<form id="wl" autocomplete="on" data-kind="${esc(isPartner ? "partner" : isEnterprise ? "enterprise" : "waitlist")}">
  <div class="grid2">
    <label><span class="k">Your name</span><input id="f_name" name="name" type="text" required placeholder="Jane Smith"></label>
    <label><span class="k">Work email</span><input id="f_email" name="email" type="email" required placeholder="jane@agency.com"></label>
  </div>
  <label><span class="k">${isPartner ? "Agency name" : "Company / publisher"}</span><input id="f_org" name="org" type="text" placeholder="${isPartner ? "Acme SEO" : "Your publisher or agency"}"></label>
  <div class="grid2">
    <label><span class="k">${isPartner ? "Rough # of client sites" : "Sites you'd gate"}</span><input id="f_sites" name="sites" type="text" placeholder="${isPartner ? "30-50" : "blog.example.com, docs.example.com"}"></label>
    <label><span class="k">Plan</span>
      <select id="f_plan" name="plan">
        <option value="solo"${plan==="solo"?" selected":""}>Cloud Solo · $19/mo</option>
        <option value="team"${plan==="team"?" selected":""}>Cloud Team · $99/mo</option>
        <option value="agency"${plan==="agency"?" selected":""}>Cloud Agency · $299/mo</option>
        <option value="enterprise"${plan==="enterprise"?" selected":""}>Enterprise</option>
        <option value="partner"${plan==="partner"?" selected":""}>Partner program</option>
      </select>
    </label>
  </div>
  <label><span class="k">Anything else? (optional)</span><textarea id="f_msg" name="message" placeholder="What problem are you trying to solve? Which AI crawlers are hitting you hardest? What stack do these sites run on?"></textarea></label>
  <!-- honeypot: real visitors leave this empty -->
  <label style="position:absolute; left:-10000px; top:auto; width:1px; height:1px; overflow:hidden;" aria-hidden="true"><input id="f_hp" name="website" type="text" tabindex="-1" autocomplete="off"></label>
  <button id="wl_submit" class="btn btn-secondary cta" type="submit">${isPartner ? "Apply as partner →" : isEnterprise ? "Request a call →" : "Join waitlist →"}</button>
  <div id="wl_err" style="display:none; color:var(--bad); font-size:var(--fs-md);"></div>
</form>

<div id="wl_done" style="display:none; background:var(--card); border:1px solid var(--hairline); padding:22px;">
  <h2 style="margin:0 0 6px; color:var(--accent); font-size:var(--fs-lg);">Got it - you're on the list.</h2>
  <p style="margin:0; color:var(--muted);">We'll be in touch within 1 business day. In the meantime, <a href="/tollbooth">install the OSS gate</a> in observe mode and you'll have a week of bot-traffic data ready when we onboard you.</p>
</div>

<p class="note">Submissions are stored privately on our server (Postgres on Railway) and never appear in any public repo. We use them to email you about your plan and nothing else.</p>

<script src="/js/tollbooth-waitlist.js"></script>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body,
  });
}
