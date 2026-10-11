(function(){
  // Shared "copy code snippet" button handler for every page that has one:
  // adapter docs (.ml-adp-copy), the /docs badges (.bdg-copy), contribute (.ct-copy),
  // quickstart (.qs-copy). All four copy their own <code> sibling's text and
  // give the same "Copied!" feedback - unified into one file (CSP hardening,
  // 2026-08-16) instead of four near-identical inline scripts. .ml-adp-copy
  // originally used inline style.color instead of a "copied" CSS class;
  // both behaviors are preserved exactly, keyed by which class matched, so
  // no page's visual behavior changed.
  function wire(selector, feedback){
    document.querySelectorAll(selector).forEach(function(btn){
      btn.addEventListener("click",function(){
        var code=btn.parentElement.querySelector("code");
        var text=code.textContent;
        navigator.clipboard.writeText(text).then(function(){
          btn.textContent="Copied!";
          feedback(btn, true);
          setTimeout(function(){btn.textContent="Copy";feedback(btn, false);},1500);
        });
      });
    });
  }
  wire(".ml-adp-copy", function(btn, on){ btn.style.color = on ? "var(--accent)" : ""; });
  wire(".bdg-copy, .ct-copy, .qs-copy", function(btn, on){ btn.classList.toggle("copied", on); });
})();
