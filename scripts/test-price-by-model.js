#!/usr/bin/env node
// Price by model on a booted PAID server (stub facilitator, no upstream key).
//
// A flat chat route asked for another flat tier's model answers a 402 quoting
// that model's HOME tier price, and a payment at that price is served under the
// home tier's config. The unit suites pin the kit; this pins the WIRING the kit
// cannot see: the x402 price function (payments.js), the Tempo challenge minted
// through server.js's quotedPriceUsd (the same function the Stripe and credits
// gates price through), and the handler serving only what was paid for.
//
// Discriminator for "served as the home tier": OPENROUTER_API_KEY is empty, so
// a request that clears validation at the home tier ends 503 "not configured"
// (settlement cancelled), while one left on the route tier ends 400 "served by
// the ... tier". Nothing leaves the machine; nothing settles.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Challenge } from "mppx";
import { getFreePorts } from "./lib/free-port.js";
import { PRICED_BY_MODEL_NOTE } from "../src/tools/llm-gateway-kit.js";

const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
const PAYER = "0x00000000000000000000000000000000000000b2";
const TREASURY = "0x000000000000000000000000000000000000dEaD";
let pass = 0, proc = null, facilitator = null;
const serverLog = [];
const fail = (m) => {
  console.error("FAIL:", m);
  if (serverLog.length) { console.error("--- server output (last lines) ---"); for (const l of serverLog) console.error(l); }
  proc?.kill("SIGKILL"); facilitator?.close(); process.exit(1);
};
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let verifies = 0, settles = 0, relayCalls = 0;
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") { verifies++; return reply(200, { isValid: true, payer: PAYER }); }
    if (req.url === "/settle") { settles++; return reply(200, { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: PAYER }); }
    if (req.url.startsWith("/tempo")) { relayCalls++; return reply(500, { error: "stub relay: never expected" }); }
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

proc = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "", NODE_ENV: "test",
    WALLET_ADDRESS: TREASURY, NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
    // No upstream: a request that clears validation ends at the key check.
    OPENROUTER_API_KEY: "",
    // Tempo challenges are minted through quotedPriceUsd; the relay is a local stub nothing should reach.
    MPP_SECRET_KEY: "test-price-by-model-secret", TEMPO_API_KEY: "test-tempo-key", TEMPO_RECIPIENT_ADDRESS: TREASURY,
    TEMPO_API_BASE_URL: `http://127.0.0.1:${FAC_PORT}/tempo`, STRIPE_SECRET_KEY: "", STRIPE_PROFILE_ID: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    WALLET_DIGEST: "off", SOLANA_LEADERBOARD: "off", LEADERBOARD_FIRST_REFRESH_DELAY_MS: "3600000",
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
  const ch = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": w })).find((c) => c.method === "tempo");
  return ch?.request?.amount ?? null;
};
const quoteOf = async (path, body) => {
  const r = await post(path, body);
  const pr = decode402(r);
  const amounts = [...new Set((pr?.accepts || []).map((a) => a.amount))];
  return { status: r.status, pr, amounts, tempo: tempoAmount(r) };
};
const credential = (pr, accepted, nonce) => Buffer.from(JSON.stringify({
  x402Version: 2, resource: pr.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce } },
})).toString("base64");

const MSG = [{ role: "user", content: "hi" }];
const OPUS = "anthropic/claude-opus-5";
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }
  ok((await fetch(`${B}/health`)).ok, "server booted (paid mode, stub facilitator)");

  // 1. the 402 quotes the model's home tier on every flat route and wire
  const same = await quoteOf("/v1/chat/completions", { model: "openai/gpt-4o-mini", messages: MSG });
  ok(same.status === 402 && same.amounts.length === 1 && same.amounts[0] === "20000", `base route + base model: 402 quotes the base price (${same.amounts.join(",")})`);
  const up = await quoteOf("/v1/chat/completions", { model: OPUS, messages: MSG });
  ok(up.status === 402 && up.amounts.length === 1 && up.amounts[0] === "500000", `base route + premium model: 402 quotes the premium price on every accept (${up.amounts.join(",")})`);
  ok(same.tempo === "20000" && up.tempo === "500000", `the Tempo challenge (priced through quotedPriceUsd, as the Stripe and credits gates are) carries the same per-model price (${same.tempo} / ${up.tempo})`);
  const nanoUp = await quoteOf("/v1/nano/chat/completions", { model: OPUS, messages: MSG });
  ok(nanoUp.amounts[0] === "500000" && nanoUp.tempo === "500000", "nano route + premium model: 402 quotes the premium price");
  const down = await quoteOf("/v1/premium/chat/completions", { model: "openai/gpt-5.6-luna", messages: MSG });
  ok(down.amounts[0] === "3000", `premium route + a nano-home model: 402 quotes the nano price (${down.amounts.join(",")})`);
  const unknown = await quoteOf("/v1/chat/completions", { model: "not-a-real/model", messages: MSG });
  ok(unknown.amounts[0] === "20000", "an unknown model quotes the route price (the handler's 400 refuses it, uncharged)");
  const msgs = await quoteOf("/v1/messages", { model: OPUS, max_tokens: 64, messages: MSG });
  const resp = await quoteOf("/v1/responses", { model: OPUS, input: "hi" });
  const gem = await quoteOf("/v1/gemini", { model: OPUS, contents: [{ role: "user", parts: [{ text: "hi" }] }] });
  ok([msgs, resp, gem].every((q) => q.status === 402 && q.amounts[0] === "500000"), `Messages, Responses and Gemini base routes quote the premium price for a premium model (${[msgs, resp, gem].map((q) => q.amounts[0]).join(", ")})`);

  // 2. the static surfaces keep each tier's own list price
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const flatJson = JSON.stringify(pricing);
  const tiers = pricing?.llmGateway?.tiers || [];
  const baseRow = tiers.find((t) => t.path === "/v1/chat/completions");
  ok(baseRow?.price === "$0.02" && baseRow?.quoted === undefined, `/api/pricing keeps the base route at $0.02 and does not mark it quoted (${JSON.stringify(baseRow)})`);
  ok(tiers.filter((t) => t.quoted).every((t) => t.path.startsWith("/v1/metered/")), "only the metered routes are marked quoted on /api/pricing");
  ok(flatJson.includes("/v1/chat/completions"), "/api/pricing still lists the base route");
  const openapi = await (await fetch(`${B}/openapi.json`)).json();
  const op = openapi?.paths?.["/v1/chat/completions"]?.post;
  ok(op?.["x-price"] === "$0.02", `/openapi.json keeps the base route's list price (x-price ${op?.["x-price"]})`);

  // 2b. ...and every surface that publishes that fixed number SAYS the price
  // depends on the model, or is a surface the change cannot make stale. A
  // correct figure with no sentence beside it reads as a ceiling, and a buyer
  // budgeting from /api/pricing meets the difference in a 402.
  ok(baseRow?.pricedByModel === true, "/api/pricing marks the flat chat route pricedByModel");
  ok(tiers.filter((t) => t.quoted).every((t) => t.pricedByModel === undefined),
    "the metered routes are quoted, never pricedByModel - two different pricing shapes, never conflated");
  ok(typeof pricing?.llmGateway?.pricingByModel === "string" && /agent402_tier/.test(pricing.llmGateway.pricingByModel),
    "/api/pricing says in words what a flat chat route's price depends on, and how the answer discloses it");
  ok(pricing.llmGateway.pricingByModel === PRICED_BY_MODEL_NOTE,
    "that sentence is the kit's own constant, not a second copy that can drift");
  const eps = pricing?.endpoints || [];
  const chatEp = eps.find((e) => e.path === "/v1/chat/completions");
  const hashEp = eps.find((e) => e.path === "/api/hash");
  ok(chatEp?.pricedByModel === true && chatEp?.price === "$0.02", `the endpoints row carries the flag beside the list price (${chatEp?.price})`);
  ok(hashEp && hashEp.pricedByModel === undefined, "a route whose price cannot move carries no flag at all (absent, never false)");
  const byModelEps = eps.filter((e) => e.pricedByModel).map((e) => e.path);
  ok(byModelEps.length > 0 && byModelEps.every((p) => p.startsWith("/v1/") && !p.startsWith("/v1/metered/")),
    `only flat /v1 routes are flagged (${byModelEps.length}: ${byModelEps.slice(0, 4).join(", ")})`);
  ok(op?.description?.includes(PRICED_BY_MODEL_NOTE), "/openapi.json says it in the operation description, beside the price");
  const hashOp = openapi?.paths?.["/api/hash"]?.get || openapi?.paths?.["/api/hash"]?.post;
  ok(hashOp && !hashOp.description?.includes(PRICED_BY_MODEL_NOTE), "an unaffected operation does not carry the note");

  // /v1/models is the surface an agent PICKS a model from, and it stays exactly
  // correct: each id is advertised at its home tier's route and that route's
  // own price, which is what a buyer sending it there pays.
  const models = await (await fetch(`${B}/v1/models`)).json();
  const priceByPath = new Map(tiers.map((t) => [t.path, Number(String(t.price).replace(/[^0-9.]/g, ""))]));
  const badModel = (models?.data || []).filter((m) => m?.x402?.endpoint && m.x402.priceUsd !== undefined
    && priceByPath.has(m.x402.endpoint) && Math.abs(priceByPath.get(m.x402.endpoint) - m.x402.priceUsd) > 1e-9);
  ok((models?.data || []).length > 0 && badModel.length === 0,
    `every /v1/models row advertises its home route's own price${badModel.length ? ` - ${badModel.slice(0, 3).map((m) => m.id).join(", ")}` : ""}`);

  // The x402 manifest publishes resources as bare URLs and ONE catalog-wide
  // price range, so it carries no per-route number this can make stale - and
  // the range already spans the tier prices a cross-tier quote can name.
  const manifest = await (await fetch(`${B}/.well-known/x402`)).json();
  ok((manifest?.resources || []).some((u) => u.endsWith("/v1/chat/completions")), "the manifest lists the flat chat route");
  ok((manifest?.resources || []).every((r) => typeof r === "string"), "manifest resources are bare URLs, so there is no per-resource price there to go stale");
  // One catalog-wide range, published as a display string ("$0.001-$3.3").
  const range = String(manifest?.payment?.x402?.priceRange || "");
  const rangeHi = Math.max(...range.split(/[^0-9.]+/).filter(Boolean).map(Number), 0);
  ok(rangeHi >= 0.5, `the manifest's price range already spans the premium price a cross-tier quote can name (${range})`);

  // The challenge itself: the only amount on it is accepts[].amount, which is
  // the quote asserted above. The bazaar extension carries schemas, not prices.
  const bazaar = up.pr?.extensions?.bazaar ?? up.pr?.extensions?.["x402/bazaar"];
  ok(!JSON.stringify(bazaar ?? {}).includes('"amount"'), "the 402's discovery extension carries no amount of its own");

  // 3. paid at the premium price -> served under the premium config
  const v0 = verifies;
  const acceptUp = up.pr.accepts.find((a) => a.scheme === "exact" && a.network === "eip155:8453");
  const paid = await post("/v1/chat/completions", { model: OPUS, messages: MSG }, { "payment-signature": credential(up.pr, acceptUp, "0x" + "aa".repeat(32)) });
  const paidBody = await paid.json().catch(() => ({}));
  ok(verifies === v0 + 1, `the premium-priced payment reached the facilitator verify (verifies ${verifies - v0})`);
  ok(paid.status === 503 && /not configured/.test(paidBody.error || ""), `paid at the premium price: validated under the premium tier and reached the upstream key check (${paid.status} ${String(paidBody.error || "").slice(0, 60)})`);

  // 4. a payment at the base price cannot ride a premium body
  const v1 = verifies;
  const acceptSame = same.pr.accepts.find((a) => a.scheme === "exact" && a.network === "eip155:8453");
  const smuggled = await post("/v1/chat/completions", { model: OPUS, messages: MSG }, { "payment-signature": credential(same.pr, acceptSame, "0x" + "bb".repeat(32)) });
  ok(smuggled.status === 402 && verifies === v1, `a base-price payment with a premium body is refused at the paywall, never verified or served (${smuggled.status}, verifies +${verifies - v1})`);

  // 5. a base model paid at the base price is dispatched as before
  const plain = await post("/v1/chat/completions", { model: "openai/gpt-4o-mini", messages: MSG }, { "payment-signature": credential(same.pr, acceptSame, "0x" + "cc".repeat(32)) });
  const plainBody = await plain.json().catch(() => ({}));
  ok(plain.status === 503 && /not configured/.test(plainBody.error || ""), `base model at the base price is served on the base tier as before (${plain.status})`);

  // 5b. model "auto" on every flat route and wire: the 402 quotes the AUTO
  // price, a payment at it is served as the auto tier, and a nano-priced
  // payment (below auto) with an auto body is refused at the paywall.
  const G = [{ role: "user", parts: [{ text: "hi" }] }];
  const autoQuotes = {
    chat: await quoteOf("/v1/chat/completions", { model: "auto", messages: MSG }),
    nano: await quoteOf("/v1/nano/chat/completions", { model: "auto", messages: MSG }),
    pro: await quoteOf("/v1/pro/chat/completions", { model: "auto", messages: MSG }),
    premium: await quoteOf("/v1/premium/chat/completions", { model: "auto", messages: MSG }),
    messages: await quoteOf("/v1/messages", { model: "auto", max_tokens: 64, messages: MSG }),
    responses: await quoteOf("/v1/responses", { model: "auto", input: "hi" }),
    gemini: await quoteOf("/v1/gemini", { model: "auto", contents: G }),
  };
  ok(Object.values(autoQuotes).every((q) => q.status === 402 && q.amounts.length === 1 && q.amounts[0] === "10000" && q.tempo === "10000"),
    `model "auto" quotes the auto price on every flat route and wire (${Object.entries(autoQuotes).map(([k, q]) => `${k} ${q.amounts.join("/")}`).join(", ")})`);
  const autoAccept = autoQuotes.chat.pr.accepts.find((a) => a.scheme === "exact" && a.network === "eip155:8453");
  const autoPaid = await post("/v1/chat/completions", { model: "auto", messages: MSG }, { "payment-signature": credential(autoQuotes.chat.pr, autoAccept, "0x" + "dd".repeat(32)) });
  const autoPaidBody = await autoPaid.json().catch(() => ({}));
  ok(autoPaid.status === 503 && /not configured/.test(autoPaidBody.error || ""), `paid at the auto price: validated under the auto tier and reached the upstream key check (${autoPaid.status} ${String(autoPaidBody.error || "").slice(0, 60)})`);
  const nanoQ = await quoteOf("/v1/nano/chat/completions", { model: "openai/gpt-5.6-luna", messages: MSG });
  const nanoAccept = nanoQ.pr.accepts.find((a) => a.scheme === "exact" && a.network === "eip155:8453");
  const v2 = verifies;
  const cheap = await post("/v1/nano/chat/completions", { model: "auto", messages: MSG }, { "payment-signature": credential(nanoQ.pr, nanoAccept, "0x" + "ee".repeat(32)) });
  ok(nanoQ.amounts[0] === "3000" && cheap.status === 402 && verifies === v2, `a nano-price payment with an auto body is refused at the paywall (${cheap.status}, verifies +${verifies - v2})`);

  ok(settles === 0 && relayCalls === 0, `nothing settled and no relay was called (settles ${settles}, relay ${relayCalls})`);

  // 6. from source: a charged-but-failed debt records the price THIS request was
  // gated at, so a call priced at its model's home tier is owed at that price.
  const { readFileSync } = await import("node:fs");
  const serverSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const debtStart = serverSrc.indexOf("const receipt = decodeSettleReceipt(settleReceipt);");
  const debt = serverSrc.slice(debtStart, serverSrc.indexOf("recordRefundOwed({", debtStart));
  ok(/const priceUsd = settledPriceUsd\(def, req, res\);/.test(debt) && !/def\.price/.test(debt), "the charged-failure debt is priced by settledPriceUsd (the gated price), never the route's list price");
  ok(/priceFnOf\(def\) && Number\.isFinite\(req\?\.__meteredQuoteUsd\)/.test(serverSrc), "settledPriceUsd honours a flat route's tierQuote stash, so the books record the home-tier price");
  console.log(`\nPASS - ${pass} checks (price by model, booted paid server)`);
  proc.kill("SIGKILL"); facilitator.close(); process.exit(0);
} catch (e) { fail(e?.stack || String(e)); }
