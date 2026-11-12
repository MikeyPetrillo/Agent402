#!/usr/bin/env node
// Every tracked Dockerfile builds on one Node patch release. A security
// release moved the main images and left the tollbooth image a patch behind;
// this keeps every node base on the same major.minor.patch, pinned by digest,
// so the next bump moves all of them or fails here. The variant (slim, alpine)
// may differ per image; the version and the digest pin may not.
//
// Also: the tollbooth image runs as the unprivileged node user, set before
// its CMD, and the directory its one optional file lives in is that user's.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// A Dockerfile by name: Dockerfile, Dockerfile.<x>, <x>.Dockerfile, anywhere in the tree.
const isDockerfile = (p) => /(^|\/)(Dockerfile(\.[^/]+)?|[^/]+\.Dockerfile)$/.test(p);
const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(isDockerfile);

// FROM [--platform=...] <image> [AS name]; a continuation line is not a FROM.
const fromsOf = (text) => text.split("\n")
  .map((l) => l.match(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/i)?.[1])
  .filter(Boolean);
const NODE_RE = /^(?:docker\.io\/)?(?:library\/)?node:(\d+\.\d+\.\d+)-([a-z][a-z0-9.]*)@sha256:[0-9a-f]{64}$/;

const patches = new Map(); // version -> [file]
let nodeBases = 0;
for (const f of files) {
  const text = readFileSync(join(ROOT, f), "utf8");
  const froms = fromsOf(text);
  ok(froms.length > 0, `${f}: has a FROM line`);
  // A stage built from an earlier stage (FROM build AS run) is not a base image.
  const stages = new Set([...text.matchAll(/^\s*FROM\s+(?:--\S+\s+)*\S+\s+AS\s+(\S+)/gim)].map((m) => m[1].toLowerCase()));
  for (const img of froms) {
    if (stages.has(img.toLowerCase())) continue;
    const isNode = /^(?:docker\.io\/)?(?:library\/)?node[:@]/.test(img);
    if (!isNode) continue;
    nodeBases++;
    const m = NODE_RE.exec(img);
    ok(Boolean(m), `${f}: node base ${img} names an exact major.minor.patch and variant, pinned by digest`);
    if (!m) continue;
    ok(["slim", "alpine"].some((v) => m[2].startsWith(v)), `${f}: variant ${m[2]} is slim or alpine`);
    if (!patches.has(m[1])) patches.set(m[1], []);
    patches.get(m[1]).push(f);
  }
}
ok(files.length >= 6, `the tracked Dockerfiles are found (${files.length}: ${files.join(", ")})`);
ok(nodeBases >= files.length, `every tracked Dockerfile builds on a node base (${nodeBases} bases)`);
ok(patches.size === 1, `every node base runs one Node patch (${[...patches].map(([v, fs]) => `${v}: ${fs.join(", ")}`).join("; ")})`);

// The tollbooth image: the proxy runs as node, reached through an entrypoint
// that starts as root only to hand the replay record (TOLLBOOTH_REPLAY_SQLITE)
// to node. A record an earlier root image wrote stays root's on its volume, and
// a proxy started as node (a Dockerfile USER) opens it read-only: it boots,
// then refuses every claim. Proved in Docker (old image as root writes the
// record on a named volume, this image boots on it and a claim writes); these
// checks keep that shape.
{
  const df = readFileSync(join(ROOT, "tollbooth/deploy/docker/Dockerfile"), "utf8");
  const ep = readFileSync(join(ROOT, "tollbooth/deploy/docker/tollbooth-entrypoint.sh"), "utf8");
  const lines = df.split("\n");
  const code = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const entryAt = lines.findIndex((l) => /^\s*ENTRYPOINT\s+\["\/usr\/local\/bin\/tollbooth-entrypoint\.sh"\]\s*$/.test(l));
  const cmdAt = lines.findIndex((l) => /^\s*CMD\b/.test(l));
  ok(entryAt >= 0 && cmdAt > entryAt, "tollbooth image: the entrypoint runs before the CMD");
  ok(/COPY\s+tollbooth-entrypoint\.sh\s+\/usr\/local\/bin\/tollbooth-entrypoint\.sh/.test(df), "tollbooth image: the entrypoint is copied under its own name (the base image has a docker-entrypoint.sh)");
  ok(!lines.some((l) => /^\s*USER\b/.test(l)), "tollbooth image: no Dockerfile USER (a node start cannot take back a root-owned replay record)");
  ok(/apk add --no-cache su-exec && su-exec node true/.test(df), "tollbooth image: su-exec is installed and checked at build");
  ok(/chown\s+node:node\s+\/var\/lib\/tollbooth/.test(df), "tollbooth image: /var/lib/tollbooth (the replay record's directory) belongs to node");
  ok(!/\bnpx\b/.test(lines[cmdAt] || ""), "tollbooth image: the CMD runs the installed bin, not npx");
  const epCode = code(ep);
  const execs = epCode.split("\n").filter((l) => /^\s*exec\b/.test(l)).map((l) => l.trim());
  ok(execs.length === 2 && execs[0] === 'exec su-exec "$TARGET_USER" "$@"' && execs[1] === 'exec "$@"' && /TARGET_USER=node/.test(epCode), `entrypoint: as root it execs the proxy as node; started as another user it runs as that user (${execs.join(" | ")})`);
  ok(/\$TOLLBOOTH_REPLAY_SQLITE-wal/.test(epCode) && /\$TOLLBOOTH_REPLAY_SQLITE-shm/.test(epCode) && /chown -h "\$TARGET_USER:\$TARGET_USER" -- "\$f"/.test(epCode), "entrypoint: hands the record and its -wal/-shm files to node, never following a link");
  ok(!/chown\s+-[a-zA-Z]*R/.test(epCode) && /"\$real" = "\/var\/lib\/tollbooth" \] \|\| on_volume "\$real"/.test(epCode), "entrypoint: the record's own place is judged on the resolved path (never recursive, never part of the image)");
  // Every chown, the directory's and each file's, sits under the one
  // own-place verdict, so a file in /app is never handed over either; and that
  // verdict is never given to a directory that is itself a link
  // (/vol/sub -> /usr/local/bin), nor is a chown ever made through one.
  const epLines = epCode.split("\n");
  const chowns = epLines.map((l, i) => [l, i]).filter(([l]) => /\bchown\b/.test(l));
  const guardOf = (i) => { for (let k = i - 1; k >= 0; k--) { const t = epLines[k].trim(); if (/^(if|elif)\b/.test(t)) return t; } return ""; };
  ok(chowns.length >= 2 && chowns.every(([, i]) => guardOf(i) === 'if [ "$own_place" = yes ]; then'), `entrypoint: every chown is under the own-place verdict (${chowns.map(([, i]) => guardOf(i)).join(" | ")})`);
  ok(chowns.every(([l]) => /chown -h /.test(l)), "entrypoint: every chown leaves a link itself unfollowed");
  const verdict = epLines.findIndex((l) => /own_place=yes/.test(l));
  const verdictGate = epLines.slice(0, verdict).reverse().find((l) => /^\s*if \[ -d "\$dir" \]/.test(l)) || "";
  // The record's directory is created as node first (a subdirectory of the
  // image's /var/lib/tollbooth then comes out node's, writable), and by root
  // only where node cannot create it; never by root alone before node tries.
  const mkdirs = epLines.filter((l) => /\bmkdir\b/.test(l)).map((l) => l.trim());
  ok(mkdirs.length === 1 && /^su-exec "\$TARGET_USER" mkdir -p -- "\$dir" 2>\/dev\/null \|\| mkdir -p -- "\$dir"/.test(mkdirs[0]), `entrypoint: the directory is made as node, root only as the fallback (${mkdirs.join(" | ")})`);
  ok(verdict > 0 && /\[ ! -L "\$dir" \]/.test(verdictGate) && epLines.filter((l) => /own_place=yes/.test(l)).length === 1, `entrypoint: a directory that is a link never earns the own-place verdict (${verdictGate.trim()})`);
}

console.log(`\ntest-dockerfile-node-patch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
