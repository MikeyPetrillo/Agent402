#!/usr/bin/env node
// The MPP start-here set (src/mpp-flagship.js) is defined once and shown on
// four surfaces: /what-is-mpp, /llms.txt, /openapi.json (x-mpp-flagship) and
// the hosted MCP connector's payment.info. This pins that:
//   - the list is 15-25 unique slugs, each with a one-line reason and no
//     typed price;
//   - every slug is a live catalog route that the 402 offers tempo on (not
//     identity-bound, not long-running) - checked on the booted server's own
//     /openapi.json offers with the tempo method switched on;
//   - every surface carries exactly the list, in order, and every price it
//     shows is the catalog's (/api/pricing);
//   - each surface module builds from mpp-flagship.js rather than a copy.
// Boots its own FREE_MODE server on a free port (or reads TARGET_URL).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { MPP_FLAGSHIP, MPP_FLAGSHIP_SLUGS, MPP_FLAGSHIP_SNIPPET_SLUG } from "../src/mpp-flagship.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---------------------------------------------------------------- the list
ok(MPP_FLAGSHIP.length >= 15 && MPP_FLAGSHIP.length <= 25, `list has 15-25 entries (${MPP_FLAGSHIP.length})`);
ok(new Set(MPP_FLAGSHIP_SLUGS).size === MPP_FLAGSHIP_SLUGS.length, "slugs are unique");
ok(MPP_FLAGSHIP.every((f) => typeof f.why === "string" && f.why.length >= 10 && f.why.length <= 140), "every entry has a one-line why");
ok(MPP_FLAGSHIP.every((f) => typeof f.group === "string" && f.group), "every entry names a group");
ok(MPP_FLAGSHIP.every((f) => !/\$\s?\d/.test(f.why)), "no price is typed into a why line");
ok(MPP_FLAGSHIP.every((f) => !/[—–]/.test(f.why)), "no em or en dash in the copy");
ok(new Set(MPP_FLAGSHIP.map((f) => f.group)).size >= 6, "the list spans at least six groups");
ok(MPP_FLAGSHIP_SLUGS.includes(MPP_FLAGSHIP_SNIPPET_SLUG), "snippet route is on the list");

// ---------------------------------------------------------------- derivation pins
const src = (f) => readFileSync(path.join(ROOT, f), "utf8");
for (const [file, fn] of [
  ["src/what-is-mpp.js", "mppFlagshipRows"],
  ["src/seo.js", "mppFlagshipLlmsBlock"],
  ["src/pages.js", "mppFlagshipRows"],
  ["src/mcp-http.js", "mppFlagshipRows"],
]) {
  const s = src(file);
  ok(s.includes('from "./mpp-flagship.js"') && s.includes(`${fn}(`), `${file} derives from mpp-flagship.js (${fn})`);
}
ok(/whatIsMppPage\(BASE_URL, CATALOG\)/.test(src("src/server.js")), "server.js hands /what-is-mpp the catalog");
ok(/tempoOfferedFor\(def\)/.test(src("src/mpp-flagship.js")), "rows are filtered by the same tempo predicate the 402 uses");

// ---------------------------------------------------------------- boot
const TREASURY = "0x1111111111111111111111111111111111111111";
async function boot() {
  if (process.env.TARGET_URL) return { base: process.env.TARGET_URL.replace(/\/$/, ""), child: null };
  const port = await getFreePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, FREE_MODE: "true", PORT: String(port),
      // Tempo switched on so /openapi.json publishes the tempo offers the 402 makes.
      MPP_SECRET_KEY: "test-mpp-secret", TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY, WALLET_ADDRESS: TREASURY,
      // judge is listed only with its key; a placeholder lists it (nothing here calls it).
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY || "test-placeholder",
      X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", SOLANA_LEADERBOARD: "off", MONITOR_SCHEDULER: "off",
      FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`; const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return { base, child }; } catch { /* booting */ }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGKILL"); throw new Error(`no /health in 120s\n${log.slice(-2000)}`);
}

const { base, child } = await boot();
try {
  const get = async (p) => { const r = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(60_000) }); if (!r.ok) throw new Error(`${p} -> ${r.status}`); return r; };
  const pricing = await (await get("/api/pricing")).json();
  const bySlug = new Map((pricing.endpoints || []).map((e) => [e.slug, e]));

  for (const slug of MPP_FLAGSHIP_SLUGS) ok(bySlug.has(slug), `${slug} is a live catalog route`);
  const catalogPrice = (slug) => bySlug.get(slug)?.price;

  // /openapi.json
  const spec = await (await get("/openapi.json")).json();
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths || {})) for (const [m, op] of Object.entries(item)) ops.push({ method: m.toUpperCase(), path: p, op });
  const opOf = (slug) => { const e = bySlug.get(slug); return e && ops.find((o) => o.method === e.method && o.path === e.path); };
  for (const [i, f] of MPP_FLAGSHIP.entries()) {
    const o = opOf(f.slug);
    ok(!!o, `${f.slug}: operation in /openapi.json`);
    if (!o) continue;
    const offers = o.op["x-payment-info"]?.offers || [];
    ok(offers.some((x) => x.method === "tempo"), `${f.slug}: the 402 offers tempo (x-payment-info.offers)`);
    ok(/MPP \(Tempo or Base\)/.test(o.op.description || ""), `${f.slug}: not identity-bound or long-running`);
    const mark = o.op["x-mpp-flagship"];
    ok(mark && mark.order === i + 1 && mark.why === f.why, `${f.slug}: x-mpp-flagship order ${i + 1} and why`);
    ok(o.op["x-price"] === catalogPrice(f.slug), `${f.slug}: x-price equals the catalog price`);
  }
  const marked = ops.filter((o) => o.op["x-mpp-flagship"]).length;
  ok(marked === MPP_FLAGSHIP.length, `exactly the list is marked in /openapi.json (${marked})`);
  const top = spec["x-mpp-flagship"] || [];
  ok(JSON.stringify(top.map((r) => r.slug)) === JSON.stringify(MPP_FLAGSHIP_SLUGS), "top-level x-mpp-flagship lists the set in order");
  ok(top.every((r) => r.price === catalogPrice(r.slug) && r.method === bySlug.get(r.slug)?.method && r.path === bySlug.get(r.slug)?.path), "top-level x-mpp-flagship method, path and price match the catalog");

  // /llms.txt
  const llms = await (await get("/llms.txt")).text();
  ok(llms.includes("**MPP: start here.**"), "/llms.txt carries the MPP start-here block");
  for (const slug of MPP_FLAGSHIP_SLUGS) {
    const e = bySlug.get(slug);
    ok(e && llms.includes(`\`${e.method} ${e.path}\` (${e.price})`), `/llms.txt lists ${slug} at the catalog price`);
  }

  // /what-is-mpp
  const html = await (await get("/what-is-mpp")).text();
  ok(html.includes('id="start-here"'), "/what-is-mpp has the start-here section");
  const pagePrices = [...html.matchAll(/data-mpp-price="([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2]]);
  ok(JSON.stringify(pagePrices.map((p) => p[0])) === JSON.stringify(MPP_FLAGSHIP_SLUGS), "/what-is-mpp lists the set in order");
  for (const [slug, price] of pagePrices) ok(price === catalogPrice(slug), `/what-is-mpp ${slug} price ${price} equals the catalog`);
  const snip = bySlug.get(MPP_FLAGSHIP_SNIPPET_SLUG);
  ok(html.includes("mppx/client") && html.includes(`${snip.path}?`), "/what-is-mpp carries the mppx snippet for the snippet route");

  // hosted MCP connector payment.info
  let id = 1;
  const rpc = async (method, params) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }), signal: AbortSignal.timeout(60_000) });
    const ct = (r.headers.get("content-type") || "").split(";")[0];
    const body = ct === "text/event-stream"
      ? JSON.parse((await r.text()).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""))
      : await r.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  };
  const pay = await rpc("tools/call", { name: "payment.info", arguments: {} });
  const payload = pay.structuredContent || JSON.parse((pay.content || []).map((c) => c.text || "").join(""));
  const routes = payload?.mppStartHere?.routes || [];
  ok(JSON.stringify(routes.map((r) => r.slug)) === JSON.stringify(MPP_FLAGSHIP_SLUGS), "payment.info mppStartHere lists the set in order");
  ok(routes.every((r) => r.price === catalogPrice(r.slug) && r.path === bySlug.get(r.slug)?.path), "payment.info prices and paths match the catalog");
} finally {
  if (child) child.kill("SIGTERM");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
