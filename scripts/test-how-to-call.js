#!/usr/bin/env node
// Every input-validation 400 carries a ready-to-run call (`howToCall`): the
// method, the full URL on the server's BASE_URL and the body from the tool's
// own example, plus the other method only where the server really serves it.
//
// Part 1, in process: the builder's method rules (the alias serves the other
// verb only when the catalog has no route of it; a GET form only when every
// example value survives a query string; multipart stays multipart).
// Part 2, a FREE_MODE boot on port 0 with BASE_URL set to a foreign origin:
// a bare GET to /api/base64 (the shape an outside buyer sent) answers a 400
// whose howToCall names that origin, and for every free-tier tool whose empty
// call is refused, the 400's howToCall and its alternate are SENT as written
// (origin swapped for the bound port) and must answer 200. A GET form the
// server would refuse fails here.
// Part 3, a paid boot against a stub facilitator: the unpaid 402 body carries
// the same howToCall, the PAYMENT-REQUIRED header does not, and a refused
// payment's 402 keeps its own explanation.
// Offline: free-tier tools are pure CPU; nothing leaves the machine.
//
//   node scripts/test-how-to-call.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ownStoreEnv } from "./lib/own-stores.js";
import { configureHowToCall, howToCallFor, howToCall402Field, howToCallField, MAX_GET_URL_CHARS, MAX_402_CALL_BYTES, MAX_CALL_BYTES } from "../src/how-to-call.js";
import { isComputePayable } from "../src/pow.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };

// ---- Part 1: the builder -------------------------------------------------
{
  const post = { route: "POST /api/p", discovery: { bodyType: "json", input: { text: "hello", mode: "encode" } } };
  const postNum = { route: "POST /api/n", discovery: { input: { text: "x", n: 5 } } };
  const get = { route: "GET /api/g", discovery: { input: { q: "a b", k: 3, all: true } } };
  const getNested = { route: "GET /api/gn", discovery: { input: { ids: ["a", "b"] } } };
  const both = { route: "POST /api/both", discovery: { input: { text: "x" } } };
  const multipart = { route: "POST /api/stt", discovery: { bodyType: "form-data", input: { file: "<audio>" } } };
  const long = { route: "POST /api/long", discovery: { input: { text: "x".repeat(MAX_GET_URL_CHARS) } } };
  const catalog = Object.fromEntries([post, postNum, get, getNested, both, multipart, long].map((d) => [d.route, d]));
  catalog["GET /api/both"] = { route: "GET /api/both" };
  configureHowToCall({ baseUrl: "https://origin.example/", catalog });

  const p = howToCallFor(post);
  ok(p.method === "POST" && p.url === "https://origin.example/api/p" && p.headers["Content-Type"] === "application/json" && JSON.stringify(p.body) === JSON.stringify(post.discovery.input),
    "a POST tool: POST to the BASE_URL origin (trailing slash folded) with its own example as the JSON body");
  ok(p.alternate?.method === "GET" && p.alternate.url === "https://origin.example/api/p?text=hello&mode=encode" && !("body" in p.alternate),
    "...and the GET form the method alias serves, with the example on the query string");
  ok(!howToCallFor(postNum).alternate, "a POST tool whose example carries a number gets no GET form (its handler receives strings there)");
  const g = howToCallFor(get);
  ok(g.method === "GET" && g.url === "https://origin.example/api/g?q=a+b&k=3&all=true" && g.alternate?.method === "POST" && g.alternate.body.k === 3,
    "a GET tool: its own query form (scalars), with the POST body form as the alternate");
  const gn = howToCallFor(getNested);
  ok(gn.method === "POST" && Array.isArray(gn.body.ids) && !gn.alternate, "a GET tool whose example is an array: the POST body form only");
  ok(!howToCallFor(both).alternate, "no alternate where the catalog routes the other verb to another tool");
  const m = howToCallFor(multipart);
  ok(m.method === "POST" && m.form?.file && !m.body && !m.alternate && /multipart/.test(m.headers["Content-Type"]), "a multipart tool: a form part, never a JSON body or a query string");
  ok(!howToCallFor(long).alternate, `a GET form past ${MAX_GET_URL_CHARS} characters is left out`);
  ok(howToCallFor({ route: "nonsense" }) === null && howToCallFor({}) === null, "no route, no call");
  const small = howToCall402Field(post).howToCall;
  ok(JSON.stringify(small) === JSON.stringify(howToCallFor(post)), "402 form: a call that fits the budget goes out whole");
  const big = howToCall402Field(long).howToCall;
  ok(big && big.method === "POST" && big.url === "https://origin.example/api/long" && Object.keys(big).length === 2 && JSON.stringify(howToCallFor(long)).length > MAX_402_CALL_BYTES,
    `402 form: a call past ${MAX_402_CALL_BYTES} bytes goes out as its method and URL only`);
  ok(MAX_CALL_BYTES === MAX_402_CALL_BYTES, "one budget for the 400 and the 402");
  ok(JSON.stringify(howToCallField(post).howToCall) === JSON.stringify(howToCallFor(post)), "400 form: a call that fits the budget goes out whole");
  const big400 = howToCallField(long).howToCall;
  ok(big400 && big400.method === "POST" && big400.url === "https://origin.example/api/long" && Object.keys(big400).length === 2,
    `400 form: a call past ${MAX_CALL_BYTES} bytes goes out as its method and URL only (the 400's example carries the body once)`);

  // /openapi.json documents the 400 the server sends: every operation's 400
  // names howToCall and each field the builder can put in it.
  const { openapiSpec } = await import("../src/pages.js");
  const mk = (slug) => ({ name: slug, slug, category: "x", price: "$0.001", description: "d", discovery: { inputSchema: { type: "object", properties: {} }, input: { text: "x" } } });
  const spec = openapiSpec("https://example.test", { "POST /api/oa": mk("oa"), "GET /api/ob": mk("ob") });
  const ops = Object.values(spec.paths).flatMap((p) => Object.values(p)).filter((op) => op?.responses?.[402]); // the paid tool operations
  const fields = [...new Set([...Object.keys(p), ...Object.keys(g), ...Object.keys(m)])].filter((k) => k !== "headers");
  ok(ops.length >= 2 && ops.every((op) => /\bhowToCall\b/.test(op.responses?.[400]?.description || "")), "openapi: every paid operation's 400 names howToCall");
  ok(ops.every((op) => fields.every((k) => (op.responses[400].description || "").includes(k))), `openapi: the 400 names each howToCall field the builder sends (${fields.join(", ")})`);
}

// ---- Part 2: a FREE_MODE boot --------------------------------------------
const ORIGIN = "https://howtocall.example";
const env = {
  ...process.env, ...ownStoreEnv("how-to-call"),
  FREE_MODE: "true", PORT: "0", BASE_URL: ORIGIN,
  X402_INDEX_CRAWL: "off", INDEX_FIRST_CRAWL_DELAY_MS: "999999999",
  RATE_LIMIT_MAX: "1000000", RATE_LIMIT_WINDOW_MS: "60000",
};
const proc = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
proc.stdout.on("data", (d) => { out += d; });
proc.stderr.on("data", (d) => { out += d; });
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`server did not start: ${out.slice(-800)}`)), 90_000);
  const tick = setInterval(() => {
    const mm = out.match(/listening on :(\d+)/);
    if (mm) { clearInterval(tick); clearTimeout(t); resolve(Number(mm[1])); }
  }, 100);
  proc.on("exit", (c) => { clearInterval(tick); clearTimeout(t); reject(new Error(`server exited ${c}: ${out.slice(-800)}`)); });
});
const local = `http://127.0.0.1:${port}`;
const toLocal = (u) => (u.startsWith(ORIGIN) ? local + u.slice(ORIGIN.length) : null);
async function send(call) {
  const url = toLocal(call.url);
  if (!url) return { status: -1 };
  const init = { method: call.method, headers: { ...(call.headers || {}) } };
  if (call.method === "POST") init.body = JSON.stringify(call.body ?? {});
  const r = await fetch(url, init);
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

try {
  // The outside buyer's shape: a bare GET to a POST-only tool.
  const r = await fetch(`${local}/api/base64`);
  const b = await r.json();
  ok(r.status === 400 && b.tool === "base64" && b.howToCall?.method === "POST" && b.howToCall.url === `${ORIGIN}/api/base64`,
    "a bare GET to /api/base64: 400 with howToCall POST on the configured BASE_URL");
  ok(JSON.stringify(b.howToCall?.body) === JSON.stringify(b.example), "...whose body is the published example the 400 already carries");
  ok(b.howToCall?.alternate?.method === "GET" && /\/api\/base64\?/.test(b.howToCall.alternate.url), "...and a GET form, since the alias serves a query-string GET there");
  for (const c of [b.howToCall, b.howToCall?.alternate].filter(Boolean)) {
    const res = await send(c);
    ok(res.status === 200 && typeof res.body?.result === "string", `the ${c.method} form runs as written (${res.status})`);
  }

  // Every free-tier tool whose empty call is refused: run what the 400 says.
  const pricing = await (await fetch(`${local}/api/pricing`)).json();
  const tools = (pricing.endpoints || []).filter((t) => t?.slug && t.computePayable === true && isComputePayable(t));
  ok(tools.length > 50, `pricing lists the free-tier tools (${tools.length})`);
  let refused = 0, ran = 0, alternates = 0;
  const broken = [];
  let capped = 0;
  for (const t of tools) {
    const [method, path] = String(t.route || `${t.method} ${t.path}`).split(" ");
    if (!path) continue;
    const empty = await fetch(`${local}${path}`, { method, headers: method === "POST" ? { "Content-Type": "application/json" } : {}, ...(method === "POST" ? { body: "{}" } : {}) });
    if (empty.status !== 400) { await empty.arrayBuffer(); continue; }
    const eb = await empty.json();
    refused++;
    if (!eb.howToCall) { broken.push(`${t.slug}: 400 without howToCall`); continue; }
    if (Buffer.byteLength(JSON.stringify(eb.howToCall), "utf8") > MAX_CALL_BYTES) { broken.push(`${t.slug}: howToCall past ${MAX_CALL_BYTES} bytes`); continue; }
    for (const c of [eb.howToCall, eb.howToCall.alternate].filter(Boolean)) {
      // A call past the budget names its method and URL; the body is the
      // 400's own example, sent once.
      const bare = c.method === "POST" && c.body === undefined && c.form === undefined;
      if (bare) capped++;
      const res = await send(bare ? { ...c, headers: { "Content-Type": "application/json" }, body: eb.example } : c);
      if (c === eb.howToCall.alternate) alternates++;
      if (res.status === 200) ran++;
      else broken.push(`${t.slug} ${c.method} -> ${res.status}${res.body?.error ? ` (${String(res.body.error).slice(0, 80)})` : ""}`);
    }
  }
  ok(refused > 20 && alternates > 0, `free-tier tools refused an empty call (${refused}); alternates sent (${alternates})`);
  ok(broken.length === 0, `every howToCall and alternate runs as written, a capped call with the 400's example (${ran} ran, ${capped} capped)${broken.length ? `: ${broken.slice(0, 12).join("; ")}` : ""}`);
} finally {
  proc.kill("SIGTERM");
}

// ---- Part 3: the unpaid 402 carries the same call (paid boot, stub facilitator)
{
  const fac = createServer((req, res) => {
    res.writeHead(req.url === "/supported" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/supported" ? { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} } : {}));
  });
  await new Promise((r) => fac.listen(0, "127.0.0.1", r));
  const paidEnv = {
    ...process.env, ...ownStoreEnv("how-to-call-paid"),
    FREE_MODE: "", PORT: "0", BASE_URL: ORIGIN, TARGET_URL: "",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${fac.address().port}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    STATS_ALLOW_EPHEMERAL: "true", FRONT_DOOR_402: "", PAYMENT_REQUIRED_BODY: "", FIRST_CALL_ALLOWANCE: "",
  };
  const paid = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env: paidEnv, stdio: ["ignore", "pipe", "pipe"] });
  let pout = "";
  paid.stdout.on("data", (d) => { pout += d; });
  paid.stderr.on("data", (d) => { pout += d; });
  try {
    const pport = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`paid server did not start: ${pout.slice(-800)}`)), 90_000);
      const tick = setInterval(() => { const mm = pout.match(/listening on :(\d+)/); if (mm) { clearInterval(tick); clearTimeout(t); resolve(Number(mm[1])); } }, 100);
      paid.on("exit", (c) => { clearInterval(tick); clearTimeout(t); reject(new Error(`paid server exited ${c}: ${pout.slice(-800)}`)); });
    });
    const P = `http://127.0.0.1:${pport}`;
    const r402 = await fetch(`${P}/api/base64`);
    const b402 = await r402.json().catch(() => ({}));
    const header = r402.headers.get("payment-required") || "";
    ok(r402.status === 402 && b402.howToCall?.method === "POST" && b402.howToCall.url === `${ORIGIN}/api/base64` && b402.howToCall.body?.text === "hello",
      "the unpaid 402 for a bare GET names the call to make once paid (POST, BASE_URL, the example body)");
    ok(Array.isArray(b402.accepts) || b402.x402Version !== undefined || Object.keys(b402).length > 1, "...beside the paywall's own body fields");
    ok(header.length > 0 && !Buffer.from(header, "base64").toString("utf8").includes("howToCall"), "...and the PAYMENT-REQUIRED header does not carry it (the header budget is untouched)");
    const refused = await fetch(`${P}/api/base64`, { headers: { authorization: "Bearer a402_00000000000000000000" } });
    const rb = await refused.json().catch(() => ({}));
    ok(refused.status !== 200 && !rb.howToCall, "a request that presented a credential keeps its own explanation (no howToCall)");
  } finally {
    paid.kill("SIGTERM");
    fac.close();
  }
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
