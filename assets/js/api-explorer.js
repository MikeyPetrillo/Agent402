(function(){
  var wrapEl=document.querySelector('.ae-wrap');
  var BASE=wrapEl?(wrapEl.getAttribute('data-base')||''):'';
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
      var tryBtn=el('a','ae-try-btn','Try in Playground →');
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
