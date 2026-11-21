// Every place that tells someone which agent402-mcp to install names the
// version in mcp/package.json: the package's own AGENT402_MCP_VERSION and
// every `agent402-mcp@x.y.z` pin in the shipped trees, docs and pages.
// Changelog history is a record and is not read.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { AGENT402_MCP_VERSION } from "../mcp/output-schemas.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const version = JSON.parse(readFileSync(new URL("../mcp/package.json", import.meta.url), "utf8")).version;
ok(AGENT402_MCP_VERSION === version, `AGENT402_MCP_VERSION (${AGENT402_MCP_VERSION}) matches mcp/package.json (${version})`);
const root = fileURLToPath(new URL("..", import.meta.url));
const files = execFileSync("git", ["ls-files", "--", ".", ":!CHANGELOG.md", ":!src/changelog.js", ":!**/package-lock.json", ":!package-lock.json"], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => /\.(js|mjs|md|json|html|txt)$/.test(f));
const stale = [];
for (const f of files) {
  let s; try { s = readFileSync(root + f, "utf8"); } catch { continue; }
  for (const m of s.matchAll(/agent402-mcp@(\d+\.\d+\.\d+)/g)) if (m[1] !== version) stale.push(`${f}: ${m[0]}`);
}
ok(stale.length === 0, `every agent402-mcp install pin names ${version}${stale.length ? `; stale: ${stale.slice(0, 5).join(", ")}` : ""}`);
// An install line with no pin at all is not seen by the scan above: in the
// markdown trees every `npx -y agent402-mcp` and every "-y", "agent402-mcp"
// argument names the version.
const UNPINNED = /(?:npx -y |"-y",\s*")agent402-mcp(?!@\d+\.\d+\.\d+)/g;
ok("npx -y agent402-mcp\n".match(UNPINNED) && '"args": ["-y", "agent402-mcp"]'.match(UNPINNED) && !`npx -y agent402-mcp@${version}`.match(UNPINNED), "control: an unpinned install line is matched, a pinned one is not");
const bare = [];
for (const f of files.filter((x) => x.endsWith(".md"))) {
  let s; try { s = readFileSync(root + f, "utf8"); } catch { continue; }
  for (const m of s.matchAll(UNPINNED)) bare.push(`${f}:${s.slice(0, m.index).split("\n").length}`);
}
ok(bare.length === 0, `every markdown install line pins agent402-mcp@${version}${bare.length ? `; unpinned: ${bare.slice(0, 8).join(", ")}` : ""}`);

// The pins name mcp/package.json's version before the publish job puts it on
// npm, and the deploy job does not wait on that job: after a deploy, the
// deploy job reads the registry until the pinned version resolves
// (scripts/mcp-pin-resolves.js) and fails when it never does.
{
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { load } = await import("js-yaml");
  const { expandedDeployWorkflow } = await import("./lib/ci-workflow.js");
  // A stub registry: answers the pinned version per `mode`, counting reads.
  let mode = "found", reads = 0, missingFor = 0;
  const reg = createServer((req, res) => {
    reads++;
    const want = `/agent402-mcp/${version}`;
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url !== want) return send(404, { error: "Not found" });
    if (mode === "late" && reads <= missingFor) return send(404, { error: "Not found" });
    if (mode === "missing") return send(404, { error: "Not found" });
    if (mode === "down") return send(503, { error: "unavailable" });
    return send(200, { name: "agent402-mcp", version });
  });
  await new Promise((r) => reg.listen(0, "127.0.0.1", r));
  const URL_ = `http://127.0.0.1:${reg.address().port}`;
  const run = (env) => new Promise((resolve) => {
    const c = spawn(process.execPath, [fileURLToPath(new URL("./mcp-pin-resolves.js", import.meta.url))], { env: { ...process.env, NPM_REGISTRY_URL: URL_, MCP_PIN_POLL_MS: "50", MCP_PIN_WAIT_MS: "600", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("exit", (code) => resolve({ code, out }));
  });
  mode = "found"; reads = 0;
  let r = await run({});
  ok(r.code === 0 && reads === 1 && r.out.includes(`agent402-mcp@${version} resolves`), `a pinned version on the registry passes at once (exit ${r.code}, ${reads} read)`);
  mode = "late"; reads = 0; missingFor = 3;
  r = await run({});
  ok(r.code === 0 && reads === 4, `a version that lands while the step waits passes (exit ${r.code}, ${reads} reads)`);
  mode = "missing"; reads = 0;
  r = await run({});
  ok(r.code === 1 && /::error::agent402-mcp@\S+ does not resolve on npm/.test(r.out) && reads >= 2, `a version that never lands fails the step with an error line (exit ${r.code}, ${reads} reads)`);
  mode = "down"; reads = 0;
  r = await run({});
  ok(r.code === 2 && /::warning::The npm registry could not be read/.test(r.out), `an unreadable registry is a warning, not a verdict (exit ${r.code})`);
  reg.close();

  const steps = load(expandedDeployWorkflow()).jobs?.deploy?.steps || [];
  const verifyAt = steps.findIndex((s) => s.id === "verify");
  const at = steps.findIndex((s) => /node scripts\/mcp-pin-resolves\.js/.test(String(s.run || "")));
  const step = steps[at] || {};
  ok(verifyAt >= 0 && at > verifyAt && /steps\.verify\.outcome == 'success'/.test(String(step.if || "")), `the deploy job reads the pin after a verified deploy (verify ${verifyAt}, pin ${at})`);
  ok(!step["continue-on-error"] && /\[ "\$CODE" = "1" \] && exit 1/.test(String(step.run || "")) && Number(step["timeout-minutes"]) >= 21, "a pin that never resolves fails the job; the step's own timeout sits above the script's 20-minute wait");
  const blank = ["CDP_KEY_ID", "CDP_KEY_SECRET", "MPP_SECRET_KEY", "X_BEARER_TOKEN", "BRAVE_API_KEY", "RAILWAY_API_TOKEN"];
  ok(blank.every((k) => k in (step.env || {}) && String(step.env[k] ?? "") === ""), "the step blanks the job's keys");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
