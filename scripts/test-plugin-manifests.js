#!/usr/bin/env node
// The plugin manifests registries read (.codex-plugin, .cursor-plugin) carry
// the SERVER's release version, the one the repository's release tags use.
// They carried agent402-mcp's npm version (0.13.4) beside v2.4.0 releases, so
// a registry comparing the listed version with the release history found no
// match. package.json's version is the single source; cut a release by moving
// it, and the manifests must follow in the same commit.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

const root = read("package.json").version;
const lock = read("package-lock.json");
ok(/^\d+\.\d+\.\d+$/.test(root), `package.json carries a release version (${root})`);
ok(lock.version === root && lock.packages?.[""]?.version === root, "package-lock.json agrees with package.json");
for (const p of [".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
  ok(read(p).version === root, `${p} version ${read(p).version} equals the release version ${root}`);
}
// The Claude Code marketplace (.claude-plugin/marketplace.json at the root)
// lists one plugin whose manifest and MCP config live under plugins/agent402.
// Its versions follow the same release version, and every source path it names
// must exist, or `/plugin marketplace add` installs nothing.
const market = read(".claude-plugin/marketplace.json");
ok(market.metadata?.version === root, `.claude-plugin/marketplace.json metadata version equals ${root}`);
for (const entry of market.plugins ?? []) {
  ok(entry.version === root, `marketplace plugin ${entry.name} version equals ${root}`);
  const dir = entry.source.replace(/^\.\//, "");
  ok(read(`${dir}/.claude-plugin/plugin.json`).version === root, `${dir}/.claude-plugin/plugin.json version equals ${root}`);
  ok(read(`${dir}/.mcp.json`).mcpServers?.agent402?.url === "https://agent402.tools/mcp", `${dir}/.mcp.json points at the hosted /mcp connector`);
}
// Every manifest a registry or a coding agent reads leads with the approved
// lead sentence and the supporting line (src/positioning.js), and the skill
// the plugins ship is one real SKILL.md each manifest points at.
{
  const { LEAD_SENTENCE, SUPPORT_LINE } = await import("../src/positioning.js");
  const lead = `${LEAD_SENTENCE} ${SUPPORT_LINE}`;
  const descs = [
    [".claude-plugin/marketplace.json metadata", market.metadata?.description],
    ...(market.plugins ?? []).map((e) => [`.claude-plugin/marketplace.json plugin ${e.name}`, e.description]),
    ...(market.plugins ?? []).map((e) => [`${e.source.replace(/^\.\//, "")}/.claude-plugin/plugin.json`, read(`${e.source.replace(/^\.\//, "")}/.claude-plugin/plugin.json`).description]),
    [".codex-plugin/plugin.json", read(".codex-plugin/plugin.json").description],
    [".cursor-plugin/plugin.json", read(".cursor-plugin/plugin.json").description],
  ];
  for (const [where, d] of descs) ok(typeof d === "string" && d.startsWith(lead), `${where} description leads with the lead sentence and the supporting line`);
  const server = read("mcp/server.json");
  ok(!/\d+\+? (?:agent |ready |web )?tools/i.test(server.title || "") && /^Agent402\.Tools: /.test(server.title || ""), `mcp/server.json title names the product, no tool count ("${server.title}")`);

  const { existsSync, readdirSync } = await import("node:fs");
  const SKILLS = "plugins/agent402/skills";
  const skillDirs = existsSync(new URL(`../${SKILLS}`, import.meta.url)) ? readdirSync(new URL(`../${SKILLS}`, import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  ok(skillDirs.length >= 1, `the Claude Code plugin ships at least one skill under ${SKILLS} (${skillDirs.join(", ") || "none"})`);
  for (const dir of skillDirs) {
    const text = readFileSync(new URL(`../${SKILLS}/${dir}/SKILL.md`, import.meta.url), "utf8");
    const fm = (text.match(/^---\n([\s\S]*?)\n---\n/) || [])[1] || "";
    const name = (fm.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
    const desc = ((fm.match(/^description:\s*(.+)$/m) || [])[1] || "").trim().replace(/^"|"$/g, "");
    ok(name === dir && /^[a-z0-9-]{1,64}$/.test(name), `${SKILLS}/${dir}/SKILL.md names itself "${dir}" in its frontmatter`);
    ok(desc.length > 0 && desc.length <= 1024 && desc.startsWith(LEAD_SENTENCE), `${SKILLS}/${dir}/SKILL.md description leads with the lead sentence, 1024 characters at most (${desc.length})`);
    ok(!/\$\d/.test(text), `${SKILLS}/${dir}/SKILL.md types no price (prices are read from the catalog)`);
    ok(!/\u2014/.test(text), `${SKILLS}/${dir}/SKILL.md carries no em dash`);
  }
  for (const p of [".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
    const s = read(p).skills;
    ok(s === `./${SKILLS}/`, `${p} points its skills at ./${SKILLS}/ (${s})`);
  }
}
// When the checkout has tags, the newest release tag must not be AHEAD of
// package.json (a release cut without moving the version). A shallow CI
// checkout has none; the manifest checks above still hold there.
let tags = [];
try { tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch { /* not a git checkout */ }
if (tags.length) {
  const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  const newest = tags.map((t) => t.slice(1)).filter((t) => /^\d+\.\d+\.\d+$/.test(t)).sort(cmp).pop();
  ok(!newest || cmp(root, newest) >= 0, `package.json ${root} is not behind the newest release tag v${newest}`);
} else {
  console.log("note - no release tags in this checkout; tag comparison not run");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
