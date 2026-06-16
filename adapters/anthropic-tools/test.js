// Smoke test for agent402-anthropic-tools. Runs against a local FREE_MODE Agent402
// server (boot with: FREE_MODE=true PORT=3000 node src/server.js).
import { agent402Tools, agent402Execute } from "./index.js";

const BASE = process.env.AGENT402_BASE_URL || "http://localhost:3000";

async function main() {
  const { tools, execute } = await agent402Tools({ baseUrl: BASE, slugs: ["hash"] });
  if (!Array.isArray(tools)) throw new Error("tools should be an array");
  if (!tools.length) throw new Error("expected at least one tool (hash)");

  const hashTool = tools.find((t) => t.name === "hash");
  if (!hashTool) throw new Error("expected the 'hash' tool to be present");
  if (typeof hashTool.name !== "string") throw new Error("name must be string");
  if (typeof hashTool.description !== "string") throw new Error("description must be string");
  if (!hashTool.input_schema || hashTool.input_schema.type !== "object") {
    throw new Error("input_schema must be a JSON object schema");
  }

  const out = await execute("hash", { text: "hello world", algo: "sha256" });
  if (!out || typeof out !== "object") throw new Error("expected an object from execute");

  const exec = agent402Execute({ baseUrl: BASE });
  const out2 = await exec("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out2)) throw new Error("standalone executor disagreed with bundled one");

  console.log(`PASS — agent402-anthropic-tools: ${tools.length} tool(s) generated, execute() returned a real result.`);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
