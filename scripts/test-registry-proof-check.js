// scripts/registry-proof-check.js reads a namespace proof the way the MCP
// Registry does: its own request headers, no redirect followed, a bounded
// body, one proof record. Here it reads a stub that answers each way a site
// can; the served route itself is read in scripts/test-official-surfaces.js
// (a booted server with the setting on, off and malformed).
//
//   node scripts/test-registry-proof-check.js
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const SCRIPT = fileURLToPath(new URL("./registry-proof-check.js", import.meta.url));
const edPub = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const PROOF = `v=MCPv1; k=ed25519; p=${edPub}`;

let mode = "ok", reads = 0, absentFor = 0;
const seen = [];
const stub = createServer((req, res) => {
  reads++;
  seen.push({ url: req.url, accept: req.headers.accept, agent: req.headers["user-agent"] });
  const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers }); res.end(body); };
  if (req.url === "/moved") return send(200, `${PROOF}\n`);
  if (req.url !== "/.well-known/mcp-registry-auth") return send(404, "not found");
  if (mode === "late" && reads <= absentFor) return send(404, "not found");
  if (mode === "absent") return send(404, "not found");
  if (mode === "redirect") return send(301, "", { location: "/moved" });
  if (mode === "html") return send(200, "<!doctype html><title>Just a moment</title>");
  if (mode === "two-lines") return send(200, `${PROOF}\n${PROOF}\n`);
  if (mode === "padded") return send(200, `${PROOF}${" ".repeat(5000)}\n`);
  if (mode === "prefix-only") return send(200, "v=MCPv1; k=ed25519; p=short\n");
  if (mode === "challenge") return send(403, "forbidden");
  if (mode === "error") return send(503, "unavailable");
  return send(200, mode === "no-newline" ? PROOF : `${PROOF}\n`);
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${stub.address().port}`;
const run = (args = [], url = URL_) => new Promise((resolve) => {
  const c = spawn(process.execPath, [SCRIPT, ...args, url], { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  c.on("exit", (code) => { let v = {}; try { v = JSON.parse(out.split("\n")[0]); } catch { /* no verdict line */ } resolve({ code, out, ...v }); });
});

mode = "ok"; reads = 0;
let r = await run();
ok(r.code === 0 && r.word === "ok" && r.status === 200 && reads === 1, `a served proof record passes in one read (exit ${r.code}, ${r.word})`);
ok(seen[0]?.accept === "text/plain" && seen[0]?.agent === "mcp-registry/1.0" && seen[0]?.url === "/.well-known/mcp-registry-auth", `the read carries the registry's Accept and User-Agent on its path (${seen[0]?.accept}, ${seen[0]?.agent})`);
ok(!r.out.includes(edPub), "the record is not printed");
mode = "no-newline";
r = await run();
ok(r.code === 0 && r.word === "ok", "a record with no line ending passes too");
r = await run([], `${URL_}/`);
ok(r.code === 0 && r.word === "ok", "a base URL with a trailing slash reads the same path");

for (const [m, word, why] of [
  ["absent", "absent", "a 404"],
  ["redirect", "redirect", "a redirect to a page that would serve the record (never followed)"],
  ["html", "invalid", "a 200 that is a challenge page"],
  ["two-lines", "invalid", "a 200 holding two records"],
  ["padded", "invalid", "a 200 past the registry's size limit"],
  ["prefix-only", "invalid", "a 200 that starts like a record and is not one"],
  ["challenge", "refused", "a 403"],
  ["error", "refused", "a 503"],
]) {
  mode = m;
  r = await run();
  ok(r.code === 1 && r.word === word && /::error::MCP Registry namespace proof is not served/.test(r.out), `${why} reads ${word} and fails (exit ${r.code}, ${r.word})`);
  const w = await run(["--warn"]);
  ok(w.code === 0 && w.word === word && /::warning::/.test(w.out) && !/::error::/.test(w.out), `...and with --warn is a warning that never fails the step (exit ${w.code})`);
}

mode = "late"; reads = 0; absentFor = 2;
r = await run(["--tries", "4", "--wait-ms", "20"]);
ok(r.code === 0 && r.word === "ok" && reads === 3, `a proof that appears while the check waits passes (exit ${r.code}, ${reads} reads)`);
mode = "absent"; reads = 0;
r = await run(["--tries", "3", "--wait-ms", "20"]);
ok(r.code === 1 && r.word === "absent" && reads === 3, `a proof that never appears is read --tries times, then fails (${reads} reads)`);

stub.close();
r = await run();
ok(r.code === 1 && r.word === "unreadable" && r.status === 0, `a site that does not answer reads unreadable (exit ${r.code}, ${r.word})`);
const usage = await new Promise((resolve) => { const c = spawn(process.execPath, [SCRIPT], { stdio: "ignore" }); c.on("exit", resolve); });
ok(usage === 2, `no base URL is a usage error, not a verdict (exit ${usage})`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
