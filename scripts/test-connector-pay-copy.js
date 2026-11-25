#!/usr/bin/env node
// Copy that describes paying on the hosted MCP connector names the wires the
// connector takes in the call on that boot, and no other (src/connector-pay.js).
//
//   node scripts/test-connector-pay-copy.js
//
// Offline. Four boots of the real server, each read on its text and page
// surfaces and on the connector's own answers:
//   paid, MPP gates on    x402 and MPP in the call
//   paid, no MPP gates    x402 alone, MPP never named as a way to pay there
//   FREE_MODE             no paywall: no surface offers payment on the
//                         connector, and the text says the instance is in
//                         free mode
//   FREE_MODE, MPP key    the same: a key with no paywall offers nothing
// On each boot the pages and the connector agree: what /llms.txt, /agents.md,
// /how-to-pay, /quickstart, /learn/mcp-payments, /integrations/mcp and the
// agent-hosts guide say is what the connector's initialize instructions, its
// listed tool descriptions, payment.info and a paid tool's first ask say and
// do. The static trees (README, wiki, docs) describe the hosted service: a
// paragraph there that says the connector is paid over MPP names x402 too.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bootServer } from "./lib/boot-server.js";

const { connectorWires, connectorPayText, connectorPayShort, connectorLongCallText, connectorX402Enabled, connectorMppEnabled, X402_MCP_PAYMENT_KEY, X402_MCP_RECEIPT_KEY, MPP_MCP_ASK_KEY, MPP_MCP_CREDENTIAL_KEY } = await import("../src/connector-pay.js");
const { X402_PAYMENT_META, X402_PAYMENT_RESPONSE_META, paymentRequiredOfResult } = await import("../src/mcp-x402.js");
const { MCP_PAYMENT_REQUIRED_META, MCP_CREDENTIAL_META } = await import("../src/mcp-mpp.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ORIGIN = "https://agent402.tools";

// ---- the module --------------------------------------------------------------------
{
  ok(X402_MCP_PAYMENT_KEY === `_meta["${X402_PAYMENT_META}"]` && X402_MCP_RECEIPT_KEY === `_meta["${X402_PAYMENT_RESPONSE_META}"]` && MPP_MCP_ASK_KEY === `_meta["${MCP_PAYMENT_REQUIRED_META}"]` && MPP_MCP_CREDENTIAL_KEY === `_meta["${MCP_CREDENTIAL_META}"]`,
    "the keys the copy names are the keys the codecs read");
  ok(connectorX402Enabled({ FREE_MODE: "true" }) === false && connectorX402Enabled({}) === true && connectorX402Enabled({ FREE_MODE: "false" }) === true, "x402 in the call on every boot but FREE_MODE");
  const both = connectorPayText({ x402: true, mpp: true });
  const x = connectorPayText({ x402: true, mpp: false });
  const m = connectorPayText({ x402: false, mpp: true });
  const none = connectorPayText({ x402: false, mpp: false });
  ok(both.includes(X402_MCP_PAYMENT_KEY) && both.includes(MPP_MCP_CREDENTIAL_KEY) && /over x402 \(.*\), or over MPP \(/.test(both), "both wires: x402 first, then MPP");
  ok(x.includes(X402_MCP_PAYMENT_KEY) && !/MPP|paymentauth/.test(x), "x402 alone never names MPP");
  ok(m.includes(MPP_MCP_CREDENTIAL_KEY) && !/x402/.test(m.replace(/x402 client/g, "")) && !/rate limit/.test(m), "MPP alone never names x402 in the call, nor the paid way past the rate limit");
  ok(/free mode/.test(none) && !/payable|_meta|x402\/payment|paymentauth/.test(none), `no wire: the text offers no payment on the connector (${none.slice(0, 80)})`);
  ok(connectorWires({ x402: true, mpp: true }).phrase === "x402 or MPP" && connectorWires({ x402: false, mpp: false }).phrase === "" && connectorWires({ x402: false, mpp: true }).names.join() === "MPP", "the phrase lists the wires on");
  ok(connectorPayShort({ x402: true, mpp: true }) === "Wallet-only tools are payable in the call over x402 or MPP (how: /agents.md)" && connectorPayShort({ x402: true, mpp: false }).includes("over x402 (") && /free mode/.test(connectorPayShort({ x402: false, mpp: false })) && Buffer.byteLength(connectorPayShort({ x402: true, mpp: true })) <= 80,
    "the short line names the wires in 80 bytes or fewer and points at /agents.md");
  ok(connectorMppEnabled({ MPP_SECRET_KEY: "k" }) === true && connectorMppEnabled({}) === false && connectorMppEnabled({ FREE_MODE: "true", MPP_SECRET_KEY: "k" }) === false, "MPP in the call while the gates are on, and never in FREE_MODE");
  ok(!/structuredContent/.test(both + x) && /first text block is the x402 PaymentRequired as JSON/.test(x), "the x402 ask is described where it rides: the first text block");
  // The x402 wire is blocking only: a long call is scoped out of the claim.
  ok(/long-running tool .* is the exception over x402: pay it in the call over MPP, where the run is handed back as an MCP task, or call its HTTP route with Prefer: respond-async\./.test(both) && both.endsWith(connectorLongCallText({ x402: true, mpp: true })), "both wires: a long-running tool is paid in the call over MPP, or on its HTTP route");
  ok(/long-running tool .* is the exception over x402: call its HTTP route with Prefer: respond-async\./.test(x) && connectorLongCallText({ x402: false, mpp: true }) === "" && !/long-running/.test(m + none), "x402 alone: a long-running tool is paid on its HTTP route; no scope note without x402");
  ok(connectorPayText({ x402: true, mpp: true, code: (s) => `\`${s}\`` }).includes(`\`${X402_MCP_PAYMENT_KEY}\``), "the keys are wrapped as the surface asks");
  ok(![both, x, m, none].some((t) => /—|\$\s?\d/.test(t)), "no em dash and no typed price in any variant");
}

// ---- four boots --------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), "connector-pay-copy-"));
const facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x0" });
    reply({});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;
const QUIET = {
  NODE_ENV: "test", BASE_URL: ORIGIN, REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "", POSTHOG_API_KEY: "",
  STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
  MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
  TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "",
};
const PAID = (label) => ({
  ...QUIET, FREE_MODE: "", TRUST_PROXY_HOPS: "1",
  WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
  FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, EVM_RPC_8453: `${FAC}/rpc`, FACILITATOR_GAS_CHECK: "off",
  CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
  SALES_LEDGER_DB: join(TMP, `${label}-sales.db`), REFUND_DB_DIR: mkdtempSync(join(TMP, `${label}-`)), HANGUP_FORGIVE_FILE: join(TMP, `${label}-hangup.json`),
});
const BOOTS = [
  { label: "paid, MPP on", x402: true, mpp: true, args: ["--import", "./scripts/lib/loopback-only-preload.js"], env: { ...PAID("both"), MPP_SECRET_KEY: randomBytes(24).toString("hex") } },
  { label: "paid, no MPP", x402: true, mpp: false, args: ["--import", "./scripts/lib/loopback-only-preload.js"], env: { ...PAID("x402"), MPP_SECRET_KEY: "" } },
  { label: "FREE_MODE", x402: false, mpp: false, args: [], env: { ...QUIET, FREE_MODE: "true", MPP_SECRET_KEY: "" } },
  // The MPP key set on a boot with no paywall: the connector asks for nothing.
  { label: "FREE_MODE, MPP key set", x402: false, mpp: false, args: [], env: { ...QUIET, FREE_MODE: "true", MPP_SECRET_KEY: randomBytes(24).toString("hex") } },
];

const wires0 = (boot) => [boot.x402 && "x402", boot.mpp && "MPP"].filter(Boolean).join(" or ");
const plain = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>|<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ");
/** The sentences of a text that mention the connector. */
const connectorLines = (text) => text.split(/\n+/).filter((l) => /connector/i.test(l)).join("\n");
// What a surface claims about paying in the call.
const claimsX402 = (t) => t.includes(X402_MCP_PAYMENT_KEY) || /in the call over x402/.test(t) || /pays x402(?: or MPP)? settles it in the same call/.test(t) || /Over x402\./.test(t);
const claimsMpp = (t) => t.includes(MPP_MCP_CREDENTIAL_KEY) || t.includes(MPP_MCP_ASK_KEY) || /in the call over (?:x402 or )?MPP/.test(t) || /pays (?:x402 or )?MPP settles it in the same call/.test(t) || /Over MPP\./.test(t);

for (const boot of BOOTS) {
  let srv = null, client = null;
  try {
    srv = await bootServer({ stores: `connector-pay-copy-${boot.label.replace(/\W+/g, "-")}`, args: boot.args, env: boot.env });
    const get = async (p) => { const r = await fetch(`${srv.url}${p}`); return { status: r.status, text: await r.text() }; };
    const want = `${[boot.x402 && "x402", boot.mpp && "MPP"].filter(Boolean).join(" and ") || "no wire"}`;

    // /agents.md: the full sentence, keys included.
    {
      const r = await get("/agents.md");
      const t = connectorLines(r.text);
      ok(r.status === 200 && claimsX402(t) === boot.x402 && claimsMpp(t) === boot.mpp, `${boot.label}: /agents.md names ${want} for paying on the connector`);
      ok(/long-running tool/.test(t) === boot.x402 && (!boot.x402 || /in the call over MPP, where the run is handed back as an MCP task/.test(t) === boot.mpp), `${boot.label}: /agents.md scopes the claim: a long-running tool is not paid in the call over x402`);
      if (boot.x402) ok(t.includes(`\`${X402_MCP_PAYMENT_KEY}\``) && t.includes(`\`${X402_MCP_RECEIPT_KEY}\``) && /at the price the HTTP route quotes/.test(t) && /rate limit/.test(t), `${boot.label}: /agents.md says where the payment and the receipt ride, the price rule and the paid way past the rate limit`);
      else ok(/free mode, with no paywall/.test(t) && !/payable in the call/.test(r.text), `${boot.label}: /agents.md says the instance is in free mode and offers no payment on the connector`);
      ok(!/\u2014/.test(t) && !/\$\s?\d/.test(t.split("\n").filter((l) => /MCP, hosted/.test(l)).join("\n")), `${boot.label}: /agents.md's connector line has no em dash and no typed price`);
    }
    // /llms.txt and /llms-full.txt: one short line (the index has a byte budget) that points at /agents.md.
    for (const p of ["/llms.txt", "/llms-full.txt"]) {
      const r = await get(p);
      const block = (r.text.split("## Connect via MCP")[1] || "").split("\n## ")[0];
      const line = block.split("\n").find((l) => /payable in the call|free mode/.test(l)) || "";
      ok(r.status === 200 && (wires0(boot) ? line === `  - Wallet-only tools are payable in the call over ${wires0(boot)} (how: /agents.md)` : line === "  - This instance runs in free mode: its connector takes no payment"), `${boot.label}: ${p}'s MCP block names ${want} (${line.trim()})`);
      const all = connectorLines(r.text);
      ok((boot.mpp || !claimsMpp(all)) && (boot.x402 || !claimsX402(all)), `${boot.label}: no connector line on ${p} offers a wire that is off`);
    }

    // Pages: the short form.
    for (const p of ["/how-to-pay", "/quickstart", "/integrations/mcp"]) {
      const r = await get(p);
      const t = connectorLines(plain(r.text));
      ok(r.status === 200 && claimsX402(t) === boot.x402 && claimsMpp(t) === boot.mpp, `${boot.label}: ${p} names ${want} for paying on the connector`);
      ok(boot.x402 || boot.mpp ? /payable in the call over (?:x402|MPP)/.test(t) : !/payable in the call|also payable/.test(t), `${boot.label}: ${p} says the connector is payable in the call only where a wire is on`);
    }
    const quick = plain((await get("/quickstart")).text);
    ok(boot.x402 ? /paid tools answer with their price, payable in the call over x402/.test(quick) : /paid tools answer with their price and a pointer to payment\.info\./.test(quick), `${boot.label}: /quickstart's first line says what a paid tool answers`);

    // The explainer: a section per wire on.
    const learn = plain((await get("/learn/mcp-payments")).text);
    ok(learn.includes(X402_MCP_PAYMENT_KEY) === boot.x402 && /first text block is the x402 PaymentRequired as JSON/.test(learn) === boot.x402 && !/whose structuredContent/.test(learn) && /long-running tool/.test(learn) === boot.x402 && learn.includes("org.paymentauth/credential") === boot.mpp && /McpClient\.wrap/.test(learn) === boot.mpp,
      `${boot.label}: /learn/mcp-payments explains ${want}`);
    ok(boot.x402 && boot.mpp ? /A call that carries both is settled over MPP/.test(learn) : !/carries both/.test(learn), `${boot.label}: it states which wire settles a call that carries both only when both are on`);
    if (!boot.x402 && !boot.mpp) ok(/free mode, with no paywall/.test(learn), `${boot.label}: it says the instance is in free mode`);

    // /terms: the access item names the wires this boot's connector takes, and none in FREE_MODE.
    {
      const r = await get("/terms");
      const t = plain(r.text).replace(/\s+/g, " ");
      const item = (t.match(/The hosted MCP connector runs the pure-CPU tools free, rate-limited[^.]*\./) || [""])[0];
      ok(r.status === 200 && (wires0(boot) ? item.endsWith(`, and a wallet can pay the other tools through it in the call, over ${wires0(boot)}.`) : item === "The hosted MCP connector runs the pure-CPU tools free, rate-limited."),
        `${boot.label}: /terms names ${want} for paying on the connector (${item.slice(60)})`);
    }

    // The agent-hosts guide.
    const guide = plain((await get("/guides/agent-hosts")).text).replace(/\s+/g, " ");
    const sentence = (guide.match(/Wallet-only tools, the flagship web and market tools among them, ([^.]*?), and a call that carries no payment/) || [])[1] || "";
    ok(sentence && claimsX402(sentence) === boot.x402 && claimsMpp(sentence) === boot.mpp && (boot.x402 || boot.mpp || /answer with payment setup instead of a result/.test(sentence)), `${boot.label}: the agent-hosts guide names ${want} (${sentence.slice(0, 90)})`);

    // The connector's own answers say the same.
    client = new Client({ name: "test-connector-pay-copy", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
    const hosted = String(client.getInstructions() || "").split("\n").find((l) => l.startsWith("Hosted connector")) || "";
    const wires = [boot.x402 && "x402", boot.mpp && "MPP"].filter(Boolean);
    const lead = String(client.getInstructions() || "").split("\n")[0];
    ok(boot.mpp ? /\bacross x402 and MPP\b/.test(lead) : (/\bacross x402\b/.test(lead) && !/\bMPP\b/.test(lead)), `${boot.label}: the initialize lead names MPP only where the connector takes it (${lead.slice(0, 110)})`);
    ok(hosted.includes(wires.length ? `other tools paid in the call over ${wires.join(" or ")} from a wallet)` : "others need a wallet on the npm package)"), `${boot.label}: the initialize instructions name ${want} (${hosted.slice(0, 110)})`);
    const tools = (await client.listTools()).tools;
    const info = tools.find((t) => t.name === "payment.info")?.description || "";
    const allDescriptions = tools.map((t) => t.description || "").join("\n");
    ok(wires.length ? info.includes(`(payable here, in the call, over ${wires.join(" or ")})`) : !/payable here|pay it here/.test(allDescriptions),
      `${boot.label}: payment.info's listed description names ${want} (${(info.match(/the rest settle[^.]*\./) || [""])[0]})`);
    ok((boot.mpp || !/here[^.]{0,40}over (?:x402 or )?MPP/.test(allDescriptions)) && (boot.x402 || !/here[^.]{0,40}over x402/.test(allDescriptions)), `${boot.label}: no listed description offers a wire in the call that is off`);
    // Every listed description that offers payment here names this boot's wires, all of them.
    const hereClaims = tools.flatMap((t) => (String(t.description || "").match(/(?:payable here|pay it here)[^.]*?over (?:x402 or MPP|x402|MPP)/g) || []).map((c) => `${t.name}: ${c}`));
    const paidFlagships = tools.filter((t) => /^Paid \(/.test(t.description || ""));
    ok(wires.length ? hereClaims.length >= 3 && hereClaims.every((c) => c.endsWith(`over ${wires.join(" or ")}`)) : hereClaims.length === 0,
      `${boot.label}: each listed description that offers payment here names ${want} (${hereClaims.filter((c) => !c.endsWith(`over ${wires.join(" or ")}`)).join(" | ") || `${hereClaims.length} read`})`);
    // A flagship's wallet note rides after its description and is usually cut
    // by the listing's length bound; where one survives it is read above.
    ok(paidFlagships.length >= 5 && paidFlagships.every((t) => wires.length || !/pay it here/.test(t.description)), `${boot.label}: no paid flagship's description offers payment here without a wire (${paidFlagships.length} read)`);
    for (const n of ["catalog.search", "catalog.call"]) {
      const d = tools.find((t) => t.name === n)?.description || "";
      ok(wires.length ? d.includes(`over ${wires.join(" or ")}`) : !/payable here/.test(d), `${boot.label}: ${n}'s description names ${want}`);
    }
    const found = await client.callTool({ name: "catalog.find", arguments: { task: "hash some text" } });
    const usage = String((found.structuredContent || JSON.parse(found.content?.[0]?.text || "{}")).usage || "");
    ok(usage && (wires.length ? usage.includes(`payable here, in the call, over ${wires.join(" or ")},`) : !/payable here|over MPP|over x402/.test(usage)), `${boot.label}: catalog.find's usage line names ${want} (${usage.slice(0, 110)})`);
    const pi = await client.callTool({ name: "payment.info", arguments: {} });
    const how = String((pi.structuredContent || JSON.parse(pi.content?.[0]?.text || "{}")).freeTier?.how || "");
    ok(how && how.includes('_meta["x402/payment"]') === boot.x402 && /over MPP \(the first ask/.test(how) === boot.mpp && !/structuredContent/.test(how), `${boot.label}: payment.info names ${want} (${how.slice(0, 100)})`);
    ok(/outlast this connector's blocking wait/.test(how) === boot.x402 && (!boot.x402 || /pay it here over MPP as an MCP task/.test(how) === boot.mpp), `${boot.label}: payment.info scopes a long-running tool out of x402 in the call`);
    const sd = await client.callTool({ name: "server.describe", arguments: {} });
    const sdText = JSON.stringify(sd.structuredContent || sd.content || "");
    ok(boot.x402 || !/x402\/payment/.test(sdText), `${boot.label}: server.describe offers no x402 payment in the call without a paywall`);
    ok(boot.mpp || !/org\.paymentauth/.test(sdText), `${boot.label}: server.describe names no MPP credential key without the gates`);
    const access = ((sd.structuredContent || {}).startHere?.flagships || []).filter((f) => f.access !== "free here").map((f) => f.access);
    ok(access.length >= 5 && access.every((a) => (wires.length ? a === `paid: payable here over ${wires.join(" or ")}, or with a wallet on the npm server` : a === "wallet required on this hosted connector")), `${boot.label}: server.describe's flagship access names ${want} (${access[0]})`);
    // And does the same: a paid flagship's first ask.
    const ask = await client.callTool({ name: "memory.read", arguments: {} });
    const offer = paymentRequiredOfResult(ask);
    const hasOffer = ask.isError === true && Array.isArray(offer?.accepts);
    // The client lists tools first (its output check is armed), so reaching
    // here means it read the ask; a structuredContent there is the offer itself.
    ok(ask.isError !== true || !("structuredContent" in ask) || (offer && JSON.stringify(ask.structuredContent) === JSON.stringify(offer)), `${boot.label}: the ask's structuredContent, when present, is the x402 offer itself, read by a client that checks the tool's output schema`);
    const askText = (ask.content || []).map((c) => c.text || "").join("\n");
    ok(!/structuredContent/.test(askText) && (boot.x402 ? /the JSON in its first text block/.test(askText) : true), `${boot.label}: the ask's text points at where the offer rides`);
    const hasMpp = Array.isArray(ask._meta?.[MCP_PAYMENT_REQUIRED_META]?.challenges);
    ok(hasOffer === boot.x402 && hasMpp === boot.mpp, `${boot.label}: a paid tool's first ask carries ${want} (x402 offer ${hasOffer}, MPP challenges ${hasMpp})`);
    if (boot.x402) ok(offer?.resource?.url === `${ORIGIN}/mcp`, `${boot.label}: a flagship called by name quotes the resource /mcp, as the wiki says`);
    // The npm-server setup reads as sentences: the command with its variables,
    // then the wallet warning on its own (never "agent402-mcp with Use a new wallet").
    {
      const piText = JSON.stringify(pi.structuredContent || pi.content || "");
      const WARN = "Use a new wallet holding only a few dollars of USDC, never your main wallet.";
      for (const [where, t] of [["payment.info", piText], ["a paid tool's ask", askText]]) {
        ok(!/agent402-mcp`? with (?:env )?Use a new wallet/.test(t) && t.includes(WARN) && /agent402-mcp`? with (?:env )?AGENT_KEY=0x<private key>/.test(t),
          `${boot.label}: ${where} names the command with AGENT_KEY, then the wallet warning as its own sentence`);
      }
    }
  } catch (e) {
    ok(false, `${boot.label}: ${e?.stack || String(e)}`);
  } finally {
    try { await client?.close(); } catch { /* closed */ }
    if (srv) await srv.stop();
  }
}
facilitator.closeAllConnections?.();
await new Promise((r) => facilitator.close(r));

// ---- static trees: the hosted service takes both wires ---------------------------------
{
  const files = ["README.md", "llms-install.md", ...readdirSync(join(ROOT, "wiki")).filter((f) => f.endsWith(".md")).map((f) => `wiki/${f}`), ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
  // A paragraph (or a table row, or a list item) that says the connector is paid over MPP.
  const PAID_OVER_MPP = /(?:connector|\/mcp)[^\n]{0,200}(?:payable|be paid|paid right|pay wallet-only)[^\n]{0,160}\bMPP\b|\bMPP\b[^\n]{0,80}(?:on|directly on) the (?:hosted )?connector/i;
  const offenders = [];
  let read = 0;
  for (const f of files) {
    const blocks = readFileSync(join(ROOT, f), "utf8").split(/\n\s*\n|\n(?=[-|*] )/);
    for (const b of blocks) {
      const flat = b.replace(/\s*\n\s*/g, " ");
      if (!PAID_OVER_MPP.test(flat)) continue;
      read++;
      if (!/x402/.test(flat)) offenders.push(`${f}: ${flat.slice(0, 90)}`);
    }
  }
  ok(read >= 6, `the static trees hold paragraphs that say the connector is paid in the call (${read} read)`);
  ok(offenders.length === 0, `each one that names MPP names x402 too (${offenders.join(" | ") || "none left"})`);
  // The reverse order ("payable on the connector over MPP") is read too.
  const REVERSED = /(?:payable|paid|pay)[^\n.]{0,80}on the (?:hosted )?(?:MCP )?connector[^\n.]{0,40}over MPP/i;
  const reversed = files.filter((f) => REVERSED.test(readFileSync(join(ROOT, f), "utf8").replace(/\s*\n\s*/g, " ")));
  ok(reversed.length === 0, `no static page says the connector is payable over MPP alone (${reversed.join(", ") || "none"})`);
  const flatOf = (f) => readFileSync(join(ROOT, f), "utf8").replace(/\s*\n\s*/g, " ");
  ok(/wallet-only tools are payable on the connector in the call, over x402 or MPP \(the offer arrives in the tool result, the payment goes back in `_meta`\)/.test(flatOf("docs/ecosystem-listings.md")), "docs/ecosystem-listings.md: the connector is payable in the call over x402 or MPP");
  const cf = flatOf("docs/cloudflare-agents.md");
  ok(/are payable on the connector in the call\. Over x402,/.test(cf) && cf.includes('`_meta["x402/payment"]`') && cf.includes('`_meta["x402/payment-response"]`') && /Over MPP, the same result/.test(cf) && !/To pay over x402 instead/.test(cf), "docs/cloudflare-agents.md: both wires in the call, and the npm package is not the only x402 way");
  ok(/on the hosted MCP connector in the call \(over x402 or MPP\)/.test(flatOf("wiki/Payments-and-x402.md")), "wiki/Payments-and-x402.md: the connector takes x402 or MPP in the call");
  ok(/The same first answer carries an x402 PaymentRequired for an x402 MCP client; a call that carries both an MPP credential and an x402 payment is settled over MPP\./.test(flatOf("wiki/Paying-with-MPP.md")), "wiki/Paying-with-MPP.md: its connector paragraph names the x402 offer");
  ok(!files.some((f) => /whose `structuredContent` is the x402|as (?:its|the tool result's) `structuredContent`/.test(flatOf(f))), "no static page says the x402 offer rides in structuredContent");
  ok(/A report runs long, so on the connector it is paid over MPP/.test(flatOf("wiki/Reports-and-Monitors.md")) && /long-running tool[^.]*is the exception over x402/.test(flatOf("wiki/MCP-Connector.md")), "the wiki scopes long-running tools out of x402 in the call");
  ok((flatOf("wiki/MCP-Connector.md").match(/\*\*x402 on `\/mcp`\.\*\*/g) || []).length === 1, "the MCP Connector page has one x402 paragraph");
  const wiki = readFileSync(join(ROOT, "wiki/MCP-Connector.md"), "utf8");
  ok(/\*\*x402 on `\/mcp`\.\*\*/.test(wiki) && wiki.includes('`_meta["x402/payment"]`') && wiki.includes('`_meta["x402/payment-response"]`') && /`FREE_MODE` has no paywall, so its connector takes no payment/.test(wiki),
    "the MCP Connector wiki page has the x402 paragraph: where the payment and the receipt ride, and the FREE_MODE scope");
  const { MCP_X402_SLUGS } = await import("../src/mcp-x402-routes.js");
  const { FLAGSHIP_MCP_NAMES } = await import("../src/mcp-flagship.js");
  // The wiki is static and names the twins every server lists: a stock twin
  // is listed only with a stock data provider (src/tools/stock-provider.js),
  // so it is not named there.
  const { STOCK_SLUGS } = await import("../src/tools/stock-provider.js");
  const listed = MCP_X402_SLUGS.filter((s) => !STOCK_SLUGS.has(s)).map((s) => FLAGSHIP_MCP_NAMES[s]);
  const para = wiki.split("\n").find((l) => l.startsWith("**x402 on `/mcp`.**")) || "";
  const named = (para.match(/called by its listed name \(([^)]*)\)/) || [])[1] || "";
  ok(named.split(", ").map((x) => x.replace(/`/g, "")).sort().join() === [...listed].sort().join(), `the tools it says quote the resource /mcp are the server's twins (${named})`);
  ok(/Updated 2026-11-16: the same answer now carries an x402 payment offer/.test(readFileSync(join(ROOT, "src/blog.js"), "utf8")), "the dated connector post carries its update note");
  // README's connector paragraph names the wires the server mounts on the hosted
  // connector: x402 on a paid boot (x402Loopback), MPP while the gates are on (mppLoopback).
  const server = readFileSync(join(ROOT, "src/server.js"), "utf8");
  const mounted = connectorWires({ x402: /\bx402Loopback: FREE_MODE \? null : create\w+\(/.test(server), mpp: /\bmppLoopback: connectorWires\(\)\.mpp \? create\w+\(/.test(server) });
  ok(mounted.names.length === 2, `src/server.js mounts both connector wires (${mounted.phrase})`);
  const readmeLine = flatOf("README.md").match(/The pure-CPU tools run free there\. A wallet-only tool is payable in the same call over ([^,]+), from an MCP client that holds a wallet/);
  ok(readmeLine && readmeLine[1] === mounted.phrase, `README.md's connector paragraph names the wires the server mounts (${readmeLine ? readmeLine[1] : "sentence missing"})`);
  // The project map says the codec and the twins are wired to /mcp, off in FREE_MODE.
  const map = flatOf("CLAUDE.md");
  ok(!/not yet wired/.test(map) && /the internal x402 twins of flagships \(both wired to `\/mcp` through `x402Loopback`, off in FREE_MODE/.test(map), "CLAUDE.md says the x402 codec and twins are wired to /mcp through x402Loopback, off in FREE_MODE");
  // The npm package's own text is read by scripts/test-surface-copy.js (its hosted line matches this one).
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
