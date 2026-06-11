// Latency benchmark: server-side compute time per tool, plus PoW solve cost.
import { KIT } from "../src/tools/kit.js";
import { KIT2 } from "../src/tools/kit2.js";
import { createHash } from "node:crypto";

const ALL = [...KIT, ...KIT2];
// Pure-CPU, synchronous tools we can microbenchmark in-process. Skip ones that
// hit the network/browser/db or spawn workers (measured/characterized separately).
const SKIP = new Set([
  "extract", "meta", "dns", "render", "screenshot", "pdf",
  "http-check", "tls-cert", "whois", "robots-check", "sitemap",
  "email-validate", "ip-info", "regex", "qr",
  "memory-write", "memory-read", "memory-incr", "memory-grant", "memory-revoke",
  "memory-grants", "memory-log", "memory-remember", "memory-recall", "memory-forget",
]);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Tools backed by jsdom/marked/turndown are heavier and allocate a lot — fewer iters.
const HEAVY = new Set(["xml-to-json", "markdown-to-html", "html-to-markdown", "yaml-to-json", "json-to-yaml", "csv-to-json"]);

async function timeHandler(tool, iters) {
  const input = tool.discovery?.input ?? {};
  for (let i = 0; i < 5; i++) await tool.handler({ ...input }); // warm up
  const samples = [];
  for (let r = 0; r < 5; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) await tool.handler({ ...input });
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6 / iters);
  }
  return median(samples);
}

const rows = [];
for (const tool of ALL) {
  if (SKIP.has(tool.slug)) continue;
  try {
    const ms = await timeHandler(tool, HEAVY.has(tool.slug) ? 50 : 500);
    rows.push({ slug: tool.slug, ms, heavy: HEAVY.has(tool.slug) });
  } catch (e) {
    rows.push({ slug: tool.slug, ms: NaN, err: e.message.slice(0, 40) });
  }
}
rows.sort((a, b) => b.ms - a.ms);

console.log("\n=== Server-side compute per call (pure-CPU tools), slowest first ===");
for (const r of rows.slice(0, 12)) console.log(`  ${(r.ms * 1000).toFixed(1).padStart(8)} µs   ${r.slug}${r.err ? "  ERR " + r.err : ""}`);
console.log("  …");
const ok = rows.filter((r) => Number.isFinite(r.ms));
console.log(`\n  ${ok.length} pure-CPU tools measured`);
console.log(`  median tool: ${(median(ok.map((r) => r.ms)) * 1000).toFixed(1)} µs`);
console.log(`  fastest: ${(Math.min(...ok.map((r) => r.ms)) * 1000).toFixed(1)} µs (${ok.find((r) => r.ms === Math.min(...ok.map((x) => x.ms))).slug})`);
console.log(`  slowest: ${(Math.max(...ok.map((r) => r.ms))).toFixed(2)} ms (${rows[0].slug})`);
console.log(`  all ${ok.length} tools complete in under ${(Math.max(...ok.map((r) => r.ms))).toFixed(1)} ms of compute`);

// PoW solve cost at various difficulties (the free-tier latency tax).
console.log("\n=== Proof-of-work solve time (free-tier latency, client CPU) ===");
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
for (const diff of [16, 18, 20, 22]) {
  const times = [];
  for (let trial = 0; trial < 5; trial++) {
    const challenge = createHash("sha256").update(Math.random() + "").digest("hex");
    const t0 = process.hrtime.bigint();
    let n = 0;
    while (lz(createHash("sha256").update(challenge + ":" + n).digest()) < diff) n++;
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`  difficulty ${diff}: ~${median(times).toFixed(0)} ms median  (≈2^${diff} hashes)`);
}
