import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

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
  const rightText = "1,338 tools";
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
  const rightText = "1,338 tools";
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

  const extraCss = `
.bdg-wrap{max-width:860px;margin:0 auto;padding:56px 30px}
.bdg-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.bdg-title{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 10px}
.bdg-subtitle{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 40px}

.bdg-section{background:var(--card);border:1.5px solid var(--ink);padding:24px;margin-bottom:20px}
.bdg-section h3{font-family:var(--font-body);font-weight:800;font-size:20px;margin:0 0 4px;color:var(--ink)}
.bdg-desc{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 16px}

.bdg-preview{background:var(--paper);border:1.5px solid var(--ink);padding:20px;text-align:center;margin-bottom:20px}
.bdg-preview img{display:inline-block;vertical-align:middle}

.bdg-label{display:inline-block;font-family:var(--font-mono);font-size:13px;color:var(--faint);margin-bottom:8px}

.bdg-code-wrap{position:relative;margin-bottom:16px}
.bdg-code-wrap pre{background:var(--ink);border:1.5px solid var(--ink);padding:16px;overflow-x:auto;margin:0;font-family:var(--font-mono);font-size:13px;line-height:1.55;color:var(--cream);white-space:pre-wrap;word-break:break-all}
.bdg-code-wrap .bdg-copy{position:absolute;top:8px;right:8px;background:var(--ink);border:1.5px solid var(--cream);color:var(--cream);font-family:var(--font-mono);font-size:11px;padding:4px 10px;cursor:pointer;transition:all .15s}
.bdg-code-wrap .bdg-copy:hover{background:var(--cream);color:var(--ink)}
.bdg-code-wrap .bdg-copy.copied{color:var(--accent);border-color:var(--accent)}

.bdg-note{background:var(--card);border:1.5px solid var(--ink);padding:24px;margin-top:32px}
.bdg-note h3{font-family:var(--font-body);font-weight:800;font-size:18px;margin:0 0 6px;color:var(--ink)}
.bdg-note p{color:var(--muted);font-size:14px;line-height:1.55;margin:0}
.bdg-note code{font-family:var(--font-mono);background:var(--ink);color:var(--cream);padding:2px 7px;font-size:13px;border:1.5px solid var(--ink)}

@media(max-width:600px){
  .bdg-title{font-size:36px !important}
}
`;

  const body = `
<div class="bdg-wrap">

<div class="bdg-eyebrow">$ GET /badges</div>
<h1 class="bdg-title">Badges & Embeds</h1>
<p class="bdg-subtitle">Add an Agent402 badge to your README, docs, or website. Copy the snippet and paste.</p>

${badgeSections}

<div class="bdg-note">
  <h3>Custom badge</h3>
  <p>The tools count in each badge updates automatically to reflect the current catalog size. Point the <code>src</code> at <code>${esc(baseUrl)}/badges/{style}.svg</code> and it will always show the latest count.</p>
</div>

</div>
${ledgerFooterCompact()}

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
</script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/badges", extraCss, body });
}
