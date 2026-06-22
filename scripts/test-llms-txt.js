// /llms.txt is the orientation file an LLM crawler (or an agent doing first-
// touch discovery) reads to learn what this host sells, how to discover it,
// and how to pay. The file is rendered from src/seo.js's llmsTxt() — there is
// no schema, just a long markdown document with a known structure that
// downstream consumers grep for.
//
// This test boots FREE_MODE, fetches /llms.txt, and locks the contract that
// has to hold for an agent to use the file:
//
//   1. Content-type is text/plain (otherwise the agent reads it as HTML and
//      loses the structure).
//   2. The tool-count claim is present and matches the live catalog. The text
//      says "1199 tools" or similar — a regression where the claim drifts
//      from CATALOG (because the count is hard-coded somewhere instead of
//      derived) is exactly the kind of trust-eroding bug an LLM would notice.
//   3. The discovery section pinpoints /api/find, /api/route, /api/index,
//      /api/leaderboard, /openapi.json, /.well-known/x402 — the URLs an
//      agent uses to keep going after reading llms.txt. Silent drop = agent
//      can't proceed.
//   4. The proof-of-work path is mentioned (otherwise free-tier agents won't
//      know they can skip the wallet).
//   5. The MCP path is mentioned (otherwise agents using MCP-only clients
//      can't find the right entrypoint).
//   6. The wallet identity / receiving address (agent402.base.eth) is
//      mentioned — trust-signal a payer reads before sending USDC.
//
//   node scripts/test-llms-txt.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3087;
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

  const res = await fetch(`${BASE}/llms.txt`);
  ok(res.status === 200, `/llms.txt → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("text/plain"), `content-type is text/plain (got ${res.headers.get("content-type")})`);
  const txt = await res.text();
  ok(txt.startsWith("# Agent402"), `body opens with '# Agent402' (got '${txt.slice(0, 30)}…')`);

  // Tool count claim must match the live catalog. We get the live count from
  // /api/pricing (same source-of-truth /openapi.json + capabilities.tools use)
  // and assert llms.txt mentions it. If the text hard-codes 1100 but catalog
  // is 1199, an agent reading llms.txt and deciding "small catalog, not worth
  // calling" would be making a decision on stale data.
  const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
  const liveCount = pricing.endpoints?.length ?? 0;
  ok(liveCount > 0, `live catalog has tools (got ${liveCount})`);
  ok(txt.includes(String(liveCount)), `llms.txt mentions live catalog size '${liveCount}' (drift = trust signal broken)`);

  // Discovery URLs — what an agent reads next.
  for (const path of ["/api/find", "/api/route", "/api/leaderboard", "/openapi.json", "/.well-known/x402", "/api/pricing"]) {
    ok(txt.includes(path), `llms.txt mentions ${path}`);
  }

  // PoW path — free-tier agents need to know this exists.
  ok(/proof[- ]of[- ]work/i.test(txt), "llms.txt mentions proof-of-work (free-tier path)");

  // MCP path — MCP-client agents need to know the connector exists.
  ok(/MCP|mcp/.test(txt), "llms.txt mentions MCP");

  // Trust signal — receiving wallet name. Resolves to the on-chain address an
  // x402 payer settles to; a regression that drops this leaves payers
  // verifying against an unknown address.
  ok(txt.includes("agent402.base.eth"), "llms.txt mentions agent402.base.eth (receiving-wallet trust signal)");

  // Section count sanity — the file currently has multiple `## ` headers. A
  // floor of 3 catches a regression that collapses the structure into a flat
  // wall of text.
  const sectionCount = (txt.match(/^## /gm) || []).length;
  ok(sectionCount >= 3, `llms.txt has >= 3 '##' sections (got ${sectionCount}) — structure must remain navigable`);

  console.log(`\n${pass} passed (${liveCount} tools, ${sectionCount} sections)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
