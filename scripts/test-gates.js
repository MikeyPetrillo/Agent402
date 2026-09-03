#!/usr/bin/env node
// Do our regression gates actually fail when their invariant is violated?
//
//   node scripts/test-gates.js            (needs a server on TARGET_URL for the
//                                          gates that take one; see GATES below)
//
// WHY: a gate that cannot fail is worse than no gate, because it converts "we
// never checked" into "we checked and it was fine". This is not theoretical.
// Three times while building tonight's gates, a green result was meaningless:
// the docs gate matched source paths as dead links and would have been switched
// off as noise; the public-surface leak gate passed VACUOUSLY on an empty
// database, which is the state CI starts in; and the free-tier egress probe
// reported a clean sweep while blind, because its control tool used node:dns
// and never called fetch. Each was found by accident.
//
// So each gate is checked the only way that means anything: reintroduce the
// exact defect it exists to catch, and require a non-zero exit. A gate that
// stays green under its own mutation is reported as BROKEN.
//
// SAFETY: every mutation is reverted in a finally block, and the run ends by
// asserting `git diff` is clean for every file it touched. If this script is
// killed mid-run, `git checkout -- <file>` restores it; nothing is committed.
import { execFileSync, execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

// Each entry: the gate, the file to mutate, the exact defect to reintroduce, and
// what that defect represents. `needsServer` gates are skipped with a loud note
// when no server is reachable, never silently passed.
const GATES = [
  {
    gate: "test-package-integrity.js",
    file: "adapters/strands/package.json",
    from: '"agent402-client": ">=0.6.0 <1.0.0"',
    to: '"agent402-client": "^0.1.0"',
    defect: "a published adapter pinning a client version we no longer ship",
  },
  {
    gate: "test-docs-truth.js",
    needsServer: true,
    file: "wiki/Tool-Catalog.md",
    from: "| `search` | $0.02 |",
    to: "| `search` | $0.99 |",
    defect: "a documented price that disagrees with the catalog",
  },
  {
    gate: "test-docs-truth.js",
    needsServer: true,
    file: "wiki/Skill-Packs.md",
    from: "/skills/company-dossier) | $0.064",
    to: "/skills/company-dossier) | $0.99",
    defect: "a stale pack price on a /skills link (the shape that slipped past the first version)",
  },
  {
    gate: "test-sales-ledger.js",
    file: "src/sales-ledger.js",
    from: "rail: r.rail, network: r.network, tx: r.tx, internal: !!r.internal,",
    to: "rail: r.rail, network: r.network, payer: r.payer, tx: r.tx, internal: !!r.internal,",
    defect: "a payer address back on a public settlement feed",
  },
  {
    gate: "test-seller-trust.js",
    file: "src/tools/seller-trust.js",
    from: "reason: \"not in our index - never crawled, so we hold no evidence either way\",",
    to: "reason: \"unsafe seller\",",
    defect: "absence of evidence reported as a bad verdict",
  },
  {
    gate: "test-analytics-redaction.js",
    file: "src/analytics-db.js",
    // Simulate a REAL regression rather than a crash: pass the raw per-tool rows
    // straight through. The original defect (a mis-named destructure) now only
    // throws, because the rows are re-assigned explicitly after the spread - so
    // mutating the destructure would prove sensitivity to a line, not to the
    // leak. This mutation is what a careless "simplification" would look like.
    from: "    topTools: reliabilityOnly(topTools),",
    to: "    topTools,",
    defect: "raw per-tool rows (call volume, traffic ranking) passed through to unauthenticated callers",
  },
  {
    gate: "test-discoverability.js",
    needsServer: true,
    file: "src/pages.js",
    from: '  x402: { label: "x402 seller intelligence"',
    to: '  __x402_disabled: { label: "x402 seller intelligence"',
    defect: "a category dropped from CATEGORIES, orphaning its tools from llms.txt and its page",
    // The mutation is in SERVER code, so a server booted before it was applied
    // would still be serving the old catalog and the gate would pass against
    // code that no longer exists. Boot a fresh one on the mutated source.
    bootMutatedServer: true,
  },
];

let serverUp = false;
try { serverUp = (await fetch(`${TARGET}/health`)).ok; } catch { serverUp = false; }
if (!serverUp) console.log(`note: no server at ${TARGET} - server-dependent gates will be reported as UNCHECKED, not passed`);

const touched = new Map(); // file -> exact content before any mutation
for (const g of GATES) {
  if (g.needsServer && !serverUp) {
    failed++;
    console.error(`FAIL - ${g.gate} UNCHECKED (needs a server at ${TARGET}): ${g.defect}`);
    continue;
  }
  const path = join(ROOT, g.file);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const original = readFileSync(path, "utf8");
  if (!original.includes(g.from)) {
    failed++;
    console.error(`FAIL - cannot mutate ${g.file}: anchor missing, so ${g.gate} was NOT verified (anchor: ${g.from.slice(0, 60)})`);
    continue;
  }
  if (!touched.has(g.file)) touched.set(g.file, original);
  let caught = false;
  let mutant = null, mutantTarget = TARGET;
  try {
    writeFileSync(path, original.replace(g.from, g.to));

    // A mutation in server code is invisible to a server that booted before it.
    // Boot one on the mutated source, or the gate is being asked about code that
    // is no longer running - which is how this runner first reported a working
    // gate as broken.
    if (g.bootMutatedServer) {
      const port = 3300 + Math.floor(Math.random() * 200);
      mutantTarget = `http://127.0.0.1:${port}`;
      mutant = spawn("node", ["src/server.js"], {
        cwd: ROOT, stdio: "ignore",
        env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off",
               AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" },
      });
      let up = false;
      for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`${mutantTarget}/health`)).ok) { up = true; break; } } catch { /* booting */ }
        await sleep(500);
      }
      if (!up) throw new Error("mutated server never came up");
    }

    try {
      execFileSync("node", [join("scripts", g.gate)], {
        cwd: ROOT, stdio: "pipe", timeout: 900_000,
        env: { ...process.env, TARGET_URL: mutantTarget },
      });
      caught = false; // exit 0 with the defect present
    } catch {
      caught = true;  // non-zero exit: the gate did its job
    }
  } finally {
    writeFileSync(path, original);
    if (mutant) { mutant.kill("SIGTERM"); await sleep(300); mutant.kill("SIGKILL"); }
  }
  ok(caught, `${g.gate} catches ${g.defect}`);
}

// The mutations must leave no trace. A gate suite that corrupts the tree is its
// own outage.
//
// Compare against the content captured BEFORE the mutation, not against git.
// The first version asked `git diff --name-only`, which cannot distinguish "my
// mutation leaked" from "this file already had uncommitted work" - so running
// the suite on a dirty tree reported a false corruption, which is precisely the
// kind of untrustworthy signal that gets a gate ignored.
for (const [file, before] of touched) {
  const now = readFileSync(join(ROOT, file), "utf8");
  ok(now === before, `${file} restored byte-for-byte after mutation`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
