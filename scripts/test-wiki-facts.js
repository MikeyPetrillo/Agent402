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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { agentReportPriceRange, cardReportPriceRange, reportLadderProse } from "../src/report-tiers.js";
import { PACK_PRICE_RANGE } from "../src/skills.js";
import { TIERS } from "../src/tools/llm-gateway-kit.js";
import { routeTiebreakProse } from "../src/route-order.js";
import { IMAGE_TIERS } from "../src/tools/llm-images-fast-kit.js";

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

// The metered client-timeout advice is typed in the wiki but derived in code
// (src/metered-lead.js meteredClientTimeoutSeconds, from the upstream bound).
{
  const { meteredClientTimeoutSeconds } = await import("../src/metered-lead.js");
  const gw = wiki.find(([f]) => f === "LLM-Gateway.md")?.[1] || "";
  const m = /client timeout of at least (\d+) s/.exec(gw);
  ok(!!m && Number(m[1]) === meteredClientTimeoutSeconds(), `wiki/LLM-Gateway.md metered timeout (${m?.[1]}) matches meteredClientTimeoutSeconds() (${meteredClientTimeoutSeconds()})`);
}
// The same advice as one sentence on every surface that describes a metered
// call: the pages are read from the booted server, the typed markdown from the
// tree, and each must carry meteredTimeoutSentence() word for word. A surface
// that words the advice another way (the lead-in without the sentence) fails.
{
  const { meteredTimeoutSentence, METERED_WIRES } = await import("../src/metered-lead.js");
  const sentence = meteredTimeoutSentence();
  const LEAD = "Set a client timeout of at least";
  ok(sentence.startsWith(LEAD) && sentence.length > 120, "the derived sentence opens with the lead-in the surfaces are searched for");
  // Page text with its markup left out, in one pass; whitespace runs are one space.
  const flat = (t) => { let out = "", inTag = false; for (const ch of t) { if (inTag) { if (ch === ">") inTag = false; } else if (ch === "<") inTag = true; else out += ch; } return out.replace(/\s+/g, " "); };
  const count = (hay, needle) => hay.split(needle).length - 1;
  const check = (label, text) => {
    const body = flat(text);
    const whole = count(body, sentence), leads = count(body, LEAD);
    ok(whole >= 1 && leads === whole, `${label} carries the derived metered client-timeout sentence, and only that wording (${whole} whole, ${leads} lead-ins)`);
  };
  const pages = [
    ...METERED_WIRES.map((w) => `/tools/${w.slug}`),
    "/pricing", "/docs", "/guides/buying-at-volume", "/guides/agent-hosts", "/guides/openclaw-model-provider",
  ];
  ok(METERED_WIRES.length === 3, `the metered route has a tool page per wire (${METERED_WIRES.length})`);
  for (const path of pages) {
    const r = await fetch(`${TARGET}${path}`);
    const html = await r.text();
    ok(r.status === 200, `${path} answers 200 (${r.status})`);
    check(path, html.replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&"));
  }
  for (const f of ["wiki/Buying-at-Volume.md", "wiki/LLM-Gateway.md", "README.md"]) check(f, readFileSync(join(ROOT, f), "utf8"));
}
// A model id the LLM-Gateway page says is served as itself until its upstream
// expiration: the day and the successor are the ones RETIRING_MODELS holds.
{
  const { RETIRING_MODELS } = await import("../src/tools/llm-gateway-kit.js");
  const gw = (wiki.find(([f]) => f === "LLM-Gateway.md")?.[1] || "").replace(/\s+/g, " ");
  const stated = [...gw.matchAll(/`([a-z0-9./-]{3,80})` is served as itself until its upstream expiration on (\d{4}-\d{2}-\d{2}), then by `([a-z0-9./-]{3,80})`/g)];
  ok(stated.length >= 1, `LLM-Gateway names a model served as itself until its expiration (${stated.length})`);
  for (const [, id, until, use] of stated) {
    const r = RETIRING_MODELS[id];
    ok(r?.asItselfUntil === true && r.until === until && r.use === use, `LLM-Gateway's ${id}: until ${until}, then ${use} (RETIRING_MODELS: ${r ? `${r.until}, ${r.use}${r.asItselfUntil ? "" : ", not served as itself"}` : "no entry"})`);
  }
}
// The funding refusal classes as the Paying-with-x402 page documents them:
// each class the hints carry, the retry verb they share, the rails a
// no-account refusal comes from and every field of needs (needsOf).
{
  const { hintFor, needsOf } = await import("../src/verify-hint.js");
  const { REJECTION_REASONS } = await import("../src/payment-reject.js");
  const { RAILS } = await import("../src/rails.js");
  const { ALGORAND_MAINNET_CAIP2 } = await import("../src/avm-network.js");
  const pw = readFileSync(join(ROOT, "wiki", "Paying-with-x402.md"), "utf8").replace(/\s+/g, " ");
  const SOL = RAILS.find((r) => /^solana:/.test(r.caip2)).caip2;
  const noAccount = [
    hintFor({ reason: "transaction_simulation_failed", detail: "InstructionError:[2 InvalidAccountData]", network: SOL, priceUsd: 0.01 }),
    hintFor({ reason: "simulation_failed", detail: "HostError: Error(Contract, #13) trustline entry is missing", network: "stellar:pubnet", priceUsd: 0.01 }),
    hintFor({ reason: "simulation_failed", detail: `asset 31566704 missing from ${"A".repeat(58)}`, payTo: "B".repeat(58), network: ALGORAND_MAINNET_CAIP2, priceUsd: 0.01 }),
  ];
  const short = hintFor({ reason: "invalid_exact_evm_insufficient_balance", network: "eip155:137", priceUsd: 0.01 });
  const classes = [short.reason, ...new Set(noAccount.map((h) => h.reason))];
  const retry = short.retry;
  ok(classes.length === 2 && classes.every((c) => REJECTION_REASONS.some((r) => r.reason === c)) && noAccount.every((h) => h.retry === retry), `control: the funding classes are ${classes.join(", ")}, retry ${retry}`);
  for (const c of classes) ok(pw.includes(`(\`reason: "${c}"\``) || pw.includes(`(\`reason: "${c}"\`:`), `Paying-with-x402 names reason ${c}`);
  ok(pw.includes(`\`${retry}\` means the paying wallet holds too little of the asset`), `Paying-with-x402 says what ${retry} means`);
  const rails = noAccount.map((h) => RAILS.find((r) => h.hint.includes(` on ${r.name}`))?.name);
  const naSentence = (pw.split(`reason: "${classes[1]}"`)[1] || "").split(")")[0];
  ok(rails.every(Boolean) && rails.every((r) => naSentence.includes(r)), `Paying-with-x402's no-account sentence names each rail it comes from (${rails.join(", ")})`);
  const keys = Object.keys(needsOf({ network: "eip155:137", asset: "0x" + "ab".repeat(20), amount: "10000" }) || {});
  const needsSentence = (pw.split("carries `needs`:")[1] || "").split(".")[0];
  ok(keys.length >= 4 && keys.every((k) => needsSentence.includes(`\`${k}\``)), `Paying-with-x402's needs sentence names every field needsOf returns (${keys.join(", ")})`);
}
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

// The /v1/images/generations failover the gateway page names is the chain the
// route walks (IMAGE_TIERS["v1-images"]): every link, in order, by the name the
// page uses, and no retired link named as current.
{
  const gw = wiki.find(([f]) => f === "LLM-Gateway.md")[1];
  const NAMES = { "black-forest-labs/flux.2-pro": "FLUX.2 Pro", "microsoft/mai-image-2.6-flash": "MAI-Image-2.6 Flash" };
  const chain = IMAGE_TIERS["v1-images"].chain.map((l) => l.model);
  ok(chain.every((m) => NAMES[m]), `every /v1/images/generations link has a page name here (${chain.join(", ")}); a new link needs its wiki name`);
  const [primary, ...failover] = chain.map((m) => NAMES[m]);
  const row = gw.split("\n").find((l) => l.startsWith("| `POST /v1/images/generations`")) || "";
  ok(row.includes(`${primary} with ${failover.join(", then ")} as the failover`), `LLM-Gateway's images row names ${primary} with ${failover.join(", ")} as the failover`);
  ok(gw.includes(`The model is ${primary} (${failover.join(", then ")} as the failover)`), "LLM-Gateway's images section names the same chain");
  ok(!/GPT-5 Image Mini/i.test(gw), "LLM-Gateway no longer names GPT-5 Image Mini, the retired failover");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
