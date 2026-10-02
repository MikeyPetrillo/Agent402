// Read our own agent-facing text back to us and check it against what the
// server actually offers.
//
// WHY THIS EXISTS. Issue #705 was reported by an outside agent, and it was the
// THIRD instance of one defect: a tool with a working CallTool handler that was
// never added to tools/list. The first two (about_agent402, top_x402_sellers)
// were found and fixed by hand, with a comment in src/mcp-http.js noting that
// tools/list is the only discovery surface a client has - and no test was
// written, so the class stayed open and the third instance shipped. Worse, the
// unlisted tool was request_tool, which about_agent402's own missingATool field
// tells agents to call. Our published text instructed agents to do something
// our published capabilities made impossible, and every existing test passed,
// because every existing test drives the connector the way WE intend it to be
// used: they call the tools they know the names of.
//
// So this checks the thing no functional test can: INTERNAL CONSISTENCY. Does
// the text an agent reads name only tools that exist and routes that are
// registered? A defect here is invisible to a passing suite and obvious to any
// stranger who reads two of our surfaces side by side.
//
// Offline apart from the local server: static-reads the source for the handler
// branches and the route table, and reads the live tools/list + the free
// meta-tool payloads. Run against a booted free-mode server:
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-mcp-self-consistency.js
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = process.env.TARGET_URL || "http://127.0.0.1:3000";

// Every read of the live target goes through ONE retry (the heartbeat's
// single-retry doctrine, 20 s). Measured 2026-08-25 (#939): the 30-min cron
// landed inside a production deploy; Railway's edge answered /api/pricing
// with a parseable JSON error body, `endpoints` came back empty, and the run
// graded every /api route in the manifest as unregistered - a drift page for
// a healthy service. A thrown error here (no "assertions passed" line) makes
// the workflow SKIP; an unreachable prod is the heartbeat's alarm, not this one.
const RETRY_MS = Number(process.env.SELF_CONSISTENCY_RETRY_MS || 20_000);
async function fetchLive(path, init) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${TARGET}${path}`, init);
      if (res.status < 500) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) { last = e; }
    if (attempt === 1) await new Promise((r) => setTimeout(r, RETRY_MS));
  }
  throw new Error(`target unreachable after retry: ${path} (${last?.message || last}) - a deploy in progress or prod down; not a consistency failure`);
}
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let passed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`ok - ${msg}`); return; }
  failures.push(msg);
  console.log(`FAIL - ${msg}`);
}

let nextId = 1;
async function rpc(method, params) {
  const res = await fetchLive("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const ct = (res.headers.get("content-type") || "").split(";")[0];
  const body = ct === "text/event-stream"
    ? JSON.parse((await res.text()).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""))
    : await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

// ---------------------------------------------------------------- extractors
//
// Each extractor is proven against a planted control below before any clean
// result is believed. An extractor that silently matches nothing would report
// perfect consistency forever - the same way the free-tier egress probe once
// reported a clean run while blind.

// "Call request_tool", "run catalog.search", "the find_tool tool", `web.search`
// in backticks. Accepts snake_case AND Smithery dotted names (domain.action).
const TOOL_NAME = "[a-z][a-z0-9]*(?:[._][a-z0-9]+)+";
function referencedToolNames(text) {
  const out = new Set();
  const patterns = [
    new RegExp(`\\b(?:call|calls|calling|run|runs|running|invoke|use)\\s+\`?(${TOOL_NAME})\`?`, "gi"),
    new RegExp(`\`(${TOOL_NAME})\`\\s+tool\\b`, "gi"),
    new RegExp(`\\b(${TOOL_NAME})\\s+tool\\b`, "gi"),
    new RegExp(`\\bname:\\s*['"](${TOOL_NAME})['"]`, "gi"),
    // The service manifest advertises capabilities as mcpTool: "x". This is the
    // exact field that promised top_x402_sellers while tools/list did not offer
    // it - a third-party integrator reads the manifest, not our source.
    new RegExp(`"?mcpTool"?:\\s*['"](${TOOL_NAME})['"]`, "gi"),
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.add(m[1]);
  return out;
}

// call_tool { slug: 'unit-convert' } / "slug: \"x\"" - a slug named in prose
// must be a real catalog entry, or the worked example we hand an agent is dead.
function referencedSlugs(text) {
  const out = new Set();
  for (const m of text.matchAll(/\bslug:\s*['"]([a-z0-9][a-z0-9-]*)['"]/gi)) out.add(m[1]);
  return out;
}

// Absolute URLs on our own host, plus bare paths.
//
// Bare paths are restricted to the families we unambiguously own. /.well-known
// is deliberately NOT among them: it is a shared standard namespace, and our
// own tool descriptions legitimately name OTHER sites' well-known paths (the
// A2A card fetcher documents /.well-known/agent-card.json on the site it is
// pointed at, not on us). Our own well-known routes still get checked whenever
// they appear as a full URL.
//
// A dot ends a path unless it begins a real file extension, so prose like
// "/api/extract.body" yields /api/extract rather than a route that never was.
const PATH_FAMILIES = "api|v1|mcp|tools|skills";
const EXT = "txt|json|xml|html|md|ico|csv|yaml|js";
function referencedPaths(text, baseUrl) {
  const out = new Set();
  const add = (p) => {
    let clean = String(p).split(/[?#]/)[0].replace(/[.,)\]]+$/, "");
    const dot = clean.indexOf(".");
    if (dot > 0 && !new RegExp(`\\.(?:${EXT})$`, "i").test(clean)) clean = clean.slice(0, dot);
    clean = clean.replace(/\/$/, "");
    if (clean && clean.startsWith("/")) out.add(clean);
  };
  const host = baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of text.matchAll(new RegExp(`https?://${esc}(/[\\w\\-./:*{}]*)`, "gi"))) add(m[1]);
  for (const m of text.matchAll(new RegExp(`(?:^|[\\s(\`"'])(/(?:${PATH_FAMILIES})[\\w\\-./:*]*)`, "gi"))) add(m[1]);
  return out;
}

// ------------------------------------------------------- the server's truths
// Handler branches in the CallTool dispatch, grouped PER BRANCH rather than per
// name, because a branch may answer to more than one name: `get_payment_info ||
// payment_info` keeps a legacy alias reachable on purpose. The rule is that
// every branch must be reachable under at least one advertised name - an alias
// nobody advertises is fine, a whole capability nobody advertises is #705.
const mcpSource = readFileSync(join(SRC, "mcp-http.js"), "utf8");
const handlerBranches = [...mcpSource.matchAll(/^\s*if \(.*$/gm)]
  .map((m) => [...m[0].matchAll(/name === "([a-z0-9_.]+)"/g)].map((x) => x[1]))
  .filter((names) => names.length);
// Any name the dispatch mentions at all, including the negative guard that lets
// catalog.call through to the generic slug path (`name !== "catalog.call"`).
const handledNames = new Set([...mcpSource.matchAll(/\bname\s*[!=]==\s*"([a-z0-9_.]+)"/g)].map((m) => m[1]));

// Flagship catalog tools are listed under an MCP name that is NOT always the
// slug with dashes swapped for underscores - FLAGSHIP_MCP_NAMES in
// mcp-flagship.js renames them to Smithery dotted form (search is listed as
// web.search). Reversing that map is what lets the "advertised but
// unimplemented" check resolve a listed name back to a real catalog entry.
const flagshipSource = readFileSync(join(SRC, "mcp-flagship.js"), "utf8");
const overrideBlock = flagshipSource.match(/FLAGSHIP_MCP_NAMES\s*=\s*\{([\s\S]*?)\n\};/);
const slugForMcpName = new Map();
// Keys are quoted only when the slug contains a dash ("search-news"), bare
// otherwise (search, answer, render) - both forms are real entries.
for (const m of (overrideBlock?.[1] ?? "").matchAll(/(?:"([^"]+)"|([a-z0-9-]+)):\s*"([^"]+)"/g)) {
  slugForMcpName.set(m[3], m[1] ?? m[2]);
}
if (slugForMcpName.size === 0) throw new Error("could not parse FLAGSHIP_MCP_NAMES - the rename table moved, and this check would silently pass without it");
assert(slugForMcpName.get("web.search") === "search", "FLAGSHIP_MCP_NAMES maps web.search → search");
assert(slugForMcpName.get("web.answer") === "answer", "FLAGSHIP_MCP_NAMES maps web.answer → answer");

// Registered express routes, read from the source rather than probed, because
// probing cannot distinguish "route does not exist" from "route exists but is
// POST-only" - exactly the ambiguity the #705 reporter correctly refused to
// resolve from a GET 404.
const routePaths = new Set();
const mountPrefixes = new Set();
for (const file of readdirSync(SRC).filter((f) => f.endsWith(".js"))) {
  const text = readFileSync(join(SRC, file), "utf8");
  for (const m of text.matchAll(/\bapp\.(get|post|put|patch|delete|all|use)\(\s*"([^"]+)"/g)) {
    if (m[1] === "use") mountPrefixes.add(m[2].replace(/\/$/, ""));
    else routePaths.add(m[2].replace(/\/$/, ""));
  }
}

const segs = (p) => p.split("/").filter(Boolean);
// Segment-aware matching. "/v1" legitimately stands for the whole gateway
// family and matches /v1/nano/chat/completions; "/api/wish" must NOT be
// satisfied by "/api/wishes", which is the singular-vs-plural confusion that
// makes this check worth having at all.
function staticRouteExists(ref) {
  const r = segs(ref);
  const covers = (route) => {
    const c = segs(route);
    if (c.length < r.length) return false;
    for (let i = 0; i < r.length; i++) {
      const want = r[i], got = c[i];
      if (got.startsWith(":") || got.includes("*") || want === "*") continue;
      if (want !== got) return false;
    }
    return true;
  };
  if ([...routePaths].some(covers)) return true;
  if ([...mountPrefixes].some((p) => p && p !== "/" && covers(p))) return true;
  // Catalog tool routes come from the live server, not the source. A proper
  // PREFIX of one counts too - our own copy legitimately tells SDK users to
  // point base_url at /v1/nano (or /v1/pro, /v1/premium, /v1/auto) and let
  // the SDK append /chat/completions, /messages or /responses (2026-08-19:
  // issue #837 read those base_url prefixes as four missing routes).
  return catalogRoutes.has(ref) || [...catalogRoutes].some(covers);
}

// TWO INDEPENDENT ORACLES, and a path is only reported missing when BOTH say
// no. The source scan cannot see routes registered through a template literal
// (the per-chain market pages are `app.get(\`/${chainKey}\`)` over a local map),
// and a live GET cannot distinguish "no such route" from "route exists but is
// POST-only" - the ambiguity the #705 reporter correctly refused to resolve
// from a GET 404. Each oracle covers the other's blind spot.
//
// The live probe is a LAST resort and never touches /api or /v1: in FREE_MODE
// those handlers execute, and a consistency check has no business calling a
// tool that spends money or reaches a third party. Those two families are also
// exactly where the source scan is strongest, so nothing is lost.
const probeCache = new Map();
async function routeExists(ref) {
  if (staticRouteExists(ref)) return true;
  const family = segs(ref)[0];
  if (family === "api" || family === "v1") return false;
  if (probeCache.has(ref)) return probeCache.get(ref);
  let live = false;
  try {
    const res = await fetchLive(ref, { redirect: "manual" });
    live = res.status !== 404;
  } catch { live = false; }
  probeCache.set(ref, live);
  return live;
}

const pricing = await fetchLive("/api/pricing").then((r) => r.json());
// Catalog floor (the same 400 sync-count enforces): grading against a thin or
// empty catalog would fail every route the manifest names, so refuse instead.
if (!Array.isArray(pricing.endpoints) || pricing.endpoints.length < 400) {
  throw new Error(`/api/pricing carried ${Array.isArray(pricing.endpoints) ? pricing.endpoints.length : "no"} endpoints (floor 400) - the target answered with something other than the catalog; refusing to grade`);
}
const catalogRoutes = new Set((pricing.endpoints || []).map((e) => String(e.path).replace(/\/$/, "")));
const catalogSlugs = new Set((pricing.endpoints || []).map((e) => e.slug).filter(Boolean));

const listed = await rpc("tools/list", {});
const listedNames = new Set((listed.tools || []).map((t) => t.name));

// snake_case words that appear in a call-this position in our own copy but are
// NOT callable tools of ours. Each entry is a claim that an agent reading this
// word will not try to call it. Keep it short and specific: this list is the
// only escape hatch, and a long one turns the check back into the heuristic it
// replaced.
const NOT_A_TOOL = new Set([
  // Tools on the STDIO npm package (agent402-mcp), named in our copy as the
  // wallet-holding alternative to this authless connector. Real, just not here.
  "route_and_execute",
]);

// ------------------------------------------------------------- probe control
// Prove the extractors can see a defect before trusting them to report none.
const CONTROL = 'Call totally_fake_tool to continue, or POST https://example.test/api/not-a-real-route with slug: "no-such-slug-here". "mcpTool": "another_fake_tool"';
assert(referencedToolNames(CONTROL).has("totally_fake_tool"), "control: the tool-name extractor sees a planted tool reference");
assert(referencedToolNames(CONTROL).has("another_fake_tool"), "control: the tool-name extractor sees a planted manifest mcpTool reference");
assert(referencedSlugs(CONTROL).has("no-such-slug-here"), "control: the slug extractor sees a planted slug reference");
assert(referencedPaths(CONTROL, "https://example.test").has("/api/not-a-real-route"), "control: the path extractor sees a planted path reference");
assert(!(await routeExists("/api/not-a-real-route")), "control: an unregistered route is reported missing");
assert(await routeExists("/api/wishes"), "control: /api/wishes is found in the route table");
assert(await routeExists("/api/wish"), "control: the POST-only /api/wish is found in the route table (a GET 404 must not read as absent)");
assert(!(await routeExists("/api/wishe")), "control: a near-miss path is NOT satisfied by a longer sibling route");
assert(await routeExists("/base"), "control: a template-literal route the source scan cannot see is confirmed by the live probe");

// --------------------------------------------- 1. handler / listing parity
// The #705 class, in the direction that bit us: implemented but undiscoverable.
// A tool an agent cannot see may as well not exist, and our own text was
// telling agents to call one.
// A branch whose tool is listed only when its feature is configured is checked
// only on a server where that feature is on (decide.feedback needs the decide
// service; its paid siblings are absent from the catalog without it).
const decidePricing = await (await fetch(`${TARGET}/api/pricing`)).json().catch(() => ({}));
const decideLive = JSON.stringify(decidePricing).includes("/api/decide");
const FEATURE_GATED = new Map([["decide.feedback", decideLive]]);
for (const names of handlerBranches) {
  if (names.every((n) => FEATURE_GATED.has(n) && !FEATURE_GATED.get(n))) { console.log(`skip - [${names.join(", ")}] is feature-gated and the feature is off on this server`); continue; }
  assert(
    names.some((n) => listedNames.has(n)),
    `CallTool branch [${names.join(", ")}] is reachable under an advertised name (a capability no client can discover is dead code)`,
  );
}
// The mirror: advertised but unimplemented. Nothing hits this today; it is the
// failure an agent experiences as a broken promise rather than a missing one.
for (const name of [...listedNames].sort()) {
  const slug = slugForMcpName.get(name) || name.replace(/_/g, "-");
  assert(
    handledNames.has(name) || catalogSlugs.has(slug),
    `listed tool "${name}" resolves to a handler or a real catalog slug (${slug})`,
  );
}

// ------------------------------------------------- 2. the text agents read
// Every free, self-describing surface: the tool list itself, plus the payloads
// of the meta-tools whose entire job is to orient an agent.
const about = await rpc("tools/call", { name: "server.describe", arguments: {} });
const payment = await rpc("tools/call", { name: "get_payment_info", arguments: {} });
const textOf = (r) => (r.content || []).map((c) => c.text || "").join("\n");
const llms = await fetchLive("/llms.txt").then((r) => r.text());
const manifest = await fetchLive("/.well-known/x402").then((r) => r.text());
const init = await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "test-mcp-self-consistency", version: "0.0.0" },
});
assert(
  typeof init.instructions === "string" && init.instructions.length > 40,
  "initialize.instructions is populated (clients that never call server.describe still get oriented)",
);

const surfaces = [
  ["tools/list", (listed.tools || []).map((t) => `${t.title}\n${t.description}`).join("\n\n")],
  ["server.describe", textOf(about)],
  ["get_payment_info", textOf(payment)],
  ["initialize.instructions", init.instructions || ""],
  ["/llms.txt", llms],
  ["/.well-known/x402", manifest],
];

// A tool name we tell an agent to call must be one it can discover. This is the
// assertion that fails on #705: about_agent402 said "Call request_tool" while
// tools/list did not contain it.
for (const [surface, text] of surfaces) {
  for (const name of [...referencedToolNames(text)].sort()) {
    // NO "does this look like one of our tools?" filter here. The first draft
    // had one, and it skipped any snake_case name that was neither listed nor
    // handled - which is exactly the defect being hunted. Planting
    // "Call submit_wish" in about_agent402 passed a green run. An unknown name
    // in a call-this position is the FINDING, not noise to be filtered out.
    //
    // Prose that legitimately contains snake_case non-tools (protocol field
    // names like max_tokens) goes in NOT_A_TOOL, one line per word, so adding
    // one is a deliberate statement that it is not callable.
    if (NOT_A_TOOL.has(name)) continue;
    assert(listedNames.has(name), `${surface} names tool "${name}" in a call-this position, but tools/list does not offer it`);
  }
  for (const slug of [...referencedSlugs(text)].sort()) {
    assert(catalogSlugs.has(slug), `${surface} names catalog slug "${slug}", which exists`);
  }
  for (const path of [...referencedPaths(text, TARGET)].sort()) {
    assert(await routeExists(path), `${surface} names route "${path}", which is registered`);
  }
}

console.log(`\n${passed} assertions passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
