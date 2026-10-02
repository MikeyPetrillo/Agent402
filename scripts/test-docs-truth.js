#!/usr/bin/env node
// Docs-vs-catalog truth gate. Requires a booted server:
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-docs-truth.js
//
// WHY: the single most repeated defect in this repo is a FACT COPIED BY HAND
// into prose and then left behind when the code moved. One audit found, across
// the wiki and README alone: twelve wrong prices in one table, ~20 routes and
// slugs that 404, twelve skill packs that do not exist, and a price ceiling
// claim that was 75x under the real maximum. Nothing compared any of it to the
// catalog, so it all rotted silently and shipped to a public wiki.
//
// This test compares the DOCS to the SERVED CATALOG:
//   1. every /api/... route mentioned in docs exists (no dead routes)
//   2. every price stated next to a route matches that route's real price
//   3. every /tools/<slug> and /skills/<slug> link resolves to a real entry
//   4. no doc states an exact catalog count (those must stay evergreen)
//
// It is deliberately conservative: it only judges a price when the doc puts one
// adjacent to a specific route, because that is the pattern that misleads a
// buyer. Prose ranges are left to humans.
const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Routes a server lists only when their service is configured: the decide
// service needs its own deployment and database, so a CI boot without it
// does not serve them though production does (POST /api/decide etc.).
const CONFIG_GATED_ROUTES = new Set(["/api/decide", "/api/decide/execute", "/api/decide/feedback"]);


const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
const packs = await (await fetch(`${TARGET}/api/skill-packs.json`)).json();
// /llms.txt quotes a price beside ~40 routes in prose. Those numbers were
// hand-typed until 2026-09-10 and eleven were stale; they are derived from the
// catalog now, and this pins that every "`METHOD /api/slug` ($x)" in the served
// text equals the live price for that slug (an unknown slug prints no number).
{
  const llms = await (await fetch(`${TARGET}/llms.txt`)).text();
  const bySlug = Object.fromEntries((pricing.endpoints || []).map((e) => [e.slug, String(e.price || "")]));
  const re = /`(?:GET|POST) \/api\/([a-z0-9-]+)` \((\$[0-9.]+)\)/g;
  let m, seen = 0, stale = 0;
  while ((m = re.exec(llms))) {
    seen++;
    const live = bySlug[m[1]];
    if (!live || Number(live.replace("$", "")) !== Number(m[2].replace("$", ""))) { stale++; console.log(`STALE llms.txt price: ${m[1]} says ${m[2]}, catalog says ${live || "(no such slug)"}`); }
  }
  console.log(`llms.txt: ${seen} route prices checked, ${stale} stale`);
  if (seen < 20 || stale) { console.error(`FAIL: llms.txt route prices (${seen} seen, ${stale} stale)`); process.exit(1); }
}
const routeByPath = new Map();   // "/api/x" -> { price, method }
const priceBySlug = new Map();
for (const e of pricing.endpoints || []) {
  routeByPath.set(e.path, { price: e.price, method: e.method });
  priceBySlug.set(e.slug, e.price);
}
const packSlugs = new Set((packs.packs || []).map((p) => p.slug));
ok(routeByPath.size > 400, `catalog loaded from the server (${routeByPath.size} routes)`);

/** Docs we hold to this standard. Excludes release notes and changelogs, which
 *  are point-in-time records and are SUPPOSED to preserve old numbers. */
function docFiles() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "releases" && name !== "node_modules" && name !== "internal") walk(p); continue; }
      if (name.endsWith(".md")) out.push(p);
    }
  };
  walk(join(ROOT, "wiki"));
  walk(join(ROOT, "docs"));
  for (const f of ["README.md", "llms-install.md", "mcp/README.md", "client/README.md", "tollbooth/README.md"]) {
    const p = join(ROOT, f);
    if (existsSync(p)) out.push(p);
  }
  return out.filter((p) => !/CHANGELOG|ecosystem-listings|submission/i.test(p));
}

const files = docFiles();
ok(files.length > 10, `documentation files under test (${files.length})`);

// Routes that are real but deliberately absent from the paid catalog (free
// surfaces, operator-only, or protocol paths served outside CATALOG).
const KNOWN_NON_CATALOG = new Set([
  // --- /v1, added when the route scan was widened past /api on 2026-08-24 ---
  // Free and informational, not priced catalog entries (same class as the /api
  // surfaces below).
  "/v1/models",
  // Prose referring to a BASE URL a caller points an SDK at, not a route:
  // "point the Anthropic SDK at https://agent402.tools/v1 (or /v1/pro,
  // /v1/premium)".
  "/v1/", "/v1/pro", "/v1/premium", "/v1/nano", "/v1/auto", "/v1/grounded",
  // Same class: the base URL an SDK is pointed at to reach the metered wires
  // ("point your SDK's base URL at /v1/metered"). It also answers a free
  // gateway index JSON of its own; the priced routes under it are checked.
  "/v1/metered",
  // Real and PRICED, but env-gated on OPENROUTER_TTS_ENABLED, so a FREE_MODE
  // catalog does not carry it and this gate would call it dead. Its price is
  // therefore NOT checked here; it is checked on prod, where the route exists.
  "/v1/audio/speech",
  "/api/pricing", "/api/find", "/api/index", "/api/route", "/api/stats", "/api/wishes",
  "/api/sales", "/api/revenue", "/api/revenue/daily", "/api/revenue/mpp", "/api/calls/daily",
  "/api/reliability", "/api/status", "/api/status/probe", "/api/leaderboard", "/api/analytics",
  "/api/cacheable", "/api/cache-stats", "/api/pow", "/api/pow/challenge", "/api/skill-packs.json",
  "/api/index/register", "/api/x402-economy", "/api/gateway-status", "/api/selfcheck",
  "/api/tollbooth/waitlist", "/api/wish", "/api/route/execute", "/api/skill-packs",
  "/api/health", "/api/route/external-debug", "/api/market",
  "/api/mpp-index", "/api/mpp-leaderboard", "/api/mpp-index/register",
  // Free refund-ledger lookup by settlement tx (app.get/post in server.js), quoted by /why.
  "/api/refunds/lookup",
  // Card front door (Stripe): served outside CATALOG, mounted with STRIPE_SECRET_KEY.
  "/api/buy", "/api/subscribe", "/api/credits/checkout", "/api/credits/claim", "/api/credits/balance",
]);

let deadRoutes = 0, priceMismatches = 0, badSlugLinks = 0, exactCounts = 0;
for (const file of files) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, "utf8");

  // 1 + 2. Routes, and a price only where the line is unambiguous.
  //
  // Line-scoped on purpose. A 60-char window after the route bled into the NEXT
  // markdown table row and reported a tier cap as that route's price - a gate
  // that cries wolf gets switched off, so it only judges a price when the line
  // contains exactly one catalog route and exactly one price.
  for (const rawLine of text.split("\n")) {
    // Source-tree paths and GitHub links are not site routes.
    const line = rawLine;
    const isSourceRef = /src\/tools\/|github\.com|blob\/main/.test(line);
    const routesOnLine = [];
    // `/api/` AND `/v1/`. This matched only /api/ until 2026-08-24, and every
    // outcome-priced report lives under /v1/ - so the eleven-row report price
    // table in the README, and the same prices restated across the wiki, were
    // invisible to the one gate that exists to catch a price copied by hand and
    // left behind. They went a day stale through a repricing with this green.
    for (const m of line.matchAll(/`?(\/(?:api|v1)\/[a-zA-Z0-9/_.-]+?)`?(?=[\s,)|`"'\]]|$)/g)) {
      let path = m[1].replace(/[.,;:]+$/, "");
      if (path.startsWith("/api/skill/")) continue;
      if (path.includes("{") || path.includes("<") || path.includes(":")) continue;
      if (KNOWN_NON_CATALOG.has(path) || path.startsWith("/api/memory")) continue;
      // "/docs/api/explorer" contains "/api/explorer" but is not that route.
      if (line.includes("/docs" + path)) continue;
      routesOnLine.push(path);
    }
    for (const path of routesOnLine) {
      if (!routeByPath.has(path) && !CONFIG_GATED_ROUTES.has(path)) {
        // An illustrative snippet defining a NEW tool is not a dead reference.
        if (/route:\s*"|example|e\.g\.|your own|placeholder/i.test(line)) continue;
        if (isSourceRef) continue;
        deadRoutes++;
        if (deadRoutes <= 12) console.error(`  dead route: ${rel} -> ${path}`);
      }
    }
    const pricesOnLine = [...line.matchAll(/\$(\d+\.\d+)/g)].map((m) => m[1]);

    // Pack price tables key on a /skills/<slug> LINK, not a route and not a
    // backticked slug, so neither check above looked at them - found when a
    // reprice left three wiki rows stale and this gate stayed green.
    if (pricesOnLine.length === 1) {
      const packs = [...line.matchAll(/\/skills\/([a-z0-9-]+)/g)].map((m) => m[1]).filter((sl) => priceBySlug.has(`skill-${sl}`));
      if (new Set(packs).size === 1) {
        const real = String(priceBySlug.get(`skill-${packs[0]}`)).replace("$", "");
        if (Number(pricesOnLine[0]) !== Number(real)) {
          priceMismatches++;
          if (priceMismatches <= 12) console.error(`  price: ${rel} -> pack ${packs[0]} says $${pricesOnLine[0]}, catalog says $${real}`);
        }
      }
    }

    // Slug-keyed price tables. The catalog table that carried TWELVE wrong
    // prices states them next to `slug` in backticks, not next to a /api/ route,
    // so a route-only check never looked at the worst file in the repo.
    if (routesOnLine.length === 0 && pricesOnLine.length === 1) {
      const slugs = [...line.matchAll(/`([a-z0-9][a-z0-9-]{2,})`/g)].map((m) => m[1]).filter((sl) => priceBySlug.has(sl));
      if (slugs.length === 1) {
        const real = String(priceBySlug.get(slugs[0])).replace("$", "");
        if (Number(pricesOnLine[0]) !== Number(real)) {
          priceMismatches++;
          if (priceMismatches <= 12) console.error(`  price: ${rel} -> \`${slugs[0]}\` says $${pricesOnLine[0]}, catalog says $${real}`);
        }
      }
    }

    // N routes and N prices on one row are PAIRED IN ORDER. The one-and-one
    // rule below is the safe case; a row like
    //   | `POST /v1/dossier` · `/v1/dossier/max` | $0.85 · $1.10 | ... |
    // has two of each and was skipped as ambiguous, which is most of the README
    // report table. It went a day stale through a repricing with this gate
    // green, and restoring the stale figures still passed. Pairing positionally
    // is what a reader does with that row, so it is what the check should do.
    // Only when the counts match and every route is a real one, so a sentence
    // that happens to mention two routes and two unrelated figures is untouched.
    const pairable = routesOnLine.length > 1
      && routesOnLine.length === pricesOnLine.length
      && routesOnLine.every((r) => routeByPath.has(r));
    if (pairable) {
      for (let i = 0; i < routesOnLine.length; i++) {
        const real = String(routeByPath.get(routesOnLine[i]).price).replace("$", "");
        if (Number(pricesOnLine[i]) !== Number(real)) {
          priceMismatches++;
          if (priceMismatches <= 12) console.error(`  price: ${rel} -> ${routesOnLine[i]} says $${pricesOnLine[i]}, catalog says $${real}`);
        }
      }
    }

    if (routesOnLine.length === 1 && pricesOnLine.length === 1 && routeByPath.has(routesOnLine[0])) {
      const real = String(routeByPath.get(routesOnLine[0]).price).replace("$", "");
      if (Number(pricesOnLine[0]) !== Number(real)) {
        priceMismatches++;
        if (priceMismatches <= 12) console.error(`  price: ${rel} -> ${routesOnLine[0]} says $${pricesOnLine[0]}, catalog says $${real}`);
      }
    }
  }

  // 3. /tools/<slug> and /skills/<slug> links must resolve.
  // Only SITE links, never repo paths: "src/tools/x402-kit.js" is a module, not
  // a tool page, and matching it reported four phantom dead links.
  for (const m of text.matchAll(/(?:agent402\.tools|\]\(|^|\s)(\/tools\/([a-z0-9-]+))/gm)) {
    const slug = m[2];
    const at = m.index ?? 0;
    const ctx = text.slice(Math.max(0, at - 30), at + 40);
    if (/src\/tools|github\.com|blob\/main|\.js/.test(ctx)) continue;
    if (slug === "category" || priceBySlug.has(slug)) continue;
    badSlugLinks++;
    if (badSlugLinks <= 12) console.error(`  dead tool link: ${rel} -> /tools/${slug}`);
  }
  for (const m of text.matchAll(/\/skills\/([a-z0-9-]+)/g)) {
    if (packSlugs.has(m[1])) continue;
    badSlugLinks++;
    if (badSlugLinks <= 12) console.error(`  dead pack link: ${rel} -> /skills/${m[1]}`);
  }

  // 4. Exact catalog counts must not appear in docs - they rot on every commit
  //    that adds a tool. The house rule is evergreen ("500+", "100+").
  const total = routeByPath.size;
  for (const bad of [String(total), String((packs.packs || []).length)]) {
    const re = new RegExp(`(?<![\\d.+])${bad}(?!\\+)(?![\\d.])\\s*(tools|endpoints|skill packs|packs)`, "gi");
    for (const m of text.matchAll(re)) {
      exactCounts++;
      if (exactCounts <= 8) console.error(`  exact count: ${rel} -> "${m[0].trim()}" (use an evergreen form)`);
    }
  }
}

ok(deadRoutes === 0, `no documentation references a route the server does not serve (${deadRoutes} found)`);
ok(priceMismatches === 0, `every price stated beside a route matches the catalog (${priceMismatches} mismatched)`);
ok(badSlugLinks === 0, `every /tools and /skills link resolves to a real entry (${badSlugLinks} dead)`);
ok(exactCounts === 0, `no doc hard-codes an exact catalog count (${exactCounts} found)`);

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
