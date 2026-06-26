// Machine Ledger design system — shared chrome for the Agent402 marketing site.
// Exports the status line, nav, footers (full + compact), settlement tape,
// design-token CSS, and a ledgerShell() wrapper that composes a full HTML page.
//
// Pages import ledgerShell() and one of the footer functions, then pass their
// body HTML to get a complete document with SEO metadata and shared chrome.

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// Head links: Google Fonts + favicons
// ---------------------------------------------------------------------------

export const LEDGER_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="512x512" href="/logo.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/logo.png">`;

// ---------------------------------------------------------------------------
// Design-token CSS + base reset + keyframes + shared chrome styles
// ---------------------------------------------------------------------------

export const LEDGER_CSS = `
:root {
  --accent: #D63C1A;
  --paper: #ECE4D2;
  --card: #F4EEDE;
  --card-zebra: #efe7d4;
  --footer-bg: #E5DCC8;
  --ink: #16150F;
  --ink-panel: #1d1c15;
  --ink-tape: #11100b;
  --muted: #4f4b3f;
  --faint: #8A8475;
  --hairline: #d8cfb6;
  --dark-border: #2a2920;
  --dark-border2: #34322a;
  --cream: #ECE4D2;
  --cream2: #F4EEDE;
  --dk-muted: #9a9382;
  --dk-muted2: #b9b1a0;
  --dk-muted3: #7c7768;
  --green: #6fae8d;
  --font-body: 'Archivo', system-ui, sans-serif;
  --font-mono: 'Space Mono', monospace;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--paper); font-family: var(--font-body); color: var(--ink); -webkit-font-smoothing: antialiased; }
::selection { background: #d63c1a33; }
a { color: inherit; }

/* --- keyframes --- */
@keyframes ml-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
@keyframes ml-tape  { from { transform: translateX(0); } to { transform: translateX(-50%); } }

/* --- responsive --- */
@media (max-width: 900px) {
  .ml-ft-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .ml-hero-grid { grid-template-columns: 1fr !important; }
  .ml-2col { grid-template-columns: 1fr !important; }
}
@media (max-width: 600px) {
  .ml-nav-in  { padding: 12px 16px !important; gap: 14px !important; }
  .ml-nav-links { gap: 12px !important; }
  .ml-nav-gh  { display: none !important; }
  .ml-h1      { font-size: 40px !important; }
  .ml-hero-h1 { font-size: 42px !important; }
}
`;

// ---------------------------------------------------------------------------
// Status line (top of every page)
// ---------------------------------------------------------------------------

function statusLine() {
  return `<div style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-size:12px;letter-spacing:.02em;">
  <div style="max-width:1180px;margin:0 auto;padding:8px 30px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">HTTP/1.1 <span style="color:var(--accent);font-weight:700;">402</span> PAYMENT REQUIRED</span>
    <span style="color:var(--dk-muted);white-space:nowrap;">agent402.base.eth · BASE · USDC</span>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Nav (sticky, every page)
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { href: "/tools", label: "catalog" },
  { href: "/pricing", label: "pricing" },
  { href: "/leaderboard", label: "leaderboard" },
  { href: "/docs", label: "docs" },
];

function nav(activePath) {
  const links = NAV_ITEMS.map((l) => {
    const active = l.href === activePath;
    const style = active
      ? "color:var(--ink);font-weight:700;text-decoration:none;border-bottom:2px solid var(--accent);padding-bottom:2px;"
      : "color:var(--muted);text-decoration:none;";
    return `<a href="${l.href}" style="${style}">${l.label}</a>`;
  }).join("\n      ");
  return `<nav style="border-bottom:1.5px solid var(--ink);background:var(--paper);position:sticky;top:0;z-index:50;">
  <div class="ml-nav-in" style="max-width:1180px;margin:0 auto;padding:14px 30px;display:flex;align-items:center;gap:26px;">
    <a href="/" style="display:flex;align-items:center;gap:11px;text-decoration:none;color:var(--ink);">
      <span style="width:32px;height:32px;border:2px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;">402</span>
      <span style="font-weight:800;font-size:18px;letter-spacing:-.02em;text-transform:uppercase;">Agent402<span style="color:var(--accent);">.</span>Tools</span>
    </a>
    <div class="ml-nav-links" style="display:flex;align-items:center;gap:20px;margin-left:6px;font-family:var(--font-mono);font-size:13px;">
      ${links}
    </div>
    <div style="margin-left:auto;display:flex;align-items:center;gap:14px;">
      <a class="ml-nav-gh" href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="font-family:var(--font-mono);font-size:13px;color:var(--muted);text-decoration:none;">github ★1.3k</a>
      <a href="/docs" style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:9px 15px;">ADD TO CLAUDE →</a>
    </div>
  </div>
</nav>`;
}

// ---------------------------------------------------------------------------
// Footer — full 5-column (home page)
// ---------------------------------------------------------------------------

export function ledgerFooterFull() {
  return `<footer style="border-top:1.5px solid var(--ink);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:48px 30px 32px;">
    <div class="ml-ft-grid" style="display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr 1fr;gap:26px;">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <span style="width:30px;height:30px;border:2px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;">402</span>
          <span style="font-weight:800;font-size:16px;text-transform:uppercase;letter-spacing:-.02em;">Agent402<span style="color:var(--accent);">.</span>Tools</span>
        </div>
        <p style="font-family:var(--font-mono);font-size:12px;line-height:1.6;color:#6b6757;margin:0;max-width:240px;">The open x402 index — discovery, routing, and on-chain ranking for the agent payments economy.</p>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">product</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/tools" style="color:var(--muted);text-decoration:none;">Tools</a><a href="/pricing" style="color:var(--muted);text-decoration:none;">Pricing</a><a href="/integrations" style="color:var(--muted);text-decoration:none;">Integrations</a><a href="/tollbooth" style="color:var(--muted);text-decoration:none;">Tollbooth</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">learn</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/docs" style="color:var(--muted);text-decoration:none;">Docs</a><a href="/quickstart" style="color:var(--muted);text-decoration:none;">Quickstart</a><a href="/skills" style="color:var(--muted);text-decoration:none;">Skills</a><a href="/faq" style="color:var(--muted);text-decoration:none;">FAQ</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">ecosystem</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/index" style="color:var(--muted);text-decoration:none;">Index</a><a href="/leaderboard" style="color:var(--muted);text-decoration:none;">Leaderboard</a><a href="/economy" style="color:var(--muted);text-decoration:none;">Economy</a><a href="/playground" style="color:var(--muted);text-decoration:none;">Playground</a></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">developers</div>
        <div style="display:flex;flex-direction:column;gap:9px;font-size:14px;"><a href="/openapi.json" style="color:var(--muted);text-decoration:none;">OpenAPI</a><a href="/llms.txt" style="color:var(--muted);text-decoration:none;">llms.txt</a><a href="/api/stats" style="color:var(--muted);text-decoration:none;">Stats</a><a href="/changelog" style="color:var(--muted);text-decoration:none;">Changelog</a></div>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:36px;padding-top:18px;border-top:1px solid #cdc3ad;font-family:var(--font-mono);font-size:12px;color:var(--faint);">
      <span>open-source x402 + MCP server · built by <a href="https://github.com/MikeyPetrillo" rel="noopener" style="color:var(--muted);text-decoration:none;">Mike Petrillo</a> · <a href="mailto:mike@agent402.tools" style="color:var(--muted);text-decoration:none;">mike@agent402.tools</a></span>
      <span style="display:flex;gap:16px;"><a href="/privacy" style="color:var(--muted);text-decoration:none;">privacy</a><a href="/terms" style="color:var(--muted);text-decoration:none;">terms</a><a href="/contact" style="color:var(--muted);text-decoration:none;">contact</a><a href="/llms.txt" style="color:var(--muted);text-decoration:none;">llms.txt</a><a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="color:var(--muted);text-decoration:none;">github</a><a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--muted);text-decoration:none;">𝕏</a></span>
    </div>
  </div>
</footer>`;
}

// ---------------------------------------------------------------------------
// Footer — compact single-row (sub-pages)
// ---------------------------------------------------------------------------

export function ledgerFooterCompact() {
  return `<footer style="border-top:1.5px solid var(--ink);background:var(--footer-bg);">
  <div style="max-width:1180px;margin:0 auto;padding:26px 30px;font-family:var(--font-mono);font-size:12px;color:var(--faint);">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
      <span style="display:flex;align-items:center;gap:10px;"><span style="width:24px;height:24px;border:2px solid var(--ink);color:var(--ink);font-weight:700;font-size:10px;display:flex;align-items:center;justify-content:center;">402</span><span style="font-weight:700;">Agent402.Tools</span></span>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/tools" style="color:var(--muted);text-decoration:none;">catalog</a><a href="/pricing" style="color:var(--muted);text-decoration:none;">pricing</a><a href="/leaderboard" style="color:var(--muted);text-decoration:none;">leaderboard</a><a href="/docs" style="color:var(--muted);text-decoration:none;">docs</a><a href="/integrations" style="color:var(--muted);text-decoration:none;">integrations</a></span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid #cdc3ad;">
      <span>built by <a href="https://github.com/MikeyPetrillo" rel="noopener" style="color:var(--muted);text-decoration:none;">Mike Petrillo</a> · <a href="mailto:mike@agent402.tools" style="color:var(--muted);text-decoration:none;">mike@agent402.tools</a></span>
      <span style="display:flex;gap:16px;flex-wrap:wrap;"><a href="/privacy" style="color:var(--muted);text-decoration:none;">privacy</a><a href="/terms" style="color:var(--muted);text-decoration:none;">terms</a><a href="/contact" style="color:var(--muted);text-decoration:none;">contact</a><a href="/llms.txt" style="color:var(--muted);text-decoration:none;">llms.txt</a><a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="color:var(--muted);text-decoration:none;">github</a><a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--muted);text-decoration:none;">𝕏</a></span>
    </div>
  </div>
</footer>`;
}

// ---------------------------------------------------------------------------
// Settlement tape — scrolling marquee of recent paid calls
// ---------------------------------------------------------------------------

function agoStr(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
}

export function ledgerTape(recentCalls) {
  if (!recentCalls || !recentCalls.length) return "";
  const items = recentCalls.slice(0, 12);
  const chip = (r) =>
    `<span>${esc(r.slug)} · <span style="color:var(--cream);">${r.paidWith === "proof-of-work" ? "PoW" : "$USDC"}</span> · ${agoStr(r.at)}</span>`;
  const track = items.map(chip).join("");
  return `<div style="background:var(--ink-tape);border-bottom:1.5px solid var(--ink);overflow:hidden;display:flex;align-items:center;">
  <div style="flex:none;padding:11px 18px;font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--accent);border-right:1px solid var(--dark-border);">●●● TAPE</div>
  <div style="overflow:hidden;flex:1;">
    <div style="display:flex;gap:30px;width:max-content;animation:ml-tape 40s linear infinite;font-family:var(--font-mono);font-size:12px;color:#8b8676;padding:11px 18px;white-space:nowrap;">${track}${track}</div>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Full HTML document shell
// ---------------------------------------------------------------------------

/**
 * Wraps page content in a complete HTML document with status line, nav,
 * SEO metadata, design-token CSS, and optional page-specific CSS.
 *
 * @param {object} opts
 * @param {string} opts.title       - <title> tag content
 * @param {string} opts.description - meta description
 * @param {string} opts.canonical   - canonical URL
 * @param {string} opts.baseUrl     - base URL for OG image default
 * @param {string} opts.activePath  - nav link to highlight ("" for home)
 * @param {string} [opts.ogImage]   - OG image URL (defaults to baseUrl/card.png)
 * @param {object|object[]} [opts.jsonLd] - JSON-LD structured data
 * @param {string} [opts.extraCss]  - page-specific CSS
 * @param {string} opts.body        - main content HTML (including footer)
 */
export function ledgerShell({ title, description, canonical, baseUrl, activePath = "", ogImage, jsonLd, extraCss = "", body }) {
  const og = ogImage || (baseUrl + "/card.png");
  const jsonLdBlock = jsonLd
    ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd])
        .map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`)
        .join("\n")
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="Agent402.Tools">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(og)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@Agent402Tools">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(og)}">
<meta name="base:app_id" content="6a3dd86ca341d86b910769fb" />
${LEDGER_HEAD}
<style>${LEDGER_CSS}${extraCss}</style>
${jsonLdBlock}
</head>
<body style="overflow-x:hidden;">
${statusLine()}
${nav(activePath)}
${body}
</body>
</html>`;
}
