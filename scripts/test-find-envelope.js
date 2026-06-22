// /api/find is the local catalog resolver — same buyer-side cache key as
// /api/route, but it's the canonical "I have a task, give me one tool" hop
// that the agent402-client SDK + MCP `find_tool` both run. A per-row shape
// change cascades into the SDK; a ranker tuning that silently flips the
// top pick changes which tool gets called by every uninformed agent.
//
// This test boots FREE_MODE and locks:
//
//   1. GET /api/find?q=<known-task> → 200 application/json.
//   2. Envelope: { query (echoed), count, results[], packs[] }.
//      packs[] surfaces skill packs that match — the workflow tier above
//      individual tools.
//   3. Per-row shape: slug, name, route ("METHOD /api/...path"), price
//      (string, "$X.XX" — listed as a string for downstream display, not a
//      number), callExample{method,path,...}, example (the documented
//      input the tool answers), required[], inputSchema.
//   4. Top-1 ranking for known canonical queries — pins the ranker so a
//      tuning regression that silently flips top picks fails fast:
//        - "qr code"        → qr
//        - "ocr image"      → image-ocr
//        - "sha256 hash"    → hash
//        - "extract article" → extract
//      These four cover four different tool kits (image, ocr, util, web)
//      so a single-kit rerank doesn't silently slip past.
//   5. Empty query → 200 with count=0 (parallel to /api/route).
//
//   node scripts/test-find-envelope.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3094;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  // Envelope + per-row shape using "qr code" as the probe query.
  const res = await fetch(`${BASE}/api/find?q=qr%20code`);
  ok(res.status === 200, `/api/find → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("application/json"), "content-type is application/json");
  const body = await res.json();
  for (const k of ["query", "count", "results", "packs"]) {
    ok(k in body, `envelope key '${k}' present (got: ${Object.keys(body).join(",")})`);
  }
  ok(body.query === "qr code", `query is echoed (got ${body.query})`);
  ok(typeof body.count === "number" && body.count > 0, `count is positive (got ${body.count})`);
  ok(Array.isArray(body.results) && body.results.length > 0, `results is a non-empty array`);
  ok(Array.isArray(body.packs), `packs is an array (skill packs that match the query)`);

  const row = body.results[0];
  for (const k of ["slug", "name", "route", "price", "callExample", "example", "required", "inputSchema"]) {
    ok(k in row, `row carries ${k} (got keys: ${Object.keys(row).join(",")})`);
  }
  // Route shape: "METHOD /api/<slug-path>" — the agent402-client SDK splits
  // on space to recover the method.
  ok(typeof row.route === "string" && /^(GET|POST|PUT|DELETE) \/api\//.test(row.route), `row.route is 'METHOD /api/...' (got ${row.route})`);
  // Price is a display string ($X.XX), not a number — the per-tool docs and
  // /shop page render it verbatim.
  ok(typeof row.price === "string" && row.price.startsWith("$"), `row.price is a display string starting with $ (got ${row.price})`);
  // callExample is the structured "how to call me" hint.
  ok(typeof row.callExample === "object" && row.callExample != null, `row.callExample is an object`);
  ok(typeof row.callExample.method === "string", `row.callExample.method is string`);
  ok(typeof row.callExample.path === "string" && row.callExample.path.startsWith("/api/"), `row.callExample.path is an /api/ path`);
  ok(Array.isArray(row.required), `row.required is an array of required-field names`);
  ok(typeof row.inputSchema === "object" && row.inputSchema != null, `row.inputSchema is a JSONSchema object`);

  // Top-1 ranking lock. Each pair covers a different tool kit so a single
  // kit's rerank doesn't slip past.
  const TOP1 = [
    ["qr code",         "qr"],
    ["ocr image",       "image-ocr"],
    ["sha256 hash",     "hash"],
    ["extract article", "extract"],
  ];
  for (const [q, expectedSlug] of TOP1) {
    const r = await (await fetch(`${BASE}/api/find?q=${encodeURIComponent(q)}`)).json();
    const got = r.results?.[0]?.slug;
    ok(got === expectedSlug, `'${q}' → top1=${expectedSlug} (got ${got})`);
  }

  // Empty/missing query — parallels /api/route's documented contract:
  // 200 with count=0, no error envelope.
  const empty = await fetch(`${BASE}/api/find`);
  ok(empty.status === 200, `missing query → 200 (got ${empty.status})`);
  const emptyBody = await empty.json();
  ok(emptyBody.count === 0, `missing query → count=0 (got ${emptyBody.count})`);
  ok(Array.isArray(emptyBody.results) && emptyBody.results.length === 0, `missing query → results=[] (got ${emptyBody.results?.length})`);

  console.log(`\n${pass} passed (${body.results.length} results for 'qr code', ${body.packs.length} skill packs matched)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
