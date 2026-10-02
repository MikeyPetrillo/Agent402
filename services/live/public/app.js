// Agent402 Live: little logo-headed walkers carry each settled payment from a
// buyer's wallet into the gate for its price. One server-sent event stream
// feeds it. Seller names and logos are third-party text and images: every
// string is set with textContent (never innerHTML) and every image comes
// from this origin.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const canvas = $("scene"), ctx = canvas.getContext("2d"), field = $("field"), tip = $("tip");
  const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const RAIL = { x402: { c: "#6EE7A8", rgb: "110,231,168", lit: "#9EF0B0" }, mpp: { c: "#A78BFA", rgb: "167,139,250", lit: "#C4B5FD" } };
  const params = new URLSearchParams(location.search);
  let rail = ["all", "x402", "mpp"].includes(params.get("rail")) ? params.get("rail") : "all";
  let win = params.get("window") === "24h" ? "h24" : "h1";
  let W = 0, H = 0, DPR = 1;
  const payments = [];            // last hour, oldest first
  const walkers = [], puffs = [], floaters = [];
  const latest = [];              // newest first, <= 8
  let lastLive = 0, lastStats = null, replay = null;
  const MAX_WALKERS = 160, MAX_FLOATERS = 14, REPLAY_SPEED = 10, QUIET_MS = 45_000;

  // ---- images, colors ------------------------------------------------------
  const mascot = new Image(); mascot.src = "/mascot.svg";
  const logos = new Map();        // seller key -> { img, ok, color }
  const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
  function sellerStyle(seller) {
    let e = logos.get(seller.key);
    if (!e) {
      e = { img: null, ok: false, color: `hsl(${hash(seller.key) % 360} 38% 42%)` };
      logos.set(seller.key, e);
      if (seller.logo) { const img = new Image(); img.onload = () => { e.img = img; e.ok = img.naturalWidth > 0; const c = dominantColor(img); if (c) e.color = c; }; img.src = seller.logo; }
    }
    return e;
  }
  function dominantColor(img) {
    try {
      const c = document.createElement("canvas"); c.width = c.height = 16;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data; let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2], A = d[i + 3], mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        if (A < 128 || mx < 40 || mn > 220 || mx - mn < 30) continue; r += R; gg += G; b += B; n++;
      }
      return n ? `rgb(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)})` : null;
    } catch { return null; }
  }
  const initials = (name) => String(name || "?").replace(/^0x/i, "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";

  // ---- price gates and buyer slots ------------------------------------------
  const GATES = [
    { max: 0.001, label: "≤ $0.001" }, { max: 0.01, label: "≤ $0.01" }, { max: 0.1, label: "≤ $0.10" },
    { max: 1, label: "≤ $1" }, { max: Infinity, label: "over $1" },
  ];
  const gateIndex = (usd) => GATES.findIndex((g) => usd <= g.max);
  let gates = [];
  const slots = [];               // recent buyer wallets { payer, rail, flash }
  const SLOTS = 10;
  const inRail = (p) => rail === "all" || p.chain === rail;
  function geometry() {
    const narrow = W < 600;
    const leftW = narrow ? 26 : Math.min(132, Math.max(84, W * 0.11));
    const gw = narrow ? 104 : Math.min(210, Math.max(140, W * 0.17));
    return { leftW, gw, gx: W - gw - 14, top: 40, bottom: H - 14 };
  }
  function layout() {
    const now = Date.now(), tally = GATES.map(() => ({ n: 0, usd: 0 }));
    for (const p of payments) if (inRail(p) && now - p.ts <= 3600_000) { const t = tally[gateIndex(p.amountUsd)]; t.n++; t.usd += p.amountUsd; }
    const g = geometry(), gap = 8, h = (g.bottom - g.top - gap * (GATES.length - 1)) / GATES.length;
    const prev = gates;
    gates = GATES.map((x, i) => ({ i, label: x.label, x: g.gx, y: g.top + i * (h + gap), w: g.gw, h, n: tally[i].n, usd: tally[i].usd, hit: prev[i]?.hit || 0, hitRail: prev[i]?.hitRail || "x402" }));
  }
  function slotFor(p) {
    let i = slots.findIndex((s) => s.payer === p.payer);
    if (i < 0) { if (slots.length >= SLOTS) slots.pop(); slots.unshift({ payer: p.payer, rail: p.chain, flash: 0 }); i = 0; }
    slots[i].flash = 16; slots[i].rail = p.chain;
    return i;
  }
  function slotY(i) { const g = geometry(); return g.top + 14 + i * ((g.bottom - g.top - 28) / (SLOTS - 1)); }

  // ---- walkers ---------------------------------------------------------------
  const HATS = ["none", "none", "none", "party", "top", "shades", "beanie", "bow", "cap"];
  const GAITS = ["waddle", "waddle", "waddle", "skip", "run"];
  const QUIPS = ["ka-ching", "one call pls", "402 ✓", "paid in full", "receipt pls", "brb, paying", "on my way", "worth it", "gas? none", "beep boop"];
  function spawn(p, speed = 1) {
    if (!inRail(p)) return;
    const g = gates[gateIndex(p.amountUsd)];
    if (!g) return;
    if (walkers.length >= MAX_WALKERS) walkers.shift();
    const si = slotFor(p), geo = geometry(), h = hash(p.id || p.tx);
    const gait = p.seller.agent402 ? "skip" : GAITS[h % GAITS.length];
    const dur = ((gait === "run" ? 5200 : 8200) + (h % 3000)) / speed;
    walkers.push({
      p, gi: g.i, sx: geo.leftW + 6, sy: slotY(si), tx: g.x - 10, ty: g.y + 18 + ((h >> 4) % Math.max(4, g.h - 36)),
      t0: performance.now(), dur, gait, hat: p.amountUsd >= 0.1 ? "crown" : HATS[(h >> 8) % HATS.length],
      bag: p.amountUsd >= 0.05, big: !!p.seller.agent402, scale: p.amountUsd >= 0.1 ? 1.25 : 1, phase: (h % 628) / 100,
      quip: !REDUCED && ((h >> 12) % 14 === 0 || (p.seller.agent402 && (h >> 12) % 4 === 0)) ? (p.seller.agent402 ? "402!" : QUIPS[(h >> 16) % QUIPS.length]) : null,
    });
  }
  function pos(w, now) {
    const k = Math.min(1, (now - w.t0) / w.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    let x = w.sx + (w.tx - w.sx) * e, y = w.sy + (w.ty - w.sy) * e;
    if (!REDUCED) {
      y += Math.sin(k * 18 + w.phase) * 3;                                  // meander
      if (w.gait === "skip") y -= Math.abs(Math.sin((now - w.t0) / 180)) * 7; // hop hop
      if (k > 0.86) y -= Math.sin(((k - 0.86) / 0.14) * Math.PI) * 22;        // the leap in
    }
    return { k, x, y };
  }

  // ---- drawing ---------------------------------------------------------------
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  function fit(t, max) { if (ctx.measureText(t).width <= max) return t; while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1); return t + "…"; }
  const money = (n) => n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
  function drawGate(g) {
    const r = RAIL[g.hitRail], lit = g.hit > 0, a = g.hit / 14;
    ctx.save();
    ctx.fillStyle = lit ? `rgba(${r.rgb},${0.08 + 0.1 * a})` : "rgba(20,27,36,.85)";
    rr(g.x, g.y, g.w, g.h, 12); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = lit ? `rgba(${r.rgb},${0.3 + 0.3 * a})` : "#1E2733"; ctx.stroke();
    ctx.fillStyle = lit ? r.c : "#2A3542"; rr(g.x - 4, g.y + g.h / 2 - 14, 7, 28, 4); ctx.fill();   // the notch walkers leap into
    ctx.textAlign = "left"; ctx.fillStyle = "#E9EAEC"; ctx.font = `600 ${W < 600 ? 14 : 17}px Geist, system-ui, sans-serif`;
    ctx.fillText(g.label, g.x + 16, g.y + Math.min(30, g.h / 2 + 2));
    if (g.h > 44) { ctx.fillStyle = "#8A97A8"; ctx.font = `${W < 600 ? 10 : 11.5}px "Geist Mono", ui-monospace, monospace`; ctx.fillText(fit(`${g.n.toLocaleString()} · ${money(g.usd)}`, g.w - 24), g.x + 16, g.y + Math.min(50, g.h / 2 + 20)); }
    ctx.restore();
  }
  function drawSlots() {
    const geo = geometry();
    ctx.save(); ctx.textAlign = "left"; ctx.font = `10px "Geist Mono", ui-monospace, monospace`; ctx.fillStyle = "#7C8AA0";
    if (W >= 600) ctx.fillText("AGENTS", 14, 26);
    ctx.textAlign = "right";
    slots.forEach((s, i) => {
      const y = slotY(i), on = s.flash > 0;
      if (W >= 600) { ctx.fillStyle = on ? "#DCE4EE" : "#5A6B7F"; ctx.fillText(`${s.payer}`, geo.leftW - 10, y + 3.5); }
      ctx.fillStyle = on ? RAIL[s.rail].c : "#2A3542"; ctx.beginPath(); ctx.arc(geo.leftW - 2, y, 3, 0, Math.PI * 2); ctx.fill();
      if (on) s.flash--;
    });
    ctx.restore();
  }
  function drawHat(kind, x, y, r, now) {
    ctx.save(); ctx.lineWidth = 1.5;
    if (kind === "party") { ctx.fillStyle = "#F472B6"; ctx.beginPath(); ctx.moveTo(x - r * 0.55, y - r * 0.75); ctx.lineTo(x + r * 0.55, y - r * 0.75); ctx.lineTo(x + 1, y - r * 2); ctx.fill(); ctx.fillStyle = "#FDE047"; ctx.beginPath(); ctx.arc(x + 1, y - r * 2, 2.4, 0, 7); ctx.fill(); }
    else if (kind === "top") { ctx.fillStyle = "#111"; ctx.fillRect(x - r * 0.95, y - r * 0.95, r * 1.9, 3); ctx.fillRect(x - r * 0.6, y - r * 1.9, r * 1.2, r); ctx.fillStyle = "#EF4444"; ctx.fillRect(x - r * 0.6, y - r * 1.15, r * 1.2, 2.5); }
    else if (kind === "beanie") { ctx.fillStyle = "#38BDF8"; ctx.beginPath(); ctx.arc(x, y - r * 0.7, r * 0.75, Math.PI, 0); ctx.fill(); const a = now / 120; ctx.strokeStyle = "#FDE047"; ctx.beginPath(); ctx.moveTo(x - 6 * Math.cos(a), y - r * 1.55); ctx.lineTo(x + 6 * Math.cos(a), y - r * 1.55); ctx.stroke(); ctx.fillStyle = "#FDE047"; ctx.fillRect(x - 1, y - r * 1.6, 2, 4); }
    else if (kind === "cap") { ctx.fillStyle = "#F97316"; ctx.beginPath(); ctx.arc(x, y - r * 0.55, r * 0.85, Math.PI, 0); ctx.fill(); ctx.fillRect(x, y - r * 0.6, r * 1.2, 3); }
    else if (kind === "bow") { ctx.fillStyle = "#F43F5E"; ctx.beginPath(); ctx.moveTo(x + r * 0.2, y - r * 0.95); ctx.lineTo(x + r * 0.95, y - r * 1.4); ctx.lineTo(x + r * 0.95, y - r * 0.6); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(x + r * 0.2, y - r * 0.95); ctx.lineTo(x - r * 0.55, y - r * 1.4); ctx.lineTo(x - r * 0.55, y - r * 0.6); ctx.closePath(); ctx.fill(); }
    else if (kind === "crown") { ctx.fillStyle = "#FACC15"; ctx.beginPath(); ctx.moveTo(x - r * 0.8, y - r * 0.85); ctx.lineTo(x - r * 0.8, y - r * 1.6); ctx.lineTo(x - r * 0.4, y - r * 1.2); ctx.lineTo(x, y - r * 1.75); ctx.lineTo(x + r * 0.4, y - r * 1.2); ctx.lineTo(x + r * 0.8, y - r * 1.6); ctx.lineTo(x + r * 0.8, y - r * 0.85); ctx.closePath(); ctx.fill(); }
    ctx.restore();
  }
  function drawWalker(w, now) {
    const { k, x, y } = pos(w, now);
    const t = (now - w.t0) / (w.gait === "run" ? 55 : 95), swing = Math.sin(t) * (REDUCED ? 0 : 1);
    ctx.save();
    ctx.globalAlpha = k > 0.96 ? (1 - k) / 0.04 : 1;
    if (w.big) {
      const s = 0.6;
      ctx.shadowColor = "rgba(158,240,176,.85)"; ctx.shadowBlur = 16;
      if (mascot.complete) ctx.drawImage(mascot, x - 32 * s, y - 80 * s, 64 * s, 80 * s);
      ctx.shadowBlur = 0; if (w.quip && k > 0.25 && k < 0.6) bubble(w.quip, x, y - 54);
      ctx.restore(); w.hit = { x: x - 20, y: y - 50, w: 40, h: 50 }; return;
    }
    const st = sellerStyle(w.p.seller), r = 13 * w.scale, cy = y - 30 * w.scale, rc = RAIL[w.p.chain] || RAIL.x402;
    // legs and feet
    ctx.strokeStyle = "#9AA1A9"; ctx.lineWidth = 2.4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x - 3, y - 9 * w.scale); ctx.lineTo(x - 3 + swing * 4, y); ctx.moveTo(x + 3, y - 9 * w.scale); ctx.lineTo(x + 3 - swing * 4, y); ctx.stroke();
    // body in the seller's color, with a wobble
    ctx.save(); ctx.translate(x, y - 13 * w.scale); ctx.rotate(REDUCED ? 0 : Math.sin(t / 2) * 0.08);
    ctx.fillStyle = w.p.internal ? "#56606b" : st.color; rr(-7 * w.scale, -9 * w.scale, 14 * w.scale, 12 * w.scale, 5); ctx.fill();
    // arms: swinging, or carrying the money bag
    ctx.strokeStyle = "#9AA1A9"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-7 * w.scale, -6 * w.scale); ctx.lineTo(-11 * w.scale - swing * 2, 1 + swing * 3);
    ctx.moveTo(7 * w.scale, -6 * w.scale); ctx.lineTo(11 * w.scale + (w.bag ? 2 : swing * 2), w.bag ? 2 : 1 - swing * 3); ctx.stroke();
    if (w.bag) { ctx.fillStyle = "#C98B2B"; ctx.beginPath(); ctx.arc(14 * w.scale, 6, 5, 0, 7); ctx.fill(); ctx.fillStyle = "#1d2b3a"; ctx.font = "700 7px Geist, sans-serif"; ctx.textAlign = "center"; ctx.fillText("$", 14 * w.scale, 8.5); }
    ctx.restore();
    // the logo head, ringed in its rail's color
    ctx.fillStyle = rc.c; ctx.beginPath(); ctx.arc(x, cy, r + 2.2, 0, 7); ctx.fill();
    ctx.fillStyle = "#F3F4F5"; ctx.beginPath(); ctx.arc(x, cy, r, 0, 7); ctx.fill();
    if (st.ok) { ctx.save(); ctx.beginPath(); ctx.arc(x, cy, r - 1.5, 0, 7); ctx.clip(); ctx.drawImage(st.img, x - r + 3, cy - r + 3, 2 * r - 6, 2 * r - 6); ctx.restore(); }
    else { ctx.fillStyle = st.color; ctx.beginPath(); ctx.arc(x, cy, r - 1.5, 0, 7); ctx.fill(); ctx.fillStyle = "#F3F4F5"; ctx.font = `700 ${Math.round(9.5 * w.scale)}px "Geist Mono", monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(initials(w.p.seller.name), x, cy + 0.5); }
    if (w.hat === "shades") { ctx.fillStyle = "#0B0C0E"; rr(x - r * 0.75, cy - 3, r * 0.65, 5, 2); ctx.fill(); rr(x + r * 0.1, cy - 3, r * 0.65, 5, 2); ctx.fill(); ctx.fillRect(x - r * 0.1, cy - 2, r * 0.2, 1.5); }
    else if (w.hat !== "none") drawHat(w.hat, x, cy, r, now);
    if (w.quip && k > 0.2 && k < 0.55) bubble(w.quip, x, cy - r - 14);
    ctx.restore();
    w.hit = { x: x - r - 4, y: cy - r - 6, w: 2 * r + 8, h: y - cy + r + 8 };
  }
  function bubble(text, x, y) {
    ctx.save(); ctx.font = `11px "Geist Mono", monospace`;
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = "#F3F4F5"; rr(x - w / 2, y - 18, w, 18, 9); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 2, y + 5); ctx.lineTo(x + 4, y); ctx.fill();
    ctx.fillStyle = "#0B0C0E"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, x, y - 9);
    ctx.restore();
  }
  function arrive(w) {
    const g = gates[w.gi]; if (!g) return;
    g.hit = 14; g.hitRail = w.p.chain;
    if (REDUCED) return;
    const rc = RAIL[w.p.chain] || RAIL.x402, n = w.p.amountUsd >= 1 ? 26 : 6;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 0.6 + Math.random() * (n > 6 ? 2.6 : 1.2);
      puffs.push({ x: g.x - 6, y: w.ty - 14, vx: Math.cos(a) * v - (n > 6 ? 0 : 0.6), vy: Math.sin(a) * v - (n > 6 ? 1.6 : 0), life: 1, c: n > 6 ? ["#FACC15", "#F472B6", "#38BDF8", "#6EE7A8"][i % 4] : rc.c, sq: n > 6 });
    }
    if (w.seeded) return;
    if (floaters.length >= MAX_FLOATERS) floaters.shift();
    floaters.push({ x: g.x - 10 - Math.random() * 30, y: w.ty - 20, t: 1, text: `+$${w.p.amountUsd < 0.01 ? w.p.amountUsd.toFixed(3) : w.p.amountUsd.toFixed(w.p.amountUsd < 1 ? 3 : 2)}`, c: rc.lit });
  }
  function frame(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (const g of gates) { drawGate(g); if (g.hit > 0) g.hit--; }
    drawSlots();
    for (let i = walkers.length - 1; i >= 0; i--) { const w = walkers[i]; if (now - w.t0 >= w.dur) { arrive(w); walkers.splice(i, 1); } }
    for (const w of walkers) if (!w.big) drawWalker(w, now);
    for (const w of walkers) if (w.big) drawWalker(w, now);
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i]; p.x += p.vx; p.y += p.vy; p.vy += p.sq ? 0.08 : 0; p.vx *= 0.94; p.vy *= p.sq ? 1 : 0.94; p.life -= p.sq ? 0.014 : 0.06;
      if (p.life <= 0) { puffs.splice(i, 1); continue; }
      ctx.globalAlpha = p.life; ctx.fillStyle = p.c;
      if (p.sq) ctx.fillRect(p.x, p.y, 4, 4); else { ctx.beginPath(); ctx.arc(p.x, p.y, 2.5 * p.life + 0.5, 0, 7); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    ctx.font = `700 11px "Geist Mono", monospace`; ctx.textAlign = "right";
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i]; f.t -= 1 / 66; if (f.t <= 0) { floaters.splice(i, 1); continue; }
      ctx.globalAlpha = f.t; ctx.fillStyle = f.c; ctx.fillText(f.text, f.x, f.y - (1 - f.t) * 22);
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }

  // ---- replay when the feed is quiet ------------------------------------------
  setInterval(() => {
    const live = Date.now() - lastLive < QUIET_MS;
    if (live) { replay = null; return setMode(); }
    const pool = payments.filter(inRail);
    if (!pool.length) return setMode();
    if (!replay) replay = { i: 0, clock: pool[0].ts };
    replay.clock += 250 * REPLAY_SPEED;
    while (replay.i < pool.length && pool[replay.i].ts <= replay.clock) spawn(pool[replay.i++], 1.4);
    if (replay.i >= pool.length) replay = null;
    setMode();
  }, 250);
  function setMode(conn) {
    const live = Date.now() - lastLive < QUIET_MS;
    $("mode").textContent = conn || (live ? "" : replay ? `replay ×${REPLAY_SPEED} · last hour` : "waiting for payments");
    $("dot").className = "dot" + (live && !conn ? " live" : "");
    $("conn").textContent = conn || (live ? "live" : "connecting");
  }

  // ---- stats, leaderboard, latest ---------------------------------------------
  const fmtUsd = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function renderStats() {
    const s = lastStats?.[rail]; if (!s) return;
    $("s-pm").textContent = String(s.perMinute);
    $("s-usd").textContent = fmtUsd(s[win].usd);
    $("s-buyers").textContent = s[win].buyers.toLocaleString();
    // The 24h rollups live in memory and a restart backfills one hour, so a
    // 24h figure read before a full day has passed covers less than a day:
    // every 24h label says since when.
    const partial = win === "h24" && lastStats.coverage24hSince && Date.now() - lastStats.coverage24hSince < 23.5 * 3600_000;
    const since = partial ? new Date(lastStats.coverage24hSince).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    document.querySelectorAll(".stat .w").forEach((el) => { el.textContent = win === "h1" ? "1h" : partial ? `since ${since}` : "24h"; });
    $("board-title").textContent = `Top sellers · ${win === "h1" ? "last hour" : partial ? `since ${since} (not a full 24 hours)` : "last 24 hours"}`;
    const cards = $("cards"); cards.textContent = "";
    for (const t of s[win].topSellers) {
      const shared = /^Shared recipient/.test(t.name), href = t.agent402 ? "https://agent402.tools/" : t.listed && t.host && !shared ? `https://${t.host}` : shared ? "https://agent402.tools/mpp-marketplace" : null;
      const card = document.createElement(href ? "a" : "div"); card.className = "card";
      if (href) { card.href = href; card.target = "_blank"; card.rel = "nofollow noopener noreferrer"; card.title = t.host || t.name; }
      const tile = document.createElement("div"); tile.className = "tile"; tile.style.background = sellerStyle(t).color;
      const fallback = () => { tile.textContent = initials(t.name); };
      if (t.agent402 || t.logo) { const img = document.createElement("img"); img.alt = ""; img.src = t.agent402 ? "/brand.svg" : t.logo; img.onerror = fallback; tile.appendChild(img); } else fallback();
      const mid = document.createElement("div"); mid.style.minWidth = "0";
      const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = t.name + (href ? " ↗" : "");
      const sub = document.createElement("div"); sub.className = "sub"; sub.textContent = `×${t.payments.toLocaleString()}${t.host ? ` · ${t.host}` : ""}`;
      mid.append(nm, sub);
      const usd = document.createElement("div"); usd.className = "usd"; usd.textContent = t.usd >= 1 ? fmtUsd(t.usd) : `$${t.usd.toFixed(3)}`;
      card.append(tile, mid, usd); cards.appendChild(card);
    }
  }
  function pushLatest(p) { latest.unshift(p); if (latest.length > 24) latest.pop(); renderLatest(); }
  function renderLatest() {
    const box = $("latest"); box.querySelectorAll("a").forEach((a) => a.remove());
    latest.filter(inRail).slice(0, 8).forEach((x, i) => {
      const a = document.createElement("a"); a.href = x.txUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; a.style.opacity = String(Math.max(0.35, 1 - i * 0.1));
      const dot = document.createElement("i"); dot.style.background = (RAIL[x.chain] || RAIL.x402).c;
      const tm = document.createElement("span"); tm.textContent = new Date(x.ts).toLocaleTimeString([], { hour12: false });
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = x.seller.name;
      const amt = document.createElement("span"); amt.className = "amt" + (x.chain === "mpp" ? " mpp" : ""); amt.textContent = `+$${x.amountUsd.toFixed(x.amountUsd >= 1 ? 2 : 3)}`;
      const tx = document.createElement("span"); tx.textContent = `${x.tx.slice(0, 6)}…${x.tx.slice(-4)}`;
      a.append(dot, tm, nm, amt, tx); box.appendChild(a);
    });
  }

  // ---- stream ------------------------------------------------------------------
  function ingest(list, live) {
    for (const p of list) payments.push(p);
    const cut = Date.now() - 3600_000;
    while (payments.length && payments[0].ts < cut) payments.shift();
    if (!live) return;
    layout();
    for (const p of list) { pushLatest(p); if (inRail(p)) { lastLive = Date.now(); replay = null; spawn(p); } }
    setMode();
  }
  function connect() {
    const es = new EventSource("/events");
    es.addEventListener("hello", (e) => {
      const d = JSON.parse(e.data); payments.length = 0; ingest(d.payments, false);
      const newest = payments.length ? payments[payments.length - 1].ts : 0;
      lastLive = newest ? Date.now() - Math.max(0, (d.now || Date.now()) - newest) : 0;
      payments.slice(-8).forEach(pushLatest);
      lastStats = d.stats; layout(); renderStats(); setMode();
      // a few walkers already on their way, so the stage never opens empty
      const now = performance.now();
      payments.filter(inRail).slice(-14).forEach((p, i) => { spawn(p); const w = walkers[walkers.length - 1]; if (w) { w.t0 = now - (i / 14) * w.dur * 0.8; w.seeded = true; } });
    });
    es.addEventListener("payments", (e) => ingest(JSON.parse(e.data), true));
    es.addEventListener("stats", (e) => { lastStats = JSON.parse(e.data); renderStats(); });
    es.onerror = () => setMode("reconnecting");
  }

  // ---- controls, tooltip, resize, clock ------------------------------------------
  function syncUrl() { const q = new URLSearchParams(); if (rail !== "all") q.set("rail", rail); if (win === "h24") q.set("window", "24h"); history.replaceState(null, "", q.toString() ? `?${q}` : location.pathname); }
  function press(sel, v, attr) { document.querySelectorAll(sel).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === v))); }
  document.querySelectorAll("[data-rail]").forEach((b) => b.addEventListener("click", () => { rail = b.dataset.rail; press("[data-rail]", rail, "rail"); for (let i = walkers.length - 1; i >= 0; i--) if (!inRail(walkers[i].p)) walkers.splice(i, 1); replay = null; layout(); renderStats(); renderLatest(); syncUrl(); setMode(); }));
  document.querySelectorAll("[data-win]").forEach((b) => b.addEventListener("click", () => { win = b.dataset.win; press("[data-win]", win, "win"); renderStats(); syncUrl(); }));
  press("[data-rail]", rail, "rail"); press("[data-win]", win, "win");
  function showTip(w, cx, cy) {
    const p = w.p; tip.textContent = "";
    const add = (text, cls, tag = "div") => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; tip.appendChild(el); return el; };
    add(`$${p.amountUsd < 0.01 ? p.amountUsd.toFixed(4) : p.amountUsd.toFixed(3)} ${p.chain === "mpp" ? "USDC.e" : "USDC"}`, "amt");
    add(`${p.seller.name}${p.seller.host ? ` · ${p.seller.host}` : ""}`);
    if (p.endpoint) add(p.endpoint, "muted");
    add(`${p.chain === "mpp" ? "MPP on Tempo" : "x402 on Base"} · ${new Date(p.ts).toLocaleTimeString()}${p.internal ? " · Agent402's own test traffic" : ""}`, "muted");
    add(`buyer ${p.payer}`, "muted");
    const a = add("View transaction ↗", null, "a"); a.href = p.txUrl; a.target = "_blank"; a.rel = "noopener noreferrer";
    tip.style.display = "block";
    const r = field.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(cx - r.left + 12, r.width - 290))}px`;
    tip.style.top = `${Math.max(8, Math.min(cy - r.top + 12, r.height - 170))}px`;
  }
  function hitAt(cx, cy) {
    const r = canvas.getBoundingClientRect(), x = cx - r.left, y = cy - r.top;
    for (let i = walkers.length - 1; i >= 0; i--) { const h = walkers[i].hit; if (h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return walkers[i]; }
    return null;
  }
  field.addEventListener("mousemove", (e) => { canvas.style.cursor = hitAt(e.clientX, e.clientY) ? "pointer" : "default"; });
  field.addEventListener("click", (e) => { if (e.target.closest("#tip")) return; const w = hitAt(e.clientX, e.clientY); if (w) showTip(w, e.clientX, e.clientY); else tip.style.display = "none"; });
  // Full screen: the whole stage (toolbar, scene, LATEST bar). Native
  // fullscreen when the browser offers it; otherwise a fixed overlay, closed
  // by the same button or Esc. The ResizeObserver redraws the scene either way.
  const stage = document.querySelector(".stage"), fsBtn = $("fs");
  const nativeFs = () => document.fullscreenElement || document.webkitFullscreenElement;
  function setFull(on) {
    stage.classList.toggle("is-full", on); document.body.classList.toggle("stage-full", on);
    fsBtn.setAttribute("aria-pressed", String(on)); fsBtn.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
    fsBtn.querySelector("span").textContent = on ? "Exit" : "Full screen";
  }
  if (fsBtn && stage) {
    fsBtn.addEventListener("click", async () => {
      if (stage.classList.contains("is-full")) {
        if (nativeFs()) { try { await (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch { /* left already */ } }
        setFull(false); return;
      }
      setFull(true);
      const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
      if (req) { try { await req.call(stage); } catch { /* the overlay stays */ } }
    });
    const onChange = () => { if (!nativeFs() && stage.classList.contains("is-full") && document.fullscreenEnabled !== false && (stage.requestFullscreen || stage.webkitRequestFullscreen)) setFull(false); };
    document.addEventListener("fullscreenchange", onChange); document.addEventListener("webkitfullscreenchange", onChange);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && stage.classList.contains("is-full") && !nativeFs()) setFull(false); });
  }
  function resize() { const r = field.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); W = r.width; H = r.height; canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR); layout(); }
  new ResizeObserver(resize).observe(field);
  setInterval(layout, 10_000);
  const tick = () => { $("clock").textContent = new Date().toISOString().slice(11, 19) + " UTC"; };
  tick(); setInterval(tick, 1000);
  resize(); connect(); requestAnimationFrame(frame);
})();
