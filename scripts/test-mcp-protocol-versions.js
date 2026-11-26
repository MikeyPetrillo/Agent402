#!/usr/bin/env node
// Every protocol version the hosted /mcp lists is served, however the client
// names it.
//
// A 2025-era client names its revision in the MCP-Protocol-Version header,
// and some also stamp it into the request's
// _meta["io.modelcontextprotocol/protocolVersion"]. The SDK's era classifier
// sends any request carrying that key to the 2026-07-28 handler, which serves
// 2026-07-28 only and answered such a request "Unsupported protocol version:
// 2025-06-18". The connector routes a claim naming a 2025-era version the
// transport serves (SUPPORTED_PROTOCOL_VERSIONS) to the 2025-era path
// (legacyEnvelopeClaim, src/mcp-http.js).
//
// Through a booted FREE_MODE server, for each supported 2025-era version:
// initialize, then tools/list and a free tools/call, with the header alone,
// with the header and a bare _meta claim, and with a full envelope naming the
// version; the initialized notification carrying the claim is accepted; a
// wallet-only tool's answer is the same on every path. 2026-07-28 keeps its
// envelope answers (resultType). A made-up version gets the documented
// refusals: the 2025-era transport's -32000 for the header, the modern
// -32022 with the supported list for an envelope claim. The reference SDK
// client negotiated to 2025-06-18 connects, lists tools and runs a free tool,
// once plain and once stamping the claim on every request.
//
//   node scripts/test-mcp-protocol-versions.js      (offline: no network, no spend)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SUPPORTED_PROTOCOL_VERSIONS, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { bootServer } from "./lib/boot-server.js";
import { legacyEnvelopeClaim, MODERN_PROTOCOL_VERSION, mcpServerCard } from "../src/mcp-http.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const HASH_ARGS = { slug: "hash", params: { text: "agent402", algorithm: "sha256" } };
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
const INFO_KEY = "io.modelcontextprotocol/clientInfo";
const WALLET_TOOL = { name: "weather.current", arguments: { latitude: 40.7, longitude: -74 } };

// --- the classifier, offline -------------------------------------------------
{
  const req = (meta, header) => ({ body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: meta === undefined ? {} : { _meta: meta } }, headers: header ? { "mcp-protocol-version": header } : {} });
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    ok(legacyEnvelopeClaim(req({ [PROTOCOL_VERSION_META_KEY]: v })) === true, `a ${v} claim with no header goes to the 2025-era path`);
    ok(legacyEnvelopeClaim(req({ [PROTOCOL_VERSION_META_KEY]: v }, v)) === true, `a ${v} claim with the matching header goes to the 2025-era path`);
  }
  ok(legacyEnvelopeClaim(req({ [PROTOCOL_VERSION_META_KEY]: "2025-06-18" }, MODERN_PROTOCOL_VERSION)) === false, "a 2025-06-18 claim under a 2026-07-28 header stays with the SDK's mismatch refusal");
  ok(legacyEnvelopeClaim(req({ [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION })) === false, "a 2026-07-28 claim stays on the modern path");
  ok(legacyEnvelopeClaim(req({ [PROTOCOL_VERSION_META_KEY]: "1999-01-01" })) === false, "an unknown claim stays with the modern refusal");
  ok(legacyEnvelopeClaim(req({ [PROTOCOL_VERSION_META_KEY]: 20250618 })) === false, "a non-string claim stays with the modern refusal");
  ok(legacyEnvelopeClaim(req(undefined, "2025-06-18")) === false && legacyEnvelopeClaim(req({})) === false, "no claim is no claim (the SDK classifies it)");
  ok(legacyEnvelopeClaim({ body: [{ params: { _meta: { [PROTOCOL_VERSION_META_KEY]: "2025-06-18" } } }], headers: {} }) === false, "a batch body is left to the SDK");
  ok(legacyEnvelopeClaim({ body: { params: { _meta: Object.create({ [PROTOCOL_VERSION_META_KEY]: "2025-06-18" }) } }, headers: {} }) === false, "an inherited key is not a claim");
  const card = mcpServerCard({ baseUrl: "http://t", toolCount: 1 });
  const listed = card?.remotes?.[0]?.supportedProtocolVersions || [];
  ok(listed[0] === MODERN_PROTOCOL_VERSION && SUPPORTED_PROTOCOL_VERSIONS.every((v) => listed.includes(v)), `the server card lists 2026-07-28 and every 2025-era version this suite drives (${listed.join(", ")})`);
}

// --- booted FREE_MODE server -------------------------------------------------
let booted = null;
try {
  booted = await bootServer({ stores: "mcp-protocol-versions", timeoutMs: 120_000, env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATE_DATABASE_URL: "", UPSTREAM_COSTS_JSON: "", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" } });
} catch (e) { console.error(e.message); }
const kill = () => { try { booted?.child.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", kill);
ok(Boolean(booted), "server booted");
if (!booted) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
const MCP = `${booted.url}/mcp`;

const post = async (message, headers = {}) => {
  const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(message) });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  let body = null; try { body = JSON.parse(line ? line.slice(5) : text); } catch { /* empty or not JSON */ }
  return { status: res.status, body };
};
const rpc = (method, params, id, headers) => post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, headers);
const hashOf = (r) => /[0-9a-f]{64}/.exec(r.body?.result?.content?.[0]?.text || "")?.[0] || null;
const toolNames = (r) => (r.body?.result?.tools || []).map((t) => t.name);

const base = await rpc("tools/list", undefined, 1, { "mcp-protocol-version": "2025-11-25" });
const baseNames = JSON.stringify(toolNames(base));
const baseCall = await rpc("tools/call", { name: "catalog.call", arguments: HASH_ARGS }, 2, { "mcp-protocol-version": "2025-11-25" });
const HASH = hashOf(baseCall);
const baseWallet = await rpc("tools/call", WALLET_TOOL, 3, { "mcp-protocol-version": "2025-11-25" });
const walletText = baseWallet.body?.result?.content?.[0]?.text || "";
ok(toolNames(base).includes("catalog.call") && HASH && /payment/i.test(walletText), `baseline: tools/list, a free call and a wallet-only ask answer (${toolNames(base).length} tools)`);

for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
  const init = await rpc("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "versions", version: "1" } }, 10);
  ok(init.status === 200 && init.body?.result?.protocolVersion === v, `${v}: initialize is answered with ${v} (${init.status} ${init.body?.result?.protocolVersion})`);
  const shapes = [
    ["header only", () => ({}), { "mcp-protocol-version": v }],
    ["header and _meta claim", () => ({ _meta: { [PROTOCOL_VERSION_META_KEY]: v } }), { "mcp-protocol-version": v }],
    ["_meta claim, no header", () => ({ _meta: { [PROTOCOL_VERSION_META_KEY]: v } }), {}],
    ["full envelope", () => ({ _meta: { [PROTOCOL_VERSION_META_KEY]: v, [CAPS_KEY]: {}, [INFO_KEY]: { name: "versions", version: "1" } } }), { "mcp-protocol-version": v }],
  ];
  for (const [label, extra, headers] of shapes) {
    const list = await rpc("tools/list", extra(), 11, { ...headers, "mcp-method": "tools/list" });
    ok(list.status === 200 && JSON.stringify(toolNames(list)) === baseNames && list.body?.result?.resultType === undefined, `${v} ${label}: tools/list is the 2025-era listing (${list.status}${list.body?.error ? ` ${list.body.error.message}` : ""})`);
    const call = await rpc("tools/call", { name: "catalog.call", arguments: HASH_ARGS, ...extra() }, 12, { ...headers, "mcp-method": "tools/call", "mcp-name": "catalog.call" });
    ok(call.status === 200 && hashOf(call) === HASH && call.body?.result?.isError !== true, `${v} ${label}: a free tools/call runs (${call.status}${call.body?.error ? ` ${call.body.error.message}` : ""})`);
    const wallet = await rpc("tools/call", { ...WALLET_TOOL, ...extra() }, 13, { ...headers, "mcp-method": "tools/call", "mcp-name": WALLET_TOOL.name });
    ok(wallet.status === 200 && (wallet.body?.result?.content?.[0]?.text || "") === walletText, `${v} ${label}: a wallet-only tool answers the same payment ask as the header-only path`);
  }
  const note = await post({ jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: { [PROTOCOL_VERSION_META_KEY]: v } } }, { "mcp-protocol-version": v });
  ok(note.status === 202, `${v}: the initialized notification carrying the claim is accepted (${note.status}${note.body?.error ? ` ${note.body.error.message}` : ""})`);
}

{
  // 2026-07-28 keeps its own path.
  const env = { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION, [CAPS_KEY]: {}, [INFO_KEY]: { name: "modern", version: "1" } };
  const h = (method, name) => ({ "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });
  const list = await rpc("tools/list", { _meta: env }, 20, h("tools/list"));
  ok(list.status === 200 && list.body?.result?.resultType === "complete" && JSON.stringify(toolNames(list)) === baseNames, `2026-07-28: tools/list answers resultType complete with the same tools (${list.status})`);
  const call = await rpc("tools/call", { name: "catalog.call", arguments: HASH_ARGS, _meta: env }, 21, h("tools/call", "catalog.call"));
  ok(call.status === 200 && call.body?.result?.resultType === "complete" && hashOf(call) === HASH, `2026-07-28: a free tools/call answers resultType complete (${call.status})`);
  const mismatch = await rpc("tools/list", { _meta: { ...env, [PROTOCOL_VERSION_META_KEY]: "2025-06-18" } }, 22, h("tools/list"));
  ok(mismatch.status === 400 && mismatch.body?.error, `a 2025-06-18 claim under a 2026-07-28 header is still refused (${mismatch.status} ${mismatch.body?.error?.code})`);
}

{
  // A made-up version gets the documented refusals.
  const v = "1999-01-01";
  const header = await rpc("tools/list", undefined, 30, { "mcp-protocol-version": v });
  ok(header.status === 400 && header.body?.error?.code === -32000 && /Unsupported protocol version: 1999-01-01 \(supported versions: /.test(header.body?.error?.message || ""), `${v} header: the 2025-era transport's -32000 naming the supported versions (${header.status} ${header.body?.error?.message})`);
  const claim = await rpc("tools/list", { _meta: { [PROTOCOL_VERSION_META_KEY]: v, [CAPS_KEY]: {}, [INFO_KEY]: { name: "x", version: "1" } } }, 31, { "mcp-protocol-version": v, "mcp-method": "tools/list" });
  ok(claim.status === 400 && claim.body?.error?.code === -32022 && claim.body?.error?.data?.requested === v && claim.body?.error?.data?.supported?.includes(MODERN_PROTOCOL_VERSION), `${v} envelope: the modern -32022 with the supported list (${claim.status} ${claim.body?.error?.code})`);
  const call = await rpc("tools/call", { name: "catalog.call", arguments: HASH_ARGS, _meta: { [PROTOCOL_VERSION_META_KEY]: v, [CAPS_KEY]: {} } }, 32, { "mcp-protocol-version": v, "mcp-method": "tools/call", "mcp-name": "catalog.call" });
  ok(call.status === 400 && call.body?.error && hashOf(call) === null, `${v}: a tools/call is refused and runs nothing (${call.status})`);
  const init = await rpc("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "x", version: "1" } }, 33);
  ok(init.status === 200 && init.body?.result?.protocolVersion === SUPPORTED_PROTOCOL_VERSIONS[0], `${v} initialize is answered with the server's newest 2025-era version (${init.body?.result?.protocolVersion})`);
}

// --- the reference SDK client, negotiated to 2025-06-18 -----------------------
// The v1 Client always offers its newest version and takes the server's
// answer; a fetch that rewrites the offer makes the server answer 2025-06-18,
// which the client then sends on every request. `stamp` also writes the claim
// into every message's _meta, as some clients do.
for (const stamp of [false, true]) {
  const PIN = "2025-06-18";
  const sentHeaders = new Set();
  const shim = async (url, init = {}) => {
    let body = init.body;
    if (typeof body === "string") {
      const msg = JSON.parse(body);
      if (msg.method === "initialize") msg.params.protocolVersion = PIN;
      else if (stamp && msg.method) msg.params = { ...(msg.params || {}), _meta: { ...(msg.params?._meta || {}), [PROTOCOL_VERSION_META_KEY]: PIN } };
      body = JSON.stringify(msg);
      const h = new Headers(init.headers);
      if (msg.method !== "initialize") sentHeaders.add(h.get("mcp-protocol-version"));
    }
    return fetch(url, { ...init, body });
  };
  const label = stamp ? "reference client on 2025-06-18 stamping the _meta claim" : "reference client on 2025-06-18";
  const client = new Client({ name: "versions-check", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { fetch: shim }));
    ok(client.getServerVersion()?.name === "agent402", `${label}: connects`);
    const tools = await client.listTools();
    ok(JSON.stringify(tools.tools.map((t) => t.name)) === baseNames, `${label}: lists the tools (${tools.tools.length})`);
    const r = await client.callTool({ name: "catalog.call", arguments: HASH_ARGS });
    ok(r.isError !== true && (r.content?.[0]?.text || "").includes(HASH), `${label}: runs a free tool`);
    ok(sentHeaders.size === 1 && sentHeaders.has(PIN), `${label}: every later request named ${PIN} (${[...sentHeaders].join(", ")})`);
  } catch (e) {
    ok(false, `${label}: ${e.message}`);
  } finally {
    await client.close().catch(() => {});
  }
}

const log = booted.log();
ok(!/Unsupported protocol version: 20(24|25)-/.test(log), "the server logged no 2025-era version as unsupported");
await booted.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
