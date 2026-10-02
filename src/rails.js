// Single source of truth for the payment rails Agent402 advertises.
//
// Every public surface (landing pages, FAQ, llms.txt, the /.well-known/x402
// manifest, JSON-LD, the MCP connector's self-description) derives its
// "supported chains" copy from RAILS below — so adding a rail is a one-line
// change here, not a twenty-file sweep, and a page can no longer silently
// advertise a stale chain list. scripts/test-rails.js locks this file against
// src/payments.js: a network added there without a RAILS entry fails CI.
//
// Copy is DERIVED, not hand-written, so the strings can never disagree with
// the data. Keep prose-heavy narrative (guides/blog bodies) as prose — this
// module owns the *claims*, not the storytelling.

export const RAILS = [
  { name: "Base", asset: "USDC", caip2: "eip155:8453", chainId: 8453, primary: true },
  { name: "Solana", asset: "USDC", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
  { name: "Polygon", asset: "USDC", caip2: "eip155:137", chainId: 137 },
  { name: "Arbitrum", asset: "USDC", caip2: "eip155:42161", chainId: 42161 },
  { name: "Monad", asset: "USDC", caip2: "eip155:143", chainId: 143 },
  { name: "Celo", asset: "USDC", caip2: "eip155:42220", chainId: 42220 },
  { name: "Avalanche", asset: "USDC", caip2: "eip155:43114", chainId: 43114 },
  { name: "Sei", asset: "USDC", caip2: "eip155:1329", chainId: 1329 },
  { name: "Optimism", asset: "USDC", caip2: "eip155:10", chainId: 10 },
  { name: "Stellar", asset: "USDC", caip2: "stellar:pubnet" },
  { name: "Algorand", asset: "USDC", caip2: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" },
  { name: "Robinhood Chain", asset: "USDG", caip2: "eip155:4663", chainId: 4663 },
];

const usdc = RAILS.filter((r) => r.asset === "USDC").map((r) => r.name);
const others = RAILS.filter((r) => r.asset !== "USDC");
const usdcAmp = `${usdc.slice(0, -1).join(", ")} & ${usdc.at(-1)}`;
const usdcOr = `${usdc.slice(0, -1).join(", ")}, or ${usdc.at(-1)}`;
const othersDash = others.map((o) => ` - or ${o.asset} on ${o.name}`).join("");
const othersPlus = others.map((o) => ` - plus ${o.asset} on ${o.name}`).join("");

/** "USDC on Base, Solana, Polygon, Arbitrum & Stellar — plus USDG on Robinhood Chain" */
export const RAILS_AMP = `USDC on ${usdcAmp}${othersPlus}`;

/** "USDC on Base, Solana, Polygon, Arbitrum, or Stellar — or USDG on Robinhood Chain" */
export const RAILS_OR = `USDC on ${usdcOr}${othersDash}`;

/** "USDC on Base (or Solana, Polygon, Arbitrum, Stellar — or USDG on Robinhood Chain)" —
 *  the "primary chain first" phrasing used in buyer-facing prose. */
export const RAILS_PAREN = `USDC on ${usdc[0]} (or ${usdc.slice(1).join(", ")}${othersDash})`;

/** "USDC on Base + 10 more chains, or USDG on Robinhood Chain" — tight UI copy (derives live from RAILS). */
export const RAILS_SHORT = `USDC on ${usdc[0]} + ${usdc.length - 1} more chains${others.length ? `, or ${others.map((o) => `${o.asset} on ${o.name}`).join(" / ")}` : ""}`;

/** Chain names for the /.well-known/x402 manifest's ecosystem.chains. */
export const RAIL_CHAIN_NAMES = RAILS.map((r) => r.name);

/** JSON-LD operatingSystem string. */
export const RAILS_OS = RAILS.map((r) =>
  r.chainId ? `${r.name} (EVM, chain ID ${r.chainId}${r.asset !== "USDC" ? `, ${r.asset}` : ""})` : r.name
).join(", ");

/** Topbar ticker strip: "BASE · SOLANA · POLYGON · ARBITRUM · ROBINHOOD · USDC · USDG".
 *  Chain names shortened (" Chain" dropped) and uppercased for the site chrome. */
export const RAILS_TICKER = [...RAILS.map((r) => r.name.replace(/ Chain$/, "")), ...new Set(RAILS.map((r) => r.asset))]
  .join(" · ")
  .toUpperCase();

/** Manifest note — settlement summary for discovery agents. */
export const RAILS_NOTE =
  `x402 settlements use USDC on ${usdcOr}` +
  others.map((o) => ` - plus ${o.asset} (${o.asset === "USDG" ? "Global Dollar" : o.asset}) on ${o.name}`).join("") +
  ". Gas is sponsored by the facilitator on EVM chains - callers need only the stablecoin.";

/** Short display key for a rail: "Robinhood Chain" -> "robinhood". Used for
 *  ?network= query params and CSS-class-safe identifiers. */
export const railKey = (r) => r.name.replace(/ Chain$/, "").toLowerCase().replace(/\s+/g, "");

/** Truncate a CAIP-2 id for tight UI cells (chain strip, index chips) — full
 *  value belongs in a title attribute, never dropped outright. Short ids
 *  (eip155:8453, stellar:pubnet) pass through whole; only ids that would
 *  blow out a grid column (solana's base58 pubkey, algorand's base64 genesis
 *  hash) get shortened to "namespace:first5…". */
export function truncateCaip2(caip2, { max = 18, tail = 5 } = {}) {
  const s = String(caip2 || "");
  if (s.length <= max) return s;
  const idx = s.indexOf(":");
  if (idx === -1) return `${s.slice(0, tail)}…`;
  return `${s.slice(0, idx + 1)}${s.slice(idx + 1, idx + 1 + tail)}…`;
}

/** True when a route's x402 offer is EVM `exact` only. ONE predicate, read by
 *  src/payments.js acceptsForItem (the live 402) and by every surface that
 *  names the rails a route takes (/openapi.json, /tools/<slug>), so the docs
 *  cannot list a chain the 402 withholds:
 *    - identity-bound routes: the payer is the signed EIP-3009 authorization;
 *    - long-running routes: settlement after a multi-minute run needs the
 *      EIP-3009 validity window;
 *    - a route naming `onlyNetworks`: the handler serves those chains only. */
export function x402EvmOnly(item) {
  return !!(item && (item.identityBound || item.longRunning || (Array.isArray(item.onlyNetworks) && item.onlyNetworks.length)));
}

/** The RAILS entries a route's x402 402 can offer (before PAYMENT_NETWORKS
 *  narrows them, exactly as RAILS_OR does for the whole catalog). */
export function x402RailsFor(item) {
  const only = Array.isArray(item?.onlyNetworks) && item.onlyNetworks.length ? new Set(item.onlyNetworks) : null;
  return RAILS.filter((r) => (!x402EvmOnly(item) || r.caip2.startsWith("eip155:")) && (!only || only.has(r.caip2)));
}

/** RAILS_OR phrasing for one route's own rails, e.g. "USDC on Base, Polygon,
 *  or Optimism - or USDG on Robinhood Chain". Equals RAILS_OR for a route that
 *  takes every rail. */
export function railsOrFor(item) {
  const rails = x402RailsFor(item);
  const u = rails.filter((r) => r.asset === "USDC").map((r) => r.name);
  const o = rails.filter((r) => r.asset !== "USDC").map((r) => `${r.asset} on ${r.name}`);
  const list = u.length <= 1 ? u.join("") : u.length === 2 ? `${u[0]} or ${u[1]}` : `${u.slice(0, -1).join(", ")}, or ${u.at(-1)}`;
  if (!u.length) return o.join(" - or ");
  return `USDC on ${list}${o.map((t) => ` - or ${t}`).join("")}`;
}
