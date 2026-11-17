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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function upstreamFailureLogPath() {
  return process.env.UPSTREAM_FAILURE_LOG || join(tmpdir(), "agent402-upstream-failures.jsonl");
}

const KEYED_NAME = /key|token|secret|sig|auth|passw|credential|session|cookie/i;
/** True when a request carries a credential: a key-like query parameter or
 *  header name. Such a request is never logged by URL nor re-read. */
export function isKeyedRequest(u, headers) {
  for (const name of u.searchParams.keys()) if (KEYED_NAME.test(name)) return true;
  if (u.username || u.password) return true;
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
];
/** True for the shared fetch helper's upstream-failure answers only. */
export function isUpstreamErrorShape(status, body) {
  const msg = String(body?.error || "");
  return UPSTREAM_SHAPES.some(([st, re]) => st === status && re.test(msg));
}

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
/** The upstream hosts a tool's definition names, read from src/tools/: the
 *  hosts in the tool's own definition (from its `route: "` to the next
 *  one), or, when that names none (a kit-wide base URL), every host in
 *  its kit file. Empty when the slug is not defined there. */
export function upstreamHostsForSlug(slug, root = ROOT) {
  const marker = `slug: "${slug}"`;
  const hostsIn = (s) => new Set([...s.matchAll(HOST_LITERAL)].map((m) => (m[1] || m[2]).toLowerCase()));
  for (const text of kits(root)) {
    // The definition, not a reference (a skill step also says `slug: "x"`):
    // the marker sits in the same object as a `route: "` just before it.
    for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
      const start = text.lastIndexOf('route: "', at);
      if (start < 0 || at - start > 400) continue;
      const next = text.indexOf('route: "', at);
      const own = hostsIn(text.slice(start, next < 0 ? text.length : next));
      return own.size ? own : hostsIn(text);
    }
  }
  return new Set();
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
/** The runner's own direct GET of `url`: true when it FAILS (500 or above,
 *  429, or no answer within 10 s). */
export async function directReadFails(url) {
  let ua = RUNNER_UA;
  try { ua = (await import("../../src/tools/fetch-guard.js")).USER_AGENT || ua; } catch { /* the default identity */ }
  try {
    const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "application/json,*/*" }, signal: AbortSignal.timeout(10_000) });
    try { await res.arrayBuffer(); } catch { /* status is the evidence */ }
    return res.status >= 500 || res.status === 429;
  } catch {
    return true;
  }
}

/** The verdict on a failed answer: { verdict: "upstream", evidence } when the
 *  four conditions above hold, else { verdict: "fail", reason }. */
export async function upstreamOutageVerdict({ slug, status, body, t0, t1, logPath = upstreamFailureLogPath(), readFails = directReadFails, root = ROOT }) {
  if (!isUpstreamErrorShape(status, body)) return { verdict: "fail", reason: "not an upstream-error answer" };
  const hosts = upstreamHostsForSlug(slug, root);
  if (!hosts.size) return { verdict: "fail", reason: "no upstream host in the tool's definition" };
  const rows = failuresBetween(t0, t1, logPath).filter((r) => hosts.has(String(r.host).toLowerCase()));
  if (!rows.length) return { verdict: "fail", reason: "no failed upstream request recorded during the call" };
  const row = rows[rows.length - 1];
  if (row.keyed || !row.url || row.method !== "GET") return { verdict: "fail", reason: `the failed request to ${row.host} is keyed or not a GET` };
  if (!(await readFails(row.url))) return { verdict: "fail", reason: `${row.host} answers the runner's direct read of the same request` };
  return { verdict: "upstream", evidence: `${row.host} answered the server ${row.status || row.error} and refuses the runner's direct read of the same request too` };
}
