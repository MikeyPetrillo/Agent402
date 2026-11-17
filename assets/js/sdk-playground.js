(function(){
  var EXAMPLES=[
    {
      label: "Hash a string",
      code: "// Hash text with SHA-256\nconst result = await callTool(\"hash\", {\n  text: \"hello world\",\n  algo: \"sha256\"\n});\nconsole.log(result);",
    },
    {
      label: "Find tools by keyword",
      code: "// Search for tools matching a query - /api/find is free and\n// unpaywalled, so this skips the proof-of-work step entirely.\nconst result = await callTool(\"find\", {\n  q: \"weather\"\n}, { path: \"/api/find\", method: \"GET\", free: true });\nconsole.log(result);",
    },
    {
      label: "Generate a UUID",
      code: "// Generate a v4 UUID\nconst result = await callTool(\"uuid\", {}, { path: \"/api/uuid\", method: \"GET\" });\nconsole.log(result);",
    },
    {
      label: "Convert units",
      code: "// Convert miles to kilometers\nconst result = await callTool(\"unit-convert\", {\n  value: 26.2,\n  from: \"miles\",\n  to: \"kilometers\"\n});\nconsole.log(result);",
    },
    {
      label: "Base64 encode",
      code: "// Encode text to base64\nconst result = await callTool(\"base64\", {\n  text: \"Agent402 is awesome\"\n});\nconsole.log(result);",
    },
  ];
  var wrapEl=document.querySelector('.sp-wrap');
  var BASE=wrapEl?(wrapEl.getAttribute('data-base')||''):'';
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

  /* --- real PoW + tool call, run in this TRUSTED page (never inside the
     sandbox iframe below - it has no network access at all). --- */
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
    var headers={};

    if(opts.free){
      // Free, unpaywalled endpoints (e.g. /api/find) need no proof-of-work -
      // requesting a PoW challenge for a slug outside the paid catalog 404s.
      while(statusEl.firstChild)statusEl.removeChild(statusEl.firstChild);
      statusEl.appendChild(document.createTextNode('Calling free endpoint...'));
    }else{
      while(statusEl.firstChild)statusEl.removeChild(statusEl.firstChild);
      var spin=document.createElement('span');
      spin.className='spin';
      statusEl.appendChild(spin);
      statusEl.appendChild(document.createTextNode(' Solving PoW...'));

      var cRes=await fetch(BASE+'/api/pow/challenge?slug='+encodeURIComponent(slug));
      if(!cRes.ok)throw new Error('challenge request failed: '+cRes.status);
      var cData=await cRes.json();
      var nonce=await solvePow(cData.challenge,cData.difficulty);
      headers['X-Pow-Solution']=cData.token+':'+nonce;

      while(statusEl.firstChild)statusEl.removeChild(statusEl.firstChild);
      var spin2=document.createElement('span');
      spin2.className='spin';
      statusEl.appendChild(spin2);
      statusEl.appendChild(document.createTextNode(' Calling tool...'));
    }

    var resp;
    if(method==='GET'){
      resp=await fetch(BASE+path+'?'+new URLSearchParams(params),{headers:headers});
    }else{
      headers['Content-Type']='application/json';
      resp=await fetch(BASE+path,{method:'POST',headers:headers,body:JSON.stringify(params)});
    }
    var ct=resp.headers.get('content-type')||'';
    if(ct.indexOf('json')!==-1)return resp.json();
    return resp.text();
  }

  /* --- user code runs inside an isolated, network-less sandbox iframe
     (assets/sdk-sandbox.html, served from its own route with its own
     relaxed CSP - see /sdk-playground/sandbox in server.js). The iframe can
     only reach the outside world by asking THIS page to run callTool on its
     behalf via postMessage; it never gets fetch, cookies, or this origin. --- */
  var RUN_TIMEOUT_MS=30000;
  var active=null; // { iframe, timer, resolveReady }

  function teardown(){
    if(!active)return;
    clearTimeout(active.timer);
    if(active.iframe && active.iframe.parentNode)active.iframe.parentNode.removeChild(active.iframe);
    active=null;
  }

  window.addEventListener('message',function(ev){
    if(!active || ev.source!==active.iframe.contentWindow)return;
    var msg=ev.data;
    if(!msg||typeof msg!=='object')return;

    if(msg.type==='ready'){
      active.iframe.contentWindow.postMessage({type:'run',code:active.code},'*');
      return;
    }
    if(msg.type==='log'){
      addLine('log',msg.text);
      return;
    }
    if(msg.type==='error'){
      addLine('err','Error: '+msg.message);
      return;
    }
    if(msg.type==='callTool'){
      var id=msg.id;
      callTool(msg.slug,msg.params,msg.opts).then(function(result){
        if(active && active.iframe.contentWindow)active.iframe.contentWindow.postMessage({type:'callToolResult',id:id,result:result},'*');
      }).catch(function(e){
        if(active && active.iframe.contentWindow)active.iframe.contentWindow.postMessage({type:'callToolError',id:id,error:(e&&e.message)||String(e)},'*');
      });
      return;
    }
    if(msg.type==='done'){
      statusEl.textContent='Done';
      runBtn.disabled=false;
      teardown();
      return;
    }
  });

  runBtn.addEventListener('click',function(){
    if(active)return;
    runBtn.disabled=true;
    while(resultEl.firstChild)resultEl.removeChild(resultEl.firstChild);
    statusEl.textContent='';

    var iframe=document.createElement('iframe');
    iframe.setAttribute('sandbox','allow-scripts');
    iframe.style.display='none';
    iframe.src='/sdk-playground/sandbox';
    document.body.appendChild(iframe);

    active={iframe:iframe,code:codeEl.value,timer:setTimeout(function(){
      addLine('err','Error: timed out after '+(RUN_TIMEOUT_MS/1000)+'s');
      statusEl.textContent='Error';
      runBtn.disabled=false;
      teardown();
    },RUN_TIMEOUT_MS)};
  });
})();
