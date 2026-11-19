#!/usr/bin/env node
// "Watch a call get paid" (src/paid-call-figure.js, assets/js/paid-call.js):
//   - the six steps in order, the receipt step only while the server signs;
//   - the price is the tool's catalog price, and no other dollar figure appears
//     (no cost, no revenue);
//   - a live figure with no reading is served hidden, never as a placeholder;
//   - home, /101 and a tool page carry the figure, its styles and the
//     first-party script (no inline script);
//   - the script under reduced motion leaves every step lit and starts no
//     timer; with motion allowed it lights the steps in order once on screen.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { paidCallFigure, paidCallSteps, PAID_CALL_CSS } from "../src/paid-call-figure.js";
import { RECEIPT_HEADER } from "../src/receipt-signing.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

{
  const on = paidCallSteps({ method: "GET", path: "/api/uuid", price: "$0.001", chains: 12, receipts: true });
  ok(on.map((s) => s[1]).join(",") === "Request,402,Sign,Settle,Answer,Receipt", "six steps in order while receipts are signed");
  ok(on.at(-1)[2] === RECEIPT_HEADER, "the receipt step names the receipt header");
  const off = paidCallSteps({ receipts: false, price: "$0.001", chains: 12 });
  ok(off.length === 5 && !off.some((s) => s[0] === "receipt"), "no receipt step while the server does not sign");
  const one = paidCallSteps({ receipts: false, price: "$0.01", chains: "USDC on Base" });
  ok(one[3][2] === "USDC on Base", "a tool on one chain names it");
  ok(paidCallSteps({ chains: 1, receipts: false })[3][2] === "on 1 chain" && paidCallSteps({ chains: 12, receipts: false })[3][2] === "on 12 chains", "the chain count reads singular and plural");
}
{
  const html = paidCallFigure({ method: "GET", path: "/api/answer", price: "$0.08", chains: 12, receipts: true, latencyMs: 412, settled: 1234 });
  ok(/data-pc-m="latency">p50 412 ms</.test(html) && /data-pc-m="settled">1,234 settled</.test(html), "readings the server holds are rendered");
  const dollars = [...html.matchAll(/\$[0-9][0-9.,]*/g)].map((m) => m[0]);
  ok(dollars.length === 1 && dollars[0] === "$0.08", `the only dollar figure is the call's price (${dollars.join(", ")})`);
  const empty = paidCallFigure({ price: "$0.001", chains: 12, receipts: false });
  ok(/data-pc-m="latency" hidden><\/span>/.test(empty) && /data-pc-m="settled" hidden><\/span>/.test(empty), "a figure with no reading is served hidden and empty");
  ok(!/<script/i.test(html) && /role="list"/.test(html) && /aria-label="A paid call, step by step: Request, 402, Sign, Settle, Answer, Receipt"/.test(html), "no inline script; a named list for assistive technology");
  ok(/\.pc-run \.pc-step:not\(\.is-on\)/.test(PAID_CALL_CSS) && !/\.pc-step \{[^}]*opacity/.test(PAID_CALL_CSS), "only the script's run state dims a step; served, every step is lit");
}
{
  const { toolPage, toolList } = await import("../src/pages.js");
  const { ledgerHomePage } = await import("../src/ledger-home.js");
  const { x402101Page } = await import("../src/x402-101.js");
  const catalog = {
    "GET /api/uuid": { route: "GET /api/uuid", slug: "uuid", name: "UUID", category: "utility", price: "$0.001", description: "Generate a UUID.", tags: [], discovery: { inputSchema: { type: "object", properties: {} }, input: {}, output: { example: { uuid: "x" } } } },
    "GET /api/answer": { route: "GET /api/answer", slug: "answer", name: "Answer", category: "search", price: "$0.08", description: "Answer a question.", tags: [], discovery: { inputSchema: { type: "object", properties: {} }, input: {}, output: { example: { answer: "x" } } } },
  };
  const tools = toolList(catalog);
  const tp = toolPage("https://agent402.tools", tools.find((t) => t.slug === "uuid"), [], {});
  ok(/<h2 class="tp-h2">Watch a call get paid<\/h2>/.test(tp) && /<figure class="pc" data-pc/.test(tp) && /<code class="pc-v">GET \/api\/uuid<\/code>/.test(tp), "a tool page shows its own call");
  ok(/<script src="\/js\/paid-call\.js\?v=[^"]+" defer><\/script>/.test(tp) && tp.includes(".pc-track{"), "a tool page loads the figure's styles and first-party script");
  const home = ledgerHomePage("http://127.0.0.1:3000", catalog, {}, {}, [], { chainsOffered: 12 });
  ok(/<section id="paid-call"[\s\S]*Watch a call get paid\.[\s\S]*<code class="pc-v">GET \/api\/answer<\/code>[\s\S]*\$0\.08 USDC/.test(home), "home shows the cited-answer call at its catalog price");
  ok(/<code class="pc-v">on 12 chains<\/code>/.test(home), "home reads the chain count the server offers");
  const deck = x402101Page("https://agent402.tools", { demoTool: catalog["GET /api/uuid"] });
  ok(/<section class="s101-slide" id="recap"[\s\S]*?<figure class="pc" data-pc[\s\S]*?<\/section>/.test(deck) && /\$0\.001 USDC/.test(deck), "/101 shows the demo's call on the recap slide");
  ok(!/<figure class="pc"/.test(x402101Page("https://agent402.tools")) , "/101 leaves the figure out with no demo tool");
}
// The script, run in a sandbox with timers and observers driven by hand.
{
  const code = readFileSync(new URL("../assets/js/paid-call.js", import.meta.url), "utf8");
  const run = (reduced) => {
    const cls = (set) => ({ toggle: (c, on) => (on ? set.add(c) : set.delete(c)), add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) });
    const steps = Array.from({ length: 6 }, () => { const s = new Set(); return { set: s, classList: cls(s) }; });
    const figSet = new Set();
    const fig = { classList: cls(figSet), querySelectorAll: () => steps, querySelector: () => null };
    const intervals = [];
    let io = null;
    const sandbox = {
      document: { querySelectorAll: () => [fig], documentElement: {}, hidden: false, addEventListener() {} },
      window: { matchMedia: () => ({ matches: reduced, addEventListener() {} }), IntersectionObserver: true },
      IntersectionObserver: function (cb) { io = cb; this.observe = () => {}; },
      getComputedStyle: () => ({ getPropertyValue: () => "1000ms" }),
      fetch: () => Promise.resolve({ ok: false }),
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      clearInterval() {},
      Promise,
    };
    sandbox.window.IntersectionObserver = sandbox.IntersectionObserver;
    vm.runInNewContext(code, sandbox);
    if (io) io([{ isIntersecting: true }]);
    return { steps, figSet, intervals };
  };
  const still = run(true);
  ok(still.intervals.length === 0 && !still.figSet.has("pc-run"), "under reduced motion no timer starts and every step stays lit");
  const moving = run(false);
  ok(moving.intervals.length === 1 && moving.intervals[0].ms === 1000 && moving.figSet.has("pc-run"), "on screen the figure runs one beat (--dur-beat) per step");
  moving.intervals[0].fn(); moving.intervals[0].fn();
  ok(moving.steps[0].set.has("is-on") && moving.steps[1].set.has("is-now") && !moving.steps[2].set.has("is-on"), "the steps light in order");
}

console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
