// Privacy policy — a stable URL is required for listing the remote MCP
// connector in Anthropic's directory, and it should be true: this service
// has no accounts, so there is genuinely little to say.
export function privacyPage(baseUrl) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy — Agent402</title>
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; }
  body { background:var(--bg); color:var(--fg); font:16px/1.65 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 20px 64px; }
  h1 { font-size:1.6rem; } h2 { font-size:1.1rem; margin-top:32px; color:var(--accent); }
  a { color:var(--accent); } p, li { color:var(--fg); } .muted { color:var(--muted); }
  code { font-family:ui-monospace,Menlo,monospace; font-size:.9em; }
</style>
</head>
<body><div class="wrap">
<h1>Privacy policy</h1>
<p class="muted">Agent402 (agent402.tools) — last updated 2026-06-12.</p>

<p>Agent402 has no accounts, no signups, no cookies, and no analytics or ad trackers.
The entire server is <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">open source</a>,
so every claim below is verifiable in code.</p>

<h2>What we process, and why</h2>
<ul>
  <li><b>Tool inputs.</b> The data you send to a tool (text to hash, a URL to render, …) is processed
  in memory to compute the response and is not stored — with one deliberate exception: the
  <code>/api/memory</code> tools, whose purpose <i>is</i> storage (see below).</li>
  <li><b>IP addresses.</b> Used for free-tier rate limiting (kept in process memory for up to one hour)
  and in standard, short-lived operational logs (request path, status code) for abuse prevention and debugging.</li>
  <li><b>Payments.</b> We never see card numbers, names, or emails — there are none. Payments settle in USDC on
  the public Base blockchain via the x402 protocol; wallet addresses, amounts, and timestamps are public
  on-chain by the protocol's design, not collected by us. Payment verification is performed by the
  payment facilitator (Coinbase CDP).</li>
  <li><b>Memory tools.</b> Data written via <code>/api/memory</code> is stored on our server keyed to the
  paying wallet, readable only by that wallet (or wallets it explicitly grants), until the owner deletes
  it or its TTL expires. A tamper-evident audit log of accesses is kept for the namespace owner.</li>
</ul>

<h2>Third parties</h2>
<ul>
  <li>Tools that fetch external URLs (<code>extract</code>, <code>render</code>, <code>screenshot</code>, …)
  contact those sites from our server with the URL you provided.</li>
  <li><code>/api/search</code> forwards the query to the Brave Search API to produce results.</li>
  <li>Hosting is on Railway. On-chain settlement is on Base (Coinbase CDP facilitator).</li>
  <li>We do not sell or share data with anyone for advertising or any other purpose.</li>
</ul>

<h2>The MCP connector (${baseUrl}/mcp)</h2>
<p>The hosted connector is anonymous: requests carry no identity beyond the connecting IP, which is used
only for rate limiting as described above. Tool calls made through it are processed exactly like the
HTTP API.</p>

<h2>Retention</h2>
<p>Operational logs are short-lived (platform default, days not months). Rate-limit counters live in
process memory only. Memory-tool data persists until deleted by its owner or TTL expiry. Aggregate,
non-personal counters (total calls served per tool) are kept for the public <a href="/api/stats">/api/stats</a> page.</p>

<h2>Contact</h2>
<p>Mikey Petrillo — <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">GitHub issues</a>
or <a href="https://github.com/MikeyPetrillo" rel="noopener">github.com/MikeyPetrillo</a>.</p>

<p class="muted"><a href="/">← agent402.tools</a></p>
</div></body>
</html>`;
}
