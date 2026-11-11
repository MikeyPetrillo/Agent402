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
//   4. Seller keys that are not the text a parser makes of them (scheme and
//      host case, written default and odd ports, hosts a parser rewrites,
//      credentials, trailing dots, paths with dot segments and encoded
//      slashes), every combination, read the reference answer for plain and
//      hostile routes, and the plain routes of such a key parse nothing.
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
  // A key that is not the text a parser makes of it is read once too: the
  // host's case (every row stays) and a written default port (the host as
  // parsed is not the host as written, so every row leaves).
  for (const [seller, want, what] of [["HTTPS://Off-Seller-Rows.EXAMPLE/app/tenant-a", false, "an uppercase host"], ["https://off-seller-rows.example:443", true, "a written default port"], ["https://Off-Seller-Rows.example:8443/App//v1/", false, "an odd port, mixed case and a doubled slash"]]) {
    const rows = Array.from({ length: N }, (_, i) => row(seller, i));
    const sts = await counted(() => rows.map((t) => x._computeToolStaticsForTest(t)));
    const n = parses;
    const agree = rows.every((t) => reference(t.seller, t.route) === want);
    ok(n <= 2 && agree && sts.every((st) => st.offSeller === want), `${N} ordinary rows under a key with ${what} parse the key and nothing per row, and read the parsed answer, ${want ? "off" : "under"} the seller (${n} parses)`);
  }
  // CONTROL: the counter sees a parse, and a row that needs one gets it and its answer.
  const odd = [row("https://off-seller-rows.example/app/tenant-a", 1, "/../other/x"), row("https://off-seller-rows.example", 2, "@victim.example/x"), row("https://off-seller-rows.example/a/../b", 3, "/x")];
  const sts = await counted(() => odd.map((t) => x._computeToolStaticsForTest(t)));
  ok(parses >= 6 && sts[0].offSeller === true && sts[1].offSeller === true && sts[2].offSeller === reference(odd[2].seller, odd[2].route), `CONTROL: a row a parser could read differently is parsed and reads the parsed answer (${parses} parses over ${odd.length} rows)`);
  const local = await counted(() => x._computeToolStaticsForTest({ ...row("self", 4), route: "@victim.example/x" }));
  ok(local.offSeller === false && parses === 0, "this host's own rows are never read as off their seller, and parse nothing");
}

// --- 4. Seller keys a parser rewrites, every combination of the parts.
{
  const SCHEMES = ["https://", "HTTPS://", "Https://", "http://", "hTTp://"];
  const HOSTS = ["a.com", "A.COM", "A.com", "a.Com.", "a.com.", "sub.A.com", "b\u00fccher.example", "B\u00dcCHER.example", "xn--bcher-kva.example", "XN--BCHER-KVA.example", "\u0130stanbul.example", "ex%41mple.com", "a%2ecom", "127.0.0.1", "0x7f.1", "2130706433", "[::1]", "[0:0:0:0:0:0:0:1]", "[::FFFF:1.2.3.4]",
    "user@a.com", "user:pw@a.com", "@a.com", ":@a.com", "a.com@evil.com", "A.com:pw@Evil.com", "a_b.com", "-a.com", "a..com", "a.com-", "\uff41.com", "a\u3002com", "a.com%00", "a,b.com", "a b.com", "a|b.com", "a^b.com", "{a}.com", "a..", "."];
  const PORTS = ["", ":443", ":80", ":0443", ":080", ":8443", ":08443", ":", ":0", ":65535", ":65536", ":99999", ":4a", ":-1", ":443:443"];
  const PATHS = ["", "/", "//", "/app", "/App/V1", "/app/", "/app//", "/a//b", "/a/../b", "/a/./b", "/a/.", "/a/..", "/..", "/.", "/...", "/..a", "/a..", "/.a/b", "/%2e%2e", "/%2E", "/a%2eb", "/.%2e/x", "/%41pp", "/%2f", "/a%2Fb", "/a%2f..%2fb", "/%5c", "/%", "/%zz", "/\u00e9", "/p@q", "/p:q", "/a.b", "/a;b=c", "/a{b}", "/a|b", "/a^b", "/a`b", "/a\"b", "/a<b>", "/a'b", "/~a", "/a!$&()*+,=", "/a[b]", "/@evil.com", "/:80", "/https://evil.com"];
  const PLAIN_ROUTES = ["/x", "/", "/?q=1", "/app/x", "/v1/tools/t-1/run.json?mode=3", "//evil.com/@y?z#w", "/a%2fb%2F..%2f", "/%5c..%5c", "/:80/@evil.com", "/..."];
  const pool = [...ROUTES, ...generated];
  let compared = 0, leaves = 0, keys = 0, textKeys = 0, textPairs = 0, textLeave = 0, textStay = 0, parses = 0;
  const diffs = [];
  const CountedURL = class extends RealURL { constructor(...args) { parses++; super(...args); } };
  const one = (seller, route) => {
    const want = reference(seller, route);
    x._routeLeavesSellerForTest(seller, route); // the seller key's one read
    parses = 0;
    globalThis.URL = CountedURL;
    let got;
    try { got = x._routeLeavesSellerForTest(seller, route); } finally { globalThis.URL = RealURL; }
    const text = parses === 0;
    compared++;
    if (want) leaves++;
    if (got !== want) diffs.push(`${JSON.stringify(seller)} + ${JSON.stringify(route)}: got ${got}, reference ${want}`);
    return { text, want };
  };
  for (const sc of SCHEMES) for (const h of HOSTS) for (const p of PORTS) for (const path of PATHS) {
    const seller = `${sc}${h}${p}${path}`;
    keys++;
    let allText = true;
    for (const r of PLAIN_ROUTES) { const o = one(seller, r); if (o.text) { textPairs++; if (o.want) textLeave++; else textStay++; } else allText = false; }
    if (allText) textKeys++;
    for (let i = 0; i < 4; i++) one(seller, pool[rnd(pool.length)]);
  }
  for (const d of diffs.slice(0, 12)) console.error(`  differs: ${d}`);
  ok(diffs.length === 0, `seller keys a parser rewrites read the parsed answer for every input (${compared} pairs: ${keys} keys from ${SCHEMES.length} schemes, ${HOSTS.length} hosts, ${PORTS.length} ports and ${PATHS.length} paths, each by ${PLAIN_ROUTES.length} plain routes and 4 drawn from the hostile and generated sets; ${diffs.length} differences)`);
  ok(leaves > compared / 10 && compared - leaves > compared / 20, `...over a corpus that holds both answers (${leaves} leave, ${compared - leaves} stay)`);
  ok(textKeys > keys / 2 && textLeave > 1000 && textStay > 1000, `...and ${textKeys} of the ${keys} keys decide every plain route from the key's one parse (${textPairs} pairs with no parse: ${textLeave} leave, ${textStay} stay)`);
}

// --- 5. The kept answer per seller key: keyed on the key as written, bounded.
{
  // Two keys that lowercase to the same text: the first's path is ASCII (no
  // plain route leaves), the second's holds the Kelvin sign, which lowercases
  // to "k" but which a parser percent-encodes (every route leaves). Read in
  // that order, the second must not take the first's kept answer.
  const first = "HTTPS://case-memo.example/kpp", second = "HTTPS://case-memo.example/\u212App";
  ok(first.toLowerCase() === second.toLowerCase() && first !== second, "setup: the two keys share their lowercase text");
  const a = x._routeLeavesSellerForTest(first, "/r"), b = x._routeLeavesSellerForTest(second, "/r");
  ok(a === x._routeLeavesSellerParsedForTest(first, "/r") && a === false, `the ASCII key keeps its routes (${a})`);
  ok(b === x._routeLeavesSellerParsedForTest(second, "/r") && b === true, `the Kelvin-sign key read second still reads its own parsed answer, never the first key's (${b})`);

  // The kept answers are bounded like the plain-key memo: past its size the
  // table starts over, so the first key of a long run is parsed again (one
  // parse), where an unbounded table would answer it from memory (none).
  const keyAt = (i) => `HTTPS://memo-${i}.example/app/`;
  ok(x._routeLeavesSellerForTest(keyAt(0), "/x") === false, "setup: a key that is not plain text decides its plain routes from its one kept read");
  let parses = 0;
  const CountedURL = class extends RealURL { constructor(...args) { parses++; super(...args); } };
  globalThis.URL = CountedURL;
  try { x._routeLeavesSellerForTest(keyAt(0), "/y"); } finally { globalThis.URL = RealURL; }
  ok(parses === 0, `control: a kept key is answered from memory (${parses} parses)`);
  for (let i = 1; i <= 20_000; i++) x._routeLeavesSellerForTest(keyAt(i), "/x");
  parses = 0;
  globalThis.URL = CountedURL;
  let again;
  try { again = x._routeLeavesSellerForTest(keyAt(0), "/y"); } finally { globalThis.URL = RealURL; }
  ok(parses === 1 && again === false, `after 20,000 more keys the first is read again, once (${parses} parses), with the same answer (${again})`);
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
