#!/usr/bin/env node
// Copied text reads as the page does: the widow pass (assets/js/site-chrome.js,
// a402BindWidows) puts word joiners (U+2060) and no-break spaces into link and
// paragraph text so a line never ends on one word, and a copy of that text
// must not carry them (a path pasted with a hidden joiner no longer resolves).
//
// Real Chromium: the page runs its own scripts, the test selects a link's text
// and fires a copy, and reads what the page put on the clipboard.
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-copy-joiners.js
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const browser = await chromium.launch();
try {
  // Each page is one where the widow pass edits text at that width (the
  // control below): the copy handler is site-wide, so any such page reads it.
  // The home page's short lead leaves it nothing to join at 375 px.
  for (const [path, width] of [["/how-to-pay", 375], ["/pricing", 375], ["/docs", 1440]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${BASE}${path}`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      // The element the widow pass edited most: the one whose text holds the most joiners.
      const els = [...document.querySelectorAll("main a, main p, main li")].filter((e) => /[⁠ ]/.test(e.textContent));
      els.sort((a, b) => (b.textContent.match(/[⁠ ]/g) || []).length - (a.textContent.match(/[⁠ ]/g) || []).length);
      const el = els[0];
      if (!el) return { found: false };
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      const raw = sel.toString();
      const dt = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
      return { found: true, raw, copied: dt.getData("text/plain") };
    });
    ok(r.found && /[⁠ ]/.test(r.raw), `${path} at ${width}px: the widow pass left joiners or no-break spaces in the page text (control)`);
    ok(r.found && r.copied.length > 0 && !/[⁠ ]/.test(r.copied) && r.copied === r.raw.replace(/⁠/g, "").replace(/ /g, " "), `${path} at ${width}px: the copied text carries none of them (${JSON.stringify((r.copied || "").slice(0, 60))})`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
