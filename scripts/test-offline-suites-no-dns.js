// Offline suites that stub an upstream answer the same with no name server.
//
//   node scripts/test-offline-suites-no-dns.js            # every suite below
//   node scripts/test-offline-suites-no-dns.js test-x.js  # just these
//
// The address guard (src/tools/fetch-guard.js) resolves a URL's host before
// the fetch, with an uncached resolver. A suite that stubs the fetch (or an
// upstream, or boots a server under a stub preload) but lets that upfront
// lookup reach the machine's resolver passes on a quick resolver and fails on
// a slow or refusing one: the tool answers 503 "Name resolution ... temporarily
// unavailable" before the stubbed fetch is reached. The fix is the resolver
// stub (scripts/lib/guard-resolver-stub.js; a preload for a booted server).
//
// This runs each suite in the list once under scripts/lib/dns-refuse-preload.js,
// which makes every lookup the guard would send to a real resolver fail at
// once (NODE_OPTIONS, so booted servers inherit it), and requires each to exit
// 0. A suite that depends on live DNS through the guard now fails every time,
// not one run in five. The list is every suite this class was found in (a run
// of each CI suite with the preload against a normal run) plus one suite per
// stub shape (a module-level fetch stub, a booted server under a stub preload,
// a boot that buys from a loopback seller). A new suite of one of those shapes
// is added here.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = join(ROOT, "scripts/lib/dns-refuse-preload.js");

const SUITES = [
  "test-capped-body-reads.js",
  "test-coingecko-rate.js",
  "test-crawl-conditional.js",
  "test-crawl-kit.js",
  "test-databento-bar-range.js",
  "test-databento-fallback.js",
  "test-databento-range-fallback.js",
  "test-databento-timeouts.js",
  "test-dossier-inputs.js",
  "test-edgar-13f-datasets.js",
  "test-fetch-guard.js",
  "test-finance-kit.js",
  "test-free-tier-egress.js",
  "test-gone-routes.js",
  "test-index-tools-catalog.js",
  "test-leak-guard.js",
  "test-live-price-adopt.js",
  "test-live-quote-body-redirect.js",
  "test-live-quote-method-refused.js",
  "test-live-quote-query-params.js",
  "test-load-shed.js",
  "test-mcp-package-kit.js",
  "test-nominatim-pace.js",
  "test-openfda-reference.js",
  "test-page-change-kit.js",
  "test-price-label-readers.js",
  "test-quote-retired-on-free.js",
  "test-recall-nomatch.js",
  "test-register-recheck-cooldown.js",
  "test-report-grounding.js",
  "test-report-prose-filter.js",
  "test-upstream-deadline.js",
];

const pick = process.argv.slice(2).map((a) => a.replace(/^scripts\//, ""));
const list = pick.length ? pick : SUITES;
const dir = mkdtempSync(join(tmpdir(), "a402-nodns-"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

function run(suite) {
  const log = join(dir, `${suite}.dns.log`);
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import ${PRELOAD}`.trim(),
    DNS_REFUSE_LOG: log,
    MEMORY_DB_FILE: join(dir, `${suite}.memory.db`),
  };
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [join("scripts", suite)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const asked = existsSync(log) ? [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t").slice(1).join(" ")))] : [];
      resolve({ code, out, asked, ms: Date.now() - t0 });
    });
  });
}

for (const suite of list) {
  const r = await run(suite);
  ok(r.code === 0, `${suite} passes with every real name lookup refused (exit ${r.code}, ${Math.round(r.ms / 1000)}s)`);
  if (r.code !== 0) {
    console.error(`  refused lookups: ${r.asked.slice(0, 8).join("; ") || "none"}`);
    console.error(r.out.split("\n").filter((l) => /FAIL|Error|503|temporarily unavailable/.test(l)).slice(0, 8).map((l) => `  | ${l.slice(0, 240)}`).join("\n"));
  }
}

console.log(`\ntest-offline-suites-no-dns: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
