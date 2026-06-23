// Interactive API docs — Swagger-style browsable reference generated from the
// live OpenAPI spec. Lets developers browse endpoints, see schemas, and try
// tools via the playground's PoW solver.

import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function apiExplorerPage(baseUrl) {
  const canonical = `${baseUrl}/docs/api`;
  const title = "API Explorer — interactive Agent402 reference";
  const description = "Browse every endpoint, inspect schemas, and try tools live. Generated from the OpenAPI spec.";

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
.ae-wrap{max-width:1080px;margin:0 auto;padding:1.5rem 1.25rem 4rem}
.ae-crumb{font-size:.85rem;color:var(--muted);margin-bottom:1rem}
.ae-crumb a{color:var(--accent);text-decoration:none}
.ae-title{font-size:1.6rem;font-weight:700;margin:0 0 .5rem}
.ae-sub{color:var(--muted);margin:0 0 1.5rem;font-size:.95rem}
.ae-sub a{color:var(--accent)}
.ae-search{width:100%;max-width:480px;padding:10px 16px;background:#0d1220;border:1px solid #1e2638;border-radius:10px;color:var(--text);font-size:.95rem;outline:none;margin-bottom:1rem}
.ae-search:focus{border-color:var(--accent)}
.ae-count{margin-left:12px;color:var(--muted);font-size:.85rem}
.ae-cats{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1.5rem}
.ae-cat-btn{background:transparent;border:1px solid #1e2638;color:var(--muted);padding:.35rem .75rem;border-radius:999px;font-size:.8rem;cursor:pointer;font-family:inherit;transition:.15s}
.ae-cat-btn:hover{border-color:var(--accent);color:var(--text)}
.ae-cat-btn.active{background:var(--accent);color:#0b0e14;border-color:var(--accent);font-weight:600}
.ae-endpoint{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;margin-bottom:.75rem;overflow:hidden}
.ae-ep-head{display:flex;align-items:center;gap:12px;padding:.75rem 1rem;cursor:pointer;user-select:none}
.ae-ep-head:hover{background:rgba(255,255,255,.02)}
.ae-method{font-family:var(--mono);font-size:.75rem;font-weight:700;padding:2px 8px;border-radius:4px;min-width:48px;text-align:center}
.ae-method.GET{background:#1a3a2a;color:#4ade80}
.ae-method.POST{background:#1a2a3d;color:#60a5fa}
.ae-path{font-family:var(--mono);font-size:.88rem;color:var(--text)}
.ae-ep-name{color:var(--muted);font-size:.85rem;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}
.ae-ep-body{display:none;border-top:1px solid rgba(255,255,255,.06);padding:1rem}
.ae-endpoint.open .ae-ep-body{display:block}
.ae-section{margin-bottom:.75rem}
.ae-section-title{font-size:.82rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.4rem}
.ae-schema{background:var(--bg);border:1px solid #1e2638;border-radius:6px;padding:.75rem 1rem;font-family:var(--mono);font-size:.78rem;line-height:1.5;overflow-x:auto}
.ae-prop{margin:.25rem 0}
.ae-prop-name{color:var(--accent)}
.ae-prop-type{color:var(--muted)}
.ae-prop-desc{color:var(--muted);font-style:italic;margin-left:.5rem}
.ae-try-btn{display:inline-block;padding:.4rem 1rem;background:var(--accent);color:#000;font-weight:600;font-size:.82rem;border:none;border-radius:6px;cursor:pointer;text-decoration:none;font-family:inherit}
.ae-try-btn:hover{opacity:.85}
@media(max-width:640px){.ae-ep-name{display:none}}
</style>
</head>
<body>
<script>var BASE='${baseUrl.replace(/'/g, "\\'")}';</script>
${renderHeader("/docs")}
<div class="ae-wrap">
<p class="ae-crumb"><a href="/">Home</a> &rsaquo; <a href="/docs">Docs</a> &rsaquo; API Explorer</p>
<h1 class="ae-title">API Explorer</h1>
<p class="ae-sub">Browse every endpoint, inspect input schemas, and try tools live. Data from <a href="/openapi.json">/openapi.json</a>.</p>
<input class="ae-search" id="aeSearch" type="text" placeholder="Search endpoints..." autocomplete="off"><span class="ae-count" id="aeCount"></span>
<div class="ae-cats" id="aeCats"></div>
<div id="aeList">Loading...</div>
</div>
${renderFooter()}
<script>
(function(){
  var list=document.getElementById('aeList');
  var search=document.getElementById('aeSearch');
  var countEl=document.getElementById('aeCount');
  var catsEl=document.getElementById('aeCats');
  var endpoints=[];
  var activeCategory='all';

  function el(tag,cls,text){
    var e=document.createElement(tag);
    if(cls)e.className=cls;
    if(text)e.textContent=text;
    return e;
  }

  fetch(BASE+'/openapi.json').then(function(r){return r.json()}).then(function(spec){
    var paths=spec.paths||{};
    Object.keys(paths).sort().forEach(function(p){
      var methods=paths[p];
      ['get','post','put','delete','patch'].forEach(function(m){
        if(!methods[m])return;
        var op=methods[m];
        endpoints.push({method:m.toUpperCase(),path:p,name:op.summary||op.operationId||'',desc:op.description||'',category:(op.tags&&op.tags[0])||'other',schema:op.requestBody&&op.requestBody.content&&op.requestBody.content['application/json']&&op.requestBody.content['application/json'].schema||null,params:op.parameters||[]});
      });
    });
    renderCats();
    renderList();
  }).catch(function(){list.textContent='Failed to load API spec.';});

  function renderCats(){
    while(catsEl.firstChild)catsEl.removeChild(catsEl.firstChild);
    var cats={};
    endpoints.forEach(function(e){cats[e.category]=true;});
    var allBtn=el('button','ae-cat-btn active','All');
    allBtn.setAttribute('data-cat','all');
    catsEl.appendChild(allBtn);
    Object.keys(cats).sort().forEach(function(c){
      var btn=el('button','ae-cat-btn',c);
      btn.setAttribute('data-cat',c);
      catsEl.appendChild(btn);
    });
    catsEl.addEventListener('click',function(ev){
      var btn=ev.target.closest('.ae-cat-btn');
      if(!btn)return;
      activeCategory=btn.getAttribute('data-cat');
      catsEl.querySelectorAll('.ae-cat-btn').forEach(function(x){x.classList.remove('active');});
      btn.classList.add('active');
      renderList();
    });
  }

  function renderList(){
    var q=search.value.toLowerCase().trim();
    while(list.firstChild)list.removeChild(list.firstChild);
    var shown=0;
    endpoints.forEach(function(ep){
      if(activeCategory!=='all'&&ep.category!==activeCategory)return;
      if(q&&ep.method.toLowerCase().indexOf(q)===-1&&ep.path.toLowerCase().indexOf(q)===-1&&ep.name.toLowerCase().indexOf(q)===-1&&ep.desc.toLowerCase().indexOf(q)===-1)return;
      shown++;

      var div=el('div','ae-endpoint');
      var head=el('div','ae-ep-head');
      head.appendChild(el('span','ae-method '+ep.method,ep.method));
      head.appendChild(el('span','ae-path',ep.path));
      head.appendChild(el('span','ae-ep-name',ep.name));
      head.addEventListener('click',function(){div.classList.toggle('open');});
      div.appendChild(head);

      var body=el('div','ae-ep-body');

      if(ep.desc){
        var sec=el('div','ae-section');
        sec.appendChild(el('div','ae-section-title','Description'));
        var p=el('p','',ep.desc);
        p.style.cssText='font-size:.9rem;color:var(--muted);margin:0';
        sec.appendChild(p);
        body.appendChild(sec);
      }

      if(ep.params.length){
        var sec2=el('div','ae-section');
        sec2.appendChild(el('div','ae-section-title','Parameters'));
        var schema=el('div','ae-schema');
        ep.params.forEach(function(pm){
          var row=el('div','ae-prop');
          row.appendChild(el('span','ae-prop-name',pm.name));
          row.appendChild(document.createTextNode(' '));
          row.appendChild(el('span','ae-prop-type',pm.in||'query'));
          if(pm.description){row.appendChild(document.createTextNode(' '));row.appendChild(el('span','ae-prop-desc',pm.description));}
          schema.appendChild(row);
        });
        sec2.appendChild(schema);
        body.appendChild(sec2);
      }

      if(ep.schema&&ep.schema.properties){
        var sec3=el('div','ae-section');
        sec3.appendChild(el('div','ae-section-title','Request Body'));
        var schema2=el('div','ae-schema');
        Object.keys(ep.schema.properties).forEach(function(k){
          var prop=ep.schema.properties[k];
          var row=el('div','ae-prop');
          row.appendChild(el('span','ae-prop-name',k));
          row.appendChild(document.createTextNode(' '));
          row.appendChild(el('span','ae-prop-type',prop.type||'any'));
          if(prop.description){row.appendChild(document.createTextNode(' '));row.appendChild(el('span','ae-prop-desc',prop.description));}
          schema2.appendChild(row);
        });
        sec3.appendChild(schema2);
        body.appendChild(sec3);
      }

      var sec4=el('div','ae-section');
      var tryBtn=el('a','ae-try-btn','Try in Playground \u2192');
      tryBtn.href='/playground';
      sec4.appendChild(tryBtn);
      body.appendChild(sec4);

      div.appendChild(body);
      list.appendChild(div);
    });
    countEl.textContent=shown+' endpoint'+(shown===1?'':'s');
  }

  search.addEventListener('input',renderList);
})();
</script>
</body>
</html>`;
}
