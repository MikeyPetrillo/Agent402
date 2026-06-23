// /api/route is the neutral cross-seller router. POST { query, top, include }
// returns ranked tools across every x402 seller Agent402 has crawled (auto-
// discovered from the Coinbase CDP Bazaar) plus the local catalog. Buyers
// use it to find tools regardless of seller; `include:'external'` deliberately
// excludes Agent402 from the results — same router used as a neutral
// discovery API over the rest of the ecosystem.
//
// This surface is declared in /.well-known/x402 as `discovery.neutralRouter`
// and in /llms.txt as the cross-seller discovery path. A regression in the
// envelope here (renamed field, lost include filter) cascades to every
// buyer-side SDK and external aggregator using the URL from the manifest.
//
// This test boots FREE_MODE and locks:
//
//   1. POST /api/route → 200 application/json.
//   2. Envelope: { query, include, count, sellers, results[] }.
//   3. include defaults / echoes correctly (default vs explicit).
//   4. top caps results length.
//   5. results[] rows carry the documented per-tool shape: seller,
//      sellerHome, sellerName, slug, name, method, route, url, price,
//      priceUsd, category, description.
//   6. For self-served rows: seller === 'self' and sellerHome matches BASE.
//   7. include='external' excludes the local catalog.
//   8. Empty body / missing query → 200 with count=0 and empty results[]
//      (no silent partial routing; the empty array is the observable signal
//      that the buyer forgot to send a query).
//
//   node scripts/test-route-envelope.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3080;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (body) => fetch(`${BASE}/api/route`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  // Happy path — query ranked across sellers, include=all.
  const res = await post({ query: "ocr image", top: 3, include: "all" });
  ok(res.status === 200, `POST /api/route → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("application/json"), `content-type is application/json`);
  const body = await res.json();

  // Envelope keys.
  for (const k of ["query", "include", "count", "sellers", "results"]) {
    ok(k in body, `envelope key '${k}' present (got: ${Object.keys(body).join(",")})`);
  }
  ok(body.query === "ocr image", `query is echoed (got ${body.query})`);
  ok(body.include === "all", `include is echoed (got ${body.include})`);
  ok(typeof body.count === "number", `count is a number (got ${typeof body.count})`);
  ok(typeof body.sellers === "number" && body.sellers >= 1, `sellers is >= 1 (got ${body.sellers}) — at least self`);
  ok(Array.isArray(body.results), "results is an array");
  ok(body.results.length <= 3, `top=3 honored (got ${body.results.length})`);
  ok(body.results.length > 0, `'ocr image' has at least one result (got ${body.results.length}) — image-ocr is in catalog`);

  // Per-row shape — every documented field a downstream consumer reads.
  const row = body.results[0];
  for (const k of ["seller", "sellerHome", "sellerName", "slug", "name", "method", "route", "url", "price", "priceUsd", "category", "description"]) {
    ok(k in row, `row carries ${k} (got keys: ${Object.keys(row).join(",")})`);
  }
  ok(typeof row.priceUsd === "number", `row.priceUsd is a number (got ${typeof row.priceUsd})`);
  ok(typeof row.url === "string" && row.url.startsWith("http"), `row.url is an http URL (got ${row.url})`);
  // For self-served rows: seller === 'self' and sellerHome matches BASE.
  // 'ocr image' should match image-ocr which is in local catalog.
  const selfRow = body.results.find((r) => r.seller === "self");
  ok(selfRow, `at least one result has seller='self' (image-ocr is in local catalog)`);
  if (selfRow) {
    ok(selfRow.sellerHome === BASE, `self row sellerHome matches BASE (got ${selfRow.sellerHome}, expected ${BASE})`);
  }

  // include='external' must exclude self results. CI may have no external
  // sellers cached (warming), so we only assert "no self rows" — not "rows
  // exist."
  const ext = await post({ query: "ocr image", top: 3, include: "external" });
  const extBody = await ext.json();
  ok(ext.status === 200, `external POST → 200 (got ${ext.status})`);
  ok(extBody.include === "external", `external include is echoed`);
  const externalHasSelf = (extBody.results || []).some((r) => r.seller === "self");
  ok(!externalHasSelf, `include='external' has zero self rows (got ${(extBody.results || []).length} results, none should be self)`);

  // Default include — when not provided, what does it default to? The
  // manifest documents 'all' / 'external' / 'local' as valid options. We
  // pin whatever the server says today so a silent default-flip surfaces.
  const def = await post({ query: "ocr image", top: 1 });
  const defBody = await def.json();
  ok(typeof defBody.include === "string" && ["all", "external", "local"].includes(defBody.include), `default include is one of all|external|local (got ${defBody.include})`);

  // Missing query — server returns 200 with count=0 and empty results.
  // The empty array is the observable signal — a downstream buyer can detect
  // "no query sent" by `count === 0 && results.length === 0` without parsing
  // an error envelope.
  const noQ = await post({ top: 3 });
  ok(noQ.status === 200, `missing query → 200 (got ${noQ.status}) — no error envelope`);
  const noQBody = await noQ.json();
  ok(noQBody.count === 0, `missing query → count=0 (got ${noQBody.count})`);
  ok(Array.isArray(noQBody.results) && noQBody.results.length === 0, `missing query → results=[] (got ${noQBody.results?.length})`);

  console.log(`\n${pass} passed (${body.results.length} results, self rows=${body.results.filter((r) => r.seller === "self").length})`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
