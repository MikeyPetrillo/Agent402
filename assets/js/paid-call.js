(function () {
  // "Watch a call get paid" (src/paid-call-figure.js). The server renders
  // every step lit; this fills the live figures and, where motion is allowed,
  // lights the steps in order one beat apart while the figure is on screen.
  var figs = [].slice.call(document.querySelectorAll('.pc[data-pc]'));
  if (!figs.length) return;

  // Live figures from /api/stats: the 24-hour median latency and the count of
  // settled payments from outside buyers. A missing reading changes nothing.
  function setMeter(fig, key, text) {
    var el = fig.querySelector('[data-pc-m="' + key + '"]');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }
  fetch('/api/stats', { headers: { accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j) return;
    var p50 = j.performance24h && Number(j.performance24h.p50LatencyMs);
    var ext = j.settledExternal && Number(j.settledExternal.count);
    figs.forEach(function (f) {
      if (p50 > 0) setMeter(f, 'latency', 'p50 ' + Math.round(p50).toLocaleString('en-US') + ' ms');
      if (ext > 0) setMeter(f, 'settled', Math.round(ext).toLocaleString('en-US') + ' settled');
    });
  }).catch(function () {});

  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var beat = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-beat')) || 1000;
  figs.forEach(function (fig) {
    var steps = fig.querySelectorAll('.pc-step');
    var n = steps.length, at = 0, timer = null, visible = false;
    function paint() {
      for (var k = 0; k < n; k++) {
        steps[k].classList.toggle('is-on', k < at);
        steps[k].classList.toggle('is-now', k === at - 1);
      }
    }
    // 0 (nothing reached), then each step in turn, then two beats with all lit.
    function tick() { at = at >= n + 2 ? 0 : at + 1; paint(); }
    function update() {
      var still = !!(reduce && reduce.matches);
      if (still) {
        if (timer) { clearInterval(timer); timer = null; }
        fig.classList.remove('pc-run');
        return;
      }
      var go = visible && !document.hidden;
      if (go && !timer) {
        if (!fig.classList.contains('pc-run')) { at = 0; paint(); fig.classList.add('pc-run'); }
        timer = setInterval(tick, beat);
      } else if (!go && timer) { clearInterval(timer); timer = null; }
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[entries.length - 1].isIntersecting;
        update();
      }, { threshold: 0.35 }).observe(fig);
    }
    document.addEventListener('visibilitychange', update);
    if (reduce && reduce.addEventListener) reduce.addEventListener('change', update);
  });
})();
