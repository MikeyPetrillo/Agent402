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

  // ---- layout: storefronts ----------------------------------------------
  let buildings = [];           // { key, seller, x, y, w, h, flash, count }
  const OTHERS = { key: "others", name: "Everyone else", host: null, logo: null, agent402: false, listed: false };
  function inScope(p) { return scope === "all" || p.chain === scope; }
  // Agent402 is one storefront whichever chain it was paid on.
  const A402 = { key: "agent402", name: "Agent402", host: "agent402.tools", logo: null, agent402: true, listed: true };
  const bKey = (seller) => (seller.agent402 ? "agent402" : seller.key);
  function layout() {
    const now = Date.now();
    const counts = new Map();
    for (const p of payments) {
      if (!inScope(p) || now - p.ts > 3600_000) continue;
      const k = bKey(p.seller);
      counts.set(k, { seller: p.seller.agent402 ? A402 : p.seller, n: (counts.get(k)?.n || 0) + 1 });
    }
    const slots = W < 640 ? 6 : W < 1100 ? 10 : 14;
    const ranked = [...counts.values()].filter((v) => !v.seller.agent402).sort((a, b) => b.n - a.n);
    const shown = ranked.slice(0, slots - 2);
    const list = [{ seller: A402, n: counts.get("agent402")?.n || 0 }, ...shown, { seller: OTHERS, n: ranked.slice(slots - 2).reduce((s, v) => s + v.n, 0) }];
    const cols = W < 640 ? 3 : W < 1100 ? 5 : 7;
    const rows = Math.ceil(list.length / cols);
    const panel = W >= 640 ? 285 : 0;
    const left = Math.max(80, W * 0.2), areaW = W - left - 16 - panel, cellW = areaW / cols;
    const rowH = Math.min(190, (H - 70) / rows);
    const top = Math.max(30, (H - rows * rowH) / 2);
    const maxN = Math.max(1, ...list.map((v) => v.n));
    const prev = new Map(buildings.map((b) => [b.key, b]));
    buildings = list.map((v, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const scale = 0.45 + 0.55 * Math.sqrt(v.n / maxN);
      const w = Math.min(cellW * 0.8, 120), h = Math.max(38, (rowH - 34) * scale);
      const x = left + c * cellW + (cellW - w) / 2, baseY = top + (r + 1) * rowH - 18;
      return { key: bKey(v.seller), seller: v.seller, x, y: baseY - h, w, h, baseY, count: v.n, flash: prev.get(v.seller.key)?.flash || 0 };
    });
  }
  function buildingFor(seller) {
    return buildings.find((b) => b.key === bKey(seller)) || buildings.find((b) => b.key === "others");
  }

  // ---- walkers -----------------------------------------------------------
  function spawn(p, speed = 1) {
    if (!inScope(p)) return;
    const b = buildingFor(p.seller);
    if (!b) return;
    if (walkers.length >= MAX_WALKERS) walkers.shift();
    const sy = 40 + Math.random() * (H - 80);
    const tx = b.x + b.w / 2 + (Math.random() - 0.5) * b.w * 0.4, ty = b.baseY;
    const dur = (8000 + Math.random() * 4000) / speed;
    walkers.push({ p, b, sx: -20, sy, tx, ty, t0: performance.now(), dur, big: !!p.seller.agent402 });
  }

  // ---- drawing -----------------------------------------------------------
  function fitText(t, max) {
    if (ctx.measureText(t).width <= max) return t;
    while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
    return t + "…";
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  function drawBuilding(b) {
    const st = b.seller.agent402 ? { color: "#0f5e43" } : b.key === "others" ? { color: "#3a4655" } : sellerStyle(b.seller);
    ctx.save();
    ctx.globalAlpha = 1;
    // body
    ctx.fillStyle = "#18222d"; roundRect(b.x, b.y, b.w, b.h, 6); ctx.fill();
    ctx.strokeStyle = b.flash > 0 ? "#9ef0b0" : "#2a3a4b"; ctx.lineWidth = b.flash > 0 ? 2 : 1; ctx.stroke();
    // awning in the seller color
    ctx.fillStyle = st.color; roundRect(b.x - 3, b.y - 6, b.w + 6, 10, 4); ctx.fill();
    // windows
    ctx.fillStyle = b.flash > 0 ? "rgba(158,240,176,.35)" : "rgba(255,255,255,.06)";
    for (let wy = b.y + 12; wy < b.baseY - 22; wy += 14) for (let wx = b.x + 8; wx < b.x + b.w - 12; wx += 14) ctx.fillRect(wx, wy, 8, 7);
    // door
    ctx.fillStyle = "#0c1117"; roundRect(b.x + b.w / 2 - 7, b.baseY - 16, 14, 16, 3); ctx.fill();
    // logo on the facade
    const icon = b.seller.agent402 ? (mascot.complete ? mascot : null) : st.ok ? st.img : null;
    if (icon) ctx.drawImage(icon, b.x + b.w / 2 - 9, b.y + 8, 18, b.seller.agent402 ? 22 : 18);
    // label
    ctx.fillStyle = b.seller.agent402 ? "#9ef0b0" : "#c9d4de"; ctx.font = "600 11px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(fitText(String(b.seller.name || ""), b.w + 24), b.x + b.w / 2, b.baseY + 13);
    if (b.count) { ctx.fillStyle = "#8a99a8"; ctx.font = "10px system-ui, sans-serif"; ctx.fillText(String(b.count), b.x + b.w / 2, b.y - 10); }
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
    ctx.globalAlpha = k > 0.92 ? (1 - k) / 0.08 : 1;
    if (w.big) {
      const s = 0.62;
      ctx.shadowColor = "rgba(158,240,176,.8)"; ctx.shadowBlur = 12;
      if (mascot.complete) ctx.drawImage(mascot, x - 32 * s, y - 80 * s + step * 1.5, 64 * s, 80 * s);
      ctx.restore(); w.hit = { x: x - 20, y: y - 50, w: 40, h: 50 }; return;
    }
    const st = sellerStyle(w.p.seller);
    const internal = w.p.internal;
    // legs
    ctx.fillStyle = "#1d2b3a";
    ctx.fillRect(x - 4, y - 10, 3, 10 + step * 2); ctx.fillRect(x + 1, y - 10, 3, 10 - step * 2);
    // body in the seller's color
    ctx.fillStyle = internal ? "#56606b" : st.color; roundRect(x - 6, y - 22, 12, 13, 4); ctx.fill();
    // head
    ctx.fillStyle = "#f1e6da"; ctx.beginPath(); ctx.arc(x, y - 26, 4.5, 0, Math.PI * 2); ctx.fill();
    // favicon badge
    if (st.ok) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(x + 8, y - 17, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.drawImage(st.img, x + 4, y - 21, 8, 8); }
    ctx.restore();
    w.hit = { x: x - 9, y: y - 32, w: 22, h: 32 };
  }
  function frame(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = "#0c1117"; ctx.fillRect(0, 0, W, H);
    // street
    ctx.strokeStyle = "#16202a"; ctx.lineWidth = 1;
    for (let y = 40; y < H; y += 46) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    for (const b of buildings) { drawBuilding(b); if (b.flash > 0) b.flash -= 1; }
    for (let i = walkers.length - 1; i >= 0; i--) {
      const w = walkers[i];
      if (now - w.t0 >= w.dur) { w.b.flash = 24; walkers.splice(i, 1); continue; }
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
