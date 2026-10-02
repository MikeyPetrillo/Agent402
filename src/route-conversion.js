// Attributes a paid call to the /api/route answer the same caller got in the
// previous 30 minutes. Hashed caller (never the ip); counts only.
import { callerHash } from "./wish.js";
import { capturePostHogRouteConversion, capturePostHogRouteAnswers } from "./posthog.js";

const WINDOW_MS = 30 * 60_000;
const MAX = 20_000;
const recent = new Map(); // callerHash -> { at, topSlug, topOurs, judged }
const tally = new Map();  // `${judged}|${topOurs}` -> count, flushed hourly

function judgedKind(body) {
  if (body?.judged?.method === "judged") return "reordered";
  if (body?.judged?.noMatch) return "noMatch";
  return "none";
}

export function noteRouteAnswer(ip, body, now = Date.now()) {
  const rows = Array.isArray(body?.results) ? body.results : [];
  if (!rows.length) return;
  const key = callerHash(ip, now);
  if (!key) return;
  const judged = judgedKind(body);
  const top = rows[0];
  const topOurs = top?.seller === "self";
  if (recent.size >= MAX) recent.delete(recent.keys().next().value);
  recent.set(key, { at: now, topSlug: String(top?.slug || ""), topOurs, judged });
  const t = `${judged}|${topOurs}`;
  tally.set(t, (tally.get(t) || 0) + 1);
}

export function noteRoutePurchase(ip, slug, now = Date.now()) {
  const key = callerHash(ip, now);
  if (!key) return null;
  const hit = recent.get(key);
  if (!hit || now - hit.at > WINDOW_MS) return null;
  recent.delete(key);
  const viaRouteExecute = /^route-execute/.test(String(slug));
  const out = { judged: hit.judged, topOurs: hit.topOurs, boughtTop: slug === hit.topSlug, viaRouteExecute, slug, minutes: Math.round((now - hit.at) / 60_000) };
  capturePostHogRouteConversion(out);
  return out;
}

export function flushRouteAnswers() {
  for (const [k, count] of tally) {
    const [judged, ours] = k.split("|");
    capturePostHogRouteAnswers({ judged, topOurs: ours === "true", count });
  }
  tally.clear();
}
const timer = setInterval(flushRouteAnswers, 60 * 60_000);
timer.unref?.();

export function _routeConversionReset() { recent.clear(); tally.clear(); }
