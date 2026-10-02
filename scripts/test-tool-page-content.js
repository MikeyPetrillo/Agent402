// Tool pages (/tools/<slug>) are built from the tool's own def: summary,
// parameters table, example request and response, MCP usage, errors and
// behavior, related tools and a breadcrumb. This pins:
//
//   1. Example strings are HTML-escaped wherever they are rendered. A tool
//      whose example contains `<a href="x">` or `<h1>` once rendered a live
//      link and extra headings (html-entities, html-select, html-strip ...).
//   2. Every catalog tool page has one <h1>, a title of at most 60 characters,
//      a meta description of 120-155 characters, and a meta description no
//      other tool page shares.
//   3. The sections exist on sample pages and carry that tool's own data.
//
//   node scripts/test-tool-page-content.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { toolPage, toolTitle, toolMetaDescription, relatedTools, powSnippetRequest } from "../src/pages.js";
// Remove every tag, repeating until none remain (one pass can leave a tag
// formed by the text it removed).
function stripTags(s) { let prev; do { prev = s; s = s.replace(/<[^>]*>/g, ""); } while (s !== prev); return s; }


const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let proc = null;
const fail = (m) => { console.error("FAIL:", m); if (proc) proc.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; if (process.env.VERBOSE) console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const mainOf = (html) => (html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || [, html])[1];
const titleOf = (html) => decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || "");
const descOf = (html) => decode((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "");
const h1Count = (html) => (html.match(/<h1\b/gi) || []).length;

// ---- 1. Offline: a hostile def renders inert. ----
const hostile = {
  route: "POST /api/fake-html", method: "POST", path: "/api/fake-html", slug: "fake-html", name: "Fake <h1>HTML</h1> tool",
  category: "text", price: "$0.001", tags: ["html"],
  description: 'Parses <a href="x">links</a> and <h1>headings</h1>. Second sentence.',
  discovery: {
    inputSchema: { type: "object", properties: { html: { type: "string", description: 'HTML such as <h1>Hi</h1> or <a href="x">' } }, required: ["html"] },
    input: { html: '<h1>Title</h1><a href="x">link</a>' },
    output: { example: { markdown: "# Title", links: ['<a href="x">'], raw: "<h1>Title</h1>" } },
  },
};
for (const computePayable of [true, false]) {
  const html = toolPage("https://example.test", hostile, [], { computePayable, powDifficulty: 16 });
  ok(h1Count(html) === 1, `hostile def (pow=${computePayable}): exactly one <h1>`);
  ok(!/<a href="x"/.test(html) && !/<a href=\\"x\\"/.test(html), `hostile def (pow=${computePayable}): no live <a href="x"> from the example`);
  ok(!/<h1>(Title|headings|Hi|HTML)/.test(html), `hostile def (pow=${computePayable}): example <h1> text is escaped`);
  ok(html.includes("&lt;h1&gt;Title&lt;/h1&gt;"), `hostile def (pow=${computePayable}): example rendered as escaped text`);
}
ok(toolTitle({ name: "A very long tool name that goes on (with a parenthetical) and on and on", price: "$0.001" }).length <= 60, "toolTitle trims long names to 60");
ok(toolTitle({ name: "Hash", price: "$0.001" }) === "Hash API - $0.001/call | Agent402", "toolTitle keeps the short form");
ok(/\$0\.002\/call/.test(toolTitle({ name: "An extremely long name for a tool that will not fit anywhere at all", price: "$0.002" })), "toolTitle never drops the price");
{
  const d = toolMetaDescription({ ...hostile, description: "Convert JSON to YAML." }, { computePayable: true });
  ok(d.length >= 120 && d.length <= 155, `short description padded into range (${d.length})`);
}
{
  const tools = [hostile, { ...hostile, slug: "b", tags: ["html"], category: "web" }, { ...hostile, slug: "c", tags: [], category: "math" }];
  const rel = relatedTools(hostile, tools);
  ok(rel.length === 1 && rel[0].slug === "b", "relatedTools keeps category/tag matches and drops unrelated tools");
}

// ---- 1b. Offline: the "Errors and behavior" sentences are true per tool. ----
// Each of these once stated the same thing on every page, true for most tools
// and false for some: settlement on failure (a Tempo push credential settles
// before the tool runs), the method alias (not on a path with both methods),
// the idempotent replay (not for raw bytes), the free-tier and wallet-only
// reasons, and the JSON field table on a tool that answers raw bytes.
{
  const factsOf = (html) => decode(stripTags((html.match(/<ul class="tp-facts">([\s\S]*?)<\/ul>/) || [])[1] || ""));
  const plain = { ...hostile, slug: "plain", method: "GET", path: "/api/plain", discovery: { ...hostile.discovery, input: { text: "a b", n: 2 } } };
  const saved = { k: process.env.TEMPO_API_KEY, r: process.env.TEMPO_RECIPIENT_ADDRESS };
  delete process.env.TEMPO_API_KEY;
  ok(!/Tempo push/.test(factsOf(toolPage("https://example.test", plain, []))), "no Tempo push sentence when Tempo is not offered");
  process.env.TEMPO_API_KEY = "test"; process.env.TEMPO_RECIPIENT_ADDRESS = "0x000000000000000000000000000000000000dEaD";
  ok(/Tempo push credential.*refund owed/.test(factsOf(toolPage("https://example.test", plain, []))), "Tempo push sentence when Tempo is offered on the route");
  ok(!/Tempo push/.test(factsOf(toolPage("https://example.test", { ...plain, identityBound: true }, []))), "no Tempo push sentence on an identity-bound route (no Tempo offer)");
  ok(!/Tempo push/.test(factsOf(toolPage("https://example.test", { ...plain, longRunning: true }, []))), "no Tempo push sentence on a long-running route (no Tempo offer)");
  if (saved.k === undefined) delete process.env.TEMPO_API_KEY; else process.env.TEMPO_API_KEY = saved.k;
  if (saved.r === undefined) delete process.env.TEMPO_RECIPIENT_ADDRESS; else process.env.TEMPO_RECIPIENT_ADDRESS = saved.r;

  ok(/served as this GET/.test(factsOf(toolPage("https://example.test", plain, []))), "method alias sentence when the other method has no route");
  ok(!/served as this GET/.test(factsOf(toolPage("https://example.test", plain, [], { otherMethodRouted: true }))), "no method alias sentence when the other method has its own route");
  ok(!/same 402 quote/.test(factsOf(toolPage("https://example.test", hostile, [], { otherMethodRouted: true }))), "no GET/HEAD alias sentence when GET has its own route");

  const bin = { ...plain, slug: "bin", binaryTypes: ["image/png", "image/jpeg"], discovery: { ...plain.discovery, output: { example: { __note: "returns the image as binary" } } } };
  const binHtml = toolPage("https://example.test", bin, [], { computePayable: true, powDifficulty: 16 });
  ok(!/a JSON object with/.test(binHtml) && !/__note/.test(binHtml), "binary tool: no JSON object claim and no __note shown");
  ok(/raw bytes, not JSON/.test(binHtml) && /image\/jpeg/.test(binHtml), "binary tool: names raw bytes and its content types");
  ok(/does not replay/.test(factsOf(binHtml)), "binary tool: Idempotency-Key replay not promised");
  ok(/larger than 1 MB is not replayed/.test(factsOf(toolPage("https://example.test", plain, []))), "JSON tool: replay scoped by the body ceiling");

  ok(!/pure computation/.test(factsOf(toolPage("https://example.test", plain, [], { computePayable: true, powDifficulty: 16 }))), "free tier sentence makes no pure-computation claim");
  const sq = factsOf(toolPage("https://example.test", { ...hostile, slug: "sql-guard" }, []));
  ok(/pure computation, but it can mint/.test(sq) && !/reaches the network/.test(sq), "sql-guard: wallet-only by policy, not by network");
  const ag = factsOf(toolPage("https://example.test", { ...hostile, slug: "action-gate" }, []));
  ok(/pure computation/.test(ag) && !/reaches the network/.test(ag), "action-gate: wallet-only by policy, not by network");

  const r = powSnippetRequest("https://example.test", plain);
  ok(r.url === "https://example.test/api/plain?text=a+b&n=2", `GET PoW snippet carries the documented input (${r.url})`);
  ok(powSnippetRequest("https://example.test", hostile).url === "https://example.test/api/fake-html", "POST PoW snippet URL has no query string");
}

// ---- 2 + 3. Booted: every catalog page. ----
const PORT = await getFreePort();
const BASE = `http://127.0.0.1:${PORT}`;
proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off" },
  stdio: "ignore",
});
try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
  ok(up, "server booted");

  for (const slug of ["html-entities", "html-links", "html-select", "html-to-markdown", "html-strip"]) {
    const html = await (await fetch(`${BASE}/tools/${slug}`)).text();
    ok(h1Count(html) === 1, `/tools/${slug}: exactly one <h1>`);
    ok(!/<a href=\\?"x\\?"/.test(html), `/tools/${slug}: no live link from an example string`);
  }

  const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
  const list = (Array.isArray(pricing) ? pricing : pricing.tools || pricing.endpoints || []).filter((t) => t.slug);
  ok(list.length >= 400, `catalog listed (${list.length})`);
  const seen = new Map();
  for (const t of list) {
    const html = await (await fetch(`${BASE}/tools/${t.slug}`)).text();
    const title = titleOf(html), desc = descOf(html);
    ok(h1Count(html) === 1, `/tools/${t.slug}: one <h1>`);
    ok(title.length > 0 && title.length <= 60, `/tools/${t.slug}: title <= 60 (${title.length}: ${title})`);
    ok(desc.length >= 120 && desc.length <= 155, `/tools/${t.slug}: description 120-155 (${desc.length})`);
    ok(!seen.has(desc), `/tools/${t.slug}: description not shared with /tools/${seen.get(desc)}`);
    seen.set(desc, t.slug);
  }

  for (const slug of ["http-headers", "password", "iban-validate", "uuid-validate", "edgar-company-lookup", "hash", "weather-forecast", "dns-lookup"]) {
    const html = await (await fetch(`${BASE}/tools/${slug}`)).text();
    const main = mainOf(html);
    const def = list.find((t) => t.slug === slug);
    for (const h of ["Parameters", "Example request", "Example response", "From an MCP client", "Errors and behavior", "Related tools"]) {
      ok(main.includes(`>${h}</h2>`), `/tools/${slug}: has "${h}" section`);
    }
    ok(main.includes(def.price), `/tools/${slug}: summary names the price`);
    ok(main.includes(`&quot;slug&quot;: &quot;${slug}&quot;`), `/tools/${slug}: MCP example carries the slug`);
    const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));
    const crumbs = ld.find((b) => b["@type"] === "BreadcrumbList");
    ok(crumbs && crumbs.itemListElement.length === 4, `/tools/${slug}: BreadcrumbList with four levels`);
    ok(/\/tools\/category\//.test(crumbs.itemListElement[2].item), `/tools/${slug}: breadcrumb links the category page`);
    const offer = ld.find((b) => b.offers)?.offers;
    ok(offer && offer.priceCurrency === "USD" && `$${offer.price}` === def.price, `/tools/${slug}: Offer price matches the catalog`);
    ok(!ld.some((b) => b["@type"] === "FAQPage"), `/tools/${slug}: no FAQPage without visible Q&A`);
  }

  // ---- 4. Booted: the per-tool claims on real routes, and /openapi.json. ----
  {
    const factsOf = (html) => decode(stripTags((html.match(/<ul class="tp-facts">([\s\S]*?)<\/ul>/) || [])[1] || ""));
    const page = async (slug) => (await fetch(`${BASE}/tools/${slug}`)).text();
    // /api/memory carries both a GET and a POST route, so the method alias never runs there.
    for (const slug of ["memory-read", "memory-write"]) {
      const f = factsOf(await page(slug));
      ok(!/served as this GET/.test(f) && !/same 402 quote/.test(f), `/tools/${slug}: no method-alias sentence on a path with both methods`);
    }
    for (const slug of ["qr", "image-resize", "image-convert", "image-thumbnail", "screenshot"]) {
      const html = await page(slug);
      ok(/raw bytes, not JSON/.test(html) && !/a JSON object with/.test(html) && !/__note/.test(html), `/tools/${slug}: described as raw bytes`);
      ok(/does not replay/.test(factsOf(html)), `/tools/${slug}: no idempotent replay promised for bytes`);
    }
    for (const slug of ["feedback-summary", "seller-trust", "x402-market-pulse"]) {
      const f = factsOf(await page(slug));
      if (f) ok(!/pure computation/.test(f), `/tools/${slug}: no pure-computation claim on a tool that reads server state`);
    }
    for (const slug of ["sql-guard", "action-gate"]) {
      ok(!/reaches the network or stored state/.test(factsOf(await page(slug))), `/tools/${slug}: wallet-only reason is the policy, not network`);
    }

    const spec = await (await fetch(`${BASE}/openapi.json`)).json();
    const g = spec.info["x-guidance"];
    ok(!/Every \/api\/\* and \/v1\/\*/.test(g) && /x-price/.test(g), "x-guidance scopes pay-per-call to priced operations");
    ok(!/buy at \/credits/.test(g), "x-guidance does not send agents to buy credits");
    ok(!/Every endpoint is paid/.test(spec.info.description), "info.description makes no every-endpoint claim");
    const ops = [];
    for (const [p, item] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(item)) ops.push({ p, m, op });
    const opOf = (slug) => ops.find((o) => o.op.operationId === slug || o.op.operationId === `${slug}Get`);
    for (const slug of ["memory-write", "memory-read", "research", "dossier"]) {
      const o = opOf(slug);
      if (!o) continue;
      ok(!/Solana|Stellar|Algorand/.test(o.op.description), `/openapi.json ${slug}: EVM-only route names no non-EVM rail`);
    }
    const hash = opOf("hash");
    ok(hash && /Solana/.test(hash.op.description), "/openapi.json hash: a route on every rail still names them");
    const img = opOf("image-resize");
    ok(img && img.op.responses[200].content["image/jpeg"] && !img.op.responses[200].content["application/json"], "/openapi.json image-resize: 200 is binary per content type");

    // An example whose output shows a found/success result must not be fed a
    // placeholder all-zero hash, which can only answer not-found.
    const ZERO = /0x0{64}\b/;
    for (const o of ops) {
      const ex = o.op.responses?.[200]?.content?.["application/json"]?.example;
      if (!ex || typeof ex !== "object") continue;
      if (!(ex.status === "success" || ex.found === true || ex.settled === true)) continue;
      const input = JSON.stringify(o.op.requestBody?.content?.["application/json"]?.example ?? (o.op.parameters || []).map((p) => p.example));
      ok(!ZERO.test(input), `/openapi.json ${o.op.operationId}: success-shaped example is not fed an all-zero hash`);
    }
  }

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.stack || e.message);
}
