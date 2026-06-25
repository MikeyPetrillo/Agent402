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
// The form has no server endpoint — submission is client-side JS that builds a
// GitHub issues/new URL with title + labels + body params and opens it in a
// new tab. No PII ever touches our server. (If/when we run a Tally/Typeform or
// an `/api/tollbooth/waitlist` route, the form action swaps in one place.)
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const REPO = "https://github.com/MikeyPetrillo/Agent402";

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
  const ghLabel = isPartner ? "tollbooth-partner" : "tollbooth-cloud";
  const ghTitle = isPartner
    ? "Tollbooth Cloud partner application"
    : isEnterprise
      ? "Tollbooth Cloud enterprise inquiry"
      : `Tollbooth Cloud waitlist — ${p.label}`;

  const title = `${p.h} — Agent402 Tollbooth Cloud`;
  const description = `${p.lead} Hosted on top of open-source agent402-tollbooth. Non-custodial — your wallet collects USDC directly.`;
  const canonical = `${baseUrl}/tollbooth/waitlist?plan=${plan}`;

  const extraCss = `
  .tw-wrap { max-width:680px; margin:0 auto; padding:56px 30px 60px; }
  .crumbs { color:var(--faint); font-family:var(--font-mono); font-size:.85rem; margin-bottom:14px; }
  .crumbs a { color:var(--faint); text-decoration:none; }
  .crumbs a:hover { color:var(--accent); }
  h1 { font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 8px; }
  .lede { color:var(--muted); margin:0 0 24px; line-height:1.55; }
  form { background:var(--card); border:1.5px solid var(--ink); padding:22px; display:grid; gap:16px; }
  label { display:grid; gap:6px; font-size:.92rem; }
  label .k { color:var(--faint); font-family:var(--font-mono); font-size:.82rem; letter-spacing:.02em; text-transform:uppercase; }
  input, select, textarea {
    background:var(--paper); border:1.5px solid var(--ink);
    color:var(--ink); padding:10px 12px; font:inherit; font-family:var(--font-body); outline:none;
  }
  input:focus, select:focus, textarea:focus { border-color:var(--accent); }
  textarea { min-height:88px; resize:vertical; }
  .grid2 { display:grid; gap:12px; grid-template-columns:1fr 1fr; }
  @media (max-width:560px){ .grid2 { grid-template-columns:1fr; } }
  .cta { background:var(--ink); color:var(--cream); border:none; padding:12px 18px; font:inherit; font-family:var(--font-mono); font-weight:700; cursor:pointer; }
  .cta:hover { opacity:.9; }
  .alt { color:var(--faint); font-size:.85rem; text-align:center; margin-top:6px; }
  .alt a { color:var(--accent); }
  .note { color:var(--faint); font-size:.82rem; margin-top:14px; }
  .badge { display:inline-block; background:var(--card); border:1.5px solid var(--ink); padding:2px 10px; color:var(--accent); font-family:var(--font-mono); font-size:.78rem; letter-spacing:.04em; text-transform:uppercase; margin-bottom:10px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  code { font-family:var(--font-mono); font-size:.86rem; }
  `;

  const body = `<div class="tw-wrap">
<div class="crumbs"><a href="/tollbooth">Tollbooth</a> · <a href="/tollbooth/cloud">Cloud</a> · <span style="color:var(--ink);">${isPartner ? "Partner" : isEnterprise ? "Enterprise" : "Waitlist"}</span></div>
<span class="badge">${isPartner ? "Partner program" : isEnterprise ? "Enterprise" : "Cloud · early access"}</span>
<h1>${esc(p.h)}</h1>
<p class="lede">${esc(p.lead)}</p>

<form id="wl" autocomplete="on">
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
  <button id="wl_submit" class="cta" type="submit">${isPartner ? "Apply as partner →" : isEnterprise ? "Request a call →" : "Join waitlist →"}</button>
  <div id="wl_err" style="display:none; color:#c0392b; font-size:.88rem;"></div>
</form>

<div id="wl_done" style="display:none; background:var(--card); border:1.5px solid var(--ink); padding:22px;">
  <h2 style="margin:0 0 6px; color:var(--accent); font-size:1.2rem;">Got it — you're on the list.</h2>
  <p style="margin:0; color:var(--muted);">We'll be in touch within 1 business day. In the meantime, <a href="/tollbooth">install the OSS gate</a> in observe mode and you'll have a week of bot-traffic data ready when we onboard you.</p>
</div>

<p class="note">Submissions are stored privately on our server (Postgres on Railway) and never appear in any public repo. We use them to email you about your plan and nothing else.</p>

<script>
(function(){
  var form = document.getElementById('wl');
  var doneEl = document.getElementById('wl_done');
  var errEl = document.getElementById('wl_err');
  var btn = document.getElementById('wl_submit');
  function fields(){
    return {
      kind: ${JSON.stringify(isPartner ? "partner" : isEnterprise ? "enterprise" : "waitlist")},
      name: (document.getElementById('f_name').value||'').trim(),
      email: (document.getElementById('f_email').value||'').trim(),
      org: (document.getElementById('f_org').value||'').trim(),
      sites: (document.getElementById('f_sites').value||'').trim(),
      plan: document.getElementById('f_plan').value,
      message: (document.getElementById('f_msg').value||'').trim(),
      website: (document.getElementById('f_hp').value||'')
    };
  }
  function ghBody(f){
    return [
      'Name: ' + (f.name||'-'),
      'Email: ' + (f.email||'-'),
      (f.org ? 'Org: ' + f.org : ''),
      'Plan: ' + f.plan,
      (f.sites ? 'Sites: ' + f.sites : ''),
      '',
      (f.message || '-')
    ].filter(Boolean).join('\\n');
  }
  function ghUrl(f){
    var title = ${JSON.stringify(ghTitle)};
    var label = ${JSON.stringify(ghLabel)};
    var q = new URLSearchParams({ title: title, labels: label, body: ghBody(f) });
    return ${JSON.stringify(REPO)} + '/issues/new?' + q.toString();
  }
  function showError(msg){
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    errEl.style.display = 'none';
    var f = fields();
    if (!f.name || !f.email) { showError('Name and email are required.'); return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      var r = await fetch('/api/tollbooth/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(f),
      });
      if (r.ok) {
        form.style.display = 'none';
        doneEl.style.display = 'block';
        return;
      }
      if (r.status === 503) {
        // DB not configured — fall back to GitHub pre-fill so the lead is not lost.
        window.open(ghUrl(f), '_blank', 'noopener');
        form.style.display = 'none';
        doneEl.style.display = 'block';
        return;
      }
      if (r.status === 429) { showError('Too many submissions — please try again in a minute.'); }
      else if (r.status === 400) { showError('Please double-check your name and email.'); }
      else { showError('Something went wrong. Please try again.'); }
    } catch (_) {
      // Network failed — let them at least file via GitHub rather than lose the submission.
      window.open(ghUrl(f), '_blank', 'noopener');
      form.style.display = 'none';
      doneEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = ${JSON.stringify(isPartner ? "Apply as partner →" : isEnterprise ? "Request a call →" : "Join waitlist →")};
    }
  });
})();
</script>
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
