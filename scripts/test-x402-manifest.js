// /.well-known/x402 is the x402 service-discovery surface. Buyer SDKs, the
// Coinbase Bazaar crawler, and any agent that wants to know "what does this
// host sell, on what network, at what price?" reads it first. Silent renames
// or shape drift here mean buyers can't reach the seller — the listing exists
// but the discovery payload doesn't carry the expected fields.
//
// This test boots FREE_MODE, fetches the manifest, and locks every contract
// that downstream consumers depend on:
//
//   1. Envelope shape: spec, name, summary, homepage, payment, capabilities,
//      discovery, mcp — the documented top-level keys. A wholesale schema
//      rewrite surfaces here as missing keys.
//   2. payment.x402: version (number), currency, networks[] (non-empty),
//      primaryNetwork (one of networks), payToName, nonCustodial=true. These
//      are exactly what an x402 client reads to construct a payment.
//   3. payment.proofOfWork: challengeUrl, info, difficultyBits, eligibleTools
//      — what an agent reads to know it can pay with CPU instead of USDC.
//   4. capabilities.tools is a number > 1000 (current catalog is ~1199; a
//      regression that drops a whole kit would shrink this materially).
//   5. capabilities.categories is a non-empty array with {key, label, tools,
//      priceRange} on each row (consumed by the shop/landing surfaces and
//      external discovery aggregators).
//   6. discovery.spec === 'x402-discovery/1' (versioned contract; any bump
//      should be deliberate and shouldn't sneak through a refactor).
//   7. mcp.remoteConnector and mcp.package are present — the buyer-facing
//      "how do I plug this into Claude/Cursor?" answer.
//
//   node scripts/test-x402-manifest.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3093;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  const res = await fetch(`${BASE}/.well-known/x402`);
  ok(res.status === 200, `/.well-known/x402 → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("application/json"), "content-type is application/json");
  const m = await res.json();

  // Envelope shape. The documented top-level keys downstream consumers expect.
  for (const k of ["spec", "name", "summary", "homepage", "payment", "capabilities", "discovery", "mcp"]) {
    ok(k in m, `top-level key '${k}' present (got: ${Object.keys(m).join(",")})`);
  }
  // spec is the manifest version string (currently 'agent402-service-manifest/1');
  // any change should be deliberate — pin the exact value.
  ok(m.spec === "agent402-service-manifest/1", `spec='agent402-service-manifest/1' (got ${m.spec})`);

  // payment.x402 — what a buyer reads to construct a payment.
  const x = m.payment?.x402;
  ok(x && typeof x === "object", "payment.x402 is an object");
  ok(typeof x.version === "number", `payment.x402.version is a number (got ${typeof x?.version})`);
  ok(x.currency === "USDC", `payment.x402.currency=USDC (got ${x?.currency})`);
  ok(Array.isArray(x.networks) && x.networks.length > 0, `payment.x402.networks is non-empty array (got ${JSON.stringify(x?.networks)})`);
  ok(typeof x.primaryNetwork === "string" && x.networks.includes(x.primaryNetwork), `primaryNetwork is in networks[] (primary=${x?.primaryNetwork}, networks=${JSON.stringify(x?.networks)})`);
  ok(typeof x.payToName === "string" && x.payToName.length > 0, `payToName is non-empty (got ${x?.payToName})`);
  ok(x.nonCustodial === true, `nonCustodial=true (got ${x?.nonCustodial})`);

  // payment.proofOfWork — the free-tier path.
  const pow = m.payment?.proofOfWork;
  ok(pow && typeof pow === "object", "payment.proofOfWork is an object");
  ok(typeof pow.challengeUrl === "string" && pow.challengeUrl.endsWith("/api/pow/challenge"), `proofOfWork.challengeUrl ends with /api/pow/challenge (got ${pow?.challengeUrl})`);
  ok(typeof pow.info === "string" && pow.info.length > 0, `proofOfWork.info is a non-empty URL (got ${pow?.info})`);
  ok(typeof pow.difficultyBits === "number" && pow.difficultyBits > 0, `proofOfWork.difficultyBits is a positive number (got ${pow?.difficultyBits})`);
  ok(typeof pow.eligibleTools === "number" && pow.eligibleTools > 0, `proofOfWork.eligibleTools is a positive number (got ${pow?.eligibleTools})`);

  // capabilities.tools count: a kit drop would shrink this. 1000 is a floor
  // chosen well below the current ~1199 — if we ever drop below it, that's a
  // real regression, not a planned trim.
  ok(typeof m.capabilities?.tools === "number", `capabilities.tools is a number (got ${typeof m.capabilities?.tools})`);
  ok(m.capabilities.tools >= 1000, `capabilities.tools >= 1000 (got ${m.capabilities.tools}) — under this floor means a kit went missing`);

  // capabilities.categories — per-category breakdown for discovery aggregators.
  ok(Array.isArray(m.capabilities?.categories) && m.capabilities.categories.length > 0, `capabilities.categories is a non-empty array (got length ${m.capabilities?.categories?.length})`);
  const cat = m.capabilities.categories[0];
  for (const k of ["key", "label", "tools", "priceRange"]) {
    ok(k in cat, `category row carries ${k} (got keys: ${Object.keys(cat).join(",")})`);
  }

  // discovery contract — versioned, and downstream services pin against the
  // spec string. A version bump should be deliberate.
  ok(m.discovery?.spec === "x402-discovery/1", `discovery.spec='x402-discovery/1' (got ${m.discovery?.spec})`);
  ok(typeof m.discovery?.neutralRouter === "string" && m.discovery.neutralRouter.endsWith("/api/route"), `discovery.neutralRouter points at /api/route (got ${m.discovery?.neutralRouter})`);
  ok(typeof m.discovery?.leaderboard === "string" && m.discovery.leaderboard.endsWith("/api/leaderboard"), `discovery.leaderboard points at /api/leaderboard (got ${m.discovery?.leaderboard})`);

  // mcp section — buyer-facing "plug this into Claude" answer.
  ok(typeof m.mcp?.remoteConnector === "string" && m.mcp.remoteConnector.endsWith("/mcp"), `mcp.remoteConnector ends with /mcp (got ${m.mcp?.remoteConnector})`);
  ok(m.mcp?.package === "agent402-mcp", `mcp.package is agent402-mcp (got ${m.mcp?.package})`);

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
