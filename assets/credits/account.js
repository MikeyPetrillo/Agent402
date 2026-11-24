// /credits/account behavior: the sign-in form, and once signed in a new
// purchase and the balances with their history, top-up, spending limits, CSV,
// refund, new-key and revoke actions. Every
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
  // A balance's name: the day it was bought (UTC), as src/credits-account-page.js
  // balanceName draws it; two from one day keep the key id's last four apart.
  var allBalances = [];
  function dayOf(x) { var d = new Date((x && x.createdAt) || ""); return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); }
  function balanceName(b) {
    var mine = dayOf(b), id = String((b && b.keyId) || "");
    if (!mine) return "Balance " + id.slice(-4);
    var twin = allBalances.some(function (o) { return o && o.keyId !== b.keyId && dayOf(o) === mine; });
    return "Balance bought " + mine + (twin ? " (" + id.slice(-4) + ")" : "");
  }
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
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { input.setAttribute("aria-invalid", "true"); err.textContent = "Enter your email address."; input.focus(); return; }
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
    if (b.disabled) return [b.revoked ? "Key revoked" : "Switched off", "off"];
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
      var NAMES = { charge: "Charge", purchase: "Purchase", topup: "Top-up", refund: "Refund", hold: "Held for a call", key: "New key issued", revoked: "Key revoked" };
      wrap.appendChild(h("div", { class: "acct-section" }, [
        h("h3", { text: "Activity" }),
        rows.length ? h("div", { class: "tablewrap" }, [h("table", null, [
          h("thead", null, [h("tr", null, [h("th", { text: "Date" }), h("th", { text: "What" }), h("th", { text: "Tool" }), h("th", { text: "Amount" })])]),
          h("tbody", null, rows.slice(0, 100).map(function (r) {
            var sign = r.type === "charge" || r.type === "refund" || r.type === "hold" ? "-" : r.type === "key" || r.type === "revoked" ? "" : "+";
            return h("tr", null, [h("td", { text: String(r.at).slice(0, 16).replace("T", " ") }), h("td", { text: NAMES[r.type] || r.type }), h("td", null, r.tool ? [h("code", { text: r.tool })] : []), h("td", { text: r.type === "key" || r.type === "revoked" ? "" : sign + usdFine(r.amountUsd) })]);
          })),
        ])]) : h("p", { text: "Nothing yet." }),
        hist.historyFrom ? h("p", { text: "The page keeps the latest entries; the totals by tool cover every call." }) : null,
      ]));
      bind(wrap);
    }).catch(function () {});
  }
  function refundSection(b, card) {
    return h("div", { class: "acct-section" }, [
        h("h3", { text: "Refund" }),
        h("p", { text: "The whole unspent balance (" + usdFine(b.balanceUsd) + ") goes back to the card that paid, with no fee, and the balance closes." }),
        h("div", { class: "acct-row" }, [h("button", { class: "btn btn-secondary", type: "button", disabled: b.balanceUsd > 0 ? null : true, onclick: function (e) {
          if (!window.confirm("Refund the unspent balance to your card and close this balance?")) return;
          var btn = e.currentTarget; btn.disabled = true;
          post("/refund", { key: b.keyId }).then(function (j) { msg(card, j.message || j.error || "", j._status >= 400); if (j._status < 400) setTimeout(load, 1200); else btn.disabled = false; })
            .catch(function () { btn.disabled = false; msg(card, "Could not take the refund request.", true); });
        } }, ["Refund the unspent balance"])]),
      ]);
  }
  function balanceCard(b, packs, lowNoticeUsd) {
    var st = stateOf(b);
    var open = !b.disabled && !b.refund;
    var card = h("div", { class: "acct-card", "data-key": b.keyId });
    card.appendChild(h("div", { class: "acct-head" }, [h("h2", { class: "acct-name", text: balanceName(b) }), h("span", { class: "acct-state " + st[1], text: st[0] })]));
    card.appendChild(h("div", { class: "acct-amt", text: usdFine(b.balanceUsd) }));
    card.appendChild(h("div", { class: "acct-meta" }, [
      h("span", { text: "Key id " + b.keyId }), h("span", { text: "Loaded " + usd(b.loadedUsd) }), h("span", { text: "Spent " + usdFine(b.spentUsd) }),
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
        h("p", { text: "Keys are stored only as a hash, so the key itself cannot be shown again. Lost it? Issue a new key within ten minutes of signing in: it is shown once, here, and the old key stops working at once. The balance and its history stay." }),
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
      card.appendChild(refundSection(b, card));
      var lim = b.limits || {};
      var daily = h("input", { type: "number", min: "0", step: "0.01", inputmode: "decimal", id: "daily-" + b.keyId, value: lim.dailyUsd != null ? String(lim.dailyUsd) : "", placeholder: "No limit" });
      var perCall = h("input", { type: "number", min: "0", step: "0.001", inputmode: "decimal", id: "call-" + b.keyId, value: lim.perCallUsd != null ? String(lim.perCallUsd) : "", placeholder: "No limit" });
      card.appendChild(h("div", { class: "acct-section" }, [
        h("h3", { text: "Spending limits" }),
        h("p", { text: "Set the most this key may spend in a day (UTC) and on one call. A credits call past either limit is refused and the key is not charged. Leave a field empty for no limit." }),
        h("div", { class: "acct-row" }, [
          h("label", { for: "daily-" + b.keyId }, ["Per day (USD)", daily]),
          h("label", { for: "call-" + b.keyId }, ["Per call (USD)", perCall]),
          h("button", { class: "btn btn-secondary", type: "button", onclick: function (e) {
            var btn = e.currentTarget; btn.disabled = true;
            post("/limits", { key: b.keyId, dailyUsd: daily.value === "" ? null : Number(daily.value), perCallUsd: perCall.value === "" ? null : Number(perCall.value) }).then(function (j) {
              btn.disabled = false; msg(card, j._status === 200 ? "Limits saved." : j.error || "Could not save the limits.", j._status !== 200);
            }).catch(function () { btn.disabled = false; msg(card, "Could not save the limits.", true); });
          } }, ["Save limits"]),
        ]),
      ]));
      card.appendChild(h("div", { class: "acct-section" }, [
        h("h3", { text: "Revoke the key" }),
        h("p", { text: "Stop the key working at once, for example if it leaked. Nothing is spent; the balance stays refundable to the card that paid, from this page." }),
        h("div", { class: "acct-row" }, [h("button", { class: "btn btn-secondary", type: "button", onclick: function (e) {
          if (!window.confirm("Revoke this key? It stops working at once.")) return;
          var btn = e.currentTarget; btn.disabled = true;
          post("/revoke", { key: b.keyId }).then(function (j) { msg(card, j.message || j.error || "", j._status >= 400); if (j._status < 400) setTimeout(load, 1200); else btn.disabled = false; })
            .catch(function () { btn.disabled = false; msg(card, "Could not revoke the key.", true); });
        } }, ["Revoke the key"])]),
      ]));
      var cb = h("input", { type: "checkbox", checked: b.lowNotice ? true : null, onchange: function () { post("/low-notice", { key: b.keyId, on: cb.checked }); } });
      card.appendChild(h("div", { class: "acct-section" }, [h("label", { class: "acct-check" }, [cb, typeof lowNoticeUsd === "number" ? "Low-balance and spending-limit emails (balance under " + usd(lowNoticeUsd) + ", or a call refused by the daily limit)" : "Low-balance and spending-limit emails"])]));
    }
    // A revoked or switched-off balance keeps its unspent balance refundable.
    if (!open && !b.refund && b.balanceUsd > 0) card.appendChild(refundSection(b, card));
    var hist = h("div");
    card.appendChild(hist);
    historyBlock(b.keyId, hist);
    return card;
  }
  // A new balance: each purchase issues its own key, shown once after paying.
  function buyBlock(packs) {
    var want = new URLSearchParams(location.search).get("pack");
    var card = h("div", { class: "acct-card" });
    var sel = h("select", { id: "buy-pack", disabled: packs.length ? null : true }, packs.length ? packs.map(function (p) { return h("option", { value: p.id, selected: p.id === want ? true : null, text: usd(p.usd) }); }) : [h("option", { text: "Not on sale" })]);
    card.appendChild(h("div", { class: "acct-section", style: "margin-top:0" }, [
      h("h2", { text: "Buy credits" }),
      h("p", { text: "A purchase issues a new key holding the pack, shown once after you pay and emailed to you. Your bank may ask you to confirm the payment." }),
      h("div", { class: "acct-row" }, [
        h("label", { for: "buy-pack" }, ["Pack", sel]),
        h("button", { class: "btn btn-primary", type: "button", disabled: packs.length ? null : true, onclick: function (e) {
          var btn = e.currentTarget; btn.disabled = true; msg(card, "Opening checkout...");
          post("/buy", { pack: sel.value }).then(function (j) {
            if (j.url) { location.href = j.url; return; }
            btn.disabled = false; msg(card, j.error || "Could not start checkout.", true);
          }).catch(function () { btn.disabled = false; msg(card, "Could not start checkout.", true); });
        } }, ["Buy with a card"]),
      ]),
    ]));
    card.appendChild(h("div", { class: "acct-msg", "aria-live": "polite" }));
    return card;
  }
  // ---- connected apps (the connector sign-in; absent while it is off) ---------
  function when(v) { return v ? String(v).slice(0, 16).replace("T", " ") + " UTC" : "never"; }
  function connectedApps(wrap) {
    fetch(API + "/connected.json", { credentials: "same-origin" }).then(function (r) { return r.status === 200 ? r.json() : null; }).then(function (c) {
      if (!c) return;
      wrap.textContent = "";
      var sec = h("div", { class: "acct-section" }, [
        h("h2", { text: "Connected apps" }),
        h("p", { text: "Apps you connected with your email code pay for tool calls from one balance, up to a daily cap (UTC day). Change a cap or disconnect an app here; a disconnected app stops paying at once. A call is refused once it would pass either the app's cap or the balance's own daily limit." }),
        c.connectorUrl ? h("p", null, ["To connect Claude, Cursor or another MCP app, give it this connector address: ", h("code", { text: c.connectorUrl }), ". It asks for your email code, then a balance and a daily cap."]) : null,
      ]);
      wrap.appendChild(sec);
      if (!c.apps || !c.apps.length) { sec.appendChild(h("p", { text: "No apps are connected." })); bind(wrap); return; }
      c.apps.forEach(function (a) {
        var card = h("div", { class: "acct-card", "data-app": a.id });
        card.appendChild(h("div", { class: "acct-head" }, [h("span", { class: "acct-id", text: a.app }), h("span", { class: "acct-state ok", text: "Connected" })]));
        card.appendChild(h("div", { class: "acct-meta" }, [
          h("span", { text: balanceName(allBalances.filter(function (x) { return x.keyId === a.keyId; })[0] || { keyId: a.keyId }) }), h("span", { text: "Spent today " + usdFine(a.spentTodayUsd) + " of " + usd(a.capUsd) }),
          h("span", { text: "Connected " + when(a.createdAt) }), h("span", { text: "Last used " + when(a.lastUsedAt) }),
          a.lastNetwork ? h("span", { text: "From " + a.lastNetwork }) : null,
        ]));
        var cap = h("input", { id: "cap-" + a.id, inputmode: "decimal", value: Number(a.capUsd).toFixed(2), "aria-label": "Daily cap in USD" });
        card.appendChild(h("div", { class: "acct-row" }, [
          h("label", { for: "cap-" + a.id }, ["Daily cap (USD, up to " + usd(c.capMaxUsd) + ")", cap]),
          h("button", { class: "btn btn-secondary", type: "button", onclick: function () {
            post("/connected/cap", { id: a.id, capUsd: cap.value }).then(function (j) { msg(card, j.ok ? "Cap saved: " + usd(j.capUsd) + " a day." : j.error || "Could not change the cap.", !j.ok); });
          } }, ["Save cap"]),
          h("button", { class: "btn btn-secondary", type: "button", onclick: function (e) {
            if (!window.confirm("Disconnect " + a.app + "? It stops paying from your credits at once.")) return;
            var btn = e.currentTarget; btn.disabled = true;
            post("/connected/revoke", { id: a.id }).then(function (j) { if (j.ok) connectedApps(wrap); else { btn.disabled = false; msg(card, j.error || "Could not disconnect.", true); } });
          } }, ["Disconnect"]),
        ]));
        card.appendChild(h("div", { class: "acct-msg", "aria-live": "polite" }));
        sec.appendChild(card);
      });
      bind(wrap);
    }).catch(function () {});
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
        note.textContent = c.status === "over_balance_cap" ? "The top-up did not fit under the cap and was refunded in full." : c.status === "topup_refused" ? "This balance could not take the top-up, so it was refunded in full." : c.status === "over_limit" ? "The daily purchase limit was reached, so the top-up was refunded in full." : c.status === "not_completed" ? (c.error || "This purchase can't be completed right now.") + " The top-up was refunded in full." : "The top-up has not been confirmed yet. Reload in a moment.";
      }).catch(function () {});
    }
    allBalances = s.balances || [];
    // Connected apps sit above the balances, so an app user sees first what
    // pays for their app (the section is absent while the connector is off).
    var apps = h("div");
    root.appendChild(apps);
    connectedApps(apps);
    root.appendChild(buyBlock(s.packs || []));
    var list = h("div", { class: "acct-bal" });
    root.appendChild(list);
    if (!s.balances.length) list.appendChild(h("p", { class: "lede", text: "No balance is on this email yet." }));
    s.balances.forEach(function (b) { list.appendChild(balanceCard(b, s.packs || [], s.lowNoticeUsd)); });
    root.appendChild(h("p", { class: "note", text: "Each balance holds at most " + usd(s.capUsd) + ". Credits never expire and carry no fees." }));
    bind(root);
  }
  function load() {
    fetch(API + "/session.json", { credentials: "same-origin" }).then(function (r) { return r.status === 200 ? r.json() : null; }).then(function (s) { if (s) render(s); else signInForm(); }).catch(function () { signInForm(); });
  }
  load();
})();
