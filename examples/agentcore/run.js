// Runnable proof-of-life for the Agent402 → Strands → AgentCore wiring.
//
// What this proves:
//   1. agent402Tools() returns Strands tool({...}) instances ready for `new Agent({tools})`.
//   2. The tool callback talks to a live Agent402 instance (default: agent402.tools).
//   3. Payment is handled underneath — sub-second proof-of-work for free tools,
//      no wallet, no API key, no AWS account required to run this file.
//
// Same code runs unchanged on AWS Bedrock AgentCore — just remove the SDK stub
// below and install `@strands-agents/sdk`. AgentCore Identity supplies the CDP
// credentials for wallet-only tools.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
if (!existsSync(join(stubDir, "package.json"))) {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, "package.json"), JSON.stringify({
    name: "@strands-agents/sdk", version: "0.0.0-stub", type: "module", main: "index.js",
  }));
  writeFileSync(join(stubDir, "index.js"), `
    export function tool(def) {
      return { __isStrandsTool: true, name: def.name, description: def.description,
               inputSchema: def.inputSchema, callback: def.callback };
    }
    export class Agent {
      constructor(opts) { this.tools = opts?.tools || []; }
      // Minimal "router" — for the demo, pick the tool the prompt mentions.
      async invoke(prompt) {
        const text = String(prompt || "").toLowerCase();
        const picked = this.tools.find((t) => text.includes(t.name)) || this.tools[0];
        if (!picked) throw new Error("no tools");
        const m = text.match(/hash\\s+['"]([^'"]+)['"]/);
        const args = picked.name === "hash"
          ? { text: m ? m[1] : "hello world", algo: "sha256" }
          : {};
        const result = await picked.callback(args);
        return { tool: picked.name, args, result };
      }
    }
  `);
}

const { Agent } = await import("@strands-agents/sdk");
const { agent402Tools } = await import("agent402-strands");

const BASE = process.env.AGENT402_BASE_URL || "https://agent402.tools";
console.log(`[demo] Agent402 catalog: ${BASE}`);

const { tools } = await agent402Tools({
  baseUrl: BASE,
  slugs: ["hash", "token-count", "json-validate", "text-stats"],
});
console.log(`[demo] catalog: ${tools.length} Agent402 tools wired into Strands`);

const agent = new Agent({ tools });
const out = await agent.invoke("Use the hash tool on 'hello world'");
console.log(`[demo] agent picked tool: ${out.tool}`);
console.log(`[demo] tool result:`, out.result);

if (!out.result || typeof out.result !== "object") {
  console.error("FAIL — expected a structured result object");
  process.exit(1);
}
const expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
const got = out.result.hex || out.result.digest || out.result.hash;
if (got !== expected) {
  console.error(`FAIL — expected sha256(hello world)=${expected}, got ${got}`);
  process.exit(1);
}
console.log("PASS — Strands → Agent402 round trip works end-to-end.");
