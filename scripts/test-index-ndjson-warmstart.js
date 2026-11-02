#!/usr/bin/env node
// The index cache warm-start must not hold the event loop (2026-08-25). The
// legacy loader is one JSON.parse of the whole file - 1.4-3 s on prod for
// 48 MB, plus the GC after it - inside the seconds a fresh container has to
// answer its first health check. The NDJSON twin is parsed a few hundred
// sellers per turn with a setImmediate between batches. This proves, on a
// synthetic 3,000-seller cache, that (1) the async persist writes the twin,
// (2) the incremental loader loads every seller, (3) no single turn holds the
// loop for long while it does, and (4) the legacy loader still works when no
// twin exists (first boot after this ships).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const dir = mkdtempSync(join(tmpdir(), "a402-ndjson-"));
const jsonFile = join(dir, "index.json");
const ndFile = join(dir, "index.ndjson");

// A 3,000-seller cache with realistic per-tool weight (~450 bytes each).
const entries = [];
for (let i = 0; i < 3000; i++) {
  const origin = `https://seller${i}.example.test`;
  const tools = Array.from({ length: 12 }, (_, j) => ({ seller: origin, method: "POST", route: `/api/tool${j}`, slug: `tool-${j}`, name: `Tool ${j} of ${i}`, description: "Deterministic description text for a tool that does one thing well and says so. ".repeat(3), category: "data", tags: ["a", "b"], price: "$0.002", networks: ["eip155:8453"], accepts: [{ network: "eip155:8453", payTo: "0x" + String(i).padStart(40, "0") }] }));
  entries.push([origin, { manifest: { name: `Seller ${i}`, homepage: origin }, tools, fetchedAt: 1, error: null, source: "openapi", history: [1, 1], paywall: null }]);
}
writeFileSync(jsonFile, JSON.stringify({ savedAt: Date.now(), entries }));

// Child A: legacy load from JSON, then async persist -> writes the NDJSON twin.
const childA = `
  import { loadPersistedIndexCache, persistIndexCacheAsync } from ${JSON.stringify(new URL("../src/x402-index.js", import.meta.url).href)};
  const n = loadPersistedIndexCache(${JSON.stringify(jsonFile)});
  const okp = await persistIndexCacheAsync(${JSON.stringify(jsonFile)});
  process.send({ n, okp });
`;
// Child B: incremental load from the twin while a 10 ms ticker measures the
// longest gap between ticks - the event-loop hold the loader caused.
const childB = `
  const { loadPersistedIndexCacheAsync, indexWarmStartInProgress } = await import(${JSON.stringify(new URL("../src/x402-index.js", import.meta.url).href)});
  let last = performance.now(), worst = 0, ticks = 0;
  const t = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now; ticks++; }, 10);
  // Sample the flag from INSIDE the load's own turns (every loop iteration
  // until the promise settles), never at a fixed clock offset: on a slow
  // runner the file read alone can outlast any fixed delay.
  let sawTrue = false, done = false;
  const p = loadPersistedIndexCacheAsync(${JSON.stringify(ndFile)}).then((n) => { done = true; return n; });
  (function sample() { if (done) return; if (indexWarmStartInProgress()) sawTrue = true; setImmediate(sample); })();
  const n = await p;
  clearInterval(t);
  process.send({ n, worst, ticks, inProgressAfter: indexWarmStartInProgress(), sawTrue });
`;
const run = (code) => new Promise((resolve) => {
  const tmp = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(tmp, code);
  const c = fork(tmp, [], { env: { ...process.env, X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let out = ""; c.stdout.on("data", (d) => out += d); c.stderr.on("data", (d) => out += d);
  c.on("message", (m) => resolve({ ...m, out }));
  c.on("exit", (code) => resolve({ exit: code, out }));
});

const a = await run(childA);
ok(a.n === 3000, `legacy loader loaded the synthetic cache (${a.n})`);
ok(a.okp === true && existsSync(ndFile), "async persist wrote the NDJSON twin next to the JSON");
const mb = existsSync(ndFile) ? statSync(ndFile).size / 1048576 : 0;
ok(mb > 5, `twin is realistically large (${mb.toFixed(1)} MB)`);
const firstLine = existsSync(ndFile) ? (await import("node:fs")).readFileSync(ndFile, "utf8").split("\n")[0] : "";
ok(/"format":"ndjson-v1"/.test(firstLine) && /"origins":3000/.test(firstLine), "header line names the format and the origin count");

const b = await run(childB);
ok(b.n === 3000, `incremental loader loaded every seller (${b.n})`);
ok(b.worst < 150, `longest event-loop hold during the incremental load was ${Math.round(b.worst)}ms (must stay under 150ms; the legacy loader holds it for the whole parse)`);
// Control: the same ticker around the LEGACY loader on the same data must see a
// longer hold, or the ticker could not see holds and the number above is vacuous.
const childD = `
  const { loadPersistedIndexCache } = await import(${JSON.stringify(new URL("../src/x402-index.js", import.meta.url).href)});
  let last = performance.now(), worst = 0;
  const t = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  const n = loadPersistedIndexCache(${JSON.stringify(jsonFile)});
  const parseMs = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(t);
  process.send({ n, worst, parseMs });
`;
const d = await run(childD);
// The control is self-consistent: the one-shot parse is synchronous, so the
// ticker must have seen a hold at least half as long as the parse it timed
// itself. (It used to demand 3x the incremental loader's worst tick, and one
// noisy GC pause on a shared runner - 93 ms - failed a green build.)
ok(d.n === 3000 && d.parseMs > 40 && d.worst > 40 && d.worst >= d.parseMs * 0.5,
  `control: the legacy one-shot parse took ${Math.round(d.parseMs)}ms and the ticker saw a ${Math.round(d.worst)}ms hold (incremental: ${Math.round(b.worst)}ms) - the ticker sees holds`);
ok(b.sawTrue === true, "indexWarmStartInProgress() is true while the load runs (snapshot readers must not pin a half-loaded cache)");
ok(b.inProgressAfter === false, "indexWarmStartInProgress() is false once the load completes");

// Legacy fallback: no twin -> async loader reports 0 and the sync loader serves.
const dir2 = mkdtempSync(join(tmpdir(), "a402-ndjson-"));
const childC = `
  import { loadPersistedIndexCacheAsync, loadPersistedIndexCache } from ${JSON.stringify(new URL("../src/x402-index.js", import.meta.url).href)};
  const n = await loadPersistedIndexCacheAsync(${JSON.stringify(join(dir2, "missing.ndjson"))});
  const m = loadPersistedIndexCache(${JSON.stringify(jsonFile)});
  process.send({ n, m });
`;
const c = await run(childC);
ok(c.n === 0 && c.m === 3000, `without a twin the async loader yields 0 and the legacy loader still serves (${c.n}, ${c.m})`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
