// Tests route stubbed fetches by the URL's parsed host (scripts/lib/url-host.js),
// not by a substring of the URL string. `String(url).includes("api.example.com")`
// is CodeQL's js/incomplete-url-substring-sanitization on every suite that writes
// it; each new one is an alert to dismiss by hand, and noise that hides a real
// finding. The test files that predate the helper are frozen, with their counts,
// in scripts/url-substring-baseline.json: a file's count may only fall, a file at
// zero must leave the list, and no new file may appear.
//
// Also checks the helpers themselves, including the inputs a substring check gets
// wrong.
//
//   node scripts/test-url-host-match.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostOf, isHost, urlMatches } from "./lib/url-host.js";

const DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// ---- the helpers ----
ok(isHost("https://api.example.com/v1/x", "api.example.com"), "isHost: the host itself");
ok(isHost(new URL("https://API.example.com/"), "api.example.com"), "isHost: a URL object, case-insensitive");
ok(isHost(new Request("https://api.example.com/v1"), "api.example.com"), "isHost: a Request");
ok(!isHost("https://evil.test/?u=api.example.com", "api.example.com"), "isHost: a host named in the query is not the host");
ok(!isHost("https://api.example.com.evil.test/", "api.example.com"), "isHost: a longer host that starts with it is not the host");
ok(!isHost("https://sub.api.example.com/", "api.example.com"), "isHost: a subdomain is not the host");
ok(!isHost("not a url", "api.example.com") && hostOf("not a url") === "", "isHost: an unparseable string is no host");
ok(urlMatches("https://api.example.com/v1/embeddings", "api.example.com", "/v1/embeddings"), "urlMatches: host and path prefix");
ok(!urlMatches("https://api.example.com/v2?x=/v1/embeddings", "api.example.com", "/v1/embeddings"), "urlMatches: a path in the query does not count");

// ---- the scan ----
// A URL-ish receiver (url, href, uri, u, input, target, x.url, String(...) of
// one) tested with includes/startsWith/indexOf against a literal naming a host
// ("https://...", "http://..." or a dotted host). A bare file name is not a host.
const RX = /\b(?:String\(\s*(?:[\w.]*\.)?(?:url|u|href|input|target|uri)\s*\)|(?:\w+\.)?(?:url|href|uri)|\bu|\binput|\btarget)\??\.(?:includes|startsWith|indexOf)\(\s*(["'`])(https?:\/\/[^"'`]+|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:][^"'`]*)?)\1/g;
const FILE_NAME = /^[a-z0-9-]+\.(js|mjs|json|html?|txt|md|csv|xml|pdf|png|jpe?g|zip)$/i;
function countSubstringHostChecks(src) {
  let n = 0;
  for (const m of src.matchAll(RX)) if (!FILE_NAME.test(m[2])) n++;
  return n;
}
ok(countSubstringHostChecks('if (String(url).includes("api.example.com")) {}') === 1, "control: String(url).includes(host) is seen");
ok(countSubstringHostChecks('calls.filter((c) => c.url.startsWith("https://blob.test"))') === 1, "control: x.url.startsWith(origin) is seen");
ok(countSubstringHostChecks('if (String(u).includes("acme-10k.htm")) {}') === 0, "control: a file name is not a host");
ok(countSubstringHostChecks('ok(got.includes("https://alpha.example"))') === 0, "control: an array named otherwise is not read");

const counts = {};
for (const f of readdirSync(DIR).filter((f) => /^test-.*\.m?js$/.test(f) && f !== "test-url-host-match.js")) {
  const n = countSubstringHostChecks(readFileSync(join(DIR, f), "utf8"));
  if (n) counts[f] = n;
}
const baseline = JSON.parse(readFileSync(join(DIR, "url-substring-baseline.json"), "utf8")).files;
const added = Object.keys(counts).filter((f) => !(f in baseline));
const grown = Object.keys(counts).filter((f) => f in baseline && counts[f] > baseline[f]);
const stale = Object.keys(baseline).filter((f) => (counts[f] || 0) < baseline[f]);
ok(added.length === 0, `no new test routes a fetch by a URL substring (use isHost/urlMatches from scripts/lib/url-host.js)${added.length ? `:\n  ${added.map((f) => `${f} (${counts[f]})`).join("\n  ")}` : ""}`);
ok(grown.length === 0, `no frozen file adds a URL substring check${grown.length ? `:\n  ${grown.map((f) => `${f} (${baseline[f]} -> ${counts[f]})`).join("\n  ")}` : ""}`);
ok(stale.length === 0, `the baseline matches what is left (lower a count, or delete a file at zero)${stale.length ? `:\n  ${stale.map((f) => `${f} (${baseline[f]} -> ${counts[f] || 0})`).join("\n  ")}` : ""}`);
ok(Object.keys(counts).length >= 1 || Object.keys(baseline).length === 0, "the scan reads the test fleet");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
