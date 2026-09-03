// Checkout page (/reports) behavior. External file because the site-wide CSP
// drops 'unsafe-inline' from script-src, so an inline <script> can't run.
(function () {
  // Returning from a canceled Stripe checkout: say so plainly rather than
  // dropping the buyer back on an unchanged page wondering what happened.
  try {
    if (new URLSearchParams(location.search).has("canceled")) {
      var n = document.getElementById("checkout-note");
      if (n) { n.hidden = false; }
    }
  } catch (e) { /* no-op */ }
  var sel = { research: "research", dossier: "dossier", fund: "fund-report", domain: "domain-audit", recall: "recall-report", insider: "insider-report", market: "market-brief", filing: "filing-report", token: "token-brief", ticker: "ticker-pack", linkedin: "linkedin-article" };
  var need = { dossier: "a ticker.", research: "a question.", fund: "a fund name, ticker, or CIK.", domain: "a domain, e.g. example.com", recall: "a drug, food, brand or device.", insider: "a US ticker.", market: "a market, category or company.", filing: "a US ticker.", token: "a Solana token mint address.", ticker: "a US ticker.", linkedin: "a topic." };
  function ph(ev, props) { try { if (window.posthog && window.posthog.capture) window.posthog.capture(ev, props); } catch (e) { /* telemetry never blocks a buy */ } }
  document.querySelectorAll(".pcard").forEach(function (card) {
    card.querySelectorAll(".tierbtn").forEach(function (b) {
      b.addEventListener("click", function () {
        card.querySelectorAll(".tierbtn").forEach(function (x) { x.classList.remove("sel"); });
        b.classList.add("sel");
        sel[card.dataset.kind] = b.dataset.p;
        // Keep the button's price in step with the chosen tier, so what the
        // buyer clicks is what Stripe will charge.
        var pr = b.querySelector(".pr");
        var btn = card.querySelector("[data-price-for]");
        var slot = btn && btn.querySelector(".bprice");
        if (pr && slot) slot.textContent = pr.textContent;
      });
    });
  });
  document.querySelectorAll("[data-buy]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var kind = btn.dataset.buy;
      var input = (document.getElementById("in-" + kind).value || "").trim();
      var errEl = document.getElementById("err-" + kind);
      errEl.textContent = "";
      if (!input) { errEl.textContent = "Please enter " + (need[kind] || "a value."); return; }
      btn.disabled = true;
      var label = btn.textContent;
      ph("report_buy_click", { product: sel[kind], kind: kind });
      btn.innerHTML = '<span class="spin"></span>Redirecting to checkout…';
      try {
        var r = await fetch("/api/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: sel[kind], input: input }) });
        var j = await r.json();
        if (j && j.url) { window.location = j.url; }
        else { errEl.textContent = (j && j.error) || "Could not start checkout."; btn.disabled = false; btn.textContent = label; }
      } catch (e) {
        errEl.textContent = "Network error, please try again.";
        btn.disabled = false; btn.textContent = label;
      }
    });
  });
})();
