// scripts/ci-apt-install.sh on an image whose apt sources name no Ubuntu
// archive: the update reads only a vendor repository, and the install fails
// with "Unable to locate package" on every retry. The helper must see that no
// candidate exists, add the archive's main and universe components, update
// again and install. Runs the real helper against a temp apt tree
// (CI_APT_ETC) with stub sudo, timeout, apt-get, apt-cache and getent on PATH,
// so nothing on the machine is touched. Offline.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const HELPER = fileURLToPath(new URL("./ci-apt-install.sh", import.meta.url));

function run({ archiveListed }) {
  const root = mkdtempSync(join(tmpdir(), "a402-apt-"));
  const etc = join(root, "etc-apt"), bin = join(root, "bin"), calls = join(root, "calls.log");
  mkdirSync(join(etc, "sources.list.d"), { recursive: true });
  mkdirSync(join(etc, "apt.conf.d"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(calls, "");
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // The archive is "listed" when the image ships it, or once the helper adds its own sources file.
  const listed = archiveListed ? "true" : `[ -f "${etc}/sources.list.d/ci-ubuntu-archive.sources" ]`;
  stub("sudo", `exec "$@"`);
  stub("timeout", `shift; exec "$@"`);
  stub("getent", "exit 0");
  stub("apt-get", `echo "apt-get $*" >> "${calls}"
case "$1" in
  update) if ${listed}; then echo "Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease"; touch "${root}/updated-with-archive"; else echo "Hit:1 https://packages.microsoft.com/ubuntu/24.04/prod noble InRelease"; fi ;;
  install) [ -f "${root}/updated-with-archive" ] || { echo "E: Unable to locate package ffmpeg"; exit 100; } ;;
esac`);
  stub("apt-cache", `if [ -f "${root}/updated-with-archive" ]; then echo "  Candidate: 7:6.1.1-3ubuntu5"; else echo "  Candidate: (none)"; fi`);
  const r = spawnSync("bash", [HELPER, "ffmpeg"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI_APT_ETC: etc }, encoding: "utf8", timeout: 60_000 });
  const out = { status: r.status, stdout: r.stdout + r.stderr, calls: readFileSync(calls, "utf8").trim().split("\n"), added: existsSync(join(etc, "sources.list.d", "ci-ubuntu-archive.sources")) ? readFileSync(join(etc, "sources.list.d", "ci-ubuntu-archive.sources"), "utf8") : null };
  rmSync(root, { recursive: true, force: true });
  return out;
}

const bare = run({ archiveListed: false });
ok(bare.status === 0, `an image with no Ubuntu archive source still installs ffmpeg on the first attempt (exit ${bare.status})`);
ok(bare.calls.join("|") === "apt-get update -q|apt-get update -q|apt-get install -y -q ffmpeg", `the helper updates, sees no candidate, updates again with the archive and installs (${bare.calls.join(" | ")})`);
ok(/Components: main universe/.test(bare.added || "") && /URIs: http:\/\/archive\.ubuntu\.com\/ubuntu\//.test(bare.added || "") && /Suites: \S+ \S+-updates \S+-security/.test(bare.added || "") && /Signed-By: \/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/.test(bare.added || ""), "the added source names the archive's main and universe components, updates and security, signed by the archive keyring");
ok(/adding the Ubuntu archive/.test(bare.stdout) && !/retrying/.test(bare.stdout), "the log says why the source was added, and no retry was spent on it");

const normal = run({ archiveListed: true });
ok(normal.status === 0 && normal.calls.join("|") === "apt-get update -q|apt-get install -y -q ffmpeg", `an image that lists the archive gets one update and the install (${normal.calls.join(" | ")})`);
ok(normal.added === null, "nothing is added when the package resolves");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
