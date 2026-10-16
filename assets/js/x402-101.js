(function () {
  // x402 & MPP 101 (/101): presenter navigation + the live demo. Everything
  // rendered here comes from THIS server (same origin) or is authored text;
  // values are still inserted with textContent, never innerHTML.
  var wrap = document.getElementById("s101");
  if (!wrap) return;
  var slides = Array.prototype.slice.call(wrap.querySelectorAll(".s101-slide"));
  var progress = document.getElementById("s101-progress");
  var current = 0;

  function go(i) {
    if (i < 0 || i >= slides.length) return;
    current = i;
    slides[i].scrollIntoView({ behavior: "smooth", block: "start" });
    if (progress) progress.textContent = (i + 1) + " / " + slides.length;
  }
  var byId = function (id) { return document.getElementById(id); };
  var prevB = byId("s101-prev"), nextB = byId("s101-next"), notesB = byId("s101-notes-toggle"), printB = byId("s101-print");
  if (prevB) prevB.addEventListener("click", function () { go(current - 1); });
  if (nextB) nextB.addEventListener("click", function () { go(current + 1); });
  if (notesB) notesB.addEventListener("click", function () { document.body.classList.toggle("s101-show-notes"); });
  if (printB) printB.addEventListener("click", function () { document.body.classList.add("s101-show-notes"); window.print(); });
  document.addEventListener("keydown", function (e) {
    var t = e.target && e.target.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); go(current + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(current - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(slides.length - 1); }
    else if (e.key === "n" || e.key === "N") { document.body.classList.toggle("s101-show-notes"); }
    else if (e.key === "p" || e.key === "P") { document.body.classList.add("s101-show-notes"); window.print(); }
  });
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting && en.intersectionRatio > 0.5) {
          current = Number(en.target.getAttribute("data-index")) || 0;
          if (progress) progress.textContent = (current + 1) + " / " + slides.length;
        }
      });
    }, { threshold: [0.55] });
    slides.forEach(function (s) { io.observe(s); });
  }

  /* ---------------- live demo ---------------- */
  var askB = byId("s101-ask"), payB = byId("s101-pay");
  var askOut = byId("s101-ask-out"), payOut = byId("s101-pay-out"), receipts = byId("s101-receipts");
  var ROUTE = "/api/uuid";
  var SLUG = "uuid";

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function line(el, key, val, cls) {
    var d = document.createElement("div");
    if (key) { var k = document.createElement("span"); k.className = "k"; k.textContent = key + " "; d.appendChild(k); }
    var v = document.createElement("span"); if (cls) v.className = cls; v.textContent = val; d.appendChild(v);
    el.appendChild(d); return d;
  }
  function raw(el, label, text) {
    var det = document.createElement("details"); var sum = document.createElement("summary"); sum.textContent = label; det.appendChild(sum);
    var pre = document.createElement("pre"); pre.textContent = text; det.appendChild(pre); el.appendChild(det);
  }
  function b64json(s) {
    try { var t = s.replace(/-/g, "+").replace(/_/g, "/"); while (t.length % 4) t += "="; return JSON.parse(atob(t)); } catch (e) { return null; }
  }
  var CHAIN_NAMES = { "eip155:8453": "Base", "eip155:137": "Polygon", "eip155:42161": "Arbitrum", "eip155:42220": "Celo", "eip155:43114": "Avalanche", "eip155:1329": "Sei", "eip155:10": "Optimism", "eip155:143": "Monad", "eip155:4663": "Robinhood Chain", "eip155:4217": "Tempo" };
  function chainName(n) { if (CHAIN_NAMES[n]) return CHAIN_NAMES[n]; if (/^solana:/.test(n)) return "Solana"; if (/^stellar:/.test(n)) return "Stellar"; if (/^algorand:/.test(n)) return "Algorand"; return n; }
  function short(a) { a = String(a || ""); return a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-4) : a; }

  if (askB) askB.addEventListener("click", function () {
    askB.disabled = true; clear(askOut); line(askOut, "", "asking…", "k");
    fetch(ROUTE, { method: "GET", headers: { Accept: "application/json" } }).then(function (r) {
      clear(askOut);
      line(askOut, "server says:", "HTTP " + r.status + (r.status === 402 ? " Payment Required" : ""), r.status === 402 ? "ok" : "");
      var pr = r.headers.get("payment-required");
      var wa = r.headers.get("www-authenticate");
      var q = pr ? b64json(pr) : null;
      if (q && q.accepts && q.accepts.length) {
        var a = q.accepts[0];
        var amount = a.amount != null ? Number(a.amount) / 1e6 : null;
        var price = a.price || (amount != null ? "$" + amount.toFixed(3) : "?");
        var nets = q.accepts.map(function (x) { return chainName(x.network); }).filter(function (v, i, arr) { return arr.indexOf(v) === i; });
        line(askOut, "in plain words:", "“This costs " + price + ". Pay in USDC to " + short(a.payTo) + " on any of " + nets.length + " chains (" + nets.slice(0, 5).join(", ") + (nets.length > 5 ? ", …" : "") + "). This quote is good for " + (a.maxTimeoutSeconds ? Math.round(a.maxTimeoutSeconds / 60) + " minutes" : "a few minutes") + ".”");
        line(askOut, "dialect 1:", "x402 · the quote rides in the PAYMENT-REQUIRED header (" + q.accepts.length + " ways to pay)");
      } else {
        line(askOut, "dialect 1:", pr ? "x402 quote present (could not decode here)" : "no x402 quote on this response");
      }
      if (wa && /^Payment\b/i.test(wa)) {
        var methods = []; var re = /method="([^"]+)"/g; var m; while ((m = re.exec(wa))) if (methods.indexOf(m[1]) < 0) methods.push(m[1]);
        line(askOut, "dialect 2:", "MPP · the same offer as a WWW-Authenticate: Payment challenge (methods: " + methods.join(", ") + ")");
      }
      line(askOut, "", "No account was involved. The agent now knows exactly what to pay, and how.", "k");
      if (pr) raw(askOut, "show the raw x402 header (base64 JSON)", pr.slice(0, 900) + (pr.length > 900 ? "…" : ""));
      if (wa) raw(askOut, "show the raw MPP challenge header", wa.slice(0, 900) + (wa.length > 900 ? "…" : ""));
      if (payB) payB.disabled = false;
      askB.disabled = false;
    }).catch(function (e) { clear(askOut); line(askOut, "", "request failed: " + (e && e.message ? e.message : e)); askB.disabled = false; });
  });

  /* proof-of-work: same puzzle the playground solves */
  function sha256(str) { return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(function (b) { return new Uint8Array(b); }); }
  function lz(buf) { var n = 0; for (var i = 0; i < buf.length; i++) { var b = buf[i]; if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; }
  function solve(ch, diff) {
    var nonce = 0;
    function step() {
      return sha256(ch + ":" + nonce).then(function (h) {
        if (lz(h) >= diff) return nonce;
        nonce++;
        if (nonce % 4000 === 0) return new Promise(function (r) { setTimeout(r, 0); }).then(step);
        return step();
      });
    }
    return step();
  }
  if (payB) payB.addEventListener("click", function () {
    payB.disabled = true; clear(payOut); line(payOut, "", "asking the server for a puzzle…", "k");
    var t0 = performance.now(); var solveMs = 0;
    fetch("/api/pow/challenge?slug=" + encodeURIComponent(SLUG)).then(function (r) { if (!r.ok) throw new Error("challenge HTTP " + r.status); return r.json(); })
      .then(function (c) {
        clear(payOut);
        line(payOut, "the puzzle:", "find a number so that sha256(challenge:number) starts with " + c.difficulty + " zero bits · solving in this browser…");
        return solve(c.challenge, c.difficulty).then(function (nonce) {
          solveMs = Math.round(performance.now() - t0);
          line(payOut, "solved:", "nonce " + nonce + " in " + solveMs + " ms · that is the “coin” on the free tier");
          var t1 = performance.now();
          return fetch(ROUTE, { headers: { "X-Pow-Solution": c.token + ":" + nonce, Accept: "application/json" } }).then(function (r) {
            return r.text().then(function (body) {
              line(payOut, "server says:", "HTTP " + r.status + (r.status === 200 ? " OK · answered in " + Math.round(performance.now() - t1) + " ms" : ""), r.status === 200 ? "ok" : "");
              line(payOut, "the answer:", body.slice(0, 300));
              line(payOut, "", "Same request, now with payment attached. With a wallet the coin would be $0.001 in USDC and the answer would come back with an on-chain receipt.", "k");
              payB.disabled = false;
            });
          });
        });
      }).catch(function (e) { clear(payOut); line(payOut, "", "demo failed: " + (e && e.message ? e.message : e)); payB.disabled = false; });
  });

  /* newest real settlements per rail, from this server's own revenue API */
  function ago(iso) { var s = (Date.now() - Date.parse(iso)) / 1000; if (!(s >= 0)) return ""; if (s < 90) return Math.round(s) + "s ago"; if (s < 5400) return Math.round(s / 60) + " min ago"; if (s < 172800) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago"; }
  if (receipts) fetch("/api/revenue").then(function (r) { return r.json(); }).then(function (d) {
    clear(receipts);
    var rows = (d && d.rails ? d.rails : []).map(function (rl) {
      var rec = (rl.recent || []).filter(function (x) { return x && x.tx && x.external !== false; })[0];
      return rec ? { rail: rl.rail, asset: rl.asset || rec.asset || "USDC", usd: rec.usd, when: rec.when, tx: rec.tx } : null;
    }).filter(Boolean).sort(function (a, b) { return Date.parse(b.when) - Date.parse(a.when); }).slice(0, 5);
    if (!rows.length) { var none = line(receipts, "", "no recent settlements", "k"); none.style.cssText = "display:flex;flex-wrap:wrap;column-gap:.6em"; none.firstChild.style.whiteSpace = "nowrap"; var see = document.createElement("span"); see.className = "k"; see.style.whiteSpace = "nowrap"; see.textContent = "see /revenue"; none.appendChild(see); return; }
    rows.forEach(function (x) {
      var d1 = document.createElement("div");
      var k = document.createElement("span"); k.className = "k"; k.textContent = String(x.rail || "").toUpperCase() + " "; d1.appendChild(k);
      var t = document.createElement("span"); t.textContent = "$" + Number(x.usd || 0).toFixed(3) + " " + x.asset + " · " + ago(x.when) + " · "; d1.appendChild(t);
      var a = document.createElement("a"); a.textContent = "view the receipt on chain →"; a.rel = "noopener"; a.target = "_blank";
      if (/^https:\/\//.test(String(x.tx))) a.href = x.tx; else a.href = "/revenue";
      d1.appendChild(a); receipts.appendChild(d1);
    });
    line(receipts, "", "Every one of these is a real per-request payment from someone’s agent to this server. The full ledger is at /revenue.", "k");
  }).catch(function () { clear(receipts); line(receipts, "", "could not load live settlements · see /revenue", "k"); });
})();
