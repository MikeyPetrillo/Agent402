// Playground — interactive tool-tester page.  Lets visitors pick any Agent402
// tool, fill in its inputs, solve a proof-of-work challenge in the browser, and
// see the live JSON response.  Entirely server-rendered HTML + inline vanilla JS
// (no frameworks, no external scripts).

import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function playgroundPage(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playground — try Agent402 tools for free</title>
<meta name="description" content="Try any of Agent402's 1,000+ free-tier tools directly in your browser. No signup, no wallet — proof-of-work pays automatically.">
<link rel="canonical" href="${esc(baseUrl)}/playground">
<meta property="og:title" content="Playground — try Agent402 tools for free">
<meta property="og:description" content="Try any of Agent402's 1,000+ free-tier tools directly in your browser. No signup, no wallet — proof-of-work pays automatically.">
<meta property="og:url" content="${esc(baseUrl)}/playground">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Playground — try Agent402 tools for free">
<meta name="twitter:description" content="Try any of Agent402's 1,000+ free-tier tools directly in your browser. No signup, no wallet — proof-of-work pays automatically.">
${CHROME_HEAD_LINKS}
<style>
${CHROME_CSS}
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
body{background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,sans-serif;min-height:100vh}
a{color:var(--accent)}
.crumb{max-width:1080px;margin:0 auto;padding:18px 20px 0;font-size:.85rem;color:var(--muted)}
.crumb a{color:var(--muted);text-decoration:none}
.crumb a:hover{color:var(--accent)}
.pg-title{max-width:1080px;margin:0 auto;padding:10px 20px 0}
.pg-title h1{font-size:1.6rem;font-weight:700;letter-spacing:-.02em}
.pg-title p{color:var(--muted);font-size:.95rem;margin-top:4px}
.pg-wrap{max-width:1080px;margin:24px auto 0;padding:0 20px;display:flex;gap:20px}
.pg-left{flex:0 0 60%;min-width:0}
.pg-right{flex:1;min-width:0}
@media(max-width:760px){.pg-wrap{flex-direction:column}.pg-left,.pg-right{flex:none;width:100%}}
.pg-search{width:100%;padding:10px 14px;border:1px solid #1e2638;border-radius:8px;background:var(--card);color:var(--text);font-size:.95rem;outline:none;font-family:inherit}
.pg-search:focus{border-color:var(--accent)}
.pg-search::placeholder{color:var(--muted)}
.pg-select{width:100%;margin-top:10px;padding:10px 14px;border:1px solid #1e2638;border-radius:8px;background:var(--card);color:var(--text);font-size:.95rem;outline:none;font-family:inherit;cursor:pointer}
.pg-select:focus{border-color:var(--accent)}
.pg-select optgroup{color:var(--muted);font-style:normal}
.pg-select option{color:var(--text);background:var(--card)}
.pg-info{margin-top:16px;padding:14px 16px;border:1px solid #1e2638;border-radius:10px;background:var(--card)}
.pg-info .tool-name{font-size:1.1rem;font-weight:600}
.pg-info .tool-desc{color:var(--muted);font-size:.9rem;margin-top:4px}
.pg-info .tool-meta{margin-top:8px;font-size:.82rem;color:var(--muted);font-family:var(--mono)}
.pg-info .tool-meta span{margin-right:14px}
.pg-fields{margin-top:14px}
.pg-field{margin-bottom:10px}
.pg-field label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:3px;font-family:var(--mono)}
.pg-field input[type="text"],.pg-field input[type="number"]{width:100%;padding:8px 12px;border:1px solid #1e2638;border-radius:6px;background:var(--bg);color:var(--text);font-size:.9rem;font-family:var(--mono);outline:none}
.pg-field input:focus{border-color:var(--accent)}
.pg-field .chk-wrap{display:flex;align-items:center;gap:8px}
.pg-field input[type="checkbox"]{accent-color:var(--accent);width:16px;height:16px}
.pg-btn{margin-top:14px;padding:10px 22px;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;transition:opacity .15s}
.pg-btn.run{background:var(--accent);color:#000}
.pg-btn.run:hover{opacity:.85}
.pg-btn.run:disabled{opacity:.5;cursor:not-allowed}
.pg-btn.disabled-info{background:#1e2638;color:var(--muted);cursor:default}
.pg-btn.disabled-info a{color:var(--accent);margin-left:6px}
.pg-status{margin-top:10px;font-size:.85rem;color:var(--muted);font-family:var(--mono)}
.pg-status .spin{display:inline-block;width:14px;height:14px;border:2px solid var(--muted);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.pg-result{padding:16px;border:1px solid #1e2638;border-radius:10px;background:var(--card);min-height:300px;position:sticky;top:80px}
.pg-result .placeholder{color:var(--muted);font-size:.9rem;text-align:center;padding-top:100px}
.pg-result pre{white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:.82rem;line-height:1.55;max-height:70vh;overflow:auto}
.pg-result .timing{font-size:.8rem;color:var(--muted);margin-bottom:10px;font-family:var(--mono)}
.pg-result .err{color:#f87171}
.json-str{color:#4ade80}
.json-num{color:#60a5fa}
.json-key{color:#e6e9f0}
.json-bool{color:#c084fc}
.json-null{color:#8b93a7}
</style>
</head>
<body>
<script>var BASE='${baseUrl.replace(/'/g, "\\'")}';</script>
${renderHeader("/playground")}
<div class="crumb"><a href="/">Agent402</a> / playground</div>
<div class="pg-title">
  <h1>Playground</h1>
  <p>Try any of Agent402's 1,000+ free-tier tools directly in your browser. No signup, no wallet — proof-of-work pays automatically.</p>
</div>
<div class="pg-wrap">
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
${renderFooter()}
<script>
(function(){
  var tools=[];
  var toolMap={};
  var selEl=document.getElementById('pgSelect');
  var searchEl=document.getElementById('pgSearch');
  var formEl=document.getElementById('pgForm');
  var resultEl=document.getElementById('pgResult');

  function escH(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* --- load catalog --- */
  fetch(BASE+'/api/pricing').then(function(r){return r.json()}).then(function(data){
    tools=(data.endpoints||[]).slice().sort(function(a,b){
      if(a.category<b.category)return -1;
      if(a.category>b.category)return 1;
      return a.name<b.name?-1:1;
    });
    tools.forEach(function(t){toolMap[t.slug]=t});
    renderSelect(tools);
    var def=toolMap['hash']||tools[0];
    if(def){selEl.value=def.slug;showTool(def.slug)}
  }).catch(function(){
    selEl.textContent='Failed to load tools';
  });

  function renderSelect(list){
    var cats={};
    list.forEach(function(t){
      if(!cats[t.category])cats[t.category]=[];
      cats[t.category].push(t);
    });
    while(selEl.firstChild)selEl.removeChild(selEl.firstChild);
    var placeholder=document.createElement('option');
    placeholder.value='';
    placeholder.textContent='-- select a tool --';
    selEl.appendChild(placeholder);
    Object.keys(cats).sort().forEach(function(c){
      var grp=document.createElement('optgroup');
      grp.label=c;
      cats[c].forEach(function(t){
        var opt=document.createElement('option');
        opt.value=t.slug;
        opt.textContent=t.name;
        grp.appendChild(opt);
      });
      selEl.appendChild(grp);
    });
  }

  /* --- search filter --- */
  searchEl.addEventListener('input',function(){
    var q=searchEl.value.toLowerCase().trim();
    if(!q){renderSelect(tools);return}
    var filtered=tools.filter(function(t){
      return t.name.toLowerCase().indexOf(q)!==-1||
             t.slug.toLowerCase().indexOf(q)!==-1||
             (t.description||'').toLowerCase().indexOf(q)!==-1||
             (t.category||'').toLowerCase().indexOf(q)!==-1;
    });
    renderSelect(filtered);
  });

  selEl.addEventListener('change',function(){showTool(selEl.value)});

  /* --- show tool form --- */
  function showTool(slug){
    var t=toolMap[slug];
    if(!t){while(formEl.firstChild)formEl.removeChild(formEl.firstChild);return}

    var schema=(t.discovery&&t.discovery.inputSchema&&t.discovery.inputSchema.properties)||{};
    var example=(t.discovery&&t.discovery.input)||{};
    var keys=Object.keys(schema);

    /* build form with safe DOM methods */
    while(formEl.firstChild)formEl.removeChild(formEl.firstChild);
    var info=document.createElement('div');
    info.className='pg-info';

    var nameEl=document.createElement('div');
    nameEl.className='tool-name';
    nameEl.textContent=t.name;
    info.appendChild(nameEl);

    var descEl=document.createElement('div');
    descEl.className='tool-desc';
    descEl.textContent=t.description||'';
    info.appendChild(descEl);

    var metaEl=document.createElement('div');
    metaEl.className='tool-meta';
    var mSpan1=document.createElement('span');
    mSpan1.textContent=t.method+' '+t.path;
    metaEl.appendChild(mSpan1);
    var mSpan2=document.createElement('span');
    mSpan2.textContent='$'+t.price;
    metaEl.appendChild(mSpan2);
    info.appendChild(metaEl);

    var fieldsDiv=document.createElement('div');
    fieldsDiv.className='pg-fields';
    keys.forEach(function(k){
      var prop=schema[k];
      var val=example[k]!==undefined?example[k]:'';
      var field=document.createElement('div');
      field.className='pg-field';

      var lbl=document.createElement('label');
      lbl.textContent=k;
      if(prop.description){
        var descSpan=document.createElement('span');
        descSpan.style.cssText='font-weight:400;color:var(--muted);font-family:inherit;font-size:.8rem';
        descSpan.textContent=' \u2014 '+prop.description;
        lbl.appendChild(descSpan);
      }
      field.appendChild(lbl);

      if(prop.type==='boolean'){
        var wrap=document.createElement('div');
        wrap.className='chk-wrap';
        var cb=document.createElement('input');
        cb.type='checkbox';
        cb.setAttribute('data-key',k);
        cb.setAttribute('data-type','boolean');
        if(val)cb.checked=true;
        wrap.appendChild(cb);
        var cbLabel=document.createElement('span');
        cbLabel.textContent=String(val);
        wrap.appendChild(cbLabel);
        field.appendChild(wrap);
      }else if(prop.type==='number'||prop.type==='integer'){
        var numIn=document.createElement('input');
        numIn.type='number';
        numIn.setAttribute('data-key',k);
        numIn.setAttribute('data-type','number');
        numIn.value=String(val);
        field.appendChild(numIn);
      }else{
        var txtIn=document.createElement('input');
        txtIn.type='text';
        txtIn.setAttribute('data-key',k);
        txtIn.setAttribute('data-type','string');
        txtIn.value=String(val);
        field.appendChild(txtIn);
      }
      fieldsDiv.appendChild(field);
    });
    info.appendChild(fieldsDiv);

    if(t.computePayable){
      var btn=document.createElement('button');
      btn.className='pg-btn run';
      btn.id='pgRun';
      btn.textContent='Run free (proof-of-work)';
      btn.addEventListener('click',function(){runTool(t)});
      info.appendChild(btn);
    }else{
      var dbtn=document.createElement('button');
      dbtn.className='pg-btn disabled-info';
      dbtn.disabled=true;
      dbtn.textContent='Requires USDC wallet ';
      var lnk=document.createElement('a');
      lnk.href='/integrations';
      lnk.textContent='Setup \u2192';
      dbtn.appendChild(lnk);
      info.appendChild(dbtn);
    }

    var statusDiv=document.createElement('div');
    statusDiv.className='pg-status';
    statusDiv.id='pgStatus';
    info.appendChild(statusDiv);

    formEl.appendChild(info);
  }

  /* --- PoW helpers --- */
  async function sha256(msg){
    var buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(msg));
    return new Uint8Array(buf);
  }
  function leadingZeroBits(buf){
    var n=0;
    for(var i=0;i<buf.length;i++){
      var b=buf[i];
      if(b===0){n+=8;continue}
      n+=Math.clz32(b)-24;
      break;
    }
    return n;
  }
  async function solvePow(challenge,difficulty){
    var nonce=0;
    while(true){
      var hash=await sha256(challenge+':'+nonce);
      if(leadingZeroBits(hash)>=difficulty) return nonce;
      nonce++;
      if(nonce%5000===0) await new Promise(function(r){setTimeout(r,0)});
    }
  }

  /* --- JSON syntax highlight (operates on pre-serialized JSON only) --- */
  function highlightJson(str){
    /* escape HTML entities first so content is safe */
    var safe=escH(str);
    return safe
      .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)\s*:/g,
        '<span class="json-key">$1</span>:')
      .replace(/:\s*(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g,
        ': <span class="json-str">$1</span>')
      .replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g,
        ': <span class="json-num">$1</span>')
      .replace(/:\s*(true|false)/g,
        ': <span class="json-bool">$1</span>')
      .replace(/:\s*(null)/g,
        ': <span class="json-null">$1</span>');
  }

  /* --- run tool --- */
  async function runTool(t){
    var btn=document.getElementById('pgRun');
    var status=document.getElementById('pgStatus');
    btn.disabled=true;

    /* status: solving */
    while(status.firstChild)status.removeChild(status.firstChild);
    var spinSpan=document.createElement('span');
    spinSpan.className='spin';
    status.appendChild(spinSpan);
    status.appendChild(document.createTextNode(' Solving proof-of-work...'));

    /* result: running */
    while(resultEl.firstChild)resultEl.removeChild(resultEl.firstChild);
    var runPlaceholder=document.createElement('div');
    runPlaceholder.className='placeholder';
    runPlaceholder.textContent='Running...';
    resultEl.appendChild(runPlaceholder);

    try{
      /* gather params */
      var params={};
      var inputs=formEl.querySelectorAll('[data-key]');
      for(var i=0;i<inputs.length;i++){
        var el=inputs[i];
        var k=el.getAttribute('data-key');
        var tp=el.getAttribute('data-type');
        if(tp==='boolean') params[k]=el.checked;
        else if(tp==='number') params[k]=el.value===''?0:Number(el.value);
        else params[k]=el.value;
      }

      /* get challenge */
      var powStart=performance.now();
      var cRes=await fetch(BASE+'/api/pow/challenge?slug='+encodeURIComponent(t.slug));
      if(!cRes.ok) throw new Error('Challenge request failed: '+cRes.status);
      var cData=await cRes.json();
      var challenge=cData.challenge,difficulty=cData.difficulty,token=cData.token;

      /* solve */
      var nonce=await solvePow(challenge,difficulty);
      var powMs=Math.round(performance.now()-powStart);

      /* status: calling */
      while(status.firstChild)status.removeChild(status.firstChild);
      var spinSpan2=document.createElement('span');
      spinSpan2.className='spin';
      status.appendChild(spinSpan2);
      status.appendChild(document.createTextNode(' Calling tool...'));

      /* call tool */
      var callStart=performance.now();
      var headers={'X-Pow-Solution':token+':'+nonce};
      var resp;
      if(t.method==='GET'){
        resp=await fetch(BASE+t.path+'?'+new URLSearchParams(params),{headers:headers});
      }else{
        headers['Content-Type']='application/json';
        resp=await fetch(BASE+t.path,{method:'POST',headers:headers,body:JSON.stringify(params)});
      }
      var callMs=Math.round(performance.now()-callStart);

      var body;
      var ct=resp.headers.get('content-type')||'';
      if(ct.indexOf('json')!==-1){
        body=await resp.json();
      }else{
        body=await resp.text();
      }

      /* render result */
      while(resultEl.firstChild)resultEl.removeChild(resultEl.firstChild);

      var timingDiv=document.createElement('div');
      timingDiv.className='timing';
      timingDiv.textContent='PoW solved in '+powMs+'ms, tool responded in '+callMs+'ms';
      resultEl.appendChild(timingDiv);

      var pre=document.createElement('pre');
      if(!resp.ok) pre.className='err';
      if(typeof body==='string'){
        pre.textContent=(!resp.ok?'HTTP '+resp.status+'\\n':'')+body;
      }else{
        var jsonStr=JSON.stringify(body,null,2);
        if(!resp.ok){
          var errPrefix=document.createElement('span');
          errPrefix.textContent='HTTP '+resp.status+'\\n';
          pre.appendChild(errPrefix);
        }
        /* highlightJson returns HTML-escaped + highlighted string */
        var codeSpan=document.createElement('span');
        codeSpan.innerHTML=highlightJson(jsonStr);
        pre.appendChild(codeSpan);
      }
      resultEl.appendChild(pre);

      status.textContent='Done \u2014 PoW '+powMs+'ms, response '+callMs+'ms';
    }catch(e){
      while(resultEl.firstChild)resultEl.removeChild(resultEl.firstChild);
      var errPre=document.createElement('pre');
      errPre.className='err';
      errPre.textContent=e.message||String(e);
      resultEl.appendChild(errPre);
      status.textContent='Error';
    }finally{
      btn.disabled=false;
    }
  }
})();
</script>
</body>
</html>`;
}
