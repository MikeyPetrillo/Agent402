#!/usr/bin/env node
// The AWS Marketplace listing's own surfaces (src/aws-start-page.js,
// src/aws-openapi.js, src/aws-listing.js):
//   - offline: the AWS-facing description drops a sentence naming a tool the
//     gate does not serve, one of this server's paths or host, or a sales word,
//     and keeps everything else (an abbreviation never ends a sentence, a
//     one-word slug is an ordinary word);
//   - booted in paid mode with the default slug list: every listed slug is
//     served (the two held slugs are not listed); /aws/start renders, is not
//     indexed, and links nowhere but the /aws addresses, AWS's documentation
//     and the support mailboxes; it lists every served tool at its catalog
//     price under its group's notice; /aws/openapi.json lists exactly the
//     served tools under the one /aws server, each input schema compiles and
//     its example validates against it; no /aws description (402 listing,
//     page, OpenAPI) names a slug outside the served set or a path of this
//     server; /terms carries the AWS Marketplace section.
//
//   node scripts/test-aws-start-page.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { generateKeyPairSync } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { bootPaidServer } from "./lib/paid-boot.js";

const { AWS_DEFAULT_SLUGS } = await import("../src/aws-marketplace-gate.js");
const { AWS_LISTING_GROUPS, awsDescriptionOf, awsPointersIn, sentencesOf } = await import("../src/aws-listing.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- offline ---------------------------------------------------------------
{
  ok(sentencesOf("Resolve a ticker (e.g. AAPL) to its CIK. Returns rows.").length === 2, "an abbreviation does not end a sentence");
  const ctx = { servedSlugs: ["dns"], catalogSlugs: ["dns", "spf-check", "search"], ownPaths: ["/api/dns"], ownHosts: ["agent402.tools"] };
  const def = { slug: "dns", name: "DNS", description: "Resolve one record type. Full-text search is not done here. For SPF use spf-check. Call POST /api/dns directly. See agent402.tools for more. Killer endpoint for screens." };
  const d = awsDescriptionOf(def, ctx);
  ok(d === "Resolve one record type. Full-text search is not done here.", `the AWS description keeps only the tool's own sentences (${d})`);
  ok(awsPointersIn("Use spf-check next.", ctx).includes("spf-check") && awsPointersIn("Use dns next.", ctx).length === 0, "a served slug is not a pointer; an unserved hyphenated one is");
  ok(awsPointersIn("Source: data.sec.gov/api/xbrl/frames.", ctx).length === 0, "a path inside another host's address is not a pointer at this server");
  ok(awsDescriptionOf({ slug: "x", name: "X tool", description: "See /api/x." }, ctx) === "X tool", "nothing left: the tool's name");
  const listed = AWS_LISTING_GROUPS.flatMap((g) => g.slugs);
  ok(listed.length === 74 && new Set(listed).size === 74 && JSON.stringify([...AWS_DEFAULT_SLUGS]) === JSON.stringify(listed), "the default slug list is the 74 listed tools, each once");
  ok(!listed.includes("edgar-insider-trades") && !listed.includes("fec-candidates"), "the held slugs are not listed");
}

// ---- booted ------------------------------------------------------------------
const seller = generateKeyPairSync("ec", { namedCurve: "P-256" });
const OP = "test-operator-token-aws-start-0001";
const ENV = {
  SQL_CERT_SIGNING_KEY: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
  AWS_MARKETPLACE_QUOTE_KEY: Buffer.from(seller.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"),
  AWS_MARKETPLACE_QUOTE_KEY_ID: "quote-test-1", AWS_MARKETPLACE_PRODUCT_ID: "prod-testproduct01",
  AWS_MARKETPLACE_SLUGS: "", AWS_MARKETPLACE_QUOTES_PER_MIN: "1000",
  AGENT402_OPERATOR_TOKEN: OP,
};
const srv = await bootPaidServer({ label: "aws-start", env: ENV });
try {
  // BASE_URL as the server reads it (the canonical address /terms names).
  const termsHtml = await (await fetch(`${srv.url}/terms`)).text();
  const origin = new URL(/<link rel="canonical" href="([^"]+)\/terms"/.exec(termsHtml)[1]).origin;
  // The gate is built asynchronously: the page answers once it is.
  let page;
  for (let i = 0; i < 50; i++) { page = await fetch(`${srv.url}/aws/start`); if (page.status === 200) break; await new Promise((r) => setTimeout(r, 200)); }
  const op = await (await fetch(`${srv.url}/__operator/aws.json`, { headers: { "x-operator-token": OP } })).json();
  const served = op.routes || [];
  ok(op.enabled === true && served.length === 74 && (op.notServed || []).length === 0, `defaults: 74 served, none refused (${served.length} served; refused ${JSON.stringify(op.notServed)})`);

  const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
  const tools = Array.isArray(pricing) ? pricing : (pricing.tools || pricing.endpoints || Object.values(pricing).find(Array.isArray));
  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  const catalogSlugs = [...bySlug.keys()];
  const servedSet = new Set(served);
  const outside = catalogSlugs.filter((s) => !servedSet.has(s) && s.includes("-"));
  const pointers = (text) => {
    const lc = String(text).toLowerCase();
    const hits = outside.filter((s) => new RegExp(`(?<![a-z0-9-])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`).test(lc));
    for (const m of lc.matchAll(/(?:^|[\s"'`(,;:=])(\/(?:api|v1|mcp|ref|docs|pricing|credits|llms)[a-z0-9._~\-/]*)/g)) hits.push(m[1]);
    if (/agent402\.tools(?!\/aws)/.test(lc.replace(/(?:help|security)@agent402\.tools/g, ""))) hits.push("agent402.tools");
    if (/\bkiller\b/.test(lc)) hits.push("killer");
    return hits;
  };

  // The page.
  const html = await page.text();
  ok(page.status === 200 && /text\/html/.test(page.headers.get("content-type") || ""), "/aws/start renders");
  ok(/noindex/.test(page.headers.get("x-robots-tag") || "") && /<meta name="robots" content="noindex/.test(html), "/aws/start is not indexed (header and meta)");
  const anchors = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const allowedAnchor = (h) => h.startsWith("#") || h.startsWith(`${origin}/aws/`) || h === `${origin}/aws` || /^mailto:(?:help|security)@agent402\.tools$/.test(h) || h.startsWith("https://docs.aws.amazon.com/");
  ok(anchors.length >= 4 && anchors.every(allowedAnchor), `every link on /aws/start stays on the listing (${anchors.filter((h) => !allowedAnchor(h)).join(", ") || "none off it"})`);
  const others = [...html.matchAll(/\b(?:href|src|action)="([^"]*)"/g)].map((m) => m[1]).filter((h) => !anchors.includes(h.replace(/&amp;/g, "&")));
  ok(others.every((h) => /^\/(?:js|fonts)\/|^\/favicon\.|^\/logo\.png/.test(h)), `the page's other references are its own assets (${others.filter((h) => !/^\/(?:js|fonts)\/|^\/favicon\.|^\/logo\.png/.test(h)).join(", ") || "only assets"})`);
  ok(!/<nav\b|<footer\b|<form\b/.test(html), "no site navigation, footer or form");
  const text = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
  // The tables quote each tool's own purpose (a stablecoin tool names USDC); the page's own copy names no other way to pay.
  const prose = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<table[\s\S]*?<\/table>/g, "").replace(/<[^>]+>/g, " ");
  const offWords = [...(text.match(/—/g) || []), ...(prose.match(/proof[- ]of[- ]work|USDC|stablecoin|credits|wallet/gi) || [])];
  ok(offWords.length === 0, `no em dash, and the page's copy names no other way to pay (${offWords.join(", ") || "none"})`);
  ok(!/llms\.txt/.test(page.headers.get("link") || "") && !/llms\.txt/.test(html), "no Link header or head link to the site map");
  ok(pointers(text).length === 0, `the page names nothing past the listing (${pointers(text).join(", ")})`);
  const missing = served.filter((s) => !html.includes(`<code>${s}</code>`) || !html.includes(bySlug.get(s)?.price));
  ok(missing.length === 0, `every served tool is on the page with its catalog price (${missing.join(", ") || "all"})`);
  {
    const priced = served.map((s) => bySlug.get(s).price).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    ok(text.includes(`from ${priced[0]} to ${priced[priced.length - 1]} per call`), `the price span is the catalog's (${priced[0]} to ${priced[priced.length - 1]})`);
  }
  ok(AWS_LISTING_GROUPS.every((g) => html.includes(g.notice.replace(/'/g, "&#39;")) || html.includes(g.notice)), "each group's notice is printed");
  ok(html.includes(`${origin}/aws/.well-known/jwks.json`) && html.includes(`${origin}/aws/openapi.json`) && html.includes("help@agent402.tools"), "the JWKS, the OpenAPI document and the support mailbox are named");
  ok(/up to 3 attempts/.test(text) && /is reviewed, and an approved correction is made as a billing adjustment on your AWS invoice through AWS Marketplace\./.test(text), "the refund rule states the attempts the gate allows and the reviewed invoice adjustment");

  // The OpenAPI document.
  const oaRes = await fetch(`${srv.url}/aws/openapi.json`);
  const oa = await oaRes.json();
  ok(oaRes.status === 200 && oa.openapi === "3.1.0" && oa.info?.title && oa.info?.version, "/aws/openapi.json is an OpenAPI 3.1 document");
  ok(Array.isArray(oa.servers) && oa.servers.length === 1 && oa.servers[0].url === `${origin}/aws`, "one server: BASE_URL + /aws");
  const keys = Object.keys(oa.paths || {});
  ok(keys.length === served.length && keys.every((k) => servedSet.has(k.slice(1))) && served.every((s) => keys.includes(`/${s}`)), "it lists exactly the served tools");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const bad = [];
  const opIds = new Set();
  for (const [p, item] of Object.entries(oa.paths)) {
    const slug = p.slice(1);
    const methods = Object.keys(item);
    const want = String(bySlug.get(slug)?.method || "").toLowerCase();
    if (methods.length !== 1 || methods[0] !== want) { bad.push(`${slug}: method ${methods.join(",")} not ${want}`); continue; }
    const o = item[methods[0]];
    if (!o.operationId || opIds.has(o.operationId)) bad.push(`${slug}: operationId`); opIds.add(o.operationId);
    if (!o.responses?.["200"] || !o.responses?.["402"]) bad.push(`${slug}: responses`);
    const pi = o["x-payment-info"];
    if (pi?.network !== "aws:base" || pi?.scheme !== "exact" || pi?.asset !== "iso4217:USD" || `$${pi?.price?.amount}` !== bySlug.get(slug)?.price) bad.push(`${slug}: payment info`);
    if (pointers(o.description).length) bad.push(`${slug}: description names ${pointers(o.description).join(",")}`);
    let schema, example;
    if (methods[0] === "post") { schema = o.requestBody?.content?.["application/json"]?.schema; example = o.requestBody?.content?.["application/json"]?.example; }
    else {
      schema = { type: "object", properties: Object.fromEntries((o.parameters || []).map((x) => [x.name, x.schema])), required: (o.parameters || []).filter((x) => x.required).map((x) => x.name) };
      example = Object.fromEntries((o.parameters || []).filter((x) => "example" in x).map((x) => [x.name, x.example]));
      if ((o.parameters || []).some((x) => x.in !== "query" || typeof x.name !== "string")) bad.push(`${slug}: parameters`);
    }
    try {
      const v = ajv.compile(schema);
      if (!v(example)) bad.push(`${slug}: example fails its schema (${ajv.errorsText(v.errors).slice(0, 160)})`);
    } catch (e) { bad.push(`${slug}: schema does not compile (${String(e.message).slice(0, 120)})`); }
  }
  ok(bad.length === 0, `every operation is well formed, priced as listed, and its example validates (${bad.slice(0, 6).join("; ") || "all"})`);

  // The 402 listing each served tool answers.
  const listingBad = [];
  for (const slug of served) {
    const method = bySlug.get(slug)?.method || "POST";
    const r = await fetch(`${srv.url}/aws/${slug}`, { method });
    const hdr = r.headers.get("payment-required");
    if (r.status !== 402 || !hdr) { listingBad.push(`${slug}: ${r.status}`); continue; }
    const req = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
    const desc = String(req.resource?.description || "");
    if (/llms\.txt/.test(r.headers.get("link") || "")) listingBad.push(`${slug}: Link header names the site map`);
    if (!desc || pointers(desc).length) listingBad.push(`${slug}: ${pointers(desc).join(",") || "no description"}`);
  }
  ok(listingBad.length === 0, `no /aws 402 listing description names a tool, path or host past the listing (${listingBad.slice(0, 6).join("; ") || "all clean"})`);
  {
    const read = async (slug) => { const r = await fetch(`${srv.url}/aws/${slug}`, { method: bySlug.get(slug).method }); return JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf8")).resource.description; };
    const [dns, sql, frame] = [await read("dns"), await read("sql-guard"), await read("edgar-xbrl-frame")];
    ok(!/spf-check|dmarc-check|email-deliverability/.test(dns) && /Resolve one common DNS record type/.test(dns), "dns is described without the mail tools it names on the direct route");
    ok(!/sql-cert-verify/.test(sql) && /Review a SQL statement/.test(sql), "sql-guard is described without its verify route");
    ok(!/killer/i.test(frame) && /cross-sectional/.test(frame), "edgar-xbrl-frame carries no sales word");
    ok(/spf-check/.test(bySlug.get("dns").description), "control: the direct route's dns description still names the mail tools");
  }

  ok(/id="aws-marketplace"/.test(termsHtml) && /standard\s+contract for AWS Marketplace/.test(termsHtml), "/terms carries the AWS Marketplace purchases section while the gate is on");
  ok(/ends without an answer is reviewed, and an approved correction is made as a billing\s+adjustment on your AWS invoice through AWS Marketplace\./.test(termsHtml) && !/is corrected as a billing adjustment/.test(termsHtml), "/terms: a paid call that ends without an answer is reviewed, and an approved correction is an invoice adjustment");
} finally {
  await srv.stop();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
