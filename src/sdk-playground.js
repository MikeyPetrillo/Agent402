// SDK playground — a browser-based REPL for trying agent402-client code
// snippets. Provides pre-filled examples that run against the live API
// using the playground's PoW solver.
//
// Security note: new Function() is intentional — this is a user-facing code
// playground (like CodePen/JSFiddle). Code runs entirely in the user's browser
// and never reaches the server. The callTool wrapper authenticates via PoW.

import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
    code: `// Search for tools matching a query
const result = await callTool("find", {
  q: "geocode"
}, { path: "/api/find", method: "GET" });
console.log(result);`,
  },
  {
    label: "Generate a UUID",
    code: `// Generate a v4 UUID
const result = await callTool("uuid", {});
console.log(result);`,
  },
  {
    label: "Convert units",
    code: `// Convert miles to kilometers
const result = await callTool("convert/miles-to-kilometers", {
  value: 26.2
}, { method: "GET" });
console.log(result);`,
  },
  {
    label: "Base64 encode",
    code: `// Encode text to base64
const result = await callTool("base64-encode", {
  text: "Agent402 is awesome"
});
console.log(result);`,
  },
];

export function sdkPlaygroundPage(baseUrl) {
  const canonical = `${baseUrl}/sdk-playground`;
  const title = "SDK Playground — try agent402-client in your browser";
  const description = "Write and run agent402-client code snippets in the browser. Pre-filled examples, live API calls via proof-of-work.";

  const exampleButtons = EXAMPLES.map((ex, i) =>
    `<button class="sp-example${i === 0 ? " active" : ""}" data-idx="${i}">${esc(ex.label)}</button>`
  ).join("\n      ");

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
${CHROME_HEAD_LINKS}
<style>
${CHROME_CSS}
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,sans-serif}
.sp-wrap{max-width:1080px;margin:0 auto;padding:1.5rem 1.25rem 4rem}
.sp-crumb{font-size:.85rem;color:var(--muted);margin-bottom:1rem}
.sp-crumb a{color:var(--accent);text-decoration:none}
.sp-title{font-size:1.6rem;font-weight:700;margin:0 0 .5rem}
.sp-sub{color:var(--muted);margin:0 0 1.5rem;font-size:.95rem}
.sp-sub a{color:var(--accent)}
.sp-examples{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem}
.sp-example{background:transparent;border:1px solid #1e2638;color:var(--muted);padding:.4rem .85rem;border-radius:999px;font-size:.82rem;cursor:pointer;font-family:inherit;transition:.15s}
.sp-example:hover{border-color:var(--accent);color:var(--text)}
.sp-example.active{background:var(--accent);color:#0b0e14;border-color:var(--accent);font-weight:600}
.sp-editor-wrap{display:flex;gap:1rem;margin-bottom:1rem}
@media(max-width:760px){.sp-editor-wrap{flex-direction:column}}
.sp-editor{flex:1;min-width:0}
.sp-output{flex:1;min-width:0}
.sp-label{font-size:.82rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.4rem}
textarea.sp-code{width:100%;min-height:240px;background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:1rem;color:var(--text);font-family:var(--mono);font-size:.82rem;line-height:1.55;resize:vertical;outline:none}
textarea.sp-code:focus{border-color:var(--accent)}
.sp-result{width:100%;min-height:240px;background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:1rem;font-family:var(--mono);font-size:.82rem;line-height:1.55;white-space:pre-wrap;word-break:break-word;overflow:auto;color:var(--muted)}
.sp-result .log{color:var(--text)}
.sp-result .err{color:#f87171}
.sp-actions{display:flex;gap:.75rem;align-items:center;margin-bottom:1.5rem}
.sp-run{padding:.5rem 1.5rem;background:var(--accent);color:#000;font-weight:600;font-size:.9rem;border:none;border-radius:8px;cursor:pointer;font-family:inherit}
.sp-run:hover{opacity:.85}
.sp-run:disabled{opacity:.5;cursor:not-allowed}
.sp-status{color:var(--muted);font-size:.85rem;font-family:var(--mono)}
.sp-status .spin{display:inline-block;width:14px;height:14px;border:2px solid var(--muted);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.sp-note{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:1rem 1.25rem;color:var(--muted);font-size:.88rem;margin-top:1.5rem}
.sp-note a{color:var(--accent)}
.sp-note code{font-family:var(--mono);background:rgba(255,255,255,.04);padding:.15rem .4rem;border-radius:3px;font-size:.82rem}
</style>
</head>
<body>
<script>var BASE='${baseUrl.replace(/'/g, "\\'")}';</script>
${renderHeader("/playground")}
<div class="sp-wrap">
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
${renderFooter()}
<script>
(function(){
  var EXAMPLES=${JSON.stringify(EXAMPLES.map(function(e){ return {label:e.label,code:e.code}; }))};
  var codeEl=document.getElementById('spCode');
  var resultEl=document.getElementById('spResult');
  var runBtn=document.getElementById('spRun');
  var statusEl=document.getElementById('spStatus');
  var exBtns=document.querySelectorAll('.sp-example');

  exBtns.forEach(function(btn){
    btn.addEventListener('click',function(){
      exBtns.forEach(function(b){b.classList.remove('active');});
      btn.classList.add('active');
      var idx=parseInt(btn.getAttribute('data-idx'),10);
      codeEl.value=EXAMPLES[idx].code;
      clearResult();
    });
  });

  function clearResult(){
    while(resultEl.firstChild)resultEl.removeChild(resultEl.firstChild);
    resultEl.textContent='Click Run to execute';
  }

  function addLine(cls,text){
    var line=document.createElement('div');
    line.className=cls;
    line.textContent=text;
    resultEl.appendChild(line);
  }

  async function sha256(msg){
    var buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(msg));
    return new Uint8Array(buf);
  }
  function leadingZeroBits(buf){
    var n=0;
    for(var i=0;i<buf.length;i++){
      if(buf[i]===0){n+=8;continue;}
      n+=Math.clz32(buf[i])-24;
      break;
    }
    return n;
  }
  async function solvePow(challenge,difficulty){
    var nonce=0;
    while(true){
      var hash=await sha256(challenge+':'+nonce);
      if(leadingZeroBits(hash)>=difficulty)return nonce;
      nonce++;
      if(nonce%5000===0)await new Promise(function(r){setTimeout(r,0);});
    }
  }

  async function callTool(slug,params,opts){
    opts=opts||{};
    var path=opts.path||('/api/'+slug);
    var method=opts.method||'POST';

    while(statusEl.firstChild)statusEl.removeChild(statusEl.firstChild);
    var spin=document.createElement('span');
    spin.className='spin';
    statusEl.appendChild(spin);
    statusEl.appendChild(document.createTextNode(' Solving PoW...'));

    var cRes=await fetch(BASE+'/api/pow/challenge?slug='+encodeURIComponent(slug));
    var cData=await cRes.json();
    var nonce=await solvePow(cData.challenge,cData.difficulty);

    while(statusEl.firstChild)statusEl.removeChild(statusEl.firstChild);
    var spin2=document.createElement('span');
    spin2.className='spin';
    statusEl.appendChild(spin2);
    statusEl.appendChild(document.createTextNode(' Calling tool...'));

    var headers={'X-Pow-Solution':cData.token+':'+nonce};
    var resp;
    if(method==='GET'){
      resp=await fetch(BASE+path+'?'+new URLSearchParams(params),{headers:headers});
    }else{
      headers['Content-Type']='application/json';
      resp=await fetch(BASE+path,{method:'POST',headers:headers,body:JSON.stringify(params)});
    }
    statusEl.textContent='Done';
    var ct=resp.headers.get('content-type')||'';
    if(ct.indexOf('json')!==-1)return resp.json();
    return resp.text();
  }

  /* User code runs entirely client-side via Function() — same sandbox model as
     CodePen/JSFiddle. callTool is injected as a parameter so user code can
     await it without importing anything. */
  runBtn.addEventListener('click',async function(){
    runBtn.disabled=true;
    while(resultEl.firstChild)resultEl.removeChild(resultEl.firstChild);
    var code=codeEl.value;
    var origConsoleLog=console.log;
    console.log=function(){
      var args=Array.from(arguments).map(function(a){return typeof a==='object'?JSON.stringify(a,null,2):String(a);}).join(' ');
      addLine('log',args);
    };
    try{
      var fn=new Function('callTool','"use strict";return (async function(){'+code+'})()'); // eslint-disable-line no-new-func
      await fn(callTool);
    }catch(e){
      addLine('err','Error: '+(e.message||String(e)));
    }finally{
      console.log=origConsoleLog;
      runBtn.disabled=false;
    }
  });
})();
</script>
</body>
</html>`;
}
