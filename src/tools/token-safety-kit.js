// token-safety: the cheap, deterministic EVM read of a token contract's
// on-chain risk facts, the counterpart to sol-token-safety on the Solana side.
// The slug keeps its name; the answer is facts, never a judgment of the token.
//
// Every fact is computed here (src/tools/token-facts.js) from chain reads on
// commercial-use RPC lanes (ERC-20 calls, owner and proxy slots, a simulated
// buy and sell that sends nothing), Sourcify's verified ABI and source, and
// DexScreener's pairs. token-risk reads the SAME probe, so the report and the
// cheap check cannot disagree about the same token. No model in this path.
//
// There is deliberately NO verdict, level or score (owner decision,
// 2026-11-24): an "ok" or a band reads as a statement that a token is fine,
// which on-chain facts cannot support. The answer lists each named fact that
// was found (`flags`: id, description, measured value), what could not be
// checked and why (`unknown`), the sources and limits, and the fixed notice
// (src/token-claims.js). A fact this tool could not compute is null and is
// listed in `unknown`; it is never read as an absence of a flag.
import { readTokenFacts, TOKEN_CHAIN_NAMES } from "./token-facts.js";
import { addCredit, SOURCIFY_ATTRIBUTION } from "../data-attribution.js";
import { markResaleCleared } from "../resale-terms.js";
import { TOKEN_FACTS_NOTICE } from "../token-claims.js";
import { rugcheckEnabled } from "../rugcheck-switch.js";

const CHAINS = TOKEN_CHAIN_NAMES;
const bad = (m, statusCode = 422) => Object.assign(new Error(m), { statusCode });

// Each named fact a flag can report: its id, the fact field it reads, when it
// fires and what it says. Order is the order flags are listed in.
const FLAG_RULES = Object.freeze([
  { id: "sell-simulation-reverted", field: "honeypot", when: (v) => v === true, says: "the simulated sell against the deepest pool reverted (a honeypot reading)" },
  { id: "cannot-sell-full-balance", field: "cannotSellAll", when: (v) => v === true, says: "the simulated sell of the full balance did not go through" },
  { id: "buy-blocked", field: "cannotBuy", when: (v) => v === true, says: "the simulated buy did not go through" },
  { id: "listed-as-counterfeit", field: "fakeToken", when: (v) => v?.value === true, says: "a counterfeit list names this contract as a copy of another token" },
  { id: "sell-tax-50-or-more", field: "sellTaxPct", when: (v) => v != null && v >= 50, says: "the simulated sell kept 50% or more of the tokens sold as tax" },
  { id: "buy-tax-50-or-more", field: "buyTaxPct", when: (v) => v != null && v >= 50, says: "the simulated buy kept 50% or more of the tokens bought as tax" },
  { id: "sell-tax-over-10", field: "sellTaxPct", when: (v) => v != null && v > 10 && v < 50, says: "the simulated sell kept more than 10% and under 50% of the tokens sold as tax" },
  { id: "buy-tax-over-10", field: "buyTaxPct", when: (v) => v != null && v > 10 && v < 50, says: "the simulated buy kept more than 10% and under 50% of the tokens bought as tax" },
  { id: "hidden-owner", field: "hiddenOwner", when: (v) => v === true, says: "an owner is set that the owner() reads do not return" },
  { id: "ownership-reclaimable", field: "canTakeBackOwnership", when: (v) => v === true, says: "the contract has a function that can take back renounced ownership" },
  { id: "owner-can-change-balances", field: "ownerChangeBalance", when: (v) => v === true, says: "the owner can change holder balances" },
  { id: "mintable", field: "mintable", when: (v) => v === true, says: "the verified ABI has a function that mints new supply" },
  { id: "transfers-pausable", field: "transferPausable", when: (v) => v === true, says: "the verified ABI has a function that pauses transfers" },
  { id: "blacklist", field: "blacklist", when: (v) => v === true, says: "the verified ABI has a function that blocks addresses from transferring" },
  { id: "owner-can-change-fees", field: "slippageModifiable", when: (v) => v === true, says: "the verified ABI has a function that sets transfer fees" },
  { id: "upgradeable-proxy", field: "proxy", when: (v) => v === true, says: "the contract is an upgradeable proxy, so its code can be replaced" },
  { id: "source-not-verified", field: "openSource", when: (v) => v === false, says: "the source is not verified on Sourcify, so its code cannot be read here" },
]);
export const FLAG_IDS = Object.freeze(FLAG_RULES.map((r) => r.id));

// The checks whose absence is named in `unknown` when not computed, with the
// words that name them.
const CHECKS = Object.freeze([["honeypot", "sell simulation"], ["openSource", "source verification"], ["mintable", "mint function"],
  ["hiddenOwner", "hidden owner"], ["blacklist", "blacklist function"], ["transferPausable", "pause function"],
  ["buyTaxPct", "buy tax"], ["sellTaxPct", "sell tax"]]);

/**
 * The named facts found, from computed facts. `limits` (the probe's reasons a
 * field is null) name why a check is in `unknown`. A null fact never fires a
 * flag and never reads as clear: it lands in `unknown`.
 */
export function tokenFlags(g, limits = []) {
  const flags = [];
  for (const r of FLAG_RULES) {
    const v = g[r.field];
    if (r.when(v)) flags.push({ id: r.id, field: r.field, description: r.says, value: r.field === "fakeToken" ? true : v });
  }
  const unknown = [];
  for (const [field, check] of CHECKS) {
    if (g[field] != null) continue;
    const reason = (limits || []).find((l) => l.field === field)?.reason || "not computed";
    unknown.push({ field, check, reason });
  }
  return { flags, unknown };
}

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
    aliases: ["honeypot-check", "honeypot", "token-tax-check", "token-contract-facts", "evm-token-facts",
      "token-owner-powers", "evm-token-risk-facts", "token-security"],
    description:
      "Risk facts for an EVM token contract, read on chain. One deterministic call lists each named fact it found (flags: an id, a description and the measured value), what it could not check and why (unknown), its sources, its limits and a fixed notice that these are facts read from the chain and named public sources and not investment advice. Each fact is computed here: whether a simulated buy and sell against the token's deepest pool went through and what tax each kept (nothing is sent), owner and renounced state, upgradeable proxy from its storage slots, mint, pause, blacklist and fee-setting functions from the verified ABI, whether the source is publicly verified, owner share and the share of LP tokens held by burn addresses. Covers Base, Ethereum, Polygon, Arbitrum One, OP Mainnet, BSC, Gnosis and Celo. There is no verdict, level or score, and no flags is not a statement about the token. A fact it could not compute is null and listed in unknown with its reason. For the cited, model-written report see token-risk" + (rugcheckEnabled() ? "; for Solana mints see sol-token-safety." : "."),
    pageSummary:
      "Risk facts for an EVM token contract, read on chain by deterministic code. Lists each named fact found (flags), what it could not compute (null, listed in unknown with its reason) and a fixed notice: facts read from the chain and named public sources, not investment advice. Facts: a simulated buy and sell with the tax each kept (nothing is sent), owner and renounced state, upgradeable proxy, mint, pause, blacklist and fee-setting functions, source verification, owner share and burned LP share. Covers Base, Ethereum, Polygon, Arbitrum One, OP Mainnet, BSC, Gnosis and Celo. There is no verdict, level or score, and no flags is not a statement about the token. See token-risk for the model-written report" + (rugcheckEnabled() ? "; for Solana see sol-token-safety." : "."),
    tags: ["token", "honeypot", "tax", "contract", "ownership", "evm", "onchain"],
    // The keyless hosts token-facts.js reads (scripts/test-token-safety.js holds this to its lanes).
    upstreamHosts: ["sourcify.dev", "api.dexscreener.com", "base-rpc.publicnode.com", "mainnet.base.org", "ethereum-rpc.publicnode.com", "polygon-bor-rpc.publicnode.com", "arbitrum-one-rpc.publicnode.com", "arb1.arbitrum.io", "optimism-rpc.publicnode.com", "bsc-rpc.publicnode.com", "gnosis-rpc.publicnode.com", "forno.celo.org"],
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
          "flags": [
            {
              "id": "mintable",
              "field": "mintable",
              "description": "the verified ABI has a function that mints new supply",
              "value": true
            }
          ],
          "unknown": [
            {
              "field": "hiddenOwner",
              "check": "hidden owner",
              "reason": "a hidden owner needs bytecode analysis, which this tool does not run"
            }
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
          "notice": "These are facts read from the chain and named public sources. No flags does not mean a token is legitimate; off-chain fraud cannot be detected here. Not investment advice.",
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
      const limits = g.limits.filter((l) => FACT_FIELDS.includes(l.field));
      const { flags, unknown } = tokenFlags(g, g.limits);
      const facts = Object.fromEntries(FACT_FIELDS.map((k) => [k, g[k] ?? null]));
      const answer = {
        chain, address, flags, unknown, facts,
        source: TOKEN_SAFETY_SOURCE,
        sources: g.sources,
        limits,
        notice: TOKEN_FACTS_NOTICE,
      };
      return g.verification ? addCredit(answer, SOURCIFY_ATTRIBUTION) : answer;
    },
  },
];

// Every source the answer reads is cleared: chain reads on commercial-use
// lanes, Sourcify (public verification data) and DexScreener's computed pair
// fields (src/resale-terms.js).
markResaleCleared(TOKEN_SAFETY_TOOLS, ["token-safety"], "computed from chain reads, Sourcify and DexScreener pairs");
