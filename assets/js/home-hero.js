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

  // --- real, live proof-of-work demo: fetch a real challenge, solve it in
  // this tab, submit it, exactly matching src/pow.js's own semantics
  // (hash the "challenge" field, submit the "token" field). ---
  var input = document.getElementById('hm-demo-in');
  var runBtn = document.getElementById('hm-demo-run');
  var statusEl = document.getElementById('hm-demo-status');
  var outEl = document.getElementById('hm-demo-out');
  var receiptEl = document.getElementById('hm-demo-receipt');
  var step1 = document.getElementById('hm-step1'), step1m = document.getElementById('hm-step1-mark');
  var step2 = document.getElementById('hm-step2'), step2m = document.getElementById('hm-step2-mark');
  var step3 = document.getElementById('hm-step3'), step3m = document.getElementById('hm-step3-mark');
  var busy = false;

  function lzOf(buf) {
    var bits = 0, arr = new Uint8Array(buf);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] === 0) { bits += 8; continue; }
      bits += Math.clz32(arr[i]) - 24;
      break;
    }
    return bits;
  }

  runBtn.addEventListener('click', function() {
    if (busy) return;
    var text = (input.value || 'hello').slice(0, 200);
    busy = true;
    runBtn.textContent = 'WORKING…';
    statusEl.textContent = 'challenge';
    outEl.textContent = 'requesting a signed challenge…';
    receiptEl.textContent = 'waiting on the live server';
    step1m.textContent = '·'; step2m.textContent = '·'; step3m.textContent = '·';

    fetch('/api/pow/challenge?slug=hash', { headers: { accept: 'application/json' } })
      .then(function(r) { if (!r.ok) throw new Error('challenge returned ' + r.status); return r.json(); })
      .then(function(c) {
        if (!c || !c.challenge || !c.token) throw new Error('challenge response missing challenge/token');
        statusEl.textContent = c.difficulty + '-bit puzzle';
        step1m.textContent = '✓';
        step1.textContent = c.difficulty + '-bit sha256 puzzle issued';
        outEl.textContent = 'solving…';

        var t0 = performance.now();
        var enc = new TextEncoder();
        var BATCH = 512, CAP = 4000000, base = 0, nonce = null;

        function solveBatch() {
          var jobs = [];
          for (var i = 0; i < BATCH; i++) jobs.push(crypto.subtle.digest('SHA-256', enc.encode(c.challenge + ':' + (base + i))));
          return Promise.all(jobs).then(function(digests) {
            for (var i = 0; i < BATCH; i++) {
              if (lzOf(digests[i]) >= c.difficulty) { nonce = base + i; return; }
            }
            base += BATCH;
            outEl.textContent = 'solving… ' + base.toLocaleString('en-US') + ' hashes tried';
            step2.textContent = base.toLocaleString('en-US') + ' hashes…';
            if (base > CAP) throw new Error('gave up after 4M hashes');
            return solveBatch();
          });
        }

        return solveBatch().then(function() {
          var ms = Math.round(performance.now() - t0);
          step2m.textContent = '✓';
          step2.textContent = 'nonce ' + nonce.toLocaleString('en-US') + ' found in ' + ms + 'ms';
          statusEl.textContent = 'X-Pow-Solution sent';
          outEl.textContent = 'solution accepted locally - calling the tool…';
          receiptEl.textContent = 'solved in ' + ms + 'ms';
          return fetch('/api/hash', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-Pow-Solution': c.token + ':' + nonce },
            body: JSON.stringify({ text: text, algo: 'sha256' }),
          }).then(function(rr) {
            return rr.text().then(function(body) {
              if (!rr.ok) throw new Error('tool returned ' + rr.status + ' - ' + body.slice(0, 160));
              var out = body;
              try { out = JSON.stringify(JSON.parse(body), null, 2); } catch (e) {}
              step3m.textContent = '✓';
              step3.textContent = 'served free - no payment, no key';
              statusEl.textContent = '200 OK';
              outEl.textContent = out;
              receiptEl.textContent = 'paid with ' + (nonce + 1).toLocaleString('en-US') + ' hashes · ' + ms + 'ms of your CPU · $0.00 · nonce ' + nonce.toLocaleString('en-US');
            });
          });
        });
      })
      .catch(function(e) {
        statusEl.textContent = 'error';
        outEl.textContent = "couldn't complete the live call: " + (e && e.message ? e.message : 'unknown error');
        receiptEl.textContent = 'try again, or see the curl example above';
      })
      .then(function() {
        busy = false;
        runBtn.textContent = 'RUN IT AGAIN';
      });
  });

  // --- inline seller registration (same POST /api/index/register the /sell
  // page's own form uses - listing an API shouldn't require a click-through
  // to a second page just to paste one URL). ---
  var regBtn = document.getElementById('hm-reg-go');
  var regIn = document.getElementById('hm-reg-origin');
  var regOut = document.getElementById('hm-reg-out');
  // The two hero-style "LIST YOUR API" buttons jump here via #sell instead of
  // navigating to /sell - focus the input so the jump visibly lands on
  // something typeable, not just a scroll position.
  document.querySelectorAll('a[href="#sell"]').forEach(function(a) {
    a.addEventListener('click', function() { setTimeout(function() { if (regIn) regIn.focus(); }, 400); });
  });
  if (regBtn) {
    function submitReg() {
      regOut.textContent = 'probing...';
      fetch('/api/index/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: regIn.value }) })
        .then(function(r) { return r.json(); })
        .then(function(j) {
          regOut.textContent = j.listed
            ? ('Listed - ' + (j.seller && j.seller.displayName ? j.seller.displayName : j.origin) + ' (' + (j.seller && j.seller.toolCount ? j.seller.toolCount : 0) + ' tools). Appears on /marketplace and any chain page it advertises.')
            : ('Not listed: ' + (j.error || 'unknown error'));
        })
        .catch(function() { regOut.textContent = 'submission failed - try again'; });
    }
    regBtn.addEventListener('click', submitReg);
    regIn.addEventListener('keydown', function(e) { if (e.key === 'Enter') submitReg(); });
  }

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
        octx.fillStyle = '#fff';
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
        ctx.fillStyle = '#8C8C88';
        ctx.globalAlpha = 0.44;
        for (var i = 0; i < dots.length; i++) { ctx.beginPath(); ctx.arc(dots[i][0], dots[i][1], 1.05, 0, 6.2832); ctx.fill(); }
        for (var j = 0; j < arcs.length; j++) {
          var arc = arcs[j], a = arc.a, b = arc.b;
          var span = Math.hypot(a[0] - b[0], a[1] - b[1]);
          var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 - span * 0.34;
          var accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#34A877').trim();
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
