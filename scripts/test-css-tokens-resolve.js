// Every custom property declared in ledger-chrome.js's :root must actually
// resolve to a real value in a real browser - not just be present as text in
// the served HTML.
//
// Found live 2026-08-16: a WCAG-contrast fix added a JS-style `//` comment
// INSIDE the :root {} block (invalid CSS - comments must be /* */). The
// browser's CSS parser silently swallowed every declaration from that point
// to the closing brace (--green, --hairline, --dash, --on-dark, --on-dark2,
// --dk-muted/2/3, --surface, even --font-body/--font-mono) - a site-wide
// regression that shipped to production for one deploy cycle before being
// caught. The prior --faint test only did static regex extraction on the
// source text, which can never catch a CSS PARSE failure - the string
// "--green: #3E9B6E;" is right there in the file either way, parser error or
// not. Only an actual browser evaluating actual CSS can catch this class.
//
// Requires a booted server (same TARGET_URL convention as other page tests):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-css-tokens-resolve.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../src/ledger-chrome.js", import.meta.url), "utf8");
const rootMatch = src.match(/:root\s*\{([\s\S]*?)\n\}/);
ok(!!rootMatch, "found the :root {} block in ledger-chrome.js");
const rootBody = rootMatch ? rootMatch[1] : "";
const tokenNames = [...rootBody.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]);
ok(tokenNames.length >= 20, `extracted a substantial token list from :root (got ${tokenNames.length})`);
// Sanity the extractor isn't blind - these are known, long-standing tokens
// that must always be in the list if the regex is working at all.
for (const must of ["accent", "paper", "card", "ink", "faint"]) {
  ok(tokenNames.includes(must), `token extraction sees the known token --${must} (extractor is not blind)`);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  // Check on a real page, not a blank one - the homepage loads ledger-chrome
  // the same way every other page does.
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  const values = await page.evaluate((names) => {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const n of names) out[n] = cs.getPropertyValue("--" + n).trim();
    return out;
  }, tokenNames);

  const broken = tokenNames.filter((n) => !values[n]);
  ok(broken.length === 0, `every :root token resolves to a non-empty value in a real browser${broken.length ? ` - BROKEN: ${broken.map((n) => "--" + n).join(", ")}` : ""}`);

  // font-body/font-mono resolving is itself a real, separate signal: those
  // are the LAST two declarations before the closing brace, so if a CSS
  // parse error anywhere earlier in the block silently swallowed the rest,
  // these are the two most likely to still show broken.
  ok(!!values["font-body"] && !!values["font-mono"], `--font-body and --font-mono resolve (last declarations in the block - proves the parser reached the end)`);
} finally {
  await browser.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
