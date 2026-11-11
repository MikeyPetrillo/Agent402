(function() {
  // --- live counter + rails/leaderboard poll (seeds from server-rendered
  // values above so the number is real and SEO-visible even with JS off;
  // polling every 30s is a pure enhancement on top). ---
  var counterEl = document.getElementById('hm-counter');
  var counterEmptyEl = document.getElementById('hm-counter-empty');
  var freePowEl = document.getElementById('hm-freepow');
  var shownN = Number(counterEl ? counterEl.getAttribute('data-via-usdc') : 0) || 0;
  function animateTo(target, dur) {
    var from = shownN, t0 = performance.now();
    function step(t) {
      var p = Math.min(1, (t - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      var n = Math.round(from + (target - from) * eased);
      counterEl.textContent = n.toLocaleString('en-US');
      if (n > 0) { counterEl.style.display = ''; counterEmptyEl.style.display = 'none'; }
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function pollStats() {
    fetch('/api/stats', { headers: { accept: 'application/json' } }).then(function(r) { return r.ok ? r.json() : null; }).then(function(j) {
      if (!j || !j.toolCallsServed) return;
      // Prefer the chain-derived settled count (same source as /revenue);
      // the in-process tally is the fallback for servers that predate it.
      var paid = Number(j.settledOnChain) || Number(j.toolCallsServed.viaUSDC) || 0;
      var pow = Number(j.toolCallsServed.viaProofOfWork) || 0;
      if (freePowEl) freePowEl.textContent = pow.toLocaleString('en-US');
      if (paid && paid !== shownN) { animateTo(paid, shownN ? 1000 : 1500); shownN = paid; }
    }).catch(function() {});
  }
  setInterval(pollStats, 30000);

  // --- the live panel's four figures: every x402 and MPP payment the live
  // view reads from the chain in the last hour (its public stats endpoint;
  // the scene itself is the framed /embed page). Left as "-" if unreadable.
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

  // --- dot world map: real Natural Earth geometry (world-atlas 110m, public
  // domain), rasterised to a land mask, sampled into a dot grid, with
  // animated settlement arcs. Waits for the pinned d3/topojson tags above. ---
  (function() {
    var c = document.getElementById('hm-map');
    if (!c) return;
    function waitForLibs(timeoutMs) {
      return new Promise(function(resolve, reject) {
        var t0 = Date.now();
        (function tick() {
          if (window.d3 && window.topojson) return resolve();
          if (Date.now() - t0 > (timeoutMs || 8000)) return reject(new Error('d3/topojson did not load'));
          setTimeout(tick, 60);
        })();
      });
    }
    waitForLibs().then(function() {
      return fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json').then(function(r) { return r.json(); });
    }).then(function(topo) {
      var all = window.topojson.feature(topo, topo.objects.countries);
      var land = { type: 'FeatureCollection', features: all.features.filter(function(f) { return String(f.id) !== '010'; }) };
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var ctx = c.getContext('2d');
      var W = 0, H = 0, dots = [], arcs = [], raf = null;

      function build() {
        W = Math.max(300, c.parentElement.clientWidth);
        H = Math.round(W / 2.05);
        c.width = W * dpr; c.height = H * dpr;
        c.style.height = H + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var proj = window.d3.geoEquirectangular().fitExtent([[8, 8], [W - 8, H - 8]], land);
        var off = document.createElement('canvas');
        off.width = W; off.height = H;
        var octx = off.getContext('2d');
        octx.fillStyle = 'black'; // an alpha mask: only coverage is read back, never the color
        octx.beginPath();
        window.d3.geoPath(proj, octx)(land);
        octx.fill();
        var px = octx.getImageData(0, 0, W, H).data;
        dots = [];
        var step = W > 460 ? 4 : 5;
        for (var y = 0; y < H; y += step) for (var x = 0; x < W; x += step) if (px[(y * W + x) * 4 + 3] > 140) dots.push([x + 0.5, y + 0.5]);
        arcs = [];
        var minSpan = W * 0.24;
        for (var i = 0; i < 9 && dots.length > 40; i++) {
          var a = null, b = null;
          for (var tries = 0; tries < 60; tries++) {
            var p = dots[(Math.random() * dots.length) | 0];
            var q = dots[(Math.random() * dots.length) | 0];
            if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= minSpan) { a = p; b = q; break; }
          }
          if (a && b) arcs.push({ a: a, b: b, phase: Math.random() });
        }
      }

      function draw(t) {
        ctx.clearRect(0, 0, W, H);
        var rootStyle = getComputedStyle(document.documentElement);
        ctx.fillStyle = rootStyle.getPropertyValue('--faint').trim() || 'gray';
        ctx.globalAlpha = 0.44;
        for (var i = 0; i < dots.length; i++) { ctx.beginPath(); ctx.arc(dots[i][0], dots[i][1], 1.05, 0, 6.2832); ctx.fill(); }
        for (var j = 0; j < arcs.length; j++) {
          var arc = arcs[j], a = arc.a, b = arc.b;
          var span = Math.hypot(a[0] - b[0], a[1] - b[1]);
          var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 - span * 0.34;
          var accent = rootStyle.getPropertyValue('--accent').trim() || 'seagreen';
          ctx.globalAlpha = 0.2; ctx.strokeStyle = accent; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(mx, my, b[0], b[1]); ctx.stroke();
          ctx.fillStyle = accent; ctx.globalAlpha = 0.7;
          ctx.beginPath(); ctx.arc(a[0], a[1], 2, 0, 6.2832); ctx.fill();
          ctx.beginPath(); ctx.arc(b[0], b[1], 2, 0, 6.2832); ctx.fill();
          if (!reduce) {
            var tt = (t * 0.00014 + arc.phase) % 1, u = 1 - tt;
            var qx = u * u * a[0] + 2 * u * tt * mx + tt * tt * b[0];
            var qy = u * u * a[1] + 2 * u * tt * my + tt * tt * b[1];
            ctx.globalAlpha = 0.22; ctx.beginPath(); ctx.arc(qx, qy, 6.5, 0, 6.2832); ctx.fill();
            ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(qx, qy, 2.6, 0, 6.2832); ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
        if (!reduce) raf = requestAnimationFrame(draw);
      }

      build();
      window.addEventListener('resize', function() { build(); if (reduce) draw(0); });
      if (reduce) draw(0); else raf = requestAnimationFrame(draw);
    }).catch(function() { /* map is decorative - silently fall back to the panel without it */ });
  })();
})();
