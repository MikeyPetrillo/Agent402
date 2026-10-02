(function () {
  // Behaviour for the market terminal: windowing, keyboard navigation,
  // incremental search and column sort.
  //
  // Progressive enhancement, in the strict sense: the server renders every
  // row, the selection and every number, so with this file absent, blocked or
  // broken the page is still a complete, readable, navigable market - the rows
  // are real links and the numbers are already on screen. Nothing here fetches
  // anything or derives a figure the server did not already compute; it only
  // decides which of the existing rows are visible and in what order.
  //
  // CSP: this is a real file under script-src 'self'. There is no inline
  // script anywhere in this surface, and no HTML is ever built from a string.
  var root = document.querySelector('[data-t-terminal]');
  if (!root || !root.querySelector) return;

  var body = root.querySelector('[data-t-body]');
  var scroller = body;
  var search = root.querySelector('[data-t-search]');
  var count = root.querySelector('[data-t-count]');
  // The server's count can read "400 of 1,234" (a capped roster); keep it.
  var countAll = count ? count.textContent : '';
  var help = root.querySelector('[data-t-help]');
  var head = root.querySelector('.t-head');
  if (!body) return;

  var all = Array.prototype.slice.call(body.querySelectorAll('[data-t-row]'));
  if (!all.length) return;

  // Tell the stylesheet the script is live, so zebra striping switches from
  // DOM position (correct while the server order stands) to the .is-odd class
  // this file stamps (correct once it sorts or filters).
  var table = root.querySelector('[data-t-roster]');
  if (table) table.setAttribute('data-t-js', '');

  // Windowing pays for itself only on a long roster; under this many rows the
  // browser handles the whole list faster than we can manage a window, and the
  // simpler path has fewer ways to be wrong.
  var VIRTUALIZE_OVER = 150;
  var OVERSCAN = 12;

  var view = all.slice();          // current filter + sort order
  var cursor = 0;                  // index into `view`
  var spacerTop, spacerBottom;
  var rowH = 26;

  function measureRowHeight() {
    var h = all[0] && all[0].getBoundingClientRect ? all[0].getBoundingClientRect().height : 0;
    if (h > 4) rowH = h;
  }

  function ensureSpacers() {
    if (spacerTop) return;
    spacerTop = document.createElement('div');
    spacerBottom = document.createElement('div');
    spacerTop.setAttribute('aria-hidden', 'true');
    spacerBottom.setAttribute('aria-hidden', 'true');
    body.insertBefore(spacerTop, body.firstChild);
    body.appendChild(spacerBottom);
  }

  var virtual = all.length > VIRTUALIZE_OVER;

  function paint() {
    if (!virtual) {
      for (var i = 0; i < all.length; i++) all[i].style.display = 'none';
      for (var j = 0; j < view.length; j++) {
        view[j].style.display = '';
        view[j].classList.toggle('is-odd', j % 2 === 1);
      }
      return;
    }
    ensureSpacers();
    measureRowHeight();
    var top = scroller.scrollTop;
    var visible = Math.ceil(scroller.clientHeight / rowH) + OVERSCAN * 2;
    var first = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
    var last = Math.min(view.length, first + visible);
    for (var i = 0; i < all.length; i++) all[i].style.display = 'none';
    for (var j = first; j < last; j++) {
      view[j].style.display = '';
      view[j].classList.toggle('is-odd', j % 2 === 1);
    }
    spacerTop.style.height = (first * rowH) + 'px';
    spacerBottom.style.height = Math.max(0, (view.length - last) * rowH) + 'px';
  }

  // --- selection -----------------------------------------------------------
  function select(idx, opts) {
    if (!view.length) return;
    cursor = Math.max(0, Math.min(view.length - 1, idx));
    if (virtual) {
      // Bring the row into the window BEFORE trying to focus it: a windowed
      // row that is display:none cannot take focus, and a silent focus
      // failure is how keyboard navigation dies on long lists.
      var wantTop = cursor * rowH;
      if (wantTop < scroller.scrollTop) scroller.scrollTop = wantTop;
      else if (wantTop + rowH > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = wantTop + rowH - scroller.clientHeight;
      paint();
    }
    for (var i = 0; i < all.length; i++) { all[i].classList.remove('is-cursor'); all[i].tabIndex = -1; }
    var el = view[cursor];
    if (!el) return;
    el.classList.add('is-cursor');
    el.tabIndex = 0;
    if (!opts || opts.focus !== false) el.focus({ preventScroll: virtual });
    if (!virtual && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  // --- filter + sort -------------------------------------------------------
  var sortKey = null, sortDir = -1;

  function apply() {
    var q = (search && search.value ? search.value : '').trim().toLowerCase();
    view = all.filter(function (el) {
      return !q || (el.getAttribute('data-host') || '').toLowerCase().indexOf(q) !== -1;
    });
    if (sortKey) {
      view.sort(function (a, b) {
        var x = Number(a.getAttribute('data-' + sortKey)) || 0;
        var y = Number(b.getAttribute('data-' + sortKey)) || 0;
        return (x - y) * sortDir;
      });
    }
    // Re-order the DOM so tab order and the reading order a screen reader gets
    // match what is on screen. Existing nodes are moved, never re-created.
    for (var i = 0; i < view.length; i++) body.appendChild(view[i]);
    if (virtual && spacerBottom) body.appendChild(spacerBottom);
    if (count) count.textContent = view.length === all.length
      ? countAll
      : String(view.length) + '/' + String(all.length);
    cursor = Math.min(cursor, Math.max(0, view.length - 1));
    paint();
  }

  if (search) {
    search.addEventListener('input', function () { apply(); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { search.value = ''; apply(); search.blur(); }
      if (e.key === 'Enter') { e.preventDefault(); select(0); }
    });
  }

  if (head) {
    head.addEventListener('click', function (e) {
      var th = e.target.closest ? e.target.closest('[data-t-sort]') : null;
      if (!th) return;
      var key = th.getAttribute('data-t-sort');
      sortDir = sortKey === key ? -sortDir : -1;
      sortKey = key;
      var hs = head.querySelectorAll('[data-t-sort]');
      for (var i = 0; i < hs.length; i++) {
        hs[i].classList.toggle('is-sorted', hs[i] === th);
        hs[i].setAttribute('aria-sort', hs[i] === th ? (sortDir === -1 ? 'descending' : 'ascending') : 'none');
      }
      apply();
    });
  }

  if (virtual && scroller) {
    var ticking = false;
    scroller.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () { ticking = false; paint(); });
    }, { passive: true });
  }

  // --- keyboard ------------------------------------------------------------
  function typingInField(t) {
    if (!t) return false;
    var n = (t.tagName || '').toLowerCase();
    return n === 'input' || n === 'textarea' || n === 'select' || t.isContentEditable;
  }
  function toggleHelp(on) {
    if (!help) return;
    var show = on === undefined ? help.hasAttribute('hidden') : on;
    if (show) help.removeAttribute('hidden'); else help.setAttribute('hidden', '');
  }
  if (help) {
    help.addEventListener('click', function (e) {
      if (e.target === help || (e.target.closest && e.target.closest('[data-t-help-close]'))) toggleHelp(false);
    });
  }

  var SORT_BY_DIGIT = { '3': 'calls', '4': 'usd', '5': 'buyers', '6': 'tools' };

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && help && !help.hasAttribute('hidden')) { toggleHelp(false); return; }
    if (typingInField(e.target)) return;

    if (e.key === '/') { e.preventDefault(); if (search) { search.focus(); search.select(); } return; }
    if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); select(cursor + 1); return; }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); select(cursor - 1); return; }
    if (e.key === 'g') { e.preventDefault(); select(0); return; }
    if (e.key === 'G') { e.preventDefault(); select(view.length - 1); return; }
    if (e.key === 'Enter') {
      var el = view[cursor];
      if (el && el.classList.contains('is-cursor')) { e.preventDefault(); el.click(); }
      return;
    }
    if (e.key === 't') {
      var toggle = document.querySelector('.ml-theme-toggle');
      if (toggle) { e.preventDefault(); toggle.click(); }
      return;
    }
    if (SORT_BY_DIGIT[e.key] && head) {
      var th = head.querySelector('[data-t-sort="' + SORT_BY_DIGIT[e.key] + '"]');
      if (th) { e.preventDefault(); th.click(); }
    }
  });

  // Start on the server's own selection so the keyboard picks up where the
  // page already is, rather than resetting it to the top.
  var pre = body.querySelector('[data-t-row].is-sel');
  cursor = pre ? all.indexOf(pre) : 0;
  if (cursor < 0) cursor = 0;
  apply();
  select(cursor, { focus: false });
})();
