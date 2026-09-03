// /monitors storefront behavior. External file (site CSP drops inline script).
(function () {
  document.querySelectorAll("[data-sub]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var product = btn.dataset.sub;
      try { if (window.posthog && window.posthog.capture) window.posthog.capture("monitor_subscribe_click", { product: product }); } catch (e) { /* telemetry never blocks a subscribe */ }
      var el = document.getElementById("in-" + product);
      var input = (el && el.value || "").trim();
      var errEl = document.getElementById("err-" + product);
      if (errEl) errEl.textContent = "";
      if (!input) { if (errEl) errEl.textContent = "Please enter a value."; return; }
      btn.disabled = true;
      var label = btn.textContent;
      btn.innerHTML = '<span class="spin"></span>Redirecting to checkout…';
      try {
        var r = await fetch("/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: product, target: input }) });
        var j = await r.json();
        if (j && j.url) { window.location = j.url; }
        else { if (errEl) errEl.textContent = (j && j.error) || "Could not start checkout."; btn.disabled = false; btn.textContent = label; }
      } catch (e) {
        if (errEl) errEl.textContent = "Network error, please try again.";
        btn.disabled = false; btn.textContent = label;
      }
    });
  });
})();
