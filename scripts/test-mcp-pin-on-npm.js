// scripts/mcp-pin-on-npm.js against a stub site and a stub npm registry
// (offline, port 0): a served pin npm has reads ok, one it lacks reads
// missing, an unreadable site or registry reads unknown (never an alarm).
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const listen = (handler) => new Promise((r) => { const s = createServer(handler).listen(0, "127.0.0.1", () => r(s)); });

let served = { llms: "npx -y agent402-mcp@0.13.26", describe: "agent402-mcp@0.13.26", siteUp: true };
const published = new Set(["0.13.25", "0.13.26"]);
let registryUp = true;

const site = await listen((req, res) => {
  if (!served.siteUp) { res.statusCode = 503; return res.end(); }
  if (req.url === "/llms.txt") return res.end(`# Agent402\nInstall: ${served.llms}\n`);
  if (req.url === "/mcp" && req.method === "POST") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ result: { content: [{ type: "text", text: `install ${served.describe}` }] } })); }
  res.statusCode = 404; res.end();
});
const registry = await listen((req, res) => {
  if (!registryUp) { res.statusCode = 500; return res.end(); }
  const m = req.url.match(/^\/agent402-mcp\/(\d+\.\d+\.\d+)$/);
  if (m && published.has(m[1])) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ name: "agent402-mcp", version: m[1] })); }
  res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
});

const check = async () => {
  const { stdout } = await run(process.execPath, ["scripts/mcp-pin-on-npm.js"], {
    env: { ...process.env, TARGET_URL: `http://127.0.0.1:${site.address().port}`, NPM_REGISTRY: `http://127.0.0.1:${registry.address().port}` },
  });
  return JSON.parse(stdout.trim().split("\n").pop());
};

let r = await check();
ok(r.word === "ok" && r.versions.join() === "0.13.26", `a pin npm has reads ok (${JSON.stringify(r)})`);

served = { ...served, llms: "npx -y agent402-mcp@0.13.27", describe: "agent402-mcp@0.13.27" };
r = await check();
ok(r.word === "missing" && r.missing.join() === "0.13.27", `a pin npm lacks reads missing (${JSON.stringify(r)})`);

served = { ...served, llms: "npx -y agent402-mcp@0.13.26", describe: "agent402-mcp@0.13.27" };
r = await check();
ok(r.word === "missing" && r.versions.join() === "0.13.26,0.13.27" && r.missing.join() === "0.13.27", `one surface on an unpublished pin is enough to read missing (${JSON.stringify(r)})`);

served = { ...served, siteUp: false };
r = await check();
ok(r.word === "unknown", `an unreadable site reads unknown, not missing (${r.word})`);

served = { llms: "npx -y agent402-mcp@0.13.26", describe: "agent402-mcp@0.13.26", siteUp: true };
registryUp = false;
r = await check();
ok(r.word === "unknown", `an unreadable registry reads unknown, not missing (${r.word})`);

site.close(); registry.close();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
