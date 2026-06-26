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
ok(m.openSource === true && m.selfHostable === true && m.license === "MIT", "wedge flags");
ok(Array.isArray(m.differentiators) && m.differentiators.length >= 3, "differentiators present");
ok(m.twoSided?.tollbooth?.npm === "agent402-tollbooth", "tollbooth advertised");

ok(m.payment.x402.version === 2 && m.payment.x402.currency === "USDC", "x402 payment shape");
ok(JSON.stringify(m.payment.x402.networks) === JSON.stringify(["base", "polygon"]), "networks passed through");
ok(m.payment.x402.payTo === WALLET, "payTo is the wallet");
ok(m.payment.x402.priceRange === "$0.001–$0.005", `price range derived (got ${m.payment.x402.priceRange})`);
ok(m.payment.proofOfWork.difficultyBits === 20, "pow difficulty");
ok(m.payment.proofOfWork.eligibleTools === 1, "pow eligible count");

ok(m.capabilities.tools === 3, "capability tool count");
const webCat = m.capabilities.categories.find((c) => c.key === "web");
const encCat = m.capabilities.categories.find((c) => c.key === "encoding");
ok(webCat && webCat.tools === 1 && webCat.computePayable === false, "web category rollup");
ok(encCat && encCat.computePayable === true, "encoding category is compute-payable (hash)");

ok(m.mcp.remoteConnector === `${BASE}/mcp`, "mcp connector url");
ok(m.machineReadable.reliability === `${BASE}/api/reliability`, "links to reliability");
ok(m.trust.onchainRevenueProof.includes("basescan.org") && m.trust.onchainRevenueProof.includes(WALLET), "onchain proof url");

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
  uptimeSeconds: 12345,
  toolCallsServed: { total: 100, viaUSDC: 60, viaProofOfWork: 40 },
};
const r = reliabilityReport({ baseUrl: BASE, network: "base", wallet: WALLET, stats });
ok(r.service === "Agent402.Tools" && r.status === "operational", "reliability identity/status");
ok(r.uptimeSeconds === 12345 && r.toolCallsServed.total === 100, "reliability pulls live stats");
ok(r.onchain.revenueProof.includes(WALLET), "reliability onchain proof");
ok(Array.isArray(r.guarantees) && r.guarantees.length >= 5, "guarantees listed");
ok(r.guarantees.every((g) => typeof g.claim === "string" && (g.verify || g.evidence)), "every guarantee has a claim + a verify/evidence link");
ok(r.endpoints.manifest === `${BASE}/.well-known/x402`, "reliability points back to manifest");
JSON.parse(JSON.stringify(r));

// No-wallet reliability must not fabricate a proof link.
const r2 = reliabilityReport({ baseUrl: BASE, network: "base", wallet: null, stats });
ok(r2.onchain.revenueProof === null, "no wallet -> null reliability proof");

console.log("test-discovery: OK");
