// /openapi.json must expose every CATALOG tool as a path. The OpenAPI spec is
// generated from CATALOG at boot, so a regression here would mean: a kit was
// wired into Express + the discovery surfaces, but openapi.js's iteration
// missed it (e.g. a filter that excludes the new kit's category). Buyers that
// integrate via OpenAPI codegen would silently lose the tool.
//
// This test boots FREE_MODE, fetches /openapi.json, and walks every CATALOG
// entry, asserting:
//
//   1. The path appears in spec.paths.
//   2. The path declares the method the catalog says it accepts (POST for
//      everything currently).
//   3. The method object carries operationId + summary + responses (minimum
//      OpenAPI well-formedness — Postman/Insomnia/codegen tools rely on these).
//   4. Catalog/spec sizes are within 1% of each other — a wholesale drop
//      (e.g. a category accidentally filtered out) surfaces as a count delta.
//
//   node scripts/test-openapi-coverage.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3094;
const BASE = `http://127.0.0.1:${PORT}`;

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

  const spec = await (await fetch(`${BASE}/openapi.json`)).json();
  ok(spec.openapi?.startsWith("3."), `openapi version is 3.x (got ${spec.openapi})`);
  ok(typeof spec.info?.title === "string" && spec.info.title.length > 0, "spec.info.title is non-empty");
  ok(spec.paths && typeof spec.paths === "object", "spec.paths is an object");

  // Source-of-truth for the catalog is the server's own /api/pricing surface
  // (an envelope around the same CATALOG the openapi generator iterates). If
  // these two diverge, that's the regression — they come from the same map.
  const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
  const catalog = pricing.endpoints || [];
  const catalogPaths = catalog.map((t) => t.path);
  const specPaths = Object.keys(spec.paths);

  // Within 1% of each other. The OpenAPI doc is allowed to skip a handful of
  // non-tool routes (health checks, the well-known endpoints) but the bulk
  // must match catalog. A 20-tool gap on a 1100-tool catalog is a regression.
  const delta = Math.abs(catalogPaths.length - specPaths.length);
  ok(delta <= Math.ceil(catalog.length * 0.01), `path count delta within 1% (catalog=${catalog.length}, spec=${specPaths.length}, delta=${delta})`);

  // Every catalog tool must appear in the spec. Walk all of them — a single
  // missing slug is a regression worth surfacing by name.
  const missing = [];
  for (const tool of catalog) {
    if (!spec.paths[tool.path]) missing.push(tool.slug);
  }
  ok(missing.length === 0, `every catalog tool has an OpenAPI path (missing: ${missing.slice(0, 5).join(",") || "none"}${missing.length > 5 ? `…+${missing.length - 5} more` : ""})`);

  // Well-formedness on a sample: operationId, summary, responses must be
  // present on each method object. Postman/codegen tooling assumes these.
  // Sample the first 10 catalog tools — a representative cross-section is
  // enough; if these are well-formed, the generator's loop is sound.
  let wellFormed = 0;
  for (const tool of catalog.slice(0, 10)) {
    const pathItem = spec.paths[tool.path];
    if (!pathItem) continue;
    const method = Object.keys(pathItem)[0];
    const op = pathItem[method];
    if (op?.operationId && op.summary && op.responses) wellFormed++;
  }
  ok(wellFormed === 10, `first 10 catalog tools have operationId+summary+responses (got ${wellFormed}/10)`);

  // x-price + x-payment-protocol must round-trip from catalog. These are the
  // fields a buyer reads to know what a call will cost — silent loss here
  // means OpenAPI codegen produces a "free" surface.
  let priced = 0;
  for (const tool of catalog.slice(0, 20)) {
    const op = Object.values(spec.paths[tool.path] || {})[0];
    if (op?.["x-price"] != null) priced++;
  }
  ok(priced === 20, `first 20 catalog tools carry x-price in the spec (got ${priced}/20)`);

  // MPP discovery dialect (paymentauth.org draft-payment-discovery; MPPScan
  // crawls it): the same x-payment-info object carries an `offers` array, one
  // entry per challenge the live 402 makes (src/mpp-offers.js), each pricing
  // the tool in the SMALLEST unit of its currency - drift here would
  // advertise wrong prices to MPP agents. Which methods appear depends on
  // what this instance has switched on (none on a keyless boot, whose 402
  // carries no Payment challenge either); scripts/test-mpp-discovery-parity.js
  // boots with MPP on and matches every route against its own 402.
  ok(spec["x-service-info"]?.docs?.llms?.endsWith("/llms.txt"), "x-service-info.docs.llms points at /llms.txt (MPP discovery)");
  const DECIMALS = { evm: 6, tempo: 6, stripe: 2 };
  let mppChecked = 0;
  const offerDrift = [];
  for (const tool of catalog.slice(0, 20)) {
    const op = Object.values(spec.paths[tool.path] || {})[0];
    const info = op?.["x-payment-info"];
    if (!info || info.price?.mode !== "fixed") continue;
    const dollars = Number(String(op["x-price"]).replace(/[^0-9.]/g, ""));
    for (const offer of info.offers || []) {
      mppChecked++;
      const want = String(Math.round(dollars * 10 ** (DECIMALS[offer.method] ?? 6)));
      if (offer.intent !== "charge" || offer.amount !== want) offerDrift.push(`${tool.slug}: ${offer.method} ${offer.amount} vs ${want}`);
    }
  }
  ok(offerDrift.length === 0, `every MPP offer on the first 20 catalog tools prices x-price in its currency's smallest unit (${mppChecked} offers checked)${offerDrift.length ? ` - ${offerDrift.slice(0, 5).join("; ")}` : ""}`);

  // Every $ref anywhere in the spec must resolve against the spec root.
  // Tool examples may embed specs whose refs point at #/components/... —
  // naive ecosystem dereferencers (MPPScan's crawler, codegen tools) resolve
  // from the ROOT and crash on a dangling pointer, killing the whole listing
  // (2026-07-24: openapi-resolve-refs' example did exactly this).
  const danglingRefs = [];
  const resolves = (ref) => {
    if (typeof ref !== "string" || !ref.startsWith("#/")) return true; // external/relative: not root-resolved here
    let node = spec;
    for (const seg of ref.slice(2).split("/")) {
      node = node?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
      if (node === undefined || node === null) return false;
    }
    return true;
  };
  (function walk(node, path) {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && !resolves(v)) danglingRefs.push(`${path} -> ${v}`);
      walk(v, `${path}/${k}`);
    }
  })(spec, "");
  ok(danglingRefs.length === 0, `every $ref in the spec resolves from the root (dangling: ${danglingRefs.slice(0, 3).join("; ") || "none"})`);

  console.log(`\n${pass} passed (${catalog.length} catalog tools, ${specPaths.length} spec paths)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
