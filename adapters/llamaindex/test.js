// Smoke test for agent402-llamaindex. Expects a FREE_MODE server reachable at
// AGENT402_BASE_URL (defaults to http://localhost:3000). Self-installs
// agent402-client and llamaindex if they're not in node_modules.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(HERE, "node_modules", "agent402-client"))) {
  execSync("npm install ../../client --no-save --silent", { cwd: HERE, stdio: "inherit" });
}
if (!existsSync(join(HERE, "node_modules", "llamaindex"))) {
  execSync("npm install llamaindex --no-save --silent", { cwd: HERE, stdio: "inherit" });
}

const { agent402Tools, agent402Execute } = await import("./index.js");
const BASE = process.env.AGENT402_BASE_URL || "http://localhost:3000";

async function main() {
  const { tools, execute } = await agent402Tools({ baseUrl: BASE, slugs: ["hash"] });
  if (!Array.isArray(tools)) throw new Error("tools should be an array");
  if (!tools.length) throw new Error("expected at least one tool (hash)");

  // LlamaIndex tools expose metadata via .metadata (FunctionTool) or directly.
  const findName = (t) => t.metadata?.name || t.name;
  const hashTool = tools.find((t) => findName(t) === "hash");
  if (!hashTool) throw new Error("expected the 'hash' tool to be present");

  const meta = hashTool.metadata || hashTool;
  if (typeof meta.name !== "string") throw new Error("name must be string");
  if (typeof meta.description !== "string") throw new Error("description must be string");
  if (!meta.parameters || meta.parameters.type !== "object") throw new Error("parameters must be a JSON object schema");

  // Drive the tool's call() — both FunctionTool and the newer tool() helper
  // expose it. The result is the raw object returned from agent402-client.
  const callable = hashTool.call || hashTool.invoke;
  if (typeof callable !== "function") throw new Error("tool must expose call() or invoke()");
  const out = await callable.call(hashTool, { text: "hello world", algo: "sha256" });
  if (!out || typeof out !== "object") throw new Error("expected an object from tool.call");
  if (!out.hex && !out.digest && !out.hash) throw new Error(`expected a hash field in: ${JSON.stringify(out)}`);

  // Standalone executor agrees.
  const exec = agent402Execute({ baseUrl: BASE });
  const out2 = await exec("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out2)) throw new Error("standalone executor disagreed with bundled one");

  // Bundled execute() helper agrees.
  const out3 = await execute("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out3)) throw new Error("bundled execute() disagreed with tool.call");

  console.log(`PASS — agent402-llamaindex: ${tools.length} tool(s) generated, call() returned a real result.`);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
