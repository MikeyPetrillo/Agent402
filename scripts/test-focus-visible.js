// Locks the focus-visible fix (2026-08-16 audit): four prominent search/demo
// inputs stripped outline:none with no replacement, unlike 7 other inputs in
// the same codebase that already use a :focus{border-color:var(--accent)}
// pattern. Verified via a REAL browser (Playwright) - a lesson learned the
// hard way earlier the same day: static regex on the source text cannot
// prove a CSS rule actually applies (see test-css-tokens-resolve.js's own
// header comment for the incident this guards against generalizing).
//
// Requires a booted server (same TARGET_URL convention as other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-focus-visible.js
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  // Each case: [page path, input selector, element to read the border color
  // from (the input itself, or its focus-within wrapper)].
  const CASES = [
    { path: "/tools", input: "#cat-search", borderEl: ".cat-search-wrap", label: "/tools catalog search" },
    { path: "/marketplace", input: "form.mkt-search-wrap input[name='q']", borderEl: "form.mkt-search-wrap", label: "/marketplace search" },
    { path: "/base", input: "form.mkt-search-wrap input[name='q']", borderEl: "form.mkt-search-wrap", label: "/base (per-chain) search" },
  ];

  for (const c of CASES) {
    await page.goto(`${BASE}${c.path}`, { waitUntil: "load" });
    const input = page.locator(c.input).first();
    const borderTarget = page.locator(c.borderEl).first();
    ok(await input.count() > 0, `${c.label}: input is present`);
    const before = await borderTarget.evaluate((el) => getComputedStyle(el).borderColor);
    await input.focus();
    const after = await borderTarget.evaluate((el) => getComputedStyle(el).borderColor);
    ok(before !== after, `${c.label}: border color visibly changes on focus (${before} -> ${after})`);
    // Confirm it's the ACCENT token specifically (read live from :root, so a
    // palette change cannot desync this test), not just "some change" (e.g. an
    // unrelated hover rule coincidentally firing).
    const accent = await page.evaluate(() => { const d = document.createElement("div"); d.style.color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(); document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; });
    ok(after === accent, `${c.label}: focused border is the accent color specifically (got ${after}, accent ${accent})`);
  }
} finally {
  await browser.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
