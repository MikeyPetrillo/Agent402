// Chain truth for the EIP-712 domain of every token an x402 accept in the index
// actually names, and the verdict on what a seller's 402 advertises against it.
//
// WHY. An x402 exact/EVM payment is an EIP-3009 authorization signed under the
// TOKEN's own EIP-712 domain, and a stock client (@x402/evm, and ours through
// it) signs under whatever `extra.name` / `extra.version` the seller's accept
// carries. Get either wrong and the signature recovers to nobody: the
// facilitator answers invalid_payload, nothing settles - and the seller reads
// as "healthy, zero external settlements". Circle's own deployments do not
// share one name (Base, Polygon, Arbitrum, Avalanche, Optimism and Ethereum
// USDC sign under "USD Coin"; Monad, Celo, Sei, World Chain, HyperEVM,
// Unichain and Sonic USDC under "USDC"), so "it's USDC, use USDC" is wrong
// about half the time and nobody can tell by looking at the symbol.
//
// EVIDENCE, NOT A SECOND OPINION. Every row carries the token's own
// DOMAIN_SEPARATOR(), read from that chain. keccak256(abi.encode(EIP712Domain
// typehash, keccak(name), keccak(version), chainId, verifyingContract)) has to
// reproduce it byte for byte, and scripts/test-evm-usdc-domain.js recomputes
// all of them offline on every CI run - so a wrong name or version in this
// table cannot survive a commit. If the rebuild misses, no signature under
// that domain will ever verify on that token. That is arithmetic.
//
// KEYED BY (network, asset), not by network. One chain carries several payable
// tokens - X Layer alone appears in the live index with USDC, USDG and USDT0,
// under three different domain names - and a network-keyed table can only ever
// answer for one of them; the rest fall through as "unknown" and a wrong
// domain ships unnoticed.
//
// Measured on the public index 2026-09-15: 36 distinct (network, asset) pairs
// across 4149 sellers, 22 of them on chains a public RPC answers. 45 seller
// rows advertise a domain that does not rebuild the token's separator - among
// them 18 rows on 11 chains carrying "GatewayWalletBatched" (Circle Gateway's
// own EIP-712 domain) pasted onto plain USDC contracts, and 3 sellers naming
// "USD Coin" on World Chain, whose USDC signs under "USDC".
//
// Dependency-free on purpose: the index, the router label and the buyer all
// read it, and none of them should pull the payment stack in to ask a
// question about a string.

/** Every (network, asset) whose EIP-712 domain we have read from the chain.
 *  `domainSeparator` is what the contract itself returned on 2026-09-15;
 *  `name` + `version` are the only pair that rebuilds it. Addresses
 *  lower-cased for comparison. Row order decides only which USDC row a chain
 *  contributes to the derived USDC_DOMAIN_BY_NETWORK below. */
export const EVM_TOKEN_DOMAINS = Object.freeze([
  { network: "eip155:8453", chain: "Base", symbol: "USDC", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", name: "USD Coin", version: "2", domainSeparator: "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f" },
  { network: "eip155:137", chain: "Polygon", symbol: "USDC", asset: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", name: "USD Coin", version: "2", domainSeparator: "0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca" },
  { network: "eip155:42161", chain: "Arbitrum", symbol: "USDC", asset: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", name: "USD Coin", version: "2", domainSeparator: "0x08d11903f8419e68b1b8721bcbe2e9fc68569122a77ef18c216f10b3b5112c78" },
  { network: "eip155:143", chain: "Monad", symbol: "USDC", asset: "0x754704bc059f8c67012fed69bc8a327a5aafb603", name: "USDC", version: "2", domainSeparator: "0xfe22123edc0dd4aeb912eb7948c5f0e531592c2053b3067612f427db342c93c6" },
  { network: "eip155:42220", chain: "Celo", symbol: "USDC", asset: "0xceba9300f2b948710d2653dd7b07f33a8b32118c", name: "USDC", version: "2", domainSeparator: "0xb2ce31d2838445fa765a491f550e7c78ac7280ab0f3bc9d6063a86df9c3fb578" },
  { network: "eip155:43114", chain: "Avalanche", symbol: "USDC", asset: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", name: "USD Coin", version: "2", domainSeparator: "0xbbea200329a938bc3438984a49cb0732e66d66d7bd59c127abacc1710e77f7b3" },
  { network: "eip155:1329", chain: "Sei", symbol: "USDC", asset: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392", name: "USDC", version: "2", domainSeparator: "0x0a19136106ae98d2c245cbbd451f3cb2bbbb1670e1ee191abacb5a5e255c0255" },
  { network: "eip155:10", chain: "Optimism", symbol: "USDC", asset: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", name: "USD Coin", version: "2", domainSeparator: "0x26d9c34bb1a1c312f69c53b2d93b8be20faafba63af2438c6811713c9b1f933f" },
  { network: "eip155:1", chain: "Ethereum", symbol: "USDC", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", name: "USD Coin", version: "2", domainSeparator: "0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335" },
  { network: "eip155:480", chain: "World Chain", symbol: "USDC", asset: "0x79a02482a880bce3f13e09da970dc34db4cd24d1", name: "USDC", version: "2", domainSeparator: "0x936533d5f85622a8261854e20bb87f4e849dde486f429bc1fb66202b7cde09ec" },
  { network: "eip155:999", chain: "HyperEVM", symbol: "USDC", asset: "0xb88339cb7199b77e23db6e890353e22632ba630f", name: "USDC", version: "2", domainSeparator: "0x70a72998ad787d1a9152a8f88ccfe0766b1cb293b6b4011b34523035da10b0a3" },
  { network: "eip155:130", chain: "Unichain", symbol: "USDC", asset: "0x078d782b760474a361dda0af3839290b0ef57ad6", name: "USDC", version: "2", domainSeparator: "0x565b4c4095d739dada6adeb9a89bc6dc4d102500ebd4a88bef1ec1d0f69d83b8" },
  { network: "eip155:146", chain: "Sonic", symbol: "USDC", asset: "0x29219dd400f2bf60e5a23d13be72b486d4038894", name: "USDC", version: "2", domainSeparator: "0x47ff53f4cb866f027068ac56dedd98f6818c3ea4f1f60a1850d746944543ac12" },
  { network: "eip155:196", chain: "X Layer", symbol: "USDC", asset: "0x74b7f16337b8972027f6196a17a631ac6de26d22", name: "USD Coin", version: "2", domainSeparator: "0xb1671065a2ea487729c4ff0e2f8beb2105e3ce63315ad07483374a3476b83972" },
  { network: "eip155:84532", chain: "Base Sepolia", symbol: "USDC", asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", name: "USDC", version: "2", domainSeparator: "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818" },
  { network: "eip155:80002", chain: "Polygon Amoy", symbol: "USDC", asset: "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582", name: "USDC", version: "2", domainSeparator: "0x5cddc98319864e897e4469bd1d13c2288c677047b54b8cca12bd342adb6be9eb" },
  { network: "eip155:10143", chain: "Monad Sepolia", symbol: "USDC", asset: "0x534b2f3a21130d7a60830c2df862319e593943a3", name: "USDC", version: "2", domainSeparator: "0xf1090f5a61ddee19528cecc447be0f91c7205fc2b34dd271fc0de87809a0a48d" },
  { network: "eip155:196", chain: "X Layer", symbol: "USDG", asset: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", name: "Global Dollar", version: "1", domainSeparator: "0x415f0706e345fcaf25d5be24c4fd7830d0054fc5742c51a0db9319c759bd3743" },
  { network: "eip155:196", chain: "X Layer", symbol: "USDT0", asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736", name: "USD₮0", version: "1", domainSeparator: "0xd591d9baf744328d9400b923cb02c9474d367d591ca1ab24d8c4068be527599d" },
  { network: "eip155:56", chain: "BNB Chain", symbol: "USD1", asset: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", name: "World Liberty Financial USD", version: "1", domainSeparator: "0x5d939dc193fd011c5e26fb861450a696546a09db6b26db26501fe354ba3ed4ba" },
  { network: "eip155:56", chain: "BNB Chain", symbol: "U", asset: "0xce24439f2d9c6a2289f741120fe202248b666666", name: "United Stables", version: "1", domainSeparator: "0x358738403e5a61fdc30a8be78a60f289cbe4d2545b735a344b6229c70c1679b6" },
  { network: "eip155:8453", chain: "Base", symbol: "X402R", asset: "0x50ec5ed76e336a7823b6924c2839defa0c5a3a2d", name: "x402 Roshambo", version: "1", domainSeparator: "0x7f03d9403ff771153871e61092bd6112ab3a66072f3dc6456b4baf24013e28b9" },
].map(Object.freeze));

/** The USDC of each chain, keyed by CAIP-2 - the shape this module published
 *  before it learned that a chain can carry more than one payable token.
 *  DERIVED, never hand-edited, so it cannot disagree with the rows above. */
export const USDC_DOMAIN_BY_NETWORK = Object.freeze(Object.fromEntries(
  EVM_TOKEN_DOMAINS
    .filter((r) => r.symbol === "USDC")
    .filter((r, i, all) => all.findIndex((o) => o.network === r.network) === i)
    .map((r) => [r.network, Object.freeze({ chain: r.chain, asset: r.asset, name: r.name, version: r.version })]),
));

const lc = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** (network, asset) -> row. Built once; both parts of the key already lower-cased. */
const BY_PAIR = new Map(EVM_TOKEN_DOMAINS.map((r) => [`${r.network}|${r.asset}`, r]));

/** The chain truth for one accept's token, or null if we have never read it. */
export function domainTruthFor(network, asset) {
  return BY_PAIR.get(`${String(network || "")}|${lc(asset)}`) || null;
}

/**
 * What a seller's EVM accept advertises against the token's own EIP-712 domain.
 *
 * Refuses ONLY on a positive mismatch: the accept names a token we have read
 * from the chain AND carries a domain name (or version) that is not that
 * token's. Everything else is "unknown" - a token we have never read, or no
 * name at all (the client's registry then supplies the default, which is right
 * on every chain listed).
 *
 * @param {object} accept  an x402 accepts entry ({network, asset, extra:{name, version}})
 *                         or the index's observation ({asset, name, version}) with `network`
 * @returns {{verdict:"matches"|"wrong_domain"|"unknown", expectedName?:string, advertisedName?:string,
 *            expectedVersion?:string, advertisedVersion?:string, chain?:string, field?:"name"|"version"}}
 */
export function usdcDomainVerdict(accept, network = accept?.network) {
  const truth = domainTruthFor(network, accept?.asset);
  if (!truth) return { verdict: "unknown" };
  const advertised = typeof accept?.name === "string" ? accept.name : accept?.extra?.name;
  const advertisedVersion = typeof accept?.version === "string" ? accept.version : accept?.extra?.version;
  const named = typeof advertised === "string" && advertised.trim() !== "";
  if (named && lc(advertised) !== lc(truth.name))
    return { verdict: "wrong_domain", field: "name", advertisedName: advertised.trim().slice(0, 40), expectedName: truth.name, expectedVersion: truth.version, chain: truth.chain };
  // A wrong VERSION is exactly as unsignable as a wrong name - both hash into
  // the same domain separator - and it is the half nobody checks.
  if (typeof advertisedVersion === "string" && advertisedVersion.trim() && lc(advertisedVersion) !== lc(truth.version))
    return { verdict: "wrong_domain", field: "version", advertisedName: named ? advertised.trim().slice(0, 40) : truth.name, advertisedVersion: advertisedVersion.trim().slice(0, 16), expectedName: truth.name, expectedVersion: truth.version, chain: truth.chain };
  if (!named) return { verdict: "unknown" };
  return { verdict: "matches", expectedName: truth.name, chain: truth.chain };
}

/** The domain each EVM accept advertises, keyed by network - what the index
 *  stores beside payToByNetwork so the label and the router can read it later
 *  without the 402. First accept per network wins (a seller that offers two
 *  entries on one chain is priced from the first anyway). Bounded strings. */
export function evmDomainsOfAccepts(accepts) {
  const out = {};
  for (const a of Array.isArray(accepts) ? accepts : []) {
    const net = typeof a?.network === "string" ? a.network : "";
    if (!net.startsWith("eip155:") || out[net]) continue;
    const asset = typeof a?.asset === "string" ? a.asset.trim().slice(0, 42) : "";
    const name = typeof a?.extra?.name === "string" ? a.extra.name.trim().slice(0, 40) : "";
    const version = typeof a?.extra?.version === "string" ? a.extra.version.trim().slice(0, 16) : "";
    if (!asset || !name) continue;
    out[net] = version ? { asset, name, version } : { asset, name };
  }
  return out;
}

/** One sentence for a wrong_domain verdict, written for the seller who has to fix it. */
export function usdcDomainMismatchDetail({ advertisedName, expectedName, chain, field, advertisedVersion, expectedVersion } = {}) {
  const what = field === "version"
    ? `advertises extra.version ${JSON.stringify(advertisedVersion)} but that token signs under version ${JSON.stringify(expectedVersion)} (the name ${JSON.stringify(expectedName)} is right)`
    : `advertises extra.name ${JSON.stringify(advertisedName)} but that token signs under ${JSON.stringify(expectedName)}`;
  return `the ${chain || "chain"} USDC accept ${what}, so every stock x402 buyer (this router included) produces a signature the facilitator refuses and nothing settles`;
}
