#!/usr/bin/env node
// A route quoted per request states one floor everywhere. On a booted PAID
// server (stub facilitator; nothing leaves the machine), for every row
// /api/pricing marks `quoted`:
//   - fromUsd equals quoteRange.minUsd;
//   - /openapi.json's dynamic price min and its "from $X" summary read it;
//   - the /llms-full.txt catalog line reads "from $X";
//   - the smallest quote the route's 402 asks on Base, over that route's
//     cheapest bodies, is that same amount, and no body here quotes under it.
// decide is the case that drifted: its list price is the default depth, and
// the quick depth costs less. A quoted route with no cheapest body listed
// below fails, so a new one is added here with its floor.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";
import { DEPTHS, priceForDepth } from "../src/decide/config.js";
import { fromPriceLabel, fromUsdOf } from "../src/quoted-from.js";

let B = "";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const BASE_NET = "eip155:8453";
const TMP = mkdtempSync(join(tmpdir(), "quoted-from-"));
let pass = 0, failed = 0, srv = null, facilitator = null;
const cleanup = async () => { await srv?.stop().catch(() => {}); facilitator?.close(); try { rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// The helper alone.
ok(fromPriceLabel({ price: "$0.010", quoteRange: { minUsd: 0.003, maxUsd: 0.03 } }) === "$0.003" && fromUsdOf({ price: "$0.010", quoteRange: { minUsd: 0.003, maxUsd: 0.03 } }) === 0.003, "a floor under the list price is the from price");
ok(fromPriceLabel({ price: "$0.140", quoteRange: { minUsd: 0.14, maxUsd: 0.26 } }) === "$0.140" && fromPriceLabel({ price: "$0.02" }) === "$0.02", "a floor equal to the list price prints the list price as written");
ok(fromPriceLabel({ price: "$1.00", quoteRange: { minUsd: 0.0125, maxUsd: 2 } }) === "$0.0125" && fromPriceLabel({ price: "$1.00", quoteRange: { minUsd: 0.5, maxUsd: 2 } }) === "$0.500", "the label keeps at least three decimals and never rounds the floor");

facilitator = createServer((req, res) => {
  req.on("data", () => {}); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: BASE_NET }], extensions: [], signers: {} });
    return reply(500, { error: "stub facilitator: nothing is paid in this suite" });
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC_PORT = facilitator.address().port;

const SERVER_ENV = {
  FREE_MODE: "", NODE_ENV: "test", STATE_DATABASE_URL: "", REDIS_URL: "", DECIDE_CONFIG: "",
  WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base",
  FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
  CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", PAYAI_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
  OPENROUTER_API_KEY: "test-key-never-called", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "",
  // The decision service is never reached: only the 402 is read.
  DECIDE_SERVICE_URL: "http://127.0.0.1:9", DECIDE_INTERNAL_TOKEN: "quoted-from-price-token-0123456789", DECIDE_LEDGER_FILE: join(TMP, "decide.db"),
  POSTHOG_API_KEY: "",
  FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
  SOLANA_LEADERBOARD: "off", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "3600000", STATS_ALLOW_EPHEMERAL: "true",
};

// The amount (USD) the 402 for this body asks on Base, or null with the status.
const quote402 = async (path, body) => {
  const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const h = r.headers.get("payment-required");
  let pr = null; try { pr = h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null; } catch { /* not a 402 */ }
  const a = (pr?.accepts || []).find((x) => x.scheme === "exact" && x.network === BASE_NET && !x.extra?.verifyingContract);
  return { status: r.status, usd: a ? Number(a.amount) / 1e6 : null };
};
// Each quoted route's bodies, the cheapest first; every one is quoted and none may come in under the floor.
// decide-execute reaches its floor only for a paid decision whose credit covers
// the run (scripts/test-decide-execute.js); a sketch here quotes its steps, so
// this suite checks its quotes sit inside the range, not on the floor.
const FLOOR_NEEDS_A_DECISION = new Set(["decide-execute"]);
const chat = { messages: [{ role: "user", content: "hi" }], max_tokens: 1 };
const BODIES = {
  "decide": [{ task: "resolve an ENS name", depth: "quick" }, { task: "resolve an ENS name" }, { task: "resolve an ENS name", depth: "full" }],
  "decide-execute": ["example"],
  "html-frames": ["example"],
  "tts": [{ text: "" }, { text: "a" }, "example"],
  "tts-hd": [{ text: "" }, { text: "a" }, "example"],
  "dub": ["example", { tier: "hd" }],
  "v1-chat-metered": [chat, "example"],
  "v1-chat-metered-messages": [chat, "example"],
  "v1-chat-metered-responses": [{ input: "hi", max_output_tokens: 1 }, "example"],
  "v1-chat-metered-gemini": [{ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1 } }, "example"],
};

try {
  srv = await bootServer({ env: SERVER_ENV, stores: "quoted-from-price" });
  B = srv.url;
  ok((await fetch(`${B}/health`)).ok, "server booted (paid mode, stub facilitator)");
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const openapi = await (await fetch(`${B}/openapi.json`)).json();
  const llmsFull = (await (await fetch(`${B}/llms-full.txt`)).text()).split("\n");
  const quoted = pricing.endpoints.filter((e) => e.quoted);
  ok(quoted.length >= 6 && quoted.some((e) => e.slug === "decide"), `the quoted routes are listed, decide among them (${quoted.map((e) => e.slug).join(", ")})`);

  for (const row of quoted) {
    const label = fromPriceLabel(row);
    ok(row.fromUsd === row.quoteRange?.minUsd && row.fromUsd > 0 && row.quoteRange.maxUsd >= row.fromUsd, `${row.slug}: /api/pricing fromUsd is the range's floor (${row.fromUsd})`);
    const op = openapi.paths?.[row.path]?.[row.method.toLowerCase()];
    const info = op?.["x-payment-info"]?.price;
    ok(info?.mode === "dynamic" && Number(info.min) === row.fromUsd, `${row.slug}: /openapi.json's dynamic price starts at it (${info?.min})`);
    const inSummary = /\(from (\$[0-9.]+)\/call/.exec(op?.summary || "")?.[1];
    const inDescription = /quoted per request from the body, from (\$[0-9.]+)/.exec(op?.description || "")?.[1];
    ok(inSummary === label && inDescription === label && Number(label.slice(1)) === row.fromUsd, `${row.slug}: /openapi.json says from ${label} (summary ${inSummary}, description ${inDescription})`);
    const line = llmsFull.find((l) => l.startsWith(`- ${row.slug} | ${row.method} ${row.path} |`));
    const wide = row.quoteRange.maxUsd > row.quoteRange.minUsd;
    ok(line && line.split(" | ")[2] === (wide ? `from ${label}` : row.price), `${row.slug}: the /llms-full.txt line reads ${wide ? `from ${label}` : row.price} (${line?.split(" | ")[2]})`);
    const example = op?.requestBody?.content?.["application/json"]?.example ?? op?.requestBody?.content?.["application/json"]?.schema?.example;
    const bodies = BODIES[row.slug];
    if (!bodies) { ok(false, `${row.slug}: a quoted route with no cheapest body in this suite (add it to BODIES)`); continue; }
    const quotes = [];
    for (const b of bodies) {
      const body = b === "example" ? example : b;
      if (b === "example" && !body) continue;
      const q = await quote402(row.path, body);
      if (q.status === 402 && q.usd !== null) quotes.push(q.usd);
      else ok(false, `${row.slug}: ${JSON.stringify(b).slice(0, 60)} was not quoted (status ${q.status})`);
    }
    const least = Math.min(...quotes);
    if (FLOOR_NEEDS_A_DECISION.has(row.slug)) ok(quotes.length > 0 && least >= row.fromUsd && row.fromUsd === Number(row.price.slice(1)), `${row.slug}: no 402 quotes under the from price, which is its list price (${quotes.join(", ")} vs ${row.fromUsd})`);
    else ok(quotes.length > 0 && least === row.fromUsd, `${row.slug}: the 402's smallest quote is the from price (${quotes.join(", ")} vs ${row.fromUsd})`);
    ok(quotes.every((q) => q <= row.quoteRange.maxUsd + 1e-9), `${row.slug}: no quote passes the published ceiling`);
  }

  // decide: the floor comes from the depth prices its quote function reads.
  const decide = quoted.find((e) => e.slug === "decide");
  const depthMin = Math.min(...DEPTHS.map((d) => priceForDepth(d)));
  ok(decide?.fromUsd === depthMin && decide.quoteRange.maxUsd === priceForDepth("full") && Number(decide.price.slice(1)) === priceForDepth("plan"), `decide: from is the cheapest depth, the list price stays the default depth (${decide?.fromUsd}, ${decide?.price})`);
  for (const d of DEPTHS) {
    const q = await quote402("/api/decide", { task: "resolve an ENS name", depth: d });
    ok(q.usd === priceForDepth(d), `decide: depth ${d} is still quoted at its configured price (${q.usd})`);
  }
  const gateway = pricing.llmGateway?.tiers || [];
  ok(gateway.filter((t) => t.quoted).every((t) => t.fromUsd === pricing.endpoints.find((e) => e.path === t.path)?.fromUsd), "the gateway tier list reads the same floors");
} catch (e) {
  ok(false, `unexpected: ${e?.stack || e}`);
} finally {
  if (failed && srv) console.error(`--- server output (tail) ---\n${srv.log().slice(-3000)}`);
  await cleanup();
}
console.log(`\ntest-quoted-from-price: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
