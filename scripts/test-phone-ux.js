#!/usr/bin/env node
// Phone-width and touch checks the presence review found (real Chromium):
//   - /pricing at 375 px: the paid card's x402 badge does not sit on its label;
//   - /tools: a search with no tool match says so under the box, in a polite
//     live region, and a later match clears it;
//   - arrow links ("… →") on /, /docs and /company are tap targets of 24 px or more;
//   - /reports and /credits set the display serif on the type scale (--fs-4xl), never a 5vw clamp;
//   - /status: a tap on a day strip writes that day's reading under it, and the
//     lead names tap beside hover.
//   - a row of tags never begins a row with its dot, and no line of text with a
//     separator or a period; a short heading does not open on one word;
//   - /revenue's rows of segments fit their card, /status readings are never cut,
//     a hyphenated name and a short camelCase field stay whole;
//   - skill pack step numbers meet AA contrast in both schemes; the home page's
//     people card ends under its buttons at 1440 px;
//   - a changed width re-measures the wraps (assets/js/site-chrome.js a402Rebind).
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-phone-ux.js
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const overlap = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const browser = await chromium.launch();
const open = async (path, width = 375) => { const p = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: true }); await p.goto(`${BASE}${path}`, { waitUntil: "load" }); return p; };
try {
  {
    const p = await open("/pricing");
    const r = await p.evaluate(() => {
      const label = [...document.querySelectorAll("div")].find((d) => /^PAID · STABLECOIN OVER x402 OR MPP$/.test(d.textContent.trim()));
      const badge = label && [...label.parentElement.children].find((d) => d.textContent.trim() === "x402");
      const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      // The label's text, not its box: a range over the words.
      const rng = label && document.createRange(); if (rng) rng.selectNodeContents(label);
      return { label: rng ? [...rng.getClientRects()].map((b) => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom })) : [], badge: box(badge) };
    });
    ok(r.badge && r.label.length > 0 && !r.label.some((l) => overlap(l, r.badge)), "/pricing at 375 px: the x402 badge does not overlap the paid card's label");
    ok(new Set(r.label.map((l) => Math.round(l.top))).size === 1, `/pricing at 375 px: the paid card's label sits on one line (${r.label.length} box(es))`);
    await p.close();
  }
  {
    const p = await open("/tools");
    const st = p.locator("#cat-find-status");
    ok(await st.getAttribute("aria-live") === "polite" && await st.getAttribute("role") === "status", "/tools: the search status is a polite live region");
    await p.fill("#cat-search", "zzqxv wqpzk vvxq");
    await p.waitForFunction(() => /No tool matches/.test(document.getElementById("cat-find-status")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
    const t = await st.textContent();
    ok(/No tool matches "zzqxv wqpzk vvxq"/.test(t) && await st.isVisible(), `/tools: a search with no match says so under the box (${t.slice(0, 60)})`);
    await p.fill("#cat-search", "hash text sha256");
    await p.waitForFunction(() => document.getElementById("cat-results")?.style.display === "block", null, { timeout: 8000 }).catch(() => {});
    ok(!(await st.isVisible()), "/tools: a later match clears the no-match line");
    await p.close();
  }
  for (const path of ["/", "/docs", "/company"]) {
    const p = await open(path);
    const small = await p.evaluate(() => [...document.querySelectorAll("a")].filter((a) => /→\s*$/.test(a.textContent) && a.offsetParent).map((a) => [a.textContent.trim().slice(0, 30), Math.round(a.getBoundingClientRect().height)]).filter(([, h]) => h > 0 && h < 24));
    ok(small.length === 0, `${path} at 375 px: every arrow link is a 24 px tap target${small.length ? ` (${JSON.stringify(small.slice(0, 5))})` : ""}`);
    await p.close();
  }
  for (const path of ["/reports", "/credits"]) {
    const p = await open(path);
    const r = await p.evaluate(() => { const h = document.querySelector(".hero h1"); const probe = document.createElement("span"); probe.style.fontSize = "var(--fs-4xl)"; document.body.appendChild(probe); return { h: h ? getComputedStyle(h).fontSize : null, want: getComputedStyle(probe).fontSize, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }; });
    ok(r.h && r.h === r.want && r.sw <= r.cw + 1, `${path} at 375 px: the hero h1 is --fs-4xl (${r.h}, want ${r.want}) and the page does not scroll sideways`);
    await p.close();
  }
  {
    // /docs/api at 360 px: its reference list and category table stay inside
    // the page, a probe entry and row with a long unbroken path and word
    // included (no font metric assumed).
    const p = await open("/docs/api", 360);
    const r = await p.evaluate(() => {
      const item = document.querySelector(".ml-docs-reflist li");
      const row = document.querySelector(".ml-docs-main table tbody tr");
      if (!item || !row) return null;
      const probeItem = item.cloneNode(true);
      probeItem.dataset.phoneUxProbe = "1";
      probeItem.querySelector("code").textContent = "/" + "x".repeat(120);
      probeItem.querySelector("span").textContent = `Reads ${"y".repeat(160)} and answers.`;
      item.after(probeItem);
      const probeRow = row.cloneNode(true);
      probeRow.dataset.phoneUxProbe = "1";
      probeRow.cells[0].textContent = `Reads ${"z".repeat(160)} and answers.`;
      row.after(probeRow);
      const cw = document.documentElement.clientWidth;
      const els = [...document.querySelectorAll(".ml-docs-reflist, .ml-docs-reflist li, .ml-docs-reflist li > *, .ml-docs-tw")];
      const wide = els.filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > cw + 1 || b.left < -1); }).map((e) => `${e.tagName}.${e.className}:${(e.textContent || "").trim().slice(0, 30)}`);
      return { items: document.querySelectorAll(".ml-docs-reflist li").length, rows: document.querySelectorAll(".ml-docs-main table tbody tr").length, wide, sw: document.documentElement.scrollWidth, cw };
    });
    ok(r && r.items >= 6 && r.rows > 10 && r.wide.length === 0 && r.sw <= r.cw + 1, `/docs/api at 360 px: the reference list and category table stay inside the page (${r ? `${r.items} references, ${r.rows} rows${r.wide.length ? `; past it: ${r.wide.slice(0, 3).join(" | ")}` : ""}` : "none"})`);
    await p.close();
  }
  {
    const p = await open("/status");
    ok(/hover over or tap a bar/.test(await p.textContent("body")), "/status: the lead names tap beside hover");
    await p.evaluate(() => {
      const lead = [...document.querySelectorAll("p")].find((x) => /tap a bar/.test(x.textContent));
      const d = document.createElement("div");
      d.className = "bars";
      d.dataset.phoneUxProbe = "1"; // the page renders its own strip too: this one is marked
      d.innerHTML = Array.from({ length: 30 }, (_, i) => `<i class="b up" title="2026-11-${String(i + 1).padStart(2, "0")}: 100% of ${i + 1} probes"></i>`).join("");
      lead.after(d);
      d.scrollIntoView({ block: "center" });
    });
    // The scroll brings the strip's section into view, and its reveal slides
    // it into place (a transform transition): tap where the strip ends up, not
    // where it is mid-slide. Wait a frame for the observer to start the
    // reveal, then for every running animation to finish.
    await p.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      await frame(); await frame();
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
      await frame();
    });
    const box = await p.locator('.bars[data-phone-ux-probe="1"]').boundingBox();
    await p.touchscreen.tap(box.x + box.width * (2.5 / 30), box.y + box.height / 2);
    const read = await p.evaluate(() => { const r = document.querySelector('.bars[data-phone-ux-probe="1"]').nextElementSibling; return r && r.classList.contains("bar-read") ? { t: r.textContent, live: r.getAttribute("aria-live") } : null; });
    ok(read && read.t === "2026-11-03: 100% of 3 probes" && read.live === "polite", `/status: a tap on the strip reads that day under it (${read && read.t})`);
    await p.close();
  }
  // --- Layout shapes measured after a review of rendered pages -------------
  // A row of tags joined by dots never begins a row with its dot: the tag
  // that starts a row carries its dot left of the row's clip (sepRowCss).
  for (const [path, width] of [["/", 375], ["/", 1440], ["/sell", 375], ["/revenue", 375], ["/status", 375]]) {
    const p = await open(path, width);
    await p.waitForTimeout(300);
    const r = await p.evaluate(() => {
      const rows = new Set(), shown = [];
      for (const el of document.querySelectorAll("main span, footer span")) {
        if (getComputedStyle(el, "::before").content !== '"·"') continue;
        const row = el.parentElement, a = row.getBoundingClientRect(), b = el.getBoundingClientRect();
        if (!b.width) continue;
        rows.add(row);
        const prev = el.previousElementSibling;
        const startsRow = !prev || b.top > prev.getBoundingClientRect().top + 4;
        const dotRight = b.left + parseFloat(getComputedStyle(el).paddingLeft);
        // Drawn when the dot's box is inside the row, or the row does not clip.
        if (startsRow && (dotRight > a.left + 1 || getComputedStyle(row).clipPath === "none")) shown.push(el.textContent.trim().slice(0, 30));
      }
      const text = [];
      const tw = document.createTreeWalker(document.querySelector("main"), NodeFilter.SHOW_TEXT); let prevTop = null; const rg = document.createRange();
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (n.parentElement.closest("pre,script,style,details:not([open])")) continue; for (let i = 0; i < n.data.length; i++) { if (/[\s⁠]/.test(n.data[i])) continue; rg.setStart(n, i); rg.setEnd(n, i + 1); const b = rg.getBoundingClientRect(); if (!b.height) continue; if (prevTop !== null && b.top > prevTop.top + prevTop.h * 0.6 && b.left < prevTop.left && /[·.]/.test(n.data[i]) && /\s/.test(n.data[i + 1] || " ")) text.push(n.data.slice(i, i + 24)); prevTop = { top: b.top, left: b.left, h: b.height }; } }
      return { rows: rows.size, shown, text };
    });
    ok(r.rows > 0 && r.shown.length === 0, `${path} at ${width}px: no row of tags begins with its dot (${r.rows} rows)${r.shown.length ? `: ${r.shown.join("; ")}` : ""}`);
    ok(r.text.length === 0, `${path} at ${width}px: no line of text begins with a separator dot or a period${r.text.length ? `: ${r.text.join("; ")}` : ""}`);
    if (path === "/sell") {
      // Control: with the pull-back margin removed, the same measure finds the dots.
      const seen = await p.evaluate(() => { const st = document.createElement("style"); st.textContent = ".ml-meta>span{margin-left:0 !important}"; document.head.append(st); let n = 0; for (const el of document.querySelectorAll("main .ml-meta > span")) { const prev = el.previousElementSibling, b = el.getBoundingClientRect(), a = el.parentElement.getBoundingClientRect(); if (prev && b.top > prev.getBoundingClientRect().top + 4 && b.left + parseFloat(getComputedStyle(el).paddingLeft) > a.left + 1) n++; } return n; });
      ok(seen > 0, `control: without the pull-back a wrapped tag shows its dot (${seen})`);
    }
    await p.close();
  }
  // A heading of four or five words does not open on one word alone.
  {
    const p = await open("/sell");
    await p.waitForTimeout(300);
    const lone = await p.evaluate(() => [...document.querySelectorAll("main h2")].map((h) => {
      const words = h.textContent.trim().split(/[\s ]+/); if (words.length < 4 || words.length > 5) return null;
      const r = document.createRange(), tw = document.createTreeWalker(h, NodeFilter.SHOW_TEXT); const tops = [];
      for (let n = tw.nextNode(); n; n = tw.nextNode()) for (const m of n.data.matchAll(/[^\s ]+/g)) { r.setStart(n, m.index); r.setEnd(n, m.index + 1); tops.push(Math.round(r.getBoundingClientRect().top)); }
      return tops.length > 1 && tops[1] > tops[0] + 4 ? h.textContent.trim() : null;
    }).filter(Boolean));
    const read = await p.evaluate(() => [...document.querySelectorAll("main h2")].filter((h) => { const n = h.textContent.trim().split(/[\s ]+/).length; return n === 4 || n === 5; }).length);
    ok(read >= 3 && lone.length === 0, `/sell at 375px: no four- or five-word heading opens on one word (${read} read)${lone.length ? `: ${lone.join("; ")}` : ""}`);
    await p.close();
  }
  // /revenue: each row of segments ends inside its card. /status: a reading is never cut.
  {
    const p = await open("/revenue");
    const out = await p.evaluate(() => { const card = document.querySelector(".rvz"); const inner = card.getBoundingClientRect().right - parseFloat(getComputedStyle(card).paddingRight); return [...document.querySelectorAll(".rvz-controls:not(details .rvz-controls) .rvz-seg")].map((s) => Math.round(s.scrollWidth - s.clientWidth) + ":" + Math.round(s.getBoundingClientRect().right - inner)); });
    ok(out.length >= 2 && out.every((v) => { const [over, past] = v.split(":").map(Number); return over <= 0 && past <= 0; }), `/revenue at 375px: the rows of segments fit their card (${out.join(", ")})`);
    const period = await p.evaluate(() => { const s = document.getElementById("rvzWindowText"); const n = s && s.nextSibling; return Boolean(s && n && n.nodeType === 3 && n.data.startsWith(".") && getComputedStyle(s.parentElement).whiteSpace === "nowrap"); });
    ok(period, "/revenue: the period after the window's dates is held to them");
    await p.close();
    const s = await open("/status");
    const cut = await s.evaluate(() => [...document.querySelectorAll(".lrow .lv")].filter((e) => e.scrollWidth > e.clientWidth + 1 || getComputedStyle(e).textOverflow === "ellipsis" || [...e.childNodes].some((n) => { if (n.nodeType !== 3) return false; const r = document.createRange(); for (const m of n.data.matchAll(/[\p{L}\p{N}]{2,}/gu)) { r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); if (r.getClientRects().length > 1) return true; } return false; })).map((e) => e.textContent.trim().slice(0, 30)));
    const rows = await s.evaluate(() => document.querySelectorAll(".lrow .lv").length);
    ok(rows > 3 && cut.length === 0, `/status at 375px: no live reading is cut or split inside a word (${rows} rows)${cut.length ? `: ${cut.join("; ")}` : ""}`);
    await s.close();
  }
  // A name that holds hyphens, and a short camelCase field name, stay whole.
  {
    const whole = async (path, find) => { const p = await open(path); await p.waitForTimeout(300); const n = await p.evaluate((find) => { const tw = document.createTreeWalker(document.querySelector("main"), NodeFilter.SHOW_TEXT); const out = []; for (let t = tw.nextNode(); t; t = tw.nextNode()) { if (t.parentElement.closest("pre")) continue; let at = -1; while ((at = t.data.indexOf(find, at + 1)) >= 0) { const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at + find.length); out.push(new Set([...r.getClientRects()].map((b) => Math.round(b.top))).size); } } return out; }, find); await p.close(); return n; };
    const duns = await whole("/company", "D-U-N-S");
    ok(duns.length >= 1 && duns.every((n) => n === 1), `/company at 375px: D-U-N-S sits on one line (${duns.join(",")})`);
    const field = await whole("/insider-trades-api", "primaryDocument");
    ok(field.length >= 1 && field.every((n) => n === 1), `/insider-trades-api at 375px: primaryDocument is not split (${field.join(",")})`);
  }
  // Skill pack pages: the workflow's step numbers meet WCAG AA contrast in both schemes.
  for (const scheme of ["light", "dark"]) {
    const p = await browser.newPage({ viewport: { width: 375, height: 900 }, colorScheme: scheme });
    await p.goto(`${BASE}/skills/seo-audit`, { waitUntil: "load" });
    const ratio = await p.evaluate(() => {
      const cs = getComputedStyle(document.querySelector(".sk-wf li"), "::before");
      const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const a = lum(cs.color), b = lum(cs.backgroundColor); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    ok(ratio >= 4.5, `/skills/seo-audit (${scheme}): a workflow step number has ${ratio.toFixed(1)}:1 contrast (4.5 or more)`);
    await p.close();
  }
  // Home at 1440px: the people card ends under its buttons, with no empty band above them.
  {
    const p = await open("/", 1440);
    const gap = await p.evaluate(() => { const act = document.querySelector(".hm-door-people .hm-door-act"); return act ? Math.round(act.getBoundingClientRect().top - act.previousElementSibling.getBoundingClientRect().bottom) : null; });
    ok(gap !== null && gap <= 32, `home at 1440px: the people card's buttons follow its text (${gap}px)`);
    await p.close();
  }
  // A changed width re-measures the wraps: a page loaded wide and narrowed
  // reads as the same page loaded narrow. Stale wraps are the control.
  {
    const snap = (p) => p.evaluate(() => document.querySelector("main").innerHTML.replace(/\s(?:tabindex|style|class|data-wbr)="[^"]*"/g, ""));
    for (const path of ["/how-to-pay", "/sell"]) {
      const fresh = await open(path, 375); await fresh.waitForTimeout(400); const want = await snap(fresh); await fresh.close();
      const p = await open(path, 1440); await p.waitForTimeout(400);
      const wide = await snap(p);
      await p.setViewportSize({ width: 375, height: 900 }); await p.waitForTimeout(700);
      const got = await snap(p); await p.close();
      ok(wide !== want, `${path}: the wraps bound at 1440px differ from those at 375px (control)`);
      ok(got === want, `${path}: narrowed from 1440px to 375px, the text is bound as a fresh load at 375px binds it`);
    }
    // A long page (a thousand bound tails) re-measures in short turns: the
    // call returns at once, no turn holds the thread, and the text ends bound
    // as a fresh load binds it, also when the width changes again mid-way.
    {
      const LONG = "/changelog/archive";
      const fresh = await open(LONG, 390); await fresh.waitForTimeout(600); const want = await snap(fresh); await fresh.close();
      const fresh2 = await open(LONG, 414); await fresh2.waitForTimeout(600); const want2 = await snap(fresh2); await fresh2.close();
      const p = await open(LONG, 1440); await p.waitForTimeout(600);
      const edits = await p.evaluate(() => (document.querySelector("main").innerHTML.match(/\u2060|\u00A0|<wbr>/g) || []).length);
      await p.evaluate(() => { window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ["longtask"] }); });
      await p.setViewportSize({ width: 390, height: 900 }); await p.waitForTimeout(2500);
      const got = await snap(p);
      const longest = await p.evaluate(() => Math.round(Math.max(0, ...window.__long)));
      const call = await p.evaluate(() => { const t = []; for (let i = 0; i < 3; i++) { const s = performance.now(); window.a402Rebind(); t.push(performance.now() - s); } return Math.round(t.sort((a, b) => a - b)[1]); });
      await p.waitForTimeout(2500);
      const again = await snap(p);
      ok(edits >= 500, `${LONG} is a long page for the pass (${edits} edits at 1440px)`);
      ok(call < 50 && longest < 300, `${LONG}: a changed width re-measures in short turns (the call returns in ${call} ms, the longest task after the resize ${longest} ms)`);
      ok(got === want && again === want, `${LONG}: narrowed from 1440px to 390px it is bound as a fresh load binds it, and again after three more passes started over each other`);
      await p.setViewportSize({ width: 400, height: 900 }); await p.waitForTimeout(260);
      await p.setViewportSize({ width: 414, height: 900 }); await p.waitForTimeout(2500);
      ok((await snap(p)) === want2, `${LONG}: a width that changes again while a pass runs ends bound for the last width`);
      await p.close();
    }
    const p = await open("/how-to-pay", 1440); await p.waitForTimeout(400);
    const before = await snap(p);
    await p.setViewportSize({ width: 1440, height: 500 }); await p.waitForTimeout(500);
    ok((await snap(p)) === before, "a change of height alone (a phone's address bar) re-measures nothing");
    await p.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
