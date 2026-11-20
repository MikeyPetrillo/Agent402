(function() {
  // --- first-party figures: the server renders them (uptime, external
  // payments, chains, median latency, each with its data-as-of), so they are
  // real with JS off; this poll refreshes the two /api/stats carries. A figure
  // the server left out stays out, and a missing reading changes nothing. ---
  var freePowEl = document.getElementById('hm-freepow');
  // A refreshed figure takes the measurement time its source states; with
  // none stated, its as-of is left as the server rendered it.
  function setFigure(key, text, at) {
    var fig = document.getElementById('hm-own-' + key);
    var v = fig && fig.querySelector ? fig.querySelector('.hm-own-v') : null;
    if (!v) return;
    v.textContent = text;
    if (typeof at === 'string' && at) { fig.setAttribute('data-as-of', at); fig.setAttribute('title', 'as of ' + at); }
  }
  function pollStats() {
    fetch('/api/stats', { headers: { accept: 'application/json' } }).then(function(r) { return r.ok ? r.json() : null; }).then(function(j) {
      if (!j || !j.toolCallsServed) return;
      var pow = Number(j.toolCallsServed.viaProofOfWork) || 0;
      if (freePowEl) freePowEl.textContent = pow.toLocaleString('en-US');
      // External payments only (buyers outside our wallets), the figure the server rendered.
      var ext = j.settledExternal && Number(j.settledExternal.count);
      if (ext > 0) setFigure('paid', Math.round(ext).toLocaleString('en-US'), j.settledExternal.asOf);
      var p50 = j.performance24h && Number(j.performance24h.p50LatencyMs);
      if (p50 > 0) setFigure('latency', Math.round(p50).toLocaleString('en-US') + ' ms');
    }).catch(function() {});
  }
  setInterval(pollStats, 30000);

  // --- the live panel's four figures: every x402 and MPP payment the live
  // view reads from the chain in the last hour (its public stats endpoint;
  // the scene itself is the framed /embed page). The row is served hidden and
  // shown on the first good reading, so an unreadable view shows no placeholder.
  // Each live figure eases from what it shows to the new reading; with
  // reduced motion it is simply set.
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var liveShown = {};
  function tween(id, to, fmt) {
    var el = document.getElementById(id); if (!el) return;
    var from = liveShown[id] == null ? 0 : liveShown[id];
    liveShown[id] = to;
    if (reduceMotion || from === to) { el.textContent = fmt(to); return; }
    var t0 = performance.now(), dur = from ? 700 : 1100;
    (function step(t) {
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }
  // A read the live view does not answer is given up after 8 s, so a slow
  // answer there never leaves this page with a request open until the
  // browser's own limit; the figures stay as they were.
  function pollLive() {
    var ac = typeof AbortController === 'function' ? new AbortController() : null;
    var giveUp = ac ? setTimeout(function() { ac.abort(); }, 8000) : null;
    fetch('https://live.agent402.tools/api/stats', ac ? { signal: ac.signal } : undefined).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
      clearTimeout(giveUp);
      var a = d && d.all, h = a && a.h1; if (!h) return;
      var u = Number(h.usd || 0);
      var row = document.getElementById('hm-live-stats');
      if (row) row.hidden = false;
      tween('hm-live-n', Number(h.payments || 0), function(v) { return Math.round(v).toLocaleString('en-US'); });
      tween('hm-live-usd', u, function(v) { return '$' + (u >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)); });
      tween('hm-live-buyers', Number(h.buyers || 0), function(v) { return Math.round(v).toLocaleString('en-US'); });
      tween('hm-live-pm', Number(a.perMinute || 0), function(v) { return v.toFixed(1); });
    }).catch(function() { clearTimeout(giveUp); });
  }
  if (document.getElementById('hm-live-n')) { pollLive(); setInterval(pollLive, 30000); }

  // The proof-of-work demo and the inline seller registration left the home
  // page in the 2026-11 trim: the free tools run in /playground and listing
  // an API is on /sell (its own form posts the same /api/index/register).

  // --- reveal-on-scroll: the shared script in ledger-chrome.js now applies
  // this to every header/section site-wide on its own; no per-page opt-in
  // needed here anymore. ---
})();
