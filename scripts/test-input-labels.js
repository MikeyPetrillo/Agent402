#!/usr/bin/env node
// Every rendered text, url, search and email input carries an accessible
// name: a <label for> pointing at it, an aria-label or aria-labelledby, or
// aria-hidden when it is a honeypot. A placeholder is not a name. Also pins
// the analytics config: session replay stays off.
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
const PAGES = ["/", "/reports", "/monitors", "/digest", "/company", "/markets", "/marketplace", "/what-is-mpp", "/tools", "/api", "/sell", "/privacy", "/terms"];
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const chrome = readFileSync(new URL("../src/ledger-chrome.js", import.meta.url), "utf8");
ok(/disable_session_recording: true,/.test(chrome) && !/\n\s*session_recording:/.test(chrome), "analytics config: session replay is off and no recording options are set");
const privacy = readFileSync(new URL("../src/privacy.js", import.meta.url), "utf8");
ok(/keeps no session\s+replay/.test(privacy) && !/keeps a\s+session replay/.test(privacy), "privacy page says no session replay is kept");

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const path of PAGES) {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) { ok(false, `${path}: HTTP ${res?.status()}`); continue; }
    const unnamed = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('input[type="text"],input[type="url"],input[type="search"],input[type="email"],input:not([type])')) {
        if (el.getAttribute("aria-hidden") === "true") continue;
        if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) continue;
        if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) continue;
        if (el.closest("label")) continue;
        out.push(el.id || el.name || el.outerHTML.slice(0, 80));
      }
      return out;
    });
    ok(unnamed.length === 0, `${path}: every text input has an accessible name${unnamed.length ? ` (missing: ${unnamed.join(", ")})` : ""}`);
  }
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
