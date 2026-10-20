// Attributes a settled call to the /api/route or /api/find answer the same
// caller got in the previous 30 minutes. Hashed caller (never the ip); counts
// only. /api/find is the control: a lexical answer with no judge in it.
import { callerHash } from "./wish.js";
import { capturePostHogRouteConversion, capturePostHogRouteAnswers } from "./posthog.js";

const WINDOW_MS = 30 * 60_000;
const MAX = 20_000;
const recent = new Map(); // callerHash -> { at, source, topSlug, topOurs, judged, slugs, unpaidNoted }
const tally = new Map();  // `${source}|${judged}|${topOurs}|${synthetic}` -> count, flushed hourly

// "reordered": the judge picked a row. "tie": the judge found rows that fit
// equally and the cheapest went first (its own kind, so the readout can count
// ties and sum reordered + tie as judged). "noMatch": the judge found no row
// does the task. "none": no judgment in the answer (lexical order).
function judgedKind(body) {
  const method = body?.judged?.method;
  if (method === "judged") return "reordered";
  if (method === "judged-tie") return "tie";
  if (body?.judged?.noMatch) return "noMatch";
  return "none";
}

// `source` names the surface ("route" | "find"). A /api/find row carries no
// seller (first-party catalog only), so it is ours. A synthetic answer
// (heartbeat, status probe) is tallied as such and never remembered: a shared
// runner address must not hand a probe's answer to a real buyer behind it.
export function noteRouteAnswer(ip, body, now = Date.now(), { source = "route", synthetic = false } = {}) {
  const rows = Array.isArray(body?.results) ? body.results : [];
  if (!rows.length) return;
  const judged = judgedKind(body);
  const top = rows[0];
  const topOurs = top?.seller == null ? true : top.seller === "self";
  const t = `${source}|${judged}|${topOurs}|${!!synthetic}`;
  tally.set(t, (tally.get(t) || 0) + 1);
  if (synthetic) return;
  const key = callerHash(ip, now);
  if (!key) return;
  if (recent.size >= MAX) recent.delete(recent.keys().next().value);
  const slugs = rows.map((r) => String(r?.slug || "")).filter(Boolean);
  recent.set(key, { at: now, source: String(source), topSlug: String(top?.slug || ""), topOurs, judged, slugs, unpaidNoted: false });
}

// `rail`, `wire` and `paid` come from the finish hook that books the sale,
// in the sales ledger's own words (rail usdc | credits | pow | trial, wire
// x402 | mpp | mpp-tempo | mpp-stripe). A paid call closes the answer. A
// free call (PoW, trial) is noted once and leaves the answer open, so the
// purchase that follows a free try still attributes: at most one unpaid and
// one paid conversion per answer.
export function noteRoutePurchase(ip, slug, now = Date.now(), { rail = "unknown", wire = null, paid = false } = {}) {
  const key = callerHash(ip, now);
  if (!key) return null;
  const hit = recent.get(key);
  if (!hit || now - hit.at > WINDOW_MS) return null;
  if (paid) recent.delete(key);
  else {
    if (hit.unpaidNoted) return null;
    hit.unpaidNoted = true;
  }
  const s = String(slug);
  const viaRouteExecute = /^route-execute/.test(s);
  const out = {
    source: hit.source,
    judged: hit.judged,
    topOurs: hit.topOurs,
    boughtTop: s === hit.topSlug,
    boughtAnyRow: hit.slugs.includes(s),
    viaRouteExecute,
    slug: s,
    minutes: Math.round((now - hit.at) / 60_000),
    rail: String(rail || "unknown"),
    wire: wire ? String(wire) : null,
    paid: !!paid,
  };
  capturePostHogRouteConversion(out);
  return out;
}

export function flushRouteAnswers() {
  for (const [k, count] of tally) {
    const [source, judged, ours, synthetic] = k.split("|");
    capturePostHogRouteAnswers({ source, judged, topOurs: ours === "true", synthetic: synthetic === "true", count });
  }
  tally.clear();
}
const timer = setInterval(flushRouteAnswers, 60 * 60_000);
timer.unref?.();

export function _routeConversionReset() { recent.clear(); tally.clear(); }
