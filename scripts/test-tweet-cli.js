// scripts/tweet.js media upload, offline. The script runs as a child process
// with fetch replaced by a stub (a --import preload), so nothing reaches X:
//   - --upload-only honors DRY_RUN=1 and --dry-run: it names the file it
//     would upload and makes no request at all;
//   - a refused STATUS read while a video is processing (401, 429, 5xx) is an
//     error (exit 2, the status printed), never taken as "processing done".
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const dir = mkdtempSync(join(tmpdir(), "tweet-cli-"));
const video = join(dir, "clip.mp4");
const image = join(dir, "card.png");
writeFileSync(video, Buffer.alloc(1024, 1));
writeFileSync(image, Buffer.alloc(256, 2));
const callLog = join(dir, "calls.log");

// The stub answers the chunked upload: INIT and APPEND and FINALIZE succeed,
// FINALIZE says "pending, check after 1 s", and STATUS answers STUB_STATUS.
const preload = join(dir, "stub-fetch.mjs");
writeFileSync(preload, `
import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(callLog)};
const status = Number(process.env.STUB_STATUS || 200);
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = typeof init.body === "string" ? init.body : "";
  const cmd = (u.match(/command=([A-Z]+)/) || body.match(/command=([A-Z]+)/) || [])[1] || "POST";
  appendFileSync(LOG, cmd + "\\n");
  const reply = (code, json) => new Response(JSON.stringify(json), { status: code, headers: { "content-type": "application/json" } });
  if (cmd === "INIT") return reply(202, { media_id_string: "123" });
  if (cmd === "APPEND") return new Response(null, { status: 204 });
  if (cmd === "FINALIZE") return reply(200, { media_id_string: "123", processing_info: { state: "pending", check_after_secs: 1 } });
  if (cmd === "STATUS") return status === 200 ? reply(200, { processing_info: { state: "succeeded" } }) : reply(status, { errors: [{ message: "refused" }] });
  return reply(200, { media_id_string: "456" });
};
`);

const run = (args, env = {}) => {
  writeFileSync(callLog, "");
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "scripts/tweet.js", ...args], {
    encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t", X_ACCESS_SECRET: "a", ...env },
  });
  const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean) : [];
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), calls };
};

// --- --upload-only under a dry run uploads nothing --------------------------
for (const [label, args, env] of [
  ["DRY_RUN=1", ["--media", video, "--upload-only"], { DRY_RUN: "1" }],
  ["--dry-run", ["--media", video, "--upload-only", "--dry-run"], {}],
  ["DRY_RUN=1 (image)", ["--media", image, "--upload-only"], { DRY_RUN: "1" }],
]) {
  const r = run(args, env);
  ok(r.code === 0 && r.calls.length === 0, `upload-only ${label}: exits 0 and makes no request (${r.calls.length} requests)`);
  ok(/DRY RUN/.test(r.out) && r.out.includes(args[1]) && !/media id/.test(r.out), `upload-only ${label}: names the file it would upload, reports no media id`);
}

// Control: the same stub with no dry run does upload, so the dry-run silence
// above is the flag's doing, not a stub that never answers.
{
  const r = run(["--media", video, "--upload-only"]);
  ok(r.code === 0 && r.calls.join() === "INIT,APPEND,FINALIZE,STATUS" && /media id 123/.test(r.out), `upload-only without a dry run uploads (${r.calls.join()})`);
}

// --- a refused STATUS read is an error ---------------------------------------
for (const code of [401, 429, 503]) {
  const r = run(["--media", video, "--upload-only"], { STUB_STATUS: String(code) });
  ok(r.code === 2 && new RegExp(`STATUS ${code}`).test(r.out) && !/media id/.test(r.out), `STATUS ${code}: exit 2 with the status, no media id reported (exit ${r.code})`);
}

console.log(`\ntest-tweet-cli: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
