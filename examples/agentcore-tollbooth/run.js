// Reverse flow: a Strands agent (the kind you'd deploy on AWS Bedrock
// AgentCore) PAYING a tollbooth-gated endpoint over x402.
//
// This closes the loop on the agents-pay-agents story:
//   - examples/agentcore/        Strands agent BUYING from Agent402
//   - examples/agentcore-tollbooth/ (this) Strands agent SELLING-side payer
//                                  hitting a self-hostable tollbooth gate
//
// We boot a tiny "premium content" Express app behind agent402-tollbooth on
// localhost, then a Strands tool fetches /article. The gate replies 402; the
// adapter solves the proof-of-work; the agent gets the body and returns it
// as the tool result.
//
// On AgentCore: replace the `solvePow()` step with AgentCore Payments signing
// an x402 USDC transaction using a PaymentCredentialProvider in Identity. The
// flow at the tool boundary is identical — only the payment scheme changes.

import express from "express";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTollbooth } from "agent402-tollbooth";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- Stub @strands-agents/sdk so the demo runs without AWS deps.
// --- Delete on AgentCore — `npm install @strands-agents/sdk` provides the real SDK.
const stubDir = join(HERE, "node_modules", "@strands-agents", "sdk");
if (!existsSync(join(stubDir, "package.json"))) {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, "package.json"), JSON.stringify({
    name: "@strands-agents/sdk", version: "0.0.0-stub", type: "module", main: "index.js",
  }));
  writeFileSync(join(stubDir, "index.js"), `
    export function tool(def) { return { __isStrandsTool: true, ...def }; }
    export class Agent {
      constructor(opts) { this.tools = opts?.tools || []; }
      async invoke(prompt) {
        const t = this.tools[0]; if (!t) throw new Error("no tools");
        return { tool: t.name, result: await t.callback({ url: prompt }) };
      }
    }
  `);
}

const { Agent, tool } = await import("@strands-agents/sdk");

// 1) Boot a "premium content" site behind agent402-tollbooth (the sell side).
//    Humans browse free; AI agents (this Strands agent) must pay per request.
const app = express();
app.use(createTollbooth({
  price: "$0.002",
  payTo: "0x0000000000000000000000000000000000000000",  // demo only
  powDifficulty: 14,                                     // sub-second on a laptop
  // For the demo we whitelist a fake AgentCore UA so the gate charges *us*
  // and not just the canonical AI-crawler list. In production you'd leave
  // this off and let the default AI_BOTS list do the matching.
  botUserAgents: ["AgentCoreBot"],
}));
app.use((req, res) => res.json({ url: req.path, body: "premium content for paying clients only." }));
const server = app.listen(0);
const PORT = server.address().port;
const SITE = `http://localhost:${PORT}`;
console.log(`[demo] tollbooth-gated site:  ${SITE}`);

// 2) Build a Strands tool that fetches a URL. If the response is 402, solve
//    the proof-of-work the tollbooth advertises and retry. On AgentCore, the
//    402-handling lives inside AgentCore Payments instead of in your tool.
const lz = (buf) => { let b = 0; for (const x of buf) { if (x === 0) { b += 8; continue; } b += Math.clz32(x) - 24; break; } return b; };
function solvePow(c) {
  let nonce = 0;
  while (lz(createHash("sha256").update(`${c.challenge}:${nonce}`).digest()) < c.difficulty) nonce++;
  return `${c.token}:${nonce}`;
}
const AGENT_UA = "Mozilla/5.0 (compatible; AgentCoreBot/1.0; +x402)";

const fetchPaid = tool({
  name: "fetch_paid",
  description: "Fetch a URL that may be tollbooth-gated. Pays automatically via x402 or proof-of-work.",
  inputSchema: { url: "string" },
  callback: async ({ url }) => {
    let res = await fetch(url, { headers: { "user-agent": AGENT_UA } });
    if (res.status !== 402) return await res.json();
    const quote = await res.json();
    const sol = solvePow(quote.proofOfWork);
    res = await fetch(url, { headers: { "user-agent": AGENT_UA, "x-pow-solution": sol } });
    if (!res.ok) throw new Error(`paid fetch failed: ${res.status}`);
    return { paidVia: res.headers.get("x-tollbooth-paid"), ...(await res.json()) };
  },
});

// 3) The agent uses the tool. End to end: agent → tollbooth → 402 → PoW → 200.
const agent = new Agent({ tools: [fetchPaid] });
try {
  const out = await agent.invoke(`${SITE}/article`);
  console.log(`[demo] agent invoked tool: ${out.tool}`);
  console.log(`[demo] tool result:`, out.result);

  if (!out.result || out.result.body !== "premium content for paying clients only.") {
    console.error("FAIL — expected premium content body");
    process.exit(1);
  }
  if (out.result.paidVia !== "pow") {
    console.error(`FAIL — expected paidVia=pow, got ${out.result.paidVia}`);
    process.exit(1);
  }
  console.log("PASS — Strands agent paid the tollbooth over x402-style PoW and got the gated content.");
} finally {
  server.close();
}
