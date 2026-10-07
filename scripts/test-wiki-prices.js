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
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-wiki-prices.js
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
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed (${rows} wiki price rows checked)`);
process.exit(fail ? 1 : 0);
