// Interactive API docs — Swagger-style browsable reference generated from the
// live OpenAPI spec. Lets developers browse endpoints, see schemas, and try
// tools via the playground's PoW solver.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function apiExplorerPage(baseUrl) {
  const canonical = `${baseUrl}/docs/api/explorer`;
  const title = "API Explorer - interactive Agent402 reference";
  const description = "Browse every endpoint, inspect schemas, and try tools live. Generated from the OpenAPI spec.";

  const extraCss = `
.ae-wrap{max-width:1180px;margin:0 auto;padding:56px 30px 0}
.ae-crumb{font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:14px}
.ae-crumb a{color:var(--accent);text-decoration:none}
.ae-search{width:100%;max-width:560px;padding:13px 16px;background:var(--card);border:1px solid var(--hairline);color:var(--ink);font-family:var(--font-mono);font-size:14px;outline:none;margin-bottom:14px}
.ae-search:focus{border-color:var(--accent)}
.ae-count{margin-left:12px;color:var(--faint);font-family:var(--font-mono);font-size:12px}
.ae-cats{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:22px}
.ae-cat-btn{background:transparent;border:1px solid var(--hairline);color:var(--ink);padding:5px 10px;font-family:var(--font-mono);font-size:11.5px;cursor:pointer;transition:.15s}
.ae-cat-btn:hover{border-color:var(--accent);color:var(--accent)}
.ae-cat-btn.active{background:var(--surface);color:var(--on-dark);border-color:var(--ink);font-weight:700}
.ae-endpoint{background:var(--card);border:1px solid var(--hairline);margin-bottom:8px;overflow:hidden}
.ae-ep-head{display:flex;align-items:center;gap:12px;padding:12px 18px;cursor:pointer;user-select:none}
.ae-ep-head:hover{background:var(--card-zebra)}
.ae-method{font-family:var(--font-mono);font-size:12px;font-weight:700;padding:2px 8px;min-width:48px;text-align:center}
.ae-method.GET{color:var(--green)}
.ae-method.POST{color:var(--accent)}
.ae-path{font-family:var(--font-mono);font-size:13px;color:var(--ink)}
.ae-ep-name{color:var(--faint);font-size:13px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}
.ae-ep-body{display:none;border-top:1px solid var(--hairline);padding:16px 18px}
.ae-endpoint.open .ae-ep-body{display:block}
.ae-section{margin-bottom:12px}
.ae-section-title{font-family:var(--font-mono);font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px}
.ae-schema{background:var(--surface);border:1px solid var(--hairline);padding:12px 16px;font-family:var(--font-mono);font-size:12px;line-height:1.6;overflow-x:auto;color:var(--on-dark)}
.ae-prop{margin:4px 0}
.ae-prop-name{color:var(--accent)}
.ae-prop-type{color:var(--dk-muted)}
.ae-prop-desc{color:var(--dk-muted2);font-style:italic;margin-left:8px}
.ae-try-btn{display:inline-block;padding:9px 15px;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:13px;border:none;cursor:pointer;text-decoration:none;font-family:var(--font-mono)}
.ae-try-btn:hover{opacity:.85}
@media(max-width:640px){.ae-ep-name{display:none}}
`;

  const body = `
<div class="ae-wrap" data-base="${esc(baseUrl)}">
<p class="ae-crumb"><a href="/">Home</a> &rsaquo; <a href="/docs">Docs</a> &rsaquo; API Explorer</p>
<div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:14px;">$ GET /docs/api/explorer</div>
<h1 style="font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;">API Explorer.</h1>
<p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:620px;margin:0 0 30px;">Browse every endpoint, inspect input schemas, and try tools live. Data from <a href="/openapi.json" style="color:var(--accent);text-decoration:none;">/openapi.json</a>.</p>
<input class="ae-search" id="aeSearch" type="text" placeholder="Search endpoints..." autocomplete="off" aria-label="Search endpoints..."><span class="ae-count" id="aeCount"></span>
<div class="ae-cats" id="aeCats"></div>
<div id="aeList" style="font-family:var(--font-mono);font-size:13px;color:var(--faint);">Loading...</div>
</div>

<section style="max-width:1180px;margin:0 auto;padding:56px 30px 64px;">
</section>

${ledgerFooterCompact()}
<script src="/js/api-explorer.js"></script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/docs", extraCss, body });
}
