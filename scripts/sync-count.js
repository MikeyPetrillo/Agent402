// Catalog-count consistency gate — evergreen edition.
//
//   node scripts/sync-count.js          # verify (same checks as --check)
//   node scripts/sync-count.js --check  # exit 1 on violation (CI guard)
//
// Marketing/static surfaces (README, wiki, docs, package descriptions, served
// page copy) now say an evergreen "500+ tools" instead of the exact total, so
// adding tools never requires a doc sweep again. Machine-readable surfaces
// (/api/pricing, /openapi.json, /health, /.well-known/x402, docs.js
// `${catalog.length}`) derive the exact count at runtime and are untouched.
//
// The old behavior — a repo-wide textual replace of the previous exact total —
// is RETIRED: at the 500→501 bump it rewrote every standalone "500" in the
// repo, including HTTP statuses (`res.status(500)` → 501), CSS font-weights,
// font filenames, size caps, and even a tool price. Never bring the numeric
// sweep back. If the brand floor ever moves (e.g. to "1,000+"), that's a rare,
// deliberate rebrand: update BRAND_FLOOR here, then hand-edit the "500+"
// phrases (they're grep-able and unambiguous).
//
// What this script still enforces, live from the booted server (can't be
// gamed by editing a doc):
//   1. THE FLOOR — the catalog must never fall below 400 entries; a drop that
//      size means a kit fell off the build, not a curation decision. There is
//      NO upper bound: the catalog grows when a tool is worth calling.
//   2. HONESTY — the evergreen "500+" claim must be true: total >= 500.
//   3. ANCHOR: the README's lead (above its first "## ") must carry the
//      literal "500+ ready tools" supporting line, and its H1 no tool count
//      at all: marketing leads with the payment and trust layer, and the
//      flagship surface can't silently drift back to an exact count.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CATALOG_FLOOR = 400;
export const BRAND_FLOOR = 500; // the number in the public "500+" claim
// The number in the public "70+ skill packs" claim (README, wiki). Five surfaces -
// two of them PUBLISHED npm READMEs - once said "100+ skill packs" against a
// real 85, and the pack count was already being read here for the summary line
// without anything asserting on it. A count printed but never checked is how
// the claim drifted. The packs that run a stock tool are listed only with an
// active stock provider, so the claim holds on a boot with none.
export const PACK_BRAND_FLOOR = 70;

// Returns null when the total is at or above the floor, else the CI failure
// message. Exported (and main() gated below) so the assertion is unit-testable
// without booting the server: floorViolation(399) must return the message.
export function floorViolation(total) {
  if (total >= CATALOG_FLOOR) return null;
  return `Catalog fell below the ${CATALOG_FLOOR}-entry floor (got ${total}) — a kit is probably missing.`;
}

// Returns null while the public "500+" claim is honest, else the CI failure
// message. brandViolation(499) must return the message.
export function brandViolation(total) {
  if (total >= BRAND_FLOOR) return null;
  return `Catalog (${total}) is below the public "${BRAND_FLOOR.toLocaleString("en-US")}+" claim — either restore the missing tools or rebrand the marketing surfaces.`;
}

// Returns null while the public "70+ skill packs" claim is honest, else the CI
// failure message. packBrandViolation(69) must return the message.
export function packBrandViolation(packs) {
  if (packs >= PACK_BRAND_FLOOR) return null;
  return `Skill packs (${packs}) are below the public "${PACK_BRAND_FLOOR}+ skill packs" claim - either restore the missing packs or rebrand the surfaces that say it.`;
}

async function main() {
  const PORT = 3199;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const srv = spawn("node", ["src/server.js"], { env: { ...process.env, FREE_MODE: "true", PORT: String(PORT) }, stdio: "ignore" });
  try {
    let total = 0;
    for (let i = 0; i < 40; i++) {
      try { total = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json())?.meta?.toolCount || 0; if (total) break; } catch {}
      await sleep(500);
    }
    if (!total) { console.error("sync-count: could not read the tool count from /health"); process.exit(2); }

    let packs = 0;
    try {
      const sp = await (await fetch(`http://127.0.0.1:${PORT}/api/skill-packs.json`)).json();
      packs = (sp?.packs || []).length;
    } catch {}
    if (!packs) { console.error("sync-count: could not read the pack count from /api/skill-packs.json"); process.exit(2); }

    // 1. THE FLOOR
    const floor = floorViolation(total);
    if (floor) { console.error(floor); process.exit(1); }

    // 2. HONESTY of the evergreen claim
    const brand = brandViolation(total);
    if (brand) { console.error(brand); process.exit(1); }

    // 2b. HONESTY of the pack claim, on the same terms as the tool claim.
    const packBrand = packBrandViolation(packs);
    if (packBrand) { console.error(packBrand); process.exit(1); }

    // 3. ANCHOR: the README's lead carries the evergreen "500+ ready tools"
    // supporting line, never an exact count that would rot as the catalog
    // grows, and the H1 names no tool count (the catalog is not the headline).
    const claim = `${BRAND_FLOOR.toLocaleString("en-US")}+ ready tools`;
    const readme = readFileSync("README.md", "utf8");
    const readmeH1 = readme.split("\n")[0] || "";
    const readmeLead = readme.split(/\n## /)[0];
    if (!readmeLead.includes(claim) || /\d+\+? (ready )?tools/.test(readmeH1)) {
      console.error(`sync-count: the README lead no longer carries the evergreen "${claim}" line, or its H1 names a tool count; restore it (exact counts on marketing surfaces are banned; runtime surfaces derive the real number).`);
      process.exit(1);
    }

    console.log(`sync-count: OK — catalog has ${total.toLocaleString("en-US")} entries (${total - packs} tools + ${packs} skill packs); the "${claim}" claim is honest and above the ${CATALOG_FLOOR}-entry floor. Marketing surfaces are evergreen — nothing to rewrite.`);
  } finally {
    srv.kill("SIGKILL");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
