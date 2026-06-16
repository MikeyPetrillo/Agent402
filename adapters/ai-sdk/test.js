// Smoke test for agent402-ai-sdk. Expects a FREE_MODE server reachable at
// AGENT402_BASE_URL (defaults to http://localhost:3000). Self-installs both
// agent402-client and ai (the Vercel AI SDK) if they're not in node_modules.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(HERE, "node_modules", "agent402-client"))) {
  execSync("npm install ../../client --no-save --silent", { cwd: HERE, stdio: "inherit" });
}
if (!existsSync(join(HERE, "node_modules", "ai"))) {
  // Pinned to a known-good major so a future malicious release of `ai`
  // can't land here unreviewed on the next CI run.
  execSync("npm install ai@^6 --no-save --silent", { cwd: HERE, stdio: "inherit" });
}

const { agent402Tools, agent402Execute } = await import("./index.js");
const BASE = process.env.AGENT402_BASE_URL || "http://localhost:3000";

async function main() {
  const { tools, execute } = await agent402Tools({ baseUrl: BASE, slugs: ["hash"] });
  if (!tools || typeof tools !== "object") throw new Error("tools should be an object record");
  const keys = Object.keys(tools);
  if (!keys.length) throw new Error("expected at least one tool (hash)");

  const hashTool = tools["hash"];
  if (!hashTool) throw new Error("expected the 'hash' tool to be present");
  if (typeof hashTool.execute !== "function") throw new Error("tool must expose execute()");
  if (!hashTool.description) throw new Error("tool must have a description");
  if (!hashTool.parameters) throw new Error("tool must have parameters (jsonSchema wrapper)");

  // The wrapped JSON schema retains the original under `.jsonSchema`.
  const json = hashTool.parameters?.jsonSchema || hashTool.parameters;
  if (!json || json.type !== "object") throw new Error("parameters must be a JSON object schema");

  // Drive the tool's execute() directly — confirms the underlying client.call() resolves.
  const out = await hashTool.execute({ text: "hello world", algo: "sha256" }, { toolCallId: "t1", messages: [] });
  if (!out || typeof out !== "object") throw new Error("expected an object from tool.execute");
  if (!out.hex && !out.digest && !out.hash) throw new Error(`expected a hash field in: ${JSON.stringify(out)}`);

  // Standalone executor agrees.
  const exec = agent402Execute({ baseUrl: BASE });
  const out2 = await exec("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out2)) throw new Error("standalone executor disagreed with bundled one");

  // And the bundled execute() helper agrees.
  const out3 = await execute("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out3)) throw new Error("bundled execute() disagreed with tool.execute");

  console.log(`PASS — agent402-ai-sdk: ${keys.length} tool(s) generated, execute() returned a real result.`);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
