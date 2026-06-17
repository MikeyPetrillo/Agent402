// Smoke test for agent402-langchain. Expects a FREE_MODE server reachable at
// AGENT402_BASE_URL (defaults to http://localhost:3000). Tests the framework-
// agnostic spec path only — the LangChain-native wrapper is verified by the
// peerDeps install path in consumers' projects.
import { agent402ToolSpecs } from "./index.js";

const BASE = process.env.AGENT402_BASE_URL || "http://localhost:3000";
let pass = 0;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

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

console.log(`PASS — agent402-langchain: ${pass} assertions passed against ${BASE}`);
