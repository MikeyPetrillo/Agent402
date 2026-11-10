// A listed route whose text joins to a URL outside its seller's key is never
// ranked (offSeller in a row's statics, src/x402-index.js). An index add
// computes it for every tool row it holds, so the ordinary row is decided
// from its text and parses no URL; only a seller key or a route a parser
// could read differently is parsed.
//   1. The text-first answer equals the parsed answer for every input: a
//      hostile corpus of seller keys and routes (prefix look-alikes,
//      credentials, backslashes, scheme case, default ports,
//      protocol-relative text, dot segments written out and encoded,
//      whitespace and control characters, non-strings) and twelve thousand
//      generated routes. The reference is written out here, independent of
//      the module's own parsed path, which is compared too.
//   2. Named cases read the value they should.
//   3. A seller's ordinary rows parse one URL for the seller and none per
//      row, and a row's statics carry the same offSeller either way.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { joinSellerRoute } from "../src/x402-live-quote.js";

const x = await import("../src/x402-index.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// The reference: the joined text read as a URL, as the check was first written.
const RealURL = globalThis.URL;
function reference(seller, route) {
  let u;
  try { u = new RealURL(joinSellerRoute(seller, route)); } catch { return true; }
  return !!(u.username || u.password) || !x.isUnderSeller(u.href, seller);
}

const SELLERS = [
  "https://a.com", "https://a.com/app", "https://a.com/App/tenant-a", "https://a.com/app/v1", "http://a.com", "http://a.com/app",
  "HTTPS://a.com", "https://A.COM", "https://A.com/App", "Https://a.com/app",
  "https://a.com:443", "https://a.com:8443", "https://a.com:8443/app", "http://a.com:80", "http://a.com:080", "https://a.com:0443", "https://a.com:0", "https://a.com:99999", "https://a.com:/p", "https://a.com:",
  "https://a.com/", "https://a.com/app/", "https://a.com//", "https://a.com//x", "https://a.com/app//x",
  "https://user@a.com", "https://user:pw@a.com", "https://@a.com", "https://:@a.com", "https://a.com@evil.com", "https://a.com:pw@evil.com/app",
  "https://a.com.evil.com", "https://a.com.evil.com/app", "https://a.com\\evil", "https://a.com\\@evil.com", "https://a.com/app\\x", "https:\\\\a.com",
  "https://a.com?x", "https://a.com#x", "https://a.com/app?x", "https://a.com/app#x", "https://a.com/app?", "https://a.com/app#",
  " https://a.com", "https://a.com ", "https://a.com\t", "https://a\tb.com", "https://a.com/a\nb", "\u0000https://a.com", "https://a.com/\u007f",
  "//a.com", "a.com", "", "local", "ftp://a.com", "ws://a.com", "file:///x", "javascript:alert(1)", "data:text/plain,x", "https:/a.com", "https:a.com", "https://", "https:///a.com",
  "https://1.2.3", "https://0x7f.1", "https://127.0.0.1", "https://127.0.0.1:8080/p", "https://2130706433", "https://1.2.3.4.5", "https://[::1]", "https://[::1]:8080/p", "https://[0:0:0:0:0:0:0:1]",
  "https://xn--bcher-kva.example", "https://b\u00fccher.example", "https://xn--a.example", "https://a..com", "https://a.com.", "https://a.com./app", "https://a_b.com", "https://-a.com", "https://a.com-",
  "https://a.com/a/../b", "https://a.com/a/./b", "https://a.com/..", "https://a.com/.", "https://a.com/%61pp", "https://a.com/a%2e%2e/b", "https://a.com/%2e%2e", "https://a.com/\u00e9", "https://a.com/p q", "https://a.com/p%20q", "https://a.com/p@q", "https://a.com/p:q", "https://a.com/a.b",
];
const ROUTES = [
  "/", "/x", "/x/y", "/x/y/", "/?q=1", "/?", "/#f", "/x?a=b#c", "/weather", "/v1/file.json", "/users/{id}", "/a.b/c.d", "/app", "/app/x", "/App/tenant-a/x", "/app2",
  "", "x", "x/y", "?x", "#x", "weather",
  "//evil.com", "//evil.com/x", "///evil.com", "/\\evil.com", "\\\\evil.com", "\\evil.com", "/\\/evil.com", "/\\\\evil.com",
  "@evil.com/x", "@victim.example/weather", ".evil.com/x", ".evil.example/weather", ":8080/x", ":443", ":443/x", ":80", "/@evil.com", "/x@evil.com", "/:80", "-evil.com/x",
  "https://evil.com/x", "https://a.com/x", "HTTPS://a.com/x", "http://a.com/x", "/https://evil.com", "/http:/evil.com",
  "/..", "/../", "/../x", "/a/../../x", "/a/..", "/a/../b", "/./x", "/.", "/./", "/a/.", "/a/./b", "/a/b/../../../c", "/app/../x", "/x/../app/y",
  "/%2e%2e/x", "/%2E%2E/x", "/.%2e/x", "/%2e./x", "/%2e/x", "/a/%2e%2e", "/a/%2E%2e/", "/%2e%2e", "/%2e", "/%252e%252e/x", "/%2f..%2f..", "/%5c..%5c..", "/..%2f", "/..%5c", "/%2e%2e%2f", "/%2e%2e%5cx",
  "/..;/x", "/...", "/.../x", "/..x", "/x..", "/.x", "/x.", "/..x/y", "/a/..b", "/a/b..",
  "/a/..\\x", "/a\\..\\..\\x", "/..\\x", "/\\..", "/\\../x", "/a\\b",
  "/\t../x", "/.\t./x", "/.\n./x", "/.\r./x", "/x\r", "/x ", " /x", "\t/x", "\n/x", "/x\u0000", "\u0000/x", "/\u0000../x", "/x\u007f", "/\u001f", "/ ", "/a b",
  "/\u00a0", "/\u2028..", "/\u00e9", "/\u200b../x", "/.\u200b./x", "/x\ufeff", "\ufeff/x", "/\ud800", "/\uff0e\uff0e/x", "/\u2024\u2024/x",
  "/.. ", "/..  ", "/a/../.. ", "/x/.. ", "/. ", "/..\u001f", "/..\u0000", "/a/../..\u0001",
  "/x?y=/../z", "/x#/../z", "/x?..", "/x?../", "/?/..", "/?/../..", "/#/..", "/x#..", "/..?x", "/..#x", "/.?x", "/a/..?x", "/a/..#x",
  "/%00", "/%0a", "/.%0a./x", "/%2e%0a%2e", "/%", "/%2", "/%zz",
  null, undefined, 0, 1, true, false, {}, [], ["/x"], ["/..", "x"], { toString() { return "/x"; } },
];

// Generated routes: fragments a parser treats specially, joined at random
// (a fixed seed, so a difference found once is found again).
let seed = 0x2f6e2b1;
const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const FRAGMENTS = ["/", "/", "/", "..", ".", "%2e", "%2E", "\\", "a", "b", "app", "x.json", "?", "#", "@", ":", "evil.com", "\t", " ", "\n", "%", "{id}", "\u00e9", "//", "/..", "/./", "/../", "..;", "%2f", "%5c", "v1", "-", "_", "~", "\u0000"];
const generated = [];
for (let i = 0; i < 6000; i++) {
  let r = rnd(4) ? "/" : "";
  for (let n = 1 + rnd(8); n > 0; n--) r += FRAGMENTS[rnd(FRAGMENTS.length)];
  generated.push(r);
}

// A second set near the text rule's own boundary: paths of ordinary characters
// with dots, percent signs and delimiters in every position, no character
// the rule sends to the parser outright.
const NEAR_PLAIN = ["/", "/", "a", "b", "app", "x.json", "v1", ".", ".", "..", "...", "?", "#", "@", ":", "%2", "%", "e", "E", "2e", "-", "~", "{id}", ";", "=", "&", "+", ",", "\u00e9"];
for (let i = 0; i < 6000; i++) {
  let r = "/";
  for (let n = 1 + rnd(7); n > 0; n--) r += NEAR_PLAIN[rnd(NEAR_PLAIN.length)];
  generated.push(r);
}

// --- 1. Zero differences.
{
  let compared = 0, leaves = 0, byText = 0, parses = 0;
  const diffs = [];
  const CountedURL = class extends RealURL { constructor(...args) { parses++; super(...args); } };
  const check = (seller, route) => {
    const want = reference(seller, route);
    x._routeLeavesSellerForTest(seller, route); // the seller key's one read
    parses = 0;
    globalThis.URL = CountedURL;
    let got;
    try { got = x._routeLeavesSellerForTest(seller, route); } finally { globalThis.URL = RealURL; }
    if (parses === 0) byText++;
    const parsed = x._routeLeavesSellerParsedForTest(seller, route);
    compared++;
    if (want) leaves++;
    if (got !== want || parsed !== want) diffs.push(`${JSON.stringify(seller)} + ${JSON.stringify(route)}: text-first ${got}, parsed ${parsed}, reference ${want}`);
  };
  for (const s of SELLERS) for (const r of ROUTES) check(s, r);
  for (let i = 0; i < generated.length; i++) for (const s of [SELLERS[i % SELLERS.length], SELLERS[rnd(6)]]) check(s, generated[i]);
  for (const d of diffs.slice(0, 12)) console.error(`  differs: ${d}`);
  ok(diffs.length === 0, `the text-first answer is the parsed answer for every input (${compared} pairs: ${SELLERS.length} seller keys by ${ROUTES.length} hostile routes, and ${generated.length} generated routes twice; ${diffs.length} differences)`);
  ok(leaves > compared / 10 && compared - leaves > compared / 20, `...over a corpus that holds both answers (${leaves} leave, ${compared - leaves} stay)`);
  ok(byText > 500 && compared - byText > 500, `...and both paths: ${byText} pairs decided from the text with no parse, ${compared - byText} parsed`);
}

// --- 2. Named cases.
{
  const leavesOf = x._routeLeavesSellerForTest;
  const stay = [["https://a.com", "/weather"], ["https://a.com", "//evil.com/x"], ["https://a.com", "/@evil.com"], ["https://a.com", "/../x"], ["https://a.com/app", "/x"], ["https://a.com/app", "/"], ["https://a.com/app", "/?q=1"], ["https://a.com/app", "/x/../y"], ["https://a.com:8443/app", "/x"]];
  const leave = [["https://a.com", "@victim.example/weather"], ["https://a.com", ".evil.example/weather"], ["https://a.com", ":8080/x"], ["https://a.com", "https://evil.com/x"], ["https://a.com/app", "/../x"], ["https://a.com/app", "/%2e%2e/x"], ["https://a.com/app", "/x/../../y"], ["https://a.com/app", "/..\\x"], ["https://a.com/app", "/.\t./x"], ["https://user@a.com", "/x"], ["https://A.com:443", "/x"], ["not a url", "/x"]];
  const wrong = [...stay.filter(([s, r]) => leavesOf(s, r) !== false), ...leave.filter(([s, r]) => leavesOf(s, r) !== true)];
  ok(wrong.length === 0, `named cases: ${stay.length} routes stay under their seller and ${leave.length} leave it (${wrong.length ? `wrong: ${JSON.stringify(wrong)}` : "all as written"})`);
}

// --- 3. Ordinary rows parse nothing per row.
{
  let parses = 0;
  const counted = async (fn) => {
    parses = 0;
    globalThis.URL = class extends RealURL { constructor(...args) { parses++; super(...args); } };
    try { return fn(); } finally { globalThis.URL = RealURL; }
  };
  const N = 5000;
  const row = (seller, i, route = `/v1/tools/tool-${i}/run.json?mode=${i % 7}`) => ({ seller, slug: `tool-${i}`, name: `Tool ${i}`, description: "returns a figure for a query", category: "data", tags: ["a", "b"], route, price: "$0.002", networks: ["eip155:8453"] });
  for (const seller of ["https://off-seller-rows.example", "https://off-seller-rows.example/app/tenant-a"]) {
    const rows = Array.from({ length: N }, (_, i) => row(seller, i));
    const sts = await counted(() => rows.map((t) => x._computeToolStaticsForTest(t)));
    const n = parses;
    ok(n <= 1 && sts.every((st) => st.offSeller === false), `${N} ordinary rows of ${seller.includes("/app") ? "a path seller" : "a seller"} parse one URL for the seller key and none per row (${n} parses)`);
  }
  // CONTROL: the counter sees a parse, and a row that needs one gets it and its answer.
  const odd = [row("https://off-seller-rows.example/app/tenant-a", 1, "/../other/x"), row("https://off-seller-rows.example", 2, "@victim.example/x"), row("HTTPS://Off-Seller-Rows.example", 3, "/x")];
  const sts = await counted(() => odd.map((t) => x._computeToolStaticsForTest(t)));
  ok(parses >= 3 && sts[0].offSeller === true && sts[1].offSeller === true && sts[2].offSeller === reference(odd[2].seller, odd[2].route), `CONTROL: a row a parser could read differently is parsed and reads the parsed answer (${parses} parses over ${odd.length} rows)`);
  const local = await counted(() => x._computeToolStaticsForTest({ ...row("self", 4), route: "@victim.example/x" }));
  ok(local.offSeller === false && parses === 0, "this host's own rows are never read as off their seller, and parse nothing");
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
