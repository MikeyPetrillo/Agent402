import { esc } from "./ledger-chrome.js";

// README badges: the SVG images at /badges/<style>.svg (embedded by READMEs
// elsewhere, so the routes stay) and the Badges section of /docs (#badges;
// /badges answers a 301 to it).

/* ------------------------------------------------------------------ */
/*  Badge SVG generator                                                */
/* ------------------------------------------------------------------ */

export function badgeSvg(style) {
  if (style === "flat") return flatBadge();
  if (style === "powered-by") return poweredByBadge();
  return defaultBadge(); // "default" or fallback
}

// design-tokens: literal-start (standalone SVG badges embedded in other sites' READMEs: no stylesheet)
function defaultBadge() {
  const leftText = "Agent402";
  const rightText = "500+ tools";
  const leftWidth = 72;
  const rightWidth = 82;
  const totalWidth = leftWidth + rightWidth;
  const h = 20;
  const r = 3;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${h}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="c"><rect width="${totalWidth}" height="${h}" rx="${r}" fill="#FFFFFF"/></clipPath>
  <g clip-path="url(#c)">
    <rect width="${leftWidth}" height="${h}" fill="#3A3F45"/>
    <rect x="${leftWidth}" width="${rightWidth}" height="${h}" fill="#0F5E43"/>
    <rect width="${totalWidth}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="#FFFFFF" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11" text-rendering="geometricPrecision">
    <text x="${leftWidth / 2}" y="14" fill="#0B0C0E" fill-opacity=".3">${leftText}</text>
    <text x="${leftWidth / 2}" y="13">${leftText}</text>
    <text x="${leftWidth + rightWidth / 2}" y="14" fill="#0B0C0E" fill-opacity=".3">${rightText}</text>
    <text x="${leftWidth + rightWidth / 2}" y="13">${rightText}</text>
  </g>
</svg>`;
}

function flatBadge() {
  const leftText = "Agent402";
  const rightText = "500+ tools";
  const leftWidth = 72;
  const rightWidth = 82;
  const totalWidth = leftWidth + rightWidth;
  const h = 20;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${h}">
  <rect width="${leftWidth}" height="${h}" fill="#3A3F45"/>
  <rect x="${leftWidth}" width="${rightWidth}" height="${h}" fill="#0F5E43"/>
  <g fill="#FFFFFF" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11" text-rendering="geometricPrecision">
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
  <rect width="${w}" height="${h}" rx="${r}" fill="#0B0C0E"/>
  <rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${r}" fill="none" stroke="#34A877" stroke-opacity=".4"/>
  <text x="${w / 2}" y="18" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="12" fill="#0F5E43" text-rendering="geometricPrecision">${text}</text>
</svg>`;
}

// design-tokens: literal-end

/* ------------------------------------------------------------------ */
/*  Badges section of /docs                                            */
/* ------------------------------------------------------------------ */

export const BADGE_STYLES = [
  { style: "default", label: "Default", description: "Shields-style badge with the tool count" },
  { style: "flat",    label: "Flat",    description: "Flat version without the gradient" },
  { style: "powered-by", label: "Powered by", description: "Wider badge for project footers" },
];

/** CSS for the #badges section (appended to the docs page's extraCss). */
export const BADGES_SECTION_CSS = `
  #badges { scroll-margin-top: 110px; }
  .bdg-row { display:grid;grid-template-columns:200px minmax(0,1fr);gap:18px;align-items:start;padding:16px 20px;border-bottom:1px solid var(--hairline); }
  .bdg-row:last-child { border-bottom:none; }
  @media (max-width:740px){ .bdg-row { grid-template-columns:minmax(0,1fr);gap:10px; } }
  .ml-docs-main .bdg-row h3 { font-family:var(--font-body);font-weight:600;font-size:var(--fs-md);margin:0 0 4px;color:var(--ink); }
  .ml-docs-main .bdg-row p { font-size:var(--fs-sm);line-height:1.5;color:var(--muted);margin:0 0 10px; }
  .bdg-label { display:block;font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:0 0 4px; }
  .bdg-code-wrap { position:relative;margin:0 0 10px; }
  .bdg-code-wrap:last-child { margin-bottom:0; }
  .bdg-code-wrap pre { background:var(--panel);border:1px solid var(--panel-rule);padding:12px 70px 12px 12px;margin:0;font-family:var(--font-mono);font-size:var(--fs-xs);line-height:1.55;color:var(--on-panel);white-space:pre-wrap;word-break:break-all; }
  .bdg-code-wrap .bdg-copy { position:absolute;top:8px;right:8px;background:var(--panel);border:1px solid var(--panel-rule-2);border-radius:var(--radius);color:var(--on-panel);font-family:var(--font-mono);font-size:var(--fs-2xs);padding:4px 10px;cursor:pointer; }
  .bdg-code-wrap .bdg-copy.copied { color:var(--accent-lit);border-color:var(--accent-lit); }`;

/** The Badges section of /docs: each style's preview and its Markdown and
 * HTML embed. The copy buttons are wired by /js/copy-buttons.js. */
export function badgesSectionHtml(baseUrl) {
  const rows = BADGE_STYLES.map((b) => {
    const svgUrl = `${baseUrl}/badges/${b.style}.svg`;
    const md = `[![Agent402](${svgUrl})](${baseUrl})`;
    const html = `<a href="${baseUrl}"><img src="${svgUrl}" alt="Agent402"></a>`;
    const snippet = (label, code) => `<span class="bdg-label">${label}</span><div class="bdg-code-wrap"><pre><code>${esc(code)}</code></pre><button class="bdg-copy" type="button" aria-label="Copy the ${label} snippet">Copy</button></div>`;
    return `
        <div class="bdg-row">
          <div><h3>${esc(b.label)}</h3><p>${esc(b.description)}</p><img src="/badges/${esc(b.style)}.svg" alt="${esc(b.label)} badge" loading="lazy"></div>
          <div>${snippet("Markdown", md)}${snippet("HTML", html)}</div>
        </div>`;
  }).join("");
  return `<!-- BADGES -->
      <section>
      <h2 id="badges" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 10px;">Badges.</h2>
      <p style="font-size:var(--fs-base);line-height:1.55;color:var(--muted);max-width:640px;margin:0 0 18px;">Show that a project runs on Agent402: paste a snippet into a README, docs page or site. Each image is served from <code>${esc(baseUrl)}/badges/{style}.svg</code>, so an embed always shows the current badge.</p>
      <div style="border:1px solid var(--hairline);background:var(--card);margin-bottom:44px;">${rows}
      </div>
      </section>
`;
}
