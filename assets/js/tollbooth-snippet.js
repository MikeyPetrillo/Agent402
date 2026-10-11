(function(){
  /* esc() HTML-escapes every user-controlled value before it reaches the
     syntax-highlighted snippet. This is the same sanitisation used in the
     pre-migration version of this page. */
  function esc(t){ return String(t==null?'':t).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }
  var w=document.getElementById('wallet'), p=document.getElementById('price'), m=document.getElementById('mode'), out=document.getElementById('snip');
  function render(){
    var wallet=esc((w.value||'').trim()||'0xYourWalletHere');
    var price=esc((p.value||'').trim()||'$0.002');
    var mode=esc(m.value);
    // Options and comments match tollbooth/index.js: `observe` is its own
    // boolean (a mode value of "observe" would charge), and the x402
    // middleware is what verifies and settles USDC (scripts/test-tollbooth-landing.js
    // runs this exact text against the package for every mode).
    var modeLine = mode==='observe'
      ? '  <span class="kw">observe</span>: <span class="num">true</span>,   <span class="com">// count would-charge requests, never 402</span>\n'
      : '  <span class="kw">mode</span>: <span class="str">"'+mode+'"</span>,   <span class="com">// '+(mode==='bots'?'charge known AI crawler user-agents; people pass':mode==='strict'?'charge anything that is not a real browser':'charge every client, people included')+'</span>\n';
    out.innerHTML =
      '<span class="kw">import</span> express <span class="kw">from</span> <span class="str">"express"</span>;\n' +
      '<span class="kw">import</span> { createTollbooth } <span class="kw">from</span> <span class="str">"agent402-tollbooth"</span>;\n' +
      '<span class="kw">import</span> { paymentMiddleware } <span class="kw">from</span> <span class="str">"@x402/express"</span>;\n' +
      '<span class="kw">import</span> { HTTPFacilitatorClient, x402ResourceServer } <span class="kw">from</span> <span class="str">"@x402/core/server"</span>;\n' +
      '<span class="kw">import</span> { ExactEvmScheme } <span class="kw">from</span> <span class="str">"@x402/evm/exact/server"</span>;\n\n' +
      '<span class="kw">const</span> payTo = <span class="str">"'+wallet+'"</span>;\n' +
      '<span class="kw">const</span> price = <span class="str">"'+price+'"</span>;\n\n' +
      '<span class="com">// USDC on Base, verified and settled by the x402 facilitator you choose</span>\n' +
      '<span class="kw">const</span> x402 = <span class="kw">paymentMiddleware</span>(\n' +
      '  { <span class="str">"/*"</span>: { accepts: [{ scheme: <span class="str">"exact"</span>, network: <span class="str">"eip155:8453"</span>, price, payTo }] } },\n' +
      '  <span class="kw">new</span> x402ResourceServer(<span class="kw">new</span> HTTPFacilitatorClient({ url: process.env.<span class="kw">X402_FACILITATOR_URL</span> }))\n' +
      '    .register(<span class="str">"eip155:8453"</span>, <span class="kw">new</span> ExactEvmScheme()),\n' +
      ');\n\n' +
      '<span class="kw">const</span> gate = <span class="kw">createTollbooth</span>({\n' +
      '  payTo, price, x402,\n' +
      modeLine +
      '});\n\n' +
      '<span class="kw">const</span> app = <span class="kw">express</span>();\n' +
      'app.<span class="kw">use</span>(gate);\n' +
      'app.<span class="kw">use</span>(yourExistingRoutes);\n' +
      'app.<span class="kw">listen</span>(<span class="num">3000</span>);';
  }
  w.addEventListener('input', render);
  p.addEventListener('input', render);
  m.addEventListener('change', render);
  render();

  document.querySelectorAll('.copy').forEach(function(btn){
    btn.addEventListener('click', function(){
      var el=document.getElementById(btn.getAttribute('data-target'));
      if(!el) return;
      var txt=el.innerText;
      if(navigator.clipboard) navigator.clipboard.writeText(txt);
      var old=btn.textContent; btn.textContent='copied'; setTimeout(function(){ btn.textContent=old; }, 1200);
    });
  });
})();
