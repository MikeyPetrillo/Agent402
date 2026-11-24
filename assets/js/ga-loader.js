(function () {
  // Google Analytics 4, loaded only when ledger-chrome.js renders the
  // {id} JSON island (GA_MEASUREMENT_ID set) and never on a page whose URL is
  // a bearer link (the shell leaves the island off those).
  //
  // Consent: assets/js/analytics-consent.js decides (window.a402Consent).
  // Google's tag is not even requested until consent is granted: a visitor in
  // the EU, the EEA, the UK or Switzerland is asked first and nothing reaches
  // Google before "Allow"; a browser that sends Global Privacy Control never
  // loads it. Everyone else starts granted and can withdraw from the footer's
  // "analytics choices" button, which removes the measurement cookies. Ad
  // storage, ad user data and ad personalization are always denied, and
  // Google signals are off. No consent module on the page: nothing loads.
  //
  // Internal traffic: opening any page with ?internal=1 marks this browser
  // (localStorage), and its events carry traffic_type=internal for GA's
  // Internal Traffic filter; ?internal=0 clears it. A browser driven by
  // automation (navigator.webdriver: a headless test or a browser tool's own
  // page load) is tagged the same way. The request still goes out, so a tool
  // that measures the page sees the same load; the filter keeps it out of the
  // visit counts.
  var el = document.getElementById("ga-config");
  if (!el) return;
  var cfg;
  try { cfg = JSON.parse(el.textContent); } catch (e) { return; }
  if (!cfg || !/^G-[A-Z0-9]{4,16}$/.test(cfg.id || "")) return;
  // Belt beside the server's rule (GA_BEARER_PATH in src/ledger-chrome.js, kept
  // identical by scripts/test-ga-snippet.js): a 404 or error page rendered at a
  // bearer path carries its own canonical, so the server may stamp the island
  // there; the browser's own path decides.
  if (/^\/(r|m|reports\/public|answers|alerts|followups|credits\/thanks|monitors\/manage|monitors\/thanks|digest|__operator)(\/|$)/.test(location.pathname)) return;

  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  var q = new URLSearchParams(location.search);
  if (q.get("internal") === "1") store.set("a402-internal", "1");
  if (q.get("internal") === "0") store.set("a402-internal", null);

  var consent = window.a402Consent;
  if (!consent || consent.gpc) return;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  var loaded = false;
  function load() {
    if (loaded) { gtag("consent", "update", { analytics_storage: "granted" }); return; }
    loaded = true;
    window.gtag = gtag;
    gtag("consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
    gtag("js", new Date());
    // The URL Google receives keeps only campaign (utm_*) parameters: a query
    // string elsewhere can carry a session id or a signed link.
    var keep = new URLSearchParams();
    q.forEach(function (v, k) { if (/^utm_[a-z_]+$/.test(k)) keep.append(k, v); });
    var qs = keep.toString();
    var config = { allow_google_signals: false, allow_ad_personalization_signals: false, page_location: location.origin + location.pathname + (qs ? "?" + qs : "") };
    var automated = false;
    try { automated = navigator.webdriver === true; } catch (e) { /* no navigator */ }
    if (automated || store.get("a402-internal") === "1") config.traffic_type = "internal";
    gtag("config", cfg.id, config);

    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(cfg.id);
    document.head.appendChild(s);
  }
  // Withdrawing denies storage and removes the measurement cookies already
  // set (_ga, _ga_<id>), on this host and on the parent domain GA writes them to.
  function withdraw() {
    if (!loaded) return;
    gtag("consent", "update", { analytics_storage: "denied" });
    var host = location.hostname.replace(/^www\./, "");
    document.cookie.split(";").forEach(function (c) {
      var name = c.split("=")[0].trim();
      if (!/^_ga(_|$)/.test(name)) return;
      ["", "; domain=" + host, "; domain=." + host].forEach(function (d) { document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/" + d; });
    });
  }
  consent.whenGranted(load);
  consent.onWithdrawn(withdraw);
})();
