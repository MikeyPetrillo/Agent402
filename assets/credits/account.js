// /credits/account behavior: the sign-in form, and once signed in the
// balances with their history, top-up, CSV, refund and new-key actions. Every
// value from the server is set as text, never as markup. The key is never put
// in a URL: actions name the key id, and a new key arrives in a POST answer.
// External file (site CSP drops inline script).
(function () {
  var root = document.getElementById("app");
  if (!root || !root.hasAttribute("data-api")) return;
  var API = root.getAttribute("data-api") || "/credits/account";
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") el.textContent = attrs[k];
      else if (k === "class") el.className = attrs[k];
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) el.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return el;
  }
  // The site's widow and code-seam binding (site-chrome.js), run on text this script draws.
  function bind(el) { try { if (window.a402BindWidows) window.a402BindWidows(el || root); } catch (e) {} }
  function usd(n) { return "$" + Number(n || 0).toFixed(2); }
  function usdFine(n) { var v = Number(n || 0); return "$" + (v !== 0 && Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(2)); }
  function post(path, body) {
    return fetch(API + path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); });
  }

  // ---- signed out: the form from the page's template --------------------------
  function signInForm() {
    var tpl = document.getElementById("acct-signin");
    root.textContent = "";
    if (tpl) root.appendChild(tpl.content.cloneNode(true));
    bind(root);
    var form = document.getElementById("acct-signin-form");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = document.getElementById("in-email"), err = document.getElementById("err-email"), btn = form.querySelector("button");
      var email = (input.value || "").trim();
      err.className = "err";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { input.setAttribute("aria-invalid", "true"); err.textContent = "Enter the email address you bought credits with."; input.focus(); return; }
      input.removeAttribute("aria-invalid"); btn.disabled = true;
      post("/sign-in", { email: email }).then(function (j) {
        btn.disabled = false;
        if (j._status === 200) { err.className = "acct-msg"; err.textContent = j.message; return; }
        err.textContent = j.error || "Something went wrong. Please try again.";
      }).catch(function () { btn.disabled = false; err.textContent = "Something went wrong. Please try again."; });
    });
  }

  // ---- signed in --------------------------------------------------------------
  function stateOf(b) {
    if (b.refund) return b.refund.state === "refunded" ? ["Refunded " + usd(b.refund.amountUsd), "off"] : ["Refund of " + usd(b.refund.amountUsd) + " in progress", "warn"];
    if (b.disabled) return ["Switched off", "off"];
    return ["Active", "ok"];
  }
  function msg(card, text, bad) { var m = card.querySelector(".acct-msg"); m.textContent = text || ""; m.className = "acct-msg" + (bad ? " bad" : ""); }
  function historyBlock(keyId, wrap) {
    fetch(API + "/history.json?key=" + encodeURIComponent(keyId), { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (hist) {
      if (!hist) return;
      wrap.textContent = "";
      var byTool = hist.byTool || [];
      wrap.appendChild(h("div", { class: "acct-section" }, [
        h("h3", { text: "Spent by tool" }),
        byTool.length ? h("div", { class: "tablewrap" }, [h("table", null, [
          h("thead", null, [h("tr", null, [h("th", { text: "Tool" }), h("th", { text: "Calls" }), h("th", { text: "Spent" })])]),
          h("tbody", null, byTool.map(function (t) { return h("tr", null, [h("td", null, [h("code", { text: t.tool })]), h("td", { text: String(t.calls) }), h("td", { text: usdFine(t.spentUsd) })]); })),
        ])]) : h("p", { text: "No calls yet." }),
      ]));
      var rows = (hist.holds || []).concat(hist.rows || []);
      var NAMES = { charge: "Charge", purchase: "Purchase", topup: "Top-up", refund: "Refund", hold: "Held for a call", key: "New key issued" };
      wrap.appendChild(h("div", { class: "acct-section" }, [
        h("h3", { text: "Activity" }),
        rows.length ? h("div", { class: "tablewrap" }, [h("table", null, [
          h("thead", null, [h("tr", null, [h("th", { text: "Date" }), h("th", { text: "What" }), h("th", { text: "Tool" }), h("th", { text: "Amount" })])]),
          h("tbody", null, rows.slice(0, 100).map(function (r) {
            var sign = r.type === "charge" || r.type === "refund" || r.type === "hold" ? "-" : r.type === "key" ? "" : "+";
            return h("tr", null, [h("td", { text: String(r.at).slice(0, 16).replace("T", " ") }), h("td", { text: NAMES[r.type] || r.type }), h("td", null, r.tool ? [h("code", { text: r.tool })] : []), h("td", { text: r.type === "key" ? "" : sign + usdFine(r.amountUsd) })]);
          })),
        ])]) : h("p", { text: "Nothing yet." }),
        hist.historyFrom ? h("p", { text: "The page keeps the latest entries; the totals by tool cover every call." }) : null,
      ]));
      bind(wrap);
    }).catch(function () {});
  }
  function balanceCard(b, packs) {
    var st = stateOf(b);
    var open = !b.disabled && !b.refund;
    var card = h("div", { class: "acct-card", "data-key": b.keyId });
    card.appendChild(h("div", { class: "acct-head" }, [h("span", { class: "acct-id", text: "Key id " + b.keyId }), h("span", { class: "acct-state " + st[1], text: st[0] })]));
    card.appendChild(h("div", { class: "acct-amt", text: usdFine(b.balanceUsd) }));
    card.appendChild(h("div", { class: "acct-meta" }, [
      h("span", { text: "Loaded " + usd(b.loadedUsd) }), h("span", { text: "Spent " + usdFine(b.spentUsd) }),
      b.heldUsd > 0 ? h("span", { text: "Held " + usdFine(b.heldUsd) }) : null, h("span", { text: (b.calls || 0) + " calls" }),
    ]));
    var actions = h("div", { class: "acct-row" });
    if (open) {
      var fits = packs.filter(function (p) { return p.usd <= b.roomUsd + 1e-9; });
      var sel = h("select", { id: "pack-" + b.keyId, disabled: fits.length ? null : true }, fits.length ? fits.map(function (p) { return h("option", { value: p.id, text: "Add " + usd(p.usd) }); }) : [h("option", { text: "No room under the cap" })]);
      actions.appendChild(h("label", { for: "pack-" + b.keyId }, ["Top up (room for " + usd(b.roomUsd) + ")", sel]));
      actions.appendChild(h("button", { class: "btn btn-primary", type: "button", disabled: fits.length ? null : true, onclick: function (e) {
        var btn = e.currentTarget; btn.disabled = true; msg(card, "Opening checkout...");
        post("/top-up", { key: b.keyId, pack: sel.value }).then(function (j) {
          if (j.url) { location.href = j.url; return; }
          btn.disabled = false; msg(card, j.error || "Could not start checkout.", true);
        }).catch(function () { btn.disabled = false; msg(card, "Could not start checkout.", true); });
      } }, ["Add to balance"]));
    }
    actions.appendChild(h("a", { class: "btn btn-secondary", href: API + "/history.csv?key=" + encodeURIComponent(b.keyId), download: "agent402-credits-" + b.keyId + ".csv" }, ["Download CSV"]));
    card.appendChild(actions);
    card.appendChild(h("div", { class: "acct-msg", "aria-live": "polite" }));
    if (open) {
      var keyBox = h("div");
      card.appendChild(h("div", { class: "acct-section" }, [
        h("h3", { text: "Your key" }),
        h("p", { text: "Keys are stored only as a hash, so the key itself cannot be shown again. Lost it? Issue a new key: it is shown once, here, and the old key stops working at once. The balance and its history stay." }),
        h("div", { class: "acct-row" }, [h("button", { class: "btn btn-secondary", type: "button", onclick: function (e) {
          if (!window.confirm("Issue a new key? The current key stops working at once.")) return;
          var btn = e.currentTarget; btn.disabled = true;
          post("/new-key", { key: b.keyId }).then(function (j) {
            btn.disabled = false;
            if (j.key) { keyBox.textContent = ""; keyBox.appendChild(h("pre", { class: "acct-key", text: j.key })); keyBox.appendChild(h("p", { text: "Copy it now: it is not stored and will not be shown again." })); return; }
            msg(card, j.error || "Could not issue a new key.", true);
          }).catch(function () { btn.disabled = false; msg(card, "Could not issue a new key.", true); });
        } }, ["Issue a new key"])]),
        keyBox,
      ]));
      card.appendChild(h("div", { class: "acct-section" }, [
        h("h3", { text: "Refund" }),
        h("p", { text: "The whole unspent balance (" + usdFine(b.balanceUsd) + ") goes back to the card that paid, with no fee, and the balance closes." }),
        h("div", { class: "acct-row" }, [h("button", { class: "btn btn-secondary", type: "button", disabled: b.balanceUsd > 0 ? null : true, onclick: function (e) {
          if (!window.confirm("Refund the unspent balance to your card and close this balance?")) return;
          var btn = e.currentTarget; btn.disabled = true;
          post("/refund", { key: b.keyId }).then(function (j) { msg(card, j.message || j.error || "", j._status >= 400); if (j._status < 400) setTimeout(load, 1200); else btn.disabled = false; })
            .catch(function () { btn.disabled = false; msg(card, "Could not take the refund request.", true); });
        } }, ["Refund the unspent balance"])]),
      ]));
      var cb = h("input", { type: "checkbox", checked: b.lowNotice ? true : null, onchange: function () { post("/low-notice", { key: b.keyId, on: cb.checked }); } });
      card.appendChild(h("div", { class: "acct-section" }, [h("label", { class: "acct-check" }, [cb, "Low-balance email (under $2.00)"])]));
    }
    var hist = h("div");
    card.appendChild(hist);
    historyBlock(b.keyId, hist);
    return card;
  }
  function render(s) {
    root.textContent = "";
    var head = h("div", { class: "acct-head" }, [
      h("p", { class: "acct-msg", text: "Signed in as " + s.email }),
      h("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: function () { post("/sign-out").then(function () { location.reload(); }); } }, ["Sign out"]),
    ]);
    root.appendChild(head);
    var topup = new URLSearchParams(location.search).get("topup");
    if (topup) {
      var note = h("p", { class: "acct-msg", "aria-live": "polite", text: "Adding your top-up..." });
      root.appendChild(note);
      fetch("/api/credits/claim?session=" + encodeURIComponent(topup)).then(function (r) { return r.json(); }).then(function (c) {
        if (c.status === "topped_up") { note.textContent = usd(c.addedUsd) + " added. Balance now " + usdFine(c.balanceUsd) + "."; history.replaceState(null, "", location.pathname); load(); return; }
        note.className = "acct-msg bad";
        note.textContent = c.status === "over_balance_cap" ? "The top-up did not fit under the cap and was refunded in full." : c.status === "topup_refused" ? "This balance could not take the top-up, so it was refunded in full." : c.status === "over_limit" ? "The daily purchase limit was reached, so the top-up was refunded in full." : "The top-up has not been confirmed yet. Reload in a moment.";
      }).catch(function () {});
    }
    var list = h("div", { class: "acct-bal" });
    root.appendChild(list);
    if (!s.balances.length) list.appendChild(h("p", { class: "lede", text: "No balance is on this email." }));
    s.balances.forEach(function (b) { list.appendChild(balanceCard(b, s.packs || [])); });
    root.appendChild(h("p", { class: "note", text: "Each balance holds at most " + usd(s.capUsd) + ". Credits never expire and carry no fees." }));
    bind(root);
  }
  function load() {
    fetch(API + "/session.json", { credentials: "same-origin" }).then(function (r) { return r.status === 200 ? r.json() : null; }).then(function (s) { if (s) render(s); else signInForm(); }).catch(function () { signInForm(); });
  }
  load();
})();
