// Unit tests for the discovery & trust surfaces (/.well-known/x402 and
// /api/reliability). These are what make an agent PICK this seller, so the
// contract — required fields present, links well-formed, counts coherent —
// must not silently regress. Offline, no server, no secrets.
import { serviceManifest, reliabilityReport } from "../src/discovery.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); };

const BASE = "https://agent402.tools";
const WALLET = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";

// Minimal catalog spanning a few real categories, with one compute-payable slug.
const CATALOG = {
  "POST /api/extract": { name: "Extract", slug: "extract", category: "web", price: "$0.005", description: "x" },
  "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "x" },
  "GET /api/dns": { name: "DNS", slug: "dns", category: "network", price: "$0.002", description: "x" },
};
const PRICES = { extract: 0.005, hash: 0.001, dns: 0.002 };
const POW = new Set(["hash"]); // only hash is compute-payable

// ---- serviceManifest ----
const m = serviceManifest({
  baseUrl: BASE, network: "base", networks: ["base", "polygon"],
  wallet: WALLET, walletName: "agent402.base.eth", catalog: CATALOG,
  toolCount: Object.keys(CATALOG).length, powSlugs: POW, powDifficulty: 20, prices: PRICES,
});

ok(m.spec === "agent402-service-manifest/1", "manifest spec tag");
ok(m.name === "Agent402.Tools", "manifest name");
ok(m.openSource === true && m.selfHostable === true && m.license === "AGPL-3.0-or-later", "wedge flags");
ok(Array.isArray(m.differentiators) && m.differentiators.length >= 3, "differentiators present");
ok(m.twoSided?.tollbooth?.npm === "agent402-tollbooth", "tollbooth advertised");

ok(m.payment.x402.version === 2 && m.payment.x402.currency === "USDC", "x402 payment shape");
ok(JSON.stringify(m.payment.x402.networks) === JSON.stringify(["base", "polygon"]), "networks passed through");
ok(m.payment.x402.payTo === WALLET, "payTo is the wallet");
{
  const m2 = serviceManifest({ baseUrl: BASE, network: "base", networks: ["base", "stellar", "solana"], wallet: WALLET, walletName: "agent402.base.eth", catalog: CATALOG, toolCount: Object.keys(CATALOG).length, powSlugs: POW, powDifficulty: 20, prices: PRICES, payToByNetwork: { evm: WALLET, stellar: "GDNJXCKW7ZM7EXAMPLE", solana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" } });
  ok(m2.payment.x402.payToByNetwork.stellar === "GDNJXCKW7ZM7EXAMPLE" && m2.payment.x402.payToByNetwork.evm === WALLET, "payToByNetwork lists each rail's own address beside the EVM payTo");
  ok(!("payToByNetwork" in m.payment.x402), "no per-network map when none is given (manifest shape unchanged)");
}
ok(m.payment.x402.priceRange === "$0.001–$0.005", `price range derived (got ${m.payment.x402.priceRange})`);
ok(m.payment.proofOfWork.difficultyBits === 20, "pow difficulty");
ok(m.payment.proofOfWork.eligibleTools === 1, "pow eligible count");
ok(m.payment.dataHandling?.readsPaymentMetadata === false && m.payment.dataHandling?.retainsPaymentMetadata === false,
  "dataHandling attests payment-metadata minimisation");
// The fields read off a payment are named in full. The list once named only
// authorization.from while the server also reads the payment-identifier
// extension, the Solana transaction's signers, the Tempo credential source and
// the payer in the facilitator's settlement receipt, and keeps the payer per sale.
{
  const reads = (m.payment.dataHandling?.readsOnly || []).join(" | ");
  for (const [needle, what] of [["authorization.from", "the EIP-3009 payer"], ["payment-identifier", "the idempotency extension"], ["Solana", "the Solana signers"], ["Tempo", "the Tempo credential source"], ["settlement receipt", "the facilitator receipt payer"]]) {
    ok(reads.includes(needle), `dataHandling.readsOnly names ${what}`);
  }
  ok(/payer/.test(String(m.payment.dataHandling?.retains || "")), "dataHandling says the sales ledger keeps the payer of a sale");
}
// The heartbeat figure is the interval of the observer that actually keeps it:
// the Cloudflare cron in workers/status-probe/wrangler.toml. It said 15, the
// GitHub schedule's REQUEST, which GitHub delivers far less often.
{
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../workers/status-probe/wrangler.toml", import.meta.url), "utf8");
  const cron = toml.match(/crons\s*=\s*\["\*\/(\d+) \* \* \* \*"\]/);
  ok(cron, "the status-probe worker declares a minute-interval cron");
  ok(m.trust?.productionHeartbeatMinutes === Number(cron[1]), `productionHeartbeatMinutes matches the worker cron (${m.trust?.productionHeartbeatMinutes} vs ${cron[1]})`);
  // The crawl cadence is the crawler's timer, not a typed figure ("crawl: 300"
  // stood here while the crawler ran every 1800 s).
  const { CRAWL_INTERVAL_SECONDS } = await import("../src/crawl-cadence.js");
  ok(m.discovery?.refreshSeconds?.crawl === CRAWL_INTERVAL_SECONDS && CRAWL_INTERVAL_SECONDS > 300, `refreshSeconds.crawl is the crawler's own interval (${m.discovery?.refreshSeconds?.crawl} vs ${CRAWL_INTERVAL_SECONDS})`);
}

ok(m.capabilities.tools === 3, "capability tool count");
const webCat = m.capabilities.categories.find((c) => c.key === "web");
const encCat = m.capabilities.categories.find((c) => c.key === "encoding");
ok(webCat && webCat.tools === 1 && webCat.computePayable === false, "web category rollup");
ok(encCat && encCat.computePayable === true, "encoding category is compute-payable (hash)");

ok(m.mcp.remoteConnector === `${BASE}/mcp`, "mcp connector url");
ok(m.machineReadable.reliability === `${BASE}/api/reliability`, "links to reliability");
ok(m.trust.onchainRevenueProof.includes("basescan.org") && m.trust.onchainRevenueProof.includes(WALLET), "onchain proof url");
ok(m.trust.failedCallsNeverCharged === "structural", "manifest carries the structural no-charge-on-failure guarantee");

// Sepolia + no-wallet edge cases must not throw or fabricate proof links.
const mTest = serviceManifest({
  baseUrl: BASE, network: "base-sepolia", networks: ["base-sepolia"],
  wallet: null, walletName: null, catalog: CATALOG, toolCount: 3,
  powSlugs: POW, powDifficulty: 20, prices: PRICES,
});
ok(mTest.payment.x402.payTo === null, "null wallet -> null payTo");
ok(mTest.trust.onchainRevenueProof === null, "no wallet -> no proof link");

// Whole thing must serialize (it's served as JSON).
JSON.parse(JSON.stringify(m));

// ---- reliabilityReport ----
const stats = {
  servingSince: "2026-01-01T00:00:00.000Z",
  processUptimeSeconds: 12345,
  toolCallsServed: { total: 100, viaUSDC: 60, viaProofOfWork: 40 },
};
const r = reliabilityReport({ baseUrl: BASE, network: "base", wallet: WALLET, stats });
// `status` MIRRORS what the outside observers measured (/api/status overall),
// it is not this endpoint's own opinion: the two surfaces contradicted each
// other in the same minute before 2026-08-28. With no observation passed it
// says "serving" - never "operational", which would be a claim we cannot make
// about ourselves from inside the process.
ok(r.service === "Agent402.Tools" && r.status === "serving" && r.statusMeasuredFrom === `${BASE}/api/status`, `reliability identity + measured status (got ${r.status})`);
ok(reliabilityReport({ baseUrl: BASE, network: "base", wallet: WALLET, stats, observedStatus: "degraded" }).status === "degraded", "an observed degraded state is reported, never overwritten with operational");
ok(r.processUptimeSeconds === 12345 && r.toolCallsServed.total === 100, "reliability pulls live stats");
ok(r.onchain.revenueProof.includes(WALLET), "reliability onchain proof");
ok(Array.isArray(r.guarantees) && r.guarantees.length >= 5, "guarantees listed");
ok(r.guarantees.every((g) => typeof g.claim === "string" && (g.verify || g.evidence)), "every guarantee has a claim + a verify/evidence link");
ok(r.endpoints.manifest === `${BASE}/.well-known/x402`, "reliability points back to manifest");
JSON.parse(JSON.stringify(r));

// No-wallet reliability must not fabricate a proof link.
const r2 = reliabilityReport({ baseUrl: BASE, network: "base", wallet: null, stats });
ok(r2.onchain.revenueProof === null, "no wallet -> null reliability proof");

// ---- the CI guarantee's metered count is derived, never typed ----
{
  const { meteredSkip, METERED_SLUGS } = await import("../src/metered-slugs.js");
  const { readFileSync } = await import("node:fs");
  const metered = [...METERED_SLUGS][0];
  const cat = {
    "POST /api/a": { slug: "a", price: "$0.001" },
    [`POST /api/${metered}`]: { slug: metered, price: "$0.02" },
    "POST /api/skill/pk": { slug: "skill-pk", price: "$0.01" },
    "POST /api/skill/clean": { slug: "skill-clean", price: "$0.01" },
    "GET /api/free": { slug: "free", price: "$0" },
  };
  const packs = [{ slug: "pk", toolSlugs: ["a", metered] }, { slug: "clean", toolSlugs: ["a"] }];
  const ms = meteredSkip(cat, packs);
  ok(ms.metered === 2 && ms.total === 4, `meteredSkip counts the metered slug and the pack reaching it, over priced routes only (got ${JSON.stringify(ms)})`);
  const claim = reliabilityReport({ baseUrl: BASE, network: "base", wallet: WALLET, stats, meteredSkip: ms }).guarantees[0].claim;
  ok(/2 of this server's 4 priced routes/.test(claim), `the CI guarantee states the derived count (${claim})`);
  ok(!/\$\{/.test(claim), "no unrendered template in the claim");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/meteredSkip: meteredSkip\(CATALOG, SKILL_PACKS\)/.test(server), "/api/reliability passes the live catalog's count");
  const sweep = readFileSync(new URL("./test-non-metered-examples.js", import.meta.url), "utf8");
  ok(/import \{ METERED_SLUGS, meteredPackSlugs \} from "\.\.\/src\/metered-slugs\.js"/.test(sweep) && !/METERED_SLUGS = new Set\(/.test(sweep), "the sweep reads the same list (no second copy in scripts/)");
}

console.log("test-discovery: OK");
