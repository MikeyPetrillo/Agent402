#!/usr/bin/env node
// /api/tts and /api/tts-hd quoted per request, on a booted PAID server: the
// wiring the kit suite (test-tts-quote.js) cannot see.
//
//   - the 402 on Base asks exactly the quote for the body's text; Optimism adds
//     its configured premium and Robinhood Chain is raised to its floor; the
//     Tempo challenge carries the same quote (it prices through
//     server.js quotedPriceUsd, as the card and credits gates do);
//   - a payment at the quote is served and settled, and the sale is booked at
//     the quote; a payment at a shorter text's quote with a longer text is
//     refused at the paywall, never verified;
//   - a prepaid credits key is held and debited exactly the quote, and the
//     sale is booked at it;
//   - a text over the cap quotes the ceiling and, paid, is refused 400 before
//     any speech call, with nothing settled;
//   - /api/pricing, /openapi.json, the tool page and /llms-full.txt publish the
//     range and the formula.
// Offline: a stub facilitator and a stub speech upstream (the OpenRouter
// preload), a seeded credits key in a scratch store; no payment leaves the machine.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Challenge } from "mppx";
import Database from "better-sqlite3";
import { getFreePorts } from "./lib/free-port.js";
import { ttsQuoteUsd, ttsQuoteFormula, TTS_TIERS } from "../src/tools/tts-kit.js";
import { hashKey } from "../src/credits.js";

const [PORT, FAC_PORT, OR_PORT] = await getFreePorts(3);
const B = `http://127.0.0.1:${PORT}`;
const PAYER = "0x00000000000000000000000000000000000000b3";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const BASE_NET = "eip155:8453", OP = "eip155:10", RH = "eip155:4663";
const PREMIUM_USD = 0.002;
const TMP = mkdtempSync(join(tmpdir(), "tts-quote-paid-"));
let pass = 0, proc = null, facilitator = null, speech = null;
const serverLog = [];
const cleanup = () => { proc?.kill("SIGKILL"); facilitator?.close(); speech?.close(); try { rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } try { rmSync(CREDITS_FILE, { force: true }); } catch { /* gone */ } };
const fail = (m) => {
  console.error("FAIL:", m);
  if (serverLog.length) { console.error("--- server output (last lines) ---"); for (const l of serverLog) console.error(l); }
  cleanup(); process.exit(1);
};
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const micro = (usd) => String(Math.round(usd * 1e6));

let verifies = 0, settles = 0, speechCalls = 0, txn = 0;
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply(200, { kinds: [BASE_NET, OP, RH].map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} });
    if (req.url === "/verify") { verifies++; return reply(200, { isValid: true, payer: PAYER }); }
    if (req.url === "/settle") { settles++; txn++; return reply(200, { success: true, transaction: "0x" + txn.toString(16).padStart(64, "0"), network: BASE_NET, payer: PAYER }); }
    if (req.url.startsWith("/tempo")) return reply(500, { error: "stub relay: never expected" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
// The speech upstream: any speech request answers a few mp3 bytes.
speech = createServer((req, res) => {
  req.on("data", () => {}); req.on("end", () => {
    if (req.url === "/api/v1/audio/speech") { speechCalls++; res.writeHead(200, { "Content-Type": "audio/mpeg" }); return res.end(Buffer.from("ID3stubaudio")); }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => speech.listen(OR_PORT, "127.0.0.1", r));

// A prepaid credits key in the store the server reads (no /data volume: /tmp/credits).
const CREDIT_KEY = `a402_${randomBytes(16).toString("hex")}`;
const CREDITS_DIR = "/tmp/credits";
mkdirSync(CREDITS_DIR, { recursive: true });
const CREDITS_FILE = join(CREDITS_DIR, `k_${hashKey(CREDIT_KEY)}.json`);
writeFileSync(CREDITS_FILE, JSON.stringify({ keyId: `kid_${randomBytes(4).toString("hex")}`, balanceMicro: 5_000_000, loadedMicro: 5_000_000, spentMicro: 0, calls: 0, createdAt: new Date().toISOString(), pack: "credits-20", sessions: [], paymentIntents: [], lastUsedAt: null }));
const SALES_DB = join(TMP, "sales.db");

const env = { ...process.env };
delete env.STATE_DATABASE_URL; delete env.REDIS_URL;
proc = spawn(process.execPath, ["--import", "./scripts/lib/openrouter-stub-preload.js", "src/server.js"], {
  env: {
    ...env, PORT: String(PORT), FREE_MODE: "", NODE_ENV: "test",
    WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base,optimism,robinhood",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, SOLVADOR_KEY: "test-key", SOLVADOR_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, ROBINHOOD_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    NETWORK_PRICE_PREMIUMS: `${OP}=${PREMIUM_USD}`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", PAYAI_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    OPENROUTER_API_KEY: "test-key-stubbed", OPENROUTER_STUB_URL: `http://127.0.0.1:${OR_PORT}`,
    MPP_SECRET_KEY: "test-tts-quote-paid-secret", TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY,
    TEMPO_API_BASE_URL: `http://127.0.0.1:${FAC_PORT}/tempo`,
    // Credits run on the card switch; no Stripe call is made by a spend.
    STRIPE_SECRET_KEY: "sk_test_tts_quote", STRIPE_PROFILE_ID: "",
    SALES_LEDGER_DB: SALES_DB, POSTHOG_API_KEY: "",
    FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    SOLANA_LEADERBOARD: "off", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "3600000", STATS_ALLOW_EPHEMERAL: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) if (line.trim()) serverLog.push(line.slice(0, 300)); if (serverLog.length > 60) serverLog.splice(0, serverLog.length - 60); };
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);

const post = (path, body, headers = {}) => fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const decode402 = (res) => { const h = res.headers.get("payment-required"); try { return h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null; } catch { return null; } };
const tempoAmount = (res) => {
  const w = res.headers.get("www-authenticate");
  if (!w) return null;
  return Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": w })).find((c) => c.method === "tempo")?.request?.amount ?? null;
};
const quoteOf = async (path, body) => {
  const r = await post(path, body);
  const pr = decode402(r);
  const byNet = {};
  for (const a of pr?.accepts || []) if (a.scheme === "exact" && !a.extra?.verifyingContract) byNet[a.network] = a;
  return { status: r.status, pr, byNet, tempo: tempoAmount(r) };
};
const credential = (pr, accepted, nonce) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: pr.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce } },
})).toString("base64");
const text = (n) => "x".repeat(n);
const saleByTx = (tx) => { const db = new Database(SALES_DB, { readonly: true }); try { return db.prepare("SELECT slug, price_usd, rail FROM sales WHERE tx = ? ORDER BY id DESC LIMIT 1").get(tx); } finally { db.close(); } };
const creditSales = () => { const db = new Database(SALES_DB, { readonly: true }); try { return db.prepare("SELECT slug, price_usd FROM sales WHERE rail = 'credits' ORDER BY id").all(); } finally { db.close(); } };
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return null; };

try {
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(250); }
  ok((await fetch(`${B}/health`)).ok, "server booted (paid mode, stub facilitator, stub speech upstream)");
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const rhFloor = Number(pricing.payment?.minPriceUsdByNetwork?.robinhood);
  ok(rhFloor > 0 && Number(pricing.payment?.premiumUsdByNetwork?.optimism) === PREMIUM_USD, "the boot offers Base, Optimism with a premium and Robinhood Chain with a floor");

  // 1. the 402 asks the quote for the text, per chain
  for (const [slug, path] of [["tts", "/api/tts"], ["tts-hd", "/api/tts-hd"]]) {
    for (const n of [1, 100, 2000, 5000]) {
      const q = await quoteOf(path, { text: text(n) });
      const usd = ttsQuoteUsd(slug, n);
      ok(q.status === 402 && q.byNet[BASE_NET]?.amount === micro(usd), `${slug} ${n} chars: the Base accept asks the quote $${usd} (${q.byNet[BASE_NET]?.amount})`);
      ok(q.byNet[OP]?.amount === micro(usd + PREMIUM_USD), `${slug} ${n} chars: Optimism adds its premium (${q.byNet[OP]?.amount})`);
      ok(q.byNet[RH]?.amount === micro(Math.max(usd, rhFloor)), `${slug} ${n} chars: Robinhood Chain is raised to its floor (${q.byNet[RH]?.amount})`);
      ok(q.tempo === micro(usd), `${slug} ${n} chars: the Tempo challenge carries the same quote (${q.tempo})`);
    }
  }
  ok((await quoteOf("/api/tts", { input: { text: text(2000) } })).byNet[BASE_NET]?.amount === micro(0.12), "a body in an input envelope is quoted on its text");

  // 2. paid at the quote: served, settled, booked at the quote
  const q2k = await quoteOf("/api/tts", { text: text(2000) });
  const paid = await post("/api/tts", { text: text(2000) }, { "payment-signature": credential(q2k.pr, q2k.byNet[BASE_NET], "0x" + "a1".repeat(32)) });
  const paidBody = await paid.json().catch(() => ({}));
  const receipt = (() => { try { return JSON.parse(Buffer.from(paid.headers.get("payment-response") || "", "base64").toString("utf8")); } catch { return null; } })();
  ok(paid.status === 200 && paidBody.chars === 2000 && speechCalls === 1 && settles === 1, `a payment at the quote is served and settled (${paid.status}, settles ${settles})`);
  const sale = await waitFor(() => saleByTx(receipt?.transaction));
  ok(sale?.slug === "tts" && Math.abs(sale.price_usd - 0.12) < 1e-9, `the sale is booked at the quote ($${sale?.price_usd})`);

  // 3. a shorter text's quote cannot pay for a longer text
  const q1 = await quoteOf("/api/tts-hd", { text: text(1) });
  const v0 = verifies, s0 = speechCalls;
  const smuggled = await post("/api/tts-hd", { text: text(2000) }, { "payment-signature": credential(q1.pr, q1.byNet[BASE_NET], "0x" + "b2".repeat(32)) });
  ok(smuggled.status === 402 && verifies === v0 && speechCalls === s0, `a 1-char payment with a 2,000-char body is refused at the paywall, never verified or spoken (${smuggled.status})`);

  // 4. over the cap: the 402 quotes the ceiling; paid, refused before any spend
  const cap = TTS_TIERS.tts.maxChars;
  const over = await quoteOf("/api/tts", { text: text(cap + 1) });
  ok(over.byNet[BASE_NET]?.amount === micro(ttsQuoteUsd("tts", cap)), `${cap + 1} chars quotes the ceiling, never more (${over.byNet[BASE_NET]?.amount})`);
  const s1 = settles, sp1 = speechCalls;
  const overPaid = await post("/api/tts", { text: text(cap + 1) }, { "payment-signature": credential(over.pr, over.byNet[BASE_NET], "0x" + "c3".repeat(32)) });
  const overBody = await overPaid.json().catch(() => ({}));
  ok(overPaid.status === 400 && /Text too long/.test(overBody.error || "") && settles === s1 && speechCalls === sp1, `paid over the cap: refused 400 before any speech call, nothing settled (${overPaid.status})`);

  // 5. a prepaid credits key is held and debited the quote
  const credit = async (n) => {
    const r = await post("/api/tts-hd", { text: text(n) }, { authorization: `Bearer ${CREDIT_KEY}` });
    return { status: r.status, balance: Number(r.headers.get("x-credits-balance")), error: r.headers.get("x-credits-error") };
  };
  const c1 = await credit(100);
  ok(c1.status === 200 && Math.abs(c1.balance - (5 - ttsQuoteUsd("tts-hd", 100))) < 1e-9, `credits: the hold for 100 chars on tts-hd is the quote $${ttsQuoteUsd("tts-hd", 100)} (balance ${c1.balance}${c1.error ? `, ${c1.error}` : ""})`);
  const c2 = await credit(5000);
  ok(c2.status === 200 && Math.abs(c2.balance - (5 - ttsQuoteUsd("tts-hd", 100) - ttsQuoteUsd("tts-hd", 5000))) < 1e-9, `credits: the hold for 5,000 chars is the quote $${ttsQuoteUsd("tts-hd", 5000)} (balance ${c2.balance})`);
  const booked = await waitFor(() => { const rows = creditSales(); return rows.length >= 2 ? rows : null; });
  ok(booked && Math.abs(booked[0].price_usd - ttsQuoteUsd("tts-hd", 100)) < 1e-9 && Math.abs(booked[1].price_usd - ttsQuoteUsd("tts-hd", 5000)) < 1e-9, `credits: each sale is booked at its quote (${(booked || []).map((r) => r.price_usd).join(", ")})`);

  // 6. the surfaces publish the range and the formula
  for (const [slug, path] of [["tts", "/api/tts"], ["tts-hd", "/api/tts-hd"]]) {
    const row = pricing.endpoints.find((e) => e.path === path);
    const cap2 = TTS_TIERS[slug].maxChars;
    ok(row?.quoted === true && row.quoteRange?.minUsd === ttsQuoteUsd(slug, 0) && row.quoteRange?.maxUsd === ttsQuoteUsd(slug, cap2) && row.quoteFormula === ttsQuoteFormula(slug), `/api/pricing: ${path} is quoted, with its range and formula`);
  }
  const openapi = await (await fetch(`${B}/openapi.json`)).json();
  const op = openapi?.paths?.["/api/tts"]?.post;
  ok(op?.["x-payment-info"]?.price?.mode === "dynamic" && op["x-payment-info"].price.max === "0.293" && op["x-payment-info"].quoteFormula === ttsQuoteFormula("tts") && op.description.includes(ttsQuoteFormula("tts")), "/openapi.json: a dynamic price with the range and the formula");
  const page = await (await fetch(`${B}/tools/tts-hd`)).text();
  ok(page.includes(ttsQuoteFormula("tts-hd").replace(/&/g, "&amp;")), "the tool page states the formula");
  const llmsFull = await (await fetch(`${B}/llms-full.txt`)).text();
  const line = llmsFull.split("\n").find((l) => l.startsWith("- tts | POST /api/tts |"));
  ok(line && line.includes("| from $0.005 |") && line.includes(ttsQuoteFormula("tts")), `/llms-full.txt: the catalog line reads "from" the floor and carries the formula`);

  console.log(`\nPASS - ${pass} checks (tts quote, booted paid server)`);
  cleanup(); process.exit(0);
} catch (e) { fail(e?.stack || String(e)); }
