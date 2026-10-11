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
   block's measure (never more than 60% of it, so a narrow cell never
   overflows). Text only: tags, code, buttons and attributes are untouched,
   and with no script the page simply wraps as before.
   scripts/test-wrap-quality.js measures the result in Chromium. */
document.addEventListener('DOMContentLoaded',function(){try{
  var SEL='main p,main li,main h1,main h2,main h3,main h4,main dd,main dt,main td,main th,main figcaption,main blockquote,main label,main [class*="lede"],main [class*="intro"],footer p';
  var OPAQUE=/^(CODE|PRE|KBD|SAMP|SCRIPT|STYLE|TEXTAREA|BUTTON|SELECT|svg|SVG|IMG|BR)$/;
  var INLINE=/^inline$|^contents$/;
  var BLOCK=/^(block|list-item|table-cell|flow-root)$/;
  var WS=/[ \t\n\r\f]+/g;
  var plans=[];
  var collect=function(el){var segs=[];var walk=function(n){for(var c=n.firstChild;c;c=c.nextSibling){if(c.nodeType===3){segs.push({node:c,text:c.data});}else if(c.nodeType===1){if(OPAQUE.test(c.tagName)){segs.push({node:null,text:c.textContent||'x'});continue;}var d=getComputedStyle(c).display;if(d==='none')continue;if(INLINE.test(d)){walk(c);}else{segs.push({node:null,text:c.textContent||'x'});}}}};walk(el);return segs;};
  var els=document.querySelectorAll(SEL);
  for(var i=0;i<els.length;i++){var el=els[i];if(el.closest('pre,code,[data-wrap="off"]'))continue;var cs=getComputedStyle(el);if(!BLOCK.test(cs.display)||/pre|nowrap/.test(cs.whiteSpace))continue;var w=el.clientWidth-parseFloat(cs.paddingLeft||0)-parseFloat(cs.paddingRight||0);var fs=parseFloat(cs.fontSize);if(!(w>0&&fs>0))continue;var em=/mono/i.test(cs.fontFamily)?0.6:0.5;var ls=parseFloat(cs.letterSpacing)||0;plans.push({el:el,line:w/(fs*em+ls),segs:collect(el)});}
  plans.forEach(function(p){
    var s='',map=[];p.segs.forEach(function(g){map.push({node:g.node,start:s.length});s+=g.text;});
    var first=s.search(/[^ \t\n\r\f]/);if(first<0)return;var last=s.replace(/[ \t\n\r\f]+$/,'').length-1;
    var runs=[],m;WS.lastIndex=0;while((m=WS.exec(s))){if(m.index>first&&m.index<last)runs.push({a:m.index,b:m.index+m[0].length});}
    if(runs.length<2)return;
    var lo=p.line*0.33,hi=p.line*0.6,k=0;
    for(var j=1;j<=runs.length;j++){var r=runs[runs.length-j];var chunk=last-r.b+1;var words=j;if(chunk>hi)break;k=j-1;if(words>=3&&chunk>=lo){break;}if(j===runs.length)k=j-1;}
    if(k<1)return;
    var segAt=function(x){for(var q=map.length-1;q>=0;q--)if(map[q].start<=x)return map[q];return null;};
    var edits=[];
    for(var t=1;t<=k;t++){var r2=runs[runs.length-t];var ok=true;for(var x=r2.a;x<r2.b;x++){var g=segAt(x);if(!g||!g.node){ok=false;break;}}if(!ok)continue;for(var y=r2.b-1;y>=r2.a;y--){var g2=segAt(y);edits.push({node:g2.node,off:y-g2.start,nb:y===r2.a});}}
    edits.forEach(function(e){var d=e.node.data;e.node.data=d.slice(0,e.off)+(e.nb?' ':'')+d.slice(e.off+1);});
  });
}catch(e){}});
