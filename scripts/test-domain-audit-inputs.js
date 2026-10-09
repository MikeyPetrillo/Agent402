#!/usr/bin/env node
// Domain audit inputs, round 2 (2026-08-28, from a buyer's own review of a
// real run): DKIM probed by the MX provider's selectors, DNS-host feasibility
// for CAA/DNSSEC, advisory cross-origin headers, CSP quality, www/apex twin,
// server-header severity, and JSON on the report link. Offline.
import { readFileSync } from "node:fs";
import { PROVIDER_DKIM_SELECTORS, providerForMx } from "../src/tools/network-kit.js";
import { analyzeSecurity, cspQuality } from "../src/tools/network-kit2.js";
import { DNS_HOSTS, dnsHostFor, probeWwwPair, reportMailboxesFrom, dmarcFacts } from "../src/tools/domain-audit-kit.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };

// 1. DKIM selectors follow the MX provider.
ok(providerForMx(["mx01.mail.icloud.com", "mx02.mail.icloud.com"])?.selectors.includes("sig1"), "iCloud MX -> sig1 is probed (the havok.holdings miss)");
ok(providerForMx(["aspmx.l.google.com."])?.provider === "Google Workspace", "trailing dot and Google MX resolve");
ok(providerForMx(["in1-smtp.messagingengine.com"])?.selectors.join() === "fm1,fm2,fm3", "Fastmail -> fm1-3");
ok(providerForMx(["mail.protonmail.ch"])?.selectors[0] === "protonmail", "Proton -> protonmail selectors");
ok(providerForMx(["example-com.mail.protection.outlook.com"])?.provider === "Microsoft 365", "M365 MX matched by suffix");
ok(providerForMx(["mx.unknown-host.example"]) === null && providerForMx([]) === null, "unknown or empty MX -> no provider (common list only)");
ok(PROVIDER_DKIM_SELECTORS.every((p) => p.selectors.every((s) => /^[a-zA-Z0-9._-]+$/.test(s))), "every provider selector is a valid DNS label");

// 2. DNS host feasibility from the nameservers.
ok(dnsHostFor(["ns1.railway.app", "ns2.railway.app"])?.caa === false && dnsHostFor(["ns1.railway.app"])?.dnssec === false, "Railway DNS: CAA and DNSSEC not offered");
ok(dnsHostFor(["ns1.vercel-dns.com"])?.caa === true, "Vercel DNS: CAA supported");
ok(dnsHostFor(["ada.ns.cloudflare.com"])?.dnssec === true, "Cloudflare: DNSSEC supported");
ok(dnsHostFor(["ns-123.awsdns-45.org"])?.host === "Amazon Route 53", "Route 53 matched on the awsdns- infix");
ok(/Name\.com/.test(dnsHostFor(["ns1kpv.name.com"])?.host) && dnsHostFor(["ns1kpv.name.com"])?.caa === null && /Railway/.test(dnsHostFor(["ns1kpv.name.com"])?.note), "name.com nameservers: CAA unknown with the Railway-registration note (the real havok.holdings host)");
ok(dnsHostFor(["ns1.some-registrar.example"]) === null, "unrecognised nameservers -> null (report says: check your host)");
ok(DNS_HOSTS.every((h) => ["boolean", "object"].includes(typeof h.caa) && h.ns.length), "every host row carries a caa verdict (true/false/null) and suffixes");

// 3. Cross-origin headers are advisory, CSP quality is scored.
const base = { "strict-transport-security": "max-age=31536000; includeSubDomains", "content-security-policy": "default-src 'self'; script-src 'self' 'nonce-abc'", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "permissions-policy": "camera=()" };
const full = analyzeSecurity(base);
ok(full.score === 100, `six core headers strict -> 100 (got ${full.score}); COOP/CORP/COEP absence does not penalise`);
ok(full.findings.filter((f) => f.advisory).length === 3 && full.findings.filter((f) => f.advisory).every((f) => !f.present && /advisory/.test(f.note)), "the three cross-origin headers are reported as advisory, not scored");
const weak = analyzeSecurity({ ...base, "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'" });
ok(weak.score < full.score && weak.warnings.some((w) => /unsafe-inline/.test(w)), `a CSP with 'unsafe-inline' scores lower (${weak.score}) and is named in the warnings`);
ok(cspQuality("script-src 'self' 'unsafe-inline' 'nonce-x'")?.strict === true, "unsafe-inline beside a nonce is the standard fallback pattern: strict");
ok(cspQuality("default-src *")?.wildcard === true && cspQuality("") === null, "wildcard sources are permissive; empty CSP -> null");
const ro = analyzeSecurity({ ...base, "content-security-policy": undefined, "content-security-policy-report-only": "default-src 'self'" });
ok(ro.warnings.some((w) => /report-only/.test(w)), "a report-only CSP is named as a first step, not silently a miss");
const srv = analyzeSecurity({ ...base, server: "railway-hikari", "x-powered-by": "Express" });
ok(srv.warnings.some((w) => /^info: Server header/.test(w)) && srv.warnings.some((w) => /X-Powered-By names the framework/.test(w)), "Server header is informational; X-Powered-By stays a removable disclosure");

// 4. www / apex twin.
const twin = await probeWwwPair("example.com", async ({ url }) => ({ url, finalUrl: "https://example.com/", status: 200, security: { findings: [{ header: "HSTS", present: true }] } }));
ok(twin.twin === "www.example.com" && twin.redirectsToOther === true && twin.finalHost === "example.com" && twin.hsts === true, "www twin: redirect to apex and HSTS read from the headers tool");
const dead = await probeWwwPair("www.example.com", async () => { throw new Error("ENOTFOUND"); });
ok(dead.twin === "example.com" && dead.reachable === false && /ENOTFOUND/.test(dead.error), "apex twin of a www domain; unreachable is reported, never thrown");

// 5. Prompt rules and material blocks are in the kit; JSON negotiation on the report links.
const kit = readFileSync(new URL("../src/tools/domain-audit-kit.js", import.meta.url), "utf8");
for (const needle of ["=== NAMESERVERS / DNS HOST", "=== WWW / APEX TWIN", "=== REPORT MAILBOXES", "1. MAILBOXES:", "2. FEASIBILITY:", "3. CAA WITH PLATFORM CERTIFICATES:", "4. CROSS-ORIGIN HEADERS", "7. Escalate safely", "8. Check both hosts"]) ok(kit.includes(needle), `prompt carries "${needle}"`);
const srv2 = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/const wantsJson = \(req\)/.test(srv2) && /app\.get\("\/r\/:sessionId", \(req, res, next\) => \{\s*\/\/[^\n]*\n[^\n]*\n\s*if \(wantsJson\(req\)\)/.test(srv2), "/r/<id> serves the JSON bundle to Accept: application/json");
ok(/app\.get\("\/reports\/public\/:publicId", \(req, res, next\) => \{\s*if \(wantsJson\(req\)\)/.test(srv2) && srv2.includes('rel="alternate"; type="application/json"'), "public report pages negotiate JSON too and carry a Link alternate");
// ---------------------------------------------------------------------------
// Regression: the report crashed on every domain that publishes a DMARC rua.
//
// `reportingUris` is {aggregate, failure}; the mailbox block spread it as an
// array, so `[...(obj || [])]` threw "is not iterable" and the whole $0.60
// report answered 500. It survived a day because the report composites are
// excluded from both catalog sweeps. Hold the SHAPE here, where no upstream and
// no key is needed.
{
  const real = { aggregate: ["mailto:dmarc@github.com"], failure: [] };
  ok(reportMailboxesFrom(real, []).join() === "dmarc@github.com", "a DMARC reportingUris OBJECT yields its aggregate mailbox (the shape that used to throw)");
  ok(reportMailboxesFrom({ aggregate: ["mailto:a@x.com"], failure: ["mailto:b@x.com"] }, []).length === 2, "both rua and ruf mailboxes are read");
  ok(reportMailboxesFrom(["mailto:c@x.com"], []).join() === "c@x.com", "a legacy ARRAY still works (a parser change must not re-break this)");
  ok(reportMailboxesFrom(undefined, undefined).length === 0, "no DMARC and no CAA yields no mailboxes, never a throw");
  ok(reportMailboxesFrom(null, [{ tag: "iodef", value: "mailto:sec@x.com" }, { tag: "issue", value: "letsencrypt.org" }]).join() === "sec@x.com", "a CAA iodef contact is included and a CAA issue row is not");
  ok(reportMailboxesFrom({ aggregate: ["mailto:a@x.com"], failure: ["a@x.com"] }, []).length === 1, "the same mailbox with and without the mailto: prefix is one address");
  let threw = false;
  try { reportMailboxesFrom({ aggregate: ["mailto:a@x.com"] }, { not: "an array" }); } catch { threw = true; }
  ok(!threw, "a malformed CAA value never throws");
}

// An UNMEASURED leg is not an absent record. The corpus caught the live shape
// on 2026-09-18: a resolver timeout on github.com made email-deliverability
// publish spf.hasRecord false, check "fail: No SPF record" and a 75/100 grade,
// i.e. a finding about a domain that nothing had observed (the standalone
// spf-check tool got this right and answered 502). Pinned from SOURCE because
// reproducing a DNS timeout in a unit test would test the resolver, not us.
{
  const net = readFileSync(new URL("../src/tools/network-kit.js", import.meta.url), "utf8");
  for (const leg of ["spf", "dmarc", "mx"]) {
    ok(new RegExp(`check: "${leg}", status: "unknown"`).test(net), `${leg}: a failed lookup is reported unknown, never a missing record`);
  }
  ok(/hasRecord: spfRaw \? true : \(spfTxt\.error \? null : false\)/.test(net), "spf.hasRecord is null when the lookup failed, false only when it answered");
  ok(/hasRecord: dmarcRaw \? true : \(dmarcTxt\.error \? null : false\)/.test(net), "dmarc.hasRecord is null when the lookup failed");
  ok(/const summary = unmeasured\.length \? "partial"/.test(net), "the summary word refuses to grade a partial reading");
  ok((kit.match(/NOT MEASURED \(DNS lookup failed/g) || []).length === 3, "the report prompt says NOT MEASURED for each unmeasured leg rather than MISSING");
}

// ---- DMARC facts: what the record says, apart from what applies by default
{
  const f = dmarcFacts({ raw: "v=DMARC1; p=quarantine; rua=mailto:r@x.test; pct=100", policy: "quarantine", percent: 100, valid: true });
  ok(/tags present: p=quarantine rua=mailto:r@x.test pct=100/.test(f), "the tags the record carries are listed as present");
  ok(/not in the record \(defaults apply\): sp \(not set: subdomains inherit p=quarantine\), aspf \(default r\), adkim \(default r\), fo \(default 0\), ri \(default 86400\)/.test(f), "absent tags are listed as defaults, sp as inheriting p");
  ok(/no ruf tag, so no failure reports are requested/.test(f) && !/ruf=none/.test(f), "an absent ruf is described, never written as ruf=none");
  const g = dmarcFacts({ raw: "v=DMARC1; p=reject; sp=none; aspf=s; ruf=mailto:f@x.test; fo=1", policy: "reject", percent: 100, valid: true });
  ok(/tags present: p=reject sp=none aspf=s ruf=mailto:f@x.test fo=1/.test(g) && /defaults apply\): adkim \(default r\), ri \(default 86400\), pct \(default 100\)$/.test(g), "a record with explicit tags lists only the rest as defaults");
  ok(/record: "v=DMARC1; p=reject; sp=none; aspf=s; ruf=mailto:f@x.test; fo=1"/.test(g), "the raw record rides along verbatim");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
