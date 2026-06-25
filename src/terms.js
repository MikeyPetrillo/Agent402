// Terms of Service — a stable, public ToS URL is a submission requirement for
// the Anthropic connector directory. Kept short and honest: a no-account,
// open-source, pay-per-call tool service.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function termsPage(baseUrl) {
  const title = "Terms of Service — Agent402";
  const description = "Agent402 terms of service: open-source, pay-per-call web tools. As-is, no warranty, on-chain settlement.";
  const canonical = `${baseUrl}/terms`;

  const extraCss = `
.tm-wrap{max-width:760px;margin:0 auto;padding:56px 30px}
.tm-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.tm-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px}
.tm-updated{font-family:var(--font-mono);font-size:13px;color:var(--faint);margin:0 0 32px}
.tm-body p,.tm-body li{font-size:15px;line-height:1.55;color:var(--muted)}
.tm-body p{margin:0 0 14px}
.tm-body ul{margin:0 0 18px;padding:0 0 0 22px}
.tm-body li{margin-bottom:8px}
.tm-body h2{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:36px 0 14px;color:var(--ink)}
.tm-body a{color:var(--accent);text-decoration:none}
.tm-body a:hover{text-decoration:underline}
.tm-body b,.tm-body strong{color:var(--ink);font-weight:600}
.tm-body code{font-family:var(--font-mono);font-size:13px;background:var(--ink);color:var(--cream);padding:2px 7px;border:1.5px solid var(--ink)}
@media(max-width:600px){.tm-h1{font-size:36px !important}}
`;

  const body = `
<div class="tm-wrap">
<div class="tm-eyebrow">$ GET /terms</div>
<h1 class="tm-h1">Terms of Service</h1>
<p class="tm-updated">Agent402 (agent402.tools) — last updated 2026-06-13.</p>

<div class="tm-body">
<p>Agent402 provides a catalog of small, deterministic web tools that clients call over HTTP.
By using the service you agree to these terms. The service is
<a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">open source</a>; these terms cover the hosted instance at agent402.tools.</p>

<h2>The service</h2>
<ul>
  <li>Tools are deterministic code — no large language model runs in the serving path.</li>
  <li>No account or signup. Access is by paying per call (USDC via the x402 protocol) or, on the pure-CPU tools, by solving a proof-of-work challenge. The hosted MCP connector exposes the pure-CPU tools free, rate-limited.</li>
  <li>Provided <b>"as is", without warranty</b> of any kind. We do not guarantee availability, fitness for a particular purpose, or that any tool will be error-free.</li>
</ul>

<h2>Acceptable use</h2>
<ul>
  <li>Don't use the service to break the law, infringe others' rights, or attack the service or third parties (e.g. using the URL-fetching tools against targets you don't control).</li>
  <li>Don't attempt to bypass rate limits, payment, or the proof-of-work gate, or to disrupt availability for others.</li>
  <li>You are responsible for the inputs you send and how you use the outputs.</li>
</ul>

<h2>Payments</h2>
<p>Paid calls settle on the public Base blockchain in USDC via x402. Micropayments are per-call and,
once settled on-chain, are final and non-refundable except where required by law. You are responsible
for your own wallet and keys; we never receive or hold your private key.</p>

<h2>Availability & changes</h2>
<p>The service may change, be rate-limited, or be discontinued at any time. We may update these terms;
the "last updated" date reflects the current version. Continued use after a change means you accept it.</p>

<h2>Liability</h2>
<p>To the maximum extent permitted by law, Agent402 and its maintainer are not liable for any indirect,
incidental, or consequential damages, or for any losses arising from use of the service, the tools, or
on-chain payments. Total liability for any claim will not exceed the amount you paid for the call at issue.</p>

<h2>Contact</h2>
<p>Mike Petrillo — <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>,
<a href="https://github.com/MikeyPetrillo" rel="noopener">github.com/MikeyPetrillo</a>,
or <a href="https://x.com/Agent402Tools" rel="noopener">@Agent402Tools on X</a>.</p>
</div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/terms", extraCss, body });
}
