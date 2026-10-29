// The shared internal-name filter (src/tools/dns-name-filter.js) and every
// caller-chosen DNS lookup in src/tools that runs through it. The resolver is
// instrumented so a refused name is proven to be refused BEFORE any query, and
// a control name proves the instrumented path is the one that queries. No
// network: every resolver call is answered by the stub.
//
//   node scripts/test-dns-name-filter.js
import dns from "node:dns";
import dnsP from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- resolver stubs (installed before the kits load) ------------------------------
const queried = [];
const answer = async (name) => { queried.push(String(name)); const e = new Error("stub"); e.code = "ENOTFOUND"; throw e; };
dns.promises.resolve = answer; dns.promises.lookup = answer; dns.promises.resolveTxt = answer;
dns.promises.resolveMx = answer; dns.promises.resolveNs = answer; dns.promises.resolveCaa = answer;
dnsP.Resolver.prototype.resolve = answer;
dnsP.lookup = answer; dnsP.resolveMx = answer;
syncBuiltinESMExports();

const { internalNameReason, assertQueryableName } = await import("../src/tools/dns-name-filter.js");
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

// --- assertPublicUrl: one message for unresolvable and private ----------------------------
const msgOf = async (u) => { try { await assertPublicUrl(u); return null; } catch (e) { return e.message; } };
const unresolved = await msgOf("https://no-such-host.example/");
const privateLit = await msgOf("http://127.0.0.1/");
ok(unresolved === UNRESOLVED_OR_PRIVATE && privateLit === UNRESOLVED_OR_PRIVATE, `assertPublicUrl answers one message for both (${unresolved} | ${privateLit})`);
ok(!String(unresolved).includes("no-such-host"), "the refusal does not echo the host");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
