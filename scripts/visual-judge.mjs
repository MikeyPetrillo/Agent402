#!/usr/bin/env node
// Visual review of the site's pages with Jev's image questions (2026-10-15).
// Renders each page at desktop and phone width, sends the screenshot to Jev
// as an image, and asks typed questions a layout bug answers "yes" to:
// overlapping or cut-off text, a broken or unstyled layout, text that is
// hard to read against its background. Prints every page a question flags.
//
// Run by hand, not in CI: it calls the upstream with our key, and CI never
// spends upstream. Local server or production pages both work.
//
//   TYPESAFE_API_KEY=... node scripts/visual-judge.mjs --base http://127.0.0.1:3000 [--pages /,/tools,/pricing] [--threshold 0.5]
import { chromium } from "playwright";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg("base", "http://127.0.0.1:3000").replace(/\/$/, "");
const THRESHOLD = Number(arg("threshold", "0.5"));
const DEFAULT_PAGES = ["/", "/tools", "/pricing", "/reports", "/marketplace", "/docs", "/sell", "/status", "/company", "/privacy", "/terms", "/why", "/what-is-x402", "/guides/agent-hosts", "/tools/judge-vision"];
const PAGES = arg("pages", "") ? arg("pages", "").split(",") : DEFAULT_PAGES;
const KEY = (process.env.TYPESAFE_API_KEY || "").trim();
if (!KEY) { console.error("visual-judge: set TYPESAFE_API_KEY"); process.exit(2); }
const MODEL = (process.env.JEV_MODEL || "jev-1.13.0").trim();

const QUESTIONS = {
  // A code block or table that scrolls sideways is cut at its edge by design;
  // without the second sentence the model reads every one as a bug.
  overlap: { type: "noul", instructions: "In `page`, does any text overlap other text or an element, or get cut off by its box? A code block or table that continues off its right edge because it scrolls sideways is normal and does not count." },
  broken: { type: "noul", instructions: "Does `page` look broken: unstyled content, a large empty area where content should be, elements stacked on top of each other, or a layout that is clearly not what a designer intended?" },
  contrast: { type: "noul", instructions: "Is any body text or button label in `page` hard to read because its color is too close to the color behind it?" },
};

async function ask(pngBase64) {
  const ref = `img-${Math.random().toString(36).slice(2)}`;
  const r = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "TypeSafe-Danger-Zone-Images": "true" },
    body: JSON.stringify({ model: MODEL, state: { page: ref }, assets: { [ref]: { type: "image", format: "png", data_base64: pngBase64 } }, questions: QUESTIONS }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`upstream ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return { answers: j.answers || {}, tokens: j.usage?.input_tokens || 0 };
}

const browser = await chromium.launch();
const flagged = [];
let tokens = 0;
for (const [label, viewport] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  for (const path of PAGES) {
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(800);
      const png = (await page.screenshot({ type: "png" })).toString("base64");
      const { answers, tokens: t } = await ask(png);
      tokens += t;
      const hits = Object.entries(answers).filter(([, a]) => typeof a?.noul === "number" && a.noul >= THRESHOLD).map(([k, a]) => `${k} ${a.noul.toFixed(2)}`);
      console.log(`${hits.length ? "FLAG" : "ok  "} ${label.padEnd(7)} ${path}${hits.length ? `  -> ${hits.join(", ")}` : ""}`);
      if (hits.length) flagged.push({ label, path, hits });
    } catch (e) {
      console.log(`ERR  ${label.padEnd(7)} ${path}  ${String(e?.message || e).slice(0, 140)}`);
    } finally { await page.close(); }
  }
  await ctx.close();
}
await browser.close();
console.log(`\nvisual-judge: ${flagged.length} flagged of ${PAGES.length * 2} renders; ${tokens} input tokens`);
process.exit(0);
