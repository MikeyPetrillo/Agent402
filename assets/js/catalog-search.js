(function() {
  var search = document.getElementById('cat-search');
  var rows = document.querySelectorAll('.cat-row');
  var empty = document.getElementById('cat-empty');
  var emptyQ = document.getElementById('cat-empty-q');
  var resultsBox = document.getElementById('cat-results');
  var resultsShown = 0;

  function applyFilter() {
    var q = (search.value || '').toLowerCase().trim();
    var visible = 0;
    rows.forEach(function(row) {
      var label = row.querySelector('th a').textContent.toLowerCase();
      var blurb = row.querySelector('.cat-blurb').textContent.toLowerCase();
      var match = !q || label.indexOf(q) !== -1 || blurb.indexOf(q) !== -1;
      row.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    empty.style.display = (visible === 0 && resultsShown === 0) ? 'block' : 'none';
    if (visible === 0) emptyQ.textContent = search.value;
  }

  // Tool-level search: the same free GET /api/find the page tells agents to
  // call. Progressive enhancement - if the fetch fails or the container is
  // missing, the category filter above still works exactly as before.
  var timer = null;
  var controller = null;
  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (text != null) n.textContent = text;
    return n;
  }
  function renderResults(data, q) {
    if (!resultsBox) return;
    resultsBox.textContent = '';
    var tools = (data && data.results) || [];
    var packs = (data && data.packs) || [];
    resultsShown = tools.length + packs.length;
    if (resultsShown === 0) { resultsBox.style.display = 'none'; applyFilter(); return; }
    var head = el('div', 'font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);padding:10px 16px;border-bottom:1px solid var(--hairline);', 'tools matching "' + q + '" · GET /api/find');
    resultsBox.appendChild(head);
    tools.slice(0, 8).forEach(function(t) {
      var row = el('a', 'display:flex;align-items:baseline;gap:12px;padding:10px 16px;text-decoration:none;border-bottom:1px solid var(--hairline);color:var(--ink);');
      row.href = '/tools/' + encodeURIComponent(t.slug);
      row.appendChild(el('span', 'font-weight:700;font-size:14px;white-space:nowrap;', t.name || t.slug));
      row.appendChild(el('span', 'font-family:var(--font-mono);font-size:11.5px;color:var(--faint);white-space:nowrap;', t.route || ''));
      var desc = String(t.description || '');
      if (desc.length > 90) desc = desc.slice(0, 87) + '…';
      row.appendChild(el('span', 'font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;', desc));
      row.appendChild(el('span', 'font-family:var(--font-mono);font-size:12px;color:var(--accent);white-space:nowrap;margin-left:auto;', t.price || ''));
      resultsBox.appendChild(row);
    });
    packs.slice(0, 2).forEach(function(p) {
      var row = el('a', 'display:flex;align-items:baseline;gap:12px;padding:10px 16px;text-decoration:none;border-bottom:1px solid var(--hairline);color:var(--ink);');
      row.href = '/skills/' + encodeURIComponent(p.slug);
      row.appendChild(el('span', 'font-weight:700;font-size:14px;white-space:nowrap;', p.title || p.slug));
      row.appendChild(el('span', 'font-family:var(--font-mono);font-size:11.5px;color:var(--green);white-space:nowrap;', 'skill pack'));
      var tag = String(p.tagline || '');
      if (tag.length > 90) tag = tag.slice(0, 87) + '…';
      row.appendChild(el('span', 'font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;', tag));
      resultsBox.appendChild(row);
    });
    var last = resultsBox.lastChild;
    if (last) last.style.borderBottom = 'none';
    resultsBox.style.display = 'block';
    applyFilter();
  }
  function fetchTools() {
    var q = (search.value || '').trim();
    if (controller) controller.abort();
    if (!resultsBox || q.length < 2) {
      resultsShown = 0;
      if (resultsBox) { resultsBox.style.display = 'none'; resultsBox.textContent = ''; }
      applyFilter();
      return;
    }
    controller = ('AbortController' in window) ? new AbortController() : null;
    fetch('/api/find?q=' + encodeURIComponent(q), controller ? { signal: controller.signal } : {})
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) { if (data) renderResults(data, q); })
      .catch(function() { /* category filter keeps working */ });
  }

  search.addEventListener('input', function() {
    applyFilter();
    if (timer) clearTimeout(timer);
    timer = setTimeout(fetchTools, 250);
  });
  try {
    var params = new URLSearchParams(window.location.search);
    var q0 = params.get('q');
    if (q0) { search.value = q0; applyFilter(); fetchTools(); }
  } catch (e) {}
})();
