import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { convertToTokenAmount, numberToDecimalString } from "@x402/core/utils";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";
import {
  BUILDER_CODE,
  builderCodeResourceServerExtension,
  declareBuilderCodeExtension,
} from "@x402/extensions/builder-code";
import { normalizePayerAddress } from "./payer.js";

// Supported networks. EVM chains use eip155: CAIP-2 IDs; Solana uses the
// solana: genesis-hash CAIP-2. Adding a chain = register its scheme + list
// it in `accepts`. Only chains a facilitator can settle are safe to add.
// Chains missing from @x402/evm's built-in asset registry are fine too —
// a money parser supplies the asset + on-chain-verified EIP-712 domain
// (the Monad/Celo mechanism, generalized in TIER1_USDC below).
const EVM_NETWORKS = {
  base: "eip155:8453",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  // Monad (EVM L1, chain 143). Native Circle USDC is in @x402/evm's built-in
  // asset registry (eip155:143 → 0x754704Bc059F8C67012fEd69BC8A327a5aafb603),
  // so the standard exact/USDC path settles it — no custom money parser.
  // Settlement routes to Monad's DEDICATED facilitator (MONAD_FACILITATOR_URL,
  // wired below) — PayAI/CDP do not advertise eip155:143. OPT-IN: offered only
  // when `monad` is listed in PAYMENT_NETWORKS.
  monad: "eip155:143",
  // Celo (EVM L2, chain 42220). Native Circle USDC, but NOT in @x402/evm's
  // built-in asset registry — and like Monad its on-chain EIP-712 name is
  // "USDC" (verified via forno.celo.org 2026-07-20), so it uses the custom
  // money parser + the Celo-operated facilitator wired below
  // (api.x402.celo.org, keyless, advertises exact/eip155:42220). OPT-IN:
  // offered only when `celo` is listed in PAYMENT_NETWORKS.
  celo: "eip155:42220",
  // Tier 1 expansion (2026-07-20, all settled by PayAI — already a client in
  // multi-chain mode, so routing is automatic; assets + EIP-712 domains
  // verified on-chain, see TIER1_USDC). OPT-IN via PAYMENT_NETWORKS.
  avalanche: "eip155:43114",
  sei: "eip155:1329",
  // Optimism (OP mainnet, chain 10). Native Circle USDC with the STANDARD
  // "USD Coin" v2 domain (verified on-chain 2026-07-28 via mainnet.optimism.io)
  // but absent from @x402/evm's registry, so it rides the TIER1_USDC parser.
  // Settlement routes to Solvador (the keyed client wired below) — the ONLY
  // facilitator we have that settles eip155:10; CDP/PayAI do not. Solvador
  // charges $0.001/settlement past 1,000/month, so this chain carries a
  // NETWORK_PRICE_PREMIUMS entry (eip155:10=0.001) per the fee-charging-
  // primary pricing rule. OPT-IN via PAYMENT_NETWORKS.
  optimism: "eip155:10",
  "base-sepolia": "eip155:84532",
  // Robinhood Chain (Arbitrum Orbit L2, EVM-equivalent, AI-native RWA chain).
  // NOT in @x402/evm's built-in USDC registry, and settles a non-Circle
  // stablecoin (USDG / Global Dollar) via a configured external settlement
  // facilitator, so it uses the custom money parser + facilitator wired below.
  // OPT-IN only: it settles nothing unless `robinhood` is listed in
  // PAYMENT_NETWORKS, so the working USDC path is untouched by default.
  robinhood: "eip155:4663",
};
const SVM_NETWORKS = {
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};
const STELLAR_NETWORKS = {
  stellar: "stellar:pubnet",
};
const AVM_NETWORKS = {
  // Algorand mainnet (genesis-hash CAIP-2). USDC is ASA 31566704 — resolved by
  // @x402/avm's built-in asset config, so no custom money parser. Settlement
  // via the GoPlausible-operated facilitator (keyless /supported verified
  // 2026-07-10); fee-sponsored, so buyers don't need ALGO for gas.
  algorand: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
};
// Exported for scripts/test-rails.js: the copy layer (src/rails.js) must
// advertise every mainnet rail this file can settle — the test cross-checks.
export const NETWORKS = { ...EVM_NETWORKS, ...SVM_NETWORKS, ...STELLAR_NETWORKS, ...AVM_NETWORKS };

// Robinhood Chain settles USDG (Global Dollar), not Circle USDC, and @x402/evm
// has no default asset for chain 4663 — so we resolve the asset ourselves and
// route settlement to an external facilitator that advertises
// exact/eip155:4663/USDG at its /supported endpoint. The facilitator URL is
// operator-supplied via ROBINHOOD_FACILITATOR_URL (no default is baked in);
// the USDG EIP-712 domain (name/version) is likewise env-overridable and can be
// verified on-chain via scripts/rh-chain-probe.js before enabling.
const ROBINHOOD_CAIP2 = "eip155:4663";
const ROBINHOOD_FACILITATOR_URL = (process.env.ROBINHOOD_FACILITATOR_URL || "").trim();
// Monad (chain 143) settles native Circle USDC (in @x402/evm's registry, so the
// standard ExactEvmScheme handles it — no custom parser). But PayAI and CDP do
// NOT advertise eip155:143 at their /supported, so Monad must route to its own
// dedicated facilitator, which advertises exact/eip155:143. It's public + keyless
// (the molandak-operated facilitator from docs.monad.xyz/guides/x402), so a sane
// default is baked in; override with MONAD_FACILITATOR_URL. Advertises only
// Monad (143 + testnet 10143), so it wins that route without touching other rails.
const MONAD_CAIP2 = "eip155:143";
const MONAD_FACILITATOR_URL = (process.env.MONAD_FACILITATOR_URL || "https://x402-facilitator.molandak.org").trim();
// Monad's native Circle USDC reports name() = "USDC" on-chain (NOT the usual
// "USD Coin"), and the EIP-3009 transferWithAuthorization domain separator is
// built from that name. @x402/evm's built-in registry hardcodes "USD Coin" for
// eip155:143, so a buyer signs against the wrong domain and settlement fails
// ("unexpected_error"). We override the EIP-712 name to the real on-chain value
// via a money parser (same mechanism as Robinhood's USDG domain), so the accept
// advertises the correct { name, version } and the buyer signs a valid auth.
// Verified on-chain 2026-07-12: name()="USDC", version()="2", decimals=6.
const MONAD_USDC = {
  asset: (process.env.MONAD_USDC_ADDRESS || "0x754704Bc059F8C67012fEd69BC8A327a5aafb603").trim(),
  decimals: 6,
  name: (process.env.MONAD_USDC_EIP712_NAME || "USDC").trim(),
  version: (process.env.MONAD_USDC_EIP712_VERSION || "2").trim(),
};
// Celo (chain 42220) settles native Circle USDC via the Celo-operated
// facilitator at api.x402.celo.org (keyless /supported verified 2026-07-20,
// advertises exact/eip155:42220 at x402 v2). @x402/evm has no default asset
// for 42220, and the on-chain EIP-712 name is "USDC" (not "USD Coin") —
// verified via forno.celo.org: name()="USDC", version()="2", decimals=6,
// EIP-3009 TRANSFER_WITH_AUTHORIZATION_TYPEHASH present — so a money parser
// supplies both the asset and the correct signing domain.
const CELO_CAIP2 = "eip155:42220";
const CELO_FACILITATOR_URL = (process.env.CELO_FACILITATOR_URL || "https://api.x402.celo.org").trim();
// The Celo facilitator's /supported and /verify are keyless, but /settle
// requires an X-API-Key (observed live 2026-07-20: 401 "Missing X-API-Key";
// their docs don't mention it yet). Keys are free + self-service: sign a
// no-gas message with any wallet at https://x402.celo.org (POST /api/keys,
// SIWE-style; key shown once, prefix x402_…; rotate on the same page). The
// key is rate-limit/account identity only — settle is NOT payTo-bound.
const CELO_FACILITATOR_KEY = (process.env.CELO_FACILITATOR_KEY || "").trim();
const CELO_USDC = {
  asset: (process.env.CELO_USDC_ADDRESS || "0xcebA9300f2b948710d2653dD7B07f33A8B32118C").trim(),
  decimals: 6,
  name: (process.env.CELO_USDC_EIP712_NAME || "USDC").trim(),
  version: (process.env.CELO_USDC_EIP712_VERSION || "2").trim(),
};
const USDG = {
  asset: (process.env.ROBINHOOD_USDG_ADDRESS || "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168").trim(),
  decimals: 6,
  // EIP-712 domain used to sign the transferWithAuthorization. Defaults are
  // best-effort; verify against USDG.eip712Domain() on chain 4663 and override
  // ROBINHOOD_USDG_EIP712_NAME / ROBINHOOD_USDG_EIP712_VERSION if they differ.
  name: (process.env.ROBINHOOD_USDG_EIP712_NAME || "Global Dollar").trim(),
  version: (process.env.ROBINHOOD_USDG_EIP712_VERSION || "1").trim(),
};

// An ExactEvmScheme that settles USDG on Robinhood Chain: the money parser turns
// a dollar price into a USDG AssetAmount, bypassing @x402/evm's USDC-only
// default-asset lookup (which throws for chain 4663).
function makeUsdgScheme() {
  return new ExactEvmScheme().registerMoneyParser((amount, network) => {
    if (String(network) !== ROBINHOOD_CAIP2) return null;
    return {
      amount: convertToTokenAmount(numberToDecimalString(amount), USDG.decimals),
      asset: USDG.asset,
      extra: { name: USDG.name, version: USDG.version },
    };
  });
}

// Monad USDC with the CORRECT on-chain EIP-712 name ("USDC", not @x402/evm's
// registry default "USD Coin"). Same override mechanism as makeUsdgScheme — the
// asset address is unchanged (Circle USDC), only the signing domain is fixed.
function makeMonadUsdcScheme() {
  return new ExactEvmScheme().registerMoneyParser((amount, network) => {
    if (String(network) !== MONAD_CAIP2) return null;
    return {
      amount: convertToTokenAmount(numberToDecimalString(amount), MONAD_USDC.decimals),
      asset: MONAD_USDC.asset,
      extra: { name: MONAD_USDC.name, version: MONAD_USDC.version },
    };
  });
}

// Tier 1 chains (Avalanche / Sei): USDC deployments @x402/evm's
// registry lacks, with EIP-712 domains verified on-chain 2026-07-20. Sei's
// trap: the prominent "USDC" there is Noble's IBC bridge WITHOUT EIP-3009 —
// the address below is Circle's native deployment (name "USDC", the
// Monad/Celo-style domain). One table + one factory replaces per-chain
// copies of the Monad/Celo parser shape.
const TIER1_USDC = {
  "eip155:43114": { asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, name: "USD Coin", version: "2" }, // Avalanche C-Chain, native Circle
  "eip155:1329": { asset: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", decimals: 6, name: "USDC", version: "2" }, // Sei, native Circle (NOT Noble's 0x3894…)
  "eip155:10": { asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, name: "USD Coin", version: "2" }, // Optimism, native Circle (verified 2026-07-28)
};
function makeTier1UsdcScheme(caip2) {
  const cfg = TIER1_USDC[caip2];
  return new ExactEvmScheme().registerMoneyParser((amount, network) => {
    if (String(network) !== caip2) return null;
    return {
      amount: convertToTokenAmount(numberToDecimalString(amount), cfg.decimals),
      asset: cfg.asset,
      extra: { name: cfg.name, version: cfg.version },
    };
  });
}

// ONE money table for EVERY scheme registered on a chain.
//
// The per-scheme factories above were written when `exact` was the only scheme,
// so the override lived on the factory rather than the chain. Adding `upto`
// registered the STOCK scheme with no parser, which falls back to
// @x402/evm's default-asset registry — and that registry has no entry for
// Celo, Robinhood, Optimism, Avalanche or Sei, so parsePrice THROWS on five of
// nine EVM rails.
//
// That is not a per-chain outage. buildPaymentRequirementsFromOptions has no
// per-option try/catch, so one throwing option aborts the WHOLE accepts array:
// a Base-priced route 500s because a Celo option threw. Site-wide, no
// payment-required header, nobody can pay - while /health stays green, so a
// healthcheck accepts the deploy.
//
// Keyed by chain, applied to whatever scheme is being registered, so a future
// scheme cannot silently miss the override the way upto just did.
function moneyOverrideFor(caip2) {
  if (caip2 === ROBINHOOD_CAIP2) return USDG;
  if (caip2 === MONAD_CAIP2) return MONAD_USDC;
  if (caip2 === CELO_CAIP2) return CELO_USDC;
  return TIER1_USDC[caip2] || null;
}
/** Apply the chain's money override to any EVM scheme instance. */
function withMoney(scheme, caip2) {
  const cfg = moneyOverrideFor(caip2);
  if (!cfg) return scheme;
  return scheme.registerMoneyParser((amount, network) => {
    if (String(network) !== caip2) return null;
    return {
      amount: convertToTokenAmount(numberToDecimalString(amount), cfg.decimals),
      asset: cfg.asset,
      extra: { name: cfg.name, version: cfg.version },
    };
  });
}

// Celo USDC with the CORRECT on-chain EIP-712 name ("USDC") and the asset
// address @x402/evm's registry lacks. Same override mechanism as Monad.
function makeCeloUsdcScheme() {
  return new ExactEvmScheme().registerMoneyParser((amount, network) => {
    if (String(network) !== CELO_CAIP2) return null;
    return {
      amount: convertToTokenAmount(numberToDecimalString(amount), CELO_USDC.decimals),
      asset: CELO_USDC.asset,
      extra: { name: CELO_USDC.name, version: CELO_USDC.version },
    };
  });
}

/** Which networks to accept. PAYMENT_NETWORKS="base,polygon,arbitrum" opts in;
 *  default is the single primary network (current behavior, zero change). The
 *  primary `network` is always included and listed first (it carries the Bazaar
 *  resource + is what the facilitator must support). */
export function enabledNetworks(network) {
  const requested = (process.env.PAYMENT_NETWORKS || network)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // The primary network must be known — it carries the Bazaar resource and is
  // what the facilitator must settle — so a bad NETWORK is a hard error.
  if (!NETWORKS[network]) {
    throw new Error(`Unsupported primary network "${network}". Known: ${Object.keys(NETWORKS).join(", ")}`);
  }
  const names = [network, ...requested.filter((n) => n !== network)];
  const seen = new Set();
  const out = [];
  for (const n of names) {
    // An UNKNOWN extra network in PAYMENT_NETWORKS is skipped with a warning
    // rather than thrown — otherwise a typo, or adding a chain to the env var
    // before the code that knows it is the running build (e.g. `robinhood`
    // before chain 4663 shipped), would crash boot and take down ALL payments.
    // Degrade to the known networks instead; the missing one just isn't offered.
    if (!NETWORKS[n]) {
      console.warn(
        `Ignoring unknown PAYMENT_NETWORKS entry "${n}" - not offered. Known: ${Object.keys(NETWORKS).join(", ")}`
      );
      continue;
    }
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// An identity-bound route derives the caller's namespace / usage identity from
// the SIGNED EVM authorization field (payerFromRequest), which is EVM-only by
// construction (EIP-3009 `authorization.from`). Non-EVM schemes (SVM/Stellar/
// AVM) don't sign an authorization.from, so a buyer who paid one of those rails
// would settle on-chain and THEN get an identity error — a charged failure
// (security audit A402-03). The wallet-scoped memory family and the
// wallet-keyed my-usage report are the only such routes. Marked centrally where
// the catalog is assembled; keyed here so code and tests share one definition.
export const isIdentityBoundRoute = (def) =>
  def?.category === "memory" || def?.slug === "my-usage";

// Build the `accepts` list for one catalog item. EVM rails always apply. For an
// identity-bound route that is ALL it advertises, so a buyer can never settle on
// a rail whose identity the handler can't derive. EVERY other tool keeps all
// configured chains — restricting is scoped strictly to identity routes, so all
// rails keep selling the rest of the catalog. Behavior for non-identity items is
// byte-identical to the previous inline builder.
// The SOR external-router tiers. Their BASE leg is settled to the burner (the
// x402 spending wallet) instead of the treasury, so the external float pays
// itself: buyer -> burner -> external seller nets +fee, replacing a one-way
// drain that needed manual top-ups. Base only, because external settlement is
// Base-only (x402-buyer.js pins Base USDC); every other chain keeps the treasury
// payTo. Gated on a configured burner address (X402_UPSTREAM_BUYER_ADDRESS) so a
// clone without one falls back to the treasury, unchanged. A periodic
// burner->treasury sweep (scripts/sweep-burner.js) keeps the hot wallet bounded.
// EVERY tier must be here: a tier missing from this set settles its revenue
// to the treasury while its external spends drain the burner - the one-way
// leak this mechanism exists to close (the plus tier shipped without it for
// one commit on 2026-07-29; test-route-execute now locks the set against
// EXEC_TIERS so the next tier cannot repeat that).
// Router tiers only - the subset whose Algorand revenue is chain-matched to
// the AVM spending wallet (see avmPayToFor). Blockscout stays out: its
// upstream spend is Base-pinned regardless of the buyer's rail.
export const AVM_SELF_FUNDING_SLUGS = new Set(["route-execute", "route-execute-plus", "route-execute-max"]);
const AVM_UPSTREAM_BUYER_ADDRESS = (process.env.ALGORAND_UPSTREAM_BUYER_ADDRESS || "").trim();

export const SELF_FUNDING_SLUGS = new Set([
  "route-execute", "route-execute-plus", "route-execute-max",
  // Blockscout kit (2026-07-29, the house rule: everything that spends from the
  // burner settles to the burner): each call pays Blockscout ~$0.002 upstream
  // from the same wallet, so treasury-settled revenue was a slow one-way
  // drain needing manual top-ups. Revenue attribution already handles the
  // burner on both sides (receiver = revenue, payer/sweeps = internal).
  "contract-inspect", "address-profile", "token-info", "token-holders", "tx-inspect",
]);
const UPSTREAM_BUYER_ADDRESS = (process.env.X402_UPSTREAM_BUYER_ADDRESS || "").trim();

// ---------------------------------------------------------------------------
// Per-chain price premiums (Phase B pricing engine, 2026-07-27)
// ---------------------------------------------------------------------------
// Mike's binding rule: anything settled through a fee-charging facilitator must
// be priced to cover the fee — structurally, not by memory. Each 402 accepts
// entry carries its own price, so a chain whose facilitator charges us (e.g.
// Solvador at $0.001/settlement as a PRIMARY) quotes tool price + premium
// while fee-free rails (CDP on Base) stay at list. Buyers on cheap rails never
// subsidise expensive ones, and the fee is visible in the quote.
//
// Config: NETWORK_PRICE_PREMIUMS="eip155:10=0.001,eip155:130=0.001" (USD per
// settlement, CAIP-2 keyed). Unset/empty = every accepts entry byte-identical
// to before, pinned by scripts/test-price-premium.js. Premiums only ever ADD:
// a negative or unparseable entry is refused LOUDLY at parse time rather than
// silently quoting below cost. Integer micro-dollar arithmetic — float math on
// money invents dust like $0.0020000000000000005.
export function parseNetworkPremiums(raw = process.env.NETWORK_PRICE_PREMIUMS || "") {
  const out = new Map();
  for (const pair of String(raw).split(",").map((x) => x.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const net = eq > 0 ? pair.slice(0, eq).trim() : "";
    const usd = eq > 0 ? Number(pair.slice(eq + 1)) : NaN;
    if (!net || !Number.isFinite(usd) || usd < 0) {
      console.warn(`[payments] NETWORK_PRICE_PREMIUMS entry ignored (malformed or negative): "${pair}"`);
      continue;
    }
    out.set(net, Math.round(usd * 1e6)); // micro-dollars
  }
  return out;
}
const NETWORK_PREMIUMS = parseNetworkPremiums();

/** "$0.001" + premium micro-dollars -> "$0.002". Exact in integer micro-dollars.
 *  A price this parser cannot read is returned UNCHANGED (never a NaN quote). */
export function priceWithPremium(price, network, premiums = NETWORK_PREMIUMS) {
  const extra = premiums.get(network);
  if (!extra) return price;
  const m = /^\$(\d+(?:\.\d+)?)$/.exec(String(price));
  if (!m) return price;
  const micro = Math.round(Number(m[1]) * 1e6) + extra;
  return "$" + (micro / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function acceptsForItem(item, rails) {
  const { evmCaip2, svmCaip2, stellarCaip2, avmCaip2, walletAddress, solanaWallet, stellarWallet, algorandWallet } = rails;
  const burner = rails.upstreamBuyerAddress ?? UPSTREAM_BUYER_ADDRESS;
  const avmBuyer = rails.avmUpstreamBuyerAddress ?? AVM_UPSTREAM_BUYER_ADDRESS;
  const payToFor = (caip2) =>
    burner && caip2 === "eip155:8453" && SELF_FUNDING_SLUGS.has(item.slug) ? burner : walletAddress;
  // Chain-matched self-funding for Algorand (2026-07-29, same rule as Base):
  // an Algorand buyer's route-execute payment funds the AVM spending wallet
  // that pays Algorand sellers on their behalf. ROUTER TIERS ONLY - the
  // Blockscout kit's upstream spend is pinned to Base (payX402), so routing
  // its Algorand revenue to the AVM wallet would fund the wrong wallet.
  const avmPayToFor = () =>
    avmBuyer && AVM_SELF_FUNDING_SLUGS.has(item.slug) ? avmBuyer : algorandWallet;
  const evm = evmCaip2.map((caip2) => ({ scheme: "exact", payTo: payToFor(caip2), price: priceWithPremium(item.price, caip2), network: caip2 }));
  // `upto` rides ALONGSIDE `exact` on the gated networks, at the identical
  // price and payTo. The scheme is chosen per payment-option, not per
  // registration, so dual-advertising means emitting a second option - which is
  // what makes the upgrade additive: an exact-only buyer sees the entry it
  // always saw, at the amount it always saw, and negotiates unchanged.
  //
  // For a fixed-price tool the ceiling IS the price, so `upto` currently buys
  // the buyer nothing here beyond the option. It exists so the wire is proven
  // before anything is priced variably; metered pricing is a separate change on
  // top of a scheme that already settles.
  const uptoNets = Array.isArray(rails.uptoCaip2) ? rails.uptoCaip2 : [];
  const upto = uptoNets
    .filter((caip2) => evmCaip2.includes(caip2))
    .map((caip2) => ({ scheme: "upto", payTo: payToFor(caip2), price: priceWithPremium(item.price, caip2), network: caip2 }));
  // Identity-bound routes stay EVM-`exact` ONLY (security audit A402-03): the
  // handler derives the caller from the signed EIP-3009 authorization.from, and
  // upto's payload is Permit2-shaped (permit2Authorization.from), which
  // payerFromRequest deliberately does not read. Advertising upto here offers a
  // rail these routes structurally cannot serve - it fails closed at a 400 with
  // nobody charged, but a rail that cannot work should not be advertised.
  if (item.identityBound) return evm;
  return [
    ...evm,
    ...upto,
    ...(solanaWallet ? svmCaip2.map((caip2) => ({ scheme: "exact", payTo: solanaWallet, price: priceWithPremium(item.price, caip2), network: caip2 })) : []),
    ...(stellarWallet ? stellarCaip2.map((caip2) => ({ scheme: "exact", payTo: stellarWallet, price: priceWithPremium(item.price, caip2), network: caip2 })) : []),
    // The Algorand accepts carry the x402 Global Challenge tag (Algorand
    // Foundation's entry marker, per their 2026-07-21 checklist): GoPlausible's
    // Bazaar + leaderboard attribute challenge entries by `extra.tag`, and the
    // challenge-filtered views hide untagged merchants entirely. Scheme-level
    // fields (decimals/feePayer) are merged in by the facilitator downstream.
    ...(algorandWallet ? avmCaip2.map((caip2) => ({ scheme: "exact", payTo: avmPayToFor(), price: priceWithPremium(item.price, caip2), network: caip2, extra: { tag: "x402-global-challenge" } })) : []),
  ];
}

/**
 * Build the x402 v2 payment middleware: an "exact" USDC payment scheme,
 * paywalling the routes in `catalog`, with Bazaar discovery metadata so agents
 * can find the service. Accepts USDC on EVM chains and optionally Solana (the
 * agent picks the chain it holds funds on).
 */
export async function buildPaymentMiddleware({ walletAddress, network, baseUrl, catalog, extraRoutes = {} }) {
  const networks = enabledNetworks(network);
  const caip2List = networks.map((n) => NETWORKS[n]);
  let evmCaip2 = caip2List.filter((c) => c.startsWith("eip155:"));
  // `let`, not `const`: the reachability check below may drop any of these, and
  // a chain we cannot settle must never reach the offer. See that block.
  let svmCaip2 = caip2List.filter((c) => c.startsWith("solana:"));
  let stellarCaip2 = caip2List.filter((c) => c.startsWith("stellar:"));
  let avmCaip2 = caip2List.filter((c) => c.startsWith("algorand:"));

  // Facilitator routing. x402ResourceServer accepts a LIST of facilitator
  // clients: at sync it asks each for its /supported kinds and routes every
  // verify/settle by the payment's (network, scheme), earlier clients winning
  // ties. A facilitator that is down at sync only logs a warning — the others
  // keep their networks serving.
  //
  //   - Single network (default): unchanged — CDP (Bazaar discovery +
  //     fee-free Base settlement) or FACILITATOR_URL.
  //   - Multi-chain: CDP FIRST, PayAI second. Base settlement must stay on
  //     CDP: the Bazaar harvester only indexes/refreshes a listing when it
  //     observes a payment settle through CDP, so moving Base to PayAI would
  //     silently degrade marketplace discovery for the chain that actually
  //     earns. PayAI covers the chains CDP doesn't settle (Solana, Polygon,
  //     Arbitrum — free tier 10k settlements/month).
  const isMultiChain = networks.length > 1;
  const facilitatorClients = [];
  let payAiClient = null;
  if (isMultiChain) {
    const cdpConfig = await resolveCdpFacilitatorConfig();
    if (cdpConfig) {
      facilitatorClients.push(new HTTPFacilitatorClient(cdpConfig));
    } else {
      console.warn(
        "WARNING: multi-chain mode without CDP keys - Base will settle via PayAI and the " +
          "x402 Bazaar will stop indexing/refreshing this seller's listings. Set " +
          "CDP_API_KEY_ID + CDP_API_KEY_SECRET to keep Base on CDP (Bazaar discovery + fee-free)."
      );
    }
    payAiClient = new HTTPFacilitatorClient(await resolvePayAIFacilitatorConfig());
    facilitatorClients.push(payAiClient);
    console.log(
      `Multi-chain facilitator routing: ${cdpConfig ? "CDP (Base + Bazaar) → PayAI (remaining chains)" : "PayAI (all chains)"}`
    );
  } else if (network === "robinhood" && ROBINHOOD_FACILITATOR_URL) {
    // Robinhood-ONLY server: the dedicated USDG facilitator client (pushed
    // below via robinhoodEnabled) is the only one needed. The generic resolver
    // would demand CDP keys or FACILITATOR_URL — neither settles chain 4663 —
    // and crash boot. (A robinhood-only server with a generic FACILITATOR_URL
    // and no ROBINHOOD_FACILITATOR_URL still takes the resolver path below,
    // preserving the pre-rename behavior.)
  } else {
    facilitatorClients.push(new HTTPFacilitatorClient(await resolveFacilitatorConfig(network)));
  }
  // Robinhood Chain / USDG settles through the operator-configured external
  // facilitator (ROBINHOOD_FACILITATOR_URL), added only when the chain is
  // actually enabled, so the default USDC path is untouched. That facilitator
  // advertises only eip155:4663, so it wins that one route without disturbing
  // CDP (Base) or PayAI (the rest).
  //
  // CRITICAL: if `robinhood` is listed in PAYMENT_NETWORKS but no facilitator
  // URL is set, DROP it from the offered networks entirely (below) — NOT just
  // its facilitator client. Registering a scheme / advertising an `accepts`
  // entry for a network that no facilitator can settle makes EVERY 402
  // challenge throw, which surfaces as a 500 on ALL paid endpoints (buyers
  // can't pay anything). Degrading robinhood to "not offered" keeps the rest
  // of the gateway serving; it returns the moment ROBINHOOD_FACILITATOR_URL is set.
  const robinhoodEnabled = evmCaip2.includes(ROBINHOOD_CAIP2) && !!ROBINHOOD_FACILITATOR_URL;
  if (evmCaip2.includes(ROBINHOOD_CAIP2) && !ROBINHOOD_FACILITATOR_URL) {
    console.warn(
      "WARNING: PAYMENT_NETWORKS enables `robinhood` but ROBINHOOD_FACILITATOR_URL is unset - " +
        "dropping Robinhood Chain/USDG from the offered networks (other chains unaffected). " +
        "Set ROBINHOOD_FACILITATOR_URL to enable it."
    );
    evmCaip2 = evmCaip2.filter((c) => c !== ROBINHOOD_CAIP2);
  }
  if (robinhoodEnabled) {
    facilitatorClients.push(new HTTPFacilitatorClient({ url: ROBINHOOD_FACILITATOR_URL }));
    console.log(`Robinhood Chain: settling USDG (${USDG.asset}) via facilitator ${ROBINHOOD_FACILITATOR_URL}`);
  }
  // Monad (chain 143 / USDC) settles through its dedicated facilitator, added
  // only when `monad` is enabled — PayAI/CDP can't settle eip155:143, so without
  // this client an offered Monad accept would make EVERY 402 throw. It advertises
  // only Monad, so it wins that route without disturbing the other rails. Same
  // safety as Robinhood: if the URL is emptied, drop Monad from the offered
  // networks rather than break all payments.
  const monadEnabled = evmCaip2.includes(MONAD_CAIP2) && !!MONAD_FACILITATOR_URL;
  if (evmCaip2.includes(MONAD_CAIP2) && !MONAD_FACILITATOR_URL) {
    console.warn(
      "WARNING: PAYMENT_NETWORKS enables `monad` but MONAD_FACILITATOR_URL is empty - " +
        "dropping Monad from the offered networks (other chains unaffected)."
    );
    evmCaip2 = evmCaip2.filter((c) => c !== MONAD_CAIP2);
  }
  if (monadEnabled) {
    facilitatorClients.push(new HTTPFacilitatorClient({ url: MONAD_FACILITATOR_URL }));
    console.log(`Monad: settling USDC via facilitator ${MONAD_FACILITATOR_URL}`);
  }
  // Celo (chain 42220 / USDC) settles through the Celo-operated facilitator,
  // added only when `celo` is enabled — PayAI/CDP don't advertise
  // eip155:42220, so without this client an offered Celo accept would make
  // EVERY 402 throw. It advertises only Celo, so it wins that route without
  // disturbing the other rails. Same safety as Monad/Robinhood: if the URL or
  // API key is missing, drop Celo from the offered networks rather than break
  // payments — the key gate matters because verify is keyless but settle 401s
  // without it, so a keyless Celo offer verifies fine and then bounces every
  // buyer at settlement (never charged, but a dead rail dressed up as live).
  const celoEnabled = evmCaip2.includes(CELO_CAIP2) && !!CELO_FACILITATOR_URL && !!CELO_FACILITATOR_KEY;
  if (evmCaip2.includes(CELO_CAIP2) && !celoEnabled) {
    console.warn(
      "WARNING: PAYMENT_NETWORKS enables `celo` but " +
        (CELO_FACILITATOR_URL ? "CELO_FACILITATOR_KEY is unset - the facilitator's /settle requires an " +
          "X-API-Key (free: sign a no-gas message at https://x402.celo.org)" : "CELO_FACILITATOR_URL is empty") +
        " - dropping Celo from the offered networks (other chains unaffected)."
    );
    noteRailDropped("celo", CELO_FACILITATOR_URL ? "CELO_FACILITATOR_KEY unset" : "CELO_FACILITATOR_URL empty");
    evmCaip2 = evmCaip2.filter((c) => c !== CELO_CAIP2);
  }
  if (celoEnabled) {
    const celoAuthHeaders = { "X-API-Key": CELO_FACILITATOR_KEY };
    facilitatorClients.push(new HTTPFacilitatorClient({
      url: CELO_FACILITATOR_URL,
      createAuthHeaders: async () => ({ verify: celoAuthHeaders, settle: celoAuthHeaders, supported: celoAuthHeaders }),
    }));
    console.log(`Celo: settling USDC (${CELO_USDC.asset}) via facilitator ${CELO_FACILITATOR_URL}`);
  }
  // Solvador — settle-FALLBACK for existing rails, deliberately NOT in
  // facilitatorClients as a general client: it advertises Base (which must
  // stay on CDP for Bazaar indexing) and most of our other rails, so an
  // unfiltered client would contend for primary routes. Its fallback value is
  // redundancy: the only second facilitator that can settle Celo, Monad and
  // Robinhood. Env-gated on SOLVADOR_KEY (dashboard.solvador.com,
  // pay-as-you-go: first 1,000 settlements/month free, then $0.001). Used by
  // registerFacilitatorFailureHooks below when PAYMENT_SETTLE_FALLBACK is on.
  let solvadorClient = null;
  if (process.env.SOLVADOR_KEY) {
    const solvadorAuth = { "X-API-Key": process.env.SOLVADOR_KEY };
    solvadorClient = new HTTPFacilitatorClient({
      url: process.env.SOLVADOR_FACILITATOR_URL || "https://api.solvador.com",
      createAuthHeaders: async () => ({ verify: solvadorAuth, settle: solvadorAuth, supported: solvadorAuth }),
    });
  }
  // Solvador as PRIMARY, network-filtered. For chains where Solvador is our
  // ONLY facilitator (Optimism today; Unichain/World Chain/Linea are the
  // same shape when funded), a dedicated client advertises JUST that chain —
  // getSupported is filtered so it can never win a route CDP/PayAI own. Same
  // drop-don't-break safety as Monad/Celo/Robinhood: enabling the network
  // without SOLVADOR_KEY drops it from the offer with a loud warning, because
  // an offered accept no facilitator can settle would 500 every 402.
  // Fee-charging-primary rule: every chain routed here must carry a
  // NETWORK_PRICE_PREMIUMS entry so the $0.001 settlement fee is priced into
  // that chain's accepts quote, never eaten silently.
  const SOLVADOR_PRIMARY_CAIP2 = ["eip155:10"];
  class NetworkFilteredFacilitatorClient extends HTTPFacilitatorClient {
    constructor(cfg, networks) { super(cfg); this._only = new Set(networks); }
    async getSupported() {
      const s = await super.getSupported();
      return { ...s, kinds: (s.kinds || []).filter((k) => this._only.has(k.network)) };
    }
  }
  const solvadorPrimaryWanted = SOLVADOR_PRIMARY_CAIP2.filter((c) => evmCaip2.includes(c));
  if (solvadorPrimaryWanted.length && !process.env.SOLVADOR_KEY) {
    console.warn(
      `WARNING: PAYMENT_NETWORKS enables ${solvadorPrimaryWanted.join(", ")} but SOLVADOR_KEY is unset - ` +
        "Solvador is the only facilitator settling these chains (keyed: dashboard.solvador.com). " +
        "Dropping them from the offered networks (other chains unaffected)."
    );
    evmCaip2 = evmCaip2.filter((c) => !solvadorPrimaryWanted.includes(c));
  } else if (solvadorPrimaryWanted.length) {
    const solvadorAuth = { "X-API-Key": process.env.SOLVADOR_KEY };
    facilitatorClients.push(new NetworkFilteredFacilitatorClient({
      url: process.env.SOLVADOR_FACILITATOR_URL || "https://api.solvador.com",
      createAuthHeaders: async () => ({ verify: solvadorAuth, settle: solvadorAuth, supported: solvadorAuth }),
    }, solvadorPrimaryWanted));
    console.log(`Solvador (primary, filtered): settling USDC on ${solvadorPrimaryWanted.join(", ")}`);
  }
  // A CONFIGURED-BUT-UNREACHABLE FACILITATOR MUST NOT TAKE DOWN EVERY CHAIN.
  //
  // The guards above only cover a MISSING url/key. A facilitator that is
  // configured and simply DOWN takes the opposite path: the client is added,
  // its /supported handshake fails, and the network stays in the offer with
  // nothing able to settle it. @x402/core then refuses to BUILD the 402 and
  // every paid route on EVERY chain answers 500 - while /health stays 200, so
  // it reads as healthy with all revenue dead.
  //
  // Reproduced 2026-08-02 with Celo's facilitator returning 500 (its real state
  // that day): POST /api/hash -> 500 RouteConfigurationError, with Base
  // perfectly healthy and configured. The only thing protecting production was
  // that someone had manually removed `celo` from PAYMENT_NETWORKS.
  //
  // So the offer is now verified against what the facilitators we route through
  // ACTUALLY advertise, which is the same discipline the upto gate below has
  // always applied - it just never covered `exact`.
  //
  // Two deliberate safety properties:
  //   * a network is dropped only on a POSITIVE answer, i.e. at least one
  //     facilitator responded and did not list it. If none respond (a boot-time
  //     network blip), the configured offer is left alone rather than emptied.
  //   * each client gets a second attempt, so a slow facilitator is not
  //     mistaken for a dead one and a transient blip cannot cost a rail.
  const advertisedExact = new Set();
  const advertisedUpto = new Set();
  let anyFacilitatorResponded = false;
  await Promise.all(facilitatorClients.map(async (client) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const kinds = (await client.getSupported())?.kinds || [];
        anyFacilitatorResponded = true;
        for (const k of kinds) {
          const scheme = String(k?.scheme || "").toLowerCase();
          if (!k?.network) continue;
          if (scheme === "exact") advertisedExact.add(String(k.network));
          if (scheme === "upto") advertisedUpto.add(String(k.network));
        }
        return;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 750));
      }
    }
  }));
  if (anyFacilitatorResponded) {
    const nameFor = (caip2) => Object.keys(NETWORKS).find((n) => NETWORKS[n] === caip2) || caip2;
    const keepSettleable = (list, label) => list.filter((caip2) => {
      if (advertisedExact.has(caip2)) return true;
      console.warn(
        `WARNING: ${label} ${caip2} is configured but NO reachable facilitator advertises exact/${caip2} - ` +
        "dropping it from the offer so the other rails keep settling. Leaving it in would make @x402/core " +
        "refuse to build the 402 and answer 500 on EVERY paid route, on every chain."
      );
      noteRailDropped(nameFor(caip2), "no reachable facilitator advertises exact for it");
      return false;
    });
    evmCaip2 = keepSettleable(evmCaip2, "EVM network");
    svmCaip2 = keepSettleable(svmCaip2, "Solana network");
    stellarCaip2 = keepSettleable(stellarCaip2, "Stellar network");
    avmCaip2 = keepSettleable(avmCaip2, "Algorand network");
  } else {
    console.error(
      "WARNING: no facilitator answered /supported at boot, so the offer could not be verified. " +
      "Leaving the configured networks in place rather than emptying the offer on what may be a " +
      "transient blip - but if this persists, paid routes will 500."
    );
  }

  // Which networks may offer `upto`. Two gates, both required:
  //   1. Operator opt-in — X402_UPTO_NETWORKS (CSV of CAIP-2 ids, or "all").
  //      Unset means the scheme is never registered and every 402 is
  //      byte-identical to today.
  //   2. A configured facilitator must ADVERTISE upto for that network at
  //      /supported. Advertising a scheme nobody can settle is worse than not
  //      offering it: the buyer signs, the settle fails, and they are refused a
  //      service they tried to pay for. @x402/core also refuses to BUILD a 402
  //      for an unadvertised pair, which turns every unpaid request into a 500
  //      (measured while building the trial test).
  const uptoWanted = String(process.env.X402_UPTO_NETWORKS || "").trim();
  let uptoCaip2 = [];
  if (uptoWanted) {
    const wanted = uptoWanted.toLowerCase() === "all"
      ? evmCaip2
      : uptoWanted.split(",").map((x) => x.trim()).filter(Boolean).filter((c) => evmCaip2.includes(c));
    // Ask each facilitator CLIENT, not its URL.
    //
    // The first version fetched `${url}/supported` directly, which bypasses
    // NetworkFilteredFacilitatorClient.getSupported() - the subclass that
    // exists so a fallback facilitator can only win the networks we actually
    // route to it. Solvador advertises upto on eleven chains while being
    // network-filtered to one, so the raw fetch credited it with ten it is
    // deliberately not routed for. Going through the client honours the same
    // filter the settle path uses, so the gate can only ever agree with where
    // payments will really go.
    const claimed = wanted.filter((c) => advertisedUpto.has(c));

    // PROVE it, do not take its word. A facilitator advertising upto says
    // nothing about whether WE can price the asset on that chain: the scheme
    // needs a money override, and a missing one throws inside parsePrice while
    // the 402 is being built. Since one throwing option aborts the entire
    // accepts array, an unpriceable chain does not degrade - it 500s every paid
    // route on every chain. So each candidate is priced here, once, at boot,
    // and anything that throws is dropped with the same loud refusal.
    for (const caip2 of claimed) {
      try {
        await withMoney(new UptoEvmScheme(), caip2).parsePrice(0.001, caip2);
        uptoCaip2.push(caip2);
      } catch (e) {
        console.warn(`x402 upto: REFUSING ${caip2} — cannot price it (${String(e?.message || e).slice(0, 120)}). Offering it would abort the whole accepts array and 500 every paid route.`);
      }
    }
    const refused = wanted.filter((c) => !uptoCaip2.includes(c));
    if (refused.length) {
      console.warn(`x402 upto: REFUSING to offer upto on ${refused.join(", ")} — not advertised by a facilitator we route through, or not priceable here.`);
    }
  }

  let server = new x402ResourceServer(facilitatorClients)
    .registerExtension(bazaarResourceServerExtension)
    .registerExtension(builderCodeResourceServerExtension);
  for (const caip2 of evmCaip2) {
    const scheme = caip2 === ROBINHOOD_CAIP2 ? makeUsdgScheme()
      : caip2 === MONAD_CAIP2 ? makeMonadUsdcScheme()
      : caip2 === CELO_CAIP2 ? makeCeloUsdcScheme()
      : TIER1_USDC[caip2] ? makeTier1UsdcScheme(caip2)
      : new ExactEvmScheme();
    server = server.register(caip2, scheme);
  }
  // `upto` — variable-amount settlement. The buyer signs a Permit2
  // authorization for a CEILING and the facilitator settles the amount the
  // seller names at settle time, never above it. `exact` cannot express that:
  // the price is fixed in the 402 before the handler runs, which is why the
  // gateway prices in flat tiers and clamps max_tokens to defend margin instead
  // of billing what a call actually cost.
  //
  // SHIPS DARK. Registering a scheme adds an accepts entry to EVERY 402 on the
  // affected network, so this changes the payment negotiation of every buyer on
  // the site. On a service where a malformed 402 means nobody can pay, that is
  // not a change to make implicitly. Default OFF; enable per-network via
  // X402_UPTO_NETWORKS once a canary has settled a real sub-ceiling payment.
  //
  // Registration is ADDITIVE, never a replacement: `exact` stays registered for
  // the same network, so both appear in accepts at the same amount and an
  // exact-only buyer negotiates exactly as it does today. Same
  // backwards-compatible shape as the MPP shim.
  //
  // Advertising a scheme our facilitator cannot settle would be worse than not
  // offering it, so a network is only registered when a configured facilitator
  // actually advertises upto for it at /supported.
  for (const caip2 of uptoCaip2) {
    server = server.register(caip2, withMoney(new UptoEvmScheme(), caip2));
    console.log(`x402 upto: variable-amount settlement offered on ${caip2}`);
  }
  for (const caip2 of svmCaip2) server = server.register(caip2, new ExactSvmScheme());
  // Stellar — settlement via the OpenZeppelin-operated x402 facilitator on pubnet.
  // STELLAR_FACILITATOR_URL defaults to the public OpenZeppelin endpoint; override
  // for a self-hosted or private facilitator instance. Requires a Bearer token
  // (STELLAR_FACILITATOR_KEY) generated at https://channels.openzeppelin.com/gen
  // via GitHub OAuth. Without the key, the facilitator returns 401 on /supported
  // and the scheme registration is skipped (same graceful-degrade as Solana).
  const stellarFacilitatorUrl = (process.env.STELLAR_FACILITATOR_URL || "https://channels.openzeppelin.com/x402").trim();
  const stellarFacilitatorKey = (process.env.STELLAR_FACILITATOR_KEY || "").trim();
  const stellarWallet = (process.env.STELLAR_WALLET_ADDRESS || "").trim();
  if (stellarCaip2.length && stellarWallet && stellarFacilitatorKey) {
    const stellarAuthHeaders = { Authorization: `Bearer ${stellarFacilitatorKey}` };
    facilitatorClients.push(new HTTPFacilitatorClient({
      url: stellarFacilitatorUrl,
      createAuthHeaders: async () => ({ verify: stellarAuthHeaders, settle: stellarAuthHeaders, supported: stellarAuthHeaders }),
    }));
    for (const caip2 of stellarCaip2) server = server.register(caip2, new ExactStellarScheme());
    console.log(`Stellar: settling USDC via facilitator ${stellarFacilitatorUrl} → ${stellarWallet}`);
  } else if (stellarCaip2.length && !stellarWallet) {
    console.warn(
      "WARNING: PAYMENT_NETWORKS enables `stellar` but STELLAR_WALLET_ADDRESS is unset - " +
        "the Stellar payment option will be OMITTED from every 402. Set STELLAR_WALLET_ADDRESS " +
        "(Stellar public key, G...) to accept USDC on Stellar."
    );
  } else if (stellarCaip2.length && !stellarFacilitatorKey) {
    console.warn(
      "WARNING: PAYMENT_NETWORKS enables `stellar` but STELLAR_FACILITATOR_KEY is unset - " +
        "the OpenZeppelin facilitator requires a Bearer token. Generate one at " +
        "https://channels.openzeppelin.com/gen (GitHub OAuth). Stellar will be OMITTED until set."
    );
  }
  // Algorand — settlement via the GoPlausible-operated x402 facilitator on
  // mainnet. ALGORAND_FACILITATOR_URL defaults to the public GoPlausible
  // endpoint; its /supported is keyless (verified 2026-07-10), so no bearer
  // token is required here (unlike Stellar). NOTE the reserve quirk: the
  // payTo wallet must have opted in to ASA 31566704 (USDC) or on-chain
  // settlement fails even though verify() looks fine.
  const algorandFacilitatorUrl = (process.env.ALGORAND_FACILITATOR_URL || "https://facilitator.goplausible.xyz").trim();
  const algorandWallet = (process.env.ALGORAND_WALLET_ADDRESS || "").trim();
  if (avmCaip2.length && algorandWallet) {
    facilitatorClients.push(new HTTPFacilitatorClient({ url: algorandFacilitatorUrl }));
    for (const caip2 of avmCaip2) server = server.register(caip2, new ExactAvmScheme());
    console.log(`Algorand: settling USDC via facilitator ${algorandFacilitatorUrl} → ${algorandWallet}`);
  } else if (avmCaip2.length && !algorandWallet) {
    console.warn(
      "WARNING: PAYMENT_NETWORKS enables `algorand` but ALGORAND_WALLET_ADDRESS is unset - " +
        "the Algorand payment option will be OMITTED from every 402. Set ALGORAND_WALLET_ADDRESS " +
        "(Algorand public key) to accept USDC on Algorand - and make sure that wallet has opted " +
        "in to ASA 31566704 (USDC), or settlement will fail on-chain even though the payment verifies."
    );
  }
  registerFacilitatorFailureHooks(server, payAiClient, solvadorClient);
  registerWalletBlocklistHook(server);
  // Log the OFFERED set, not the requested one: the drop-don't-break guards
  // above (Robinhood/Monad/Celo/Solvador-primary) may have removed EVM chains,
  // and a boot log claiming an unoffered rail sends the next debugger the
  // wrong way (it did, 2026-07-28: a keyless optimism boot logged optimism).
  const offeredCaip2 = new Set([...evmCaip2, ...svmCaip2, ...stellarCaip2, ...avmCaip2]);
  const offeredNames = networks.filter((n) => offeredCaip2.has(NETWORKS[n]));
  // Snapshot for railStatus(): what was asked for vs what is actually on offer.
  railsConfigured = [...networks];
  railsOffered = [...offeredNames];
  console.log(
    `Accepting USDC on: ${offeredNames.join(", ")} (${[...offeredCaip2].join(", ")})` +
      (robinhoodEnabled ? " - note: robinhood settles USDG, not USDC" : "")
  );

  const solanaWallet = (process.env.SOLANA_WALLET_ADDRESS || "").trim();
  if (svmCaip2.length && solanaWallet) {
    console.log(`Solana payTo: ${solanaWallet}`);
    warnIfSolanaTokenAccountMissing(solanaWallet);
  }
  // Loud, because the failure is silent everywhere else: acceptsFor() below
  // simply omits the Solana option, so every 402 offers EVM chains only and
  // buyers never learn Solana was intended. Zero Solana revenue with no error
  // anywhere is exactly what that misconfiguration looks like.
  if (svmCaip2.length && !solanaWallet) {
    console.warn(
      "WARNING: PAYMENT_NETWORKS enables a Solana network but SOLANA_WALLET_ADDRESS is unset - " +
        "the Solana payment option will be OMITTED from every 402. Set SOLANA_WALLET_ADDRESS " +
        "(base58 Solana address) to actually accept USDC on Solana."
    );
  }

  // One payment option per enabled chain — agents pick the chain they hold funds on.
  // Identity-bound routes are the exception (EVM-only) — see acceptsForItem.
  const acceptsFor = (item) =>
    acceptsForItem(item, { evmCaip2, svmCaip2, stellarCaip2, avmCaip2, walletAddress, solanaWallet, stellarWallet, algorandWallet, uptoCaip2 });

  // The payment-required header is one base64-encoded JSON blob carrying
  // description + discovery extensions.  Skill packs and tools with rich
  // schemas can push it past ~2900 bytes, which @x402/fetch fails to
  // negotiate.  Cap description and strip bulky output examples here; full
  // text lives on /api/pricing, /openapi.json, tool pages, and MCP surfaces.
  const capDesc = (s) => (s && s.length > 250 ? s.slice(0, 247) + "..." : s);
  const slimDiscovery = (d) => {
    if (!d) return d;
    const slim = { ...d };
    if (slim.output) {
      // Keep the output EXAMPLE in the bazaar declaration: discovery crawlers
      // (MPPScan's @agentcash/discovery, which x402scan also consumes) treat a
      // missing extensions.bazaar.schema.properties.output as an error-level
      // finding, and the example is what makes a listing invocable-with-
      // confidence. Catalog examples are small (p50 178B, max ~1.1KB measured
      // 2026-07-24); the 2KB guard keeps a future oversized example from
      // bloating every 402 for that route — the full example always lives in
      // /openapi.json.
      const example = slim.output.example;
      const oversized = example !== undefined && JSON.stringify(example).length > 2048;
      slim.output = {
        type: slim.output.type || "json",
        ...(example !== undefined
          ? { example: oversized ? { truncated: true, note: "full example in /openapi.json" } : example }
          : {}),
      };
    }
    return slim;
  };

  const builderCode = process.env.BASE_BUILDER_CODE || null;
  if (builderCode) console.log(`Builder Code: ${builderCode} (Base onchain attribution enabled)`);

  const routes = Object.fromEntries(
    Object.entries(catalog).map(([route, item]) => {
      const ext = {};
      if (item.bazaar !== false) Object.assign(ext, declareDiscoveryExtension(slimDiscovery(item.discovery)));
      if (builderCode) Object.assign(ext, { [BUILDER_CODE]: declareBuilderCodeExtension(builderCode) });
      return [
        route,
        {
          accepts: acceptsFor(item),
          description: capDesc(item.description),
          serviceName: "Agent402.tools",
          // Discovery tags feed marketplace categorizers (x402scan, the Bazaar).
          // Include the resource's own category alongside its specific tags so
          // an indexer sees the real category signal (unit conversion, data,
          // crypto, llm, ...) - every entry is honestly tagged with what it is,
          // never a blanket label. Deduped, ≤10 to keep the 402 header lean.
          tags: [...new Set(["web", "tools", "agents", "x402", item.category, ...(item.tags ?? [])].filter(Boolean))].slice(0, 10),
          mimeType: "application/json",
          resource: `${baseUrl}${route.split(" ")[1]}`,
          // Canonical brand icon on every Bazaar/discovery record. Without it,
          // downstream directories (OpenSea's x402 tools surface, etc.) scrape
          // the site favicon at index time and cache it forever — which is how
          // the pre-rebrand logo got frozen on OpenSea. The URL serves the
          // current 512px PNG mark (image/png despite the .ico name).
          iconUrl: `${baseUrl}/favicon.ico`,
          extensions: Object.keys(ext).length ? ext : undefined,
        },
      ];
    })
  );

  // Wildcard price entries for paths that are deliberately NOT catalog tools —
  // today just the retired pairwise converters. They must never enter `catalog`:
  // the boot-time shadow guard rejects that shape, and ~970 phantom rows would
  // land in /api/pricing, /openapi.json, the sitemap, the tool count, and
  // bazaar-register (which BUYS a listing per route). A wildcard keeps the
  // paywall honest with one entry and leaves every catalog-derived surface
  // untouched. `bazaar: false` on the caller's side keeps the discovery
  // extension off, which is also what x402 wants for `*` patterns.
  for (const [route, cfg] of Object.entries(extraRoutes)) {
    routes[route] = {
      accepts: acceptsFor(cfg),
      description: capDesc(cfg.description),
      serviceName: "Agent402.tools",
      tags: ["web", "tools", "agents", "x402", cfg.category].filter(Boolean).slice(0, 10),
      mimeType: "application/json",
      resource: `${baseUrl}${route.split(" ")[1]}`,
      iconUrl: `${baseUrl}/favicon.ico`,
    };
  }

  // X402_SYNC_ON_START=false skips the facilitator handshake at boot —
  // only for local testing where the facilitator is unreachable.
  //
  // NEVER SET THIS IN PRODUCTION. The handshake is what loads the facilitator's
  // supported scheme/network kinds, and @x402/core refuses to BUILD a 402 for a
  // pair it has not seen — so without it EVERY unpaid request answers 500
  // instead of 402. That is a total revenue outage wearing the costume of a
  // startup optimization: no buyer can read a price, nobody can pay, and
  // because a 5xx cancels settlement it is not even chargeable. Measured
  // directly: same server, same stub facilitator, this flag alone flips every
  // unpaid response from 402 to 500.
  //
  // Test scripts set it freely because they run FREE_MODE (no paywall to build)
  // or only exercise the PoW path, which never asks for a quote.
  const syncOnStart = process.env.X402_SYNC_ON_START !== "false";
  return paymentMiddleware(routes, server, undefined, undefined, syncOnStart);
}

/**
 * WALLET_BLOCKLIST enforcement — the teeth behind /terms' "we may refuse
 * service to any wallet".
 *
 * WALLET_BLOCKLIST is a comma-separated list of wallet addresses (EVM 0x…,
 * Solana base58, Stellar G…, Algorand base32 — same alphabet
 * normalizePayerAddress accepts). Read at CALL time (same convention as the
 * memory quotas), so a Railway variable update takes effect on the next
 * restart with no code change.
 *
 * Enforcement point is a beforeSettle abort: the hook runs after verify but
 * BEFORE the facilitator settles, so a blocked wallet is never charged — the
 * buyer gets the standard settle-failure 402 whose receipt carries
 * errorReason "wallet_blocked" (which the tally middleware records as a
 * settle_failed event, so blocks are visible in PostHog). EVM payers are
 * matched from the signature-covered EIP-3009 authorization.from; other
 * schemes match when their payload carries a recognizable payer field.
 */
export function blockedPayerFromPayload(paymentPayload) {
  const raw = (process.env.WALLET_BLOCKLIST || "").trim();
  if (!raw) return null;
  const blocklist = new Set(
    raw.split(",").map((s) => normalizePayerAddress(s.trim())).filter(Boolean)
  );
  if (!blocklist.size) return null;
  const candidates = [
    paymentPayload?.payload?.authorization?.from, // EVM exact scheme (signature-covered)
    paymentPayload?.payload?.payer,
    paymentPayload?.payer,
  ];
  for (const c of candidates) {
    const normalized = normalizePayerAddress(c);
    if (normalized && blocklist.has(normalized)) return normalized;
  }
  return null;
}

function registerWalletBlocklistHook(server) {
  server.onBeforeSettle((ctx) => {
    const blocked = blockedPayerFromPayload(ctx?.paymentPayload);
    if (!blocked) return;
    console.warn(`[payments] BLOCKED wallet refused before settlement: ${blocked} (${ctx?.requirements?.network})`);
    return {
      abort: true,
      reason: "wallet_blocked",
      message: "This wallet is blocked for terms-of-service violations (see https://agent402.tools/terms). Contact mike@agent402.tools.",
    };
  });
}

/**
 * Make facilitator verify/settle failures LOUD — and optionally auto-recover a
 * failed settlement via PayAI.
 *
 * Why this exists: the @x402 middleware turns a facilitator verify/settle
 * failure into a bare `402` with an EMPTY body and logs NOTHING. So when CDP
 * started returning `402 payment-method-required` on settle (its account-level
 * billing gate — a valid payment method must be on the CDP account once the
 * free settlement tier is used), buyers saw ordinary-looking empty 402s, the
 * server printed nothing, and Base revenue silently went to zero with no error
 * anywhere. verify() is free and kept returning isValid:true, so every check
 * that looked at verification looked healthy. These hooks surface the network +
 * the facilitator's actual reason (and correlationId/errorLink) in the server
 * log, turning that class of outage into a seconds-long diagnosis.
 *
 * PAYMENT_SETTLE_FALLBACK=true (default OFF) additionally re-settles through a
 * fallback CHAIN — PayAI, then Solvador (when SOLVADOR_KEY is set) — when the
 * primary facilitator rejects settlement BEFORE broadcasting (an HTTP 402
 * billing gate). Never on a timeout/5xx, where the settler may already have
 * broadcast; that rule applies between fallbacks too, so a PayAI timeout stops
 * the chain rather than risking a double-charge via Solvador. PayAI is skipped
 * on networks it cannot settle (Celo/Monad/Robinhood go straight to Solvador —
 * the only second facilitator those single-facilitator rails have). Left off by
 * default so Base stays purely on CDP (Bazaar discovery + fee-free settlement)
 * unless the operator opts into never-miss-a-sale behavior.
 */
/** Networks PayAI can settle (from its live /supported, 2026-07-27). A fallback
 *  attempt on a network the facilitator cannot settle is a guaranteed error —
 *  worse than useless, because a network-level failure STOPS the fallback chain
 *  (it is indistinguishable from "may have broadcast"). So PayAI is skipped
 *  outright for networks it does not serve, sending Celo/Monad/Robinhood
 *  straight to Solvador. Solvador gets no allowlist: it is always last, so a
 *  wasted attempt there cannot mask a viable fallback behind it. */
const PAYAI_SETTLE_NETWORKS = new Set([
  "eip155:8453", "eip155:137", "eip155:42161", "eip155:43114",
  "eip155:1329", "eip155:196", "eip155:1187947933", "eip155:324705682",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
]);

export function fallbackCandidatesFor(network, payAiClient, solvadorClient) {
  const out = [];
  if (payAiClient && PAYAI_SETTLE_NETWORKS.has(network)) out.push({ name: "PayAI", client: payAiClient });
  if (solvadorClient) out.push({ name: "Solvador", client: solvadorClient });
  return out;
}


// WHICH RAILS DID WE ACTUALLY END UP OFFERING, and why not the rest?
//
// The drop-don't-break guards below are correct and load-bearing: a chain whose
// facilitator is missing or down is removed from the offer instead of throwing
// while building the challenge, which once turned one bad rail into HTTP 500 on
// EVERY paid endpoint (2026-07-02). Revenue keeps flowing on the other chains,
// which is exactly right.
//
// What was missing is that the removal is SILENT after boot. Celo vanished from
// the offer and nothing said so: the 402 quietly advertised 11 networks while
// the config asked for 12, /health said ok, and the only trace was one boot log
// nobody re-reads. It surfaced days later via a canary WARN.
//
// So every drop records itself here, and railStatus() reports configured vs
// offered per chain with the reason. One chain failing stays one chain's
// problem - now a VISIBLE one.
const railDrops = new Map();   // network name -> reason
let railsConfigured = [];
let railsOffered = [];
export function noteRailDropped(network, reason) { railDrops.set(network, reason); }
export function railStatus() {
  return railsConfigured.map((n) => ({
    network: n,
    caip2: NETWORKS[n] || null,
    offered: railsOffered.includes(n),
    reason: railsOffered.includes(n) ? null : (railDrops.get(n) || "not advertised by any configured facilitator"),
  }));
}

export function registerFacilitatorFailureHooks(server, payAiClient, solvadorClient = null) {
  server.onVerifyFailure((ctx) => {
    console.warn(
      `[payments] facilitator VERIFY failed on ${ctx?.requirements?.network} ` +
        `${ctx?.requirements?.scheme}: ${summarizeFacilitatorError(ctx?.error)}`
    );
  });

  // A GRACEFUL settle rejection — the facilitator answers { success:false }
  // without an HTTP error — never reaches onSettleFailure below: @x402/core
  // fires that hook only when the facilitator client THROWS. The graceful path
  // returns normally, the buyer gets a 402 carrying the failed receipt, and
  // without this hook the server log says NOTHING (the 2026-07-16 Robinhood
  // rejection left zero trace). afterSettle runs on graceful failures too, so
  // it closes the gap.
  server.onAfterSettle((ctx) => {
    const result = ctx?.result;
    if (!result || result.success !== false) return;
    console.warn(
      `[payments] facilitator settle REJECTED on ${ctx?.requirements?.network} ` +
        `${ctx?.requirements?.scheme}: ${result.errorReason || result.errorMessage || "no reason given"}`
    );
  });

  const fallbackEnabled = /^(1|true|yes|on)$/i.test((process.env.PAYMENT_SETTLE_FALLBACK || "").trim());
  if (fallbackEnabled) {
    console.log(
      `Settle fallback: ON — chain ${payAiClient ? "PayAI → " : ""}${solvadorClient ? "Solvador" : payAiClient ? "(PayAI only)" : "(no candidates!)"}` +
        "; fires ONLY on facilitator-thrown pre-broadcast rejections (HTTP 402 class), never on buyer-side or ambiguous failures"
    );
  }
  server.onSettleFailure(async (ctx) => {
    console.warn(
      `[payments] facilitator SETTLE failed on ${ctx?.requirements?.network} ` +
        `${ctx?.requirements?.scheme}: ${summarizeFacilitatorError(ctx?.error)}`
    );
    if (!fallbackEnabled) return;
    if (!isPreBroadcastSettleRejection(ctx?.error)) return;
    const candidates = fallbackCandidatesFor(ctx?.requirements?.network, payAiClient, solvadorClient);
    for (const { name, client } of candidates) {
      try {
        const result = await client.settle(ctx.paymentPayload, ctx.requirements);
        console.warn(
          `[payments] recovered ${ctx?.requirements?.network} settlement via ${name} fallback ` +
            "(PAYMENT_SETTLE_FALLBACK=true; primary rejected pre-broadcast)"
        );
        return { recovered: true, result };
      } catch (err) {
        console.warn(
          `[payments] ${name} settle fallback ALSO failed on ${ctx?.requirements?.network}: ` +
            summarizeFacilitatorError(err)
        );
        // The double-settle gate applies BETWEEN fallbacks exactly as it does
        // after the primary: only a clean pre-broadcast rejection (HTTP 402
        // class) proves this facilitator did not broadcast, so only that lets
        // the chain continue to the next candidate. A timeout/5xx here may
        // mean the transfer is already on-chain — trying anyone else could
        // charge the buyer twice, so the chain STOPS.
        if (!isPreBroadcastSettleRejection(err)) return;
      }
    }
  });
}

/**
 * True only for facilitator settle failures guaranteed NOT to have broadcast
 * on-chain (safe to re-settle elsewhere): an HTTP 402 from the facilitator
 * /settle endpoint (e.g. CDP's `payment-method-required` billing gate). Network
 * errors, timeouts, and 5xx are excluded — there the primary may already have
 * broadcast, so re-settling could double-charge the buyer.
 */
export function isPreBroadcastSettleRejection(err) {
  if (!err) return false;
  if (err.status === 402) return true;
  const msg = String(err.message || "");
  return /settle failed \(402\)/i.test(msg) || /payment-method-required/i.test(msg);
}

/** Pull the human-meaningful bits out of a facilitator error (its message
 *  embeds the facilitator's JSON body — errorMessage, errorLink, correlationId)
 *  so the server log names the cause instead of a bare stack. */
function summarizeFacilitatorError(err) {
  if (!err) return "unknown error";
  const msg = String(err.message || err);
  const brace = msg.indexOf("{");
  if (brace >= 0) {
    try {
      const body = JSON.parse(msg.slice(brace));
      const bits = [];
      if (body.errorMessage) bits.push(body.errorMessage);
      if (body.errorType) bits.push(`type=${body.errorType}`);
      if (body.errorLink) bits.push(body.errorLink);
      if (body.correlationId) bits.push(`correlationId=${body.correlationId}`);
      if (bits.length) return `${msg.slice(0, brace).trim()} ${bits.join(" | ")}`;
    } catch {
      /* truncated/partial JSON body — fall through to the raw message */
    }
  }
  return msg.slice(0, 240);
}

// On Solana, a USDC transfer to a wallet with no USDC token account fails
// on-chain SIMULATION (InstructionError: InvalidAccountData) — so every
// buyer's payment bounces while the 402 looks perfectly healthy, and nothing
// on the seller's side ever errors. The fix is one-time and trivial (send the
// wallet any amount of USDC to create its token account), but invisible until
// someone decodes a facilitator rejection — this exact trap ate the first day
// of Solana support. Best-effort, fire-and-forget: RPC flake must not affect
// boot, and Railway egress may not reach public Solana RPCs at all.
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function warnIfSolanaTokenAccountMissing(owner) {
  (async () => {
    const res = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
        params: [owner, { mint: SOLANA_USDC_MINT }, { encoding: "jsonParsed" }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    if (Array.isArray(j?.result?.value) && j.result.value.length === 0) {
      console.warn(
        `WARNING: Solana payTo ${owner} has NO USDC token account - every buyer's Solana ` +
          "payment will fail on-chain simulation (InvalidAccountData) until one exists. " +
          "One-time fix: send this address any amount of USDC on Solana to create it."
      );
    }
  })().catch(() => { /* best-effort — never affects boot */ });
}

async function resolvePayAIFacilitatorConfig() {
  if (process.env.PAYAI_API_KEY_ID && process.env.PAYAI_API_KEY_SECRET) {
    const { createFacilitatorConfig } = await import("@payai/facilitator");
    console.log("Facilitator (Solana): PayAI (authenticated)");
    return createFacilitatorConfig(process.env.PAYAI_API_KEY_ID, process.env.PAYAI_API_KEY_SECRET);
  }
  // PayAI free tier: 10,000 settlements/month, no API key needed.
  const { facilitator } = await import("@payai/facilitator");
  console.log("Facilitator (Solana): PayAI (free tier)");
  return facilitator;
}

/** Coinbase CDP facilitator config, or null when the keys aren't set. CDP
 *  settles on Base (fee-free) and indexes discoverable endpoints in the
 *  x402 Bazaar — it's the facilitator Base settlement should always prefer. */
async function resolveCdpFacilitatorConfig() {
  if (!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET)) return null;
  const { createFacilitatorConfig } = await import("@coinbase/x402");
  console.log("Facilitator: Coinbase CDP (Bazaar discovery enabled)");
  return createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET);
}

async function resolveFacilitatorConfig(network) {
  const cdp = await resolveCdpFacilitatorConfig();
  if (cdp) return cdp;
  if (process.env.FACILITATOR_URL) {
    console.log(`Facilitator: ${process.env.FACILITATOR_URL}`);
    return { url: process.env.FACILITATOR_URL };
  }
  if (network !== "base-sepolia") {
    throw new Error(
      `Network is "${network}" but no facilitator is configured. ` +
        "Set CDP_API_KEY_ID + CDP_API_KEY_SECRET (free at portal.cdp.coinbase.com) " +
        "or FACILITATOR_URL. The default x402.org facilitator only supports base-sepolia testnet." +
        (network === "robinhood" ? " For Robinhood Chain/USDG, set ROBINHOOD_FACILITATOR_URL." : "")
    );
  }
  console.log("Facilitator: default (x402.org, testnet)");
  return undefined;
}
