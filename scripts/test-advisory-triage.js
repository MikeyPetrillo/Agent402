// The heartbeat's security advisory triage check: scripts/advisory-triage-check.js
// run as the workflow runs it, against a stub GitHub API on port 0, and the
// heartbeat.yml step's own shell run with gh stubbed (nothing reaches GitHub).
//
// Pages on a triage advisory older than 24 h; not on a younger one, an
// acknowledged id (ADVISORY_TRIAGE_ACK) or a published one; reads every page;
// a refused or missing read is "unreadable", its own issue, never a pass. The
// issue is public: GHSA ids and ages only, never advisory text or the token.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "advisory-triage-check.js");
const TOKEN = "github_pat_STUBTOKEN0123456789";
const SECRET_TEXT = "Reflected input in the private report";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.error(`FAIL - ${name}: ${e?.stack || e}`); }
}

const hoursAgo = (h) => new Date(Date.now() - h * 3.6e6).toISOString();
const adv = (id, h, state = "triage") => ({ ghsa_id: id, state, created_at: hoursAgo(h), summary: SECRET_TEXT, description: SECRET_TEXT, severity: "high" });
const OLD = "GHSA-2222-3333-4444";
const OLD2 = "GHSA-5555-6666-7777";
const YOUNG = "GHSA-8888-9999-cccc";
const PUB = "GHSA-ffff-gggg-hhhh";

// scenario: { status, pages: [[...], ...], foreignNext }
let scenario = { status: 200, pages: [[]] };
const seen = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  seen.push({ path: u.pathname, state: u.searchParams.get("state"), auth: req.headers.authorization || "" });
  if (u.pathname !== "/repos/o/r/security-advisories") { res.writeHead(404); return res.end("{}"); }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end(JSON.stringify({ message: "Bad credentials" })); }
  if (scenario.status !== 200) { res.writeHead(scenario.status); return res.end(JSON.stringify({ message: SECRET_TEXT })); }
  const page = Number(u.searchParams.get("page") || 1);
  const rows = scenario.pages[page - 1] || [];
  const headers = { "content-type": "application/json" };
  if (page < scenario.pages.length) {
    const next = scenario.foreignNext ? "http://192.0.2.1/next" : `http://127.0.0.1:${server.address().port}/repos/o/r/security-advisories?state=triage&per_page=100&page=${page + 1}`;
    headers.link = `<${next}>; rel="next", <http://127.0.0.1/last>; rel="last"`;
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify(rows));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${server.address().port}`;

const dir = await mkdtemp(path.join(tmpdir(), "adv-triage-"));

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const baseEnv = (extra = {}) => {
  const env = { ...process.env, GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: API, ADVISORY_READ_TOKEN: TOKEN, ADVISORY_TRIAGE_ACK: "", ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
};

async function script(sc, extra = {}) {
  scenario = sc;
  const bodyFile = path.join(dir, "body.md");
  await rm(bodyFile, { force: true });
  const r = await run(process.execPath, [SCRIPT], baseEnv({ ADVISORY_BODY_FILE: bodyFile, ...extra }));
  r.body = await readFile(bodyFile, "utf8").catch(() => "");
  return r;
}

const noLeak = (r) => {
  for (const text of [r.stdout, r.stderr, r.body]) {
    assert.ok(!text.includes(TOKEN), "the token is never printed or posted");
    assert.ok(!text.includes(SECRET_TEXT), "advisory text is never printed or posted");
    assert.ok(!/\bhigh\b/.test(text), "severity is never printed or posted");
  }
};

await check("a triage advisory older than 24 h pages with its id and age", async () => {
  const r = await script({ status: 200, pages: [[adv(OLD, 30)]] });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.body, new RegExp(`${OLD}: in triage 30 h`));
  assert.match(r.stdout, /1 past 24 h/);
  noLeak(r);
  const last = seen.at(-1);
  assert.equal(last.state, "triage", "the read asks for state=triage");
  assert.equal(last.auth, `Bearer ${TOKEN}`, "the read carries the advisory token");
});

await check("a triage advisory younger than 24 h does not page", async () => {
  const r = await script({ status: 200, pages: [[adv(YOUNG, 3)]] });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body, "", "no issue body on a clear read");
  assert.match(r.stdout, /clear \(1 in triage, 0 acknowledged, 0 past 24 h\)/);
  noLeak(r);
});

await check("an acknowledged id does not page (case and spaces ignored), others still do", async () => {
  let r = await script({ status: 200, pages: [[adv(OLD, 40)]] }, { ADVISORY_TRIAGE_ACK: ` ${OLD.toLowerCase()} , GHSA-xxxx-xxxx-xxxx` });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /1 acknowledged/);
  r = await script({ status: 200, pages: [[adv(OLD, 40), adv(OLD2, 50)]] }, { ADVISORY_TRIAGE_ACK: OLD });
  assert.equal(r.code, 1);
  assert.ok(r.body.includes(OLD2) && !r.body.includes(OLD), "only the unacknowledged id is listed");
  noLeak(r);
});

await check("a published advisory in the answer is ignored", async () => {
  const r = await script({ status: 200, pages: [[adv(PUB, 500, "published"), adv(YOUNG, 1)]] });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /1 in triage/);
});

await check("every page is read: a stale advisory on page 2 pages", async () => {
  const before = seen.length;
  const r = await script({ status: 200, pages: [[adv(YOUNG, 2)], [adv(OLD2, 26)]] });
  assert.equal(r.code, 1, r.stdout);
  assert.ok(r.body.includes(OLD2));
  assert.equal(seen.length - before, 2, "two pages were read");
});

await check("a next page on another origin is unreadable, the token is not sent there", async () => {
  const r = await script({ status: 200, pages: [[adv(YOUNG, 2)], [adv(OLD2, 26)]], foreignNext: true });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stdout, /UNREADABLE \(next page on another origin\)/);
});

for (const status of [401, 403, 500, 503]) {
  await check(`HTTP ${status} is unreadable, never a pass`, async () => {
    const r = await script({ status, pages: [[]] });
    assert.equal(r.code, 2, r.stdout);
    assert.match(r.stdout, new RegExp(`UNREADABLE \\(http ${status}\\)`));
    assert.match(r.body, /ADVISORY_READ_TOKEN/);
    noLeak(r);
  });
}

await check("a wrong token reads 401: unreadable", async () => {
  const r = await script({ status: 200, pages: [[adv(OLD, 30)]] }, { ADVISORY_READ_TOKEN: "wrong" });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /http 401/);
});

await check("a missing token is unreadable, never a skip", async () => {
  const r = await script({ status: 200, pages: [[]] }, { ADVISORY_READ_TOKEN: undefined });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /UNREADABLE \(token missing\)/);
});

await check("an unreachable API is unreadable", async () => {
  const r = await script({ status: 200, pages: [[]] }, { GITHUB_API_URL: "http://127.0.0.1:9" });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /UNREADABLE \(network error\)/);
});

// The heartbeat.yml step, run as written with gh stubbed.
const wf = yamlLoad(await readFile(path.join(ROOT, ".github/workflows/heartbeat.yml"), "utf8"));
const steps = Object.values(wf.jobs).flatMap((j) => j.steps || []);
const step = steps.find((s) => String(s.name || "").startsWith("Security advisory triage check"));
const TITLE = "Security advisory waiting in triage";
const TITLE2 = "Security advisory check cannot read";

await check("heartbeat.yml wires the step: token from the secret, ack list from the repo variable, never fails the run", async () => {
  assert.ok(step, "heartbeat.yml has the Security advisory triage check step");
  assert.equal(step.env?.ADVISORY_READ_TOKEN, "${{ secrets.ADVISORY_READ_TOKEN }}");
  assert.equal(step.env?.ADVISORY_TRIAGE_ACK, "${{ vars.ADVISORY_TRIAGE_ACK }}");
  assert.equal(step["if"], "always()");
  assert.equal(step["continue-on-error"], true);
  assert.match(step.run, /node scripts\/advisory-triage-check\.js/);
  assert.ok(!/\$\{\{/.test(step.run), "no expression is interpolated into the shell");
});

await writeFile(path.join(dir, "gh"), `#!/usr/bin/env bash
{ printf 'CALL'; for a in "$@"; do printf ' [%s]' "$a"; done; echo; } >> "${dir}/gh.log"
prev=""; for a in "$@"; do if [ "$prev" = "--body-file" ]; then { echo "BODY<<"; cat "$a"; echo ">>"; } >> "${dir}/gh.log"; fi; prev="$a"; done
if [ "$1 $2" = "issue list" ]; then
  case "$*" in *"cannot read"*) cat "${dir}/open2" 2>/dev/null;; *"waiting in triage"*) cat "${dir}/open1" 2>/dev/null;; esac
fi
exit 0
`);
await chmod(path.join(dir, "gh"), 0o755);

async function runStep(sc, { open1 = "", open2 = "", env = {} } = {}) {
  scenario = sc;
  await writeFile(path.join(dir, "open1"), open1);
  await writeFile(path.join(dir, "open2"), open2);
  await rm(path.join(dir, "gh.log"), { force: true });
  const r = await run("bash", ["-eo", "pipefail", "-c", step.run], baseEnv({
    PATH: `${dir}:${path.dirname(process.execPath)}:${process.env.PATH}`, RUNNER_TEMP: dir, GH_TOKEN: "x", ...env,
  }));
  r.log = await readFile(path.join(dir, "gh.log"), "utf8").catch(() => "");
  return r;
}
const calls = (log, verb) => log.split("\n").filter((l) => l.startsWith(`CALL [issue] [${verb}]`));

await check("step: stale and no issue open -> one issue created with ids and ages", async () => {
  const r = await runStep({ status: 200, pages: [[adv(OLD, 30), adv(YOUNG, 2)]] });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const created = calls(r.log, "create");
  assert.equal(created.length, 1, r.log);
  assert.ok(created[0].includes(`[${TITLE}]`));
  assert.match(r.log, new RegExp(`${OLD}: in triage 30 h`));
  assert.ok(!r.log.includes(YOUNG), "a young advisory is not listed");
  assert.equal(calls(r.log, "close").length, 0);
  assert.ok(!r.log.includes(TOKEN) && !r.log.includes(SECRET_TEXT) && !r.stdout.includes(TOKEN));
});

await check("step: stale with the issue open -> a comment, no second issue; an open unreadable issue closes", async () => {
  const r = await runStep({ status: 200, pages: [[adv(OLD, 30)]] }, { open1: "41", open2: "42" });
  assert.equal(calls(r.log, "create").length, 0, r.log);
  const commented = calls(r.log, "comment");
  assert.equal(commented.length, 1);
  assert.ok(commented[0].includes("[41]"));
  const closed = calls(r.log, "close");
  assert.equal(closed.length, 1);
  assert.ok(closed[0].includes("[42]"));
});

await check("step: clear -> both open issues close, nothing created", async () => {
  const r = await runStep({ status: 200, pages: [[adv(YOUNG, 1)]] }, { open1: "41", open2: "42" });
  assert.equal(calls(r.log, "create").length, 0, r.log);
  const closed = calls(r.log, "close").join("\n");
  assert.ok(closed.includes("[41]") && closed.includes("[42]"), r.log);
});

await check("step: clear with nothing open -> no issue writes", async () => {
  const r = await runStep({ status: 200, pages: [[]] });
  assert.equal(r.log.split("\n").filter((l) => l.startsWith("CALL") && !l.includes("[list]")).length, 0, r.log);
});

await check("step: 401 -> the unreadable issue opens, the triage issue is left as it was", async () => {
  const r = await runStep({ status: 401, pages: [[]] }, { open1: "41" });
  const created = calls(r.log, "create");
  assert.equal(created.length, 1, r.log);
  assert.ok(created[0].includes(`[${TITLE2}]`));
  assert.equal(calls(r.log, "close").length, 0, "a blind read never closes the triage issue");
  assert.match(r.stdout, /UNREADABLE/);
  assert.ok(!r.log.includes(SECRET_TEXT));
});

await check("step: missing token -> unreadable issue (commented when already open)", async () => {
  const r = await runStep({ status: 200, pages: [[]] }, { open2: "42", env: { ADVISORY_READ_TOKEN: "" } });
  const commented = calls(r.log, "comment");
  assert.equal(commented.length, 1, r.log);
  assert.ok(commented[0].includes("[42]"));
  assert.match(r.log, /token missing/);
});

await check("step: an acknowledged stale id does not open an issue", async () => {
  const r = await runStep({ status: 200, pages: [[adv(OLD, 30)]] }, { env: { ADVISORY_TRIAGE_ACK: OLD } });
  assert.equal(calls(r.log, "create").length, 0, r.log);
});

server.close();
await rm(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
