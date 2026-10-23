// Socket.dev supply-chain gate — fails on NEW critical/high alerts in what we
// publish and what our published packages pull in.
//
// WHY THIS EXISTS: our own code is audited by scripts/test-supply-chain-guards.js,
// but the 2026 worm waves land in DEPENDENCIES — a package that was clean last
// week ships a malicious patch version this week. This asks a third party
// (Socket) "has anything in this tree started behaving like malware?" on every
// run, which is the question a static audit of our own repo cannot answer.
//
// SCOPE: our 11 published packages, the tree that ships to users of
// agent402-mcp (the npx path), AND the server's own PRODUCTION tree.
//
// The server tree was originally excluded as "never reaches a buyer" - wrong
// reasoning, corrected 2026-08-05 after Socket's GitHub app surfaced 61 alerts
// this gate had never looked at. The server is what handles buyer money; a
// compromised dependency there is worse than one in a published package, not
// better. Dev-only dependencies stay out (they never run in production, and
// the batch call is priced per request so scope is nearly free).
//
// FAILURE POLICY:
//   - critical/high alert on any scanned package  -> exit 1 (block)
//   - Socket unreachable / quota exhausted / auth failure -> LOUD warning,
//     exit 0. A third-party outage is not evidence of compromise, and blocking
//     releases on someone else's uptime is its own outage. The warning is
//     deliberately noisy: this repo has been bitten by an alarm that treated
//     "unreadable" as "fine" and silently never fired (charged-failure, 2026-07).
//   - middle/low alerts -> printed, never blocking. They are capability
//     descriptions (networkAccess, envVars) that every HTTP client trips.
//
// Usage:  SOCKET_API_TOKEN=... node scripts/socket-check.js [--strict]
//         --strict also fails on middle severity (not used in CI by default)
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = (process.env.SOCKET_API_TOKEN || "").trim();
const STRICT = process.argv.includes("--strict");
const API = "https://api.socket.dev/v0/purl?alerts=true";
// Severity alone is the wrong gate: Socket rates `socketUpgradeAvailable`
// (a product recommendation to adopt their optimized drop-in packages) as
// "high", and it carries no security meaning. Block on alert TYPES that
// describe compromise, at high/critical severity.
const MALICIOUS_TYPES = new Set([
  "malware", "gptMalware", "gptSecurity", "installScripts",
  "shellAccess", "networkAccessAnomaly", "suspiciousStarActivity", "typosquat",
  "didYouMean", "gptDidYouMean", "troll", "cryptoMiner", "telemetry",
  "protestware", "badEncoding", "invalidPackageJSON", "compromisedSSHKey",
]);
// REPORTED, NOT BLOCKING. `obfuscatedFile` fires on minified, bundled and
// machine-generated files, which is most of the ecosystem's dist output. Every
// one of the 13 hits in our tree on 2026-08-05 was provably that: two files
// literally named *.min.js (pdf-lib, zlibjs), WASM glue (tesseract.js-core),
// and - decisively - hi-base32's index.d.ts, a 27-line TypeScript DECLARATION
// file containing JSDoc and no executable code at all. Blocking on this signal
// means blocking on "ships a bundle", which would fire constantly on
// legitimate packages and train us to ignore the gate. It stays visible in
// every run so a NEW one gets human eyes; it just doesn't stop the build.
// Genuine compromise markers (malware, install scripts, shell access) still
// block, and an unknown high-severity type still blocks.
const REPORTED_TYPES = new Set(["obfuscatedFile"]);
// Alert types that are advisory, not security. Never block on these.
const ADVISORY_TYPES = new Set([
  "socketUpgradeAvailable", "unmaintained", "unpopularPackage", "newAuthor",
  "missingTarball", "deprecated", "majorRefactor", "unstableOwnership",
]);
// Documented accepts, keyed "namespace/name@version:alertType" (one exact
// version, so a later version of the same package is judged afresh) or
// "namespace/name:alertType". Each entry needs a REASON - an allowlist
// without justification is just a mute button.
const ACCEPTED = new Map([
  ["zod@3.25.76:cve", "GHSA-mrhx-c7xc-m3w5 (memory on a large failing array) is patched only in zod 4.6.6+; no patched 3.x exists. zod 3 is held by the x402, CDP and image libraries, which parse header-sized or our own inputs; the MCP SDK, which parses request bodies, is pinned to zod 4.6.7 by overrides. Drop this entry when those libraries move to zod 4."],
]);

const warn = (msg) => console.log(`\n::warning::${msg}\n[socket] ${msg}`);

/** Our published packages at their CURRENT local versions — catches the case
 *  where a version we are about to publish is already flagged. */
function ourPackages() {
  const dirs = ["mcp", "tollbooth", "client"];
  const adaptersDir = join(ROOT, "adapters");
  if (existsSync(adaptersDir)) {
    for (const e of readdirSync(adaptersDir, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(`adapters/${e.name}`);
    }
  }
  const out = [];
  for (const d of dirs) {
    const f = join(ROOT, d, "package.json");
    if (!existsSync(f)) continue;
    const p = JSON.parse(readFileSync(f, "utf8"));
    if (p.private || !p.name || !p.version) continue;
    out.push(`pkg:npm/${p.name}@${p.version}`);
  }
  return out;
}

/** Production dependencies from a lockfile. `dev` entries are skipped: they
 *  never run in prod and never ship. Used for both the mcp tree (what npx
 *  users get) and the server tree (what handles buyer money). */
function prodTree(lockPath) {
  const lock = join(ROOT, lockPath);
  if (!existsSync(lock)) return [];
  const data = JSON.parse(readFileSync(lock, "utf8"));
  const out = [];
  for (const [path, meta] of Object.entries(data.packages || {})) {
    if (!path.startsWith("node_modules/")) continue;
    if (meta.dev) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!meta.version) continue;
    out.push(`pkg:npm/${name}@${meta.version}`);
  }
  return out;
}

async function scan(purls) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${TOKEN}:`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ components: purls.map((purl) => ({ purl })) }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`Socket API HTTP ${res.status}: ${body.slice(0, 200)}`), { status: res.status });
  }
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

if (!TOKEN) {
  warn("SOCKET_API_TOKEN is not set - supply-chain scan SKIPPED. This gate is not protecting this run.");
  process.exit(0);
}

const mine = ourPackages();
const purls = [...new Set([...mine, ...prodTree("mcp/package-lock.json"), ...prodTree("package-lock.json")])];
console.log(`[socket] scanning ${purls.length} packages: ${mine.length} we publish + the agent402-mcp runtime tree + the server's production tree`);

let rows;
try {
  rows = await scan(purls);
} catch (e) {
  warn(`Socket scan could not complete (${e.message}). NOT blocking the run - a third-party outage is not evidence of compromise - but this run was NOT scanned.`);
  process.exit(0);
}

const blocking = [];
const accepted = [];
const advisory = [];
const reported = [];
const counts = { critical: 0, high: 0, middle: 0, low: 0 };
for (const r of rows) {
  // Socket splits scoped names: name="hashes", namespace="@noble".
  const id = r.namespace ? `${r.namespace}/${r.name}` : r.name;
  for (const a of r.alerts || []) {
    counts[a.severity] = (counts[a.severity] || 0) + 1;
    const severe = a.severity === "critical" || a.severity === "high" || (STRICT && a.severity === "middle");
    if (!severe) continue;
    if (ADVISORY_TYPES.has(a.type)) { advisory.push(`${id}: ${a.type}`); continue; }
    if (REPORTED_TYPES.has(a.type)) { reported.push(`${id}@${r.version}: ${a.type}${a.file ? ` (${a.file})` : ""}`); continue; }
    const key = `${id}:${a.type}`;
    const exact = `${id}@${r.version}:${a.type}`;
    if (ACCEPTED.has(exact)) { accepted.push(exact); continue; }
    if (ACCEPTED.has(key)) { accepted.push(key); continue; }
    // Unknown type at high severity blocks too - fail closed on the unfamiliar.
    if (MALICIOUS_TYPES.has(a.type) || !ADVISORY_TYPES.has(a.type)) {
      blocking.push({ pkg: `${id}@${r.version}`, type: a.type, severity: a.severity, file: a.file });
    }
  }
}

console.log(`[socket] ${rows.length}/${purls.length} packages returned data`);
console.log(`[socket] alerts: critical=${counts.critical} high=${counts.high} middle=${counts.middle} low=${counts.low}`);
if (rows.length < purls.length) {
  console.log(`[socket] note: ${purls.length - rows.length} package(s) returned no data (unpublished local version, or not yet indexed)`);
}

if (reported.length) {
  console.log(`\n[socket] ${reported.length} obfuscation flag(s) - REPORTED, not blocking (minified/bundled/generated code; see REPORTED_TYPES for why). Review any that are NEW:`);
  for (const r of reported) console.log(`    ${r}`);
}
if (advisory.length) {
  console.log(`[socket] ${advisory.length} advisory alert(s) ignored (not security): ${[...new Set(advisory.map((a) => a.split(": ")[1]))].join(", ")}`);
}
for (const key of new Set(accepted)) {
  console.log(`[socket] accepted (documented): ${key}\n         reason: ${ACCEPTED.get(key)}`);
}

if (blocking.length) {
  console.error(`\n::error::Socket found ${blocking.length} blocking alert(s) in the dependency tree`);
  for (const b of blocking) console.error(`  [${b.severity}] ${b.type} - ${b.pkg}${b.file ? ` (${b.file})` : ""}`);
  console.error("\nThis is the shape of a supply-chain compromise: a dependency that was clean before is now flagged.");
  console.error("If a finding is a verified false positive, add it to ACCEPTED above WITH a reason - never silence it blindly.");
  console.error("Do NOT bump past it. Check the package's recent versions and Socket's alert detail first.");
  process.exit(1);
}

console.log("\n[socket] OK - no critical/high alerts. (middle/low are capability descriptions: network access, env reads, etc.)");
