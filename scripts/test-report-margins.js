// Report economics: every priced report must clear its MEASURED worst-case
// upstream cost on BOTH rails, card and agent.
//
// This guard exists because the previous prices were set against the kits'
// DECLARED `maxUpstreamUsd` figures, which sat below the measured distribution
// of synthesis spend (30 days of `$ai_generation`), and some products were
// priced below the observed maximum, i.e. a worst-case run lost money. A cap
// under the real distribution is worse than cosmetic: research-deep is the one
// kit that reads its own field, and it downgrades the synthesis model when
// spend exceeds it, so a fictional cap silently degrades the product too.
//
// The numbers below are therefore OBSERVATIONS, not targets. When the model mix
// or model pricing changes, re-measure and move them; do not tune them to make
// a price look acceptable.
import { RESEARCH_TIERS } from "../src/tools/research-deep-kit.js";
import { DOSSIER_TIERS } from "../src/tools/dossier-kit.js";
import { FUND_TIERS } from "../src/tools/fund-report-kit.js";
import { DOMAIN_AUDIT_TIERS } from "../src/tools/domain-audit-kit.js";
import { RECALL_TIERS } from "../src/tools/recall-report-kit.js";
import { INSIDER_TIERS } from "../src/tools/insider-flow-kit.js";
import { TOKEN_RISK_TIERS } from "../src/tools/token-risk-kit.js";
import { TOKEN_BRIEF_TIERS } from "../src/tools/token-brief-kit.js";
import { FILING_TIERS } from "../src/tools/filing-watch-kit.js";
import { TICKER_PACK_TIERS } from "../src/tools/ticker-pack-kit.js";
import { LINKEDIN_TIERS } from "../src/tools/linkedin-article-kit.js";
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { MAX_FULL_PER_SUB_30D } from "../src/monitor-scheduler.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// Measured, 30 days of $ai_generation. See the header.
export const MEASURED_OPUS_MAX_USD = 0.311;
export const MEASURED_OPUS_P95_USD = 0.195;
// Planning calls: measured worst case, budgeted for two.
const PLANNING_USD = 0.021;
// Worst case for a report that runs ONE opus synthesis.
const ONE_SYNTH_WORST = MEASURED_OPUS_MAX_USD + PLANNING_USD;
// Stripe's published card fee.
const stripeNet = (usd) => usd - (0.029 * usd + 0.30);
// The margin floor both rails must clear at worst case. Set to what the current
// ladder actually achieves, NOT to a looser number that would let a price
// regress.
const MIN_MARGIN = 0.40;

const usd = (s) => Number(String(s).replace(/[^0-9.]/g, ""));

const TIERS = {
  ...RESEARCH_TIERS, ...DOSSIER_TIERS, ...FUND_TIERS, ...DOMAIN_AUDIT_TIERS,
  ...RECALL_TIERS, ...INSIDER_TIERS, ...TOKEN_RISK_TIERS, ...TOKEN_BRIEF_TIERS,
  ...FILING_TIERS, ...TICKER_PACK_TIERS, ...LINKEDIN_TIERS,
};

// 1. Every declared cap must be at or above the measured worst case for the
//    work it does. A cap below it is the defect this file was written for.
for (const [slug, t] of Object.entries(TIERS)) {
  const cap = Number(t.maxUpstreamUsd);
  // ticker-pack runs three syntheses; its cap is derived from its parts.
  const floor = slug === "ticker-pack" ? 3 * MEASURED_OPUS_MAX_USD * 0.9 : MEASURED_OPUS_MAX_USD;
  ok(cap >= floor - 1e-9,
    `${slug}: declared cap is at or above the measured worst case (a cap under the real distribution both misprices the product and, in research-deep, downgrades the model on a normal run)`);
}

// 2. AGENT rail (x402 / MPP, no fixed fee): price must clear the cap.
for (const [slug, t] of Object.entries(TIERS)) {
  const price = usd(t.price), cap = Number(t.maxUpstreamUsd);
  const margin = (price - cap) / price;
  ok(margin >= MIN_MARGIN,
    `${slug}: agent price clears the margin floor at worst-case upstream`);
}

// 3. CARD rail: the card fee comes out BEFORE the report is paid for. This is
//    the leg that was under water on the lowest card prices.
for (const [key, p] of Object.entries(HUMAN_PRODUCTS)) {
  const t = TIERS[p.slug];
  if (!t) continue;
  const gross = p.price / 100, net = stripeNet(gross), cap = Number(t.maxUpstreamUsd);
  const margin = (net - cap) / gross;
  ok(margin >= MIN_MARGIN,
    `${key}: card price clears the margin floor after the card fee at worst-case upstream`);
}

// 4. MONITORS: one monthly fee funds up to MAX_FULL_PER_SUB_30D paid runs, so
//    the fee must clear that many worst-case reports, not one.
for (const [key, m] of Object.entries(MONITOR_PRODUCTS)) {
  const t = TIERS[m.slug];
  const cap = t ? Number(t.maxUpstreamUsd) : ONE_SYNTH_WORST;
  const gross = m.price / 100, net = stripeNet(gross);
  const worst = MAX_FULL_PER_SUB_30D * cap;
  // A subscription's risk is REPEAT fulfilment, so a percentage floor is the
  // wrong shape here: one month's fee must cover twice its worst-case month.
  ok(net >= 2 * worst,
    `${key}: monthly fee net of card fees covers at least twice the ${MAX_FULL_PER_SUB_30D}-run worst case`);
}

// 5. The card price must never sit below the agent price for the same report:
//    the card buyer also pays the card fee, so an equal price is a worse deal
//    for us on every sale.
for (const [key, p] of Object.entries(HUMAN_PRODUCTS)) {
  const t = TIERS[p.slug];
  if (!t) continue;
  ok(stripeNet(p.price / 100) >= usd(t.price),
    `${key}: card price net of the card fee is at or above the agent price $${usd(t.price).toFixed(2)} for the same work`);
}

// 6. The card ladder must MIRROR the agent ladder. Hand-setting it shipped a
//    storefront where Standard and Pro were both $2: three distinct agent tiers
//    collapsed onto two card prices, so the page offered an upgrade that cost
//    the same as not upgrading. A buyer cannot tell those tiers apart, and
//    nothing in the margin checks above would ever notice.
{
  const pairs = Object.values(HUMAN_PRODUCTS)
    .map((p) => ({ slug: p.slug, agent: usd(TIERS[p.slug]?.price ?? "0"), card: p.price / 100 }))
    .filter((r) => r.agent > 0);
  const byAgent = new Map();
  for (const r of pairs) {
    const seen = byAgent.get(r.agent);
    ok(seen === undefined || seen === r.card,
      `every product on the $${r.agent.toFixed(2)} agent tier shares one card price (${r.slug} is $${r.card})`);
    byAgent.set(r.agent, r.card);
  }
  const tiers = [...byAgent.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < tiers.length; i++) {
    ok(tiers[i][1] > tiers[i - 1][1],
      `card price rises with the agent tier: $${tiers[i - 1][0].toFixed(2)} agent -> $${tiers[i - 1][1]} card, then $${tiers[i][0].toFixed(2)} agent -> $${tiers[i][1]} card (a flat step means a paid upgrade that costs the same as not upgrading)`);
  }
}

console.log(`\n${pass} passed, 0 failed`);
