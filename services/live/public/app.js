// Agent402 Live: canvas scene fed by one server-sent event stream.
// Seller names and logos are third-party text and images: every string is set
// with textContent (never innerHTML), and every image comes from this origin.
(() => {
  "use strict";
  const canvas = document.getElementById("scene");
  const ctx = canvas.getContext("2d");
  const tip = document.getElementById("tip");
  const modeEl = document.getElementById("mode");
  const $ = (id) => document.getElementById(id);

  let scope = "all", win = "h1";
  let W = 0, H = 0, DPR = 1;
  const payments = [];          // last hour, oldest first
  const walkers = [];
  let lastLive = 0, lastStats = null;
  let replay = null;            // { cursor, clock, startTs }
  const MAX_WALKERS = 450, REPLAY_SPEED = 10, QUIET_MS = 45_000;

  // ---- images and colors -------------------------------------------------
  const mascot = new Image(); mascot.src = "/mascot.svg";
  const logoCache = new Map();  // seller key -> { img, ok, color }
  function hashHue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
  function sellerStyle(seller) {
    let e = logoCache.get(seller.key);
    if (!e) {
      e = { img: null, ok: false, color: `hsl(${hashHue(seller.key)} 55% 58%)` };
      logoCache.set(seller.key, e);
      if (seller.logo) {
        const img = new Image();
        img.onload = () => { e.img = img; e.ok = true; const c = dominantColor(img); if (c) e.color = c; };
        img.src = seller.logo;
      }
    }
    return e;
  }
  // The seller's own color, read from its logo (same-origin, so readable).
  function dominantColor(img) {
    try {
      const c = document.createElement("canvas"); c.width = c.height = 16;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const [R, G, B, A] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        const max = Math.max(R, G, B), min = Math.min(R, G, B);
        if (A < 128 || max < 40 || min > 220 || max - min < 30) continue;
        r += R; gg += G; b += B; n++;
      }
      return n ? `rgb(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)})` : null;
    } catch { return null; }
  }

  // ---- layout: price gates on the right -------------------------------------
  function inScope(p) { return scope === "all" || p.chain === scope; }
  const GATES = [
    { max: 0.001, label: "≤ $0.001" },
    { max: 0.01, label: "≤ $0.01" },
    { max: 0.1, label: "≤ $0.10" },
    { max: 1, label: "≤ $1" },
    { max: Infinity, label: "over $1" },
  ];
  let gates = [];                // { i, label, x, y, w, h, doorX, doorY, n, usd, flash, flashColor }
  function layout() {
    const now = Date.now();
    const tally = GATES.map(() => ({ n: 0, usd: 0 }));
    for (const p of payments) {
      if (!inScope(p) || now - p.ts > 3600_000) continue;
      const t = tally[gateIndex(p.amountUsd)]; t.n++; t.usd += p.amountUsd;
    }
    const gw = W < 640 ? 92 : 150, x = W - gw - 12;
    const top = 16, gap = 10, h = (H - top * 2 - gap * (GATES.length - 1)) / GATES.length;
    const prev = gates;
    gates = GATES.map((g, i) => ({ i, label: g.label, x, y: top + i * (h + gap), w: gw, h, doorX: x, doorY: top + i * (h + gap) + h / 2, n: tally[i].n, usd: tally[i].usd, flash: prev[i]?.flash || 0, flashColor: prev[i]?.flashColor }));
  }
  function gateIndex(usd) { return GATES.findIndex((g) => usd <= g.max); }

  // ---- walkers: the paid seller's logo on legs ------------------------------
  function spawn(p, speed = 1) {
    if (!inScope(p)) return;
    const g = gates[gateIndex(p.amountUsd)];
    if (!g) return;
    if (walkers.length >= MAX_WALKERS) walkers.shift();
    const sy = 30 + Math.random() * (H - 60);
    const ty = g.y + 14 + Math.random() * Math.max(4, g.h - 28);
    const dur = (8000 + Math.random() * 4000) / speed;
    walkers.push({ p, gi: g.i, sx: -24, sy, tx: g.x - 6, ty, t0: performance.now(), dur, big: !!p.seller.agent402 });
  }

  // ---- drawing -----------------------------------------------------------
  function fitText(t, max) {
    if (ctx.measureText(t).width <= max) return t;
    while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
    return t + "…";
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  const fmtGateUsd = (n) => n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
  function drawGate(g) {
    ctx.save();
    const lit = g.flash > 0;
    ctx.fillStyle = "#141d27"; roundRect(g.x, g.y, g.w, g.h, 10); ctx.fill();
    ctx.lineWidth = lit ? 2.5 : 1; ctx.strokeStyle = lit ? (g.flashColor || "#9ef0b0") : "#2a3a4b"; ctx.stroke();
    // the opening walkers step into
    ctx.fillStyle = "#0c1117"; ctx.fillRect(g.x - 2, g.y + 10, 6, g.h - 20);
    ctx.fillStyle = lit ? (g.flashColor || "#9ef0b0") : "#2a3a4b"; ctx.fillRect(g.x - 3, g.y + 10, 3, g.h - 20);
    ctx.textAlign = "left";
    ctx.fillStyle = "#e8eef3"; ctx.font = `700 ${W < 640 ? 13 : 16}px system-ui, sans-serif`;
    ctx.fillText(g.label, g.x + 14, g.y + Math.min(28, g.h / 2));
    if (g.h > 46) {
      ctx.fillStyle = "#8a99a8"; ctx.font = `${W < 640 ? 10 : 12}px system-ui, sans-serif`;
      ctx.fillText(`${g.n.toLocaleString()} · ${fmtGateUsd(g.usd)}`, g.x + 14, g.y + Math.min(48, g.h / 2 + 18));
    }
    ctx.restore();
  }
  function walkerPos(w, now) {
    const k = Math.min(1, (now - w.t0) / w.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    return { k, x: w.sx + (w.tx - w.sx) * e, y: w.sy + (w.ty - w.sy) * e };
  }
  function drawWalker(w, now) {
    const { k, x, y } = walkerPos(w, now);
    const step = Math.sin((now - w.t0) / 90);
    ctx.save();
    ctx.globalAlpha = k > 0.93 ? (1 - k) / 0.07 : 1;
    if (w.big) {
      const s = 0.62;
      ctx.shadowColor = "rgba(158,240,176,.85)"; ctx.shadowBlur = 14;
      if (mascot.complete) ctx.drawImage(mascot, x - 32 * s, y - 80 * s + step * 1.5, 64 * s, 80 * s);
      ctx.restore(); w.hit = { x: x - 20, y: y - 50, w: 40, h: 50 }; return;
    }
    const st = sellerStyle(w.p.seller);
    const r = 15, cy = y - 24;
    // legs
    ctx.strokeStyle = "#8a99a8"; ctx.lineWidth = 2.2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x - 3, cy + r - 1); ctx.lineTo(x - 4 + step * 3, y); ctx.moveTo(x + 3, cy + r - 1); ctx.lineTo(x + 4 - step * 3, y); ctx.stroke();
    // the seller's logo as the head and body
    ctx.fillStyle = w.p.internal ? "#56606b" : st.color;
    ctx.beginPath(); ctx.arc(x, cy, r + 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(x, cy, r, 0, Math.PI * 2); ctx.fill();
    if (st.ok) {
      ctx.save(); ctx.beginPath(); ctx.arc(x, cy, r - 1, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(st.img, x - r + 1, cy - r + 1, 2 * r - 2, 2 * r - 2); ctx.restore();
    } else {
      ctx.fillStyle = st.color; ctx.font = "700 15px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(w.p.seller.name || "?").replace(/^0x/, "").slice(0, 1).toUpperCase(), x, cy + 0.5);
    }
    ctx.restore();
    w.hit = { x: x - r - 3, y: cy - r - 3, w: 2 * r + 6, h: y - cy + r + 6 };
  }
  function frame(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = "#0c1117"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#131c25"; ctx.lineWidth = 1;
    for (let y = 40; y < H; y += 46) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    for (const g of gates) { drawGate(g); if (g.flash > 0) g.flash -= 1; }
    for (let i = walkers.length - 1; i >= 0; i--) {
      const w = walkers[i];
      if (now - w.t0 >= w.dur) { const g = gates[w.gi]; if (g) { g.flash = 18; g.flashColor = w.big ? "#9ef0b0" : sellerStyle(w.p.seller).color; } walkers.splice(i, 1); }
    }
    for (const w of walkers) if (!w.big) drawWalker(w, now);
    for (const w of walkers) if (w.big) drawWalker(w, now);
    requestAnimationFrame(frame);
  }

  // ---- replay when the feed is quiet --------------------------------------
  function tickReplay() {
    const live = Date.now() - lastLive < QUIET_MS;
    if (live) { if (replay) replay = null; setMode(); return; }
    const pool = payments.filter(inScope);
    if (!pool.length) { setMode(); return; }
    if (!replay) replay = { i: 0, clock: pool[0].ts };
    replay.clock += 250 * REPLAY_SPEED;
    while (replay.i < pool.length && pool[replay.i].ts <= replay.clock) spawn(pool[replay.i++], 1.4);
    if (replay.i >= pool.length) replay = null;
    setMode();
  }
  setInterval(tickReplay, 250);
  function setMode() {
    const live = Date.now() - lastLive < QUIET_MS;
    modeEl.textContent = live ? "live" : replay ? `replay ×${REPLAY_SPEED}, last hour` : "waiting for payments";
    modeEl.className = live ? "live" : "";
  }

  // ---- stats ---------------------------------------------------------------
  const fmtUsd = (n) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
  function renderStats() {
    const s = lastStats?.[scope];
    if (!s) return;
    $("s-pm").textContent = String(s.perMinute);
    $("s-usd").textContent = fmtUsd(s[win].usd);
    $("s-buyers").textContent = String(s[win].buyers);
    const since = lastStats.coverage24hSince && win === "h24" && Date.now() - lastStats.coverage24hSince < 23.5 * 3600_000 ? ` (since ${new Date(lastStats.coverage24hSince).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : "";
    $("top-title").textContent = `Top sellers, last ${win === "h1" ? "hour" : "24 hours"}${since}`;
    const ol = $("top"); ol.textContent = "";
    for (const t of s[win].topSellers) { const li = document.createElement("li"); li.textContent = `${t.name}: ${t.payments} · ${fmtUsd(t.usd)}`; ol.appendChild(li); }
  }

  // ---- stream --------------------------------------------------------------
  function ingest(list, live) {
    for (const p of list) payments.push(p);
    const cut = Date.now() - 3600_000;
    while (payments.length && payments[0].ts < cut) payments.shift();
    if (live) {
      layout();
      for (const p of list) if (inScope(p)) { lastLive = Date.now(); if (replay) replay = null; spawn(p); }
      setMode();
    }
  }
  function connect() {
    const es = new EventSource("/events");
    es.addEventListener("hello", (e) => {
      const d = JSON.parse(e.data); payments.length = 0; ingest(d.payments, false);
      // The feed is live if its newest payment is recent, not only once the
      // next one arrives (which would open every visit in replay).
      const newest = payments.length ? payments[payments.length - 1].ts : 0;
      lastLive = newest ? Date.now() - Math.max(0, (d.now || Date.now()) - newest) : 0;
      lastStats = d.stats; layout(); renderStats(); setMode();
    });
    es.addEventListener("payments", (e) => ingest(JSON.parse(e.data), true));
    es.addEventListener("stats", (e) => { lastStats = JSON.parse(e.data); renderStats(); });
    es.onerror = () => { modeEl.textContent = "reconnecting"; };
  }

  // ---- controls, tooltip, resize -------------------------------------------
  document.querySelectorAll("[data-scope]").forEach((b) => b.addEventListener("click", () => {
    scope = b.dataset.scope; document.querySelectorAll("[data-scope]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    walkers.length = 0; replay = null; layout(); renderStats(); setMode();
  }));
  document.querySelectorAll("[data-win]").forEach((b) => b.addEventListener("click", () => {
    win = b.dataset.win; document.querySelectorAll("[data-win]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); renderStats();
  }));
  function showTip(w, cx, cy) {
    const p = w.p; tip.textContent = "";
    const add = (text, cls, tag = "div") => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; tip.appendChild(el); return el; };
    add(`$${p.amountUsd < 0.01 ? p.amountUsd.toFixed(4) : p.amountUsd.toFixed(3)} USDC`, "amt");
    add(`${p.seller.name}${p.seller.host ? ` · ${p.seller.host}` : ""}`);
    if (p.endpoint) add(p.endpoint, "muted");
    add(`${p.chain === "mpp" ? "MPP on Tempo" : "x402 on Base"} · ${new Date(p.ts).toLocaleTimeString()}${p.internal ? " · Agent402's own test traffic" : ""}`, "muted");
    add(`buyer ${p.payer}`, "muted");
    const a = add("View transaction", null, "a"); a.href = p.txUrl; a.target = "_blank"; a.rel = "noopener noreferrer";
    tip.style.display = "block";
    const r = canvas.getBoundingClientRect();
    tip.style.left = `${Math.min(cx - r.left + 12, r.width - 290)}px`;
    tip.style.top = `${Math.max(8, Math.min(cy - r.top + 12, r.height - 160))}px`;
  }
  function hitAt(cx, cy) {
    const r = canvas.getBoundingClientRect(), x = cx - r.left, y = cy - r.top;
    for (let i = walkers.length - 1; i >= 0; i--) { const h = walkers[i].hit; if (h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return walkers[i]; }
    return null;
  }
  canvas.addEventListener("mousemove", (e) => { const w = hitAt(e.clientX, e.clientY); canvas.style.cursor = w ? "pointer" : "default"; });
  canvas.addEventListener("click", (e) => { const w = hitAt(e.clientX, e.clientY); if (w) showTip(w, e.clientX, e.clientY); else tip.style.display = "none"; });
  function resize() {
    const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height; canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR); layout();
  }
  window.addEventListener("resize", resize);
  setInterval(layout, 10_000);
  resize(); connect(); requestAnimationFrame(frame);
})();
