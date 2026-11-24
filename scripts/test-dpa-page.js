// /dpa, the Data Processing Addendum (src/dpa.js):
//   - names the controller entity /company names, both roles, the SCC modules
//     (Two and Three) and the UK Addendum by reference, Switzerland;
//   - its sub-processor table is the /trust table plus the mailbox, row for row;
//   - offered on request (binds once confirmed by email), breach notice to the
//     customers we can reach, outside sellers and data sources named as
//     recipients; the change notice is the constant;
//   - every figure it prints is read from the module that runs it;
//   - linked from /privacy and the footer, in the sitemap and llms.txt, dated
//     like the legal pages; no em dashes, no raw hex.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const B = "https://agent402.tools";

const D = await import("../src/dpa.js");
const { trustSubprocessors } = await import("../src/trust-page.js");
const { backupKeepDays } = await import("../src/backup.js");
const html = D.dpaPage(B);
const doc = new JSDOM(html).window.document;
const text = doc.querySelector("main").textContent.replace(/\s+/g, " ");

ok(/last updated \d{4}-\d{2}-\d{2}\./.test(text) && text.includes(`last updated ${D.DPA_DATE}.`), `the page prints its date (${D.DPA_DATE})`);
const { companyPage } = await import("../src/company.js");
const legalName = (companyPage(B).match(/"legalName":"([^"]+)"/) || [])[1];
ok(legalName && text.includes(`${legalName}, doing business as Havok Holdings LLC`), `the processor is the legal entity /company names (${legalName})`);
ok(/you are the controller/.test(text) && /we are your processor/.test(text) && /independent controller/.test(text), "both roles are stated");
ok(/Implementing Decision \(EU\) 2021\/914/.test(text) && /Module Two/.test(text) && /Module Three/.test(text), "the EU Standard Contractual Clauses, Modules Two and Three, by reference");
ok(/International Data Transfer Addendum/.test(text) && /Switzerland/.test(text) && /Federal Act on Data Protection/.test(text), "the UK Addendum and the Swiss adaptation");
ok(/available on request/.test(text) && /from the day we confirm it by email/.test(text) && !/needs no signature/.test(text) && !/for every business customer that uses/.test(text), "the addendum is offered on request, not incorporated for every caller");
ok(/without undue delay/.test(text) && /customers we can identify and reach/.test(text) && !/within \d+ hours/.test(text), "breach notice: without undue delay to customers we can identify and reach, no hour figure a wallet-only caller could not receive");
ok(!/no less protective than these/.test(text) && /Article 28\(3\)/.test(text), "the sub-processor flow-down says what is true: each provider's own terms, chosen to meet Article 28(3)");
ok(/Recipients that are not our sub-processors/.test(text) && /Outside sellers/.test(text) && /decide\/execute/.test(text) && /Data sources/.test(text) && /blockchain node provider/.test(text), "outside sellers and data sources are named as recipients");
ok(/clause 13/.test(text), "an SCC clause 13 supervisory authority is chosen");
ok(!/Cardhavok LLC/.test(readFileSync(new URL("../src/dpa.js", import.meta.url), "utf8")), "the entity name is read from src/legal-entity.js, never typed");
ok(text.includes(`at least ${D.DPA_SUBPROCESSOR_NOTICE_DAYS} days`) && /changelog/.test(text), "sub-processor changes are announced ahead on the changelog");
ok(text.includes(`after ${backupKeepDays()} days`), "the backup period is read from src/backup.js");
{
  const rows = [...doc.querySelectorAll(".dp-table tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent));
  const want = [...trustSubprocessors(), D.DPA_MAILBOX_ROW];
  ok(rows.length === want.length && want.every((s, i) => rows[i][0] === s.category && rows[i][1] === s.name && rows[i][2] === s.gets), `the sub-processor table is the /trust table plus the mailbox (${rows.length} rows)`);
  ok(rows.some((r) => r[1] === "Zoho Mail"), "the mailbox that receives requests is listed");
}
ok(!/—/.test(text) && !/never use it to train a model[^.]*—/.test(text), "no em dash");
ok(!/#[0-9a-fA-F]{3,6}\b/.test(readFileSync(new URL("../src/dpa.js", import.meta.url), "utf8").replace(/&#\d+;/g, "")), "styles use design tokens, no raw hex");
{
  const { privacyPage } = await import("../src/privacy.js");
  const { ledgerFooterCompact } = await import("../src/ledger-chrome.js");
  ok(/href="\/dpa"/.test(privacyPage(B).split("<footer")[0]) || /href="\/dpa">Data Processing Addendum/.test(privacyPage(B)), "/privacy links the addendum");
  ok(/<a href="\/dpa"[^>]*>dpa<\/a>/.test(ledgerFooterCompact()), "the footer links it");
  const seo = await import("../src/seo.js");
  const sm = seo.sitemapPages(B, {});
  ok(/\/dpa/.test(String(await sm)), "the sitemap lists it");
  ok(/\[Data processing addendum\]\(\$\{baseUrl\}\/dpa\)/.test(readFileSync(new URL("../src/seo.js", import.meta.url), "utf8")), "llms.txt lists it");
  const { pageLastmod } = await import("../src/page-dates.js");
  ok(pageLastmod("/dpa") === D.DPA_DATE, `the sitemap's lastmod is the printed date (${pageLastmod("/dpa")})`);
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/app\.get\("\/dpa", \(_req, res\) => htmlCache\(res, 300, 900\)\.send\(dpaPage\(BASE_URL\)\)\);/.test(server), "served at /dpa, cached like the legal pages");
}

console.log(`\ntest-dpa-page: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
