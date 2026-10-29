#!/usr/bin/env node
// An input nested past MAX_INPUT_DEPTH is a 400, never a handler's stack
// overflow answered as a 500.
//
//   node scripts/test-input-depth.js   (unit checks, then a FREE_MODE boot on port 0)
//
// Handlers walk their input recursively (flatten, schema inference, diff,
// YAML, $ref resolution), and a JSON body or a JSON-text field nested
// thousands of levels deep overflows the stack. handlerInputOf
// (src/handler-input.js) refuses both shapes before dispatch; the MCP
// connector, which calls handlers with its own params, makes the same check.
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handlerInputOf, preValidateInput, inputDepthExceeds, jsonTextDepthExceeds, inputDepthRefusal, MAX_INPUT_DEPTH } from "../src/handler-input.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nest = (n) => { let v = 1; for (let i = 0; i < n; i++) v = { a: v }; return v; };
const nestText = (n) => "{\"a\":".repeat(n) + "1" + "}".repeat(n);
const throwsStatus = (fn) => { try { fn(); return null; } catch (e) { return e.statusCode ?? "no-status"; } };

// --- unit ------------------------------------------------------------------
ok(MAX_INPUT_DEPTH === 64, "the bound is 64 levels");
ok(!inputDepthExceeds(nest(MAX_INPUT_DEPTH)) && inputDepthExceeds(nest(MAX_INPUT_DEPTH + 1)), "object depth: 64 passes, 65 is refused");
ok(inputDepthExceeds(nest(20000)), "a 20,000-level object is detected without recursion");
ok(!jsonTextDepthExceeds(nestText(MAX_INPUT_DEPTH)) && jsonTextDepthExceeds(nestText(MAX_INPUT_DEPTH + 1)), "JSON text depth: 64 passes, 65 is refused");
ok(!jsonTextDepthExceeds(`{"s":"${"{".repeat(500)}"}`), "brackets inside a JSON string literal do not count");
ok(!jsonTextDepthExceeds(`{"s":"a\\"${"[".repeat(500)}"}`), "an escaped quote does not end the string literal");
ok(!jsonTextDepthExceeds("(".repeat(500) + "{".repeat(500)), "text that does not start as JSON is not scanned");
ok(throwsStatus(() => handlerInputOf({ body: { json: nest(200) }, query: {} })) === 400, "handlerInputOf refuses a deep body with a 400");
ok(throwsStatus(() => handlerInputOf({ body: { json: nestText(200) }, query: {} })) === 400, "handlerInputOf refuses a deep JSON-text field with a 400");
ok(throwsStatus(() => handlerInputOf({ body: { input: { json: nestText(200) } }, query: {} })) === 400, "a deep JSON-text field inside an input envelope is refused too");
{
  const i = handlerInputOf({ body: { json: nest(40), text: nestText(40) }, query: {} });
  ok(i.json && i.text, "an input inside the bound is served unchanged");
}
{
  const def = { slug: "json-flatten", discovery: { inputSchema: { required: ["json"], properties: { json: {} } }, input: { json: { a: 1 } } } };
  const r = preValidateInput(def, { body: { json: nest(200) }, query: {} });
  ok(r && r.status === 400 && /nested more than 64/.test(r.body.error) && r.body.tool === "json-flatten", "preValidateInput answers the self-explaining 400");
}
ok(inputDepthRefusal({ json: nest(200) }) && inputDepthRefusal({ json: nestText(200) }) && inputDepthRefusal({ json: { a: 1 } }) === null, "inputDepthRefusal covers objects and JSON text");

// --- the caller path: HTTP and MCP on a FREE_MODE boot -----------------------
const srv = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: "0", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", X402_PAYWALL_PROBES_PER_CYCLE: "0", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => { log += d; });
srv.stderr.on("data", (d) => { log += d; });
try {
  let B = null;
  for (let i = 0; i < 180 && !B; i++) { const m = log.match(/listening on :(\d+)/); if (m) B = `http://127.0.0.1:${m[1]}`; else await sleep(500); }
  if (!B) throw new Error(`server never came up:\n${log.slice(-600)}`);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* not yet */ } await sleep(500); }
  const post = async (slug, body) => { const r = await fetch(`${B}/api/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const deep = nestText(8000);
  for (const slug of ["json-flatten", "json-schema-infer", "json-to-yaml"]) {
    const r = await post(slug, `{"json":${deep}}`);
    ok(r.status === 400 && /nested more than 64/.test(r.body.error), `${slug}: a deep JSON body is a 400 (got ${r.status})`);
  }
  const d2 = await post("json-diff", `{"a":${deep},"b":{}}`);
  ok(d2.status === 400, `json-diff: a deep body is a 400 (got ${d2.status})`);
  for (const [slug, field] of [["json-format", "json"], ["openapi-resolve-refs", "spec"], ["json-query", "json"]]) {
    const r = await post(slug, JSON.stringify({ [field]: deep, path: "a" }));
    ok(r.status === 400 && /nested more than 64/.test(r.body.error), `${slug}: a deep JSON-text ${field} is a 400 (got ${r.status})`);
  }
  const fine = await post("json-flatten", JSON.stringify({ json: nest(30) }));
  ok(fine.status === 200, `json-flatten: a 30-level body is still served (got ${fine.status})`);
  const m = await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"catalog.call","arguments":{"slug":"json-flatten","params":{"json":${deep}}}}}` });
  const mt = await m.text();
  ok(/nested more than 64/.test(mt) && !/Maximum call stack/.test(mt), "MCP catalog.call refuses a deep params object with the depth message");
} catch (e) {
  fail++; console.error(`FAIL - ${e.message}`);
} finally {
  srv.kill("SIGKILL");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
