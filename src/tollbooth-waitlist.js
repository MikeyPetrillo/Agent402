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
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const REPO = "https://github.com/MikeyPetrillo/Agent402";

const PLAN_COPY = {
  solo: { label: "Cloud Solo · $19/mo", h: "Join the Cloud Solo waitlist", lead: "One domain, hosted dashboard, weekly digest, spike alerts." },
  team: { label: "Cloud Team · $99/mo", h: "Join the Cloud Team waitlist", lead: "Up to 25 sites, multi-instance dashboard, per-site tagging, 90-day retention." },
  agency: { label: "Cloud Agency · $299/mo", h: "Join the Cloud Agency waitlist", lead: "Up to 250 sites, white-label sub-domain, per-client alert thresholds, monthly exports." },
  enterprise: { label: "Enterprise", h: "Talk to us about Enterprise", lead: "SSO, custom retention, SLA, signed audit log. Your wallet still settles USDC directly." },
  partner: { label: "Partner program", h: "Apply as a partner agency", lead: "20% lifetime recurring on every Team or Agency plan you refer. Stripe rev-share, settled monthly." },
};

export function tollboothWaitlistPage(baseUrl, { plan = "team", kind = "waitlist" } = {}) {
  const p = PLAN_COPY[plan] || PLAN_COPY.team;
  const isPartner = plan === "partner" || kind === "partner";
  const isEnterprise = plan === "enterprise" || kind === "enterprise";
  const ghLabel = isPartner ? "tollbooth-partner" : "tollbooth-cloud";
  const ghTitle = isPartner
    ? "Tollbooth Cloud partner application"
    : isEnterprise
      ? "Tollbooth Cloud enterprise inquiry"
      : `Tollbooth Cloud waitlist — ${p.label}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.h} — Agent402 Tollbooth Cloud</title>
<meta name="description" content="${p.lead} Hosted on top of open-source agent402-tollbooth. Non-custodial — your wallet collects USDC directly.">
<link rel="canonical" href="${baseUrl}/tollbooth/waitlist?plan=${plan}">
<meta name="robots" content="noindex">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0a0d13; --fg:#e6e9f0; --muted:#8b93a7; --line:#1e2638; --card:#0e1320; --accent:#4ade80; --pop:#a78bfa; --warn:#fbbf24; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui,-apple-system,sans-serif; }
  .wrap { max-width:680px; margin:0 auto; padding:36px 22px 60px; }
  .crumbs { color:var(--muted); font-size:.85rem; margin-bottom:14px; }
  .crumbs a { color:var(--muted); text-decoration:none; }
  .crumbs a:hover { color:var(--accent); }
  h1 { font-size:1.7rem; line-height:1.2; margin:0 0 8px; letter-spacing:-.01em; }
  .lede { color:var(--muted); margin:0 0 24px; }
  form { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px; display:grid; gap:16px; }
  label { display:grid; gap:6px; font-size:.92rem; }
  label .k { color:var(--muted); font-size:.82rem; letter-spacing:.02em; text-transform:uppercase; }
  input, select, textarea {
    background:#0a0d15; border:1px solid var(--line); border-radius:8px;
    color:var(--fg); padding:10px 12px; font:inherit; outline:none;
  }
  input:focus, select:focus, textarea:focus { border-color:var(--accent); }
  textarea { min-height:88px; resize:vertical; }
  .grid2 { display:grid; gap:12px; grid-template-columns:1fr 1fr; }
  @media (max-width:560px){ .grid2 { grid-template-columns:1fr; } }
  .cta { background:var(--accent); color:#06120a; border:none; border-radius:8px; padding:12px 18px; font:inherit; font-weight:700; cursor:pointer; }
  .cta:hover { filter:brightness(1.05); }
  .alt { color:var(--muted); font-size:.85rem; text-align:center; margin-top:6px; }
  .alt a { color:var(--accent); }
  .note { color:var(--muted); font-size:.82rem; margin-top:14px; }
  .badge { display:inline-block; background:#0f1320; border:1px solid var(--line); border-radius:999px; padding:2px 10px; color:var(--pop); font-size:.78rem; letter-spacing:.04em; text-transform:uppercase; margin-bottom:10px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  ${CHROME_CSS}
</style>
</head>
<body>${renderHeader("/tollbooth")}<div class="wrap">
<div class="crumbs"><a href="/tollbooth">Tollbooth</a> · <a href="/tollbooth/cloud">Cloud</a> · <span style="color:var(--fg);">${isPartner ? "Partner" : isEnterprise ? "Enterprise" : "Waitlist"}</span></div>
<span class="badge">${isPartner ? "Partner program" : isEnterprise ? "Enterprise" : "Cloud · early access"}</span>
<h1>${p.h}</h1>
<p class="lede">${p.lead}</p>

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
  <button class="cta" type="submit">${isPartner ? "Apply as partner →" : isEnterprise ? "Request a call →" : "Join waitlist →"}</button>
  <div class="alt">Prefer email? <a id="mail" href="#" rel="noopener">Open your mail client</a> · We'll reply within 1 business day.</div>
</form>

<p class="note">Submitting opens a pre-filled GitHub issue in <a href="${REPO}" rel="noopener">MikeyPetrillo/Agent402</a> with the <code>${ghLabel}</code> label. The repo is public, so don't paste anything you wouldn't want indexed — for sensitive details, use the email fallback above.</p>

<script>
(function(){
  var form = document.getElementById('wl');
  var mail = document.getElementById('mail');
  function fields(){
    return {
      name: (document.getElementById('f_name').value||'').trim(),
      email: (document.getElementById('f_email').value||'').trim(),
      org: (document.getElementById('f_org').value||'').trim(),
      sites: (document.getElementById('f_sites').value||'').trim(),
      plan: document.getElementById('f_plan').value,
      msg: (document.getElementById('f_msg').value||'').trim()
    };
  }
  function body(f){
    return [
      'Name: ' + (f.name||'-'),
      'Email: ' + (f.email||'-'),
      (f.org ? 'Org: ' + f.org : ''),
      'Plan: ' + f.plan,
      (f.sites ? 'Sites: ' + f.sites : ''),
      '',
      (f.msg || '-')
    ].filter(Boolean).join('\\n');
  }
  function ghUrl(f){
    var title = ${JSON.stringify(ghTitle)};
    var label = ${JSON.stringify(ghLabel)};
    var q = new URLSearchParams({ title: title, labels: label, body: body(f) });
    return ${JSON.stringify(REPO)} + '/issues/new?' + q.toString();
  }
  function mailUrl(f){
    var subject = ${JSON.stringify(ghTitle)};
    return 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body(f));
  }
  function syncMail(){ mail.href = mailUrl(fields()); }
  form.addEventListener('input', syncMail);
  syncMail();
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var f = fields();
    if (!f.name || !f.email) return;
    window.open(ghUrl(f), '_blank', 'noopener');
  });
})();
</script>
</div>${renderFooter()}</body>
</html>`;
}
