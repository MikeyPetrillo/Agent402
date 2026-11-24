// The /v1 model gateway is described as this service's own product on every
// surface that describes it as a whole: /llms.txt, /docs, the llm tag of
// /openapi.json, the README and the wiki carry the one sentence from
// src/gateway-product-copy.js (pricing before the call, `auto` routing, chat
// failover and, while receipts are signed, the signed receipt), and no public
// surface offers a model provider's access for sale.
//
//   node scripts/test-gateway-product-copy.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const flat = (s) => String(s).replace(/\s+/g, " ");

const { gatewayProductSentence, gatewayProductHtml, GATEWAY_PRODUCT_SENTENCE } = await import("../src/gateway-product-copy.js");
const on = gatewayProductSentence({ receipts: true }), off = gatewayProductSentence({ receipts: false });
ok(on === GATEWAY_PRODUCT_SENTENCE, "the published form is the receipts-on sentence");
ok(/signs a receipt/.test(on) && !/receipt/.test(off), "the receipt clause follows the switch");
for (const s of [on, off]) {
  ok(/^The gateway is an Agent402 service: /.test(s) && /prices each call before it runs/.test(s) && /`auto`/.test(s) && /falls back/.test(s) && /, and [^,]+\.$/.test(s), `the sentence names what the gateway does, as one list (${s})`);
  ok(!/—/.test(s) && !/resell|access to/i.test(s), "no em dash, no resale or access wording");
}
ok(gatewayProductHtml({ receipts: false }).includes("<code>auto</code>") && !gatewayProductHtml().includes("`"), "the HTML form sets code spans");

// The static files carry the published sentence verbatim.
for (const f of ["README.md", "wiki/LLM-Gateway.md"]) ok(flat(read(f)).includes(GATEWAY_PRODUCT_SENTENCE), `${f} carries the sentence`);

// The rendered surfaces read it, with the receipt clause per this boot.
const { receiptsServed } = await import("../src/receipt-signing.js");
const want = gatewayProductSentence({ receipts: receiptsServed() });
{
  const { openapiSpec } = await import("../src/pages.js");
  const spec = openapiSpec("https://agent402.tools", {});
  const tag = (spec.tags || []).find((t) => t.name === "llm");
  ok(tag && tag.description.includes(want), `the openapi llm tag carries it (${tag?.description})`);
}
{
  const src = read("src/seo.js");
  ok(/Model-backed: third-party models answer\. \$\{gatewayProductSentence\(\{ receipts: receiptsServed\(\) \}\)\}/.test(src), "/llms.txt's call-a-model section reads it beside the model-backed line");
  const docs = read("src/ledger-docs.js");
  ok(/These routes are model-backed\. \$\{gatewayProductHtml\(\{ receipts: receiptsServed\(\) \}\)\}/.test(docs), "/docs' gateway section reads it beside the model-backed line");
}

// No tracked public text offers a provider's model access for sale.
const files = execFileSync("git", ["ls-files", "src/*.js", "src/**/*.js", "*.md", "wiki/*.md", "docs/*", "mcp/README.md", "client/README.md"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).split("\n").filter(Boolean);
const RESALE = /\bresell(?:s|ing)? (?:api )?access to\b|\bresale of (?:model|api) access\b/i;
const hits = files.filter((f) => RESALE.test(flat(read(f))));
ok(hits.length === 0, `no public text resells model access (${hits.join(", ") || `${files.length} files read`})`);
ok(RESALE.test("We resell access to frontier models.") && RESALE.test("reselling API access to Models"), "control: the pattern reads resale wording");

console.log(`\ntest-gateway-product-copy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
