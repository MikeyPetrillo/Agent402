// A skill pack page reads in about a minute: the lead under the title is at
// most 40 prose words and the rest of the page at most 250 (tables, code and
// the sources' attribution sentences excluded), each workflow step at most 20
// words and the when-to-use line at most 40. The page names each tool once,
// in a table of name and route, and prints no member tool's price there (the
// page sells the bundle; a member's price is on its own tool page and in
// /api/pricing); a tool's own description lives on its /tools page. What the page must still say is checked beside the budget:
// the pack price and the sentence that derives it, the proof-of-work fact,
// the attribution its sources require, and every tool linked.
//
// The full text stays the agent's copy: /api/skill-packs.json serves it.
// The page copy (src/skill-page-copy.js) is checked for every pack in both
// stock states; the rendered pages are the ones this boot lists.
//
//   node scripts/test-pack-page-words.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { proseWords, packPageProse } from "./lib/page-prose.js";
import { ALL_SKILL_PACKS, SKILL_PACKS, packAsListed, packPageCopy } from "../src/skills.js";
import { attributionTailOf } from "../src/data-attribution.js";

const LEAD_MAX = 40, BODY_MAX = 250, USE_MAX = 40, STEP_MAX = 20;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const words = (s) => String(s ?? "").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
// A member tool's price printed in a pack's tool table: a price column (its
// heading or its cell class) or an amount in any cell. A tool or route named
// for prices ("Crypto price", /api/crypto-price) is a name, not an amount.
const memberPriceIn = (table) => {
  const heads = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
  if (heads.some((h) => /\b(?:price|cost|usd|usdc)\b/i.test(h))) return `a "${heads.find((h) => /\b(?:price|cost|usd|usdc)\b/i.test(h))}" column`;
  if (/<t[dh]\b[^>]*class="[^"]*\bprice\b/.test(table)) return "a price cell";
  const text = table.replace(/<[^>]+>/g, " ");
  const amount = text.match(/\$\s?\d[\d.,]*|\b\d[\d.,]*\s*(?:USDC?|cents?)\b/i);
  return amount ? `the amount ${amount[0]}` : "";
};
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Control: the counter leaves code, tables and markup out.
ok(proseWords(`<p>One two <code>three four</code> five.</p><pre>six seven</pre><table><tr><td>eight</td></tr></table><p>- &middot; nine</p>`) === 4, "control: prose words exclude code, tables and bare punctuation");
{
  const page = `<h1>T</h1><p>a b c</p><div class="sk-buy-route">POST /x</div><p class="sk-attr">Source: X.</p><p>d e</p><a>All skill packs</a>`;
  const r = packPageProse(page);
  ok(r && r.lead === 3 && r.body === 2 && r.attribution === 2, "control: the page split reads the lead, the body and the attribution apart");
}

// The copy, for every pack as either stock state lists it.
{
  const over = [];
  let n = 0;
  for (const p of ALL_SKILL_PACKS) {
    for (const stock of [false, true]) {
      const listed = packAsListed(p, { stock });
      if (!listed) continue;
      n++;
      const c = packPageCopy(listed, { stock });
      if (words(c.lead) > LEAD_MAX) over.push(`${p.slug}${stock ? "" : " (no stock)"} lead ${words(c.lead)}`);
      if (words(c.use) > USE_MAX) over.push(`${p.slug}${stock ? "" : " (no stock)"} when-to-use ${words(c.use)}`);
      c.steps.forEach((s, i) => { if (words(s) > STEP_MAX) over.push(`${p.slug}${stock ? "" : " (no stock)"} step ${i + 1}: ${words(s)}`); });
      if (!c.steps.length || !c.lead || !c.use) over.push(`${p.slug} has an empty page field`);
    }
  }
  ok(n > SKILL_PACKS.length, `the copy check reads every listed form of every pack (${n})`);
  ok(over.length === 0, `every lead and when-to-use line is at most ${LEAD_MAX}/${USE_MAX} words and every step at most ${STEP_MAX}${over.length ? `: ${over.slice(0, 8).join("; ")}` : ""}`);
}

const srv = await bootServer({ env: { FREE_MODE: "true", X402_SYNC_ON_START: "false" }, stores: "pack-page-words" });
try {
  const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
  const bySlug = new Map((pricing.endpoints || []).map((e) => [e.slug, e]));
  const over = [], missing = [];
  const bodies = [];
  const memberPrices = [];
  let lastTable = null;
  for (const pack of SKILL_PACKS) {
    const html = await (await fetch(`${srv.url}/skills/${pack.slug}`)).text();
    const r = packPageProse(html);
    if (!r) { missing.push(`${pack.slug}: page shape not found`); continue; }
    bodies.push(r.lead + r.body);
    if (r.lead > LEAD_MAX || r.body > BODY_MAX) over.push(`${pack.slug} ${r.lead}/${r.body}`);
    const ep = bySlug.get(`skill-${pack.slug}`);
    if (!ep) { missing.push(`${pack.slug}: no pack route in /api/pricing`); continue; }
    // The price, and the sentence that derives it from the parts.
    if (!html.includes(`<span class="sk-buy-price">${esc(ep.price)}</span>`)) missing.push(`${pack.slug}: price`);
    if (!/the pack is that sum less a 10% bundle discount, rounded up to the \$0\.001 settlement floor, which is \$[0-9.]+\./.test(html)) missing.push(`${pack.slug}: price derivation`);
    // The proof-of-work fact, as the gate computes it.
    if (!(ep.computePayable ? /Free with proof-of-work/.test(html) : /this pack has no proof-of-work tier/.test(html))) missing.push(`${pack.slug}: proof-of-work fact`);
    // Each tool once, in the table: linked name and route, and no price.
    const table = (html.match(/<table class="sk-tt">[\s\S]*?<\/table>/) || [""])[0];
    for (const slug of new Set(pack.toolSlugs)) {
      const t = bySlug.get(slug);
      const row = new RegExp(`<tr><td class="name"><a href="/tools/${slug}">[^<]+</a></td><td class="route">[^<]+</td></tr>`);
      if (!t || !row.test(table)) missing.push(`${pack.slug}: tool row ${slug}`);
    }
    const priced = memberPriceIn(table);
    if (priced) memberPrices.push(`${pack.slug}: ${priced}`);
    if (table) lastTable = { table, price: bySlug.get([...pack.toolSlugs].find((s) => bySlug.get(s)))?.price };
    // The sources' attribution, under the table.
    const tail = attributionTailOf(ep.description || "");
    if (tail && !html.includes(`>${esc(tail)}</p>`)) missing.push(`${pack.slug}: attribution`);
  }
  ok(memberPrices.length === 0, `no pack page prints a member tool's price in its tool table${memberPrices.length ? `: ${memberPrices.slice(0, 8).join("; ")}` : ""}`);
  // Controls on a served table: the column this page once had, a price typed
  // into a cell, and a price column under another heading are each found.
  ok(lastTable && memberPriceIn(lastTable.table) === "" && /^\$\d/.test(String(lastTable.price)), "control: a served table reads clean, and its first tool has a price to print");
  if (lastTable) {
    const { table, price } = lastTable;
    ok(memberPriceIn(table.replace(/<\/td><\/tr>/, `</td><td class="price">${price}</td></tr>`)) !== "", "control: a price cell in the table is found");
    ok(memberPriceIn(table.replace(/<\/td><\/tr>/, ` ${price}</td></tr>`)) !== "", "control: a price typed into another cell is found");
    ok(memberPriceIn(table.replace(/<\/th><\/tr>/, `</th><th scope="col">Price</th></tr>`)) !== "", "control: a price heading is found");
    ok(memberPriceIn(table.replace(/<\/td><\/tr>/, `</td><td>0.002 USDC</td></tr>`)) !== "", "control: an amount without a dollar sign is found");
  }
  ok(missing.length === 0, `every pack page keeps its price, the derivation, the proof-of-work fact, a table row per tool and its attribution${missing.length ? `: ${missing.slice(0, 8).join("; ")}` : ""}`);
  ok(over.length === 0, `every pack page's lead is at most ${LEAD_MAX} prose words and its body at most ${BODY_MAX} (${SKILL_PACKS.length} pages)${over.length ? `: ${over.slice(0, 10).join("; ")}` : ""}`);
  // The long text is still served: the agent's copy of each pack carries its
  // full tagline, use case and workflow, as written.
  const json = await (await fetch(`${srv.url}/api/skill-packs.json`)).json();
  const jsonBySlug = new Map((json.packs || []).map((p) => [p.slug, p]));
  const lost = SKILL_PACKS.filter((p) => { const j = jsonBySlug.get(p.slug); return !j || j.tagline !== p.tagline || j.useCase !== p.useCase || JSON.stringify(j.workflow) !== JSON.stringify(p.workflow); }).map((p) => p.slug);
  ok(lost.length === 0, `/api/skill-packs.json serves every pack's full tagline, use case and workflow${lost.length ? `: ${lost.slice(0, 5).join(", ")}` : ""}`);
  const med = bodies.slice().sort((a, b) => a - b)[Math.floor(bodies.length / 2)];
  console.log(`  median prose words per pack page: ${med}`);
} finally {
  await srv.stop();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
