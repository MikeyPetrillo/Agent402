// MPP start-here set: a short list of routes a new MPP agent can try first.
// Defined ONCE here; every surface that shows it derives from this list:
//   - /what-is-mpp "Start here" section (method, path, price read from the catalog)
//   - /llms.txt "MPP: start here" list
//   - /openapi.json `x-mpp-flagship` (per operation and a top-level index)
//   - the hosted MCP connector's payment.info (`mppStartHere`)
// Prices are never written here: every surface reads them from the catalog.
// A route belongs here only if the live 402 offers it a tempo challenge
// (tempoOfferedFor: not identity-bound, not long-running), it answers in a
// single fast call, and it costs little. A route this instance does not list
// (judge is listed only with its key) is simply left out of every surface.
// scripts/test-mpp-flagship.js pins it.
import { tempoOfferedFor, tempoEnabled } from "./mpp-tempo.js";

export const MPP_FLAGSHIP = [
  { slug: "search-lite", group: "Web", why: "Web search: up to five ranked results with title, URL and snippet." },
  { slug: "extract", group: "Web", why: "Read one known URL as clean markdown, with title, byline and word count." },
  { slug: "crypto-price", group: "Crypto and markets", why: "Spot price, 24h change, volume and market cap for several coins in one call." },
  { slug: "sol-price", group: "Crypto and markets", why: "USD price for up to 50 Solana token mints, with liquidity and the block read." },
  { slug: "perp-funding", group: "Crypto and markets", why: "Current perpetual funding rate, annualized, plus recent hourly prints." },
  { slug: "defi-yields", group: "Crypto and markets", why: "DeFi yield pools filtered by chain, project, token and TVL, sorted by APY or TVL." },
  { slug: "kalshi-markets", group: "Crypto and markets", why: "Open prediction markets with yes/no prices, volume and resting size at the best price." },
  { slug: "fx-rate", group: "Crypto and markets", why: "Convert an amount between two currencies at the reference rate, with its date." },
  { slug: "treasury-yield-curve", group: "Macro and filings", why: "The latest US Treasury yield curve, eleven tenors in percent." },
  { slug: "unemployment-rate", group: "Macro and filings", why: "Latest US unemployment rate plus a trailing monthly series." },
  { slug: "edgar-company-lookup", group: "Macro and filings", why: "Resolve a stock ticker to its SEC CIK and registered name, the key to every EDGAR call." },
  { slug: "dns", group: "Network", why: "DNS records for a domain: A, AAAA, MX, TXT, NS or CNAME." },
  { slug: "asn-info", group: "Network", why: "ASN, prefix, country and registry for an IP address or hostname." },
  { slug: "tls-cert", group: "Network", why: "A host's TLS certificate: issuer, validity window, days left, SANs." },
  { slug: "weather-current", group: "Weather", why: "Current conditions anywhere on Earth, metric or imperial." },
  { slug: "block-number", group: "Chain", why: "Latest block number on Ethereum, Base, Polygon, Arbitrum or Optimism." },
  { slug: "judge", group: "Judgment", why: "A typed judgment about any content (choice, score or yes/no) with probabilities; model-backed." },
  { slug: "time-convert", group: "Utilities", why: "Convert between epoch, ISO 8601 and any IANA timezone." },
  { slug: "hash", group: "Utilities", why: "SHA-256, SHA-512, SHA-1 or MD5 of a text, in hex and base64." },
  { slug: "uuid", group: "Utilities", why: "Fresh UUIDs (v4 or v7): the simplest paid call to test an MPP client." },
];

export const MPP_FLAGSHIP_SLUGS = MPP_FLAGSHIP.map((f) => f.slug);

// The route used for the copy-paste snippet on /what-is-mpp.
export const MPP_FLAGSHIP_SNIPPET_SLUG = "crypto-price";

/** Rows for every flagship route present in `catalog` (a route -> def map, or
 *  an array of defs carrying `route`) that the live 402 offers tempo on, in
 *  list order. Method, path, name and price come from the catalog def. */
export function mppFlagshipRows(catalog) {
  const defs = Array.isArray(catalog) ? catalog : Object.entries(catalog || {}).map(([route, def]) => ({ route, ...def }));
  const bySlug = new Map();
  for (const d of defs) if (d && d.slug && d.route && !bySlug.has(d.slug)) bySlug.set(d.slug, d);
  const rows = [];
  for (const f of MPP_FLAGSHIP) {
    const def = bySlug.get(f.slug);
    if (!def || !tempoOfferedFor(def)) continue;
    const [method, path] = String(def.route).split(" ");
    rows.push({ order: rows.length + 1, slug: f.slug, group: f.group, why: f.why, method, path, name: def.name, price: def.price, modelBacked: !!def.modelBacked });
  }
  return rows;
}

/** What every listed route is offered, worded for whether this instance has
 *  the tempo method switched on (a self-hosted server may not). */
export function mppFlagshipOffersPhrase() {
  return tempoEnabled()
    ? "offer the tempo challenge (USDC.e on Tempo) as well as the evm one"
    : "take every MPP method this server has switched on";
}

/** Copy-paste mppx client snippet for one flagship row. */
export function mppFlagshipSnippet(row, baseUrl, query = "") {
  const url = `${baseUrl}${row.path}${query}`;
  return `import { Mppx, tempo, evm } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY);
const mppx = Mppx.create({ methods: [tempo.charge({ account }), evm.charge({ account })] });

// ${row.price} per call; the first request returns 402, mppx pays and retries.
const res = await mppx.fetch("${url}");
console.log(res.status, res.headers.get("payment-receipt"), await res.json());`;
}

/** The /llms.txt "MPP: start here" block (full paths only). */
export function mppFlagshipLlmsBlock(catalog) {
  const rows = mppFlagshipRows(catalog);
  if (!rows.length) return "";
  const lines = rows.map((r) => `- \`${r.method} ${r.path}\` (${r.price}): ${r.why}`);
  return `**MPP: start here.** ${rows.length} fast, low-priced routes that ${mppFlagshipOffersPhrase()}: a good first call for a new MPP client. Prices are the catalog's; the full list is marked \`x-mpp-flagship\` in /openapi.json.\n${lines.join("\n")}`;
}
