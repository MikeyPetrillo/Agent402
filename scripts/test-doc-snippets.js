// Every code sample on the developer-docs pages is checked against the real
// API of the package it imports.
//
// Why this exists: the adapter docs (/docs/adapters/*), the integration pages,
// /quickstart and /docs/webhooks shipped samples that could not run. Option
// tables documented `categories` and `agentKey`, which no adapter reads; pages
// imported `openai-agents` and `@strands/agents` (the first an unrelated npm
// package, the second not on npm) and `OpenAIAgent` from llamaindex (not
// exported by 0.12); per-slug examples asked for wallet-only slugs on the
// free tier, where `freeOnly: true` silently drops them; meta-tool adapters
// were destructured as `{ tools, execute }` although they return an array (or,
// for the AI SDK, an object keyed by tool name); the proof-of-work header was
// shown as "<nonce>:<hash>" when the server reads "<token>:<nonce>". Every one
// of those passed every page test, because the page tests read rendered text,
// not what the text tells a developer to type.
//
// This reads the RENDERED pages from a booted server (TARGET_URL), pulls every
// <pre> block, and for each block:
//   1. every import from one of our packages names something that package
//      exports (read from the package's own source, statically: the peers are
//      optional and need not be installed here);
//   2. every import from a third-party package is a package and name we have
//      verified exist (THIRD_PARTY below - a new import must be added there,
//      after it has been checked against the published package);
//   3. agent402Tools({...}) passes only options that adapter destructures, and
//      binds the result in the shape that adapter returns (per-slug adapters
//      return { tools, execute, client }; meta-tool adapters return the tools);
//   4. a per-slug call without `freeOnly: false` names only compute-payable
//      slugs (read from /api/pricing), because the default free filter drops
//      every wallet-only slug without a word;
//   5. new Agent402({...}) passes only constructor options agent402-client has;
//   6. no unresolved {{token}} survives a guide render, and the retired forms
//      (the "<nonce>:<hash>" PoW header, `elizaos plugins add`, a route not in
//      the catalog on a wire diagram) do not come back.
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-doc-snippets.js
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL", m); } };

// ---- our packages: name -> { exports, options, shape } ---------------------
function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(",")) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); }
  if (/^export\s+default\b/m.test(src)) names.add("default");
  return names;
}
const keysOf = (destructure) => destructure.split(",").map((p) => p.trim().split(/[=:]/)[0].trim()).filter(Boolean);
const OURS = new Map();
function addPackage(dir) {
  const pj = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  const main = join(ROOT, dir, pj.main || "index.js");
  if (!existsSync(main)) return;
  const src = readFileSync(main, "utf8");
  const exp = exportsOf(src);
  // A re-exported module's names (export { a } from "./x.js") are covered by
  // the export-brace rule above.
  let options = null, shape = null;
  const perSlug = src.match(/export\s+async\s+function\s+agent402Tools\s*\(\s*\{([^}]*)\}/);
  const specs = src.match(/export\s+function\s+agent402ToolSpecs\s*\(\s*\{([^}]*)\}/);
  if (perSlug) { options = keysOf(perSlug[1]); shape = "per-slug"; }
  else if (specs && /export\s+async\s+function\s+agent402Tools\s*\(\s*opts\s*\)/.test(src)) { options = keysOf(specs[1]); shape = /return\s+out;/.test(src.slice(src.indexOf("function agent402Tools"))) ? "keyed" : "array"; }
  const ctor = src.match(/constructor\s*\(\s*\{([\s\S]*?)\}\s*=\s*\{\}\s*\)/);
  OURS.set(pj.name, { dir, exports: exp, options, shape, specOptions: specs ? keysOf(specs[1]) : null, ctor: ctor ? keysOf(ctor[1].replace(/\s+/g, " ")) : null });
}
for (const d of readdirSync(join(ROOT, "adapters"))) if (existsSync(join(ROOT, "adapters", d, "package.json"))) addPackage(join("adapters", d));
for (const d of ["client", "tollbooth"]) addPackage(d);
ok(OURS.get("agent402-openai-tools")?.shape === "per-slug" && OURS.get("agent402-langchain")?.shape === "array" && OURS.get("agent402-ai-sdk")?.shape === "keyed",
  "control: the source reader classifies per-slug, array and keyed adapters");
ok(OURS.get("agent402-openai-tools").options.join() === "baseUrl,slugs,freeOnly,fetch" && OURS.get("agent402-langchain").options.join() === "baseUrl,fetch,fetchImpl",
  "control: the source reader extracts each adapter's real option names");
ok(OURS.get("agent402-client").ctor?.includes("creditsKey") && !OURS.get("agent402-client").ctor.includes("agentKey"), "control: the Agent402 constructor options are read from source");

// ---- third-party imports verified against the published packages ------------
// name -> the named imports a sample may take from it (checked by installing
// the published package and reading its exports). "*" = default import only.
const THIRD_PARTY = {
  "openai": ["default"],
  "@anthropic-ai/sdk": ["default"],
  "ai": ["generateText", "streamText", "stepCountIs", "tool"],
  "@ai-sdk/openai": ["openai"],
  "@langchain/openai": ["ChatOpenAI"],
  "@langchain/langgraph/prebuilt": ["createReactAgent"],
  "llamaindex": ["tool", "FunctionTool"],
  "@llamaindex/workflow": ["agent"],
  "@llamaindex/openai": ["openai"],
  "@google/adk": ["LlmAgent", "FunctionTool"],
  "@openai/agents": ["Agent", "run", "tool"],
  "@strands-agents/sdk": ["Agent", "tool"],
  "@x402/fetch": ["wrapFetchWithPayment"],
  "@x402/core/client": ["x402Client", "x402HTTPClient"],
  "@x402/core/server": ["HTTPFacilitatorClient", "x402ResourceServer"],
  "@x402/evm/exact/client": ["registerExactEvmScheme"],
  "@x402/evm/exact/server": ["ExactEvmScheme", "registerExactEvmScheme"],
  "@x402/express": ["paymentMiddleware", "x402ResourceServer"],
  "viem/accounts": ["privateKeyToAccount", "generatePrivateKey"],
  "mppx/client": ["Fetch", "evm", "tempo", "Mppx"],
  "express": ["default"],
  "node:crypto": ["createHash", "randomBytes"],
  "@coinbase/agentkit": ["AgentKit", "CdpEvmWalletProvider", "ViemWalletProvider"],
  "@coinbase/cdp-sdk/x402": ["CdpX402Client"],
  "@coinbase/x402": ["createFacilitatorConfig", "facilitator"],
  "zod": ["z"],
};

// ---- pages -------------------------------------------------------------------
// Strip tags until none remain (a single pass can leave a tag formed by what
// it removed), then decode entities, &amp; last.
const stripTags = (s) => { let prev; do { prev = s; s = s.replace(/<[^>]*>/g, ""); } while (s !== prev); return s; };
const decode = (s) => stripTags(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&hellip;/g, "…").replace(/&rarr;/g, "→").replace(/&amp;/g, "&");
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, text: await r.text() }; };
const json = async (p) => (await fetch(BASE + p)).json();

let pricing;
try { pricing = await json("/api/pricing"); } catch (e) { console.log(`FAIL: no server at ${BASE} (${e.message})`); process.exit(1); }
const priced = new Map((pricing.endpoints || []).map((e) => [e.slug, e]));
const openapi = await json("/openapi.json");
const apiPaths = new Set(Object.keys(openapi.paths || {}));
// slug -> the input field names its OpenAPI operation declares
function inputFieldsOf(slug) {
  const e = priced.get(slug);
  if (!e) return null;
  const path = e.path || String(e.route || "").split(" ").pop();
  const op = openapi.paths?.[path]?.[String(e.method || "post").toLowerCase()];
  if (!op) return null;
  const body = op.requestBody?.content?.["application/json"]?.schema?.properties;
  return new Set([...Object.keys(body || {}), ...(op.parameters || []).map((x) => x.name)]);
}

const { INTEGRATIONS } = await import("../src/integration-pages.js");
const { ADAPTERS } = await import("../src/adapter-docs.js");
const { guideSlugs } = await import("../src/guides.js");
const { learnSlugs } = await import("../src/learn.js");
const { BLOG_POSTS } = await import("../src/blog.js");
const pages = [
  "/quickstart", "/integrations", "/docs/adapters", "/docs/webhooks", "/what-is-x402", "/what-is-mpp", "/playground", "/workflows", "/learn",
  ...INTEGRATIONS.map((i) => `/integrations/${i.slug}`),
  ...ADAPTERS.map((a) => `/docs/adapters/${a.slug}`),
  ...guideSlugs().map((s) => `/guides/${s}`),
  ...learnSlugs().map((s) => `/learn/${s}`),
  ...BLOG_POSTS.map((p) => `/blog/${p.slug}`),
];

let blocks = 0, imports = 0, toolCalls = 0;
for (const page of pages) {
  const { status, text } = await get(page);
  ok(status === 200, `${page} answers 200 (got ${status})`);
  if (status !== 200) continue;
  const body = decode(text.replace(/<script[\s\S]*?<\/script>/g, ""));
  ok(!/\{\{(?:price|amount|routerTiers|routingProof)[^}]*\}\}/.test(body), `${page}: no unresolved guide token`);
  ok(!/elizaos plugins add/.test(body), `${page}: no \`elizaos plugins add\` (the community registry is retired)`);
  ok(!/X-Pow-Solution:\s*<nonce>/i.test(body), `${page}: the PoW header is "<token>:<nonce>", never "<nonce>:..."`);
  const pageBound = new Map(); // imports seen earlier on the page carry into later blocks
  for (const m of text.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)) {
    // comment lines are prose, not code
    const code = decode(m[1]).split("\n").filter((l) => !/^\s*(?:\/\/|#)/.test(l)).join("\n");
    blocks++;
    // wire diagrams and curl lines: a catalog route must exist
    for (const r of code.matchAll(/^(?:GET|POST)\s+(\/api\/[A-Za-z0-9/_-]+)/gm)) {
      ok(apiPaths.has(r[1]), `${page}: wire line names ${r[1]}, which is in /openapi.json`);
    }
    // imports
    const bound = new Map(pageBound); // local name -> package
    for (const im of code.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
      const [, def, named, pkg] = im;
      imports++;
      const names = [...(def ? ["default"] : []), ...(named ? named.split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [])];
      const locals = [...(def ? [def] : []), ...(named ? named.split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean) : [])];
      for (const l of locals) { bound.set(l, pkg); pageBound.set(l, pkg); }
      if (OURS.has(pkg)) {
        const { exports } = OURS.get(pkg);
        for (const n of names) ok(exports.has(n), `${page}: ${pkg} exports ${n}`);
      } else {
        const allowed = THIRD_PARTY[pkg];
        ok(!!allowed, `${page}: import from "${pkg}" is a verified package (add it to THIRD_PARTY after checking the published package)`);
        if (allowed) for (const n of names) ok(allowed.includes(n), `${page}: "${pkg}" import { ${n} } is a verified export`);
      }
    }
    // agent402Tools calls
    for (const c of code.matchAll(/(?:const|let)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*await\s+agent402Tools\s*\(/g)) {
      const pkg = bound.get("agent402Tools") || null;
      const info = pkg && OURS.get(pkg);
      if (!info?.options) { ok(false, `${page}: agent402Tools is called without an import from one of our adapter packages in the same block`); continue; }
      toolCalls++;
      const start = c.index + c[0].length;
      let depth = 1, i = start;
      while (i < code.length && depth > 0) { if (code[i] === "(") depth++; else if (code[i] === ")") depth--; i++; }
      const args = code.slice(start, i - 1).trim();
      const keys = [];
      if (args.startsWith("{")) {
        let d = 0, top = "";
        for (const ch of args.slice(1, args.lastIndexOf("}"))) { if ("{[(".includes(ch)) d++; else if ("}])".includes(ch)) d--; else if (d === 0) top += ch; if (d === 0 && ",".includes(ch)) top += ""; }
        for (const k of top.replace(/\/\/[^\n]*/g, "").split(",")) { const name = k.trim().split(":")[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.push(name); }
      }
      for (const k of keys) ok(info.options.includes(k), `${page}: ${pkg} agent402Tools() has option "${k}" (it reads ${info.options.join(", ")})`);
      const binding = c[1];
      if (info.shape === "per-slug") {
        ok(binding.startsWith("{"), `${page}: ${pkg} returns { tools, execute, client } - destructure it`);
        if (binding.startsWith("{")) for (const k of keysOf(binding.slice(1, -1))) ok(["tools", "execute", "client"].includes(k), `${page}: ${pkg} result has "${k}"`);
        const freeOnlyOff = /freeOnly\s*:\s*false/.test(args);
        const slugList = args.match(/slugs\s*:\s*\[([^\]]*)\]/);
        if (!freeOnlyOff && slugList) for (const sl of slugList[1].match(/["']([^"']+)["']/g) || []) {
          const slug = sl.slice(1, -1);
          ok(priced.get(slug)?.computePayable === true, `${page}: "${slug}" must be compute-payable: the free-tier default drops wallet-only slugs (they need freeOnly: false and a paying fetch)`);
        }
      } else {
        ok(!binding.startsWith("{"), `${page}: ${pkg} returns the tools themselves (${info.shape === "keyed" ? "an object keyed by name" : "an array"}), not { tools, execute }`);
      }
    }
    // bare option examples: agent402Tools({ key: ... }) anywhere in the block
    {
      const pkg = bound.get("agent402Tools");
      const info = pkg && OURS.get(pkg);
      if (info?.options) for (const c of code.matchAll(/agent402Tools\s*\(\s*\{([^}]*)\}/g)) {
        for (const k of c[1].split(",").map((x) => x.trim().split(":")[0].trim()).filter((x) => /^[A-Za-z_$][\w$]*$/.test(x))) {
          ok(info.options.includes(k), `${page}: ${pkg} agent402Tools() has option "${k}" (it reads ${info.options.join(", ")})`);
        }
      }
    }
    // agent402ToolSpecs({ key: ... }) on the meta-tool adapters
    {
      const pkg = bound.get("agent402ToolSpecs");
      const info = pkg && OURS.get(pkg);
      if (bound.has("agent402ToolSpecs")) ok(!!info?.specOptions, `${page}: ${pkg} exports agent402ToolSpecs`);
      if (info?.specOptions) for (const c of code.matchAll(/agent402ToolSpecs\s*\(\s*\{([^}]*)\}/g)) {
        for (const k of c[1].split(",").map((x) => x.trim().split(":")[0].trim()).filter((x) => /^[A-Za-z_$][\w$]*$/.test(x))) {
          ok(info.specOptions.includes(k), `${page}: ${pkg} agent402ToolSpecs() has option "${k}"`);
        }
      }
    }
    // client.call("slug", { field: ... }): the slug exists and takes those fields
    if ([...bound.values()].includes("agent402-client")) {
      for (const c of code.matchAll(/\.call\(\s*"([a-z0-9-]+)"\s*,\s*\{([^}]*)\}/g)) {
        const fields = inputFieldsOf(c[1]);
        ok(!!fields, `${page}: .call("${c[1]}") names a priced catalog tool`);
        if (fields) for (const k of c[2].split(",").map((x) => x.trim().split(":")[0].trim()).filter((x) => /^[A-Za-z_$][\w$]*$/.test(x))) {
          ok(fields.has(k), `${page}: ${c[1]} takes "${k}" (it declares ${[...fields].filter((f) => f !== "Idempotency-Key").join(", ")})`);
        }
      }
    }
    // new Agent402({...})
    if ([...bound.values()].includes("agent402-client")) {
      for (const c of code.matchAll(/new\s+Agent402\s*\(\s*\{([^}]*)\}/g)) {
        for (const k of keysOf(c[1].replace(/\/\/[^\n]*/g, ""))) ok(OURS.get("agent402-client").ctor.includes(k), `${page}: new Agent402() has option "${k}"`);
      }
    }
  }
}
// /workflows: each card's cost is the sum of its steps' list prices, and
// "free via proof-of-work" only when every step is compute-payable.
{
  const html = (await get("/workflows")).text;
  const cards = [...html.matchAll(/<div class="wf-card">([\s\S]*?)<p class="wf-cost">[\s\S]*?<span class="wf-price">([^<]*)<\/span>/g)];
  ok(cards.length >= 4, `/workflows renders its cards (${cards.length})`);
  for (const [, card, label] of cards) {
    const slugs = [...card.matchAll(/class="wf-step-name">([^<]+)</g)].map((m) => m[1]);
    const rows = slugs.map((sl) => priced.get(sl)).filter(Boolean);
    ok(rows.length === slugs.length, `/workflows: every step (${slugs.join(", ")}) is a priced catalog tool`);
    const micro = rows.reduce((n, e) => n + Math.round(Number(String(e.price).replace(/[^0-9.]/g, "")) * 1e6), 0);
    const free = rows.every((e) => e.computePayable === true);
    if (free) ok(/free via proof-of-work/.test(label), `/workflows: an all-free chain says so (${slugs.join(", ")})`);
    else ok(Math.round(Number(label.replace(/[^0-9.]/g, "")) * 1e6) === micro && !/free/i.test(label), `/workflows: "${label}" equals the steps' summed list price $${micro / 1e6} (${slugs.join(", ")})`);
  }
}
// /playground runs catalog tools only; it has no /v1 gateway client.
ok(!/\/v1\b/.test(decode((await get("/playground")).text.replace(/<script[\s\S]*?<\/script>/g, ""))), "/playground does not offer the /v1 gateway it cannot call");
ok(blocks > 50 && imports > 30 && toolCalls >= 12, `the sweep measured something (${blocks} blocks, ${imports} imports, ${toolCalls} agent402Tools calls)`);

// The checker must catch the defects it was written for (a planted control,
// run through the same functions as the pages).
const planted = OURS.get("agent402-langchain");
ok(!planted.options.includes("categories") && !planted.options.includes("agentKey"), "control: categories/agentKey are not adapter options");
ok(!THIRD_PARTY["openai-agents"] && !THIRD_PARTY["@strands/agents"] && !THIRD_PARTY.llamaindex.includes("OpenAIAgent"), "control: the wrong package names stay unverified");
ok(priced.get("extract")?.computePayable === false, "control: extract is wallet-only, so a free-tier sample naming it fails");
ok(inputFieldsOf("extract")?.has("url") && !inputFieldsOf("extract").has("html"), "control: extract takes url, not html, so the old chaining sample fails");

console.log(`test-doc-snippets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
