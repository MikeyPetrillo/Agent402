#!/usr/bin/env node
// Offline tests for facilitator/access-policy.js: the open-mainnet startup
// refusal and the constant-time bearer compare, plus that index.js wires both
// and that the module ships in the package and the image.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as policy from "../facilitator/access-policy.js";

const { tokenMatches } = policy;
const openFacilitatorRefusal = policy.openFacilitatorRefusal || (() => null);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const open = { network: "stellar:pubnet", authToken: "", allowedPayTo: [], allowOpen: false };
const w = openFacilitatorRefusal(open);
ok(typeof w === "string" && /Refusing to start/.test(w) && /FACILITATOR_ALLOW_OPEN=1/.test(w), "pubnet with no token and no allowlist is refused, naming the opt-in");
ok(openFacilitatorRefusal({ ...open, authToken: "t" }) === null, "a token gates it: starts");
ok(openFacilitatorRefusal({ ...open, allowedPayTo: ["GABC"] }) === null, "a payTo allowlist gates it: starts");
ok(openFacilitatorRefusal({ ...open, allowOpen: true }) === null, "FACILITATOR_ALLOW_OPEN=1 opts in: starts");
ok(openFacilitatorRefusal({ ...open, network: "stellar:testnet" }) === null, "testnet stays permissive: starts");

ok(tokenMatches("secret-token", "secret-token") === true, "equal tokens match");
ok(tokenMatches("secret-tokeN", "secret-token") === false, "one differing byte does not match");
ok(tokenMatches("secret-token-longer", "secret-token") === false && tokenMatches("secret", "secret-token") === false, "different lengths do not match (and do not throw)");
ok(tokenMatches("", "") === false && tokenMatches("x", "") === false, "an empty expected token never matches");
ok(tokenMatches(undefined, "t") === false, "a missing presented token does not match");

const idx = read("facilitator/index.js");
ok(/if \(!tokenMatches\(token, AUTH_TOKEN\)\) return res\.status\(401\)/.test(idx) && !/token !== AUTH_TOKEN/.test(idx), "requireAuth uses the constant-time compare");
ok(/import \{ openFacilitatorRefusal, tokenMatches \} from "\.\/access-policy\.js";/.test(idx), "index.js imports the refusal");
ok(/openFacilitatorRefusal\(\{[\s\S]*?allowOpen: process\.env\.FACILITATOR_ALLOW_OPEN === "1"[\s\S]*?\}\);\s*if \(openRefusal\) \{\s*console\.error\(openRefusal\);\s*process\.exit\(1\);/.test(idx), "startup exits 1 on an open mainnet config");
// The real entry point, where the facilitator's own dependencies are installed:
// an open pubnet config exits 1 with the refusal before the signer loads.
// Offline: the RPC URL is a closed local port and no secret is set.
{
  const fdir = fileURLToPath(new URL("../facilitator/", import.meta.url));
  let hasDeps = false;
  try { await import(new URL("../facilitator/node_modules/@x402/core/package.json", import.meta.url), { with: { type: "json" } }); hasDeps = true; } catch { /* not installed in this lane */ }
  if (hasDeps) {
    const env = { ...process.env, FACILITATOR_NETWORK: "pubnet", FACILITATOR_MAINNET_RPC_URL: "https://127.0.0.1:9/", FACILITATOR_STELLAR_SECRET: "", FACILITATOR_AUTH_TOKEN: "", FACILITATOR_ALLOWED_PAYTO: "", FACILITATOR_ALLOW_OPEN: "" };
    const r = spawnSync(process.execPath, ["index.js"], { cwd: fdir, env, encoding: "utf8", timeout: 30_000 });
    ok(r.status === 1 && /Refusing to start/.test(r.stderr) && !/FACILITATOR_STELLAR_SECRET (is|must|does)/.test(r.stderr), `index.js exits 1 with the refusal, before the signer loads (status ${r.status})`);
    const optIn = spawnSync(process.execPath, ["index.js"], { cwd: fdir, env: { ...env, FACILITATOR_ALLOW_OPEN: "1" }, encoding: "utf8", timeout: 30_000 });
    ok(!/Refusing to start/.test(optIn.stderr), "control: FACILITATOR_ALLOW_OPEN=1 gets past the refusal (it then stops on the missing secret)");
  } else if (process.env.CI) {
    // Under CI a missing dependency is a failure, never a skip: the lane that
    // runs this suite installs facilitator/ (deploy.yml, test-unit-b2).
    ok(false, "facilitator/node_modules is installed for the entry-point boot check (CI)");
  } else {
    console.log("skip - facilitator/node_modules not installed; the entry-point boot check runs where it is (and fails under CI)");
  }
}
ok(JSON.parse(read("facilitator/package.json")).files.includes("access-policy.js"), "access-policy.js is in the package files list");
ok(/COPY [^\n]*facilitator\/access-policy\.js/.test(read("Dockerfile.facilitator")), "access-policy.js is copied into the image");
ok(/FACILITATOR_ALLOW_OPEN/.test(read("facilitator/README.md")), "README documents FACILITATOR_ALLOW_OPEN");
// The CI lane that runs this suite installs the facilitator's own lockfile
// first, so the boot check above runs there instead of skipping.
{
  const wf = read(".github/workflows/deploy.yml");
  const job = wf.slice(wf.indexOf("\n  test-unit-b2:\n"), wf.indexOf("\n  test-unit-b4:\n"));
  const install = job.indexOf("- name: Install facilitator dependencies (secretless)");
  const runs = job.indexOf("t node scripts/test-facilitator-access-policy.js");
  ok(job.length > 0 && install > 0 && runs > install, "test-unit-b2 installs facilitator dependencies before it runs this suite");
  ok(/- name: Install facilitator dependencies \(secretless\)[\s\S]{0,800}?working-directory: facilitator[\s\S]{0,200}?run: npm ci --ignore-scripts/.test(job), "...from facilitator/'s own lockfile, with install scripts off");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
