// token-safety — the cheap, deterministic EVM answer to "is this token safe to
// trade", the counterpart to sol-token-safety on the Solana side.
//
// Why this exists (2026-09-13, measured): our only EVM answer to that question
// was `token-risk` at $0.60, an LLM-synthesised cited report. That is the wrong
// SHAPE for the question an agent actually asks before a swap - it wants a
// verdict in one call for a cent, not a report - and the wrong price: a seller
// running the same GoPlus leg sells it at $0.01 and takes the traffic. Solana
// buyers already had `sol-token-safety` at $0.005; EVM buyers had nothing under
// sixty cents.
//
// It reuses the EXACT probe `token-risk` already runs (probeGoPlus/shapeGoPlus,
// keyless), so this is not a second source of truth - the report and the cheap
// check cannot disagree about the same token. No model anywhere in the path.
//
// The verdict is derived from named facts and says which fact drove it. There
// is deliberately NO score: a number invites a ranking, and a ranking over
// vendor flags reads as a measurement we did not make (the same reasoning as
// the feedback kit's two verdicts, and why seller-dossier ends in sentences).
import { probeGoPlus } from "./token-risk-kit.js";

const CHAINS = ["base", "ethereum", "polygon", "arbitrum", "optimism", "bsc", "gnosis", "celo"];
const bad = (m, statusCode = 422) => Object.assign(new Error(m), { statusCode });

/**
 * Deterministic verdict from GoPlus facts.
 *
 * `unsafe` is reserved for things that take a buyer's money outright; `caution`
 * for powers an owner COULD use; `ok` only when nothing fired. A null flag is
 * UNKNOWN and never counts as safe - it lands in `unknown` so the caller can
 * see what the upstream did not answer rather than read silence as a pass.
 */
export function safetyVerdict(g) {
  const blocking = [], warnings = [], unknown = [];
  const t = (v) => v === true;
  if (t(g.honeypot)) blocking.push("honeypot: the contract blocks selling");
  if (t(g.cannotSellAll)) blocking.push("cannot sell the full balance");
  if (t(g.cannotBuy)) blocking.push("buying is blocked");
  if (g.fakeToken?.value === true) blocking.push("flagged as a counterfeit of another token");
  // The `!= null` on the tax thresholds is a READABILITY belt, not load-bearing:
  // `(x ?? 0)` fails these comparisons identically, so no mutation can kill it.
  // What IS load-bearing is listing an unanswered tax under `unknown` below -
  // the first cut computed thresholds off `?? 0` and reported nothing, so a
  // token whose tax the upstream never answered read as a clean bill.
  if (g.sellTaxPct != null && g.sellTaxPct >= 50) blocking.push(`sell tax ${g.sellTaxPct}%`);

  if (t(g.hiddenOwner)) warnings.push("hidden owner");
  if (t(g.canTakeBackOwnership)) warnings.push("ownership can be reclaimed");
  if (t(g.ownerChangeBalance)) warnings.push("owner can change balances");
  if (t(g.mintable)) warnings.push("supply is mintable");
  if (t(g.transferPausable)) warnings.push("transfers can be paused");
  if (t(g.blacklist)) warnings.push("addresses can be blacklisted");
  if (t(g.slippageModifiable)) warnings.push("slippage is modifiable");
  if (t(g.proxy)) warnings.push("upgradeable proxy");
  if (g.openSource === false) warnings.push("source is not verified");
  if (g.sellTaxPct != null && g.sellTaxPct > 10 && g.sellTaxPct < 50) warnings.push(`sell tax ${g.sellTaxPct}%`);
  if (g.buyTaxPct != null && g.buyTaxPct > 10) warnings.push(`buy tax ${g.buyTaxPct}%`);

  for (const [k, label] of [["honeypot", "honeypot"], ["openSource", "source verified"], ["mintable", "mintable"],
    ["hiddenOwner", "hidden owner"], ["blacklist", "blacklist"], ["transferPausable", "pausable"],
    ["buyTaxPct", "buy tax"], ["sellTaxPct", "sell tax"]]) {
    if (g[k] == null) unknown.push(label);
  }

  const verdict = blocking.length ? "unsafe" : warnings.length ? "caution" : "ok";
  const because = blocking[0] || warnings[0]
    || (unknown.length ? "no blocking or owner-power flag fired, but some checks were unanswered" : "no blocking or owner-power flag fired");
  return { verdict, because, blocking, warnings, unknown };
}

export const TOKEN_SAFETY_TOOLS = [
  {
    route: "POST /api/token-safety",
    name: "EVM token safety check",
    slug: "token-safety",
    category: "crypto",
    price: "$0.005",
    aliases: ["honeypot-check", "honeypot", "rugpull-check", "scam-token-check", "token-scam-check",
      "malicious-token", "is-this-token-safe", "evm-token-safety", "token-security"],
    description:
      "Is this EVM token safe to trade? One deterministic call returns a verdict (ok, caution, unsafe) with the named facts behind it: honeypot, can-sell, buy and sell tax, mintable supply, hidden or reclaimable ownership, pausable transfers, blacklist, modifiable slippage, upgradeable proxy, verified source, LP lock share and holder counts. Covers Base, Ethereum, Polygon, Arbitrum, Optimism, BSC, Gnosis and Celo. No model in the path, so the same token always gives the same answer; checks the upstream could not answer are listed as unknown rather than counted as safe. For the cited, researched version see token-risk; for Solana mints see sol-token-safety.",
    tags: ["token", "safety", "honeypot", "rugpull", "evm"],
    discovery: {
      bodyType: "json",
      input: { chain: "base", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
      inputSchema: {
        type: "object",
        properties: {
          chain: { type: "string", description: `One of: ${CHAINS.join(", ")}.` },
          address: { type: "string", description: "Token contract address (0x…)." },
        },
        required: ["address"],
      },
      output: {
        // The real answer for the documented input, captured from a live run.
        // The upstream answers every check for this token now, so `unknown`
        // is empty; the shape sweep fails an example whose arrays show data
        // the live answer does not carry.
        example: {
          "chain": "base",
          "address": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
          "verdict": "caution",
          "because": "supply is mintable",
          "blocking": [],
          "warnings": [
            "supply is mintable"
          ],
          "unknown": [],
          "facts": {
            "honeypot": false,
            "cannotSellAll": false,
            "cannotBuy": false,
            "openSource": true,
            "proxy": false,
            "mintable": true,
            "ownerAddress": null,
            "ownerRenounced": null,
            "hiddenOwner": false,
            "canTakeBackOwnership": false,
            "transferPausable": false,
            "blacklist": false,
            "slippageModifiable": false,
            "buyTaxPct": 0,
            "sellTaxPct": 0,
            "holderCount": 754627,
            "lpHolderCount": 175,
            "lpLockedPct": 0,
            "creatorPct": 0,
            "ownerPct": 0,
            "fakeToken": null
          },
          "source": "GoPlus token_security"
        },
      },
    },
    async handler(input = {}) {
      const address = String(input.address || input.token || input.contract || "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw bad("`address` must be a 0x EVM token contract address");
      const chain = String(input.chain || "base").trim().toLowerCase();
      if (!CHAINS.includes(chain)) throw bad(`\`chain\` must be one of: ${CHAINS.join(", ")}`);
      const g = await probeGoPlus({ chain, address });
      const v = safetyVerdict(g);
      return {
        chain, address, ...v,
        facts: {
          honeypot: g.honeypot, cannotSellAll: g.cannotSellAll, cannotBuy: g.cannotBuy,
          openSource: g.openSource, proxy: g.proxy, mintable: g.mintable,
          ownerAddress: g.ownerAddress, ownerRenounced: g.ownerRenounced, hiddenOwner: g.hiddenOwner,
          canTakeBackOwnership: g.canTakeBackOwnership, transferPausable: g.transferPausable,
          blacklist: g.blacklist, slippageModifiable: g.slippageModifiable,
          buyTaxPct: g.buyTaxPct, sellTaxPct: g.sellTaxPct,
          holderCount: g.holderCount, lpHolderCount: g.lpHolderCount, lpLockedPct: g.lpLockedPct,
          creatorPct: g.creatorPct, ownerPct: g.ownerPct, fakeToken: g.fakeToken || null,
        },
        source: "GoPlus token_security",
      };
    },
  },
];
