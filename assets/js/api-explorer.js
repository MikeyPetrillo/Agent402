(function(){
  // Same-origin, relative fetches: the page works on whatever host serves it.
  var list=document.getElementById('aeList');
  var search=document.getElementById('aeSearch');
  var countEl=document.getElementById('aeCount');
  var catsEl=document.getElementById('aeCats');
  var endpoints=[];
  var activeCategory='all';
  var freeByPath={};   // path -> slug for the proof-of-work (free) tools

  function el(tag,cls,text){
    var e=document.createElement(tag);
    if(cls)e.className=cls;
    if(text)e.textContent=text;
    return e;
  }

  // computePayable lives in /api/pricing, not in the OpenAPI spec.
  var pricing=fetch('/api/pricing').then(function(r){return r.json()}).then(function(pr){
    (pr.endpoints||[]).forEach(function(e){if(e.computePayable)freeByPath[e.path]=e.slug;});
  }).catch(function(){});
  Promise.all([fetch('/openapi.json').then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}),pricing]).then(function(res){
    var spec=res[0];
    var paths=spec.paths||{};
    Object.keys(paths).sort().forEach(function(p){
      var methods=paths[p];
      ['get','post','put','delete','patch'].forEach(function(m){
        if(!methods[m])return;
        var op=methods[m];
        // The spec's summary names one wire ("($0.001/call via x402)"); every
        // paid route also takes MPP, so the price is shown on its own instead.
        var name=String(op.summary||op.operationId||'').replace(/\s*\([^)]*via x402\)\s*$/,'');
        endpoints.push({method:m.toUpperCase(),path:p,slug:op.operationId||'',price:op['x-price']||'',name:name,desc:op.description||'',category:(op.tags&&op.tags[0])||'other',schema:op.requestBody&&op.requestBody.content&&op.requestBody.content['application/json']&&op.requestBody.content['application/json'].schema||null,params:op.parameters||[]});
      });
    });
    renderCats();
    renderList();
  }).catch(function(){
    while(list.firstChild)list.removeChild(list.firstChild);
    list.appendChild(document.createTextNode('Could not load the API spec here. Open '));
    var a=el('a','','/openapi.json');a.href='/openapi.json';list.appendChild(a);
    list.appendChild(document.createTextNode(' directly.'));
  });

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
      var free=freeByPath[ep.path];
      head.appendChild(el('span','ae-ep-name',ep.name+(ep.price?' \u00b7 '+ep.price+(free?' or free (proof-of-work)':' (x402 or MPP)'):'')));
      head.addEventListener('click',function(){div.classList.toggle('open');});
      div.appendChild(head);

      var body=el('div','ae-ep-body');

      if(ep.desc){
        var sec=el('div','ae-section');
        sec.appendChild(el('div','ae-section-title','Description'));
        var p=el('p','',ep.desc);
        p.style.cssText='font-size:var(--fs-md);color:var(--muted);margin:0';
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
      // The playground runs the free (proof-of-work) tools; a paid tool links to
      // its own page, which shows how to pay for it.
      var tryBtn=el('a','btn btn-secondary btn-sm ae-try-btn',free?'Try it free in the playground →':'Tool page and how to pay →');
      tryBtn.href=free?'/playground?slug='+encodeURIComponent(free):(ep.slug?'/tools/'+encodeURIComponent(ep.slug):'/tools');
      sec4.appendChild(tryBtn);
      body.appendChild(sec4);

      div.appendChild(body);
      list.appendChild(div);
    });
    countEl.textContent=shown+' endpoint'+(shown===1?'':'s')+' in openapi.json';
  }

  search.addEventListener('input',renderList);
})();
