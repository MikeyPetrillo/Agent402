#!/usr/bin/env node
// Spawned helper binaries get an allowlisted environment, never the server's
// secrets. A secret-shaped sentinel is put in process.env, then:
//  1. childEnv() keeps the allowlist and drops the sentinel;
//  2. the media kit's ffmpeg call spawns a real child with the options the kit
//     passes (the runner seam swaps only the binary for node printing its env);
//  3. the in-process Chromium launched by render.js is read from the OS
//     (/proc/<pid>/environ on Linux, ps -E on macOS).
// Needs Playwright's Chromium; under CI a missing browser fails, it never skips.
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { childEnv } from "../src/tools/child-env.js";
import { transcodePcm, __setExecFileForTest } from "../src/tools/media-kit.js";
import { __test } from "../src/tools/render.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const SENTINEL = "sentinel-child-env-5c2e";
process.env.AGENT402_TEST_SECRET_KEY = SENTINEL;
process.env.STRIPE_SECRET_KEY = SENTINEL;

// 1. the allowlist
const env = childEnv();
ok(env.PATH === process.env.PATH, "PATH is passed through");
ok(!Object.values(env).includes(SENTINEL) && !("AGENT402_TEST_SECRET_KEY" in env) && !("STRIPE_SECRET_KEY" in env), "secret-shaped variables are dropped");

// 2. ffmpeg through the media kit's own runner
let childSaw = null;
__setExecFileForTest((bin, args, opts, cb) => {
  execFile(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], opts, (err, stdout) => {
    if (!err) childSaw = JSON.parse(stdout);
    cb(err, "", "");
  });
});
await transcodePcm(Buffer.alloc(64), "wav").catch(() => { /* no ffmpeg ran, so no output file */ });
__setExecFileForTest(null);
ok(childSaw && typeof childSaw.PATH === "string", "the media child process ran with a PATH");
ok(childSaw && !JSON.stringify(childSaw).includes(SENTINEL), `the media child process sees no secret (keys: ${childSaw ? Object.keys(childSaw).join(",") : "none"})`);

// 3. Chromium
function envOf(pid) {
  if (process.platform === "linux") return readFileSync(`/proc/${pid}/environ`, "latin1");
  return execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)]).toString();
}
try {
  __test.setNetworkGuard({ assertPublicUrl: async (u) => new URL(u), hostIsPublic: async () => true });
  const seen = await __test.withPage("data:text/html,<p>x</p>", async () => {
    const kids = execFileSync("pgrep", ["-P", String(process.pid)]).toString().trim().split("\n").filter(Boolean);
    const out = [];
    for (const k of kids) { try { out.push(envOf(k)); } catch { /* exited */ } }
    return out;
  });
  ok(seen.length > 0, `found the browser process (${seen.length} child process${seen.length === 1 ? "" : "es"})`);
  ok(seen.every((e) => !e.includes(SENTINEL)), "the browser process sees no secret");
} catch (e) {
  if (/Executable doesn't exist|browserType\.launch|Browser unavailable/i.test(String(e?.message))) {
    const msg = `Chromium is not installed (${String(e.message).split("\n")[0]})`;
    if (process.env.CI) { console.error(`FAIL - ${msg}`); process.exit(1); }
    console.log(`SKIP - ${msg}`);
  } else throw e;
} finally {
  __test.setNetworkGuard(null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
