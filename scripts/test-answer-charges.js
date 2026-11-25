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
{
  // The images wire: the mark is written into each generated file
  // (data[].b64_json, a copy of the answer), the field is not added.
  const { Jimp } = await import("jimp");
  const png = (await new Jimp({ width: 2, height: 2, color: 0x3366ccff }).getBuffer("image/png")).toString("base64");
  const src = charged({ created: 1, data: [{ b64_json: png }] });
  const out = withAiGenerated(src, { wire: true });
  ok(out !== src && out.data[0].b64_json !== png, "the images wire answer is a copy with the mark in the file");
  kept(out, "withAiGenerated (images wire, data[].b64_json marked)");
  const img = charged({ image: png });
  const outImg = withAiGenerated(img);
  ok(outImg.image !== png, "an image tool's `image` is marked in the file");
  kept(outImg, "withAiGenerated (image tool, `image` marked)");
}
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

// ---- the class: every composer in src/tools/ is named here ----
// A tool whose handler runs ANOTHER tool's handler (a call, or the handler
// taken as a step) and answers a newly built object drops whatever charge
// figures the inner answer carried, unless the copy goes through
// keepAnswerCharges. Each file's count of handler reads is pinned with how it
// stands with that rule, so a new composer fails here until it is read:
//   keeps     - the rebuilt answer goes through keepAnswerCharges (checked);
//   wrapper   - a handler wrapper pinned in WRAPPERS above (rule held there);
//   dataLegs  - every leg comes from the listed kits (checked against the
//               file's own tool-array imports), and none of those kits ever
//               sets a charge figure (checked), so there is nothing to carry;
//   ownsCharge- the route prices its own run and discards the inner figure on
//               purpose (the pattern is checked);
//   fixedSum  - the route's price is a fixed sum over legs of which at most one
//               reports a figure: carried alone, that one leg's figure would
//               settle an upto buyer under the other legs' share, so the
//               answer carries none and the buyer settles the listed price.
// The route binders and gates in src/ (server.js, mcp-http, referral and
// marketplace gates) call the handler AS the route and are not composers.
const SETS_FIGURE = /\bsetMeterSentinel\b|\bsetActualCharge\b|__meterUpstreamUsd|__actualChargeUsd/;
const COMPOSERS = {
  "src/tools/llm-gemini-kit.js": { n: 1, keeps: true },               // the Gemini wire over the chat tiers
  "src/tools/hyperliquid-shared.js": { n: 1, keeps: true },           // staleness label (also a wrapper)
  "src/tools/coingecko-rate.js": { n: 1, wrapper: true },             // cgScoped
  "src/tools/gov-kit.js": { n: 2, wrapper: true },                    // geo-lookup's census credit (the inner handler, its toString)
  "src/tools/solana-intel-kit.js": { n: 1, wrapper: true }, "src/tools/x-data-kit.js": { n: 1, wrapper: true }, "src/tools/crawl-kit.js": { n: 1, wrapper: true }, // markUntrusted
  "src/tools/html-kit.js": { n: 1, dataLegs: ["src/tools/html-kit.js"] }, // the worker's handler map, its own kit
  "src/tools/cdp-kit.js": { n: 1, dataLegs: ["src/tools/cdp-kit.js"] },   // ownSqlQuery: the server's own read
  "src/tools/bundle-kit.js": { n: 1, dataLegs: ["src/tools/weather-kit.js", "src/tools/weather-plan-kit.js", "src/tools/weather-probability-kit.js", "src/tools/edgar-kit.js", "src/tools/crypto-markets-kit.js"] },
  "src/tools/dossier-kit.js": { n: 1, dataLegs: ["src/tools/edgar-kit.js", "src/tools/finance-kit.js"] },
  "src/tools/domain-audit-kit.js": { n: 1, dataLegs: ["src/tools/kit.js", "src/tools/network-kit.js", "src/tools/network-kit2.js"] },
  "src/tools/ipo-report-kit.js": { n: 1, dataLegs: ["src/tools/edgar-kit.js"] },
  "src/tools/recall-report-kit.js": { n: 1, dataLegs: ["src/tools/gov-kit.js"] },
  "src/tools/token-brief-kit.js": { n: 1, dataLegs: ["src/tools/solana-intel-kit.js"] },
  "src/tools/token-risk-kit.js": { n: 1, dataLegs: ["src/tools/contract-kit.js"] },
  "src/tools/decide-kit.js": { n: 2, ownsCharge: /return setActualCharge\(answer, chargedUsd, req\)/ },   // settles the run's own spend
  "src/tools/route-execute.js": { n: 1, ownsCharge: /delete result\.__meterUpstreamUsd/ },                 // resale price over the underlying list price
  "src/tools/redact-chat-kit.js": { n: 2, fixedSum: "/api/redact plus the v1-chat tier" },
  "src/tools/pdf-summarize-kit.js": { n: 1, fixedSum: "the PDF read plus the v1-chat tier" },
  "src/tools/dub-kit.js": { n: 1, fixedSum: "the translate tier plus the speech tier's quote (speech reports a figure only under METERED_MEDIA)" },
  "src/tools/skill-runner.js": { n: 1, fixedSum: "a pack's generated price over its steps (scripts/pack-prices.js)" },
};
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  // A handler read: `x.handler(` or `x.handler` taken as a value, never a
  // `typeof` test or an assignment to it.
  const READ = /(?<!typeof\s+[\w$.?[\]]*)\.handler\b(?=\s*(?:\(|[;,)\]}]|$))/gm;
  const reads = {};
  for (const f of files.filter((p) => p.startsWith("src/tools/"))) {
    const n = (strip(readFileSync(join(root, f), "utf8")).match(READ) || []).length;
    if (n) reads[f] = n;
  }
  const unread = Object.entries(reads).filter(([f, n]) => (COMPOSERS[f]?.n || 0) < n);
  ok(unread.length === 0, `every tool that runs another tool's handler is one this suite reads (${unread.map(([f, n]) => `${f}: ${n}`).join(", ") || "none new"})`);
  for (const [f, c] of Object.entries(COMPOSERS)) {
    const src = readFileSync(join(root, f), "utf8");
    if (c.keeps) ok(/import \{[^}]*\bkeepAnswerCharges\b[^}]*\} from "\.\.\/answer-charges\.js"/.test(src) && /keepAnswerCharges\(/.test(strip(src)), `${f}: the rebuilt answer goes through keepAnswerCharges`);
    else if (c.wrapper) ok((WRAPPERS[f] || 0) >= 1, `${f}: a handler wrapper pinned above`);
    else if (c.dataLegs) {
      const own = new Set([f]);
      const imported = [...strip(src).matchAll(/import \{([^}]*)\} from "\.\/([\w-]+\.js)"/g)]
        .filter(([, names]) => /\b(?:[A-Z][A-Z0-9_]*_TOOLS\d*|KIT\d*)\b/.test(names)).map(([, , p]) => `src/tools/${p}`);
      const outside = imported.filter((p) => !c.dataLegs.includes(p) && !own.has(p));
      const setters = c.dataLegs.filter((p) => SETS_FIGURE.test(readFileSync(join(root, p), "utf8")));
      ok(outside.length === 0 && setters.length === 0, `${f}: every leg comes from a kit that sets no charge figure (outside the list: ${outside.join(", ") || "none"}; setting one: ${setters.join(", ") || "none"})`);
    } else if (c.ownsCharge) ok(c.ownsCharge.test(src), `${f}: prices its own run and discards the inner figure`);
    else ok(typeof c.fixedSum === "string" && c.fixedSum.length > 0, `${f}: a fixed-sum composite (${c.fixedSum}); carries no single leg's figure`);
  }
  // fixedSum, as served: a charged chat step leaves redact-chat's answer
  // with no figure, so an upto buyer settles the listed sum.
  const { REDACT_CHAT_TOOLS, __setChatForTest } = await import("../src/tools/redact-chat-kit.js");
  __setChatForTest(async () => charged({ model: "m", choices: [{ message: { role: "assistant", content: "Fine." }, finish_reason: "stop" }] }));
  try {
    const out = await REDACT_CHAT_TOOLS[0].handler({ text: "mail ada@example.com", instruction: "Reply." });
    ok(out.answer === "Fine." && out.__meterUpstreamUsd === undefined && out.__actualChargeUsd === undefined, "redact-chat (a fixed sum) answers no single leg's figure");
  } finally { __setChatForTest(null); }
  // keeps, as served: the Gemini wire carries the chat tier's figures.
  const { LLM_GATEWAY_TOOLS } = await import("../src/tools/llm-gateway-kit.js");
  const { LLM_GEMINI_TOOLS } = await import("../src/tools/llm-gemini-kit.js");
  const chat = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-metered");
  const gem = LLM_GEMINI_TOOLS.find((t) => t.route.endsWith("/v1/metered/gemini"));
  const realChat = chat.handler;
  chat.handler = async () => charged({ model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Hi." }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  try {
    const out = await gem.handler({ contents: [{ role: "user", parts: [{ text: "Hi" }] }] }, {});
    ok(out.candidates?.[0]?.content?.parts?.[0]?.text === "Hi.", "the Gemini wire answered in its own shape");
    kept(out, "/v1/metered/gemini (the chat answer rebuilt in Google's shape)");
  } finally { chat.handler = realChat; }
}

console.log(`\ntest-answer-charges: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
