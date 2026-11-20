// A CDP FAILURE IN THE LIVE CHECK IS READ AGAINST THE RUNNER.
//
// scripts/test-cdp-live.js calls the kit's tools against the real service.
// A failure there is excused as the service's own only when BOTH hold, and
// fails the check otherwise:
//
//   1. the kit answered an upstream-failure status (502 or 504), or, for the
//      observatory, every error it collected is one of its three queries
//      answered HTTP 5xx by the query service;
//   2. the runner's own direct read, sent right then, fails too (an answer of
//      500 or above, or none): one request, signed with the same key, sent
//      with plain fetch, so none of the kit's pacing, retries, budgets, caches
//      or health verdicts stand between the runner and the service.
//
// The direct read is the same request for a GET (balances, the schema), and
// the kit's known-good query for the query service: a heavy query that fails
// while the known-good one answers is ours to fix, never excused. If the
// service answers the runner, the kit failing is ours and it fails.
const CDP_HOST = "api.cdp.coinbase.com";
export const DIRECT_READ_TIMEOUT_MS = 20_000;

/** The runner's own direct request to CDP: its status, or 0 for no answer. */
export async function cdpDirectStatus({ method = "GET", path, body = null }, { fetchImpl = fetch, mint = null, timeoutMs = DIRECT_READ_TIMEOUT_MS, host = CDP_HOST } = {}) {
  try {
    const mintJwt = mint || (await import("../../src/tools/cdp-kit.js")).mintCdpJwt;
    const jwt = await mintJwt({ method, path });
    const res = await fetchImpl(`https://${host}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { await res.arrayBuffer(); } catch { /* the status is the evidence */ }
    return res.status;
  } catch {
    return 0;
  }
}

const directFails = (st) => st === 0 || st >= 500;
const said = (st) => (st === 0 ? "no answer" : `HTTP ${st}`);

/** The verdict on a kit call that threw `status`: { verdict: "upstream",
 *  evidence } under the rule above, else { verdict: "fail", reason }.
 *  `control` is the direct request ({ method, path, body }); a call with none
 *  (one with an effect, never re-sent) is never excused. */
export async function cdpFailureVerdict({ status, control, read = cdpDirectStatus }) {
  if (status !== 502 && status !== 504) return { verdict: "fail", reason: "not an upstream-failure answer" };
  if (!control) return { verdict: "fail", reason: "no direct read exists for this call" };
  const got = await read(control);
  if (!directFails(got)) return { verdict: "fail", reason: `CDP answers the runner's direct read (${control.method || "GET"} ${String(control.path).split("?")[0]}) HTTP ${got}` };
  return { verdict: "upstream", evidence: `CDP answered the kit HTTP ${status} and the runner's direct read ${said(got)}` };
}

// The observatory's three queries, as its snapshot labels their errors.
export const OBSERVATORY_QUERIES = Object.freeze(["daily", "volume", "merchants"]);
const QUERY_5XX = /^(daily|volume|merchants): CDP(?:'s query service| upstream error)[^(]*\(HTTP 5\d\d\b/;

/** The verdict on an observatory snapshot's `errors`: "clean" with none,
 *  "upstream" (with the queries that failed) when every error is a query the
 *  service answered 5xx AND the direct read of `control` fails too, else
 *  "fail". Any other error (history, weekly, a busy refusal, a 4xx) is ours. */
export async function observatoryVerdict({ errors, control, read = cdpDirectStatus }) {
  const list = Array.isArray(errors) ? errors.map(String) : [];
  if (!list.length) return { verdict: "clean", failed: [] };
  const other = list.find((e) => !QUERY_5XX.test(e));
  if (other) return { verdict: "fail", reason: `not a query-service 5xx: ${other.slice(0, 80)}`, failed: [] };
  if (!control) return { verdict: "fail", reason: "no direct read given", failed: [] };
  const got = await read(control);
  if (!directFails(got)) return { verdict: "fail", reason: `the query service answers the runner's direct known-good query HTTP ${got}`, failed: [] };
  const failed = [...new Set(list.map((e) => e.slice(0, e.indexOf(":"))))];
  return { verdict: "upstream", evidence: `the query service answered ${failed.join(", ")} HTTP 5xx and the runner's direct known-good query ${said(got)}`, failed };
}
