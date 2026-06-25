// Interactive API docs — Swagger-style browsable reference generated from the
// live OpenAPI spec. Lets developers browse endpoints, see schemas, and try
// tools via the playground's PoW solver.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function apiExplorerPage(baseUrl) {
  const canonical = `${baseUrl}/docs/api/explorer`;
  const title = "API Explorer — interactive Agent402 reference";
  const description = "Browse every endpoint, inspect schemas, and try tools live. Generated from the OpenAPI spec.";

  const extraCss = `
.ae-wrap{max-width:1180px;margin:0 auto;padding:56px 30px 0}
.ae-crumb{font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:14px}
.ae-crumb a{color:var(--accent);text-decoration:none}
.ae-search{width:100%;max-width:560px;padding:13px 16px;background:var(--card);border:1.5px solid var(--ink);color:var(--ink);font-family:var(--font-mono);font-size:14px;outline:none;margin-bottom:14px}
.ae-search:focus{border-color:var(--accent)}
.ae-count{margin-left:12px;color:var(--faint);font-family:var(--font-mono);font-size:12px}
.ae-cats{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:22px}
.ae-cat-btn{background:transparent;border:1.5px solid var(--ink);color:var(--ink);padding:5px 10px;font-family:var(--font-mono);font-size:11.5px;cursor:pointer;transition:.15s}
.ae-cat-btn:hover{border-color:var(--accent);color:var(--accent)}
.ae-cat-btn.active{background:var(--ink);color:var(--cream);border-color:var(--ink);font-weight:700}
.ae-endpoint{background:var(--card);border:1.5px solid var(--ink);margin-bottom:8px;overflow:hidden}
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
.ae-schema{background:var(--ink);border:1.5px solid var(--ink);padding:12px 16px;font-family:var(--font-mono);font-size:12px;line-height:1.6;overflow-x:auto;color:var(--cream)}
.ae-prop{margin:4px 0}
.ae-prop-name{color:var(--accent)}
.ae-prop-type{color:var(--dk-muted)}
.ae-prop-desc{color:var(--dk-muted2);font-style:italic;margin-left:8px}
.ae-try-btn{display:inline-block;padding:9px 15px;background:var(--accent);color:#fff;font-weight:700;font-size:13px;border:none;cursor:pointer;text-decoration:none;font-family:var(--font-mono)}
.ae-try-btn:hover{opacity:.85}
@media(max-width:640px){.ae-ep-name{display:none}}
`;

  const body = `
<script>var BASE='${baseUrl.replace(/'/g, "\\'")}';</script>
<div class="ae-wrap">
<p class="ae-crumb"><a href="/">Home</a> &rsaquo; <a href="/docs">Docs</a> &rsaquo; API Explorer</p>
<div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:14px;">$ GET /docs/api/explorer</div>
<h1 style="font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;">API Explorer.</h1>
<p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:620px;margin:0 0 30px;">Browse every endpoint, inspect input schemas, and try tools live. Data from <a href="/openapi.json" style="color:var(--accent);text-decoration:none;">/openapi.json</a>.</p>
<input class="ae-search" id="aeSearch" type="text" placeholder="Search endpoints..." autocomplete="off"><span class="ae-count" id="aeCount"></span>
<div class="ae-cats" id="aeCats"></div>
<div id="aeList" style="font-family:var(--font-mono);font-size:13px;color:var(--faint);">Loading...</div>
</div>

<section style="max-width:1180px;margin:0 auto;padding:56px 30px 64px;">
</section>

${ledgerFooterCompact()}
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
</script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/docs", extraCss, body });
}
