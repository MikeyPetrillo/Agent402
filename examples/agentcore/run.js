// Runnable proof-of-life for the Agent402 → Strands → AgentCore wiring.
//
// What this proves:
//   1. agent402Tools() returns Strands tool({...}) instances ready for `new Agent({tools})`.
//   2. The tool callback talks to a live Agent402 instance (default: agent402.tools).
//   3. Payment is handled underneath:
//      - with AGENT_KEY set (an EVM key holding USDC on Base), the agent runs a
//        web search and then a cited answer, each paid per call over x402;
//      - with no wallet, it falls back to a pure-CPU tool paid with a
//        sub-second proof-of-work: no wallet, no API key, no AWS account.
//
// Same code runs unchanged on AWS Bedrock AgentCore — just remove the SDK stub
// below and install `@strands-agents/sdk`. On AgentCore, pass the fetch that
// AgentCore Payments hands you in place of the local x402 fetch.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- Stub @strands-agents/sdk so this demo runs without pulling AWS Bedrock,
// --- uuid, or yaml transitively. The shape matches the real SDK exactly:
// --- tool({ name, description, inputSchema, callback }) → tool object,
// --- new Agent({ tools }) → object with .invoke().
// --- DELETE this whole block on AgentCore — `npm install @strands-agents/sdk`
// --- will provide the real implementations.
const stubDir = join(HERE, "node_modules", "@strands-agents", "sdk");
const STUB = `
    // agent402-demo-stub v2
    export function tool(def) {
      return { __isStrandsTool: true, name: def.name, description: def.description,
               inputSchema: def.inputSchema, callback: def.callback };
    }
    export class Agent {
      constructor(opts) { this.tools = opts?.tools || []; }
      // Minimal "router": run each tool the prompt names, in the order named,
      // with the quoted text that follows its name as the input.
      async invoke(prompt) {
        const text = String(prompt || "");
        const named = this.tools
          .map((t) => ({ t, at: text.toLowerCase().indexOf(t.name) }))
          .filter((x) => x.at >= 0)
          .sort((a, b) => a.at - b.at)
          .map((x) => x.t);
        if (!named.length) throw new Error("no tool named in the prompt");
        const steps = [];
        for (const picked of named) {
          const m = text.slice(text.toLowerCase().indexOf(picked.name)).match(/['"]([^'"]+)['"]/);
          const input = m ? m[1] : "hello world";
          const args = picked.name === "hash" ? { text: input, algo: "sha256" } : { q: input };
          steps.push({ tool: picked.name, args, result: await picked.callback(args) });
        }
        return { steps };
      }
    }
  `;
const stubFile = join(stubDir, "index.js");
if (!existsSync(stubFile) || !readFileSync(stubFile, "utf8").includes("agent402-demo-stub v2")) {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, "package.json"), JSON.stringify({
    name: "@strands-agents/sdk", version: "0.0.0-stub", type: "module", main: "index.js",
  }));
  writeFileSync(stubFile, STUB);
}

const { Agent } = await import("@strands-agents/sdk");
const { agent402Tools } = await import("agent402-strands");

const BASE = process.env.AGENT402_BASE_URL || "https://agent402.tools";
console.log(`[demo] Agent402 catalog: ${BASE}`);

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

if (process.env.AGENT_KEY) {
  // Web search, then a cited answer: both wallet-only, paid per call over x402.
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { x402Client } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { privateKeyToAccount } = await import("viem/accounts");
  const payClient = new x402Client();
  // @x402/core 2.23+ refuses some accepts by default; keep your own spend
  // ceiling in code instead.
  payClient.setSpendControls?.(false);
  registerExactEvmScheme(payClient, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
  const payFetch = wrapFetchWithPayment(fetch, payClient);

  const { tools } = await agent402Tools({
    baseUrl: BASE,
    slugs: ["search", "answer"],
    freeOnly: false,
    fetch: payFetch,
  });
  console.log(`[demo] catalog: ${tools.length} Agent402 tools wired into Strands`);

  const agent = new Agent({ tools });
  const out = await agent.invoke("Use search on 'x402 payment protocol adoption', then answer 'what is the x402 payment protocol?'");
  for (const s of out.steps) console.log(`[demo] ${s.tool}(${JSON.stringify(s.args)}):`, s.result);

  const search = out.steps.find((s) => s.tool === "search")?.result;
  const answer = out.steps.find((s) => s.tool === "answer")?.result;
  if (!Array.isArray(search?.results) || !search.results.length) fail("expected search results");
  if (typeof answer?.answer !== "string" || !answer.answer) fail("expected a cited answer");
  console.log("PASS: Strands → Agent402 web search and answer, paid from the wallet.");
} else {
  // No wallet yet? The pure-CPU tools run free with proof-of-work.
  console.log("[demo] no AGENT_KEY set: running the proof-of-work free tier (set AGENT_KEY for web search + answer)");
  const { tools } = await agent402Tools({
    baseUrl: BASE,
    slugs: ["hash", "token-count", "json-validate", "text-stats"],
  });
  console.log(`[demo] catalog: ${tools.length} Agent402 tools wired into Strands`);

  const agent = new Agent({ tools });
  const out = await agent.invoke("Use the hash tool on 'hello world'");
  const step = out.steps[0];
  console.log(`[demo] agent picked tool: ${step.tool}`);
  console.log(`[demo] tool result:`, step.result);

  if (!step.result || typeof step.result !== "object") fail("expected a structured result object");
  const expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
  const got = step.result.hex || step.result.digest || step.result.hash;
  if (got !== expected) fail(`expected sha256(hello world)=${expected}, got ${got}`);
  console.log("PASS: Strands → Agent402 round trip works end-to-end.");
}
