// The paid half of scripts/test-settle-first.js: three boots of one PAID-mode
// server (scripts/lib/paid-wires-rig.js). The stub facilitators hold a balance
// per payer and record every settle call; the stub model upstream records
// every call it is sent, so the ORDER of the two is read, not inferred.
//   boot A: settle first on (the default);
//   boot B: GATEWAY_SETTLE_FIRST=off, the same calls, served as they were;
//   boot C: on again, on boot A's sales ledger file: a restart.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootPaidWires, tallyOf, sleep } from "./paid-wires-rig.js";

const CHAT = { method: "POST", path: "/v1/chat/completions", body: { messages: [{ role: "user", content: "hi" }] } };
const STREAM = { method: "POST", path: "/v1/chat/completions", body: { messages: [{ role: "user", content: "hi" }], stream: true } };
const METERED = { method: "POST", path: "/v1/metered/chat/completions", body: { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 } };
const SQL = { method: "POST", path: "/api/sql-guard", body: { sql: "select 1" } };
const X402_WIRES = ["evm", "mpp-evm", "svm", "avm", "stellar"];
const CLASS = "settle-first-failed";
const decode = (h) => { try { return JSON.parse(Buffer.from(String(h), "base64").toString("utf8")); } catch { return null; } };

// What a buyer reads, with what differs call to call masked (ids, times,
// transaction hashes, request ids): the status, the header names, the body.
const VOLATILE_HEADERS = new Set(["date", "etag", "x-request-id", "x-response-time", "server-timing", "content-length", "payment-response", "x-agent402-receipt", "x-agent402-receipt-key", "x-agent402-receipt-sig"]);
const maskBody = (j) => JSON.parse(JSON.stringify(j ?? null, (k, v) => (["id", "created", "transaction", "requestId", "receipt", "nonce"].includes(k) ? "<masked>" : v)));
const shapeOf = (r) => ({ status: r.status, headers: [...r.headers.keys()].filter((h) => !VOLATILE_HEADERS.has(h)).sort().join(","), body: maskBody(r.json), receipt: decode(r.headers.get("payment-response"))?.errorReason || decode(r.headers.get("payment-response"))?.success || null });

export async function run({ ok, parts, setRig }) {
  const ledgerDir = mkdtempSync(join(tmpdir(), "a402-settle-first-ledger-"));
  const SHARED_ENV = {
    SALES_LEDGER_DB: join(ledgerDir, "sales.db"),
    REFUND_OWED_NOTICE_MINUTES: "0",
    // A model attempt ends after 1.5 s here, so a silent upstream is a 504 in seconds.
    LLM_ATTEMPT_MAX_MS: "1500",
    OPENAI_API_KEY: "stub-key-never-used", OPENROUTER_TTS_ENABLED: "true",
  };
  let rig = null;
  const boot = async (label, env = {}) => { rig = await bootPaidWires({ label, env: { ...SHARED_ENV, ...env } }); setRig(rig); return rig; };
  // ---- reading what happened ----
  const mark = () => rig.st.events.length;
  /** What reached the stubs since `from`, for wallet `w`: "settle-first" (its
   *  settle call came before any model call), "upstream-first", "settle-only",
   *  "upstream-only" or "nothing". */
  const orderOf = (w, from) => {
    const ev = rig.st.events.slice(from).filter((e) => e.t === "upstream" || (e.t === "settle" && e.id === w.id));
    if (!ev.length) return "nothing";
    const hasSettle = ev.some((e) => e.t === "settle"), hasUp = ev.some((e) => e.t === "upstream");
    if (hasSettle && !hasUp) return "settle-only";
    if (hasUp && !hasSettle) return "upstream-only";
    return ev[0].t === "settle" ? "settle-first" : "upstream-first";
  };
  const upstreamSince = (from) => rig.st.events.slice(from).filter((e) => e.t === "upstream").length;
  const refunds = async () => (await rig.operator("/__operator/refunds.json?status=all&limit=500"))?.refunds || [];
  const refundOf = async (pred, tries = 30) => { for (let i = 0; i < tries; i++) { const r = (await refunds()).find(pred); if (r) return r; await sleep(100); } return null; };
  const status = () => rig.operator("/api/gateway-status");
  const fresh = async (wire, calls = 10, route = CHAT) => { const w = await rig.wallet(wire); const price = await rig.priceOf(w, route); rig.fund(w, price * BigInt(calls)); return { w, price }; };
  /** A wallet with a paid sale on the books: one settled call on a route that never settles first. */
  const withHistory = async (wire = "evm") => {
    const w = await rig.wallet(wire);
    rig.fund(w, 10n ** 12n);
    const r = await rig.pay(w, SQL);
    if (r.status !== 200) throw new Error(`history call answered ${r.status}`);
    await sleep(150);
    return w;
  };
  const llm = (hook) => { rig.st.llmHook = hook; };
  const owedShape = (row, { slug = "v1-chat", status: st, payer, usd, tx }) => !!row && String(row.note || "").startsWith(CLASS) && row.status === "owed" && row.slug === slug && row.httpStatus === st
    && (payer == null || row.payer === payer) && (usd == null || Math.abs(row.priceUsd - usd) < 1e-9) && (tx == null || String(row.evidence).toLowerCase() === String(tx).toLowerCase());

  /** What a new wallet reads in normal operation: the 402 offer, a served
   *  call, a call whose payment does not settle, and an upto payment. */
  async function normalShapes() {
    const offer = (await rig.offerOf(CHAT)).offer;
    const { w } = await fresh("evm");
    const from = mark();
    const served = await rig.pay(w, CHAT);
    const servedOrder = orderOf(w, from);
    const poor = await rig.wallet("evm");
    rig.fund(poor, 0n);
    const from2 = mark();
    const unpaid = await rig.pay(poor, CHAT);
    const unpaidOrder = orderOf(poor, from2);
    const { w: u } = await fresh("evm");
    const from3 = mark();
    const upto = await rig.send(CHAT, await rig.credentialFor(u, CHAT, { scheme: "upto" }));
    const uptoOrder = orderOf(u, from3);
    // (Each boot's stubs make their own Solana, Stellar and Algorand payTo and fee payer.)
    const offerMasked = JSON.stringify(offer, (k, v) => (k === "payTo" || k === "feePayer" ? "<per-boot>" : v));
    return { offer: offerMasked, served: JSON.stringify(shapeOf(served)), servedOrder, unpaid: JSON.stringify(shapeOf(unpaid)), unpaidOrder, upto: JSON.stringify(shapeOf(upto)), uptoOrder };
  }

  // ===========================================================================
  // boot A: settle first
  // ===========================================================================
  const failed502 = {};   // per wire, the body of a payment that did not settle (compared with boot B)
  let offShapes = null;   // boot B: what a new wallet reads, compared with boot D under its budget
  let restartPaid = null, restartOwedOnly = null;
  if (parts.includes("2")) {
    await boot("settle-first-a", {
      GATEWAY_SETTLE_FIRST: "always",
      // The connector's x402 twins (web.search, web.news, web.answer) on a stub search upstream.
      BRAVE_API_KEY: "stub-brave-key", BRAVE_ANSWERS_API_KEY: "stub-brave-key", UPSTREAM_STUB_HOSTS: "api.search.brave.com",
      AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999",
    });
    try {
      // ---- every x402 exact wire ---------------------------------------------
      for (const wire of X402_WIRES) {
        const { w } = await fresh(wire);
        let from = mark();
        let r = await rig.pay(w, CHAT);
        let o = rig.outcomesOf(w);
        await ok(r.status === 200 && orderOf(w, from) === "settle-first" && o.attempts === 1 && o.settled === 1,
          `${wire}: a wallet that never paid is served, and its payment was settled BEFORE the model call (${orderOf(w, from)}; one settle call: ${JSON.stringify(o)})`);
        if (wire === "evm") {
          const receipt = decode(r.headers.get("payment-response"));
          await ok(receipt?.success === true && /^0x[0-9a-f]{64}$/.test(receipt.transaction || "") && r.json?.choices?.[0]?.message?.content === "stub answer", "evm: the answer carries the settlement receipt (success, the transaction) and the model's answer");
          restartPaid = w;
        }
        await sleep(150);
        from = mark();
        r = await rig.pay(w, CHAT);
        o = rig.outcomesOf(w);
        await ok(r.status === 200 && orderOf(w, from) === "upstream-first" && o.attempts === 2 && o.settled === 2,
          `${wire}: once that payment settled the wallet is served handler first, as every call was (${orderOf(w, from)}; ${JSON.stringify(o)})`);

        // A run that fails AFTER the settlement: owed, under its own class.
        const { w: unlucky } = await fresh(wire);
        rig.st.llmStatus = 500;
        from = mark();
        r = await rig.pay(unlucky, CHAT);
        rig.st.llmStatus = 0;
        o = rig.outcomesOf(unlucky);
        // The payer a row names is the one the books record: the signed EVM
        // payer, else the payer the facilitator's receipt names (on the stub
        // Solana rail, the source token account).
        const payerOnBooks = wire === "evm" || wire === "mpp-evm" ? unlucky.address.toLowerCase() : wire === "svm" ? unlucky.source : unlucky.address;
        const row = await refundOf((x) => x.payer === payerOnBooks && x.slug === "v1-chat");
        await ok(r.status === 502 && orderOf(unlucky, from) === "settle-first" && o.attempts === 1 && o.settled === 1, `${wire}: the upstream failing after the settlement is a 502 on a payment already taken once (${orderOf(unlucky, from)}; ${JSON.stringify(o)})`);
        await ok(owedShape(row, { status: 502, usd: 0.02 }) && !!row.evidence && row.note === `${CLASS}: answer http 502`,
          `${wire}: that charge is on the refund ledger as owed, class ${CLASS}, with its payer, transaction, amount and route (${JSON.stringify(row && { note: row.note, slug: row.slug, priceUsd: row.priceUsd, network: row.network, wire: row.wire, evidence: String(row.evidence).slice(0, 14) })})`);
        if (wire === "evm") {
          const receipt = decode(r.headers.get("payment-response"));
          await ok(receipt?.success === true && receipt.transaction.toLowerCase() === String(row.evidence).toLowerCase() && r.json?.charged === true && r.json?.refundOwed === true && r.json?.transaction === receipt.transaction && /refund owed/.test(r.json?.payment || "") && !/not charged|nothing was charged/i.test(JSON.stringify(r.json)),
            `evm: the 502 carries the receipt of the charge and says it is owed back, never "not charged" (${JSON.stringify(r.json).slice(0, 200)})`);
          restartOwedOnly = unlucky;
        }
        // A payment that does not settle: the paywall's settle-failure answer, and no model call.
        if (wire !== "stellar") { // (a failed Stellar settle waits on its confirmation read; the evm and Solana legs carry this)
          const poor = await rig.wallet(wire);
          rig.fund(poor, 0n);
          from = mark();
          r = await rig.pay(poor, CHAT);
          o = rig.outcomesOf(poor);
          failed502[wire] = { status: r.status, keys: Object.keys(r.json || {}).sort().join(), receipt: decode(r.headers.get("payment-response"))?.errorReason || null };
          await ok(r.status === 402 && upstreamSince(from) === 0 && o.attempts === 1 && o.settled === 0, `${wire}: a payment that does not settle is answered 402 with no model call made (${orderOf(poor, from)}; ${JSON.stringify(o)})`);
        }
      }
      await ok((await status())?.refundsOwed?.status === "owed", "refundsOwed reads owed on /api/gateway-status once such a charge is on the ledger");

      // ---- a stream ------------------------------------------------------------
      {
        rig.st.llmStreamFrames = () => ['data: {"id":"s1","choices":[{"index":0,"delta":{"role":"assistant","content":"stub"}}]}\n\n', 'data: {"id":"s1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"cost":0.000001}}\n\n', "data: [DONE]\n\n"];
        const { w } = await fresh("evm");
        let from = mark();
        let r = await rig.pay(w, STREAM);
        await ok(r.status === 200 && /data: /.test(r.text) && orderOf(w, from) === "settle-first" && rig.outcomesOf(w).attempts === 1, `a streamed call from a new wallet: settled before the model call, once, and the stream is served (${orderOf(w, from)})`);
        const { w: w2 } = await fresh("evm");
        rig.st.llmStatus = 500;
        r = await rig.pay(w2, STREAM);
        rig.st.llmStatus = 0;
        const row = await refundOf((x) => x.payer === w2.address.toLowerCase());
        await ok(r.status === 502 && owedShape(row, { status: 502 }), `a streamed call whose upstream fails before the first frame after the settlement: 502, booked owed (${row?.note})`);
        rig.st.llmStreamFrames = null;
      }

      // ---- every refusal that is the buyer's own doing comes BEFORE the settle --
      {
        const big = "x".repeat(450_000);
        const classes = [
          ["bad input (no messages)", { ...CHAT, body: {} }],
          ["bad input (an empty message list)", { ...CHAT, body: { messages: [] } }],
          ["an unknown model on a flat tier", { ...CHAT, body: { model: "nope/not-a-model", messages: [{ role: "user", content: "hi" }] } }],
          ["input over the tier's size cap", { ...CHAT, body: { messages: [{ role: "user", content: big }] } }],
          ["embeddings: no input", { method: "POST", path: "/v1/embeddings", body: {} }],
          ["rerank: no documents", { method: "POST", path: "/v1/rerank", body: { query: "q" } }],
          ["speech: no input", { method: "POST", path: "/v1/audio/speech", body: { voice: "alloy" } }],
          ["Messages wire: no messages", { method: "POST", path: "/v1/messages", body: { model: "anthropic/claude-haiku-4.5", max_tokens: 16 } }],
          ["Responses wire: no input", { method: "POST", path: "/v1/responses", body: { model: "openai/gpt-6-luna" } }],
        ];
        for (const [name, route] of classes) {
          const w = await rig.wallet("evm");
          rig.fund(w, 10n ** 9n);
          const from = mark();
          // The offer is read for a well-formed body of the same route; the payment is then sent with the refused one.
          const good = route.path === CHAT.path ? CHAT : route.path === "/v1/embeddings" ? { ...route, body: { input: "hello" } } : route.path === "/v1/rerank" ? { ...route, body: { query: "q", documents: ["a", "b"] } }
            : route.path === "/v1/audio/speech" ? { ...route, body: { input: "hello", voice: "alloy" } } : route.path === "/v1/messages" ? { ...route, body: { model: "anthropic/claude-haiku-4.5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] } }
              : { ...route, body: { model: "openai/gpt-6-luna", input: "hi" } };
          const cred = await rig.credentialFor(w, good);
          const r = await rig.send(route, cred);
          const o = rig.outcomesOf(w);
          await ok(r.status >= 400 && r.status < 500 && r.status !== 402 && o.attempts === 0 && orderOf(w, from) === "nothing" && !(await refunds()).some((x) => x.payer === w.address.toLowerCase()),
            `refused before any payment is taken: ${name} (${r.status}; no settle call, no model call, nothing owed)`);
        }
        // The metered tier's pre-payment refusals answer before any gate.
        for (const [name, body] of [["an unknown model on the metered tier", { model: "nope/not-a-model", messages: [{ role: "user", content: "hi" }] }], ["input over the metered model's cap", { model: "openai/gpt-6-luna", messages: [{ role: "user", content: "x".repeat(1_200_000) }] }]]) {
          const w = await rig.wallet("evm");
          rig.fund(w, 10n ** 9n);
          const from = mark();
          const cred = await rig.credentialFor(w, METERED);
          const r = await rig.send({ ...METERED, body }, cred);
          await ok((r.status === 400 || r.status === 413) && rig.outcomesOf(w).attempts === 0 && orderOf(w, from) === "nothing", `refused before any payment is taken: ${name} (${r.status}; no settle call, no model call)`);
        }
        // The coverage admission: a wallet holding one call's price sends five at once.
        {
          const { w } = await fresh("evm", 1);
          const from = mark();
          const rs = await rig.burst(w, CHAT, 5);
          const t = tallyOf(rs), o = rig.outcomesOf(w);
          await ok(t[200] === 1 && t[429] === 4 && o.attempts === 1 && o.settled === 1 && upstreamSince(from) === 1, `refused before any payment is taken: runs the wallet's balance does not cover (one 200, four 429, ONE settle call: ${JSON.stringify(t)} ${JSON.stringify(o)})`);
        }
        // The settle breaker's own refusal: unchanged, and before any settle.
        {
          const w = await withHistory();
          rig.fund(w, 0n);
          const seen = [];
          for (let i = 0; i < 4; i++) { const from = mark(); const r = await rig.pay(w, CHAT); seen.push(`${r.status}:${orderOf(w, from)}`); }
          await ok(seen.join(" ") === "402:upstream-first 402:upstream-first 402:settle-only 429:nothing",
            `a wallet with history whose payments stop settling: two runs served unpaid, the third settles first (no model call), the fourth is refused at the wallet's unchanged count with no settle call (${seen.join(" ")})`);
        }
        // A buyer gone before the payment is verified: nothing settles.
        {
          const { w } = await fresh("evm");
          rig.st.verifyDelayMs = 1200;
          const from = mark();
          const ctl = new AbortController();
          const p = rig.pay(w, CHAT, { signal: ctl.signal }).catch(() => null);
          await sleep(300); ctl.abort(); await p; await sleep(1500);
          rig.st.verifyDelayMs = 0;
          await ok(rig.outcomesOf(w).attempts === 0 && orderOf(w, from) === "nothing", "a buyer who left before the call started is not settled and nothing runs");
        }
      }

      // ---- every failure after the settlement is owed ---------------------------
      {
        const failures = [
          ["the upstream answers nothing in time (a timeout)", async ({ res }) => { await sleep(4000); try { res.writeHead(200); res.end("{}"); } catch { /* closed */ } return true; }, 504],
          ["the upstream answers a body that is not JSON", async ({ res }) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("<html>not json</html>"); return true; }, 502],
          ["the upstream closes the connection", async ({ req }) => { req.socket.destroy(); return true; }, null],
          ["the upstream refuses the request itself (a 4xx)", async ({ reply }) => { reply(400, { error: { message: "unsupported parameter", code: 400 } }); return true; }, 400],
          ["the upstream is rate limited", async ({ reply }) => { reply(429, { error: { message: "slow down", code: 429 } }); return true; }, 503],
        ];
        for (const [name, hook, want] of failures) {
          const { w } = await fresh("evm");
          llm(hook);
          const from = mark();
          const r = await rig.pay(w, CHAT);
          llm(null);
          const o = rig.outcomesOf(w);
          const row = await refundOf((x) => x.payer === w.address.toLowerCase());
          await ok(r.status >= 400 && r.status !== 402 && (want === null || r.status === want) && orderOf(w, from) === "settle-first" && o.attempts === 1 && o.settled === 1 && owedShape(row, { status: r.status, usd: 0.02, payer: w.address.toLowerCase() }) && r.json?.charged === true && r.json?.refundOwed === true,
            `after the settlement, ${name}: ${r.status}, charged once, booked owed as ${row?.note}, and the answer says so`);
        }
      }

      // ---- a hang-up after the settlement ---------------------------------------
      {
        const before = (await rig.operator("/__operator/refunds.json"))?.hangupForgiveness;
        const { w } = await fresh("evm");
        llm(async () => { await sleep(1300); return false; });
        const cred = await rig.credentialFor(w, CHAT);
        const ctl = new AbortController();
        const from = mark();
        const p = rig.send(CHAT, cred, { signal: ctl.signal }).catch(() => null);
        await sleep(800); // the settle call (250 ms) is done, the model call is still out
        ctl.abort(); await p;
        llm(null);
        const row = await refundOf((x) => x.payer === w.address.toLowerCase(), 60);
        const o = rig.outcomesOf(w);
        const after = (await rig.operator("/__operator/refunds.json"))?.hangupForgiveness;
        await ok(orderOf(w, from) === "settle-first" && o.attempts === 1 && o.settled === 1 && owedShape(row, { status: 499, usd: 0.02 }) && row.note === `${CLASS}: answer not delivered`,
          `a buyer who leaves after the settlement is owed the charge: one settle call, a 499 row in the class (${row?.note}; reason ${row?.hangupReason})`);
        await ok(JSON.stringify(after?.abandonedUsd ?? after?.global ?? null) === JSON.stringify(before?.abandonedUsd ?? before?.global ?? null) && row.hangupReason !== "payer budget" && row.hangupReason !== "ip budget" && row.hangupReason !== "global budget",
          `no forgiveness ticket forgave that charge and none of the forgiveness budget was spent on it (${JSON.stringify(after).slice(0, 120)})`);
        // The same payment sent again: answered from what it already bought, never settled again.
        const again = await rig.send(CHAT, cred);
        const o2 = rig.outcomesOf(w);
        const rowAfter = (await refunds()).find((x) => x.id === row.id);
        await ok(o2.attempts === 1 && ((again.status === 200 && rowAfter.status === "void") || (again.status !== 200 && rowAfter.status === "owed")),
          `that payment sent again is never settled a second time, and is either served its stored answer with the debt voided or left owed, never both (${again.status}, row ${rowAfter.status}, settle calls ${o2.attempts})`);
      }

      // ---- a hang-up after the settlement on an image tier ------------------------
      // (An image run is cut off when its buyer leaves AND its charge is
      // cancelled; a charge already taken is not cancelled, so the run goes
      // on and its answer is kept for the same payment sent again.)
      {
        const IMAGE = { method: "POST", path: "/v1/images/fast", body: { prompt: "a red fox in the snow" } };
        const { w } = await fresh("evm", 10, IMAGE);
        rig.st.llmDelayMs = 1300;
        const cred = await rig.credentialFor(w, IMAGE);
        const ctl = new AbortController();
        const i0 = rig.st.images;
        const from = mark();
        const p = rig.send(IMAGE, cred, { signal: ctl.signal }).catch(() => null);
        await sleep(800);
        ctl.abort(); await p;
        const row = await refundOf((x) => x.payer === w.address.toLowerCase(), 60);
        rig.st.llmDelayMs = 0;
        await sleep(300);
        const again = await rig.send(IMAGE, cred);
        const rowAfter = (await refunds()).find((x) => x.id === row?.id);
        await ok(orderOf(w, from) === "settle-first" && rig.st.images - i0 === 1 && owedShape(row, { slug: "v1-images-fast", status: 499 }) && again.status === 200 && rowAfter?.status === "void" && rig.outcomesOf(w).attempts === 1,
          `an image run whose buyer leaves after the settlement runs to its end: the charge is owed (${row?.note}), and the same payment sent again is served the kept image with the debt voided (${again.status}, row ${rowAfter?.status}, one settle call, one image)`);
      }

      // ---- the same payment sent again -----------------------------------------
      {
        const { w } = await fresh("evm");
        const cred = await rig.credentialFor(w, CHAT);
        const first = await rig.send(CHAT, cred);
        await sleep(150);
        const from = mark();
        const again = await rig.send(CHAT, cred);
        await ok(first.status === 200 && again.status === 200 && again.headers.get("x-replayed-answer") === "1" && rig.outcomesOf(w).attempts === 1 && upstreamSince(from) === 0, "a settled-first payment sent again is answered from its first answer: no second settle call, no second model call");
        const { w: w2 } = await fresh("evm");
        const cred2 = await rig.credentialFor(w2, CHAT);
        const both = await Promise.all([rig.send(CHAT, cred2), rig.send(CHAT, cred2)]);
        const o = rig.outcomesOf(w2);
        await ok(o.attempts === 1 && o.settled === 1 && both.filter((r) => r.status === 200).length >= 1, `one payment sent twice at once is settled once (${both.map((r) => r.status).join(", ")}; ${JSON.stringify(o)})`);
        // ... and a payment whose run failed after the settlement, sent again
        // (retry: same-payment), is run once more at no further charge and
        // its debt is voided: served once, never both served and refunded.
        const { w: w3 } = await fresh("evm");
        const cred3 = await rig.credentialFor(w3, CHAT);
        rig.st.llmStatus = 500;
        const failedRun = await rig.send(CHAT, cred3);
        rig.st.llmStatus = 0;
        const owed3 = await refundOf((x) => x.payer === w3.address.toLowerCase());
        const from3 = mark(), c3 = rig.st.completions;
        const retry = await rig.send(CHAT, cred3);
        await sleep(150);
        const o3 = rig.outcomesOf(w3);
        const row3 = (await refunds()).find((x) => x.id === owed3?.id);
        await ok(failedRun.status === 502 && failedRun.json?.charged === true && failedRun.json?.retry === "same-payment" && /^0x[0-9a-f]{64}$/.test(failedRun.json?.transaction || "") && failedRun.json?.refundStatusUrl?.endsWith(`?tx=${failedRun.json.transaction.toLowerCase()}`)
          && retry.status === 200 && retry.json?.choices?.[0]?.message?.content === "stub answer" && o3.attempts === 1 && o3.settled === 1 && rig.st.completions - c3 === 1 && orderOf(w3, from3) === "upstream-only"
          && row3?.status === "void" && /served on the resend of the same payment/.test(row3?.note || "") && (await refunds()).filter((x) => x.payer === w3.address.toLowerCase()).length === 1,
          `a payment whose run failed after the settlement (502: charged, the transaction, retry ${failedRun.json?.retry}), sent again: run once more with no settle call (${retry.status}; ${JSON.stringify(o3)}), and its one owed row is void (${row3?.status}: ${row3?.note})`);
        const from3b = mark(), c3b = rig.st.completions;
        const third = await rig.send(CHAT, cred3);
        await ok(third.status === 200 && rig.st.completions - c3b === 0 && upstreamSince(from3b) === 0 && rig.outcomesOf(w3).attempts === 1, `sent a third time, that payment is answered from what it already bought: no model call, no settle call (${third.status})`);
        // A resend that fails again leaves the debt owed under its class; the next one is served.
        const { w: w4 } = await fresh("evm");
        const cred4 = await rig.credentialFor(w4, CHAT);
        rig.st.llmStatus = 500;
        await rig.send(CHAT, cred4);
        const again4 = await rig.send(CHAT, cred4);
        rig.st.llmStatus = 0;
        await sleep(150);
        const owed4 = await refundOf((x) => x.payer === w4.address.toLowerCase());
        const ok4 = await rig.send(CHAT, cred4);
        await sleep(150);
        const row4 = (await refunds()).find((x) => x.id === owed4?.id);
        await ok(again4.status === 502 && again4.json?.retry === "same-payment" && owed4?.status === "owed" && String(owed4?.note).startsWith(CLASS) && ok4.status === 200 && row4?.status === "void" && rig.outcomesOf(w4).attempts === 1,
          `a resend that fails again is still owed under its class (${again4.status}, row ${owed4?.status}: ${owed4?.note}); the one after it is served and the row is void (${ok4.status}, ${row4?.status}); one settle call in all`);
        // Two resends at once: one run.
        const { w: w5 } = await fresh("evm");
        const cred5 = await rig.credentialFor(w5, CHAT);
        rig.st.llmStatus = 500;
        await rig.send(CHAT, cred5);
        rig.st.llmStatus = 0;
        await refundOf((x) => x.payer === w5.address.toLowerCase());
        llm(async () => { await sleep(400); return false; });
        const c5 = rig.st.completions;
        const pair = await Promise.all([rig.send(CHAT, cred5), rig.send(CHAT, cred5)]);
        llm(null);
        const wait5 = pair.find((r) => r.status === 409);
        await ok(pair.filter((r) => r.status === 200).length === 1 && !!wait5 && wait5.json?.charged === true && /nothing more is charged/i.test(wait5.json?.hint || "") && rig.st.completions - c5 === 1 && rig.outcomesOf(w5).attempts === 1,
          `the same payment sent twice at once after a failed run: one is run, the other told to wait, its body saying the payment was charged and nothing more is (${pair.map((r) => r.status).join(", ")}; ${JSON.stringify(wait5?.json)}; one model call)`);
      }

      // ---- a wallet with history whose settlements fail on OUR side -------------
      {
        const w = await withHistory();
        rig.st.settleAnswer = ({ id }) => (id === w.id ? { status: 500, body: { error: "facilitator unavailable" } } : null);
        const seen = [];
        const cFrom = rig.st.completions;
        for (let i = 0; i < 7; i++) { const from = mark(); const r = await rig.pay(w, CHAT); seen.push(`${r.status}:${orderOf(w, from)}`); }
        const served = rig.st.completions - cFrom;
        rig.st.settleAnswer = null;
        await ok(served === 2 && !seen.some((s) => s.startsWith("429")) && seen.slice(2).every((s) => s.endsWith(":settle-only")),
          `a wallet with history, seven payments that fail to settle for a cause on our side: ${served} runs are served (the threshold), the other five settle first and run nothing, and none is refused (${seen.join(" ")})`);
        const from = mark();
        const good = await rig.pay(w, CHAT);
        await sleep(150);
        const from2 = mark();
        const next = await rig.pay(w, CHAT);
        await ok(good.status === 200 && orderOf(w, from) === "settle-first" && next.status === 200 && orderOf(w, from2) === "upstream-first", `once one of its payments settles (settled first, then served) the wallet is back to handler first (${orderOf(w, from)} then ${orderOf(w, from2)})`);
      }

      // ---- the metered tier: the amount is the one the payment was signed for ---
      {
        const { w, price } = await fresh("evm", 3, METERED);
        const from = mark();
        const r = await rig.pay(w, METERED);
        const left = rig.accounts.get(w.id).balance;
        const old = await withHistory();
        const before = rig.accounts.get(old.id).balance;
        const from2 = mark();
        const r2 = await rig.pay(old, METERED);
        const tookOld = before - rig.accounts.get(old.id).balance;
        await ok(r.status === 200 && orderOf(w, from) === "settle-first" && price * 3n - left === price && r2.status === 200 && orderOf(old, from2) === "upstream-first" && tookOld === price,
          `the metered tier, an exact payment: settled first it takes exactly the quote (${price} base units), the amount the same call takes from a wallet served handler first (${tookOld})`);
      }

      // ---- every armed route reaches its settle point before its upstream --------
      {
        const kits = await Promise.all([import("../../src/tools/llm-gateway-kit.js"), import("../../src/tools/llm-messages-kit.js"), import("../../src/tools/llm-gemini-kit.js"), import("../../src/tools/llm-responses-kit.js"), import("../../src/tools/llm-images-fast-kit.js")]);
        // The armed routes, as server.js lists them (SETTLE_FIRST_SLUGS).
        const tools = [...kits[0].LLM_GATEWAY_TOOLS, ...kits[1].LLM_MESSAGES_TOOLS, ...kits[2].LLM_GEMINI_TOOLS, ...kits[3].LLM_RESPONSES_TOOLS, ...kits[4].IMAGES_FAST_TOOLS.filter((t) => t.slug !== "v1-videos")];
        // Usable answers for the wires the stub does not speak, so the sweep also reads a 200 on each.
        llm(async ({ path, j, reply }) => {
          if (/\/messages$/.test(path)) return reply(200, { id: "msg_1", type: "message", role: "assistant", model: j.model, content: [{ type: "text", text: "stub answer" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2, cost: 0.000001 } }), true;
          if (/\/responses$/.test(path)) return reply(200, { id: "resp_1", object: "response", status: "completed", model: j.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "stub answer" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, cost: 0.000001 } }), true;
          if (/\/rerank$/.test(path)) return reply(200, { id: "rr_1", model: j.model, results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }], usage: { search_units: 1 } }), true;
          if (/\/embeddings$/.test(path)) return reply(200, { object: "list", model: j.model || "text-embedding-3-small", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3, total_tokens: 3 } }), true;
          return false;
        });
        const bad = [], served = [], notReached = [];
        for (const tool of tools) {
          const [method, path] = tool.route.split(" ");
          const route = { method, path, body: tool.discovery?.input || {} };
          const off = await rig.offerOf(route);
          if (off.status !== 402) continue; // a route this boot does not mount (a switched-off tier)
          const w = await rig.wallet("evm");
          rig.fund(w, 10n ** 12n);
          const from = mark();
          const r = await rig.pay(w, route);
          const order = orderOf(w, from), o = rig.outcomesOf(w);
          if (order === "upstream-first" || order === "upstream-only" || o.attempts > 1) bad.push(`${tool.slug}: ${order}, ${o.attempts} settle call(s), ${r.status}`);
          else if (order === "settle-first") served.push(`${tool.slug}:${r.status}`);
          else notReached.push(`${tool.slug}:${r.status}:${order}`);
        }
        llm(null);
        await ok(bad.length === 0, `no /v1 model route calls its upstream before a new wallet's payment settled${bad.length ? ` - ${bad.join(" | ")}` : ""}`);
        await ok(served.length >= 28 && served.filter((s) => s.endsWith(":200")).length >= 22 && served.some((s) => s.startsWith("v1-images-fast:")), `${served.length} of ${tools.length} routes were read settling first and then calling their upstream, ${served.filter((s) => s.endsWith(":200")).length} to a 200 (a collapsed count must fail)${notReached.length ? `; not read: ${notReached.join(", ")}` : ""}`);
      }

      // ---- dub: its translation is the chat gateway's call, behind the same point --
      {
        const DUB = { method: "POST", path: "/api/dub", body: { text: "Good morning", targetLanguage: "es", json: true } };
        const { w } = await fresh("evm", 3, DUB);
        const from = mark();
        const r = await rig.pay(w, DUB);
        await ok(orderOf(w, from) === "settle-first" && rig.outcomesOf(w).attempts === 1, `dub: a new wallet's payment settles before the translation's model call (${orderOf(w, from)}, ${r.status})`);
        const bad = await rig.wallet("evm");
        rig.fund(bad, 10n ** 9n);
        const from2 = mark();
        const r2 = await rig.send({ ...DUB, body: { text: "", targetLanguage: "es", json: true } }, await rig.credentialFor(bad, DUB));
        await ok(r2.status >= 400 && r2.status < 500 && orderOf(bad, from2) === "nothing", `dub: its own input refusal answers before any settle call (${r2.status})`);
      }

      // ---- redact-chat: masks, then the chat gateway's call, behind the same point --
      {
        const RC = { method: "POST", path: "/api/redact-chat", body: { text: "Reach me at ada@example.com.", instruction: "Write a one-line reply." } };
        const { w } = await fresh("evm", 3, RC);
        const from = mark();
        const r = await rig.pay(w, RC);
        await ok(orderOf(w, from) === "settle-first" && rig.outcomesOf(w).attempts === 1, `redact-chat: a new wallet's payment settles before the chat step's model call (${orderOf(w, from)}, ${r.status})`);
        const bad = await rig.wallet("evm");
        rig.fund(bad, 10n ** 9n);
        const from2 = mark();
        const r2 = await rig.send({ ...RC, body: { text: "Reach me at ada@example.com." } }, await rig.credentialFor(bad, RC));
        await ok(r2.status >= 400 && r2.status < 500 && orderOf(bad, from2) === "nothing", `redact-chat: its own input refusal answers before any settle call (${r2.status})`);
      }

      // ---- through the hosted connector (/mcp), paid over x402 --------------------
      // (The connector replays the payment to the route; its line about the
      // charge is read from the route's answer.)
      {
        const { connectMcp } = await import("./mcp-x402-client.js");
        const { randomBytes } = await import("node:crypto");
        const mcp = await connectMcp(rig.url, { timeoutMs: 60_000 });
        try {
          const args = { slug: "v1-chat", params: { messages: [{ role: "user", content: "hi" }] } };
          const ask = await mcp.callTool("catalog.call", args);
          let offer = null;
          try { offer = JSON.parse(ask?.content?.[0]?.text || "null"); } catch { offer = null; }
          const accept = (offer?.accepts || []).find((a) => a.scheme === "exact" && a.network === "eip155:8453");
          const w = await rig.wallet("evm");
          rig.fund(w, 10n ** 9n);
          const payment = (nonce) => ({ x402Version: 2, resource: offer.resource, accepted: accept, payload: { signature: "0x" + "11".repeat(65), authorization: { from: w.address, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce } } });
          llm(async ({ reply }) => { reply(400, { error: { message: "unsupported parameter", code: 400 } }); return true; });
          const from = mark();
          const failedCall = accept ? await mcp.callTool("catalog.call", args, { "x402/payment": payment("0x" + randomBytes(32).toString("hex")) }) : null;
          llm(null);
          const text = (failedCall?.content || []).map((c) => c?.text || "").join(" ");
          const o = rig.outcomesOf(w);
          await ok(!!accept && failedCall?.isError === true && orderOf(w, from) === "settle-first" && o.settled === 1 && /refund owed/.test(text) && !/not charged/i.test(text),
            `through the connector, a call whose upstream refuses it after the settlement: the result says the payment is owed back, never "not charged" (${text.slice(0, 160)})`);
          const from2 = mark();
          const good = await mcp.callTool("catalog.call", args, { "x402/payment": payment("0x" + randomBytes(32).toString("hex")) });
          await ok(good?.isError !== true && orderOf(w, from2) === "settle-first" && rig.outcomesOf(w).settled === 2, `through the connector, the wallet's next call (still no sale on the books) settles first and is served (${orderOf(w, from2)})`);
        } finally { await mcp.close(); }
      }

      // ---- the connector's x402 twins: one settle per payment -------------------
      // web.search, web.news and web.answer are served by the twins' own HTTP
      // resource server over the same core server: a new wallet's payment
      // settles before the search upstream, and the twin's after-handler
      // settlement answers that settle. A facilitator that refuses a second
      // settle of the same payment (as a used EVM nonce or a processed Solana
      // transaction is) is never asked one.
      {
        const { connectMcp } = await import("./mcp-x402-client.js");
        const { randomBytes } = await import("node:crypto");
        rig.st.upHook = async ({ host, path, res }) => {
          if (host !== "api.search.brave.com") return false;
          if (path.startsWith("/res/v1/web/search")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ web: { results: [{ title: "x402", url: "https://www.x402.org/", description: "An open payment standard" }] } })); return true; }
          if (path.startsWith("/res/v1/news/search")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ results: [{ title: "x402 news", url: "https://www.x402.org/news", description: "A stub article", age: "1 day ago", page_age: "2026-11-21T00:00:00Z", meta_url: { hostname: "www.x402.org" } }] })); return true; }
          if (path.startsWith("/res/v1/chat/completions")) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "x402 is an open payment standard." } }] })}\n\ndata: [DONE]\n\n`); return true; }
          return false;
        };
        const TWINS = [
          { tool: "web.search", route: { method: "GET", path: "/api/search?q=x402" }, args: { q: "x402" }, served: (j) => Array.isArray(j?.results) && j.results.length > 0 },
          { tool: "web.news", route: { method: "GET", path: "/api/search-news?q=x402" }, args: { q: "x402" }, served: (j) => Array.isArray(j?.results) && j.results.length > 0 },
          { tool: "web.answer", route: { method: "GET", path: "/api/answer?q=what%20is%20x402" }, args: { q: "what is x402" }, served: (j) => typeof j?.answer === "string" && j.answer.length > 0 },
        ];
        const mcp = await connectMcp(rig.url, { timeoutMs: 60_000 });
        try {
          for (const twin of TWINS) {
            const ask = await mcp.callTool(twin.tool, twin.args);
            let offer = null;
            try { offer = JSON.parse(ask?.content?.[0]?.text || "null"); } catch { offer = null; }
            for (const wire of ["evm", "svm"]) {
              for (const refuseResettle of [false, true]) {
                const { w, price } = await fresh(wire, 10, twin.route);
                const funded = rig.accounts.get(w.id).balance;
                let payment = null;
                if (wire === "evm") {
                  const accept = (offer?.accepts || []).find((a) => a.scheme === "exact" && a.network === "eip155:8453");
                  payment = accept ? { x402Version: 2, resource: offer.resource, accepted: accept, payload: { signature: "0x" + "11".repeat(65), authorization: { from: w.address, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } } } : null;
                } else {
                  const p = JSON.parse(Buffer.from((await rig.credentialFor(w, twin.route))["payment-signature"], "base64").toString("utf8"));
                  const accept = (offer?.accepts || []).find((a) => a.scheme === "exact" && a.network === p.accepted.network);
                  payment = accept ? { ...p, resource: offer.resource, accepted: accept } : null;
                }
                let seen = 0;
                rig.st.settleAnswer = refuseResettle ? ({ id, payer, network }) => (id === w.id && ++seen > 1 ? { status: 200, body: { success: false, errorReason: wire === "evm" ? "invalid_exact_evm_payload_authorization_nonce_already_used" : "transaction_already_processed", transaction: "", network, payer } } : null) : null;
                const from = mark();
                const r = payment ? await mcp.callTool(twin.tool, twin.args, { "x402/payment": payment }) : null;
                await sleep(300);
                rig.st.settleAnswer = null;
                const settles = rig.st.events.slice(from).filter((e) => e.t === "settle" && e.id === w.id).length;
                let json = null;
                try { json = JSON.parse(r?.content?.[0]?.text || "null"); } catch { json = null; }
                const receipt = r?._meta?.["x402/payment-response"];
                const taken = funded - rig.accounts.get(w.id).balance;
                const rows = (await refunds()).filter((x) => String(x.payer).toLowerCase() === String(w.address).toLowerCase());
                await ok(!!payment && r?.isError !== true && twin.served(json) && receipt?.success === true && settles === 1 && orderOf(w, from) === "settle-first" && taken === price && rows.length === 0,
                  `${twin.tool} through the connector on ${wire}${refuseResettle ? ", a facilitator that refuses a second settle of the payment" : ""}: one settle call, before the search upstream (${orderOf(w, from)}, ${settles} settle calls), the answer served with its receipt, the price taken once (${taken} of ${price}) and nothing owed (${rows.length} refund rows)`);
              }
            }
          }
        } finally { rig.st.upHook = null; rig.st.settleAnswer = null; await mcp.close(); }
      }

      // ---- left as they were -----------------------------------------------------
      {
        const t = await rig.wallet("tempo");
        rig.fund(t, 0n);
        const cFrom = rig.st.completions;
        const r = await rig.pay(t, CHAT);
        await ok(r.status === 402 && rig.st.completions - cFrom === 1, "a Tempo pull credential is left as it was: its handler runs before its payment is taken (not covered by this change)");
        const w = await rig.wallet("evm");
        rig.fund(w, 0n);
        const from = mark();
        const r2 = await rig.pay(w, SQL);
        await ok(r2.status === 402 && rig.outcomesOf(w).attempts === 1 && orderOf(w, from) === "settle-only", "a route with no model upstream is left as it was: settled after its handler (a pure-CPU tool has no settle point)");
      }

      // ---- counted for the operator; nothing new in public -----------------------
      {
        const op = (await status())?.settleFailures?.settleFirst;
        const pub = await rig.gatewayStatus();
        await ok(op?.enabled === true && op.armed["never-settled"] > 30 && op.armed["unsettled-runs"] >= 5 && op.settled > 30 && op.refused >= 9 && op.owed >= 10 && op.notReached >= 9,
          `the operator view counts the runs by reason and by outcome (${JSON.stringify(op)})`);
        await ok(Object.keys(pub.settleFailures).join() === "status" && !JSON.stringify(pub).includes("settleFirst") && !JSON.stringify(pub).includes("unsettledMax"), "the public status carries the word alone: no count and no threshold of this rule");
        const lines = rig.log().split("\n").filter((l) => l.startsWith("[settle-first]"));
        await ok(lines.some((l) => /payment settled before the run in \d+ ms \(reason=never-settled net=eip155:8453 payer=0x[0-9a-f]{4}\)$/.test(l)) && lines.some((l) => /did not settle, so the call was not run/.test(l)) && !lines.some((l) => /0x[0-9a-f]{12}/.test(l)),
          `each settled-first payment prints one line with its reason and the payer's first characters only (${lines.length} lines; e.g. ${lines[0]})`);
      }

      // ---- how long the settlement adds, and where a buyer waits -----------------
      {
        const time = async (w, route) => { const t0 = Date.now(); const r = await rig.pay(w, route); return { ms: Date.now() - t0, status: r.status }; };
        const firsts = [], laters = [];
        for (let i = 0; i < 4; i++) {
          const { w } = await fresh("evm");
          firsts.push((await time(w, CHAT)).ms);
          await sleep(150);
          laters.push((await time(w, CHAT)).ms);
        }
        const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
        console.log(`# timing against the stub facilitator (its settle call takes ${rig.st.settleDelayMs} ms): a new wallet's first call (settled first) ${med(firsts)} ms; the same wallet's next call (settled after the handler) ${med(laters)} ms`);
        // (Less than one settle call apart: a second settle call, or a wait
        // added beside the one that moved, would be at least that much.)
        await ok(med(firsts) - med(laters) < rig.st.settleDelayMs, `settling first adds no settle call and no wait of that size to the whole call: the one settle call moves from after the model call to before it (${med(firsts)} ms against ${med(laters)} ms)`);
        // A streamed call: the answer's first byte arrives when the whole
        // answer does on x402 either way (the paywall holds every byte until
        // settlement), so what a streaming buyer waits for does not change.
        rig.st.llmStreamFrames = () => ['data: {"id":"s1","choices":[{"index":0,"delta":{"role":"assistant","content":"stub"}}]}\n\n', 'data: {"id":"s1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"cost":0.000001}}\n\n', "data: [DONE]\n\n"];
        const firstByte = async (w) => { const cred = await rig.credentialFor(w, STREAM); const t0 = Date.now(); const r = await fetch(`${rig.url}${STREAM.path}`, { method: "POST", headers: { "content-type": "application/json", ...cred }, body: JSON.stringify(STREAM.body) }); const reader = r.body.getReader(); await reader.read(); const at = Date.now() - t0; try { await reader.cancel(); } catch { /* done */ } return at; };
        const { w: sw } = await fresh("evm");
        const sFirst = await firstByte(sw);
        await sleep(300);
        const sLater = await firstByte(sw);
        rig.st.llmStreamFrames = null;
        console.log(`# a streamed call's first byte: ${sFirst} ms settled first, ${sLater} ms settled after the handler`);
        await ok(sFirst - sLater < rig.st.settleDelayMs, `a streamed call's first byte arrives no later settled first than settled after the handler (${sFirst} ms against ${sLater} ms)`);
      }

      // ---- concurrency: the balance moved out after the calls were admitted -------
      {
        const { w, price } = await fresh("evm", 8);
        llm(async () => { await sleep(1000); return false; });
        const cFrom = rig.st.completions;
        const p = rig.burst(w, CHAT, 8);
        await sleep(600);
        rig.accounts.get(w.id).balance = 0n; // moved out while the model calls are still running
        const rs = await p;
        llm(null);
        const o = rig.outcomesOf(w);
        await ok(tallyOf(rs)[200] === 8 && o.settled === 8 && rig.st.completions - cFrom === 8, `a new wallet's eight calls at once, its balance moved out while they run: every one had settled first, so all eight are paid (${JSON.stringify(o)}; ${price} each)`);
      }

      // ---- rotation, end to end ---------------------------------------------------
      {
        const cFrom = rig.st.completions;
        let refusedFirst = 0;
        for (let i = 0; i < 16; i++) {
          const w = await rig.wallet("evm");
          rig.fund(w, 0n);
          for (let k = 0; k < 4; k++) { const r = await rig.pay(w, CHAT); if (r.status === 429) { if (k === 0) refusedFirst++; break; } }
        }
        await ok(rig.st.completions - cFrom === 0 && refusedFirst === 0, `rotation: sixteen new wallets whose payments never settle run ${rig.st.completions - cFrom} model calls, and none is refused its first call`);
      }
    } finally { await rig.stop(); }
  }

  // ===========================================================================
  // boot B: the switch off: the same calls, as they were served before
  // ===========================================================================
  if (parts.includes("3")) {
    await boot("settle-first-b", { GATEWAY_SETTLE_FIRST: "off", X402_UPTO_NETWORKS: "eip155:8453" });
    try {
      offShapes = await normalShapes();
      const { w } = await fresh("evm");
      let from = mark();
      let r = await rig.pay(w, CHAT);
      await ok(r.status === 200 && orderOf(w, from) === "upstream-first" && rig.outcomesOf(w).attempts === 1, `GATEWAY_SETTLE_FIRST=off: a new wallet's call runs its handler first (${orderOf(w, from)})`);
      for (const wire of ["evm", "svm"]) {
        const poor = await rig.wallet(wire);
        rig.fund(poor, 0n);
        from = mark();
        r = await rig.pay(poor, CHAT);
        const body = { status: r.status, keys: Object.keys(r.json || {}).sort().join(), receipt: decode(r.headers.get("payment-response"))?.errorReason || null };
        await ok(r.status === 402 && upstreamSince(from) >= 1, `off, ${wire}: a payment that does not settle is a 402 AFTER the model call ran (${orderOf(poor, from)})`);
        if (failed502[wire]) await ok(JSON.stringify(body) === JSON.stringify(failed502[wire]), `${wire}: the 402 a payment that does not settle gets is the same answer either way (status, body fields, receipt reason: ${JSON.stringify(body)})`);
      }
      const cFrom = rig.st.completions;
      for (let i = 0; i < 16; i++) {
        const poor = await rig.wallet("evm");
        rig.fund(poor, 0n);
        for (let k = 0; k < 4; k++) { const rr = await rig.pay(poor, CHAT); if (rr.status === 429) break; }
      }
      const unpaid = rig.st.completions - cFrom;
      await ok(unpaid >= 16, `off, rotation: the same sixteen new wallets are served ${unpaid} model calls that are never paid`);
      {
        const { w: c } = await fresh("evm", 8);
        rig.st.llmHook = async () => { await sleep(1000); return false; };
        const c0 = rig.st.completions;
        const p = rig.burst(c, CHAT, 8);
        await sleep(600);
        rig.accounts.get(c.id).balance = 0n;
        const rs = await p;
        rig.st.llmHook = null;
        await ok(rig.outcomesOf(c).settled === 0 && rig.st.completions - c0 === 8 && !tallyOf(rs)[200], `off, eight calls at once with the balance moved out while they run: all eight model calls ran and none was paid (${JSON.stringify(tallyOf(rs))})`);
      }
      const op = (await status())?.settleFailures?.settleFirst;
      await ok(op?.enabled === false && op.settled === 0 && Object.keys(op.armed).length === 0, `off: nothing is armed (${JSON.stringify(op)})`);
      // The 402 an unpaid caller reads carries no flow field, on or off.
      const offer = await rig.offerOf(CHAT);
      await ok(offer.status === 402 && offer.offer.accepts.length >= 4 && offer.offer.accepts.every((a) => !a.extra || a.extra.paymentFlow === undefined) && !JSON.stringify(offer.offer).includes("upfront"), "the 402 names no payment flow: nothing about settling first is declared on the wire");
    } finally { await rig.stop(); }

    // =========================================================================
    // boot C: a restart, on boot A's sales ledger
    // =========================================================================
    if (parts.includes("2") && restartPaid && restartOwedOnly) {
      await boot("settle-first-c", { GATEWAY_SETTLE_FIRST: "always" });
      try {
        rig.fund(restartPaid, 10n ** 9n); rig.fund(restartOwedOnly, 10n ** 9n);
        let from = mark();
        let r = await rig.pay(restartPaid, CHAT);
        await ok(r.status === 200 && orderOf(restartPaid, from) === "upstream-first", `after a restart a wallet whose payment settled before it is read from the sales ledger: served handler first (${orderOf(restartPaid, from)})`);
        from = mark();
        r = await rig.pay(restartOwedOnly, CHAT);
        await ok(r.status === 200 && orderOf(restartOwedOnly, from) === "settle-first", `a wallet whose only charge was owed back (its run failed) has no sale on the books: it still settles first (${orderOf(restartOwedOnly, from)})`);
        const offerC = await rig.offerOf(CHAT);
        await ok(offerC.offer.accepts.every((a) => !a.extra || a.extra.paymentFlow === undefined), "on, too, the 402 names no payment flow");
      } finally { await rig.stop(); }
    }
  }

  // ===========================================================================
  // boot D: the default, the budget mode (GATEWAY_SETTLE_FIRST unset), with a
  // small budget so a few unpaid runs cross it. Every model answer reports
  // an upstream charge of COST.
  // ===========================================================================
  if (parts.includes("4")) {
    const BUDGET = 0.2, COST = 0.03;
    await boot("settle-first-d", { GATEWAY_SETTLE_FIRST_BUDGET_USD: String(BUDGET), X402_UPTO_NETWORKS: "eip155:8453" });
    try {
      rig.st.llmCost = COST;
      const meterOf = async () => (await status())?.settleFailures?.settleFirst?.meter;
      // ---- normal operation, under the budget: as the switch off serves -------
      const shapes = await normalShapes();
      await ok(shapes.servedOrder === "upstream-first" && shapes.unpaidOrder === "upstream-first" && shapes.uptoOrder === "upstream-first",
        `under the budget, a new wallet is served first, as on main: its paid call, its unsettled call and its upto payment all run the model before any settle call (${shapes.servedOrder}, ${shapes.unpaidOrder}, ${shapes.uptoOrder})`);
      if (offShapes) {
        await ok(shapes.offer === offShapes.offer, "under the budget, the 402 offer is byte for byte the one served with settle first switched off (each boot's own stub wallets aside)");
        await ok(shapes.served === offShapes.served && shapes.unpaid === offShapes.unpaid && shapes.upto === offShapes.upto,
          `under the budget, what a new wallet reads (status, header names, body) is the same as with settle first switched off: a served call, an unsettled call (${JSON.parse(shapes.unpaid).status}) and an upto payment (${JSON.parse(shapes.upto).status})`);
      }
      // ---- the per-wallet rule applies under the budget too (#1936) ------------
      {
        const w = await withHistory();
        rig.st.settleAnswer = ({ id }) => (id === w.id ? { status: 500, body: { error: "facilitator unavailable" } } : null);
        const seen = [];
        for (let i = 0; i < 4; i++) { const from = mark(); const r = await rig.pay(w, CHAT); seen.push(`${r.status}:${orderOf(w, from)}`); }
        rig.st.settleAnswer = null;
        await ok(seen.slice(0, 2).every((x) => x.endsWith(":upstream-first")) && seen.slice(2).every((x) => x.endsWith(":settle-only")) && !seen.some((x) => x.startsWith("429")),
          `under the budget, a wallet with history whose settlements fail on our side: two runs are served, the rest settle first and run nothing, none refused (${seen.join(" ")})`);
        // ... and its upto payment is asked for an exact one (option A).
        const from = mark();
        const r = await rig.send(CHAT, await rig.credentialFor(w, CHAT, { scheme: "upto" }));
        const pr = decode(r.headers.get("payment-required"));
        await ok(r.status === 402 && pr?.accepts?.[0]?.scheme === "exact" && pr?.error === "exact_payment_required" && r.json?.reason === "exact_payment_required" && r.json?.retry === "exact-payment" && orderOf(w, from) === "nothing",
          `that wallet's upto payment is answered 402 asking for an exact payment, exact listed first, with no settle call and no model call (${r.status}, first accept ${pr?.accepts?.[0]?.scheme}, ${orderOf(w, from)}, ${JSON.stringify(r.json).slice(0, 300)})`);
      }
      const m0 = await meterOf();
      await ok(m0?.budgetMode === "off" && m0.unsettledUsd24h > 0 && m0.unsettledUsd24h < BUDGET, `the meter reads the unsettled runs so far, under the budget (${JSON.stringify(m0)})`);
      // ---- calls in flight together cross the budget -----------------------------
      {
        const { w } = await fresh("evm", 12);
        llm(async () => { await sleep(1000); return false; });
        const cFrom = rig.st.completions;
        const p = rig.burst(w, CHAT, 12);
        await sleep(600);
        rig.accounts.get(w.id).balance = 0n; // moved out while the model calls run
        const rs = await p;
        llm(null);
        const o = rig.outcomesOf(w);
        const unpaid = rig.st.completions - cFrom - o.settled;
        await ok(rig.st.completions - cFrom === 12 && o.settled > 0 && unpaid >= 1 && unpaid <= Math.ceil((BUDGET - m0.unsettledUsd24h) / 0.02) && !tallyOf(rs)[429],
          `a new wallet's twelve calls at once, its balance moved out while they run: ${unpaid} were served first unpaid (their price at risk crossed the budget), ${o.settled} had settled first and are paid; none refused (${JSON.stringify(tallyOf(rs))})`);
      }
      await sleep(200);
      const m1 = await meterOf();
      await ok(m1?.budgetMode === "on" && m1.why === "budget", `the budget is crossed: the mode is on (${m1?.why})`);
      // ---- rotation after the crossing: nothing runs unpaid ------------------------
      {
        const cFrom = rig.st.completions;
        let refusedFirst = 0;
        for (let i = 0; i < 6; i++) {
          const w = await rig.wallet("evm");
          rig.fund(w, 0n);
          const r = await rig.pay(w, CHAT);
          if (r.status === 429) refusedFirst++;
        }
        await ok(rig.st.completions - cFrom === 0 && refusedFirst === 0, `once the mode is on, six new wallets whose payments never settle run ${rig.st.completions - cFrom} model calls, and none is refused its first call`);
        const { w } = await fresh("evm");
        const from = mark();
        const r = await rig.pay(w, CHAT);
        await ok(r.status === 200 && orderOf(w, from) === "settle-first", `a new wallet that pays is settled first and served (${orderOf(w, from)})`);
      }
      // ---- option A: an upto payment from a new wallet while the mode is on -------
      {
        const { w } = await fresh("evm");
        const from = mark();
        const r = await rig.send(CHAT, await rig.credentialFor(w, CHAT, { scheme: "upto" }));
        const pr = decode(r.headers.get("payment-required"));
        const plain = (await rig.offerOf(CHAT)).offer;
        const sortKey = (a) => JSON.stringify(a);
        const sameSet = JSON.stringify((pr?.accepts || []).map(sortKey).sort()) === JSON.stringify((plain?.accepts || []).map(sortKey).sort());
        const firstNonExact = (pr?.accepts || []).findIndex((a) => a.scheme !== "exact");
        const lastExact = (pr?.accepts || []).map((a) => a.scheme).lastIndexOf("exact");
        await ok(r.status === 402 && pr?.error === "exact_payment_required" && sameSet && firstNonExact > lastExact && r.json?.charged === false && /exact/.test(r.json?.hint || "") && orderOf(w, from) === "nothing" && rig.outcomesOf(w).attempts === 0,
          `option A: a new wallet's upto payment while the mode is on is answered 402 with the same accepts, every exact one first (${(pr?.accepts || []).map((a) => a.scheme).join(",")}), charged false, no settle call, no model call`);
        const again = await rig.pay(w, CHAT);
        await ok(again.status === 200, `the same wallet's exact payment is then served (${again.status})`);
        const op = (await status())?.settleFailures?.settleFirst;
        await ok(op?.exactRequired >= 2, `the operator view counts the payments asked for an exact one (${op?.exactRequired})`);
      }
      // ---- nothing new in public -------------------------------------------------------
      {
        const pub = await rig.gatewayStatus();
        const txt = JSON.stringify(pub);
        await ok(!/budgetMode|unsettledUsd24h|atRiskUsd|budgetUsd/.test(txt), "the public status carries none of the meter's figures or its word");
        const lines = rig.log().split("\n").filter((l) => l.includes("budget mode"));
        await ok(lines.length >= 1 && lines.every((l) => !/\$|\d+\.\d+/.test(l)), `the log says when the mode turns on or off, with no figure (${lines[0]})`);
      }
    } finally { await rig.stop(); }
  }
}
