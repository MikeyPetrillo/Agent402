// Every route's 402 listing at this tree keeps what the same route listed at
// the base: its description is not shorter, each input field it listed keeps
// a description when it had one (shortened is allowed) and every bound
// (enum, lengths, range, format), and its sample output is not
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
import { mkdtempSync, rmSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withoutLicenseFields } from "../src/data-attribution.js";
import { WITHDRAWN_SOURCE_FIELDS } from "../src/resale-terms.js";

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

// The input fields a listing declares (a POST body or GET query parameters).
const inputFieldsOf = (pr) => {
  const inp = pr?.extensions?.bazaar?.schema?.properties?.input?.properties || {};
  const block = inp.body || inp.queryParams;
  return block && typeof block === "object" && block.properties && typeof block.properties === "object" ? block.properties : {};
};
// The bounds an input field carries that a buyer's value is held to.
const INPUT_CONSTRAINTS = ["enum", "const", "maxLength", "minLength", "maximum", "minimum", "maxItems", "minItems", "format"];
const isPointer = (ex) => !!ex && typeof ex === "object" && ex.truncated === true && /openapi\.json/.test(String(ex.note || ""));
const exampleOf = (pr) => pr?.extensions?.bazaar?.info?.output?.example;

// Sample fields an owner decision removed on purpose, by slug: the field is
// gone from the answer itself, so the sample must not keep it. token-safety
// dropped its verdict (2026-11-24: no answer may read as a statement that a
// token is fine); the named facts are listed in `flags` and `unknown` instead.
export const REMOVED_SAMPLE_FIELDS = Object.freeze({
  "token-safety": Object.freeze(["verdict", "because", "blocking", "warnings"]),
});

/** What `now` lost against `then` for one route ([] when nothing). A
 *  sample field named for the route's slug in `withdrawn` (a source figure a
 *  tool stopped answering, src/resale-terms.js WITHDRAWN_SOURCE_FIELDS) may
 *  leave the sample; one still in the sample is a loss of its own (the
 *  withdrawal did not happen). */
export function listingLosses(then, now, withdrawn = WITHDRAWN_SOURCE_FIELDS) {
  const lost = [];
  if (!then?.pr) return lost;
  if (!now?.pr) return [`no 402 listing (status ${now?.status ?? now?.err})`];
  const da = String(then.pr.resource?.description || ""), db = String(now.pr.resource?.description || "");
  if (db.length < da.length) lost.push(`description ${da.length} -> ${db.length} chars`);
  const ea = exampleOf(then.pr), eb = exampleOf(now.pr);
  if (ea !== undefined && eb === undefined) lost.push("sample output dropped");
  else if (ea !== undefined && !isPointer(ea) && isPointer(eb)) lost.push("sample output became the /openapi.json pointer");
  else if (ea && eb && typeof ea === "object" && typeof eb === "object" && !Array.isArray(ea) && !isPointer(ea)) {
    const removed = REMOVED_SAMPLE_FIELDS[then.slug] || [];
    const out = Object.hasOwn(withdrawn || {}, then.slug) ? withdrawn[then.slug] : [];
    const gone = Object.keys(withoutLicenseFields(ea)).filter((k) => !(k in eb) && !removed.includes(k) && !out.includes(k));
    if (gone.length) lost.push(`sample output lost ${gone.join(", ")}`);
    const kept = out.filter((k) => k in eb);
    if (kept.length) lost.push(`sample output still carries withdrawn source field ${kept.join(", ")}`);
  }
  // Input fields: each field the base listed is still listed, keeps a
  // description when it had one (it may be shortened), and keeps every bound.
  const fa = inputFieldsOf(then.pr), fb = inputFieldsOf(now.pr);
  for (const [name, pa] of Object.entries(fa)) {
    const pb = fb[name];
    if (!pb || typeof pb !== "object") { lost.push(`input field ${name} dropped`); continue; }
    if (typeof pa?.description === "string" && pa.description.trim() && !(typeof pb.description === "string" && pb.description.trim())) lost.push(`input field ${name} lost its description`);
    for (const k of INPUT_CONSTRAINTS) {
      if (pa?.[k] !== undefined && JSON.stringify(pb[k]) !== JSON.stringify(pa[k])) lost.push(`input field ${name} lost ${k} ${JSON.stringify(pa[k])}`);
    }
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
  ok(listingLosses({ slug: "token-safety", ...pr("a", { verdict: "x", flags: [] }) }, pr("a", { flags: [] })).length === 0 && /lost verdict/.test(listingLosses({ slug: "other", ...pr("a", { verdict: "x" }) }, pr("a", {}))[0] || ""), "control: a field an owner decision removed is excused for its slug only");
  const slugged = (d, ex) => ({ slug: "z-tool", ...pr(d, ex) });
  ok(listingLosses(slugged("a", { a: 1, rawUsd: 2 }), slugged("a", { a: 1, rawShare: 3 }), { "z-tool": ["rawUsd"] }).length === 0, "control: a withdrawn source field may leave the sample");
  ok(/lost rawUsd/.test(listingLosses(slugged("a", { a: 1, rawUsd: 2 }), slugged("a", { a: 1 }), { "other-tool": ["rawUsd"] })[0] || ""), "control: a field withdrawn for another slug is still a loss");
  ok(/still carries withdrawn source field rawUsd/.test(listingLosses(slugged("a", { a: 1, rawUsd: 2 }), slugged("a", { a: 1, rawUsd: 2 }), { "z-tool": ["rawUsd"] }).join() || ""), "control: a withdrawn field left in the sample is a loss");
  ok(listingLosses({ pr: null }, pr("a", {})).length === 0 && /no 402/.test(listingLosses(pr("a", {}), { status: 410 })[0] || ""), "control: a route the base did not list is not compared; one that stopped listing is a loss");
  const withInput = (props, where = "body") => ({ pr: { resource: { description: "a" }, extensions: { bazaar: { info: {}, schema: { properties: { input: { properties: { [where]: { properties: props } } } } } } } } });
  const full = { url: { type: "string", maxLength: 2048, description: "The URL to look up" }, mode: { type: "string", enum: ["a", "b"] } };
  ok(listingLosses(withInput(full), withInput(full)).length === 0, "control: the same input fields lose nothing");
  ok(listingLosses(withInput(full), withInput({ ...full, url: { type: "string", maxLength: 2048, description: "The URL" } })).length === 0, "control: a shortened field description is not a loss");
  ok(/url lost its description/.test(listingLosses(withInput(full), withInput({ ...full, url: { type: "string", maxLength: 2048 } })).join()), "control: a field that lost its description is a loss");
  ok(/url lost maxLength/.test(listingLosses(withInput(full), withInput({ ...full, url: { type: "string", description: "x" } })).join()), "control: a field that lost its maxLength is a loss");
  ok(/mode lost enum/.test(listingLosses(withInput(full, "queryParams"), withInput({ ...full, mode: { type: "string" } }, "queryParams")).join()), "control: a query parameter that lost its enum is a loss");
  ok(/mode dropped/.test(listingLosses(withInput(full), withInput({ url: full.url })).join()), "control: a dropped input field is a loss");
}

const ref = baseRef();
if (!ref) {
  ok(!process.env.CI, "a base commit to compare with (origin/main, main or BAZAAR_PARITY_BASE) is readable");
  if (!process.env.CI) console.log("SKIP - no base commit readable (set BAZAAR_PARITY_BASE)");
} else {
  const baseDir = mkdtempSync(join(tmpdir(), "a402-listing-parity-"));
  try {
    execFileSync("sh", ["-c", `git archive ${ref} | tar -x -C "${baseDir}"`], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    // The base boots on its own dependencies: the head's node_modules only when
    // both lockfiles are the same, else a clean install of the base lockfile
    // (a dependency move can drop an export the base imports, so the head's
    // packages would not boot the base at all).
    const sameLock = existsSync(join(baseDir, "package-lock.json")) && readFileSync(join(baseDir, "package-lock.json"), "utf8") === readFileSync(join(ROOT, "package-lock.json"), "utf8");
    if (sameLock && existsSync(join(ROOT, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(baseDir, "node_modules"), "dir");
    else {
      console.log("base lockfile differs from the head's: installing the base's dependencies");
      execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: baseDir, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
    }
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
