// The `payment` block of a first-contact 402 body (src/payment-guide.js): the
// dollar price of this request, how to pay, the free path where one exists,
// and where to read more. Additive: every other body field and the
// PAYMENT-REQUIRED header are what they were without it.
//
// Part 1, pure: the block's shape, the price spelling, what a quote echoes.
// Part 2, three paid-mode boots on port 0 against a local /supported stub
// (no payment is made, nothing leaves the machine):
//   A  Base primary, Optimism beside it with a settlement premium
//   B  the same environment with the block switched off (PAYMENT_GUIDE_402=off),
//      or, with PAYMENT_GUIDE_BASE_TREE=<a checkout of the batch base>, that
//      tree's own server: every pre-existing field of A's 402 must equal B's
//   C  Optimism as the only network, so the stated price carries the premium
// Checked on a flat tool, a proof-of-work tool and the metered route: the
// price equals /api/pricing and the accept it names, the metered block names
// the model the caller sent, the links answer, and nothing but the caller's
// own inputs and the total is in the block.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { ownStoreEnv } from "./lib/own-stores.js";
import { paymentGuide, quoteInputs, usdText, HOW_TO_PAY_PATH, HOW_SENTENCE, PAY_HEADING } from "../src/payment-guide.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_TREE = process.env.PAYMENT_GUIDE_BASE_TREE ? resolve(process.env.PAYMENT_GUIDE_BASE_TREE) : "";
const ORIGIN = "https://tools.example";
const OP = "eip155:10", BASE_NET = "eip155:8453";
const PREMIUM_USD = 0.001;
// The whole block, and the most it may add to a 402 body.
const BLOCK_KEYS = ["price", "network", "how", "quote", "noWallet", "docs", "howToPay", "mcp"];
const MAX_ADDED_BYTES = 600;

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const microOf = (usd) => Math.round(Number(String(usd ?? "").replace(/[^0-9.]/g, "")) * 1e6);

// ---- Part 1: pure ---------------------------------------------------------------
{
  const g = paymentGuide({ price: "$0.010", network: "base", baseUrl: `${ORIGIN}/` });
  ok(JSON.stringify(Object.keys(g)) === JSON.stringify(["price", "network", "how", "docs", "howToPay", "mcp"]), `a flat tool's block: ${Object.keys(g).join(",")}`);
  ok(g.price === "$0.010" && g.network === "base" && g.how === HOW_SENTENCE, "it states the price as given, the network it is for, and one sentence on paying");
  ok(g.docs === `${ORIGIN}/llms.txt` && g.howToPay === `${ORIGIN}${HOW_TO_PAY_PATH}` && g.mcp === `${ORIGIN}/mcp`, "the three links are on the server's origin (a trailing slash folded)");
  const pow = paymentGuide({ price: "$0.001", network: "base", baseUrl: ORIGIN, powEligible: true });
  ok(pow.noWallet?.method === "proof-of-work" && pow.noWallet.price === "free" && pow.noWallet.how === `${ORIGIN}/api/pow`, "a proof-of-work tool names the free path and its documented flow");
  ok(!("noWallet" in g), "control: a tool without a free tier names no wallet-free path");
  ok(paymentGuide({ price: "see /api/pricing", network: "base", baseUrl: ORIGIN }) === null && paymentGuide({ price: "$0.01", network: "", baseUrl: ORIGIN }) === null, "no readable price or no network: no block");
  ok(usdText(0.0105) === "$0.0105" && usdText(0.002) === "$0.002" && usdText(1) === "$1" && usdText(0.0000019) === "$0.000002", "a quote is spelled to the micro-dollar with trailing zeros cut");
  ok(JSON.stringify(quoteInputs({ model: "anthropic/claude-haiku-5.5", max_tokens: 200, messages: [] }, "187")) === JSON.stringify({ model: "anthropic/claude-haiku-5.5", requestBytes: 187, maxOutputTokens: 200 }), "a quote echoes the model sent, the request size and the output cap");
  ok(JSON.stringify(quoteInputs({ model: "x".repeat(300), max_tokens: -5 }, undefined)) === "{}" && !("model" in quoteInputs({ model: "<script>" }, 0)) && !("model" in quoteInputs({ model: { a: 1 } }, 0)), "a model id that is not shaped like one, a missing size and a bad cap are left out");
  ok(quoteInputs({ max_completion_tokens: 64 }, 10).maxOutputTokens === 64 && quoteInputs({ max_output_tokens: 32 }, 10).maxOutputTokens === 32, "the output cap is read under each wire's name");
  ok(Buffer.byteLength(JSON.stringify({ payment: paymentGuide({ price: "$0.123456", network: "robinhood", baseUrl: "https://agent402.tools", powEligible: true, quote: quoteInputs({ model: "a".repeat(120), max_tokens: 128000 }, 4_000_000) }) })) <= MAX_ADDED_BYTES + 150, "the largest block stays small");
}

// ---- Part 2: the served 402 ---------------------------------------------------------
const facilitator = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    if (req.url === "/supported") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ kinds: [BASE_NET, OP].map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const stub = `http://127.0.0.1:${facilitator.address().port}`;

const children = [];
async function boot(label, extra, cwd = ROOT) {
  const env = {
    ...process.env, ...ownStoreEnv(`payment-guide-${label}`),
    PORT: "0", FREE_MODE: "", NODE_ENV: "test", BASE_URL: ORIGIN, TARGET_URL: "",
    NETWORK: "base", PAYMENT_NETWORKS: "base,optimism",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    FACILITATOR_URL: stub, SOLVADOR_KEY: "test-key", SOLVADOR_FACILITATOR_URL: stub, ROBINHOOD_RELAYER_KEY: "",
    NETWORK_PRICE_PREMIUMS: `${OP}=${PREMIUM_USD}`, NETWORK_PRICE_FLOORS: "",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
    MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", OPENROUTER_API_KEY: "", GATEWAY_NANOPAYMENTS: "",
    FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
    MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true",
    FRONT_DOOR_402: "", PAYMENT_REQUIRED_BODY: "", FIRST_CALL_ALLOWANCE: "", PAYMENT_GUIDE_402: "",
    ...extra,
  };
  const child = spawn(process.execPath, ["src/server.js"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${label} did not start: ${log.slice(-800)}`)), 120_000);
    const tick = setInterval(() => { const m = log.match(/listening on :(\d+)/); if (m) { clearInterval(tick); clearTimeout(t); res(Number(m[1])); } }, 100);
    child.on("exit", (c) => { clearInterval(tick); clearTimeout(t); rej(new Error(`${label} exited ${c}: ${log.slice(-800)}`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 250)); }
  return url;
}
const METERED_BODY = { model: "anthropic/claude-haiku-5.5", messages: [{ role: "user", content: "Name three rivers." }], max_tokens: 200 };
const REQUESTS = {
  flat: { path: "/api/extract", body: { url: "https://example.com/" } },
  pow: { path: "/api/hash", body: { text: "hello" } },
  metered: { path: "/v1/metered/chat/completions", body: METERED_BODY },
  meteredEmpty: { path: "/v1/metered/chat/completions", body: {} },
  // A request large enough that its quote is above the route's list price.
  meteredLarge: { path: "/v1/metered/chat/completions", body: { model: "anthropic/claude-opus-5", messages: [{ role: "user", content: "Name three rivers." }], max_tokens: 8000 } },
};
const ask = async (url, { path, body }, headers = {}) => {
  const r = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported by the caller */ }
  let header = null;
  try { header = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8")); } catch { /* none */ }
  return { status: r.status, text, json, header, bytes: Buffer.byteLength(text) };
};
const acceptOn = (body, network) => (body?.accepts || []).find((a) => a.network === network && a.scheme === "exact");

try {
  const [A, B, C] = await Promise.all([
    boot("a", {}),
    BASE_TREE ? boot("base-tree", {}, BASE_TREE) : boot("off", { PAYMENT_GUIDE_402: "off" }),
    boot("c", { NETWORK: "optimism", PAYMENT_NETWORKS: "optimism" }),
  ]);
  const B_NAME = BASE_TREE ? "the batch base tree" : "the block switched off";
  const pricing = await (await fetch(`${A}/api/pricing`)).json();
  const listed = (path) => (pricing.endpoints || []).find((e) => e.path === path) || (pricing.llmGateway?.tiers || []).find((t) => t.path === path);
  ok((pricing.endpoints || []).length > 400 && JSON.stringify(pricing.payment?.premiumUsdByNetwork) === JSON.stringify({ optimism: PREMIUM_USD }), `boot A offers Base and Optimism with the premium published (${JSON.stringify(pricing.payment?.networks)})`);

  const got = {};
  for (const [name, reqSpec] of Object.entries(REQUESTS)) got[name] = { a: await ask(A, reqSpec), b: await ask(B, reqSpec) };

  // PAYMENT_GUIDE_PRINT=1 prints each block as served, for a report.
  if (process.env.PAYMENT_GUIDE_PRINT) for (const [name, { a }] of Object.entries(got)) console.log(`# ${name}: ${JSON.stringify({ payment: a.json?.payment })}`);

  // -- the block, per kind of route --
  for (const name of ["flat", "pow", "metered", "meteredEmpty"]) {
    const { a } = got[name];
    const p = a.json?.payment;
    ok(a.status === 402 && p && typeof p === "object", `${name}: the 402 carries a payment block`);
    if (!p) continue;
    ok(Object.keys(p).every((k) => BLOCK_KEYS.includes(k)) && p.how === HOW_SENTENCE, `${name}: only the documented keys (${Object.keys(p).join(",")})`);
    const base = acceptOn(a.json, BASE_NET), op = acceptOn(a.json, OP);
    ok(p.network === "base" && base && microOf(p.price) === Number(base.amount), `${name}: the price ${p.price} is the Base accept's amount (${base?.amount})`);
    ok(op && Number(op.amount) === Number(base?.amount) + microOf(PREMIUM_USD), `${name}: control, the Optimism accept asks the premium on top (${op?.amount}), so the block names its network`);
    ok(p.docs === `${ORIGIN}/llms.txt` && p.howToPay === `${ORIGIN}${HOW_TO_PAY_PATH}` && p.mcp === `${ORIGIN}/mcp`, `${name}: the links are on the public origin`);
    ok(!/credit|a402_|mpp|tempo|card/i.test(JSON.stringify(p)), `${name}: the block offers nothing this boot does not sell`);
  }
  {
    const p = got.flat.a.json?.payment || {};
    ok(p.price === listed("/api/extract")?.price, `flat: the price is /api/pricing's own string (${p.price} vs ${listed("/api/extract")?.price})`);
    ok(!("noWallet" in p) && !("quote" in p) && !got.flat.a.json.altPayment, "flat: no free path and no quote on a wallet-only flat tool");
  }
  {
    const p = got.pow.a.json?.payment || {};
    ok(p.price === listed("/api/hash")?.price && listed("/api/hash")?.computePayable === true, `proof-of-work tool: the price is /api/pricing's (${p.price})`);
    ok(p.noWallet?.method === "proof-of-work" && p.noWallet.price === "free" && p.noWallet.how === `${ORIGIN}/api/pow`, `proof-of-work tool: the block names the free path (${JSON.stringify(p.noWallet)})`);
    ok(Object.keys(got.pow.a.json)[0] === "altPayment" && typeof got.pow.a.json.altPayment.challengeUrl === "string", "proof-of-work tool: altPayment is still the first key, with its challenge link");
  }
  {
    const p = got.metered.a.json?.payment || {};
    const row = listed("/v1/metered/chat/completions");
    const range = (pricing.endpoints || []).find((e) => e.path === "/v1/metered/chat/completions")?.quoteRange || {};
    ok(p.quote?.model === METERED_BODY.model, `metered: the block names the model the caller sent (${p.quote?.model})`);
    ok(got.metered.a.json.howToCall?.body?.model !== METERED_BODY.model, "metered: control, howToCall still shows the catalog example, a different model");
    ok(p.quote?.maxOutputTokens === 200 && p.quote.requestBytes === Buffer.byteLength(JSON.stringify(METERED_BODY)), `metered: and the caller's own size and cap (${JSON.stringify(p.quote)})`);
    ok(JSON.stringify(Object.keys(p.quote || {})) === JSON.stringify(["model", "requestBytes", "maxOutputTokens"]), "metered: the quote holds the caller's inputs only: no cost, rate or markup field");
    ok(microOf(p.price) >= microOf(range.minUsd) && microOf(p.price) <= microOf(range.maxUsd), `metered: the quote ${p.price} is inside /api/pricing's range (${range.minUsd}..${range.maxUsd})`);
    // A quote above the list price: the block states this request's own
    // price, the amount its accept asks, never the route's list price.
    const big = got.meteredLarge.a.json?.payment || {};
    const bigBase = acceptOn(got.meteredLarge.a.json, BASE_NET);
    ok(Number(bigBase?.amount) > microOf(row?.price), `metered, a large request: control, its Base accept asks more than the list price (${bigBase?.amount} vs ${row?.price})`);
    ok(microOf(big.price) === Number(bigBase?.amount) && big.price !== row?.price && big.quote?.maxOutputTokens === 8000, `metered, a large request: payment.price ${big.price} is the amount in the same 402's accept (${bigBase?.amount}), not the list price ${row?.price}`);
    const e = got.meteredEmpty.a.json?.payment || {};
    ok(microOf(e.price) === microOf(row?.price) && !("model" in (e.quote || {})), `metered, a body that names nothing: the floor /api/pricing lists (${e.price} vs ${row?.price}) and no model`);
  }

  // -- additive: every pre-existing field equals B's --
  for (const name of Object.keys(REQUESTS)) {
    const { a, b } = got[name];
    const { payment, ...rest } = a.json || {};
    ok(b.status === 402 && !("payment" in (b.json || {})), `${name}: control, ${B_NAME} answers the same 402 without the block`);
    ok(isDeepStrictEqual(rest, b.json), `${name}: every other body field deep-equals ${B_NAME}`);
    ok(JSON.stringify(Object.keys(rest)) === JSON.stringify(Object.keys(b.json || {})), `${name}: in the same order (${Object.keys(a.json || {}).join(",")})`);
    ok(isDeepStrictEqual(a.json?.accepts, b.json?.accepts) && JSON.stringify(a.json?.accepts) === JSON.stringify(b.json?.accepts), `${name}: accepts is byte-identical`);
    ok(a.header && isDeepStrictEqual(a.header, b.header) && !JSON.stringify(a.header).includes("howToPay"), `${name}: the PAYMENT-REQUIRED header is the same object and does not carry the block`);
    const added = a.bytes - b.bytes;
    ok(added > 0 && added <= MAX_ADDED_BYTES, `${name}: the body grew ${added} bytes (${b.bytes} -> ${a.bytes}), at most ${MAX_ADDED_BYTES}`);
  }

  // -- a refused credential keeps its own explanation --
  {
    const r = await ask(A, REQUESTS.flat, { authorization: "Bearer a402_00000000000000000000" });
    ok(r.status !== 200 && !r.json?.payment, "a request that presented a credential gets no payment block");
  }

  // -- an x402 header: one that does not decode is first contact; one that decodes and is refused is not --
  {
    for (const name of ["payment-signature", "x-payment"]) {
      const bad = await ask(A, REQUESTS.flat, { [name]: "!!!not base64!!!" });
      ok(bad.status === 402 && bad.json?.reason === "malformed-header" && typeof bad.json?.payment === "object" && bad.json.payment.price === got.flat.a.json?.payment?.price,
        `a ${name} header that does not decode is treated as first contact: the 402 carries the payment block beside reason malformed-header (${bad.status}, ${bad.json?.reason}, ${bad.json?.payment?.price})`);
    }
    // A well-formed v2 exact payment for this route that no key signed.
    const accept = acceptOn(got.flat.a.json, BASE_NET);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      x402Version: 2, resource: got.flat.a.header?.resource, accepted: accept,
      payload: { signature: `0x${"11".repeat(65)}`, authorization: { from: "0x000000000000000000000000000000000000bEEF", to: accept?.payTo, value: accept?.amount, validAfter: "0", validBefore: String(now + 300), nonce: `0x${"22".repeat(32)}` } },
    };
    const refused = await ask(A, REQUESTS.flat, { "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") });
    ok(!!accept && refused.status === 402 && !("payment" in (refused.json || {})), `a header that decodes and is refused gets no payment block (${refused.status}, reason ${refused.json?.reason}, keys ${Object.keys(refused.json || {}).join(",")})`);
  }

  // -- the primary network carries a premium: the stated price does too --
  {
    const r = await ask(C, REQUESTS.flat);
    const p = r.json?.payment || {};
    const op = acceptOn(r.json, OP);
    const cPricing = await (await fetch(`${C}/api/pricing`)).json();
    const list = (cPricing.endpoints || []).find((e) => e.path === "/api/extract")?.price;
    const premium = cPricing.payment?.premiumUsdByNetwork?.optimism;
    ok(p.network === "optimism" && op && microOf(p.price) === Number(op.amount), `premium chain: the price ${p.price} is the Optimism accept's amount (${op?.amount})`);
    ok(premium === PREMIUM_USD && microOf(p.price) === microOf(list) + microOf(premium), `premium chain: and equals /api/pricing's list price plus its published premium (${list} + ${premium})`);
  }

  // -- the links answer on this server --
  {
    const llms = await fetch(`${A}/llms.txt`);
    const agents = await fetch(`${A}/agents.md`);
    const agentsText = await agents.text();
    const pow = await fetch(`${A}/api/pow`);
    const mcp = await fetch(`${A}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
    ok(llms.status === 200 && agents.status === 200 && pow.status === 200 && mcp.status === 200, `the linked pages answer (${llms.status}, ${agents.status}, ${pow.status}, mcp ${mcp.status})`);
    ok(new RegExp(`^## ${PAY_HEADING}$`, "m").test(agentsText) && HOW_TO_PAY_PATH === `/agents.md#${PAY_HEADING.toLowerCase()}`, "and /agents.md has the Pay heading the howToPay link names");
  }
} catch (e) {
  failed++;
  console.error(`FAIL - ${e?.stack || e}`);
} finally {
  for (const c of children) c.kill("SIGTERM");
  facilitator.close();
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
