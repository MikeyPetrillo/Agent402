// FFmpeg video-decode lockout (audit R-06 / CVE-2026-8461 MagicYUV).
//
// CVE-2026-8461 is a heap overflow in ffmpeg's MagicYUV *video* decoder. Our
// media tools only ever process AUDIO: every `ffmpeg` invocation passes `-vn`
// (disable video), and metadata inspection uses `ffprobe` (which reads
// container/stream headers, it does not decode video frames). So the vulnerable
// decoder is never exercised — the CVE is unreachable through our flags.
//
// This test regression-LOCKS that property: it scans the source for every
// ffmpeg invocation and fails if any one is missing `-vn`. A future change that
// starts decoding video (dropping `-vn`, or transcoding to a video codec) would
// re-open the reachability and this test would catch it before it ships.
//
//   node scripts/test-ffmpeg-novideo.js
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// Collect every source file that could shell out to ffmpeg.
const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(d, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (/\.(js|mjs|cjs)$/.test(name) && p !== SELF) files.push(p);
  }
};
walk(join(ROOT, "src"));

// Match an ffmpeg invocation and capture its argument array:
//   run("ffmpeg", [ ... ])  |  execFile("ffmpeg", [ ... ])  |  spawn("ffmpeg", [ ... ])
const FFMPEG_CALL = /(?:run|execFile|execFileSync|spawn|spawnSync)\(\s*["'`]ffmpeg["'`]\s*,\s*\[([\s\S]*?)\]/g;

let ffmpegCalls = 0;
const offenders = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(FFMPEG_CALL)) {
    ffmpegCalls++;
    const args = m[1];
    // `-vn` (disable video) must be present in the arg array.
    if (!/["'`]-vn["'`]/.test(args)) {
      const rel = f.replace(ROOT + "/", "");
      offenders.push(`${rel}: ffmpeg call without -vn → ${args.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  // Belt-and-braces: no ffmpeg call may explicitly request a video codec.
  for (const m of src.matchAll(FFMPEG_CALL)) {
    if (/-c:v|-vcodec|-map\s*["'`]?0:v/.test(m[1])) {
      offenders.push(`${f.replace(ROOT + "/", "")}: ffmpeg call selects a VIDEO codec/stream`);
    }
  }
}

// There must be at least one ffmpeg call (else the scan is vacuous and the
// regex has silently broken).
ok(ffmpegCalls > 0, `found ffmpeg invocations to check (${ffmpegCalls})`);
ok(offenders.length === 0, `every ffmpeg invocation disables video (-vn), none decode video${offenders.length ? ":\n  " + offenders.join("\n  ") : ""}`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed (${ffmpegCalls} ffmpeg calls scanned)`);
process.exit(fail ? 1 : 0);
