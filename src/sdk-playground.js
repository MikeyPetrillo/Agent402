// SDK playground — a browser-based REPL for trying agent402-client code
// snippets. Provides pre-filled examples that run against the live API
// using the playground's PoW solver.
//
// Security note: the Function constructor is intentional here. This is a user-facing code
// playground (like CodePen/JSFiddle). Code runs entirely in the user's browser
// and never reaches the server. The callTool wrapper authenticates via PoW.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const EXAMPLES = [
  {
    label: "Hash a string",
    code: `// Hash text with SHA-256
const result = await callTool("hash", {
  text: "hello world",
  algo: "sha256"
});
console.log(result);`,
  },
  {
    label: "Find tools by keyword",
    code: `// Search for tools matching a query - /api/find is free and
// unpaywalled, so this skips the proof-of-work step entirely.
const result = await callTool("find", {
  q: "geocode"
}, { path: "/api/find", method: "GET", free: true });
console.log(result);`,
  },
  {
    label: "Generate a UUID",
    code: `// Generate a v4 UUID
const result = await callTool("uuid", {}, { path: "/api/uuid", method: "GET" });
console.log(result);`,
  },
  {
    label: "Convert units",
    code: `// Convert miles to kilometers
const result = await callTool("unit-convert", {
  value: 26.2,
  from: "miles",
  to: "kilometers"
});
console.log(result);`,
  },
  {
    label: "Base64 encode",
    code: `// Encode text to base64
const result = await callTool("base64", {
  text: "Agent402 is awesome"
});
console.log(result);`,
  },
];

export function sdkPlaygroundPage(baseUrl) {
  const canonical = `${baseUrl}/sdk-playground`;
  const title = "SDK Playground - try agent402-client in your browser";
  const description = "Write and run agent402-client code snippets in the browser. Pre-filled examples, live API calls via proof-of-work.";

  const exampleButtons = EXAMPLES.map((ex, i) =>
    `<button class="sp-example${i === 0 ? " active" : ""}" data-idx="${i}">${esc(ex.label)}</button>`
  ).join("\n      ");

  const extraCss = `
  .sp-wrap{max-width:1180px;margin:0 auto;padding:56px 30px 60px}
  .sp-crumb{font-family:var(--font-mono);font-size:.85rem;color:var(--faint);margin-bottom:1rem}
  .sp-crumb a{color:var(--accent);text-decoration:none}
  .sp-title{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 .5rem}
  .sp-sub{color:var(--muted);margin:0 0 1.5rem;font-size:.95rem}
  .sp-sub a{color:var(--accent)}
  .sp-examples{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem}
  .sp-example{background:transparent;border:1px solid var(--hairline);color:var(--faint);padding:.4rem .85rem;font-family:var(--font-mono);font-size:.82rem;cursor:pointer;transition:.15s}
  .sp-example:hover{border-color:var(--accent);color:var(--ink)}
  .sp-example.active{background:var(--surface);color:var(--on-dark);border-color:var(--ink);font-weight:700}
  .sp-editor-wrap{display:flex;gap:1rem;margin-bottom:1rem}
  @media(max-width:760px){.sp-editor-wrap{flex-direction:column}}
  .sp-editor{flex:1;min-width:0}
  .sp-output{flex:1;min-width:0}
  .sp-label{font-family:var(--font-mono);font-size:.82rem;color:var(--faint);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.4rem}
  textarea.sp-code{width:100%;min-height:240px;background:var(--surface);border:1.5px solid var(--dark-border);padding:1rem;color:var(--on-dark);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;resize:vertical;outline:none}
  textarea.sp-code:focus{border-color:var(--accent)}
  .sp-result{width:100%;min-height:240px;background:var(--surface);border:1.5px solid var(--dark-border);padding:1rem;font-family:var(--font-mono);font-size:.82rem;line-height:1.55;white-space:pre-wrap;word-break:break-word;overflow:auto;color:var(--dk-muted)}
  .sp-result .log{color:var(--on-dark)}
  .sp-result .err{color:#c0392b}
  .sp-actions{display:flex;gap:.75rem;align-items:center;margin-bottom:1.5rem}
  .sp-run{padding:.5rem 1.5rem;background:var(--surface);color:var(--on-dark);font-weight:700;font-size:.9rem;border:none;font-family:var(--font-mono);cursor:pointer}
  .sp-run:hover{opacity:.85}
  .sp-run:disabled{opacity:.5;cursor:not-allowed}
  .sp-status{color:var(--faint);font-size:.85rem;font-family:var(--font-mono)}
  .sp-status .spin{display:inline-block;width:14px;height:14px;border:2px solid var(--faint);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .sp-note{background:var(--card);border:1px solid var(--hairline);padding:1rem 1.25rem;color:var(--muted);font-size:.88rem;margin-top:1.5rem}
  .sp-note a{color:var(--accent)}
  .sp-note code{font-family:var(--font-mono);background:var(--surface);color:var(--on-dark);padding:.15rem .4rem;font-size:.82rem}
  `;

  const pageBody = `
<div class="sp-wrap" data-base="${esc(baseUrl)}">
<p class="sp-crumb"><a href="/">Home</a> &rsaquo; <a href="/playground">Playground</a> &rsaquo; SDK</p>
<h1 class="sp-title">SDK Playground</h1>
<p class="sp-sub">Write code and run it against the live API. Proof-of-work handles payment automatically. Based on <a href="/docs/adapters">agent402-client</a>.</p>

<div class="sp-examples" id="spExamples">
  ${exampleButtons}
</div>

<div class="sp-editor-wrap">
  <div class="sp-editor">
    <div class="sp-label">Code</div>
    <textarea class="sp-code" id="spCode" spellcheck="false">${esc(EXAMPLES[0].code)}</textarea>
  </div>
  <div class="sp-output">
    <div class="sp-label">Output</div>
    <div class="sp-result" id="spResult">Click Run to execute</div>
  </div>
</div>

<div class="sp-actions">
  <button class="sp-run" id="spRun">Run</button>
  <span class="sp-status" id="spStatus"></span>
</div>

<div class="sp-note">
  <strong>How it works:</strong> The playground uses <code>callTool(slug, params)</code> which fetches a PoW challenge, solves it in your browser, then calls the tool. This mirrors what <code>agent402-client</code> does in Node.js. For production use, install the SDK: <code>npm install agent402-client</code>. <a href="/quickstart">Quickstart guide &rarr;</a>
</div>
</div>
${ledgerFooterCompact()}
<script src="/js/sdk-playground.js"></script>`;

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
