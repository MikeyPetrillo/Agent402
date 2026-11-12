#!/usr/bin/env node
// Rendered accessibility checks for the shared controls (DESIGN.md "Controls
// and focus", "Code blocks", "Forms"), read in a real browser in both themes:
//   - the skip link is the first focusable element and lands on <main>;
//   - every focusable element in the nav, main and footer shows a 2px focus
//     ring at 3:1 or more against the ground it sits on;
//   - the boundary of every text input, select and outlined button is 3:1 or
//     more against its ground (WCAG 1.4.11);
//   - links and buttons in the nav, the footer, tool pages and forms are at
//     least 24x24 CSS px, or spaced so a 24px box around each touches no other
//     target (WCAG 2.5.8); a link inside a sentence is exempt;
//   - every code block carries a keyboard-reachable copy button that copies
//     the block and announces it through a live region, and the served HTML
//     (no script) holds the plain <pre> with no button;
//   - prose on long-form pages is set at the prose step (16px);
//   - the card storefront forms tie a visible label to each field and the
//     error line to the field by aria-describedby; no checkout starts here.
//
// Requires a booted server (same TARGET_URL convention as other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-a11y-controls.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { chromium } from "playwright";
import { stripScripts } from "./lib/html-text.js";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const list = (xs, n = 6) => xs.slice(0, n).join(" | ") + (xs.length > n ? ` | ... ${xs.length - n} more` : "");

const TOOL = "/tools/json-validate";
const GUIDE = "/guides/x402-in-5-minutes";
const PAGES = ["/", TOOL, "/docs", "/docs/Architecture", GUIDE, "/how-to-pay", "/reports", "/monitors", "/pricing"];
const CODE_PAGES = [TOOL, "/docs", "/docs/Architecture", GUIDE, "/how-to-pay", "/", "/what-is-x402", "/quickstart", "/integrations/openai", "/learn/mpp"];
const PROSE_PAGES = [[GUIDE, ".gp-body p"], ["/docs/Architecture", ".ml-docs-main p"]];
const FORM_PAGES = ["/reports", "/monitors"];

// In-page helpers, installed once per document.
const HELPERS = () => {
  const parse = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  // The grounds an element sits on: walk up to the first opaque color, or the
  // stops of a gradient ground (the milled and obsidian surfaces).
  const grounds = (el, from = el) => {
    const layers = [];
    for (let a = from; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (/gradient/.test(cs.backgroundImage)) {
        const stops = [...cs.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0])).filter((c) => c && c.a > 0.5);
        if (stops.length) return stops.map((s) => layers.reduceRight((acc, l) => over(l, acc), { ...s, a: 1 }));
      }
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.99) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return [base];
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; };
  window.__a11y = { parse, ratio, grounds, visible };
};

const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    if (theme === "dark") await ctx.addInitScript(() => { try { localStorage.setItem("a402-theme", "dark"); } catch {} });
    await ctx.addInitScript(HELPERS);
    // Nothing on these pages may start a checkout: any request to the buy or
    // subscribe endpoints is refused here and counted.
    let checkoutCalls = 0;
    await ctx.route(/\/api\/(buy|subscribe|monitors\/subscribe|checkout)/, (r) => { checkoutCalls++; return r.abort(); });
    const page = await ctx.newPage();
    for (const path of PAGES) {
      const res = await page.goto(`${BASE}${path}`, { waitUntil: "load" });
      if (!res || res.status() !== 200) { ok(false, `[${theme}] ${path}: HTTP ${res?.status()}`); continue; }
      await page.waitForTimeout(0);

      // Skip link: the first Tab lands on it, it shows, and it targets <main>.
      await page.keyboard.press("Tab");
      const skip = await page.evaluate(() => {
        const a = document.activeElement;
        const href = a && a.getAttribute("href");
        const target = href && href.startsWith("#") ? document.getElementById(href.slice(1)) : null;
        const r = a ? a.getBoundingClientRect() : null;
        return { tag: a && a.tagName, href, text: a && a.textContent.trim(), targetTag: target && target.tagName, shown: !!r && r.width > 0 && r.top >= 0 && r.bottom <= innerHeight };
      });
      ok(skip.tag === "A" && skip.targetTag === "MAIN" && skip.shown, `[${theme}] ${path}: the first Tab is a visible skip link to <main> (${JSON.stringify(skip)})`);

      // Focus ring on every focusable element in nav, main and footer.
      const ring = await page.evaluate(() => {
        const { ratio, grounds, visible, parse } = window.__a11y;
        const bad = [];
        let n = 0;
        const els = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex='-1'])")].filter((e) => e.closest("nav, main, footer") && visible(e) && !e.disabled);
        for (const el of els.slice(0, 500)) {
          el.focus({ preventScroll: true });
          if (document.activeElement !== el) continue;
          n++;
          const cs = getComputedStyle(el);
          const w = parseFloat(cs.outlineWidth) || 0;
          const col = parse(cs.outlineColor);
          // The ring sits outside the element (2px offset), on its parent's ground.
          const worst = col ? Math.min(...grounds(el, el.parentElement).map((g) => ratio(col, g))) : 0;
          if (cs.outlineStyle === "none" || w < 2 || worst < 3) bad.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/)[0] : ""} "${(el.textContent || el.getAttribute("aria-label") || el.name || "").trim().slice(0, 24)}" ${cs.outlineStyle} ${w}px ${worst.toFixed(2)}:1`);
        }
        document.activeElement && document.activeElement.blur();
        return { n, bad };
      });
      ok(ring.n > 0 && ring.bad.length === 0, `[${theme}] ${path}: ${ring.n} focusable elements show a 2px focus ring at 3:1 or more${ring.bad.length ? ` (${ring.bad.length} do not: ${list(ring.bad)})` : ""}`);

      // Control boundaries: inputs, selects and outlined buttons.
      const bounds = await page.evaluate(() => {
        const { ratio, grounds, visible, parse } = window.__a11y;
        const bad = [];
        let n = 0;
        const els = [...document.querySelectorAll("input[type=text], input[type=email], input[type=search], input[type=url], input:not([type]), select, textarea, .btn-secondary")].filter((e) => visible(e) && e.closest("main, nav, footer"));
        for (const el of els) {
          // A borderless field inside a bordered wrapper is bounded by the wrapper.
          let box = el;
          for (let i = 0; i < 2 && box && parseFloat(getComputedStyle(box).borderTopWidth) === 0; i++) box = box.parentElement;
          if (!box || parseFloat(getComputedStyle(box).borderTopWidth) === 0) { bad.push(`${el.tagName.toLowerCase()}#${el.id || el.name || ""} has no boundary`); continue; }
          n++;
          const col = parse(getComputedStyle(box).borderTopColor);
          const outside = Math.min(...grounds(box, box.parentElement).map((g) => ratio(col, g)));
          if (outside < 3) bad.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : el.className ? "." + String(el.className).split(/\s+/)[0] : ""} ${outside.toFixed(2)}:1`);
        }
        return { n, bad };
      });
      if (bounds.n || bounds.bad.length) ok(bounds.bad.length === 0, `[${theme}] ${path}: ${bounds.n} control boundaries clear 3:1 against their ground${bounds.bad.length ? ` (${list(bounds.bad)})` : ""}`);

    }

    // Target size, at desktop and phone width (light theme only: geometry does
    // not change with the theme). Every target in the nav, the footer, a tool
    // page's body and a form is at least 24x24; a link inside a sentence is exempt.
    if (theme === "light") {
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of PAGES) {
          await page.goto(`${BASE}${path}`, { waitUntil: "load" });
          if (width < 1100) { await page.click(".ml-burger"); }
          const small = await page.evaluate((isTool) => {
            const { visible } = window.__a11y;
            const inSentence = (a) => {
              const blk = a.parentElement && a.parentElement.closest("p, li, dd, td, figcaption, blockquote");
              if (!blk) return false;
              const text = blk.textContent.replace(/\s+/g, " ").trim();
              const own = a.textContent.replace(/\s+/g, " ").trim();
              return text.length > own.length + 12;
            };
            const scope = (e) => e.closest("nav, footer, .ml-mobile-menu") || (isTool && e.closest("main")) || e.closest("form, .pcard, .field, .manage");
            const targets = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select")].filter((e) => visible(e) && scope(e) && !(e.tagName === "A" && inSentence(e)) && !e.closest("pre"));
            const bad = [];
            for (const el of targets) {
              const r = el.getBoundingClientRect();
              if (r.width >= 24 && r.height >= 24) continue;
              bad.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
            }
            return { n: targets.length, bad };
          }, path.startsWith("/tools/"));
          ok(small.n > 0 && small.bad.length === 0, `${path} at ${width}px: ${small.n} nav, footer, tool-page and form targets are at least 24x24${small.bad.length ? ` (${small.bad.length} are not: ${list(small.bad, 10)})` : ""}`);
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    // Code blocks: every <pre> in main sits in the shared component with a copy button.
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(BASE).origin });
    for (const path of CODE_PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: "load" });
      const blocks = await page.evaluate(() => {
        const pres = [...document.querySelectorAll("main pre")].filter((p) => window.__a11y.visible(p));
        const missing = pres.filter((p) => { const w = p.closest(".ml-code"); return !w || !w.querySelector("button.ml-code-copy"); }).map((p) => p.textContent.trim().slice(0, 30));
        // One block, one button: a block never sits inside another.
        const doubled = [...document.querySelectorAll("main .ml-code")].filter((b) => b.parentElement.closest(".ml-code") || b.querySelectorAll("button.ml-code-copy").length !== 1).length;
        return { n: pres.length, missing, doubled, live: !!document.querySelector("[aria-live].ml-code-live, .ml-code-live[aria-live]") };
      });
      if (path === "/") { ok(blocks.missing.length === 0, `[${theme}] /: every code block has a copy button (${blocks.n} blocks)`); continue; }
      ok(blocks.n > 0 && blocks.missing.length === 0, `[${theme}] ${path}: all ${blocks.n} code blocks carry a copy button${blocks.missing.length ? ` (missing on: ${list(blocks.missing)})` : ""}`);
      ok(blocks.doubled === 0, `[${theme}] ${path}: no code block is nested in another and each has one copy button (${blocks.doubled} are not)`);
      if (!blocks.n || blocks.missing.length) continue;
      ok(blocks.live, `[${theme}] ${path}: a polite live region announces the copy`);
      if (theme !== "light") continue;
      // Keyboard: Tab reaches the button; Enter copies the block's own text and announces it.
      const btn = page.locator("main .ml-code button.ml-code-copy").first();
      const name = await btn.evaluate((b) => b.getAttribute("aria-label") || b.textContent.trim());
      ok(/copy/i.test(name), `${path}: the copy button has an accessible name ("${name}")`);
      await btn.focus();
      ok(await btn.evaluate((b) => document.activeElement === b && b.tabIndex >= 0), `${path}: the copy button takes keyboard focus`);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => /copied/i.test((document.querySelector(".ml-code-live") || {}).textContent || ""), null, { timeout: 5000 }).catch(() => {});
      const after = await page.evaluate(async () => ({ live: (document.querySelector(".ml-code-live") || {}).textContent || "", clip: await navigator.clipboard.readText().catch(() => null), text: document.querySelector("main .ml-code pre").textContent }));
      ok(/copied/i.test(after.live), `${path}: the live region says the code was copied ("${after.live}")`);
      ok(after.clip === after.text, `${path}: the clipboard holds the block's text exactly`);
      // No script: the served HTML is the plain block, no dead button.
      const raw = await (await fetch(`${BASE}${path}`)).text();
      ok(/<pre\b/.test(raw) && !/ml-code-copy/.test(stripScripts(raw)), `${path}: without script the block is a plain <pre> with no button in the HTML`);
    }

    // Prose step on long-form pages.
    if (theme === "light") {
      for (const [path, sel] of PROSE_PAGES) {
        await page.goto(`${BASE}${path}`, { waitUntil: "load" });
        const fs = await page.evaluate((s) => { const p = document.querySelector(s); return p ? { size: getComputedStyle(p).fontSize, token: getComputedStyle(document.documentElement).getPropertyValue("--fs-prose").trim() } : null; }, sel);
        ok(fs && fs.size === "16px" && fs.token === "16px", `${path}: prose (${sel}) is set at the 16px prose step (${JSON.stringify(fs)})`);
      }
    }

    // Storefront forms: a visible label per field, the error tied by aria-describedby.
    for (const path of FORM_PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: "load" });
      const f = await page.evaluate(() => {
        const bad = [];
        const fields = [...document.querySelectorAll(".pcard input, .manage input")];
        for (const el of fields) {
          const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (!lab || !window.__a11y.visible(lab) || !lab.textContent.trim()) bad.push(`${el.id || el.name}: no visible <label for>`);
          const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
          const errs = ids.map((i) => document.getElementById(i)).filter(Boolean);
          if (!errs.length) bad.push(`${el.id || el.name}: no aria-describedby target`);
          else if (!errs.some((e) => e.getAttribute("aria-live") || /^(alert|status)$/.test(e.getAttribute("role") || ""))) bad.push(`${el.id || el.name}: the described error line is not announced`);
          if (!el.closest("form")) bad.push(`${el.id || el.name}: not inside a <form>`);
        }
        return { n: fields.length, bad };
      });
      ok(f.n > 0 && f.bad.length === 0, `[${theme}] ${path}: ${f.n} fields have a visible label and an announced error line${f.bad.length ? ` (${list(f.bad)})` : ""}`);
    }
    if (theme === "light") {
      // Enter on an empty field shows the error in the described line and keeps focus on the field; nothing is sent.
      await page.goto(`${BASE}/reports`, { waitUntil: "load" });
      const input = page.locator(".pcard input").first();
      await input.focus();
      await page.keyboard.press("Enter");
      const e = await page.evaluate(() => { const el = document.activeElement; const id = (el.getAttribute("aria-describedby") || "").split(/\s+/)[0]; const err = id && document.getElementById(id); return { focusedInput: el.tagName === "INPUT", err: err ? err.textContent.trim() : "", invalid: el.getAttribute("aria-invalid") }; });
      ok(e.focusedInput && e.err.length > 0 && e.invalid === "true", `/reports: Enter on an empty field shows its error, marks it invalid and keeps focus (${JSON.stringify(e)})`);
    }
    ok(checkoutCalls === 0, `[${theme}] no checkout request was sent (${checkoutCalls})`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
