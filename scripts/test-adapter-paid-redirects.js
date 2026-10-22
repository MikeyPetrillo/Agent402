// Paid calls in the zero-dependency adapters and the OpenClaw proxy never
// follow a redirect. Followed, a redirect would pay another origin's 402 or
// carry a signature (or a credits key) to another host, and that host's answer
// would come back as the tool's. Two loopback origins: the seller redirects
// every paid request to the other origin, which counts what reaches it. The
// payment fetch here is plain fetch: what is proven is that the request the
// payment fetch is handed says not to follow redirects, and that the redirect
// is refused. The controls: the same adapters pay a route that does not
// redirect, and the proxy relays one.
import { createServer } from "node:http";
import { agent402ToolSpecs as langchainSpecs } from "../adapters/langchain/index.js";
import { agent402ToolSpecs as aiSdkSpecs } from "../adapters/ai-sdk/index.js";
import { agent402ToolSpecs as googleAdkSpecs } from "../adapters/google-adk/index.js";
import { agent402ToolSpecs as openaiAgentsSpecs } from "../adapters/openai-agents/index.js";
import { startProxy } from "../openclaw/proxy.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.log(`FAIL - ${msg}`); } };
const listen = (handler) => new Promise((res) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => res(s)); });
const reply = (res, status, obj, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };

const elsewhereSeen = { requests: 0 };
const elsewhere = await listen((req, res) => { req.resume(); elsewhereSeen.requests++; reply(res, 200, { from: "elsewhere", choices: [{ message: { role: "assistant", content: "elsewhere" } }] }); });
const OTHER = `http://127.0.0.1:${elsewhere.address().port}`;

const seller = await listen((req, res) => {
  req.resume();
  const path = req.url.split("?")[0];
  if (path === "/api/pricing") return reply(res, 200, { endpoints: [
    { slug: "moved", method: "POST", path: "/api/moved", computePayable: false, price: "$0.001" },
    { slug: "here", method: "POST", path: "/api/here", computePayable: false, price: "$0.001" },
  ] });
  if (path === "/v1/models") return reply(res, 200, { data: [
    { id: "a/moved", object: "model", x402: { tier: "v1-chat", endpoint: "/v1/moved/chat/completions", priceUsd: 0.02, maxTokens: 2048, maxInputChars: 200_000 } },
    { id: "a/here", object: "model", x402: { tier: "v1-chat", endpoint: "/v1/here/chat/completions", priceUsd: 0.02, maxTokens: 2048, maxInputChars: 200_000 } },
  ] });
  if (path === "/api/here" || path === "/v1/here/chat/completions") return reply(res, 200, { from: "seller", id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "seller" }, finish_reason: "stop" }] });
  res.writeHead(307, { location: `${OTHER}${req.url}` });
  res.end();
});
const SELLER = `http://127.0.0.1:${seller.address().port}`;

try {
  for (const [name, specsOf] of [["langchain", langchainSpecs], ["ai-sdk", aiSdkSpecs], ["google-adk", googleAdkSpecs], ["openai-agents", openaiAgentsSpecs]]) {
    const call = specsOf({ baseUrl: SELLER, fetch: (url, init) => fetch(url, init) }).find((s) => s.name === "agent402_call");
    const here = await call.execute({ slug: "here", params: { q: 1 } });
    ok(here?.from === "seller", `${name}: control, a paid route that does not redirect answers`);
    const before = elsewhereSeen.requests;
    let e = null; try { await call.execute({ slug: "moved", params: { q: 1 } }); } catch (err) { e = err; }
    ok(e && /never follow redirects/.test(e.message) && e.message.includes(`${OTHER}/api/moved`), `${name}: a redirected paid call is refused, naming where it pointed (${e?.message})`);
    ok(elsewhereSeen.requests === before, `${name}: the other origin got no request`);
  }

  for (const [mode, opts] of [["credits", { creditsKey: "a402_testkey0000000000000000" }], ["x402", { payFetch: (url, init) => fetch(url, init) }]]) {
    const p = await startProxy({ upstream: SELLER, port: 0, ...opts });
    try {
      const ask = (model) => fetch(`${p.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) });
      const here = await ask("a/here");
      ok(here.status === 200 && (await here.json()).from === "seller", `openclaw ${mode}: control, a route that does not redirect is relayed`);
      const before = elsewhereSeen.requests;
      const moved = await ask("a/moved");
      const body = await moved.json();
      ok(moved.status === 502 && body.error?.type === "upstream_redirect_refused" && body.error.message.includes(OTHER), `openclaw ${mode}: a redirected paid call is refused with where it pointed (${moved.status} ${JSON.stringify(body).slice(0, 200)})`);
      ok(elsewhereSeen.requests === before, `openclaw ${mode}: the other origin got no request`);
      // The Anthropic wire refuses the same redirect in its own error shape.
      const msg = await fetch(`${p.baseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) });
      const mb = await msg.json();
      ok(msg.status === 502 && mb.type === "error" && mb.error?.type === "upstream_redirect_refused" && mb.error.message.includes(OTHER) && Object.keys(mb).sort().join() === "error,type",
        `openclaw ${mode}: a redirected Messages call is refused in the Anthropic error shape (${msg.status} ${JSON.stringify(mb).slice(0, 200)})`);
      ok(elsewhereSeen.requests === before, `openclaw ${mode}: the other origin got no Messages request`);
    } finally { await p.close(); }
  }
} finally { seller.close(); elsewhere.close(); }

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
