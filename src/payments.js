import { handlerInputOf } from "./handler-input.js";
import { boundedResponseSchemaFor } from "./openapi-schema.js";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { installAcceptOutputSchema, withOutputSchemaOnFirstAccept, outputSchemaFromExtensions, acceptOutputSchemaEnabled } from "./accept-output-schema.js";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { convertToTokenAmount, numberToDecimalString } from "@x402/core/utils";
import { confirmStellarTransfer, settlePayerOf, settleWithStellarFallback } from "./stellar-confirm.js";
import { clarifySvmSettleFailure } from "./svm-clarify.js";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  sanitizeTags,
} from "@x402/extensions/bazaar";
import {
  BUILDER_CODE,
  builderCodeResourceServerExtension,
  declareBuilderCodeExtension,
} from "@x402/extensions/builder-code";
import { declarePaymentIdentifierExtension, PAYMENT_IDENTIFIER } from "@x402/extensions/payment-identifier";
import { normalizePayerAddress } from "./payer.js";
import { installFacilitatorDiagnostics, labelFacilitatorErrors } from "./facilitator-diagnostics.js";

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
export const AVM_SELF_FUNDING_SLUGS = new Set(["route-execute", "route-execute-plus", "route-execute-max", "route-execute-pro"]);
const AVM_UPSTREAM_BUYER_ADDRESS = (process.env.ALGORAND_UPSTREAM_BUYER_ADDRESS || "").trim();

export const SELF_FUNDING_SLUGS = new Set([
  "route-execute", "route-execute-plus", "route-execute-max", "route-execute-pro",
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
  // A tool with a `quote` (the metered gateway tier) is priced PER REQUEST:
  // @x402/core resolves a `price` function against the request context on
  // every call, including the paid retry, so the amount a buyer authorized is
  // re-derived from the body actually served. The quote is stashed on the
  // request so the upto meter can use it as the ceiling (gateway-meter.js).
  const priceOf = (caip2) => {
    if (typeof item.quote !== "function") return priceWithPremium(item.price, caip2);
    return async (ctx) => {
      let usd = null;
      try {
        const req = ctx?.adapter?.req;
        // ONE quote per request: @x402/core resolves every option's price on
        // every request (13 rails on prod) and the Tempo/Stripe appenders ask
        // again on the 402, and each quote is a full tokenization of the body.
        // Every closure shares the request object, so the first one computes
        // and the rest read the stash (audit 2026-08-26: ~15x per POST before).
        if (req && Number.isFinite(req.__meteredQuoteUsd)) {
          usd = req.__meteredQuoteUsd;
        } else {
          // Price the object the handler will be SERVED (query merged, MCP
          // envelopes unwrapped), never the raw body: a body the quoter cannot
          // read must not quote the floor for a call that is then served.
          const body = req ? handlerInputOf(req, item) : (typeof ctx?.adapter?.getBody === "function" ? ctx.adapter.getBody() : null);
          usd = Number(item.quote(body && typeof body === "object" ? body : {}));
          if (req && Number.isFinite(usd)) req.__meteredQuoteUsd = usd;
        }
      } catch { usd = null; }
      const price = Number.isFinite(usd) && usd > 0 ? "$" + usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : item.price;
      return priceWithPremium(price, caip2);
    };
  };
  const evm = evmCaip2.map((caip2) => ({ scheme: "exact", payTo: payToFor(caip2), price: priceOf(caip2), network: caip2 }));
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
    .map((caip2) => ({ scheme: "upto", payTo: payToFor(caip2), price: priceOf(caip2), network: caip2 }));
  // Identity-bound routes stay EVM-`exact` ONLY (security audit A402-03): the
  // handler derives the caller from the signed EIP-3009 authorization.from, and
  // upto's payload is Permit2-shaped (permit2Authorization.from), which
  // payerFromRequest deliberately does not read. Advertising upto here offers a
  // rail these routes structurally cannot serve - it fails closed at a 400 with
  // nobody charged, but a rail that cannot work should not be advertised.
  if (item.identityBound) return evm;
  // Long-running composites (research/dossier/fund/domain/token-risk: 2-4 min
  // handlers, settlement AFTER) stay EVM-`exact` ONLY: EIP-3009 validBefore is
  // sized by maxTimeoutSeconds (300s) and covers the run; the SVM challenge
  // embeds a recent blockhash (~60-90s), a default AVM txn is ~10 rounds
  // (~28s) and Tempo credentials are client-bounded - on those rails the work
  // is done, settlement fails, and the buyer is never charged. A rail that
  // structurally cannot settle these must not be advertised for them.
  if (item.longRunning) return evm;
  return [
    ...evm,
    ...upto,
    ...(solanaWallet ? svmCaip2.map((caip2) => ({ scheme: "exact", payTo: solanaWallet, price: priceOf(caip2), network: caip2 })) : []),
    ...(stellarWallet ? stellarCaip2.map((caip2) => ({ scheme: "exact", payTo: stellarWallet, price: priceOf(caip2), network: caip2 })) : []),
    // The Algorand accepts carry the x402 Global Challenge tag (Algorand
    // Foundation's entry marker, per their 2026-07-21 checklist): GoPlausible's
    // Bazaar + leaderboard attribute challenge entries by `extra.tag`, and the
    // challenge-filtered views hide untagged merchants entirely. Scheme-level
    // fields (decimals/feePayer) are merged in by the facilitator downstream.
    ...(algorandWallet ? avmCaip2.map((caip2) => ({ scheme: "exact", payTo: avmPayToFor(), price: priceOf(caip2), network: caip2, extra: { tag: "x402-global-challenge" } })) : []),
  ];
}

/**
 * Build the x402 v2 payment middleware: an "exact" USDC payment scheme,
 * paywalling the routes in `catalog`, with Bazaar discovery metadata so agents
 * can find the service. Accepts USDC on EVM chains and optionally Solana (the
 * agent picks the chain it holds funds on).
 */
/** Bazaar listing cap (Coinbase: 500 chars). Truncate at the last sentence
 *  end under the cap, else the last word; never a mid-word "...". */
export const BAZAAR_DESCRIPTION_MAX = 500;
// Byte budget for the typed output schema carried in the discovery extension.
// Sized against the measured challenge sizes: the widest routes sat near 10.7 KB
// of a 12 KB ceiling before this, so the schema must be small enough that no
// route crosses it. test-challenge-size.js is the enforcement.
export const BAZAAR_SCHEMA_MAX_BYTES = Number(process.env.BAZAAR_SCHEMA_MAX_BYTES) || 500;

export function bazaarCapDescription(s, max = BAZAAR_DESCRIPTION_MAX) {
  if (!s || s.length <= max) return s;
  const head = s.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.endsWith(".") ? head.length - 1 : -1);
  if (sentenceEnd >= Math.floor(max * 0.5)) return head.slice(0, sentenceEnd + 1).trim();
  const wordEnd = head.lastIndexOf(" ");
  return (wordEnd > 0 ? head.slice(0, wordEnd) : head).trim().replace(/[,;:\-]+$/, "") + ".";
}

/** Purpose-written Bazaar copy for the flagship routes: WHAT it returns and
 *  WHEN an agent should pick it, in <= 500 chars, no internal cross-references
 *  to tools the Bazaar reader cannot see. Bazaar ranking weighs description
 *  completeness alongside usage; the catalog description (llms.txt, MCP,
 *  /api/find) is untouched. scripts/test-bazaar-descriptions.js pins every
 *  key to a real slug and the cap. */
export const BAZAAR_DESCRIPTIONS = Object.freeze({
  // Market-data front door (/markets), 2026-08-27: every keyless market tool gets purpose-written copy.
  "perp-funding-screener": "Every listed perpetual ranked by current funding rate, the most positive and most negative N with open interest and 24h volume beside each, from a live venue feed. Use it when an agent is screening for carry, basis or crowded positioning across the whole perp market in one call instead of polling each contract.",
  "perp-open-interest": "Open interest for one perpetual in coins and USD notional with its share of the venue total, or the top N contracts ranked by open interest plus the venue total. Use it when an agent needs positioning size for a market or a leaderboard of where leverage is concentrated right now.",
  "perp-klines": "OHLCV candles for one perpetual at any interval from 1 minute to 1 month, up to the venue's history, with a window summary of open, close, change, high, low and volume. Use it when an agent needs price history for a chart, a backtest or an indicator without an exchange account or API key.",
  "perp-orderbook": "The live level-2 order book for one perpetual: best bid and ask, mid, spread in basis points, up to 20 levels a side with cumulative depth and bid/ask imbalance. Use it when an agent is sizing an order, checking liquidity before a trade or measuring book pressure at a point in time.",
  "perp-basis": "Basis for one perpetual: mark versus oracle premium in percent and basis points, impact premium, current funding and the predicted next funding per venue. Use it when an agent is evaluating a cash-and-carry, comparing funding across venues or deciding whether a perp is trading rich or cheap to spot.",
  "options-summary": "A one-call options market summary for a currency: index price, DVOL, call and put open interest with the put/call ratio, total open interest, 24h volume, a per-expiry breakdown, the most active instruments and the perp's mark, funding and open interest. Use it when an agent needs the state of BTC or ETH options before drilling into a chain.",
  "crypto-options-chain": "The options chain for a currency and expiry sorted by strike: bid, ask, mark, mark implied volatility, open interest, 24h volume and the underlying, plus the list of available expiries. Use it when an agent is pricing a strategy, finding liquid strikes or reading the volatility smile for a specific expiry.",
  "options-ticker": "One options instrument live: mark, last, bid and ask with sizes, index price, open interest, mark, bid and ask implied volatility and the full greeks (delta, gamma, vega, theta, rho). Use it when an agent holds or is quoting a specific contract and needs its current risk numbers.",
  "options-volume": "Onchain options protocols ranked by 24h notional volume with 7d and 30d volume, 1d and 7d change and the chains each runs on, plus sector totals. Use it when an agent is comparing decentralized options venues or tracking whether onchain options activity is growing.",
  "crypto-indicators": "RSI, MACD, EMA 20/50/200, SMA 20/50, Bollinger bands, ATR and VWAP computed deterministically from live candles for one coin and interval, with the latest series points and a plain-language summary. Use it when an agent needs standard technical indicators without fetching candles and computing them itself.",
  "crypto-market-pulse": "The whole crypto perp market in one call: advancers versus decliners, mean, median and volume-weighted 24h change, total open interest and volume, top contracts by volume, the day's gainers and losers, funding extremes and BTC and ETH at a glance. Use it when an agent needs a market snapshot before deciding what to look at next.",
  "defi-yield-history": "Daily APY and TVL history for one yield pool, up to ten years, with a summary of latest, minimum, maximum and mean APY and the TVL change over the window. Use it when an agent is judging whether a pool's current yield is typical or an outlier before allocating to it.",
  "defi-protocols": "DeFi protocols ranked by total value locked, filterable by category, chain or name, each with rank, chains, TVL, 1h, 1d and 7d change, market cap and the market cap to TVL ratio. Use it when an agent needs the league table of protocols or wants to find the largest lending, DEX or staking venues on a chain.",
  "defi-protocol": "One DeFi protocol in full: TVL rank, TVL per chain, recent change, market cap to TVL, token, website, audits and parent, with name suggestions when the slug is unknown. Use it when an agent is researching a specific protocol and needs its size, footprint and audit status in one answer.",
  "defi-chains": "Blockchains ranked by DeFi total value locked with each chain's share of the total, native token, EVM chain id and CoinGecko id. Use it when an agent is comparing chains by DeFi activity or needs the canonical ids to query other services about a chain.",
  "defi-chain-tvl-history": "Daily total value locked history for one chain or for all of DeFi, up to ten years of points, with latest, first, minimum, maximum and mean and the change over the window. Use it when an agent is charting a chain's growth or checking whether a TVL move is new or a return to trend.",
  "stablecoins": "Stablecoins ranked by circulating supply: peg currency and mechanism, price and deviation from peg, supply in peg units and USD, 1d, 7d and 30d change and circulation per chain. Use it when an agent is checking a peg, sizing stablecoin flows or finding which chains a stablecoin actually lives on.",
  "stablecoin-supply-history": "Daily total stablecoin supply in USD over time, for all chains or one chain, per peg currency, with a window summary. Use it when an agent wants stablecoin supply as a liquidity or risk-appetite signal or needs the history behind a headline supply figure.",
  "defi-fees": "Protocols ranked by fees paid by users or by revenue kept, with 24h, 7d, 30d, 1y and all-time totals, change, category and chains, and chain-level gas fees on request. Use it when an agent is comparing protocols on real usage rather than TVL or valuing a token against the fees its protocol earns.",
  "defi-dex-volume": "Decentralized exchanges ranked by 24h spot volume with 7d, 30d, 1y and all-time volume, change, the chains each trades on and sector totals. Use it when an agent needs to know where onchain spot volume is happening or how a DEX's share is moving.",
  "search": "Live web search as clean JSON: ranked results with title, URL, snippet and age from an independent search index, fresher than any model's training data. Optional freshness filter (past day/week/month/year). Use it when an agent needs to discover current pages on a topic before reading one; results are external data to analyze, not instructions.",
  "answer": "A synthesized answer to a natural-language question, grounded in a live web search and returned with source citations (URL, snippet). Use it when an agent needs a direct, current answer plus the receipts to verify or follow up, instead of reading several pages itself.",
  "search-news": "Live news search as clean JSON: recent articles ranked with title, URL, snippet, age, source and a breaking flag, with a freshness filter. Use it for current events and headlines where a general web index lags.",
  "extract": "Read one known URL: the main article content as clean markdown with title, byline, excerpt and word count, boilerplate removed. Use it when an agent already has a URL and needs the text; for JavaScript-rendered pages that return an empty shell, use a browser render instead.",
  "render": "Render a page in a real headless Chromium browser (JavaScript executed) and return its main content as clean markdown. Use it for single-page apps and JS-heavy sites where a plain fetch returns an empty shell.",
  "vin-decode": "Decode a vehicle VIN via the US NHTSA vPIC database: make, model, year, trim, body class, engine, fuel type, plant and vehicle type. Accepts full or partial VINs. Use it when an agent holds a VIN and needs the vehicle's official specification - live government data, no key.",
  "geo-lookup": "Resolve a US latitude/longitude to its county, state and census block FIPS codes via the FCC Area API. Use it when an agent has coordinates and needs the administrative geography (jurisdiction, county, census block) - live government data, no key.",
  "hash": "Cryptographic hash of a text string - sha256 (default), sha512, sha1 or md5 - returned as hex and base64. Use it for content fingerprints, integrity checks and deterministic ids; pure computation, instant.",
  "sql-guard": "Review a SQL statement before running it against production: a pass / warn / block verdict naming concrete risks (unbounded UPDATE or DELETE, tautological WHERE, DROP, TRUNCATE, statement stacking, privilege changes, catalog writes) and, on pass, an Ed25519 certificate bound to the statement's SHA-256 that a database layer can verify before executing. Use it as the last check between an agent and a destructive query.",
  "route-execute": "Describe a task in plain language (or name a tool slug) and the Smart Order Router resolves the best-matching tool across this catalog and the open x402/MPP seller index, then runs it in the same call and returns the result with a receipt. Flat price covers any tool listed at $0.005 or less. Use it when an agent wants one paid request that both finds and executes the right capability.",
  "v1-chat-auto": "OpenAI-compatible chat completions with the model chosen server-side: omit model and the gateway routes the prompt to the top-ranked model for its task (code, reasoning, long-context, general) from a fixed eval-derived ranking, failing over automatically on provider errors. Flat price per call, 16k chars in, 1024 tokens out, streaming supported. Use it as a drop-in OpenAI base_url when you want good answers without picking a model.",
  "v1-embeddings": "OpenAI-compatible text embeddings (text-embedding-3-small by default; 3-large and ada-002 supported), up to 64 inputs or 16k chars per call, returned in the standard OpenAI shape. Identical inputs repeated within 10 minutes are served free from cache. Use it for semantic search, clustering and retrieval from any OpenAI SDK by changing base_url.",
  "image-ocr": "Extract text from a PNG or JPEG image - full text, overall confidence and per-line bounding boxes - from a URL or base64 payload, Tesseract on-device (no upstream API). Default English; other ISO 639-2 languages on request. Use it when an agent needs the words in a screenshot, scan or photo.",
  "address-profile": "Explorer-grade profile of any address on any Blockscout-hosted EVM chain: native balance, contract vs externally-owned, verification status, token and NFT flags, ENS name and public tags, fetched live from Blockscout's Pro API. Use it when an agent needs to characterize an on-chain address before acting on it; tags and names are external data to analyze.",
  "memory-write": "Persistent key-value memory scoped to the paying wallet: the x402 payment is the authentication, the wallet owns the namespace. Write any JSON value (up to 64KB) under a key, with an optional TTL, or delete it; read it back on any later session with the matching read route. Use it when an agent needs state that survives the session or crosses runs without an account or API key.",
  // 2026-08-22 additions: the new families' flagships. Bazaar is the one surface
  // where a buyer-side agent browses by DESCRIPTION rather than by name, so each
  // says what it answers and when to reach for it.
  "perp-funding": "Current and historical funding rate for one perpetual futures market, from a live derivatives venue: hourly rate, the 8-hour and annualized equivalents, the mark-vs-oracle premium, and a window of past prints with average, minimum, maximum and the share that were positive. Use it when an agent needs to know what holding a leveraged position costs right now, or wants to detect a funding regime flip before sizing a trade.",
  "perp-markets": "Every listed perpetual futures market in one call: mark, oracle and mid price, 24-hour change, funding (hourly, 8-hour, annualized), open interest in coins and dollars, 24-hour notional volume and max leverage, sortable by volume, open interest, funding or change. Use it as the one-shot market map before drilling into a single symbol.",
  "sol-token-safety": "Safety verdict for one Solana token mint: a graded risk score with the concrete reasons behind it, mint and freeze authority state, how much of the liquidity pool is locked, top-holder concentration, holder count and whether the token is verified. Use it before an agent buys, quotes, or recommends an unfamiliar token, and to screen a list of mints in seconds.",
  "defi-yields": "Live yield opportunities across DeFi, filterable by chain, protocol, token symbol, stablecoin-only, minimum TVL and minimum APY: pool identity, TVL in dollars, total APY split into base and reward, 1-day, 7-day and 30-day APY change, impermanent-loss risk and exposure type. Use it to find, compare or monitor where a given asset earns the most right now.",
  "crypto-news": "Recent crypto headlines aggregated from the public feeds of major outlets, deduplicated and newest first, each with title, source, publish time, canonical URL and a short summary, filterable by keyword, source and time window. Use it when an agent needs what happened in the last hours rather than what a model was trained on.",
  "v1-images-fast": "Generate an image from a text prompt at a flat price per picture, no token math and no subscription: the OpenAI images request shape in, base64 PNG or JPEG out, with an automatic fallback model so a provider outage does not become your error. Use it when an agent needs a picture cheaply and predictably.",
  "v1-videos": "Generate a short video clip from a text prompt at a flat price per clip: a four-second 720p clip returned inline as base64 MP4, with the duration and resolution locked so the price never moves. Use it when an agent needs motion rather than a still, and needs to know the cost before it calls.",
  "site-crawl": "Crawl a website from a starting URL and return each page as clean markdown: breadth-first over internal links, bounded by page count and depth, honouring robots.txt, with per-page title, status, depth and outbound links. Use it when an agent needs a whole section of a site rather than one known page.",
  "asset-transfers": "Token and native transfer history for any EVM address across major chains: direction, counterparty, asset, exact decimal value, block and transaction hash, filterable by category and block range with a cursor for paging. Use it to reconstruct what an address actually did, rather than only what it holds now.",
});

export async function buildPaymentMiddleware({ walletAddress, network, baseUrl, catalog, extraRoutes = {} }) {
  const networks = enabledNetworks(network);
  const caip2List = networks.map((n) => NETWORKS[n]);
  let evmCaip2 = caip2List.filter((c) => c.startsWith("eip155:"));
  let svmCaip2 = caip2List.filter((c) => c.startsWith("solana:"));
  let stellarCaip2 = caip2List.filter((c) => c.startsWith("stellar:"));
  let avmCaip2 = caip2List.filter((c) => c.startsWith("algorand:"));

  // Facilitator routing. x402ResourceServer accepts a LIST of facilitator
  // clients: at sync it asks each for its /supported kinds and routes every
  // verify/settle by the payment's (network, scheme), earlier clients winning
  // ties. NB a facilitator that is down at sync only logs a warning INSIDE
  // initialize(), but its networks stay in every route's accepts — and route
  // validation then 500s EVERY paid route, not just that rail (the 2026-08-01
  // Celo outage). The boot /supported guard below exists for exactly that.
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
  // Labels ride alongside facilitatorClients (same index) so the boot-time
  // /supported probe below can NAME the facilitator that failed — "a rail
  // was dropped" without which one is a debugging session, not a log line.
  const facilitatorLabels = [];
  // getSupported is memoized per INSTANCE (60s, shared in-flight promise):
  // the boot /supported probe below, the upto gate, and @x402's own
  // initialize() would otherwise each refetch within seconds of each other —
  // three fetches per facilitator per boot, plus a keep-alive race (the
  // first fetch primes an idle socket that can close exactly as the next
  // fetch reuses it, a spurious "TypeError: fetch failed" that reads as a
  // facilitator outage). Failures are never cached, so a transient boot
  // error is retried live by whoever asks next; re-initializations past the
  // TTL fetch live. Patching the instance keeps NetworkFilteredFacilitatorClient's
  // override in the chain (the memo wraps the FILTERED view, same as callers saw).
  const memoizeGetSupported = (client, ttlMs = 60_000) => {
    const orig = client.getSupported.bind(client);
    let cache = null;
    client.getSupported = async () => {
      if (cache && Date.now() - cache.at < ttlMs) return cache.promise;
      const entry = { at: Date.now(), promise: orig() };
      cache = entry;
      try {
        return await entry.promise;
      } catch (e) {
        if (cache === entry) cache = null;
        throw e;
      }
    };
    return client;
  };
  // Every facilitator base URL we register, so a non-JSON error from one of
  // them gets diagnosed instead of quoted. See facilitator-diagnostics.js: the
  // vendor truncates an error body at 200 chars, which for an HTML page is
  // spent entirely on markup, and that is why 15 settle failures on
  // 2026-08-07 could not be told apart from an edge refusing our egress.
  const facilitatorUrls = [];
  const addFacilitator = (label, client) => {
    // Name the facilitator in its own errors. The failure hooks log the chain
    // and never the client, so a Polygon failure could read as Coinbase's
    // words while PayAI owns that chain and may never have been reached.
    labelFacilitatorErrors(label, client);
    facilitatorClients.push(memoizeGetSupported(client));
    facilitatorLabels.push(label);
    facilitatorRegistry.push({ label, client: facilitatorClients[facilitatorClients.length - 1] });
    // Clients expose their base URL as `url`; a subclass that does not is
    // simply not diagnosed rather than a boot failure.
    const u = client?.url || client?.config?.url || client?.options?.url;
    if (u) facilitatorUrls.push(u);
    installFacilitatorDiagnostics(facilitatorUrls);
    return client;
  };
  // PayAI's Solana settles report an on-chain "insufficient funds" failure as
  // `settle_exact_svm_transaction_confirmation_timed_out` - measured
  // 2026-08-03 when our best Solana buyer drained its wallet to $0 and its
  // last four purchases all "timed out". That wording reads as a seller
  // outage: the buyer's agent logs tell its operator to wait, and our own
  // settle_failed telemetry sent us hunting a rail problem. So on an
  // ambiguous Solana settle failure we measure the payer's balance and, only
  // when it is genuinely below the price, rewrite the receipt to
  // `insufficient_funds` with a self-explaining message. Specific reasons are
  // never overwritten, an unreadable balance changes nothing, and the payer
  // comes from the facilitator's own result/error - never the payload (the
  // stellar-confirm lesson). Both failure shapes are covered: the graceful
  // { success:false } return AND the thrown SettleError, because @x402/core
  // builds the buyer's 402 receipt from whichever one it gets.
  class SvmClarifyingFacilitatorClient extends HTTPFacilitatorClient {
    async settle(paymentPayload, paymentRequirements) {
      const network = paymentRequirements?.network;
      try {
        const res = await super.settle(paymentPayload, paymentRequirements);
        if (res?.success === false) {
          const fix = await clarifySvmSettleFailure({
            network, reason: res.errorReason || res.errorMessage,
            payer: settlePayerOf(res), requirements: paymentRequirements,
          }).catch(() => null);
          if (fix) {
            console.warn(`[payments] solana settle failure clarified: ${res.errorReason} -> ${fix.reason} (${fix.message})`);
            return { ...res, errorReason: fix.reason, errorMessage: fix.message };
          }
        }
        return res;
      } catch (e) {
        const fix = await clarifySvmSettleFailure({
          network, reason: e?.errorReason || e?.message,
          payer: settlePayerOf(e), requirements: paymentRequirements,
        }).catch(() => null);
        if (fix) {
          console.warn(`[payments] solana settle failure clarified: ${e?.errorReason || e?.message} -> ${fix.reason}`);
          e.errorReason = fix.reason;
          e.errorMessage = fix.message;
        }
        throw e;
      }
    }
  }

  let payAiClient = null;
  if (isMultiChain) {
    const cdpConfig = await resolveCdpFacilitatorConfig();
    if (cdpConfig) {
      addFacilitator("CDP (Base)", new HTTPFacilitatorClient(cdpConfig));
    } else {
      console.warn(
        "WARNING: multi-chain mode without CDP keys - Base will settle via PayAI and the " +
          "x402 Bazaar will stop indexing/refreshing this seller's listings. Set " +
          "CDP_API_KEY_ID + CDP_API_KEY_SECRET to keep Base on CDP (Bazaar discovery + fee-free)."
      );
    }
    payAiClient = addFacilitator("PayAI", new SvmClarifyingFacilitatorClient(await resolvePayAIFacilitatorConfig()));
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
    addFacilitator(`primary (${network})`, new HTTPFacilitatorClient(await resolveFacilitatorConfig(network)));
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
    addFacilitator(`Robinhood (${ROBINHOOD_FACILITATOR_URL})`, new HTTPFacilitatorClient({ url: ROBINHOOD_FACILITATOR_URL }));
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
    addFacilitator(`Monad (${MONAD_FACILITATOR_URL})`, new HTTPFacilitatorClient({ url: MONAD_FACILITATOR_URL }));
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
    evmCaip2 = evmCaip2.filter((c) => c !== CELO_CAIP2);
  }
  if (celoEnabled) {
    const celoAuthHeaders = { "X-API-Key": CELO_FACILITATOR_KEY };
    addFacilitator(`Celo (${CELO_FACILITATOR_URL})`, new HTTPFacilitatorClient({
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
    addFacilitator("Solvador (primary)", new NetworkFilteredFacilitatorClient({
      url: process.env.SOLVADOR_FACILITATOR_URL || "https://api.solvador.com",
      createAuthHeaders: async () => ({ verify: solvadorAuth, settle: solvadorAuth, supported: solvadorAuth }),
    }, solvadorPrimaryWanted));
    console.log(`Solvador (primary, filtered): settling USDC on ${solvadorPrimaryWanted.join(", ")}`);
  }
  // Stellar — settlement via an x402 facilitator on pubnet. STELLAR_FACILITATOR_URL
  // defaults to the public OpenZeppelin endpoint (code default only) BUT PRODUCTION
  // OVERRIDES THIS to our own self-hosted facilitator (facilitator/, deployed as
  // the agent402-facilitator Railway service - see facilitator/README.md) as of
  // 2026-08-13; check the live Railway variable before assuming which one is in
  // use. STELLAR_FACILITATOR_KEY is a Bearer token either way — for OpenZeppelin,
  // generated at https://channels.openzeppelin.com/gen; for our own facilitator,
  // its own FACILITATOR_AUTH_TOKEN. Without the key, the facilitator returns 401
  // on /supported and the scheme registration is skipped (same graceful-degrade
  // as Solana).
  // The CLIENT is constructed here, with the other facilitators, so the boot
  // /supported probe below sees the complete set; the scheme registers further
  // down, once the resource server exists, and only for surviving networks.
  const stellarFacilitatorUrl = (process.env.STELLAR_FACILITATOR_URL || "https://channels.openzeppelin.com/x402").trim();
  const stellarFacilitatorKey = (process.env.STELLAR_FACILITATOR_KEY || "").trim();
  const stellarWallet = (process.env.STELLAR_WALLET_ADDRESS || "").trim();
  const stellarEnabled = !!(stellarCaip2.length && stellarWallet && stellarFacilitatorKey);
  // A settle failure on Stellar is not the last word - ask the chain.
  //
  // Stellar closes a ledger about every 5s and the channel service answers
  // before that, so `settle_channel_service_failed` is routinely returned for a
  // transfer that then confirms. @x402/express reacts by discarding the
  // already-computed response body and returning 402, which means the buyer is
  // CHARGED and told they were not. The handler had already run: we did the
  // work, took the money, and threw the answer away. Measured 2026-08-03 on ten
  // consecutive canary runs, deterministic because it is a race nobody can win.
  //
  // So on failure we poll Horizon for a confirmed transfer from this payer to
  // our payTo and, if one exists, report the settlement that actually happened.
  // This is verification, never a re-settle: nothing new is broadcast, so it
  // cannot double-charge. confirmStellarTransfer returns null on any error or
  // timeout, leaving the original failure exactly as it was - the only unsafe
  // direction is claiming a payment that did not occur, and it never guesses.
  // Plus a FALLBACK facilitator (2026-08-26): when the primary fails and the
  // transfer is NOT on-chain, the same signed payload is re-submitted through
  // it (settleWithStellarFallback, src/stellar-confirm.js - the decision is a
  // pure function so the test can drive every path). Configured by
  // STELLAR_FALLBACK_FACILITATOR_URL + _KEY (an OpenZeppelin /gen token); it is
  // NOT in facilitatorClients, so @x402 never tries it as a peer and the boot
  // /supported guard does not reason about it - it is probed separately, loud
  // but non-fatal.
  const stellarFallbackUrl = (process.env.STELLAR_FALLBACK_FACILITATOR_URL || "").trim();
  const stellarFallbackKey = (process.env.STELLAR_FALLBACK_FACILITATOR_KEY || "").trim();
  const stellarFallbackClient = stellarFallbackUrl && stellarFallbackKey && stellarFallbackUrl !== stellarFacilitatorUrl
    ? new HTTPFacilitatorClient({ url: stellarFallbackUrl, createAuthHeaders: async () => { const h = { Authorization: `Bearer ${stellarFallbackKey}` }; return { verify: h, settle: h, supported: h }; } })
    : null;
  class StellarConfirmingFacilitatorClient extends HTTPFacilitatorClient {
    async settle(paymentPayload, paymentRequirements) {
      const startedAt = Date.now() - 5_000;   // skew allowance for Horizon clocks
      const payTo = paymentRequirements?.payTo || stellarWallet;
      const network = paymentRequirements?.network || "stellar:pubnet";
      // The payer comes from the FACILITATOR's own settle result/error, never
      // from the payload — see settlePayerOf(). Reading it from the payload is
      // what made the first version of this a no-op in production.
      const res = await settleWithStellarFallback({
        primary: () => super.settle(paymentPayload, paymentRequirements),
        fallback: stellarFallbackClient ? () => stellarFallbackClient.settle(paymentPayload, paymentRequirements) : null,
        confirm: ({ payer, txHash }) => confirmStellarTransfer({ payer, payTo, sinceMs: startedAt, txHash }),
      });
      // A thrown primary that the chain later confirmed comes back as a bare
      // success object; give it the wire shape @x402 expects.
      if (res && res.success === true && !res.network) return { ...res, network };
      return res;
    }
  }
  if (stellarEnabled) {
    const stellarAuthHeaders = { Authorization: `Bearer ${stellarFacilitatorKey}` };
    addFacilitator(`Stellar (${stellarFacilitatorUrl})`, new StellarConfirmingFacilitatorClient({
      url: stellarFacilitatorUrl,
      createAuthHeaders: async () => ({ verify: stellarAuthHeaders, settle: stellarAuthHeaders, supported: stellarAuthHeaders }),
    }));
    console.log(`Stellar: settling USDC via facilitator ${stellarFacilitatorUrl} → ${stellarWallet}${stellarFallbackClient ? ` (fallback on pre-broadcast failure: ${stellarFallbackUrl})` : ""}`);
    if (stellarFallbackClient && process.env.X402_SYNC_ON_START !== "false") {
      // Loud, non-fatal: a fallback that cannot answer /supported would only
      // fail at the moment it is needed, which is the worst time to learn it.
      stellarFallbackClient.getSupported().then((s) => {
        const okKind = (s?.kinds || []).some((k) => String(k?.scheme) === "exact" && String(k?.network || "").startsWith("stellar:"));
        if (!okKind) console.warn(`WARNING: Stellar fallback facilitator ${stellarFallbackUrl} does not advertise exact on stellar - it will not be able to settle`);
      }).catch((e) => console.warn(`WARNING: Stellar fallback facilitator ${stellarFallbackUrl} unreachable at boot (${String(e?.message || e).slice(0, 120)})`));
    }
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
  // settlement fails even though verify() looks fine. Client constructed
  // here for the probe, scheme registered below — same split as Stellar.
  const algorandFacilitatorUrl = (process.env.ALGORAND_FACILITATOR_URL || "https://facilitator.goplausible.xyz").trim();
  const algorandWallet = (process.env.ALGORAND_WALLET_ADDRESS || "").trim();
  const algorandEnabled = !!(avmCaip2.length && algorandWallet);
  if (algorandEnabled) {
    addFacilitator(`Algorand (${algorandFacilitatorUrl})`, new HTTPFacilitatorClient({ url: algorandFacilitatorUrl }));
    console.log(`Algorand: settling USDC via facilitator ${algorandFacilitatorUrl} → ${algorandWallet}`);
  } else if (avmCaip2.length && !algorandWallet) {
    console.warn(
      "WARNING: PAYMENT_NETWORKS enables `algorand` but ALGORAND_WALLET_ADDRESS is unset - " +
        "the Algorand payment option will be OMITTED from every 402. Set ALGORAND_WALLET_ADDRESS " +
        "(Algorand public key) to accept USDC on Algorand - and make sure that wallet has opted " +
        "in to ASA 31566704 (USDC), or settlement will fail on-chain even though the payment verifies."
    );
  }

  // ---- Boot-time /supported guard (2026-08-01 incident) -------------------
  //
  // The drop-don't-break guards above only cover MISCONFIGURATION: a missing
  // key or URL. They cannot see an OUTAGE. A facilitator that is configured
  // but failing /supported never delivers its kinds to the resource server's
  // initialize() — which merely WARNS and moves on — and @x402's route
  // validation then rejects, per request and as a 500, every route whose
  // accepts advertise the missing (scheme, network) pair. Every catalog route
  // advertises every offered network, so ONE dead facilitator takes EVERY
  // paid route down. Measured live 2026-08-01: api.x402.celo.org 500ing
  // /supported → "RouteConfigurationError … does not support scheme exact on
  // eip155:42220" on all paid routes from the 12:28Z boot until the rail was
  // dropped by hand ~4h later. Free surfaces stayed up; paid revenue was $0.
  //
  // So: probe every client's /supported once at boot (6s timeout, one retry
  // after 2s — the heartbeat's single-retry doctrine, so a deploy-window blip
  // doesn't drop a healthy rail), and drop any offered network that no
  // REACHABLE facilitator advertises `exact` on, with the same loud warning
  // shape as the misconfiguration guards. A dropped rail returns on the next
  // boot where its facilitator answers.
  //
  // FAIL-OPEN when EVERY probe fails: that shape is indistinguishable from
  // our own egress being broken, and dropping all rails on a local blip would
  // turn a transient into a self-inflicted total offer wipe. Prior behavior
  // (paid routes 500 until a facilitator is reachable, free tier unaffected)
  // is the safer floor there — the guard only acts when at least one
  // facilitator answering proves our side of the network works.
  //
  // X402_SUPPORTED_GUARD=off restores prior behavior outright (operator
  // escape hatch); the probe is skipped under X402_SYNC_ON_START=false for
  // the same reason that flag exists — offline tests with no facilitator.
  const syncOnStart = process.env.X402_SYNC_ON_START !== "false";
  const supportedGuardOn =
    syncOnStart && String(process.env.X402_SUPPORTED_GUARD || "").toLowerCase() !== "off";
  if (supportedGuardOn && facilitatorClients.length) {
    const probeOne = async (client, label) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const kinds = (await Promise.race([
            client.getSupported(),
            new Promise((_, reject) => {
              const t = setTimeout(() => reject(new Error("timeout after 6000ms")), 6000);
              if (typeof t.unref === "function") t.unref();
            }),
          ]))?.kinds;
          return Array.isArray(kinds) ? kinds : [];
        } catch (e) {
          if (attempt === 1) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          console.warn(
            `WARNING: facilitator ${label} failed /supported at boot after a retry ` +
              `(${String(e?.message || e).slice(0, 140)}) - networks only it advertises will be ` +
              "dropped from the offer so the rest keep serving."
          );
          return null;
        }
      }
      return null;
    };
    const probed = await Promise.all(
      facilitatorClients.map((c, i) => probeOne(c, facilitatorLabels[i] || `#${i}`))
    );
    if (probed.every((kinds) => kinds === null)) {
      console.error(
        "ERROR: EVERY facilitator failed /supported at boot - REFUSING to filter the offer " +
          "(indistinguishable from our own egress being down; dropping all rails would make a " +
          "transient self-inflicted). Paid routes will answer 500 until a facilitator is " +
          "reachable; the free tier is unaffected."
      );
    } else {
      const advertisedExact = new Set();
      for (const kinds of probed) {
        for (const k of kinds || []) {
          if (String(k?.scheme || "").toLowerCase() === "exact" && k?.network) {
            advertisedExact.add(String(k.network));
          }
        }
      }
      const dropUnadvertised = (list) => {
        const dropped = list.filter((c) => !advertisedExact.has(c));
        if (dropped.length) {
          console.warn(
            `WARNING: dropping ${dropped.join(", ")} from the offered networks - no reachable ` +
              "facilitator advertises `exact` settlement there (see /supported failures above). " +
              "Other chains are unaffected; a dropped rail returns on the next boot where its " +
              "facilitator answers."
          );
        }
        return list.filter((c) => advertisedExact.has(c));
      };
      evmCaip2 = dropUnadvertised(evmCaip2);
      svmCaip2 = dropUnadvertised(svmCaip2);
      stellarCaip2 = dropUnadvertised(stellarCaip2);
      avmCaip2 = dropUnadvertised(avmCaip2);
    }
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
    const advertised = new Set();
    await Promise.all(facilitatorClients.map(async (client) => {
      try {
        const kinds = (await client.getSupported())?.kinds || [];
        for (const k of kinds) {
          if (String(k?.scheme || "").toLowerCase() === "upto" && k?.network) advertised.add(String(k.network));
        }
      } catch { /* a facilitator that cannot be reached advertises nothing */ }
    }));
    const claimed = wanted.filter((c) => advertised.has(c));

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

  // accepts[0].outputSchema (src/accept-output-schema.js): the accept below
  // declares it, this patch carries it onto the requirement the core builds -
  // the one object that is both the 402 and what verify matches against.
  installAcceptOutputSchema(x402ResourceServer);
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
  // Stellar/Algorand clients were constructed above (pre-probe); only their
  // scheme registrations live here, and only for networks that survived it.
  if (stellarEnabled) for (const caip2 of stellarCaip2) server = server.register(caip2, new ExactStellarScheme());
  if (algorandEnabled) for (const caip2 of avmCaip2) server = server.register(caip2, new ExactAvmScheme());
  registerFacilitatorFailureHooks(server, payAiClient, solvadorClient);
  registerWalletBlocklistHook(server);
  // Log the OFFERED set, not the requested one: the drop-don't-break guards
  // above (Robinhood/Monad/Celo/Solvador-primary) may have removed EVM chains,
  // and a boot log claiming an unoffered rail sends the next debugger the
  // wrong way (it did, 2026-07-28: a keyless optimism boot logged optimism).
  const offeredCaip2 = new Set([...evmCaip2, ...svmCaip2, ...stellarCaip2, ...avmCaip2]);
  const offeredNames = networks.filter((n) => offeredCaip2.has(NETWORKS[n]));
  // Observe the outcome for railStatus(); does not affect it.
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
  // "Extract article" beats "Agent402.tools" as the name of a row in an index
  // of 14,000 resources. Falls back to the host name when a tool has no name,
  // so a listing is never anonymous.
  const serviceNameFor = (item) =>
    (typeof item?.name === "string" && item.name.trim())
      // 32 characters is the protocol's own ceiling on serviceName
      // (ResourceInfoSchema); the contract sweep fails the build on 33. Trim at
      // a word boundary so a cut name still reads as a name.
      ? asciiName(item.name)
      : "Agent402.tools";
  // Printable ASCII only, then 32 characters - both are ResourceInfoSchema's
  // rules, and the contract sweep fails the build on either. A tool named
  // "EDGAR company lookup (ticker -> CIK)" carried a real arrow character and
  // was rejected as Invalid rather than as too long, which is why this
  // normalises before it truncates. Trim on a word boundary so a cut name
  // still reads as a name.
  const asciiName = (raw) => {
    const clean = String(raw).replace(/[\u2192\u2794\u27a1]/g, "->").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return "Agent402.tools";
    if (clean.length <= 32) return clean;
    return clean.slice(0, 32).replace(/\s+\S*$/, "").trim() || clean.slice(0, 32);
  };
  const acceptsFor = (item) =>
    acceptsForItem(item, { evmCaip2, svmCaip2, stellarCaip2, avmCaip2, walletAddress, solanaWallet, stellarWallet, algorandWallet, uptoCaip2 });

  // The payment-required header is one base64-encoded JSON blob carrying
  // description + discovery extensions.  Skill packs and tools with rich
  // schemas can push it past ~2900 bytes, which @x402/fetch fails to
  // negotiate.  Cap description and strip bulky output examples here; full
  // text lives on /api/pricing, /openapi.json, tool pages, and MCP surfaces.
  // Bazaar listing copy. The Bazaar caps descriptions at 500 chars (the old
  // 250-char slice here cut every flagship mid-sentence - seen on the live
  // listing 2026-08-19). Flagships get purpose-written "what + when" copy
  // (BAZAAR_DESCRIPTIONS, by slug); everyone else gets the catalog description
  // truncated at a SENTENCE boundary under 500, never mid-word with "...".
  const capDesc = (s) => bazaarCapDescription(s);
  const slimDiscovery = (d, path) => {
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
      //
      // The example alone is documentation for a HUMAN. A buyer deciding
      // whether to pay is a machine, and a machine reading only an example
      // learns nothing it can rely on - an outside audit (issue #1047,
      // 2026-08-29) made exactly that finding about our /openapi.json. So the
      // declaration also carries a TYPED schema derived from the same example.
      // It is byte-bounded because the buyer echoes this challenge back inside
      // its payment payload (scripts/test-challenge-size.js): the schema
      // shallows a level at a time to fit and is dropped rather than blow the
      // budget. The complete typed schema is always in /openapi.json, which
      // the listing links. One copy here, never one per accept: with 13 rails
      // a per-accept schema would cost 13x on every 402.
      const example = slim.output.example;
      const oversized = example !== undefined && JSON.stringify(example).length > 2048;
      const schema = oversized ? null : boundedResponseSchemaFor(path, example, BAZAAR_SCHEMA_MAX_BYTES);
      slim.output = {
        type: slim.output.type || "json",
        ...(example !== undefined
          ? { example: oversized ? { truncated: true, note: "full example in /openapi.json" } : example }
          : {}),
        ...(schema ? { schema } : {}),
      };
    }
    return slim;
  };

  const builderCode = process.env.BASE_BUILDER_CODE || null;
  if (builderCode) console.log(`Builder Code: ${builderCode} (Base onchain attribution enabled)`);

  const routes = Object.fromEntries(
    Object.entries(catalog).map(([route, item]) => {
      const ext = {};
      const path = route.split(" ")[1];
      if (item.bazaar !== false) Object.assign(ext, declareDiscoveryExtension(slimDiscovery(item.discovery, path)));
      const listingDescription = capDesc(BAZAAR_DESCRIPTIONS[item.slug] || item.description);
      if (builderCode) Object.assign(ext, { [BUILDER_CODE]: declareBuilderCodeExtension(builderCode) });
      // x402 payment-identifier (optional): a buyer MAY attach a payment id to
      // its payload; we honour it as an Idempotency-Key alias (server.js
      // idemHashKey). Declared so CDP-native clients (x402Client extensions,
      // awal, purl) know the seller understands it. ~120 bytes per 402.
      ext[PAYMENT_IDENTIFIER] = declarePaymentIdentifierExtension(false);
      return [
        route,
        {
          // The first accept declares the extension's typed output schema (one
          // copy - the buyer echoes its chosen accept back in the payment).
          accepts: withOutputSchemaOnFirstAccept(acceptsFor(item), acceptOutputSchemaEnabled() ? outputSchemaFromExtensions(ext) : null),
          description: listingDescription,
          // Per-TOOL service name, not the host name.
          //
          // Measured 2026-08-31: our 168 Bazaar listings all read
          // "Agent402.tools", so an agent browsing or searching the index sees
          // 168 identical rows. The sellers with the largest presence name each
          // resource for what it does - delx.ai carries 971 distinct
          // serviceNames across 995 listings, agentstools.dev 347 across 347.
          // Being IN the index and being FINDABLE in it are different things,
          // and a row that says only "Agent402.tools" answers no query an agent
          // would type.
          //
          // It may also be why so few of ours register at all: 325 paid buys
          // produced 64 listings, a second payment for the same routes produced
          // one, and no observable property of the request explained which -
          // an indexer that treats identical serviceName + near-identical tags
          // as duplicates of a row it already holds would produce exactly that.
          // UNPROVEN (m2mcent.com has one serviceName across 965 listings, so
          // it cannot be the whole rule), but the change stands on
          // discoverability alone.
          serviceName: serviceNameFor(item),
          // Discovery tags feed marketplace categorizers (x402scan, the Bazaar).
          // Include the resource's own category alongside its specific tags so
          // an indexer sees the real category signal (unit conversion, data,
          // crypto, llm, ...) - every entry is honestly tagged with what it is.
          // Use the protocol's own sanitizer: printable ASCII, ≤32 chars,
          // case-insensitive dedupe, and the official maximum of five tags.
          tags: sanitizeTags([item.category, ...(item.tags ?? []), "agents", "x402", "tools"]),
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
      tags: sanitizeTags([cfg.category, "agents", "x402", "tools"]),
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
  // (`syncOnStart` is computed above, where the boot /supported guard needs it.)
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
 * settle_failed event, so blocks are visible in PostHog).
 *
 * NON-EVM PAYER ENRICHMENT (2026-08-16): beforeSettle only ever receives the
 * raw, UNVERIFIED client payload (@x402/core's settlePayment() builds its own
 * { paymentPayload, ... } context straight from the caller's argument — it
 * never carries the verify() result). For SVM/Stellar/AVM's exact schemes the
 * payer is never on that raw payload at all — it's derived by decoding the
 * signed transaction, and only appears as a `payer` field on the verify
 * RESULT (confirmed directly against the installed SDKs: @x402/svm, /stellar
 * and /avm's facilitator verify() all return `{ isValid: true, payer }`).
 * Before this fix, blockedPayerFromPayload only ever matched EVM's
 * signature-covered authorization.from — a blocked wallet trivially evaded
 * the ban by paying on Solana, Stellar, or Algorand instead.
 * registerWalletBlocklistPayerEnrichment below closes that gap the only way
 * @x402/core's hook API allows: onAfterVerify DOES receive the verify result,
 * but can't itself abort settlement (a thrown/rejecting hook there is caught
 * and only logged - see runAfterVerifyHooks). So it stashes the verified
 * payer directly onto the SAME paymentPayload object instance that
 * beforeSettle will receive moments later in the same request (verifyPayment
 * and settlePayment both build their context from the exact object reference
 * passed in by the caller - never a clone - so this is safe, request-scoped,
 * and needs no external cache/keying).
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
    paymentPayload?.__verifiedPayer, // SVM/Stellar/AVM — see registerWalletBlocklistPayerEnrichment
  ];
  for (const c of candidates) {
    const normalized = normalizePayerAddress(c);
    if (normalized && blocklist.has(normalized)) return normalized;
  }
  return null;
}

export function registerWalletBlocklistPayerEnrichment(server) {
  server.onAfterVerify((ctx) => {
    const payer = ctx?.result?.payer;
    const payload = ctx?.paymentPayload;
    if (payer && payload && !payload.payload?.authorization?.from) {
      try {
        payload.__verifiedPayer = payer;
      } catch {
        /* non-extensible payload object — blocklist just won't cover this one payment */
      }
    }
  });
}

function registerWalletBlocklistHook(server) {
  registerWalletBlocklistPayerEnrichment(server);
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


// CONFIGURED vs ACTUALLY OFFERED, queryable.
//
// The drop-don't-break guards and the reachability gate below both do the right
// thing: a rail nobody can settle is removed from the offer so the other chains
// keep earning. What neither leaves behind is an ANSWER to "why are we serving
// 11 when we configured 12?" - that lived only in a boot log, and on
// 2026-08-01 the gap went unnoticed for hours while paid revenue was $0.
//
// This records the two sets at the moment the offer is finalised, so
// GET /api/rails can report the difference. Read-only: it observes the
// decision, it never influences it.
let railsConfigured = [];
let railsOffered = [];
// The facilitator clients + labels as built (module-level copy, operator
// diagnostics only). CDP's facilitator table has grown (Polygon, Arbitrum,
// Solana, World) and CDP is FIRST in facilitatorClients, so it may now be
// settling chains the boot log's labels attribute to PayAI; /supported needs
// a JWT, so the only way to know what prod's clients advertise is to ask the
// clients themselves. This feeds GET /__operator/facilitators.json.
// Does serving this resource cost us anything at a third party? Compute-payable
// is the server's own answer to that question (PoW-eligible == makes no external
// call), and it is enforced, not asserted: test-free-tier-egress.js drives every
// one of them under an egress-recording preload and requires zero attributed
// egress. Unknown route -> treated as costly, because the failure we are
// avoiding is spending money we cannot bill for.
let _computePayablePaths = null;
export function setComputePayablePaths(paths) { _computePayablePaths = paths instanceof Set ? paths : new Set(paths || []); }
function isFreeToServe(resource) {
  if (!_computePayablePaths || !_computePayablePaths.size) return false;
  try { return _computePayablePaths.has(new URL(String(resource)).pathname); } catch { return false; }
}

const VERIFY_FAILOVER = String(process.env.VERIFY_FAILOVER || "").toLowerCase();
let facilitatorRegistry = [];
export async function facilitatorSupportReport() {
  return Promise.all(facilitatorRegistry.map(async ({ label, client }) => {
    try {
      const s = await client.getSupported();
      const kinds = Array.isArray(s?.kinds) ? s.kinds : [];
      return {
        label,
        networks: [...new Set(kinds.filter((k) => k?.scheme === "exact").map((k) => k.network))],
        kinds: kinds.map((k) => ({ scheme: k.scheme, network: k.network, x402Version: k.x402Version })),
        extensions: Array.isArray(s?.extensions) ? s.extensions : [],
      };
    } catch (e) {
      return { label, error: String(e?.message || e).slice(0, 200) };
    }
  }));
}
export function railStatus() {
  return railsConfigured.map((n) => ({
    network: n,
    caip2: NETWORKS[n] || null,
    offered: railsOffered.includes(n),
    // Deliberately one honest sentence rather than a guess at which of the
    // several guards fired: the guards already log their specific reason at
    // boot, and inventing a more precise one here could contradict them.
    reason: railsOffered.includes(n)
      ? null
      : "not offered - no reachable facilitator advertises it, or its facilitator config is incomplete (see boot log for the specific guard)",
  }));
}

// One recorder for BOTH verify-failure shapes @x402/core produces: a
// facilitator that THROWS (non-2xx verify: CDP's shape) reaches
// onVerifyFailure; one that answers 200 `{isValid:false}` (PayAI, Solvador,
// our Stellar facilitator) takes the graceful path, which has NO failure
// hook - only onAfterVerify sees it (review 2026-08-28: 20 graceful
// rejections, zero hook firings, zero hints). Tell the buyer WHY on the 402
// (src/verify-hint.js): read their USDC balance on Base (bounded, <= 1.5 s,
// at most 4 in flight) and remember a plain-language hint under the failed
// CREDENTIAL's key, which the 402 middleware merges in for that header only.
async function recordVerifyFailure(ctx, reason) {
  let bucket = "unknown";
  try {
    const amount = Number(ctx?.requirements?.amount);
    const priceUsd = Number.isFinite(amount) ? amount / 1e6 : null;
    const { noteVerifyFailure } = await import("./verify-hint.js");
    const noted = await noteVerifyFailure({ paymentPayload: ctx?.paymentPayload, network: ctx?.requirements?.network, reason, priceUsd });
    if (noted) bucket = noted.bucket;
  } catch { /* a hint is best-effort */ }
  // Telemetry (reason, chain, route, balance BUCKET - never the payer): see posthog.js.
  // Who failed, as a one-way id. Prefer the signed EIP-3009 `from`; fall back to
  // the credential itself (SVM/Stellar payloads carry no readable payer), which
  // is what credentialKeyOf already derives for the 402 hint. Never an address.
  let payerKey = null;
  try {
    // KEYED, not a bare hash. sha256 of an EVM address is one-way only against
    // blind inversion: the input comes from a public, enumerable set - every
    // address that has settled USDC on Base - so anyone holding the analytics
    // dataset recovers the payer by hashing candidates until one matches. That is
    // pseudonymisation, not anonymisation, and the comment here claimed the
    // stronger thing. An HMAC under a secret we hold is neither forgeable nor
    // enumerable and still groups (same payer, same id) - the construction the
    // wish board already uses for caller fingerprints.
    const { createHmac } = await import("node:crypto");
    const idSecret = process.env.TELEMETRY_ID_SECRET || process.env.POW_SECRET || process.env.MPP_SECRET_KEY || "";
    const from = ctx?.paymentPayload?.payload?.authorization?.from;
    let basis = from ? `payer:${String(from).toLowerCase()}` : null;
    if (!basis) {
      const { credentialKeyOf } = await import("./verify-hint.js");
      const cred = credentialKeyOf(ctx?.paymentPayload);
      if (cred) basis = `credential:${cred}`;
    }
    // No secret configured: emit NO id rather than a reversible one. A missing
    // dimension is a gap in telemetry; a guessable one is a claim we cannot back.
    if (basis && idSecret) payerKey = `a402:${createHmac("sha256", idSecret).update(basis).digest("hex").slice(0, 32)}`;
  } catch { /* telemetry is best-effort */ }
  import("./posthog.js").then(({ capturePostHogVerifyFailed }) => capturePostHogVerifyFailed({
    network: ctx?.requirements?.network, scheme: ctx?.requirements?.scheme, resource: ctx?.requirements?.resource, errorReason: reason, payerBalanceBucket: bucket, payerKey,
  })).catch(() => {});
}

export function registerFacilitatorFailureHooks(server, payAiClient, solvadorClient = null) {
  server.onVerifyFailure(async (ctx) => {
    const reason = summarizeFacilitatorError(ctx?.error);
    console.warn(
      `[payments] facilitator VERIFY failed on ${ctx?.requirements?.network} ` +
        `${ctx?.requirements?.scheme}: ${reason}`
    );
    // Before writing this off as a failed payment: was the facilitator merely
    // UNREACHABLE? @x402/core resolves one client per network and does not fall
    // back when that client throws, so a connect timeout at CDP - which is
    // first-tried for Solana - loses the sale outright while PayAI sits idle.
    // Verify is a READ, so asking another facilitator cannot double charge.
    // Only a transport failure is retried; a verdict is never second-guessed.
    // (src/verify-failover.js carries the full reasoning.)
    // Only rescue a verify when the work it unlocks is FREE for us.
    //
    // Failover is verify-only, and verify is a read, so it cannot double-charge -
    // that part holds. The cost sits one layer out: settle resolves the SAME
    // facilitator client that was just unreachable (getFacilitatorClient is a
    // deterministic lookup), and settle has no transport-error fallback BY
    // DESIGN, because retrying a possibly-broadcast settlement elsewhere is how
    // you double-settle. So a rescued verify on a metered route runs the handler,
    // spends real upstream money (up to $0.65 on a report tier), then 402s at
    // settle: buyer not charged, gets nothing, retries, and each retry spends
    // again. Before this feature that request 402'd BEFORE the handler, free.
    //
    // Compute-payable routes make no external call at all - proven every run by
    // test-free-tier-egress.js - so rescuing those is pure upside: a sale we
    // would otherwise lose, and a failed settle costs only CPU.
    if (VERIFY_FAILOVER !== "off" && isFreeToServe(ctx?.requirements?.resource)) {
      try {
        const { verifyElsewhere } = await import("./verify-failover.js");
        const rescued = await verifyElsewhere({
          error: ctx?.error,
          paymentPayload: ctx?.paymentPayload,
          requirements: ctx?.requirements,
          registry: facilitatorRegistry,
          log: (label, msg) => console.warn(`[payments] ${msg}`),
        });
        if (rescued) {
          await recordVerifyFailure(ctx, `${reason} (recovered via ${rescued.via})`);
          return rescued;
        }
      } catch (e) {
        console.warn(`[payments] verify failover errored, original failure stands: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    await recordVerifyFailure(ctx, reason);
  });
  if (typeof server.onAfterVerify === "function") {
    server.onAfterVerify(async (ctx) => {
      if (ctx?.result && ctx.result.isValid === false) {
        const reason = String(ctx.result.invalidReason || "verify rejected");
        console.warn(`[payments] facilitator VERIFY rejected on ${ctx?.requirements?.network} ${ctx?.requirements?.scheme}: ${reason}`);
        await recordVerifyFailure(ctx, reason);
      }
    });
  }

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
    const failure = summarizeFacilitatorError(ctx?.error);
    // A facilitator QUOTA refusal is not an outage and must not read as one:
    // PayAI answers 403 free_tier_exhausted once the free monthly settlements
    // are spent (1,000 per receiving wallet). Say so in the log so the alarm
    // and the operator reach for credits, not for a status page.
    if (/free_tier_exhausted|quota[_ ]exceeded|payment[_ ]required.*credit/i.test(failure)) {
      console.warn(
        `[payments] facilitator QUOTA exhausted on ${ctx?.requirements?.network} ` +
          `${ctx?.requirements?.scheme}: ${failure} - top up the facilitator account; this is billing, not an outage`
      );
    }
    console.warn(
      `[payments] facilitator SETTLE failed on ${ctx?.requirements?.network} ` +
        `${ctx?.requirements?.scheme}: ${failure}`
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
export function summarizeFacilitatorError(err) {
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
  // NETWORK-LEVEL failures arrive as the bare string "fetch failed" - undici
  // flattens every one of them to that, and hangs the real reason off
  // `err.cause`. A DNS failure and a refused connection are byte-identical
  // without it (verified: both log `message="fetch failed"`, one carries
  // code=ENOTFOUND syscall=getaddrinfo, the other nothing at all).
  //
  // That is why a Monad settle failure read as an unknowable blip and got
  // written off as "transient". It was not unknowable; the field that would
  // have named it was being dropped one line before it was logged. A cause we
  // discard is not a cause we do not have.
  const cause = err?.cause;
  // Happy Eyeballs on a dual-stack host (the Monad facilitator has both A and
  // AAAA behind Cloudflare) can fail every address and hand back an
  // AggregateError. Its `.errors` is where the per-address reason lives; the
  // wrapper itself carries no code, so without this branch a dual-stack
  // failure still logs as bare "fetch failed" - the exact shape being fixed.
  if (Array.isArray(cause?.errors) && cause.errors.length) {
    const subs = cause.errors.slice(0, 3).map((e) =>
      [e?.code, e?.address && `address=${e.address}`, e?.port && `port=${e.port}`].filter(Boolean).join(" ")
    ).filter(Boolean);
    if (subs.length) return `${msg.slice(0, 140)} [all addresses failed: ${subs.join(" | ")}]`;
  }
  if (cause) {
    const bits = [cause.code, cause.syscall && `syscall=${cause.syscall}`,
      cause.errno !== undefined && `errno=${cause.errno}`,
      cause.address && `address=${cause.address}`, cause.port && `port=${cause.port}`,
      // A nested cause is where TLS and proxy errors put the real reason.
      cause.cause?.code && `inner=${cause.cause.code}`,
      !cause.code && cause.message && `cause="${String(cause.message).slice(0, 80)}"`,
    ].filter(Boolean);
    if (bits.length) return `${msg.slice(0, 160)} [${bits.join(" ")}]`;
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
  // URL-override parity with every other facilitator (CELO_/MONAD_/ROBINHOOD_/
  // SOLVADOR_/STELLAR_/ALGORAND_FACILITATOR_URL are all env-overridable) —
  // PayAI was the only one whose endpoint couldn't be pointed at a stub, which
  // is what scripts/test-supported-guard.js needs to boot a fully offline
  // multi-facilitator server. Unset = stock @payai/facilitator config.
  if (process.env.PAYAI_FACILITATOR_URL) {
    console.log(`Facilitator (Solana): PayAI at ${process.env.PAYAI_FACILITATOR_URL} (URL override)`);
    return { url: process.env.PAYAI_FACILITATOR_URL };
  }
  if (process.env.PAYAI_API_KEY_ID && process.env.PAYAI_API_KEY_SECRET) {
    const { createFacilitatorConfig } = await import("@payai/facilitator");
    console.log("Facilitator (Solana): PayAI (authenticated)");
    return createFacilitatorConfig(process.env.PAYAI_API_KEY_ID, process.env.PAYAI_API_KEY_SECRET);
  }
  // PayAI free tier: 1,000 settlements/month per receiving wallet, no API
  // key needed; past that /settle answers 403 free_tier_exhausted and the
  // account bills $0.001/tx from prepaid credits (docs read 2026-08-28).
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
