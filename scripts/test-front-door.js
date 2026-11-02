#!/usr/bin/env node
// The front door leads every machine surface, says the same thing on each,
// quotes the catalog's own price and scopes every recovery sentence.
//
// Boots this tree in paid mode against a stub facilitator (one rail, nothing
// settles) and reads: /llms.txt, /agents.md, the MCP server.describe answer,
// the unpaid 402 (header and body), /openapi.json info and /.well-known/x402.
// Offline: no upstream is called; only free surfaces and unpaid 402s are read.
//
//   node scripts/test-front-door.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./lib/free-port.js";
import { BAZAAR_DESCRIPTIONS, isExamplePointer } from "../src/payments.js";
import { FRONT_DOOR_SLUG, AGENTS_MD_PATH } from "../src/front-door.js";
import { FLAGSHIP_MCP_NAMES } from "../src/mcp-flagship.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [PORT, FAC_PORT] = await getFreePorts(2);
const fac = createServer((req, res) => {
  res.writeHead(req.url === "/supported" ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.url === "/supported" ? { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} } : {}));
});
await new Promise((r) => fac.listen(FAC_PORT, "127.0.0.1", r));
const BASE_URL = "http://agent402.test";
const proc = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "", TARGET_URL: "", BASE_URL,
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    STATS_ALLOW_EPHEMERAL: "true", FRONT_DOOR_402: "", PAYMENT_REQUIRED_BODY: "",
    DECIDE_LEDGER_DB: join(mkdtempSync(join(tmpdir(), "front-door-")), "decide.db"),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
const errTail = [];
proc.stderr.on("data", (c) => { errTail.push(String(c)); if (errTail.length > 40) errTail.shift(); });
const stop = () => { try { proc.kill("SIGKILL"); } catch {} try { fac.close(); } catch {} };
process.on("exit", stop);
const B = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch {} if (!up) await sleep(500); }
if (!up) { console.log(`FAIL - the paid server booted (stderr: ${errTail.join("").slice(-800)})`); process.exit(1); }

const EM_DASH = /[—–]/;
const strip = (s) => String(s).replace(/`/g, "");

// The catalog's own price and route for the first call.
const pricing = await (await fetch(`${B}/api/pricing`)).json();
const row = (pricing.endpoints || []).find((e) => e.slug === FRONT_DOOR_SLUG);
ok(!!row && typeof row.price === "string" && /^\$\d/.test(row.price), `the catalog prices the first call (${FRONT_DOOR_SLUG}: ${row?.price})`);
const PRICE = row?.price;
const ROUTE = `${row?.method} ${row?.path}`;
const mcpName = FLAGSHIP_MCP_NAMES[FRONT_DOOR_SLUG];

/** The eight block lines, parsed from a markdown surface. */
const LABELS = ["First call", "Access", "Use when", "Do not use when", "If a call fails", "If an answer is lost", "To retry", "If a call is slow"];
function blockOf(md, label) {
  const at = md.indexOf("## Start here");
  ok(at >= 0, `${label}: carries the "## Start here" block`);
  // The heading, a blank line, then the list: the block ends at the next blank line.
  const end = md.indexOf("\n\n", at + "## Start here\n\n".length);
  const block = md.slice(at, end < 0 ? undefined : end);
  const lines = {};
  for (const l of block.split("\n")) { const m = l.match(/^- \*\*([^:*]+):\*\* (.*)$/); if (m) lines[m[1]] = m[2]; }
  ok(LABELS.every((k) => typeof lines[k] === "string" && lines[k].length > 20), `${label}: the block has all eight lines (${Object.keys(lines).join(", ")})`);
  return { at, block, lines };
}

/** Scope words each recovery sentence must carry (the place it holds). */
function assertRecoveryScope(label, rec) {
  ok(/x402/.test(rec[0]) && /under 400/.test(rec[0]) && /PAYMENT-RESPONSE/.test(rec[0]) && /Tempo push payment/.test(rec[0]) && /refund owed/.test(rec[0]),
    `${label}: the not-charged sentence is scoped to x402 and names the Tempo push exception`);
  ok(/EVM x402/.test(rec[1]) && /same signed payment/.test(rec[1]) && /replay window/.test(rec[1]) && /X-Replayed-Answer: 1/.test(rec[1]) && /identity-bound/.test(rec[1]) && /lasting effect/.test(rec[1]) && /streamed/.test(rec[1]),
    `${label}: the implicit replay is scoped to an EVM x402 payment, with its three exclusions`);
  ok(/Idempotency-Key/.test(rec[2]) && /same credential/.test(rec[2]) && /route and body/.test(rec[2]) && /first 200 answer/.test(rec[2]) && /\d+ MB/.test(rec[2]),
    `${label}: the explicit key is bound to the same credential, route and body, first 200 only, with its size cap`);
  ok(/slow route/.test(rec[3]) && /Prefer: respond-async/.test(rec[3]) && /\/api\/jobs\/\{id\}/.test(rec[3]) && /delivered answer/.test(rec[3]),
    `${label}: the async sentence is scoped to a slow route`);
}

function assertFirstCall(label, text) {
  ok(text.includes(PRICE), `${label}: the first call quotes the catalog price ${PRICE}`);
  ok(strip(text).includes(`${row.method} ${BASE_URL}${row.path}?q=`), `${label}: ...and the catalog route ${ROUTE}`);
  ok(text.startsWith(mcpName), `${label}: ...named by its MCP name ${mcpName}`);
  const priced = [...text.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => `$${m[1]}`);
  const catalogPrices = new Set((pricing.endpoints || []).map((e) => e.price));
  ok(priced.length >= 1 && priced.every((p) => catalogPrices.has(p)), `${label}: every price in the first-call line is a catalog price (${priced.join(", ")})`);
}

// 1. /llms.txt: the block sits right under the title, ahead of the summary and every wire section.
const llmsRes = await fetch(`${B}/llms.txt`);
const llms = await llmsRes.text();
ok(llmsRes.status === 200, "/llms.txt answers 200");
ok(llms.startsWith("# Agent402.Tools\n\n## Start here\n"), "/llms.txt: the block is the first thing under the title");
const L = blockOf(llms, "/llms.txt");
for (const wire of ["> Pay-per-call", "PAYMENT-REQUIRED and MPP", "## Settlement chains", "## Connect via MCP"]) {
  const i = llms.indexOf(wire);
  ok(i > L.at + L.block.length, `/llms.txt: "${wire}" comes after the block (rails and wire detail below it)`);
}
assertFirstCall("/llms.txt", L.lines["First call"]);
assertRecoveryScope("/llms.txt", LABELS.slice(4).map((k) => L.lines[k]));
ok(!EM_DASH.test(L.block), "/llms.txt: no em or en dash in the block");
ok(llms.includes(`${BASE_URL}${AGENTS_MD_PATH}`), "/llms.txt links /agents.md");
ok(Buffer.byteLength(llms) < 16_384, `/llms.txt stays a short index (${Buffer.byteLength(llms)} bytes)`);

// 2. /agents.md: markdown, free, the block before Connect and Pay.
const agentsRes = await fetch(`${B}${AGENTS_MD_PATH}`);
const agents = await agentsRes.text();
ok(agentsRes.status === 200 && /^text\/markdown/.test(agentsRes.headers.get("content-type") || ""), `${AGENTS_MD_PATH} answers 200 as text/markdown (${agentsRes.status}, ${agentsRes.headers.get("content-type")})`);
const A = blockOf(agents, AGENTS_MD_PATH);
ok(agents.indexOf("\n## ") === A.at - 1, `${AGENTS_MD_PATH}: the block is the first section`);
ok(A.at < agents.indexOf("## Connect") && A.at < agents.indexOf("## Pay"), `${AGENTS_MD_PATH}: the block comes before Connect and Pay`);
ok(A.block === L.block, `${AGENTS_MD_PATH}: the block is the same text /llms.txt leads with`);
ok(!EM_DASH.test(agents), `${AGENTS_MD_PATH}: no em or en dash anywhere`);
const sitemap = await (await fetch(`${B}/sitemap.xml`)).text();
ok(sitemap.includes(`${BASE_URL}${AGENTS_MD_PATH}`), "the sitemap lists /agents.md");
const robots = await (await fetch(`${B}/robots.txt`)).text();
ok(robots.includes(`${BASE_URL}${AGENTS_MD_PATH}`) && !new RegExp(`Disallow:\\s*${AGENTS_MD_PATH}`).test(robots), "robots.txt names /agents.md and never disallows it");

// 3. MCP server.describe: frontDoor is the first key, same sentences.
const mcpRes = await fetch(`${B}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "server.describe", arguments: {} } }),
});
const mcpText = await mcpRes.text();
const rpc = (mcpRes.headers.get("content-type") || "").startsWith("text/event-stream")
  ? JSON.parse(mcpText.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""))
  : JSON.parse(mcpText);
const about = rpc.result?.structuredContent || JSON.parse(rpc.result?.content?.[0]?.text || "{}");
ok(Object.keys(about)[0] === "frontDoor", `server.describe: frontDoor is the first key (${Object.keys(about).slice(0, 3).join(",")})`);
ok(typeof about.service === "string" && typeof about.startHere === "object" && typeof about.install === "object", "server.describe: the rest of the contract is intact (service, startHere, install)");
const fd = about.frontDoor || {};
assertFirstCall("server.describe", fd.firstCall || "");
assertRecoveryScope("server.describe", fd.recovery || []);
ok(fd.access === strip(L.lines.Access) && fd.useWhen === strip(L.lines["Use when"]) && fd.doNotUseWhen === strip(L.lines["Do not use when"]),
  "server.describe: access and use lines are the /llms.txt sentences");
ok((fd.recovery || []).every((r, i) => r === strip(L.lines[LABELS[4 + i]])), "server.describe: the four recovery sentences are the /llms.txt sentences");
ok(fd.guide === `${BASE_URL}${AGENTS_MD_PATH}`, "server.describe: the guide points at /agents.md");
ok(!EM_DASH.test(JSON.stringify(fd)), "server.describe: no em or en dash in frontDoor");

// 4. The unpaid 402: body leads with the block, the header carries none of it.
const decode = (r) => { const h = r.headers.get("payment-required"); return h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null; };
{
  const r = await fetch(`${B}${row.path}?q=test`);
  const body = JSON.parse(await r.text());
  const hdr = decode(r);
  ok(r.status === 402 && !!hdr, `unpaid ${ROUTE} -> 402 with PAYMENT-REQUIRED (${r.status})`);
  ok(Object.keys(body)[0] === "frontDoor", `402 body: frontDoor is the first key on a wallet-only route (${Object.keys(body).slice(0, 3).join(",")})`);
  ok(JSON.stringify(body.frontDoor) === JSON.stringify({ access: fd.access, recovery: fd.recovery, guide: fd.guide }), "402 body: access, the four recovery sentences and the guide are the server.describe ones");
  ok(!JSON.stringify(hdr).includes("frontDoor") && !JSON.stringify(hdr).includes("Idempotency-Key"), "402 header: carries no front-door text (the challenge does not grow)");
  ok(Array.isArray(body.accepts) && body.accepts.length > 0 && body.x402Version === hdr.x402Version, "402 body: the offer is still mirrored");
  ok(hdr.resource?.description === BAZAAR_DESCRIPTIONS[FRONT_DOOR_SLUG], "402 header: the listing description is the curated copy, untrimmed");
}
{
  const r = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  const body = JSON.parse(await r.text());
  ok(r.status === 402 && Object.keys(body)[0] === "altPayment" && Object.keys(body)[1] === "frontDoor", `402 body on a proof-of-work tool: altPayment stays first, frontDoor next (${Object.keys(body).slice(0, 3).join(",")})`);
}
{
  // A refused payment keeps its own explanation: no block.
  const bogus = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "lightning", network: "eip155:8453" }, payload: {} })).toString("base64");
  const r = await fetch(`${B}${row.path}?q=test`, { headers: { "payment-signature": bogus } });
  const text = await r.text();
  let body = {}; try { body = JSON.parse(text); } catch {}
  ok(r.status === 402 && !("frontDoor" in body), `a refused payment's 402 carries no frontDoor (${r.status})`);
  const p = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json", "x-pow-solution": "bad:1" }, body: JSON.stringify({ text: "x" }) });
  let pb = {}; try { pb = JSON.parse(await p.text()); } catch {}
  ok(!("frontDoor" in pb), `a refused proof-of-work's answer carries no frontDoor (${p.status})`);
}

// 5. Bazaar listings of the front-door flagships: curated copy and a full sample output.
for (const slug of ["search", "answer", "search-news", "render"]) {
  const e = (pricing.endpoints || []).find((x) => x.slug === slug);
  const r = await fetch(`${B}${e.path}${e.method === "GET" ? "?q=test" : ""}`, e.method === "GET" ? {} : { method: e.method, headers: { "content-type": "application/json" }, body: "{}" });
  const hdr = decode(r);
  const info = hdr?.extensions?.bazaar?.info;
  ok(hdr?.resource?.description === BAZAAR_DESCRIPTIONS[slug] && /^One call (returns|loads)/.test(BAZAAR_DESCRIPTIONS[slug]), `${slug}: the listing says what one call gets, untrimmed`);
  const ex = info?.output?.example;
  ok(ex && !isExamplePointer(ex), `${slug}: the listing carries the full sample output, not the pointer`);
  if (Array.isArray(ex?.results)) ok(ex.results.length === ex.count && ex.count > 1, `${slug}: the sample's count matches its results (${ex.count} vs ${ex.results.length})`);
}

// 6. Origin-level descriptions lead with the first call.
const openapi = await (await fetch(`${B}/openapi.json`)).json();
ok(String(openapi.info?.description || "").startsWith(`Start here: ${ROUTE}?q=`) && openapi.info.description.includes(`${PRICE} a call`), "openapi info.description leads with the first call at the catalog price");
const manifest = await (await fetch(`${B}/.well-known/x402`)).json();
ok(String(manifest.summary || "").startsWith(`Start here: ${ROUTE}?q=`) && manifest.summary.includes(`${PRICE} a call`), "/.well-known/x402 summary leads with the first call at the catalog price");
ok(!EM_DASH.test(openapi.info.description.slice(0, 300)) && !EM_DASH.test(manifest.summary.slice(0, 300)), "no em or en dash in either lead sentence");

stop();
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
