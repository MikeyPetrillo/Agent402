#!/usr/bin/env node
// /api/summarize (src/tools/summarize-kit.js): a web page or a text, one chat call.
// Offline: the chat step is the REAL v1-chat gateway handler, with the HTTP
// upstream stubbed at globalThis.fetch, and the page read is stubbed where a
// page is needed (the refusal cases use extract's real read path).
//
// What it pins:
//   - the text path and the url path each answer a summary in the documented
//     shape, through the same model and prompt rule as pdf-summarize;
//   - neither or both inputs, a non-http URL and an over-long text are a 400
//     with no settle call and no model call;
//   - a private or link-local URL is refused by extract's own read path
//     before any settle call or model call;
//   - an unreadable page is a 422 before any settle call or model call;
//   - on a run armed to settle first, the settle call comes before the model
//     call, and after the page read;
//   - the price is pdf-summarize's, read from its definition;
//   - the lists pdf-summarize is on, summarize is on (wallet-only, metered,
//     model-backed, robots-gated) and the settle-first list holds neither.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { SUMMARIZE_TOOLS, SUMMARIZE_SLUG, TEXT_MAX_CHARS, FRAMING, summarizeInput, __setStepsForTest } from "../src/tools/summarize-kit.js";
import { PDF_SUMMARIZE_TOOLS, SUMMARY_MODEL, MAX_SUMMARY_INPUT_BYTES } from "../src/tools/pdf-summarize-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { METERED_SLUGS } from "../src/metered-slugs.js";
import { ROBOTS_GATED_SLUGS } from "../src/tools/robots-gate.js";
import { settleFirstSlugs } from "../src/settle-first-tools.js";
import { armSettleFirst, disarmSettleFirst, setSettleFirstAmbient } from "../src/settle-first.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const throwsWith = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const tool = SUMMARIZE_TOOLS[0];
const pdfDef = PDF_SUMMARIZE_TOOLS.find((t) => t.slug === "pdf-summarize");

// --- the upstream, stubbed at fetch, and the settle point, recorded ------------
process.env.OPENROUTER_API_KEY = "test-key";
const order = [];
const outbound = [];
const SUMMARY = "Renewable sources supplied a record share of power, storage grew, and permitting remains the bottleneck.";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!/openrouter\.ai/.test(u)) return realFetch(url, init);
  const raw = String(init?.body ?? "");
  order.push("model");
  outbound.push({ url: u, body: JSON.parse(raw) });
  const body = JSON.parse(raw);
  const json = { id: "gen-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: SUMMARY }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20 } };
  return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(json), json: async () => json };
};
// Every call runs as a request armed to settle first: the settle point records
// its turn, so "no settle call" and "settle before model" are both readable.
let req = null;
setSettleFirstAmbient(() => req);
const run = async (input) => {
  order.length = 0; outbound.length = 0;
  req = {};
  armSettleFirst(req, { run: async () => { order.push("settle"); } });
  try { return await tool.handler(input); } finally { disarmSettleFirst(req); req = null; }
};

const PAGE = {
  url: "https://news.example/renewables",
  title: "Renewables set a record",
  markdown: "# Renewables set a record\n\nSolar and wind supplied a record share of electricity last year. Battery storage grew quickly. Permitting remains the main bottleneck.",
  wordCount: 22,
  untrustedContent: true,
};
const readCalls = [];
const stubRead = async (url) => { readCalls.push(url); order.push("read"); return { ...PAGE, url }; };

// --- the text path --------------------------------------------------------------
{
  __setStepsForTest({ read: stubRead });
  readCalls.length = 0;
  const text = "Solar and wind supplied a record share of electricity last year as new capacity came online.";
  const out = await run({ text, maxWords: 60 });
  ok(out.summary === SUMMARY && out.source === "text" && out.url === null && out.title === null, `the text path answers the summary (${JSON.stringify(out).slice(0, 160)})`);
  ok(out.wordCount === text.split(/\s+/).length && out.summaryWordCount === SUMMARY.split(/\s+/).length && out.truncatedInput === false && !("untrustedContent" in out), "the text path counts words both ways and marks nothing untrusted");
  ok(readCalls.length === 0, "the text path reads no page");
  ok(outbound.length === 1 && outbound[0].body.model === SUMMARY_MODEL, `one model call, on pdf-summarize's model (${outbound[0]?.body?.model})`);
  const msgs = outbound[0]?.body?.messages || [];
  ok(msgs[0]?.role === "system" && msgs[0]?.content === FRAMING && msgs.at(-1)?.content.includes("in about 60 words") && msgs.at(-1)?.content.endsWith(text), "the prompt frames the document as data and carries the word target and the text");
  ok(order.join(",") === "settle,model", `the settle call comes before the model call on the text path (${order.join(",")})`);
}

// --- the url path ---------------------------------------------------------------
{
  readCalls.length = 0;
  const out = await run({ url: "https://news.example/renewables" });
  ok(out.summary === SUMMARY && out.source === "url" && out.url === PAGE.url && out.title === PAGE.title && out.untrustedContent === true, `the url path answers the summary with the page's url and title (${JSON.stringify(out).slice(0, 160)})`);
  ok(out.wordCount === PAGE.markdown.split(/\s+/).filter(Boolean).length && out.model === SUMMARY_MODEL, "the url path counts the page's words and names the model");
  ok(readCalls.length === 1 && outbound[0].body.messages.at(-1).content.endsWith(PAGE.markdown) && outbound[0].body.messages.at(-1).content.includes("about 200 words"), "the url path sends the extracted markdown with the default length");
  ok(order.join(",") === "read,settle,model", `the page read, then the settle call, then the model call (${order.join(",")})`);
}

// --- a long text is clipped exactly as pdf-summarize clips a page --------------
{
  // The chat step is stubbed here: whether the tier then accepts the clipped
  // body depends on the private cost table, and the clip is this kit's own.
  let seen = null;
  __setStepsForTest({ read: stubRead, chat: async (b) => { seen = b; return { model: SUMMARY_MODEL, choices: [{ message: { content: SUMMARY } }] }; } });
  const long = "word ".repeat(Math.ceil((MAX_SUMMARY_INPUT_BYTES + 5000) / 5));
  const out = await run({ text: long.slice(0, TEXT_MAX_CHARS) });
  __setStepsForTest({ read: stubRead });
  const sent = seen?.messages?.at(-1)?.content || "";
  ok(out.truncatedInput === true && Buffer.byteLength(sent, "utf8") < MAX_SUMMARY_INPUT_BYTES + 400, `a text over the clip is cut and says so (${Buffer.byteLength(sent, "utf8")} bytes sent)`);
}

// --- refusals of the caller's input: 400, no settle, no model ------------------
for (const [label, input] of [
  ["neither input", {}],
  ["blank inputs", { url: "  ", text: "" }],
  ["both inputs", { url: "https://news.example/a", text: "some text" }],
  ["a non-http URL", { url: "file:///etc/passwd" }],
  ["a URL that is not a string", { url: { href: "https://news.example/a" } }],
  ["a text that is not a string", { text: ["a", "b"] }],
  ["a text over the cap", { text: "x".repeat(TEXT_MAX_CHARS + 1) }],
]) {
  readCalls.length = 0;
  const e = await throwsWith(() => run(input));
  ok(e?.statusCode === 400 && order.length === 0 && outbound.length === 0 && readCalls.length === 0, `${label}: 400 with no read, no settle call and no model call (${e?.statusCode} ${e?.message?.slice(0, 80)}; ${order.join(",") || "nothing ran"})`);
}
ok(JSON.stringify(summarizeInput({ url: " https://news.example/a " })) === '{"url":"https://news.example/a"}', "a url is trimmed before it is read");

// --- extract's own read path refuses private addresses before any settle -------
{
  __setStepsForTest({}); // the real extractArticle
  for (const url of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://10.0.0.5/"]) {
    const e = await throwsWith(() => run({ url }));
    ok(e && e.statusCode >= 400 && e.statusCode < 500 && order.length === 0 && outbound.length === 0, `${url}: refused by the read path (${e?.statusCode} ${e?.message?.slice(0, 70)}) with no settle call and no model call`);
  }
}

// --- an unreadable page: 422 before any settle ---------------------------------
{
  __setStepsForTest({ read: async () => { order.push("read"); throw Object.assign(new Error("Could not extract readable content from this page"), { statusCode: 422 }); } });
  let e = await throwsWith(() => run({ url: "https://news.example/empty" }));
  ok(e?.statusCode === 422 && order.join(",") === "read" && outbound.length === 0, `extract's own 422 is answered before any settle call (${e?.statusCode}; ${order.join(",")})`);
  __setStepsForTest({ read: async (url) => { order.push("read"); return { ...PAGE, url, markdown: "   " }; } });
  e = await throwsWith(() => run({ url: "https://news.example/blank" }));
  ok(e?.statusCode === 422 && order.join(",") === "read" && outbound.length === 0, `a page with no text is a 422 before any settle call (${e?.statusCode}; ${order.join(",")})`);
  __setStepsForTest({ read: stubRead, chat: async () => ({ model: "m", choices: [{ message: { content: "  " } }] }) });
  e = await throwsWith(() => run({ text: "some text to summarize" }));
  ok(e?.statusCode === 502, `an empty model answer is a 502 (never settled on x402) (${e?.statusCode})`);
  __setStepsForTest({});
}

// --- the definition and the lists ----------------------------------------------
ok(tool.slug === SUMMARIZE_SLUG && tool.route === "POST /api/summarize" && tool.modelBacked === true, "summarize is POST /api/summarize and marked modelBacked");
ok(tool.price === pdfDef.price, `the price is pdf-summarize's, read from its definition (${tool.price})`);
ok(!/\$\d/.test(readFileSync(new URL("../src/tools/summarize-kit.js", import.meta.url), "utf8")), "the kit types no price");
ok(/AI-generated/.test(tool.description) && /Model-backed/.test(tool.description) && !/—/.test(tool.description), "the description says the summary is AI-generated and model-backed, with no em dash");
for (const [name, has] of [["WALLET_ONLY_SLUGS", (s) => WALLET_ONLY_SLUGS.has(s)], ["METERED_SLUGS", (s) => METERED_SLUGS.has(s)], ["ROBOTS_GATED_SLUGS", (s) => ROBOTS_GATED_SLUGS.includes(s)]]) {
  ok(has("pdf-summarize") && has(SUMMARIZE_SLUG), `summarize is on ${name}, as pdf-summarize is`);
}
const sfs = settleFirstSlugs([]);
ok(!sfs.has("pdf-summarize") && !sfs.has(SUMMARIZE_SLUG), "neither summarize tool is on the settle-first list");
ok(!FREE_TIER_SLUGS.has(SUMMARIZE_SLUG), "summarize is not on the free tier");
ok(typeof tool.discovery.input.url === "string" && !tool.discovery.inputSchema.required, "the published example reads a url; the schema requires neither field alone");

globalThis.fetch = realFetch;
setSettleFirstAmbient(null);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
