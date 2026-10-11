#!/usr/bin/env node
// Wiki facts that a page states in prose, checked against the code that decides
// them. scripts/test-docs-truth.js judges a price written beside ONE route; the
// wiki also states ranges, ladders, tier caps and the router's ordering in
// sentences and multi-slug table rows, which that gate skips as ambiguous, and
// those are the figures that went stale (a premium input cap a third of the
// real one, the router order missing two of its steps).
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-wiki-facts.js
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { agentReportPriceRange, cardReportPriceRange, reportLadderProse } from "../src/report-tiers.js";
import { PACK_PRICE_RANGE } from "../src/skills.js";
import { TIERS } from "../src/tools/llm-gateway-kit.js";
import { routeTiebreakProse } from "../src/route-order.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const num = (s) => Number(String(s).replace(/[^0-9.]/g, ""));
const same = (a, b) => Math.abs(num(a) - num(b)) < 1e-9;

const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
const priceBySlug = new Map((pricing.endpoints || []).map((e) => [e.slug, num(e.price)]));
ok(priceBySlug.size > 400, `catalog loaded (${priceBySlug.size} routes)`);

const wiki = readdirSync(join(ROOT, "wiki")).filter((f) => f.endsWith(".md")).map((f) => [f, readFileSync(join(ROOT, "wiki", f), "utf8")]);
const card = cardReportPriceRange(HUMAN_PRODUCTS);
const agent = agentReportPriceRange();
const monthly = reportLadderProse({ monitorProducts: MONITOR_PRODUCTS }).monthly;
const [agentLo, agentHi] = String(agent.text).split("-");
const cardPrices = new Set(Object.values(HUMAN_PRODUCTS).map((p) => p.price / 100));

let cardSeen = 0, agentSeen = 0, monthSeen = 0, rowsSeen = 0, orderSeen = 0;
for (const [f, text] of wiki) {
  for (const line of text.split("\n")) {
    // 1. the card range ("$2 to $5 by card", "by card at /reports for $2 to $5")
    for (const m of line.matchAll(/\$([0-9.]+) to \$([0-9.]+)/g)) {
      const after = line.slice(m.index, m.index + 60), before = line.slice(Math.max(0, m.index - 60), m.index);
      if (/by card|card at|\/reports/.test(after + before) && !/per report over/.test(after)) {
        cardSeen++;
        ok(`$${m[1]} to $${m[2]}` === card.text, `${f}: card range "$${m[1]} to $${m[2]}" is cardReportPriceRange (${card.text})`);
      } else if (/report|x402 or MPP|x402 \/ MPP/.test(after) && Number(m[1]) >= 0.1) {
        agentSeen++;
        ok(same(m[1], agentLo) && same(m[2], agentHi), `${f}: agent report range "$${m[1]} to $${m[2]}" is agentReportPriceRange (${agent.text})`);
      }
    }
    // 2. the monitor price
    for (const m of line.matchAll(/\$([0-9.]+)(?: per month|\/month| a month)/g)) {
      monthSeen++;
      ok(`$${m[1]}` === monthly, `${f}: monitor price "$${m[1]}" a month is MONITOR_PRODUCTS (${monthly})`);
    }
    // 3. the skill-pack range
    for (const m of line.matchAll(/skill packs (?:are priced from the tools they run|run) \(?(\$[0-9.]+ to \$[0-9.]+)/g)) {
      ok(m[1] === PACK_PRICE_RANGE.text, `${f}: pack range "${m[1]}" is PACK_PRICE_RANGE (${PACK_PRICE_RANGE.text})`);
    }
    // 4. multi-slug table rows with one range: the range is the min and max of those slugs
    if (/^\|/.test(line)) {
      const cells = line.split("|").map((c) => c.trim());
      // `name` is one tool; `prefix-*` is every catalog tool with that prefix
      const slugs = [...(cells[1] || "").matchAll(/`([a-z0-9][a-z0-9-]+?)(-\*)?`/g)]
        .flatMap((m) => (m[2] ? [...priceBySlug.keys()].filter((s) => s.startsWith(`${m[1]}-`)) : [m[1]]))
        .filter((s) => priceBySlug.has(s));
      const range = (cells[2] || "").match(/^\$([0-9.]+)\s*(?:to|–|-)\s*\$([0-9.]+)$/);
      if (slugs.length >= 2 && range) {
        rowsSeen++;
        const ps = slugs.map((s) => priceBySlug.get(s));
        ok(same(range[1], Math.min(...ps)) && same(range[2], Math.max(...ps)),
          `${f}: row ${slugs.slice(0, 3).join(", ")}${slugs.length > 3 ? ", ..." : ""} says $${range[1]} to $${range[2]}, the catalog spans $${Math.min(...ps)} to $${Math.max(...ps)}`);
      }
    }
    // 5. the router's order, wherever a page spells it out
    if (/then ordered by crawl health/.test(line)) {
      orderSeen++;
      ok(line.includes(routeTiebreakProse()), `${f}: the router order names every step (${routeTiebreakProse()})`);
    }
  }
}
ok(cardSeen >= 3 && agentSeen >= 2 && monthSeen >= 3 && rowsSeen >= 10 && orderSeen >= 2,
  `the sweep measured something (card ${cardSeen}, agent ${agentSeen}, monthly ${monthSeen}, rows ${rowsSeen}, order ${orderSeen})`);

// 6. the card ladder on Reports-and-Monitors names only real card prices
{
  const rm = wiki.find(([f]) => f === "Reports-and-Monitors.md")[1];
  const bold = [...rm.matchAll(/\*\*\$([0-9.]+)\*\* for the/g)].map((m) => Number(m[1]));
  ok(bold.length >= 3 && bold.every((b) => cardPrices.has(b)), `the card ladder's figures (${bold.join(", ")}) are HUMAN_PRODUCTS prices`);
}

// 7. the /v1 chat tier table: price, input cap and output cap come from TIERS
{
  const gw = wiki.find(([f]) => f === "LLM-Gateway.md")[1];
  const ROWS = [["v1-chat-nano", "/v1/nano/chat/completions"], ["v1-chat-auto", "/v1/auto/chat/completions"], ["v1-chat", "/v1/chat/completions"], ["v1-chat-pro", "/v1/pro/chat/completions"], ["v1-chat-premium", "/v1/premium/chat/completions"]];
  for (const [slug, path] of ROWS) {
    const row = gw.split("\n").find((l) => l.startsWith(`| \`POST ${path}\``));
    ok(!!row, `LLM-Gateway lists ${path}`);
    if (!row) continue;
    const cells = row.split("|").map((c) => c.trim());
    const t = TIERS[slug];
    ok(same(cells[2], t.price), `${path}: price ${cells[2]} is TIERS (${t.price})`);
    ok(num(cells[4]) * 1000 === t.maxInputChars, `${path}: input cap ${cells[4]} is TIERS (${t.maxInputChars} chars)`);
    ok(num(cells[5]) === t.maxTokens, `${path}: output cap ${cells[5]} is TIERS (${t.maxTokens} tokens)`);
  }
}

// Control: a drifted figure is reported through the same comparisons.
ok(!same("0.85", Math.max(0.6, 1.1)) && `$1 to $5` !== card.text, "control: a wrong range would not match");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
