#!/usr/bin/env node
// CLASS GUARD: a test that misses a mutation. Batch after batch the devil
// review found a defect put back in a copy and every suite still green: the
// settle-first clause returning "" (batch 6), the /privacy split-leg line
// removed, a receipt kept before the response finished (batch 7), the
// token-diligence trim broken (caught by one suite, missed by the one meant
// to hold it). This script keeps those mutations, and the ones that were
// caught, and runs them again: each is applied in an export copy of the
// tree, its suite is run there, and a suite that still passes is a failure.
//
//   node scripts/mutation-smoke.js               run every mutation
//   node scripts/mutation-smoke.js --only <id>   run one (repeatable)
//   node scripts/mutation-smoke.js --list        print the list
//
// The working tree is never touched: the copy holds the tracked and the
// untracked, not ignored files as they are in the working tree (a git repository of its own, so a suite that
// reads `git ls-files` reads the copy), with node_modules linked. A mutation
// whose `find` text is not in its file exactly once fails as stale, so a
// refactor re-anchors it instead of letting it pass vacuously. Each suite is
// first run unmutated in the copy (the control: a mutation's failure must be
// the mutation's). Add a mutation here when a review finds one a suite
// missed, together with the test that now catches it.
//
// Runs in the test-unit-d lane (about 40 s: each mutation runs its suite
// once, and each suite runs once unmutated). Keep a mutation's suite an
// offline one that finishes in seconds; a slower one belongs in the /batch
// gate's own mutation checks, not here.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** id, where it came from, the file and the exact text replaced, and the suite that must fail. */
export const MUTATIONS = [
  { id: "settle-first-clause-empty", origin: "batch 6, survived test-settle-first", file: "src/settle-first-copy.js",
    find: 'return def && def.settlesFirst === true && SETTLE_FIRST_SENTENCE ? ` ${SETTLE_FIRST_SENTENCE}` : "";', replace: 'return "";', suite: "test-claim-registry.js" },
  { id: "privacy-split-leg-line", origin: "batch 7, survived test-referral-gate and test-referral-legs", file: "src/privacy.js",
    find: "the amount, how the network's contract split it, and the wallet", replace: "the amount, and the wallet", suite: "test-claim-registry.js" },
  { id: "terms-v1-fallback-for-every-call", origin: "batch 7 (/terms /v1 sentence)", file: "src/terms.js",
    find: "a call on a chat tier falls back to the next model on that tier when one fails", replace: "a call falls back to the next model when one fails", suite: "test-claim-registry.js" },
  { id: "terms-caller-url-clause", origin: "batch 7, survived five suites; now caught", file: "src/terms.js",
    find: "${modelOutputsSection}${callerUrlSection}", replace: "${modelOutputsSection}", suite: "test-robots-gate.js" },
  { id: "receipt-kept-before-finish", origin: "batch 7 N4, survived test-receipt-streams", file: "src/receipt-store.js",
    find: 'res.once("finish", () => { try { if (res.statusCode === 200) keep(key, jws, record); } catch { /* bookkeeping only */ } });', replace: "keep(key, jws, record);", suite: "test-receipt-streams.js" },
  { id: "token-diligence-answers-market", origin: "batch 7 M5 (then a /ref trim; batch 8 answers no source figure anywhere)", file: "src/tools/bundle-kit.js",
    find: "    supply: { circulatingShare: round(circulatingShare, 4) },", replace: "    market: { price: m.price ?? null }, supply: { circulatingShare: round(circulatingShare, 4) },", suite: "test-bundle-products.js" },
  { id: "stablecoin-peg-sells-price", origin: "batch 7 (/aws skipped the /ref trim; batch 8 answers no source figure anywhere)", file: "src/tools/crypto-kit.js",
    find: '{ id: "tether", symbol: "USDT", name: "Tether", deviationBps: -11.32,', replace: '{ id: "tether", symbol: "USDT", name: "Tether", price: 0.998868, deviationBps: -11.32,', suite: "test-resale-clearance.js" },
  { id: "exchange-spread-answers-median-price", origin: "batch 8 (a source figure back in a computed screen)", file: "src/tools/crypto-screens-kit.js",
    find: "      volumeWeightedVsMedianBps: vwap == null ? null : round(devBps(vwap), 2),", replace: "      medianPriceUsd: mid, volumeWeightedVsMedianBps: vwap == null ? null : round(devBps(vwap), 2),", suite: "test-crypto-screens-kit.js" },
  { id: "code-mail-global-read-before-charge", origin: "batch 8 (parallel asks past the service budget)", file: "src/mcp-oauth.js",
    find: 'if (await charge("send-global", "all", HOUR_MS) > globalMax', replace: 'if (await add("send-global", "all", 0, HOUR_MS) >= globalMax', suite: "test-limiter-identity.js" },
  { id: "limiter-key-mapped-ipv4", origin: "batch 8 (one host, two keys)", file: "src/rate-limit.js",
    find: "if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff)", replace: "if (false)", suite: "test-limiter-identity.js" },
  { id: "alerts-email-spelling", origin: "batch 8 (a mailbox's +tag spellings, as batch 6 G2)", file: "src/server.js",
    find: 'update(mailboxKey(String(b.email || "")))', replace: 'update(String(b.email || "").trim().toLowerCase())', suite: "test-limiter-identity.js" },
  { id: "typed-source-floor", origin: "batch 7 (fred >= 8, jupiter >= 5)", file: "scripts/test-bazaar-descriptions.js",
    find: 'ok(Object.entries(counts).every(([k, n]) => k === "fred" ? n === 0 : n > 0), ', replace: 'ok(Object.entries(counts).every(([k, n]) => k === "fred" ? n === 0 : n > 0) && counts.coingecko >= 24, ', suite: "test-typed-counts.js" },
  { id: "typed-count-in-page-module", origin: "batch 8 devil (a count typed in a served page module)", file: "src/pages.js",
    find: "  const item = (it, open) =>", replace: "  const planted = `<p>Agent402 serves 612 tools today.</p>`; void planted;\n  const item = (it, open) =>", suite: "test-typed-counts.js" },
  { id: "delivered-reads-own-claim-only", origin: "batch 8 devil (a joined leg's sentence in a charged answer)", file: "src/not-charged.js",
    find: "if (!store.claimed && printed === store.printedAtStart) return value;", replace: "if (!store.claimed) return value;", suite: "test-not-charged-scope.js" },
  { id: "new-unscoped-absolute", origin: "batch 8 (the class of batches 6 and 7: a claim broader than the code)", file: "wiki/FAQ.md",
    find: "so they are never charged.", replace: "so they are never charged. A refund always arrives within a day.", suite: "test-claim-registry.js" },
  { id: "code-mail-refusal-keeps-counts", origin: "batch 8 devil (a refused ask kept its counts)", file: "src/mcp-oauth.js",
    find: "add(n, k, -1, w)", replace: "add(n, k, 0, w)", suite: "test-limiter-identity.js" },
  { id: "unregistered-limiter", origin: "batch 8 (a new limiter with no identity named)", file: "src/answer-share.js",
    find: 'createLimiter("answer-share-card"', replace: 'createLimiter("answer-share-thumb"', suite: "test-limiter-identity.js" },
  { id: "bea-non-endorsement", origin: "batch 7, caught", file: "src/tools/us-macro-series.js",
    find: " This product uses BEA data but is not endorsed or certified by BEA.", replace: "", suite: "test-fred-series-sources.js" },
  { id: "fraud-rule-sales-off", origin: "batch 7, caught", file: "src/terms.js",
    find: "reported by Stripe. ${FRAUD_WARNING_RULE}`} One buyer", replace: "reported by Stripe.`} One buyer", suite: "test-credits-terms.js" },
];

// A suite's run: its exit status (null when it was killed, a timeout among
// them), whether it timed out, and its failing checks (FAIL, ASSERT FAIL or not ok lines,
// or an uncaught assertion).
export function runSuite(suite, { cwd, timeoutMs = 300_000 } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join("scripts", suite)], { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, CI: process.env.CI || "" } });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const timedOut = r.error?.code === "ETIMEDOUT" || (r.status === null && r.signal === "SIGTERM" && Date.now() - t0 >= timeoutMs);
  return { status: r.status, signal: r.signal || null, timedOut, ms: Date.now() - t0, fails: out.split("\n").filter((l) => /^\s*(?:ASSERT\s+)?(?:FAIL|not ok)\b|^\s*AssertionError\b|\bERR_ASSERTION\b/.test(l)).length };
}

/**
 * Whether a suite's run under a mutation caught it: only a numeric non-zero
 * exit with at least one failing check. A timeout, a kill (status null) or a
 * crash that names no failing check is its own failure, never a catch.
 */
export function mutationVerdict(r) {
  if (r.timedOut) return { caught: false, why: `the suite timed out after ${Math.round(r.ms / 1000)} s: a timeout is not a catch` };
  if (typeof r.status !== "number") return { caught: false, why: `the suite was killed (${r.signal || "no exit status"}): a kill is not a catch` };
  if (r.status === 0) return { caught: false, why: "the suite misses it" };
  if (!(r.fails > 0)) return { caught: false, why: `the suite exited ${r.status} with no failing check: a crash is not a catch` };
  return { caught: true, why: "" };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) main();

function main() {
const args = process.argv.slice(2);
const only = args.flatMap((a, i) => (a === "--only" ? [args[i + 1]] : []));
if (args.includes("--list")) { for (const m of MUTATIONS) console.log(`${m.id}\t${m.file}\t${m.suite}\t${m.origin}`); process.exit(0); }
const picked = only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS;
if (only.length && picked.length !== only.length) { console.error(`unknown mutation id: ${only.filter((o) => !MUTATIONS.some((m) => m.id === o)).join(", ")}`); process.exit(2); }

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - [test misses a mutation] ${m}`); } };

// The export copy: tracked files as the working tree holds them.
const COPY = mkdtempSync(join(tmpdir(), "mutation-smoke-"));
process.on("exit", () => { try { rmSync(COPY, { recursive: true, force: true }); } catch { /* best effort */ } });
const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
for (const f of tracked) {
  const from = join(ROOT, f);
  if (!existsSync(from)) continue; // deleted in the working tree, not yet staged
  mkdirSync(dirname(join(COPY, f)), { recursive: true });
  cpSync(from, join(COPY, f), { verbatimSymlinks: true });
}
symlinkSync(realpathSync(join(ROOT, "node_modules")), join(COPY, "node_modules"));
const git = (...a) => execFileSync("git", a, { cwd: COPY, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "m", GIT_AUTHOR_EMAIL: "m@x", GIT_COMMITTER_NAME: "m", GIT_COMMITTER_EMAIL: "m@x" } });
git("init", "-q"); git("add", "-A"); git("commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "export");
console.log(`export copy: ${tracked.length} tracked files`);


// Controls: every suite passes in the copy before anything is mutated.
const controls = new Map();
for (const suite of [...new Set(picked.map((m) => m.suite))]) {
  const r = runSuite(suite, { cwd: COPY });
  controls.set(suite, r.status === 0);
  ok(r.status === 0, `control: ${suite} passes unmutated in the copy (exit ${r.status}, ${Math.round(r.ms / 1000)} s)`);
}

for (const m of picked) {
  const p = join(COPY, m.file);
  const before = existsSync(p) ? readFileSync(p, "utf8") : "";
  const count = before.split(m.find).length - 1;
  ok(count === 1, `${m.id}: the mutation's text is in ${m.file} exactly once (${count}${count === 1 ? "" : "; re-anchor it to the code as it is now"})`);
  if (count !== 1 || !controls.get(m.suite)) continue;
  writeFileSync(p, before.replace(m.find, m.replace));
  try {
    const r = runSuite(m.suite, { cwd: COPY });
    const v = mutationVerdict(r);
    ok(v.caught, `${m.id}: ${m.suite} fails under the mutation (exit ${r.status}, ${r.fails} failing checks, ${Math.round(r.ms / 1000)} s; ${m.origin})${v.caught ? "" : `: ${v.why}${r.status === 0 ? `; add the assert that catches it to ${m.suite}` : ""}`}`);
  } finally { writeFileSync(p, before); }
}

console.log(`\nmutation-smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}
