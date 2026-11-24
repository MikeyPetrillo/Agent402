#!/usr/bin/env node
// "A failed call is not charged" on the pages a buyer reads, as served.
//
//   node scripts/test-not-charged-rendered.js     (boots its own FREE_MODE server on port 0)
//
// The source guard (scripts/test-copy-absolutes.js) reads modules and markdown
// and accepts the shared settle-first sentence anywhere near the claim in the
// source. A page that renders only part of an object (the home card shows a
// claim's heading and short line, never its long paragraph) passed it while the
// sentence never reached the page. This guard boots the server, reads each
// page's text as served, and requires the sentence (src/settle-first-copy.js)
// close to every phrasing of the claim (scripts/lib/not-charged-claims.js).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { stripScripts, stripTags } from "./lib/html-text.js";
import { notChargedClaims } from "./lib/not-charged-claims.js";
import { SETTLE_FIRST_MARK, SETTLE_FIRST_TEXT, FAILED_CALL_TEXT } from "../src/settle-first-copy.js";

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) failed++; };

// How close the sentence must be: the claim's own block, in served text.
const BEFORE = 400, AFTER = 700;

/** The visible text of a page, with entities that matter here decoded. */
export function pageText(html) {
  return stripTags(stripScripts(String(html)))
    .replace(/&nbsp;|&#160;/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/⁠/g, "").replace(/\s+/g, " ");
}

/** Each claim on a page with no sentence in reach: [{ at, claim }]. A claim in
 *  a table cell is carried by the sentence in the table or right under it (the
 *  source guard's rule for a table row). */
export function bareClaimsHtml(html) {
  const out = [];
  const TABLE = /<table\b[\s\S]*?<\/table\s*>/gi;
  for (const t of String(html).matchAll(TABLE)) {
    const inTable = pageText(t[0]);
    const under = pageText(String(html).slice(t.index + t[0].length)).slice(0, AFTER);
    if (!(inTable + under).includes(SETTLE_FIRST_MARK)) out.push(...bareClaims(inTable));
  }
  out.push(...bareClaims(pageText(String(html).replace(TABLE, " "))));
  return out;
}

/** Each claim in `text` with no sentence in reach: [{ at, claim }]. */
export function bareClaims(text) {
  const out = [];
  for (const m of text.matchAll(notChargedClaims())) {
    const near = text.slice(Math.max(0, m.index - BEFORE), m.index + m[0].length + AFTER);
    // "refusals are free": a refusal of the payment itself is not this claim.
    if (/\b[Rr]efusals? (?:are|is) free\b/.test(text.slice(Math.max(0, m.index - 120), m.index))) continue;
    if (!near.includes(SETTLE_FIRST_MARK)) out.push({ at: m.index, claim: text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 40) });
  }
  return out;
}

// Controls, offline: the reader finds a bare claim and accepts a carried one.
ok(bareClaims(pageText("<h3>A failed x402 call is not charged.</h3><p>An error cancels settlement.</p>")).length >= 1,
  "control: a bare home-card claim is found in rendered text");
ok(bareClaims(pageText(`<h3>A failed x402 call is not charged.</h3><p>${SETTLE_FIRST_TEXT}</p>`)).length === 0
  && bareClaims(pageText(`<p>A failed call is not charged on x402.</p><p>${FAILED_CALL_TEXT}</p>`)).length === 0,
  "control: a claim with either shared sentence beside it is carried");
ok(bareClaims(pageText(`<p>A failed x402 call is not charged.</p><div>${"x ".repeat(600)}</div><p>${SETTLE_FIRST_TEXT}</p>`)).length === 1,
  "control: a sentence a screen away does not carry the claim");
ok(bareClaimsHtml(`<table><tr><td>Not charged: the error cancels settlement before any facilitator call.</td><td>${"y ".repeat(500)}</td></tr></table><p>${FAILED_CALL_TEXT}</p>`).length === 0
  && bareClaimsHtml(`<table><tr><td>Not charged: the error cancels settlement before any facilitator call.</td></tr></table><p>Read on.</p>`).length === 1,
  "control: a table claim is carried by the sentence under its table, and only by that");

const PAGES = ["/", "/docs", "/how-to-pay", "/faq", "/quickstart", "/start", "/what-is-x402", "/what-is-mpp", "/pricing",
  "/guides/x402-and-mpp", "/docs/MCP-Connector", "/docs/TTS", "/tools/answer", "/tools/search", "/tools/tts", "/tools/json-format", "/tools/screenshot"];

const srv = await bootServer({ env: { FREE_MODE: "true", GATEWAY_SETTLE_FIRST: "" }, stores: "not-charged-rendered" });
try {
  let claims = 0;
  for (const path of PAGES) {
    const r = await fetch(srv.url + path, { redirect: "follow" });
    const html = await r.text();
    if (r.status !== 200) { ok(false, `${path} answers 200 (got ${r.status})`); continue; }
    claims += [...pageText(html).matchAll(notChargedClaims())].length;
    const bare = bareClaimsHtml(html);
    ok(bare.length === 0, `${path}: every not-charged claim carries the settle-first sentence${bare.length ? ` (bare: ${bare.map((b) => JSON.stringify(b.claim)).join("; ")})` : ""}`);
  }
  ok(claims >= 6, `the claim is found on the rendered pages (${claims} places)`);
} finally {
  await srv.stop();
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nnot-charged claims on rendered pages: all carry the settle-first sentence ✓");
