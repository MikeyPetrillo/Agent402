import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/*  Badge SVG generator                                                */
/* ------------------------------------------------------------------ */

export function badgeSvg(style) {
  if (style === "flat") return flatBadge();
  if (style === "powered-by") return poweredByBadge();
  return defaultBadge(); // "default" or fallback
}

function defaultBadge() {
  const leftText = "Agent402";
  const rightText = "1,323 tools";
  const leftWidth = 72;
  const rightWidth = 82;
  const totalWidth = leftWidth + rightWidth;
  const h = 20;
  const r = 3;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${h}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="c"><rect width="${totalWidth}" height="${h}" rx="${r}" fill="#fff"/></clipPath>
  <g clip-path="url(#c)">
    <rect width="${leftWidth}" height="${h}" fill="#555"/>
    <rect x="${leftWidth}" width="${rightWidth}" height="${h}" fill="#4ade80"/>
    <rect width="${totalWidth}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11" text-rendering="geometricPrecision">
    <text x="${leftWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${leftText}</text>
    <text x="${leftWidth / 2}" y="13">${leftText}</text>
    <text x="${leftWidth + rightWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${rightText}</text>
    <text x="${leftWidth + rightWidth / 2}" y="13">${rightText}</text>
  </g>
</svg>`;
}

function flatBadge() {
  const leftText = "Agent402";
  const rightText = "1,323 tools";
  const leftWidth = 72;
  const rightWidth = 82;
  const totalWidth = leftWidth + rightWidth;
  const h = 20;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${h}">
  <rect width="${leftWidth}" height="${h}" fill="#555"/>
  <rect x="${leftWidth}" width="${rightWidth}" height="${h}" fill="#4ade80"/>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11" text-rendering="geometricPrecision">
    <text x="${leftWidth / 2}" y="14">${leftText}</text>
    <text x="${leftWidth + rightWidth / 2}" y="14">${rightText}</text>
  </g>
</svg>`;
}

function poweredByBadge() {
  const text = "Powered by Agent402";
  const w = 160;
  const h = 28;
  const r = 4;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" rx="${r}" fill="#131826"/>
  <rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${r}" fill="none" stroke="#4ade80" stroke-opacity=".4"/>
  <text x="${w / 2}" y="18" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="12" fill="#4ade80" text-rendering="geometricPrecision">${text}</text>
</svg>`;
}

/* ------------------------------------------------------------------ */
/*  Badges page HTML                                                   */
/* ------------------------------------------------------------------ */

const BADGE_STYLES = [
  { style: "default", label: "Default", description: "Shields.io-style badge with tool count" },
  { style: "flat",    label: "Flat",    description: "Flat version without gradient" },
  { style: "powered-by", label: "Powered By", description: "Wider badge for project footers" },
];

export function badgesPage(baseUrl) {
  const canonical = `${baseUrl}/badges`;
  const title = "Badges & Embeds \u2014 Agent402";
  const description =
    "Grab embed badges for your README or website to show you're powered by Agent402. Markdown and HTML snippets with copy buttons.";

  const badgeSections = BADGE_STYLES.map((b) => {
    const svgUrl = `${baseUrl}/badges/${b.style}.svg`;
    const siteUrl = baseUrl;
    const mdSnippet = `[![Agent402](${svgUrl})](${siteUrl})`;
    const htmlSnippet = `<a href="${siteUrl}"><img src="${svgUrl}" alt="Agent402"></a>`;

    return `
<div class="bdg-section">
  <h3>${esc(b.label)}</h3>
  <p class="bdg-desc">${esc(b.description)}</p>

  <div class="bdg-preview">
    <img src="/badges/${esc(b.style)}.svg" alt="${esc(b.label)} badge">
  </div>

  <span class="bdg-label">Markdown</span>
  <div class="bdg-code-wrap">
    <pre><code>${esc(mdSnippet)}</code></pre>
    <button class="bdg-copy" aria-label="Copy">Copy</button>
  </div>

  <span class="bdg-label">HTML</span>
  <div class="bdg-code-wrap">
    <pre><code>${esc(htmlSnippet)}</code></pre>
    <button class="bdg-copy" aria-label="Copy">Copy</button>
  </div>
</div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${CHROME_HEAD_LINKS}
<style>
${CHROME_CSS}
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;line-height:1.6}
.bdg-wrap{max-width:860px;margin:0 auto;padding:2rem 1.25rem 4rem}
.bdg-breadcrumb{font-size:.85rem;color:var(--muted);margin-bottom:1.5rem}
.bdg-breadcrumb a{color:var(--accent);text-decoration:none}
.bdg-breadcrumb a:hover{text-decoration:underline}
.bdg-title{font-size:2rem;font-weight:700;margin:0 0 .5rem;line-height:1.2}
.bdg-subtitle{color:var(--muted);font-size:1.05rem;margin:0 0 2.5rem}

.bdg-section{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.5rem;margin-bottom:1.5rem}
.bdg-section h3{font-size:1.1rem;margin:0 0 .25rem;font-weight:600}
.bdg-desc{color:var(--muted);font-size:.9rem;margin:0 0 1rem}

.bdg-preview{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:6px;padding:1.25rem;text-align:center;margin-bottom:1.25rem}
.bdg-preview img{display:inline-block;vertical-align:middle}

.bdg-label{display:inline-block;font-size:.78rem;color:var(--muted);background:rgba(255,255,255,.04);padding:.2rem .6rem;border-radius:4px;margin-bottom:.5rem}

.bdg-code-wrap{position:relative;margin-bottom:1rem}
.bdg-code-wrap pre{background:var(--bg);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:1rem 1rem 1rem 1rem;overflow-x:auto;margin:0;font-family:var(--mono);font-size:.82rem;line-height:1.55;color:var(--text);white-space:pre-wrap;word-break:break-all}
.bdg-code-wrap .bdg-copy{position:absolute;top:.6rem;right:.6rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:var(--muted);font-size:.72rem;padding:.3rem .6rem;border-radius:4px;cursor:pointer;font-family:inherit;transition:all .15s}
.bdg-code-wrap .bdg-copy:hover{color:var(--text);background:rgba(255,255,255,.1)}
.bdg-code-wrap .bdg-copy.copied{color:var(--accent);border-color:var(--accent)}

.bdg-note{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.5rem;margin-top:2rem}
.bdg-note h3{font-size:1rem;margin:0 0 .4rem;font-weight:600}
.bdg-note p{color:var(--muted);font-size:.9rem;margin:0}
.bdg-note code{font-family:var(--mono);background:rgba(255,255,255,.06);padding:.15rem .4rem;border-radius:4px;font-size:.82rem}

@media(max-width:600px){
  .bdg-title{font-size:1.5rem}
}
</style>
</head>
<body>
${renderHeader("/badges")}
<div class="bdg-wrap">

<div class="bdg-breadcrumb"><a href="/">Home</a> &rsaquo; Badges</div>
<h1 class="bdg-title">Badges & Embeds</h1>
<p class="bdg-subtitle">Add an Agent402 badge to your README, docs, or website. Copy the snippet and paste.</p>

${badgeSections}

<div class="bdg-note">
  <h3>Custom badge</h3>
  <p>The tools count in each badge updates automatically to reflect the current catalog size. Point the <code>src</code> at <code>${esc(baseUrl)}/badges/{style}.svg</code> and it will always show the latest count.</p>
</div>

</div>
${renderFooter()}

<script>
(function(){
  document.querySelectorAll(".bdg-copy").forEach(function(btn){
    btn.addEventListener("click",function(){
      var code=btn.parentElement.querySelector("code");
      var text=code.textContent;
      navigator.clipboard.writeText(text).then(function(){
        btn.textContent="Copied!";
        btn.classList.add("copied");
        setTimeout(function(){btn.textContent="Copy";btn.classList.remove("copied")},1500);
      });
    });
  });
})();
</script>
</body>
</html>`;
}
