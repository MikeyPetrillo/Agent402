// /credits behavior: start a Stripe Checkout for a credit pack, signed in. External file
// (site CSP drops inline script).
(function () {
  document.querySelectorAll("[data-pack-buy]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var pack = btn.dataset.packBuy;
      var errEl = document.getElementById("err-" + pack);
      if (errEl) errEl.textContent = "";
      btn.disabled = true; var old = btn.textContent; btn.textContent = "Opening checkout…";
      try {
        // A purchase is made signed in to the balance page; a buyer who is
        // not signed in goes there first, with the pack chosen.
        var r = await fetch("/credits/account/buy", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: pack }) });
        if (r.status === 401) { location.href = "/credits/account?pack=" + encodeURIComponent(pack); return; }
        var j = await r.json();
        if (!r.ok || !j.url) throw new Error(j.error || "Could not start checkout");
        location.href = j.url;
      } catch (e) {
        if (errEl) errEl.textContent = e.message || "Something went wrong.";
        btn.disabled = false; btn.textContent = old;
      }
    });
  });
})();
