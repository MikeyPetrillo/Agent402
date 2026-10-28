// /credits/thanks behavior: claim the key ONCE for the paid session and show it
// with a copy button. A later visit shows "already claimed" (the key is never
// re-shown). External file (site CSP drops inline script).
(function () {
  var app = document.getElementById("app");
  var id = app && app.getAttribute("data-session");
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function render(s) {
    if (s.status === "minted") {
      app.innerHTML = '<div class="status" style="text-align:left">' +
        '<div class="eyebrow">Credits loaded · $' + esc(s.balanceUsd) + '</div>' +
        '<h2 style="margin-top:10px">Your key. Shown once.</h2>' +
        '<p>Copy it now and keep it secret; we also emailed it to you. Use it on any paid tool as <span style="font-family:var(--font-mono)">Authorization: Bearer &lt;key&gt;</span>.</p>' +
        '<pre id="key-box" style="background:var(--panel);color:var(--on-panel);padding:14px 16px;border-radius:var(--radius);font-family:var(--font-mono);font-size:var(--fs-sm);overflow:auto;margin:16px 0;user-select:all">' + esc(s.key) + '</pre>' +
        '<div class="report-actions"><button class="btn btn-primary" id="copy-key">Copy key</button><a class="btn btn-secondary" href="/tools">Browse tools</a><a class="btn btn-secondary" href="/credits">Buy more</a></div>' +
        '<p class="note">Balance: <span style="font-family:var(--font-mono)">curl -H "Authorization: Bearer &lt;key&gt;" ' + esc(location.origin) + '/api/credits/balance</span></p>' +
        '</div>';
      var b = document.getElementById("copy-key");
      if (b) b.addEventListener("click", function () { try { navigator.clipboard.writeText(s.key); b.textContent = "Copied ✓"; setTimeout(function () { b.textContent = "Copy key"; }, 1500); } catch (e) {} });
      return;
    }
    if (s.status === "claimed") {
      app.innerHTML = '<div class="status"><h2>Key already claimed</h2><p>The key for this purchase was shown once and emailed to you (key id <span style="font-family:var(--font-mono)">' + esc(s.keyId || "") + '</span>, balance $' + esc(s.balanceUsd) + '). For safety it cannot be shown again.</p><p style="margin-top:16px"><a class="btn btn-secondary" href="/credits">Buy another pack</a></p></div>';
      return;
    }
    if (s.status === "tax_id_required") { app.innerHTML = '<div class="status"><h2>A business tax ID is needed</h2><p>Credits billed to an address in the EU or the UK are sold to businesses with a VAT number. ' + (s.refunded ? 'This purchase was refunded in full to your card and no key was issued.' : 'This purchase was not issued a key and will be refunded to your card.') + ' Buy again and enter your VAT number at checkout, or pay per call with a wallet.</p><p style="margin-top:16px"><a class="btn btn-secondary" href="/credits">Back to credits</a></p></div>'; return; }
    if (s.status === "over_limit") { app.innerHTML = '<div class="status"><h2>Daily purchase limit reached</h2><p>Credits are limited to  app.innerHTML = '<div class="status"><h2>Payment not completed</h2><p><a href="/credits">Start over</a></p></div>'; return; }
    app.innerHTML = '<div class="status"><h2>Purchase not found</h2><p><a href="/credits">Back to credits</a></p></div>';
  }
  if (!id) { render({ status: "not_found" }); return; }
  fetch("/api/credits/claim?session=" + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () { render({ status: "not_found" }); });
})();
 + esc(s.limitUsd) + ' per buyer in any 24 hours. ' + (s.refunded ? 'This purchase was refunded in full to your card and no key was issued.' : 'This purchase was not issued a key and will be refunded to your card.') + '</p><p style="margin-top:16px"><a class="btn btn-secondary" href="/credits">Back to credits</a></p></div>'; return; }
    if (s.status === "unpaid") { app.innerHTML = '<div class="status"><h2>Payment not completed</h2><p><a href="/credits">Start over</a></p></div>'; return; }
    app.innerHTML = '<div class="status"><h2>Purchase not found</h2><p><a href="/credits">Back to credits</a></p></div>';
  }
  if (!id) { render({ status: "not_found" }); return; }
  fetch("/api/credits/claim?session=" + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () { render({ status: "not_found" }); });
})();
