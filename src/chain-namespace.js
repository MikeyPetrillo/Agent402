// /api/chain/<verb> - the RPC name a buyer already knows, pointed at the route
// that already serves it.
//
// WHAT THIS IS AND IS NOT. It is a PATH REWRITE that runs before every gate, so
// `/api/chain/erc20-balance` is served by `/api/token-balances` at that tool's
// own price, under that tool's own paywall, replay guard and idempotency key.
// It mints no catalog entries, appears on no discovery surface as a second
// resource, and can never be a second listing for one capability - the thing we
// object to when other sellers do it to an index.
//
// WHY IT EXISTS. Measured 2026-09-12 against the busiest seller on x402scan by
// buyer count (1,933 buyers, 16,716 settlements, $70.83): all 25 of its
// endpoints are one family, `/api/chain/*`, and they are the JSON-RPC verbs
// spelled out. We already sold 20 of the 25 under our own names and the
// remaining five arrived with this change. So nothing was missing except the
// name a buyer would guess. An agent that knows `eth_getTransactionCount`
// cannot be expected to guess `wallet-transactions`; it can be expected to try
// `/api/chain/nonce`.
//
// The rewrite is invisible past this middleware: `req.path` is the canonical
// route by the time anything prices, gates or records the call, so the ledger,
// the 402, the Bazaar listing and /api/route all keep speaking about one tool.
// A buyer who wants the canonical name still gets it in the response's own
// fields and in the receipt.

/**
 * Verb -> canonical route. Every value must be a real catalog route; the pin in
 * scripts/test-chain-namespace.js checks each one against the booted server, so
 * a retired or renamed tool cannot leave a verb pointing at a 404.
 *
 * Synonyms are deliberate and cheap: a caller reaching for `logs`, `events` or
 * `eth_getLogs` means one thing, and being right about which of the three they
 * type is not a skill we should be charging for.
 */
export const CHAIN_VERB_ROUTES = new Map(Object.entries({
  // reads that already had a home
  "allowance": "/api/token-allowance",
  "balance": "/api/wallet-balance",
  "block": "/api/block-info",
  "block-number": "/api/block-number",
  "call": "/api/eth-call",
  "chain-id": "/api/chain-info",
  "code": "/api/contract-code",
  "contract": "/api/contract-abi",
  "ens": "/api/ens-resolve",
  "erc20-balance": "/api/token-balances",
  "erc20-transfers": "/api/asset-transfers",
  "erc721-tokens": "/api/nft-holdings",
  "estimate-gas": "/api/gas-estimate",
  "events": "/api/event-logs",
  "gas": "/api/gas-snapshot",
  "live-balance": "/api/wallet-balance",
  "logs": "/api/event-logs",
  "network-info": "/api/chain-info",
  "nft-metadata": "/api/nft-metadata",
  "nft-owner": "/api/erc721-owner",
  "proxy": "/api/address-profile",
  "receipt": "/api/tx-receipt",
  "rpc": "/api/evm-rpc",
  "source": "/api/contract-source",
  "token-metadata": "/api/token-metadata",
  "token-price": "/api/token-price",
  "transactions": "/api/wallet-transactions",
  "tx": "/api/tx-status",
  // The raw JSON-RPC method names, for a caller who has the method and not our
  // vocabulary. Only reads that map to a route above; eth_call and the generic
  // evm-rpc route cover everything else.
  "eth_blocknumber": "/api/block-number",
  "eth_call": "/api/eth-call",
  "eth_estimategas": "/api/gas-estimate",
  "eth_getbalance": "/api/wallet-balance",
  "eth_getcode": "/api/contract-code",
  "eth_getlogs": "/api/event-logs",
  "eth_gettransactionreceipt": "/api/tx-receipt",
}));

// Verbs served by their own routes under this prefix (chain-rpc-kit). They are
// listed here so the namespace can describe itself completely, and so the
// middleware knows to leave them alone rather than look for an alias.
export const CHAIN_OWN_ROUTES = new Map(Object.entries({
  "nonce": "/api/chain/nonce",
  "storage": "/api/chain/storage",
  "pending": "/api/chain/pending",
  "total-supply": "/api/chain/total-supply",
  "erc1155-balance": "/api/chain/erc1155-balance",
}));

/** The verb from `/api/chain/<verb>`, lowercased, or null. */
export function chainVerbOf(path) {
  if (typeof path !== "string") return null;
  const m = /^\/api\/chain\/([^/?]+)\/?$/.exec(path);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

/** Canonical route for a verb, or null when the namespace does not define it. */
export function chainRouteFor(verb) {
  if (!verb) return null;
  // Belt, not braces: the two maps are disjoint today and a test pins that, so
  // this line changes nothing now. It is here so that a verb added to both -
  // the obvious mistake when a verb graduates from alias to its own route -
  // keeps being served where it stands rather than rewritten away from it.
  if (CHAIN_OWN_ROUTES.has(verb)) return null;
  return CHAIN_VERB_ROUTES.get(verb) || null;
}

/**
 * Mounted with the other pre-gate path aliases. Rewrites the URL and keeps the
 * query string, exactly like the Messages SDK alias above it.
 */
export function chainNamespaceMiddleware(req, _res, next) {
  const verb = chainVerbOf(req.path);
  if (verb) {
    const target = chainRouteFor(verb);
    if (target) {
      const q = req.url.indexOf("?");
      req.url = target + (q >= 0 ? req.url.slice(q) : "");
      req.__chainVerb = verb;
    }
  }
  next();
}

/** Every verb the namespace answers, with the route that serves it. */
export function chainNamespaceMap() {
  const out = [];
  for (const [verb, route] of CHAIN_OWN_ROUTES) out.push({ verb, route, own: true });
  for (const [verb, route] of CHAIN_VERB_ROUTES) out.push({ verb, route, own: false });
  return out.sort((a, b) => a.verb.localeCompare(b.verb));
}

/**
 * Canonical route -> the verbs that resolve to it, for the catalog build to
 * fold into each tool's `aliases`.
 *
 * DERIVED, NEVER TYPED TWICE. The namespace map above is the one place a verb
 * is declared; adding a verb there makes our own resolvers find it with no
 * second edit, which is the same rule the skill-pack prices follow. Typing the
 * list again on each tool is how the two drift, and a drifted alias is a buyer
 * routed to the wrong tool rather than a visible error.
 *
 * The five verbs with their own routes are absent by construction: those tools
 * carry their own curated aliases and there is nothing to fold them into.
 */
/**
 * Verbs that stay URL-only: unambiguous under `/api/chain/` and ambiguous
 * everywhere else, so folding them into a tool's aliases would assert a claim
 * that fights the rest of the catalog.
 *
 * `proxy` means an EIP-1967 implementation pointer here and an LLM proxy in
 * most of our other descriptions; measured 2026-09-12, folding it put
 * address-profile behind llm, llm-pro and llm-premium for the bare word and
 * would have dragged the LLM tiers down for it in return. The URL still
 * answers - it is the search claim that is withdrawn. Name any addition here
 * with its reason, the way the sweep skiplists do.
 */
export const VERBS_NOT_FOLDED = new Set(["proxy"]);

export function chainVerbAliasesByRoute() {
  const out = new Map();
  for (const [verb, route] of CHAIN_VERB_ROUTES) {
    if (VERBS_NOT_FOLDED.has(verb)) continue;
    if (!out.has(route)) out.set(route, []);
    out.get(route).push(verb);
  }
  return out;
}
