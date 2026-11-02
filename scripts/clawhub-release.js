// Publish ./openclaw to ClawHub from the publish job, idempotently, and ride
// out ClawHub's write rate limit. The workflow step logs in first (token and
// config path stay in that step), then runs this with VERSION in the env.
//
//   inspect  exit 0                      -> already on ClawHub, done
//   inspect  "Too many writes"           -> wait the hinted seconds, retry
//   inspect  "not found"                 -> publish
//   inspect  anything else               -> fail (never fall through to a publish)
//   publish  exit 0 / "already exists"   -> done
//   publish  "staged by failed publish"  -> warning, done (theirs to clear)
//   publish  "Too many writes"           -> wait, retry; anything else fails
//
// The "(reset in Ns)" suffix rides on every ClawHub answer, not only on rate
// limits, so only the "Too many writes" wording marks a limit. At most
// MAX_ATTEMPTS tries per call inside one BUDGET_MS across both calls.
// Imports nothing outside node: the publish job installs no packages.
import { spawnSync } from "node:child_process";

const env = process.env;
const scale = Number(env.CLAWHUB_TIME_SCALE) > 0 ? Number(env.CLAWHUB_TIME_SCALE) : 1;
const MAX_ATTEMPTS = 3;
const BUDGET_MS = 60000 * scale;
const MAX_WAIT_MS = 20000 * scale;
const cli = (env.CLAWHUB_CMD || "npx -y clawhub@0.23.3").split(/\s+/).filter(Boolean);
const version = env.VERSION;
const started = Date.now();

const RATE = /too many writes|too many requests|rate.?limit(ed)?/i;
const NOT_FOUND = /not found/i;

function run(args) {
  const r = spawnSync(cli[0], [...cli.slice(1), ...args], { encoding: "utf8", env });
  return { code: r.status ?? 1, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms)); };

// Runs args, retrying only a rate-limited answer. Returns the last result;
// `limited` is true when the attempts or the budget ran out still limited.
function call(args) {
  let r;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    r = run(args);
    if (r.code === 0 || !RATE.test(r.out)) return { ...r, limited: false };
    const hint = Number((/reset in (\d+)s/i.exec(r.out) || [])[1]);
    const base = Number.isFinite(hint) && hint > 0 ? hint * 1000 * scale : 5000 * scale;
    const wait = Math.min(MAX_WAIT_MS, base + 500 * scale);
    if (attempt === MAX_ATTEMPTS || Date.now() - started + wait > BUDGET_MS) break;
    console.log(`ClawHub rate limited (attempt ${attempt}) - waiting ${Math.ceil(wait / scale / 1000)}s`);
    sleep(wait);
  }
  return { ...r, limited: true };
}
const fail = (msg, out) => { if (out) console.log(out); console.log(`::error::${msg}`); process.exit(1); };

if (!version) fail("VERSION is not set");

const ins = call(["package", "inspect", "agent402-openclaw", "--version", version]);
if (ins.code === 0) {
  console.log(`agent402-openclaw@${version} is already on ClawHub - nothing to do`);
  process.exit(0);
}
if (ins.limited) fail("ClawHub inspect stayed rate limited; not publishing blind", ins.out);
if (!NOT_FOUND.test(ins.out)) fail("ClawHub inspect failed for a reason other than not-found", ins.out);

// --manual-override-reason: the package carries a trusted-publisher config,
// which makes a token publish a "manual" one that ClawHub refuses without a
// stated reason. OIDC publishing needs ClawHub's reusable workflow, whose
// actions are tag-pinned, and this repository requires full-SHA pinning.
const pub = call([
  "package", "publish", "./openclaw",
  "--manual-override-reason", "repository policy requires SHA-pinned actions; ClawHub's reusable OIDC workflow is tag-pinned",
  "--source-repo", env.GITHUB_REPOSITORY || "", "--source-commit", env.GITHUB_SHA || "",
  "--source-ref", env.GITHUB_REF_NAME || "", "--source-path", "openclaw",
  "--changelog", `agent402-openclaw ${version} (see the package README and CHANGELOG at https://agent402.tools/changelog)`,
]);
if (pub.code === 0) {
  console.log(pub.out);
  console.log(`published agent402-openclaw@${version} -> https://clawhub.ai/plugins/agent402-openclaw (hidden until ClawHub review completes)`);
} else if (pub.limited) {
  fail("ClawHub publish stayed rate limited", pub.out);
} else if (/already exists/.test(pub.out)) {
  // A version still under review is hidden from inspect, so a re-run reaches
  // publish and is refused "already exists": the no-op inspect means.
  console.log(`agent402-openclaw@${version} is already on ClawHub (hidden while under review) - nothing to do`);
} else if (/is staged by failed publish attempt/.test(pub.out)) {
  console.log(pub.out);
  console.log(`::warning::agent402-openclaw@${version} is staged on ClawHub behind a failed ClawHub scan; npm and the MCP Registry are published`);
} else {
  fail("ClawHub publish failed", pub.out);
}
