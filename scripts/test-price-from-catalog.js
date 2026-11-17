#!/usr/bin/env node
// The price a paid route asks for is the catalog's, whatever the caller sends,
// and a payment for any other amount, recipient or asset never reaches the
// facilitator.
//
//   node scripts/test-price-from-catalog.js
//
// Boots a PAID server against a stub facilitator (the shape
// scripts/test-payment-required-body.js uses) and reads real 402s:
//
//   1. The unpaid 402 for a fixed-price route asks for the amount /api/pricing
//      lists for it, in USDC atomic units.
//   2. The same request carrying every price-shaped field a caller could send
//      (query, JSON body and headers: price, amount, maxAmountRequired, payTo,
//      asset, network) gets a byte-identical offer.
//   3. A payment whose accepted terms differ from the offer in amount (lower),
//      recipient or asset is refused with a 402 and the facilitator's verify
//      is never called; neither is settle.
//   4. Control: the offer's own terms, unchanged, are verified, served and
//      settled once, so the refusals above are the terms check and not a
//      server that refuses everything.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const PAYER = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000e7";
const fac = { verify: 0, settle: 0 };
const AGG3 = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);
const facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let payer = PAYER; try { payer = JSON.parse(body)?.paymentPayload?.payload?.authorization?.from || payer; } catch { /* not json */ }
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") { fac.verify++; return reply(200, { isValid: true, payer }); }
    if (req.url === "/settle") { fac.settle++; return reply(200, { success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer }); }
    if (req.url === "/rpc") {
      try {
        const { args } = decodeFunctionData({ abi: AGG3, data: JSON.parse(body)?.params?.[0]?.data });
        return reply(200, { jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi: AGG3, functionName: "aggregate3", result: args[0].map(() => ({ success: true, returnData: "0x" + "00".repeat(32) })) }) });
      } catch { return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" }); }
    }
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;

const srv = await bootServer({
  stores: "price-from-catalog",
  env: {
    FREE_MODE: "", BASE_URL: "http://agent402.test",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
    MPP_SECRET_KEY: "", PAYMENT_REQUIRED_BODY: "", X402_UPTO_NETWORKS: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    STATS_ALLOW_EPHEMERAL: "true",
  },
});
const B = srv.url;
let nonceN = 0;
const credential = (accepted) => b64({
  x402Version: 2, resource: accepted.resource, accepted,
  payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (++nonceN).toString(16).padStart(64, "0") } },
});
const offerOf = (r) => { const h = r.headers.get("payment-required"); return h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null; };
const baseAccept = (offer) => (offer?.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");

try {
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const listed = (route) => (pricing.endpoints || []).find((e) => e.route === route || e.path === route.split(" ")[1]);

  const ROUTES = [
    { route: "POST /api/hash", url: "/api/hash", method: "POST", body: { text: "x" } },
    { route: "GET /api/demand-radar", url: "/api/demand-radar?limit=1", method: "GET" },
  ];
  const TAMPER_QUERY = "price=0&amount=0&maxAmountRequired=0&maxPrice=0.000001&payTo=" + OTHER + "&asset=" + OTHER + "&network=eip155:1";
  const TAMPER_BODY = { price: 0, amount: "0", maxAmountRequired: "0", payTo: OTHER, asset: OTHER, network: "eip155:1", accepts: [{ amount: "0" }] };
  const TAMPER_HEADERS = { "x-price": "0", "x-amount": "0", "x-pay-to": OTHER, "x-max-amount": "0" };
  const call = (t, { query = "", body = null, headers = {} } = {}) => {
    const url = `${B}${t.url}${query ? (t.url.includes("?") ? "&" : "?") + query : ""}`;
    return t.method === "GET"
      ? fetch(url, { headers })
      : fetch(url, { method: t.method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body || t.body) });
  };

  for (const t of ROUTES) {
    const entry = listed(t.route);
    ok(!!entry, `${t.route} is listed on /api/pricing`);
    const r0 = await call(t);
    const offer0 = offerOf(r0);
    const acc = baseAccept(offer0);
    ok(r0.status === 402 && !!acc, `${t.route}: unpaid -> 402 offering exact on Base (${r0.status})`);
    if (!acc || !entry) continue;
    const listedUsd = Number(String(entry.price ?? entry.priceUsd ?? "").replace(/^\$/, ""));
    const atomic = Math.round(listedUsd * 1e6);
    ok(Number.isFinite(listedUsd) && listedUsd > 0 && Number(acc.amount) === atomic, `${t.route}: the 402 asks for the listed price (${acc.amount} atomic = $${listedUsd})`);

    const r1 = await call(t, { query: TAMPER_QUERY, body: { ...(t.body || {}), ...TAMPER_BODY }, headers: TAMPER_HEADERS });
    const offer1 = offerOf(r1);
    ok(r1.status === 402 && isDeepStrictEqual(offer1?.accepts, offer0.accepts), `${t.route}: price-shaped caller fields leave the offer byte-identical`);

    for (const [label, changed] of [
      ["a lower amount", { ...acc, amount: String(Math.max(0, Number(acc.amount) - 1)) }],
      ["a zero amount", { ...acc, amount: "0" }],
      ["another recipient", { ...acc, payTo: OTHER }],
      ["another asset", { ...acc, asset: OTHER }],
    ]) {
      const v = fac.verify, s = fac.settle;
      const r = await call(t, { headers: { "payment-signature": credential(changed) } });
      await r.arrayBuffer();
      ok(r.status === 402 && fac.verify === v && fac.settle === s, `${t.route}: a payment for ${label} -> 402 with no verify and no settle (${r.status}, verify +${fac.verify - v}, settle +${fac.settle - s})`);
    }

    const v = fac.verify, s = fac.settle;
    const good = await call(t, { headers: { "payment-signature": credential(acc) } });
    await good.arrayBuffer();
    ok(good.status === 200 && fac.verify === v + 1 && fac.settle === s + 1, `${t.route}: control: the offer's own terms are verified, served and settled once (${good.status}, verify +${fac.verify - v}, settle +${fac.settle - s})`);
  }
} finally {
  await srv.stop();
  facilitator.close();
}
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
