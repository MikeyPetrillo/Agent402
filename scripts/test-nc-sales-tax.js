// North Carolina sales tax on credits spent on digital audio and video
// (src/nc-sales-tax.js): only an NC billing address and a taxable route are
// recorded, tax-included, by month and ZIP; the taxable routes exist in the
// catalog; checkout collects the address; the debit hook passes it.
import { readFileSync } from "node:fs";
import { createNcTaxLedger, ncTaxableKind, isNcBilling, taxIncludedPortion, NC_TAXABLE_SLUGS, NC_STATE_RATE } from "../src/nc-sales-tax.js";

let failed = 0;
const ok = (c, m) => { if (c) console.log("ok - " + m); else { failed++; console.log("FAIL - " + m); } };

ok(ncTaxableKind("tts") === "digital audio work" && ncTaxableKind("v1-videos") === "digital audiovisual work", "speech and video are taxable kinds");
ok(ncTaxableKind("v1-images-fast") === null && ncTaxableKind("whois") === null && ncTaxableKind("v1-chat-metered") === null, "images, data and chat are not");
ok(isNcBilling({ country: "us", state: "nc" }) && !isNcBilling({ country: "US", state: "VA" }) && !isNcBilling({ country: "CA", state: "NC" }) && !isNcBilling(null), "only a US billing address in NC counts");
ok(Math.abs(taxIncludedPortion(1.0475, NC_STATE_RATE) - 0.0475) < 1e-9, "the tax inside a tax-included amount is gross x rate / (1 + rate)");

const L = createNcTaxLedger({ now: () => Date.parse("2026-11-03T12:00:00Z") });
await L.record({ slug: "tts", grossUsd: 0.05, billing: { country: "US", state: "NC", postal: "27601-1234" } });
await L.record({ slug: "v1-videos", grossUsd: 0.5, billing: { country: "US", state: "NC", postal: "28202" } });
await L.record({ slug: "tts", grossUsd: 0.05, billing: { country: "US", state: "VA", postal: "22201" } });
await L.record({ slug: "whois", grossUsd: 0.005, billing: { country: "US", state: "NC", postal: "27601" } });
await L.record({ slug: "tts", grossUsd: 0.05, billing: { country: "US", state: "NC", postal: null }, at: Date.parse("2026-12-01T00:00:01Z") });
const r = L.report();
ok(Object.keys(r).join() === "2026-11,2026-12", "receipts are grouped by calendar month (UTC)");
ok(r["2026-11"].calls === 2 && Math.abs(r["2026-11"].grossReceiptsUsd - 0.55) < 1e-9, "only NC-billed charges on taxable routes are recorded");
ok(r["2026-11"].byZip["27601"]?.calls === 1 && r["2026-11"].byZip["28202"]?.calls === 1, "receipts are broken down by 5-digit billing ZIP");
ok(Math.abs(r["2026-11"].stateTaxIncludedUsd - taxIncludedPortion(0.55, NC_STATE_RATE)) < 1e-6, "the state tax portion is computed from tax-included gross");
ok(r["2026-12"].byZip.unknown?.calls === 1, "a missing ZIP is kept as unknown, not dropped");

// Every taxable slug is a real catalog route.
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const toolsSrc = ["tools/tts-kit.js", "tools/llm-gateway-kit.js", "tools/dub-kit.js", "tools/llm-images-fast-kit.js"].map(src).join("\n");
for (const slug of Object.keys(NC_TAXABLE_SLUGS)) ok(toolsSrc.includes(`slug: "${slug}"`), `taxable slug ${slug} is a catalog route`);

// Checkout collects the address, and the debit hook hands it to the ledger.
const credits = src("credits.js");
ok(/billing_address_collection: "required"/.test(credits) && /tax_id_collection: \{ enabled: true \}/.test(credits), "credits checkout requires a billing address and offers a tax ID field");
ok((credits.match(/billing: (rec|a)\.billing \|\| null/g) || []).length === 3, "every debit passes the key's billing address");
ok(/if \(ncTaxableKind\(slug\) && isNcBilling\(billing\)\) ncTaxLedger\.record/.test(src("server.js")), "the server records NC taxable debits");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
