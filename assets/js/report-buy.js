// Buy button on the programmatic report landing pages
// (/reports/insider/:ticker, /reports/fund/:manager, /reports/dossier/:ticker).
// External file because the site-wide CSP drops 'unsafe-inline' from
// script-src. Same /api/buy contract as assets/js/reports.js, with the product
// and the input already decided by the page.
(function () {
  document.querySelectorAll("[data-buy-product]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var errEl = document.getElementById("err-buy");
      if (errEl) errEl.textContent = "";
      var label = btn.textContent;
      btn.disabled = true;
      try { if (window.posthog && window.posthog.capture) window.posthog.capture("report_buy_click", { product: btn.dataset.buyProduct, kind: "programmatic" }); } catch (e) { /* telemetry never blocks a buy */ }
      btn.innerHTML = '<span class="spin"></span>Redirecting to checkout…';
      try {
        var r = await fetch("/api/buy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ product: btn.dataset.buyProduct, input: btn.dataset.buyInput }),
        });
        var j = await r.json();
        if (j && j.url) { window.location = j.url; return; }
        if (errEl) errEl.textContent = (j && j.error) || "Could not start checkout.";
      } catch (e) {
        if (errEl) errEl.textContent = "Network error, please try again.";
      }
      btn.disabled = false;
      btn.textContent = label;
    });
  });
})();
