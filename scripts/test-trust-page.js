#!/usr/bin/env node
// /trust and the /company contact block state only what the code runs.
//
//   node scripts/test-trust-page.js          (offline, no server)
//
// Each statement on /trust is pinned to its source here: a provider it names
// must be named in the privacy policy and called from src/, a figure it prints
// must equal the value its module runs, the outside probe's schedule is the
// Worker's cron, the restore suites must sit in a CI lane, and the alarm words
// it quotes must be the ones both pagers read. Change the code without the
// page (or the page without the code) and this fails. It also checks the
// page is reachable (route, footer, /security, /privacy, /company, sitemap,
// page-dates source list, llms.txt) and that /company prints the business
// phone, the legal entity sentence, the postal address from the variable the
// mail footer reads, and only mailboxes the site already uses.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pageText } from "./lib/html-text.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const BASE = "https://agent402.tools";
delete process.env.COMPANY_POSTAL_ADDRESS;
delete process.env.BACKUP_UTC_HOUR;
delete process.env.BACKUP_KEEP_DAYS;
delete process.env.BACKUP_STALE_HOURS;

const { trustPage, trustSubprocessors, hstsYears } = await import("../src/trust-page.js");
const { privacyPage } = await import("../src/privacy.js");
const { securityPage } = await import("../src/security-page.js");
const { companyPage, COMPANY_PHONE, COMPANY_MAILBOXES, LEGAL_ENTITY_SENTENCE } = await import("../src/company.js");
const { ledgerFooterCompact } = await import("../src/ledger-chrome.js");
const { backupKeepDays, backupUtcHour, backupStaleHours, encryptBackupBuffer, decryptBackupBuffer, parseEncKey } = await import("../src/backup.js");
const { IDEM_TTL_MS } = await import("../src/idempotency-store.js");
const { ALWAYS_HEADERS } = await import("../src/security-headers.js");
const { sitemapPages, sitemapXml, llmsFullTxt } = await import("../src/seo.js");
const { PAGE_SOURCES } = await import("../src/page-dates.js");

const trustHtml = trustPage(BASE);
const trust = pageText(trustHtml);
const privacy = pageText(privacyPage(BASE));

// ---- the page renders --------------------------------------------------------
ok(/<title>[^<]*Trust/.test(trustHtml) && /<h1[^>]*>Trust at Agent402\.<\/h1>/.test(trustHtml), "/trust renders with its title and h1");
for (const h of ["Subprocessors", "What we store, and where", "Encryption", "Backups and restore tests", "Incidents and status", "Security reports"]) {
  ok(trust.includes(h), `/trust has the "${h}" section`);
}

// ---- subprocessors: named in the privacy policy, called from src/ -------------
// Every src/*.js and src/tools/*.js file, read once.
const srcFiles = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== "generated") walk(p); } else if (p.endsWith(".js")) srcFiles.push(p); } };
walk(fileURLToPath(new URL("../src", import.meta.url)));
const srcAll = srcFiles.filter((f) => !/\/(privacy|trust-page)\.js$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
// The provider -> a host or marker its client code uses. A provider on the
// page with no entry here fails, so a new row needs its call site named.
const CALL_SITE = {
  Railway: ".railway.internal",
  Stripe: "api.stripe.com",
  ZeptoMail: "api.zeptomail.com",
  Resend: "api.resend.com",
  OpenAI: "api.openai.com",
  OpenRouter: "openrouter.ai/api",
  "Brave Search API": "api.search.brave.com",
  Exa: "api.exa.ai",
  "X API": "api.x.com",
  E2B: "api.e2b.dev",
  TypeSafe: "api.typesafe.ai",
  "Coinbase CDP": "api.cdp.coinbase.com",
  "Tempo's relay": "TEMPO_API_KEY",
  "Tempo's transfer data feed": "api.tempo.xyz",
  "Google Analytics": "googletagmanager.com",
  PostHog: "posthog.com",
  "Circle Gateway": "gateway-api.circle.com",
  // The edge in front of the site: the server reads the client address it sets.
  Cloudflare: "CF-Connecting-IP",
  "direct inference provider": "DIRECT_UPSTREAM_URL",
  "Example Inference": "DIRECT_UPSTREAM_URL",
};
// A provider /trust names ahead of the privacy policy, which waits on an owner
// decision. The entry fails once /privacy names it, so it is removed then.
const subs = trustSubprocessors();
ok(subs.length >= 10, `the subprocessor table lists ${subs.length} rows`);
for (const s of subs) {
  ok(trust.includes(s.name) && trust.includes(s.category), `/trust prints the ${s.category} row (${s.name})`);
  ok(Array.isArray(s.providers) && s.providers.length > 0 && s.providers.every((p) => s.name.includes(p)), `the ${s.category} row names each of its providers (${(s.providers || []).join(", ")})`);
  for (const part of s.providers || []) {
    const site = CALL_SITE[part];
    ok(Boolean(site), `"${part}" has a call site named in this test`);
    if (site) ok(srcAll.includes(site), `"${part}" is called from src/ (${site})`);
    ok(privacy.includes(part), `"${part}" is named in the privacy policy`);
  }
}
ok(subs.some((s) => s.name === "Cloudflare") && /Cloudflare[\s\S]{0,200}IP address/.test(trust), "the network edge in front of the site is a row, with what it sees");
{
  const stripe = subs.find((s) => s.name === "Stripe")?.gets || "";
  ok(/ledger mirror/.test(stripe) && /wallet address, transaction id, amount/.test(stripe) && /optional Stripe ledger mirror[\s\S]*wallet address, transaction id, amount/.test(privacy), "the Stripe row names the optional ledger mirror and its fields, as the privacy policy does");
  const ph = subs.find((s) => s.providers.includes("PostHog"))?.gets || "";
  for (const field of ["paying wallet address", "first word of the caller's User-Agent", "keyed hash of one declared input field", "error message"]) {
    ok(ph.includes(field) && privacy.includes(field), `the PostHog row names the server's service events: ${field} (as /privacy does)`);
  }
}
{
  // The direct inference provider: a row exactly while /privacy names it.
  const KEYS = ["DIRECT_UPSTREAM_URL", "DIRECT_UPSTREAM_KEY", "DIRECT_UPSTREAM_MODELS", "DIRECT_UPSTREAM_NAME"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const direct = () => trustSubprocessors().find((s) => s.category === "AI models (direct)");
  ok(!direct() && !privacy.includes("direct inference provider"), "with the direct upstream off, neither page names a direct inference provider");
  Object.assign(process.env, { DIRECT_UPSTREAM_URL: "https://inference.example.test/v1", DIRECT_UPSTREAM_KEY: "unit", DIRECT_UPSTREAM_MODELS: "a/b=c" });
  delete process.env.DIRECT_UPSTREAM_NAME;
  for (const name of ["", "Example Inference"]) {
    if (name) process.env.DIRECT_UPSTREAM_NAME = name;
    const row = direct(), p = pageText(privacyPage(BASE)), t = pageText(trustPage(BASE));
    const part = row?.providers?.[0] || "";
    ok(Boolean(row) && t.includes(row.name) && p.includes(part) && Boolean(CALL_SITE[part]) && srcAll.includes(CALL_SITE[part]), `with the direct upstream on${name ? " and named" : ""}, /trust has its row and /privacy names it (${part})`);
    ok(/zero data retention/.test(row?.gets || "") && /zero data retention/.test(p), "the direct row states zero data retention, as /privacy does");
  }
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  ok(!direct(), "control: the row leaves with the switch");
}
ok(!srcAll.includes("api.example-provider.invalid") && CALL_SITE.Stripe && srcAll.includes(CALL_SITE.Stripe), "control: the call-site scan finds a real host and not a made-up one");
ok(/outside seller/.test(trust) && /outside seller/.test(privacy), "outside sellers are described by role, as in the privacy policy");

// ---- what we store ------------------------------------------------------------
ok(trust.includes(`cached answers up to ${Math.round(IDEM_TTL_MS / 60000)} minutes`), `the retry cache window is the idempotency store's (${Math.round(IDEM_TTL_MS / 60000)} min)`);
ok(/for one hour, or 24 hours for the per-client daily allowance/.test(privacy) && trust.includes("one hour, or 24 hours for the free trial's daily allowance"), "counter windows match the privacy policy");
ok(/An entry is removed only\s*\n?\/\/ after its database write committed/.test(src("src/ledger-journal-redis.js")) && trust.includes("until its database write commits"), "a journaled money record lives until its database write commits (src/ledger-journal-redis.js)");
ok(trust.includes(`A nightly copy of the state database ${backupKeepDays()} days`) || new RegExp(`nightly copy of the state database\\s+${backupKeepDays()} days`).test(trust), `backup retention on /trust is backupKeepDays() (${backupKeepDays()})`);
ok(privacy.includes(`deleted after ${backupKeepDays()} days`), "the privacy policy states the same backup retention");

ok(trust.includes("Backups (separate object storage)") && !/offsite/i.test(trust) && privacy.includes("object storage"), "backups are named as separate object storage, consistent with the hosting row and /privacy");

// ---- encryption -----------------------------------------------------------------
const hsts = (ALWAYS_HEADERS.find(([k]) => k === "Strict-Transport-Security") || [])[1];
ok(/max-age=\d+; includeSubDomains; preload/.test(hsts || ""), `every answer's HSTS header carries includeSubDomains and preload (${hsts})`);
ok(/for \(const \[name, value\] of ALWAYS_HEADERS\) res\.setHeader\(name, value\);/.test(src("src/security-headers.js")), "the middleware sets ALWAYS_HEADERS on every answer");
ok(trust.includes(`Strict-Transport-Security: ${hsts}`), "/trust quotes the HSTS header exactly");
ok(hstsYears() === 2 && /for two years/.test(trust), `/trust's HSTS lifetime is the header's (${hstsYears()} years)`);
{
  const key = parseEncKey("ab".repeat(32));
  const enc = encryptBackupBuffer(Buffer.from("row"), key);
  ok(enc.subarray(0, 8).toString() === "A402ENC1" && decryptBackupBuffer(enc, key).toString() === "row", "backup objects encrypt and decrypt with the AES-256-GCM envelope");
  ok(/createCipheriv\("aes-256-gcm"/.test(src("src/backup.js")) && trust.includes("AES-256-GCM"), "/trust names the cipher src/backup.js uses");
}
{
  // The emailed report link (/r/<checkout session>) is not signed: the HMAC claim is scoped as /security scopes it.
  const scope = "Links we email (confirmations, unsubscribes, monitor management) are HMAC-signed";
  ok(trust.includes(scope) && pageText(securityPage(BASE)).includes(scope) && !/the links we email are HMAC-signed/i.test(trust), "the HMAC claim on /trust carries the scope /security states");
  ok(/\/r\/\$\{/.test(src("src/human-checkout.js")), "control: the report link is a bare /r/<session> path");
}
ok(/if \(keyState === "unset" && backupProduction\(\)\) return "unencrypted";/.test(src("src/backup.js")), "the backup word reads unencrypted in production without a key");

// ---- backups and restore tests ---------------------------------------------------
ok(backupUtcHour() === 4 && trust.includes("starting at 04:00 UTC"), "the nightly hour on /trust is backupUtcHour()");
ok(/now\.getUTCHours\(\) !== cfg\(\)\.utcHour/.test(src("src/backup.js")), "the scheduler runs in that hour");
ok(backupStaleHours() === 26 && trust.includes(`no run has succeeded in ${backupStaleHours()} hours`), "the stale threshold on /trust is backupStaleHours()");
ok(/const staleMs = backupStaleHours\(\) \* 3600_000;/.test(src("src/backup.js")), "backupAlarmStatus reads the same stale threshold");
{
  const worker = src("workers/status-probe/src/index.js"), hb = src(".github/workflows/heartbeat.yml");
  const bad = (worker.match(/const BACKUP_BAD = new Set\(\[([^\]]*)\]\)/) || [])[1] || "";
  for (const w of ["stale", "failed", "held", "unencrypted"]) {
    ok(bad.includes(`"${w}"`) && new RegExp(`held\\|failed\\|stale\\|unencrypted`).test(hb), `both observers page on backup=${w}`);
  }
}
{
  const deploy = src(".github/workflows/deploy.yml");
  ok(/^\s+t node scripts\/test-backup-restore\.js$/m.test(deploy), "the object restore test runs in a CI lane");
  ok(/^\s+t node scripts\/test-backup-state\.js$/m.test(deploy) && /state-restore/.test(src("scripts/test-backup-state.js")), "the state-table restore test runs in a CI lane and drives scripts/state-restore.js");
}

// ---- incidents and status ---------------------------------------------------------
ok(/crons = \["\*\/5 \* \* \* \*"\]/.test(src("workers/status-probe/wrangler.toml")) && trust.includes("an outside probe that runs every five minutes"), "the outside probe's five-minute schedule is the Worker's cron");
ok(/refundsOwed: await/.test(src("src/server.js")) && /if \(w === "owed" \|\| w === "aging" \|\| w === "stuck"\) return "bad";/.test(src("workers/status-probe/src/index.js")), "refundsOwed is a gateway-status word the status Worker pages on");
ok(/export function receiptProvesCharge/.test(src("src/refund-ledger.js")) && /repaid only after the charge is proven on chain/.test(trust), "refunds wait for on-chain proof (src/refund-ledger.js)");
ok(/workflow_dispatch:/.test(src(".github/workflows/refund.yml")), "the refund run is dispatched by hand");

// ---- security reports ----------------------------------------------------------------
ok(/acknowledgement within two business days/.test(src("SECURITY.md")) && trust.includes("acknowledge within two business days"), "the acknowledgement window matches SECURITY.md");
ok(/node scripts\/advisory-triage-check\.js/.test(src(".github/workflows/heartbeat.yml")), "the heartbeat checks reports waiting in triage");

// ---- every internal link on /trust is a served route --------------------------------
{
  const server = src("src/server.js");
  // The page's own content: from its h1 to the shared footer (the nav and footer have their own tests).
  const content = trustHtml.slice(trustHtml.indexOf("Trust at Agent402."), trustHtml.indexOf("<footer"));
  const hrefs = [...content.matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1]).filter((h) => !h.startsWith("//"));
  const missing = [...new Set(hrefs)].filter((h) => h !== "/" && !server.includes(`app.get("${h}"`) && !server.includes(`"${h}"`));
  ok(hrefs.length > 5 && missing.length === 0, `every internal link on /trust is a route (${missing.join(", ") || "all served"})`);
}

// ---- reachability ----------------------------------------------------------------------
ok(/app\.get\("\/trust", /.test(src("src/server.js")), "server.js serves /trust");
ok(ledgerFooterCompact().includes('href="/trust"'), "the footer links /trust");
// The page's own body, before the shared footer (which links /trust on every page).
const ownBody = (html) => html.slice(0, html.indexOf("<footer"));
ok(!ownBody("<p>x</p>" + ledgerFooterCompact()).includes('href="/trust"') && ownBody('<p><a href="/trust">t</a></p>' + ledgerFooterCompact()).includes('href="/trust"'), "control: the body slice leaves the footer's link out");
ok(ownBody(securityPage(BASE)).includes('href="/trust"'), "/security links /trust in its own text");
ok(ownBody(privacyPage(BASE)).includes('href="/trust"'), "/privacy links /trust in its own text");
ok(ownBody(companyPage(BASE)).includes('href="/trust"'), "/company links /trust in its own text");
ok(sitemapPages(BASE, {}).includes(`<loc>${BASE}/trust</loc>`) && sitemapXml(BASE, {}).includes(`<loc>${BASE}/trust</loc>`), "both sitemaps list /trust");
ok(JSON.stringify(PAGE_SOURCES["/trust"]) === JSON.stringify(["src/trust-page.js"]), "page-dates dates /trust from its module");
ok(llmsFullTxt(BASE, {}).includes(`(${BASE}/trust)`), "llms-full.txt lists /trust beside /security and /company");

// ---- /company contact block -----------------------------------------------------------
{
  const html = companyPage(BASE), text = pageText(html);
  ok(text.includes(COMPANY_PHONE.display) && html.includes(`href="tel:${COMPANY_PHONE.tel}"`), "/company prints the business phone with a tel link");
  ok(COMPANY_PHONE.tel.replace(/\D/g, "").endsWith(COMPANY_PHONE.display.replace(/\D/g, "")), "the tel link dials the printed number");
  ok(LEGAL_ENTITY_SENTENCE === "Cardhavok LLC (doing business as Havok Holdings LLC)" && text.includes(LEGAL_ENTITY_SENTENCE), "/company states the legal entity sentence");
  ok(/© 2026 /.test(pageText(ledgerFooterCompact())) && pageText(ledgerFooterCompact()).includes("Havok Holdings LLC"), "the brand credit stays Havok Holdings LLC");
  for (const role of ["Email", "Security", "Partnerships and investors", "Phone"]) ok(new RegExp(`<th scope="row">${role}</th>`).test(html), `/company lists the ${role} contact`);
  {
    // One email row names every role the operator mailbox answers, so the address is printed once in the table.
    const table = (html.match(/<table class="co-contacts"[\s\S]*?<\/table>/) || [""])[0];
    ok((table.match(/mailto:mike@agent402\.tools/g) || []).length === 1 && /Support, billing and refunds, legal and abuse/.test(table), "/company prints the operator mailbox once, with the roles it answers");
    ok((pageText(html).match(/mike@agent402\.tools/g) || []).length === 1, "/company shows the operator mailbox as text once (the contact table); the form and the footer link to it without repeating it");
  }
  ok(!/<th scope="row">Mail<\/th>/.test(html), "with COMPANY_POSTAL_ADDRESS unset, no postal row is printed");
  // Every role reads one of the two existing mailboxes: no invented addresses.
  const boxes = [...new Set([...html.matchAll(/mailto:([^"?]+)/g)].map((m) => m[1]))].sort();
  ok(JSON.stringify(boxes) === JSON.stringify(Object.values(COMPANY_MAILBOXES).sort()), `/company prints exactly the two existing mailboxes (${boxes.length})`);
  const others = ["src/privacy.js", "src/security-page.js", "SECURITY.md"].map(src).join("\n");
  ok(others.includes(`mailto:${COMPANY_MAILBOXES.operator}`) || others.includes(COMPANY_MAILBOXES.operator), "the operator mailbox is the one /privacy, /security and SECURITY.md already name");
  ok(/"@type": "ContactPoint", contactType: "billing support"/.test(src("src/company.js")) && html.includes('"telephone":"+17043138483"'), "the JSON-LD carries the billing contact and the phone");
  process.env.COMPANY_POSTAL_ADDRESS = "Havok Holdings LLC\nPO Box 65\nSample Town, NC 00000";
  const withPostal = companyPage(BASE);
  ok(/<th scope="row">Mail<\/th><td>Havok Holdings LLC, PO Box 65, Sample Town, NC 00000<\/td>/.test(withPostal), "/company prints COMPANY_POSTAL_ADDRESS as one line, the value the mail footer appends");
  const { postalAddress } = await import("../src/email.js");
  ok(postalAddress().replace(/\s*\n\s*/g, ", ") === "Havok Holdings LLC, PO Box 65, Sample Town, NC 00000", "the mail footer reads the same variable");
  delete process.env.COMPANY_POSTAL_ADDRESS;
}

// /privacy covers /scorecard, and its sample-transaction sentence follows SCORECARD_PUBLISH_TX
{
  const prev = process.env.SCORECARD_PUBLISH_TX;
  delete process.env.SCORECARD_PUBLISH_TX;
  const off = pageText(privacyPage(BASE));
  process.env.SCORECARD_PUBLISH_TX = "on";
  const on = pageText(privacyPage(BASE));
  if (prev === undefined) delete process.env.SCORECARD_PUBLISH_TX; else process.env.SCORECARD_PUBLISH_TX = prev;
  ok(/buyer scorecard[\s\S]{0,200}monthly[\s\S]{0,120}counts only[\s\S]{0,200}never a wallet\s+address/.test(off), "/privacy says the scorecard publishes monthly counts only, never a wallet address");
  ok(!/sample settlement transactions/.test(off), "/privacy names no scorecard transaction links while SCORECARD_PUBLISH_TX is off");
  ok(/sample settlement transactions[\s\S]{0,120}paying wallet/.test(on), "/privacy says the scorecard links sample transactions that show the payer while SCORECARD_PUBLISH_TX is on");
  ok(/Cloudflare[\s\S]{0,200}IP address/.test(off), "/privacy names Cloudflare and what it sees");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
