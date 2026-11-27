// The home page and the hub pages (/sell, /docs) are short answers first.
// Two budgets per page, both in words a reader sees (scripts/lib/page-words.js, its "visible" mode):
//
//   top   every visible word above the first h2: the h1, the lead paragraphs,
//         button and link labels, kickers, and the labels and cells of any
//         figure beside them (the home page's live panel with its figure
//         labels, /sell's cost table, the label of /docs' terminal block).
//         At most TOP_MAX[page].
//   body  every visible word on the page. At most BODY_MAX.
//
// Counted: headings, paragraphs, list items, table cells, button and link
// labels, a closed <details>' summary, and blocks served `hidden` that a
// script shows when their data loads. Not counted: code (pre, code),
// navigation (nav, aside: breadcrumbs, the docs sidebar), aria-hidden and
// screen-reader-only text, the body of a closed <details>, attribute text
// (placeholders, titles) and the site footer.
//
// Each top limit is the page's largest measured count across the switch
// states rendered below, rounded up to the next 10. A page that grows past
// its limit is trimmed; the limit is not raised to fit new copy.
// Long detail lives on a linked page, or collapsed where it is optional.
//
// Boots a FREE_MODE server on port 0 and reads the pages it serves; with
// TARGET_URL set it reads that server instead (a copy under a mutation, or a
// boot of another revision).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { visiblePageWords as pageWords, countVisibleWords as countWords } from "./lib/page-words.js";
import { ownStoreEnv } from "./lib/own-stores.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOP_MAX = { "/": 110, "/sell": 80, "/docs": 50 };
const BODY_MAX = 700;
const PAGES = ["/", "/sell", "/docs"];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the counter itself ---------------------------------------------------
{
  const page = (inner) => `<nav>site nav words here</nav><main id="main">${inner}</main><footer>footer words</footer>`;
  const w = pageWords(page(`<h1>One two</h1><p>three four five</p><pre>code code</pre><h2>Six</h2><p>seven <code>x</code> eight</p><details><summary>nine ten</summary><p>hidden hidden hidden</p></details><details open><summary>eleven</summary><p>twelve</p></details><aside>sidebar words</aside>`));
  ok(w.topWords === 5, `top counts the h1 and the paragraph above the first h2, never the code (${w.topWords})`);
  ok(w.bodyWords === 12, `body counts headings and prose, a closed details' summary and an open one's body, never code, nav, aside or the footer (${w.bodyWords})`);
  ok(countWords("a -> b · c 500+ $0.01") === 5, "a word holds a letter or a digit; arrows and dots are not words");
  // What a reader meets above the first h2 beyond paragraphs: a button, a
  // kicker, a figure's labels and cells, and a block a script shows.
  const hero = pageWords(page(`<nav>crumb crumb</nav><h1>Big title</h1><p>lead <code>x</code> words</p><a class="btn">Start now</a><div class="kicker">For agents</div><table><tr><th>fee</th><td>$0</td></tr></table><div hidden><span>payments settled</span></div><span aria-hidden="true">decor decor</span><span class="sr-only">reader only</span><div style="display:none">gone gone</div><details><summary>more</summary><div><p>closed body</p></div></details><h2>Next</h2><p>below</p>`));
  ok(hero.topWords === 13, `top counts headings, lead, button, kicker, figure cells, a script-shown block and a closed details' summary (${hero.topWords}: ${hero.topText})`);
  ok(!/crumb|decor|reader only|gone|closed body|below|Next/.test(hero.topText), "top leaves out nav, aria-hidden, screen-reader-only, display:none, a closed details' body and everything from the first h2 on");
  const noH2 = pageWords(page(`<h1>Only</h1><p>two words</p>`));
  ok(noH2.topWords === 3 && noH2.bodyWords === 3, "a page with no h2 is all top");
}

let proc = null;
let BASE = process.env.TARGET_URL ? process.env.TARGET_URL.replace(/\/$/, "") : null;
if (!BASE) {
  proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: { ...process.env, ...ownStoreEnv("hub-words"), FREE_MODE: "true", PORT: "0", X402_SYNC_ON_START: "false" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let log = "";
  proc.stdout.on("data", (d) => { if (!BASE) log = (log + d).slice(-20_000); });
  for (let i = 0; i < 180 && !BASE; i++) { const m = log.match(/listening on :(\d+)/); if (m) BASE = `http://127.0.0.1:${m[1]}`; else await sleep(500); }
  if (!BASE) { console.error(`FAIL - the server never printed its port:\n${log.slice(-600)}`); proc.kill("SIGKILL"); process.exit(1); }
}

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }
  for (const path of PAGES) {
    const res = await fetch(`${BASE}${path}`);
    const html = await res.text();
    ok(res.status === 200 && html.includes("<main"), `${path} serves a page with a <main> (${res.status})`);
    const { topWords, bodyWords } = pageWords(html);
    ok(topWords > 0 && topWords <= TOP_MAX[path], `${path}: ${topWords} visible words above the first h2 (at most ${TOP_MAX[path]})`);
    ok(bodyWords > 100 && bodyWords <= BODY_MAX, `${path}: ${bodyWords} words a reader sees without opening anything (at most ${BODY_MAX})`);
  }

  // The switches a free-mode boot leaves off but production runs with: the
  // signed-receipt clause in the home lead, and the Decide section on /docs.
  // Rendered from this tree's modules over the served catalog.
  {
    const { ledgerHomePage } = await import("../src/ledger-home.js");
    const { ledgerDocsPage } = await import("../src/ledger-docs.js");
    const { gatewayProductSentence } = await import("../src/gateway-product-copy.js");
    const { receiptsServed } = await import("../src/receipt-signing.js");
    const { endpoints = [] } = await (await fetch(`${BASE}/api/pricing`)).json();
    const catalog = Object.fromEntries(endpoints.map((t) => [`${t.method} ${t.path}`, { ...t, route: `${t.method} ${t.path}` }]));
    ok(Object.keys(catalog).length > 100, `the served catalog was read (${Object.keys(catalog).length} tools)`);
    for (const opts of [{ receipts: true, mpp: true }, { receipts: true, mpp: false }, { receipts: false, mpp: true }, { receipts: false, mpp: false }]) {
      const home = pageWords(ledgerHomePage("https://agent402.tools", catalog, {}, {}, [], opts));
      ok(home.topWords > 0 && home.topWords <= TOP_MAX["/"] && home.bodyWords <= BODY_MAX, `/ with signed receipts ${opts.receipts ? "on" : "off"} and MPP ${opts.mpp ? "on" : "off"}: ${home.topWords} top words (at most ${TOP_MAX["/"]}), ${home.bodyWords} body words`);
    }
    const withDecide = { ...catalog, "POST /api/decide": catalog["POST /api/decide"] || { slug: "decide", price: "$0.01", route: "POST /api/decide" } };
    const docs = ledgerDocsPage("https://agent402.tools", withDecide);
    const d = pageWords(docs);
    // With no signing key here, the gateway sentence on /docs is the shorter
    // receipts-off form: the words the signed form adds are counted in.
    const signedExtra = receiptsServed() ? 0 : countWords(gatewayProductSentence({ receipts: true })) - countWords(gatewayProductSentence({ receipts: false }));
    ok(/id="decide"/.test(docs) && d.topWords <= TOP_MAX["/docs"] && d.bodyWords + signedExtra <= BODY_MAX, `/docs with the Decide section and signed receipts: ${d.topWords} top words, ${d.bodyWords + signedExtra} body words`);
  }
} finally {
  if (proc) proc.kill("SIGKILL");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
