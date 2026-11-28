#!/usr/bin/env node
// The phone path, without a phone: what a first-time visitor does from a
// phone, at 375 px in Chromium with touch, in one command.
//
//   TARGET_URL=https://agent402.tools node scripts/phone-path-check.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/phone-path-check.js
//
//   1. /start: tap the Copy button on the Claude desktop step; the clipboard
//      holds the hosted connector address, the button is a 44 px target, and
//      the page fits the width.
//   2. The copied connector answers: initialize, then one free tool call
//      (hash, the sample prompt's tool) returns the known digest. When /start
//      names the credits connector (credits on sale and the sign-in on), the
//      free call goes to the free connector, which needs no sign-in.
//   3. /recipes: fits the width, every Copy button is a 44 px target, a tap
//      copies its prompt, and every tool page it links answers 200.
//
// Requests: a handful of page loads, two MCP posts and one GET per linked tool
// page; the one tool call is a free one, so nothing is paid. Prints one line
// per check and exits 1 on any failure (scripts/test-phone-path-check.js).
import { chromium } from "playwright";

const BASE = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const WIDTH = 375;
const HASH_OF_HELLO_WORLD = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

/** One JSON-RPC post to a connector address; an event-stream answer is read as JSON. */
async function rpc(url, method, params, id) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  let t = await r.text();
  if ((r.headers.get("content-type") || "").startsWith("text/event-stream")) t = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: null }; }
}

/** The page fits the phone's width, and every Copy button in main is at least 44 by 44. */
async function measure(page) {
  return page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    buttons: [...document.querySelectorAll("main .ml-code-copy")].map((b) => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height }; }),
  }));
}

/** Tap a Copy button and read what the clipboard holds, beside the block's own text. */
async function tapCopy(page, selector) {
  const block = page.locator(selector).first();
  const want = (await block.locator("pre").textContent()) || "";
  await block.locator(".ml-code-copy").tap();
  await page.waitForFunction((sel) => /Copied/.test(document.querySelector(sel)?.querySelector(".ml-code-copy")?.textContent || ""), selector, { timeout: 5_000 }).catch(() => {});
  const got = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  return { want, got };
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(BASE).origin });
  const page = await context.newPage();

  // 1. /start: copy the connector address.
  const start = await page.goto(`${BASE}/start`, { waitUntil: "load" });
  ok(start?.status() === 200, `/start opens at ${WIDTH} px (${start?.status()})`);
  let connector = "";
  {
    const m = await measure(page);
    ok(m.overflow <= 0, `/start fits ${WIDTH} px (${m.overflow > 0 ? `${m.overflow} px too wide` : "no sideways scroll"})`);
    const { want, got } = await tapCopy(page, "#claude-desktop .ml-code");
    connector = got.trim();
    ok(connector.length > 0 && connector === want.trim() && /^https?:\/\/[^\s]+\/mcp(\/credits)?$/.test(connector), `a tap on the Claude desktop step copies the connector address (${connector || "nothing copied"})`);
    const btn = await page.locator("#claude-desktop .ml-code-copy").boundingBox();
    ok(Boolean(btn) && btn.width >= 44 && btn.height >= 44, `its Copy button is a 44 px target (${btn ? `${Math.round(btn.width)}x${Math.round(btn.height)}` : "missing"})`);
  }

  // 2. The copied connector answers a free call. A page served under another
  // public address than the target (a local boot) is called on the target.
  if (connector) {
    const copied = new URL(connector);
    const freePath = copied.pathname === "/mcp/credits" ? "/mcp" : copied.pathname;
    const url = copied.origin === new URL(BASE).origin ? `${copied.origin}${freePath}` : `${BASE}${freePath}`;
    if (url !== connector) console.log(`# calling ${url} (the page names ${connector})`);
    const init = await rpc(url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "phone-path-check", version: "1.0.0" } }, 1);
    ok(init.status === 200 && init.json?.result?.serverInfo?.name === "agent402", `the connector answers initialize (${init.status})`);
    const call = await rpc(url, "tools/call", { name: "catalog.call", arguments: { slug: "hash", params: { text: "hello world" } } }, 2);
    const text = (call.json?.result?.content || []).map((c) => c.text || "").join("").replace(/\s+/g, " ");
    ok(call.status === 200 && call.json?.result && !call.json.result.isError && text.includes(HASH_OF_HELLO_WORLD), `a free hash call through it returns the digest (${text.slice(0, 80) || JSON.stringify(call.json?.error || call.status)})`);
  }

  // 3. /recipes: copy a prompt.
  const recipes = await page.goto(`${BASE}/recipes`, { waitUntil: "load" });
  ok(recipes?.status() === 200, `/recipes opens at ${WIDTH} px (${recipes?.status()})`);
  if (recipes?.status() === 200) {
    const m = await measure(page);
    ok(m.overflow <= 0, `/recipes fits ${WIDTH} px (${m.overflow > 0 ? `${m.overflow} px too wide` : "no sideways scroll"})`);
    const small = m.buttons.filter((b) => b.w < 44 || b.h < 44);
    ok(m.buttons.length > 0 && small.length === 0, `its ${m.buttons.length} Copy buttons are 44 px targets${small.length ? ` (${small.length} smaller)` : ""}`);
    const { want, got } = await tapCopy(page, "main .ml-code");
    ok(want.trim().length > 0 && got === want, `a tap copies the first prompt (${got.slice(0, 60) || "nothing copied"})`);
    const tools = [...new Set(await page.$$eval('main a[href^="/tools/"]', (as) => as.map((a) => a.getAttribute("href"))))];
    ok(tools.length > 0, `it links ${tools.length} tool pages`);
    for (const href of tools) {
      const r = await fetch(`${BASE}${href}`);
      await r.arrayBuffer();
      ok(r.status === 200, `${href} answers 200 (${r.status})`);
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed (phone path at ${WIDTH} px, ${BASE})`);
process.exit(fail ? 1 : 0);
