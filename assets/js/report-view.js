// Report delivery page (/r/:sessionId) behavior. External file (CSP: no inline
// script). The session id comes from the #app element's data-session attribute.
// On completion it renders a branded, print-ready report plus a data appendix:
// Download PDF (window.print with a print stylesheet), one CSV per structured
// table (financials, insider trades), and the full bundle as JSON. Downloads are
// built client-side from the delivered record (this is our own origin, not a
// sandboxed artifact, so Blob downloads work).
(function () {
  var app = document.getElementById("app");
  var id = app && app.getAttribute("data-session");
  // Monitor reports (/m/:id) are served by a different API but render identically.
  var api = (app && app.getAttribute("data-api")) || "/api/r/";
  if (!id) { if (app) app.innerHTML = notFound(); return; }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function notFound() { return '<div class="status"><h2>Report not found</h2><p><a href="/reports">Start a new report</a></p></div>'; }

  // Per-line inline markdown. Input is ALREADY entity-escaped, so a quote can
  // never break out of an href; each class stops at an escaped quote or angle.
  // Links in a report body may only point at a cited source (host allowlist
  // built from s.sources): a fetched page that instructs the model to plant a
  // link gets plain text instead of an anchor (review 2026-08-28).
  var allowedHosts = null;
  function setAllowedHosts(sources) {
    allowedHosts = {};
    (sources || []).forEach(function (src) { try { allowedHosts[new URL(src.url).host] = true; } catch (e) { /* not a URL */ } });
  }
  function linkOk(url) {
    if (!allowedHosts) return true;
    try { return allowedHosts[new URL(url).host] === true; } catch (e) { return false; }
  }
  function inline(l) {
    l = l.replace(/\[(\d+)\]/g, '<span class="cite">[$1]</span>');
    // A run of citations ("[5][6][7]") is one mark: a word joiner keeps it from splitting across lines.
    // A run longer than five is wider than a phone's line: it is one unbroken mark on a wide screen
    // (.cite-run) and on a phone breaks between groups of three (.cite-gap; the last group takes the
    // remainder), never leaving one citation alone on a line.
    l = l.replace(/(?:<span class="cite">\[\d+\]<\/span>)+/g, function (run) {
      var c = run.match(/<span class="cite">\[\d+\]<\/span>/g);
      if (c.length <= 5) return c.join("\u2060");
      var groups = [];
      for (var i = 0; i < c.length; i += 3) groups.push(c.slice(i, i + 3));
      if (groups.length > 1 && groups[groups.length - 1].length < 3) groups[groups.length - 2] = groups[groups.length - 2].concat(groups.pop());
      return '<span class="cite-run">' + groups.map(function (g) { return g.join("\u2060"); }).join('<span class="cite-gap"></span>') + "</span>";
    });
    l = l.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // [label](https://…) before the bare-URL autolink, or the bare rule would
    // eat the URL out of the parentheses and leave the label stranded.
    l = l.replace(/\[([^\]<>]+)\]\((https?:\/\/[^\s)<>"']+)\)/g, function (m, label, url) { return linkOk(url) ? '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>' : label + ' (' + url + ')'; });
    l = l.replace(/(^|[\s(])(https?:\/\/[^\s)<>"']+)/g, function (m, pre, url) { return linkOk(url) ? pre + '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>' : pre + url; });
    return l;
  }

  // A markdown pipe table: a header row, a |---|---| separator, then body rows.
  // Everything here is already entity-escaped by the caller.
  function isTableSep(l) { return /^\s*\|?[\s:-]*-[\s|:-]*\|[\s|:-]*$/.test(l) && l.indexOf("|") >= 0; }
  function tableCells(l) {
    var t = l.trim().replace(/^\|/, "").replace(/\|$/, "");
    return t.split("|").map(function (c) { return c.trim(); });
  }

  function mdToHtml(md) {
    var lines = esc(md).split(/\r?\n/), out = [], inList = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      // Tables first: a header line followed by a separator line. Reports that
      // carry tabular evidence (filings, holders) render as real tables rather
      // than as literal pipe characters.
      if (l.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        if (inList) { out.push("</ul>"); inList = false; }
        var head = tableCells(l), rows = [];
        i += 2;
        for (; i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim() !== ""; i++) rows.push(tableCells(lines[i]));
        i--;
        out.push('<div class="tablewrap"><table><thead><tr>' + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr></thead><tbody>"
          + rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("")
          + "</tbody></table></div>");
        continue;
      }
      l = inline(l);
      // Text is already entity-escaped here, so a quote can never break out of
      // href; the class also stops at an escaped quote/angle so the link text
      // does not swallow trailing markup.

      // A heading ends an open list: a list holds only list items.
      if (inList && /^#{1,3} /.test(l)) { out.push("</ul>"); inList = false; }
      if (/^### /.test(l)) { out.push("<h3>" + l.slice(4) + "</h3>"); continue; }
      if (/^## /.test(l)) { out.push("<h2>" + l.slice(3) + "</h2>"); continue; }
      if (/^# /.test(l)) { out.push("<h1>" + l.slice(2) + "</h1>"); continue; }
      if (/^\s*[-*] /.test(l)) { if (!inList) { out.push("<ul>"); inList = true; } out.push("<li>" + l.replace(/^\s*[-*] /, "") + "</li>"); continue; }
      if (inList) { out.push("</ul>"); inList = false; }
      if (l.trim() === "") continue;
      out.push("<p>" + l + "</p>");
    }
    if (inList) out.push("</ul>");
    return out.join("\n");
  }

  function productLabel(kind) {
    // Every report KIND we sell needs a row here: a missing one silently prints
    // "Deep Research Report" on someone else's delivered report.
    return { dossier: "Company Due-Diligence Dossier", fund: "Fund Portfolio Report (13F)",
      domain: "Domain Security Audit", recall: "FDA Recall Report", insider: "Insider Flow Report (Form 4)",
      filing: "SEC Filing Report", token: "Solana Token Due-Diligence Brief", ipo: "IPO Pipeline Digest", ticker: "Ticker Pack",
      research: "Deep Research Report", linkedin: "LinkedIn Article" }[kind] || "Deep Research Report";
  }
  // The label of the product this report was sold as. A sample carries its own
  // label; a product that shares a kind with another (market-brief runs the
  // research kind) is named by its slug, so its page never reads as the other.
  function reportLabel(s) {
    if (s && s.label) return String(s.label);
    var bySlug = { "market-brief": "Market / Competitor Brief" };
    return (s && bySlug[s.slug]) || productLabel(s && s.kind);
  }
  // Lowercase a label for use mid-sentence, leaving acronyms (SEC, FDA) alone.
  function midSentence(label) {
    var t = String(label || "");
    return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
  }
  function reasonLabel(r) {
    return { welcome: "first report", scheduled: "scheduled re-run", change: "change detected", "tls-expiring": "certificate expiring", filing: "new 13F filing", recall: "new recall activity", "safety-change": "token safety changed", "filing-new": "new SEC filing", digest: "weekly digest", problem: "we could not complete this run" }[r] || r;
  }
  function fmtDate(iso) {
    try { var d = new Date(iso); if (isNaN(d)) return ""; return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }); }
    catch (e) { return ""; }
  }
  // Under the title: the model-written note (its sentence comes from the page,
  // REPORT_MODEL_NOTE in src/report-disclosure.js) for every kind a model
  // writes, then the report's own disclaimer when its kit set one.
  function modelNoteText(s) {
    var text = (app && app.getAttribute("data-model-note")) || "";
    var codeKinds = ((app && app.getAttribute("data-code-kinds")) || "").split(",");
    return text && codeKinds.indexOf(String((s && s.kind) || "")) < 0 ? text : "";
  }
  function modelNote(s) {
    var text = modelNoteText(s), out = "";
    if (text) out += '<p class="rpt-note" id="model-note">' + esc(text) + "</p>";
    if (s && typeof s.disclaimer === "string" && s.disclaimer.trim()) out += '<p class="rpt-note" id="report-disclaimer">' + esc(s.disclaimer.trim()) + "</p>";
    return out;
  }
  function slugify(s) { return String(s || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "report"; }

  function toCSV(columns, rows) {
    var esc2 = function (v) {
      v = v == null ? "" : String(v);
      // Formula injection: a cell starting with = + - @ (or tab/CR) would execute
      // when the CSV is opened in a spreadsheet; prefix it so it reads as text.
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var out = [columns.map(esc2).join(",")];
    for (var i = 0; i < rows.length; i++) out.push(rows[i].map(esc2).join(","));
    return out.join("\r\n");
  }
  function download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1200);
    } catch (e) { /* download best-effort */ }
  }

  // The retention loop: a buyer who paid once for a report on a target is the
  // natural subscriber for the monitor that watches it. The kind -> monitor
  // map (product key, label, price) is delivered as a data attribute by the
  // server from MONITOR_PRODUCTS - never hardcoded here, so a price change
  // cannot drift. A kind with no monitor (research, dossier) shows nothing, and
  // a report that IS a monitor delivery never offers what the reader already
  // has. Clicking POSTs to the same /api/subscribe the storefront uses.
  function monitorFor(kind) {
    try {
      var map = JSON.parse((app && app.getAttribute("data-monitors")) || "{}");
      var m = map && Object.prototype.hasOwnProperty.call(map, kind) ? map[kind] : null;
      return m && m.product && m.label && m.priceUsd ? m : null;
    } catch (e) { return null; }
  }
  function upgradeBlock(s) {
    if (s.monitor) return "";
    var m = monitorFor(s.kind);
    var target = String(s.input == null ? "" : s.input).trim();
    if (!m || !target) return "";
    // A short subject (a ticker, a domain) reads inside the sentence; a whole
    // question does not, so it is named as "this question" instead.
    var subject = target.length <= 40 && !/\?\s*$/.test(target) && target.split(/\s+/).length <= 5 ? target : (s.kind === "research" ? "this question" : "this subject");
    return '<div class="upsell no-print" id="upsell" data-product="' + esc(m.product) + '" data-target="' + esc(target) + '">' +
      '<div class="k">Keep it current</div>' +
      "<h3>Watch " + esc(subject) + " and get a fresh brief the moment it changes</h3>" +
      "<p>" + esc(m.label) + ", " + esc(m.priceUsd) + " a month. We re-check it for you on a schedule and email you a new cited report when something moves. Cancel any time, no account needed.</p>" +
      '<div class="row">' +
        '<button class="btn btn-primary" id="up-go">Start monitoring, ' + esc(m.priceUsd) + " a month →</button>" +
        '<a class="btn btn-secondary" href="/monitors?product=' + encodeURIComponent(m.product) + "&amp;target=" + encodeURIComponent(target) + '">See what is included</a>' +
      "</div>" +
      '<div class="err" id="up-err"></div>' +
    "</div>";
  }
  function wireUpgrade() {
    var box = document.getElementById("upsell");
    var btn = document.getElementById("up-go");
    if (!box || !btn) return;
    var errEl = document.getElementById("up-err");
    btn.addEventListener("click", async function () {
      if (errEl) errEl.textContent = "";
      var label = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>Redirecting to checkout…';
      try {
        var r = await fetch("/api/subscribe", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ product: box.getAttribute("data-product"), target: box.getAttribute("data-target") }),
        });
        var j = await r.json();
        if (j && j.url) { window.location = j.url; return; }
        if (errEl) errEl.textContent = (j && j.error) || "Could not start checkout.";
      } catch (e) {
        if (errEl) errEl.textContent = "Network error, please try again.";
      }
      btn.disabled = false; btn.textContent = label;
    });
  }

  function inputNoun(kind) {
    return { dossier: "ticker", insider: "ticker", fund: "fund name or ticker", domain: "domain", research: "question", recall: "drug, food or device", filing: "ticker", token: "token mint", ticker: "ticker", linkedin: "topic" }[kind] || "subject";
  }
  function wireSampleBuy(s) {
    var form = document.getElementById("sample-buy");
    if (!form) return;
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var input = (document.getElementById("sample-input").value || "").trim();
      var err = document.getElementById("sample-err");
      if (!input) { err.textContent = "Enter your own " + inputNoun(s.kind) + " first."; return; }
      var btn = form.querySelector("button"); var label = btn.textContent; btn.disabled = true; btn.textContent = "Redirecting to checkout…";
      try { if (window.posthog && window.posthog.capture) window.posthog.capture("report_buy_click", { product: s.product, kind: "sample" }); } catch (e) { /* telemetry never blocks a buy */ }
      try {
        var r = await fetch("/api/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: s.product, input: input }) });
        var j = await r.json();
        if (j && j.url) { window.location = j.url; return; }
        err.textContent = (j && j.error) || "Could not start checkout.";
      } catch (e) { err.textContent = "Network error, please try again."; }
      btn.disabled = false; btn.textContent = label;
    });
  }
  // The letterhead above the body already prints the report's title, and every
  // report body opens with that same title as its own "# " heading, so each
  // page showed it twice. Drop the body's leading heading when it names the
  // same thing (compared on letters and digits only: the stored title is the
  // heading with its dashes and casing normalised). A different heading is
  // content and stays.
  function titleKey(t) { return String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }
  function withoutLeadingTitle(md, title) {
    var text = String(md || "");
    var m = /^\s*# +([^\n]*)\n?/.exec(text);
    if (!m || !titleKey(title) || titleKey(m[1]) !== titleKey(title)) return text;
    return text.slice(m[0].length);
  }
  function renderDone(s) {
    setAllowedHosts(Array.isArray(s.sources) && s.sources.length ? s.sources : null);
    var base = slugify(s.title);
    var tables = Array.isArray(s.tables) ? s.tables : [];
    var sources = Array.isArray(s.sources) ? s.sources : [];
    var images = Array.isArray(s.images) ? s.images : [];

    // Header / letterhead (prints too).
    var head =
      '<div class="rpt-head">' +
        '<div class="rpt-brand"><span class="n">agent402</span><span class="s">Report</span></div>' +
        '<h1 class="rpt-title">' + esc(s.title || "Report") + "</h1>" +
        '<div class="rpt-meta">' + String(reportLabel(s)).split(/:\s+/).map(function (x) { return "<span>" + esc(x) + "</span>"; }).join("") + (s.at ? "<span>" + esc(fmtDate(s.at)) + "</span>" : "") + "</div>" +
        modelNote(s) +
      "</div>";

    // Action bar (never printed).
    var dl = tables.map(function (t, i) {
      // Two whole parts ("Download Insider flow:" and "Reported holdings (CSV)"):
      // inline on a wide screen, stacked on a phone, never split mid-label.
      var lab = String(t.label || ""), cut = lab.indexOf(": ");
      var head = cut > 0 ? "Download " + lab.slice(0, cut + 1) : "Download", rest = (cut > 0 ? lab.slice(cut + 2) : lab) + " (CSV)";
      return '<button class="btn btn-secondary dl-csv" data-i="' + i + '"><span>' + esc(head) + "</span> <span>" + esc(rest) + "</span></button>";
    }).join("");
    var included = [];
    if (sources.length) included.push(sources.length + " cited sources");
    if (images.length) included.push(images.reduce(function (n, im) { return n + (im.files ? im.files.length : 0); }, 0) + " image files");
    tables.forEach(function (t) { included.push((t.rows ? t.rows.length : 0) + " " + esc(midSentence(t.label)) + " rows"); });
    var actions =
      '<div class="report-actions no-print">' +
        '<button class="btn btn-primary" id="dl-pdf">Download PDF</button>' +
        dl +
        '<button class="btn btn-secondary" id="dl-json">Download all data (JSON)</button>' +
        '<a class="btn btn-secondary" id="copy-link" href="#">Copy link</a>' +
        (s.sample !== true && s.publicView !== true && s.status === "done" ? '<button class="btn btn-secondary" id="mk-public">' + (s.public === true ? "Make private" : "Make public") + "</button>" : "") +
      "</div>" +
      (s.sample !== true && s.publicView !== true && s.public === true && s.publicId ? '<div class="keep-hint no-print" id="public-note">Public at <a href="/reports/public/' + esc(s.publicId) + '">' + esc(location.origin + "/reports/public/" + s.publicId) + "</a>. Anyone with that link can read it and search engines may index it; make it private again any time.</div>" : "") +
      (s.sample === true || s.publicView === true
        ? '<div class="keep-hint no-print">' + (s.publicView === true ? "A " + esc(midSentence(reportLabel(s))) + ' on "' + esc(s.input) + '" shared by its buyer' : "A real " + esc(midSentence(reportLabel(s))) + ' generated for "' + esc(s.input) + '"') + (s.at ? " on " + esc(fmtDate(s.at)) : "") + (included.length ? ". Includes " + included.join(" · ") : "") + ". Every report is generated fresh at request time from live sources.</div>" +
          (s.cutShort === true ? '<div class="keep-hint no-print" id="cut-short-note">This sample\'s text stops mid-sentence: the writing step reached its length limit when this sample was generated.</div>' : "") +
          '<form class="sample-buy no-print" id="sample-buy" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0 22px;">' +
            '<input id="sample-input" class="field" style="flex:1 1 240px;" placeholder="Your own ' + esc(inputNoun(s.kind)) + '" aria-label="Your own ' + esc(inputNoun(s.kind)) + '">' +
            '<button class="btn btn-primary" type="submit">Get this report, ' + "$" + esc(String(Math.round(s.priceUsd || 0))) + ' →</button>' +
            '<span id="sample-err" style="color:var(--muted);font-size:var(--fs-sm);"></span>' +
          "</form>"
        : included.length ? '<div class="keep-hint no-print">Includes ' + included.join(" · ") + ". This page is yours to keep, bookmark it or use the link we emailed you.</div>"
                          : '<div class="keep-hint no-print">This page is yours to keep, bookmark it or use the link we emailed you.</div>');

    // Monitor deliveries carry what triggered them + a manage/cancel link.
    var mon = "";
    if (s.monitor) {
      var ch = Array.isArray(s.monitor.changes) ? s.monitor.changes : [];
      mon = '<div class="keep-hint no-print">' + esc(s.monitor.label || "Monitor") + " · " + esc(s.monitor.target || "") +
        (s.monitor.reason ? " · " + esc(reasonLabel(s.monitor.reason)) : "") +
        (ch.length ? "<ul>" + ch.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>" : "") +
        ' Manage or cancel from the link in your email.</div>';
    }
    // Generated images (LinkedIn article): a preview of each slot and one
    // download per size, as real files at the stated pixel dimensions.
    var imgHtml = images.length ? '<div class="rpt-images"><h2>Images</h2>' + images.map(function (im, i) {
      var first = im.files && im.files[0];
      var prev = first ? '<img src="data:' + esc(first.media_type || "image/jpeg") + ';base64,' + first.b64 + '" alt="' + esc(im.alt || "") + '" style="max-width:100%;height:auto;border:1px solid var(--hairline);">' : "";
      var files = (im.files || []).map(function (f, j) {
        return '<button class="btn btn-secondary dl-img" data-i="' + i + '" data-j="' + j + '">' + esc(f.name) + " " + f.width + "x" + f.height + " (" + Math.round((f.bytes || 0) / 1024) + " KB)</button>";
      }).join(" ");
      return '<div class="rpt-image"><div class="rpt-meta">' + esc(im.slot || "image") + (im.alt ? " · " + esc(im.alt) : "") + "</div>" + prev + '<div class="report-actions no-print">' + files + "</div></div>";
    }).join("") + "</div>" : "";
    app.innerHTML = actions + mon + '<div class="report" id="report-body">' + head + mdToHtml(withoutLeadingTitle(s.report, s.title)) + imgHtml + "</div>" + upgradeBlock(s);
    if (window.a402BindWidows) window.a402BindWidows(app);
    var imgBtns = app.querySelectorAll(".dl-img");
    for (var k = 0; k < imgBtns.length; k++) {
      imgBtns[k].addEventListener("click", function (e) {
        var im = images[Number(e.currentTarget.getAttribute("data-i"))];
        var f = im && im.files ? im.files[Number(e.currentTarget.getAttribute("data-j"))] : null;
        if (!f) return;
        var bin = atob(f.b64); var bytes = new Uint8Array(bin.length);
        for (var q = 0; q < bin.length; q++) bytes[q] = bin.charCodeAt(q);
        var blob = new Blob([bytes], { type: f.media_type || "image/jpeg" });
        var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = base + "-" + f.name + "-" + f.width + "x" + f.height + ".jpg"; document.body.appendChild(a); a.click(); a.remove();
      });
    }
    wireUpgrade();

    wireSampleBuy(s);
    var mp = document.getElementById("mk-public");
    if (mp) mp.addEventListener("click", async function () {
      mp.disabled = true;
      try {
        var r = await fetch(api + encodeURIComponent(id) + "/public", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public: s.public !== true }) });
        var j = await r.json();
        if (j && j.status === "done") { s.public = j.public; s.publicId = j.publicId || s.publicId; renderDone(s); return; }
      } catch (e) { /* fall through */ }
      mp.disabled = false;
    });
    var pdf = document.getElementById("dl-pdf");
    if (pdf) pdf.addEventListener("click", function () { window.print(); });

    var csvBtns = app.querySelectorAll(".dl-csv");
    for (var i = 0; i < csvBtns.length; i++) {
      csvBtns[i].addEventListener("click", function (e) {
        var t = tables[Number(e.currentTarget.getAttribute("data-i"))];
        if (t) download(base + "-" + slugify(t.name || t.label) + ".csv", toCSV(t.columns || [], t.rows || []), "text/csv;charset=utf-8");
      });
    }
    var json = document.getElementById("dl-json");
    if (json) json.addEventListener("click", function () {
      var bundle = { title: s.title, product: productLabel(s.kind), generatedAt: s.at };
      if (modelNoteText(s)) bundle.notice = modelNoteText(s);
      if (typeof s.disclaimer === "string" && s.disclaimer.trim()) bundle.disclaimer = s.disclaimer.trim();
      bundle.report = s.report; bundle.sources = sources; bundle.tables = tables; bundle.images = images;
      download(base + "-bundle.json", JSON.stringify(bundle, null, 2), "application/json");
    });
    var cl = document.getElementById("copy-link");
    if (cl) cl.addEventListener("click", function (e) {
      e.preventDefault();
      try { navigator.clipboard.writeText(location.href); cl.textContent = "Copied ✓"; setTimeout(function () { cl.textContent = "Copy link"; }, 1500); } catch (x) {}
    });
    return true;
  }

  function render(s) {
    if (s.status === "done") return renderDone(s);
    if (s.status === "error") { app.innerHTML = '<div class="status"><h2>Something went wrong</h2><p>' + esc(s.error || "We couldn't complete this report.") + '</p><p><a href="/reports">Try another report</a></p></div>'; return true; }
    if (s.status === "unpaid") { app.innerHTML = '<div class="status"><h2>Payment not completed</h2><p>This report hasn\'t been paid for yet. <a href="/reports">Start over</a></p></div>'; return true; }
    if (s.status === "not_found" || s.status === "invalid") { app.innerHTML = notFound(); return true; }
    return false; // generating -> keep polling
  }
  var startedAt = Date.now();
  function tickElapsed() {
    var el = document.getElementById("rv-elapsed");
    if (!el) return;
    var s = Math.round((Date.now() - startedAt) / 1000);
    el.textContent = s < 60 ? "Working for " + s + "s" : "Working for " + Math.floor(s / 60) + "m " + (s % 60) + "s";
  }
  async function poll() {
    try {
      var r = await fetch(api + encodeURIComponent(id));
      var s = await r.json();
      if (render(s)) return;
    } catch (e) { /* transient; keep polling */ }
    tickElapsed();
    setTimeout(poll, 3000);
  }
  poll();
})();
