// Terms of Service — a stable, public ToS URL is a submission requirement for
// the Anthropic connector directory. Kept short and honest: a no-account,
// open-source, pay-per-call tool service.
export function termsPage(baseUrl) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terms of Service — Agent402</title>
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; }
  body { background:var(--bg); color:var(--fg); font:16px/1.65 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 20px 64px; }
  h1 { font-size:1.6rem; } h2 { font-size:1.1rem; margin-top:30px; color:var(--accent); }
  a { color:var(--accent); } .muted { color:var(--muted); } code { font-family:ui-monospace,Menlo,monospace; font-size:.9em; }
</style>
</head>
<body><div class="wrap">
<h1>Terms of Service</h1>
<p class="muted">Agent402 (agent402.tools) — last updated 2026-06-13.</p>

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
<p>Mikey Petrillo — <a href="https://github.com/MikeyPetrillo" rel="noopener">github.com/MikeyPetrillo</a>,
or <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">GitHub issues</a>.</p>

<p class="muted"><a href="/">← agent402.tools</a> · <a href="/privacy">Privacy</a></p>
</div></body>
</html>`;
}
