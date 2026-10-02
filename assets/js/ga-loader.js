(function () {
  // Google Analytics 4, loaded only when ledger-chrome.js renders the
  // {id} JSON island (GA_MEASUREMENT_ID set) and never on a page whose URL is
  // a bearer link (the shell leaves the island off those).
  //
  // Consent: visitors whose browser time zone is in Europe (the EU, the UK and
  // Switzerland all are) start with analytics storage DENIED and see a small,
  // non-blocking choice strip; until they accept, Google receives only
  // cookieless pings. Everyone else starts granted. Ad storage, ad user data
  // and ad personalization are always denied, and Google signals are off.
  //
  // Internal traffic: opening any page with ?internal=1 marks this browser
  // (localStorage), and its events carry traffic_type=internal for GA's
  // Internal Traffic filter; ?internal=0 clears it.
  var el = document.getElementById("ga-config");
  if (!el) return;
  var cfg;
  try { cfg = JSON.parse(el.textContent); } catch (e) { return; }
  if (!cfg || !/^G-[A-Z0-9]{4,16}$/.test(cfg.id || "")) return;
  // Belt beside the server's rule (GA_BEARER_PATH in src/ledger-chrome.js, kept
  // identical by scripts/test-ga-snippet.js): a 404 or error page rendered at a
  // bearer path carries its own canonical, so the server may stamp the island
  // there; the browser's own path decides.
  if (/^\/(r|m|reports\/public|alerts|followups|credits\/thanks|monitors\/manage|monitors\/thanks|digest)(\/|$)/.test(location.pathname)) return;

  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  var q = new URLSearchParams(location.search);
  if (q.get("internal") === "1") store.set("a402-internal", "1");
  if (q.get("internal") === "0") store.set("a402-internal", null);

  var tz = "";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { /* unknown */ }
  var europe = /^Europe\//.test(tz) || tz === "Atlantic/Reykjavik" || tz === "Atlantic/Canary" || tz === "Atlantic/Madeira" || tz === "Atlantic/Azores";
  var choice = store.get("a402-analytics-consent"); // "granted" | "denied" | null
  var granted = choice ? choice === "granted" : !europe;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("consent", "default", { analytics_storage: granted ? "granted" : "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  gtag("js", new Date());
  // The URL Google receives keeps only campaign (utm_*) parameters: a query
  // string elsewhere can carry a session id or a signed link.
  var keep = new URLSearchParams();
  q.forEach(function (v, k) { if (/^utm_[a-z_]+$/.test(k)) keep.append(k, v); });
  var qs = keep.toString();
  var config = { allow_google_signals: false, allow_ad_personalization_signals: false, page_location: location.origin + location.pathname + (qs ? "?" + qs : "") };
  if (store.get("a402-internal") === "1") config.traffic_type = "internal";
  gtag("config", cfg.id, config);

  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(cfg.id);
  document.head.appendChild(s);

  if (!europe || choice) return;
  // The choice strip: built node by node from text, closes on either answer.
  function strip() {
    var bar = document.createElement("div");
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Analytics choice");
    bar.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:50;max-width:620px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:12px 14px;border-radius:12px;background:var(--card,#141619);color:var(--ink,#E9EAEC);border:1px solid var(--hairline,#2C3136);box-shadow:0 10px 30px rgba(0,0,0,.35);font:14px/1.45 Geist,system-ui,sans-serif";
    var text = document.createElement("span");
    text.style.cssText = "flex:1 1 260px";
    text.appendChild(document.createTextNode("We use Google Analytics to count visits. Allow its measurement cookie? "));
    var more = document.createElement("a");
    more.href = "/privacy";
    more.textContent = "Privacy";
    more.style.color = "inherit";
    text.appendChild(more);
    function btn(label, primary, value) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = "font:500 13px Geist,system-ui,sans-serif;border-radius:999px;padding:7px 14px;cursor:pointer;border:1px solid var(--hairline,#2C3136);" + (primary ? "background:var(--ink,#E9EAEC);color:var(--paper,#0B0C0E);" : "background:transparent;color:inherit;");
      b.addEventListener("click", function () {
        store.set("a402-analytics-consent", value);
        if (value === "granted") gtag("consent", "update", { analytics_storage: "granted" });
        bar.remove();
      });
      return b;
    }
    bar.appendChild(text);
    bar.appendChild(btn("No thanks", false, "denied"));
    bar.appendChild(btn("Allow", true, "granted"));
    document.body.appendChild(bar);
  }
  if (document.body) strip(); else document.addEventListener("DOMContentLoaded", strip);
})();
