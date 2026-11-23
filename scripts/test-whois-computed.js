// whois answers what is computed from the registry's RDAP record, not the
// record: registered, ageDays, daysToExpiry, dnssec and transferLocked. The
// record's own fields keep their keys and read null, and no value of the
// record (registrar name, dates, status codes, nameservers) appears in the
// answer. Lookups share the per-registry pacing and daily ceiling with
// domain-availability, and a lookup our own ceiling refuses is never sent to
// the redirector in its place. Offline: the global fetch is stubbed.
//
//   node scripts/test-whois-computed.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)

process.env.RDAP_REGISTRY_DAILY_MAX = "3";
const { KIT, whoisAnswerOf, WHOIS_NOTE } = await import("../src/tools/kit.js");
const { registryLimits } = await import("../src/tools/rdap-registry-limits.js");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

const NOW = Date.parse("2026-11-23T12:00:00Z");
const RECORD = {
  objectClassName: "domain",
  ldhName: "taken.test",
  status: ["client transfer prohibited", "client delete prohibited"],
  events: [
    { eventAction: "registration", eventDate: "2016-11-23T12:00:00Z" },
    { eventAction: "expiration", eventDate: "2027-01-22T12:00:00Z" },
    { eventAction: "last changed", eventDate: "2026-01-02T00:00:00Z" },
  ],
  secureDNS: { delegationSigned: true },
  nameservers: [{ ldhName: "NS1.RECORDHOST.TEST" }],
  entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Record Registrar Inc"]]] }],
};

// ---- the computed answer ----
{
  const a = whoisAnswerOf("taken.test", RECORD, NOW);
  ok(a.registered === true && a.ageDays === 3652 && a.daysToExpiry === 60, `age and days to expiry are counted from the record's dates (${a.ageDays}, ${a.daysToExpiry})`);
  ok(a.dnssec === true && a.transferLocked === true, "dnssec and the transfer lock are read from the record's flags");
  for (const k of ["registrar", "created", "updated", "expires", "status", "nameservers"]) ok(k in a && a[k] === null, `"${k}" keeps its key and reads null`);
  const text = JSON.stringify(a);
  for (const v of ["Record Registrar", "2016-11-23", "2027-01-22", "2026-01-02", "client transfer prohibited", "recordhost"]) ok(!text.toLowerCase().includes(v.toLowerCase()), `no record value is copied (${v})`);
  ok(a.source === "RDAP" && a.checkedAt === new Date(NOW).toISOString() && a.note === WHOIS_NOTE, "source, checkedAt and the note are stated");
  const bare = whoisAnswerOf("bare.test", { objectClassName: "domain" }, NOW);
  ok(bare.ageDays === null && bare.daysToExpiry === null && bare.dnssec === null && bare.transferLocked === null, "a record without dates or flags reads null, never a guess");
  const epp = whoisAnswerOf("epp.test", { status: ["serverTransferProhibited"], secureDNS: { delegationSigned: false } }, NOW);
  ok(epp.transferLocked === true && epp.dnssec === false, "EPP-style status codes are read too; an unsigned delegation is false");
  ok(whoisAnswerOf("open.test", { status: ["active"] }, NOW).transferLocked === false, "no transfer-prohibited code reads unlocked");
  ok(whoisAnswerOf("past.test", { events: [{ eventAction: "expiration", eventDate: "2026-11-01T12:00:00Z" }] }, NOW).daysToExpiry === -22, "an expiry in the past is a negative count");
}

// ---- the handler, the catalog entry and the shared limits ----
const tool = KIT.find((t) => t.slug === "whois");
const realFetch = globalThis.fetch;
const asked = [];
globalThis.fetch = async (input) => {
  const u = new URL(String(input));
  asked.push(u.host + u.pathname);
  if (u.host === "data.iana.org") return new Response(JSON.stringify({ services: [[["test"], ["https://rdap.registry.test/"]]] }), { status: 200, headers: { "content-type": "application/json" } });
  if (u.host === "rdap.registry.test" && u.pathname.startsWith("/domain/")) return new Response(JSON.stringify({ ...RECORD, ldhName: u.pathname.slice(8) }), { status: 200, headers: { "content-type": "application/rdap+json" } });
  throw new Error(`unexpected fetch ${u.host}`);
};
try {
  const a = await tool.handler({ domain: "taken.test" });
  ok(a.registered === true && Number.isInteger(a.ageDays) && a.registrar === null && a.nameservers === null, "the handler answers the computed shape");
  ok(!JSON.stringify(a).includes("Record Registrar"), "the handler copies no record value");
  ok(registryLimits._count("rdap.registry.test") === 1, `the lookup took a place in the registry's daily count (${registryLimits._count("rdap.registry.test")})`);
  await tool.handler({ domain: "second.test" });
  await tool.handler({ domain: "third.test" });
  asked.length = 0;
  const e = await errOf(tool.handler({ domain: "fourth.test" }));
  ok(e?.statusCode === 503 && e.attribution === "ours" && /daily limit/.test(e.message), `past the registry's daily ceiling whois answers our own 503 (${e?.statusCode} ${e?.message})`);
  ok(asked.length === 0, `nothing was sent, the redirector included (${asked.join(", ")})`);
} finally {
  globalThis.fetch = realFetch;
}

{
  const ex = tool.discovery.output.example;
  for (const k of ["domain", "registrar", "created", "expires", "nameservers", "status"]) ok(k in ex, `the published example keeps "${k}"`);
  ok(ex.registered === true && Number.isInteger(ex.ageDays) && Number.isInteger(ex.daysToExpiry) && typeof ex.dnssec === "boolean" && ex.registrar === null, "the published example shows the computed fields");
  ok(/computed/.test(tool.description) && /read null/.test(tool.description) && /daily limit/.test(tool.description) && !/registrar, creation\/expiry dates, status, nameservers\.$/.test(tool.description), "the description says the answer is computed and the record fields read null");
  ok(tool.endsAtCeiling === true, "whois still ends at a run's ceiling (marked)");
}

// The synthetic monitor reads the computed age, not the nameserver list.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/selfcheck.js", import.meta.url), "utf8");
  ok(/"whois": \(r\) => [^\n]*ageDays/.test(src) && !/"whois": \(r\) => [^\n]*nameservers/.test(src), "the selfcheck predicate reads ageDays");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
