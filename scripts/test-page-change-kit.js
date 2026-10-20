// scripts/test-page-change-kit.js
// Tests for src/tools/page-change-kit.js (page-change) and page-change-text.js.
//   - Catalog envelope, the pure helpers (normalize, ignore patterns,
//     fingerprint, line diff) and input validation run with no network.
//   - Every fetch is served by a real node:http fixture server bound to
//     127.0.0.1 on an OS-assigned port (unchanged, changed, timestamps to
//     ignore, a selector region, hidden text, oversize, redirects, non-HTML,
//     binary, upstream 4xx/5xx). The handler reaches it through a stubbed
//     globalThis.fetch that maps https://example.com/<path> onto the fixture,
//     so safeFetch's own public-address guard stays in the path for the
//     start URL (one DNS query for example.com, the same touch
//     test-crawl-kit.js makes) and the loopback start URLs are refused by it
//     for real. A redirect hop into a private address is what the pinned
//     dispatcher refuses at connect in production (test-fetch-guard.js); the
//     stub raises the same ESSRFBLOCKED cause so the handler's answer is the
//     one a buyer sees.
import { createServer } from "node:http";
import { isIP } from "node:net";
import { PAGE_CHANGE_TOOLS } from "../src/tools/page-change-kit.js";
import { normalizeText, fingerprintOf, lineDiff, parseIgnore, MAX_TEXT_CHARS, __setIgnoreTotalMsForTests } from "../src/tools/page-change-text.js";
import { isPrivateIp } from "../src/tools/fetch-guard.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}
const HEX64 = /^[a-f0-9]{64}$/;

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(PAGE_CHANGE_TOOLS.length === 1, `1 tool exported (got ${PAGE_CHANGE_TOOLS.length})`);
const tool = PAGE_CHANGE_TOOLS[0];
const run = tool.handler;
ok(tool.route === "POST /api/page-change" && tool.slug === "page-change", "route POST /api/page-change, slug page-change");
ok(tool.price === "$0.004", `priced $0.004 (got ${tool.price})`);
ok(tool.category === "web", "category web");
const d = tool.discovery;
ok(d && d.bodyType === "json" && d.input?.url && d.inputSchema?.required?.includes("url") && d.output?.example?.fingerprint, "full discovery envelope");
ok(!/\u2014/.test(tool.description) && !/\u2014/.test(JSON.stringify(d)), "no em dash in copy");
ok(WALLET_ONLY_SLUGS.has("page-change"), "page-change is in WALLET_ONLY_SLUGS (egress)");
ok(!FREE_TIER_SLUGS.has("page-change"), "page-change is not in the free tier");
ok(Object.keys(d.output.example).every((k) => k !== "diff" && k !== "text"), "the example documents only the keys every answer carries");

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------
{
  const n = normalizeText("  Hello \t World \r\n\n\n  second\u00a0line  \n\n");
  ok(n.text === "Hello World\nsecond line" && n.lines === 2 && !n.truncated && n.ignored === 0, `normalizeText collapses whitespace, trims, drops empty lines (${JSON.stringify(n.text)})`);
  ok(normalizeText(n.text).text === n.text, "normalizeText is idempotent");
  const big = normalizeText("x".repeat(MAX_TEXT_CHARS + 10));
  ok(big.truncated && big.text.length === MAX_TEXT_CHARS, "normalizeText caps the text and says so");
  const pats = parseIgnore(["/Generated at \\d+/", "Visits:"]);
  const ig = normalizeText("Generated at 1700000000\nVisits: 42\nBody", pats);
  ok(ig.text === "42\nBody" && ig.ignored === 2, `ignore: regex and literal removed, count kept (${JSON.stringify(ig.text)}, ${ig.ignored})`);
  const ci = normalizeText("UPDATED today", parseIgnore(["/updated/i"]));
  ok(ci.text === "today", "ignore: /pattern/i is case-insensitive");
  ok(parseIgnore(undefined).length === 0 && parseIgnore(null).length === 0, "ignore: absent is no pattern");
  for (const [v, label] of [["x", "not an array"], [Array.from({ length: 21 }, () => "a"), "over 20 entries"], [[1], "non-string entry"], [[""], "empty entry"], [["a".repeat(205)], "over 200 chars"], [["/(a+)+b/"], "nested quantifiers refused"], [["/[/"], "unparseable regex"]]) {
    try { parseIgnore(v); fail++; console.error(`ASSERT FAIL - parseIgnore ${label} (did not throw)`); }
    catch (e) { ok(e.statusCode === 400, `parseIgnore: ${label} -> 400`); }
  }
  ok(fingerprintOf("") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "fingerprintOf is sha256 hex");
  ok(fingerprintOf("a") !== fingerprintOf("b") && HEX64.test(fingerprintOf("a")), "fingerprintOf differs per text");

  const same = lineDiff("a\nb\nc", "a\nb\nc");
  ok(same.added.length === 0 && same.removed.length === 0 && same.similarity === 1, "lineDiff: identical texts");
  const basic = lineDiff("a\nb\nc", "a\nx\nc\nd");
  ok(basic.added.join("|") === "x|d" && basic.removed.join("|") === "b" && basic.addedTotal === 2 && basic.removedTotal === 1, `lineDiff: added and removed in order (${basic.added}, ${basic.removed})`);
  ok(basic.similarity === Number((2 * 2 / 7).toFixed(4)), `lineDiff: similarity is the shared share (${basic.similarity})`);
  const rep = lineDiff("a\na\nb", "a\nb\nb");
  ok(rep.added.join("|") === "b" && rep.removed.join("|") === "a", "lineDiff: repeated lines count as a multiset");
  const disjoint = lineDiff("a", "b");
  ok(disjoint.similarity === 0 && lineDiff("", "").similarity === 1 && lineDiff("", "a").addedTotal === 1, "lineDiff: disjoint is 0, empty is 1, from empty is all added");
  const capped = lineDiff("", Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n"), { maxLines: 50 });
  ok(capped.added.length === 50 && capped.addedTotal === 120, "lineDiff: arrays capped, totals kept");
  const long = lineDiff("", "y".repeat(900), { maxLineChars: 500 });
  ok(long.added[0].length === 500, "lineDiff: a line is clipped");
}

// ----------------------------------------------------------------------------
// Fixture site on 127.0.0.1:0, reached as https://example.com/<path>
// ----------------------------------------------------------------------------
const state = { flip: "v1", price: "$10", nav: "Home About", many: 120 };
let secretHits = 0;
const page = (title, body) => `<!doctype html><html><head><title>${title}</title><style>.x{color:red}</style></head><body><script>var s = "never text";</script>${body}</body></html>`;
const srv = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const send = (status, type, body, extra = {}) => { res.writeHead(status, { "content-type": type, ...extra }); res.end(body); };
  switch (u.pathname) {
    case "/stable":
      return send(200, "text/html; charset=utf-8", page("Stable Page", '<h1>Heading</h1><p>Paragraph one.</p><p style="display:none">hidden text</p><!-- a comment --><ul><li>Item A</li><li>Item B</li></ul>'), { etag: '"v1"', "last-modified": "Mon, 13 Oct 2026 20:08:28 GMT" });
    case "/flip":
      return send(200, "text/html", page("Flip", `<p>Intro line.</p><p>Status: ${state.flip}</p>`));
    case "/stamp":
      return send(200, "text/html", page("Stamp", `<p>Generated at ${Date.now()}</p><p>Visits: ${Math.floor(Math.random() * 1e6)}</p><p>Body copy.</p>`));
    case "/price":
      return send(200, "text/html", page("Price", `<nav>${state.nav}</nav><main><span id="price">${state.price}</span></main>`));
    case "/many":
      return send(200, "text/html", page("Many", Array.from({ length: state.many }, (_, i) => `<p>row ${i}</p>`).join("")));
    case "/big":
      return send(200, "text/html", "<html><body>" + "a".repeat(2 * 1024 * 1024 + 1) + "</body></html>");
    case "/redirect":
      return send(302, "text/plain", "", { location: "/target" });
    case "/target":
      return send(200, "text/html", page("Target", "<p>You were redirected here.</p>"));
    case "/redirect-private":
      return send(302, "text/plain", "", { location: `http://127.0.0.1:${srv.address().port}/secret` });
    case "/secret":
      secretHits++;
      return send(200, "text/html", page("Secret", "<p>never read</p>"));
    case "/data.json":
      return send(200, "application/json", JSON.stringify({ version: "1.2.3", items: [1, 2] }));
    case "/img.png":
      return send(200, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
    case "/missing":
      return send(404, "text/html", "<p>nope</p>");
    case "/broken":
      return send(500, "text/html", "<p>boom</p>");
    default:
      return send(404, "text/plain", "not found");
  }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const PORT = srv.address().port;
const SITE = "https://example.com";

const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async function stubFetch(url, init = {}) {
  fetchCalls++;
  let u = new URL(String(url));
  for (let hop = 0; hop < 5; hop++) {
    if (u.host !== "example.com") throw Object.assign(new Error("stub: offsite fetch attempted " + u.href), { code: "ESTUB_OFFSITE" });
    const res = await realFetch(`http://127.0.0.1:${PORT}${u.pathname}${u.search}`, { method: init.method || "GET", headers: init.headers, signal: init.signal, redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, u);
      const host = next.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && isPrivateIp(host)) {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error(`Blocked: ${host} is a private address`), { code: "ESSRFBLOCKED" }) });
      }
      u = next;
      continue;
    }
    Object.defineProperty(res, "url", { value: u.href });
    return res;
  }
  throw new Error("stub: too many redirects");
};

try {
  // --------------------------------------------------------------------------
  // Input validation never fetches
  // --------------------------------------------------------------------------
  await throws(run({}), 400, "missing url");
  await throws(run({ url: "   " }), 400, "blank url");
  await throws(run({ url: "not a url" }), 400, "unparseable url");
  await throws(run({ url: "ftp://example.com/x" }), 400, "non-http scheme");
  await throws(run({ url: SITE + "/" + "a".repeat(2100) }), 400, "url over 2048 chars");
  await throws(run({ url: SITE + "/stable", baseline: "abc" }), 400, "baseline not an object");
  await throws(run({ url: SITE + "/stable", baseline: {} }), 400, "baseline without fingerprint or text");
  await throws(run({ url: SITE + "/stable", baseline: { fingerprint: "abc" } }), 400, "baseline fingerprint not a sha256");
  await throws(run({ url: SITE + "/stable", baseline: { text: 42 } }), 400, "baseline text not a string");
  await throws(run({ url: SITE + "/stable", baseline: { text: "x".repeat(MAX_TEXT_CHARS + 2048) } }), 400, "baseline text over the cap");
  await throws(run({ url: SITE + "/stable", ignore: "ts" }), 400, "ignore not an array");
  await throws(run({ url: SITE + "/stable", ignore: ["/(a+)+/"] }), 400, "ignore with nested quantifiers");
  await throws(run({ url: SITE + "/stable", includeText: "yes" }), 400, "includeText not a boolean");
  await throws(run({ url: SITE + "/stable", selector: "div[" }), 400, "invalid CSS selector");
  await throws(run({ url: SITE + "/stable", selector: 7 }), 400, "selector not a string");
  await throws(run({ url: SITE + "/stable", selector: "a".repeat(301) }), 400, "selector over 300 chars");
  ok(fetchCalls === 0, "validation failures never fetch");

  // --------------------------------------------------------------------------
  // Private addresses are refused before any request
  // --------------------------------------------------------------------------
  await throws(run({ url: `http://127.0.0.1:${PORT}/stable` }), 400, "loopback start URL refused");
  await throws(run({ url: "http://10.0.0.8/x" }), 400, "RFC1918 start URL refused");
  await throws(run({ url: "http://[::1]/x" }), 400, "IPv6 loopback start URL refused");
  await throws(run({ url: "http://169.254.169.254/latest/meta-data" }), 400, "metadata address refused");
  ok(fetchCalls === 0, "private start URLs never fetch");

  // --------------------------------------------------------------------------
  // Unchanged page
  // --------------------------------------------------------------------------
  const first = await run({ url: SITE + "/stable" });
  ok(first.url === SITE + "/stable" && first.requestedUrl === SITE + "/stable", "url and requestedUrl");
  ok(HEX64.test(first.fingerprint) && first.algorithm === "sha256", "fingerprint is sha256 hex");
  ok(first.changed === null, "changed is null without a baseline");
  ok(first.etag === '"v1"' && first.lastModified === "Mon, 13 Oct 2026 20:08:28 GMT", `etag and lastModified echoed (${first.etag}, ${first.lastModified})`);
  ok(first.title === "Stable Page" && /^text\/html/.test(first.contentType), "title and contentType");
  ok(first.length > 0 && first.lines === 4 && first.textTruncated === false, `length, lines, textTruncated (${first.length}, ${first.lines})`);
  ok(first.selector === null && first.selectorMatches === null && first.ignored === 0, "selector fields null without a selector");
  ok(first.text === undefined && first.diff === undefined && first.untrustedContent === undefined, "no text, diff or untrusted marker without includeText or a baseline text");
  ok(typeof first.fetchedAt === "string" && !Number.isNaN(Date.parse(first.fetchedAt)), "fetchedAt is an ISO timestamp");
  for (const k of Object.keys(tool.discovery.output.example)) ok(k in first, `documented key present: ${k}`);

  const withText = await run({ url: SITE + "/stable", includeText: true });
  ok(withText.fingerprint === first.fingerprint, "same page, same fingerprint");
  ok(withText.text === "Heading\nParagraph one.\nItem A\nItem B", `includeText returns the normalized block text (${JSON.stringify(withText.text)})`);
  ok(withText.untrustedContent === true, "returned page text is marked untrusted");
  ok(!/hidden text|a comment|never text|color:red/.test(withText.text), "hidden elements, comments, scripts and styles are not text");
  ok(fingerprintOf(withText.text) === withText.fingerprint, "the fingerprint is the sha256 of the returned text");

  const sameFp = await run({ url: SITE + "/stable", baseline: { fingerprint: first.fingerprint.toUpperCase() } });
  ok(sameFp.changed === false && sameFp.diff === undefined, "baseline fingerprint (any case) of the same text: changed false, no diff");
  const sameText = await run({ url: SITE + "/stable", baseline: { text: withText.text } });
  ok(sameText.changed === false && sameText.diff && sameText.diff.added.length === 0 && sameText.diff.removed.length === 0 && sameText.diff.similarity === 1 && sameText.diff.complete === true && sameText.diff.truncated === false, "baseline text of the same page: changed false, empty diff, similarity 1");
  ok(sameText.untrustedContent === true, "an answer with a diff is marked untrusted");

  // --------------------------------------------------------------------------
  // Changed page
  // --------------------------------------------------------------------------
  const v1 = await run({ url: SITE + "/flip", includeText: true });
  state.flip = "v2";
  const v2 = await run({ url: SITE + "/flip", baseline: { fingerprint: v1.fingerprint, text: v1.text } });
  ok(v2.changed === true && v2.fingerprint !== v1.fingerprint, "changed text: changed true, new fingerprint");
  ok(v2.diff.added.join("|") === "Status: v2" && v2.diff.removed.join("|") === "Status: v1", `diff names the changed line (${v2.diff.added}, ${v2.diff.removed})`);
  ok(v2.diff.addedTotal === 1 && v2.diff.removedTotal === 1 && v2.diff.returned === 2 && v2.diff.matched === 2 && v2.diff.complete === true, "diff totals and partial-answer fields");
  ok(v2.diff.similarity > 0 && v2.diff.similarity < 1, `similarity between 0 and 1 (${v2.diff.similarity})`);
  const fpOnly = await run({ url: SITE + "/flip", baseline: { fingerprint: v1.fingerprint } });
  ok(fpOnly.changed === true && fpOnly.diff === undefined, "a stale fingerprint alone: changed true, no diff");
  const textOnly = await run({ url: SITE + "/flip", baseline: { text: v1.text } });
  ok(textOnly.changed === true && textOnly.diff.removed[0] === "Status: v1", "a stale text alone: changed is derived from the text");

  // --------------------------------------------------------------------------
  // Ignore patterns
  // --------------------------------------------------------------------------
  const s1 = await run({ url: SITE + "/stamp" });
  const s2 = await run({ url: SITE + "/stamp" });
  ok(s1.fingerprint !== s2.fingerprint, "a page with a timestamp and a counter changes every fetch");
  const ignore = ["/Generated at \\d+/", "/Visits: \\d+/"];
  const i1 = await run({ url: SITE + "/stamp", ignore, includeText: true });
  const i2 = await run({ url: SITE + "/stamp", ignore, baseline: { fingerprint: i1.fingerprint, text: i1.text } });
  ok(i1.ignored === 2 && i1.text === "Body copy." && i2.changed === false && i2.diff.similarity === 1, `ignore patterns remove the volatile lines (${JSON.stringify(i1.text)}, ignored=${i1.ignored}, changed=${i2.changed})`);
  const rawBaseline = await run({ url: SITE + "/stamp", ignore, baseline: { text: "Generated at 1\nVisits: 2\nBody copy." } });
  ok(rawBaseline.changed === false, "ignore patterns apply to the baseline text too");

  // --------------------------------------------------------------------------
  // Selector
  // --------------------------------------------------------------------------
  const whole = await run({ url: SITE + "/price" });
  const region = await run({ url: SITE + "/price", selector: "#price", includeText: true });
  ok(region.selector === "#price" && region.selectorMatches === 1 && region.text === "$10", `selector narrows the text (${JSON.stringify(region.text)})`);
  state.nav = "Home About Contact";
  const whole2 = await run({ url: SITE + "/price", baseline: { fingerprint: whole.fingerprint } });
  const region2 = await run({ url: SITE + "/price", selector: "#price", baseline: { fingerprint: region.fingerprint } });
  ok(whole2.changed === true && region2.changed === false, "a change outside the selector is seen by the page, not by the region");
  state.price = "$12";
  const region3 = await run({ url: SITE + "/price", selector: "#price", baseline: { fingerprint: region.fingerprint, text: region.text } });
  ok(region3.changed === true && region3.diff.added[0] === "$12" && region3.diff.removed[0] === "$10", "a change inside the selector is seen");
  const none = await run({ url: SITE + "/price", selector: "#nope" });
  ok(none.selectorMatches === 0 && none.length === 0 && typeof none.note === "string" && none.fingerprint === fingerprintOf(""), "a selector that matches nothing answers an empty text and says so");
  await throws(run({ url: SITE + "/data.json", selector: "#x" }), 422, "a selector on a non-HTML document");

  // --------------------------------------------------------------------------
  // Diff cap, redirects, non-HTML, binary, upstream errors, size
  // --------------------------------------------------------------------------
  const many = await run({ url: SITE + "/many", baseline: { text: "" } });
  ok(many.diff.added.length === 50 && many.diff.addedTotal === 120 && many.diff.maxLines === 50 && many.diff.truncated === true && many.diff.complete === false && many.diff.matched === 120 && many.diff.returned === 50, "diff arrays are capped and the cap is stated in fields");

  const red = await run({ url: SITE + "/redirect" });
  ok(red.url === SITE + "/target" && red.requestedUrl === SITE + "/redirect" && red.title === "Target", "an in-site redirect is followed and the final URL reported");
  await throws(run({ url: SITE + "/redirect-private" }), 400, "a redirect into a private address is refused");
  ok(secretHits === 0, "the private target was never read");

  const json = await run({ url: SITE + "/data.json", includeText: true });
  ok(json.title === null && /"version":"1\.2\.3"/.test(json.text) && HEX64.test(json.fingerprint), "a JSON document is fingerprinted as text");
  await throws(run({ url: SITE + "/img.png" }), 422, "a binary document is refused");
  await throws(run({ url: SITE + "/missing" }), 422, "upstream 404 -> 422");
  await throws(run({ url: SITE + "/broken" }), 502, "upstream 500 -> 502");
  await throws(run({ url: SITE + "/big" }), 413, "a page over 2 MB is refused");
} finally {
  globalThis.fetch = realFetch;
  srv.close();
}

// The ignore patterns are bounded as a set, not only one by one: with the
// per-text budget forced to zero, the second cheap pattern is refused with a
// 400 that names the budget, and the budget restored lets the same set pass.
{
  const text = "alpha 123 beta 456\n".repeat(2000);
  const patterns = parseIgnore(["/[0-9]+/", "/beta/", "/alpha/"]);
  __setIgnoreTotalMsForTests(0);
  let err = null;
  try { normalizeText(text, patterns); } catch (e) { err = e; }
  ok(err && err.statusCode === 400 && /together/.test(err.message), `the ignore set is bounded per text (${err?.statusCode} ${err?.message})`);
  __setIgnoreTotalMsForTests(null);
  ok(normalizeText(text, patterns).text.length < text.length, "with the budget restored the same set is applied");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
