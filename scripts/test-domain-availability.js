// domain-availability against a stub RDAP world: a local HTTP server plays
// IANA's bootstrap file and two registries. The kit's fetch seam maps the
// https base URLs the bootstrap names onto the stub, so every rule runs on the
// real handler code: registered and not-registered answers, a web-page 404 as
// an outage, a registry's 429 honored, the answer cache, a name under a
// registered domain, a registry-run second level, a TLD with no RDAP service,
// redirects never followed, the bootstrap kept through a failed refresh, and
// the run's ceiling ending a hung registry.
//
//   node scripts/test-domain-availability.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import http from "node:http";
import { createDomainAvailability, DOMAIN_AVAILABILITY_TOOLS, CACHE_TTL_MS, rdapBaseFor, domainOf } from "../src/tools/domain-availability-kit.js";
import { KIT } from "../src/tools/kit.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { withRunCeiling } from "../src/run-ceiling.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ---- the stub world ----
const hits = [];
let bootstrapStatus = 200;
const registries = {
  // registry A serves .test and .co.test
  "/a/domain/taken.test": [200, { objectClassName: "domain", ldhName: "taken.test", status: ["client transfer prohibited"], events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }], entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar"]]] }] }],
  "/a/domain/parent.test": [200, { objectClassName: "domain", ldhName: "parent.test", status: ["active"], events: [{ eventAction: "registration", eventDate: "2019-01-01T00:00:00Z" }], entities: [] }],
  // a second level the registry runs: answered, but nobody's registration
  "/a/domain/co.test": [200, { objectClassName: "domain", ldhName: "co.test", status: ["server delete prohibited"], remarks: [{ title: "Public suffix", description: ["This is a public suffix"] }], events: [{ eventAction: "last changed", eventDate: "2019-01-01T00:00:00Z" }] }],
  "/a/domain/outage.test": [404, "<html>Not Found</html>", "text/html"],
  "/a/domain/bare.test": [404, "", null],
  "/a/domain/odd.test": [200, "[1,2,3]"],
};
let throttleNext = 0; // answer this many lookups on registry B with 429
let hangB = false;
const srv = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === "/iana/dns.json") {
    if (bootstrapStatus !== 200) { res.writeHead(bootstrapStatus); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ services: [[["test", "co.test"], ["https://rdap-a.test/a/"]], [["slow"], ["https://rdap-b.test/b/"]], [["plain"], ["http://rdap-c.test/c/"]]] }));
  }
  // A registry redirect to a host the bootstrap never named, which would
  // answer "registered" if it were followed.
  if (req.url === "/a/domain/hop.test") { res.writeHead(302, { location: `http://127.0.0.1:${port}/elsewhere/domain/hop.test` }); return res.end(); }
  if (req.url.startsWith("/elsewhere/")) { res.writeHead(200, { "content-type": "application/rdap+json" }); return res.end(JSON.stringify({ objectClassName: "domain", ldhName: "hop.test", events: [{ eventAction: "registration" }] })); }
  if (req.url.startsWith("/b/")) {
    if (hangB) return; // never answers
    if (throttleNext > 0) { throttleNext--; res.writeHead(429, { "retry-after": "20" }); return res.end(); }
    res.writeHead(404, { "content-type": "application/rdap+json" });
    return res.end(JSON.stringify({ errorCode: 404, title: "Not Found" }));
  }
  const r = registries[req.url];
  if (!r) { res.writeHead(404, { "content-type": "application/rdap+json" }); return res.end(JSON.stringify({ errorCode: 404 })); }
  const [status, body, type = "application/rdap+json", extra = {}] = r;
  res.writeHead(status, { ...(type ? { "content-type": type } : {}), ...extra });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const HOSTS = new Map([["data.iana.test", "/iana"], ["rdap-a.test", ""], ["rdap-b.test", ""], ["rdap-c.test", ""]]);
// The seam: an https URL the kit asks for, served by the stub. Redirect mode
// and the abort signal pass through untouched.
const stubFetch = (url, init) => {
  const u = new URL(url);
  const prefix = HOSTS.get(u.hostname);
  if (prefix === undefined) throw new Error(`stub: unexpected host ${u.hostname}`);
  return fetch(`http://127.0.0.1:${port}${prefix}${u.pathname}${u.search}`, init);
};
let clock = Date.parse("2026-11-22T12:00:00Z");
const now = () => clock;
const make = () => createDomainAvailability({ fetchImpl: stubFetch, now, bootstrapUrl: "https://data.iana.test/dns.json" });

try {
  // ---- input ----
  ok(domainOf({ domain: "https://Taken.TEST/path?q=1" }) === "taken.test", "a URL is read as its host, lower-cased");
  ok(domainOf({ domain: "münchen.test" }) === "xn--mnchen-3ya.test", "an internationalized name is asked in its ASCII form");
  for (const bad of [{}, { domain: "" }, { domain: "nodot" }, { domain: "a..b.test" }, { domain: "-x.test" }, { domain: 42 }, { domain: "x".repeat(400) }]) {
    const e = await errOf(Promise.resolve().then(() => domainOf(bad)));
    ok(e?.statusCode === 400, `${JSON.stringify(bad).slice(0, 40)} is a 400 (${e?.statusCode})`);
  }
  ok(rdapBaseFor(new Map([["test", "A"], ["co.test", "B"]]), "x.co.test") === "B", "the longest listed suffix names the registry");

  // ---- registered / not registered ----
  {
    const d = make();
    hits.length = 0;
    const a = await d.check({ domain: "taken.test" });
    ok(a.registered === true && a.registrar === "Example Registrar" && a.status.join() === "client transfer prohibited", `a 200 domain object is registered with its registrar and status (${JSON.stringify(a).slice(0, 120)})`);
    ok(a.source === "RDAP" && a.checkedAt === new Date(clock).toISOString() && a.domain === "taken.test", "source, checkedAt and the domain are stated");
    ok(/can change/i.test(a.note) && /registrar/i.test(a.note), "the note says availability can change and registration happens at a registrar");
    ok(hits.includes("/iana/dns.json") && hits.includes("/a/domain/taken.test"), "the registry the bootstrap names was asked");
    const n = await d.check({ domain: "free-name.test" });
    ok(n.registered === false && Array.isArray(n.status) && n.status.length === 0 && !("registrar" in n), "an RDAP 404 is not registered, with no registrar");
    const b = await d.check({ domain: "bare.test" });
    ok(b.registered === false, "a bare empty 404 is not registered");
    const o = await errOf(d.check({ domain: "outage.test" }));
    ok(o?.statusCode === 502, `a 404 web page is an outage: 502, never "not registered" (${o?.statusCode})`);
    const odd = await errOf(d.check({ domain: "odd.test" }));
    ok(odd?.statusCode === 502, `a 200 that is not an RDAP object is a 502 (${odd?.statusCode})`);
    ok(hits.filter((h) => h === "/iana/dns.json").length === 1, "the bootstrap is read once and kept");
  }

  // ---- redirects are never followed; only bootstrap hosts are asked ----
  {
    const d = make();
    hits.length = 0;
    const e = await errOf(d.check({ domain: "hop.test" }));
    ok(e?.statusCode === 502, `a registry redirect is not followed: 502 (${e?.statusCode})`);
    ok(!hits.some((h) => h.startsWith("/elsewhere")), "the redirect target was never asked");
    const p = await errOf(d.check({ domain: "x.plain" }));
    ok(p?.statusCode === 422, `an http-only bootstrap entry is no RDAP service: 422 (${p?.statusCode})`);
    ok(!hits.some((h) => h.startsWith("/c/")), "an http base URL is never asked");
    const none = await errOf(d.check({ domain: "example.nope" }));
    ok(none?.statusCode === 422 && /no RDAP service/.test(none.message), `a TLD with no RDAP service is a 422, not charged (${none?.statusCode})`);
  }

  // ---- a name under a registered domain; a registry-run second level ----
  {
    const d = make();
    const s = await d.check({ domain: "www.parent.test" });
    ok(s.registered === null && s.registeredParent === "parent.test" && /parent\.test/.test(s.note), `a name under a registered domain is registered null with the parent named (${JSON.stringify(s).slice(0, 100)})`);
    const c = await d.check({ domain: "fresh.co.test" });
    ok(c.registered === false && !("registeredParent" in c), "a name under a public-suffix second level reads not registered");
  }

  // ---- the answer cache ----
  {
    const d = make();
    await d.check({ domain: "taken.test" });
    hits.length = 0;
    const again = await d.check({ domain: "TAKEN.test" });
    ok(again.registered === true && hits.length === 0, "a repeat inside the cache window is answered without asking the registry");
    again.status.push("mutated");
    ok((await d.check({ domain: "taken.test" })).status.length === 1, "a caller cannot change a kept answer");
    clock += CACHE_TTL_MS + 1;
    await d.check({ domain: "taken.test" });
    ok(hits.includes("/a/domain/taken.test"), "after the window the registry is asked again");
  }

  // ---- a registry's 429 is honored ----
  {
    const d = make();
    throttleNext = 1;
    hits.length = 0;
    const e = await errOf(d.check({ domain: "first.slow" }));
    ok(e?.statusCode === 503 && e.retryAfter === 20, `a 429 is a retryable 503 carrying the registry's Retry-After (${e?.statusCode}, ${e?.retryAfter})`);
    const before = hits.length;
    const e2 = await errOf(d.check({ domain: "second.slow" }));
    ok(e2?.statusCode === 503 && hits.length === before, "inside the window the registry is not asked again");
    ok(e2.retryAfter >= 1 && e2.retryAfter <= 20, `the window's remaining seconds are stated (${e2?.retryAfter})`);
    const other = await d.check({ domain: "taken.test" });
    ok(other.registered === true, "another registry is unaffected");
    clock += 21_000;
    const after = await d.check({ domain: "second.slow" });
    ok(after.registered === false, "after the window the registry is asked again");
  }

  // ---- the bootstrap: unreadable at first, then kept through a failed refresh ----
  {
    bootstrapStatus = 500;
    const d = make();
    const e = await errOf(d.check({ domain: "taken.test" }));
    ok(e?.statusCode === 503, `no bootstrap yet is a retryable 503 (${e?.statusCode})`);
    hits.length = 0;
    const e2 = await errOf(d.check({ domain: "taken.test" }));
    ok(e2?.statusCode === 503 && !hits.includes("/iana/dns.json"), "a failed bootstrap read is not retried at once");
    bootstrapStatus = 200;
    clock += 11 * 60 * 1000;
    ok((await d.check({ domain: "taken.test" })).registered === true, "the bootstrap is read again after the retry pause");
    bootstrapStatus = 500;
    clock += 25 * 60 * 60 * 1000;
    ok((await d.check({ domain: "other-free.test" })).registered === false, "a failed daily refresh keeps the last map");
    bootstrapStatus = 200;
  }

  // ---- the run's ceiling ends a hung registry ----
  {
    const d = make();
    await d.check({ domain: "taken.test" }); // bootstrap read
    hangB = true;
    const t0 = Date.now();
    const e = await errOf(withRunCeiling(300, () => d.check({ domain: "hung.slow" })));
    ok(e && [502, 504].includes(e.statusCode) && Date.now() - t0 < 3000, `a hung registry ends at the run's ceiling (${e?.statusCode} after ${Date.now() - t0} ms)`);
    hangB = false;
  }

  // ---- the catalog entry ----
  {
    const t = DOMAIN_AVAILABILITY_TOOLS[0];
    const whois = KIT.find((x) => x.slug === "whois");
    ok(t.slug === "domain-availability" && t.route === "POST /api/domain-availability", "route and slug");
    ok(t.price === whois.price, `priced as whois (${t.price})`);
    ok(!FREE_TIER_SLUGS.has(t.slug), "wallet-only: not in the free tier (it has egress)");
    ok(t.endsAtCeiling === true, "every wait ends at the run's ceiling (marked)");
    const ex = t.discovery.output.example;
    ok(ex.registered === true && ex.source === "RDAP" && typeof ex.checkedAt === "string" && Array.isArray(ex.status), "the published example has the answer's shape");
  }
} finally {
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
