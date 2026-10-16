#!/usr/bin/env node
// Caller path for captured output examples (src/tool-output-examples.js): boot
// a FREE_MODE server with a generated examples file and read what a buyer
// reads. A tool with no hand-written example renders the captured one, with
// its date and model label, on /openapi.json and on its tool page; a tool with
// a hand-written example renders its own, untouched, with no capture note.
//
//   node scripts/test-captured-examples-render.js
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const J = (x) => JSON.stringify(x);

// Every priced tool now has a hand-written example, so the boot names seller-trust
// in TOOL_OUTPUT_EXAMPLES_TEST_BARE (FREE_MODE only) to stand in for one without;
// hash keeps its hand-written one.
const BARE = { slug: "seller-trust", path: "/api/x402/seller-trust", method: "get" };
const HAND = { slug: "hash", path: "/api/hash", method: "post" };
const CAPTURED = { verdict: "no-evidence", checks: [{ name: "listed", pass: true }], capturedMarker: "captured-render-test" };
const dir = mkdtempSync(join(tmpdir(), "captured-examples-"));
const file = join(dir, "tool-output-examples.json");
writeFileSync(file, J({
  _note: "test fixture",
  [BARE.slug]: { capturedAt: "2026-10-12", example: CAPTURED, modelBacked: true },
  [HAND.slug]: { capturedAt: "2026-10-12", example: { capturedMarker: "must-not-render" }, modelBacked: false },
}));

const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;
const proc = spawn(process.execPath, ["src/server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port), FREE_MODE: "true", TOOL_OUTPUT_EXAMPLES_FILE: file, TOOL_OUTPUT_EXAMPLES_TEST_BARE: BARE.slug, X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += d; });
proc.stderr.on("data", (d) => { log += d; });
const stop = () => { try { proc.kill("SIGKILL"); } catch {} };
process.on("exit", stop);

let up = false;
for (let i = 0; i < 480 && !up; i++) {
  try { up = (await fetch(`${base}/health`)).ok; } catch {}
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error(`FAIL - the server did not come up\n${log.slice(-3000)}`); process.exit(1); }

ok(/\[examples\] 1 captured output example\(s\) applied/.test(log), "boot applied exactly one captured example (the hand-written one is kept)");

const spec = await (await fetch(`${base}/openapi.json`)).json();
{
  const r200 = spec.paths?.[BARE.path]?.[BARE.method]?.responses?.["200"];
  const content = r200?.content?.["application/json"];
  ok(J(content?.example) === J(CAPTURED), "/openapi.json: the tool with no example publishes the captured one");
  ok(content?.["x-example-source"]?.kind === "captured-paid-answer" && content["x-example-source"].capturedAt === "2026-10-12" && content["x-example-source"].modelBacked === true, "/openapi.json: x-example-source names the capture, its date and the model label");
  ok(/real paid answer captured on 2026-10-12/.test(r200?.description || "") && /model-generated, so a call with the same input varies/.test(r200?.description || ""), "/openapi.json: the 200 description says real paid answer, the date, and model-generated");
  // `required` is added only on routes the shape sweep enforces, so the
  // derivation is judged on the typed properties.
  ok(content?.schema?.properties?.verdict?.type === "string" && content.schema.properties.checks?.type === "array" && content.schema.properties.capturedMarker, "/openapi.json: the schema is derived from the captured example like any other");
}
{
  const r200 = spec.paths?.[HAND.path]?.[HAND.method]?.responses?.["200"];
  const content = r200?.content?.["application/json"];
  ok(content?.example && !J(content.example).includes("must-not-render") && Object.keys(content.example).length > 0, "/openapi.json: a hand-written example is never overwritten by a captured one");
  ok(!content?.["x-example-source"] && r200?.description === "Success", "/openapi.json: and carries no capture note");
}

{
  const html = await (await fetch(`${base}/tools/${BARE.slug}`)).text();
  ok(html.includes("captured-render-test"), "tool page: the captured example renders under Example response");
  ok(html.includes("This example is a real paid answer captured on 2026-10-12."), "tool page: it says real paid answer and the date");
  ok(html.includes("The answer is model-generated, so a call with the same input varies."), "tool page: it says model-generated and varies for a model-backed capture");
  ok(!/—/.test(html.slice(html.indexOf("Example response"), html.indexOf("From an MCP client"))), "tool page: the example block carries no em dash");
}
{
  const html = await (await fetch(`${base}/tools/${HAND.slug}`)).text();
  ok(!html.includes("must-not-render") && !html.includes("real paid answer captured"), "tool page: the hand-written tool renders its own example and no capture note");
}

stop();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
