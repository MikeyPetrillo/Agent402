// Supply-chain guards for the packages we PUBLISH and the pipeline that
// publishes them. Every assertion here encodes a 2026 attack that actually
// happened to somebody else:
//
//   - npm publish tokens must never share a step with code execution. The
//     ChainDrop/Shai-Hulud worm family steals exactly this: a publish token
//     exposed to a dependency's install script, then used to republish every
//     package that token can reach. Our llamaindex publish step used to run a
//     remote `npm install` of a large third-party tree with NODE_AUTH_TOKEN in
//     env (fixed 2026-08-05).
//   - Published packages must ship no install hooks: a consumer running
//     `npm install agent402-*` must never execute our code.
//   - Published tarballs must be `files`-allowlisted, so a stray .env/.npmrc
//     can never ship.
//   - Remote installs in tests must pin an exact version and skip scripts.
//
// Offline (reads the workflow + package manifests; no network, no installs).
//   node scripts/test-supply-chain-guards.js
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const ROOT = new URL("..", import.meta.url).pathname;
const wf = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");

// --- 1. token isolation ----------------------------------------------------
// We now publish over OIDC, so normally there are ZERO token-bearing steps and
// this section has nothing to check (section 4 asserts that absence). It stays
// because the documented rollback re-adds a token: if that ever happens, the
// isolation rule must still hold - a token may never share a step with code
// execution, which is how the worm family harvests publish credentials.
//
// Matching is on a real `env:` binding only. An earlier version of this test
// matched the token string anywhere in the step text, so it counted the
// ROLLBACK COMMENT as a token-bearing step and reported "found 1" long after
// the tokens were gone - green for the wrong reason.
const steps = wf.split(/\n      - name: /).slice(1);
const bindsToken = (s) => s.split("\n").some((l) =>
  /^\s+NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./.test(l) && !l.trim().startsWith("#"));
const tokenSteps = steps.filter(bindsToken);
const EXEC = /node\s+\S+\.(js|mjs|cjs)|npm\s+(ci|install)\b|npx\s/;
for (const s of tokenSteps) {
  const name = s.split("\n")[0].trim();
  // The publish command itself is allowed; strip it before looking for exec.
  const body = s.replace(/npm (publish|view)[^\n]*/g, "");
  ok(!EXEC.test(body), `token step runs no code: "${name.slice(0, 52)}"`);
}
ok(true, `token-bearing publish steps: ${tokenSteps.length} (0 expected under trusted publishing)`);

// A credential does not have to arrive via `env:` to be present. The OIDC
// preflight exchanges for a real short-lived publish token, and an earlier
// version wrote npm's response to a fixed path that outlived the step - which
// this guard could not see, because it only ever matched env bindings. The
// stated invariant is "no publish credential shares an execution context with
// third-party code", so assert the DISK form too: anything that curls npm's
// token-exchange endpoint to a file must delete that file in the same step.
const exchangeSteps = steps.filter((s) => s.includes("oidc/token/exchange"));
for (const s of exchangeSteps) {
  const name = s.split("\n")[0].trim();
  const writesToFile = /curl[^\n]*-o\s+(\S+)/.exec(s);
  if (!writesToFile) { ok(true, `OIDC exchange step keeps the response off disk: "${name.slice(0, 40)}"`); continue; }
  const path = writesToFile[1];
  ok(s.includes(`rm -f ${path}`), `OIDC exchange step deletes ${path} before the step ends: "${name.slice(0, 40)}"`);
}
// Same reasoning for `sed -i.bak` on the npmrc: the .bak retains the original
// auth line.
for (const s of steps) {
  if (!/sed -i\.bak[^\n]*_authToken/.test(s)) continue;
  const name = s.split("\n")[0].trim();
  ok(/rm -f "?\$NPMRC\.bak"?/.test(s), `npmrc backup is deleted after stripping the auth line: "${name.slice(0, 40)}"`);
}

// --- 2. no install hooks in anything we publish ----------------------------
const pkgDirs = ["mcp", "tollbooth", "client", "openclaw",
  ...readdirSync(join(ROOT, "adapters"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, "adapters", d.name, "package.json")))
    .map((d) => `adapters/${d.name}`)];
ok(pkgDirs.length >= 11, `discovered ${pkgDirs.length} publishable packages`);

const HOOKS = ["preinstall", "install", "postinstall", "prepare", "prepublish"];
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  if (pkg.private === true) continue;
  const hooks = HOOKS.filter((h) => pkg.scripts?.[h]);
  ok(hooks.length === 0, `${pkg.name}: no consumer-install hooks${hooks.length ? ` (found ${hooks})` : ""}`);
  ok(Array.isArray(pkg.files) && pkg.files.length > 0, `${pkg.name}: ships a files allowlist`);
  ok(!existsSync(join(ROOT, dir, ".npmignore")), `${pkg.name}: no .npmignore (allowlist-only is the safe pattern)`);
}

// --- 2b. signing libraries resolve to what was tested ---------------------------
// A package that signs payments ships exact versions of the libraries that
// sign, equal to the versions its lockfile was tested with: a range lets a
// consumer's install take a newer patch nobody here ran. A package that takes
// a payment library as a peer caps every peer below the next major, so a
// major nobody here ran is never accepted unseen.
{
  const SIGNING = ["viem", "@solana/kit", "@modelcontextprotocol/sdk", "@x402/core", "@x402/evm", "@x402/fetch", "@x402/svm"];
  const pkg = JSON.parse(readFileSync(join(ROOT, "mcp/package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(ROOT, "mcp/package-lock.json"), "utf8"));
  for (const name of SIGNING) {
    const spec = pkg.dependencies?.[name];
    if (spec === undefined) continue;
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    ok(/^\d+\.\d+\.\d+$/.test(spec), `${pkg.name}: ${name} is pinned to an exact version (${spec})`);
    ok(spec === locked, `${pkg.name}: ${name} ${spec} is the version its lockfile resolves (${locked})`);
    ok(lock.packages?.[""]?.dependencies?.[name] === spec, `${pkg.name}: the lockfile's root records ${name} as ${spec}`);
  }
  ok(lock.packages?.[""]?.version === pkg.version && lock.version === pkg.version, `${pkg.name}: the lockfile carries the package version (${pkg.version})`);
  // Every peer of a package that takes a payment library as a peer (an
  // @x402 package, @coinbase/x402 or viem) is capped below the next major.
  const PAYMENT_PEER = /^(@x402\/|@coinbase\/x402$|viem$)/;
  let capped = 0;
  for (const dir of pkgDirs) {
    const p = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
    const peers = Object.entries(p.peerDependencies || {});
    if (!peers.some(([name]) => PAYMENT_PEER.test(name))) continue;
    capped++;
    for (const [name, range] of peers) ok(/<\s*\d/.test(range), `${p.name}: peer ${name} carries an upper bound (${range})`);
  }
  ok(capped >= 4, `peer caps checked on every package with a payment peer (${capped})`);
}

// --- 2c. the tollbooth Docker image installs exact versions ------------------
// The image's npm install names the tollbooth release this tree carries and
// the x402 packages at the versions the root lockfile resolves.
{
  const df = readFileSync(join(ROOT, "tollbooth/deploy/docker/Dockerfile"), "utf8");
  const line = df.split("\n").find((l) => /\bnpm install /.test(l)) || "";
  const specs = line.split("npm install ")[1]?.trim().split(/\s+/).filter((t) => !t.startsWith("-")) || [];
  const tbVersion = JSON.parse(readFileSync(join(ROOT, "tollbooth/package.json"), "utf8")).version;
  const rootLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  ok(specs.length >= 4, `the tollbooth image installs the tollbooth and its x402 packages (${specs.join(" ")})`);
  for (const spec of specs) {
    const m = /^(@?[^@]+)@(\d+\.\d+\.\d+)$/.exec(spec);
    ok(Boolean(m), `tollbooth image: ${spec} is pinned to an exact version`);
    if (!m) continue;
    const want = m[1] === "agent402-tollbooth" ? tbVersion : rootLock.packages?.[`node_modules/${m[1]}`]?.version;
    ok(m[2] === want, `tollbooth image: ${m[1]}@${m[2]} is the version this tree carries (${want})`);
  }
}

// --- 3. remote installs in tests are pinned + scriptless --------------------
// A range like ^0.12 is NOT a pin: it takes any new 0.12.x, which is precisely
// how worm-published patch versions land in CI.
for (const dir of pkgDirs) {
  const t = join(ROOT, dir, "test.js");
  if (!existsSync(t)) continue;
  const src = readFileSync(t, "utf8");
  for (const m of src.matchAll(/npm install ([^"']+)/g)) {
    const cmd = m[1];
    const spec = cmd.trim().split(/\s+/)[0];
    const local = spec.startsWith(".") || spec.startsWith("/");
    ok(cmd.includes("--ignore-scripts"), `${dir}: install of "${spec}" skips lifecycle scripts`);
    if (!local) {
      ok(/@\d+\.\d+\.\d+$/.test(spec), `${dir}: remote install "${spec}" pins an EXACT version (no ^ or ~ range)`);
    }
  }
}

// --- 4. no npm credential in CI at all (trusted publishing) -----------------
// Migrated 2026-08-05: auth is GitHub OIDC exchanged against each package's
// trusted publisher on npmjs.com. A long-lived token in the workflow would
// silently take precedence over OIDC and put a publish credential back in
// reach of a compromised secret - so its ABSENCE is the invariant. (The
// documented rollback line in a comment is allowed; an actual env binding
// is not.)
const tokenBindings = wf.split("\n").filter((l) =>
  /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./.test(l) && !l.trim().startsWith("#"));
ok(tokenBindings.length === 0, `no npm token is bound in the workflow${tokenBindings.length ? ` (found ${tokenBindings.length})` : ""}`);
ok(/id-token: write/.test(wf), "publish job still grants id-token: write (the OIDC credential)");
ok(/npm install -g npm@11\./.test(wf), "publish job pins an npm CLI new enough to exchange OIDC");

// --- 5. publish reachability ------------------------------------------------
ok(!wf.includes("pull_request_target"), "no pull_request_target in the deploy workflow (fork-PR privilege escalation)");
ok(/npm publish --provenance/.test(wf), "publishes carry --provenance");

// --- 6. the OIDC credential never shares a job with a lifecycle script ------
// The id-token is the publish credential under trusted publishing: npm
// exchanges it for a short-lived publish token on every `npm publish`. Until
// 2026-09-03 the same job also ran a scripted `npm ci` (better-sqlite3 needs
// its prebuild for the server-booting gates), so a dependency's postinstall
// executed in a job that could publish under every name we own - the same
// shape as section 1, one level up: not a token in `env:`, a credential in
// the job. The gates now live in `publish-gate` (no id-token, no registry-url,
// no environment) and `publish` requires that job's SUCCESS and installs
// nothing. Parsed, not grepped: a step-level regex cannot tell which JOB a
// line belongs to, and the whole point is the job boundary.
const { load: loadYaml } = await import("js-yaml");
const jobs = loadYaml(wf).jobs || {};
const runsOf = (j) => (j.steps || []).map((s) => String(s.run || ""));
const holdsIdToken = ([, j]) => j.permissions && j.permissions["id-token"] === "write";
const credentialJobs = Object.entries(jobs).filter(holdsIdToken).map(([n]) => n);
ok(credentialJobs.length === 1 && credentialJobs[0] === "publish",
  `exactly one job holds id-token: write, and it is publish (found: ${credentialJobs.join(", ") || "none"})`);
for (const name of credentialJobs) {
  const j = jobs[name];
  // An install of anything but the npm CLI itself (pinned, --ignore-scripts)
  // is a lifecycle script beside the credential. `npm ci` with no flag, `npm
  // install <pkg>`, `npm --prefix x ci` - all of them.
  const installs = runsOf(j).flatMap((r) => r.split("\n")).map((l) => l.trim())
    .filter((l) => /^npm(\s+--prefix\s+\S+)?\s+(ci|install|i)\b/.test(l) && !l.startsWith("#"))
    .filter((l) => !/^npm install -g npm@\d+\.\d+\.\d+ --ignore-scripts$/.test(l));
  ok(installs.length === 0, `${name}: no dependency install runs beside the OIDC credential${installs.length ? ` (found: ${installs.join(" | ")})` : ""}`);
  // The gates execute third-party code (server boot, adapter self-installs).
  const gateLike = (j.steps || []).filter((s) => /^(Gate |MCP e2e gate|MCP package gate|Boot FREE_MODE)/.test(String(s.name || "")));
  ok(gateLike.length === 0, `${name}: no gate step runs beside the OIDC credential${gateLike.length ? ` (found: ${gateLike.map((s) => s.name).join(" | ")})` : ""}`);
  // `npx` installs a tree at run time; it is allowed only with lifecycle
  // scripts disabled for that step, and only a pinned version.
  for (const s of j.steps || []) {
    const run = String(s.run || "");
    if (!/\bnpx\s/.test(run)) continue;
    const label = String(s.name || "").slice(0, 40);
    ok(String(s.env?.NPM_CONFIG_IGNORE_SCRIPTS) === "true", `${name}: npx step "${label}" disables lifecycle scripts`);
    for (const m of run.matchAll(/\bnpx\s+(?:-y\s+)?([^\s]+)/g)) {
      ok(/@\d+\.\d+\.\d+$/.test(m[1]), `${name}: npx runs an exactly pinned package (${m[1]})`);
    }
  }
  ok((j.steps || []).some((s) => s.with && s.with["registry-url"]),
    `${name}: setup-node declares registry-url (npm publish resolves the registry from it)`);
}
// The gate job: the tests still run, somewhere without the credential, and the
// credential job cannot start unless they SUCCEEDED (a skipped gate is not a
// passed gate: !cancelled() drops the implicit success()).
const gate = jobs["publish-gate"];
ok(!!gate, "publish-gate job exists");
if (gate) {
  ok(!(gate.permissions && gate.permissions["id-token"]), "publish-gate holds no id-token");
  ok(!gate.environment, "publish-gate is outside the protected environment (nothing there to protect)");
  ok(!(gate.steps || []).some((s) => s.with && s.with["registry-url"]), "publish-gate's setup-node has no registry-url (no npmrc auth line to strip)");
  const gateSteps = (gate.steps || []).map((s) => String(s.name || ""));
  ok(gateSteps.some((n) => /^MCP e2e gate/.test(n)) && gateSteps.filter((n) => /^Gate /.test(n)).length >= 10,
    `publish-gate runs the package gates (${gateSteps.filter((n) => /^Gate |gate/.test(n)).length} gate steps)`);
  ok(runsOf(gate).some((r) => /\bnpm ci\b/.test(r)), "publish-gate installs the tree (the server-booting gates need better-sqlite3's prebuild)");
  const pub = jobs.publish || {};
  ok([].concat(pub.needs || []).includes("publish-gate"), "publish needs publish-gate");
  ok(String(pub.if || "").includes("needs.publish-gate.result == 'success'"), "publish requires publish-gate to have SUCCEEDED (not merely not-failed)");
  ok(String(pub.if || "").includes("!cancelled()"), "publish keeps !cancelled() so the written-out success checks are what gate it");
  // Same triggers: a gate that fires on a different condition than the job it
  // protects is a gate that can be skipped while publish still waits on
  // nothing.
  ok(String(gate.if || "").replace(/\s+/g, " ").trim() === String(pub.if || "").replace(/\s+/g, " ").replace(/&& needs\.publish-gate\.result == 'success'/, "").trim(),
    "publish-gate fires on exactly publish's own condition (minus the gate requirement itself)");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
