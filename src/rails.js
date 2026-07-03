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
  { name: "Robinhood Chain", asset: "USDG", caip2: "eip155:4663", chainId: 4663 },
];

const usdc = RAILS.filter((r) => r.asset === "USDC").map((r) => r.name);
const others = RAILS.filter((r) => r.asset !== "USDC");
const usdcAmp = `${usdc.slice(0, -1).join(", ")} & ${usdc.at(-1)}`;
const usdcOr = `${usdc.slice(0, -1).join(", ")}, or ${usdc.at(-1)}`;
const othersDash = others.map((o) => ` — or ${o.asset} on ${o.name}`).join("");
const othersPlus = others.map((o) => ` — plus ${o.asset} on ${o.name}`).join("");

/** "USDC on Base, Solana, Polygon & Arbitrum — plus USDG on Robinhood Chain" */
export const RAILS_AMP = `USDC on ${usdcAmp}${othersPlus}`;

/** "USDC on Base, Solana, Polygon, or Arbitrum — or USDG on Robinhood Chain" */
export const RAILS_OR = `USDC on ${usdcOr}${othersDash}`;

/** "USDC on Base (or Solana, Polygon, Arbitrum — or USDG on Robinhood Chain)" —
 *  the "primary chain first" phrasing used in buyer-facing prose. */
export const RAILS_PAREN = `USDC on ${usdc[0]} (or ${usdc.slice(1).join(", ")}${othersDash})`;

/** "USDC on Base + 3 more chains, or USDG on Robinhood Chain" — tight UI copy. */
export const RAILS_SHORT = `USDC on ${usdc[0]} + ${usdc.length - 1} more chains${others.length ? `, or ${others.map((o) => `${o.asset} on ${o.name}`).join(" / ")}` : ""}`;

/** Chain names for the /.well-known/x402 manifest's ecosystem.chains. */
export const RAIL_CHAIN_NAMES = RAILS.map((r) => r.name);

/** JSON-LD operatingSystem string. */
export const RAILS_OS = RAILS.map((r) =>
  r.chainId ? `${r.name} (EVM, chain ID ${r.chainId}${r.asset !== "USDC" ? `, ${r.asset}` : ""})` : r.name
).join(", ");

/** Manifest note — settlement summary for discovery agents. */
export const RAILS_NOTE =
  `x402 settlements use USDC on ${usdcOr}` +
  others.map((o) => ` — plus ${o.asset} (${o.asset === "USDG" ? "Global Dollar" : o.asset}) on ${o.name}`).join("") +
  ". Gas is sponsored by the facilitator on EVM chains — callers need only the stablecoin.";
