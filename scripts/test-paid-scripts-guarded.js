#!/usr/bin/env node
// Every script that signs a payment checks where it pays.
//
// Reads scripts/*.js and scripts/*.mjs (comments stripped) for a payment
// being signed: an x402 client wrapped or asked for a payload, an exact or
// upto scheme registered, an mppx client created. Each such script must:
//
//   1. call assertOwnPaidTarget (scripts/lib/buyer-guard.js), so a mistyped or
//      pasted TARGET_URL never points a buyer of ours at another origin (that
//      the call comes before any key or network read is proven by running the
//      scripts in scripts/test-buyer-guard.js); or
//   2. be listed below with the reason its target is not an env choice of our
//      service: it pays an outside seller on purpose (and then the cap markers
//      named for it must be present), or its target is fixed in code; or
//   3. be a test suite (test-*.js) that reads no target from the environment
//      and names no production fallback: it signs only against what it boots.
//
// And a guarded script that turns the library's own spend control off must
// install a per-accept cap of its own (guardCappedSigning, a signing policy or
// hook, or a mechanism named in OWN_CAP), so no signature is unbounded. The
// scripts in PENDING_CAP are bounded today by run-level budgets and fixed
// routes only; the list may only shrink (an entry that gains a cap fails
// until it is removed), and a new script cannot join it silently.
//
// It also keeps demo-payment.js's inline USDC table (the served demo.js,
// which imports nothing) in step with client/known-assets.js.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { knownAsset } from "../client/known-assets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Scripts that pay outside sellers on purpose. Each must carry every marker:
// the cap that bounds what it signs.
const EXTERNAL_BY_DESIGN = {
  // Pays one named outside route; refuses a quote above PROBE_MAX_USD and
  // filters the signed accept by a policy against the same cap.
  "external-seller-probe.js": [/PROBE_MAX_USD/, /registerPolicy\(/, /maxAtomic/],
  // Sweeps listed outside sellers with a per-seller and a run cap, a fresh
  // client and policy per seller.
  "seller-sweep.mjs": [/SWEEP_MAX_USD/, /SWEEP_TOTAL_USD/, /registerPolicy\(/, /acceptFilterFor\(/],
  // Buys from outside Algorand sellers under a per-buy and a total cap.
  "algorand-external-buy.js": [/guardCappedSigning\(client, \{ maxUsd: PER_BUY_USD/, /makeBudget\(MAX_USD\)/],
  // The ecosystem demo: its workflow input may name an outside seller.
  "paid-demo.js": [/guardCappedSigning\(client, \{ maxUsd: MAX_USD, networks: \[CHAIN\] \}\)/],
  // smoke-buy's SMOKE_TARGET mode buys from a named outside seller; its
  // TARGET_URL mode is also guarded (and so checked by rule 1 as well).
  "smoke-buy.js": [/guardCappedSigning\(client, \{ maxUsd: SMOKE_MAX_USD/],
  // Pays a fixed public registry for its paid resource pages through the
  // shared capped guard: each page is capped at the smaller of the per-page
  // cap and what is left of --max-usd.
  "x402scan-seed.js": [/guardCappedSigning\(client, \{ maxUsd: \(\) => Math\.min\(pageCapUsd, maxUsd - spentUsd\(\)\), networks: SEED_NETWORKS/, /const SEED_NETWORKS = \["eip155:8453"\];/, /--max-usd must be a positive number/],
};
// An outside-seller script whose accepts all pass the shared guard must not
// also pick them with a selector of its own (one the guard's version and
// asset checks would not see first).
const EXTERNAL_FORBIDDEN = {
  "x402scan-seed.js": [/new\s+x402Client\s*\(\s*\(/],
};

// Scripts whose payee is fixed in code and is not a seller's HTTP route.
const FIXED_TARGET = {
  // Signs a payload and posts it straight to the facilitator it is testing.
  "facilitator-mainnet-canary.js": "pays through the facilitator under test, no HTTP seller",
  // Boots its own tollbooth in process and pays that.
  "tollbooth-cdp-live.js": "pays a tollbooth it boots in process",
};

// Guarded scripts that cap with a mechanism of their own (marker required).
const OWN_CAP = {
  // Plans against list prices and refuses a quote above each row's ceiling
  // before it pays.
  "catalog-buy.js": /quote-over-ceiling/,
};

// Guarded scripts with no per-accept cap yet (see the header): each pays only
// our own service, from a burner, under its own run budget.
const PENDING_CAP = new Set([
  "algorand-rail-canary.js", "base-list-sweep.js", "capture-bestsellers.js", "challenge-sweep.js",
  "cross-chain-matrix.js", "decide-paid-e2e.mjs", "decide-prod-check.mjs", "drain-burner.js",
  "evm-settle-test.js", "rh-settle-test.js", "solana-sor-live.js", "sweep-burner.js",
]);

// Signing calls, and the environment reads that choose a target.
const SIGN = /wrapFetchWithPayment\s*\(|\.createPaymentPayload\s*\(|registerExact\w*Scheme\s*\(|new\s+Exact(?:Evm|Svm|Stellar|Avm)Scheme\s*\(|new\s+UptoEvmScheme\s*\(|Mppx\.create\s*\(|\b(?:tempo|evm)\.(?:charge|subscription)\s*\(/;
const ENV_TARGET = /process\.env\.(?:TARGET_URL|SMOKE_TARGET|AGENT402_BASE|AGENT402_URL|PROBE_URL|BASE_URL)\b|\|\|\s*["']https:\/\/agent402\.tools["']/;
const VENDOR_OFF = /disableVendorSpendControls\s*\(\s*new\b|setSpendControls\??\.?\(\s*false\s*\)/;
const GUARD_CALL = /(?<!function\s)\bassertOwnPaidTarget\s*\(/;
const OWN_POLICY = /guardCappedSigning\s*\(|registerPolicy\s*\(|onBeforePaymentCreation\s*\(/;

/** Source with line and block comments removed (a `//` inside a string such
 *  as a URL is kept: only one at a line start or after whitespace is cut). */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");
}

/** The verdict for one script: null when it passes, else the reason. */
export function verdictFor(file, rawSrc) {
  const src = stripComments(rawSrc);
  const sign = src.search(SIGN);
  if (sign < 0) return null;
  if (EXTERNAL_BY_DESIGN[file]) {
    const missing = EXTERNAL_BY_DESIGN[file].filter((re) => !re.test(src));
    if (missing.length) return `pays outside sellers on purpose but lacks its cap (${missing.map(String).join(", ")})`;
    const present = (EXTERNAL_FORBIDDEN[file] || []).filter((re) => re.test(src));
    return present.length ? `pays outside sellers on purpose but selects accepts outside the shared guard (${present.map(String).join(", ")})` : null;
  }
  if (FIXED_TARGET[file]) return null;
  const env = ENV_TARGET.test(src);
  if (/^test-/.test(file) && !env) return null;
  if (!GUARD_CALL.test(src)) return env ? "signs against an env-chosen target with no assertOwnPaidTarget call" : "signs with a target fixed in code but is not listed in FIXED_TARGET";
  const capped = OWN_POLICY.test(src) || !!(OWN_CAP[file] && OWN_CAP[file].test(src));
  if (VENDOR_OFF.test(src) && !capped && !PENDING_CAP.has(file)) {
    return "turns the library spend control off with no per-accept cap (guardCappedSigning, a signing policy, or an OWN_CAP entry)";
  }
  if (PENDING_CAP.has(file) && capped) return "is capped now: remove it from PENDING_CAP";
  return null;
}

const files = readdirSync(HERE).filter((f) => /\.(m?js)$/.test(f)).sort();
let signers = 0;
for (const f of files) {
  if (f === "test-paid-scripts-guarded.js") continue; // its fixtures are strings
  const src = readFileSync(join(HERE, f), "utf8");
  if (SIGN.test(stripComments(src))) signers++;
  const v = verdictFor(f, src);
  if (v) ok(false, `${f}: ${v}`);
}
ok(signers >= 40, `the scan sees the signing scripts (${signers})`);
ok(fail === 0, "every signing script checks its target, is listed with its reason, or signs only against what it boots");

// The lists stay honest: every entry still exists and still signs.
for (const f of [...Object.keys(EXTERNAL_BY_DESIGN), ...Object.keys(FIXED_TARGET), ...Object.keys(OWN_CAP), ...PENDING_CAP]) {
  const p = join(HERE, f);
  ok(existsSync(p) && SIGN.test(stripComments(readFileSync(p, "utf8"))), `listed ${f} exists and signs`);
}

// The verdict itself, on fixtures (each fails without its rule).
const pay = `const c = new x402Client(); registerExactEvmScheme(c, { signer }); const f = wrapFetchWithPayment(fetch, c);`;
ok(verdictFor("x.js", `const T = process.env.TARGET_URL || "https://agent402.tools";\n${pay}`) !== null, "fixture: an env target with no guard fails");
ok(verdictFor("x.js", `const T = assertOwnPaidTarget(process.env.TARGET_URL, "x");\n${pay}`) === null, "fixture: a guarded env target passes");
ok(verdictFor("x.js", `// assertOwnPaidTarget(process.env.TARGET_URL)\nconst T = process.env.TARGET_URL;\n${pay}`) !== null, "fixture: a guard in a comment does not count");
ok(verdictFor("x.js", `function assertOwnPaidTarget(u) { return u; }\nconst T = process.env.TARGET_URL;\n${pay}`) !== null, "fixture: a definition alone is not a call");
ok(verdictFor("x.js", `const T = "https://seller.example";\n${pay}`) !== null, "fixture: a fixed-in-code target must be listed");
ok(verdictFor("test-x.js", `const port = 0;\n${pay}`) === null, "fixture: a suite signing against what it boots passes");
ok(verdictFor("test-x.js", `const T = process.env.TARGET_URL || "https://agent402.tools";\n${pay}`) !== null, "fixture: a suite with a production fallback is held to the guard");
ok(verdictFor("x.js", `const T = assertOwnPaidTarget(process.env.TARGET_URL, "x");\nconst c = disableVendorSpendControls(new x402Client()); registerExactEvmScheme(c, {});`) !== null, "fixture: spend control off with no cap fails");
ok(verdictFor("x.js", `const T = assertOwnPaidTarget(process.env.TARGET_URL, "x");\nconst c = disableVendorSpendControls(new x402Client()); registerExactEvmScheme(c, {}); guardCappedSigning(c, { maxUsd: 1, networks: ["eip155:8453"] });`) === null, "fixture: spend control off with the capped guard passes");
ok(verdictFor("drain-burner.js", `const T = assertOwnPaidTarget(process.env.TARGET_URL, "x");\nconst c = disableVendorSpendControls(new x402Client()); registerExactEvmScheme(c, {}); guardCappedSigning(c, { maxUsd: 1, networks: ["eip155:8453"] });`) !== null, "fixture: a pending entry that gains a cap must leave the list");
ok(verdictFor("paid-demo.js", `const T = process.env.TARGET_URL;\n${pay}`) !== null, "fixture: an outside-seller script without its cap marker fails");
{
  const seed = readFileSync(join(HERE, "x402scan-seed.js"), "utf8");
  ok(verdictFor("x402scan-seed.js", seed) === null, "x402scan-seed.js pays through the shared capped guard");
  ok(verdictFor("x402scan-seed.js", seed.replace("guardCappedSigning(client, {", "void (client, {")) !== null, "fixture: x402scan-seed.js without the shared guard fails");
  ok(verdictFor("x402scan-seed.js", `${seed}\nconst c2 = new x402Client((v, a) => a[0]);`) !== null, "fixture: x402scan-seed.js with a selector of its own fails");
  ok(verdictFor("x402scan-seed.js", `const PAGE_QUOTE_CAP_ATOMIC = 1n; const flagName = "--max-usd";\n${pay}`) !== null, "fixture: the old selector-only cap markers no longer pass");
}

// demo-payment.js (served as /demo.js) carries its own copy of the USDC table.
{
  const src = readFileSync(join(HERE, "demo-payment.js"), "utf8");
  const block = src.match(/const KNOWN_USDC = \{([\s\S]*?)\};/)?.[1] || "";
  const rows = [...block.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
  ok(rows.length >= 5, `demo-payment.js lists its USDC rails (${rows.length})`);
  const bad = rows.filter(([n, a]) => { const e = knownAsset(n, a); return !e || e.decimals !== 6 || e.symbol !== "USDC"; });
  ok(bad.length === 0, `every demo-payment.js USDC entry is the known-assets table's, at 6 decimals (${bad.map((r) => r[0]).join(", ") || "all match"})`);
  ok(!/from\s+["']\.\.?\//.test(src) && !/import\(\s*["']\.\.?\//.test(src), "demo-payment.js still imports nothing from this repo (it is served on its own)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
