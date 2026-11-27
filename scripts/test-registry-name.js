// The MCP Registry name is the domain's own (the reverse DNS of the site,
// granted by the proof the site serves), and every place that publishes,
// prints or derives it agrees: the two manifests the registry compares, the
// module constant, the connector's server card, the discovery document, the
// publish job and the docs. One npm version carries one registry name, so the
// manifests' versions agree too.
//
// The earlier name (the repository account's namespace) stays resolvable on
// the registry and is marked deprecated there. In this tree it is written
// only where it must be: the job that marks it moved, an outside badge keyed
// on it, and the release history. Anywhere else it is a stale pointer.
//
//   node scripts/test-registry-name.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { expandedDeployWorkflow } from "./lib/ci-workflow.js";
import { MCP_REGISTRY_NAME, MCP_REGISTRY_NAMESPACE, MCP_REGISTRY_ENTRY_URL, MCP_REGISTRY_SEARCH_URL } from "../src/org-profiles.js";
import { REPO_NAMESPACE } from "../src/repo-link.js";
import { OFFICIAL_SITE } from "../src/official-surfaces.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(ROOT + p, "utf8");
const json = (p) => JSON.parse(read(p));

// --- one name -------------------------------------------------------------------
const pkg = json("mcp/package.json"), srv = json("mcp/server.json"), lock = json("mcp/package-lock.json");
const NAME = "tools.agent402/agent402";
ok(srv.name === NAME && pkg.mcpName === NAME, `mcp/server.json and mcp/package.json publish ${NAME} (${srv.name}, ${pkg.mcpName})`);
ok(MCP_REGISTRY_NAME === NAME && MCP_REGISTRY_NAME === `${MCP_REGISTRY_NAMESPACE}/agent402`, `the module constant is the same name (${MCP_REGISTRY_NAME})`);
ok(MCP_REGISTRY_NAMESPACE === new URL(OFFICIAL_SITE).hostname.split(".").reverse().join("."), `the namespace is the reverse DNS of the site that serves its proof (${MCP_REGISTRY_NAMESPACE})`);
ok(decodeURIComponent(MCP_REGISTRY_ENTRY_URL).includes(`/servers/${NAME}/versions/latest`) && MCP_REGISTRY_SEARCH_URL.endsWith(`?search=${NAME}`), "the entry and search links read that name");
{
  // The repository account can change (AGENT402_REPO_URL); the domain's name does not follow it.
  process.env.AGENT402_REPO_URL = "https://github.com/some-org/Agent402";
  const repo = await import(`../src/repo-link.js?moved=${Date.now()}`);
  ok(repo.REPO_NAMESPACE === "io.github.some-org" && !NAME.startsWith("io.github."), "control: the repository namespace follows an override, and the registry name is not in it");
  delete process.env.AGENT402_REPO_URL;
}

// --- one version ----------------------------------------------------------------
const v = pkg.version;
ok(/^\d+\.\d+\.\d+$/.test(v) && srv.version === v && srv.packages.length === 1 && srv.packages[0].version === v && srv.packages[0].identifier === pkg.name, `server.json's two version fields name the package version (${v}; ${srv.version}, ${srv.packages[0]?.version})`);
ok(lock.version === v && lock.packages?.[""]?.version === v, `mcp/package-lock.json names it too (${lock.version})`);
ok(srv.remotes?.[0]?.url === `${OFFICIAL_SITE}/mcp` && new URL(srv.websiteUrl).hostname === new URL(OFFICIAL_SITE).hostname, "the listed remote is on the domain the name is verified against");

// --- the served surfaces --------------------------------------------------------
{
  const { mcpServerCard } = await import("../src/mcp-http.js");
  const card = mcpServerCard({ baseUrl: OFFICIAL_SITE, toolCount: 1, mpp: false });
  ok(card.name === NAME, `the connector's server card is named ${NAME} (${card.name})`);
  const discovery = read("src/discovery.js");
  ok(/registry: MCP_REGISTRY_SEARCH_URL,/.test(discovery) && !/REPO_NAMESPACE/.test(discovery), "the discovery document's registry link is the shared search link");
  const official = json("src/generated/official-packages.json");
  ok(official.mcpRegistryName === NAME, `the official list carries it (${official.mcpRegistryName}; node scripts/gen-official-surfaces.js --write)`);
}

// --- the publish job ------------------------------------------------------------
const EARLIER = `${REPO_NAMESPACE}/agent402`;
{
  const wf = load(expandedDeployWorkflow());
  const runs = ["publish-registry", "registry-earlier-name"].flatMap((n) => wf.jobs?.[n]?.steps || []).map((s) => String(s.run || ""));
  const named = runs.flatMap((r) => [...r.matchAll(/^\s*SERVER_NAME=(\S+)$/gm)].map((m) => m[1])).filter((n) => !n.startsWith("$("));
  ok(named.length >= 1 && named.every((n) => n === NAME), `every literal SERVER_NAME in the registry jobs is ${NAME} (${named.join(", ")})`);
  const earlier = runs.flatMap((r) => [...r.matchAll(/^\s*EARLIER_NAME=(\S+)$/gm)].map((m) => m[1]));
  ok(earlier.length === 2 && earlier.every((n) => n === EARLIER), `the earlier name in the job is the repository account's (${earlier.join(", ")})`);
  ok(runs.some((r) => /--message "\$MOVED"/.test(r) && /MOVED="Moved to \$SERVER_NAME"/.test(r)), `the earlier name's message is "Moved to ${NAME}"`);
}

// --- the docs -------------------------------------------------------------------
for (const p of ["wiki/MCP-Connector.md", "mcp/README.md"]) {
  const s = read(p);
  ok(s.includes(`\`${NAME}\``) && s.includes(`?search=${NAME}`) && /earlier name stays resolvable[^.]*deprecated/.test(s), `${p} names ${NAME} and says the earlier name stays resolvable, deprecated`);
}
ok(read("README.md").includes(`servers/${encodeURIComponent(NAME)}/versions/latest`) && read("README.md").includes(`?search=${NAME}`), "README.md's registry badge and links read the name");

// --- the earlier name, only where it is listed ----------------------------------
{
  // Every spelling a link can carry: plain, and the slash percent-encoded once or twice.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [ns, leaf] = EARLIER.split("/");
  const SPELLING = new RegExp(`${esc(ns)}(?:/|%2F|%252F)${esc(leaf)}(?![\\w-])`, "i");
  ok(SPELLING.test(EARLIER) && SPELLING.test(`${ns}%2Fagent402/versions`) && SPELLING.test(`${ns.toLowerCase()}%252Fagent402`) && !SPELLING.test(`${ns}/agent402-x`) && !SPELLING.test(NAME), "control: the scan matches each spelling of the earlier name, and neither a longer name nor the new one");
  // path -> which lines may hold it, and why.
  const ALLOWED = new Map([
    [".github/workflows/deploy.yml", { line: /^\s*EARLIER_NAME=\S+$/, max: 2, why: "the job that marks it moved" }],
    ["README.md", { line: /^\[!\[[^\]]*\]\(https:\/\/[^)]*\/badge\/[^)]*\)\]\(https:\/\/[^)]*\)$/, max: 1, why: "an outside badge keyed on it (Independent records)" }],
    ["CHANGELOG.md", { line: /./, max: Infinity, why: "release history" }],
    ["src/changelog.js", { line: /./, max: Infinity, why: "release history" }],
  ]);
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter((f) => f && !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|mp3|mp4|wav|zip|gz|wasm|bin)$/i.test(f) && !/(^|\/)package-lock\.json$/.test(f));
  const stray = [];
  const counts = new Map();
  for (const f of files) {
    let s; try { s = readFileSync(ROOT + f, "utf8"); } catch { continue; }
    if (!SPELLING.test(s)) continue;
    const rule = ALLOWED.get(f);
    s.split("\n").forEach((l, i) => {
      if (!SPELLING.test(l)) return;
      if (!rule || !rule.line.test(l)) { stray.push(`${f}:${i + 1}`); return; }
      counts.set(f, (counts.get(f) || 0) + 1);
    });
  }
  ok(files.length > 500, `the scan read the tracked tree (${files.length} files)`);
  ok(stray.length === 0, `the earlier registry name is written only on a listed line${stray.length ? `; elsewhere: ${stray.slice(0, 8).join(", ")}` : ""}`);
  for (const [f, rule] of ALLOWED) ok((counts.get(f) || 0) <= rule.max, `${f}: at most ${rule.max} line(s) hold it, ${rule.why} (${counts.get(f) || 0})`);
  ok((counts.get(".github/workflows/deploy.yml") || 0) === 2 && (counts.get("README.md") || 0) === 1, "control: the scan finds the listed lines it expects (the job's two, the badge's one)");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
