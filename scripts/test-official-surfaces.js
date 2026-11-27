#!/usr/bin/env node
// The official packages and endpoints: one list, every surface.
//
//   - the committed list (src/generated/official-packages.json) is exactly the
//     packages the repository publishes: a non-private package.json or a
//     pyproject.toml without an entry fails, and so does an entry whose
//     manifest is gone. Control: a planted package in a copy is reported.
//   - /company shows the list, /security and /docs link to it,
//     /.well-known/x402 carries it as `official`, and README.md holds the
//     section the module renders;
//   - the wording is the first-party sentence, with no hidden character;
//   - /.well-known/mcp-registry-auth serves the MCP Registry proof record as
//     text while MCP_REGISTRY_AUTH_PROOF holds one, and is the ordinary 404
//     when it is unset or is not a proof record (never echoed).
//
//   node scripts/test-official-surfaces.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { bootServer } from "./lib/boot-server.js";
import { buildList, readList, diffLists, scanPackages, withReadmeSection, README, README_START, README_END } from "./gen-official-surfaces.js";
import { OFFICIAL_SENTENCE, OFFICIAL_SITE, OFFICIAL_CONNECTOR, OFFICIAL_PAGE_PATH, OFFICIAL_DATA_PATH, officialPackages, officialSurfacesDocument, officialSurfacesMarkdown, officialSurfacesRows } from "../src/official-surfaces.js";
import { MCP_REGISTRY_AUTH_PATH, MCP_REGISTRY_AUTH_MAX_BYTES, registryAuthProof } from "../src/mcp-registry-auth.js";
import { hiddenCharacters } from "../src/hidden-chars.js";
import { REPO_URL, REPO_SLUG, REPO_NAMESPACE } from "../src/repo-link.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const text = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// --- the list equals the repository ------------------------------------------
const fresh = buildList();
{
  const drift = diffLists(readList(), fresh);
  ok(drift.length === 0, `the committed list is the packages this repository publishes (run node scripts/gen-official-surfaces.js --write)${drift.length ? `:\n  ${drift.join("\n  ")}` : ""}`);
  ok(fresh.packages.length >= 20 && fresh.packages.some((p) => p.registry === "npm") && fresh.packages.some((p) => p.registry === "pypi"), `the scan reads npm and PyPI manifests (${fresh.packages.length} packages)`);
  for (const [name, path] of [["agent402-mcp", "mcp"], ["agent402-client", "client"], ["agent402-tollbooth", "tollbooth"]]) ok(fresh.packages.some((p) => p.name === name && p.path === path && p.registry === "npm" && !p.renamedTo), `${name} is on the list, from ${path}/package.json`);
  ok(!fresh.packages.some((p) => p.name === "agent402" || p.name === "agent402-facilitator" || /-demo$/.test(p.name)), "a private package (the server, the facilitator, an example) is not listed as published");
  const renamed = fresh.packages.filter((p) => p.path.startsWith("renamed/"));
  ok(renamed.length >= 10 && renamed.every((p) => p.renamedTo && fresh.packages.some((q) => q.name === p.renamedTo && q.registry === p.registry && !q.renamedTo)), `every earlier name points at the current package that replaced it, on the same registry (${renamed.length})`);
  ok(fresh.mcpRegistryName === JSON.parse(readFileSync(join(ROOT, "mcp/server.json"), "utf8")).name && fresh.mcpRegistryName === JSON.parse(readFileSync(join(ROOT, "mcp/package.json"), "utf8")).mcpName, `the MCP Registry name is the one mcp/server.json and the package publish under (${fresh.mcpRegistryName})`);
  ok(JSON.stringify(officialPackages().map((p) => `${p.registry}:${p.name}`)) === JSON.stringify(fresh.packages.map((p) => `${p.registry}:${p.name}`)), "the module serves the committed list, in its order");
}
// Control: a package added to a copy of the tree, with no entry, is reported;
// a private one and one under node_modules are not.
{
  const dir = mkdtempSync(join(tmpdir(), "official-surfaces-"));
  try {
    for (const d of ["mcp", "client", "renamed/agent402-ai-sdk", "adapters/ai-sdk", "adapters/langchain-py"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true, filter: (src) => !/node_modules/.test(src) });
    const before = scanPackages(dir);
    const put = (rel, body) => { mkdirSync(join(dir, rel), { recursive: true }); writeFileSync(join(dir, rel, body.file), body.text); };
    put("adapters/planted", { file: "package.json", text: JSON.stringify({ name: "agent402-planted-adapter", version: "0.0.1" }) });
    put("adapters/planted-py", { file: "pyproject.toml", text: "[project]\nname = \"agent402-planted-py\"\nversion = \"0.0.1\"\n" });
    put("examples/planted", { file: "package.json", text: JSON.stringify({ name: "agent402-planted-private", private: true }) });
    put("client/node_modules/dep", { file: "package.json", text: JSON.stringify({ name: "some-dependency", version: "1.0.0" }) });
    const after = scanPackages(dir);
    const drift = diffLists({ packages: before, mcpRegistryName: null }, { packages: after, mcpRegistryName: null });
    ok(drift.length === 2 && drift.some((d) => d.startsWith("missing: npm:agent402-planted-adapter")) && drift.some((d) => d.startsWith("missing: pypi:agent402-planted-py")), `control: a new public package without an entry is reported, on either registry (${drift.join("; ")})`);
    ok(!after.some((p) => p.name === "agent402-planted-private" || p.name === "some-dependency"), "control: a private package and an installed dependency are not read as published");
    const gone = diffLists({ packages: after, mcpRegistryName: "a/b" }, { packages: before, mcpRegistryName: "c/d" });
    ok(gone.filter((d) => d.startsWith("no longer published")).length === 2 && gone.some((d) => d.startsWith("mcpRegistryName:")), "control: an entry whose manifest is gone, and a changed registry name, are reported");
    ok(before.some((p) => p.name === "agent402-ai-sdk" && p.renamedTo === "agent402-stream-tools"), "control: the copy reads an earlier name with its replacement");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- the wording ---------------------------------------------------------------
{
  ok(OFFICIAL_SENTENCE === "These are the official Agent402.tools packages and endpoints, published by Havok Holdings LLC.", `the statement is the first-party sentence ("${OFFICIAL_SENTENCE}")`);
  const doc = officialSurfacesDocument();
  const all = [JSON.stringify(doc), officialSurfacesMarkdown(), officialSurfacesRows().flat().join("\n"), readFileSync(new URL("../src/official-surfaces.js", import.meta.url), "utf8"), readFileSync(new URL("../src/mcp-registry-auth.js", import.meta.url), "utf8")].join("\n");
  ok(hiddenCharacters(all).length === 0, "no hidden character in the list, its renderings or the modules");
  ok(hiddenCharacters(`official​ packages`).length > 0, "control: the scan reports a zero-width character");
  ok(!/—/.test(all), "no em dash in the list or its renderings");
  ok(doc.statement === OFFICIAL_SENTENCE && doc.publisher === "Havok Holdings LLC" && doc.site === "https://agent402.tools" && doc.hostedConnector === "https://agent402.tools/mcp" && doc.repository === REPO_URL && doc.mcpRegistry?.name === fresh.mcpRegistryName && doc.page === `${OFFICIAL_SITE}${OFFICIAL_PAGE_PATH}`, "the data names the publisher, the site, the hosted connector, the repository and the MCP Registry name");
  ok(doc.packages.length === fresh.packages.length && doc.packages.every((p) => (p.registry === "npm" ? p.url === `https://www.npmjs.com/package/${p.name}` : p.url === `https://pypi.org/project/${p.name}/`)), "every package in the data links its own registry page");
}

// --- README ----------------------------------------------------------------------
{
  const readme = readFileSync(README, "utf8");
  const a = readme.indexOf(README_START), b = readme.indexOf(README_END);
  ok(a > 0 && b > a, "README.md holds the generated section's markers");
  ok(/^## Official packages and endpoints\n\n$/m.test(readme.slice(readme.lastIndexOf("\n## ", a), a)), "the README section sits under its own heading");
  ok(withReadmeSection(readme, officialSurfacesMarkdown()) === readme, "the README section is what the list renders now (run node scripts/gen-official-surfaces.js --write)");
  const section = readme.slice(a, b);
  const missing = fresh.packages.filter((p) => !section.includes(`\`${p.name}\``)).map((p) => p.name);
  ok(section.includes(OFFICIAL_SENTENCE) && section.includes(`\`${OFFICIAL_CONNECTOR}\``) && section.includes(REPO_URL) && section.includes(`\`${fresh.mcpRegistryName}\``) && missing.length === 0, `the README section carries the sentence, the connector, the repository, the registry name and every package${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
  ok(withReadmeSection("no markers", "x") === null && withReadmeSection(`a\n${README_START}\nold\n${README_END}\nz`, "new") === `a\n${README_START}\nnew\n${README_END}\nz`, "control: the section writer replaces only what is between the markers");
}

// --- the proof record setting -----------------------------------------------------
const edPub = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const PROOF = `v=MCPv1; k=ed25519; p=${edPub}`;
{
  ok(registryAuthProof({}).proof === null && registryAuthProof({}).error === null && registryAuthProof({ MCP_REGISTRY_AUTH_PROOF: "  " }).proof === null, "unset or blank: no proof and nothing to report");
  ok(registryAuthProof({ MCP_REGISTRY_AUTH_PROOF: ` ${PROOF}\n` }).proof === PROOF, "an ed25519 record is served as written, surrounding whitespace dropped");
  ok(registryAuthProof({ MCP_REGISTRY_AUTH_PROOF: `v=MCPv1; k=ecdsap384; p=${Buffer.alloc(49, 7).toString("base64")}` }).proof !== null, "an ecdsap384 record is accepted");
  for (const [bad, why] of [["hello", "free text"], [`${PROOF}<script>`, "a record with markup after it"], [`${PROOF}\nv=MCPv1; k=ed25519; p=x`, "two lines"], ["v=MCPv1; k=ed25519; p=short", "a short key"], [`v=MCPv1; k=rsa; p=${edPub}`, "another algorithm"], [`${PROOF} ${"x".repeat(MCP_REGISTRY_AUTH_MAX_BYTES)}`, "an oversized value"]]) {
    const r = registryAuthProof({ MCP_REGISTRY_AUTH_PROOF: bad });
    ok(r.proof === null && /MCP_REGISTRY_AUTH_PROOF/.test(r.error || "") && r.error === registryAuthProof({ MCP_REGISTRY_AUTH_PROOF: "another bad value" }).error && !r.error.includes(edPub), `${why} is refused, and the report is one fixed sentence that names the variable, never the value`);
  }
}

// --- the served surfaces -----------------------------------------------------------
const servers = [];
const boot = async (label, env) => {
  const srv = await bootServer({ stores: `official-${label}`, timeoutMs: 120_000, env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", X402_SYNC_ON_START: "false", MCP_REGISTRY_AUTH_PROOF: "", ...env } });
  servers.push(srv);
  return srv;
};
try {
  // Boot 1: the setting unset.
  const off = await boot("off", {});
  const get = (srv, path, init) => fetch(srv.url + path, { redirect: "manual", signal: AbortSignal.timeout(30_000), ...init });
  {
    const company = await (await get(off, "/company")).text();
    const section = (company.match(/<section id="official"[\s\S]*?<\/section>/) || [""])[0];
    const shown = text(section);
    ok(section.length > 0 && shown.includes(OFFICIAL_SENTENCE), "/company has the official packages section, opening with the statement");
    const missing = fresh.packages.filter((p) => !section.includes(`>${p.name}</code>`)).map((p) => p.name);
    ok(missing.length === 0, `/company names every package on the list${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
    const unlinked = officialPackages().filter((p) => !section.includes(`href="${p.url}"`)).map((p) => p.name);
    ok(unlinked.length === 0, `/company links every package to its registry page${unlinked.length ? ` (missing ${unlinked.join(", ")})` : ""}`);
    ok(shown.includes(OFFICIAL_CONNECTOR) && section.includes(`href="${REPO_URL}"`) && section.includes(`href="${OFFICIAL_SITE}"`) && section.includes(`href="${OFFICIAL_DATA_PATH}"`), "/company names the site, the hosted connector, the repository (as a link) and the data address");
    // A page prints no repository account name as text (scripts/test-static-pages.js):
    // a registry name in that account's namespace stays in the data and the
    // README; one in the domain's own namespace is shown on the page.
    const inAccountNamespace = fresh.mcpRegistryName.toLowerCase().startsWith(`${REPO_NAMESPACE.toLowerCase()}/`);
    ok(inAccountNamespace ? !new RegExp(`\\b${REPO_SLUG.split("/")[0]}\\b`, "i").test(shown) : shown.includes(fresh.mcpRegistryName), `/company ${inAccountNamespace ? "prints no repository account name as text" : "shows the domain-namespace MCP Registry name"}`);
    ok((section.match(/<h2[ >]/g) || []).length === 1 && !/#[0-9a-fA-F]{3,8}\b|font-size:\s*\d/.test(section), "the section has one heading and uses design tokens only");
    for (const path of ["/security", "/docs"]) {
      const html = await (await get(off, path)).text();
      ok(html.includes(`href="${OFFICIAL_PAGE_PATH}"`), `${path} links the official packages list (${OFFICIAL_PAGE_PATH})`);
    }
    const manifest = await (await get(off, OFFICIAL_DATA_PATH)).json();
    ok(JSON.stringify(manifest.official) === JSON.stringify(officialSurfacesDocument()), `${OFFICIAL_DATA_PATH} carries the list as \`official\`, the same data the page renders`);
    ok(manifest.official?.packages?.length === fresh.packages.length && manifest.maintainer && manifest.repository === REPO_URL, "the manifest still names its maintainer and repository beside it");
  }
  {
    const r = await get(off, MCP_REGISTRY_AUTH_PATH, { headers: { Accept: "text/plain", "User-Agent": "mcp-registry/1.0" } });
    ok(r.status === 404, `${MCP_REGISTRY_AUTH_PATH} is the ordinary 404 while the setting is unset (${r.status})`);
    ok(r.headers.get("x-content-type-options") === "nosniff", "...with nosniff on the refusal");
  }
  await off.stop();

  // Boot 2: the setting holds a proof record. Control for the 404 above: the
  // same request is answered.
  const on = await boot("on", { MCP_REGISTRY_AUTH_PROOF: PROOF });
  {
    const r = await get(on, MCP_REGISTRY_AUTH_PATH, { headers: { Accept: "text/plain", "User-Agent": "mcp-registry/1.0" } });
    const body = await r.text();
    ok(r.status === 200 && body.trim() === PROOF && body === `${PROOF}\n`, `${MCP_REGISTRY_AUTH_PATH} answers 200 with the proof record and nothing else (${r.status})`);
    ok(/^text\/plain\b/.test(r.headers.get("content-type") || "") && Buffer.byteLength(body) <= MCP_REGISTRY_AUTH_MAX_BYTES && !r.headers.get("location"), `...as text/plain, inside the registry's size bound, with no redirect (${r.headers.get("content-type")})`);
    ok(r.headers.get("x-content-type-options") === "nosniff" && !!r.headers.get("strict-transport-security") && !!r.headers.get("referrer-policy"), "...with nosniff, HSTS and a referrer policy");
    ok(/\bpublic\b/.test(r.headers.get("cache-control") || "") && !r.headers.get("set-cookie"), `...publicly cacheable, with no cookie (${r.headers.get("cache-control")})`);
    const slash = await get(on, `${MCP_REGISTRY_AUTH_PATH}/`);
    ok(slash.status === 200 || slash.status === 404, `a trailing slash is answered in place, never redirected (${slash.status})`);
    ok(/serving the namespace proof/.test(on.log()) && !on.log().includes(edPub), "the boot log says the proof is served and does not print the record");
    const op = await get(on, "/__operator/well-known", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: JSON.stringify({ path: "mcp-registry-auth", body: "x", contentType: "text/plain" }) });
    ok(op.status === 404 || op.status === 401 || op.status === 403, `the operator store does not take the name from an unauthenticated caller (${op.status})`);
  }
  await on.stop();

  // Boot 3: a value that is not a proof record is never served.
  const bad = await boot("bad", { MCP_REGISTRY_AUTH_PROOF: "<html>not-a-proof-record</html>" });
  {
    const r = await get(bad, MCP_REGISTRY_AUTH_PATH);
    ok(r.status === 404 && !(await r.text()).includes("not-a-proof-record"), `a setting that is not a proof record leaves the route a 404 (${r.status})`);
    ok(/MCP_REGISTRY_AUTH_PROOF is not a proof record/.test(bad.log()) && !bad.log().includes("not-a-proof-record"), "the boot log names the variable and not its value");
  }
  await bad.stop();
} catch (e) {
  ok(false, `the served surfaces could be read: ${e?.message || e}`);
} finally {
  for (const s of servers) { try { await s.stop(); } catch { /* already stopped */ } }
}

// The store that publishes operator documents refuses the dedicated name.
{
  const { registerWellKnown } = await import("../src/well-known-store.js");
  let refused = false;
  try { registerWellKnown(MCP_REGISTRY_AUTH_PATH.replace(/^\/\.well-known\//, ""), "x", "text/plain"); } catch (e) { refused = /dedicated route/.test(e.message); }
  ok(refused, "the operator document store refuses the proof path: only the setting serves it");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
