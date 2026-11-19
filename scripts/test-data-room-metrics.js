// scripts/data-room-metrics.js reads only the five public surfaces, sends no
// credential, and summarizes a real server's answers. A stub fetch pins the
// request set; a FREE_MODE boot (PORT=0) pins the summary against live bodies.
// Never run against production here.
//
//   node scripts/test-data-room-metrics.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/boot-server.js";
import { readSurfaces, summarize, SURFACES } from "./data-room-metrics.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// 1. Stub: the request set and the headers sent.
const seen = [];
const stub = async (url, init) => {
  seen.push({ url, headers: init?.headers || {} });
  const path = new URL(url).pathname;
  if (path === "/api/status") return new Response("nope", { status: 503 });
  const bodies = {
    "/health": { ok: true, meta: { toolCount: 3, build: "abc1234" } },
    "/api/pricing": { payment: { protocol: "x402", networks: ["a", "b"] }, endpoints: [
      { price: "$0.002", category: "web", modelBacked: false, computePayable: true },
      { price: "$0.01", category: "web", modelBacked: true },
      { price: 0.5, category: "llm", quoted: true },
    ] },
    "/api/stats": { tools: 3, toolCallsServed: { total: 10, viaUSDC: 4, viaProofOfWork: 6 }, chargedButFailedGenuine: 0 },
    "/api/reliability": { status: "ok", guarantees: [1, 2], servingSince: "2026-01-01T00:00:00Z" },
  };
  return new Response(JSON.stringify(bodies[path]), { status: 200, headers: { "content-type": "application/json" } });
};
const { bodies, unreadable } = await readSurfaces("http://stub.invalid", { fetchImpl: stub });
ok(seen.map((s) => new URL(s.url).pathname).join() === SURFACES.join(), `exactly the five public surfaces are read (${seen.map((s) => new URL(s.url).pathname).join(", ")})`);
ok(seen.every((s) => !Object.keys(s.headers).some((h) => /authorization|token|cookie|payment/i.test(h))), "no credential, cookie or payment header is sent");
ok(unreadable.length === 1 && unreadable[0].surface === "/api/status", "an unreadable surface is named, not fatal");
const s = summarize("http://stub.invalid", bodies, unreadable);
ok(s.catalog.pricedEndpoints === 3 && s.catalog.modelBacked === 1 && s.catalog.proofOfWorkEligible === 1 && s.catalog.quoted === 1, "catalog counts come from the pricing rows");
ok(s.catalog.priceUsd.min === 0.002 && s.catalog.priceUsd.max === 0.5 && s.catalog.priceUsd.median === 0.01, "prices parse from both string and number forms");
ok(s.catalog.categories.web === 2 && s.payment.networks === 2 && s.usage.toolCallsServed === 10 && s.reliability.overall === "ok", "categories, networks, usage and the overall word are summarized");

// 2. A local FREE_MODE server through the CLI.
const srv = await bootServer({ env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" }, stores: "data-room" });
try {
  const r = spawnSync(process.execPath, ["scripts/data-room-metrics.js"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, BASE_URL: srv.url }, timeout: 120_000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* checked below */ }
  ok(r.status === 0 && j, `the CLI reads a local server and exits 0 (${r.status}${r.stderr ? `: ${r.stderr.slice(0, 200)}` : ""})`);
  ok(j && j.source === srv.url && j.unreadable.length === 0, "every surface was readable on the local server");
  ok(j && j.catalog.toolCount >= 400 && j.catalog.pricedEndpoints >= 400 && j.catalog.proofOfWorkEligible > 0, `the catalog summary reflects the live catalog (${j?.catalog.toolCount} tools, ${j?.catalog.pricedEndpoints} priced)`);
  ok(j && typeof j.build === "string" && j.reliability.components > 0 && j.reliability.guarantees > 0, "build, status components and guarantees are read");
  ok(j && j.catalog.priceUsd && j.catalog.priceUsd.min > 0 && j.catalog.priceUsd.min <= j.catalog.priceUsd.median, "the price band is ordered and positive");
} finally { await srv.stop(); }

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
