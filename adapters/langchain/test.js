// Smoke test for agent402-langchain. Expects a FREE_MODE server reachable at
// AGENT402_BASE_URL (defaults to http://localhost:3000). Self-installs
// agent402-client, @langchain/core, and zod if they're not in node_modules.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(HERE, "node_modules", "agent402-client"))) {
  execSync("npm install ../../client --no-save --silent", { cwd: HERE, stdio: "inherit" });
}
if (!existsSync(join(HERE, "node_modules", "@langchain", "core"))) {
  execSync("npm install @langchain/core zod --no-save --silent", { cwd: HERE, stdio: "inherit" });
}

const { agent402Tools, agent402Execute } = await import("./index.js");
const BASE = process.env.AGENT402_BASE_URL || "http://localhost:3000";

async function main() {
  const { tools, execute } = await agent402Tools({ baseUrl: BASE, slugs: ["hash"] });
  if (!Array.isArray(tools)) throw new Error("tools should be an array");
  if (!tools.length) throw new Error("expected at least one tool (hash)");

  const hashTool = tools.find((t) => t.name === "hash");
  if (!hashTool) throw new Error("expected the 'hash' tool to be present");
  if (typeof hashTool.name !== "string") throw new Error("name must be string");
  if (typeof hashTool.description !== "string") throw new Error("description must be string");
  if (!hashTool.schema) throw new Error("schema must be a Zod schema");
  if (typeof hashTool.invoke !== "function") throw new Error("tool must expose invoke()");

  // .invoke() round-trip: LangChain returns the func()'s string output.
  const raw = await hashTool.invoke({ text: "hello world", algo: "sha256" });
  if (typeof raw !== "string") throw new Error("LangChain tool.invoke should return a string");
  const out = JSON.parse(raw);
  if (!out || typeof out !== "object") throw new Error("expected an object from tool.invoke");
  if (!out.hex && !out.digest && !out.hash) throw new Error(`expected a hash field in: ${JSON.stringify(out)}`);

  // Standalone executor agrees.
  const exec = agent402Execute({ baseUrl: BASE });
  const out2 = await exec("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out2)) throw new Error("standalone executor disagreed with bundled one");

  // Bundled execute() helper agrees.
  const out3 = await execute("hash", { text: "hello world", algo: "sha256" });
  if (JSON.stringify(out) !== JSON.stringify(out3)) throw new Error("bundled execute() disagreed with tool.invoke");

  console.log(`PASS — agent402-langchain: ${tools.length} tool(s) generated, invoke() returned a real result.`);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
