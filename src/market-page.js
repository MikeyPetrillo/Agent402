// Chain-agnostic x402 marketplace renderer — one template, chain config as
// data. Generalizes what used to be two near-identical files
// (stellar-page.js, algorand-page.js) so a third chain page is a CHAIN_PAGES
// entry, not a fork. src/stellar-page.js and src/algorand-page.js are now
// thin wrappers over marketPage() that keep their original export names so
// server.js and the existing test suites need no changes.
//
// Honesty rules (unchanged from the originals — see scripts/test-*-page.js):
// never invent receipts, say plainly when Agent402 is the only listed
// seller, "unavailable" rather than zeros on a failed scan, truncation
// floors, javascript: href neutralization, testnet exclusion, >12-seller
// compact roster, per-seller activity switching via ?seller=.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { CATEGORIES } from "./pages.js";
import { chainMark, CHAIN_ORDER } from "./chain-logos.js";
import { discoveryNote } from "./discovery-note.js";
import { hostCardHtml } from "./host-entry.js";

// Seller-roster row styles hoisted to classes. A busy chain (e.g. Base) renders
// 1000+ roster rows; when each row carried its 6 styles inline the page ballooned
// to ~1 MB of HTML / ~8k inline style attrs, which is slow for the browser to
// parse and style. As classes the same markup is ~5x smaller and the style
// engine reuses one computed rule per class. Output is visually identical (same
// CSS vars, same light/dark theme). The `.ml-roster-compact` hook is kept on the
// row so the existing mobile media query still collapses the grid.
const ROSTER_CSS = `
.mlr-row{display:grid;grid-template-columns:1fr auto auto auto;gap:14px;align-items:center;padding:9px 14px;border:1px solid var(--hairline);background:var(--card);color:var(--ink);text-decoration:none}
.mlr-row.sel{border:2px solid var(--accent)}
.mlr-name{font-weight:700;font-size:14px}
.mlr-host{font-family:var(--font-mono);font-size:12px;color:var(--faint)}
.mlr-tools{color:var(--muted);font-family:var(--font-mono);font-size:12.5px}
.mlr-stat{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:12px;color:var(--green)}
.mlr-stat.bad{color:var(--accent)}
.mlr-dot{width:7px;height:7px;border-radius:50%;background:var(--green)}
.mlr-stat.bad .mlr-dot{background:var(--accent)}
.mlr-badge{background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:1px 5px}
.mlr-mpp{border:1px solid var(--green);color:var(--green);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:0 4px;margin-left:4px}
.ml-chain-h1-wrap{min-height:80px}
@media (max-width: 900px) { .ml-chain-h1-wrap{min-height:120px} }
.mkt-search-wrap{border:1px solid var(--hairline)}
.mkt-search-wrap:focus-within{border-color:var(--accent)}`;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Crawled manifests are third-party input: only http(s) may become an href.
const safeHref = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");
// Dollar formatter that never lies about a nonzero settle: normal amounts get
// 2-3 decimals, but a tiny real payment (e.g. a $0.0004 canary buy) must not
// round down to "$0" - widen to up to 6 decimals until a nonzero digit shows.
const usd = (n) => {
  const v = Number(n);
  let s = v.toFixed(v < 0.01 ? 3 : 2);
  if (v > 0 && Number(s) === 0) s = v.toFixed(6);
  return `$${s.replace(/\.?0+$/, (m) => (m.includes(".") ? "" : m))}`;
};

/** Per-chain identity + copy. Add a chain here (not a new route) once it has
 *  a live page. Ordered to match src/rails.js (primary rail first). */
export const CHAIN_PAGES = {
  base: {
    chainName: "Base",
    // MPP challenges ride this chain's 402s (MPP_CHALLENGE_NETWORKS default
    // is Base+Celo) - the only chains where "pay via MPP" is advertised truth.
    mpp: true,
    ticker: "ETH",
    tickerLabel: "BASE · MAINNET",
    caip2: "eip155:8453",
    asset: "USDC",
    settleLatency: "~2 seconds",
    facilitatorLabel: "Coinbase CDP",
    gasNote: "sponsored",
    explorerUrl: "basescan.org",
    explorerWalletUrl: (wallet) => `https://basescan.org/address/${wallet}#tokentxns`,
    networkParam: "base",
    acceptNetwork: "eip155:8453",
    // Base mainnet CAIP-2 is "eip155:8453"; Base Sepolia testnet is a
    // different chain id ("eip155:84532") entirely, so an exact match
    // can't be fooled by a testnet accept.
    isNetwork: (n) => n === "eip155:8453",
    honestyNetworkPhrase: "the Base network",
    canaryLine: "A paid canary buys tools over the Base rail daily (facilitator: Coinbase CDP) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Base CAIP-2 network (<code>eip155:8453</code>) in your 402 challenge - the Coinbase CDP facilitator verifies and settles, gas sponsored, and a listed origin is picked up by the CDP Bazaar too. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  solana: {
    chainName: "Solana",
    ticker: "SOL",
    tickerLabel: "SOLANA · MAINNET",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "USDC",
    settleLatency: "~1 second",
    facilitatorLabel: "PayAI",
    gasNote: "fee-sponsored",
    explorerUrl: "solscan.io",
    explorerWalletUrl: (wallet) => `https://solscan.io/account/${wallet}`,
    networkParam: "solana",
    acceptNetwork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    // Solana mainnet CAIP-2 is the mainnet genesis hash; devnet is a wholly
    // different genesis hash ("solana:EtWTRABZ…"), so an exact match can't
    // be fooled by a devnet accept.
    isNetwork: (n) => n === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    honestyNetworkPhrase: "the Solana network",
    canaryLine: "A paid canary buys tools over the Solana rail daily (facilitator: PayAI) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Solana CAIP-2 network (<code>solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp</code>) in your 402 challenge using the <a href="https://www.npmjs.com/package/@x402/svm" rel="noopener"><code>@x402/svm</code></a> server scheme - the PayAI facilitator verifies and settles, fees sponsored. Your payTo wallet needs an existing USDC associated token account before it can receive payments (send it any amount of USDC once to create one). Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  polygon: {
    chainName: "Polygon",
    ticker: "POL",
    tickerLabel: "POLYGON · MAINNET",
    caip2: "eip155:137",
    asset: "USDC",
    settleLatency: "~2 seconds",
    facilitatorLabel: "PayAI",
    gasNote: "sponsored",
    explorerUrl: "polygonscan.com",
    explorerWalletUrl: (wallet) => `https://polygonscan.com/address/${wallet}#tokentxns`,
    networkParam: "polygon",
    acceptNetwork: "eip155:137",
    // Polygon mainnet CAIP-2 is "eip155:137"; Amoy testnet is a different
    // chain id ("eip155:80002"), so an exact match can't be fooled.
    isNetwork: (n) => n === "eip155:137",
    honestyNetworkPhrase: "the Polygon network",
    canaryLine: "A paid canary buys tools over the Polygon rail daily (facilitator: PayAI) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Polygon CAIP-2 network (<code>eip155:137</code>) in your 402 challenge - the PayAI facilitator verifies and settles, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  arbitrum: {
    chainName: "Arbitrum",
    ticker: "ETH",
    tickerLabel: "ARBITRUM · MAINNET",
    caip2: "eip155:42161",
    asset: "USDC",
    settleLatency: "~2 seconds",
    facilitatorLabel: "PayAI",
    gasNote: "sponsored",
    explorerUrl: "arbiscan.io",
    explorerWalletUrl: (wallet) => `https://arbiscan.io/address/${wallet}#tokentxns`,
    networkParam: "arbitrum",
    acceptNetwork: "eip155:42161",
    // Arbitrum One CAIP-2 is "eip155:42161"; Arbitrum Sepolia is a
    // different chain id ("eip155:421614"), so an exact match can't be
    // fooled by a testnet accept.
    isNetwork: (n) => n === "eip155:42161",
    honestyNetworkPhrase: "the Arbitrum network",
    canaryLine: "A paid canary buys tools over the Arbitrum rail daily (facilitator: PayAI) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Arbitrum CAIP-2 network (<code>eip155:42161</code>) in your 402 challenge - the PayAI facilitator verifies and settles, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  monad: {
    chainName: "Monad",
    ticker: "MON",
    tickerLabel: "MONAD · MAINNET",
    caip2: "eip155:143",
    asset: "USDC",
    settleLatency: "~1 second",
    facilitatorLabel: "molandak",
    gasNote: "sponsored",
    explorerUrl: "monadscan.com",
    explorerWalletUrl: (wallet) => `https://monadscan.com/address/${wallet}#tokentxns`,
    networkParam: "monad",
    acceptNetwork: "eip155:143",
    // Monad mainnet CAIP-2 is "eip155:143"; Monad testnet is a different chain
    // id ("eip155:10143"), so an exact match can't be fooled by a testnet accept.
    isNetwork: (n) => n === "eip155:143",
    honestyNetworkPhrase: "the Monad network",
    canaryLine: "A paid canary buys tools over the Monad rail daily (facilitator: molandak) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Monad CAIP-2 network (<code>eip155:143</code>) in your 402 challenge - the molandak facilitator verifies and settles native Circle USDC, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  celo: {
    chainName: "Celo",
    mpp: true, // see the note on base - MPP challenges serve on Base+Celo

    ticker: "CELO",
    tickerLabel: "CELO · MAINNET",
    caip2: "eip155:42220",
    asset: "USDC",
    settleLatency: "~1 second",
    facilitatorLabel: "Celo",
    gasNote: "sponsored",
    explorerUrl: "celoscan.io",
    explorerWalletUrl: (wallet) => `https://celoscan.io/address/${wallet}#tokentxns`,
    networkParam: "celo",
    acceptNetwork: "eip155:42220",
    // Celo mainnet CAIP-2 is "eip155:42220"; Celo Sepolia is a different chain
    // id ("eip155:11142220"), so an exact match can't be fooled by a testnet accept.
    isNetwork: (n) => n === "eip155:42220",
    honestyNetworkPhrase: "the Celo network",
    canaryLine: "A paid canary buys tools over the Celo rail daily (facilitator: x402.celo.org) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Celo CAIP-2 network (<code>eip155:42220</code>) in your 402 challenge - the <a href="https://x402.celo.org" rel="noopener">Celo facilitator</a> verifies and settles native Circle USDC, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  avalanche: {
    chainName: "Avalanche",
    ticker: "AVAX",
    tickerLabel: "AVALANCHE · C-CHAIN",
    caip2: "eip155:43114",
    asset: "USDC",
    settleLatency: "~2 seconds",
    facilitatorLabel: "PayAI",
    gasNote: "sponsored",
    explorerUrl: "snowtrace.io",
    explorerWalletUrl: (wallet) => `https://snowtrace.io/address/${wallet}`,
    networkParam: "avalanche",
    acceptNetwork: "eip155:43114",
    // Avalanche C-Chain CAIP-2 is "eip155:43114"; Fuji testnet is a different
    // chain id ("eip155:43113"), so an exact match can't be fooled.
    isNetwork: (n) => n === "eip155:43114",
    honestyNetworkPhrase: "the Avalanche network",
    canaryLine: "A paid canary buys tools over the Avalanche rail daily (facilitator: PayAI) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Avalanche CAIP-2 network (<code>eip155:43114</code>) in your 402 challenge - the PayAI facilitator verifies and settles native Circle USDC, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  sei: {
    chainName: "Sei",
    ticker: "SEI",
    tickerLabel: "SEI · PACIFIC-1",
    caip2: "eip155:1329",
    asset: "USDC",
    settleLatency: "~1 second",
    facilitatorLabel: "PayAI",
    gasNote: "sponsored",
    explorerUrl: "seiscan.io",
    explorerWalletUrl: (wallet) => `https://seiscan.io/address/${wallet}?chain=pacific-1`,
    networkParam: "sei",
    acceptNetwork: "eip155:1329",
    // Sei mainnet (pacific-1) CAIP-2 is "eip155:1329"; testnets are different
    // chain ids, so an exact match can't be fooled.
    isNetwork: (n) => n === "eip155:1329",
    honestyNetworkPhrase: "the Sei network",
    canaryLine: "A paid canary buys tools over the Sei rail daily (facilitator: PayAI) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Sei CAIP-2 network (<code>eip155:1329</code>) in your 402 challenge - the PayAI facilitator verifies and settles native Circle USDC, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  optimism: {
    chainName: "Optimism",
    ticker: "OP",
    tickerLabel: "OPTIMISM \u00b7 MAINNET",
    caip2: "eip155:10",
    asset: "USDC",
    settleLatency: "~2 seconds",
    facilitatorLabel: "Solvador",
    gasNote: "sponsored",
    explorerUrl: "optimistic.etherscan.io",
    explorerWalletUrl: (wallet) => `https://optimistic.etherscan.io/address/${wallet}`,
    networkParam: "optimism",
    acceptNetwork: "eip155:10",
    // OP mainnet CAIP-2 is "eip155:10"; OP Sepolia is a different chain id
    // ("eip155:11155420"), so an exact match can't be fooled. Settles native
    // Circle USDC (standard "USD Coin" v2 domain, EIP-3009 verified on-chain).
    isNetwork: (n) => n === "eip155:10",
    honestyNetworkPhrase: "the Optimism network",
    canaryLine: "A paid canary buys tools over the Optimism rail daily (facilitator: Solvador) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Optimism CAIP-2 network (<code>eip155:10</code>) in your 402 challenge - the Solvador facilitator verifies and settles native Circle USDC, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  stellar: {
    chainName: "Stellar",
    ticker: "XLM",
    tickerLabel: "STELLAR · PUBNET",
    caip2: "stellar:pubnet",
    asset: "USDC",
    settleLatency: "~5 seconds",
    facilitatorLabel: "OpenZeppelin",
    gasNote: "sponsored",
    explorerUrl: "stellar.expert",
    explorerWalletUrl: (wallet) => `https://stellar.expert/explorer/public/account/${wallet}`,
    networkParam: "stellar",
    acceptNetwork: "stellar:pubnet",
    wallet: "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL",
    // Stellar mainnet CAIP-2 is "stellar:pubnet"; testnet ids contain "test".
    isNetwork: (n) => typeof n === "string" && n.startsWith("stellar") && !n.includes("test"),
    honestyNetworkPhrase: "a Stellar network",
    canaryLine: "A paid canary buys tools over the Stellar rail daily (facilitator: OpenZeppelin) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept x402 payments with a <code>stellar:pubnet</code> accept in your 402 challenge - the <a href="https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar" rel="noopener">Built on Stellar facilitator</a> (OpenZeppelin) verifies and settles, gas sponsored. Use <a href="https://www.npmjs.com/package/@x402/stellar" rel="noopener"><code>@x402/stellar</code></a> for the wire, or <a href="/tollbooth"><code>agent402-tollbooth</code></a> to paywall an existing site. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  algorand: {
    chainName: "Algorand",
    ticker: "ALGO",
    tickerLabel: "ALGORAND · MAINNET",
    caip2: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    asset: "USDC",
    settleLatency: "~3 seconds",
    facilitatorLabel: "GoPlausible",
    gasNote: "fee-sponsored",
    explorerUrl: "allo.info",
    explorerWalletUrl: (wallet) => `https://allo.info/account/${wallet}`,
    networkParam: "algorand",
    acceptNetwork: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    wallet: "C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE",
    // Algorand mainnet CAIP-2 is `algorand:wGHE2Pwd…kit8=`; testnet starts
    // `algorand:SGO1GKSz…`. An exact-prefix match on the mainnet genesis
    // hash (rather than excluding the substring "test") can't be fooled by
    // a testnet id that happens not to contain "test".
    isNetwork: (n) => typeof n === "string" && n.startsWith("algorand:wGHE2Pwd"),
    honestyNetworkPhrase: "the Algorand mainnet network",
    canaryLine: "A paid canary buys tools over the Algorand rail daily (facilitator: GoPlausible, fees sponsored) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Algorand mainnet CAIP-2 network in your 402 challenge using the <a href="https://www.npmjs.com/package/@x402/avm" rel="noopener"><code>@x402/avm</code></a> server SDK - the GoPlausible facilitator verifies and settles, fees sponsored. Your payTo wallet must be opted in to ASA <code>31566704</code> (USDC) before it can receive payments. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free. Want a guaranteed crawl? <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Open a seed request</a>.`,
  },
  robinhood: {
    chainName: "Robinhood Chain",
    ticker: "USDG",
    tickerLabel: "ROBINHOOD CHAIN · MAINNET",
    caip2: "eip155:4663",
    asset: "USDG",
    settleLatency: "~2 seconds",
    facilitatorLabel: "operator-configured",
    gasNote: "sponsored",
    explorerUrl: "robinhoodchain.blockscout.com",
    explorerWalletUrl: (wallet) => `https://robinhoodchain.blockscout.com/address/${wallet}`,
    networkParam: "robinhood",
    acceptNetwork: "eip155:4663",
    // Robinhood Chain mainnet CAIP-2 is "eip155:4663" - an Arbitrum Orbit
    // L2 with no public testnet accept in the wild today, but the exact
    // match keeps the same guarantee as every other EVM rail here.
    isNetwork: (n) => n === "eip155:4663",
    honestyNetworkPhrase: "the Robinhood Chain network",
    canaryLine: "A paid canary buys tools over the Robinhood Chain rail daily (facilitator: operator-configured) - uptime proven with real settlements, not pings.",
    sellParagraphHtml: `Accept the Robinhood Chain CAIP-2 network (<code>eip155:4663</code>) in your 402 challenge, asset USDG (Global Dollar) - set <code>PAYMENT_NETWORKS=…,robinhood</code> plus your own <code>ROBINHOOD_FACILITATOR_URL</code> (the rail settles through an operator-supplied facilitator, not CDP or PayAI). Use <a href="https://www.npmjs.com/package/@x402/evm" rel="noopener"><code>@x402/evm</code></a> for the server-side scheme (EIP-712 domain <code>"Global Dollar"</code>, version <code>"1"</code>), or <a href="/tollbooth"><code>agent402-tollbooth</code></a> (<code>TOLLBOOTH_NETWORK=eip155:4663 TOLLBOOTH_ASSET=USDG</code>). The <a href="/guides/usdg-payments-robinhood-chain">full integration guide</a> covers chain parameters and how to recognize a settlement on Blockscout. Then serve <code>/.well-known/x402</code> - list it on /sell (free) and the index crawler picks it up; ranking is health-based, listing is free.`,
  },
};

/** Sellers with a rail on this chain: the local catalog always qualifies
 *  (every local tool's 402 offers this chain); remote sellers qualify when
 *  their crawled 402s advertise a matching network. */
export function marketSellers(chainKey, snapshot) {
  const C = CHAIN_PAGES[chainKey];
  return (snapshot?.sellers || []).filter((s) => s.local === true || (s.networks || []).some(C.isNetwork));
}

/** Every seller across every chain (local first) - backs the unified
 *  "The x402 marketplace" all-chains view (marketPage(null, …)). Unlike
 *  marketSellers this takes no chain and applies no network filter. */
export function marketSellersAll(snapshot) {
  const all = (snapshot?.sellers || []);
  return all.slice().sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));
}

/** CAIP-2 network id -> chain key, via the CHAIN_PAGES isNetwork matchers.
 *  Returns null when no configured chain claims the network (e.g. a testnet). */
function chainKeyForNetwork(network) {
  for (const key of Object.keys(CHAIN_PAGES)) if (CHAIN_PAGES[key].isNetwork(network)) return key;
  return null;
}

/** Tools purchasable on this chain. Remote snapshot entries carry no
 *  per-tool list, so this is the local catalog; external sellers render
 *  seller-level. */
export function marketTools(_chainKey, snapshot) {
  const local = (snapshot?.sellers || []).find((s) => s.local === true);
  return local?.tools || [];
}

// Shared filter bar for the unified marketplace: chain tabs (links, so the
// per-chain SEO URLs stay crawlable) + sort + search. chainKey===null marks
// the "All" (/marketplace) view; a chain slug marks that chain's view. No
// Category control: the roster lists SELLERS, and sellers carry no category
// data — a select with nothing real to filter on would be a dead control.
//
// The trailing <script> wires Sort + search client-side over the roster rows'
// numeric data-* payload (see rowData in marketPage / marketPageAll) — same
// progressive-enhancement style as the seller-panel switch script: the page is
// fully rendered server-side, and the whole block no-ops when the roster is
// absent. Rows are re-ordered by moving EXISTING nodes (appendChild) and
// hidden via style.display — never innerHTML.
//
// EXECUTION ORDER: the bar (and this script) render ABOVE the roster, so at
// parse time zero [data-mfb-row] elements exist yet — everything is wired on
// DOMContentLoaded, once the whole roster is in the DOM. (An earlier version
// queried the rows at parse time and its zero-rows early return dead-wired
// the controls on every load; the execution-order test locks this in.)
export function marketFilterBar(chainKey, _baseUrl) {
  const tab = (key, label, href, on) =>
    `<a data-chain-tab="${key}" href="${href}" class="mfb-tab${on ? " on" : ""}">${esc(label)}</a>`;
  const tabs = [tab("all", "All", "/marketplace", chainKey == null)]
    .concat(Object.keys(CHAIN_PAGES).map((k) =>
      tab(k, CHAIN_PAGES[k].chainName, `/${k}`, k === chainKey)));
  return `
  <div class="mfb" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:22px 0 6px;padding:12px;border:1px solid var(--hairline);background:var(--card);">
    <span class="mfb-label">Chain</span>
    <div class="mfb-tabs" style="display:flex;flex-wrap:wrap;gap:5px;">${tabs.join("")}</div>
    <span class="mfb-label" style="margin-left:6px;">Sort</span>
    <select class="mfb-sel" data-mfb-sort><option value="calls">most settled</option><option value="usd">volume</option><option value="buyers">buyers</option><option value="tools">tools</option><option value="health">health</option></select>
    <input class="mfb-search" data-mfb-search placeholder="search sellers">
  </div>
  <p class="mfb-legend" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:6px 0 0;line-height:1.5;"><strong style="color:var(--muted);">healthy</strong> = the last crawl of the origin succeeded, nothing more. <strong style="color:var(--muted);">dispatch</strong> = this host's router will pay the seller on a buyer's behalf right now; a seller can be listed, healthy and still not dispatch-eligible (no known payment network, or no settlement history on Base yet). The reason is on each row and on <code>/api/index</code> as <code>routerDispatchReason</code>.</p>
  <script src="/js/market-filter-bar.js"></script>`;
}

  // Dispatch badge, rendered ONLY when the handler labelled the seller
// (src/dispatch-eligibility.js via server.js withDispatchSnapshot); an
// unlabelled snapshot renders no badge rather than a guessed one.
function dispatchBadge(s) {
  if (s.local || s.routerDispatchEligible === undefined) return "";
  const reason = String(s.routerDispatchReason || "").replace(/_/g, " ");
  return s.routerDispatchEligible
    ? ` <span class="mlr-dispatch" title="the router will pay this seller on a buyer's behalf (${esc(reason)})" style="font-family:var(--font-mono);font-size:11px;color:var(--accent);">dispatch</span>`
    : ` <span class="mlr-dispatch off" title="not dispatch-eligible: ${esc(reason)}" style="font-family:var(--font-mono);font-size:11px;color:var(--faint);">no dispatch &middot; ${esc(reason)}</span>`;
}

function categoryGroups(tools, { maxCategories = 12, maxPerCategory = 6 } = {}) {
  const byCat = new Map();
  for (const t of tools) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category).push(t);
  }
  return [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxCategories)
    .map(([category, list]) => ({
      category,
      label: CATEGORIES[category]?.label || category,
      shown: list.slice(0, maxPerCategory),
      more: Math.max(0, list.length - maxPerCategory),
    }));
}

function agoLabel(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Rail-manifest "daily canary" status — derived from the same `rail` object
// the page already fetched (no new network calls). A settlement younger than
// 36h reads as proof of life; anything older or missing reads "unavailable"
// rather than a stale check mark.
function canaryManifestStatus(rail) {
  // lastInbound survives scan windows aging past a settle (see revenue-live's
  // carry-forward); recent[0] stays as the fallback for older snapshots.
  const latest = rail?.lastInbound || rail?.recent?.[0] || null;
  const ts = latest?.when ? Date.parse(latest.when) : NaN;
  if (!latest || !Number.isFinite(ts)) return { text: "unavailable", color: "var(--muted)" };
  const ageMs = Date.now() - ts;
  if (ageMs < 0 || ageMs >= 36 * 3600_000) return { text: "unavailable", color: "var(--muted)" };
  return { text: `✓ settled ${agoLabel(ageMs)}`, color: "var(--green)" };
}

// Activity section — x402scan-style Transactions / Volume / Buyers cards
// with per-day bars. Same honesty rules as the receipts: no data → say so
// plainly, capped scan → "a floor".
export function marketActivityHtml(chainKey, activity, selected) {
  const C = CHAIN_PAGES[chainKey];
  const external = !!(selected && !selected.local && selected.host);
  const scopeLabel = external ? esc(String(selected.host).toUpperCase()) : "THIS HOST";
  if (!activity || activity.error || !Array.isArray(activity.buckets) || !activity.buckets.length) {
    const why = external
      ? `activity unavailable for this seller - no ${C.chainName} payTo advertised in its 402s, or the scan failed`
      : "activity scan temporarily unavailable";
    return `
  <h2 id="activity" style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1px solid var(--hairline);padding-bottom:8px;">Activity</h2>
  <p style="color:var(--muted);font-size:13.5px;margin:0;">${why} - settlements remain independently verifiable on ${esc(C.explorerUrl)}</p>`;
  }
  const bars = (key) => {
    const max = Math.max(...activity.buckets.map((b) => Number(b[key]) || 0));
    return `<div style="display:flex;align-items:flex-end;gap:2px;height:46px;margin-top:12px;">${activity.buckets
      .map((b) => {
        const v = Number(b[key]) || 0;
        const h = max > 0 && v > 0 ? Math.max(3, Math.round((v / max) * 46)) : 2;
        const label = key === "usd" ? usd(v) : v;
        return `<div title="${esc(b.date)}: ${esc(label)}" style="flex:1;height:${h}px;background:${v > 0 ? "var(--accent)" : "var(--hairline)"};"></div>`;
      })
      .join("")}</div>`;
  };
  const card = (label, value, key) => `
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;">
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">${label}</div>
      <div style="font-size:26px;font-weight:800;">${value}</div>${bars(key)}
    </div>`;
  const t = activity.totals || {};
  const note = [
    external
      ? `all inbound ${C.asset} to this seller's advertised x402 payTo wallet - may include non-x402 transfers`
      : `all inbound ${C.asset} settlements to this host's ${C.chainName} wallet`,
    t.internalTx ? `includes ${t.internalTx} internal canary buy${t.internalTx === 1 ? "" : "s"}` : "",
    activity.truncated ? "scan capped - totals are a floor" : "",
  ].filter(Boolean).join(" · ");
  return `
  <div id="activity" style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:40px 0 14px;border-bottom:1px solid var(--hairline);padding-bottom:8px;">
    <h2 style="font-size:21px;font-weight:800;margin:0;">Activity</h2>
    <span style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">${scopeLabel} · PAST ${esc(activity.days)} DAYS</span>
  </div>
  <div class="ml-2col" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
    ${card("TRANSACTIONS", Number(t.tx || 0).toLocaleString("en-US"), "tx")}
    ${card("VOLUME", usd(t.usd || 0), "usd")}
    ${card("BUYERS", Number(t.buyers || 0).toLocaleString("en-US"), "buyers")}
  </div>
  <p style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin:8px 0 0;">${note}</p>`;
}

// Seller card — shown when an external seller is selected from the roster. The
// chain-level top cards (SELLERS / TOOLS / LATEST SETTLE / PRICE FLOOR) stay
// chain-wide; this card gives the SELECTED seller's own numbers.
//
// Headline SETTLED CALLS / VOLUME / BUYERS come from the leaderboard `stat`
// (the same rolling-window aggregate the roster's "· N tx" suffix uses) so the
// list and the card always agree — it also folds in ALL of a seller's grouped
// payTo wallets, not just the one advertised on this chain, so a router whose
// real volume lives on a second wallet isn't undercounted. When a seller has no
// leaderboard row (too small / off-chain-window), we fall back to the scoped
// on-chain scan's totals; that scan caps at 10k transfers, so a capped total is
// rendered as a floor ("N+"). The on-chain scan still powers the 30-day Activity
// charts below regardless — that's where its per-address precision belongs.
export function sellerCardHtml(chainKey, seller, sel, activity, stat, payTo, windowLabel) {
  const C = CHAIN_PAGES[chainKey];
  if (!sel || sel.local || !seller) return "";
  const t = (activity && activity.totals) || {};
  const fromLb = !!stat; // leaderboard row matched this seller's payTo
  const capped = !fromLb && !!activity?.truncated; // on-chain fallback hit the scan ceiling
  const plus = capped ? "+" : "";
  const calls = Number(fromLb ? stat.calls : t.tx ?? 0);
  const vol = Number(fromLb ? stat.usd : t.usd ?? 0);
  const buyers = Number(fromLb ? stat.buyers : t.buyers ?? 0);
  const winLabel = fromLb ? (windowLabel || "7d") : `${activity?.days || 30}d`;
  const toolN = seller.toolCount || 0;
  // Three states, not two. A registry-only record (the origin never answered
  // us) is neither "healthy" nor proven dead: we hold a third party's listing
  // and nothing from the seller. Calling that "healthy" is what put ~32% of the
  // index on this page wearing a green dot.
  // The seller-facing half of #645: when we did NOT read their spec path, say
  // so here rather than only in our own logs. A gap nobody can see is a gap
  // nobody fixes, and this one cost a seller 686 pointless requests.
  const note = discoveryNote(seller);
  const health = seller.routable
    ? "healthy"
    : (seller.originResponded === false ? "listed, unverified" : "unreachable");
  const firstSeen = (Array.isArray(activity?.buckets) ? activity.buckets.find((b) => Number(b.tx) > 0) : null)?.date || null;
  const host = String(sel.host || "");
  const name = sel.name || seller.displayName || host;
  const cell = (label, value) => `<div style="padding:12px 14px;">
      <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.08em;color:var(--dk-muted);">${label}</div>
      <div style="font-size:22px;font-weight:800;color:var(--on-dark2);margin-top:2px;font-variant-numeric:tabular-nums;">${value}</div></div>`;
  return `
  <div id="seller-card" style="background:var(--surface);--accent:var(--accent-lit);border:1px solid var(--hairline);margin:28px 0 0;">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid var(--dark-border2);">
      <div style="min-width:0;">
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);letter-spacing:.08em;">SELLER &middot; ${esc(C.chainName.toUpperCase())}</div>
        <a href="${safeHref(seller.homepage)}" rel="noopener" style="font-weight:800;font-size:18px;color:var(--on-dark2);text-decoration:none;overflow-wrap:anywhere;">${esc(name)}</a>
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--dk-muted);overflow-wrap:anywhere;">${esc(host)}</div>
      </div>
      <div style="display:flex;gap:12px;align-items:center;font-family:var(--font-mono);font-size:12px;white-space:nowrap;">
        <span style="color:${seller.routable ? "var(--accent-lit)" : "var(--dk-muted)"};">&#9679; ${health}</span>
        <a href="/${chainKey}" data-seller-link data-seller-host="" data-seller-local="1" style="color:var(--dk-muted);text-decoration:none;">clear &#10005;</a>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));border-bottom:1px solid var(--dark-border2);">
      ${cell("SETTLED CALLS", calls.toLocaleString("en-US") + plus)}
      ${cell("VOLUME", usd(vol) + plus)}
      ${cell("BUYERS", buyers.toLocaleString("en-US") + plus)}
      ${cell("TOOLS", toolN.toLocaleString("en-US"))}
    </div>
    ${note ? `<div style="padding:10px 16px;font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);line-height:1.7;border-bottom:1px solid var(--dark-border2);overflow-wrap:anywhere;">discovery &middot; ${esc(note)}</div>` : ""}
    <div style="padding:10px 16px;font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);line-height:1.7;overflow-wrap:anywhere;">rolling ${esc(winLabel)} totals${capped ? " (scan capped - a floor)" : ""} &middot; payTo ${payTo ? esc(payTo) : `not advertised on ${esc(C.chainName)}`}${firstSeen ? ` &middot; first settlement ${esc(firstSeen)}` : ""}${payTo ? ` &middot; <a href="${esc(C.explorerWalletUrl(payTo))}" rel="noopener" style="color:var(--accent-lit);text-decoration:none;">verify on ${esc(C.explorerUrl)} &rarr;</a>` : ""}</div>
    ${seller.bazaar && (seller.bazaar.calls30d > 0 || seller.bazaar.payers30d > 0) ? `<div style="padding:10px 16px;font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);line-height:1.7;border-top:1px solid var(--dark-border2);overflow-wrap:anywhere;">Coinbase Bazaar, last 30 days (their measurement, not ours) &middot; ${Number(seller.bazaar.calls30d || 0).toLocaleString("en-US")} calls &middot; ${Number(seller.bazaar.payers30d || 0).toLocaleString("en-US")} distinct payers${seller.bazaar.lastCalledAt ? ` &middot; last call ${esc(String(seller.bazaar.lastCalledAt).slice(0, 10))}` : ""}</div>` : ""}
  </div>`;
}

// The swappable panel = seller card (if a seller is picked) + Activity charts.
// Rendered both server-side inside the page and by the /api/market/:chain/panel
// endpoint the client fetches for in-place seller switching, so both stay
// identical. Self-contained: resolves the picked seller + its leaderboard stat.
export function marketPanelHtml(chainKey, { snapshot, activity, selectedSeller, leaderboardSnap } = {}) {
  const C = CHAIN_PAGES[chainKey];
  const sellers = marketSellers(chainKey, snapshot);
  const hostL = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
  const picked = selectedSeller && !selectedSeller.local
    ? sellers.find((s) => !s.local && hostL(s.homepage || s.origin) === String(selectedSeller.host || "").toLowerCase()) || null
    : null;
  const payTo = picked ? (Object.entries(picked.payToByNetwork || {}).find(([net]) => C.isNetwork(net))?.[1] || null) : null;
  let stat = null;
  if (payTo) {
    const rows = Array.isArray(leaderboardSnap?.leaderboard) ? leaderboardSnap.leaderboard : [];
    const hit = rows.find((r) => (r.wallets && r.wallets.length ? r.wallets : [r.wallet]).some((w) => String(w).toLowerCase() === String(payTo).toLowerCase()));
    if (hit) stat = { calls: hit.callsSettled || 0, usd: hit.totalUsd || 0, buyers: hit.uniqueBuyers || 0 };
  }
  return sellerCardHtml(chainKey, picked, selectedSeller, activity, stat, payTo, leaderboardSnap?.windowLabel) + marketActivityHtml(chainKey, activity, selectedSeller);
}

export function marketPage(chainKey, baseUrl, opts = {}) {
  if (chainKey == null) return marketPageAll(baseUrl, opts);
  const { snapshot, rail, activity, selectedSeller, wallet, leaderboardSnap, all = false, host = null } = opts;
  const C = CHAIN_PAGES[chainKey];
  const effectiveWallet = wallet || C.wallet;
  // Stellar/Algorand ship a committed public default wallet in CHAIN_PAGES;
  // the EVM + Solana rails don't (WALLET_ADDRESS/SOLANA_WALLET_ADDRESS are
  // Railway-only secrets, never hardcoded here) - falling back to the bare
  // explorer domain keeps the link honest instead of pointing at
  // "/address/undefined" when no wallet was passed at the route level.
  const walletExplorerUrl = effectiveWallet ? C.explorerWalletUrl(effectiveWallet) : `https://${C.explorerUrl}`;
  const sellers = marketSellers(chainKey, snapshot);
  const tools = marketTools(chainKey, snapshot);

  // Per-seller settlement stats for the roster (#tx column) and the seller card,
  // joined from the leaderboard snapshot by the seller's payTo on THIS chain.
  // The leaderboard scans Base USDC, so counts only populate for Base sellers;
  // other chains fall back to the scoped activity scan (which the seller card
  // uses directly). Match against every wallet the leaderboard grouped together.
  const statByWallet = new Map();
  (Array.isArray(leaderboardSnap?.leaderboard) ? leaderboardSnap.leaderboard : []).forEach((r, i) => {
    // `gid` = the leaderboard ROW this wallet belongs to. Two roster hosts are
    // the same economic seller iff their payTos resolve to the same gid — this
    // catches both a shared payTo address AND distinct wallets the leaderboard
    // grouped under one operator (payment = identity).
    const stat = { calls: r.callsSettled || 0, usd: r.totalUsd || 0, buyers: r.uniqueBuyers || 0, gid: `lb${i}` };
    for (const w of (r.wallets && r.wallets.length ? r.wallets : [r.wallet])) if (w) statByWallet.set(String(w).toLowerCase(), stat);
  });
  const sellerPayTo = (s) => (s && !s.local ? (Object.entries(s.payToByNetwork || {}).find(([net]) => C.isNetwork(net))?.[1] || null) : null);
  // THIS HOST joins by the page's own wallet (the leaderboard's default view
  // includes our row) — we present ourselves with the same on-chain numbers as
  // every other seller, not a blank cell.
  const sellerStat = (s) => { const p = s?.local ? effectiveWallet : sellerPayTo(s); return p ? statByWallet.get(String(p).toLowerCase()) || null : null; };
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };

  // Surface the sellers worth clicking: most on-chain settled calls, then
  // healthy, then tool-rich. THIS HOST is NOT pinned — the neutral-index claim
  // means we rank by the same numbers as everyone else (the badge marks us).
  sellers.sort((a, b) => {
    const ca = sellerStat(a)?.calls || 0, cb = sellerStat(b)?.calls || 0;
    if (ca !== cb) return cb - ca;
    if (!!a.routable !== !!b.routable) return a.routable ? -1 : 1;
    return (b.toolCount || 0) - (a.toolCount || 0);
  });
  // Roster "· N tx" suffix — only when the leaderboard has settlements for this
  // seller's payTo on this chain (Base today); silent otherwise.
  const txSuffix = (s) => { const st = sellerStat(s); return st && st.calls > 0 ? ` &middot; ${Number(st.calls).toLocaleString("en-US")} tx` : ""; };
  // "42 tools · 21 paid" when the seller's document distinguishes paid from
  // free: total surface stays honest (x402scan parity) without letting a
  // padded free surface read as paid depth. Absent when the split is unknown.
  const paidSuffix = (s) => (s.paidToolCount != null && s.paidToolCount !== s.toolCount ? ` &middot; ${s.paidToolCount} paid` : "");
  // Numeric data-* payload each roster row carries for the filter bar's
  // client-side Sort/search (see the script marketFilterBar emits). Same
  // attributes on the all-chains <tr> rows in marketPageAll.
  const rowData = (s) => {
    const st = sellerStat(s);
    return ` data-mfb-row data-local="${s.local ? 1 : 0}" data-health="${s.local || s.routable ? 1 : 0}" data-calls="${st?.calls || 0}" data-usd="${st?.usd || 0}" data-buyers="${st?.buyers || 0}" data-tools="${Number(s.toolCount) || 0}"`;
  };

  // Collapse hosts that settle to the SAME leaderboard group into one roster
  // row, so a group's tx total isn't repeated per host (it reads as 2–3× the
  // real volume otherwise). One row per settling seller; the canonical host is
  // the one on a real domain (not a throwaway platform subdomain), then the
  // richest catalog. Sellers with no leaderboard row aren't grouped — there's no
  // shared-wallet evidence — so the discovery long-tail stays fully listed.
  const PLATFORM_HOST = /\.(up\.railway\.app|run\.app|onrender\.com|fly\.dev|herokuapp\.com|vercel\.app|ondigitalocean\.app|workers\.dev)$/i;
  const prefRank = (s) => (PLATFORM_HOST.test(hostOf(s.homepage)) ? 1 : 0);
  const better = (a, b) => {
    if (prefRank(a) !== prefRank(b)) return prefRank(a) < prefRank(b) ? a : b;
    if ((a.toolCount || 0) !== (b.toolCount || 0)) return (a.toolCount || 0) > (b.toolCount || 0) ? a : b;
    return hostOf(a.homepage).length <= hostOf(b.homepage).length ? a : b;
  };
  const extraByGid = new Map(); // gid -> count of collapsed sibling endpoints
  const primaryByGid = new Map(); // gid -> the seller currently rendered for the group
  const rosterSellers = [];
  for (const s of sellers) {
    const gid = s.local ? null : sellerStat(s)?.gid;
    if (!gid) { rosterSellers.push(s); continue; }
    const cur = primaryByGid.get(gid);
    if (!cur) { primaryByGid.set(gid, s); extraByGid.set(gid, 0); rosterSellers.push(s); continue; }
    extraByGid.set(gid, extraByGid.get(gid) + 1);
    const winner = better(cur, s);
    if (winner !== cur) { rosterSellers[rosterSellers.indexOf(cur)] = winner; primaryByGid.set(gid, winner); }
  }
  // Pin THIS HOST to the top of the chain roster (same transparency rule as the
  // all-view): the operator's own listing is always the first, clearly-badged
  // row; every independent seller stays ranked by its own on-chain volume below.
  const localIdx = rosterSellers.findIndex((s) => s.local);
  if (localIdx > 0) { const [loc] = rosterSellers.splice(localIdx, 1); rosterSellers.unshift(loc); }
  // Cap the RENDERED roster the same way marketPageAll's all-chains view
  // already does (?all=1 opts out) - a busy chain's full roster (Base:
  // 1,125+ sellers) rendered unconditionally was a 700KB+ page, 56,000px of
  // desktop scroll, and 7,500+ DOM nodes to reach "Sell on X" below it. The
  // FULL rosterSellers/rosterSellers.length stays untouched everywhere else
  // (SELLERS LISTED stat, the single-seller honesty line, structured-data
  // counts) - only what actually renders as rows is capped here.
  const localSellerPinned = rosterSellers[0]?.local ? rosterSellers[0] : null;
  const rankedForCap = localSellerPinned ? rosterSellers.slice(1) : rosterSellers;
  const rosterTruncated = !all && rankedForCap.length > ALL_ROW_CAP;
  const visibleRoster = rosterTruncated
    ? (localSellerPinned ? [localSellerPinned, ...rankedForCap.slice(0, ALL_ROW_CAP)] : rankedForCap.slice(0, ALL_ROW_CAP))
    : rosterSellers;
  const rosterCapNote = rosterTruncated
    ? `<p class="chips-note" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:10px 0 0;">showing the top ${ALL_ROW_CAP} of ${rankedForCap.length} sellers &middot; <a href="/${chainKey}?all=1" style="color:var(--muted);">show all &rarr;</a></p>`
    : "";
  // "+N more endpoints" on the surviving row so the collapsed hosts are disclosed, not hidden.
  const endpointsNote = (s) => { const gid = s.local ? null : sellerStat(s)?.gid; const n = gid ? extraByGid.get(gid) || 0 : 0; return n > 0 ? ` &middot; +${n} more endpoint${n === 1 ? "" : "s"}` : ""; };
  const prices = tools.map((t) => Number(t.price)).filter((n) => Number.isFinite(n) && n > 0);
  const low = prices.length ? Math.min(...prices) : 0.001;
  const high = prices.length ? Math.max(...prices) : 0.5;
  const groups = categoryGroups(tools);
  const latest = rail?.recent?.[0] || null;

  const receiptHtml = latest
    ? `<p style="margin:8px 0 0;">Latest settlement: <strong>${usd(latest.usd)} ${esc(C.asset)}</strong> · <a href="${esc(latest.tx)}" rel="noopener">on-chain receipt</a>${latest.when ? ` · ${esc(latest.when)}` : ""}</p>`
    : `<p style="margin:8px 0 0;color:var(--muted);">live receipts temporarily unavailable - settlements remain verifiable at <a href="${esc(walletExplorerUrl)}" rel="noopener">${esc(C.explorerUrl)}</a></p>`;

  const groupsHtml = groups.map((g) => `
    <div style="border:1px solid var(--hairline);padding:14px 16px;">
      <h3 style="margin:0 0 8px;font-size:14px;">${esc(g.label)}</h3>
      ${g.shown.map((t) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:13.5px;padding:3px 0;"><a href="/tools/${esc(t.slug)}" style="color:var(--ink);text-decoration:none;">${esc(t.name)}</a><span style="color:var(--muted);font-family:var(--font-mono);">${usd(t.price)}</span></div>`).join("")}
      ${g.more ? `<div style="font-size:12px;color:var(--faint);margin-top:6px;">+ ${g.more} more in <a href="/tools" style="color:var(--muted);">the full catalog</a></div>` : ""}
    </div>`).join("");

  // Which seller's activity is on screen: default is this host; an external
  // pick highlights that seller and re-scopes the Activity section.
  const selHost = selectedSeller && !selectedSeller.local ? String(selectedSeller.host || "").toLowerCase() : null;
  const isSelected = (s) => (selHost ? !s.local && hostOf(s.homepage).toLowerCase() === selHost : !!s.local);
  const activityHref = (s) => (s.local ? `/${chainKey}#activity` : `/${chainKey}?seller=${encodeURIComponent(hostOf(s.homepage).toLowerCase())}#activity`);
  // Cards read well up to a dozen sellers; past that, compact rows keep the
  // roster scannable at any size.
  const compact = visibleRoster.length > 12;
  const sellersHtml = compact
    ? visibleRoster.map((s) => {
        const good = s.local || s.routable;
        return `
    <a href="${activityHref(s)}"${rowData(s)} data-seller-link data-seller-host="${s.local ? "" : esc(hostOf(s.homepage).toLowerCase())}" data-seller-local="${s.local ? "1" : "0"}" class="ml-roster-compact mlr-row${isSelected(s) ? " sel" : ""}">
      <span class="mlr-name">${esc(s.displayName)}${s.local ? ' <span class="mlr-badge">THIS HOST</span>' : ""}${s.mpp === true ? ' <span class="mlr-mpp" title="Also reachable over the native MPP wire">MPP</span>' : ""}</span>
      <span class="mlr-host">${esc(hostOf(s.homepage))}</span>
      <span class="mlr-tools">${Number(s.toolCount) || 0} tool${s.toolCount === 1 ? "" : "s"}${paidSuffix(s)}${txSuffix(s)}${endpointsNote(s)}</span>
      <span class="mlr-stat${good ? "" : " bad"}"><span class="mlr-dot"></span>${s.local ? "live" : (s.routable ? "healthy" : "unreachable")}</span>${dispatchBadge(s)}
    </a>`;
      }).join("")
    : visibleRoster.map((s) => {
        const health = s.local ? "live" : (s.routable ? "healthy" : "unreachable");
        const good = s.local || s.routable;
        return `
    <div${rowData(s)} style="border:${isSelected(s) ? "2px solid var(--accent)" : "1px solid var(--hairline)"};background:var(--card);padding:16px 18px;display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;">
        <a href="${safeHref(s.homepage)}" rel="noopener" style="color:var(--ink);text-decoration:none;font-weight:700;font-size:15px;">${esc(s.displayName)}</a>
        ${s.local ? '<span class="mlr-badge">THIS HOST</span>' : ""}${s.mpp === true ? '<span class="mlr-mpp" title="Also reachable over the native MPP wire">MPP</span>' : ""}
      </div>
      <div class="mlr-host">${esc(hostOf(s.homepage))}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
        <span style="color:var(--muted);font-family:var(--font-mono);font-size:13px;">${Number(s.toolCount) || 0} tool${s.toolCount === 1 ? "" : "s"}${paidSuffix(s)}${txSuffix(s)}${endpointsNote(s)}</span>
        <span class="mlr-stat${good ? "" : " bad"}"><span class="mlr-dot"></span>${health}</span>${dispatchBadge(s)}
      </div>
      <a href="${activityHref(s)}" data-seller-link data-seller-host="${s.local ? "" : esc(hostOf(s.homepage).toLowerCase())}" data-seller-local="${s.local ? "1" : "0"}" style="font-family:var(--font-mono);font-size:12px;color:var(--accent);text-decoration:none;margin-top:2px;">${isSelected(s) ? "activity shown above" : "view activity →"}</a>
    </div>`;
      }).join("");

  const statsHtml = `
  <div class="ml-2col" style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:26px 0 0;">
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">SELLERS LISTED</div><div style="font-size:26px;font-weight:800;">${rosterSellers.length.toLocaleString("en-US")}</div><div style="font-family:var(--font-mono);font-size:10.5px;color:var(--faint);margin-top:2px;">distinct payees &middot; ${sellers.length.toLocaleString("en-US")} endpoints indexed</div></div>
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">TOOLS (THIS HOST)</div><div style="font-size:26px;font-weight:800;">${tools.length.toLocaleString("en-US")}</div></div>
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">LATEST SETTLE</div><div style="font-size:26px;font-weight:800;">${latest ? usd(latest.usd) : "-"}</div></div>
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">PRICE FLOOR</div><div style="font-size:26px;font-weight:800;">${usd(low)}</div></div>
  </div>`;

  const honesty = rosterSellers.length === 1 && rosterSellers[0]?.local
    ? `<p style="color:var(--muted);font-size:13.5px;">1 seller live - discovery is open, and external sellers are added automatically when their x402 challenges advertise ${C.honestyNetworkPhrase}.</p>`
    : "";

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `The ${C.chainName} x402 marketplace`,
      url: `${baseUrl}/${chainKey}`,
      description: `Pay-per-call tools for AI agents, settled in ${C.asset} on ${C.chainName} via the x402 protocol. ${tools.length} tools live.`,
      mainEntity: {
        "@type": "OfferCatalog",
        name: `${C.chainName}-payable agent tools`,
        numberOfItems: tools.length,
        itemListElement: { "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: String(low), highPrice: String(high), offerCount: tools.length },
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Agent402.Tools", item: baseUrl },
        { "@type": "ListItem", position: 2, name: "Marketplace", item: `${baseUrl}/marketplace` },
        { "@type": "ListItem", position: 3, name: C.chainName, item: `${baseUrl}/${chainKey}` },
      ],
    },
  ];

  const formHtml = `
  <div id="list-api" style="border:1px solid var(--hairline);background:var(--card);padding:18px 20px;margin-top:16px;">
    <div style="font-weight:800;font-size:15px;margin-bottom:8px;">List your API</div>
    <label for="reg-origin" style="display:block;font-family:var(--font-mono);font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;">Your API's origin</label>
    <div style="display:flex;gap:10px;">
      <input id="reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:1;font-family:var(--font-mono);font-size:13px;padding:9px 12px;border:1px solid var(--hairline);background:var(--paper);color:var(--ink);">
      <button id="reg-go" style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:13px;border:none;padding:9px 16px;cursor:pointer;">SUBMIT</button>
    </div>
    <div id="reg-out" role="status" aria-live="polite" data-listed-note="${esc(C.chainName)} sellers appear on this page; all sellers appear on /index." style="font-family:var(--font-mono);font-size:12.5px;color:var(--muted);margin-top:8px;">Free, no account - we probe your origin's x402 surface and list you if it answers. Ranking is health-based.</div>
  </div>
  <script src="/js/reg-form.js"></script>`;

  const canary = canaryManifestStatus(rail);
  const manifestRow = (label, value) => `<div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);flex:none;">${label}</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span><span style="font-weight:700;min-width:0;overflow-wrap:anywhere;text-align:right;">${value}</span></div>`;
  const railManifestHtml = `
    <div style="border:1px solid var(--hairline);background:var(--card);padding:18px 20px;">
      <div style="display:flex;flex-direction:column;gap:4px;font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--muted);border-bottom:1px dashed var(--dash);padding-bottom:10px;margin-bottom:12px;"><span>·· RAIL MANIFEST ··</span><span>${esc(C.tickerLabel)}</span></div>
      <div style="display:flex;flex-direction:column;gap:9px;font-family:var(--font-mono);font-size:13px;">
        ${manifestRow("network", esc(C.caip2))}
        ${manifestRow("wires", C.mpp ? "x402 + MPP" : "x402")}
        ${manifestRow("asset", esc(C.asset))}
        ${manifestRow("settle latency", esc(C.settleLatency))}
        ${manifestRow("facilitator", esc(C.facilitatorLabel))}
        ${manifestRow("gas", esc(C.gasNote))}
        <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">explorer</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span><a href="${esc(walletExplorerUrl)}" rel="noopener" style="font-weight:700;color:var(--accent);text-decoration:none;">${esc(C.explorerUrl)} →</a></div>
        <div style="display:flex;align-items:baseline;gap:8px;"><span style="color:var(--muted);">daily canary</span><span style="flex:1;border-bottom:1.5px dotted var(--dash);transform:translateY(-4px);"></span><span style="font-weight:700;color:${canary.color};">${esc(canary.text)}</span></div>
      </div>
      <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--dash);font-family:var(--font-mono);font-size:11px;color:var(--faint);line-height:1.6;">agents: GET /api/route?q=&lt;task&gt;&amp;network=${esc(C.networkParam)}</div>
    </div>`;

  // Switcher strip — one row per chain page that actually exists today
  // (base/solana are index-snapshot rails, not routes). Replaces the old
  // The chain-switcher strip is GONE everywhere (owner call, 2026-07-28,
  // audit follow-up): the filter bar's CHAIN chips do its exact navigation
  // plus filtering, the ticker already names every rail, and its only unique
  // cargo - the EVERY TOOL INDEXED link - rides the nav dropdown and footer
  // on every page. Three stacked chain lists read as clutter.

  const subheadHtml = `Pay-per-call tools for AI agents - settled in ${esc(C.asset)} on ${esc(C.chainName)} in ${esc(C.settleLatency)}, no signup, no API keys. The wallet is the account.`;

  const headerHtml = `
  <div class="ml-2col" style="display:grid;grid-template-columns:1.15fr .85fr;gap:34px;align-items:start;">
    <div>
      <div class="ml-chain-h1-wrap" style="display:flex;align-items:flex-start;gap:14px;margin-bottom:12px;">
        <span style="width:44px;height:44px;flex:none;border:1px solid var(--hairline);color:var(--ink);display:flex;align-items:center;justify-content:center;" title="${esc(C.chainName)}">${chainMark(chainKey, 26) || `<span style="font-family:var(--font-mono);font-weight:700;font-size:12px;">${esc(C.ticker)}</span>`}</span>
        <h1 style="font-size:34px;font-weight:800;letter-spacing:-.02em;line-height:1.15;margin:0;">The ${esc(C.chainName)} x402 marketplace</h1>
      </div>
      <p style="font-size:16.5px;color:var(--muted);margin:0;max-width:640px;">${subheadHtml}</p>
      <div style="margin:16px 0 0;padding:16px 18px;border:1px solid var(--hairline);background:var(--card);">
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--faint);margin-bottom:10px;">START HERE · BUYER PATH</div>
        <form action="/tools" method="get" class="mkt-search-wrap" style="display:flex;gap:0;background:var(--paper);max-width:520px;margin-bottom:12px;">
          <input name="q" type="search" placeholder="what do you need? e.g. pdf ocr, web search" style="flex:1;border:none;background:transparent;font-family:var(--font-mono);font-size:13px;color:var(--ink);padding:11px 14px;outline:none;" />
          <button type="submit" style="border:none;border-left:1px solid var(--hairline);background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:12px;padding:0 16px;cursor:pointer;">FIND →</button>
        </form>
        <div style="display:flex;flex-wrap:wrap;gap:14px;font-family:var(--font-mono);font-size:12.5px;">
          <a href="/guides/smart-order-router" style="color:var(--accent);text-decoration:none;font-weight:700;">auto-route a task →</a>
          <a href="/playground" style="color:var(--muted);text-decoration:none;">try playground</a>
          <a href="#sellers" style="color:var(--muted);text-decoration:none;">browse sellers</a>
        </div>
      </div>
      <p style="font-size:13px;color:var(--faint);margin:10px 0 0;">An open index of the whole ${esc(C.chainName)} x402 economy - this host plus every independent seller the hourly crawl finds (CDP Bazaar included). Not a walled market: other venues' listings appear here too.</p>
      ${receiptHtml}
      <p style="font-size:13px;line-height:1.45;color:var(--faint);margin:4px 0 0;min-height:56px;">${C.canaryLine}</p>
    </div>
    ${railManifestHtml}
  </div>
  ${hostCardHtml(host)}
  ${marketFilterBar(chainKey, baseUrl)}
  ${statsHtml}`;

  const rosterHtml = `
  <h2 id="sellers" style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1px solid var(--hairline);padding-bottom:8px;">Sellers settling on ${esc(C.chainName)}</h2>
  <p style="font-size:13px;color:var(--faint);margin:-6px 0 12px;">pick a seller to scope the activity charts · THIS HOST = run by agent402 · every other seller is independent, found by the open crawl · tx = settled calls, last 7 days on-chain</p>
  ${compact
    ? `<div style="display:flex;flex-direction:column;gap:8px;">${sellersHtml}</div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;">${sellersHtml}</div>`}
  ${rosterCapNote}
  ${honesty}`;

  const sellSectionHtml = `
  <h2 style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1px solid var(--hairline);padding-bottom:8px;">Sell on ${esc(C.chainName)}</h2>
  <div class="ml-2col" style="display:grid;grid-template-columns:1.1fr .9fr;gap:18px;align-items:start;">
    <div>
      <p style="font-size:14.5px;line-height:1.65;">${C.sellParagraphHtml}</p>
      ${formHtml}
    </div>
    <div style="background:var(--surface);border:1px solid var(--hairline);">
      <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 10px;padding:10px 15px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);letter-spacing:.06em;"><span>402 challenge · accepts[]</span><span>JSON</span></div>
      <pre style="margin:0;padding:16px 18px;font-family:var(--font-mono);font-size:12px;line-height:1.8;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;">{
  <span style="color:var(--dk-muted3);">"scheme"</span>: "exact",
  <span style="color:var(--dk-muted3);">"network"</span>: <span style="color:var(--accent);">"${esc(C.acceptNetwork)}"</span>,
  <span style="color:var(--dk-muted3);">"asset"</span>: "${esc(C.asset)}",
  <span style="color:var(--dk-muted3);">"payTo"</span>: "your-wallet"
}</pre>
    </div>
  </div>`;

  const body = `
<div style="max-width:1080px;margin:0 auto;padding:36px 24px;">
  <section>${headerHtml}</section>
  <section>
    <div id="market-panel" data-chain="${esc(chainKey)}">${marketPanelHtml(chainKey, { snapshot, activity, selectedSeller, leaderboardSnap })}</div>

    ${rosterHtml}
  </section>

  <section>
    <h2 style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1px solid var(--hairline);padding-bottom:8px;">Browse ${esc(C.chainName)}-payable tools</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;">${groupsHtml}</div>
    <p style="font-family:var(--font-mono);font-size:13px;background:var(--card-zebra);padding:10px 14px;margin:16px 0 0;">agents: GET ${esc(baseUrl)}/api/route?q=&lt;task&gt;&amp;network=${esc(C.networkParam)}</p>
  </section>

  <section>${sellSectionHtml}</section>

  <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:28px;">machine-readable: <a href="/api/route?q=hash&amp;network=${esc(C.networkParam)}">/api/route?network=${esc(C.networkParam)}</a> · <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/api/reliability">/api/reliability</a></p>
</div>
<script src="/js/market-seller-switch.js"></script>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: `The ${C.chainName} x402 marketplace - pay-per-call tools for AI agents`,
    description: `The ${C.chainName} x402 marketplace: ${tools.length} pay-per-call tools for AI agents, settled in ${C.asset} on ${C.chainName}.${C.mpp ? " x402 and MPP (Machine Payments Protocol) both accepted." : ""} No signup, no API keys - the wallet is the account.`,
    canonical: `${baseUrl}/${chainKey}`,
    baseUrl,
    activePath: `/${chainKey}`,
    jsonLd,
    extraCss: ROSTER_CSS,
    body,
  });
}

// All-chains directory: "The x402 marketplace" (chainKey === null). Chain is
// a filter, not a separate template - this is the unfiltered view over every
// seller on every rail, so it carries NO chain-specific extras (no receipt
// strip, no per-seller activity switching, no sell-on-<chain> copy). It
// reuses the per-chain roster's leaderboard-join + shared-wallet dedup
// LOGIC (see marketPage above) so a seller settling under one group isn't
// double-counted here either, but the algorithm is duplicated rather than
// extracted into a shared helper — the per-chain version is scoped to one
// network's payTo (via C.isNetwork / C.acceptNetwork) while this view has to
// match a seller's payTo on ANY network, and factoring that difference out
// cleanly was more than this task's surface area. Flagged in the task report.
// Compact economy strip — the one useful bit carried over from the old /index
// page. The container carries id="economy": three live surfaces link to
// /marketplace#economy (the footer Economy link and the /economy +
// /x402-economy 301s), so the anchor must exist whenever a snapshot renders.
// Binds defensively to x402EconomySnapshot()'s real shape (totals.last7d
// {settlements, payers, merchants, volumeUsd} + totals.last30d.settlements):
// a missing/non-numeric field drops its cell; a snapshot whose queries all
// errored (totals empty) keeps the anchor with an honest "unavailable" line —
// never NaN/undefined text, never fabricated zeros. No snapshot → no strip.
function economyStripHtml(economySnap) {
  if (!economySnap) return "";
  const t7 = economySnap.totals?.last7d || {};
  const t30 = economySnap.totals?.last30d || {};
  const num = (v) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const fmt = (n) => n.toLocaleString("en-US");
  const cell = (label, value) => `
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">${label}</div><div style="font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;">${value}</div></div>`;
  const cells = [];
  const s7 = num(t7.settlements);
  if (s7 != null) cells.push(cell("SETTLEMENTS · 7D", fmt(s7)));
  const v7 = num(t7.volumeUsd);
  if (v7 != null) cells.push(cell("VOLUME · 7D", `$${v7.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`));
  const p7 = num(t7.payers);
  if (p7 != null) cells.push(cell("PAYERS · 7D", fmt(p7)));
  const m7 = num(t7.merchants);
  // "Wallets", not "sellers": this counts EVERY receiving wallet observed
  // on-chain in the window — most never list in any index — so it must not
  // read as the same population as the directory's "SELLERS LISTED" card.
  if (m7 != null) cells.push(cell("WALLETS SETTLING · 7D", fmt(m7)));
  const s30 = num(t30.settlements);
  if (s30 != null) cells.push(cell("SETTLEMENTS · 30D", fmt(s30)));
  const inner = cells.length
    ? `<div class="ml-2col" style="display:grid;grid-template-columns:repeat(${Math.min(cells.length, 5)},1fr);gap:14px;">${cells.join("")}</div>
  <p style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin:8px 0 0;">every gasless EIP-3009 USDC settlement on Base - the primitive x402 uses - counted chain-wide across every seller, not just this host · machine-readable at <a href="/api/x402-economy" style="color:var(--muted);">/api/x402-economy</a></p>`
    : `<p style="color:var(--muted);font-size:13.5px;margin:0;">chain-wide settlement stats unavailable right now - detail in <a href="/api/x402-economy">/api/x402-economy</a></p>`;
  return `
  <div id="economy" style="margin:40px 0 0;">
    <h2 style="font-size:21px;font-weight:800;margin:0 0 14px;border-bottom:1px solid var(--hairline);padding-bottom:8px;">The economy</h2>
    ${inner}
  </div>`;
}

// Default render caps the roster at the top ALL_ROW_CAP rows (the roster is
// sorted local-first then by settled calls, so the cap keeps the sellers worth
// reading); ?all=1 opts back into the full 700+-row table. Same speed
// rationale + honest-disclosure pattern as x402-index.js's INDEX_ROW_CAP.
const ALL_ROW_CAP = 100;

function marketPageAll(baseUrl, { snapshot, leaderboardSnap, economySnap, all = false, wallet, host = null } = {}) {
  const sellers = marketSellersAll(snapshot);
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };

  // Leaderboard join, same shape as marketPage's statByWallet: gid = the
  // leaderboard row a wallet belongs to (payment = identity for grouping).
  const statByWallet = new Map();
  (Array.isArray(leaderboardSnap?.leaderboard) ? leaderboardSnap.leaderboard : []).forEach((r, i) => {
    const stat = { calls: r.callsSettled || 0, usd: r.totalUsd || 0, buyers: r.uniqueBuyers || 0, gid: `lb${i}` };
    for (const w of (r.wallets && r.wallets.length ? r.wallets : [r.wallet])) if (w) statByWallet.set(String(w).toLowerCase(), stat);
  });
  // Unlike the per-chain view (one network via C.isNetwork), an all-chains
  // seller may have a payTo on any of several networks - check them all.
  // THIS HOST joins by the route-supplied wallet (the leaderboard's default
  // view includes our own row) — we present ourselves with the same on-chain
  // numbers as every other seller, not a blank cell.
  const sellerStat = (s) => {
    if (!s) return null;
    if (s.local) return wallet ? statByWallet.get(String(wallet).toLowerCase()) || null : null;
    for (const addr of Object.values(s.payToByNetwork || {})) {
      const st = addr ? statByWallet.get(String(addr).toLowerCase()) : null;
      if (st) return st;
    }
    return null;
  };
  const txSuffix = (s) => { const st = sellerStat(s); return st && st.calls > 0 ? ` &middot; ${Number(st.calls).toLocaleString("en-US")} tx` : ""; };
  // "42 tools · 21 paid" when the seller's document distinguishes paid from
  // free: total surface stays honest (x402scan parity) without letting a
  // padded free surface read as paid depth. Absent when the split is unknown.
  const paidSuffix = (s) => (s.paidToolCount != null && s.paidToolCount !== s.toolCount ? ` &middot; ${s.paidToolCount} paid` : "");

  // Most settled calls, then healthy, then tool-rich - same ordering rationale
  // as the per-chain roster. THIS HOST is NOT pinned: the neutral-index claim
  // means we rank by the same on-chain numbers as everyone else.
  sellers.sort((a, b) => {
    const ca = sellerStat(a)?.calls || 0, cb = sellerStat(b)?.calls || 0;
    if (ca !== cb) return cb - ca;
    if (!!a.routable !== !!b.routable) return a.routable ? -1 : 1;
    return (b.toolCount || 0) - (a.toolCount || 0);
  });

  // Collapse hosts settling to the SAME leaderboard group into one row (see
  // marketPage's identical rationale) so a group's tx total isn't repeated.
  const PLATFORM_HOST = /\.(up\.railway\.app|run\.app|onrender\.com|fly\.dev|herokuapp\.com|vercel\.app|ondigitalocean\.app|workers\.dev)$/i;
  const prefRank = (s) => (PLATFORM_HOST.test(hostOf(s.homepage)) ? 1 : 0);
  const better = (a, b) => {
    if (prefRank(a) !== prefRank(b)) return prefRank(a) < prefRank(b) ? a : b;
    if ((a.toolCount || 0) !== (b.toolCount || 0)) return (a.toolCount || 0) > (b.toolCount || 0) ? a : b;
    return hostOf(a.homepage).length <= hostOf(b.homepage).length ? a : b;
  };
  const extraByGid = new Map();
  const primaryByGid = new Map();
  const rosterSellers = [];
  for (const s of sellers) {
    const gid = s.local ? null : sellerStat(s)?.gid;
    if (!gid) { rosterSellers.push(s); continue; }
    const cur = primaryByGid.get(gid);
    if (!cur) { primaryByGid.set(gid, s); extraByGid.set(gid, 0); rosterSellers.push(s); continue; }
    extraByGid.set(gid, extraByGid.get(gid) + 1);
    const winner = better(cur, s);
    if (winner !== cur) { rosterSellers[rosterSellers.indexOf(cur)] = winner; primaryByGid.set(gid, winner); }
  }
  const endpointsNote = (s) => { const gid = s.local ? null : sellerStat(s)?.gid; const n = gid ? extraByGid.get(gid) || 0 : 0; return n > 0 ? ` &middot; +${n} more endpoint${n === 1 ? "" : "s"}` : ""; };

  // Chain column - a seller may advertise more than one network; show the
  // first resolvable chain name + "+N" for the rest, deduped.
  const chainNamesFor = (s) => {
    const names = [];
    for (const n of s.networks || []) {
      const key = chainKeyForNetwork(n);
      if (key) names.push(CHAIN_PAGES[key].chainName);
    }
    return [...new Set(names)];
  };
  const chainCell = (s) => {
    const names = chainNamesFor(s);
    if (!names.length) return `<span style="color:var(--faint);">-</span>`;
    return `${esc(names[0])}${names.length > 1 ? ` <span style="color:var(--faint);">+${names.length - 1}</span>` : ""}`;
  };

  // Numeric data-* payload for the filter bar's client-side Sort/search —
  // same attributes as the per-chain roster rows (see rowData in marketPage).
  const rowData = (s) => {
    const st = sellerStat(s);
    return ` data-mfb-row data-local="${s.local ? 1 : 0}" data-health="${s.local || s.routable ? 1 : 0}" data-calls="${st?.calls || 0}" data-usd="${st?.usd || 0}" data-buyers="${st?.buyers || 0}" data-tools="${Number(s.toolCount) || 0}"`;
  };

  // THIS HOST is PINNED at the top of the roster (transparency: the operator of
  // the index is clearly marked and always visible, not buried at its
  // settled-volume rank), then every independent seller ranked by volume below.
  // This is NOT a ranking claim — the pinned row carries the THIS HOST badge, a
  // tinted background, and the note under the heading explains it; external
  // sellers are still ranked purely by their own on-chain numbers. Row cap
  // applies to the RANKED sellers only (?all=1 opts out). Totals stay on the
  // full roster — the cap truncates the table, never the honest count.
  const localSeller = rosterSellers.find((s) => s.local) || null;
  const ranked = rosterSellers.filter((s) => !s.local);
  const truncated = !all && ranked.length > ALL_ROW_CAP;
  const rankedVisible = truncated ? ranked.slice(0, ALL_ROW_CAP) : ranked;
  const visibleSellers = localSeller ? [localSeller, ...rankedVisible] : rankedVisible;
  const capNote = truncated
    ? `<p class="chips-note" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:10px 0 0;">this host pinned · showing the top ${ALL_ROW_CAP} of ${ranked.length} independent sellers &middot; <a href="/marketplace?all=1" style="color:var(--muted);">show all &rarr;</a></p>`
    : "";

  // Grid rows, not a <table> - reuses the exact .mlr-row/.ml-roster-compact
  // classes + mobile media query already proven on every per-chain page
  // (src/ledger-chrome.js's @media rule collapses .ml-roster-compact to a
  // single column). The plain <table> this replaced had no responsive
  // treatment at all: on a 390px phone its fixed columns clipped Tools/
  // Status text mid-word inside a silent horizontal-scroll container, with
  // no scroll affordance - found in a live mobile screenshot review
  // 2026-08-13. A <div>, not an outer <a> like the per-chain compact rows:
  // this row's primary link is the seller's OWN site (safeHref(s.homepage)),
  // not an internal activity view, so only the name text is a link, same
  // interaction model the old table had.
  const rows = visibleSellers.map((s) => {
    const health = s.local ? "live" : (s.routable ? "healthy" : "unreachable");
    const good = s.local || s.routable;
    return `
    <div${rowData(s)} class="mlr-row ml-roster-compact"${s.local ? ' style="background:var(--card-zebra);"' : ""}>
      <div>
        <a href="${safeHref(s.homepage)}" rel="noopener" style="color:var(--ink);text-decoration:none;font-weight:700;">${esc(s.displayName)}</a>${s.local ? ' <span class="mlr-badge">THIS HOST</span>' : ""}${s.mpp === true ? ' <span class="mlr-mpp" title="Also reachable over the native MPP wire">MPP</span>' : ""}
        <div class="mlr-host">${esc(hostOf(s.homepage))}</div>
      </div>
      <span style="font-family:var(--font-mono);font-size:12.5px;">${chainCell(s)}</span>
      <span class="mlr-tools">${Number(s.toolCount) || 0} tool${s.toolCount === 1 ? "" : "s"}${paidSuffix(s)}${txSuffix(s)}${endpointsNote(s)}</span>
      <span class="mlr-stat${good ? "" : " bad"}"><span class="mlr-dot"></span>${health}</span>${dispatchBadge(s)}
    </div>`;
  }).join("");

  const honesty = rosterSellers.length === 1 && rosterSellers[0]?.local
    ? `<p style="color:var(--muted);font-size:13.5px;">1 seller live - discovery is open, and external sellers are added automatically the moment their x402 challenges are crawled, on any supported chain.</p>`
    : "";

  const rosterHtml = `
  <h2 id="sellers" style="font-size:21px;font-weight:800;margin:40px 0 14px;border-bottom:1px solid var(--hairline);padding-bottom:8px;">Every seller, every chain</h2>
  <p style="font-size:13px;color:var(--faint);margin:-6px 0 12px;">THIS HOST = run by agent402 · every other seller is independent, found by the open crawl · Chain shows where each seller settles · Tools shows settled tx, last 7 days on-chain</p>
  <div style="display:flex;flex-direction:column;gap:8px;">${rows}</div>
  ${capNote}
  ${honesty}`;

  // Real tool-listing total across every indexed endpoint (not just this
  // host) - the design's "tool listings" ambition, computed from data we
  // already have rather than a second, differently-scoped guess. Distinct
  // from the economy strip's settled-volume/payers figures below (chain-wide
  // EIP-3009 transfers) on purpose: two "settled" headlines with different
  // scopes on one page is exactly the kind of confusable-metric problem
  // marketOperatorCount's own comment already warns about, so this row
  // stays about the DIRECTORY (who/what is listed), the economy strip stays
  // about SETTLEMENT (what moved on chain) - never merged into one card.
  const totalToolListings = sellers.reduce((sum, s) => sum + (Number(s.toolCount) || 0), 0);

  const statsHtml = `
  <div class="ml-2col ml-4col" style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:26px 0 0;">
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">SELLERS LISTED</div><div style="font-size:26px;font-weight:800;">${rosterSellers.length.toLocaleString("en-US")}</div><div style="font-family:var(--font-mono);font-size:10.5px;color:var(--faint);margin-top:2px;">distinct payees &middot; ${sellers.length.toLocaleString("en-US")} endpoints indexed</div></div>
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">TOOL LISTINGS</div><div style="font-size:26px;font-weight:800;">${totalToolListings.toLocaleString("en-US")}</div><div style="font-family:var(--font-mono);font-size:10.5px;color:var(--faint);margin-top:2px;">advertised &middot; ours and every other seller</div></div>
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">CHAINS SUPPORTED</div><div style="font-size:26px;font-weight:800;">${Object.keys(CHAIN_PAGES).length}</div></div>
    <div style="border:1px solid var(--hairline);background:var(--card);padding:14px 16px;"><div style="font-family:var(--font-mono);font-size:11px;color:var(--faint);letter-spacing:.06em;">TOOLS (THIS HOST)</div><div style="font-size:26px;font-weight:800;">${(sellers.find((s) => s.local)?.toolCount || 0).toLocaleString("en-US")}</div></div>
  </div>`;

  // "Sellers on Base" for the hero subhead - live, not the design's frozen
  // snapshot figure (which would be wrong the moment it shipped and only
  // get worse from there).
  const baseSellerCount = marketOperatorCount("base", { sellers }, leaderboardSnap);

  const headerHtml = `
  <div>
    <h1 style="font-size:34px;font-weight:800;letter-spacing:-.02em;margin:0 0 8px;">The x402 marketplace.</h1>
    <p style="font-size:16.5px;color:var(--muted);margin:0;max-width:640px;">The open index of paid APIs for agentic commerce - ${baseSellerCount.toLocaleString("en-US")} sellers on Base alone, theirs as well as ours, with what they charge and what they have actually settled.</p>
    <div style="margin:18px 0 0;padding:16px 18px;border:1px solid var(--hairline);background:var(--card);max-width:640px;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;color:var(--faint);margin-bottom:10px;">START HERE · BUYER PATH</div>
      <form action="/tools" method="get" class="mkt-search-wrap" style="display:flex;gap:0;background:var(--paper);margin-bottom:12px;">
        <span aria-hidden="true" style="display:flex;align-items:center;padding:0 0 0 13px;color:var(--faint);"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="display:block;"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4.5-4.5"></path></svg></span>
        <input name="q" type="search" placeholder="what do you need? e.g. pdf ocr, web search" style="flex:1;min-width:0;border:none;background:transparent;font-family:var(--font-mono);font-size:13px;color:var(--ink);padding:11px 12px;outline:none;" />
        <button type="submit" style="border:none;border-left:1px solid var(--hairline);background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:12px;padding:0 16px;cursor:pointer;white-space:nowrap;">FIND →</button>
      </form>
      <div style="display:flex;flex-wrap:wrap;gap:14px;font-family:var(--font-mono);font-size:12.5px;">
        <a href="/guides/smart-order-router" style="color:var(--accent);text-decoration:none;font-weight:700;">auto-route a task →</a>
        <a href="/playground" style="color:var(--muted);text-decoration:none;">try playground</a>
        <a href="#sellers" style="color:var(--muted);text-decoration:none;">browse all sellers</a>
      </div>
    </div>
    <p style="font-size:13px;color:var(--faint);margin:10px 0 0;">Describe the job, not the tool name - FIND searches every tool and shows live results. Resolving is free (<span style="color:var(--muted);">GET /api/find</span>), you only pay to execute. This is the neutral x402 index: every seller, not just ours.</p>
    ${statsHtml}
  </div>`;

  // "Markets by chain" - real per-chain seller + tool counts, computed the
  // same way as everywhere else on the site (marketSellers/marketOperatorCount),
  // never the design's frozen 12-entry lookup table. Deliberately its own
  // section rather than counts bolted onto marketFilterBar's tabs: that
  // function is shared with all 12 per-chain pages, and giving it real
  // per-chain stats would mean every /{chain} page computing all 12 chains'
  // numbers on every load just to render its own tab strip - real added
  // cost for a value only this page needs.
  const chainGridHtml = CHAIN_ORDER.map(([slug, name]) => {
    const chainSellers = marketSellers(slug, { sellers });
    const sellerCount = marketOperatorCount(slug, { sellers }, leaderboardSnap);
    const toolCount = chainSellers.reduce((sum, s) => sum + (Number(s.toolCount) || 0), 0);
    const asset = CHAIN_PAGES[slug]?.asset || "USDC";
    return `<a href="/${slug}" title="${esc(name)} x402 marketplace" style="display:block;padding:17px 19px;border-right:1px solid var(--hairline);border-bottom:1px solid var(--hairline);background:var(--card);text-decoration:none;color:var(--muted);">
      <span style="display:flex;align-items:center;gap:9px;margin-bottom:12px;">${chainMark(slug, 19)}<span style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--ink);white-space:nowrap;">${esc(name)}</span><span style="font-family:var(--font-mono);font-size:10px;color:var(--faint);white-space:nowrap;margin-left:auto;">${asset}</span></span>
      <span style="display:flex;align-items:baseline;gap:6px;font-family:var(--font-mono);font-size:12.5px;flex-wrap:wrap;"><span style="color:var(--green);font-variant-numeric:tabular-nums;">${sellerCount.toLocaleString("en-US")}</span><span style="color:var(--faint);font-size:11px;">seller${sellerCount === 1 ? "" : "s"}</span><span style="color:var(--on-dark2);font-variant-numeric:tabular-nums;margin-left:6px;">${toolCount.toLocaleString("en-US")}</span><span style="color:var(--faint);font-size:11px;">tool${toolCount === 1 ? "" : "s"}</span></span>
    </a>`;
  }).join("");

  const chainGridSection = `
  <h2 style="font-size:21px;font-weight:800;margin:48px 0 4px;border-bottom:1px solid var(--hairline);padding-bottom:8px;">Markets by chain</h2>
  <p style="font-size:13px;color:var(--faint);margin:8px 0 16px;">every rail has its own market page - a seller appears under every chain it accepts, so these do not sum to a distinct total</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0;border:1px solid var(--hairline);">${chainGridHtml}</div>
  <p style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin-top:12px;">Buying from a seller on another rail? The Smart Order Router settles with them on their chain and relays the result.</p>`;

  const routerAndMethodSection = `
  <div class="ml-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);margin-top:48px;">
    <div style="padding:26px;border-right:1px solid var(--hairline);background:var(--card);">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">$ POST /api/route</div>
      <h2 style="font-weight:800;font-size:22px;margin:0 0 14px;color:var(--ink);">Or skip the browsing</h2>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 16px;">Describe the task and the Smart Order Router resolves it to a tool - from this index, ours or anyone else's - then runs it. It ranks by match score, then rolling crawl health, then price, and it will pay an external seller on your behalf.</p>
      <pre style="margin:0 0 14px;background:var(--surface);border:1px solid var(--dark-border);color:var(--on-dark);padding:14px;font-family:var(--font-mono);font-size:11.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># free to resolve, you only pay to execute
</span>curl 'https://agent402.tools/api/find?q=ocr+an+image'</pre>
      <a href="/guides/smart-order-router" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">how the router ranks →</a>
    </div>
    <div style="padding:26px;background:var(--card);">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">HOW THE INDEX IS BUILT</div>
      <h2 style="font-weight:800;font-size:22px;margin:0 0 14px;color:var(--ink);">Crawled, not curated</h2>
      <div style="display:flex;flex-direction:column;">${[
        "Discovery: the Coinbase CDP Bazaar plus our own crawler, plus anyone who self-registers at POST /api/index/register.",
        "We read each seller's manifest for its tools, routes and prices, and its live 402 challenge for the chains it accepts.",
        "An hourly probe records whether the manifest and challenge still respond. Probes are never paid calls.",
        "Rolling health feeds the Smart Order Router, which breaks ties on health rather than price alone and routes around sellers that are down.",
      ].map((body_, i) => `<div style="display:grid;grid-template-columns:26px 1fr;gap:12px;padding:11px 0;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">${String(i + 1).padStart(2, "0")}</span><span style="font-size:13.5px;line-height:1.55;color:var(--muted);">${esc(body_)}</span></div>`).join("")}</div>
      <p style="font-size:13px;line-height:1.6;color:var(--faint);margin:14px 0 0;">No editorial gate, no pay-for-placement, and no removal on request unless a seller stops serving. A seller that goes dark drops out on its own.</p>
    </div>
  </div>`;

  const MARKET_FAQS = [
    { q: "What is an x402 marketplace?", a: "A directory of services that accept x402 payments, so an AI agent can find something to buy and pay for it in one round trip without an account. This index lists every seller it can crawl, not only our own tools, and publishes the tool counts, settlement chains and crawl health it observes." },
    { q: "How does a seller get listed?", a: "By serving x402 challenges and registering its origin with POST /api/index/register, or by appearing in the Coinbase CDP Bazaar, which the crawler reads on its hourly pass. Listing is free, there is no review queue, and there is no pay-for-placement." },
    { q: "What does crawl health mean?", a: "A rolling success rate across recent crawls of a seller's manifest and 402 challenge. One bad hour does not delist anyone, and a new seller is not penalised for having no history. The Smart Order Router uses it to break ties and to route around sellers that are down." },
    { q: "Why do tool counts and settled volume disagree?", a: "Tool counts are what a seller advertises; settled volume is what buyers actually paid for. A large catalog with no settlements has not found buyers yet, and a small catalog with heavy volume has found exactly the right one. Both numbers are shown so you can see the difference." },
  ];
  const faqHtml = MARKET_FAQS.map((f) => `<article style="padding:22px 0;border-bottom:1px solid var(--hairline);"><h3 style="font-weight:800;font-size:17.5px;margin:0 0 10px;color:var(--ink);">${esc(f.q)}</h3><p style="font-size:15px;line-height:1.65;color:var(--muted);margin:0;">${esc(f.a)}</p></article>`).join("");
  const faqSection = `
  <div style="max-width:760px;margin:56px 0 0;">
    <h2 style="font-weight:800;font-size:26px;letter-spacing:-.02em;margin:0 0 20px;color:var(--ink);">About this index.</h2>
    <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">${faqHtml}</div>
  </div>`;

  const closingCta = `
  <div style="margin:48px 0 0;background:var(--surface);border:1px solid var(--hairline);padding:40px 36px;position:relative;overflow:hidden;">
    <div style="position:relative;">
      <h2 style="font-weight:800;font-size:30px;letter-spacing:-.02em;margin:0 0 12px;color:var(--on-dark);">Add your API to the index.</h2>
      <p style="font-size:15.5px;line-height:1.6;color:var(--dk-muted2);margin:0 0 22px;max-width:520px;">Free, no signup, nothing deducted. Serve a 402, register the origin, and the crawler picks you up on the next hourly pass.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a href="/sell" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 22px;">List your API - free →</a>
        <a href="/leaderboard" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 22px;">SEE THE LEADERBOARD</a>
      </div>
    </div>
  </div>`;

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "The x402 marketplace",
      url: `${baseUrl}/marketplace`,
      description: `Pay-per-call tools for AI agents, settled via the x402 protocol across every supported chain. ${rosterSellers.length} sellers listed.`,
      mainEntity: {
        "@type": "OfferCatalog",
        name: "x402-payable agent tools, every chain",
        numberOfItems: rosterSellers.length,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Agent402.Tools", item: baseUrl },
        { "@type": "ListItem", position: 2, name: "Marketplace", item: `${baseUrl}/marketplace` },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": `${baseUrl}/marketplace#dataset`,
      name: "x402 seller index",
      description: "Hourly crawl of every discoverable x402 seller: origin, advertised tools with route and price, settlement networks from the 402 challenge, last successful fetch and rolling crawl health. Discovery is the Coinbase CDP Bazaar plus Agent402's own crawler.",
      license: "https://www.gnu.org/licenses/agpl-3.0.html",
      isAccessibleForFree: true,
      variableMeasured: [
        { "@type": "PropertyValue", name: "toolCount", description: "Tools the seller advertises in its manifest" },
        { "@type": "PropertyValue", name: "networks", description: "CAIP-2 settlement networks accepted" },
        { "@type": "PropertyValue", name: "health", description: "Rolling crawl success rate" },
      ],
      distribution: { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${baseUrl}/api/index` },
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "@id": `${baseUrl}/marketplace#chains`,
      name: "x402 marketplaces by settlement chain",
      itemListElement: CHAIN_ORDER.map(([slug, name], i) => ({ "@type": "ListItem", position: i + 1, name, url: `${baseUrl}/${slug}` })),
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "@id": `${baseUrl}/marketplace#faq`,
      mainEntity: MARKET_FAQS.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];

  const body = `
<div style="max-width:1080px;margin:0 auto;padding:36px 24px;">
  <section>${headerHtml}</section>
  <section>
    ${hostCardHtml(host)}
    ${marketFilterBar(null, baseUrl)}
    ${rosterHtml}
  </section>
  <section>${chainGridSection}</section>
  <section>${economyStripHtml(economySnap)}</section>
  <section>${routerAndMethodSection}</section>
  <section>${faqSection}</section>
  <section>
    ${closingCta}
    <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:28px;">machine-readable: <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/api/reliability">/api/reliability</a></p>
  </section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "x402 marketplace - every indexed seller, tool count, network and health",
    description: "The open directory of every x402 seller we can crawl: advertised tools, settlement networks, crawl health and routability. Free to browse, free to query, and the operator is excluded from its own ranking.",
    canonical: `${baseUrl}/marketplace`,
    baseUrl,
    activePath: "/marketplace",
    jsonLd,
    extraCss: `${ROSTER_CSS}\n@media (max-width: 900px) { .ml-4col { grid-template-columns: repeat(2,1fr) !important; } }`,
    body,
  });
}

/** Operator-level seller count for a chain page (null = all chains): the same
 *  leaderboard-group collapse the rosters render, WITHOUT building rows —
 *  hosts settling to one leaderboard group count once, everything ungrouped
 *  counts individually. Exists so the nav dropdown and the page's SELLERS
 *  LISTED card speak the same unit (operators): the dropdown used raw origin
 *  counts (e.g. Base 1,554) while the page's deduped roster showed 843, which
 *  read as a bug from the outside. Endpoints stay disclosed on the rows
 *  ("+N more endpoints"), never hidden. */
export function marketOperatorCount(chainKey, snapshot, leaderboardSnap) {
  const sellers = chainKey ? marketSellers(chainKey, snapshot) : marketSellersAll(snapshot);
  const gidByWallet = new Map();
  (Array.isArray(leaderboardSnap?.leaderboard) ? leaderboardSnap.leaderboard : []).forEach((r, i) => {
    for (const w of (r.wallets && r.wallets.length ? r.wallets : [r.wallet])) if (w) gidByWallet.set(String(w).toLowerCase(), `lb${i}`);
  });
  const C = chainKey ? CHAIN_PAGES[chainKey] : null;
  const gidOf = (s) => {
    if (s.local) return null;
    const entries = Object.entries(s.payToByNetwork || {});
    const pay = C
      ? (entries.find(([net]) => C.isNetwork(net))?.[1] || null)
      : (entries.map(([, w]) => w).find((w) => w && gidByWallet.has(String(w).toLowerCase())) || null);
    return pay ? gidByWallet.get(String(pay).toLowerCase()) || null : null;
  };
  const seen = new Set();
  let count = 0;
  for (const s of sellers) {
    const gid = gidOf(s);
    if (!gid) { count++; continue; }
    if (!seen.has(gid)) { seen.add(gid); count++; }
  }
  return count;
}
