// One row shape for every tool the decision engine can recommend: this
// server's own catalog and every routable outside x402/MPP seller.
//
// Pure: no I/O, no clocks unless passed. The main app builds rows from its
// catalog and crawl cache and streams them to the decide service; the service
// embeds and ranks them. Both sides import this file, so the row a test pins is
// the row production ranks.
//
// NEUTRAL BY CONSTRUCTION. `firstParty` is a disclosure field. Nothing here
// (or in the ranker) reads it to change a score; the ranking test proves two
// rows that differ only in firstParty score identically.
//
// OUTSIDE TEXT IS DATA. A seller's name and description head for a model's
// context, so they are cleaned here (control and zero-width characters, markup
// brackets, length) and a listing the index already flags as an injection
// attempt never becomes a row. No seller-authored example VALUES are carried
// (request-contract.js's rule): an outside row gets field names only.

import { createHash } from "node:crypto";

export const FIRST_PARTY_SELLER = "agent402";
export const ROW_VERSION = 1;

const MAX_NAME = 120;
const MAX_DESC = 600;
const MAX_FIELDS = 24;

// Control characters, zero-width and bidi overrides, then the characters that
// build markup or fake role tags. What remains is plain prose.
const STRIP_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿<>`]/g;

export function cleanText(s, max) {
  if (typeof s !== "string") return "";
  const t = s.replace(STRIP_RE, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

const SAFE_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_FIELD = { test: (k) => SAFE_FIELD_RE.test(k) && !RESERVED.has(k) };

function hostOf(origin) {
  try { return new URL(origin).host.toLowerCase(); } catch { return ""; }
}

export function rowId(seller, method, route) {
  return createHash("sha1").update(`${seller}|${String(method).toUpperCase()}|${route}`).digest("hex").slice(0, 20);
}

/** Text the embedding and the lexical index read. */
export function embedText(row) {
  const fields = Object.keys(row.inputSchema?.properties || {}).slice(0, MAX_FIELDS).join(", ");
  return `${row.name}. ${row.description}${row.category ? `. Category: ${row.category}` : ""}${fields ? `. Inputs: ${fields}` : ""}`.slice(0, 1200);
}

function contentHash(row) {
  return createHash("sha1").update(JSON.stringify([ROW_VERSION, embedText(row), row.priceUsd, row.networks, row.rails, row.endpoint, row.method])).digest("hex").slice(0, 16);
}

/** 0..1: how well a buyer can construct a call from what the row declares.
 *  Only a fact both kinds of row carry counts: whether the inputs are
 *  declared. Property types are not scored (outside rows carry names and
 *  locations but never types, so scoring types would favour our own rows),
 *  and neither are examples (outside rows never carry seller example values,
 *  by policy). */
export function schemaQuality(row) {
  // "absent" on our own row means the tool takes no input. On an outside row
  // it only means the seller declared none, which is not the same claim: a
  // POST endpoint with no declared body fields cannot be called correctly
  // from the listing (2026-10-01: a wallet-brief step ran with {} and the
  // seller answered 400). Score that as uncertain, like a partial schema.
  if (row.inputSchemaState === "absent" && !row.firstParty && String(row.method || "").toUpperCase() === "POST") return 0.5;
  if (row.inputSchemaState === "declared" || row.inputSchemaState === "absent") return 1;
  if (row.inputSchemaState === "partial") return 0.5;
  return 0;
}

function finish(row) {
  row.schemaQuality = schemaQuality(row);
  row.contentHash = contentHash(row);
  return row;
}

function priceNumber(p) {
  if (typeof p === "number") return Number.isFinite(p) && p >= 0 ? p : null;
  if (typeof p === "string") {
    const n = Number(p.replace(/^\$/, ""));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * A row for one of this server's own catalog tools.
 * @param def catalog entry ({ route: "POST /api/x", slug, name, description, price, category, discovery })
 * @param ctx { baseUrl, networks: CAIP-2 ids this server offers, rails, now }
 */
export function localToolRow(def, { baseUrl = "https://agent402.tools", networks = [], rails = ["x402", "mpp"], now = Date.now(), executable = true } = {}) {
  if (!def || typeof def.route !== "string") return null;
  const [method, route] = def.route.split(" ");
  if (!method || !route || route.includes(":")) return null;
  const priceUsd = priceNumber(def.price);
  if (priceUsd === null) return null;
  const schema = def.discovery?.inputSchema && typeof def.discovery.inputSchema === "object" ? def.discovery.inputSchema : null;
  const properties = {};
  for (const [k, v] of Object.entries(schema?.properties || {}).slice(0, MAX_FIELDS)) {
    if (!SAFE_FIELD.test(k)) continue;
    properties[k] = { ...(typeof v?.type === "string" ? { type: v.type } : {}), ...(Array.isArray(v?.enum) ? { enum: v.enum.slice(0, 24) } : {}), ...(typeof v?.description === "string" ? { description: cleanText(v.description, 200) } : {}) };
  }
  const required = Array.isArray(schema?.required) ? schema.required.filter((k) => Object.hasOwn(properties, k)) : [];
  const example = def.discovery?.input && typeof def.discovery.input === "object" && !Array.isArray(def.discovery.input) ? def.discovery.input : null;
  return finish({
    id: rowId(FIRST_PARTY_SELLER, method, route),
    slug: String(def.slug || ""),
    name: cleanText(def.name || def.slug || route, MAX_NAME),
    description: cleanText(def.description || "", MAX_DESC),
    category: cleanText(def.category || "", 40),
    seller: FIRST_PARTY_SELLER,
    firstParty: true,
    method: method.toUpperCase(),
    endpoint: `${String(baseUrl).replace(/\/+$/, "")}${route}`,
    priceUsd,
    pricedByQuote: typeof def.quote === "function" || typeof def.tierQuote === "function",
    rails: [...rails],
    networks: [...networks],
    inputSchema: { type: "object", properties, required },
    inputSchemaState: schema ? "declared" : "absent",
    example,
    hasExample: !!example,
    hasOutputSchema: !!def.discovery?.output?.example,
    modelBacked: def.modelBacked === true,
    ...(executable ? {} : { executable: false }),
    lastLiveAt: now,
    // No privileged health prior: our rows start where an unmeasured outside
    // row does, and move only on observed reliability.
    health: null,
  });
}

/**
 * A row for one outside seller's tool, or null when it cannot be a
 * recommendation (unpriced, templated path, flagged listing, bad URL).
 * @param t a decorated remote tool (x402-index routableRemoteEntries)
 * @param ctx { requestContract: unpacked contract or null, injected: bool,
 *              lastLiveAt: ms or null, mppOrigins: Set<origin> }
 */
export function remoteToolRow(t, { requestContract = null, injected = false, lastLiveAt = null, mppOrigins = new Set(), executable = true } = {}) {
  if (!t || injected) return null;
  const origin = typeof t.seller === "string" ? t.seller.replace(/\/+$/, "") : "";
  const host = hostOf(origin);
  if (!host || !/^https:\/\//.test(origin)) return null;
  const rawRoute = typeof t.route === "string" ? t.route : "";
  if (!rawRoute.startsWith("/") || /[{}]/.test(rawRoute) || rawRoute.length > 512) return null;
  let route;
  try { const u = new URL(rawRoute, origin); if (u.origin !== new URL(origin).origin) return null; route = `${u.pathname}${u.search}`; } catch { return null; }
  const priceUsd = priceNumber(t.price);
  if (priceUsd === null || priceUsd <= 0) return null;
  const method = String(t.method || "POST").toUpperCase();
  const properties = {};
  const required = [];
  const req = requestContract?.required || {};
  for (const loc of Object.keys(req)) {
    for (const name of req[loc] || []) {
      if (Object.keys(properties).length >= MAX_FIELDS) break;
      const top = loc === "body" ? String(name).split(".")[0] : String(name);
      if (!SAFE_FIELD.test(top) || Object.hasOwn(properties, top)) continue;
      properties[top] = { in: loc === "body" ? "body" : loc };
      required.push(top);
    }
  }
  // Optional inputs the seller declared: named so a planner can fill them,
  // never listed as required.
  const opt = requestContract?.optional || {};
  for (const loc of Object.keys(opt)) {
    for (const name of opt[loc] || []) {
      if (Object.keys(properties).length >= MAX_FIELDS) break;
      if (!SAFE_FIELD.test(name) || Object.hasOwn(properties, name)) continue;
      properties[name] = { in: loc === "body" ? "body" : loc };
    }
  }
  const networks = Array.isArray(t.networks) ? t.networks.filter((n) => typeof n === "string").slice(0, 16) : [];
  const rails = ["x402", ...(mppOrigins.has(origin) ? ["mpp"] : [])];
  return finish({
    id: rowId(host, method, route),
    slug: cleanText(String(t.slug || route), 120),
    name: cleanText(t.name || route, MAX_NAME),
    description: cleanText(t.description || "", MAX_DESC),
    category: cleanText(t.category || "", 40),
    seller: host,
    sellerName: cleanText(t.sellerName || host, 80),
    firstParty: false,
    method,
    endpoint: `${origin}${route}`,
    priceUsd,
    pricedByQuote: false,
    rails,
    networks,
    networksInferred: t.networksInferred === true,
    inputSchema: { type: "object", properties, required },
    inputSchemaState: requestContract?.state || "unknown",
    example: null,
    hasExample: false,
    hasOutputSchema: false,
    modelBacked: null,
    lastLiveAt: Number.isFinite(lastLiveAt) && lastLiveAt > 0 ? lastLiveAt : null,
    health: Number.isFinite(t.health) ? t.health : null,
    // Whether POST /api/decide/execute can pay this seller today (the
    // router's Base dispatch verdict at export time). A row it cannot is
    // still a valid step to call directly; it carries no execute price.
    ...(executable ? {} : { executable: false }),
  });
}
