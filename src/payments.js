import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
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

// Supported networks. EVM chains use eip155: CAIP-2 IDs; Solana uses the
// solana: genesis-hash CAIP-2. Adding a chain = register its scheme + list
// it in `accepts`. Only chains a facilitator can settle are safe to add.
// Only chains whose USDC address is in @x402/evm's built-in asset registry.
// Avalanche is excluded — getDefaultAsset throws for eip155:43114.
const EVM_NETWORKS = {
  base: "eip155:8453",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
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
// Exported for scripts/test-rails.js: the copy layer (src/rails.js) must
// advertise every mainnet rail this file can settle — the test cross-checks.
export const NETWORKS = { ...EVM_NETWORKS, ...SVM_NETWORKS, ...STELLAR_NETWORKS };

// Robinhood Chain settles USDG (Global Dollar), not Circle USDC, and @x402/evm
// has no default asset for chain 4663 — so we resolve the asset ourselves and
// route settlement to an external facilitator that advertises
// exact/eip155:4663/USDG at its /supported endpoint. The facilitator URL is
// operator-supplied via ROBINHOOD_FACILITATOR_URL (no default is baked in);
// the USDG EIP-712 domain (name/version) is likewise env-overridable and can be
// verified on-chain via scripts/rh-chain-probe.js before enabling.
const ROBINHOOD_CAIP2 = "eip155:4663";
const ROBINHOOD_FACILITATOR_URL = (process.env.ROBINHOOD_FACILITATOR_URL || "").trim();
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
        `Ignoring unknown PAYMENT_NETWORKS entry "${n}" — not offered. Known: ${Object.keys(NETWORKS).join(", ")}`
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

/**
 * Build the x402 v2 payment middleware: an "exact" USDC payment scheme,
 * paywalling the routes in `catalog`, with Bazaar discovery metadata so agents
 * can find the service. Accepts USDC on EVM chains and optionally Solana (the
 * agent picks the chain it holds funds on).
 */
export async function buildPaymentMiddleware({ walletAddress, network, baseUrl, catalog }) {
  const networks = enabledNetworks(network);
  const caip2List = networks.map((n) => NETWORKS[n]);
  let evmCaip2 = caip2List.filter((c) => c.startsWith("eip155:"));
  const svmCaip2 = caip2List.filter((c) => c.startsWith("solana:"));
  const stellarCaip2 = caip2List.filter((c) => c.startsWith("stellar:"));

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
        "WARNING: multi-chain mode without CDP keys — Base will settle via PayAI and the " +
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
      "WARNING: PAYMENT_NETWORKS enables `robinhood` but ROBINHOOD_FACILITATOR_URL is unset — " +
        "dropping Robinhood Chain/USDG from the offered networks (other chains unaffected). " +
        "Set ROBINHOOD_FACILITATOR_URL to enable it."
    );
    evmCaip2 = evmCaip2.filter((c) => c !== ROBINHOOD_CAIP2);
  }
  if (robinhoodEnabled) {
    facilitatorClients.push(new HTTPFacilitatorClient({ url: ROBINHOOD_FACILITATOR_URL }));
    console.log(`Robinhood Chain: settling USDG (${USDG.asset}) via facilitator ${ROBINHOOD_FACILITATOR_URL}`);
  }
  let server = new x402ResourceServer(facilitatorClients)
    .registerExtension(bazaarResourceServerExtension)
    .registerExtension(builderCodeResourceServerExtension);
  for (const caip2 of evmCaip2) {
    server = server.register(caip2, caip2 === ROBINHOOD_CAIP2 ? makeUsdgScheme() : new ExactEvmScheme());
  }
  for (const caip2 of svmCaip2) server = server.register(caip2, new ExactSvmScheme());
  // Stellar — settlement via the OpenZeppelin-operated x402 facilitator on pubnet.
  // STELLAR_FACILITATOR_URL defaults to the public OpenZeppelin endpoint; override
  // for a self-hosted or private facilitator instance.
  const stellarFacilitatorUrl = (process.env.STELLAR_FACILITATOR_URL || "https://channels.openzeppelin.com/x402").trim();
  const stellarWallet = (process.env.STELLAR_WALLET_ADDRESS || "").trim();
  if (stellarCaip2.length && stellarWallet) {
    facilitatorClients.push(new HTTPFacilitatorClient({ url: stellarFacilitatorUrl }));
    for (const caip2 of stellarCaip2) server = server.register(caip2, new ExactStellarScheme());
    console.log(`Stellar: settling USDC via facilitator ${stellarFacilitatorUrl} → ${stellarWallet}`);
  } else if (stellarCaip2.length && !stellarWallet) {
    console.warn(
      "WARNING: PAYMENT_NETWORKS enables `stellar` but STELLAR_WALLET_ADDRESS is unset — " +
        "the Stellar payment option will be OMITTED from every 402. Set STELLAR_WALLET_ADDRESS " +
        "(Stellar public key, G...) to accept USDC on Stellar."
    );
  }
  registerFacilitatorFailureHooks(server, payAiClient);
  console.log(
    `Accepting USDC on: ${networks.join(", ")} (${caip2List.join(", ")})` +
      (robinhoodEnabled ? " — note: robinhood settles USDG, not USDC" : "")
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
      "WARNING: PAYMENT_NETWORKS enables a Solana network but SOLANA_WALLET_ADDRESS is unset — " +
        "the Solana payment option will be OMITTED from every 402. Set SOLANA_WALLET_ADDRESS " +
        "(base58 Solana address) to actually accept USDC on Solana."
    );
  }

  // One payment option per enabled chain — agents pick the chain they hold funds on.
  const acceptsFor = (item) => [
    ...evmCaip2.map((caip2) => ({ scheme: "exact", payTo: walletAddress, price: item.price, network: caip2 })),
    ...(solanaWallet ? svmCaip2.map((caip2) => ({ scheme: "exact", payTo: solanaWallet, price: item.price, network: caip2 })) : []),
    ...(stellarWallet ? stellarCaip2.map((caip2) => ({ scheme: "exact", payTo: stellarWallet, price: item.price, network: caip2 })) : []),
  ];

  // The payment-required header is one base64-encoded JSON blob carrying
  // description + discovery extensions.  Skill packs and tools with rich
  // schemas can push it past ~2900 bytes, which @x402/fetch fails to
  // negotiate.  Cap description and strip bulky output examples here; full
  // text lives on /api/pricing, /openapi.json, tool pages, and MCP surfaces.
  const capDesc = (s) => (s && s.length > 250 ? s.slice(0, 247) + "..." : s);
  const slimDiscovery = (d) => {
    if (!d) return d;
    const slim = { ...d };
    if (slim.output) slim.output = { type: slim.output.type || "json" };
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
          tags: ["web", "tools", "agents", ...(item.tags ?? [])],
          mimeType: "application/json",
          resource: `${baseUrl}${route.split(" ")[1]}`,
          extensions: Object.keys(ext).length ? ext : undefined,
        },
      ];
    })
  );

  // X402_SYNC_ON_START=false skips the facilitator handshake at boot —
  // only for local testing where the facilitator is unreachable.
  const syncOnStart = process.env.X402_SYNC_ON_START !== "false";
  return paymentMiddleware(routes, server, undefined, undefined, syncOnStart);
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
 * PAYMENT_SETTLE_FALLBACK=true (default OFF) additionally re-settles through
 * PayAI when the primary facilitator rejects settlement BEFORE broadcasting
 * (an HTTP 402 billing gate) — never on a timeout/5xx, where the primary may
 * already have broadcast, so it cannot double-charge the buyer. Left off by
 * default so Base stays purely on CDP (Bazaar discovery + fee-free settlement)
 * unless the operator opts into never-miss-a-sale behavior.
 */
function registerFacilitatorFailureHooks(server, payAiClient) {
  server.onVerifyFailure((ctx) => {
    console.warn(
      `[payments] facilitator VERIFY failed on ${ctx?.requirements?.network} ` +
        `${ctx?.requirements?.scheme}: ${summarizeFacilitatorError(ctx?.error)}`
    );
  });

  const fallbackEnabled = /^(1|true|yes|on)$/i.test((process.env.PAYMENT_SETTLE_FALLBACK || "").trim());
  server.onSettleFailure(async (ctx) => {
    console.warn(
      `[payments] facilitator SETTLE failed on ${ctx?.requirements?.network} ` +
        `${ctx?.requirements?.scheme}: ${summarizeFacilitatorError(ctx?.error)}`
    );
    if (!fallbackEnabled || !payAiClient) return;
    if (!isPreBroadcastSettleRejection(ctx?.error)) return;
    try {
      const result = await payAiClient.settle(ctx.paymentPayload, ctx.requirements);
      console.warn(
        `[payments] recovered ${ctx?.requirements?.network} settlement via PayAI fallback ` +
          "(PAYMENT_SETTLE_FALLBACK=true; primary rejected pre-broadcast)"
      );
      return { recovered: true, result };
    } catch (err) {
      console.warn(
        `[payments] PayAI settle fallback ALSO failed on ${ctx?.requirements?.network}: ` +
          summarizeFacilitatorError(err)
      );
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
function isPreBroadcastSettleRejection(err) {
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
        `WARNING: Solana payTo ${owner} has NO USDC token account — every buyer's Solana ` +
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
