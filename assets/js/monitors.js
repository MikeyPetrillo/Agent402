// /monitors storefront behavior. External file (site CSP drops inline script).
(function () {
  // Google Analytics key events (assets/js/ga-loader.js defines gtag only
  // where GA is configured and allowed): the product and the kind only, never
  // what the buyer typed. Sent as a beacon so it survives the redirect.
  function ga(ev, props) { try { if (typeof window.gtag === "function") window.gtag("event", ev, Object.assign({ transport_type: "beacon" }, props)); } catch (e) { /* telemetry never blocks a subscribe */ } }
  // Each card's field sits in a <form>: Subscribe submits it, and so does Enter
  // in the field. An empty field shows its error in the line it names by
  // aria-describedby, is marked invalid and keeps focus.
  document.querySelectorAll(".pcard-form").forEach(function (form) {
    var product = form.dataset.product;
    var el = document.getElementById("in-" + product);
    var errEl = document.getElementById("err-" + product);
    var btn = form.querySelector("[data-sub]");
    if (!el || !btn) return;
    el.addEventListener("input", function () { if (el.getAttribute("aria-invalid")) { el.removeAttribute("aria-invalid"); if (errEl) errEl.textContent = ""; } });
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      if (btn.disabled) return;
      try { if (window.posthog && window.posthog.capture) window.posthog.capture("monitor_subscribe_click", { product: product }); } catch (e) { /* telemetry never blocks a subscribe */ }
      ga("monitor_subscribe_click", { product: product });
      var input = (el.value || "").trim();
      if (errEl) errEl.textContent = "";
      if (!input) { if (errEl) errEl.textContent = "Please enter a value."; el.setAttribute("aria-invalid", "true"); el.focus(); return; }
      el.removeAttribute("aria-invalid");
      btn.disabled = true;
      var label = btn.textContent;
      btn.innerHTML = '<span class="spin"></span>Redirecting to checkout…';
      try {
        var r = await fetch("/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: product, target: input, source: (window.a402Source && window.a402Source()) || undefined }) });
        var j = await r.json();
        if (j && j.url) { ga("monitor_checkout_started", { product: product }); window.location = j.url; }
        else { if (errEl) errEl.textContent = (j && j.error) || "Could not start checkout."; btn.disabled = false; btn.textContent = label; }
      } catch (e) {
        if (errEl) errEl.textContent = "Network error, please try again.";
        btn.disabled = false; btn.textContent = label;
      }
    });
  });
})();
// "Already subscribed? Manage or cancel": the form also works without this
// script (a plain POST answers with a page); with it, the answer shows inline.
(function () {
  var form = document.querySelector(".manage-form");
  if (!form) return;
  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var input = form.querySelector("input[name=email]");
    var msg = form.querySelector(".msg");
    var btn = form.querySelector("button[type=submit]");
    var email = (input && input.value || "").trim();
    if (!email) { if (msg) msg.textContent = "Enter the email address you used at checkout."; return; }
    if (btn) btn.disabled = true;
    try {
      var r = await fetch("/monitors/manage-link", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ email: email }) });
      var j = await r.json();
      if (msg) msg.textContent = (j && (j.message || j.error)) || "Please try again in a moment.";
    } catch (e) {
      if (msg) msg.textContent = "Network error, please try again.";
    }
    if (btn) btn.disabled = false;
  });
})();
