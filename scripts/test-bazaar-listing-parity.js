// Every route's 402 listing at this tree keeps what the same route listed at
// the base: its description is not shorter and its sample output is not
// replaced by the /openapi.json pointer nor missing a field it had (the
// three constant licence fields of src/data-attribution.js aside, which the
// 402 sample never carries). A route the base listed is still listed, unless
// it is retired (src/retired-tools.js).
//
// Both trees boot in paid mode offline (a stub facilitator; no keys, no
// stores shared) and every route is called once without payment; the
// PAYMENT-REQUIRED header is decoded and compared.
//
// The base is BAZAAR_PARITY_BASE (any commit-ish), else the merge base with
// origin/main, else HEAD's first parent when HEAD is already on main. It
// needs git history (the lane checks out with fetch-depth 0); under CI a base
// that cannot be read fails.
//
//   node scripts/test-bazaar-listing-parity.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withoutLicenseFields } from "../src/data-attribution.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (...a) => { try { return git(...a); } catch { return ""; } };

/** The commit this tree's listings are held to. */
function baseRef() {
  if (process.env.BAZAAR_PARITY_BASE) return git("rev-parse", process.env.BAZAAR_PARITY_BASE);
  const head = git("rev-parse", "HEAD");
  for (const main of ["origin/main", "main"]) {
    const m = tryGit("rev-parse", "--verify", "--quiet", main);
    if (!m) continue;
    // HEAD already on main (a push to main): compare with the commit before it.
    if (execOk("merge-base", "--is-ancestor", head, m)) return tryGit("rev-parse", "HEAD^1") || null;
    return tryGit("merge-base", head, m) || null;
  }
  return null;
}
function execOk(...a) { try { execFileSync("git", a, { cwd: ROOT, stdio: "ignore" }); return true; } catch { return false; } }

/** The 402 of every catalog route of the server tree at `tree`. */
async function dump(tree, label) {
  const BASE_NET = "eip155:8453";
  const fac = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.url === "/supported") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE_NET }], extensions: ["bazaar"], signers: {} })); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => fac.listen(0, "127.0.0.1", r));
  const stub = `http://127.0.0.1:${fac.address().port}`;
  const env = { FREE_MODE: "", NODE_ENV: "test", NETWORK: "base", PAYMENT_NETWORKS: "base", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", FACILITATOR_URL: stub, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true", STATE_DATABASE_URL: "", REDIS_URL: "", UPSTREAM_COSTS_JSON: process.env.UPSTREAM_COSTS_JSON || "" };
  // Each tree boots through its own helper, which runs that tree's server.
  const { bootServer } = await import(pathToFileURL(join(tree, "scripts", "lib", "boot-server.js")).href);
  const srv = await bootServer({ stores: `listing-parity-${label}`, timeoutMs: 90_000, env });
  const out = new Map();
  try {
    const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
    const eps = pricing.endpoints || [];
    let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < eps.length) {
        const e = eps[i++];
        const m = String(e.method || "GET").toUpperCase();
        const key = `${m} ${e.path}`;
        try {
          const r = await fetch(`${srv.url}${e.path}`, { method: m, headers: { "content-type": "application/json" }, body: ["POST", "PUT", "PATCH"].includes(m) ? "{}" : undefined, signal: AbortSignal.timeout(20_000) });
          const h = r.headers.get("payment-required");
          await r.arrayBuffer().catch(() => {});
          out.set(key, { slug: e.slug, status: r.status, pr: h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null });
        } catch (err) { out.set(key, { slug: e.slug, err: String(err?.message || err) }); }
      }
    }));
  } finally { await srv.stop(); fac.close(); }
  return out;
}

const isPointer = (ex) => !!ex && typeof ex === "object" && ex.truncated === true && /openapi\.json/.test(String(ex.note || ""));
const exampleOf = (pr) => pr?.extensions?.bazaar?.info?.output?.example;

/** What `now` lost against `then` for one route ([] when nothing). */
export function listingLosses(then, now) {
  const lost = [];
  if (!then?.pr) return lost;
  if (!now?.pr) return [`no 402 listing (status ${now?.status ?? now?.err})`];
  const da = String(then.pr.resource?.description || ""), db = String(now.pr.resource?.description || "");
  if (db.length < da.length) lost.push(`description ${da.length} -> ${db.length} chars`);
  const ea = exampleOf(then.pr), eb = exampleOf(now.pr);
  if (ea !== undefined && eb === undefined) lost.push("sample output dropped");
  else if (ea !== undefined && !isPointer(ea) && isPointer(eb)) lost.push("sample output became the /openapi.json pointer");
  else if (ea && eb && typeof ea === "object" && typeof eb === "object" && !Array.isArray(ea) && !isPointer(ea)) {
    const gone = Object.keys(withoutLicenseFields(ea)).filter((k) => !(k in eb));
    if (gone.length) lost.push(`sample output lost ${gone.join(", ")}`);
  }
  return lost;
}

// Offline controls of the comparison.
{
  const pr = (d, ex) => ({ pr: { resource: { description: d }, extensions: { bazaar: { info: { output: { example: ex } } } } } });
  ok(listingLosses(pr("abcdef", { a: 1 }), pr("abcdef", { a: 1, b: 2 })).length === 0, "control: an unchanged or grown listing loses nothing");
  ok(listingLosses(pr("abcdef", { a: 1 }), pr("abc", { a: 1 }))[0]?.startsWith("description"), "control: a shorter description is a loss");
  ok(/pointer/.test(listingLosses(pr("a", { a: 1 }), pr("a", { truncated: true, note: "full example in /openapi.json" }))[0] || ""), "control: a sample that became the pointer is a loss");
  ok(/lost a/.test(listingLosses(pr("a", { a: 1, b: 2 }), pr("a", { b: 2 }))[0] || ""), "control: a sample missing a field is a loss");
  ok(listingLosses({ pr: null }, pr("a", {})).length === 0 && /no 402/.test(listingLosses(pr("a", {}), { status: 410 })[0] || ""), "control: a route the base did not list is not compared; one that stopped listing is a loss");
}

const ref = baseRef();
if (!ref) {
  ok(!process.env.CI, "a base commit to compare with (origin/main, main or BAZAAR_PARITY_BASE) is readable");
  if (!process.env.CI) console.log("SKIP - no base commit readable (set BAZAAR_PARITY_BASE)");
} else {
  const baseDir = mkdtempSync(join(tmpdir(), "a402-listing-parity-"));
  try {
    execFileSync("sh", ["-c", `git archive ${ref} | tar -x -C "${baseDir}"`], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    if (existsSync(join(ROOT, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(baseDir, "node_modules"), "dir");
    console.log(`base ${ref.slice(0, 9)}; head ${git("rev-parse", "--short", "HEAD")} (working tree)`);
    const then = await dump(baseDir, "base");
    const now = await dump(ROOT, "head");
    ok(then.size > 400 && now.size > 400, `both trees listed their catalog (${then.size} base, ${now.size} head)`);
    const { retiredEntryForSlug, retiredEntryFor } = await import("../src/retired-tools.js");
    const losses = [];
    for (const [key, a] of then) {
      if (!a.pr) continue;
      const b = now.get(key);
      if (!b && (retiredEntryForSlug(a.slug) || retiredEntryFor(key.slice(key.indexOf(" ") + 1)))) continue;
      const l = listingLosses(a, b || { status: "unlisted" });
      if (l.length) losses.push(`${key}: ${l.join("; ")}`);
    }
    ok(losses.length === 0, `no route's 402 listing lost description or sample output against the base (${then.size} compared)${losses.length ? `:\n  ${losses.join("\n  ")}` : ""}`);
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
}

console.log(`\ntest-bazaar-listing-parity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
