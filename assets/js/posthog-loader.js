(function(){
  // Reads the {key, cfg} JSON island ledger-chrome.js's posthogSnippet()
  // emits right before this script tag (CSP hardening, 2026-08-16 - the
  // vendor loader below is static, but the API key + config it initializes
  // with are per-deployment values, so they ride as data instead of being
  // baked into this file's text). No island = analytics not configured for
  // this deployment (POSTHOG_API_KEY unset), so this is a silent no-op.
  var cfgEl = document.getElementById('posthog-config');
  if (!cfgEl) return;
  var data;
  try { data = JSON.parse(cfgEl.textContent); } catch (e) { return; }
  if (!data || !data.key) return;
  // Global Privacy Control: a browser that sends it gets no page counter.
  try { if (navigator.globalPrivacyControl === true) return; } catch (e) { /* no navigator */ }

  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  // Every URL property leaves the browser with its query string reduced to
  // campaign (utm_*) parameters, as the GA loader does, and without its
  // fragment: a query string elsewhere can carry a session id, a signed link
  // or a subject someone typed (a monitor link's ?target=). Bearer paths
  // (report links, signed alert and follow-up links) are also redacted.
  var URL_KEY = /(url|referrer|pathname)$/i;
  function clean(v) {
    if (typeof v !== "string" || !v) return v;
    var relative = v.charAt(0) === "/";
    if (!relative && !/^https?:\/\//i.test(v)) return v; // "$direct" and other non-URLs
    var u;
    try { u = new URL(v, location.origin); } catch (e) { return v; }
    var path = u.pathname.replace(/\/(r|m|reports\/public|alerts\/[a-z]+|followups\/[a-z]+)\/[^/]+.*$/, "/$1/[redacted]").replace(/\/(alerts|followups)\/[a-z]+$/, "/$1/[redacted]");
    var keep = new URLSearchParams();
    u.searchParams.forEach(function (val, k) { if (/^utm_[a-z_]+$/.test(k)) keep.append(k, val); });
    var qs = keep.toString();
    return (relative ? "" : u.origin) + path + (qs ? "?" + qs : "");
  }
  function scrub(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 3) return;
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (typeof v === "string") { if (URL_KEY.test(k)) obj[k] = clean(v); }
      else if (v && typeof v === "object") {
        // Compressed person info ({u: url, r: referrer}).
        if (k === "$initial_person_info") ["u", "r"].forEach(function (s) { if (typeof v[s] === "string") v[s] = clean(v[s]); });
        scrub(v, depth + 1);
      }
    });
  }
  data.cfg.before_send = function (event) {
    if (event) { scrub(event.properties, 0); scrub(event.$set, 0); scrub(event.$set_once, 0); }
    return event;
  };
  // No session replay on a page whose URL is a bearer link or a checkout
  // return (same paths GA skips, src/ledger-chrome.js GA_BEARER_PATH; kept
  // identical by scripts/test-ga-snippet.js). The project's URL blocklist is a
  // second layer; this one ships with the code and cannot drift from it.
  if (/^\/(r|m|reports\/public|alerts|followups|credits\/thanks|monitors\/manage|monitors\/thanks|digest|__operator)(\/|$)/.test(location.pathname)) data.cfg.disable_session_recording = true;
  posthog.init(data.key, data.cfg);
})();
