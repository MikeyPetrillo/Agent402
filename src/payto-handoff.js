// Base payTo handoff: a seller that moves to a new payout wallet keeps the
// settlement history its old wallet earned, on its own origin only.
//
// Evidence counts only where the money goes (src/evidence-binding.js), so a
// seller that rotates its Base payTo starts again below the router's floor.
// A handoff carries the old wallet's credited history to the new one when TWO
// independent proofs agree, so neither a stolen key nor a taken-over host is
// enough on its own:
//   1. Control of the origin: the origin itself serves the handoff document
//      at HANDOFF_PATH (same host, and under a path seller's own prefix).
//   2. Control of the old wallet: the document carries the old wallet's
//      EIP-191 signature over handoffMessage(), which names the origin, the
//      network and both wallets. An ordinary wallet, an ERC-1271 contract
//      wallet and an ERC-6492 counterfactual one all verify.
// Plus the origin's own Base 402 must already ask to be paid at the new
// wallet. Nothing in the document is used except the fields parseHandoff
// validates; the signed text is rebuilt from those fields, never copied.
//
// Narrow by construction: one hop (old -> new) on one origin. A wallet can be
// handed off from by one origin at a time, a listed shared wallet or a
// mostly self-funded one is never part of a handoff, and the old wallet's
// history must itself clear the floor on this origin (evidencePayToVerdict
// only adds the new wallet beside a wallet that already clears).
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";

export const HANDOFF_PATH = "/.well-known/agent402-payto-handoff";
export const HANDOFF_NETWORK = "eip155:8453";
export const HANDOFF_DOC_MAX_BYTES = 16_384;
const MAX_AGE_MS = 30 * 86_400_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const SIG_MAX_HEX = 12_000;
const MAX_RECORDS = 5_000;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const lc = (s) => String(s).toLowerCase();

/** The exact text the old wallet signs (EIP-191 personal message). */
export function handoffMessage({ origin, network = HANDOFF_NETWORK, from, to, issuedAt }) {
  return [
    "Agent402 payTo handoff",
    `origin: ${origin}`,
    `network: ${network}`,
    `from: ${lc(from)}`,
    `to: ${lc(to)}`,
    `issued: ${issuedAt}`,
  ].join("\n");
}

export const HANDOFF_FORMAT = `serve JSON at ${HANDOFF_PATH} on the origin: {"version":1,"network":"${HANDOFF_NETWORK}","from":"<old 0x payTo>","to":"<new 0x payTo>","issuedAt":"<ISO 8601 UTC, e.g. 2026-10-28T12:00:00Z>","signature":"<old wallet's EIP-191 signature of the message>"}; the message is these six lines joined by \\n: "Agent402 payTo handoff", "origin: <origin as listed>", "network: ${HANDOFF_NETWORK}", "from: <old, lowercase>", "to: <new, lowercase>", "issued: <issuedAt>"`;

const bad = (reason) => ({ ok: false, reason });

/** Validate a fetched document. Only these fields are read; anything else is ignored. */
export function parseHandoff(doc, { now = Date.now() } = {}) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return bad(`the handoff document is not a JSON object; ${HANDOFF_FORMAT}`);
  const { version, network, from, to, issuedAt, signature } = doc;
  if (version !== 1) return bad('"version" must be 1');
  if (network !== HANDOFF_NETWORK) return bad(`"network" must be "${HANDOFF_NETWORK}" (the handoff applies to the Base payTo only)`);
  if (typeof from !== "string" || !ADDR.test(from)) return bad('"from" must be a 0x address (40 hex characters)');
  if (typeof to !== "string" || !ADDR.test(to)) return bad('"to" must be a 0x address (40 hex characters)');
  if (lc(from) === lc(to)) return bad('"from" and "to" must be different wallets');
  if (/^0x0{40}$/i.test(from) || /^0x0{40}$/i.test(to)) return bad("the zero address cannot be part of a handoff");
  if (typeof issuedAt !== "string" || !ISO.test(issuedAt) || !Number.isFinite(Date.parse(issuedAt))) return bad('"issuedAt" must be an ISO 8601 UTC time like 2026-10-28T12:00:00Z');
  const t = Date.parse(issuedAt);
  if (t > now + FUTURE_SKEW_MS) return bad('"issuedAt" is in the future');
  if (t < now - MAX_AGE_MS) return bad('"issuedAt" is more than 30 days old; sign a fresh handoff');
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length > SIG_MAX_HEX + 2 || signature.length < 132) return bad('"signature" must be a 0x hex signature');
  return { ok: true, network, from: lc(from), to: lc(to), issuedAt, signature };
}

/**
 * Decide one handoff. Every external read is injected:
 *   readDocument(origin)  -> parsed JSON served by the origin itself, or null
 *   livePayTo(origin)     -> the Base payTo the origin's 402 asks for, or null
 *   verifySignature({address, message, signature}) -> true | false (throws = unverifiable)
 *   isExcludedWallet(w)   -> true for a listed shared or self-funded wallet
 */
export async function verifyHandoff({ origin, readDocument, livePayTo, verifySignature, isExcludedWallet = () => false, now = Date.now() }) {
  const doc = await readDocument(origin);
  if (!doc) return bad(`no handoff document could be read from the origin itself; ${HANDOFF_FORMAT}`);
  const p = parseHandoff(doc, { now });
  if (!p.ok) return p;
  const live = livePayTo(origin);
  if (!live || lc(live) !== p.to) return bad(`the origin's Base 402 must already ask to be paid at "to" (${p.to}); the index last read ${live ? lc(live) : "no Base payTo"}. Update the 402, re-register the origin, then submit the handoff`);
  if (isExcludedWallet(p.from) || isExcludedWallet(p.to)) return bad("a wallet listed as a shared settlement contract, or one whose history is mostly self-funded, cannot be part of a handoff");
  let valid;
  try {
    valid = await verifySignature({ address: p.from, message: handoffMessage({ origin, network: p.network, from: p.from, to: p.to, issuedAt: p.issuedAt }), signature: p.signature });
  } catch {
    return { ok: false, reason: "the signature could not be checked right now (the chain read failed); try again shortly", retry: true };
  }
  if (valid !== true) return bad(`the signature is not the old wallet's (${p.from}) signature of the handoff message for this origin`);
  return { ok: true, record: { origin, network: p.network, from: p.from, to: p.to, issuedAt: p.issuedAt, verifiedAt: new Date(now).toISOString() } };
}

/** origin -> record. One JSON document (file, or the state database row). */
export function createHandoffStore({ file = null, log = null } = {}) {
  const say = (m) => { if (typeof log === "function") log(m); };
  const doc = file ? createJsonDocument({ file, log: say }) : null;
  const records = new Map();
  let loaded = false, ready = Promise.resolve(), refreshedAt = 0, refreshing = null;
  const MISSING = Object.freeze({});
  const clean = (o, r) => (r && typeof r === "object" && ADDR.test(r.from || "") && ADDR.test(r.to || "") && typeof o === "string"
    ? { origin: o, network: HANDOFF_NETWORK, from: lc(r.from), to: lc(r.to), issuedAt: String(r.issuedAt || ""), verifiedAt: String(r.verifiedAt || "") }
    : null);
  function apply(j) {
    records.clear();
    const entries = j && typeof j.records === "object" && j.records ? Object.entries(j.records) : [];
    for (const [o, r] of entries.slice(0, MAX_RECORDS)) { const c = clean(o, r); if (c) records.set(o, c); }
  }
  function load() {
    loaded = true;
    if (!doc) return ready;
    if (doc.backend === "pg") { ready = trackStoreReady(doc.load(MISSING).then((j) => { if (j !== MISSING) apply(j); })); return ready; }
    const j = doc.loadSync(MISSING);
    if (j !== MISSING) apply(j);
    return ready;
  }
  const ensure = () => { if (!loaded) load(); };
  function kick() {
    if (doc?.backend !== "pg" || refreshing || Date.now() - refreshedAt < 30_000) return;
    refreshing = doc.read().then((r) => { if (r.ok) { if (r.exists) apply(r.body); else records.clear(); refreshedAt = Date.now(); } })
      .catch(() => {}).finally(() => { refreshing = null; });
  }
  return {
    load,
    ready() { ensure(); return ready; },
    get(origin) { ensure(); kick(); return records.get(origin) || null; },
    list() { ensure(); kick(); return [...records.values()]; },
    /** Store a verified record. Refused when another origin already hands off from the same wallet. */
    async put(record) {
      ensure(); await ready;
      const c = clean(record.origin, record);
      if (!c) return { ok: false, reason: "malformed record" };
      const conflict = (m) => { for (const [o, r] of m) if (o !== c.origin && r.from === c.from) return o; return null; };
      if (!doc) {
        if (conflict(records)) return { ok: false, conflict: true };
        records.set(c.origin, c);
        return { ok: true };
      }
      let verdict = null;
      const r = await doc.update((b) => {
        const body = b && typeof b === "object" && b.records && typeof b.records === "object" ? { version: 1, records: { ...b.records } } : { version: 1, records: {} };
        const m = new Map(Object.entries(body.records).map(([o, x]) => [o, clean(o, x)]).filter(([, x]) => x));
        if (conflict(m)) { verdict = "conflict"; return SKIP_UPDATE; }
        if (!Object.hasOwn(body.records, c.origin) && Object.keys(body.records).length >= MAX_RECORDS) { verdict = "full"; return SKIP_UPDATE; }
        body.records[c.origin] = { from: c.from, to: c.to, issuedAt: c.issuedAt, verifiedAt: c.verifiedAt };
        verdict = "changed";
        return body;
      }, { fallback: null });
      if (!r.ok) return { ok: false, reason: "the handoff could not be stored" };
      if (r.body && typeof r.body === "object") apply(r.body);
      refreshedAt = Date.now();
      if (verdict === "conflict") return { ok: false, conflict: true };
      if (verdict === "full") return { ok: false, reason: "the handoff list is full" };
      return { ok: true };
    },
  };
}

/**
 * Attach each stored handoff to its origin's evidence binding (the object
 * evidencePayToVerdict reads). Applied only when neither wallet is excluded;
 * the verdict then adds `to` only if `from` clears the floor on this origin.
 */
export function attachHandoffs(binding, records, { isExcludedWallet = () => false } = {}) {
  if (!(binding instanceof Map)) return binding;
  for (const r of records || []) {
    const e = binding.get(r.origin);
    if (!e || isExcludedWallet(r.from) || isExcludedWallet(r.to)) continue;
    e.handoff = { from: r.from, to: r.to, issuedAt: r.issuedAt, verifiedAt: r.verifiedAt };
  }
  return binding;
}
