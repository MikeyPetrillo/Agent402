// Exact-output tests for html-kit (html-select, html-table, html-strip,
// html-links, html-meta). Pure functions on raw HTML strings — no server,
// no network, no fixtures. Covers the happy paths each tool documents in
// its `discovery.input` example plus the agent-facing error contracts
// (bad selectors, oversize input, wrong selector type).
import { HTML_TOOLS } from "../src/tools/html-kit.js";

const tool = (slug) => HTML_TOOLS.find((t) => t.slug === slug);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };
const run = (slug, input) => tool(slug).handler(input);
const throws = (fn, label) => { try { fn(); ok(false, `${label} should throw`); } catch { ok(true, `${label} throws`); } };

// ----- html-select -----
let r = run("html-select", { html: "<h1>One</h1><h1>Two</h1><h1>Three</h1>", selector: "h1", limit: 2 });
ok(r.count === 3 && r.returned === 2, `html-select count=3 returned=2 honors limit (got count=${r.count}, returned=${r.returned})`);
ok(r.matches[0].text === "One" && r.matches[1].text === "Two", `html-select returns matches in document order`);
ok(JSON.stringify(r.matches[0].attrs) === "{}", `html-select empty attrs object when no attributes set`);

r = run("html-select", { html: '<a href="/x" id="a1">X</a><a href="/y">Y</a>', selector: "a", attr: "href" });
ok(r.matches.length === 2 && r.matches[0].href === "/x" && r.matches[1].href === "/y", `html-select attr= mode returns only the requested attribute`);

r = run("html-select", { html: "<div><span class=\"px\">$9</span></div>", selector: ".px", includeHtml: true });
ok(r.matches[0].html === `<span class="px">$9</span>`, `html-select includeHtml returns outerHTML`);

throws(() => run("html-select", { html: "<p>x</p>", selector: ":::not-a-selector" }), `html-select rejects malformed selector`);
throws(() => run("html-select", { html: "<p>x</p>", selector: "p", limit: 0 }), `html-select rejects limit=0`);
throws(() => run("html-select", { html: "<p>x</p>", selector: "p", limit: 201 }), `html-select rejects limit>200`);

// ----- html-table -----
r = run("html-table", {
  html: "<table><thead><tr><th>City</th><th>Pop</th></tr></thead><tbody><tr><td>NYC</td><td>8.3M</td></tr><tr><td>LA</td><td>3.9M</td></tr></tbody></table>",
  format: "json",
});
ok(r.count === 2 && r.headers.length === 2 && r.headers[0] === "City", `html-table JSON parses headers and rows`);
ok(r.rows[0].City === "NYC" && r.rows[1].Pop === "3.9M", `html-table JSON keys rows by header`);

r = run("html-table", {
  html: "<table><tr><th>A,B</th><th>C</th></tr><tr><td>1</td><td>has \"quotes\"</td></tr></table>",
  format: "csv",
});
ok(r.csv.split("\n")[0] === `"A,B",C`, `html-table CSV quotes headers with commas (got line 0: ${JSON.stringify(r.csv.split("\n")[0])})`);
ok(r.csv.split("\n")[1] === `1,"has ""quotes"""`, `html-table CSV escapes internal quotes per RFC 4180 (got line 1: ${JSON.stringify(r.csv.split("\n")[1])})`);

// Header inference: no <thead>, but the first <tr> has <th> cells → use it.
r = run("html-table", { html: "<table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>" });
ok(r.headers[0] === "K" && r.rows[0].K === "a", `html-table infers header from first <tr> with <th>`);

throws(() => run("html-table", { html: "<div>no table here</div>" }), `html-table fails when no table matches`);
throws(() => run("html-table", { html: "<div><p>oops</p></div>", selector: "p" }), `html-table fails when selector matches a non-<table>`);
throws(() => run("html-table", { html: "<table></table>", format: "yaml" }), `html-table rejects unknown format`);

// ----- html-strip -----
r = run("html-strip", { html: "<h1>Title</h1><p>First paragraph.</p><p>Second.</p><script>alert(1)</script>" });
ok(r.text.includes("Title") && r.text.includes("First paragraph.") && r.text.includes("Second."), `html-strip preserves text content`);
ok(!r.text.includes("alert"), `html-strip removes <script> contents`);
ok(/Title\n+First paragraph\.\n+Second\./.test(r.text), `html-strip separates block elements with newlines (got ${JSON.stringify(r.text)})`);
ok(r.chars === r.text.length, `html-strip reports accurate char count`);

r = run("html-strip", { html: "<div><h1>Keep</h1></div><aside>Drop</aside>", selector: "div" });
ok(r.text.includes("Keep") && !r.text.includes("Drop"), `html-strip scoped to selector only includes that subtree`);

// ----- html-links -----
r = run("html-links", { html: '<a href="/about">About</a><a href="https://example.com">External</a>', base: "https://agent402.tools" });
ok(r.count === 2, `html-links count=2 (got ${r.count})`);
ok(r.links[0].href === "https://agent402.tools/about", `html-links resolves relative href against base (got ${r.links[0].href})`);
ok(r.links[1].href === "https://example.com/", `html-links leaves absolute href alone`);

r = run("html-links", { html: '<a href="/a">1</a><a href="/a">2</a><a href="/b">3</a>' });
ok(r.count === 2, `html-links dedups by href by default (got ${r.count})`);
r = run("html-links", { html: '<a href="/a">1</a><a href="/a">2</a>', unique: false });
ok(r.count === 2, `html-links unique:false returns duplicates`);

r = run("html-links", { html: '<a href="/a">A</a><a href="/b">B</a><a href="https://x.com">X</a>', filter: "^/" });
ok(r.count === 2 && r.links.every((l) => l.href.startsWith("/")), `html-links filter regex limits results (got ${JSON.stringify(r.links.map((l)=>l.href))})`);

throws(() => run("html-links", { html: "<a>x</a>", filter: "(" }), `html-links rejects invalid regex`);

// ----- html-meta -----
r = run("html-meta", {
  html: '<html><head><title>Hi</title><meta name="description" content="x"><meta property="og:title" content="Hi OG"><meta name="twitter:card" content="summary"><link rel="canonical" href="https://example.com/x"><script type="application/ld+json">{"@type":"Article","name":"Foo"}</script></head><body></body></html>',
});
ok(r.title === "Hi", `html-meta extracts <title>`);
ok(r.description === "x", `html-meta extracts <meta description>`);
ok(r.og.title === "Hi OG", `html-meta collects og:* into og namespace`);
ok(r.twitter.card === "summary", `html-meta collects twitter:* into twitter namespace`);
ok(r.canonical === "https://example.com/x", `html-meta extracts <link rel=canonical>`);
ok(r.jsonLd.length === 1 && r.jsonLd[0]["@type"] === "Article", `html-meta parses JSON-LD blocks`);

// JSON-LD that doesn't parse must not blow up the call (skip it, keep going).
r = run("html-meta", {
  html: '<html><head><title>OK</title><script type="application/ld+json">not json</script><script type="application/ld+json">{"@type":"X"}</script></head></html>',
});
ok(r.title === "OK" && r.jsonLd.length === 1 && r.jsonLd[0]["@type"] === "X", `html-meta skips malformed JSON-LD blocks instead of throwing`);

// ----- input-shape contracts -----
for (const t of HTML_TOOLS) {
  // Every tool must reject non-string html input cleanly.
  throws(() => t.handler({ html: 123 }), `${t.slug} rejects non-string html`);
  // Every tool must reject oversize html (5MB cap).
  throws(() => t.handler({ html: "x".repeat(5 * 1024 * 1024 + 1), selector: "p" }), `${t.slug} rejects html >5MB`);
}

// Every tool's documented example input must produce a non-error result —
// this is the same invariant scripts/test-all.js enforces in CI for the
// hosted catalog, replayed here so a broken example fails before push.
for (const t of HTML_TOOLS) {
  const ex = t.discovery?.input;
  ok(ex && typeof ex === "object", `${t.slug} has a documented discovery.input example`);
  let res, err;
  try { res = t.handler(ex); } catch (e) { err = e; }
  ok(!err, `${t.slug} answers its own documented example without throwing${err ? ` (got: ${err.message})` : ""}`);
  ok(res && typeof res === "object", `${t.slug} returns an object from its example`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
