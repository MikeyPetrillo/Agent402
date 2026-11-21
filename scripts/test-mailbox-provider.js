// email-validate's mailboxProvider field (offline: the MX lookup is a stub).
// The field is read from the MX hosts the tool already looks up: one lookup
// per call, as before, and no other query.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { KIT, _setMxLookupForTest } from "../src/tools/kit.js";
import { mailboxProviderOf, MAILBOX_PROVIDER_TYPES, __mailboxProviders } from "../src/tools/mailbox-provider.js";

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const idOf = (mx, domain) => mailboxProviderOf(mx, domain)?.id ?? null;

// --- the classifier ------------------------------------------------------------
const CASES = [
  [["gmail-smtp-in.l.google.com", "alt1.gmail-smtp-in.l.google.com"], "gmail.com", "google", "hosted"],
  [["aspmx.l.google.com"], "example.org", "google", "hosted"],
  [["mx1.smtp.goog."], "example.org", "google", "hosted"],
  [["example-org.mail.protection.outlook.com"], "example.org", "microsoft", "hosted"],
  [["hotmail-com.olc.protection.outlook.com"], "hotmail.com", "microsoft", "hosted"],
  [["mx.zoho.com", "mx2.zoho.com"], "example.org", "zoho", "hosted"],
  [["mx.zoho.eu"], "example.org", "zoho", "hosted"],
  [["mail.protonmail.ch"], "example.org", "proton", "hosted"],
  [["mta5.am0.yahoodns.net"], "yahoo.com", "yahoo", "hosted"],
  [["mx01.mail.icloud.com"], "icloud.com", "icloud", "hosted"],
  [["in1-smtp.messagingengine.com"], "example.org", "fastmail", "hosted"],
  [["inbound-smtp.us-east-1.amazonaws.com"], "example.org", "amazon", "hosted"],
  [["us-smtp-inbound-1.mimecast.com"], "example.org", "mimecast", "gateway"],
  [["mx0a-00000000.pphosted.com"], "example.org", "proofpoint", "gateway"],
  [["route1.mx.cloudflare.net"], "example.org", "cloudflare", "forwarding"],
  [["mx1.improvmx.com"], "example.org", "improvmx", "forwarding"],
  [["mail.mailinator.com"], "mailinator.com", "disposable", "disposable"],
  [["mx.example-host.net"], "yopmail.com", "disposable", "disposable"],
  [["mail2.mailinator.com"], "my-own-alias.example", "disposable", "disposable"],
  [["mail.example.org"], "example.org", "self-hosted", "self-hosted"],
  [["EXAMPLE.ORG."], "Example.org", "self-hosted", "self-hosted"],
  [["mx.some-small-host.example"], "example.org", "unknown", "unknown"],
];
for (const [mx, domain, id, type] of CASES) {
  const p = mailboxProviderOf(mx, domain);
  ok(p?.id === id && p.type === type && typeof p.name === "string" && p.name.length > 3, `${mx[0]} for ${domain} -> ${id} (${type}) (got ${JSON.stringify(p)})`);
}
ok(mailboxProviderOf([], "example.org") === null && mailboxProviderOf(undefined, "example.org") === null && mailboxProviderOf(["", "."], "example.org") === null, "no MX host -> null, never a provider");
ok(idOf(["mx.notgoogle.com"], "example.org") === "unknown" && idOf(["google.com.evil.example"], "example.org") === "unknown" && idOf(["mxgoogle.com"], "example.org") === "unknown", "a host that merely contains a provider's name is not that provider (whole-label suffix match)");
ok(idOf(["mail.example.org.evil.example"], "example.org") === "unknown", "an MX outside the domain is not self-hosted");
ok(idOf(["mx.backup-host.example", "aspmx.l.google.com"], "example.org") === "google", "a later MX host a table entry matches still names the provider");
ok(idOf(["us-smtp-inbound-1.mimecast.com", "example-org.mail.protection.outlook.com"], "example.org") === "mimecast", "the first matching MX host (lowest priority value) decides");
ok(__mailboxProviders.PROVIDERS.every(([id, name, type, sfx]) => /^[a-z0-9-]+$/.test(id) && name && MAILBOX_PROVIDER_TYPES.includes(type) && sfx.length && sfx.every((x) => x === x.toLowerCase() && !x.startsWith(".") && !x.endsWith("."))), "every table row is well formed");
ok(new Set(__mailboxProviders.PROVIDERS.map((r) => r[0])).size === __mailboxProviders.PROVIDERS.length, "provider ids are unique");
{
  const t0 = Date.now();
  mailboxProviderOf(Array.from({ length: 100_000 }, (_, k) => `mx${k}.${"a".repeat(200)}.example`), "example.org");
  ok(Date.now() - t0 < 500, `a long MX list is read in bounded time (${Date.now() - t0} ms)`);
}

// --- the tool --------------------------------------------------------------------
const tool = KIT.find((t) => t.slug === "email-validate");
let lookups = 0, rows = [];
_setMxLookupForTest(async () => { lookups++; return rows; });
try {
  rows = [{ exchange: "alt1.aspmx.l.google.com", priority: 5 }, { exchange: "aspmx.l.google.com", priority: 1 }];
  const g = await tool.handler({ email: "someone@example.org" });
  ok(g.mailboxProvider?.id === "google" && g.mailboxProvider.name === "Google Workspace / Gmail" && g.mailboxProvider.type === "hosted", `email-validate: the answer names the mailbox provider (${JSON.stringify(g.mailboxProvider)})`);
  ok(g.syntaxValid === true && g.domain === "example.org" && g.deliverableDomain === true && g.mxRecords[0] === "aspmx.l.google.com" && g.email === "someone@example.org", "email-validate: every earlier field is unchanged");
  ok(lookups === 1, `email-validate: the provider is read from the one MX lookup the tool already makes (${lookups} lookup)`);
  rows = [{ exchange: "example-org.mail.protection.outlook.com", priority: 0 }];
  ok((await tool.handler({ email: "a@example.org" })).mailboxProvider.id === "microsoft", "email-validate: Microsoft 365 by its MX");
  rows = [{ exchange: "mx.zoho.com", priority: 10 }];
  ok((await tool.handler({ email: "a@example.org" })).mailboxProvider.id === "zoho", "email-validate: Zoho by its MX");
  rows = [{ exchange: "mail.mailinator.com", priority: 10 }];
  ok((await tool.handler({ email: "a@mailinator.com" })).mailboxProvider.type === "disposable", "email-validate: a throwaway-inbox domain reads disposable");
  rows = [{ exchange: "mail.example.org", priority: 10 }];
  ok((await tool.handler({ email: "a@example.org" })).mailboxProvider.id === "self-hosted", "email-validate: an MX on the domain itself reads self-hosted");
  rows = [{ exchange: "", priority: 0 }];
  const nul = await tool.handler({ email: "a@example.org" });
  ok(nul.mailboxProvider === null && nul.deliverableDomain === false, "email-validate: a null MX has no provider");
  lookups = 0;
  const bad = await tool.handler({ email: "not-an-email" });
  ok(bad.mailboxProvider === null && bad.syntaxValid === false && lookups === 0, "email-validate: bad syntax has no provider and makes no lookup");
  _setMxLookupForTest(async () => { throw Object.assign(new Error("queryMx ENOTFOUND"), { code: "ENOTFOUND" }); });
  ok((await tool.handler({ email: "a@example.org" })).mailboxProvider === null, "email-validate: a failed lookup has no provider");
} finally { _setMxLookupForTest(); }
const ex = tool.discovery.output.example;
ok(ex.mailboxProvider?.id === "google" && JSON.stringify(ex.mailboxProvider) === JSON.stringify(mailboxProviderOf(ex.mxRecords, ex.domain)), "email-validate: the published example shows the field its own MX records give");
ok(/mailboxProvider/.test(tool.description) && tool.price === "$0.001", "email-validate: the description names the field, at the same price");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
