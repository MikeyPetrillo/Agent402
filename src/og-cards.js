// Section cards: one Open Graph image per SECTION of the site, in the homepage
// card's own layout (obsidian ground, two-line display headline, one sentence,
// a terminal panel with three mono lines, a badge column on the right).
//
// Why (2026-09-14): every section page (/why, /docs, /marketplace, /reports,
// /markets, /sell, /tollbooth, /proof, ...) served the SAME /card.png as its
// og:image, so every link preview on X, Slack and Discord looked identical -
// twelve posts in a day, twelve copies of the same picture - while only the
// tool pages carried their own card. The shell now derives the card from the
// page's own path (ogSectionFor), so no page has to be edited to get one, and
// a page that passes an explicit ogImage keeps it.
//
// Copy rules, same as the site's: no em dashes, evergreen counts only ("600" is
// DERIVED from the booted catalog through ctx, never typed), every price in a
// panel line comes from ctx.price(slug) so a repriced tool cannot leave a stale
// number in a picture, and nothing here names a third party as a comparison.
// This module is a LEAF: it imports nothing from the server; server.js hands
// in the brand tokens and the live figures.

import { RAILS } from "./rails.js";

const CHAIN_KEYS = RAILS.map((r) => ({ key: r.name.toLowerCase().replace(/ chain$/, "").replace(/\s+/g, "-"), name: r.name, asset: r.asset }));

/** Exact path -> section id. Prefix rules live in ogSectionFor. */
const EXACT = {
  "/why": "why", "/docs": "docs", "/tools": "tools", "/marketplace": "marketplace", "/mpp-marketplace": "mpp-marketplace",
  "/markets": "markets", "/decide": "decide", "/reports": "reports", "/monitors": "monitors", "/proof": "proof", "/leaderboard": "leaderboard",
  "/sell": "sell", "/tollbooth": "tollbooth", "/skills": "skills", "/x402-test": "x402-test", "/digest": "digest",
  "/security": "security", "/revenue": "revenue", "/transparency": "transparency", "/status": "status", "/credits": "credits",
  "/101": "learn", "/what-is-mpp": "learn", "/pricing": "docs", "/quickstart": "docs", "/integrations": "guides",
};
const PREFIX = [
  ["/guides", "guides"], ["/reports/", "reports"], ["/skills/", "skills"], ["/monitors", "monitors"], ["/credits", "credits"], ["/tools/", null],
];

/** The section id for a page path, or null when the page keeps the homepage card. */
export function ogSectionFor(pathname) {
  // Bounded and linear on purpose: the canonical can carry a route parameter,
  // and a trailing-slash regex on caller-shaped input is the polynomial
  // backtracking CodeQL flagged in host-entry.js (2026-08-28) and here (#192).
  let p = String(pathname || "").slice(0, 512);
  try { if (/^https?:\/\//i.test(p)) p = new URL(p).pathname; } catch { return null; }
  p = p.split("?")[0].split("#")[0];
  let end = p.length;
  while (end > 1 && p.charCodeAt(end - 1) === 47) end--;
  p = p.slice(0, end) || "/";
  if (Object.hasOwn(EXACT, p)) return EXACT[p];
  for (const [prefix, id] of PREFIX) if (p.startsWith(prefix)) return id; // null for /tools/<slug>: those pass their own card
  const chain = CHAIN_KEYS.find((c) => p === `/${c.key}`);
  return chain ? `chain-${chain.key}` : null;
}

/** Every id the /og/<id>.png route serves. */
export function ogSectionIds() {
  return [...new Set([...Object.values(EXACT), ...PREFIX.map(([, id]) => id).filter(Boolean), ...CHAIN_KEYS.map((c) => `chain-${c.key}`)])];
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The copy for one section. `ctx` carries live figures: toolCount, railCount,
 * price(slug) -> "$0.001" or null, monitorPrice -> "$5".
 */
function sectionCopy(id, ctx) {
  const n = Number(ctx.toolCount || 0).toLocaleString("en-US");
  const rails = ctx.railCount;
  const price = (slug, fallback = "") => ctx.price?.(slug) || fallback;
  const chain = CHAIN_KEYS.find((c) => id === `chain-${c.key}`);
  if (chain) return {
    h1: `${chain.asset} on ${chain.name},`, h2: "priced per call.",
    sub: `${n} tools, one 402, a receipt on every answer. ${rails} rails, one catalog.`,
    lines: [["$ curl agent402.tools/api/hash", "faint"], [`HTTP/2 402  payment-required: ${chain.asset.toLowerCase()} · ${chain.key} · ${price("hash", "0.001").replace("$", "")}`, "amber"], ["HTTP/2 200  payment-response: settled", "accent"]],
    badge: ["x402 · MPP · card", `${rails} rails · USDC · USDG`],
  };
  const C = {
    why: { h1: "Seven claims,", h2: "each with its proof.", sub: "What is different here, and the surface that shows it.",
      lines: [["$ curl agent402.tools/why", "faint"], ["usage priced under a quoted ceiling", "muted"], ["a failed call is not charged, and the receipt proves it", "accent"]], badge: ["x402 · MPP · card", "receipts on every answer"] },
    docs: { h1: "Every route,", h2: "one document.", sub: "OpenAPI, prices, the 402 you will get and the receipt you will hold.",
      lines: [["$ curl agent402.tools/openapi.json", "faint"], [`${n} operations, typed 200s, one price each`, "muted"], ["x402 · MPP · credits key on the same routes", "accent"]], badge: ["OpenAPI 3.1", `${rails} rails`] },
    tools: { h1: `${n} tools,`, h2: "priced in cents.", sub: "Search the catalog, read the price, pay per call. No account.",
      lines: [["$ curl agent402.tools/api/find?q=whois", "faint"], [`HTTP/2 200  whois · ${price("whois", "$0.005")} · POST /api/whois`, "accent"], ["free tier over proof of work for pure-compute tools", "muted"]], badge: ["x402 · MPP · card", `${rails} rails`] },
    marketplace: { h1: "Every x402 seller,", h2: "in one index.", sub: "Sellers, their routes and prices, and whether our router would pay them.",
      lines: [["$ curl agent402.tools/api/index?perPage=25", "faint"], ["routable · health · dispatch verdict per row", "muted"], ["read from their own 402, never from a form", "accent"]], badge: ["x402 · MPP", "we rank others"] },
    "mpp-marketplace": { h1: "Every MPP seller", h2: "on Tempo.", sub: "Live Payment challenges, ranked by inbound USDC.e, routable when our router can pay.",
      lines: [["$ curl agent402.tools/api/mpp-index", "faint"], ["WWW-Authenticate: Payment  tempo/charge · USDC.e", "amber"], ["Payment-Receipt on every settled answer", "accent"]], badge: ["MPP · x402", "Tempo mainnet"] },
    markets: { h1: "Market data,", h2: "priced per call.", sub: "Perps, options, prediction markets, DeFi, tokenized assets. Keyless upstreams.",
      lines: [["$ curl -X POST agent402.tools/api/crypto-market-pulse", "faint"], [`HTTP/2 402  usdc · base · ${price("crypto-market-pulse", "$0.004").replace("$", "")}`, "amber"], ["HTTP/2 200  breadth · open interest · funding", "accent"]], badge: ["x402 · MPP · card", "24 keyless tools"] },
    decide: { h1: "Describe the job.", h2: "Get the plan.", sub: "Which tools, in what order, with fallbacks and valid params, across this catalog and outside x402 sellers.",
      lines: [["$ curl -X POST agent402.tools/api/decide", "faint"], [ctx.decide ? `HTTP/2 402  usdc · base · ${ctx.decide.quick} to ${ctx.decide.full}` : "HTTP/2 402  priced per decision", "amber"], ["HTTP/2 200  plan · fallbacks · gaps · firstParty on every tool", "accent"]], badge: ["x402 · MPP · card", "one formula for every seller"] },
    reports: { h1: "Finished reports,", h2: "by card or by call.", sub: "Research, dossiers, 13F funds, domain audits, recalls, insider flow.",
      lines: [["$ curl -X POST agent402.tools/v1/research", "faint"], [`HTTP/2 402  usdc · base · ${price("research", "$0.60").replace("$", "")}`, "amber"], ["HTTP/2 200  sources cited, gaps named, tables included", "accent"]], badge: ["x402 · MPP · card", "monitors from $5/mo"] },
    monitors: { h1: "Watch one target,", h2: "get told when it moves.", sub: `A free probe every day, a full report only on change. ${ctx.monitorPrice || "$5"} a month.`,
      lines: [["domain · fund · insider · recall · filing · token · research · IPO", "muted"], ["renewals over MPP on Tempo, or by card", "accent"], ["cancel any time, nothing is charged for a quiet day", "faint"]], badge: ["MPP · card", "one-off reports over x402"] },
    proof: { h1: "Receipts,", h2: "not claims.", sub: "The latest metered settlement, ours and an outside buyer's, with the tx.",
      lines: [["$ curl agent402.tools/api/proof", "faint"], ["quoted worst case · settled actual · under the quote", "muted"], ["tx on Base, linked", "accent"]], badge: ["x402 · MPP", "metered tier"] },
    leaderboard: { h1: "Who actually", h2: "gets paid.", sub: "Settled x402 payments per payee, read from public chains. We rank others.",
      lines: [["$ curl agent402.tools/api/leaderboard", "faint"], ["include=external by default", "muted"], ["self:true on our own row when you ask for all", "accent"]], badge: ["x402 · MPP", "counts, never addresses"] },
    sell: { h1: "Sell to agents", h2: "in one call.", sub: "Register an origin. We read your 402, learn the price and list you. Free.",
      lines: [["$ curl -X POST agent402.tools/api/index/register", "faint"], ["{\"origin\":\"https://api.yourcompany.com\"}", "muted"], ["listed · routable · dispatch verdict on the row", "accent"]], badge: ["x402 · MPP", "no account"] },
    tollbooth: { h1: "Pay-per-crawl", h2: "for your own site.", sub: "Bots pay, people pass. x402 accepts and MPP challenges on the same 402.",
      lines: [["$ npx agent402-tollbooth", "faint"], ["HTTP/2 402  WWW-Authenticate: Payment · PAYMENT-REQUIRED", "amber"], ["HTTP/2 200  X-Tollbooth-Paid", "accent"]], badge: ["x402 · MPP", "Tempo native"] },
    skills: { h1: "Skill packs,", h2: "priced from their parts.", sub: "Multi-tool workflows. Each costs the sum of its tools minus 10%.",
      lines: [["$ curl -X POST agent402.tools/api/skill/crypto-dossier", "faint"], ["HTTP/2 200  steps: 6/6 succeeded", "accent"], ["a pack where nothing succeeds refuses rather than charges", "muted"]], badge: ["x402 · MPP", "85+ packs"] },
    "x402-test": { h1: "Refused payment?", h2: "The 402 says why.", sub: "Reason, retry class and a hint on every rejected x402 or MPP credential.",
      lines: [["$ curl agent402.tools/x402-test", "faint"], ["HTTP/2 402  reason: under-price · retry: fund-wallet", "amber"], ["the reason table is built from the classifier the gate runs", "muted"]], badge: ["x402 · MPP", "conformance"] },
    guides: { h1: "Guides,", h2: "copy-paste ready.", sub: "Claude Code, Cursor, Codex, OpenClaw, AgentKit, tollbooths, wallets.",
      lines: [["$ claude mcp add --transport http agent402 https://agent402.tools/mcp", "faint"], ["ANTHROPIC_BASE_URL=https://agent402.tools/v1/metered", "muted"], ["x402 · MPP · credits key", "accent"]], badge: ["agents", "sellers"] },
    digest: { h1: "One email a week,", h2: "what your wallet spent.", sub: "Calls, dollars, tools, chains. Prove the wallet, confirm by click.",
      lines: [["$ curl agent402.tools/digest", "faint"], ["signed proof · double opt-in · x402 and MPP settlements alike", "muted"], ["unsubscribe drops the address", "accent"]], badge: ["x402 wallets", "credits keys"] },
    security: { h1: "What we hold,", h2: "and what we do not.", sub: "Non-custodial on every x402 and MPP rail; the two card paths named.",
      lines: [["security.txt · CodeQL · secret scanning on every push", "muted"], ["two business days to acknowledge a report", "faint"], ["safe harbor for researchers", "accent"]], badge: ["x402 · MPP", "disclosures"] },
    revenue: { h1: "Our own books,", h2: "published.", sub: "Outside settlements by chain and by day; buyers as a running union, never a sum.",
      lines: [["$ curl agent402.tools/api/revenue/daily", "faint"], ["external only in the headline", "muted"], ["our own volume runs labeled as ours", "accent"]], badge: ["x402 rails", "MPP wire"] },
    transparency: { h1: "Disclosures,", h2: "in one place.", sub: "What each number measures, what it does not, and who counts it.",
      lines: [["charged-but-failed is a debt, not an alarm", "muted"], ["refunds verified on chain before they leave", "accent"], ["counts only, never addresses", "faint"]], badge: ["x402 · MPP", "measured, not asserted"] },
    status: { h1: "Measured", h2: "from outside.", sub: "Two observers. No data is never uptime. Every percentage carries its count.",
      lines: [["cloudflare cron · github heartbeat", "muted"], ["api · catalog · mcp · paywall · rails", "faint"], ["a daily paid buy over x402 on every chain, MPP on Tempo", "accent"]], badge: ["x402 · MPP", "outside production"] },
    credits: { h1: "No wallet?", h2: "Buy credits by card.", sub: "$20, $50 or $100. A key, pay per call, a hard cap, no card on file.",
      lines: [["Authorization: Bearer a402_…", "faint"], ["HTTP/2 200  X-Credits-Balance: 19.99", "accent"], ["every priced route, the metered tier included", "muted"]], badge: ["card", "x402 · MPP on the same routes"] },
    learn: { h1: "x402 and MPP,", h2: "in five minutes.", sub: "The 402 handshake, both wires, and a live demo you can pay.",
      lines: [["HTTP/2 402  PAYMENT-REQUIRED · WWW-Authenticate: Payment", "amber"], ["sign · retry · settle", "muted"], ["HTTP/2 200  payment-response: settled", "accent"]], badge: ["x402 · MPP", `${rails} rails`] },
  };
  return C[id] || null;
}

/** Render the SVG for a section id. Returns null for an unknown id. */
export function sectionCardSvg(id, ctx, width = 1200, height = 630) {
  const copy = sectionCopy(id, ctx);
  if (!copy) return null;
  const { BRAND, BRAND_DEFS, BRAND_FONT_STYLE } = ctx;
  const s = Math.min(width / 1200, height / 630);
  const tx = (width - 1200 * s) / 2, ty = (height - 630 * s) / 2;
  const mono = JSON.stringify(BRAND.mono), display = JSON.stringify(BRAND.display);
  const tone = { faint: BRAND.faint, muted: BRAND.muted, amber: BRAND.amber, accent: BRAND.accent };
  // The two headline lines share one size; a long line shrinks both so nothing
  // runs into the badge column or off the right edge (86px fits ~22 chars).
  const longest = Math.max(copy.h1.length, copy.h2.length);
  const hsize = longest <= 22 ? 86 : longest <= 27 ? 72 : 60;
  const line = (i, [text, t]) => `<text x="100" y="${472 + i * 34}" font-size="19" font-family=${mono} fill="${tone[t] || BRAND.muted}">${esc(text)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${BRAND_FONT_STYLE}${BRAND_DEFS}
  <rect width="${width}" height="${height}" fill="${BRAND.paper}"/>
  <g transform="translate(${tx},${ty}) scale(${s})">
  <rect x="72" y="64" width="44" height="44" rx="12" fill="url(#milled)"/>
  <text x="132" y="96" font-size="30" font-weight="600" font-family=${display} letter-spacing="-0.5" fill="${BRAND.ink}">Agent402</text>
  <text x="1128" y="95" font-size="20" font-family=${mono} text-anchor="end" fill="${BRAND.faint}">agent402.tools</text>
  <text x="72" y="238" font-size="${hsize}" font-weight="600" font-family=${display} letter-spacing="-3" fill="${BRAND.ink}">${esc(copy.h1)}</text>
  <text x="72" y="${238 + hsize + 6}" font-size="${hsize}" font-weight="600" font-family=${display} letter-spacing="-3" fill="${BRAND.faint}">${esc(copy.h2)}</text>
  <text x="72" y="392" font-size="23" font-family=${display} fill="${BRAND.muted}">${esc(copy.sub)}</text>
  <rect x="72" y="430" width="1056" height="140" rx="16" fill="url(#panel)" stroke="${BRAND.hairline}" stroke-width="1.5"/>
  ${copy.lines.slice(0, 3).map((l, i) => line(i, l)).join("\n  ")}
  <text x="1100" y="472" font-size="15" font-family=${mono} text-anchor="end" fill="${BRAND.faint}">${esc(copy.badge[0])}</text>
  <text x="1100" y="506" font-size="15" font-family=${mono} text-anchor="end" fill="${BRAND.faint}">${esc(copy.badge[1])}</text>
  </g>
</svg>`;
}
