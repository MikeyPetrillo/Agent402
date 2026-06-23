// Runnable proof-of-life for the Agent402 Vercel AI SDK adapter.
//
// What this proves:
//   1. agent402ToolSpecs() returns framework-agnostic tool specs with execute().
//   2. The agent402_call spec talks to a live Agent402 instance (default: agent402.tools).
//   3. Payment is handled underneath — sub-second proof-of-work for free tools,
//      no wallet, no API key required to run this file.
//
// Same specs wire into the real AI SDK via agent402Tools() — just install `ai`
// and `zod` as peer dependencies. See "Using with the real AI SDK" in README.md.

import { agent402ToolSpecs } from "agent402-ai-sdk";

const BASE = process.env.AGENT402_BASE_URL || "https://agent402.tools";
console.log(`[demo] Agent402 base: ${BASE}`);

const specs = agent402ToolSpecs({ baseUrl: BASE });
console.log(`[demo] ${specs.length} meta-tools loaded: ${specs.map((s) => s.name).join(", ")}`);

const callSpec = specs.find((s) => s.name === "agent402_call");
if (!callSpec) {
  console.error("FAIL — agent402_call spec not found");
  process.exit(1);
}

console.log("[demo] calling hash tool via agent402_call...");
const result = await callSpec.execute({
  slug: "hash",
  params: { text: "hello world", algo: "sha256" },
});
console.log("[demo] result:", result);

const expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
const got = result.hex || result.digest || result.hash;
if (got !== expected) {
  console.error(`FAIL — expected sha256(hello world)=${expected}, got ${got}`);
  process.exit(1);
}
console.log("PASS — AI SDK adapter round trip works end-to-end.");
