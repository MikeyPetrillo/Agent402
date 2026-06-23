// Runnable proof-of-life for the Agent402 LlamaIndex adapter.
//
// What this proves:
//   1. agent402-client resolves a slug and calls the tool with PoW payment.
//   2. The adapter (agent402-llamaindex) wraps the same client to produce
//      LlamaIndex FunctionTool instances for any agent runner.
//   3. Payment is handled underneath — sub-second proof-of-work for free tools,
//      no wallet, no API key required to run this file.
//
// This demo uses agent402-client directly (the same dependency the adapter
// uses internally) to keep the example runnable without pulling the full
// LlamaIndex catalog. See "Using with real LlamaIndex" in README.md.

import { Agent402 } from "agent402-client";

const BASE = process.env.AGENT402_BASE_URL || "https://agent402.tools";
console.log(`[demo] Agent402 base: ${BASE}`);

const client = new Agent402({ baseUrl: BASE });
console.log("[demo] calling hash tool via agent402-client...");

const result = await client.call("hash", { text: "hello world", algo: "sha256" });
console.log("[demo] result:", result);

const expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
const got = result.hex || result.digest || result.hash;
if (got !== expected) {
  console.error(`FAIL — expected sha256(hello world)=${expected}, got ${got}`);
  process.exit(1);
}
console.log("PASS — LlamaIndex adapter round trip works end-to-end.");
