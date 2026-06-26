// Privacy policy — a stable URL is required for listing the remote MCP
// connector in Anthropic's directory, and it should be true: this service
// has no accounts, so there is genuinely little to say.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function privacyPage(baseUrl) {
  const title = "Privacy — Agent402";
  const description = "Agent402's privacy policy: no accounts, no cookies, no analytics. What we process, why, and how long we keep it.";
  const canonical = `${baseUrl}/privacy`;

  const extraCss = `
.pv-wrap{max-width:760px;margin:0 auto;padding:56px 30px}
.pv-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.pv-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px}
.pv-updated{font-family:var(--font-mono);font-size:13px;color:var(--faint);margin:0 0 32px}
.pv-body p,.pv-body li{font-size:15px;line-height:1.55;color:var(--muted)}
.pv-body p{margin:0 0 14px}
.pv-body ul{margin:0 0 18px;padding:0 0 0 22px}
.pv-body li{margin-bottom:8px}
.pv-body h2{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:36px 0 14px;color:var(--ink)}
.pv-body a{color:var(--accent);text-decoration:none}
.pv-body a:hover{text-decoration:underline}
.pv-body b,.pv-body strong{color:var(--ink);font-weight:600}
.pv-body i{font-style:italic}
.pv-body code{font-family:var(--font-mono);font-size:13px;background:var(--ink);color:var(--cream);padding:2px 7px;border:1.5px solid var(--ink)}
@media(max-width:600px){.pv-h1{font-size:36px !important}}
`;

  const body = `
<div class="pv-wrap">
<div class="pv-eyebrow">$ GET /privacy</div>
<h1 class="pv-h1">Privacy policy</h1>
<p class="pv-updated">Agent402 (agent402.tools) — last updated 2026-06-12.</p>

<div class="pv-body">
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
  the public Base blockchain (or Solana, Polygon, Arbitrum) via the x402 protocol; wallet addresses, amounts, and timestamps are public
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
<p>Mike Petrillo — <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>,
<a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">GitHub issues</a>,
or <a href="https://x.com/Agent402Tools" rel="noopener">@Agent402Tools on X</a>.</p>
</div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/privacy", extraCss, body });
}
