#!/usr/bin/env node
// A prefilled storefront link: /reports?product=<product id>&input=<value>
// opens /reports with that product's card selected and its field filled.
//
//   node scripts/test-reports-prefill.js
//
// The page the server renders (humanReportsPage) is loaded in a DOM and its
// own script (assets/js/reports.js) run against the link's address:
//   - the named product's card is selected, its field holds the value and
//     has focus; no other card changes
//   - nothing is submitted and no checkout request is made until the buyer
//     presses the button, and that request is the one a typed value makes
//   - an unknown product, a product with no value, a value with markup and a
//     value past the length limit behave as the plain page or as typed input
//   - the server renders the same page whatever the query (the value is never
//     written into the HTML), so with scripts off the link is the plain page
// Offline: no server, no network, no browser.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
const { humanReportsPage } = await import("../src/human-reports-page.js");
const { HUMAN_PRODUCTS } = await import("../src/human-checkout.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const SCRIPT = readFileSync(new URL("../assets/js/reports.js", import.meta.url), "utf8");
const HTML = humanReportsPage("https://agent402.tools");

// The page at `query`, with its script run. `posts` collects checkout requests.
function open(query) {
  const dom = new JSDOM(HTML, { url: `https://agent402.tools/reports${query}`, runScripts: "outside-only" });
  const w = dom.window;
  const posts = [];
  let submits = 0;
  w.fetch = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ error: "stub: no checkout in this test" }) }; };
  w.Element.prototype.scrollIntoView = function () { w.__scrolledTo = this; };
  w.document.addEventListener("submit", () => { submits++; }, true);
  w.eval(SCRIPT);
  const doc = w.document;
  const cards = [...doc.querySelectorAll(".pcard")];
  return {
    w, doc, posts, submits: () => submits, cards,
    selected: () => cards.filter((c) => c.classList.contains("sel")).map((c) => c.dataset.kind),
    filled: () => Object.fromEntries([...doc.querySelectorAll(".pcard input[name=input]")].filter((i) => i.value).map((i) => [i.id, i.value])),
    press: async (kind) => { doc.querySelector(`.pcard[data-kind="${kind}"] [data-buy]`).click(); await new Promise((r) => setTimeout(r, 0)); },
  };
}
const q = (product, input) => `?product=${encodeURIComponent(product)}${input === undefined ? "" : `&input=${encodeURIComponent(input)}`}`;

// ---- control: the plain page -------------------------------------------------------
{
  const p = open("");
  ok(p.cards.length >= 10 && p.selected().length === 0 && Object.keys(p.filled()).length === 0 && p.posts.length === 0, `the plain page has ${p.cards.length} cards, none selected, no field filled`);
}

// ---- every product on the page opens prefilled by its id -----------------------------
const onPage = {}; // product id -> card kind, read from the page the way a buyer's click resolves it
{
  for (const card of open("").cards) {
    const p = open("");
    p.doc.getElementById(`in-${card.dataset.kind}`).value = "probe";
    await p.press(card.dataset.kind);
    if (p.posts[0]) onPage[p.posts[0].body.product] = card.dataset.kind;
  }
  ok(Object.keys(onPage).length >= 10 && Object.keys(onPage).every((id) => Object.hasOwn(HUMAN_PRODUCTS, id)), `the page sells ${Object.keys(onPage).length} products, each in the product table`);
  for (const [id, kind] of Object.entries(onPage)) {
    const p = open(q(id, "Example value 1"));
    const field = p.doc.getElementById(`in-${kind}`);
    ok(JSON.stringify(p.selected()) === JSON.stringify([kind]) && JSON.stringify(p.filled()) === JSON.stringify({ [`in-${kind}`]: "Example value 1" }) && p.doc.activeElement === field && p.w.__scrolledTo === field.closest(".pcard"),
      `${id}: its card is selected and in view, its field filled and focused, no other card touched`);
    ok(p.posts.length === 0 && p.submits() === 0 && !p.doc.querySelector("[data-buy][disabled]"), `${id}: nothing is submitted and no checkout is requested on load`);
  }
}

// ---- the buyer's press sends what a typed value sends ----------------------------------
{
  const pre = open(q("dossier", "  AAPL "));
  await pre.press("dossier");
  const typed = open("");
  typed.doc.getElementById("in-dossier").value = "  AAPL ";
  await typed.press("dossier");
  ok(pre.posts.length === 1 && pre.posts[0].url === "/api/buy" && JSON.stringify(pre.posts[0]) === JSON.stringify(typed.posts[0]) && pre.posts[0].body.input === "AAPL", `one press, one request, the same as typed (${JSON.stringify(pre.posts[0])})`);
}

// ---- values handled as typed input is -------------------------------------------------
{
  const MARKUP = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
  const p = open(q("research", MARKUP));
  ok(p.doc.getElementById("in-research").value === MARKUP && !p.doc.querySelector("img[src=x]") && p.doc.querySelectorAll("script").length === new JSDOM(HTML).window.document.querySelectorAll("script").length, "a value with markup is the field's text, never page markup");
  const long = "Q".repeat(2500);
  const l = open(q("research", long));
  ok(l.doc.getElementById("in-research").value === long && l.posts.length === 0, "a value past the limit fills the field like typed text; the server refuses it at checkout, as typed");
  const empty = open(q("dossier"));
  ok(JSON.stringify(empty.selected()) === JSON.stringify(["dossier"]) && Object.keys(empty.filled()).length === 0, "a product with no value selects its card and leaves the field empty");
  await empty.press("dossier");
  ok(empty.posts.length === 0 && /Please enter/.test(empty.doc.getElementById("err-dossier").textContent), "pressing with the empty field shows the same error a typed empty field does");
  const two = open("?product=dossier&input=AAPL&input=MSFT");
  ok(two.doc.getElementById("in-dossier").value === "AAPL", "a repeated input parameter fills the first value");
}

// ---- an unknown product is the plain page ----------------------------------------------
for (const bad of ["nope", "constructor", "__proto__", "toString", "DOSSIER", "dossier ", "research-max", "credits-20", "domain-monitor", "fund", "insider", "filing", ""]) {
  const p = open(q(bad, "AAPL"));
  ok(p.selected().length === 0 && Object.keys(p.filled()).length === 0 && p.posts.length === 0 && p.w.__scrolledTo === undefined, `unknown product ${JSON.stringify(bad)}: the plain page`);
}
{
  const p = open("?input=AAPL");
  ok(p.selected().length === 0 && Object.keys(p.filled()).length === 0, "an input with no product: the plain page");
  const c = open("?canceled=1&product=dossier&input=AAPL");
  ok(c.doc.getElementById("checkout-note").hidden === false && c.doc.getElementById("in-dossier").value === "AAPL", "the canceled note and a prefill work together");
}

// ---- the server never writes the value into the page -------------------------------------
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const route = (server.match(/app\.get\("\/reports", \(([^)]*)\) => ([^\n]*)/) || []);
  ok(route[1] === "_req, res" && /humanReportsPage\(BASE_URL\)\)\);$/.test(route[2] || ""), "GET /reports renders one page whatever the query (the request is not read)");
  ok(humanReportsPage.length === 1, "the page takes the base URL only");
  ok(/<noscript><p class="note">Checkout opens with JavaScript on\.<\/p><\/noscript>/.test(HTML), "with scripts off the link shows the plain page and its checkout note");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
