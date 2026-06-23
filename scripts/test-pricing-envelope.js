// /api/pricing is the public catalog dump that every external scraper +
// listing portal + the tollbooth + the buyer SDK reads to enumerate tools.
// The shape has stayed stable for the entire history of the project; a
// silent rename here (path → route, slug → id) breaks every downstream
// integration simultaneously.
//
// This test boots FREE_MODE and locks:
//
//   1. GET /api/pricing → 200 application/json.
//   2. Top-level envelope: name, description, payment, altPayment, baseUrl,
//      openapi, categories[], endpoints[].
//   3. baseUrl matches the BASE we hit (so a misconfigured proxy doesn't
//      silently rewrite the catalog's self-reference).
//   4. payment block carries protocol/network/currency (the x402 deal),
//      altPayment is the PoW summary.
//   5. categories[] is a non-empty array — homepage chips iterate over it.
//   6. endpoints[] floor: >= 1000 (catalog must stay above the announced
//      "1000+ tools" mark).
//   7. Per-endpoint shape: method, path, price, category, slug, description,
//      docs, computePayable. These are the columns the listing portals
//      scrape; a missing computePayable would silently make PoW eligibility
//      invisible to discovery.
//   8. method is a known HTTP verb; path starts with /api/; price is a
//      display string ("$X.XXX"); slug is non-empty; docs is a URL on BASE;
//      computePayable is a boolean.
//
//   node scripts/test-pricing-envelope.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3095;
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

  const res = await fetch(`${BASE}/api/pricing`);
  ok(res.status === 200, `/api/pricing → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("application/json"), "content-type is application/json");
  const body = await res.json();

  for (const k of ["name", "description", "payment", "altPayment", "baseUrl", "openapi", "categories", "endpoints"]) {
    ok(k in body, `envelope key '${k}' present (got: ${Object.keys(body).join(",")})`);
  }
  ok(body.name === "Agent402", `name='Agent402' (got ${body.name})`);
  ok(typeof body.description === "string" && body.description.length > 0, `description is non-empty`);
  ok(body.baseUrl === BASE, `baseUrl matches BASE (got ${body.baseUrl}, expected ${BASE}) — proxy guard`);
  ok(typeof body.openapi === "string" && body.openapi.endsWith("/openapi.json"), `openapi URL ends with /openapi.json (got ${body.openapi})`);

  // Payment + altPayment blocks.
  ok(typeof body.payment === "object" && body.payment != null, `payment is an object`);
  ok(body.payment.protocol === "x402", `payment.protocol='x402' (got ${body.payment.protocol})`);
  ok(body.payment.currency === "USDC", `payment.currency='USDC' (got ${body.payment.currency})`);
  ok(typeof body.payment.network === "string" && body.payment.network.length > 0, `payment.network is non-empty (got ${body.payment.network})`);
  ok(typeof body.altPayment === "object" && body.altPayment != null, `altPayment is an object (PoW summary)`);

  // Categories — a map of `id → display name`, not an array. The homepage
  // chips render the displayName, the SDK groups by id.
  ok(typeof body.categories === "object" && body.categories != null && !Array.isArray(body.categories), `categories is an object (id → display map)`);
  ok(Object.keys(body.categories).length > 0, `categories has >= 1 entry (got ${Object.keys(body.categories).length})`);

  // Endpoints floor.
  ok(Array.isArray(body.endpoints) && body.endpoints.length >= 1000, `endpoints has >= 1000 entries (got ${body.endpoints?.length}) — "1000+ tools" announced floor`);

  // Per-endpoint shape. Walk every row so a silent drop on row 847 surfaces.
  let shapeOk = 0;
  const verbSet = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);
  for (const ep of body.endpoints) {
    if (!verbSet.has(ep.method)) { fail(`endpoint method not a known verb (got '${ep.method}' for slug=${ep.slug})`); break; }
    if (typeof ep.path !== "string" || !ep.path.startsWith("/api/")) { fail(`endpoint path doesn't start with /api/ (got '${ep.path}' for slug=${ep.slug})`); break; }
    if (typeof ep.price !== "string" || !ep.price.startsWith("$")) { fail(`endpoint price isn't a $-prefixed string (got '${ep.price}' for slug=${ep.slug})`); break; }
    if (typeof ep.slug !== "string" || !ep.slug.length) { fail(`endpoint slug missing or empty (got '${ep.slug}')`); break; }
    if (typeof ep.category !== "string" || !ep.category.length) { fail(`endpoint category missing (slug=${ep.slug})`); break; }
    if (typeof ep.description !== "string" || !ep.description.length) { fail(`endpoint description missing (slug=${ep.slug})`); break; }
    if (typeof ep.docs !== "string" || !ep.docs.startsWith(BASE)) { fail(`endpoint docs isn't a URL on BASE (got '${ep.docs}' for slug=${ep.slug})`); break; }
    // computePayable is what tells listing portals + the SDK which tools
    // are PoW-eligible (free tier). A missing or non-boolean value would
    // silently hide that signal.
    if (typeof ep.computePayable !== "boolean") { fail(`endpoint computePayable isn't boolean (got '${ep.computePayable}' for slug=${ep.slug})`); break; }
    shapeOk++;
  }
  ok(shapeOk === body.endpoints.length, `every endpoint matches shape (${shapeOk}/${body.endpoints.length})`);

  // Slug uniqueness — two endpoints sharing a slug would silently shadow
  // each other in /api/find and the SDK.
  const slugSet = new Set();
  let dupCount = 0;
  for (const ep of body.endpoints) {
    if (slugSet.has(ep.slug)) dupCount++;
    slugSet.add(ep.slug);
  }
  ok(dupCount === 0, `slugs are unique (got ${dupCount} duplicates across ${body.endpoints.length} endpoints)`);

  console.log(`\n${pass} passed (${body.endpoints.length} endpoints, ${Object.keys(body.categories).length} categories, payment=${body.payment.network})`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
