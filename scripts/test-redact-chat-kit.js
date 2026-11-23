#!/usr/bin/env node
// /api/redact-chat (src/tools/redact-chat-kit.js): mask PII, then one chat call.
// Offline: the chat step is the REAL v1-chat gateway handler, with the HTTP
// upstream stubbed at globalThis.fetch, so what is read is the exact body that
// would leave the process.
//
// What it pins:
//   - masking happens before any upstream call: the outbound body holds the
//     placeholders and no original email, phone, card, SSN or IP, in the
//     instruction as in the text;
//   - restoreInAnswer puts the originals back on this server; without it the
//     answer keeps the placeholders and no original is answered anywhere;
//   - a caller's own placeholder-shaped token is never rewritten by restore;
//   - every refusal of the caller's input is a 400 before any upstream call
//     (so before the chat tier's settle point), and a failed chat step is a
//     status of 400 or more (never settled on x402);
//   - long hostile strings at the caps are masked inside a time bound;
//   - the published example answers its documented shape;
//   - `redact` answers exactly what it answered before the patterns moved;
//   - the price is redact's plus the chat tier's, read from the definitions;
//   - the lists a wallet-only, metered, settle-first route must be on;
//   - with the private cost table: the chat tier's worst case on the largest
//     masked body stays within MARGIN of this route's price.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { REDACT_CHAT_TOOLS, REDACT_CHAT_SLUG, CHAT_SLUG, TEXT_MAX_CHARS, INSTRUCTION_MAX_CHARS, FRAMING, chatMessages, redactChatPriceUsd, __setChatForTest } from "../src/tools/redact-chat-kit.js";
import { redactText, restorePlaceholders, newRedactionState, PII_TYPES } from "../src/tools/pii-redact.js";
import { KIT2 } from "../src/tools/kit2.js";
import { LLM_GATEWAY_TOOLS, TIERS, MARGIN, validateRequest, worstCaseUpstreamCost } from "../src/tools/llm-gateway-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { METERED_SLUGS } from "../src/metered-slugs.js";
import { SETTLE_FIRST_SHARED_TOOLS, settleFirstSlugs } from "../src/settle-first-tools.js";
import { SETTLE_FIRST_MARK } from "../src/settle-first-copy.js";
import { upstreamCostsLoaded, upstreamCostsGaps } from "../src/upstream-costs.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const throwsWith = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const priceOf = (def) => Number(String(def.price).replace(/[^0-9.]/g, ""));

const tool = REDACT_CHAT_TOOLS[0];
const chatDef = LLM_GATEWAY_TOOLS.find((t) => t.slug === CHAT_SLUG);
const redactDef = KIT2.find((t) => t.slug === "redact");

// --- the upstream, stubbed at fetch ---------------------------------------------
process.env.OPENROUTER_API_KEY = "test-key";
const outbound = [];
let reply = (body) => ({ status: 200, json: { id: "gen-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Sure. I will write to [EMAIL_1] and call [PHONE_1]." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const raw = String(init?.body ?? "");
  outbound.push({ url: String(url), raw });
  const r = reply(JSON.parse(raw));
  return { ok: r.status < 400, status: r.status, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(r.json), json: async () => r.json };
};
const run = async (input) => { outbound.length = 0; return tool.handler(input); };

const ORIGINALS = {
  email: "ada.lovelace@example.com",
  phone: "555-123-4567",
  card: "4111 1111 1111 1111",
  ssn: "123-45-6789",
  ip: "203.0.113.42",
};

// --- masking before the upstream -------------------------------------------------
{
  const text = `Customer ${ORIGINALS.email} called from ${ORIGINALS.phone} about card ${ORIGINALS.card}, SSN ${ORIGINALS.ssn}, from IP ${ORIGINALS.ip}. Email ${ORIGINALS.email} again.`;
  const instruction = `Summarize this for the agent who uses ${ORIGINALS.email}.`;
  const r = await run({ text, instruction });
  const sent = outbound.map((o) => o.raw).join("\n");
  ok(outbound.length >= 1 && outbound.every((o) => /openrouter\.ai/.test(o.url)), `the chat step reached the stubbed upstream (${outbound.length} call(s))`);
  const leaked = Object.entries(ORIGINALS).filter(([, v]) => sent.includes(v)).map(([k]) => k);
  ok(leaked.length === 0, `no original value is in any outbound body${leaked.length ? ` (leaked: ${leaked.join(", ")})` : ""}`);
  ok(/\[EMAIL_1\]/.test(sent) && /\[PHONE_1\]/.test(sent) && /\[CARD_1\]/.test(sent) && /\[SSN_1\]/.test(sent) && /\[IP_1\]/.test(sent), "the outbound body carries one numbered placeholder per type");
  ok(!/\[EMAIL_2\]/.test(sent), "a value seen three times (twice in the text, once in the instruction) is one placeholder");
  ok(sent.includes(JSON.stringify(FRAMING).slice(1, 40)), "the fixed framing is sent as the system message");
  ok(r.answer === "Sure. I will write to [EMAIL_1] and call [PHONE_1]." && !("restored" in r), "without restoreInAnswer the answer keeps the placeholders");
  ok(!JSON.stringify(r).includes(ORIGINALS.email) && !JSON.stringify(r).includes(ORIGINALS.card), "no original value is in the answer object without restoreInAnswer");
  ok(JSON.stringify(r.redactions) === JSON.stringify([
    { type: "email", placeholder: "[EMAIL_1]" }, { type: "card", placeholder: "[CARD_1]" }, { type: "ssn", placeholder: "[SSN_1]" },
    { type: "phone", placeholder: "[PHONE_1]" }, { type: "ip", placeholder: "[IP_1]" },
  ]) && r.redactions.every((e) => !("original" in e)), `redactions list type and placeholder only (${JSON.stringify(r.redactions)})`);
  ok(r.counts.email === 3 && r.counts.phone === 1 && r.counts.card === 1 && r.counts.ssn === 1 && r.counts.ip === 1, `counts are per match across instruction and text (${JSON.stringify(r.counts)})`);
  ok(r.modelTier === CHAT_SLUG && typeof r.model === "string" && r.finishReason === "stop" && !("redactedInput" in r), "modelTier and model named; redactedInput off by default");
}

// --- restore, locally ----------------------------------------------------------------
{
  const text = `Reach me at ${ORIGINALS.email} or ${ORIGINALS.phone}.`;
  const r = await run({ text, instruction: "Write a one-line reply.", restoreInAnswer: true, includeRedactedInput: true });
  ok(r.answer === `Sure. I will write to ${ORIGINALS.email} and call ${ORIGINALS.phone}.` && r.restored === 2, `restoreInAnswer puts the originals back (${r.answer})`);
  ok(!outbound.some((o) => o.raw.includes(ORIGINALS.email) || o.raw.includes(ORIGINALS.phone)), "the restore happens after the call: the upstream saw no original");
  ok(r.redactedInput?.text === "Reach me at [EMAIL_1] or [PHONE_1]." && r.redactedInput?.instruction === "Write a one-line reply.", "includeRedactedInput answers the masked text that was sent");
  // A placeholder the model made up, or one the caller typed, stays as written.
  reply = (body) => ({ status: 200, json: { model: body.model, choices: [{ message: { content: "[EMAIL_1] [EMAIL_2] [EMAIL_7]" }, finish_reason: "stop" }] } });
  const r2 = await run({ text: `My token is [EMAIL_1]; my address is ${ORIGINALS.email}.`, instruction: "Echo it.", restoreInAnswer: true });
  const sent = outbound.map((o) => o.raw).join("\n");
  ok(sent.includes("My token is [EMAIL_1]; my address is [EMAIL_2]."), "a caller's own placeholder-shaped token moves the numbering past it");
  ok(r2.answer === `[EMAIL_1] ${ORIGINALS.email} [EMAIL_7]` && r2.restored === 1, `restore rewrites only placeholders this call wrote (${r2.answer})`);
  const s = newRedactionState(["[IP_999999999]"]);
  ok(redactText("1.2.3.4", { numbered: true, state: s }).text === "[IP_1]", "a placeholder-shaped token past any reachable number does not move the numbering");
  ok(restorePlaceholders("[CARD_1]", [{ type: "card", placeholder: "[CARD_1]", original: "4111111111111111" }]).text === "4111111111111111", "restorePlaceholders maps a placeholder to its original");
}

// --- refusals: 400 before any upstream ------------------------------------------------
{
  const cases = [
    [{ instruction: "x" }, "text missing"],
    [{ text: "   ", instruction: "x" }, "text blank"],
    [{ text: "hi" }, "instruction missing"],
    [{ text: { toString: 1 }, instruction: "x" }, "text an object"],
    [{ text: ["a"], instruction: "x" }, "text an array"],
    [{ text: "hi", instruction: 5 }, "instruction a number"],
    [{ text: "x".repeat(TEXT_MAX_CHARS + 1), instruction: "x" }, "text over its cap"],
    [{ text: "hi", instruction: "x".repeat(INSTRUCTION_MAX_CHARS + 1) }, "instruction over its cap"],
  ];
  for (const [input, label] of cases) {
    outbound.length = 0;
    const e = await throwsWith(() => tool.handler(input));
    ok(e?.statusCode === 400 && outbound.length === 0, `${label}: 400 before any upstream call (${e?.statusCode}: ${String(e?.message).slice(0, 80)})`);
  }
  // Masking can lengthen a text (a 7-char email becomes a 12-char
  // placeholder): the masked size is checked against the tier before the call.
  const L = "abcdefghijklmnopqrstuvwxyz";
  const emails = (n, from = 0) => Array.from({ length: n }, (_, k) => { const i = k + from; return `${L[i % 26]}${L[Math.floor(i / 26) % 26]}@${L[Math.floor(i / 676) % 26]}.io`; });
  const text = emails(4000).join(" ").slice(0, TEXT_MAX_CHARS);
  const instruction = emails(400, 4000).join(" ").slice(0, INSTRUCTION_MAX_CHARS);
  const st = newRedactionState([instruction, text]);
  const size = chatMessages(redactText(instruction, { numbered: true, state: st }).text, redactText(text, { numbered: true, state: st }).text).reduce((n, m) => n + m.content.length, 0);
  ok(size > TIERS[CHAT_SLUG].maxInputChars, `setup: the masked body is over the tier's ${TIERS[CHAT_SLUG].maxInputChars} chars (${size})`);
  const e = await throwsWith(() => run({ text, instruction }));
  ok(e?.statusCode === 400 && outbound.length === 0 && /chat tier's/.test(e.message), `a masked body over the tier's input bound is a 400 before any call (${e?.statusCode}: ${String(e?.message).slice(0, 90)})`);
  // The tier's own token bound refuses before its settle point in words that
  // name its options; this route answers in its own.
  __setChatForTest(async () => { throw Object.assign(new Error('Input is too large for "m" at this tier\'s price. Shrink the input, lower "n", or use a cheaper model'), { statusCode: 400 }); });
  const e2 = await throwsWith(() => tool.handler({ text: "hi", instruction: "x" }));
  ok(e2?.statusCode === 400 && /too large/.test(e2.message) && !/"n"|cheaper model/.test(e2.message), `the tier's size refusal is a 400 worded for this route (${String(e2?.message).slice(0, 90)})`);
  __setChatForTest(null);
  const prose = "The meeting notes run long and say nothing private at all. ".repeat(400).slice(0, TEXT_MAX_CHARS);
  const served = await throwsWith(() => run({ text: prose, instruction: "Summarize." }));
  ok(served === null && outbound.length >= 1, "a prose text at the text cap is served");
}

// --- a failed chat step is never a status under 400 ---------------------------------------
{
  for (const status of [429, 500, 503]) {
    reply = () => ({ status, json: { error: { message: "upstream said no" } } });
    const e = await throwsWith(() => run({ text: "hi", instruction: "x" }));
    ok(e && e.statusCode >= 400 && e.step === "chat", `an upstream ${status} answers ${e?.statusCode}, naming the chat step (never settled on x402)`);
  }
  reply = (body) => ({ status: 200, json: { model: body.model, choices: [{ message: { content: "   " }, finish_reason: "stop" }] } });
  const e = await throwsWith(() => run({ text: "hi", instruction: "x" }));
  ok(e?.statusCode === 502, `an empty answer is a 502 (${e?.statusCode})`);
}

// --- bounded on long hostile strings ------------------------------------------------------
{
  // Plain redaction only: the stubbed chat step is not part of the bound.
  __setChatForTest(async () => ({ model: "stub", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  const hostile = [
    "1 ".repeat(TEXT_MAX_CHARS / 2),
    "1-".repeat(TEXT_MAX_CHARS / 2),
    "1".repeat(TEXT_MAX_CHARS),
    "a".repeat(TEXT_MAX_CHARS - 1) + "@",
    "a@".repeat(TEXT_MAX_CHARS / 2),
    "a@b.".repeat(TEXT_MAX_CHARS / 4),
    "1.".repeat(TEXT_MAX_CHARS / 2),
    "(555) ".repeat(Math.floor(TEXT_MAX_CHARS / 6)),
    "[EMAIL_1]".repeat(Math.floor(TEXT_MAX_CHARS / 9)),
    ("1" + " ".repeat(40)).repeat(Math.floor(TEXT_MAX_CHARS / 41)),
  ];
  let worst = 0;
  for (const text of hostile) {
    const t0 = performance.now();
    await throwsWith(() => tool.handler({ text, instruction: "-".repeat(INSTRUCTION_MAX_CHARS), restoreInAnswer: true }));
    worst = Math.max(worst, performance.now() - t0);
  }
  ok(worst < 1500, `every hostile string at the cap is masked within the bound (worst ${worst.toFixed(0)} ms)`);
  __setChatForTest(null);
}

// --- the published example -----------------------------------------------------------------
{
  reply = (body) => ({ status: 200, json: { model: body.model, choices: [{ message: { content: "Hi Ada, Friday at 2pm works. I will send the updated invite to [EMAIL_1]. Thanks!" }, finish_reason: "stop" }] } });
  const r = await run(tool.discovery.input);
  const ex = tool.discovery.output.example;
  const keys = Object.keys(ex).filter((k) => !(tool.discovery.output.optional || []).includes(k));
  ok(keys.every((k) => k in r) && r.answer === ex.answer && JSON.stringify(r.redactions) === JSON.stringify(ex.redactions) && JSON.stringify(r.counts) === JSON.stringify(ex.counts) && r.restored === ex.restored, `the published example answers its documented shape (${JSON.stringify(r).slice(0, 160)})`);
  ok(!outbound.some((o) => o.raw.includes("ada@example.com") || o.raw.includes("555-123-4567")), "the published example sends no original to the upstream");
}

// --- redact is unchanged ------------------------------------------------------------------
{
  const r = redactDef.handler({ text: `a ${ORIGINALS.email} b ${ORIGINALS.phone} c ${ORIGINALS.card} d ${ORIGINALS.ssn} e ${ORIGINALS.ip}` });
  ok(r.result === "a [EMAIL] b [PHONE] c [CARD] d [SSN] e [IP]" && JSON.stringify(r.counts) === JSON.stringify({ email: 1, card: 1, ssn: 1, phone: 1, ip: 1 }), `redact answers its labels and counts as before (${r.result})`);
  ok(JSON.stringify(redactDef.handler(redactDef.discovery.input)) === JSON.stringify(redactDef.discovery.output.example), "redact's published example is unchanged");
  ok(PII_TYPES.join(",") === "email,card,ssn,phone,ip", "one pattern list, in redact's order");
}

// --- price, flags and lists -----------------------------------------------------------------
{
  ok(Math.abs(redactChatPriceUsd() - (priceOf(redactDef) + priceOf(chatDef))) < 1e-9 && priceOf(tool) === redactChatPriceUsd(), `the price is redact's plus ${CHAT_SLUG}'s, read from the definitions ($${redactChatPriceUsd()})`);
  ok(tool.slug === REDACT_CHAT_SLUG && tool.route === "POST /api/redact-chat" && tool.modelBacked === true, "route, slug, model-backed");
  ok(/pattern matching can miss/i.test(tool.description) && /no original value/i.test(tool.description) && !/\b(guarantee\w*|never sees|100%|fully private|completely)\b/i.test(tool.description), "the description says masking is pattern-based and can miss, with no absolute privacy claim");
  ok(tool.description.includes(SETTLE_FIRST_MARK), "the description carries the settle-first sentence beside its not-charged claim");
  ok(WALLET_ONLY_SLUGS.has(REDACT_CHAT_SLUG), "wallet-only (no proof-of-work tier)");
  ok(METERED_SLUGS.has(REDACT_CHAT_SLUG), "excluded from the catalog sweeps as metered");
  ok(SETTLE_FIRST_SHARED_TOOLS.some((t) => t.slug === REDACT_CHAT_SLUG) && settleFirstSlugs([]).has(REDACT_CHAT_SLUG), "armed to settle first, behind the chat tier's settle point");
}

// --- the money bound, with the private table ------------------------------------------------
{
  const gaps = upstreamCostsLoaded() ? upstreamCostsGaps() : null;
  if (gaps && !gaps.length) {
    // The largest body the route can send: the instruction and text at their caps.
    const body = validateRequest({ messages: chatMessages("x".repeat(INSTRUCTION_MAX_CHARS), "y".repeat(TEXT_MAX_CHARS)) }, CHAT_SLUG);
    const worst = worstCaseUpstreamCost(body, TIERS[CHAT_SLUG]).totalUsd;
    ok(worst <= priceOf(chatDef) * MARGIN + 1e-12, `the largest masked body stays within the chat tier's own bound (${CHAT_SLUG})`);
    ok(worst <= redactChatPriceUsd() * MARGIN + 1e-12, `the largest masked body stays within ${MARGIN * 100}% of this route's price`);
  } else if (process.env.CI && process.env.UPSTREAM_COSTS_OPTIONAL !== "1") {
    ok(false, `the private upstream-cost table is ${gaps ? `incomplete (missing: ${gaps.join(", ")})` : "not loaded"}; the margin bound was not checked`);
  } else {
    console.log(`SKIP - margin bound: the private upstream-cost table is ${gaps ? "incomplete" : "not loaded"} (set UPSTREAM_COSTS_FILE)`);
  }
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
