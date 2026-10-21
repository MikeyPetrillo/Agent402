// Discovery reads (the catalog, /api/find, skill packs, leaderboards, a
// proof-of-work challenge) settle nothing, so a 503 the server sheds under
// load is safe to repeat. It is retried only when it names its own delay
// (a Retry-After header or a retryAfterSeconds body field), at most
// DISCOVERY_ATTEMPTS tries in all, each wait capped at DISCOVERY_MAX_WAIT_MS.
// A paid or priced call never goes through here: a repeat of one could settle
// twice.
import { distrustFetch } from "./networks.js";

export const DISCOVERY_ATTEMPTS = 3;
export const DISCOVERY_MAX_WAIT_MS = 5000;

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Discovery reads go through the distrusted-intermediate refusal (networks.js).
const ownFetch = distrustFetch();

/** The wait (ms) a shed 503 asks for, or null when `r` is not one. */
export async function shedRetryWaitMs(r, maxWaitMs = DISCOVERY_MAX_WAIT_MS) {
  if (!r || r.status !== 503) return null;
  const header = r.headers && typeof r.headers.get === "function" ? r.headers.get("retry-after") : null;
  let seconds = header != null && String(header).trim() !== "" ? Number(header) : NaN;
  if (!Number.isFinite(seconds)) {
    try {
      const body = await (typeof r.clone === "function" ? r.clone() : r).json();
      seconds = Number(body && body.retryAfterSeconds);
    } catch { seconds = NaN; }
  }
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, maxWaitMs);
}

/**
 * Fetch a discovery surface, retrying a shed 503. Resolves with the last
 * response (2xx or not) and how many attempts it took; the caller decides how
 * to report a failure, naming the surface and `res.status`.
 */
export async function fetchDiscovery(url, init, { fetchImpl = ownFetch, sleep = sleepMs, attempts: max = DISCOVERY_ATTEMPTS } = {}) {
  let res;
  let attempts = 0;
  for (;;) {
    attempts++;
    res = await fetchImpl(url, init);
    if (res.ok || attempts >= max) return { res, attempts };
    const wait = await shedRetryWaitMs(res);
    if (wait == null) return { res, attempts };
    await sleep(wait);
  }
}

/** "HTTP 503 from /api/find after 3 attempts": the tail of a discovery failure. */
export function discoveryFailure(url, res, attempts) {
  const path = (() => { try { return new URL(String(url)).pathname; } catch { return String(url).split("?")[0]; } })();
  return `HTTP ${res.status} from ${path}${attempts > 1 ? ` after ${attempts} attempts` : ""}`;
}

/** GET JSON from a discovery surface; throws `${label} failed: HTTP <status> from <path>[ after N attempts]`. */
export async function getDiscoveryJson(label, url, init, opts) {
  const { res, attempts } = await fetchDiscovery(url, init, opts);
  if (!res.ok) {
    const err = new Error(`${label} failed: ${discoveryFailure(url, res, attempts)}`);
    err.status = res.status;
    err.attempts = attempts;
    throw err;
  }
  return res.json();
}
