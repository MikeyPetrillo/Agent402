// Buy button on the programmatic report landing pages
// (/reports/insider/:ticker, /reports/fund/:manager, /reports/dossier/:ticker).
// External file because the site-wide CSP drops 'unsafe-inline' from
// script-src. Same /api/buy contract as assets/js/reports.js, with the product
// and the input already decided by the page.
(function () {
  // Google Analytics key events (assets/js/ga-loader.js defines gtag only
  // where GA is configured and allowed): the product and the kind only, never
  // what the buyer typed. Sent as a beacon so it survives the redirect.
  function ga(ev, props) { try { if (typeof window.gtag === "function") window.gtag("event", ev, Object.assign({ transport_type: "beacon" }, props)); } catch (e) { /* telemetry never blocks a buy */ } }
  document.querySelectorAll("[data-buy-product]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var errEl = document.getElementById("err-buy");
      if (errEl) errEl.textContent = "";
      var label = btn.textContent;
      btn.disabled = true;
      try { if (window.posthog && window.posthog.capture) window.posthog.capture("report_buy_click", { product: btn.dataset.buyProduct, kind: "programmatic" }); } catch (e) { /* telemetry never blocks a buy */ }
      ga("report_buy_click", { product: btn.dataset.buyProduct, kind: "programmatic" });
      btn.innerHTML = '<span class="spin"></span>Redirecting to checkout…';
      try {
        var r = await fetch("/api/buy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ product: btn.dataset.buyProduct, input: btn.dataset.buyInput }),
        });
        var j = await r.json();
        if (j && j.url) { ga("checkout_started", { product: btn.dataset.buyProduct, kind: "programmatic" }); window.location = j.url; return; }
        if (errEl) errEl.textContent = (j && j.error) || "Could not start checkout.";
      } catch (e) {
        if (errEl) errEl.textContent = "Network error, please try again.";
      }
      btn.disabled = false;
      btn.textContent = label;
    });
  });
})();
