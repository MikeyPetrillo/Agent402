#!/usr/bin/env node
// Phone-width and touch checks the presence review found (real Chromium):
//   - /pricing at 375 px: the paid card's x402 badge does not sit on its label;
//   - /tools: a search with no tool match says so under the box, in a polite
//     live region, and a later match clears it;
//   - arrow links ("… →") on /, /docs and /company are tap targets of 24 px or more;
//   - /reports and /credits set the display serif on the type scale (--fs-4xl), never a 5vw clamp;
//   - /status: a tap on a day strip writes that day's reading under it, and the
//     lead names tap beside hover.
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
      const badge = label && [...label.parentElement.children].find((d) => d.textContent.trim() === "x402" && getComputedStyle(d).position === "absolute");
      const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      // The label's text, not its box: a range over the words.
      const rng = label && document.createRange(); if (rng) rng.selectNodeContents(label);
      return { label: rng ? [...rng.getClientRects()].map((b) => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom })) : [], badge: box(badge) };
    });
    ok(r.badge && r.label.length > 0 && !r.label.some((l) => overlap(l, r.badge)), "/pricing at 375 px: the x402 badge does not overlap the paid card's label");
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
    const box = await p.locator('.bars[data-phone-ux-probe="1"]').boundingBox();
    await p.touchscreen.tap(box.x + box.width * (2.5 / 30), box.y + box.height / 2);
    const read = await p.evaluate(() => { const r = document.querySelector('.bars[data-phone-ux-probe="1"]').nextElementSibling; return r && r.classList.contains("bar-read") ? { t: r.textContent, live: r.getAttribute("aria-live") } : null; });
    ok(read && read.t === "2026-11-03: 100% of 3 probes" && read.live === "polite", `/status: a tap on the strip reads that day under it (${read && read.t})`);
    await p.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
