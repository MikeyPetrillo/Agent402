// /monitors/thanks behavior: confirm the subscription server-side and show a
// manage/cancel link. External file (site CSP drops inline script).
(function () {
  var app = document.getElementById("app");
  var id = app && app.getAttribute("data-session");
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  function render(s) {
    if (s.status === "active") {
      app.innerHTML = '<div class="status"><h2>You’re subscribed ✓</h2><p>We’re now monitoring <b>' + esc(s.target || "") + '</b> (' + esc(s.label || "monitor") + '). Your first report arrives by email within about 10 minutes, then we email you again whenever something changes.</p>' +
        '<p style="margin-top:18px"><a class="btn btn-secondary" href="/monitors/manage?session=' + encodeURIComponent(id) + '">Manage or cancel</a></p>' +
        '</div>';
      return;
    }
    if (s.status === "canceled" || s.status === "incomplete_expired" || s.status === "unpaid" && s.label) {
      app.innerHTML = '<div class="status"><h2>This subscription is no longer active</h2><p><a href="/monitors">Start a new monitor</a></p></div>';
      return;
    }
    if (s.status === "unpaid" || s.status === "pending" || s.status === "incomplete" || s.status === "past_due" || s.status === "trialing") {
      app.innerHTML = '<div class="status"><h2>Almost there…</h2><p>Your subscription is being set up. Refresh this page in a moment.</p></div>';
      return;
    }
    app.innerHTML = '<div class="status"><h2>Subscription not found</h2><p><a href="/monitors">Back to monitors</a></p></div>';
  }
  if (!id) { render({ status: "not_found" }); return; }
  fetch("/api/monitors/confirm?session=" + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () { render({ status: "not_found" }); });
})();
