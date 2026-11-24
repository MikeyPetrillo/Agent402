// The terms reach the machine surfaces a buyer's agent reads before it pays,
// not only the page footer: /openapi.json `info.termsOfService`, every mirrored
// 402 body (`terms`, `termsNote`; src/payment-required-body.js, driven on a
// booted server by scripts/test-payment-required-body.js B5), the MCP
// initialize instructions of the hosted connector, its product profiles and
// the npm package, and the /x402-test sample of a 402 body. Offline.
//
//   node scripts/test-terms-links.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const BASE = "https://agent402.test";
const TERMS = `${BASE}/terms`;

{
  const { openapiSpec } = await import("../src/pages.js");
  const spec = openapiSpec(BASE, {});
  ok(spec?.info?.termsOfService === TERMS, `/openapi.json info.termsOfService is ${TERMS} (${spec?.info?.termsOfService})`);
  ok(spec?.info?.license?.identifier === "AGPL-3.0-or-later", "/openapi.json info.license names the server's license");
}
{
  const { termsFields, mergePaymentRequiredBody, withoutPaymentRequired, TERMS_KEY, TERMS_NOTE_KEY } = await import("../src/payment-required-body.js");
  const f = termsFields(TERMS);
  ok(f[TERMS_KEY] === TERMS && f[TERMS_NOTE_KEY].includes(TERMS), "termsFields names the URL and says paying accepts it");
  ok(Object.keys(termsFields("")).length === 0 && Object.keys(termsFields(null)).length === 0, "no terms URL, no fields");
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact" }], resource: {} })).toString("base64");
  const merged = JSON.parse(mergePaymentRequiredBody("{}", header, f));
  ok(merged.terms === TERMS && Array.isArray(merged.accepts), "a mirrored body carries the terms beside the offer");
  const relayed = withoutPaymentRequired(merged);
  ok(!("terms" in relayed) && !("termsNote" in relayed) && !("accepts" in relayed), "a relayed refusal drops the terms with the offer");
}
{
  const { mcpInitializeInstructions, mcpTermsLine } = await import("../src/mcp-flagship.js");
  ok(mcpInitializeInstructions(BASE).includes(mcpTermsLine(BASE)) && mcpTermsLine(BASE).includes(TERMS), "the hosted connector's initialize instructions name the terms");
  const http = readFileSync(new URL("../src/mcp-http.js", import.meta.url), "utf8");
  ok(/profile\?\.instructions \? `\$\{profile\.instructions\}\\n\$\{mcpTermsLine\(baseUrl\)\}`/.test(http), "a product profile's own instructions carry the terms line too");
  const { mcpInitializeInstructions: pkg } = await import("../mcp/output-schemas.js");
  ok(pkg(BASE).includes(`Terms of Service at ${TERMS}`), "the npm package's initialize instructions name the terms");
}
{
  const { x402TestPage } = await import("../src/x402-test-page.js");
  const html = x402TestPage(BASE).replace(/&quot;/g, '"');
  ok(html.includes(`"terms": "${TERMS}"`), "the /x402-test sample 402 body shows the terms field");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
