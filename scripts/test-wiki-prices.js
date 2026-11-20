#!/usr/bin/env node
// A price the wiki quotes for an endpoint is the price the catalog charges.
//
// 2026-10-07: /api/tts and /api/tts-hd moved to ElevenLabs at new prices, and
// wiki/TTS.md still quoted the old ones. test-price-prose guards the served
// copy; the wiki (synced to GitHub by CI) had typed prices in 28 pages and no
// guard. This reads every wiki table row that names one endpoint and one
// dollar amount, and fails when the amount is not that endpoint's catalog
// price. Rows naming several endpoints or several amounts are skipped, since
// which amount belongs to which endpoint is not knowable from text.
//
// Two more checks read rows the rule above skips: a wiki/Tool-Catalog.md row
// naming several tools by slug states their price band ("$a-$b", "$a to $b",
// "$a, $b" or one price), which must be the lowest and highest catalog price
// of the tools it names; and a wiki/Skill-Packs.md row priced two ways
// ("$a (with a stock data provider: $b)") states both of the pack's prices,
// the one without a stock step and the full one (src/skills.js tables).
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-wiki-prices.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`FAIL - ${m}`); } };

const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
const price = new Map();
for (const e of pricing.endpoints || []) price.set(`${e.method} ${e.path}`, Number(String(e.price).replace("$", "")));
ok(price.size > 400, `read ${price.size} catalog prices`);

let rows = 0;
for (const file of readdirSync(join(ROOT, "wiki")).filter((f) => f.endsWith(".md"))) {
  readFileSync(join(ROOT, "wiki", file), "utf8").split("\n").forEach((line, i) => {
    if (!line.trim().startsWith("|")) return;
    const routes = [...line.matchAll(/`(GET|POST|PUT|DELETE|PATCH) (\/[^`\s]+)`/g)].map((m) => `${m[1]} ${m[2]}`);
    const amounts = [...line.matchAll(/\$(\d+(?:\.\d+)?)(?![\d.]*\s*(?:\/|per\b))/g)].map((m) => Number(m[1]));
    if (routes.length !== 1 || amounts.length !== 1 || !price.has(routes[0])) return;
    rows++;
    const want = price.get(routes[0]);
    ok(Math.abs(amounts[0] - want) < 1e-9, `wiki/${file}:${i + 1} quotes $${amounts[0]} for ${routes[0]}, the catalog charges $${want}`);
  });
}
// Control: the scan finds rows at all, so an empty match is not a pass.
ok(rows >= 10, `checked ${rows} wiki price rows`);

// The tts quote in prose: wiki/TTS.md states each tier's floor, per-1,000
// rate and price at the cap, read here from the formula /api/pricing serves.
{
  const tts = readFileSync(join(ROOT, "wiki", "TTS.md"), "utf8").replace(/\s+/g, " ");
  for (const slug of ["tts", "tts-hd"]) {
    const row = (pricing.endpoints || []).find((e) => e.slug === slug);
    const m = String(row?.quoteFormula || "").match(/^(\$[\d.]+) plus (\$[\d.]+) per 1,000 characters of text, rounded up to the next \$0\.001 \(([\d,]+) characters: (\$[\d.]+)\)$/);
    ok(!!m, `/api/pricing carries the ${slug} quote formula (${row?.quoteFormula})`);
    if (!m) continue;
    const [, floor, per1k, chars, atCap] = m;
    ok(tts.includes(`\`${slug}\` is ${floor} plus ${per1k} per 1,000 characters`), `wiki/TTS.md states ${slug} as ${floor} plus ${per1k} per 1,000 characters`);
    ok(tts.includes(`${chars} characters, the cap, costs`) && tts.includes(`${atCap} on \`${slug}\``), `wiki/TTS.md states ${chars} characters on ${slug} at ${atCap}`);
  }
}

// Tool-Catalog price bands: the lowest and highest catalog price of the tools a
// row names. A slug ending in * names every catalog slug with that prefix; a
// slug the catalog does not list here (a key-gated tool) is left out; a row
// naming no listed tool is skipped.
const priceOfSlug = new Map();
for (const e of pricing.endpoints || []) {
  const n = Number(String(e.price ?? "").replace("$", ""));
  if (e.slug && Number.isFinite(n) && String(e.price).startsWith("$")) priceOfSlug.set(e.slug, n);
}
export function statedBand(cell) {
  const amounts = [...String(cell).matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!amounts.length) return null;
  if (/\$[\d.]+\s*(?:\u2013|-|to)\s*\$[\d.]+/.test(cell) && amounts.length === 2) return { kind: "range", min: amounts[0], max: amounts[1] };
  if (amounts.length === 1) return { kind: "one", min: amounts[0], max: amounts[0] };
  return { kind: "list", set: [...new Set(amounts)].sort((a, b) => a - b) };
}
let bands = 0;
{
  const lines = readFileSync(join(ROOT, "wiki", "Tool-Catalog.md"), "utf8").split("\n");
  lines.forEach((line, i) => {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || !line.trim().startsWith("|")) return;
    const [, first, second] = cells;
    if (/`(GET|POST|PUT|DELETE|PATCH) \//.test(first)) return; // a route row: the rule above
    const named = [...first.matchAll(/`([a-z0-9][a-z0-9-]*\*?)`/g)].map((m) => m[1]);
    const band = statedBand(second);
    if (!named.length || !band) return;
    const slugs = named.flatMap((n) => n.endsWith("*") ? [...priceOfSlug.keys()].filter((k) => k.startsWith(n.slice(0, -1))) : [n]).filter((s) => priceOfSlug.has(s));
    if (!slugs.length) return;
    bands++;
    const prices = [...new Set(slugs.map((s) => priceOfSlug.get(s)))].sort((a, b) => a - b);
    const lo = prices[0], hi = prices[prices.length - 1];
    const where = `wiki/Tool-Catalog.md:${i + 1} (${named.slice(0, 3).join(", ")}${named.length > 3 ? ", ..." : ""})`;
    if (band.kind === "list") ok(band.set.length === prices.length && band.set.every((p, j) => Math.abs(p - prices[j]) < 1e-9), `${where} states ${band.set.map((p) => "$" + p).join(", ")}; the catalog charges ${prices.map((p) => "$" + p).join(", ")}`);
    else ok(Math.abs(band.min - lo) < 1e-9 && Math.abs(band.max - hi) < 1e-9, `${where} states $${band.min}${band.max !== band.min ? "-$" + band.max : ""}; the catalog band is $${lo}${hi !== lo ? "-$" + hi : ""}`);
  });
  // Control: the band reader parses each form the table uses.
  const r = statedBand("$0.001\u2013$0.004"), t = statedBand("$0.002 to $0.005"), l = statedBand("$0.005, $0.02"), o = statedBand("$0.003");
  ok(r?.kind === "range" && r.max === 0.004 && t?.kind === "range" && t.min === 0.002 && l?.kind === "list" && l.set.length === 2 && o?.kind === "one", "control: the band reader parses a dash range, a to range, a list and one price");
}
ok(bands >= 20, `checked ${bands} Tool-Catalog price bands`);

// Skill-Packs two-state rows: both prices, read from the generated tables.
let duals = 0;
{
  const { PACK_PRICE_TABLE, PACK_PRICES_WITHOUT_STOCK } = await import("../src/skills.js");
  const DUAL = /\$(\d+(?:\.\d+)?) \(with a stock data provider: \$(\d+(?:\.\d+)?)\)/;
  const text = readFileSync(join(ROOT, "wiki", "Skill-Packs.md"), "utf8");
  const listed = new Set();
  text.split("\n").forEach((line, i) => {
    const packs = [...new Set([...line.matchAll(/\/skills\/([a-z0-9-]+)/g)].map((m) => m[1]))];
    if (packs.length !== 1) return;
    const slug = packs[0];
    const d = line.match(DUAL);
    const full = PACK_PRICE_TABLE[slug], trimmed = PACK_PRICES_WITHOUT_STOCK[slug];
    if (trimmed != null) listed.add(slug);
    if (!d) {
      if (trimmed != null && Math.abs(trimmed - full) > 1e-9 && /\|\s*\$/.test(line)) ok(false, `wiki/Skill-Packs.md:${i + 1} prices ${slug} one way; it sells at $${trimmed} without a stock data provider and $${full} with one`);
      return;
    }
    duals++;
    ok(trimmed != null && Math.abs(Number(d[1]) - trimmed) < 1e-9, `wiki/Skill-Packs.md:${i + 1} states ${slug} at $${d[1]} without a stock data provider; the table says $${trimmed}`);
    ok(full != null && Math.abs(Number(d[2]) - full) < 1e-9, `wiki/Skill-Packs.md:${i + 1} states ${slug} at $${d[2]} with a stock data provider; the table says $${full}`);
  });
  ok(duals >= 3, `checked ${duals} two-state pack rows`);
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed (${rows} wiki price rows, ${bands} catalog bands, ${duals} two-state pack rows checked)`);
process.exit(fail ? 1 : 0);
