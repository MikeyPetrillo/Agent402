// Free alert signup forms (src/free-alerts.js alertFormHtml). External file:
// the site CSP has no 'unsafe-inline' for scripts. POSTs /api/alerts and shows
// the confirm-by-email message; never redirects.
(function () {
  function ph(ev, props) { try { if (window.posthog && window.posthog.capture) window.posthog.capture(ev, props); } catch (e) { /* telemetry never blocks a signup */ } }
  document.querySelectorAll("form.al-form").forEach(function (form) {
    var msg = form.querySelector(".al-msg");
    var btn = form.querySelector(".al-submit");
    var input = form.querySelector(".al-email");
    var hp = form.querySelector(".al-hp");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var email = (input.value || "").trim();
      if (!email) { msg.textContent = "Enter your email address."; return; }
      var label = btn.textContent;
      btn.disabled = true; btn.textContent = "Sending…"; msg.textContent = "";
      ph("alert_signup_click", { kind: form.dataset.kind, source: form.dataset.source || "" });
      try {
        var r = await fetch("/api/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email, kind: form.dataset.kind, target: form.dataset.target, source: form.dataset.source || "", website: hp ? hp.value : "" }) });
        var j = await r.json();
        if (j && j.ok) {
          msg.textContent = j.status === "active" ? "You are already subscribed to this alert." : "Check your inbox and click the confirmation link to start the alert.";
          input.value = "";
          btn.textContent = "Sent";
          return;
        }
        msg.textContent = (j && j.error) || "Could not sign you up. Please try again.";
      } catch (err) {
        msg.textContent = "Network error, please try again.";
      }
      btn.disabled = false; btn.textContent = label;
    });
  });
})();
