// test-mcp-binary-e2e - a binary tool answer through a real MCP tools/call,
// on BOTH result paths of the hosted connector:
//
//  - direct path: a free (compute-payable) tool whose handler returns
//    {__binary, contentType, headers}, served in-process by mountMcp;
//  - paid loopback path: a wallet-only tool replayed over the REAL
//    createMcpMppLoopback (its fetch is injected, so nothing leaves the
//    process), whose binary response is turned into the MCP answer by the
//    real translateMppResponse.
//
// Each path must answer an audio body as an audio content block (mimeType and
// bytes intact, X-Dub-Translation kept in structuredContent.result.headers)
// and an image body as an image block. A stock @modelcontextprotocol/sdk
// client drives every call over Streamable HTTP. Offline: port 0, no wallet,
// no upstream.
process.env.AGENT402_MCP_MAX_PER_MIN = "1000000";
process.env.AGENT402_MCP_MAX_PER_HOUR = "1000000";
process.env.AGENT402_MCP_REQ_PER_MIN = "1000000";
process.env.AGENT402_MCP_REQ_PER_HOUR = "1000000";
process.env.AGENT402_MCP_TASKS = "off";
process.env.X402_INDEX_CRAWL = "off";
process.env.X402_SYNC_ON_START = "false";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Receipt } from "mppx";

const { mountMcp } = await import("../src/mcp-http.js");
const { createMcpMppLoopback, MCP_RECEIPT_META } = await import("../src/mcp-mpp.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL ${msg}`); } };

// Distinct, non-text byte patterns so a truncation or re-encoding shows.
const AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64, 0x00, 0x80, 0x7f, 0x01]);
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xfe, 0x02]);
const DUB = "es->en; voice=narrator";
const RECEIPT = Receipt.serialize({ method: "evm", status: "success", reference: "0x" + "ab".repeat(32), timestamp: new Date().toISOString() });

const def = (slug, route, handler) => ({
  route, slug, name: slug, category: "test", price: "$0.01", description: `${slug} test tool`,
  tags: [slug], discovery: { inputSchema: { properties: { text: { type: "string" } } }, input: { text: "hi" } },
  handler,
});

const FREE = new Set(["free-audio", "free-image"]);
const CATALOG = {
  "POST /api/free-audio": def("free-audio", "POST /api/free-audio", async () => ({
    __binary: AUDIO, contentType: "audio/mpeg; charset=binary", headers: { "X-Dub-Translation": DUB },
  })),
  "POST /api/free-image": def("free-image", "POST /api/free-image", async () => ({ __binary: IMAGE, contentType: "image/png" })),
  // Paid tools: their handlers must never run in-process (the loopback serves them).
  "POST /api/paid-audio": def("paid-audio", "POST /api/paid-audio", async () => { throw new Error("paid handler ran in-process"); }),
  "POST /api/paid-image": def("paid-image", "POST /api/paid-image", async () => { throw new Error("paid handler ran in-process"); }),
};

// The paid route, as the loopback's fetch sees it.
const loopbackCalls = [];
async function stubFetch(url, init) {
  loopbackCalls.push({ url, method: init?.method });
  const path = new URL(url).pathname;
  if (path === "/api/paid-audio") {
    return new Response(AUDIO, { status: 200, headers: { "content-type": "audio/mpeg", "x-dub-translation": DUB, "payment-receipt": RECEIPT } });
  }
  if (path === "/api/paid-image") {
    return new Response(IMAGE, { status: 200, headers: { "content-type": "image/png", "payment-receipt": RECEIPT } });
  }
  return new Response(JSON.stringify({ error: "no such stub route" }), { status: 404, headers: { "content-type": "application/json" } });
}

const app = express();
app.use(express.json({ limit: "1mb" }));
mountMcp(app, CATALOG, {
  baseUrl: "http://localhost",
  isComputePayable: (d) => FREE.has(d.slug),
  mppLoopback: createMcpMppLoopback({ port: 1, fetchImpl: stubFetch }),
});
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const client = new Client({ name: "test-mcp-binary-e2e", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const call = (slug) => client.callTool({ name: "catalog.call", arguments: { slug, params: { text: "hi" } } });

function checkAudio(res, label) {
  const block = res?.content?.[0];
  ok(!res?.isError, `${label}: the call succeeded (got ${JSON.stringify(res).slice(0, 200)})`);
  ok(block?.type === "audio", `${label}: content[0] is an audio block (got ${block?.type})`);
  ok(block?.mimeType === "audio/mpeg", `${label}: mimeType is audio/mpeg without parameters (got ${block?.mimeType})`);
  ok(typeof block?.data === "string" && Buffer.from(block.data, "base64").equals(AUDIO), `${label}: the audio bytes arrive intact`);
  ok(res?.structuredContent?.result?.headers?.["X-Dub-Translation"] === DUB, `${label}: X-Dub-Translation is kept in structuredContent.result.headers`);
  ok(res?.structuredContent?.result?.contentType === "audio/mpeg", `${label}: structuredContent names the audio type`);
}
function checkImage(res, label) {
  const block = res?.content?.[0];
  ok(!res?.isError, `${label}: the call succeeded`);
  ok(block?.type === "image", `${label}: content[0] stays an image block (got ${block?.type})`);
  ok(block?.mimeType === "image/png", `${label}: mimeType is image/png (got ${block?.mimeType})`);
  ok(typeof block?.data === "string" && Buffer.from(block.data, "base64").equals(IMAGE), `${label}: the image bytes arrive intact`);
  ok(res?.structuredContent?.result?.headers === undefined, `${label}: no answer headers are invented`);
}

try {
  // Direct path.
  checkAudio(await call("free-audio"), "direct audio");
  checkImage(await call("free-image"), "direct image");
  ok(loopbackCalls.length === 0, "the direct path never touches the paid loopback");

  // Paid loopback path.
  const paidAudio = await call("paid-audio");
  checkAudio(paidAudio, "loopback audio");
  ok(paidAudio?._meta?.[MCP_RECEIPT_META]?.reference === "0x" + "ab".repeat(32), "loopback audio: the payment receipt rides in _meta");
  const paidImage = await call("paid-image");
  checkImage(paidImage, "loopback image");
  ok(paidImage?._meta?.[MCP_RECEIPT_META]?.status === "success", "loopback image: the payment receipt rides in _meta");
  ok(loopbackCalls.length === 2 && loopbackCalls.every((c) => c.method === "POST"), `both paid calls went through the loopback fetch (got ${loopbackCalls.length})`);
  ok(loopbackCalls.some((c) => c.url.endsWith("/api/paid-audio")) && loopbackCalls.some((c) => c.url.endsWith("/api/paid-image")), "the loopback called each tool's own route");
} finally {
  try { await client.close(); } catch { /* closed */ }
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
