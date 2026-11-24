// token-safety: the cheap, deterministic EVM answer to "is this token safe to
// trade", the counterpart to sol-token-safety on the Solana side.
//
// Why this exists (2026-09-13, measured): our only EVM answer to that question
// was `token-risk` at $0.60, a model-written cited report. That is the wrong
// SHAPE for the question an agent asks before a swap - it wants a verdict in
// one call for a cent, not a report - and the wrong price.
//
// Every fact is computed here (src/tools/token-facts.js) from chain reads on
// commercial-use RPC lanes (ERC-20 calls, owner and proxy slots, a simulated
// buy and sell that sends nothing), Sourcify's verified ABI and source, and
// DexScreener's pairs. token-risk reads the SAME probe, so the report and the
// cheap check cannot disagree about the same token. No model in this path.
//
// The verdict is derived from named facts and says which fact drove it. There
// is deliberately NO score: a number invites a ranking, and a ranking over
// computed flags reads as a measurement we did not make (the same reasoning as
// the feedback kit's two verdicts, and why seller-dossier ends in sentences).
// A fact this tool could not compute is null, listed in `unknown` and named
// with its reason in `limits`; it never counts as safe.
import { readTokenFacts, TOKEN_CHAIN_NAMES } from "./token-facts.js";
import { addCredit, SOURCIFY_ATTRIBUTION } from "../data-attribution.js";
import { markResaleCleared } from "../resale-terms.js";

const CHAINS = TOKEN_CHAIN_NAMES;
const bad = (m, statusCode = 422) => Object.assign(new Error(m), { statusCode });

/**
 * Deterministic verdict from computed facts.
 *
 * `unsafe` is reserved for things that take a buyer's money outright; `caution`
 * for powers an owner COULD use; `ok` only when nothing fired. A null flag is
 * UNKNOWN and never counts as safe - it lands in `unknown` so the caller can
 * see what was not computed rather than read silence as a pass.
 */
export function safetyVerdict(g) {
  const blocking = [], warnings = [], unknown = [];
  const t = (v) => v === true;
  if (t(g.honeypot)) blocking.push("honeypot: the simulated sell reverted");
  if (t(g.cannotSellAll)) blocking.push("cannot sell the full balance");
  if (t(g.cannotBuy)) blocking.push("buying is blocked");
  if (g.fakeToken?.value === true) blocking.push("flagged as a counterfeit of another token");
  // The `!= null` on the tax thresholds is a READABILITY belt, not load-bearing:
  // `(x ?? 0)` fails these comparisons identically, so no mutation can kill it.
  // What IS load-bearing is listing an uncomputed tax under `unknown` below -
  // the first cut computed thresholds off `?? 0` and reported nothing, so a
  // token whose tax was never measured read as a clean bill.
  if (g.sellTaxPct != null && g.sellTaxPct >= 50) blocking.push(`sell tax ${g.sellTaxPct}%`);
  if (g.buyTaxPct != null && g.buyTaxPct >= 50) blocking.push(`buy tax ${g.buyTaxPct}%`);

  if (t(g.hiddenOwner)) warnings.push("hidden owner");
  if (t(g.canTakeBackOwnership)) warnings.push("ownership can be reclaimed");
  if (t(g.ownerChangeBalance)) warnings.push("owner can change balances");
  if (t(g.mintable)) warnings.push("supply is mintable");
  if (t(g.transferPausable)) warnings.push("transfers can be paused");
  if (t(g.blacklist)) warnings.push("addresses can be blacklisted");
  if (t(g.slippageModifiable)) warnings.push("fees can be changed by the owner");
  if (t(g.proxy)) warnings.push("upgradeable proxy");
  if (g.openSource === false) warnings.push("source is not verified on Sourcify");
  if (g.sellTaxPct != null && g.sellTaxPct > 10 && g.sellTaxPct < 50) warnings.push(`sell tax ${g.sellTaxPct}%`);
  if (g.buyTaxPct != null && g.buyTaxPct > 10 && g.buyTaxPct < 50) warnings.push(`buy tax ${g.buyTaxPct}%`);

  for (const [k, label] of [["honeypot", "honeypot"], ["openSource", "source verified"], ["mintable", "mintable"],
    ["hiddenOwner", "hidden owner"], ["blacklist", "blacklist"], ["transferPausable", "pausable"],
    ["buyTaxPct", "buy tax"], ["sellTaxPct", "sell tax"]]) {
    if (g[k] == null) unknown.push(label);
  }

  const verdict = blocking.length ? "unsafe" : warnings.length ? "caution" : "ok";
  const because = blocking[0] || warnings[0]
    || (unknown.length ? "no blocking or owner-power flag fired, but some checks were not computed" : "no blocking or owner-power flag fired");
  return { verdict, because, blocking, warnings, unknown };
}

/** The `facts` an answer carries, in the order they have always been listed. */
export const FACT_FIELDS = Object.freeze(["honeypot", "cannotSellAll", "cannotBuy", "openSource", "proxy", "mintable",
  "ownerAddress", "ownerRenounced", "hiddenOwner", "canTakeBackOwnership", "transferPausable", "blacklist",
  "slippageModifiable", "buyTaxPct", "sellTaxPct", "holderCount", "lpHolderCount", "lpLockedPct", "creatorPct",
  "ownerPct", "fakeToken"]);
export const TOKEN_SAFETY_SOURCE = "computed here: chain reads (ERC-20 calls, owner and proxy slots, a simulated buy and sell), Sourcify's verified ABI and source, DexScreener pairs";

export const TOKEN_SAFETY_TOOLS = [
  {
    route: "POST /api/token-safety",
    name: "EVM token risk check",
    slug: "token-safety",
    category: "crypto",
    price: "$0.005",
    aliases: ["honeypot-check", "honeypot", "rugpull-check", "scam-token-check", "token-scam-check",
      "malicious-token", "is-this-token-safe", "evm-token-safety", "token-security"],
    description:
      "Risk facts for an EVM token before a trade. One deterministic call returns a verdict (ok, caution, unsafe) with the named facts behind it, each computed here: honeypot, can-sell and buy and sell tax from a simulated buy and sell against the token's deepest pool (nothing is sent), owner and renounced state, upgradeable proxy from its storage slots, mintable supply, pausable transfers, blacklist and owner-set fees from the verified ABI, verified source, owner share and LP burn share. Covers Base, Ethereum, Polygon, Arbitrum, Optimism, BSC, Gnosis and Celo. A fact it could not compute is null, listed as unknown with its reason in limits, never counted as safe. For the cited, researched version see token-risk; for Solana mints see sol-token-safety.",
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
        example: {
          "chain": "base",
          "address": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
          "verdict": "caution",
          "because": "supply is mintable",
          "blocking": [],
          "warnings": [
            "supply is mintable"
          ],
          "unknown": [
            "hidden owner"
          ],
          "facts": {
            "honeypot": false,
            "cannotSellAll": false,
            "cannotBuy": false,
            "openSource": true,
            "proxy": false,
            "mintable": true,
            "ownerAddress": null,
            "ownerRenounced": null,
            "hiddenOwner": null,
            "canTakeBackOwnership": false,
            "transferPausable": false,
            "blacklist": false,
            "slippageModifiable": false,
            "buyTaxPct": 0,
            "sellTaxPct": 0,
            "holderCount": null,
            "lpHolderCount": null,
            "lpLockedPct": 0,
            "creatorPct": null,
            "ownerPct": null,
            "fakeToken": null
          },
          "source": "computed here: chain reads (ERC-20 calls, owner and proxy slots, a simulated buy and sell), Sourcify's verified ABI and source, DexScreener pairs",
          "sources": [
            "chain RPC: ERC-20 calls, owner and proxy slots (eth_call, eth_getStorageAt)",
            "DexScreener: pairs and liquidity",
            "Sourcify: verification, ABI and source",
            "chain RPC: buy and sell simulation (eth_simulateV1)"
          ],
          "limits": [
            {
              "field": "proxy",
              "reason": "checked the EIP-1967, EIP-1822, beacon and ZeppelinOS slots, Sourcify's proxy reading and EIP-1167 code; other proxy patterns are not detected"
            },
            {
              "field": "ownerAddress",
              "reason": "the contract answers neither owner() nor getOwner()"
            },
            {
              "field": "ownerPct",
              "reason": "no owner address"
            },
            {
              "field": "lpLockedPct",
              "reason": "the share of the deepest pool's LP tokens held by burn addresses; LP held in locker contracts is not counted"
            },
            {
              "field": "holderCount",
              "reason": "holder index not available for this token",
              "detail": "no keyed log lane for this chain"
            },
            {
              "field": "hiddenOwner",
              "reason": "a hidden owner needs bytecode analysis, which this tool does not run"
            },
            {
              "field": "creatorPct",
              "reason": "the contract creator is not read"
            },
            {
              "field": "lpHolderCount",
              "reason": "LP holder lists are not indexed"
            },
            {
              "field": "fakeToken",
              "reason": "no counterfeit list is read"
            }
          ],
          "credit": "Verified source from Sourcify (https://sourcify.dev)."
        },
      },
    },
    async handler(input = {}) {
      const address = String(input.address || input.token || input.contract || "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw bad("`address` must be a 0x EVM token contract address");
      const chain = String(input.chain || "base").trim().toLowerCase();
      if (!CHAINS.includes(chain)) throw bad(`\`chain\` must be one of: ${CHAINS.join(", ")}`);
      const g = await readTokenFacts({ chain, address });
      const v = safetyVerdict(g);
      const facts = Object.fromEntries(FACT_FIELDS.map((k) => [k, g[k] ?? null]));
      const answer = {
        chain, address, ...v, facts,
        source: TOKEN_SAFETY_SOURCE,
        sources: g.sources,
        limits: g.limits.filter((l) => FACT_FIELDS.includes(l.field)),
      };
      return g.verification ? addCredit(answer, SOURCIFY_ATTRIBUTION) : answer;
    },
  },
];

// Every source the answer reads is cleared: chain reads on commercial-use
// lanes, Sourcify (public verification data) and DexScreener's computed pair
// fields (src/resale-terms.js).
markResaleCleared(TOKEN_SAFETY_TOOLS, ["token-safety"], "computed from chain reads, Sourcify and DexScreener pairs");
