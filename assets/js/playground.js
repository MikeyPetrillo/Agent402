(function(){
  var wrapEl=document.querySelector('.pg-wrap');
  var BASE=wrapEl?(wrapEl.getAttribute('data-base')||''):'';
  var tools=[];
  var toolMap={};
  var selEl=document.getElementById('pgSelect');
  var searchEl=document.getElementById('pgSearch');
  var formEl=document.getElementById('pgForm');
  var resultEl=document.getElementById('pgResult');

  function escH(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* --- load catalog (embedded at render time via the pg-tools-data JSON
     island; see playgroundPage) --- */
  (function loadCatalog(){
    var dataEl=document.getElementById('pg-tools-data');
    var data=dataEl?JSON.parse(dataEl.textContent):[];
    tools=(data||[]).slice().sort(function(a,b){
      if(a.category<b.category)return -1;
      if(a.category>b.category)return 1;
      var an=(a.name||a.slug||'');
      var bn=(b.name||b.slug||'');
      return an<bn?-1:1;
    });
    tools.forEach(function(t){toolMap[t.slug]=t});
    /* The picker lists the free-tier tools only: those are the ones this page
       can run. A deep link to a paid tool still shows its form and price. */
    tools=tools.filter(function(t){return t.computePayable});
    renderSelect(tools);
    var want=null;
    try{
      var params=new URLSearchParams(window.location.search);
      want=params.get('slug');
    }catch(e){}
    var def=(want&&toolMap[want])||toolMap['hash']||tools[0];
    if(def){selEl.value=def.slug;showTool(def.slug,true)}
  })();

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
        opt.textContent=t.name||t.slug;
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
      return (t.name||'').toLowerCase().indexOf(q)!==-1||
             t.slug.toLowerCase().indexOf(q)!==-1||
             (t.description||'').toLowerCase().indexOf(q)!==-1||
             (t.category||'').toLowerCase().indexOf(q)!==-1;
    });
    renderSelect(filtered);
  });

  selEl.addEventListener('change',function(){showTool(selEl.value)});

  /* --- show tool form --- */
  function showTool(slug, skipUrl){
    var t=toolMap[slug];
    if(!t){while(formEl.firstChild)formEl.removeChild(formEl.firstChild);return}

    if(!skipUrl){
      try{
        var u=new URL(window.location.href);
        u.searchParams.set('slug',slug);
        history.replaceState(null,'',u.pathname+u.search+(u.hash||''));
      }catch(e){}
    }

    var schema=(t.discovery&&t.discovery.inputSchema&&t.discovery.inputSchema.properties)||{};
    var example=(t.discovery&&t.discovery.input)||{};
    var keys=Object.keys(schema);

    /* build form with safe DOM methods */
    while(formEl.firstChild)formEl.removeChild(formEl.firstChild);
    var info=document.createElement('div');
    info.className='pg-info';

    var nameEl=document.createElement('div');
    nameEl.className='tool-name';
    nameEl.textContent=t.name||t.slug;
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
    // price is already a "$X.XXX" display string from the catalog
    mSpan2.textContent=t.price||'';
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
        descSpan.style.cssText='font-weight:400;color:var(--faint);font-family:inherit;font-size:var(--fs-sm)';
        descSpan.textContent=' - '+prop.description;
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
      /* A paid tool cannot run here: say so in text, with the setup link as
         its own link (never inside a disabled button). */
      var paid=document.createElement('p');
      paid.className='pg-paid';
      paid.textContent='This tool is paid per call'+(t.price?' ('+t.price+')':'')+' and runs from an agent with a wallet, not in this page. ';
      var lnk=document.createElement('a');
      lnk.href='/integrations';
      lnk.textContent='Set up a wallet →';
      paid.appendChild(lnk);
      info.appendChild(paid);
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

  /* --- JSON syntax highlight (operates on pre-serialized, HTML-escaped JSON) --- */
  function highlightJson(str){
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
        pre.textContent=(!resp.ok?'HTTP '+resp.status+'\n':'')+body;
      }else{
        var jsonStr=JSON.stringify(body,null,2);
        if(!resp.ok){
          var errPrefix=document.createElement('span');
          errPrefix.textContent='HTTP '+resp.status+'\n';
          pre.appendChild(errPrefix);
        }
        /* highlightJson returns HTML-escaped + highlighted string */
        var codeSpan=document.createElement('span');
        codeSpan.innerHTML=highlightJson(jsonStr);
        pre.appendChild(codeSpan);
      }
      resultEl.appendChild(pre);

      status.textContent='Done - PoW '+powMs+'ms, response '+callMs+'ms';
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
