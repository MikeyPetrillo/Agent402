// North Carolina sales tax on card-funded sales of digital audio and video
// (src/nc-sales-tax.js): the report is built from sales-ledger rows; only
// card-funded sales (a credits key, or a per-call card payment) of taxable
// routes billed to North Carolina count; wallet payments are skipped; the
// taxable routes are real; checkout collects the address; the taxable tool
// pages state the price includes the tax (G.S. 105-164.7(2)).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { ncTaxReport, ncTaxableKind, isNcBilling, taxIncludedPortion, monthBounds, NC_TAXABLE_SLUGS } from "../src/nc-sales-tax.js";
import { TERMS_VERSION, creditsTermsVersion } from "../src/credits-sales.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log("ok - " + m); else { failed++; console.log("FAIL - " + m); } };

ok(ncTaxableKind("tts") === "digital audio work" && ncTaxableKind("v1-videos") === "digital audiovisual work", "speech and video are taxable kinds");
ok(ncTaxableKind("v1-images-fast") === null && ncTaxableKind("whois") === null && ncTaxableKind("v1-chat-metered") === null, "generated images, data and chat are not");
// An edit of the buyer's own image or audio file is taxed, conservatively.
const EDITS = ["v1-images-edit", "image-crop", "image-resize", "image-convert", "image-thumbnail", "audio-convert", "audio-normalize"];
ok(EDITS.every((slug) => /^edit of a buyer's (image|audio)$/.test(String(ncTaxableKind(slug)))), "edits of a buyer's image or audio file are taxable kinds");
ok(["v1-images", "v1-images-fast", "transcribe", "v1-audio-transcriptions"].every((slug) => ncTaxableKind(slug) === null), "generated images and transcription stay untaxed");
ok(isNcBilling({ country: "us", state: "nc" }) && !isNcBilling({ country: "US", state: "VA" }) && !isNcBilling({ country: "CA", state: "NC" }) && !isNcBilling(null), "only a US billing address in NC counts");
ok(Math.abs(taxIncludedPortion(1.0725, 0.0725) - 0.0725) < 1e-9, "the tax inside a tax-included amount is gross x r / (1 + r) at the combined rate");
const [s, e] = monthBounds("2026-11");
ok(s === Date.UTC(2026, 10, 1) && e === Date.UTC(2026, 11, 1), "month bounds are UTC calendar months");

const nov = Date.parse("2026-11-03T12:00:00Z"), dec = Date.parse("2026-12-01T00:00:01Z");
const keys = new Map([["k_nc1", { country: "US", state: "NC", postal: "27601-1234" }], ["k_nc2", { country: "US", state: "NC", postal: null }], ["k_va", { country: "US", state: "VA", postal: "22201" }]]);
const payments = { pi_nc: { country: "US", state: "NC", postal: "28202" }, pi_tx: { country: "US", state: "TX", postal: "73301" } };
const rows = [
  { ts: nov, slug: "tts", priceUsd: 0.05, payer: "k_nc1", tx: null },            // credits, NC: counts
  { ts: nov, slug: "v1-videos", priceUsd: 0.5, payer: null, tx: "pi_nc" },       // card per call, NC: counts
  { ts: nov, slug: "tts", priceUsd: 0.05, payer: "k_va", tx: null },             // credits, VA: not NC
  { ts: nov, slug: "tts", priceUsd: 0.05, payer: null, tx: "pi_tx" },            // card per call, TX: not NC
  { ts: nov, slug: "whois", priceUsd: 0.005, payer: "k_nc1", tx: null },         // not taxable
  { ts: nov, slug: "tts", priceUsd: 0.05, payer: "0xabc", tx: "0xdeadbeef" },    // wallet payment: no address
  { ts: nov, slug: "dub", priceUsd: 0.2, payer: "k_unknown", tx: null },         // a key with no address on file
  { ts: dec, slug: "tts", priceUsd: 0.05, payer: "k_nc2", tx: null },            // NC, no ZIP
  { ts: nov, slug: "tts", priceUsd: 0.05, payer: "0xfeed", tx: null, rail: "usdc" }, // a wallet row with no tx: the rail says wallet, not credits
  { ts: nov, slug: "tts", priceUsd: 0.05, payer: "k_nc1", tx: null, rail: "credits" }, // credits by rail: counts
];
const lookups = [];
const r = await ncTaxReport(rows, { billingForKey: (id) => keys.get(id) || null, billingForPayment: async (pi) => { lookups.push(pi); return payments[pi] || null; } });
ok(Object.keys(r.months).sort().join() === "2026-11,2026-12", "receipts are grouped by calendar month (UTC)");
ok(r.months["2026-11"].calls === 3 && Math.abs(r.months["2026-11"].grossReceiptsUsd - 0.6) < 1e-9, "only card-funded taxable sales billed to NC count");
ok(r.months["2026-11"].bySource.credits === 2 && r.months["2026-11"].bySource.card === 1, "credits and per-call card sales are both included and told apart");
ok(r.months["2026-11"].byZip["27601"]?.calls === 2 && r.months["2026-11"].byZip["28202"]?.calls === 1, "receipts are broken down by 5-digit billing ZIP");
ok(r.months["2026-12"].byZip.unknown?.calls === 1, "an NC sale without a ZIP is kept as unknown, not dropped");
ok(r.cardFundedSalesWithoutAddress === 1, "a card-funded sale with no address on file is counted, not silently dropped");
ok(!lookups.includes("0xdeadbeef") && lookups.includes("pi_nc"), "wallet payments are not looked up; card payments are");

// Every taxable slug is a real catalog route.
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const toolsSrc = ["tools/tts-kit.js", "tools/llm-gateway-kit.js", "tools/dub-kit.js", "tools/llm-images-fast-kit.js", "tools/image-kit.js", "tools/media-kit.js"].map(src).join("\n");
for (const slug of Object.keys(NC_TAXABLE_SLUGS)) ok(toolsSrc.includes(`slug: "${slug}"`), `taxable slug ${slug} is a catalog route`);

// Checkout collects what the report and the rules need, and adds no tax of its own.
const credits = src("credits.js");
ok(/billing_address_collection: "required"/.test(credits) && /tax_id_collection: \{ enabled: true \}/.test(credits), "credits checkout requires a billing address and offers a tax ID field");
ok(/key: "terms"[\s\S]{0,200}optional: false/.test(credits) && /key: "use"[\s\S]{0,200}optional: false/.test(credits), "checkout requires the business-use and terms answers");
ok(!/automatic_tax/.test(credits.slice(credits.indexOf("async function createCheckout"), credits.indexOf("const claimedAnswer"))), "credits checkout adds no Stripe tax on top of a tax-included price");
ok(/metadata: \{ credits_pack: packKey, terms: creditsTermsVersion\(\)[ ,}]/.test(credits), "checkout records the terms version");
// /terms names every taxable kind and keeps the tax-included statement (G.S. 105-164.7(2)).
{
  const { termsPage } = await import("../src/terms.js");
  const text = termsPage("https://agent402.tools").replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
  ok(/Prices are the same everywhere and include North Carolina sales tax where it applies/.test(text), "/terms says prices include North Carolina sales tax");
  ok(/generated speech, audio or video, or that edits an image or audio file you send, includes that tax/.test(text), "/terms names generated speech, audio and video and edits of a buyer's image or audio file as taxed");
}
const termsDate = (src("terms.js").match(/last updated (\d{4}-\d{2}-\d{2})\./) || [])[1];
ok(termsDate === TERMS_VERSION, `TERMS_VERSION is the date in the /terms source (${TERMS_VERSION} vs ${termsDate})`);
// A checkout runs only while sales are on: what it records is the date /terms prints then.
{
  const prev = process.env.CREDITS_SALES;
  process.env.CREDITS_SALES = "on";
  const { termsPage } = await import("../src/terms.js");
  const printed = (termsPage("https://agent402.tools").match(/last updated (\d{4}-\d{2}-\d{2})\./) || [])[1];
  ok(printed === creditsTermsVersion(), `the recorded terms version is the date /terms prints while sales are on (${creditsTermsVersion()} vs ${printed})`);
  if (prev === undefined) delete process.env.CREDITS_SALES; else process.env.CREDITS_SALES = prev;
}
// G.S. 105-164.7(2): the tax-included statement on each taxable tool's page.
ok(/if \(ncTaxableKind\(tool\.slug\)\) facts\.push\(`Sales tax: the price includes North Carolina sales tax/.test(src("pages.js")), "taxable tool pages state the price includes NC sales tax");
ok(/ncTaxReport\(rows/.test(src("server.js")) && /externalSalesForSlugs\(Object\.keys\(NC_TAXABLE_SLUGS\)/.test(src("server.js")), "the operator report is built from the sales ledger");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
