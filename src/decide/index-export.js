// The unified tool index, streamed to the decide service as NDJSON.
//
// The main app owns the catalog and the crawl cache; the decide service owns
// embeddings and ranking. This is the one seam between them: an internal,
// token-gated GET that walks both sources and writes one row per line.
//
// It must never slow a paid call. So it yields to the event loop every
// YIELD_EVERY rows, writes through the socket's backpressure, and refuses a
// second export while one is running (the service pulls on a timer; two at
// once is a retry storm, not a need). Unset DECIDE_INTERNAL_TOKEN = not
// mounted (404), the same "key present = feature on" rule as every rollout.

import { timingSafeEqual } from "node:crypto";
import { localToolRow, remoteToolRow } from "./tool-rows.js";
import { routableRemoteEntries, looksLikeListingInjection, liveProofAt, mppDualStackOrigins, indexReadiness } from "../x402-index.js";
import { unpackRequestContract } from "../request-contract.js";
import { dispatchable } from "../tools/route-execute.js";
import { EXPENSIVE_COMPOSITE_SLUGS } from "../composite-spend-guard.js";

/** Whether POST /api/decide/execute can run this tool as a step: the router's
 *  dispatch rules, and no report product or per-request-priced tier (those
 *  are planned, but called directly). */
export const executableStep = (def) => dispatchable(def).ok && typeof def?.tierQuote !== "function" && !EXPENSIVE_COMPOSITE_SLUGS.has(def?.slug);

const YIELD_EVERY = 500;
const yieldLoop = () => new Promise((r) => setImmediate(r));

export function decideTokenOk(req, token = process.env.DECIDE_INTERNAL_TOKEN) {
  const want = String(token || "");
  if (want.length < 24) return false;
  const got = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True only for a request that did not come through the public edge: a
 *  private-network host (Railway routes public traffic by host name, so a
 *  *.railway.internal host cannot arrive from outside) or loopback, and no
 *  forwarding header. The token is still required on top of this. */
export function fromPrivateNetwork(req) {
  const h = req.headers || {};
  if (h["x-forwarded-for"] || h["x-real-ip"] || h["x-railway-edge"] || h["forwarded"]) return false;
  const host = String(h.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host.endsWith(".railway.internal") || host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Rows for every priced local tool, then every routable outside tool. */
export async function* unifiedRows({ catalog, baseUrl, networks = [], now = Date.now(), remoteExecutable = null } = {}) {
  let n = 0;
  // One row per id: the same route can reach the crawl twice (a seller listed
  // under two origins that resolve to one row id), and the service stores rows
  // by id.
  const emitted = new Set();
  for (const def of Object.values(catalog || {})) {
    // The decision tools never recommend themselves.
    if (/^decide(?:-|$)/.test(String(def?.slug || ""))) continue;
    const row = localToolRow(def, { baseUrl, networks, now, executable: executableStep(def) });
    if (row && !emitted.has(row.id)) { emitted.add(row.id); yield row; }
    if (++n % YIELD_EVERY === 0) await yieldLoop();
  }
  const mppOrigins = new Set(mppDualStackOrigins().map((o) => String(o).replace(/\/+$/, "")));
  for (const [, tools] of routableRemoteEntries({ baseUrl })) {
    for (const t of tools) {
      const row = remoteToolRow(t, {
        requestContract: unpackRequestContract(t),
        injected: looksLikeListingInjection(`${t.name || ""} ${t.description || ""} ${t.sellerName || ""} ${t.category || ""} ${t.route || ""}`),
        lastLiveAt: liveProofAt(t),
        mppOrigins,
        // Unknown (no verdict function) keeps the old behaviour; a function
        // that throws reads as not executable, never as a guess that it is.
        executable: typeof remoteExecutable === "function" ? (() => { try { return remoteExecutable(t) === true; } catch { return false; } })() : true,
      });
      if (row && !emitted.has(row.id)) { emitted.add(row.id); yield row; }
      if (++n % YIELD_EVERY === 0) await yieldLoop();
    }
  }
}

let exporting = false;

/** Express handler for GET /__internal/decide/tools.ndjson */
export function decideIndexExportHandler({ getCatalog, baseUrl, getNetworks, remoteExecutable = null, getReadiness = indexReadiness }) {
  return async (req, res) => {
    if (!fromPrivateNetwork(req) || !decideTokenOk(req)) return res.status(404).json({ error: "Not found" });
    if (exporting) return res.status(429).set("Retry-After", "60").json({ error: "export already running" });
    // A complete export tells the service to delete every row it did not
    // stream, so an export taken while the crawl cache is still loading (only
    // our own rows so far) would empty the outside index. Refuse until ready.
    let ready = { ready: true };
    try { ready = getReadiness() || ready; } catch { ready = { ready: false, retryAfterSeconds: 30 }; }
    if (!ready.ready) return res.status(503).set("Retry-After", String(ready.retryAfterSeconds || 30)).json({ error: "index still loading", state: ready.state || null });
    exporting = true;
    let rows = 0;
    try {
      res.status(200).set({ "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      for await (const row of unifiedRows({ catalog: getCatalog(), baseUrl, networks: getNetworks(), remoteExecutable })) {
        if (res.destroyed) break;
        if (!res.write(JSON.stringify(row) + "\n")) {
          // A socket that closes while we wait never drains: wait on either.
          await new Promise((r) => { const done = () => { res.off("drain", done); res.off("close", done); res.off("error", done); r(); }; res.once("drain", done); res.once("close", done); res.once("error", done); });
          if (res.destroyed) break;
        }
        rows++;
      }
      res.end(JSON.stringify({ __end: true, rows }) + "\n");
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: "export failed" });
      else res.destroy(e);
    } finally {
      exporting = false;
    }
  };
}
