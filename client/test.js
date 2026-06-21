// agent402-client tested against a server with the x402 paywall ACTIVE, so the
// client really exercises the proof-of-work auto-payment path. The facilitator
// is never contacted (X402_SYNC_ON_START=false); PoW bypasses settlement.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent402 } from "./index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3081;
const proc = spawn("node", ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: "https://facilitator.payai.network", X402_SYNC_ON_START: "false",
    POW_DIFFICULTY: "12", PORT: String(PORT), FREE_MODE: "" },
  stdio: "ignore",
});
const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
let pass = 0; const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/api/pow`)).ok) break; } catch {} await sleep(500); }
  const a = new Agent402({ baseUrl: `http://localhost:${PORT}` });

  // 1. find() resolves a task to the right tool.
  const matches = await a.find("hash text with sha256");
  ok(matches.some((m) => m.slug === "hash"), `find() returns the hash tool (got ${matches.map((m) => m.slug).slice(0, 3).join(",")})`);

  // 2. call() auto-solves the proof-of-work on a paywalled free tool.
  const out = await a.call("hash", { text: "hello world", algo: "sha256" });
  ok(out.hex && out.hex.slice(0, 8) === "b94d27b9", `call() auto-pays via PoW and returns the result (got ${out.hex?.slice(0, 8)})`);

  // 3. second identical call is served from cache (same reference, no re-solve).
  const out2 = await a.call("hash", { text: "hello world", algo: "sha256" });
  ok(out2 === out, "identical call is served from cache");

  // 4. cache can be bypassed.
  const out3 = await a.call("hash", { text: "hello world", algo: "sha256" }, { cache: false });
  ok(out3 !== out && out3.hex === out.hex, "cache:false re-fetches but returns the same value");

  // 5. solvePow() produces a valid nonce for a difficulty.
  const sol = Agent402.solvePow({ challenge: "abc", difficulty: 8, token: "t" });
  const nonce = sol.split(":").pop();
  const lz = (b) => { let n = 0; for (const x of b) { if (!x) { n += 8; continue; } n += Math.clz32(x) - 24; break; } return n; };
  ok(lz(createHash("sha256").update(`abc:${nonce}`).digest()) >= 8, "solvePow finds a nonce meeting the difficulty");

  // 6. unknown slug is a clear error.
  let threw = false; try { await a.call("definitely-not-a-tool", {}); } catch { threw = true; }
  ok(threw, "unknown slug throws");

  // 7. findWorkflows() surfaces multi-tool skill packs for task-shaped queries.
  const packs = await a.findWorkflows("security audit");
  ok(packs.some((p) => p.slug === "security-audit"), `findWorkflows("security audit") returns the security-audit pack (got ${packs.map((p) => p.slug).slice(0, 3).join(",")})`);

  // 8. getWorkflowPrompt() returns rendered messages with args substituted in.
  const rendered = await a.getWorkflowPrompt("security-audit", { domain: "stripe.com" });
  const promptText = rendered.messages?.[0]?.content?.text ?? "";
  ok(promptText.includes("stripe.com") && !promptText.includes("{{domain}}"), "getWorkflowPrompt substitutes args into the rendered prompt");

  // 9. topSellers() proxies /api/leaderboard with the right envelope. CI runs
  // before the first chain scan finishes, so results may be empty — but the
  // envelope shape and sort/include echo must be correct regardless.
  const sellers = await a.topSellers({ limit: 5, sort: "calls", include: "all" });
  ok(sellers.sort === "calls" && sellers.include === "all", `topSellers echoes sort+include (got sort=${sellers.sort}, include=${sellers.include})`);
  ok(Array.isArray(sellers.results) && sellers.results.length <= 5, `topSellers honors limit (got ${sellers.results?.length} rows)`);
  ok(typeof sellers.source === "string" && sellers.source.endsWith("/api/leaderboard"), "topSellers links to /api/leaderboard");

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
