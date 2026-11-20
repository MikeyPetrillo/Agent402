(function(){
  // In-place seller switching: fetch the same-origin, server-rendered (and fully
  // escaped) market panel and swap it without a full reload. Progressive
  // enhancement - the roster links are real hrefs, so this whole block is a
  // no-op fallback to normal navigation when JS/fetch/history are unavailable
  // or a request fails. Content is parsed with createContextualFragment +
  // replaceChildren (not innerHTML); it is our own output, never user input.
  var panel=document.getElementById('market-panel');
  var CHAIN=panel?(panel.getAttribute('data-chain')||''):'';
  if(!panel||!window.fetch||!window.history||!history.pushState||!document.createRange().createContextualFragment)return;
  function loading(on){panel.style.transition='opacity var(--dur-fast)';panel.style.opacity=on?'.5':'';}
  function mark(host){document.querySelectorAll('[data-seller-link]').forEach(function(a){var h=a.getAttribute('data-seller-host')||'';a.classList.toggle('sel',host?(h===host):(a.getAttribute('data-seller-local')==='1'));});}
  function swap(html){panel.replaceChildren(document.createRange().createContextualFragment(html));}
  function load(host,push){
    loading(true);
    return fetch('/api/market/'+CHAIN+'/panel'+(host?('?seller='+encodeURIComponent(host)):''),{headers:{accept:'application/json'}})
      .then(function(r){if(!r.ok)throw 0;return r.json();})
      .then(function(j){swap(j.html);mark(host);loading(false);
        if(push){var u=host?(location.pathname.split('?')[0]+'?seller='+encodeURIComponent(host)):location.pathname.split('?')[0];history.pushState({s:host},'',u+'#activity');var el=document.getElementById('activity');if(el)el.scrollIntoView({behavior:window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}
        return true;});
  }
  document.addEventListener('click',function(e){
    var a=e.target.closest&&e.target.closest('[data-seller-link]');if(!a)return;
    e.preventDefault();var host=a.getAttribute('data-seller-host')||'';
    load(host,true).catch(function(){window.location.href=a.getAttribute('href');});
  });
  window.addEventListener('popstate',function(){var m=location.search.match(/[?&]seller=([^&#]+)/);load(m?decodeURIComponent(m[1]):'',false).catch(function(){location.reload();});});
})();
