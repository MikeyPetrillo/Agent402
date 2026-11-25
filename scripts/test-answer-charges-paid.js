// The served route stack settles a metered media call at what it used: a
// REAL paid boot (a stub facilitator that verifies and settles anything and
// records the amount it is asked to settle; the embeddings upstream answered
// by scripts/lib/upstream-stub-preload.js, so nothing is spent), METERED_MEDIA
// and GATEWAY_METERED_BILLING on, upto offered on Base. /api/embed is
// model-backed, so its handler is wrapped by markAiGenerated and run inside
// runAsRouteCall exactly as served. An upto payment the SDK client signs
// settles the metered amount (under the ceiling it signed), and the answer
// carries the AI mark; an exact payment settles its fixed price.
// /v1/metered/gemini (the Gemini wire over the metered chat tier, the model
// aggregator answered by the same preload under STUB_OPENROUTER_CHAT): an upto
// payment settles the metered amount, under its quote, and nothing is owed.
//
//   node scripts/test-answer-charges-paid.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const BASE = "eip155:8453";
const FAC_ADDR = "0x00000000000000000000000000000000000fAc01";
const settled = [];
const facilitator = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const reply = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    let b = {}; try { b = JSON.parse(body || "{}"); } catch { b = {}; }
    const payer = b?.paymentPayload?.payload?.authorization?.from || b?.paymentPayload?.payload?.permit2Authorization?.from || "0x" + "ab".repeat(20);
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: FAC_ADDR } }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply({ isValid: true, payer });
    if (req.url === "/settle") {
      settled.push({ scheme: b?.paymentRequirements?.scheme, amount: b?.paymentRequirements?.amount });
      return reply({ success: true, transaction: `0x${String(settled.length).padStart(64, "0")}`, network: BASE, payer });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;

let srv = null;
try {
  srv = await bootServer({
    stores: "answer-charges-paid",
    args: ["--import", "./scripts/lib/upstream-stub-preload.js"],
    env: {
      FREE_MODE: "", NODE_ENV: "test", NETWORK: "base", PAYMENT_NETWORKS: "base", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      FACILITATOR_URL: FAC, PAYMENT_SETTLE_FALLBACK: "", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
      MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "",
      X402_UPTO_NETWORKS: BASE, GATEWAY_METERED_BILLING: "on", METERED_MEDIA: "on",
      OPENAI_API_KEY: "test-key-never-used", OPENROUTER_API_KEY: "test-key-never-used", OPENROUTER_MANAGEMENT_KEY: "", STUB_OPENROUTER_CHAT: "on", REFUND_OWED_NOTICE_MINUTES: "0",
      FIRST_CALL_ALLOWANCE: "", TRIAL_MODE: "", FACILITATOR_GAS_CHECK: "off",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true",
      UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url)),
    },
  });
  const B = srv.url;
  const { x402Client } = await import("@x402/core/client");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { UptoEvmScheme } = await import("@x402/evm/upto/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = { ...account, readContract: async () => 10n ** 30n };
  const body = JSON.stringify({ text: "hello" });
  const call = (scheme) => {
    const client = new x402Client((_v, accepts) => accepts.find((a) => a.scheme === scheme && a.network === BASE) || accepts[0]);
    client.register(BASE, scheme === "upto" ? new UptoEvmScheme(signer) : new ExactEvmScheme(signer));
    return wrapFetchWithPayment(fetch, client)(`${B}/api/embed`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  };
  const offer = await fetch(`${B}/api/embed`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const pr = JSON.parse(Buffer.from(offer.headers.get("payment-required") || "", "base64").toString("utf8") || "{}");
  const upto = (pr.accepts || []).find((a) => a.scheme === "upto");
  ok(offer.status === 402 && upto, `/api/embed offers upto on Base (${(pr.accepts || []).map((a) => a.scheme).join(",")})`);

  const r = await call("upto");
  const j = await r.json().catch(() => ({}));
  const metered = Number(r.headers.get("x-metered-usd"));
  const last = settled.at(-1);
  ok(r.status === 200 && j.aiGenerated === true && Array.isArray(j.embedding), `an upto call is served, marked AI-generated (${r.status})`);
  ok(last?.scheme === "upto" && Number.isFinite(metered) && metered > 0 && Number(last.amount) === Math.round(metered * 1e6) && Number(last.amount) < Number(upto.amount),
    `the served stack settles the metered amount, under the signed ceiling (settled ${last?.amount} atomic, metered ${metered}, ceiling ${upto?.amount})`);
  ok(!JSON.stringify(j).includes("__meter"), "no internal cost figure reaches the buyer");

  const e = await call("exact");
  const exact = (pr.accepts || []).find((a) => a.scheme === "exact");
  ok(e.status === 200 && settled.at(-1)?.scheme === "exact" && settled.at(-1)?.amount === exact?.amount, `an exact call settles its fixed price (${settled.at(-1)?.amount} vs ${exact?.amount})`);

  // The Gemini wire over the metered chat tier: the answer is rebuilt in
  // Google's shape and still settles what the chat run used.
  {
    const path = "/v1/metered/gemini";
    // A quote above the floor (a long prompt, a large output budget), so the
    // metered amount can land under it.
    const gbody = JSON.stringify({ contents: [{ role: "user", parts: [{ text: `Summarize x402 in one sentence. ${"Context line about paying per request. ".repeat(400)}` }] }], generationConfig: { maxOutputTokens: 4096 } });
    const goffer = await fetch(`${B}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: gbody });
    const gpr = JSON.parse(Buffer.from(goffer.headers.get("payment-required") || "", "base64").toString("utf8") || "{}");
    const gupto = (gpr.accepts || []).find((a) => a.scheme === "upto");
    ok(goffer.status === 402 && gupto, `${path} offers upto on Base (${(gpr.accepts || []).map((a) => a.scheme).join(",")})`);
    const client = new x402Client((_v, accepts) => accepts.find((a) => a.scheme === "upto" && a.network === BASE) || accepts[0]);
    client.register(BASE, new UptoEvmScheme(signer));
    const before = settled.length;
    const g = await wrapFetchWithPayment(fetch, client)(`${B}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: gbody });
    const gj = await g.json().catch(() => ({}));
    const gm = Number(g.headers.get("x-metered-usd"));
    const gl = settled.at(-1);
    ok(g.status === 200 && Array.isArray(gj.candidates), `${path}: an upto call is served in Google's shape (${g.status}${g.status === 200 ? "" : `: ${String(gj.error || "").slice(0, 120)}`})`);
    ok(settled.length === before + 1 && gl?.scheme === "upto" && Number.isFinite(gm) && gm > 0 && Number(gl.amount) === Math.round(gm * 1e6) && Number(gl.amount) < Number(gupto?.amount),
      `${path}: settles the metered amount, under its quote (settled ${gl?.amount} atomic, metered ${gm}, quote ${gupto?.amount})`);
    ok(!JSON.stringify(gj).includes("__meter"), `${path}: no internal cost figure reaches the buyer`);
    const st = await fetch(`${B}/api/gateway-status`).then((r) => r.json()).catch(() => ({}));
    ok(gj.charged === undefined && !gj.refundStatusUrl && st.refundsOwed?.status !== "owed" && st.refundsOwed?.status !== "unknown", `${path}: nothing is owed after the metered settlement (refundsOwed ${st.refundsOwed?.status ?? "absent"})`);
  }
} catch (err) {
  fail++;
  console.error(`FAIL - threw: ${err?.stack || err}`);
  if (srv) for (const l of srv.log().split("\n").slice(-30)) console.error("  server:", l);
} finally {
  srv?.child?.kill("SIGKILL");
  facilitator.close();
  console.log(`\ntest-answer-charges-paid: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
