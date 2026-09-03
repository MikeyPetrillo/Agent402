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

  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  // Bearer URLs (report links, checkout thanks pages, signed alert links) must
  // never reach the analytics provider: redact them from every URL property.
  var BEARER = /(\/r\/|\/m\/|\/reports\/public\/|\/alerts\/|\/followups\/|[?&](session|k|id)=)/;
  function redact(v) {
    if (typeof v !== "string") return v;
    try { var u = new URL(v, location.origin); if (BEARER.test(u.pathname + u.search)) { return u.origin + u.pathname.replace(/\/(r|m|reports\/public|alerts\/[a-z]+|followups\/[a-z]+)\/[^/]+.*$/, "/$1/[redacted]").replace(/\/(alerts|followups)\/[a-z]+$/, "/$1/[redacted]"); } } catch (e) { /* not a URL */ }
    return v;
  }
  data.cfg.sanitize_properties = function (props) {
    if (!props) return props;
    ["$current_url", "$pathname", "$referrer", "$initial_current_url", "$initial_referrer", "$initial_pathname"].forEach(function (k) { if (k in props) props[k] = redact(props[k]); });
    if (props.$set) ["$initial_current_url", "$initial_referrer", "$initial_pathname"].forEach(function (k) { if (k in props.$set) props.$set[k] = redact(props.$set[k]); });
    if (props.$set_once) ["$initial_current_url", "$initial_referrer", "$initial_pathname"].forEach(function (k) { if (k in props.$set_once) props.$set_once[k] = redact(props.$set_once[k]); });
    return props;
  };
  posthog.init(data.key, data.cfg);
})();
