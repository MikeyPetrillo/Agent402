// Cache hygiene (M5) — defends Attack III (cache leakage) from "Five Attacks
// on x402". A paid/gated catalog response must carry Cache-Control: no-store
// so a shared cache/CDN can never serve a paid result to a later UNPAID
// caller of the same URL. Free discovery/static routes must KEEP their public
// caching (they're not gated — caching them is the whole point).
//
// Boots free mode (every catalog route is served, so we can read the header
// the paywall path would emit in prod). Offline, no network.
//
//   node scripts/test-cache-hygiene.js
import { spawn } from "node:child_process";

const PORT = 3091;
const B = `http://127.0.0.1:${PORT}`;
const proc = spawn("node", ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT),
    AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" },
  stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const cc = (r) => (r.headers.get("cache-control") || "").toLowerCase();

try {
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(400); }

  // --- GATED catalog routes MUST be no-store -------------------------------------
  // A GET catalog tool (pure-CPU, works offline) — the URL-cacheable shape
  // that Attack III exploits.
  const conv = await fetch(`${B}/api/uuid`);
  ok(conv.status === 200, `GET catalog tool serves (got ${conv.status})`);
  ok(cc(conv).includes("no-store"), `GET paid tool carries no-store (got "${cc(conv)}")`);

  // A POST catalog tool.
  const hash = await fetch(`${B}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  ok(hash.status === 200 && cc(hash).includes("no-store"), `POST paid tool carries no-store (got "${cc(hash)}")`);

  // `private` belt-and-suspenders present too.
  ok(cc(conv).includes("private"), `paid response also marked private (got "${cc(conv)}")`);

  // --- FREE discovery/static routes MUST STAY publicly cacheable -----------------
  const llms = await fetch(`${B}/llms.txt`);
  ok(cc(llms).includes("public") && !cc(llms).includes("no-store"), `/llms.txt keeps public caching (got "${cc(llms)}")`);

  const pricing = await fetch(`${B}/api/pricing`);
  ok(!cc(pricing).includes("no-store"), `/api/pricing not marked no-store (free discovery) (got "${cc(pricing)}")`);

  const find = await fetch(`${B}/api/find?q=hash`);
  ok(find.status === 200 && !cc(find).includes("no-store"), `/api/find stays cacheable discovery (got "${cc(find)}")`);
} catch (e) {
  ok(false, `threw: ${e.message}`);
} finally {
  proc.kill("SIGKILL");
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
