// Site chrome shared by every server-rendered HTML page: favicon links, a
// sticky top nav (brand + Tools/Guides/FAQ/GitHub), and a footer with the
// standard utility + policy links. Each page imports these so navigation,
// branding, and "back to home" behavior are identical site-wide.
//
// Classes are prefixed `site-` so they don't collide with page-specific CSS
// that lives in landing.js, pages.js, guides.js, etc.

export const CHROME_HEAD_LINKS = `<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="512x512" href="/logo.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/logo.png">`;

export const CHROME_CSS = `
.site-nav { position:sticky; top:0; z-index:50; backdrop-filter:blur(12px); background:rgba(10,13,19,.82); border-bottom:1px solid #1e2638; }
.site-nav-in { max-width:1080px; margin:0 auto; display:flex; align-items:center; gap:20px; padding:12px 20px; font:14px/1.4 system-ui,-apple-system,sans-serif; }
.site-brand { display:flex; align-items:center; gap:9px; font-weight:700; text-decoration:none; color:#e6e9f0; letter-spacing:-.01em; }
.site-brand .glyph { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:700; color:#4ade80; border:1px solid #1f4a1d; background:#000; border-radius:7px; padding:2px 7px; font-size:.82rem; }
.site-nav .spacer { flex:1; }
.site-nav a.link { color:#8b93a7; text-decoration:none; font-size:.9rem; }
.site-nav a.link:hover { color:#e6e9f0; }
.site-nav a.link.active { color:#4ade80; }
.site-nav a.gh { border:1px solid #2a3550; border-radius:8px; padding:6px 13px; color:#e6e9f0; font-size:.85rem; text-decoration:none; }
.site-nav a.gh:hover { border-color:#4ade80; }
@media (max-width:720px){ .site-nav a.hide-sm{ display:none; } }
.site-footer { max-width:1080px; margin:48px auto 0; padding:24px 20px 56px; border-top:1px solid #1e2638; color:#8b93a7; font:14px/1.7 system-ui,-apple-system,sans-serif; }
.site-footer a { color:#8b93a7; text-decoration:none; }
.site-footer a:hover { color:#4ade80; }
.site-footer .row { margin:6px 0; }
.site-footer .sep { color:#2a3550; margin:0 6px; }
.site-footer .row.tag { color:#8b93a7; font-size:.8rem; margin-top:14px; }
`;

const NAV_LINKS = [
  { href: "/tools", label: "Tools" },
  { href: "/index", label: "Index" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/tollbooth", label: "Tollbooth" },
  { href: "/guides", label: "Guides" },
  { href: "/faq", label: "FAQ" },
];

const isActive = (linkHref, currentPath) =>
  linkHref === currentPath || (linkHref !== "/" && currentPath.startsWith(linkHref + "/"));

/**
 * Sticky top nav. Pass the current path so the matching link gets highlighted
 * (omit for non-page surfaces like the dashboard). `extraLinks` lets a page add
 * a one-off link (e.g. a "Connect" anchor on the landing page) without forking.
 */
export function renderHeader(currentPath = "", extraLinks = []) {
  const links = [...NAV_LINKS, ...extraLinks]
    .map((l) => `<a class="link hide-sm${isActive(l.href, currentPath) ? " active" : ""}" href="${l.href}">${l.label}</a>`)
    .join("\n  ");
  return `<nav class="site-nav"><div class="site-nav-in">
  <a class="site-brand" href="/"><span class="glyph">402</span> Agent402</a>
  <span class="spacer"></span>
  ${links}
  <a class="gh" href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">GitHub ★</a>
</div></nav>`;
}

/**
 * Standard footer. Two link rows (utility + policy) + a tagline. Stable across
 * every page so visitors always have a way to /privacy, /terms, and the repo.
 */
export function renderFooter() {
  return `<footer class="site-footer">
  <div class="row">
    <a href="/">Home</a><span class="sep">·</span>
    <a href="/tools">Tools</a><span class="sep">·</span>
    <a href="/index">x402 Index</a><span class="sep">·</span>
    <a href="/leaderboard">x402 Leaderboard</a><span class="sep">·</span>
    <a href="/tollbooth">Tollbooth</a><span class="sep">·</span>
    <a href="/tollbooth/cloud">Tollbooth Cloud</a><span class="sep">·</span>
    <a href="/guides">Guides</a><span class="sep">·</span>
    <a href="/faq">FAQ</a><span class="sep">·</span>
    <a href="/api/pricing">Pricing</a><span class="sep">·</span>
    <a href="/openapi.json">OpenAPI</a><span class="sep">·</span>
    <a href="/llms.txt">llms.txt</a><span class="sep">·</span>
    <a href="/api/stats">Stats</a>
  </div>
  <div class="row">
    <a href="/privacy">Privacy</a><span class="sep">·</span>
    <a href="/terms">Terms</a><span class="sep">·</span>
    <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">GitHub</a>
  </div>
  <div class="row tag">Agent402 — open-source, self-hostable x402 + MCP server. Built by <a href="https://github.com/MikeyPetrillo" rel="noopener">Mikey Petrillo</a> on the <a href="https://x402.org" rel="noopener">x402 protocol</a>.</div>
</footer>`;
}
