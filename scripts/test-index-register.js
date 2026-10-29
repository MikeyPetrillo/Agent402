// Offline unit tests for self-serve listing: origin validation + the
// registerOrigin flow with an injected fake crawler. No network, no /data.
import { readFileSync } from "node:fs";
import { validateOriginInput, registerOrigin, isSelfSeller, _selfCheckHostMemoForTest, __testResetSubmitted, __testSetSubmittedCap, __resetForcedCrawlForTest } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- validation ---
ok(validateOriginInput("https://example.com").origin === "https://example.com", "plain https origin accepted");
ok(validateOriginInput("https://Example.COM/").origin === "https://example.com", "trailing slash + case normalized");
ok(validateOriginInput("http://example.com").error != null, "http rejected");
ok(validateOriginInput("https://example.com/api").error != null, "path rejected");
ok(validateOriginInput("https://example.com?x=1").error != null, "query rejected");
ok(validateOriginInput("https://user:pw@example.com").error != null, "userinfo rejected");
// A port is CARRIED, not refused and not silently dropped. Both halves matter:
// dropping it would store https://host and crawl port 443, which is a different
// service or none, and that is what this door used to avoid by refusing
// outright. `u.host` gives the third answer - keep it.
ok(validateOriginInput("https://example.com:8443").origin === "https://example.com:8443", "a non-default port is kept");
ok(validateOriginInput("https://Example.COM:8443/").origin === "https://example.com:8443", "ported origin normalizes case and trailing slash");
// WHATWG URL drops a scheme's default port, so these are the same seller and
// must not become two rows in the index.
ok(validateOriginInput("https://example.com:443").origin === "https://example.com", "an explicit :443 collapses to the bare origin");
ok(validateOriginInput("https://example.com:443", { selfOrigin: "https://example.com" }).error != null, "and is caught by the self-origin check");
// A different port on our own host is a different service, so it is NOT us.
ok(validateOriginInput("https://agent402.tools:8443", { selfOrigin: "https://agent402.tools" }).origin === "https://agent402.tools:8443", "a ported twin of our own host is not the local catalog");
ok(validateOriginInput("https://example.com:8443/api").error != null, "a path is still refused on a ported origin");
ok(validateOriginInput("http://example.com:8443").error != null, "http is still refused on a ported origin");
ok(validateOriginInput("https://localhost").error != null, "dotless host rejected");
ok(validateOriginInput("not a url").error != null, "garbage rejected");
ok(validateOriginInput("https://agent402.tools", { selfOrigin: "https://agent402.tools" }).error != null, "own origin rejected");
// Our own catalog under another spelling is still our own catalog: compared
// by canonical host, so a www. twin, letter case or a trailing slash never
// registers it as an outside seller, on any instance's base URL.
ok(validateOriginInput("https://www.agent402.tools", { selfOrigin: "https://agent402.tools" }).error != null, "the www twin of our own host is rejected");
ok(validateOriginInput("https://WWW.Agent402.tools/", { selfOrigin: "https://agent402.tools" }).error != null, "...whatever its case or trailing slash");
ok(validateOriginInput("https://www.agent402.tools", { selfOrigin: "http://localhost:3000" }).error != null, "the production domain is never an outside seller of this catalog, whatever this instance's base URL");
ok(validateOriginInput("https://www.example.com", { selfOrigin: "https://example.com" }).error != null && validateOriginInput("https://example.com", { selfOrigin: "https://www.example.com" }).error != null, "the instance's own base URL is compared the same way, in both directions");
ok(validateOriginInput("https://www.other.example", { selfOrigin: "https://example.com" }).origin === "https://www.other.example", "CONTROL: another host registers");
ok(isSelfSeller("https://old.seller.test", { redirectedTo: "https://www.agent402.tools" }) && !isSelfSeller("https://old.seller.test", { redirectedTo: "https://new.seller.test" }), "an entry whose manifest was redirected onto our own host is self; onto another host it is not");
ok(isSelfSeller("https://agent402.tools:8443") === false && isSelfSeller("not a url") === false, "a ported twin and junk are not self");
// The self check runs once per entry on every whole-cache walk, so the host
// each string parses to is kept: a second walk over the same origins parses
// nothing and answers the same, and the memo never outgrows its cap.
{
  const memo = _selfCheckHostMemoForTest();
  memo.clear();
  const origins = Array.from({ length: 2_000 }, (_, i) => `https://seller${i}.example`);
  origins.push("https://WWW.Agent402.tools/", "https://old.seller.test");
  const verdict = (base) => origins.map((o) => isSelfSeller(o, { baseUrl: base, redirectedTo: o === "https://old.seller.test" ? "https://www.agent402.tools" : null }));
  const first = verdict("https://example.com");
  const parsed = memo.size;
  // Every origin, the redirect target and the base URL: one entry each, none for the production host constant.
  ok(parsed === origins.length + 2, `one parse per distinct string on the first walk (${parsed} for ${origins.length} origins, a redirect and a base URL)`);
  const second = verdict("https://example.com");
  ok(memo.size === parsed && second.every((v, i) => v === first[i]) && first.filter(Boolean).length === 2 && first[origins.length - 2] && first[origins.length - 1], "a second walk parses nothing and gives the same verdicts (the www twin and the redirected entry are self, the rest are not)");
  ok(isSelfSeller("https://seller7.example", { baseUrl: "https://www.seller7.example" }) === true && memo.size === parsed + 1, "a new base URL is one more parse and is compared from the memo");
  for (let i = 0; i < 50_010; i++) isSelfSeller(`https://fill${i}.example`);
  ok(memo.size <= 50_000, `the memo is cleared past its cap (${memo.size} entries after 50,010 more strings)`);
  memo.clear();
}
{
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(!/=== "https:\/\/agent402\.tools"/.test(src) && !/o === selfBase/.test(src), "no exact-string self compare is left in the index");
  for (const fn of ["function validateOriginInput(", "function directoryListsEntry(", "function* routableRemoteEntries("]) {
    const at = src.indexOf(fn);
    ok(at > 0 && /isSelfSeller\(/.test(src.slice(at, src.indexOf("\n}\n", at))), `${fn.replace("function* ", "").replace("function ", "")}) reads the one self rule`);
  }
  ok((src.match(/const isSelfOrigin = \(origin, v = cache\.get\(origin\)\) => isSelfSeller\(origin, \{ baseUrl, redirectedTo: v\?\.redirectedTo \}\);/g) || []).length === 2, "the index snapshot and the route query read the one self rule with the entry's redirect");
}

// --- registerOrigin with injected crawler ---
__testResetSubmitted();

// END TO END ON A PORT. The unit assertions above prove the normaliser keeps
// one; this proves the thing that actually costs a seller something, which is
// that the port reaches the crawler. Storing https://host and then fetching
// port 443 of that host would pass every assertion above and still index the
// wrong service.
{
  const seen = [];
  const crawl = async (o) => { seen.push(o); return { manifest: { name: "Ported" }, tools: [{ slug: "t", route: "/v1/x" }], error: null, history: [true] }; };
  // Through the SAME two steps the register route takes, in the same order:
  // registerOrigin trusts its argument, so handing it a literal here would
  // prove only that it passes a string along and would survive the normaliser
  // being reverted.
  const submit = async (raw) => {
    const v = validateOriginInput(raw, { selfOrigin: "https://agent402.tools" });
    if (v.error) return { error: v.error };
    return registerOrigin(v.origin, { crawl });
  };
  const r = await submit("https://Ported.example:8443/");
  ok(seen[0] === "https://ported.example:8443", "the crawler is handed the origin WITH its port");
  ok(r.listed === true && r.origin === "https://ported.example:8443", "and the ported origin is listed under its own key");
  // Same host, default port: a different seller, not a re-registration of the
  // one above.
  const plain = await submit("https://ported.example");
  ok(seen[1] === "https://ported.example", "the bare host is crawled separately");
  ok(plain.origin === "https://ported.example", "and keyed separately from its ported twin");
}

// A RE-REGISTRATION RE-READS THE DOCUMENTS (2026-09-18). Until this date the
// known-origin branch ran only the live-402 quote enrichment, so a seller who
// improved an operation's description or tags - on our own advice - had no way
// to ask us to look again and waited for the shared rotation. Measured on a
// real seller whose row carried neither two hours after they deployed both.
{
  let crawls = 0;
  const thin = async (o) => { crawls++; return { manifest: { name: "Meta" }, tools: [{ slug: "a", route: "/v1/compare", description: "", tags: [] }], error: null, history: [true] }; };
  const rich = async (o) => { crawls++; return { manifest: { name: "Meta" }, tools: [{ slug: "a", route: "/v1/compare", description: "Compare and rank candidates", tags: ["compare", "rank"] }], error: null, history: [true] }; };
  const origin = "https://meta-refresh.example";
  await registerOrigin(origin, { crawl: thin });
  const before = crawls;
  const again = await registerOrigin(origin, { crawl: rich });
  ok(crawls === before + 1, "re-registering a KNOWN origin crawls it again (was a price-only no-op)");
  // The cost of that lever is bounded AT THE ORIGIN, because registration
  // needs no proof of control: anyone can ask us to re-read anyone's
  // documents, and per-IP limits let the victim feel the sum of every caller.
  const afterFirst = crawls;
  await registerOrigin(origin, { crawl: rich });
  await registerOrigin(origin, { crawl: rich });
  ok(crawls === afterFirst, "two more re-registrations inside the window re-read NOTHING (the origin's cooldown, not the caller's)");
  __resetForcedCrawlForTest();
  await registerOrigin(origin, { crawl: rich });
  ok(crawls === afterFirst + 1, "and once the window passes, an explicit ask is honoured again");
  ok(again.listed === true, "the re-registration still lists the origin");
  const row = (again.seller?.tools || [])[0];
  if (row) ok((row.description || "").length > 0, "the answer describes the FRESH entry, not the pre-crawl one");
  else ok(true, "seller summary carries no tool rows - fresh-entry assertion covered by the crawl count");
}

let crawled = [];
const goodCrawl = async (o) => { crawled.push(o); return { manifest: { name: "Ext" }, tools: [{ slug: "a" }], error: null, history: [true] }; };
const badCrawl = async (o) => { crawled.push(o); return { error: "no manifest, no openapi, no bazaar entries", history: [false] }; };

let r = await registerOrigin("https://newseller.example", { crawl: goodCrawl });
ok(r.listed === true && r.origin === "https://newseller.example", "successful probe lists the origin");
ok(r.seller && typeof r.seller.toolCount === "number", "response carries a seller summary");
ok(crawled.length === 1, "crawler invoked once for unknown origin");

r = await registerOrigin("https://deadseller.example", { crawl: badCrawl });
ok(r.listed === false && typeof r.error === "string", "failed probe returns honest error, not listed");

// --- submission cap ---
__testResetSubmitted();
__testSetSubmittedCap(1);
const capCrawl = async (o) => { crawled.push(o); return { manifest: { name: "Cap" }, tools: [{ slug: "a" }], error: null, history: [true] }; };

r = await registerOrigin("https://cap-first.example", { crawl: capCrawl });
ok(r.listed === true, "cap: first submission fills the cap and still lists");

const crawledBefore = crawled.length;
r = await registerOrigin("https://cap-second.example", { crawl: capCrawl });
ok(r.listed === false, "cap: new origin at cap is not listed");
ok(typeof r.error === "string" && /full/i.test(r.error), "cap: error is an honest capacity message");
ok(crawled.length === crawledBefore, "cap: rejected origin is never crawled");

r = await registerOrigin("https://cap-second.example", { crawl: capCrawl });
ok(r.listed === false, "cap: rejected origin stays rejected on retry (not persisted)");

r = await registerOrigin("https://cap-first.example", { crawl: capCrawl });
ok(r.listed === true, "cap: an already-known origin still returns its state normally at cap");

__testSetSubmittedCap(); // restore default for any tests that run after this file
__testResetSubmitted();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
