// The shared internal-name filter (src/tools/dns-name-filter.js) and every
// caller-chosen DNS lookup in src/tools that runs through it. The resolver is
// instrumented so a refused name is proven to be refused BEFORE any query, and
// a control name proves the instrumented path is the one that queries. No
// network: every resolver call is answered by the stub.
//
//   node scripts/test-dns-name-filter.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import dns from "node:dns";
import dnsP from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- resolver stubs (installed before the kits load) ------------------------------
const queried = [];
const canned = new Map(); // name -> the records the stub answers with
const answer = async (name) => { queried.push(String(name)); if (canned.has(String(name))) return canned.get(String(name)); const e = new Error("stub"); e.code = "ENOTFOUND"; throw e; };
dns.promises.resolve = answer; dns.promises.lookup = answer; dns.promises.resolveTxt = answer;
dns.promises.resolveMx = answer; dns.promises.resolveNs = answer; dns.promises.resolveCaa = answer;
dnsP.Resolver.prototype.resolve = answer;
dnsP.Resolver.prototype.resolve4 = answer; dnsP.Resolver.prototype.resolve6 = answer; // the address guard
dnsP.lookup = answer; dnsP.resolveMx = answer;
syncBuiltinESMExports();

const { internalNameReason, assertQueryableName, canonicalDnsName } = await import("../src/tools/dns-name-filter.js");
const { dnsLookup } = await import("../src/tools/dns.js");
const { NETWORK_TOOLS } = await import("../src/tools/network-kit.js");
const { NETWORK_TOOLS2 } = await import("../src/tools/network-kit2.js");
const { KIT } = await import("../src/tools/kit.js");
const { normDomain, probeDnsPosture } = await import("../src/tools/domain-audit-kit.js");
const { assertPublicUrl, UNRESOLVED_OR_PRIVATE } = await import("../src/tools/fetch-guard.js");

// --- the filter itself --------------------------------------------------------------
const refused = [
  "db.internal", "db.internal.", "printer.local", "localhost", "x.localhost.", "box.localdomain", "nas.home.arpa",
  "intranet", "intranet.",
  "1.0.0.10.in-addr.arpa", "10.in-addr.arpa", "5.16.172.in-addr.arpa.", "1.168.192.in-addr.arpa", "1.0.0.127.in-addr.arpa",
  "1.254.169.in-addr.arpa", "1.64.100.in-addr.arpa", "1.127.100.in-addr.arpa",
  "1." + "0.".repeat(31) + "ip6.arpa", // ::1
  "d.f.ip6.arpa", "c.f.ip6.arpa", "8.e.f.ip6.arpa", "b.e.f.ip6.arpa",
];
for (const n of refused) ok(internalNameReason(n) !== null, `refused: ${n}`);
const allowed = ["example.com", "example.com.", "8.8.8.8.in-addr.arpa", "1.32.172.in-addr.arpa", "172.in-addr.arpa", "1.63.100.in-addr.arpa", "8.b.d.0.1.0.0.2.ip6.arpa", "f.ip6.arpa", "_dmarc.example.com"];
for (const n of allowed) ok(internalNameReason(n) === null, `allowed: ${n}`);
let threw = null;
try { assertQueryableName("x.internal"); } catch (e) { threw = e; }
ok(threw?.statusCode === 400, "assertQueryableName throws a 400");

// --- one name: every spelling a resolver reads as an internal name is judged as that name ---
// (What a resolver puts on the wire for each was read from a local stub
// server: a trailing dot is the root, case is ignored, a name written outside
// ASCII is mapped to ASCII first, and a backslash is an escape.)
const spellings = [
  "db.internal..", "db.internal...", "redis..", "redis...", ".redis", "..redis", "DB.INTERNAL", "Printer.Local.", " db.internal ", "\tdb.internal.\n",
  "db..internal", ".db.internal", "x.home..arpa", "1.0.0.10..in-addr.arpa", "1.0.0.10.IN-ADDR.ARPA..",
  "db.intern\\097l", "db\\.internal", "redis\\.", // a resolver's escapes
  "\uff44\uff42.internal", "db\u3002internal", "x.db\u3002internal", "db.internal\u3002", "db.\u24d8nternal", "db.internal\u200b", "db.inter\u00adnal", "x.\uff2c\uff2f\uff23\uff21\uff2c", // mapped to ASCII by the resolver
  "evil.example@\uff44\uff42.internal", "b\u00fccher.example/x.internal", "", " ", "...",
];
for (const n of spellings) ok(internalNameReason(n) !== null, `refused in every spelling: ${JSON.stringify(n)}`);
const canon = [["example.com.", "example.com"], ["Example.COM..", "example.com"], [" example.com ", "example.com"], ["b\u00fccher.example", "xn--bcher-kva.example"], ["xn--bcher-kva.example", "xn--bcher-kva.example"], ["_dmarc.Example.com", "_dmarc.example.com"]];
for (const [n, want] of canon) {
  let got = null; try { got = assertQueryableName(n); } catch (e) { got = `threw ${e.message}`; }
  ok(got === want && canonicalDnsName(got) === got && internalNameReason(got) === null, `(control) ${JSON.stringify(n)} is allowed and queried as ${want} (${got})`);
}
{
  const t0 = Date.now();
  internalNameReason(`${".".repeat(200_000)}x`); internalNameReason(`x${".".repeat(200_000)}`); internalNameReason("a.".repeat(100_000));
  ok(Date.now() - t0 < 500, `a long run of dots is judged in bounded time (${Date.now() - t0} ms)`);
}

// --- every caller refuses before the query ---------------------------------------------
const tool = (list, slug) => list.find((t) => t.slug === slug);
async function refusesBeforeQuery(label, fn) {
  const before = queried.length;
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  ok(err?.statusCode === 400 && queried.length === before, `${label}: refused 400 with no query (status ${err?.statusCode}, queries ${queried.length - before})`);
}
async function queries(label, fn) {
  const before = queried.length;
  try { await fn(); } catch { /* the stub answers NXDOMAIN */ }
  ok(queried.length > before, `${label}: (control) a public name reaches the resolver`);
}

await refusesBeforeQuery("dns (GET /api/dns)", () => dnsLookup("db.internal.", "A"));
await refusesBeforeQuery("dns, single label", () => dnsLookup("intranet", "A"));
await queries("dns", () => dnsLookup("example.com", "A"));
// The name asked for is the name judged, whatever the spelling.
/** Runs fn, then: it queried exactly `want` (and nothing else). */
async function queriesExactly(label, want, fn) {
  const before = queried.length;
  try { await fn(); } catch { /* the stub answers NXDOMAIN */ }
  const got = queried.slice(before);
  ok(got.length > 0 && got.every((q) => want.includes(q)), `${label}: (control) asks the resolver for ${want.join(" / ")} (${JSON.stringify([...new Set(got)])})`);
}
const dnsRoute = tool(NETWORK_TOOLS, "dns");
for (const n of ["db.internal..", "db.internal...", "redis..", "redis.", ".redis", "DB.Internal..", " db.internal.. ", "db..internal"]) {
  await refusesBeforeQuery(`dns refuses ${JSON.stringify(n)}`, () => dnsLookup(n, "A"));
  await refusesBeforeQuery(`the dns route refuses ${JSON.stringify(n)}`, () => dnsRoute.handler({ name: n }));
}
for (const n of ["db.intern\\097l", "\uff44\uff42.internal", "x.db\u3002internal"]) await refusesBeforeQuery(`dns refuses ${JSON.stringify(n)}`, () => dnsLookup(n, "A"));
await queriesExactly("dns, one trailing dot", ["example.com"], () => dnsLookup("example.com.", "A"));
await queriesExactly("the dns route, one trailing dot", ["example.com"], () => dnsRoute.handler({ name: "example.com." }));
await queriesExactly("dns, mixed case", ["example.com"], () => dnsLookup("Example.COM", "TXT"));
{
  canned.set("example.com", ["93.184.215.14"]);
  const r = await dnsLookup("example.com.", "A");
  canned.delete("example.com");
  ok(r.name === "example.com" && r.records.length === 1, `(control) a public name with one trailing dot still resolves, under the name that was asked (${JSON.stringify(r)})`);
}

const dnsTool = tool(NETWORK_TOOLS, "dns-lookup");
await refusesBeforeQuery("dns-lookup, trailing dot", () => dnsTool.handler({ host: "db.internal." }));
await refusesBeforeQuery("dns-lookup, private PTR", () => dnsTool.handler({ host: "1.0.0.10.in-addr.arpa", type: "PTR" }));
await queries("dns-lookup", () => dnsTool.handler({ host: "example.com" }));
for (const slug of ["dns-propagation", "spf-check", "dmarc-check", "email-deliverability"]) {
  await refusesBeforeQuery(slug, () => tool(NETWORK_TOOLS, slug).handler({ domain: "corp.internal" }));
}
await refusesBeforeQuery("dkim-lookup", () => tool(NETWORK_TOOLS, "dkim-lookup").handler({ domain: "corp.internal", selector: "s1" }));

const asn = tool(NETWORK_TOOLS2, "asn-info");
await refusesBeforeQuery("asn-info (host)", () => asn.handler({ host: "db.internal" }));
// network-kit2 reads a host the way network-kit does: a name its rule refuses
// never reaches the resolver or the upstream, and the handler keeps its own 400.
const badHosts = ["a..example.com", "-lead.example.com", `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.com`, "exa_mple.com"];
for (const h of badHosts) await refusesBeforeQuery(`asn-info refuses host ${h.slice(0, 24)}`, () => asn.handler({ host: h }));
await queries("asn-info", () => asn.handler({ host: "example.com" }));
{
  const ct = tool(NETWORK_TOOLS2, "cert-transparency");
  const tech = tool(NETWORK_TOOLS2, "tech-stack");
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error("stub: no network"); };
  const refusesBeforeFetch = async (label, fn, msg) => {
    const before = fetched + queried.length;
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    ok(err?.statusCode === 400 && (!msg || msg.test(err.message)) && fetched + queried.length === before, `${label}: refused 400 before any request (status ${err?.statusCode}: ${err?.message})`);
  };
  for (const h of badHosts) await refusesBeforeFetch(`cert-transparency refuses ${h.slice(0, 24)}`, () => ct.handler({ domain: h }), /^"domain" is not a valid host name/);
  await refusesBeforeFetch("cert-transparency with no domain says it is missing", () => ct.handler({}), /^Missing "domain"/);
  await refusesBeforeFetch("cert-transparency refuses an internal zone", () => ct.handler({ domain: "corp.internal" }));
  await refusesBeforeFetch("cert-transparency refuses an internal URL host", () => ct.handler({ url: "https://db.internal/x" }));
  await refusesBeforeFetch("tech-stack with no url", () => tech.handler({}), /^Missing "url"/);
  await refusesBeforeFetch("tech-stack refuses a non-http scheme", () => tech.handler({ url: "file:///etc/passwd" }));
  globalThis.fetch = realFetch;
}

const emailVerify = KIT.find((t) => t.slug === "email-validate");
if (emailVerify) await refusesBeforeQuery("email-validate", () => emailVerify.handler({ email: "a@corp.internal" }));
else ok(false, "email-validate tool found");
const tls = KIT.find((t) => t.slug === "tls-cert");
await refusesBeforeQuery("tls-cert", () => tls.handler({ host: "db.internal" }));

await refusesBeforeQuery("domain-audit normDomain", () => normDomain({ domain: "corp.home.arpa" }));
await refusesBeforeQuery("domain-audit DNS posture", () => probeDnsPosture("corp.internal"));

// --- every caller asks for the name it judged, in every spelling ---------------------------
for (const h of ["db.internal..", "DB.Internal..", "redis..", ".redis"]) {
  await refusesBeforeQuery(`dns-lookup refuses ${JSON.stringify(h)}`, () => dnsTool.handler({ host: h }));
  await refusesBeforeQuery(`dns-propagation refuses ${JSON.stringify(h)}`, () => tool(NETWORK_TOOLS, "dns-propagation").handler({ domain: h }));
  await refusesBeforeQuery(`spf-check refuses ${JSON.stringify(h)}`, () => tool(NETWORK_TOOLS, "spf-check").handler({ domain: h }));
  await refusesBeforeQuery(`asn-info refuses ${JSON.stringify(h)}`, () => asn.handler({ host: h }));
  await refusesBeforeQuery(`tls-cert refuses ${JSON.stringify(h)}`, () => tls.handler({ host: h }));
}
await refusesBeforeQuery("dns-lookup refuses a URL whose host is an internal name written outside ASCII", () => dnsTool.handler({ url: "https://\uff44\uff42.internal../x" }));
for (const e of ["a@db.internal..", "a@DB.Internal.", "a@x.db\u3002internal", "a@db.internal\u3002", "a@db.inter\u00adnal"]) await refusesBeforeQuery(`email-validate refuses ${JSON.stringify(e)}`, () => emailVerify.handler({ email: e }));
{
  // A domain with no canonical form (a resolver's escape) is asked of no
  // resolver, and the answer is still the tool's own: not deliverable.
  const before = queried.length;
  let r = null, err = null;
  try { r = await emailVerify.handler({ email: "a@db.intern\\097l" }); } catch (e) { err = e; }
  ok(!err && r?.deliverableDomain === false && queried.length === before, `email-validate asks no resolver for a domain written with an escape (${err?.message || JSON.stringify(r)}, queries ${queried.length - before})`);
}
await queriesExactly("email-validate, one trailing dot", ["example.com"], () => emailVerify.handler({ email: "someone@Example.com." }));
await queriesExactly("tls-cert, one trailing dot", ["example.com"], () => tls.handler({ host: "Example.com." }));
await refusesBeforeQuery("domain-audit DNS posture, two trailing dots", () => probeDnsPosture("corp.internal.."));
await queriesExactly("domain-audit DNS posture, one trailing dot", ["example.com", "_mta-sts.example.com", "_smtp._tls.example.com", "default._bimi.example.com"], async () => { const f = globalThis.fetch; globalThis.fetch = async () => { throw new Error("stub: no network"); }; try { await probeDnsPosture("Example.com."); } finally { globalThis.fetch = f; } });
{
  // A name inside a record someone else published (an SPF include) is judged
  // and asked for the same way.
  const spf = tool(NETWORK_TOOLS, "spf-check");
  canned.set("spf-a.example", [["v=spf1 include:db.internal.. ~all"]]);
  canned.set("spf-b.example", [["v=spf1 include:db.intern\\097l include:_spf.Example.com. ~all"]]);
  let before = queried.length, err = null, r = null;
  try { await spf.handler({ domain: "spf-a.example" }); } catch (e) { err = e; }
  ok(err?.statusCode === 400 && queried.slice(before).every((q) => q === "spf-a.example"), `spf-check: an include target that is an internal name with two trailing dots is refused before its query (status ${err?.statusCode}, asked ${JSON.stringify(queried.slice(before))})`);
  before = queried.length; err = null;
  try { r = await spf.handler({ domain: "spf-b.example" }); } catch (e) { err = e; }
  const asked = queried.slice(before);
  ok(!err && r?.hasRecord === true && asked.includes("_spf.example.com") && asked.every((q) => q === "spf-b.example" || q === "_spf.example.com"), `spf-check: an include target written with an escape is asked of no resolver, and the check still answers (${err?.message || "answered"}, asked ${JSON.stringify(asked)})`);
  canned.clear();
}
// The whole run: nothing reached the resolver stub that the filter would not
// allow exactly as it was asked.
{
  const stray = [...new Set(queried)].filter((q) => canonicalDnsName(q) !== q || internalNameReason(q) !== null);
  ok(queried.length > 10 && stray.length === 0, `every name the resolver was asked for is a canonical name the filter allows (${queried.length} queries, stray: ${JSON.stringify(stray)})`);
}

// --- assertPublicUrl: one message for unresolvable and private ----------------------------
const msgOf = async (u) => { try { await assertPublicUrl(u); return null; } catch (e) { return e.message; } };
const unresolved = await msgOf("https://no-such-host.example/");
const privateLit = await msgOf("http://127.0.0.1/");
ok(unresolved === UNRESOLVED_OR_PRIVATE && privateLit === UNRESOLVED_OR_PRIVATE, `assertPublicUrl answers one message for both (${unresolved} | ${privateLit})`);
ok(!String(unresolved).includes("no-such-host"), "the refusal does not echo the host");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
