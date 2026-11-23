#!/usr/bin/env node
// /start and the Base gas fact.
//
//   node scripts/test-start-page.js
//
// Offline renders, then one FREE_MODE boot of the real server.
//   - /start gives one step per app (Claude desktop, Claude Code, Cursor), each
//     read from mcpInstallHints (the connector's own install lines, with the
//     package version derived, never typed), and names no app this server's
//     docs do not give a path for.
//   - Each offer reads its switch: the card report line only with the
//     storefront on, the credits line only with credits on sale; the free
//     tool count is the catalog's proof-of-work count.
//   - The Base gas sentence (src/base-no-gas.js) is on /start, the /base page
//     (and on no other chain page), the Base line of /llms.txt, the hosted
//     connector's payment.info, the README, the wiki pages on paying and
//     getting started, and the agent402-client README.
//   - /start is in the docs nav, the sitemap, /llms.txt and the page dates.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bootServer } from "./lib/boot-server.js";

const { startPage, startApps, START_PATH } = await import("../src/start-page.js");
const { BASE_NO_GAS_SENTENCE } = await import("../src/base-no-gas.js");
const { mcpInstallHints, AGENT402_MCP_VERSION } = await import("../src/mcp-flagship.js");
const { HUMAN_PRODUCTS } = await import("../src/human-checkout.js");
const { cardReportPriceRange } = await import("../src/report-tiers.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ORIGIN = "https://agent402.tools";
const plain = (html) => String(html).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// ---- offline renders ----------------------------------------------------------
const catalog = {
  "POST /api/hash": { slug: "hash", route: "POST /api/hash", price: "$0.001" },
  "POST /api/uuid": { slug: "uuid", route: "POST /api/uuid", price: "$0.001" },
  "POST /api/render": { slug: "render", route: "POST /api/render", price: "$0.005" },
};
const { isComputePayable } = await import("../src/pow.js");
const powCount = Object.values(catalog).filter(isComputePayable).length;
const install = mcpInstallHints(ORIGIN);
const range = cardReportPriceRange(HUMAN_PRODUCTS);

const allOn = plain(startPage(ORIGIN, catalog, { credits: true, storefront: true }));
const allOff = plain(startPage(ORIGIN, catalog, { credits: false, storefront: false }));

const apps = startApps(ORIGIN);
ok(apps.map((a) => a.name).join() === "Claude desktop,Claude Code,Cursor", `one step per app, in order (${apps.map((a) => a.name).join(", ")})`);
ok(apps.find((a) => a.id === "claude-desktop").copy === install.hostedUrl && allOn.includes(install.hostedUrl), "Claude desktop pastes the hosted connector address from the install hints");
ok(apps.find((a) => a.id === "claude-code").copy === install.claudeCodeHosted && allOn.includes(install.claudeCodeHosted), "Claude Code runs the hosted install line from the install hints");
ok(apps.find((a) => a.id === "cursor").copy === JSON.stringify(install.cursorMcpJson, null, 2) && allOn.includes('"url": "https://agent402.tools/mcp"'), "Cursor adds the install hints' mcp.json block");
ok(!/ChatGPT/i.test(allOn), "names no app without a documented path");
{
  const src = readFileSync(join(ROOT, "src/start-page.js"), "utf8");
  ok(!/agent402-mcp@\d/.test(src) && !src.includes(AGENT402_MCP_VERSION) && !/https:\/\/agent402\.tools/.test(src), "the page module types no package version and no host");
}
ok(powCount > 0 && allOn.includes(`${powCount} tools run free with proof of work`), `the free tool count is the catalog's proof-of-work count (${powCount})`);
ok(allOn.includes(`Credits by card.`) && allOn.includes("/credits"), "credits on sale: the credits line is there");
ok(!/credits/i.test(allOff), "credits not on sale: the page says nothing about credits");
ok(range && allOn.includes(`Reports by card.`) && allOn.includes(`${range.text} by card`) && allOn.includes("model-backed"), `storefront on: the report line quotes the product table's range (${range?.text}) and says model-backed`);
ok(!/Reports by card/.test(allOff) && !allOff.includes("/reports"), "storefront off: no report line");
ok(allOff.includes("Without a wallet") && allOff.includes("Free tools."), "the free tools stay with both switches off");
ok(allOn.includes("Fund your first $5") && allOn.includes("Buy USDC on Base") && allOn.includes("basescan.org/address/<your address>"), "the funding section: buy USDC on Base, send it, check the balance");
ok(allOn.includes(BASE_NO_GAS_SENTENCE) && allOff.includes(BASE_NO_GAS_SENTENCE), "the page states the Base gas sentence");

// ---- the static trees --------------------------------------------------------
for (const f of ["README.md", "wiki/Paying-with-x402.md", "wiki/Getting-Started.md", "client/README.md"]) {
  ok(readFileSync(join(ROOT, f), "utf8").includes(BASE_NO_GAS_SENTENCE), `${f} states the Base gas sentence`);
}
{
  const dates = readFileSync(join(ROOT, "src/page-dates.js"), "utf8");
  ok(/"\/start": \["src\/start-page\.js"/.test(dates), "/start has a page-dates entry");
}

// ---- one boot ------------------------------------------------------------------
const srv = await bootServer({ stores: "start-page", env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" } });
let client;
try {
  const get = async (p) => { const r = await fetch(srv.url + p); return { status: r.status, text: await r.text() }; };
  const start = await get(START_PATH);
  ok(start.status === 200 && /<title>Start here/.test(start.text), "/start answers 200 with its title");
  const startText = plain(start.text);
  ok(/claude mcp add --transport http agent402 https?:\/\/\S+\/mcp/.test(startText), "the served page carries the Claude Code line");
  ok(!/Credits by card/.test(startText), "the served page offers no credits while CREDITS_SALES is unset");
  ok(start.text.includes(BASE_NO_GAS_SENTENCE), "the served page states the Base gas sentence");

  const home = await get("/");
  ok(/href="\/start" class="mlnav-row"/.test(home.text), "the docs nav panel links /start");

  const base = await get("/base");
  ok(base.status === 200 && base.text.includes(BASE_NO_GAS_SENTENCE), "/base states the Base gas sentence");
  for (const p of ["/ink", "/arc", "/solana"]) {
    const r = await get(p);
    ok(r.status === 200 && !r.text.includes(BASE_NO_GAS_SENTENCE), `${p} does not carry the Base sentence`);
  }

  const llms = await get("/llms.txt");
  const baseLine = llms.text.split("\n").find((l) => l.startsWith("- [Base](")) || "";
  ok(baseLine.endsWith(BASE_NO_GAS_SENTENCE), `the Base line of /llms.txt ends with the sentence (${baseLine.slice(0, 80)})`);
  ok(llms.text.split("\n").filter((l) => l.includes(BASE_NO_GAS_SENTENCE)).length === 1, "only the Base line of /llms.txt carries it");
  ok(/^- \[Start here\]\(\S+\/start\): /m.test(llms.text), "/llms.txt links /start under Connect via MCP");

  const pages = await get("/sitemap-pages.xml");
  const all = await get("/sitemap.xml");
  ok(/<loc>[^<]*\/start<\/loc>/.test(pages.text) && /<loc>[^<]*\/start<\/loc>/.test(all.text), "both sitemaps list /start");

  client = new Client({ name: "test-start-page", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
  const pi = await client.callTool({ name: "payment.info", arguments: {} });
  const info = pi.structuredContent || JSON.parse(pi.content?.[0]?.text || "{}");
  ok(info.pay?.baseGas === BASE_NO_GAS_SENTENCE, "payment.info states the Base gas sentence (pay.baseGas)");
  ok(/\/start$/.test(String(info.pay?.start || "")), "payment.info points at /start");
} finally {
  try { await client?.close(); } catch {}
  await srv.stop();
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
