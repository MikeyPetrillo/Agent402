import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function contactPage(baseUrl) {
  const canonical = `${baseUrl}/contact`;
  const title = "Contact — Agent402.Tools";
  const description = "Get in touch with the Agent402 team. Email mike@agent402.tools or reach out on GitHub and X.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ContactPage",
    name: "Contact Agent402.Tools",
    url: canonical,
    description,
    mainEntity: {
      "@type": "Organization",
      name: "Agent402.Tools",
      url: baseUrl,
      email: "mike@agent402.tools",
      sameAs: [
        "https://github.com/MikeyPetrillo/Agent402",
        "https://x.com/Agent402Tools",
      ],
      founder: {
        "@type": "Person",
        name: "Mike Petrillo",
        url: "https://github.com/MikeyPetrillo",
      },
    },
  };

  const extraCss = `
.ct-wrap{max-width:760px;margin:0 auto;padding:56px 30px}
.ct-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.ct-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px}
.ct-intro{font-size:15.5px;line-height:1.55;color:var(--muted);max-width:620px;margin:0 0 36px}
.ct-channels{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:40px}
@media(max-width:640px){.ct-channels{grid-template-columns:1fr}}
.ct-card{background:var(--card);border:1.5px solid var(--ink);padding:22px 24px}
.ct-card-label{font-family:var(--font-mono);font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}
.ct-card a{color:var(--accent);text-decoration:none;font-size:16px;font-weight:700}
.ct-card a:hover{text-decoration:underline}
.ct-card p{color:var(--muted);font-size:13.5px;margin:6px 0 0;line-height:1.5}
.ct-form{background:var(--card);border:1.5px solid var(--ink);padding:28px 28px 24px;margin-bottom:44px}
.ct-form h2{font-family:var(--font-body);font-weight:800;font-size:24px;margin:0 0 6px}
.ct-form p{color:var(--muted);font-size:14px;margin:0 0 20px}
.ct-field{display:block;margin-bottom:16px}
.ct-field label{display:block;font-family:var(--font-mono);font-size:12px;color:var(--ink);margin-bottom:6px;font-weight:700}
.ct-field input,.ct-field textarea{width:100%;padding:11px 14px;background:var(--paper);border:1.5px solid var(--ink);color:var(--ink);font-family:var(--font-body);font-size:14px;outline:none}
.ct-field input:focus,.ct-field textarea:focus{border-color:var(--accent)}
.ct-field textarea{min-height:120px;resize:vertical}
.ct-submit{background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-weight:700;font-size:14px;border:none;padding:12px 24px;cursor:pointer}
.ct-submit:hover{opacity:.85}
.ct-sent{display:none;background:var(--card);border:1.5px solid var(--green);padding:18px 22px;margin-bottom:44px;color:var(--ink);font-size:15px}
`;

  const body = `
<div class="ct-wrap">
  <div class="ct-eyebrow">$ GET /contact</div>
  <h1 class="ct-h1">Get in touch.</h1>
  <p class="ct-intro">Have a question, want to integrate, or just want to say hi? Reach out through any of the channels below.</p>

  <div class="ct-channels">
    <div class="ct-card">
      <div class="ct-card-label">email</div>
      <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>
      <p>Best for partnerships, support questions, and general inquiries.</p>
    </div>
    <div class="ct-card">
      <div class="ct-card-label">x / twitter</div>
      <a href="https://x.com/Agent402Tools" rel="noopener">@Agent402Tools</a>
      <p>Updates, announcements, and quick questions.</p>
    </div>
    <div class="ct-card">
      <div class="ct-card-label">github</div>
      <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">MikeyPetrillo/Agent402</a>
      <p>Bug reports, feature requests, and contributions.</p>
    </div>
    <div class="ct-card">
      <div class="ct-card-label">built by</div>
      <a href="https://github.com/MikeyPetrillo" rel="noopener">Mike Petrillo</a>
      <p>Independent developer. Open source, open book.</p>
    </div>
  </div>

  <div class="ct-sent" id="ctSent">Thanks for reaching out! I'll get back to you soon.</div>

  <div class="ct-form" id="ctForm">
    <h2>Send a message.</h2>
    <p>I'll get back to you as soon as I can.</p>
    <form id="contactForm" action="mailto:mike@agent402.tools" method="POST" enctype="text/plain">
      <div class="ct-field">
        <label for="ct-name">Name</label>
        <input type="text" id="ct-name" name="name" required placeholder="Your name">
      </div>
      <div class="ct-field">
        <label for="ct-email">Email</label>
        <input type="email" id="ct-email" name="email" required placeholder="you@example.com">
      </div>
      <div class="ct-field">
        <label for="ct-msg">Message</label>
        <textarea id="ct-msg" name="message" required placeholder="What's on your mind?"></textarea>
      </div>
      <button type="submit" class="ct-submit">Send message &rarr;</button>
    </form>
  </div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/contact",
    jsonLd,
    extraCss,
    body,
  });
}
