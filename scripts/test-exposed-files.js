#!/usr/bin/env node
// No repository, build or state file is ever served, and no error answer
// carries a stack.
//
//   node scripts/test-exposed-files.js
//
// The server mounts no static directory: every answer comes from a route. This
// pins that from the outside, so a future `express.static`, a catch-all that
// reads a path from disk, or a debug route cannot start handing out the
// source tree. A booted free-mode server is asked for each path below (dot
// files, the git directory, manifests, source, local databases, backups,
// source maps, the private instruction file, encoded traversal) with GET and
// HEAD. Each must answer 4xx, or a redirect to this same host whose target
// answers 4xx, and no body may carry a marker that only the real file holds.
//
// It also reads every script the home page loads and requires that none
// names a source map, and sends malformed and oversized bodies to a JSON route
// and an HTML route: the answer is the fixed error shape, never a stack frame,
// a module path or a parser message.
//
// Live control: a route that does exist (/health, /robots.txt) answers 200, so
// a server answering 404 to everything cannot pass.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// Paths a scanner tries first. Each is a file that exists in the repository,
// the image or a developer checkout, or a name a backup or build would take.
const EXPOSED_PATHS = [
  "/.env", "/.env.local", "/.env.production", "/.env.example",
  "/.git/config", "/.git/HEAD", "/.git/index", "/.git/logs/HEAD", "/.gitignore",
  "/.gitleaks.toml", "/.gitleaksignore", "/.npmrc", "/.dockerignore", "/.DS_Store",
  "/package.json", "/package-lock.json", "/Dockerfile", "/railway.toml", "/railway.json",
  "/CLAUDE.md", "/CLAUDE.local.md", "/DESIGN.md",
  "/src/server.js", "/server.js", "/src/upstream-costs.js", "/src/generated/page-dates.json",
  "/docs/example-upstream-costs.json", "/upstream-costs.json",
  "/node_modules/express/package.json", "/scripts/test-all.js",
  "/data/stats.db", "/stats.db", "/memory.db", "/backup.sql", "/dump.sql", "/backup.tar.gz",
  "/app.js.map", "/js/ga-loader.js.map", "/server.js.map",
  "/.github/workflows/deploy.yml", "/.vscode/launch.json", "/.aws/credentials",
  "/%2e%2e/package.json", "/js/..%2f..%2fpackage.json", "/.%2e/.%2e/.env", "/js/%2e%2e/%2e%2e/.git/config",
  "/server-status", "/.well-known/../package.json",
];

// Text only the real files hold. The 404 page and the error shapes carry none.
const MARKERS = [
  /"devDependencies"\s*:/, /"lockfileVersion"\s*:/,            // package.json, package-lock.json
  /repositoryformatversion/, /^ref: refs\//m,                   // .git/config, .git/HEAD
  /import express from "express"/, /^FROM node:/m,             // src/server.js, Dockerfile
  /AGENT402_OPERATOR_TOKEN\s*=/, /UPSTREAM_COSTS_JSON\s*=/,     // an env file
  /Repository map/, /\[allowlist\]/,                            // CLAUDE.md, .gitleaks.toml
  /SQLite format 3/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,       // a local database, a key
  /"mappings"\s*:/, /aws_secret_access_key/i,                   // a source map, AWS credentials
];
// What an error answer must never carry.
const STACKISH = [/\n\s+at [^\n]+\(/, /\bat [\w.<>]+ \([^)]*\.m?js:\d+:\d+\)/, /node_modules\//, /\/src\/[\w/-]+\.js/, /SyntaxError|Unexpected token|in JSON at position/];

const srv = await bootServer({ env: { FREE_MODE: "true" }, stores: "exposed-files" });
const B = srv.url;
const HOST = new URL(B).host;
try {
  for (const path of ["/health", "/robots.txt"]) {
    const r = await fetch(`${B}${path}`);
    ok(r.status === 200, `control: ${path} answers 200 (${r.status})`);
  }

  for (const path of EXPOSED_PATHS) {
    for (const method of ["GET", "HEAD"]) {
      let url = `${B}${path}`;
      let r = await fetch(url, { method, redirect: "manual" });
      let hops = 0;
      while (r.status >= 300 && r.status < 400 && hops < 3) {
        const loc = r.headers.get("location") || "";
        let next;
        try { next = new URL(loc, url); } catch { next = null; }
        ok(next && next.host === HOST, `${method} ${path}: a redirect stays on this host (${loc})`);
        if (!next || next.host !== HOST) break;
        url = next.href; hops++;
        r = await fetch(url, { method, redirect: "manual" });
      }
      const body = method === "GET" ? await r.text() : "";
      ok(r.status >= 400 && r.status < 500, `${method} ${path} answers ${r.status} (a 4xx)`);
      const hit = MARKERS.find((m) => m.test(body));
      ok(!hit, `${method} ${path}: the body holds no file content${hit ? ` (matched ${hit})` : ""}`);
    }
  }

  // Every script the home page loads names no source map.
  const home = await (await fetch(`${B}/`)).text();
  const scripts = [...home.matchAll(/<script[^>]+src="(\/[^"]+)"/g)].map((m) => m[1]);
  ok(scripts.length > 0, `the home page loads first-party scripts (${scripts.join(", ")})`);
  for (const s of scripts) {
    const r = await fetch(`${B}${s}`);
    const t = await r.text();
    ok(r.status === 200 && !/sourceMappingURL/.test(t) && !r.headers.get("sourcemap") && !r.headers.get("x-sourcemap"), `${s} names no source map`);
  }

  // Malformed and oversized bodies get the fixed error shape, never a stack.
  const cases = [
    ["/api/alerts", { "content-type": "application/json" }, "{bad", 400],
    ["/api/alerts", { "content-type": "application/json" }, JSON.stringify({ x: "a".repeat(20_000) }), 413],
    ["/__operator/login", { "content-type": "application/json", accept: "text/html" }, "{bad", 400],
    ["/tools", { "content-type": "application/json", accept: "text/html" }, "{\"a\":", 400],
  ];
  for (const [path, headers, body, want] of cases) {
    const r = await fetch(`${B}${path}`, { method: "POST", headers, body });
    const t = await r.text();
    ok(r.status === want, `POST ${path} with a ${want === 413 ? "too-large" : "malformed"} body answers ${want} (${r.status})`);
    const hit = STACKISH.find((m) => m.test(t));
    ok(!hit, `POST ${path}: the error answer carries no stack, module path or parser message${hit ? ` (matched ${hit})` : ""}`);
    ok(!r.headers.get("x-powered-by"), `POST ${path}: no X-Powered-By`);
  }
} finally {
  await srv.stop();
}
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
