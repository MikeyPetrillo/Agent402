// The crawl's control read: is OUR egress answering? The index reads sellers'
// origins, and a read that times out counts as ours, so a cycle's share of
// such reads is evidence a seller can supply. Before a UTC day is left out of
// every seller's reputation record (src/x402-index.js ourSideVerdict), the
// crawl reads hosts no seller runs, through the same resolver and egress:
//   - this server's own public address (BASE_URL + /health), when BASE_URL is
//     an https URL on a public host name (never loopback or an address);
//   - every https URL the operator lists in CRAWL_OUR_SIDE_CONTROL_URLS (CSV,
//     at most CONTROL_URLS_MAX): hosts the operator knows to be independent
//     of this deployment and of every seller.
// A control read FAILED when no HTTP answer came back inside the limit (a
// lookup that did not finish, a connection that was not made, a timeout). Any
// status is an answer: the read measures the path, not the host's health.
// The verdict needs every control read to have failed, so one host answering
// is enough to keep the day.
import { isIP } from "node:net";

export const CONTROL_URLS_MAX = 5;
export const CONTROL_TIMEOUT_MS = 5_000;

const publicHttps = (raw) => {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (isIP(host) || (host.startsWith("[") && host.endsWith("]"))) return null;
  return u;
};

/** The control URLs for this deployment: de-duplicated by host, at most
 *  CONTROL_URLS_MAX + 1. [] when none qualifies (the verdict then never
 *  confirms, and no day is left out). */
export function ourSideControlUrls({ env = process.env, baseUrl = "" } = {}) {
  const out = new Map();
  const own = publicHttps(baseUrl);
  if (own) out.set(own.host, new URL("/health", own).href);
  const listed = String(env.CRAWL_OUR_SIDE_CONTROL_URLS || "").slice(0, 4096).split(",").map((s) => s.trim()).filter(Boolean);
  let taken = 0;
  for (const raw of listed) {
    if (taken >= CONTROL_URLS_MAX) break;
    const u = publicHttps(raw);
    if (u && !out.has(u.host)) { out.set(u.host, u.href); taken++; }
  }
  return [...out.values()];
}

/** Read every control URL once, side by side. Resolves to { checked, failed };
 *  never throws. `request(url, init)` is injectable for tests. */
export async function readOurSideControl(urls, { timeoutMs = CONTROL_TIMEOUT_MS, request = null } = {}) {
  const list = (Array.isArray(urls) ? urls : []).slice(0, CONTROL_URLS_MAX + 1);
  const one = async (url) => {
    const init = { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) };
    try {
      const res = request ? await request(url, init) : await fetch(url, init);
      try { await res?.body?.cancel?.(); } catch { /* the answer is the status line */ }
      return Number.isInteger(res?.status);
    } catch { return false; }
  };
  const answers = await Promise.all(list.map(one));
  return { checked: answers.length, failed: answers.filter((a) => !a).length };
}
