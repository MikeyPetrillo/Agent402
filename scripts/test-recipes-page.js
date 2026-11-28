#!/usr/bin/env node
// /recipes: things a person can ask an AI app to do with Agent402 (src/recipes-page.js).
//
//   node scripts/test-recipes-page.js
//
// Offline renders, then one FREE_MODE boot of the real server.
//   - Every price is the catalog's: a paid tool shows its catalog price (a
//     changed catalog price changes the page, and the module types none), a
//     free one is exactly a proof-of-work tool (src/free-tier.js, not
//     WALLET_ONLY_SLUGS), and a model-backed tool says so from its own flag.
//   - A recipe whose tool the catalog does not list is left out.
//   - The paid line reads the switch: with the credits connector off the page
//     says nothing about cards or credits; on, it links the connector sign-in.
//   - On the booted server: /recipes answers 200 with one h1, every tool link
//     and /start answer 200, it is in the sitemap, /llms.txt and the page
//     dates, no listed tool is a long call (each answers within the
//     connector's blocking wait), and each prompt's tool, run through /mcp,
//     answers: a free one with its result, a paid one with the refusal that
//     names the price the page prints.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { pageText } from "./lib/html-text.js";
import { bootServer } from "./lib/boot-server.js";

const { recipesPage, servedRecipes, readablePrice, RECIPES, RECIPES_PATH } = await import("../src/recipes-page.js");
const { isComputePayable, WALLET_ONLY_SLUGS } = await import("../src/pow.js");
const { FREE_TIER_SLUGS } = await import("../src/free-tier.js");
const { pageLastmod, PAGE_SOURCES } = await import("../src/page-dates.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const ORIGIN = "https://agent402.tools";
const EM_DASH = "—";

// ---- offline renders ----------------------------------------------------------
const PAID = { answer: { price: "$0.08", modelBacked: true }, summarize: { price: "$0.030", modelBacked: true }, "image-ocr": { price: "$0.006" }, "image-gen": { price: "$0.030", modelBacked: true } };
const catalogOf = (over = {}) => Object.fromEntries(RECIPES.map((r) => {
  const def = { slug: r.slug, name: `Tool ${r.slug}`, price: "$0.001", ...(PAID[r.slug] || {}), ...(over[r.slug] || {}) };
  return [`POST /api/${r.slug}`, def];
}));
const mainText = (html) => pageText(String(html).replace(/^[\s\S]*?<main\b/i, "<main").replace(/<footer\b[\s\S]*$/i, ""));

{
  ok(RECIPES.length >= 6 && RECIPES.length <= 8, `six to eight tasks (${RECIPES.length})`);
  const served = servedRecipes(ORIGIN, catalogOf());
  ok(served.length === RECIPES.length, `every task is served when the catalog lists its tool (${served.length})`);
  for (const r of served) {
    const def = catalogOf()[`POST /api/${r.slug}`];
    ok(r.free === isComputePayable(def), `${r.slug}: free exactly when it is a proof-of-work tool (${r.free})`);
    if (r.free) ok(FREE_TIER_SLUGS.has(r.slug) && !WALLET_ONLY_SLUGS.has(r.slug), `${r.slug}: free, so it is on the free tier and not wallet-only`);
    else ok(r.price === readablePrice(def.price), `${r.slug}: the price is the catalog's (${r.price})`);
    ok(r.modelBacked === Boolean(def.modelBacked), `${r.slug}: model-backed from its own flag (${r.modelBacked})`);
  }
  ok(served.some((r) => r.free) && served.some((r) => !r.free), "the page has free and paid tasks");
  ok(readablePrice("$0.030") === "$0.03" && readablePrice("$0.006") === "$0.006" && readablePrice("$0.08") === "$0.08" && readablePrice("$1.10") === "$1.10", "a price reads as a person writes it, from the catalog's string");

  // A changed catalog price changes the page; the module types no price.
  const moved = recipesPage(ORIGIN, catalogOf({ answer: { price: "$0.123" } }), { connector: false });
  ok(mainText(moved).includes("$0.123") && !mainText(moved).includes("$0.08 "), "a catalog price change reaches the page (no typed price)");
  const src = readFileSync(new URL("../src/recipes-page.js", import.meta.url), "utf8");
  ok(!/\$\d/.test(src), "src/recipes-page.js types no dollar figure");
  const prices = [...mainText(recipesPage(ORIGIN, catalogOf(), { connector: false })).matchAll(/\$\d+(?:\.\d+)?/g)].map((m) => m[0]);
  const real = new Set(served.filter((r) => !r.free).map((r) => r.price));
  ok(prices.length > 0 && prices.every((p) => real.has(p)), `every price on the page is a listed tool's (${[...new Set(prices)].join(", ")})`);

  // A tool the catalog does not list takes its task with it.
  const without = catalogOf();
  delete without["POST /api/image-gen"];
  const html = recipesPage(ORIGIN, without, { connector: false });
  ok(!html.includes('id="image"') && !html.includes("/tools/image-gen"), "a task whose tool is not listed is left out");

  // Each recipe links its tool page and marks model-backed ones.
  const off = recipesPage(ORIGIN, catalogOf(), { connector: false });
  for (const r of served) ok(off.includes(`href="/tools/${r.slug}"`), `${r.slug}: linked to its tool page`);
  const modelBackedCards = [...off.matchAll(/model-backed<\/p>/g)].length;
  ok(modelBackedCards === served.filter((r) => r.modelBacked).length, `each model-backed tool is labeled (${modelBackedCards})`);

  // The paid line reads the switch.
  const on = recipesPage(ORIGIN, catalogOf(), { connector: true });
  ok(!/\bcards?\b(?!\.png)|credit/i.test(mainText(off)) && off.includes('href="/start#fund"'), "credits connector off: nothing about cards or credits, the wallet setup linked");
  ok(/paid ones run from a computer with a wallet/.test(mainText(off)) && !/computer/.test(mainText(on)), "credits connector off: paid recipes run from a computer with a wallet, as /start says (the phone app cannot pay from one)");
  ok(/credits/i.test(mainText(on)) && on.includes('href="/start#apps"') && !on.includes('href="/start#fund"'), "credits connector on: the connector sign-in linked");
  for (const h of [off, on]) {
    const t = mainText(h);
    ok(!t.includes(EM_DASH) && !/plain (english|language)/i.test(t) && !/\b\d{3}\+? tools\b/i.test(t), "no em dash, no banned phrase, no exact tool count");
  }
  ok(off.includes('href="/start#phone"'), "the lead links the phone setup");
  ok((off.match(/<h1\b/g) || []).length === 1, "one h1");
  ok(/main \.ml-code-copy\{min-height:44px;min-width:44px\}/.test(off), "each copy button is a 44px tap target");
}

// ---- the real server ----------------------------------------------------------
// Each prompt's call, as an app's model makes it from the prompt.
const CALLS = {
  qr: { params: { text: "https://example.com" }, image: true },
  "timezone-convert": { params: { datetime: "2026-06-23T14:00:00", from: "America/New_York", to: "Asia/Tokyo" }, expect: /2026-06-23T18:00:00/ },
  readability: { params: { text: "The cat sat on the mat. It was warm." }, expect: /"readingEase"/ },
  "unit-convert": { params: { value: 10, from: "kilometers", to: "miles" }, expect: /6\.2137/ },
};
let srv = null;
try {
  srv = await bootServer({ stores: "recipes", timeoutMs: 180_000, env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", REDIS_URL: "", CREDITS_SALES: "", MCP_OAUTH: "", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" } });
} catch (e) { ok(false, `server booted (${String(e?.message || e).slice(-800)})`); }

if (srv) {
  try {
    const page = await fetch(`${srv.url}${RECIPES_PATH}`);
    const html = await page.text();
    ok(page.status === 200 && (html.match(/<h1\b/g) || []).length === 1, `/recipes answers 200 with one h1 (${page.status})`);
    const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
    const bySlug = new Map(pricing.endpoints.map((e) => [e.slug, e]));
    let id = 1;
    const call = async (name, args) => {
      const r = await fetch(`${srv.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }) });
      let t = await r.text();
      if ((r.headers.get("content-type") || "").startsWith("text/event-stream")) t = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      return JSON.parse(t).result;
    };
    for (const r of RECIPES) {
      const e = bySlug.get(r.slug);
      ok(Boolean(e), `${r.slug}: listed in this boot's catalog`);
      if (!e) continue;
      ok(!e.asyncProfile, `${r.slug}: answers within the connector's blocking wait (no async profile)`);
      ok(html.includes(`id="${r.id}"`), `${r.slug}: its task is on the page`);
      const tool = await fetch(`${srv.url}/tools/${r.slug}`);
      await tool.arrayBuffer();
      ok(tool.status === 200, `${r.slug}: its tool page answers 200 (${tool.status})`);
      const res = await call("catalog.call", { slug: r.slug, params: CALLS[r.slug]?.params || {} });
      const text = (res?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const at = html.indexOf(`id="${r.id}"`);
      const card = at < 0 ? "" : html.slice(at, html.indexOf("</pre>", at));
      if (e.computePayable) {
        const c = CALLS[r.slug];
        ok(Boolean(c), `${r.slug}: a free task has its call in this test`);
        ok(res && !res.isError && (c?.image ? res.content?.some((x) => x.type === "image") : c?.expect.test(text)), `${r.slug}: the prompt's call runs free through /mcp (${(text || res?.content?.[0]?.type || "").slice(0, 80)})`);
        ok(card.includes(">Free<"), `${r.slug}: the page says free`);
      } else {
        ok(res?.isError === true && text.includes(`"${r.slug}" (${e.price}/call)`), `${r.slug}: unpaid through /mcp, the refusal names the catalog price (${e.price})`);
        ok(card.includes(`>${readablePrice(e.price)}<`), `${r.slug}: the page prints that price (${readablePrice(e.price)})`);
      }
      ok(Boolean(e.modelBacked) === card.includes("model-backed</p>"), `${r.slug}: model-backed on the page exactly when the catalog says so (${Boolean(e.modelBacked)})`);
    }
    const start = await fetch(`${srv.url}/start`);
    await start.arrayBuffer();
    ok(start.status === 200, "/start (the lead's link) answers 200");
    const sitemap = await (await fetch(`${srv.url}/sitemap-pages.xml`)).text();
    ok(/\/recipes<\/loc>/.test(sitemap), "/recipes is in the sitemap");
    const llms = await (await fetch(`${srv.url}/llms.txt`)).text();
    ok(llms.includes("/recipes)"), "/llms.txt lists /recipes");
    ok((PAGE_SOURCES["/recipes"] || []).includes("src/recipes-page.js") && /^\d{4}-\d{2}-\d{2}/.test(String(pageLastmod("/recipes") || "")), `/recipes has a page date from its module (${pageLastmod("/recipes")})`);
  } finally {
    await srv.stop();
  }
}

console.log(`\n${pass} passed, ${failed} failed (recipes page)`);
process.exit(failed ? 1 : 0);
