// ONE registry of every priced report tier, so "what does this cost and what is
// it allowed to spend" has a single answer.
//
// Built because `maxUpstreamUsd` was a DECLARED bound in 8 of the 10 report
// kits: only research-deep and ticker-pack read their own field at runtime, and
// everywhere else the number was a comment that nothing checked. That is how it
// drifted below measured cost without anyone noticing, and how three products
// ended up priced under their own worst case.
//
// The kits keep owning their tier config; this only collects it.
import { RESEARCH_TIERS } from "./tools/research-deep-kit.js";
import { DOSSIER_TIERS } from "./tools/dossier-kit.js";
import { FUND_TIERS } from "./tools/fund-report-kit.js";
import { DOMAIN_AUDIT_TIERS } from "./tools/domain-audit-kit.js";
import { RECALL_TIERS } from "./tools/recall-report-kit.js";
import { INSIDER_TIERS } from "./tools/insider-flow-kit.js";
import { TOKEN_RISK_TIERS } from "./tools/token-risk-kit.js";
import { TOKEN_BRIEF_TIERS } from "./tools/token-brief-kit.js";
import { rugcheckEnabled } from "./rugcheck-switch.js";
import { FILING_TIERS } from "./tools/filing-watch-kit.js";
import { TICKER_PACK_TIERS } from "./tools/ticker-pack-kit.js";
import { LINKEDIN_TIERS } from "./tools/linkedin-article-kit.js";

export const REPORT_TIERS = {
  ...RESEARCH_TIERS, ...DOSSIER_TIERS, ...FUND_TIERS, ...DOMAIN_AUDIT_TIERS,
  ...RECALL_TIERS, ...INSIDER_TIERS, ...TOKEN_RISK_TIERS, ...TOKEN_BRIEF_TIERS,
  ...FILING_TIERS, ...TICKER_PACK_TIERS, ...LINKEDIN_TIERS,
};

/** The declared upstream ceiling for a slug, or null when it is not a report. */
export function capUsdFor(slug) {
  const t = REPORT_TIERS[String(slug ?? "")];
  const n = t ? Number(t.maxUpstreamUsd) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** List price for a slug, or null. */
export function priceUsdFor(slug) {
  const t = REPORT_TIERS[String(slug ?? "")];
  if (!t) return null;
  const n = Number(String(t.price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The report/monitor price ladder as PROSE, derived from the tables above.
 *
 * This exists because two surfaces typed it by hand and both drifted after the
 * 2026-08-23 repricing: the hosted MCP connector's `payment.info` still quoted
 * "research $0.35/$0.65/$1.10 … ticker pack $0.75 … monitors $3 a month" and
 * /pricing still said monitors were "$3 a month", against real prices of
 * $0.60/$0.85/$1.10, $2.00 and $5. Every figure was understated 1.7x to 3.4x.
 *
 * That is the one error class this site's argument cannot survive: an agent
 * budgeting from a machine surface under-budgets, pays, and is refused. The
 * llms.txt copy was right the whole time because it derives its numbers, so
 * this is the same trick, exported once for everyone who quotes a ladder.
 *
 * @param {object} deps HUMAN_PRODUCTS and MONITOR_PRODUCTS (cents), injected so
 *   this module stays free of the checkout imports that would cycle back to it.
 */
export function reportLadderProse({ humanProducts = null, monitorProducts = null } = {}) {
  const usd = (n) => `$${n.toFixed(2).replace(/\.00$/, "")}`;
  const agent = (slugs) => [...new Set(slugs.map(priceUsdFor).filter(Boolean))].sort((a, b) => a - b).map(usd).join("/");
  const tiers = (label, slugs) => `${label} ${agent(slugs)}`;
  const parts = [
    tiers("research", ["research", "research-pro", "research-max"]),
    tiers("dossier", ["dossier", "dossier-max"]),
    tiers("ticker pack", ["ticker-pack"]),
    tiers("fund 13F", ["fund-report", "fund-report-max"]),
    tiers("SEC filing", ["filing-report"]),
    tiers("domain audit", ["domain-audit", "domain-audit-pro"]),
    tiers("FDA recall", ["recall-report"]),
    tiers("insider flow", ["insider-report"]),
    tiers("market brief", ["market-brief"]),
    ...(rugcheckEnabled() ? [tiers("token brief", ["token-brief"])] : []),
    tiers("token risk", ["token-risk", "token-risk-pro"]),
  ].filter((p) => /\$/.test(p));

  const cardCents = Object.values(humanProducts || {}).map((p) => Number(p?.price)).filter((n) => Number.isFinite(n) && n > 0);
  const cardLo = cardCents.length ? usd(Math.min(...cardCents) / 100) : null;
  const cardHi = cardCents.length ? usd(Math.max(...cardCents) / 100) : null;
  const monCents = [...new Set(Object.values(monitorProducts || {}).map((p) => Number(p?.price)).filter((n) => Number.isFinite(n) && n > 0))];
  const monthly = monCents.length === 1 ? usd(monCents[0] / 100) : monCents.map((c) => usd(c / 100)).sort().join("/");

  return {
    agentLadder: parts.join(", "),
    cardLadder: cardLo && cardHi ? (cardLo === cardHi ? cardLo : `${cardLo} to ${cardHi}`) : null,
    monthly: monthly || null,
    monthlySentence: monthly ? `${monthly} a month per target` : null,
  };
}

/**
 * The agent-facing report price ladder as a range, derived from REPORT_TIERS.
 *
 * Exists because `/mcp`'s `payment.info` hand-typed "report products $0.20-$1.10"
 * and kept it through two repricings: the low end was three times under the real
 * floor and the high end omitted the $2.00 ticker pack, on the surface an agent
 * budgets from. A machine surface that under-quotes gets the buyer refused at
 * the 402 it was told to expect.
 */
export function agentReportPriceRange() {
  const usd = [...new Set(Object.values(REPORT_TIERS).map((t) => Number(String(t.price).replace(/[^0-9.]/g, ""))))]
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (!usd.length) return null;
  const fmt = (n) => `$${n.toFixed(2)}`;
  return { min: usd[0], max: usd[usd.length - 1], text: `${fmt(usd[0])}-${fmt(usd[usd.length - 1])}` };
}

/**
 * The CARD report price range, derived from the product table passed in.
 *
 * /faq quoted a card range below its own floor long after the floor moved,
 * which is an under-quote a reader meets at checkout. Takes the products as
 * an argument so a copy page never has to import the Stripe-backed module.
 */
export function cardReportPriceRange(humanProducts) {
  const cents = [...new Set(Object.values(humanProducts || {}).map((p) => Number(p?.price)))]
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (!cents.length) return null;
  const fmt = (c) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;
  return { min: cents[0], max: cents[cents.length - 1], text: `${fmt(cents[0])} to ${fmt(cents[cents.length - 1])}` };
}
