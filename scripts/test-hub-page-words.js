// The home page and the hub pages (/sell, /docs) are short answers first:
// at most LEAD_MAX words of paragraph above the first h2, and at most
// BODY_MAX words a reader sees without opening anything (code, navigation and
// the bodies of closed <details> are not counted: scripts/lib/page-words.js).
// Long detail lives on a linked page, or collapsed where it is optional.
//
// Boots a FREE_MODE server on port 0 and reads the pages it serves; with
// TARGET_URL set it reads that server instead (a copy under a mutation, or a
// boot of another revision).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pageWords, countWords } from "./lib/page-words.js";
import { ownStoreEnv } from "./lib/own-stores.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEAD_MAX = 50;
const BODY_MAX = 700;
const PAGES = ["/", "/sell", "/docs"];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the counter itself ---------------------------------------------------
{
  const page = (inner) => `<nav>site nav words here</nav><main id="main">${inner}</main><footer>footer words</footer>`;
  const w = pageWords(page(`<h1>One two</h1><p>three four five</p><pre>code code</pre><h2>Six</h2><p>seven <code>x</code> eight</p><details><summary>nine ten</summary><p>hidden hidden hidden</p></details><details open><summary>eleven</summary><p>twelve</p></details><aside>sidebar words</aside>`));
  ok(w.leadWords === 3, `lead counts only the paragraphs above the first h2 (${w.leadWords})`);
  ok(w.bodyWords === 12, `body counts headings and prose, a closed details' summary and an open one's body, never code, nav, aside or the footer (${w.bodyWords})`);
  ok(countWords("a -> b · c 500+ $0.01") === 5, "a word holds a letter or a digit; arrows and dots are not words");
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
    const { leadWords, bodyWords } = pageWords(html);
    ok(leadWords > 0 && leadWords <= LEAD_MAX, `${path}: ${leadWords} words of paragraph above the first h2 (at most ${LEAD_MAX})`);
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
    const home = pageWords(ledgerHomePage("https://agent402.tools", catalog, {}, {}, [], { receipts: true, mpp: true }));
    ok(home.leadWords <= LEAD_MAX && home.bodyWords <= BODY_MAX, `/ with signed receipts and MPP: ${home.leadWords} lead words, ${home.bodyWords} body words`);
    const withDecide = { ...catalog, "POST /api/decide": catalog["POST /api/decide"] || { slug: "decide", price: "$0.01", route: "POST /api/decide" } };
    const docs = ledgerDocsPage("https://agent402.tools", withDecide);
    const d = pageWords(docs);
    // With no signing key here, the gateway sentence on /docs is the shorter
    // receipts-off form: the words the signed form adds are counted in.
    const signedExtra = receiptsServed() ? 0 : countWords(gatewayProductSentence({ receipts: true })) - countWords(gatewayProductSentence({ receipts: false }));
    ok(/id="decide"/.test(docs) && d.leadWords <= LEAD_MAX && d.bodyWords + signedExtra <= BODY_MAX, `/docs with the Decide section and signed receipts: ${d.leadWords} lead words, ${d.bodyWords + signedExtra} body words`);
  }
} finally {
  if (proc) proc.kill("SIGKILL");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
