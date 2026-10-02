// wholeTokenMatcher (src/x402-index.js) is the short-term rule of the router:
// "ip" matches "ip lookup" and "geo-ip" but never "gzip". It was a Unicode
// regex and is now an indexOf scan with a boundary check, for speed. This pins
// that the two agree, on hand-picked cases and on a seeded fuzz over ASCII,
// accented Latin, CJK, combining marks and astral-plane characters. Offline.
process.env.X402_INDEX_CRAWL = "off";
import assert from "node:assert/strict";
const { wholeTokenMatcher } = await import("../src/x402-index.js");
const { seededRng } = await import("./lib/route-perf-fixture.js");

const reference = (term) => {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc}(?:$|[^\\p{L}\\p{N}])`, "u");
  return (str) => re.test(str);
};
let n = 0;
const same = (term, str, label) => { n++; assert.equal(wholeTokenMatcher(term)(str), reference(term)(str), `${label}: ${JSON.stringify(term)} in ${JSON.stringify(str)}`); };

for (const [term, str] of [
  ["ip", "ip lookup"], ["ip", "geo-ip"], ["ip", "gzip"], ["ip", "ipv4"], ["ip", "IP"], ["ip", "x ip"], ["ip", ""],
  ["to", "json to csv"], ["to", "tokens to"], ["to", "auto"], ["a", "a"], ["a", "aa a"], ["a", "éa"], ["a", "á"],
  ["a", "\u{1D400}a"], ["a", "a\u{1D400}"], ["a", "\u{1F600}a"], ["a", "漢a"], ["io", "i/o io_bus"], ["x", "x\ud800"], ["x", "\udc00x"],
]) same(term, str, "case");

const rnd = seededRng(7);
const alphabet = ["a", "b", "i", "p", "o", "t", " ", "-", "_", "/", ".", "1", "é", "ß", "漢", "́", "\u{1D400}", "\u{1F600}", "\ud800", "\udc00", "Ω"];
const pick = () => alphabet[Math.floor(rnd() * alphabet.length)];
const word = (len) => Array.from({ length: len }, pick).join("");
for (let i = 0; i < 20000; i++) {
  const term = ["a", "i", "ip", "to", "io", "p", "ab", "é", "漢"][i % 9];
  same(term, word(1 + Math.floor(rnd() * 12)), "fuzz");
}
console.log(`test-whole-token-matcher: ${n} passed`);
