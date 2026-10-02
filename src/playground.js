// Playground — interactive tool-tester page.  Lets visitors pick any Agent402
// tool, fill in its inputs, solve a proof-of-work challenge in the browser, and
// see the live JSON response.  Entirely server-rendered HTML + inline vanilla JS
// (no frameworks, no external scripts).
//
// NOTE: The inline highlightJson() function uses .innerHTML to render
// syntax-highlighted JSON output. The input is pre-serialised JSON passed
// through the inline escH() HTML-escaper before highlight regex runs, so
// user-controlled values never reach the DOM un-escaped. This pattern is
// carried over from the original pre-migration code.

import { ledgerShell, ledgerFooterCompact, esc, jsonScriptTag } from "./ledger-chrome.js";
import { toolList } from "./pages.js";
import { isComputePayable } from "./pow.js";

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");

export function playgroundPage(baseUrl, catalog) {
  const freeCount = fmtNum(toolList(catalog).filter(isComputePayable).length);
  const title = "Playground - try Agent402 tools for free";
  const description = `Try any of Agent402's ${freeCount} free-tier tools directly in your browser. No signup, no wallet - proof-of-work pays automatically.`;
  const canonical = `${baseUrl}/playground`;

  // Embed the catalog the page already has. /api/pricing is the public scrapable
  // dump and deliberately omits discovery.inputSchema (size); the playground
  // needs schemas + names to build forms, so ship a slim per-page payload
  // instead of a second network round-trip that used to leave blank labels
  // whenever pricing dropped `name`.
  const toolsPayload = Object.entries(catalog).map(([routeKey, def]) => {
    const route = def.route || routeKey;
    const [method, path] = route.split(" ");
    return {
      method,
      path,
      name: def.name || def.slug,
      slug: def.slug,
      category: def.category || "other",
      description: def.description || "",
      price: def.price,
      computePayable: isComputePayable(def),
      discovery: def.discovery
        ? { input: def.discovery.input, inputSchema: def.discovery.inputSchema }
        : undefined,
    };
  });
  const extraCss = `
  .crumb{max-width:1180px;margin:0 auto;padding:18px 30px 0;font-family:var(--font-mono);font-size:.85rem;color:var(--faint)}
  .crumb a{color:var(--faint);text-decoration:none}
  .crumb a:hover{color:var(--accent)}
  .pg-title{max-width:1180px;margin:0 auto;padding:10px 30px 0}
  .pg-title h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 8px}
  .pg-title p{color:var(--muted);font-size:.95rem;margin-top:4px}
  .pg-wrap{max-width:1180px;margin:24px auto 0;padding:0 30px;display:flex;gap:20px}
  .pg-left{flex:0 0 60%;min-width:0}
  .pg-right{flex:1;min-width:0}
  @media(max-width:760px){.pg-wrap{flex-direction:column}.pg-left,.pg-right{flex:none;width:100%}}
  .pg-search{width:100%;padding:10px 14px;border:1px solid var(--hairline);background:var(--card);color:var(--ink);font-size:.95rem;outline:none;font-family:var(--font-body)}
  .pg-search:focus{border-color:var(--accent)}
  .pg-search::placeholder{color:var(--faint)}
  .pg-select{width:100%;margin-top:10px;padding:10px 14px;border:1px solid var(--hairline);background:var(--card);color:var(--ink);font-size:.95rem;outline:none;font-family:var(--font-body);cursor:pointer}
  .pg-select:focus{border-color:var(--accent)}
  .pg-select optgroup{color:var(--faint);font-style:normal}
  .pg-select option{color:var(--ink);background:var(--card)}
  .pg-info{margin-top:16px;padding:14px 16px;border:1px solid var(--hairline);background:var(--card)}
  .pg-info .tool-name{font-size:1.1rem;font-weight:700}
  .pg-info .tool-desc{color:var(--muted);font-size:.9rem;margin-top:4px}
  .pg-info .tool-meta{margin-top:8px;font-size:.82rem;color:var(--faint);font-family:var(--font-mono)}
  .pg-info .tool-meta span{margin-right:14px}
  .pg-fields{margin-top:14px}
  .pg-field{margin-bottom:10px}
  .pg-field label{display:block;font-size:.85rem;color:var(--faint);margin-bottom:3px;font-family:var(--font-mono)}
  .pg-field input[type="text"],.pg-field input[type="number"]{width:100%;padding:8px 12px;border:1px solid var(--hairline);background:var(--paper);color:var(--ink);font-size:.9rem;font-family:var(--font-mono);outline:none}
  .pg-field input:focus{border-color:var(--accent)}
  .pg-field .chk-wrap{display:flex;align-items:center;gap:8px}
  .pg-field input[type="checkbox"]{accent-color:var(--accent);width:16px;height:16px}
  .pg-btn{margin-top:14px;padding:10px 22px;border:none;font-size:.95rem;font-family:var(--font-mono);font-weight:700;cursor:pointer;transition:opacity .15s}
  .pg-btn.run{background:var(--surface);color:var(--on-dark)}
  .pg-btn.run:hover{opacity:.85}
  .pg-btn.run:disabled{opacity:.5;cursor:not-allowed}
  .pg-btn.disabled-info{background:var(--card);border:1px solid var(--hairline);color:var(--faint);cursor:default}
  .pg-btn.disabled-info a{color:var(--accent);margin-left:6px}
  .pg-status{margin-top:10px;font-size:.85rem;color:var(--faint);font-family:var(--font-mono)}
  .pg-status .spin{display:inline-block;width:14px;height:14px;border:2px solid var(--faint);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .pg-result{padding:16px;border:1px solid var(--hairline);background:var(--card);min-height:300px;position:sticky;top:80px}
  .pg-result .placeholder{color:var(--faint);font-size:.9rem;text-align:center;padding-top:100px}
  .pg-result pre{white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:.82rem;line-height:1.55;max-height:70vh;overflow:auto}
  .pg-result .timing{font-size:.8rem;color:var(--faint);margin-bottom:10px;font-family:var(--font-mono)}
  .pg-result .err{color:#c0392b}
  .json-str{color:var(--accent)}
  .json-num{color:#2980b9}
  .json-key{color:var(--ink)}
  .json-bool{color:#8e44ad}
  .json-null{color:var(--faint)}
  `;

  const pageBody = `
<section>
<div class="crumb"><a href="/">Agent402</a> / playground</div>
<div class="pg-title">
  <h1>Playground</h1>
  <p>Try any of Agent402's ${freeCount} free-tier tools directly in your browser. No signup, no wallet - proof-of-work pays automatically.</p>
</div>
</section>
<section>
<div class="pg-wrap" data-base="${esc(baseUrl)}">
  <div class="pg-left">
    <input class="pg-search" id="pgSearch" type="text" placeholder="Search tools..." autocomplete="off">
    <select class="pg-select" id="pgSelect"><option value="">Loading tools...</option></select>
    <div id="pgForm"></div>
  </div>
  <div class="pg-right">
    <div class="pg-result" id="pgResult">
      <div class="placeholder">Pick a tool and hit Run</div>
    </div>
  </div>
</div>
</section>
${ledgerFooterCompact()}
${jsonScriptTag("pg-tools-data", toolsPayload)}
<script src="/js/playground.js"></script>`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body: pageBody,
  });
}
