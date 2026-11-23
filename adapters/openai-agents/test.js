// Smoke test for agent402-openai-agents. Expects a FREE_MODE server reachable
// at AGENT402_BASE_URL (defaults to http://localhost:3000). Tests the
// framework-agnostic spec path only — the @openai/agents-native wrapper is
// verified by the peerDeps install path in consumers' projects.
import { agent402ToolSpecs } from "./index.js";

const BASE = process.env.AGENT402_BASE_URL || "http://localhost:3000";
let pass = 0;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

// 0. Offline: a failed call carries the server's own answer. The error's
// message names the server's `error` text, and `.status` and `.body` hold the
// status and the parsed body, on a discovery read, a paid call and a
// proof-of-work call.
{
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const pricing = { endpoints: [
    { slug: "whois", path: "/api/whois", method: "POST", price: "$0.001", computePayable: false },
    { slug: "hash", path: "/api/hash", method: "POST", price: "$0.001", computePayable: true },
  ] };
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/pricing") return json(200, pricing);
    if (u.pathname === "/api/find") return json(500, { error: "the catalog index is rebuilding" });
    if (u.pathname === "/api/pow/challenge") return json(200, { challenge: "c", difficulty: 0, token: "t" });
    if (u.pathname === "/api/hash") return json(400, { error: "Missing required parameter: text" });
    return json(404, {});
  };
  const payFetch = async () => json(503, { error: "Lookups to this registry reached this service's daily limit", retryAfterSeconds: 60 });
  const offline = Object.fromEntries(agent402ToolSpecs({ baseUrl: "https://stub.test", fetchImpl, fetch: payFetch }).map((s) => [s.name, s]));
  const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
  const d = await errOf(offline.agent402_find.execute({ task: "x" }));
  ok(d && /the catalog index is rebuilding/.test(d.message) && d.status === 500 && d.body?.error === "the catalog index is rebuilding", `a discovery error carries the server's answer (${d?.message})`);
  const p = await errOf(offline.agent402_call.execute({ slug: "whois", params: { domain: "example.com" } }));
  ok(p && /daily limit/.test(p.message) && p.status === 503 && p.body?.retryAfterSeconds === 60, `a paid call's error carries the server's answer (${p?.message})`);
  const w = await errOf(offline.agent402_call.execute({ slug: "hash", params: {} }));
  ok(w && /Missing required parameter: text/.test(w.message) && w.status === 400 && w.body?.error, `a proof-of-work call's error carries the server's answer (${w?.message})`);
}

const specs = agent402ToolSpecs({ baseUrl: BASE });

// 1. Four meta tools, all with the expected fields.
ok(specs.length === 4, `4 specs returned (got ${specs.length})`);
for (const s of specs) {
  ok(typeof s.name === "string" && s.name.startsWith("agent402_"), `spec "${s.name}" has agent402_ prefix`);
  ok(typeof s.description === "string" && s.description.length > 20, `spec "${s.name}" has description`);
  ok(s.parametersJsonSchema?.type === "object", `spec "${s.name}" has object parametersJsonSchema`);
  ok(typeof s.execute === "function", `spec "${s.name}" has execute()`);
}

const byName = Object.fromEntries(specs.map((s) => [s.name, s]));

// 2. agent402_about returns the service manifest.
const about = await byName.agent402_about.execute({});
ok(about?.spec === "agent402-service-manifest/1", `agent402_about returns the service manifest (got spec=${about?.spec})`);
ok(about?.discovery?.spec === "x402-discovery/1", `manifest exposes the x402-discovery surface`);

// 3. agent402_find resolves a task to a real slug.
const find = await byName.agent402_find.execute({ task: "hash text with sha256", limit: 3 });
ok(Array.isArray(find?.results) && find.results.some((r) => r.slug === "hash"), `agent402_find returns the hash tool`);

// 4. agent402_route honors include=local + echoes the parameter.
const route = await byName.agent402_route.execute({ query: "hash", top: 3, include: "local" });
ok(route?.include === "local", `agent402_route echoes include=local`);
ok(route?.results?.length > 0 && route.results.every((r) => r.seller === "self"), `include=local returns only self`);

// 5. agent402_route default include is "all".
const routeDefault = await byName.agent402_route.execute({ query: "hash", top: 3 });
ok(routeDefault?.include === "all", `agent402_route default include is "all"`);

// 6. agent402_call executes a real local tool end-to-end.
const call = await byName.agent402_call.execute({ slug: "hash", params: { text: "hello world", algo: "sha256" } });
ok(call?.hex?.startsWith("b94d27b9"), `agent402_call returns the hash result (got ${call?.hex?.slice(0, 8)})`);

console.log(`PASS — agent402-openai-agents: ${pass} assertions passed against ${BASE}`);
