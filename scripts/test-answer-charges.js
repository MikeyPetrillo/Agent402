// What a handler's answer says it costs survives every copy made of it
// between the handler and the settlement (src/answer-charges.js).
//   - each answer copier in src/ keeps `__actualChargeUsd` and
//     `__meterUpstreamUsd` (non-enumerable, never serialized);
//   - a metered media route (the real embed def, METERED_MEDIA=on) wrapped
//     as the server wraps a model-backed tool (markAiGenerated, then
//     runAsRouteCall while another call prints the charge sentence) settles
//     an upto payment at the metered amount, under the ceiling; and speech
//     (markAiVoice, then markAiGenerated, a byte answer) the same;
//   - the class: every handler wrapper assigned in src/ is one this suite
//     names, so a new wrapper is read for this rule before it ships.
//
//   node scripts/test-answer-charges.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const { ANSWER_CHARGE_KEYS, keepAnswerCharges } = await import("../src/answer-charges.js");
const { withAiGenerated, markAiGenerated } = await import("../src/ai-generated.js");
const { withAiVoice, markAiVoice } = await import("../src/ai-voice.js");
const { withCredit, creditAnswers, termsAnswers, licensedAnswers } = await import("../src/data-attribution.js");
const { markUntrusted } = await import("../src/tools/provenance.js");
const { runAsRouteCall, notChargedHere } = await import("../src/not-charged.js");
const { withNextCall } = await import("../src/next-call.js");
const { withHouseStyle } = await import("../src/house-style.js");
const { applyMeteredSettlement } = await import("../src/gateway-meter.js");

const charged = (body) => {
  const o = { ...body };
  Object.defineProperty(o, "__actualChargeUsd", { value: 0.0123, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(o, "__meterUpstreamUsd", { value: 0.0042, enumerable: false, configurable: true, writable: true });
  return o;
};
const kept = (o, label) => {
  const all = o && o.__actualChargeUsd === 0.0123 && o.__meterUpstreamUsd === 0.0042;
  const hidden = o && !Object.keys(o).some((k) => ANSWER_CHARGE_KEYS.includes(k)) && !/__actualCharge|__meterUpstream/.test(JSON.stringify(o));
  ok(all && hidden, `${label}: both charge figures kept, neither serialized`);
};

ok(keepAnswerCharges(charged({}), { a: 1 }).__actualChargeUsd === 0.0123, "keepAnswerCharges copies a figure onto a copy");
{ const to = charged({}); to.__meterUpstreamUsd = 9; ok(keepAnswerCharges(charged({}), to).__meterUpstreamUsd === 9, "a figure the copy already holds is kept"); }
ok(keepAnswerCharges(null, 5) === 5 && keepAnswerCharges({}, null) === null, "a non-object on either side is returned as it is");

// ---- every copier ----
kept(withAiGenerated(charged({ text: "x" })), "withAiGenerated (JSON field)");
kept(withAiGenerated(charged({ __binary: Buffer.from([1, 2, 3]), contentType: "application/octet-stream" })), "withAiGenerated (byte answer)");
kept(withAiGenerated(charged({ image: "aGVsbG8=", text: "x" })), "withAiGenerated (image inside JSON)");
kept(withAiVoice(charged({ text: "x" })), "withAiVoice (JSON)");
kept(withAiVoice(charged({ __binary: Buffer.from([1]), contentType: "audio/mpeg" })), "withAiVoice (byte answer)");
kept(withCredit(charged({ a: 1 }), "Credit line."), "withCredit (added)");
kept(withCredit(charged({ a: 1, credit: "Other." }), "Credit line."), "withCredit (appended)");
kept(markUntrusted(charged({ a: 1 })), "markUntrusted");
{
  const t = { slug: "t", handler: async () => charged({ a: 1 }), discovery: {} };
  termsAnswers(t, "Terms line.");
  kept(await t.handler({}), "termsAnswers");
  const l = { slug: "l", handler: async () => charged({ a: 1 }), discovery: {} };
  licensedAnswers(l, { license: "CC-BY" });
  kept(await l.handler({}), "licensedAnswers");
  const c = { slug: "c", handler: async () => charged({ a: 1 }), discovery: {} };
  creditAnswers(c, "Credit line.");
  kept(await c.handler({}), "creditAnswers");
}
kept(await withNextCall(async () => charged({ a: 1 }), { slug: "n" })({}), "withNextCall");
kept(await withHouseStyle(async () => charged({ title: "A title", body: "x" }))({}), "withHouseStyle");
{
  const { labelHlStaleness, withHlFreshness } = await import("../src/tools/hyperliquid-shared.js");
  ok(typeof labelHlStaleness === "function" && typeof withHlFreshness === "function", "the hyperliquid staleness label is read below (source)");
}
{
  // The route call removes the charge sentence from a delivered answer (a copy).
  const run = runAsRouteCall(async () => { await new Promise((r) => setTimeout(r, 5)); return charged({ note: "A seller said: Nothing was charged." }); });
  await runAsRouteCall(async () => notChargedHere());
  const out = await run;
  ok(out.note === "A seller said:", "runAsRouteCall delivered a sentence-free copy");
  kept(out, "runAsRouteCall (sentence removed)");
}

// ---- a metered media route, wrapped as the server wraps it ----
const encode = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const uptoReq = () => { const h = encode({ x402Version: 2, accepted: { scheme: "upto", network: "eip155:8453" }, payload: {} }); return { headers: { "payment-signature": h }, header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : null) }; };
const mkRes = () => { const h = {}; return { headersSent: false, setHeader: (k, v) => { h[k.toLowerCase()] = v; }, getHeader: (k) => h[String(k).toLowerCase()], h }; };
{
  process.env.UPSTREAM_COSTS_JSON = "";
  process.env.UPSTREAM_COSTS_FILE = fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url));
  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.METERED_MEDIA = "on";
  const { EMBED_TOOLS } = await import("../src/tools/embed-kit.js");
  const embed = EMBED_TOOLS.find((t) => t.slug === "embed");
  embed.modelBacked = true;
  markAiGenerated([embed]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 300, total_tokens: 300 } }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const req = uptoReq();
    const out = await runAsRouteCall(() => embed.handler({ text: "hello" }, req));
    const res = mkRes(); let override = null;
    const amount = applyMeteredSettlement({ result: out, req, tool: embed, res, enabled: true, setOverrides: (_r, o) => { override = o; }, log: () => {} });
    const price = Number(embed.price.replace("$", ""));
    ok(out.aiGenerated === true && Number.isFinite(amount) && amount < price && override?.amount === `$${amount.toFixed(6)}`, `embed (real def, marked model-backed): an upto buyer settles the metered amount under the price ($${amount} of ${embed.price})`);
  } finally { globalThis.fetch = realFetch; }
}
{
  // Speech: the kit marks the voice, the server marks the answer; a byte answer.
  const tts = { slug: "tts-probe", route: "POST /api/tts-probe", price: "$0.05", modelBacked: true, discovery: {}, handler: async () => {
    const o = { __binary: Buffer.from([0xff, 0xfb, 0x90, 0x00]), contentType: "audio/mpeg" };
    Object.defineProperty(o, "__meterUpstreamUsd", { value: 0.001, enumerable: false, configurable: true, writable: true });
    return o;
  } };
  markAiVoice([tts], ["tts-probe"]);
  markAiGenerated([tts]);
  const req = uptoReq();
  const out = await runAsRouteCall(() => tts.handler({ text: "hi" }, req));
  const res = mkRes(); let override = null;
  const amount = applyMeteredSettlement({ result: out, req, tool: tts, res, enabled: true, setOverrides: (_r, o) => { override = o; }, log: () => {} });
  ok(out.headers?.["X-AI-Generated"] === "true" && Number.isFinite(amount) && amount < 0.05 && override !== null, `speech through markAiVoice and markAiGenerated settles the metered amount ($${amount})`);
}

// ---- the class: every handler wrapper in src/ is named here ----
// A wrapper that returns a copy of the answer must route it through
// keepAnswerCharges; one that returns the inner answer unchanged needs
// nothing. Each file's count of handler assignments is pinned, so a new
// wrapper fails this suite until it is read for that rule and listed.
const WRAPPERS = {
  "src/ai-generated.js": 1,          // withAiGenerated, keeps (above)
  "src/ai-voice.js": 1,              // withAiVoice, keeps (above)
  "src/data-attribution.js": 3,      // credit, terms, licence, keep (above)
  "src/tools/gov-kit.js": 1,         // geo-lookup's census credit: withCredit, keeps
  "src/tools/solana-intel-kit.js": 1, "src/tools/x-data-kit.js": 1, "src/tools/crawl-kit.js": 1, // markUntrusted, keeps
  "src/tools/coingecko-rate.js": 1,  // cgScoped: returns the inner answer
  "src/upstream-deadline.js": 1,     // underBudget: returns the inner answer
  "src/server.js": 6,                // the media and browser worker binders (return the inner answer), house style, next call (keep, above), caller-input errors and cap count (return the inner answer)
  "src/tools/html-kit.js": 1,        // the HTML worker binder: a worker's answer, no charge figures
  "src/tools/hyperliquid-shared.js": 1, // staleness label, keeps (source read below)
};
const root = fileURLToPath(new URL("..", import.meta.url));
const files = [];
const walk = (d) => { for (const n of readdirSync(join(root, d))) { const p = join(d, n); if (statSync(join(root, p)).isDirectory()) { if (n !== "generated") walk(p); } else if (p.endsWith(".js")) files.push(p); } };
walk("src");
const found = {};
for (const f of files) {
  const src = readFileSync(join(root, f), "utf8");
  const n = (src.match(/\.handler\s*=(?!=)\s*(?=\S)(?!fn\b)/g) || []).length + (src.match(/\.\.\.(?:t|tool|def),\s*handler:/g) || []).length;
  if (n) found[f] = n;
}
const extra = Object.entries(found).filter(([f, n]) => (WRAPPERS[f] || 0) < n);
ok(extra.length === 0, `every handler wrapper in src/ is one this suite reads (${extra.map(([f, n]) => `${f}: ${n}`).join(", ") || "none new"})`);
{
  const hl = readFileSync(join(root, "src/tools/hyperliquid-shared.js"), "utf8");
  ok(/return keepAnswerCharges\(result, \{\s*\.\.\.result,\s*stale: true/.test(hl), "the hyperliquid staleness label keeps the charge figures");
  const gov = readFileSync(join(root, "src/tools/gov-kit.js"), "utf8");
  ok(/withCredit\(a, CENSUS_CREDIT\)/.test(gov), "geo-lookup's census credit goes through withCredit (which keeps them)");
}

console.log(`\ntest-answer-charges: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
