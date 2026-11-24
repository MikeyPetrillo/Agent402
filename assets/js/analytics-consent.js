(function () {
  // The one analytics consent decision for both page counters (Google
  // Analytics, assets/js/ga-loader.js, and the first-party PostHog counter,
  // assets/js/posthog-loader.js). Rendered by src/ledger-chrome.js before
  // both loaders whenever either island is on the page; deferred scripts run
  // in document order, so the loaders find window.a402Consent ready.
  //
  // Who is asked first: a visitor in the EU, the EEA, the UK or Switzerland.
  // The browser's time zone decides first (a European zone, or none at all,
  // asks); any other zone asks the server, which reads the CDN's country
  // header for this request only (GET /api/consent-region, never cached).
  // A country it cannot name asks; a host with no CDN country answers
  // "unknown" and the time zone stands. Until the visitor chooses "Allow",
  // NEITHER counter loads: no Google tag, no PostHog library, nothing kept.
  // Everyone else starts granted and can say no at any time.
  // Global Privacy Control: denied, never asked, the choices button hidden.
  // The choice is kept in localStorage (a402-analytics-consent).
  var gaEl = document.getElementById("ga-config");
  var phEl = document.getElementById("posthog-config");
  if (!gaEl && !phEl) return;
  var KEY = "a402-analytics-consent";
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  var tz = "";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { /* unknown */ }
  // EU law follows the EU, not the Europe/ zone prefix: Cyprus is Asia/Nicosia
  // (and Asia/Famagusta), and the outermost regions sit in other zones.
  var EU_OTHER = ["Atlantic/Reykjavik", "Atlantic/Canary", "Atlantic/Madeira", "Atlantic/Azores", "Asia/Nicosia", "Asia/Famagusta", "America/Guadeloupe", "America/Martinique", "America/Cayenne", "America/Marigot", "Indian/Reunion", "Indian/Mayotte"];
  var tzAsks = !tz || /^Europe\//.test(tz) || EU_OTHER.indexOf(tz) !== -1;
  var gpc = false;
  try { gpc = navigator.globalPrivacyControl === true; } catch (e) { /* no navigator */ }

  var state = "pending"; // "granted" | "denied" | "pending"
  var grantedFns = [], deniedFns = [];
  function grant() { state = "granted"; var f = grantedFns.slice(); for (var i = 0; i < f.length; i++) { try { f[i](); } catch (e) { /* one counter never stops the other */ } } }
  function deny() { var was = state; state = "denied"; if (was !== "granted") return; var f = deniedFns.slice(); for (var i = 0; i < f.length; i++) { try { f[i](); } catch (e) { /* as above */ } } }
  window.a402Consent = {
    gpc: gpc,
    state: function () { return state; },
    // fn runs once consent is granted: now, or after Allow.
    whenGranted: function (fn) { if (state === "granted") { try { fn(); } catch (e) { /* as above */ } } grantedFns.push(fn); },
    // fn runs when a visitor who had granted says no.
    onWithdrawn: function (fn) { deniedFns.push(fn); },
  };
  // whenGranted keeps each fn for a later Allow; a loader guards itself so a
  // second call does nothing (each loads once).

  if (gpc) { state = "denied"; return; }

  var open = null;
  function names() {
    var n = [];
    if (gaEl) n.push("Google Analytics (a measurement cookie)");
    if (phEl) n.push("our own page counter (no cookie)");
    return n.join(" and ");
  }
  function strip() {
    if (open) return;
    var bar = document.createElement("div");
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Analytics choice");
    bar.setAttribute("aria-live", "polite");
    bar.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:50;max-width:620px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:12px 14px;border-radius:var(--radius);background:var(--card);color:var(--ink);border:1px solid var(--hairline);box-shadow:0 10px 30px rgba(0,0,0,.35);font:var(--fs-md)/1.45 Geist,system-ui,sans-serif";
    var text = document.createElement("span");
    text.style.cssText = "flex:1 1 260px";
    text.appendChild(document.createTextNode("May we count this visit? We use " + names() + " to count page views. "));
    var more = document.createElement("a");
    more.href = "/privacy";
    more.textContent = "Privacy";
    more.style.color = "inherit";
    text.appendChild(more);
    // Both answers look the same: one style, one size, one weight.
    function btn(label, value) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("data-consent", value);
      b.style.cssText = "font:500 var(--fs-sm) Geist,system-ui,sans-serif;border-radius:var(--radius);padding:7px 14px;cursor:pointer;border:1px solid var(--ink);background:transparent;color:inherit;";
      b.addEventListener("click", function () {
        store.set(KEY, value);
        bar.remove();
        open = null;
        if (value === "granted") grant(); else deny();
      });
      return b;
    }
    bar.appendChild(text);
    bar.appendChild(btn("No thanks", "denied"));
    bar.appendChild(btn("Allow", "granted"));
    document.body.appendChild(bar);
    open = bar;
  }
  function ask() { state = "pending"; if (document.body) strip(); else document.addEventListener("DOMContentLoaded", strip); }

  var choice = store.get(KEY);
  function decide() {
    if (choice === "granted") return grant();
    if (choice === "denied") { state = "denied"; return; }
    if (tzAsks) return ask();
    // Any other zone: the server reads the CDN's country for this request.
    var done = false;
    function answer(asks) { if (done) return; done = true; if (asks) ask(); else grant(); }
    try {
      var x = new XMLHttpRequest();
      x.open("GET", "/api/consent-region", true);
      x.timeout = 4000;
      x.onload = function () {
        var r = null;
        try { r = JSON.parse(x.responseText); } catch (e) { /* unreadable: ask */ }
        answer(!(x.status === 200 && r && r.asksFirst === false));
      };
      x.onerror = x.ontimeout = function () { answer(true); };
      x.send();
    } catch (e) { answer(true); }
  }
  decide();

  function ready() {
    var links = document.querySelectorAll("[data-analytics-choices]");
    for (var i = 0; i < links.length; i++) {
      links[i].hidden = false;
      links[i].addEventListener("click", function () {
        store.set(KEY, null);
        strip();
        var first = open && open.querySelector("button");
        if (first) first.focus();
      });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();
