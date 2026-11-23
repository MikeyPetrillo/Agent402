#!/usr/bin/env node
// The four meta-tool adapters (agent402-langchain, agent402-ai-sdk,
// agent402-openai-agents, agent402-google-adk) pay through the caller's
// payment fetch without agent402-client, so each holds its own caps:
//   - a per-call ceiling on by default at agent402-client's default, checked
//     against the tool's listed price before the payment fetch runs; 0 or
//     "off" turns it off; dailyLimitUsd is an opt-in rolling 24-hour total;
//   - a proof-of-work challenge above MAX_POW_DIFFICULTY bits is refused
//     before any search, and the search yields to the event loop.
// Offline: one loopback stub serves the catalog, the routes and a challenge.
//   node scripts/test-meta-adapter-caps.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const clientSrc = readFileSync(new URL("../client/index.js", import.meta.url), "utf8");
const CLIENT_DEFAULT = Number(/^export const DEFAULT_MAX_PER_CALL_USD = (\d+(?:\.\d+)?);$/m.exec(clientSrc)?.[1]);
const CLIENT_POW = Number(/^export const MAX_POW_DIFFICULTY = (\d+);$/m.exec(readFileSync(new URL("../client/pow-solver.js", import.meta.url), "utf8"))?.[1]);
ok(CLIENT_DEFAULT > 0 && CLIENT_POW > 0, `agent402-client's defaults are read ($${CLIENT_DEFAULT} per call, ${CLIENT_POW}-bit proof of work)`);

let difficulty = 60;
const stub = createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/pricing") {
    return send(200, { endpoints: [
      { slug: "cheap", method: "POST", path: "/api/paid", computePayable: false, price: "$1" },
      { slug: "dear", method: "POST", path: "/api/paid", computePayable: false, price: `$${CLIENT_DEFAULT + 1}` },
      { slug: "unpriced", method: "POST", path: "/api/paid", computePayable: false, price: "quoted" },
      { slug: "pow", method: "POST", path: "/api/pow-only", computePayable: true, price: "$0.001" },
    ] });
  }
  if (u.pathname === "/api/pow/challenge") return send(200, { challenge: "abc", difficulty, token: "tok" });
  if (u.pathname === "/api/paid") return send(200, { paid: true });
  if (u.pathname === "/api/pow-only") {
    const sol = String(req.headers["x-pow-solution"] || "");
    if (!sol) return send(402, { error: "Payment Required" });
    const nonce = sol.split(":")[1];
    const digest = createHash("sha256").update(`abc:${nonce}`).digest();
    let bits = 0; for (const b of digest) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
    return bits >= difficulty && sol.startsWith("tok:") ? send(200, { solved: true }) : send(400, { error: "bad solution" });
  }
  send(404, {});
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${stub.address().port}`;

const ADAPTERS = ["langchain", "ai-sdk", "openai-agents", "google-adk"];
try {
  for (const dir of ADAPTERS) {
    const mod = await import(new URL(`../adapters/${dir}/index.js`, import.meta.url));
    const name = JSON.parse(readFileSync(new URL(`../adapters/${dir}/package.json`, import.meta.url), "utf8")).name;
    ok(mod.DEFAULT_MAX_PER_CALL_USD === CLIENT_DEFAULT, `${name}: the default per-call ceiling is agent402-client's ($${mod.DEFAULT_MAX_PER_CALL_USD})`);
    ok(mod.MAX_POW_DIFFICULTY === CLIENT_POW, `${name}: the proof-of-work bound is agent402-client's (${mod.MAX_POW_DIFFICULTY})`);
    const sent = [];
    const payFetch = (url, init) => { sent.push(String(url)); return fetch(url, init); };
    const callOf = (opts) => mod.agent402ToolSpecs({ baseUrl: BASE, fetch: payFetch, ...opts }).find((s) => s.name === "agent402_call").execute;
    const refusal = async (p) => { try { await p; return null; } catch (e) { return e; } };

    // Default ceiling: a tool listed above it is refused before the payment fetch runs.
    const call = callOf({});
    let e = await refusal(call({ slug: "dear", params: {} }));
    ok(e && e.code === "SPENDING_LIMIT" && e.limit === "maxPerCallUsd" && e.priceUsd === CLIENT_DEFAULT + 1 && sent.length === 0 && /maxPerCallUsd/.test(e.message),
      `${name}: a tool listed at $${CLIENT_DEFAULT + 1} is refused by the default ceiling, unpaid (${e?.message})`);
    ok((await call({ slug: "cheap", params: {} }))?.paid === true && sent.length === 1, `${name}: control: a $1 tool is paid through the payment fetch`);
    for (const off of [0, "0", "off", null]) {
      const before = sent.length;
      ok((await callOf({ maxPerCallUsd: off })({ slug: "dear", params: {} }))?.paid === true && sent.length === before + 1, `${name}: maxPerCallUsd ${JSON.stringify(off)} turns the ceiling off`);
    }
    e = await refusal(callOf({ maxPerCallUsd: 0.5 })({ slug: "cheap", params: {} }));
    ok(e?.limit === "maxPerCallUsd", `${name}: a ceiling the caller sets refuses a $1 tool`);
    const warned = [];
    const origWarn = console.warn; console.warn = (m) => warned.push(String(m));
    try {
      e = await refusal(callOf({ maxPerCallUsd: "five" })({ slug: "dear", params: {} }));
    } finally { console.warn = origWarn; }
    ok(e?.limit === "maxPerCallUsd" && warned.some((w) => w.includes(name) && /keeping the default/.test(w)), `${name}: a malformed maxPerCallUsd keeps the default and warns`);

    // Daily limit (opt-in): the call that would pass it is refused.
    const day = callOf({ dailyLimitUsd: 1.5 });
    const before = sent.length;
    await day({ slug: "cheap", params: {} });
    e = await refusal(day({ slug: "cheap", params: {} }));
    ok(e?.limit === "dailyLimitUsd" && e.spent === 1 && sent.length === before + 1, `${name}: dailyLimitUsd refuses the call that would pass it (${e?.message})`);
    e = await refusal(callOf({ dailyLimitUsd: "abc" })({ slug: "cheap", params: {} }));
    ok(e?.limit === "dailyLimitUsd" && sent.length === before + 1, `${name}: a malformed dailyLimitUsd pays nothing`);

    // A listed price that does not read as USD is refused while a cap is on.
    e = await refusal(call({ slug: "unpriced", params: {} }));
    ok(e?.code === "SPENDING_LIMIT" && sent.length === before + 1, `${name}: a price that does not read as USD is refused while a cap is set`);

    // Proof of work: an unbounded difficulty is refused at once; one in range is solved.
    difficulty = 60;
    const t0 = Date.now();
    // A solver that took the challenge would search without end (it yields,
    // so this timer still fires): the run fails here instead of hanging.
    let timer;
    e = await Promise.race([refusal(call({ slug: "pow", params: {} })), new Promise((resolve) => { timer = setTimeout(() => resolve(new Error("no refusal within 10 s: the 60-bit challenge was taken")), 10_000); })]);
    clearTimeout(timer);
    if (e && /no refusal within/.test(e.message)) { ok(false, `${name}: ${e.message}`); process.exit(1); }
    ok(e && /difficulty 60 is refused/.test(e.message) && Date.now() - t0 < 5000, `${name}: a 60-bit challenge is refused without a search (${e?.message})`);
    difficulty = 8;
    ok((await call({ slug: "pow", params: {} }))?.solved === true, `${name}: control: an 8-bit challenge is solved`);
    // The search yields: a timer set before a 16-bit solve fires during it.
    difficulty = 16;
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 1);
    const solved = await call({ slug: "pow", params: {} });
    clearInterval(iv);
    ok(solved?.solved === true && ticks > 0, `${name}: the search yields to the event loop (${ticks} timer ticks during a 16-bit solve)`);
  }
} finally {
  stub.close();
}

console.log(`\ntest-meta-adapter-caps: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
