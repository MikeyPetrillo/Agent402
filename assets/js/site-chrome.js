/* Theme: dark is the default (the :root tokens). A stored light preference is
   applied HERE, synchronously in <head>, so the first paint is already right -
   no flash, no inline script (CSP). Key: a402-theme = "light" | "dark"; light is the default, so only "dark" stamps. */
(function(){try{var t=localStorage.getItem('a402-theme');if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();
// Shared, site-wide chrome behavior: the hamburger menu toggle and
// reveal-on-scroll. Every page rendered through ledgerShell() loads this
// (CSP hardening, 2026-08-16 - was two inline <script> blocks; the burger
// button's onclick="a402ToggleMenu()" attribute is ALSO gone, since an
// inline event-handler attribute is exactly as CSP-blocked as an inline
// <script> tag - the click is now wired here instead).
document.addEventListener('DOMContentLoaded', function(){
  // This script tag loads in <head>, before <body> (and the burger button
  // it wires up) has been parsed - querying for .ml-burger at top-level
  // script-load time would find nothing and silently wire up no listener
  // at all. DOMContentLoaded guarantees the button already exists.
  function toggleMenu(){
    try {
      var open = document.documentElement.classList.toggle('ml-menu-open');
      var b = document.querySelector('.ml-burger');
      if (b) {
        b.setAttribute('aria-expanded', open ? 'true' : 'false');
        b.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      }
    } catch (e) {}
  }
  var burger = document.querySelector('.ml-burger');
  if (burger) burger.addEventListener('click', toggleMenu);
});

/* a402: reveal-on-scroll for every top-level header/section, site-wide. Was
   opt-in per-page via [data-reveal] (only the homepage set it, so every
   other page never got the effect at all); now applied here in the ONE
   shared script every page already loads, so it needs zero duplication -
   no per-page script block, no per-page attribute to remember to set.
   Anonymous function expression on purpose, not a declaration - avoids a
   leading-"function" source line, the exact shape test-theme.js's
   markup-safety assertions guard against. Class added here (JS), never
   baked into static CSS as a default-hidden state, so a throw/no-run leaves
   every section fully visible instead of stuck at opacity:0. The observer's
   own first callback decides visibility, not a separate getBoundingClientRect
   measurement taken before the map canvas/webfonts settle layout (that
   early-measurement bug made most sections read as already-above-the-fold
   and never animate). ONE-SHOT: once a section reveals, it is unobserved and
   never re-hidden. An earlier version toggled ml-reveal-in on every
   intersection change (added AND removed), meant to let a reload deep in the
   page still animate sections into view - but a reload doesn't need the
   removal half, only the addition: a section already in view on the
   observer's first callback reveals immediately either way. The removal
   half had a real, reported bug: a tall section scrolling past the top edge
   drops under the 8% threshold *while still partially on screen*, so it
   visibly faded out and shifted down 18px in front of the user mid-scroll -
   "content going off screen" on a normal scroll, not a rendering glitch.
   Revealed content now stays revealed, matching how every other
   scroll-reveal effect on the web works. querySelectorAll('header,section')
   only reaches pages whose top-level blocks are actually <section>
   elements - roughly half this site's page templates are, the rest use
   plain <div> wrappers and get no reveal effect from this alone; converting
   those is separate, per-template work, not something a shared script can
   retrofit onto markup that was never semantic to begin with.
   FIRST MATCH IS EXEMPT (2026-08-15): every page's first header/section is
   its hero - the block already sitting in the viewport on page load, on
   every template checked (marketplace/tools/sell/leaderboard/skills/docs/
   status/home). Hiding it behind opacity:0 first, same as every other
   section, meant it always had to wait on the observer's first callback -
   measured live at 100-300ms of near-zero opacity even though the content
   was already fully in view, a real flash-of-blank-hero on every load, not
   a scroll-triggered effect at all. The fix is DOM-order, not a
   getBoundingClientRect check - that's the deliberate difference from the
   early-measurement bug described above: no layout read before webfonts/map
   settle, so it can't misjudge a below-fold section as already visible.
   [data-reveal-eager] OPT-IN EXEMPTION (2026-08-16): some pages have a
   SECOND section that's also reliably above the fold on load (found on
   /pricing - the tier cards sit directly under a short hero, both visible
   together on an ordinary viewport) and got the same flash the hero fix
   above already solved for index 0. Rather than guessing "how many leading
   sections are above the fold" generically (which would need either an
   unsafe early layout read, or a blanket exemption for e.g. the first N
   sections that's WRONG on every page where section N+1 really is below
   the fold), this is a deliberate, explicit, per-section opt-in a page
   template sets only when it knows its own layout - same DOM-order safety
   property as the hero fix (no getBoundingClientRect), just marked by the
   page author instead of inferred by position. */
document.addEventListener('DOMContentLoaded',function(){try{if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;var els=document.querySelectorAll('header,section,[data-reveal]');if(els.length<2||!window.IntersectionObserver)return;var rest=Array.prototype.slice.call(els,1).filter(function(el){return !el.hasAttribute('data-reveal-eager');});if(!rest.length)return;rest.forEach(function(el){el.classList.add('ml-reveal');});var io=new IntersectionObserver(function(entries){entries.forEach(function(e){if(e.isIntersecting){e.target.classList.add('ml-reveal-in');io.unobserve(e.target);}});},{threshold:.08});rest.forEach(function(el){io.observe(el);});
/* SAFETY NET (2026-08-16) - a single large scroll jump (trackpad flick, End
   key, scrollbar-track click - all ordinary user actions) can move a short
   section from below the viewport to above it within one rendered frame, so
   the IntersectionObserver above never sees it cross the threshold and it
   stays at opacity:0 forever - proven live on /marketplace's "Markets by
   chain" section, reachable on ANY page since every <section> opts in.
   Revealed-content-stays-revealed elements are unobserve()'d, but a
   never-intersected element stays observed with no further callbacks ever
   firing for it, so subsequent normal scrolling does not self-heal it either.
   This directly measures position instead of trusting IO fired: on a
   debounced scroll (and once shortly after load, in case fonts/layout
   settled late) reveal anything not yet revealed whose top edge has reached
   or passed the viewport bottom - i.e. it is visible now OR already scrolled
   past. Never force-reveals a section still below the viewport, so the
   intended scroll-in effect for normal scrolling is untouched. */
var revealPassed=function(){rest.forEach(function(el){if(el.classList.contains('ml-reveal-in'))return;if(el.getBoundingClientRect().top<window.innerHeight){el.classList.add('ml-reveal-in');io.unobserve(el);}});};
var revealTimer=null;
window.addEventListener('scroll',function(){clearTimeout(revealTimer);revealTimer=setTimeout(revealPassed,150);},{passive:true});
setTimeout(revealPassed,500);
}catch(e){}});
document.addEventListener('DOMContentLoaded',function(){try{var btns=document.querySelectorAll('.ml-theme-toggle');if(!btns.length)return;function setTheme(light){try{if(light){document.documentElement.removeAttribute('data-theme');localStorage.setItem('a402-theme','light');}else{document.documentElement.setAttribute('data-theme','dark');localStorage.setItem('a402-theme','dark');}}catch(e){}}Array.prototype.forEach.call(btns,function(b){b.addEventListener('click',function(){setTheme(document.documentElement.getAttribute('data-theme')==='dark');});});}catch(e){}});
/* a402: widow control. text-wrap: pretty in Chromium only keeps a single word
   off the last line; a block still ends on two short words or a sliver of a
   line. This binds the last few words of each text block with no-break
   spaces so its last line holds at least 3 words and about a third of the
   block's measure, measured as rendered (never more than 97% of it, so the
   bound tail always fits a line). Text only: tags, code, buttons and
   attributes are untouched, and with no script the page simply wraps as before.
   scripts/test-wrap-quality.js measures the result in Chromium. */
/* Exposed so a page that renders text after load (the report view) can bind it too. */
/* a402: code tokens break at punctuation, never mid-word. Inline code (not a
   <pre> block) gets a <wbr> after each _ . / - : ? & = , inside a token, and
   between camelCase words of a long token, so a parameter name or route
   wraps at its own seams instead of splitting a word. Copied text is unchanged.
   A short name in a table cell gets no seams: one there would let the table
   squeeze its column, so it stays whole and a wide table scrolls instead. */
window.a402BreakCode=function(root){try{
  /* A code phrase of 4+ words holds its last three together (when they are short) in a nowrap span, so it never ends on one word. Copied text is unchanged. */
  var holdTail=function(el){var ln=el.lastChild;if(!ln||ln.nodeType!==3)return null;var d=ln.data,re=/\S+/g,m,toks=[];while((m=re.exec(d)))toks.push(m);var w=0,at=-1;for(var q=toks.length-1;q>0;q--){if(/[\p{L}\p{N}]/u.test(toks[q][0]))w++;if(w>=3){at=toks[q].index;break;}}if(at<0||d.length-at>32)return null;var sp=document.createElement('span');sp.style.whiteSpace='nowrap';sp.textContent=d.slice(at);ln.data=d.slice(0,at);el.appendChild(sp);return sp;};
  var els=(root||document).querySelectorAll('code,kbd,samp');
  for(var i=0;i<els.length;i++){var el=els[i];if(el.closest('pre')||el.getAttribute('data-wbr'))continue;
    el.setAttribute('data-wbr','1');
    /* In a table cell a name stays whole (a short token or phrase); a long one wraps like inline code, at its seams. */
    if(el.closest('td,th')){var tx=el.textContent.trim();if(tx.length<=40){el.style.whiteSpace='nowrap';continue;}}
    var held=holdTail(el);
    var tw=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),nodes=[];for(var n=tw.nextNode();n;n=tw.nextNode())if(!held||!held.contains(n))nodes.push(n);
    nodes.forEach(function(t){var d=t.data;if(d.length<9)return;
      var parts=[],from=0;
      for(var k=1;k<d.length-1;k++){var a=d.charAt(k-1),b=d.charAt(k);
        var c2=d.charAt(k-2)||'';var punct=/[_.\/:?&=,-]/.test(a)&&/[^\s_.\/:?&=,-]/.test(b)&&/\S/.test(c2)&&c2!==a;
        var camel=/[a-z0-9]/.test(a)&&/[A-Z]/.test(b)&&/[a-z]/.test(d.charAt(k+1)||'');
        if(punct||camel){parts.push(d.slice(from,k));from=k;}}
      if(!parts.length)return;parts.push(d.slice(from));
      var f=document.createDocumentFragment();parts.forEach(function(x,j){if(j)f.appendChild(document.createElement('wbr'));f.appendChild(document.createTextNode(x));});
      t.parentNode.replaceChild(f,t);});
  }
}catch(e){}};
/* Tails are measured, so binding waits for the web fonts (the fallback face measures differently).
   A font starts loading at the first layout that needs it, and before that layout document.fonts.status
   still reads "loaded"; a forced layout starts every fetch, so the status read after it is the real one. */
window.a402BindWidows=function(root){void document.documentElement.offsetHeight;if(document.fonts&&document.fonts.status!=='loaded'&&document.fonts.ready){document.fonts.ready.then(function(){a402BindNow(root);},function(){a402BindNow(root);});return;}a402BindNow(root);};
/* Two passes: binding a table cell changes its column, which moves its neighbours' lines, so the second pass binds against the settled layout. */
var a402BindNow=function(root){if(window.a402BreakCode)window.a402BreakCode(root);a402BindPass(root);a402BindPass(root);};
var a402BindPass=function(root){try{
  var SEL='p,li,h1,h2,h3,h4,dd,dt,td,th,figcaption,blockquote,label,[class*="lede"],[class*="intro"],[class*="meta"]';
  var OPAQUE=/^(CODE|PRE|KBD|SAMP|SCRIPT|STYLE|TEXTAREA|BUTTON|SELECT|svg|SVG|IMG|BR)$/;
  var INLINE=/^inline$|^contents$/;
  var BLOCK=/^(block|list-item|table-cell|flow-root)$/;
  var WS=/[ \t\n\r\f]+/g;
  var plans=[];
  var collect=function(el){var segs=[];var walk=function(n){for(var c=n.firstChild;c;c=c.nextSibling){if(c.nodeType===3){segs.push({node:c,text:c.data});}else if(c.nodeType===1){if(OPAQUE.test(c.tagName)){var cw=0,cr=c.getClientRects();for(var u=0;u<cr.length;u++)cw+=cr[u].width;segs.push({node:null,el:c,text:c.textContent||'x',w:cw});continue;}var d=getComputedStyle(c).display;if(d==='none')continue;if(INLINE.test(d)){walk(c);}else if(/^inline-/.test(d)){segs.push({node:null,el:c,text:c.textContent||'x'});}else{segs.push({node:null,text:c.textContent||'x'});}}}};walk(el);return segs;};
  var els=(root||document).querySelectorAll(SEL);
  /* The rendered width of the text from string offset x to the end: text by
     Range, inline code by its boxes; a block child in the tail is never bound. */
  var tailW=function(map,x,last){var W=0;for(var q=0;q<map.length;q++){var g=map[q];var a=Math.max(x,g.start),b=Math.min(last+1,g.start+g.len);if(b<=a)continue;var rs;if(g.node){var r=document.createRange();r.setStart(g.node,a-g.start);r.setEnd(g.node,b-g.start);rs=r.getClientRects();}else if(g.el){rs=g.el.getClientRects();}else return Infinity;for(var u=0;u<rs.length;u++)W+=rs[u].width;}return W;};
  /* Reads first (every block's tail measured), writes after, so the page lays out once. */
  for(var i=0;i<els.length;i++){var el=els[i];if(el.a402Split||!el.closest('main,footer')||el.closest('pre,code,[data-wrap="off"]'))continue;var cs=getComputedStyle(el);if(!BLOCK.test(cs.display)||/pre|nowrap/.test(cs.whiteSpace))continue;var w=el.clientWidth-parseFloat(cs.paddingLeft||0)-parseFloat(cs.paddingRight||0);if(!(w>0))continue;
    var segs=collect(el);var s='',map=[];segs.forEach(function(g){map.push({node:g.node,el:g.el,w:g.w,start:s.length,len:g.text.length});s+=g.text;});
    var first=s.search(/[^ \t\n\r\f]/);if(first<0)continue;var last=s.replace(/[ \t\n\r\f]+$/,'').length-1;
    var segAt=(function(map){return function(x){for(var q=map.length-1;q>=0;q--)if(map[q].start<=x)return map[q];return null;};})(map);
    var runs=[],m;WS.lastIndex=0;while((m=WS.exec(s))){if(m.index>first&&m.index<last){var g0=segAt(m.index);if(g0&&g0.node)runs.push({a:m.index,b:m.index+m[0].length});}}
    /* A short cell of a table that scrolls in its own wrapper (a name, a date, a type) stays whole: the table scrolls instead of splitting it. */
    var cell=/^T[DH]$/.test(el.tagName)&&runs.length<=3&&(function(e){for(var a=e.parentElement;a&&a!==document.body;a=a.parentElement){var ox=getComputedStyle(a).overflowX;if(ox==='auto'||ox==='scroll')return true;}return false;})(el);
    if(runs.length<1&&!cell)continue;
    /* The tail of j words, measured, for the last few runs. */
    var widths=[],wc=[],nw=0;for(var j=1;j<=Math.min(runs.length,24);j++){var rb=runs[runs.length-j].b,re2=j===1?last+1:runs[runs.length-j+1].a;widths.push(tailW(map,rb,last));/* an arrow or a lone dash is not a word; words a first pass already joined still count one by one */nw+=s.slice(rb,re2).split(/[\s\u00A0]+/).filter(function(t){return /[\p{L}\p{N}]/u.test(t);}).length;wc.push(nw);}
    var whole=(runs.length===1||cell)?tailW(map,first,last):0;
    /* A long token (60%+ of the measure) before the tail (a URL, a host name, inline code) too wide to join it: when the tail alone is short, the token joins it and breaks at its own seams, so its last piece rides on the last line ("protection." / "outlook.com, max_age: 86400."). */
    var ext=(function(){var lo=w*0.33,hi=w*0.97,jb=0;for(var j=1;j<=widths.length;j++){if(widths[j-1]>hi){jb=j;break;}if(wc[j-1]>=3&&widths[j-1]>=lo)return null;}if(jb<2||cell||widths[jb-1]-widths[jb-2]<w*0.6)return null;
      var R=runs.length,ta=runs[R-jb].b,te=runs[R-jb+1].a,seams=[],piece=-1;
      for(var x=ta+1;x<te;x++){var g=segAt(x);if(g&&g.node&&segAt(x-1)===g&&/[_.\/:?&=,-]/.test(s.charAt(x-1))&&/[^\s_.\/:?&=,\-⁠ ]/.test(s.charAt(x)))seams.push(x);}
      if(seams.length)piece=tailW(map,seams[seams.length-1],last);
      /* Inline code already broken at its seams (a <wbr>) splits after its last one. */
      for(var q=map.length-1;q>=0;q--){var gc=map[q];if(!gc.el||gc.start<ta||gc.start>=te||!/^(CODE|KBD|SAMP)$/.test(gc.el.tagName))continue;var wbs=gc.el.querySelectorAll('wbr');if(!wbs.length)break;if(seams.length&&seams[seams.length-1]>=gc.start+gc.len)break;var rr=document.createRange();rr.setStartAfter(wbs[wbs.length-1]);rr.setEnd(gc.el,gc.el.childNodes.length);var cw2=0,crs=rr.getClientRects();for(var u=0;u<crs.length;u++)cw2+=crs[u].width;piece=cw2+tailW(map,gc.start+gc.len,last);seams=[];break;}
      if(piece<0||piece>hi)return null;return {j:jb,seams:seams,from:runs[R-jb+1].b};})();
    plans.push({el:el,w:w,s:s,map:map,first:first,last:last,segAt:segAt,runs:runs,widths:widths,wc:wc,whole:whole,cell:cell,ext:ext});}
  plans.forEach(function(p){
    var s=p.s,map=p.map,first=p.first,last=p.last,segAt=p.segAt,runs=p.runs;
    /* Bind the fewest last words that make a tail of 3+ words and a third of the measure; never more than 97% of it, so the tail always fits a line. */
    var lo=p.w*0.33,hi=p.w*0.97,k=0;
    for(var j=1;j<=p.widths.length;j++){var chunk=p.widths[j-1];var words=p.wc[j-1];if(chunk>hi)break;k=j-1;if(words>=3&&chunk>=lo){break;}if(j===runs.length)k=j-1;}
    /* Two words (a short label or cell) stay together when both fit the line. */
    if(runs.length===1)k=p.whole<=hi?1:0;
    if(p.cell&&p.whole<=320){k=runs.length;hi=Infinity;}
    if(p.ext)k=p.ext.j-1;
    /* Inline code inside the bound tail stays whole too, when it fits the bound line. */
    var from=p.ext?p.ext.from:k<runs.length?runs[runs.length-k-1].b:first;
    map.forEach(function(g){if(g.el&&/^(CODE|KBD|SAMP)$/.test(g.el.tagName)&&g.start>=from&&g.w<=hi){g.el.style.whiteSpace='nowrap';/* a <wbr> still breaks inside nowrap in Chromium */var wb=g.el.querySelectorAll('wbr');for(var q=0;q<wb.length;q++)wb[q].parentNode.removeChild(wb[q]);g.el.normalize();}});
    var edits=[];
    for(var t=1;t<=k;t++){var r2=runs[runs.length-t];var ok=true;for(var x=r2.a;x<r2.b;x++){var g=segAt(x);if(!g||!g.node){ok=false;break;}}if(!ok)continue;for(var y=r2.b-1;y>=r2.a;y--){var g2=segAt(y);edits.push({node:g2.node,off:y-g2.start,op:y===r2.a?'nb':'del'});}}
    /* A hyphen, slash, bar, dash, ellipsis or query mark inside the bound tail, or any seam inside one token ("image_url:{url"), is still a break point ("proof-of-" / "work"): a word joiner after it holds the word together (a spaced dash "result - zero" too: a break is allowed between a hyphen and a no-break space). */
    if(k<1&&!(p.widths.length&&p.widths[0]<=hi)&&!p.cell)return;
    for(var z=from;z<last;z++){var c0=s.charAt(z),c1=s.charAt(z+1);if(c1!=='\u2060'&&c0!=='\u2060'&&(/[-\/\u2026?&=+|\u2013\u2014]/.test(c0)||(/\S/.test(c0)&&/\S/.test(c1)&&!(/[\p{L}\p{N}]/u.test(c0)&&/[\p{L}\p{N}]/u.test(c1))))){var g3=segAt(z);if(g3&&g3.node)edits.push({node:g3.node,off:z-g3.start,op:'wj'});}}
    /* A block whose long token was split is settled: the second pass would read the split token as one wide word. */
    if(p.ext){p.el.a402Split=true;p.ext.seams.forEach(function(x){var g4=segAt(x);if(g4&&g4.node)edits.push({node:g4.node,off:x-g4.start,op:'wbr'});});}
    if(!edits.length)return;
    edits.sort(function(a,b){return b.off-a.off;});
    edits.forEach(function(e){var d=e.node.data;if(e.op==='wbr'){var rest=e.node.splitText(e.off);rest.parentNode.insertBefore(document.createElement('wbr'),rest);return;}if(e.op==='wj'){e.node.data=d.slice(0,e.off+1)+'\u2060'+d.slice(e.off+1);}else{e.node.data=d.slice(0,e.off)+(e.op==='nb'?'\u00A0':'')+d.slice(e.off+1);}});
  });
}catch(e){}};
document.addEventListener('DOMContentLoaded',function(){window.a402BindWidows(document);});
