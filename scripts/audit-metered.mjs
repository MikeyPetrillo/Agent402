#!/usr/bin/env node
// The synthesis half of the metered blind spot: drive every METERED slug (the
// ~147 routes both catalog sweeps skip because CI holds no third-party keys)
// against REAL upstreams with its own documented example, and grade what comes
// back the way the sweeps grade everything else.
//
// NOT a CI script. It spends real money (about $11 for a full pass on 2026-08-29,
// through the dedicated OpenRouter audit key so the spend is labelled) and needs
// the prod keys in the booting server's environment. Recipe in CLAUDE.md
// ("Broken-tool audit with PRODUCTION KEYS").
//
//   TARGET_URL=http://127.0.0.1:PORT node scripts/audit-metered.mjs [--only slug,slug] [--out file.json]
//
// Grading, per slug:
//   ok        200 + every documented top-level key present + no promised array empty
//   defect    our own 4xx/500 on the documented example, or a 200 missing documented
//             keys / with an empty promised array (the sweep-shape rules)
//   upstream  502/503/504/429 or a network failure (reported, not ours to fix here)
//   skipped   no operation found in /openapi.json for the slug
import { writeFileSync, readFileSync } from "node:fs";
import { missingDocumentedKeys, emptyPromisedArrays } from "./sweep-shape.js";

const TARGET = (process.env.TARGET_URL || "").replace(/\/$/, "");
if (!TARGET) { console.error("TARGET_URL required (a FREE_MODE boot with the prod keys)"); process.exit(2); }
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ONLY = new Set(String(arg("only", "")).split(",").map((s) => s.trim()).filter(Boolean));
const OUT = arg("out", "");
const PER_CALL_MS = Number(process.env.AUDIT_PER_CALL_MS || 300_000);
const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY || 2);

// The metered list is the sweep's own exclusion set, read from its source so
// the two cannot drift.
const src = readFileSync(new URL("./test-non-metered-examples.js", import.meta.url), "utf8");
const m = src.match(/METERED_SLUGS = new Set\(\[([\s\S]*?)\]\)/);
const METERED = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);

const spec = await (await fetch(`${TARGET}/openapi.json`)).json();
const ops = [];
for (const [path, item] of Object.entries(spec.paths || {})) {
  for (const [method, op] of Object.entries(item || {})) {
    if (!/^(get|post)$/.test(method)) continue;
    ops.push({ path, method: method.toUpperCase(), op });
  }
}
const slugOf = (o) => o.op.operationId || o.path.replace(/^\/(api|v1)\//, "").replace(/\//g, "-");
const byOperationId = new Map(ops.map((o) => [String(o.op.operationId || ""), o]));
const bySlugPath = new Map(ops.map((o) => [slugOf(o), o]));
const findOp = (slug) => byOperationId.get(slug) || bySlugPath.get(slug) || ops.find((o) => o.path === `/api/${slug}`) || null;

const buildRequest = (o) => {
  const headers = { accept: "application/json" };
  if (o.method === "GET") {
    const qs = new URLSearchParams();
    for (const p of o.op.parameters || []) if (p.in === "query" && p.example !== undefined) qs.set(p.name, typeof p.example === "string" ? p.example : JSON.stringify(p.example));
    return { url: `${TARGET}${o.path}${qs.toString() ? `?${qs}` : ""}`, init: { method: "GET", headers } };
  }
  const example = o.op.requestBody?.content?.["application/json"]?.example ?? {};
  return { url: `${TARGET}${o.path}`, init: { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(example) } };
};
const UPSTREAM = /^(502|503|504|429)$/;
const classify = (status, body, o) => {
  if (status === 200) {
    let missing = [], empty = [];
    try { missing = missingDocumentedKeys(o.path, o.op, body) || []; } catch { missing = []; }
    try { empty = emptyPromisedArrays(o.path, o.op, body) || []; } catch { empty = []; }
    if (missing.length) return { grade: "defect", why: `200 missing documented keys: ${missing.join(", ")}` };
    if (empty.length) return { grade: "defect", why: `200 with empty promised arrays: ${empty.join(", ")}` };
    return { grade: "ok", why: "" };
  }
  const err = String(body?.error || body?.message || (typeof body === "string" ? body : "")).slice(0, 200);
  if (UPSTREAM.test(String(status)) || status === 0) return { grade: "upstream", why: `${status} ${err}` };
  return { grade: "defect", why: `${status} ${err}` };
};

const targets = METERED.filter((s) => !ONLY.size || ONLY.has(s));
const results = [];
let cursor = 0;
const worker = async () => {
  for (;;) {
    const slug = targets[cursor++];
    if (!slug) return;
    const o = findOp(slug);
    if (!o) { results.push({ slug, grade: "skipped", why: "no operation in /openapi.json" }); console.log(`skip    ${slug}: no operation`); continue; }
    // Identity-bound routes (memory, my-usage) key on the PAYING wallet; a
    // free-mode boot has no payer, so their 400 is the contract, not a defect.
    if ((o.op.tags || []).includes("memory") || slug === "my-usage" || /^memory-/.test(slug)) { results.push({ slug, grade: "skipped", why: "identity-bound (needs a paying wallet)" }); console.log(`skip    ${slug}: identity-bound`); continue; }
    const { url, init } = buildRequest(o);
    const t0 = Date.now();
    let status = 0, body = null, text = "";
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PER_CALL_MS) });
      status = res.status;
      const ct = res.headers.get("content-type") || "";
      if (/json/.test(ct)) { text = await res.text(); try { body = JSON.parse(text); } catch { body = text; } }
      else { text = ct.startsWith("audio/") || ct.startsWith("image/") ? `(${ct} ${res.headers.get("content-length") || "?"} bytes)` : await res.text(); body = text; }
    } catch (e) { status = 0; text = String(e?.message || e); body = { error: text }; }
    const ms = Date.now() - t0;
    const { grade, why } = typeof body === "string" && status === 200 ? { grade: "ok", why: "" } : classify(status, body, o);
    results.push({ slug, path: o.path, method: o.method, status, ms, grade, why, excerpt: (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 240) });
    console.log(`${grade.padEnd(8)} ${slug.padEnd(30)} ${o.method} ${o.path} -> ${status} in ${ms}ms${why ? `  | ${why}` : ""}`);
  }
};
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));

const counts = results.reduce((a, r) => { a[r.grade] = (a[r.grade] || 0) + 1; return a; }, {});
console.log(`\n${results.length} metered slugs driven: ${JSON.stringify(counts)}`);
const defects = results.filter((r) => r.grade === "defect");
if (defects.length) { console.log("\nDEFECTS:"); for (const d of defects) console.log(`  ${d.slug} ${d.method} ${d.path} -> ${d.status}: ${d.why}\n    ${d.excerpt}`); }
const upstream = results.filter((r) => r.grade === "upstream");
if (upstream.length) { console.log("\nUPSTREAM (reported, not ours):"); for (const u of upstream) console.log(`  ${u.slug} -> ${u.status}: ${u.why}`); }
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), target: TARGET, counts, results }, null, 1));
process.exit(defects.length ? 1 : 0);
