// A KEYLESS PUBLIC UPSTREAM'S OUTAGE IS READ AGAINST THE RUNNER.
//
// A tool that reads a keyless public upstream (NWS, USGS, Open-Meteo, the
// federal data APIs, ...) answers that upstream's failure in the shared fetch
// helper's words (src/tools/fetch-guard.js): a 502 "Source URL's host returned
// HTTP 5xx", or a 504 "Source URL did not respond within our N s limit" /
// "Could not connect to source URL". A sweep excuses such an answer only when
// ALL of these hold, and fails it otherwise:
//
//   1. the answer is one of those upstream-error shapes (any other 5xx of ours,
//      a 500, a parse 502, a keyed refusal, never qualifies);
//   2. the booted server recorded a failed outbound request during that very
//      call (upstream-failure-log-preload.js), to a host the tool's own
//      definition names in src/tools/ (derived from the code, not typed here);
//   3. that request was keyless and a GET (no credential is ever re-sent, and
//      CI holds no production key);
//   4. the runner's own direct read of the same URL, right now, fails too (an
//      answer of 500 or above, a 429, or no answer). If the upstream answers
//      the runner, the tool failing is ours and it fails.
//
// An access refusal is read the same way, by exact status: our answer that
// the host refused this server (a 422 naming HTTP 401 or 403, or a 503 naming
// a 429), a recorded request to a host the tool's definition names that got
// that same status during the call (keyless, a GET), and the runner's own
// direct read of that request getting that same status right now. A refusal
// the runner is not given (it reads 200, or a different status) fails.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function upstreamFailureLogPath() {
  return process.env.UPSTREAM_FAILURE_LOG || join(tmpdir(), "agent402-upstream-failures.jsonl");
}

const KEYED_NAME = /key|token|secret|sig|auth|passw|credential|session|cookie/i;
// Hosts whose credential rides in the URL PATH ("/v2/{key}"), which no
// parameter or header name shows.
const PATH_KEYED_HOSTS = ["g.alchemy.com"];
const SECRET_MIN_CHARS = 12;
/** The values of this process's credential-like environment variables
 *  (names as KEYED_NAME, values of SECRET_MIN_CHARS or more). */
function configuredSecrets(env) {
  const out = [];
  for (const [name, value] of Object.entries(env || {})) {
    if (KEYED_NAME.test(name) && typeof value === "string" && value.length >= SECRET_MIN_CHARS) out.push(value);
  }
  return out;
}
/** True when a request carries a credential: a key-like query parameter or
 *  header name, a host that takes its key in the path, or a configured
 *  credential's value anywhere in the URL (a key in a path segment). Such a
 *  request is never logged by URL nor re-read. */
export function isKeyedRequest(u, headers, env = process.env) {
  for (const name of u.searchParams.keys()) if (KEYED_NAME.test(name)) return true;
  if (u.username || u.password) return true;
  const host = u.hostname.toLowerCase();
  if (PATH_KEYED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  let href = u.href;
  try { href = `${href}\n${decodeURIComponent(u.href)}`; } catch { /* the raw form is still read */ }
  if (configuredSecrets(env).some((v) => href.includes(v) || href.includes(encodeURIComponent(v)))) return true;
  let names = [];
  if (headers && typeof headers.keys === "function") names = [...headers.keys()];
  else if (Array.isArray(headers)) names = headers.map((h) => h?.[0]);
  else if (headers && typeof headers === "object") names = Object.keys(headers);
  return names.some((n) => KEYED_NAME.test(String(n)));
}

const UPSTREAM_SHAPES = [
  [502, /^Source URL's host returned HTTP 5\d\d\b/],
  [504, /^Source URL did not respond within our \d+ s limit/],
  [504, /^Could not connect to source URL: /],
  // cert-transparency reads its log with its own GET (src/tools/network-kit2.js)
  // and answers the log's deadline and 5xx or 429 in its own words, as a 502.
  [502, /^The upstream cert transparency logs? did not respond within \d+ s\b/],
  [502, /^crt\.sh returned HTTP (?:5\d\d|429)\b/],
];
/** True for the shared fetch helper's upstream-failure answers, and the few
 *  tools' own words for the same failure listed above. */
export function isUpstreamErrorShape(status, body) {
  const msg = String(body?.error || "");
  return UPSTREAM_SHAPES.some(([st, re]) => st === status && re.test(msg));
}

const ACCESS_SHAPES = [
  [422, /^The host refused this server's request \(HTTP (401|403)\)/],
  [503, /^The host rate-limited or timed out this server \(HTTP (429)\)/],
];
/** The upstream status our access-refusal answer names (401, 403 or 429), else null. */
export function accessRefusalStatus(status, body) {
  const msg = String(body?.error || "");
  for (const [st, re] of ACCESS_SHAPES) {
    const m = st === status ? re.exec(msg) : null;
    if (m) return Number(m[1]);
  }
  return null;
}
/** The statuses the failure-log preload records besides 500 and above. */
export const ACCESS_STATUSES = new Set([401, 403, 429]);

let kitTexts = null;
function kits(root) {
  if (!kitTexts || kitTexts.root !== root) {
    const dir = join(root, "src", "tools");
    kitTexts = { root, files: readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dir, f), "utf8")) };
  }
  return kitTexts.files;
}
// A URL literal's host, or a quoted bare host name (a kit's host table:
// `host: "api.open-meteo.com"`); a bare name must end in a letter TLD, so a
// version string never reads as a host.
const HOST_LITERAL = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)|["'`]((?:[a-z0-9-]+\.)+[a-z]{2,})["'`]/gi;
const hostsIn = (s) => new Set([...s.matchAll(HOST_LITERAL)].map((m) => (m[1] || m[2]).toLowerCase()));
/** A tool's definition text in src/tools/ (from its `route: "` to the next
 *  one) and its kit file's, or null when the slug is not defined there. */
function definitionOf(slug, root) {
  const marker = `slug: "${slug}"`;
  for (const text of kits(root)) {
    // The definition, not a reference (a skill step also says `slug: "x"`):
    // the marker sits in the same object as a `route: "` just before it.
    for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
      const start = text.lastIndexOf('route: "', at);
      if (start < 0 || at - start > 400) continue;
      // The route is this slug's own, not the previous definition's.
      if (text.slice(start, at).includes('slug: "')) continue;
      const next = text.indexOf('route: "', at);
      return { own: text.slice(start, next < 0 ? text.length : next), kit: text };
    }
  }
  // A definition built by a factory writes no route literal beside its slug
  // (`route: \`GET /api/${slug}\``): the call that names the slug, up to the
  // next one, is the definition.
  for (const text of kits(root)) {
    const at = text.indexOf(marker);
    if (at < 0) continue;
    const next = text.indexOf('slug: "', at + marker.length);
    return { own: text.slice(at, next < 0 ? text.length : next), kit: text };
  }
  return null;
}
/** The upstream hosts a tool's definition names, read from src/tools/: the
 *  hosts in the tool's own definition, or, when that names none (a kit-wide
 *  base URL), every host in its kit file. Empty when the slug is not defined
 *  there. */
export function upstreamHostsForSlug(slug, root = ROOT) {
  const def = definitionOf(slug, root);
  if (!def) return new Set();
  const declared = DECLARED_HOSTS.exec(def.own);
  if (declared) return hostsIn(declared[1] ?? namedHostList(declared[2], root));
  const own = hostsIn(def.own);
  return own.size ? own : hostsIn(def.kit);
}
// A definition that reads its upstream through another module (a shared read
// helper, or other tools' handlers) writes the hosts it reads as a literal
// list: `upstreamHosts: ["api.example.org"]`. Where it is written, it is the
// whole answer: a host the definition only cites or shows in an example is
// not one it reads.
// A source whose hosts one module alone may name is declared by that module's
// exported list instead (`upstreamHosts: CG_API_HOSTS`): the list's literal,
// `const CG_API_HOSTS = Object.freeze([...])` in src/tools/, is read the same way.
const DECLARED_HOSTS = /\bupstreamHosts:\s*(?:\[([^\]]*)\]|([A-Z][A-Z0-9_]*)\b)/;
function namedHostList(name, root) {
  const re = new RegExp(`\\bconst ${name}\\s*=\\s*(?:Object\\.freeze\\()?\\[([^\\]]*)\\]`);
  for (const text of kits(root)) { const m = re.exec(text); if (m) return m[1]; }
  return "";
}
/** True when the tool's own definition declares the hosts it reads. */
export function declaresUpstreamHosts(slug, root = ROOT) {
  const def = definitionOf(slug, root);
  return Boolean(def && DECLARED_HOSTS.test(def.own) && upstreamHostsForSlug(slug, root).size);
}

// A BUNDLE PRODUCT'S FAILURE IS ITS LEG'S. A bundle runs other catalog tools
// (its legs) in process and answers a leg's source-side failure in its own
// words, naming the first unit, the leg and the leg's message:
//   "N of M unit(s) could not be completed on the source's side (first:
//    <unit>, <leg>: <the leg's message>). Nothing was charged. Retry later."
//   (src/tools/bundle-kit.js; the charge sentence only inside a route call)
// as a 502, 503 or 504. That answer is read as the leg's own answer, by the
// same rule: excused only when the leg's message is one of the shared fetch
// helper's upstream answers, a failed request to a host the bundle declares
// was recorded during the call, and the runner's direct read of that request
// fails the same way. Any other answer of a bundle is not read here.
const BUNDLE_FAILURE = /^\d+ of \d+ unit\(s\) could not be completed on the source's side \(first: ([^]*)\)\.(?: Nothing was charged\.)? Retry later\.$/;
/** The leg answer inside a bundle's source-side failure: { leg, status, body }
 *  for a leg in `legs`, else null. */
export function bundleLegAnswer(status, body, legs) {
  if (![502, 503, 504].includes(status) || !Array.isArray(legs) || !legs.length) return null;
  const m = BUNDLE_FAILURE.exec(String(body?.error || ""));
  if (!m) return null;
  let best = null;
  for (const leg of legs) {
    const at = m[1].indexOf(`, ${leg}: `);
    if (at >= 0 && (!best || at < best.at)) best = { at, leg };
  }
  if (!best) return null;
  return { leg: best.leg, status, body: { error: m[1].slice(best.at + best.leg.length + 4) } };
}
/** The verdict on a bundle's failed answer: null when it is not a leg's
 *  upstream answer (the caller grades it by its other rules), else the outage
 *  verdict, final either way, with the leg named. The failed request must be
 *  to a host the BUNDLE declares, in the shape the leg's definition builds. */
export async function bundleOutageVerdict({ slug, legs, status, body, ...rest }) {
  const inner = bundleLegAnswer(status, body, legs);
  if (!inner) return null;
  const refused = legRefusalStatus(inner.status, inner.body);
  if (!refused && !isUpstreamErrorShape(inner.status, inner.body)) return null;
  const v = await upstreamOutageVerdict({ ...rest, slug, shapeSlug: inner.leg, status: inner.status, body: inner.body, refused });
  return { ...v, leg: inner.leg };
}
// A leg that reads through its own helper says its source's rate limit in
// that helper's words (src/tools/crypto-markets-kit.js), a 503 like the
// shared fetch helper's: read as the same refusal, the source's 429.
const LEG_RATE_LIMIT_SHAPES = [
  [503, /^Market data upstream rate-limited this request\b/],
];
/** The upstream status a leg's refusal names: the shared fetch helper's
 *  (401, 403, 429), or 429 for a leg helper's own rate-limit answer; else null. */
export function legRefusalStatus(status, body) {
  const named = accessRefusalStatus(status, body);
  if (named) return named;
  const msg = String(body?.error || "");
  return LEG_RATE_LIMIT_SHAPES.some(([st, re]) => st === status && re.test(msg)) ? 429 : null;
}

// The static path a definition writes before its first interpolation: after
// a URL literal's host ("https://api.weather.gov/alerts/active?area=${...}"
// gives /alerts/active), or after a base constant ("${DEXSCREENER}/token-pairs/v1/solana/${mint}").
const URL_PATH_LITERAL = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(\/[^\s"'`$?#]*)?/gi;
const BASE_PATH_LITERAL = /\$\{[A-Za-z_][\w.]*\}(\/[^\s"'`$?#]*)/g;
// What an interpolation of a missing or unshaped value leaves in a URL.
const URL_RESIDUE = /(?:^|[/=,&:;])(?:undefined|null|NaN)(?=$|[/,&;?#])|\[object(?:%20| )Object\]|%5Bobject%20Object%5D/i;
/** Does the failed request have the shape the tool's definition builds? A
 *  URL with an interpolation's residue in it (undefined, null, NaN, an
 *  object's string form) or an empty path segment is a URL we built wrong,
 *  and so is one whose path starts with none of the static paths the
 *  definition writes for it (when it writes any). A wrong URL's 5xx is ours,
 *  whatever the upstream answers the runner. */
export function requestMatchesDefinition(slug, url, root = ROOT) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (/\/\//.test(u.pathname) || URL_RESIDUE.test(u.pathname) || URL_RESIDUE.test(u.search)) return false;
  const def = definitionOf(slug, root);
  if (!def) return false;
  const host = u.hostname.toLowerCase();
  const prefixes = new Set();
  const read = (text) => {
    for (const m of text.matchAll(URL_PATH_LITERAL)) if (m[1].toLowerCase() === host && m[2] && m[2].length > 1) prefixes.add(m[2]);
    for (const m of text.matchAll(BASE_PATH_LITERAL)) if (m[1].length > 1) prefixes.add(m[1]);
  };
  read(def.own);
  if (!prefixes.size) read(def.kit);
  if (!prefixes.size) return true;
  return [...prefixes].some((p) => u.pathname.startsWith(p));
}

/** The log rows recorded in [t0, t1]. */
export function failuresBetween(t0, t1, logPath = upstreamFailureLogPath()) {
  if (!existsSync(logPath)) return [];
  const rows = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r.t >= t0 && r.t <= t1) rows.push(r); } catch { /* a torn line is no evidence */ }
  }
  return rows;
}

const RUNNER_UA = "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools)";
/** The runner's own direct GET of `url`: its status, or 0 for no answer
 *  within 10 s. Sent with the fetch helper's identity and the request's own
 *  Accept header when the log recorded one. */
export async function directReadStatus(url, { accept = "application/json,*/*" } = {}) {
  let ua = RUNNER_UA;
  try { ua = (await import("../../src/tools/fetch-guard.js")).USER_AGENT || ua; } catch { /* the default identity */ }
  try {
    const res = await fetch(url, { headers: { "User-Agent": ua, Accept: accept }, signal: AbortSignal.timeout(10_000) });
    try { await res.arrayBuffer(); } catch { /* status is the evidence */ }
    return res.status;
  } catch {
    return 0;
  }
}
/** The runner's own direct GET of `url`: true when it FAILS (500 or above,
 *  429, or no answer within 10 s). */
export async function directReadFails(url, opts) {
  const st = await directReadStatus(url, opts);
  return st === 0 || st >= 500 || st === 429;
}

/** The verdict on a failed answer: { verdict: "upstream", evidence } when the
 *  conditions above hold (an outage, or an access refusal the runner is given
 *  too), else { verdict: "fail", reason }. */
export async function upstreamOutageVerdict({ slug, shapeSlug = slug, status, body, refused = accessRefusalStatus(status, body), t0, t1, logPath = upstreamFailureLogPath(), readFails = directReadFails, readStatus = directReadStatus, root = ROOT }) {
  if (!refused && !isUpstreamErrorShape(status, body)) return { verdict: "fail", reason: "not an upstream-error answer" };
  const hosts = upstreamHostsForSlug(slug, root);
  if (!hosts.size) return { verdict: "fail", reason: "no upstream host in the tool's definition" };
  const ofClass = (r) => (refused ? r.status === refused : (r.error || r.status >= 500));
  const rows = failuresBetween(t0, t1, logPath).filter((r) => hosts.has(String(r.host).toLowerCase()) && ofClass(r));
  if (!rows.length) return { verdict: "fail", reason: refused ? `no request refused with HTTP ${refused} recorded during the call` : "no failed upstream request recorded during the call" };
  const row = rows[rows.length - 1];
  if (row.keyed || !row.url || row.method !== "GET") return { verdict: "fail", reason: `the failed request to ${row.host} is keyed or not a GET` };
  if (!requestMatchesDefinition(shapeSlug, row.url, root)) return { verdict: "fail", reason: `the failed request to ${row.host} is not the shape the tool's definition builds (a URL we built wrong is ours)` };
  const opts = row.accept ? { accept: row.accept } : undefined;
  if (refused) {
    const got = await readStatus(row.url, opts);
    if (got !== refused) return { verdict: "fail", reason: `${row.host} refused the server HTTP ${refused} but answers the runner's direct read of the same request ${got || "nothing"}` };
    return { verdict: "upstream", evidence: `${row.host} refused the server HTTP ${refused} and refuses the runner's direct read of the same request with HTTP ${refused} too` };
  }
  if (!(await readFails(row.url, opts))) return { verdict: "fail", reason: `${row.host} answers the runner's direct read of the same request` };
  return { verdict: "upstream", evidence: `${row.host} answered the server ${row.status || row.error} and refuses the runner's direct read of the same request too` };
}

// A SPENT SOURCE ALLOWANCE IS OURS UNLESS THE SOURCE REFUSES THE RUNNER TOO.
// A tool that counts its reads of a source a day answers, past its own
// budget, a fixed sentence without reading the source (us-macro-series' BLS
// day: src/tools/us-macro-series.js). When the source itself refuses the
// server's read (BLS answering its daily threshold to the server's key as a
// body whose status is not REQUEST_SUCCEEDED, or not answering), the tool
// answers a second fixed sentence. Either may be ours (our budget, our key's
// allowance, a request we built wrong), so such an answer is excused only
// when ALL of these hold, and fails otherwise:
//
//   1. the answer is one of the source's fixed sentences (anchored);
//   2. the tool's own definition declares the source's host;
//   3. the runner's own keyless direct GET of the source on that host, right
//      now, fails (no answer, 429, or 500 and above) or is answered with the
//      source's own refusal (BLS answers its daily threshold as a body whose
//      status is not REQUEST_SUCCEEDED).
//
// If the source answers the runner, the spent budget is ours and it fails.
export const SOURCE_ALLOWANCES = Object.freeze([
  {
    source: "BLS",
    // The server's own budget spent, or BLS refusing or not answering the
    // server's read (us-macro-series' `busy` sentence for BLS).
    message: /^The U\.S\. Bureau of Labor Statistics (?:daily query allowance of this server is used up;|API did not answer or refused the read \(the publisher's own limit or outage\);)/,
    host: "api.bls.gov",
    // The keyless v1 read the tool makes without a key (one series, GET).
    url: "https://api.bls.gov/publicAPI/v1/timeseries/data/LNS14000000",
    refuses: (status, text) => {
      if (status === 0 || status === 429 || status >= 500) return true;
      if (status !== 200) return false;
      try { return JSON.parse(text)?.status !== "REQUEST_SUCCEEDED"; } catch { return false; }
    },
  },
]);
/** The runner's own keyless direct GET of `url`: { status, text }, status 0
 *  for no answer within 10 s. */
export async function directReadAnswer(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": RUNNER_UA, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    let text = "";
    try { text = await res.text(); } catch { /* the status is still evidence */ }
    return { status: res.status, text };
  } catch {
    return { status: 0, text: "" };
  }
}
/** The verdict on a step's spent-allowance answer: null when `error` is no
 *  source's allowance sentence (the caller grades it by its other rules),
 *  else { verdict: "upstream", evidence } or { verdict: "fail", reason }. */
export async function sourceAllowanceVerdict({ slug, error, read = directReadAnswer, root = ROOT }) {
  const a = SOURCE_ALLOWANCES.find((x) => x.message.test(String(error || "")));
  if (!a) return null;
  if (!upstreamHostsForSlug(slug, root).has(a.host)) return { verdict: "fail", reason: `${slug} does not declare ${a.host}` };
  const { status, text } = await read(a.url);
  if (!a.refuses(status, text)) return { verdict: "fail", reason: `${slug} answered ${a.source}'s refusal or spent allowance, but ${a.host} answers the runner's direct read (HTTP ${status || "none"})` };
  let said = "";
  try { said = status === 200 ? `, status ${String(JSON.parse(text)?.status).slice(0, 40)}` : ""; } catch { /* the HTTP status is the evidence */ }
  return { verdict: "upstream", evidence: `${a.host} refuses the runner's direct read too (HTTP ${status || "none"}${said})` };
}

// A HOLLOW EXAMPLE IS OURS UNLESS THE UPSTREAM IS HOLLOW FOR THE RUNNER TOO.
// A published example that answers 200 with an empty documented array fails
// a sweep (scripts/sweep-shape.js). For a tool listed here, that answer is
// excused, and named in the log, only when ALL of these hold:
//
//   1. the tool has an entry below (per-tool opt-in: a tool with no entry is
//      never excused, whatever its upstream answers);
//   2. the tool's own definition declares the entry's host;
//   3. the runner's own keyless direct GET of the same request the tool
//      builds for the example input, right now, is empty or fails (`hollow`).
//
// If the upstream answers the runner with rows while the tool answered none,
// the empty answer is ours and it fails.
export const HOLLOW_READS = Object.freeze({
  // The crt.sh query certTransparencyHandler builds (src/tools/network-kit2.js).
  "cert-transparency": {
    host: "crt.sh",
    url: (input) => {
      const domain = String(input?.domain ?? "").trim().toLowerCase();
      if (!domain) return null;
      return `https://crt.sh/?q=${encodeURIComponent("%." + domain)}&output=json${input?.includeExpired === true ? "" : "&exclude=expired"}`;
    },
    // crt.sh answers a JSON list; a 404 is its front end's mislabelled backend
    // failure. Anything but a non-empty list is hollow or failed.
    hollow: (status, text) => {
      if (status !== 200) return true;
      try { const rows = JSON.parse(text); return !Array.isArray(rows) || rows.length === 0; } catch { return true; }
    },
  },
});
/** The verdict on an example's empty documented arrays: null when the tool
 *  has no HOLLOW_READS entry (the caller fails it), else
 *  { verdict: "upstream", evidence } or { verdict: "fail", reason }. */
export async function hollowAnswerVerdict({ slug, input, read = directReadAnswer, root = ROOT, reads = HOLLOW_READS }) {
  const h = Object.hasOwn(reads, slug) ? reads[slug] : null;
  if (!h) return null;
  if (!upstreamHostsForSlug(slug, root).has(h.host)) return { verdict: "fail", reason: `${slug} does not declare ${h.host}` };
  const url = h.url(input);
  if (!url) return { verdict: "fail", reason: `no direct read of ${h.host} can be built from the example input` };
  const { status, text } = await read(url);
  if (!h.hollow(status, text)) return { verdict: "fail", reason: `${h.host} answers the runner's direct read of the same request with rows (HTTP ${status}) while the tool answered none` };
  return { verdict: "upstream", evidence: `${h.host} answers the runner's direct read of the same request empty or failed too (HTTP ${status || "none"})` };
}

// A DECLARED SOURCE'S STATE IS READ, NEVER INFERRED FROM WORDING.
// A tool whose own definition declares its hosts (`upstreamHosts`), every one
// of them a source the runner can read for itself below, is graded by that
// read alone when it fails: excused when the runner's own direct read of a
// declared host is refused or fails right now, and failed when every one
// answers. The failure's words never decide either way, so the same source
// state gets the same verdict in every pack and sweep that reaches the tool.
// One read of each source a run (the caller's `read` keeps it). A tool that
// declares no host, or a host with no read here, is not graded by this rule
// (null): the caller's other rules grade it.
export const RUNNER_SOURCE_READS = Object.freeze({
  // The keyless BLS read SOURCE_ALLOWANCES makes, judged the same way.
  "api.bls.gov": { url: SOURCE_ALLOWANCES[0].url, refuses: SOURCE_ALLOWANCES[0].refuses },
  // The crt.sh query cert-transparency builds for its published example
  // (HOLLOW_READS): a 404 (its front end's mislabelled backend failure), a
  // 5xx, a non-JSON or a non-list answer, or no rows, is refused.
  "crt.sh": { url: HOLLOW_READS["cert-transparency"].url({ domain: "agent402.tools" }), refuses: HOLLOW_READS["cert-transparency"].hollow },
});
/** The verdict on a failed answer of a tool that declares its sources: null
 *  when the rule does not apply (see above), else
 *  { verdict: "upstream", evidence } or { verdict: "fail", reason }. */
export async function declaredSourceVerdict({ slug, read = directReadAnswer, root = ROOT, reads = RUNNER_SOURCE_READS }) {
  if (!declaresUpstreamHosts(slug, root)) return null;
  const hosts = [...upstreamHostsForSlug(slug, root)];
  if (!hosts.length || !hosts.every((h) => Object.hasOwn(reads, h))) return null;
  const seen = [];
  for (const h of hosts) {
    const { status, text } = await read(reads[h].url);
    if (reads[h].refuses(status, text)) {
      let said = "";
      try { const j = status === 200 ? JSON.parse(text) : null; said = j && !Array.isArray(j) && j.status ? `, status ${String(j.status).slice(0, 40)}` : (Array.isArray(j) && !j.length ? ", an empty list" : ""); } catch { said = status === 200 ? ", not JSON" : ""; }
      return { verdict: "upstream", evidence: `${slug} declares ${h}, which refuses the runner's direct read too (HTTP ${status || "none"}${said})` };
    }
    seen.push(`${h} HTTP ${status}`);
  }
  return { verdict: "fail", reason: `${slug}'s declared source answers the runner's direct read (${seen.join(", ")})` };
}
