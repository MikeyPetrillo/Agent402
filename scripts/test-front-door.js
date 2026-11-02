#!/usr/bin/env node
// The front door leads every machine surface in three lines, says the same
// thing on each, quotes the catalog's own price and free-tier count, keeps
// the recovery lines on /agents.md under their own heading, and offers the
// first-call allowance only while its switch is on.
//
// Part 1 renders the block in-process from a synthetic catalog (the price,
// the free-tier count and the allowance clause must follow their sources).
// Part 2 boots this tree twice in paid mode against a stub facilitator (one
// rail, nothing settles), FIRST_CALL_ALLOWANCE off and then on, and reads:
// /llms.txt, /agents.md, the MCP server.describe answer, the unpaid 402
// (header and body), /openapi.json info and /.well-known/x402.
// Offline: no upstream is called; only free surfaces and unpaid 402s are read.
//
//   node scripts/test-front-door.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./lib/free-port.js";
import { BAZAAR_DESCRIPTIONS, isExamplePointer } from "../src/payments.js";
import {
  FRONT_DOOR_SLUG, AGENTS_MD_PATH, POW_LIST_PATH, RECOVERY_HEADING, RECOVERY_ANCHOR, FIRST_CALL_FREE_COPY,
  LATE_SETTLE_EXCEPTION, frontDoorMarkdown, frontDoorJson, frontDoor402Json, agentsMd, paidWiresPhrase,
} from "../src/front-door.js";
import { RAILS } from "../src/rails.js";
import { FLAGSHIP_MCP_NAMES } from "../src/mcp-flagship.js";
import { isComputePayable } from "../src/pow.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { firstCallAllowanceEnabled } from "../src/first-call-allowance.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EM_DASH = /[—–]/;
const strip = (s) => String(s).replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
/** Words that belong to the recovery lines: none of them may sit in the three-line block. */
const RECOVERY_WORDS = /If a call fails|If an answer is lost|To retry|If a call is slow|PAYMENT-RESPONSE|X-Replayed-Answer|Idempotency-Key|Prefer: respond-async|\/api\/jobs/;
const LABELS = ["First call", "Access", "Use when"];
const RECOVERY_LABELS = ["If a call fails", "If an answer is lost", "To retry", "If a call is slow"];

/** A labeled bullet list under a "## heading", up to the next blank line. */
function listOf(md, heading, label, labels) {
  const at = md.indexOf(`## ${heading}\n`);
  ok(at >= 0, `${label}: carries the "## ${heading}" block`);
  const end = md.indexOf("\n\n", at + `## ${heading}\n\n`.length);
  const block = md.slice(at, end < 0 ? undefined : end);
  const lines = {};
  const order = [];
  for (const l of block.split("\n")) { const m = l.match(/^- \*\*([^:*]+):\*\* (.*)$/); if (m) { lines[m[1]] = m[2]; order.push(m[1]); } }
  ok(order.length === labels.length && labels.every((k, i) => order[i] === k && lines[k].length > 20), `${label}: "${heading}" is exactly ${labels.length} lines (${order.join(", ")})`);
  return { at, block, lines };
}

/** Scope words each recovery sentence must carry (the place it holds). */
function assertRecoveryScope(label, rec, { tempo = false } = {}) {
  ok(/x402/.test(rec[0]) && /under 400/.test(rec[0]) && /PAYMENT-RESPONSE/.test(rec[0]) && rec[0].includes(LATE_SETTLE_EXCEPTION),
    `${label}: the not-charged sentence is scoped to x402 and names the late-settle exception`);
  ok(/Tempo push payment/.test(rec[0]) === tempo, `${label}: the Tempo push exception appears only while Tempo is offered (${tempo ? "on" : "off"})`);
  ok(/EVM x402/.test(rec[1]) && /same signed payment/.test(rec[1]) && /replay window/.test(rec[1]) && /X-Replayed-Answer: 1/.test(rec[1]) && /identity-bound/.test(rec[1]) && /lasting effect/.test(rec[1]) && /streamed/.test(rec[1]),
    `${label}: the implicit replay is scoped to an EVM x402 payment, with its three exclusions`);
  ok(/Idempotency-Key/.test(rec[2]) && /same credential/.test(rec[2]) && /route and body/.test(rec[2]) && /first 200 answer/.test(rec[2]) && /\d+ MB/.test(rec[2]),
    `${label}: the explicit key is bound to the same credential, route and body, first 200 only, with its size cap`);
  ok(/slow route/.test(rec[3]) && /Prefer: respond-async/.test(rec[3]) && /\/api\/jobs\/\{id\}/.test(rec[3]) && /delivered answer/.test(rec[3]),
    `${label}: the async sentence is scoped to a slow route`);
}

/** The access line: no account or key, the free tier first with its count and
 *  where it is listed, then the paid wires (scoped to Tempo's own coins). */
function assertAccess(label, text, powCount, wires) {
  const t = strip(text);
  ok(/^No account, no API key\./.test(t), `${label}: access opens with no account and no API key`);
  ok(t.includes(`${powCount} pure-CPU tools run free with proof-of-work and no wallet`), `${label}: access leads with the free tier at its derived count (${powCount})`);
  ok(t.includes(`GET ${POW_LIST_PATH}`), `${label}: access says where the free tools are listed (${POW_LIST_PATH})`);
  ok(t.indexOf("proof-of-work") < t.indexOf("x402") && t.includes(`paid per call in ${wires}, quoted in the 402 before you pay`),
    `${label}: then pay per call in ${wires}, quoted before payment`);
}

// ---------------------------------------------------------------------------
// Part 1: in-process, a synthetic catalog. The price, the free-tier count and
// the allowance clause follow their sources, so a typed value fails here.
{
  const saved = { on: process.env.FIRST_CALL_ALLOWANCE, max: process.env.FIRST_CALL_ALLOWANCE_MAX_USD, slugs: process.env.FIRST_CALL_ALLOWANCE_SLUGS };
  const free = [...FREE_TIER_SLUGS].filter((slug) => isComputePayable({ slug })).slice(0, 4);
  const cat = (nFree, searchPrice) => {
    const c = {
      [`GET /api/${FRONT_DOOR_SLUG}`]: { slug: FRONT_DOOR_SLUG, price: searchPrice },
      "GET /api/answer": { slug: "answer", price: "$0.5", modelBacked: true },
    };
    for (const slug of free.slice(0, nFree)) c[`POST /api/${slug}`] = { slug, price: "$0.001" };
    return c;
  };
  const B = "http://unit.test";
  delete process.env.FIRST_CALL_ALLOWANCE; delete process.env.FIRST_CALL_ALLOWANCE_SLUGS; delete process.env.FIRST_CALL_ALLOWANCE_MAX_USD;
  const a = frontDoorMarkdown(cat(3, "$0.777"), B);
  const b = frontDoorMarkdown(cat(4, "$0.333"), B);
  ok(a.includes("$0.777 per call") && b.includes("$0.333 per call"), "unit: the first-call price is the catalog's, whatever it is");
  ok(a.includes("3 pure-CPU tools") && b.includes("4 pure-CPU tools"), "unit: the free-tier count follows the catalog's proof-of-work tools");
  ok(!firstCallAllowanceEnabled(), "unit: the allowance switch reads off with FIRST_CALL_ALLOWANCE unset");
  const offSurfaces = [a, agentsMd(B, cat(3, "$0.777")), JSON.stringify(frontDoorJson(cat(3, "$0.777"), B)), JSON.stringify(frontDoor402Json(cat(3, "$0.777"), B))];
  ok(offSurfaces.every((s) => !FIRST_CALL_FREE_COPY.test(s)), "unit: switch off, no surface offers a free first call");
  process.env.FIRST_CALL_ALLOWANCE = "on"; process.env.FIRST_CALL_ALLOWANCE_SLUGS = `${FRONT_DOOR_SLUG},answer`; process.env.FIRST_CALL_ALLOWANCE_MAX_USD = "0.9";
  const catOn = cat(3, "$0.777");
  const on = frontDoorMarkdown(catOn, B);
  ok(firstCallAllowanceEnabled() && FIRST_CALL_FREE_COPY.test(on), "unit: switch on, the access line offers the free first call");
  ok(on.includes(`to ${FLAGSHIP_MCP_NAMES[FRONT_DOOR_SLUG]} or ${FLAGSHIP_MCP_NAMES.answer} (at or under $0.90)`), "unit: the clause names the eligible tools and the cap from the allowance config");
  ok([agentsMd(B, catOn), JSON.stringify(frontDoorJson(catOn, B)), JSON.stringify(frontDoor402Json(catOn, B))].every((s) => FIRST_CALL_FREE_COPY.test(s)), "unit: switch on, agents.md, the JSON block and the 402 part carry the clause (the JSON memo follows the switch)");
  ok(agentsMd(B, catOn).includes("nor for a free first call (a re-send of its payment inside the replay window is refused and not charged)"), "unit: switch on, the replay line excludes a free first call");
  process.env.FIRST_CALL_ALLOWANCE_MAX_USD = "0.6";
  const capped = frontDoorMarkdown(catOn, B);
  ok(capped.includes(`to ${FLAGSHIP_MCP_NAMES.answer} (at or under $0.60)`) && !new RegExp(`call to [^(]*${FLAGSHIP_MCP_NAMES[FRONT_DOOR_SLUG].replace(".", "\\.")}`).test(capped), "unit: a tool over the cap is left out of the clause");
  process.env.FIRST_CALL_ALLOWANCE = "off";
  ok(!agentsMd(B, catOn).includes("free first call (a re-send"), "unit: switch off, the replay line does not mention a free first call");
  ok(!FIRST_CALL_FREE_COPY.test(frontDoorMarkdown(catOn, B)) && !FIRST_CALL_FREE_COPY.test(JSON.stringify(frontDoorJson(catOn, B))), "unit: switch back off, the clause is gone from markdown and the memoized JSON");
  for (const [k, v] of [["FIRST_CALL_ALLOWANCE", saved.on], ["FIRST_CALL_ALLOWANCE_MAX_USD", saved.max], ["FIRST_CALL_ALLOWANCE_SLUGS", saved.slugs]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

// ---------------------------------------------------------------------------
// Part 1b: the access line names coins and wires from the live config.
{
  const keys = ["MPP_SECRET_KEY", "TEMPO_API_KEY", "TEMPO_RECIPIENT_ADDRESS", "WALLET_ADDRESS", "TEMPO_RELAY", "STRIPE_SECRET_KEY", "NETWORK", "PAYMENT_NETWORKS", "TEMPO_CURRENCY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  const B = "http://unit.test";
  const c = { [`GET /api/${FRONT_DOOR_SLUG}`]: { slug: FRONT_DOOR_SLUG, price: "$0.01" } };
  const others = RAILS.filter((r) => r.asset !== "USDC");
  const coins = others.length ? `stablecoins (USDC, and ${others.map((r) => `${r.asset} on ${r.name}`).join(" and ")})` : "USDC";
  ok(paidWiresPhrase() === `${coins} over x402`, `unit: MPP off, the access line says ${coins} over x402 (${paidWiresPhrase()})`);
  const offAccess = frontDoorJson(c, B).access;
  ok(!/MPP|Tempo/.test(offAccess) && offAccess.includes(`in ${coins} over x402,`), "unit: MPP off, the access line names neither MPP nor Tempo");
  ok(others.every((r) => offAccess.includes(`${r.asset} on ${r.name}`)), "unit: every non-USDC rail's coin is named on its chain");
  const offAgents = agentsMd(B, c);
  ok(offAgents.includes("the x402 offer (`PAYMENT-REQUIRED`)") && !offAgents.includes("both offers"), "unit: MPP off, /agents.md Connect names the x402 offer only");
  const { llmsTxt } = await import("../src/seo.js");
  const llmsSummary = () => llmsTxt(B, c).split("\n").find((l) => l.startsWith("> ")) || "";
  { const s = llmsSummary(); ok(s.includes("payable over **x402** ") && !/MPP/.test(s), "unit: MPP off, the llms.txt summary names x402 only"); }
  process.env.MPP_SECRET_KEY = "unit";
  ok(paidWiresPhrase() === `${coins} over x402 or MPP`, `unit: MPP on, the access line adds MPP (${paidWiresPhrase()})`);
  ok(frontDoorJson(c, B).access.includes(`in ${coins} over x402 or MPP,`), "unit: MPP on, the memoized JSON follows the switch");
  const onAgents = agentsMd(B, c);
  ok(onAgents.includes("both offers (x402 `PAYMENT-REQUIRED` and MPP `WWW-Authenticate: Payment`)"), "unit: MPP on, /agents.md Connect names both offers (the memo follows the switch)");
  ok(!/Tempo push payment/.test(onAgents), "unit: MPP on without Tempo, no Tempo push sentence");
  { const s = llmsSummary(); ok(s.includes("**x402 or MPP**") && /both offers/.test(s) && /MPP on Base[^)]*\(USDC\)/.test(s) && !/Tempo/.test(s), "unit: MPP on (EVM), the llms.txt summary names MPP and its EVM rails, not Tempo"); }
  process.env.TEMPO_API_KEY = "unit"; process.env.TEMPO_RECIPIENT_ADDRESS = "0x000000000000000000000000000000000000dEaD";
  const tempoAgents = agentsMd(B, c);
  ok(paidWiresPhrase().includes("Tempo"), "unit: a relay key and a recipient turn Tempo on");
  {
    ok(paidWiresPhrase() === `${coins} over x402 or MPP (Tempo settles in its own stablecoins)`, "unit: Tempo on, the access line scopes Tempo's own coins");
    ok(/Tempo push payment/.test(tempoAgents), "unit: Tempo on, the recovery line names the Tempo push exception");
    ok(/or Tempo \(PathUSD, native\)/.test(llmsSummary()), "unit: Tempo on (its default currency, PathUSD), the llms.txt summary names Tempo with PathUSD");
    process.env.TEMPO_CURRENCY = "usdc,pathusd";
    ok(/or Tempo \(USDC\.e or PathUSD, native\)/.test(llmsSummary()), "unit: Tempo on with USDC.e and PathUSD configured, the llms.txt summary names both");
  }
  ok(offAgents.includes(`When a call fails: [${AGENTS_MD_PATH}](${RECOVERY_ANCHOR})`) && RECOVERY_ANCHOR === "#when-a-call-fails", `unit: /agents.md links its own recovery heading by fragment (${RECOVERY_ANCHOR})`);
  ok(offAgents.includes(`## ${RECOVERY_HEADING}\n`), "unit: the fragment's heading is on the page");
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
}

// ---------------------------------------------------------------------------
// Part 1c: the class. Any copy that says no PAYMENT-RESPONSE means nothing
// settled (or not charged) carries the late-settle exception right after it.
{
  const CLAIM = /\bno\s*\*{0,2}\s*(?:\$\{\w+\(["'])?\\?`?PAYMENT-RESPONSE\\?`?(?:["']\)\})?\s*(?:header)?\s*\*{0,2}\s*(?:=|means|-)\s*(?:nothing settled|you were not charged)/gi;
  const EXC = /timed-out settle, or a disconnect during settle, is booked\s+as a refund owed and repaid after on-chain proof|a transfer that lands after a timed-out settle[^.]*booked as a refund owed and repaid after on-chain proof|\$\{LATE_SETTLE_EXCEPTION\}/;
  const files = [];
  const walk = (dir) => { if (!existsSync(dir)) return; for (const n of readdirSync(dir)) { const f = join(dir, n); const st = statSync(f); if (st.isDirectory()) { if (n !== "node_modules" && n !== "generated") walk(f); } else if (/\.(js|mjs|md|txt)$/.test(n)) files.push(f); } };
  for (const d of ["src", "wiki", "docs"]) walk(join(ROOT, d));
  for (const f of ["README.md", "mcp/README.md", "mcp/index.js", "client/README.md", "tollbooth/README.md", "openclaw/README.md"]) if (existsSync(join(ROOT, f))) files.push(join(ROOT, f));
  let claims = 0;
  const bare = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(CLAIM)) {
      claims++;
      const after = text.slice(m.index, m.index + m[0].length + 700).replace(/\\?\n\s*/g, " ");
      if (!EXC.test(after)) bare.push(`${f.slice(ROOT.length + 1)}:${text.slice(0, m.index).split("\n").length}`);
    }
  }
  ok(claims >= 5, `class: the no-receipt claim is found where it is made (${claims} places)`);
  ok(bare.length === 0, `class: every no-receipt claim carries the late-settle exception${bare.length ? ` (missing: ${bare.join(", ")})` : ""}`);
}

// ---------------------------------------------------------------------------
// Part 2: two paid boots.
const [FAC_PORT] = await getFreePorts(1);
const fac = createServer((req, res) => {
  res.writeHead(req.url === "/supported" ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.url === "/supported" ? { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} } : {}));
});
await new Promise((r) => fac.listen(FAC_PORT, "127.0.0.1", r));
const BASE_URL = "http://agent402.test";
let proc = null;
const stopProc = () => { try { proc?.kill("SIGKILL"); } catch {} proc = null; };
process.on("exit", () => { stopProc(); try { fac.close(); } catch {} });

async function boot(extraEnv) {
  const [PORT] = await getFreePorts(1);
  const TMP = mkdtempSync(join(tmpdir(), "front-door-"));
  proc = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), FREE_MODE: "", TARGET_URL: "", BASE_URL,
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      STATS_ALLOW_EPHEMERAL: "true", FRONT_DOOR_402: "", PAYMENT_REQUIRED_BODY: "",
      FIRST_CALL_ALLOWANCE: "", FIRST_CALL_ALLOWANCE_SLUGS: "", FIRST_CALL_ALLOWANCE_MAX_USD: "",
      DECIDE_LEDGER_DB: join(TMP, "decide.db"),
      AGENT402_TASK_DATA_DIR: join(TMP, "tasks"), REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errTail = [];
  proc.stderr.on("data", (c) => { errTail.push(String(c)); if (errTail.length > 40) errTail.shift(); });
  const B = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch {} if (!up) await sleep(500); }
  if (!up) { console.log(`FAIL - the paid server booted (stderr: ${errTail.join("").slice(-800)})`); process.exit(1); }
  return B;
}

const decode = (r) => { const h = r.headers.get("payment-required"); return h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null; };

async function describeOf(B) {
  const mcpRes = await fetch(`${B}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "server.describe", arguments: {} } }),
  });
  const mcpText = await mcpRes.text();
  const rpc = (mcpRes.headers.get("content-type") || "").startsWith("text/event-stream")
    ? JSON.parse(mcpText.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""))
    : JSON.parse(mcpText);
  return rpc.result?.structuredContent || JSON.parse(rpc.result?.content?.[0]?.text || "{}");
}

/** Every surface of one boot; returns the texts the switch checks read. */
async function readSurfaces(B, tag, { mpp = false } = {}) {
  const wires = `${RAILS.some((r) => r.asset !== "USDC") ? `stablecoins (USDC, and ${RAILS.filter((r) => r.asset !== "USDC").map((r) => `${r.asset} on ${r.name}`).join(" and ")})` : "USDC"} over x402${mpp ? " or MPP" : ""}`;
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const row = (pricing.endpoints || []).find((e) => e.slug === FRONT_DOOR_SLUG);
  ok(!!row && typeof row.price === "string" && /^\$\d/.test(row.price), `${tag}: the catalog prices the first call (${FRONT_DOOR_SLUG}: ${row?.price})`);
  const PRICE = row?.price;
  const ROUTE = `${row?.method} ${row?.path}`;
  const mcpName = FLAGSHIP_MCP_NAMES[FRONT_DOOR_SLUG];
  const pow = await (await fetch(`${B}${POW_LIST_PATH}`)).json();
  const powCount = Array.isArray(pow.eligibleTools) ? pow.eligibleTools.length : -1;
  ok(powCount > 0, `${tag}: ${POW_LIST_PATH} lists the proof-of-work tools (${powCount})`);

  const assertFirstCall = (label, text) => {
    ok(text.includes(`${PRICE} per call`), `${label}: the first call quotes the catalog price ${PRICE}`);
    ok(strip(text).includes(`${row.method} ${BASE_URL}${row.path}?q=`), `${label}: ...and the catalog route ${ROUTE}`);
    ok(text.startsWith(mcpName), `${label}: ...named by its MCP name ${mcpName}`);
    const priced = [...text.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => `$${m[1]}`);
    const catalogPrices = new Set((pricing.endpoints || []).map((e) => e.price));
    ok(priced.length >= 1 && priced.every((p) => catalogPrices.has(p)), `${label}: every price in the first-call line is a catalog price (${priced.join(", ")})`);
  };
  const assertUse = (label, text) => {
    const t = strip(text);
    ok(/^You need live web data/.test(t) && /; not when you already hold the URL/.test(t) && /local computation/.test(t), `${label}: use when and do not use when share one line`);
    ok(t.endsWith(`When a call fails: ${AGENTS_MD_PATH}.`), `${label}: the use line points at ${AGENTS_MD_PATH} for failures`);
  };

  // /llms.txt: title, summary blockquote, then the three lines, then the rest.
  const llmsRes = await fetch(`${B}/llms.txt`);
  const llms = await llmsRes.text();
  ok(llmsRes.status === 200, `${tag} /llms.txt answers 200`);
  ok(/^# Agent402\.Tools\n\n> [^\n]+\n\nBase URL: [^\n]+\n\nThe full text[^\n]+\n\n## Start here\n\n- \*\*First call:\*\*/.test(llms), `${tag} /llms.txt: title, summary blockquote, the pre-H2 paragraphs (base URL, full text), then the three lines under the first H2`);
  ok(llms.indexOf("\n## ") === llms.indexOf("\n## Start here"), `${tag} /llms.txt: "## Start here" is the first H2`);
  const L = listOf(llms, "Start here", `${tag} /llms.txt`, LABELS);
  for (const wire of ["## Settlement chains", "## Connect via MCP"]) {
    ok(llms.indexOf(wire) > L.at + L.block.length, `${tag} /llms.txt: "${wire}" comes after the block`);
  }
  assertFirstCall(`${tag} /llms.txt`, L.lines["First call"]);
  assertAccess(`${tag} /llms.txt`, L.lines.Access, powCount, wires);
  assertUse(`${tag} /llms.txt`, L.lines["Use when"]);
  ok(L.lines["Use when"].includes(`[${AGENTS_MD_PATH}](${BASE_URL}${AGENTS_MD_PATH}${RECOVERY_ANCHOR})`), `${tag} /llms.txt: the use line links ${AGENTS_MD_PATH}${RECOVERY_ANCHOR}`);
  ok(!RECOVERY_WORDS.test(llms.slice(0, L.at + L.block.length)) && !llms.includes(`## ${RECOVERY_HEADING}`), `${tag} /llms.txt: no recovery line at the top (they live on ${AGENTS_MD_PATH})`);
  ok(!EM_DASH.test(L.block), `${tag} /llms.txt: no em or en dash in the block`);
  ok(Buffer.byteLength(llms) < 16_384, `${tag} /llms.txt stays a short index (${Buffer.byteLength(llms)} bytes)`);

  // /agents.md: the same three lines first, then the recovery heading, then Connect and Pay.
  const agentsRes = await fetch(`${B}${AGENTS_MD_PATH}`);
  const agents = await agentsRes.text();
  ok(agentsRes.status === 200 && /^text\/markdown/.test(agentsRes.headers.get("content-type") || ""), `${tag} ${AGENTS_MD_PATH} answers 200 as text/markdown`);
  const A = listOf(agents, "Start here", `${tag} ${AGENTS_MD_PATH}`, LABELS);
  ok(agents.indexOf("\n## ") === A.at - 1, `${tag} ${AGENTS_MD_PATH}: the block is the first section`);
  ok(A.block === L.block.replace(`(${BASE_URL}${AGENTS_MD_PATH}${RECOVERY_ANCHOR})`, `(${RECOVERY_ANCHOR})`), `${tag} ${AGENTS_MD_PATH}: the block is the same text /llms.txt carries, its failure link a fragment on the page itself`);
  ok(!agents.includes(`](${BASE_URL}${AGENTS_MD_PATH})`), `${tag} ${AGENTS_MD_PATH}: never links to itself by URL`);
  const R = listOf(agents, RECOVERY_HEADING, `${tag} ${AGENTS_MD_PATH}`, RECOVERY_LABELS);
  ok(R.at > A.at && R.at < agents.indexOf("## Connect") && agents.indexOf("## Connect") < agents.indexOf("## Pay"), `${tag} ${AGENTS_MD_PATH}: "${RECOVERY_HEADING}" follows the block, ahead of Connect and Pay`);
  assertRecoveryScope(`${tag} ${AGENTS_MD_PATH}`, RECOVERY_LABELS.map((k) => R.lines[k]));
  ok(mpp ? agents.includes("both offers (x402") : agents.includes("the x402 offer (`PAYMENT-REQUIRED`)") && !agents.includes("both offers"), `${tag} ${AGENTS_MD_PATH}: Connect names ${mpp ? "both offers" : "the x402 offer only"}`);
  ok(!EM_DASH.test(agents), `${tag} ${AGENTS_MD_PATH}: no em or en dash anywhere`);

  // MCP server.describe: frontDoor first, the same three sentences and the guide.
  const about = await describeOf(B);
  ok(Object.keys(about)[0] === "frontDoor", `${tag} server.describe: frontDoor is the first key`);
  ok(typeof about.service === "string" && typeof about.startHere === "object" && typeof about.install === "object", `${tag} server.describe: the rest of the contract is intact`);
  ok(typeof about.startHere?.firstJob === "string" && about.startHere.firstJob.startsWith(about.frontDoor?.firstCall || "\u0000"), `${tag} server.describe: startHere.firstJob opens with the frontDoor first call (one first-call answer)`);
  const fd = about.frontDoor || {};
  ok(JSON.stringify(Object.keys(fd)) === JSON.stringify(["firstCall", "access", "use", "guide"]), `${tag} server.describe: frontDoor is the three lines and the guide (${Object.keys(fd).join(",")})`);
  ok(fd.firstCall === strip(L.lines["First call"]) && fd.access === strip(L.lines.Access) && fd.use === strip(L.lines["Use when"]), `${tag} server.describe: the three sentences are the /llms.txt sentences`);
  ok(fd.guide === `${BASE_URL}${AGENTS_MD_PATH}`, `${tag} server.describe: the guide points at ${AGENTS_MD_PATH}`);
  ok(!RECOVERY_WORDS.test(JSON.stringify(fd)) && !EM_DASH.test(JSON.stringify(fd)), `${tag} server.describe: no recovery line and no em or en dash in frontDoor`);

  // The unpaid 402: the access line and the guide lead the body; the header carries none of it.
  const r = await fetch(`${B}${row.path}?q=test`);
  const body402 = JSON.parse(await r.text());
  const hdr = decode(r);
  ok(r.status === 402 && !!hdr, `${tag} unpaid ${ROUTE} -> 402 with PAYMENT-REQUIRED (${r.status})`);
  ok(Object.keys(body402)[0] === "frontDoor", `${tag} 402 body: frontDoor is the first key on a wallet-only route`);
  ok(JSON.stringify(body402.frontDoor) === JSON.stringify({ access: fd.access, guide: fd.guide }), `${tag} 402 body: frontDoor is the access line and the guide`);
  ok(!JSON.stringify(hdr).includes("frontDoor") && !JSON.stringify(hdr).includes("pure-CPU"), `${tag} 402 header: carries no front-door text (the challenge does not grow)`);
  ok(Array.isArray(body402.accepts) && body402.accepts.length > 0 && body402.x402Version === hdr.x402Version, `${tag} 402 body: the offer is still mirrored`);
  return { pricing, row, PRICE, ROUTE, llms, agents, fd, body402, hdr, L };
}

// --- boot 1: FIRST_CALL_ALLOWANCE off -----------------------------------------
{
  const B = await boot({});
  const s = await readSurfaces(B, "off");
  const texts = { "/llms.txt": s.llms, [AGENTS_MD_PATH]: s.agents, "server.describe": JSON.stringify(s.fd), "402 body": JSON.stringify(s.body402) };
  for (const [where, text] of Object.entries(texts)) ok(!FIRST_CALL_FREE_COPY.test(text), `off: ${where} offers no free first call`);
  ok(s.hdr.resource?.description === BAZAAR_DESCRIPTIONS[FRONT_DOOR_SLUG], "402 header: the listing description is the curated copy, untrimmed");
  {
    const r = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
    const body = JSON.parse(await r.text());
    ok(r.status === 402 && Object.keys(body)[0] === "altPayment" && Object.keys(body)[1] === "frontDoor", `402 body on a proof-of-work tool: altPayment stays first, frontDoor next (${Object.keys(body).slice(0, 3).join(",")})`);
  }
  {
    // A refused payment keeps its own explanation: no block.
    const bogus = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "lightning", network: "eip155:8453" }, payload: {} })).toString("base64");
    const r = await fetch(`${B}${s.row.path}?q=test`, { headers: { "payment-signature": bogus } });
    let body = {}; try { body = JSON.parse(await r.text()); } catch {}
    ok(r.status === 402 && !("frontDoor" in body), `a refused payment's 402 carries no frontDoor (${r.status})`);
    const p = await fetch(`${B}/api/hash`, { method: "POST", headers: { "content-type": "application/json", "x-pow-solution": "bad:1" }, body: JSON.stringify({ text: "x" }) });
    let pb = {}; try { pb = JSON.parse(await p.text()); } catch {}
    ok(!("frontDoor" in pb), `a refused proof-of-work's answer carries no frontDoor (${p.status})`);
  }
  const sitemap = await (await fetch(`${B}/sitemap.xml`)).text();
  ok(sitemap.includes(`${BASE_URL}${AGENTS_MD_PATH}`), "the sitemap lists /agents.md");
  const robots = await (await fetch(`${B}/robots.txt`)).text();
  ok(robots.includes(`${BASE_URL}${AGENTS_MD_PATH}`) && !new RegExp(`Disallow:\\s*${AGENTS_MD_PATH}`).test(robots), "robots.txt names /agents.md and never disallows it");

  // Bazaar listings of the front-door flagships: curated copy and a full sample output.
  for (const slug of ["search", "answer", "search-news", "render"]) {
    const e = (s.pricing.endpoints || []).find((x) => x.slug === slug);
    const r = await fetch(`${B}${e.path}${e.method === "GET" ? "?q=test" : ""}`, e.method === "GET" ? {} : { method: e.method, headers: { "content-type": "application/json" }, body: "{}" });
    const hdr = decode(r);
    const info = hdr?.extensions?.bazaar?.info;
    ok(hdr?.resource?.description === BAZAAR_DESCRIPTIONS[slug] && /^One call (returns|loads)/.test(BAZAAR_DESCRIPTIONS[slug]), `${slug}: the listing says what one call gets, untrimmed`);
    const ex = info?.output?.example;
    ok(ex && !isExamplePointer(ex), `${slug}: the listing carries the full sample output, not the pointer`);
    if (Array.isArray(ex?.results)) ok(ex.results.length === ex.count && ex.count > 1, `${slug}: the sample's count matches its results (${ex.count} vs ${ex.results.length})`);
  }

  // Origin-level descriptions lead with the first call.
  const openapi = await (await fetch(`${B}/openapi.json`)).json();
  ok(String(openapi.info?.description || "").startsWith(`Start here: ${s.ROUTE}?q=`) && openapi.info.description.includes(`${s.PRICE} a call`), "openapi info.description leads with the first call at the catalog price");
  const manifest = await (await fetch(`${B}/.well-known/x402`)).json();
  ok(String(manifest.summary || "").startsWith(`Start here: ${s.ROUTE}?q=`) && manifest.summary.includes(`${s.PRICE} a call`), "/.well-known/x402 summary leads with the first call at the catalog price");
  ok(!EM_DASH.test(openapi.info.description.slice(0, 300)) && !EM_DASH.test(manifest.summary.slice(0, 300)), "no em or en dash in either lead sentence");
  ok(!FIRST_CALL_FREE_COPY.test(openapi.info.description) && !FIRST_CALL_FREE_COPY.test(manifest.summary), "off: neither origin description offers a free first call");
  stopProc();
}

// --- boot 2: FIRST_CALL_ALLOWANCE on, a non-default cap -------------------------
{
  const MAX_USD = "0.02";
  const B = await boot({ FIRST_CALL_ALLOWANCE: "on", FIRST_CALL_ALLOWANCE_MAX_USD: MAX_USD, MPP_SECRET_KEY: "front-door-test-mpp-secret" });
  const s = await readSurfaces(B, "on", { mpp: true });
  const texts = { "/llms.txt": s.llms, [AGENTS_MD_PATH]: s.agents, "server.describe": JSON.stringify(s.fd), "402 body": JSON.stringify(s.body402) };
  for (const [where, text] of Object.entries(texts)) ok(FIRST_CALL_FREE_COPY.test(text), `on: ${where} offers the free first call`);
  const access = strip(s.L.lines.Access);
  const m = access.match(/; a wallet's first EVM x402 call to (.+) \(at or under (\$[\d.]+)\) is free while the daily allowance lasts\.$/);
  ok(!!m, `on: the access line ends with one allowance clause, scoped to EVM x402 and the daily allowance (${access.slice(-200)})`);
  const cap = Number(MAX_USD);
  ok(m && Number(m[2].slice(1)) === cap, `on: the clause's cap is the configured FIRST_CALL_ALLOWANCE_MAX_USD (${m?.[2]})`);
  const named = m ? m[1].split(/, | or /) : [];
  const priceOf = (name) => {
    const slug = Object.keys(FLAGSHIP_MCP_NAMES).find((k) => FLAGSHIP_MCP_NAMES[k] === name) || name;
    const e = (s.pricing.endpoints || []).find((x) => x.slug === slug);
    return e ? Number(String(e.price).replace(/[^0-9.]/g, "")) : NaN;
  };
  ok(named.length > 0 && named.includes(FLAGSHIP_MCP_NAMES[FRONT_DOOR_SLUG]) && named.every((n) => priceOf(n) > 0 && priceOf(n) <= cap), `on: every tool the clause names is a catalog route at or under the cap, web.search among them (${named.join(", ")})`);
  ok(named.every((n) => Object.values(FLAGSHIP_MCP_NAMES).includes(n)), "on: with no slug list set, the clause names flagships only");
  stopProc();
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
