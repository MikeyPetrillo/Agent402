// The /status daily strip must not push the page sideways on a phone.
//
// Reported from a real handset 2026-09-11: "the status green orange bars go
// off the page". It is arithmetic, not a rendering quirk. The strip is 90
// bars in a flex row; each has min-width 2px and the desktop gap is 2px, so
// its MINIMUM width is 90*2 + 89*2 = 358px, while the phone wrapper leaves
// viewport-36px. Every handset narrower than 394px overflowed - which is most
// of them. A 1px gap under the 640px breakpoint takes the floor to 269px.
//
// Checked in a REAL browser at a real viewport, because the failure is the
// document being wider than the screen, and only layout can tell you that.
// The bars keep their 2px min-width on purpose: thinner reads as a smear, and
// the whole point of the strip is that a bad day is visible.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { chromium } from "playwright-core";

// Drives the LOCAL server and builds the strip itself.
//
// The first cut of this file targeted prod, and that was a deadlock: it asserts
// prod is FIXED, prod cannot be fixed until the change merges, and the test
// blocks the merge. It failed test-sweeps2 on the very PR that fixes the bug.
// A gate that cannot go green until after it has been bypassed is not a gate.
//
// So it renders /status locally for the page's own stylesheet, then injects a
// 90-bar strip into it. That is deterministic, needs no recorded probe
// observations (a FREE_MODE boot has none, which is why prod looked necessary),
// and tests exactly the rule that broke: 90 flex children under the phone
// breakpoint must fit the container the page actually gives them.
const TARGET = process.env.TARGET_URL || "http://localhost:3000";
// DERIVED from the page's own constant, never typed here (2026-09-18): the
// window moved 90 -> 30 and a hardcoded 90 would have kept asserting a strip
// the page no longer renders - passing while measuring nothing real. The
// arithmetic this guards is "N flex children must fit the container the page
// gives them", which holds at any N.
const { STRIP_DAYS } = await import("../src/status.js");
const BARS = STRIP_DAYS;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const browser = await chromium.launch();
try {
  for (const width of [320, 360, 375, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(`${TARGET}/status`, { waitUntil: "domcontentloaded" });

    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    ok(doc.scrollWidth <= doc.clientWidth + 1,
      `${width}px: the page does not scroll sideways (scrollWidth ${doc.scrollWidth} <= clientWidth ${doc.clientWidth})`);

    // Build the strip in the page's own component card, so it inherits the
    // real nested padding (page wrapper + card) that made this overflow.
    const strip = await page.evaluate((n) => {
      const host = document.querySelector(".comp") || document.querySelector(".st-wrap") || document.body;
      const d = document.createElement("div");
      d.className = "bars";
      d.innerHTML = '<i class="b up"></i>'.repeat(n);
      host.appendChild(d);
      const cs = getComputedStyle(d);
      const b0 = d.firstElementChild.getBoundingClientRect();
      return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, gap: cs.columnGap, bars: d.children.length, barWidth: b0.width };
    }, BARS);
    ok(strip.bars === BARS, `${width}px: built a ${BARS}-bar strip (got ${strip.bars})`);
    ok(strip.scrollWidth <= strip.clientWidth + 1,
      `${width}px: ${BARS} bars at gap ${strip.gap} fit their container - ${strip.scrollWidth} <= ${strip.clientWidth}`);
    ok(strip.barWidth >= 1.4, `${width}px: bars stay legible, not hairlines (${strip.barWidth.toFixed(2)}px)`);
    // The bars must still be WIDE enough to read: a strip that fits by
    // collapsing to hairlines would pass the overflow check and fail the
    // reader, which is the whole reason this page exists.
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
