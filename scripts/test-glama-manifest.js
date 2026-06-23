// /.well-known/glama.json is the connector manifest Glama (the MCP listing
// portal) reads when crawling agent402. It carries the maintainer contact
// used to verify ownership. We expose it from src/server.js:586 with an env
// override (GLAMA_MAINTAINER_EMAIL) so forks can claim their own listing
// without code changes.
//
// This test boots the server twice — once with the env override set to a
// fixture value, once without — and verifies:
//
//   1. With GLAMA_MAINTAINER_EMAIL set, the manifest carries that exact
//      value. A regression in the env-read path (typo'd var name, missing
//      destructure) would surface as the default email instead.
//   2. Without the override, the manifest carries the default. Pins the
//      fallback so a removed fallback doesn't silently break self-hosters who
//      don't set the env.
//   3. The Glama JSON schema URL is the right one — Glama's crawler uses
//      $schema to validate; a wrong URL breaks the listing.
//   4. Content-type is application/json.
//
// Both boots run on different ports so we never need to kill+restart in a way
// that races with the next test.
//
//   node scripts/test-glama-manifest.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const procs = [];
const fail = (m) => { console.error("FAIL:", m); for (const p of procs) { try { p.kill("SIGKILL"); } catch {} } process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const boot = (port, env) => {
  const p = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_SYNC_ON_START: "false", ...env },
    stdio: "ignore",
  });
  procs.push(p);
  return p;
};

const waitUp = async (port) => {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${port}/health`)).ok) return true; } catch {} await sleep(500); }
  return false;
};

try {
  // Case 1: env override set to a fixture value.
  const FIXTURE = "fixture-maintainer@example.test";
  boot(3090, { GLAMA_MAINTAINER_EMAIL: FIXTURE });
  ok(await waitUp(3090), "server up on :3090 with GLAMA_MAINTAINER_EMAIL set");
  const overrideRes = await fetch("http://localhost:3090/.well-known/glama.json");
  ok(overrideRes.status === 200, `with env: /.well-known/glama.json → 200 (got ${overrideRes.status})`);
  ok((overrideRes.headers.get("content-type") || "").includes("application/json"), "with env: content-type is application/json");
  const overrideManifest = await overrideRes.json();
  ok(
    overrideManifest.$schema === "https://glama.ai/mcp/schemas/connector.json",
    `with env: $schema is the Glama connector schema (got ${overrideManifest.$schema})`
  );
  ok(
    Array.isArray(overrideManifest.maintainers) && overrideManifest.maintainers.length > 0,
    `with env: maintainers is a non-empty array (got ${JSON.stringify(overrideManifest.maintainers)})`
  );
  ok(
    overrideManifest.maintainers[0]?.email === FIXTURE,
    `with env: maintainers[0].email === '${FIXTURE}' (got ${overrideManifest.maintainers[0]?.email})`
  );

  // Case 2: no env override — default fallback must hold.
  boot(3089, {});
  // Wipe the env var explicitly in case the parent process inherits it.
  procs[procs.length - 1].kill("SIGKILL");
  procs.pop();
  const cleanEnv = { ...process.env };
  delete cleanEnv.GLAMA_MAINTAINER_EMAIL;
  const p2 = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: { ...cleanEnv, FREE_MODE: "true", PORT: "3089", X402_SYNC_ON_START: "false" },
    stdio: "ignore",
  });
  procs.push(p2);
  ok(await waitUp(3089), "server up on :3089 without GLAMA_MAINTAINER_EMAIL");
  const defaultManifest = await (await fetch("http://localhost:3089/.well-known/glama.json")).json();
  ok(
    defaultManifest.maintainers[0]?.email === "mike@agent402.tools",
    `without env: maintainers[0].email falls back to 'mike@agent402.tools' (got ${defaultManifest.maintainers[0]?.email})`
  );

  console.log(`\n${pass} passed`);
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  process.exit(0);
} catch (e) {
  fail(e.message);
}
