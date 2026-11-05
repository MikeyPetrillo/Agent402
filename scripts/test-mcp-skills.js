// test-mcp-skills - Skills over MCP (io.modelcontextprotocol/skills, SEP-2640)
// on the hosted connector. Offline: a bare express app on port 0 with three
// mounts of the real connector code (skills on, skills off, a scoped profile
// with skills on), so nothing reaches the network.
//
// What this pins:
//  - with MCP_SKILLS=on, a client that declares the extension at initialize
//    (or in the per-request client-capabilities _meta) sees `resources` and
//    the extension in the answer; one that does not sees the same initialize
//    answer as with the switch off;
//  - skills/list carries one entry per skill pack, each a complete manifest
//    (uri, verbatim frontmatter, resources with digest and size) plus
//    resultType, ttlMs and cacheScope; skills/get answers each uri and refuses
//    an unknown one with -32602;
//  - resources/read of every SKILL.md returns bytes whose size and SHA-256
//    match the manifest, whose YAML frontmatter equals the listed frontmatter,
//    and whose body names the bundled call and each tool the pack uses;
//  - the reference SDK client negotiates the extension and reads a skill;
//  - with the switch off, skills/* and resources/* are method-not-found and
//    prompts/list is unchanged;
//  - a scoped profile (no catalog.call) never serves skills.
process.env.AGENT402_MCP_MAX_PER_MIN = "1000000";
process.env.AGENT402_MCP_MAX_PER_HOUR = "1000000";
process.env.AGENT402_MCP_REQ_PER_MIN = "1000000";
process.env.AGENT402_MCP_REQ_PER_HOUR = "1000000";
process.env.X402_INDEX_CRAWL = "off";
process.env.X402_SYNC_ON_START = "false";

import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import express from "express";
import { createHash } from "node:crypto";
import * as yaml from "js-yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { mountMcp } = await import("../src/mcp-http.js");
const { SKILL_PACKS } = await import("../src/skills.js");
const { SKILLS_EXTENSION, skillUriOf, mcpSkillsEnabled, clientDeclaresSkills, buildSkillSet } = await import("../src/mcp-skills.js");
const { hiddenCharacters } = await import("../src/hidden-chars.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  FAIL ${msg}`); } };

const def = (slug, price, extra = {}) => ({
  route: `POST /api/${slug}`, slug, name: slug, category: "test", price, description: `${slug} test tool`,
  tags: [slug], discovery: { inputSchema: { properties: { q: { type: "string" } } }, example: { q: "x" } },
  handler: async () => ({ ok: true, slug }), ...extra,
});
const PACK = SKILL_PACKS.find((p) => (p.promptArgs || []).some((a) => a.substitute)) || SKILL_PACKS[0];
const FREE_TOOL = PACK.toolSlugs[0];
// A second pack whose bundled route is free on the connector (proof-of-work).
// SKILL_PACKS[0] stays unserved when it is not PACK (the "not offered" case).
const OTHER = SKILL_PACKS.find((p) => p.slug !== PACK.slug);
const FREE_PACK = SKILL_PACKS.find((p) => p.slug !== PACK.slug && p.slug !== OTHER.slug);
const CATALOG = {
  [`POST /api/skill/${PACK.slug}`]: def(`skill-${PACK.slug}`, "$0.042"),
  [`POST /api/skill/${FREE_PACK.slug}`]: def(`skill-${FREE_PACK.slug}`, "$0.037", { free: true }),
  [`POST /api/${FREE_TOOL}`]: def(FREE_TOOL, "$0.001", { free: true }),
  "POST /api/whois": def("whois", "$0.001"),
};
const isComputePayable = (d) => d.free === true;

const app = express();
app.use(express.json({ limit: "1mb" }));
ok(mcpSkillsEnabled() === false, "MCP_SKILLS unset reads off");
process.env.MCP_SKILLS = "on";
ok(mcpSkillsEnabled() === true, "MCP_SKILLS=on reads on");
mountMcp(app, CATALOG, { baseUrl: "http://127.0.0.1", isComputePayable, path: "/mcp" });
mountMcp(app, CATALOG, { baseUrl: "http://127.0.0.1", isComputePayable, path: "/mcp-scoped", profile: { metaTools: false } });
process.env.MCP_SKILLS = "";
mountMcp(app, CATALOG, { baseUrl: "http://127.0.0.1", isComputePayable, path: "/mcp-off" });

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let rpcId = 0;
async function rpc(path, method, params) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) }),
  });
  return res.json();
}
// A raw JSON-RPC message, for notifications (no id) and literal params values.
async function rawPost(path, message) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify(message),
  });
  return { status: res.status, text: await res.text() };
}
const init = (path, capabilities = {}, extra = {}) => rpc(path, "initialize", { protocolVersion: "2025-11-25", capabilities, clientInfo: { name: "test-mcp-skills", version: "1" }, ...extra });
const DECLARE = { extensions: { [SKILLS_EXTENSION]: {} } };

try {
  // ---- unit: declaration reader
  ok(clientDeclaresSkills({ capabilities: DECLARE }), "declaration read from initialize capabilities");
  ok(clientDeclaresSkills({ _meta: { "io.modelcontextprotocol/clientCapabilities": DECLARE } }), "declaration read from per-request _meta");
  ok(!clientDeclaresSkills({ capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } }), "another extension is not a skills declaration");
  ok(!clientDeclaresSkills({ capabilities: { extensions: [SKILLS_EXTENSION] } }), "an array is not an extensions map");
  ok(!clientDeclaresSkills(undefined), "no params, no declaration");

  // ---- negotiation
  const negotiated = await init("/mcp", DECLARE);
  const caps = negotiated.result?.capabilities || {};
  ok(caps.extensions?.[SKILLS_EXTENSION] && typeof caps.extensions[SKILLS_EXTENSION] === "object", `negotiating client sees the skills extension (got ${JSON.stringify(caps.extensions)})`);
  ok(caps.resources && typeof caps.resources === "object", "negotiating client sees the resources capability the extension requires");
  ok(caps.prompts && caps.tools, "negotiating client still sees prompts and tools");
  ok(!caps.extensions?.[SKILLS_EXTENSION]?.directoryRead, "directoryRead is not declared (resources/directory/read is not served)");

  const viaMeta = await init("/mcp", {}, { _meta: { "io.modelcontextprotocol/clientCapabilities": DECLARE } });
  ok(viaMeta.result?.capabilities?.extensions?.[SKILLS_EXTENSION], "a per-request _meta declaration negotiates too");

  const plain = await init("/mcp", {});
  const plainOff = await init("/mcp-off", {});
  ok(!plain.result?.capabilities?.extensions?.[SKILLS_EXTENSION] && !plain.result?.capabilities?.resources, "non-negotiating client sees no skills extension and no resources");
  ok(JSON.stringify(plain.result?.capabilities) === JSON.stringify(plainOff.result?.capabilities), "non-negotiating client's capabilities equal the switch-off capabilities");
  ok(plain.result?.instructions === plainOff.result?.instructions, "instructions unchanged");
  const offNegotiating = await init("/mcp-off", DECLARE);
  ok(!offNegotiating.result?.capabilities?.extensions?.[SKILLS_EXTENSION] && !offNegotiating.result?.capabilities?.resources, "switch off: a declaring client is not offered skills");

  // ---- skills/list
  const list = await rpc("/mcp", "skills/list", {});
  const skills = list.result?.skills || [];
  ok(list.result?.resultType === "complete", "skills/list resultType complete");
  ok(Number.isInteger(list.result?.ttlMs) && list.result.ttlMs > 0 && typeof list.result?.cacheScope === "string", "skills/list carries ttlMs and cacheScope");
  ok(list.result?.nextCursor === undefined, "one page, no nextCursor");
  ok(skills.length === SKILL_PACKS.length, `one skill per pack (skills=${skills.length}, packs=${SKILL_PACKS.length})`);
  const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  let shape = 0;
  for (const s of skills) {
    const name = s.frontmatter?.name;
    const last = String(s.uri).replace(/\/SKILL\.md$/, "").split("/").pop();
    const good = typeof s.uri === "string" && s.uri.startsWith("skill://") && s.uri.endsWith("/SKILL.md")
      && typeof name === "string" && NAME_RE.test(name) && name.length <= 64 && name === last
      && typeof s.frontmatter.description === "string" && s.frontmatter.description.length > 0 && s.frontmatter.description.length <= 1024
      && Array.isArray(s.resources) && s.resources.length >= 1 && s.resources.some((r) => r.uri === s.uri)
      && s.resources.every((r) => /^sha256:[0-9a-f]{64}$/.test(r.digest) && Number.isInteger(r.size) && r.size > 0 && r.size <= 16777216);
    if (good) shape++; else console.error(`  bad entry ${JSON.stringify(s).slice(0, 300)}`);
  }
  ok(shape === skills.length, `every entry is a complete manifest with a valid name (${shape}/${skills.length})`);
  ok(new Set(skills.map((s) => s.uri)).size === skills.length, "skill URIs are unique");
  ok((await rpc("/mcp", "skills/list", { cursor: "nope" })).error?.code === -32602, "skills/list refuses a cursor it never issued");

  // ---- skills/get
  const packUri = skillUriOf(PACK.slug);
  const got = await rpc("/mcp", "skills/get", { uri: packUri });
  ok(got.result?.resultType === "complete" && got.result?.skill?.uri === packUri, "skills/get answers a listed uri");
  ok(JSON.stringify(got.result?.skill) === JSON.stringify(skills.find((s) => s.uri === packUri)), "skills/get entry equals the listing entry");
  ok(got.result?.ttlMs > 0 && typeof got.result?.cacheScope === "string", "skills/get carries ttlMs and cacheScope");
  ok((await rpc("/mcp", "skills/get", { uri: "skill://agent402/no-such-pack/SKILL.md" })).error?.code === -32602, "unknown skill uri is -32602");
  ok((await rpc("/mcp", "skills/get", {})).error?.code === -32602, "missing uri is -32602");
  ok((await rpc("/mcp", "skills/get", { uri: 7 })).error?.code === -32602, "non-string uri is -32602");
  ok((await rpc("/mcp", "skills/get", [1])).error?.code === -32602, "array params is -32602");
  for (const method of ["skills/list", "skills/get"]) {
    const nul = await rawPost("/mcp", { jsonrpc: "2.0", id: 901, method, params: null });
    let parsed = null;
    try { parsed = JSON.parse(nul.text); } catch { parsed = null; }
    ok(parsed?.error?.code === -32602 && parsed.error.message === "params must be an object" && parsed.id === 901, `${method} params:null is "params must be an object" (got ${nul.text.slice(0, 160)})`);
    const note = await rawPost("/mcp", { jsonrpc: "2.0", method, params: method === "skills/get" ? { uri: skillUriOf(PACK.slug) } : {} });
    ok(note.status === 202 && note.text === "", `${method} notification (no id) gets no reply (status ${note.status}, body ${JSON.stringify(note.text.slice(0, 120))})`);
  }
  const absent = await rawPost("/mcp", { jsonrpc: "2.0", id: 902, method: "skills/list" });
  ok(JSON.parse(absent.text)?.result?.skills?.length === SKILL_PACKS.length, "skills/list with params absent reads as {}");

  // ---- resources/read verifies against the manifest, for every skill
  let verified = 0;
  for (const s of skills) {
    const read = await rpc("/mcp", "resources/read", { uri: s.uri });
    const c = read.result?.contents?.[0];
    const bytes = Buffer.from(c?.text ?? "", "utf8");
    const entry = s.resources.find((r) => r.uri === s.uri);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const m = /^---\n([\s\S]*?)\n---\n/.exec(c?.text || "");
    let fm = null;
    try { fm = m ? yaml.load(m[1]) : null; } catch { fm = null; }
    const good = c?.uri === s.uri && c?.mimeType === "text/markdown" && bytes.length === entry.size && digest === entry.digest
      && fm && JSON.stringify(fm) === JSON.stringify(s.frontmatter);
    if (good) verified++; else console.error(`  unverified ${s.uri}`);
  }
  ok(verified === skills.length, `every SKILL.md matches its size, digest and frontmatter (${verified}/${skills.length})`);

  const body = (await rpc("/mcp", "resources/read", { uri: packUri })).result?.contents?.[0]?.text || "";
  ok(body.includes(`catalog.call {"slug":"skill-${PACK.slug}"`), "body names the one bundled call");
  ok(body.includes("$0.042"), "bundled price is read from the catalog");
  ok(PACK.toolSlugs.every((t) => body.includes(`\`${t}\``)), "body names every tool the pack uses");
  ok(body.includes(`Free on this connector (proof-of-work, rate-limited): \`${FREE_TOOL}\``), "free tools are split out");
  ok(!body.includes("—"), "no em dash in skill text");
  ok(body.includes("One payment of $0.042 runs all") && !body.includes("Free on this connector with proof-of-work"), "a paid bundled route leads with its one payment");
  const freeBody = (await rpc("/mcp", "resources/read", { uri: skillUriOf(FREE_PACK.slug) })).result?.contents?.[0]?.text || "";
  ok(freeBody.includes(`catalog.call {"slug":"skill-${FREE_PACK.slug}"`), "free bundled pack: body names the one bundled call");
  ok(freeBody.includes("Free on this connector with proof-of-work (no wallet, no payment, rate-limited)"), "free bundled pack: body leads with proof-of-work, no payment");
  ok(!freeBody.includes("One payment of"), "free bundled pack: body does not ask for a payment");
  ok(freeBody.includes("With a wallet, the same call is $0.037 in USDC"), "free bundled pack: the catalog price is kept as the wallet alternative");

  // ---- every built skill body and description is free of hidden characters and em dashes
  // (skill bodies are instructions an agent reads; test-hidden-chars does not read them)
  const built = buildSkillSet({ freeSlugs: new Set([`skill-${FREE_PACK.slug}`, FREE_TOOL]), priceOf: (slug) => (slug.startsWith("skill-") ? "$0.042" : null) });
  const dirty = [];
  for (const f of built.fileByUri.values()) {
    for (const [field, text] of [["text", f.text], ["description", f.description], ["title", f.title]]) {
      const hidden = hiddenCharacters(String(text));
      if (hidden.length) dirty.push(`${f.uri} ${field}: hidden ${JSON.stringify(hidden.slice(0, 3))}`);
      if (String(text).includes("\u2014")) dirty.push(`${f.uri} ${field}: em dash`);
    }
  }
  for (const e of built.entries) {
    if (hiddenCharacters(String(e.frontmatter.description)).length || String(e.frontmatter.description).includes("\u2014")) dirty.push(`${e.uri} frontmatter.description`);
  }
  ok(built.fileByUri.size === SKILL_PACKS.length && dirty.length === 0, `every skill body and description has no hidden character or em dash (${dirty.slice(0, 5).join("; ") || "clean"})`);

  const other = OTHER;
  const otherBody = (await rpc("/mcp", "resources/read", { uri: skillUriOf(other.slug) })).result?.contents?.[0]?.text || "";
  ok(!otherBody.includes("Run it in one call") && otherBody.includes("## Steps"), "a bundled route the catalog does not serve is not offered");
  ok((await rpc("/mcp", "resources/read", { uri: "skill://agent402/nope/SKILL.md" })).error?.code === -32602, "unknown resource is -32602");
  const rlist = await rpc("/mcp", "resources/list", {});
  ok(rlist.result?.resources?.length === SKILL_PACKS.length && rlist.result.resources.every((r) => r.mimeType === "text/markdown" && r.uri.startsWith("skill://")), "resources/list lists every SKILL.md");

  // ---- prompts path unchanged
  const pOn = await rpc("/mcp", "prompts/list", {});
  const pOff = await rpc("/mcp-off", "prompts/list", {});
  ok(pOn.result?.prompts?.length === SKILL_PACKS.length && JSON.stringify(pOn.result) === JSON.stringify(pOff.result), "prompts/list identical with skills on and off");
  const gOn = await rpc("/mcp", "prompts/get", { name: PACK.slug, arguments: {} });
  const gOff = await rpc("/mcp-off", "prompts/get", { name: PACK.slug, arguments: {} });
  ok(gOn.result?.messages?.length && JSON.stringify(gOn.result) === JSON.stringify(gOff.result), "prompts/get identical with skills on and off");

  // ---- switch off and scoped mounts
  for (const [path, label] of [["/mcp-off", "switch off"], ["/mcp-scoped", "scoped profile"]]) {
    ok((await rpc(path, "skills/list", {})).error?.code === -32601, `${label}: skills/list is method-not-found`);
    ok((await rpc(path, "skills/get", { uri: packUri })).error?.code === -32601, `${label}: skills/get is method-not-found`);
    ok((await rpc(path, "resources/read", { uri: packUri })).error?.code === -32601, `${label}: resources/read is method-not-found`);
  }
  const scopedInit = await init("/mcp-scoped", DECLARE);
  ok(!scopedInit.result?.capabilities?.extensions?.[SKILLS_EXTENSION] && !scopedInit.result?.capabilities?.resources, "scoped profile: a declaring client is not offered skills");

  // ---- reference SDK client
  const client = new Client({ name: "test-mcp-skills-sdk", version: "1" }, { capabilities: DECLARE });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  ok(client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION], "SDK client: server declares the skills extension");
  const sdkList = await client.listResources();
  ok(sdkList.resources.length === SKILL_PACKS.length, "SDK client: resources/list parses");
  const sdkRead = await client.readResource({ uri: packUri });
  ok(sdkRead.contents?.[0]?.text === body, "SDK client: resources/read returns the same SKILL.md");
  await client.close();
  const plainClient = new Client({ name: "test-mcp-skills-sdk-plain", version: "1" });
  await plainClient.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const pc = plainClient.getServerCapabilities() || {};
  ok(!pc.extensions?.[SKILLS_EXTENSION] && !pc.resources, "SDK client without the declaration: no skills, no resources");
  ok((await plainClient.listPrompts()).prompts.length === SKILL_PACKS.length, "SDK client without the declaration: prompts unchanged");
  await plainClient.close();
} catch (err) {
  fail++;
  console.error(`  FAIL threw: ${err?.stack || err}`);
} finally {
  server.close();
}

console.log(`\ntest-mcp-skills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
