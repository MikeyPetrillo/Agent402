// /credits/thanks behavior: claim the key ONCE for the paid session and show it
// with a copy button. A later visit shows "already claimed" (the key is never
// re-shown). External file (site CSP drops inline script).
(function () {
  var app = document.getElementById("app");
  var id = app && app.getAttribute("data-session");
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function render(s) {
    if (s.status === "minted") {
      app.innerHTML = '<div class="status" style="text-align:left">' +
        '<div class="eyebrow">Credits loaded · $' + esc(s.balanceUsd) + '</div>' +
        '<h2 style="margin-top:10px">Your key. Shown once.</h2>' +
        '<p>Copy it now and keep it secret; we also emailed it to you. Use it on any paid tool as <span style="font-family:var(--font-mono)">Authorization: Bearer &lt;key&gt;</span>.</p>' +
        '<pre id="key-box" style="background:var(--panel);color:var(--on-panel);padding:14px 16px;border-radius:12px;font-family:var(--font-mono);font-size:var(--fs-sm);overflow:auto;margin:16px 0;user-select:all">' + esc(s.key) + '</pre>' +
        '<div class="report-actions"><button class="btn btn-primary" id="copy-key">Copy key</button><a class="btn btn-ghost" href="/tools">Browse tools</a><a class="btn btn-ghost" href="/credits">Buy more</a></div>' +
        '<p class="note">Balance: <span style="font-family:var(--font-mono)">curl -H "Authorization: Bearer &lt;key&gt;" ' + esc(location.origin) + '/api/credits/balance</span></p>' +
        '</div>';
      var b = document.getElementById("copy-key");
      if (b) b.addEventListener("click", function () { try { navigator.clipboard.writeText(s.key); b.textContent = "Copied ✓"; setTimeout(function () { b.textContent = "Copy key"; }, 1500); } catch (e) {} });
      return;
    }
    if (s.status === "claimed") {
      app.innerHTML = '<div class="status"><h2>Key already claimed</h2><p>The key for this purchase was shown once and emailed to you (key id <span style="font-family:var(--font-mono)">' + esc(s.keyId || "") + '</span>, balance $' + esc(s.balanceUsd) + '). For safety it cannot be shown again.</p><p style="margin-top:16px"><a class="btn btn-ghost" href="/credits">Buy another pack</a></p></div>';
      return;
    }
    if (s.status === "unpaid") { app.innerHTML = '<div class="status"><h2>Payment not completed</h2><p><a href="/credits">Start over</a></p></div>'; return; }
    app.innerHTML = '<div class="status"><h2>Purchase not found</h2><p><a href="/credits">Back to credits</a></p></div>';
  }
  if (!id) { render({ status: "not_found" }); return; }
  fetch("/api/credits/claim?session=" + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () { render({ status: "not_found" }); });
})();
