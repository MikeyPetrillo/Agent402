// A second facilitator on the Solana mainnet rail, sharing its quotes with the
// boot-order one (SOLANA_FACILITATOR_URL, SOLANA_FACILITATOR_SHARE).
//
// Why a share and not a settle fallback. An exact Solana offer names the
// facilitator's fee payer in extra.feePayer, and the buyer builds and
// partially signs a transaction whose first static account (the fee payer) is
// that address. A facilitator verifies that the offer's feePayer is one of its
// own signers (fee_payer_not_managed_by_facilitator) and that the transaction's
// fee payer equals it (fee payer mismatch) before it signs or broadcasts
// anything (@x402/svm exact facilitator). So the one facilitator that can
// settle a Solana payment is the one whose signer the transaction names: a
// re-settle elsewhere can only be refused, never moves money, and is not
// attempted. What two facilitators CAN do is split the quotes:
//
//   - each 402 names ONE facilitator's fee payer. Which one is a pure function
//     of the request (client address, method, URL), so a buyer reading the
//     same 402 twice sees the same offer, and the share of quotes that name
//     the listed facilitator is SOLANA_FACILITATOR_SHARE percent;
//   - a paid request is routed by the fee payer its signed transaction names
//     (read from the transaction bytes, never from a label): the listed
//     facilitator's signer goes to the listed facilitator, the boot-order
//     facilitator's to it, and a fee payer neither one manages is refused
//     before any facilitator is asked (nothing is charged; the 402 offers
//     every network again). A paid retry is never re-chosen by the share, so
//     a 402 and its paid retry cannot alternate;
//   - the listed facilitator is used for quotes only while its /supported
//     lists exact on Solana mainnet with a valid base58 fee payer that is not
//     one of the boot-order facilitator's signers; otherwise every Solana
//     offer names the boot-order facilitator, exactly as with the switch
//     unset. It is read at boot and again on a timer.
//
// Mechanism (the same seam as src/settle-preference.js): the payment
// middleware runs inside an AsyncLocalStorage scope that names the listed
// facilitator, and the resource server's three lookups that name a
// facilitator (its /supported kind, its extensions, its client) read that
// scope first for (v2, Solana mainnet, exact) only. Outside a scope every
// lookup is the vendor's own, so unset means unchanged.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { decodePaymentHeader } from "./payment-header.js";
import { paymentHeaderOf } from "./payer.js";
import { svmRequiredSigners } from "./svm-payer.js";

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SVM_FEE_PAYER_NOT_OFFERED = "fee_payer_not_offered";
export const SVM_FEE_PAYER_NOT_OFFERED_MESSAGE =
  "The Solana transaction names a fee payer this server does not offer. Nothing was charged; pay again from a fresh 402's Solana offer or on another network.";

const scope = new AsyncLocalStorage();
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A base58 string that decodes to exactly 32 bytes (a Solana address). */
export function isSolanaAddress(s) {
  if (typeof s !== "string" || !B58_RE.test(s)) return false;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let zeros = 0;
  for (const c of s) { if (c !== "1") break; zeros++; }
  let len = 0;
  while (n > 0n) { n >>= 8n; len++; }
  return zeros + len === 32;
}

/**
 * SOLANA_FACILITATOR_SHARE: the percent of Solana quotes that name the listed
 * facilitator. Unset or blank = 50 (about every other quote). An integer
 * 0..100 (an optional trailing %) is that share; anything else is null and
 * the caller leaves the rail on the boot-order facilitator.
 */
export function parseSvmShare(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return 50;
  const m = /^(\d{1,3})%?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/** 0..99 from a request identity, the same on every replica and every boot. */
export function shareBucket(identity) {
  const h = createHash("sha256").update(String(identity)).digest();
  return h.readUInt32BE(0) % 100;
}

/** The identity a quote is chosen by: client address, method and URL. */
export function quoteIdentity(req) {
  const ip = String(req?.ip || req?.socket?.remoteAddress || "");
  return `${ip}|${String(req?.method || "").toUpperCase()}|${String(req?.originalUrl || req?.url || "")}`;
}

/**
 * Does a /supported answer list exact on `network` (x402 v2) with a usable
 * fee payer? { ok, kind, signers, extensions, reason }. `signers` holds the
 * kind's fee payer and every signer the answer publishes for the network.
 */
export function confirmSvmKind(supported, network = SOLANA_MAINNET) {
  const kinds = Array.isArray(supported?.kinds) ? supported.kinds : null;
  if (!kinds) return { ok: false, reason: "its /supported answer carries no kinds" };
  const kind = kinds.find((k) => k && k.x402Version === 2 && k.network === network && String(k.scheme || "").toLowerCase() === "exact");
  if (!kind) return { ok: false, reason: `its /supported does not list exact on ${network}` };
  const feePayer = kind.extra?.feePayer;
  if (!isSolanaAddress(feePayer)) return { ok: false, reason: `its exact kind on ${network} names no valid fee payer` };
  const signers = new Set([feePayer]);
  const pub = supported?.signers && typeof supported.signers === "object" ? supported.signers : {};
  for (const key of [network, "solana:*"]) {
    for (const a of Array.isArray(pub[key]) ? pub[key] : []) if (isSolanaAddress(a)) signers.add(a);
  }
  return { ok: true, kind, signers, extensions: Array.isArray(supported?.extensions) ? supported.extensions : [] };
}

/**
 * The Solana fee payer a paid request's signed transaction names: { paid,
 * feePayer }. `paid` is false when the request carries no Solana mainnet
 * payment; `feePayer` is null when the transaction cannot be read.
 */
export function svmFeePayerOfRequest(req, network = SOLANA_MAINNET) {
  const header = paymentHeaderOf(req);
  if (!header) return { paid: false, feePayer: null };
  let payload = null;
  try { payload = decodePaymentHeader(header); } catch { payload = null; }
  const net = payload?.accepted?.network || payload?.network;
  if (net !== network && !(net === "solana" && network === SOLANA_MAINNET)) return { paid: false, feePayer: null };
  const tx = payload?.payload?.transaction;
  const signers = typeof tx === "string" ? svmRequiredSigners(tx) : null;
  return { paid: true, feePayer: signers && signers.length ? signers[0] : null };
}

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  t.unref?.();
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/**
 * entries: [{ url, label, client }] in the operator's order (the first that
 * confirms is quoted). share: 0..100. Returns the split; nothing is wrapped
 * until install(server) and wrap(middleware) are called.
 */
export function createSvmFacilitatorSplit({ entries, share, network = SOLANA_MAINNET, log = console, timeoutMs = 6000 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).map((e) => ({ ...e, state: null, everSigners: new Set() }));
  let server = null, origKind = null, origExt = null, origClient = null;
  let overlapWarned = false;

  const defaultKind = () => {
    try { return origKind ? origKind(2, network, "exact") : null; } catch { return null; }
  };
  const defaultSigners = () => {
    const out = new Set();
    const k = defaultKind();
    if (isSolanaAddress(k?.extra?.feePayer)) out.add(k.extra.feePayer);
    try {
      const sup = server?.supportedResponsesMap?.get?.(2)?.get?.(network)?.get?.("exact");
      const pub = sup?.signers && typeof sup.signers === "object" ? sup.signers : {};
      for (const key of [network, "solana:*"]) for (const a of Array.isArray(pub[key]) ? pub[key] : []) if (isSolanaAddress(a)) out.add(a);
    } catch { /* the kind alone */ }
    return out;
  };
  // The entry quoted now: the first whose last read confirmed, and whose
  // signers share none with the boot-order facilitator's (a shared signer
  // would make the route of a paid transaction ambiguous).
  const active = () => {
    const def = defaultSigners();
    for (const e of list) {
      if (!e.state?.ok) continue;
      if ([...e.state.signers].some((a) => def.has(a))) {
        if (!overlapWarned) { overlapWarned = true; log.warn?.(`WARNING: SOLANA_FACILITATOR_URL: ${e.label} names a fee payer the boot-order facilitator also names; every Solana offer stays on the boot-order facilitator`); }
        continue;
      }
      return e;
    }
    return null;
  };
  // The entry whose signer a paid transaction names (any it ever published,
  // so a read that fails between the 402 and its paid retry does not refuse it).
  const ownerOf = (feePayer) => list.find((e) => e.everSigners.has(feePayer)) || null;

  async function readEntry(e) {
    let supported = null, reason = null;
    try {
      const read = typeof e.client.__a402FreshSupported === "function" ? e.client.__a402FreshSupported() : e.client.getSupported();
      supported = await withTimeout(read, timeoutMs);
    } catch (err) {
      reason = `its /supported could not be read (${String(err?.message || err).slice(0, 120)})`;
    }
    const before = e.state?.ok === true;
    const c = supported ? confirmSvmKind(supported, network) : { ok: false, reason };
    if (c.ok) {
      e.state = { ok: true, kind: c.kind, signers: c.signers, extensions: c.extensions, supported };
      for (const a of c.signers) e.everSigners.add(a);
      if (!before) log.log?.(`Solana: ${e.label} confirmed exact on ${network} (fee payer ${c.kind.extra.feePayer}); it takes ${share}% of Solana quotes`);
    } else {
      // The last confirmed kind stays for routing a payment already quoted
      // with it; only new quotes stop naming this facilitator.
      e.state = { ok: false, reason: c.reason, kind: e.state?.kind || null, extensions: e.state?.extensions || [] };
      if (before || e.reported !== c.reason) log.warn?.(`WARNING: SOLANA_FACILITATOR_URL: ${e.label} not used for Solana quotes: ${c.reason}; those quotes name the boot-order facilitator`);
      e.reported = c.reason;
    }
    return e.state;
  }

  const split = {
    network, share,
    entries: list,
    /** Read every listed facilitator's /supported once (boot and timer). */
    async check() { await Promise.all(list.map(readEntry)); return split.status(); },
    /** Re-read on a timer, unref'd. Returns a stop function. */
    start(everyMs = 600_000) {
      const t = setInterval(() => { split.check().catch(() => {}); }, Math.max(10_000, everyMs));
      t.unref?.();
      return () => clearInterval(t);
    },
    status() {
      const a = active();
      return { active: a ? a.label : null, share, entries: list.map((e) => ({ label: e.label, ok: e.state?.ok === true, reason: e.state?.ok ? null : e.state?.reason || "not read" })) };
    },
    /** The scope a request runs in, or null for the vendor's own lookups. */
    decide(req) {
      const { paid, feePayer } = svmFeePayerOfRequest(req, network);
      if (paid) {
        if (!feePayer) return null; // unreadable: the boot-order facilitator verifies (and refuses) it
        const owner = ownerOf(feePayer);
        if (owner && owner.state?.kind) return { entry: owner, feePayer };
        if (defaultSigners().has(feePayer)) return null;
        return { refuse: true, feePayer };
      }
      const a = active();
      if (!a || share <= 0) return null;
      return share >= 100 || shareBucket(quoteIdentity(req)) < share ? { entry: a, feePayer: a.state.kind.extra.feePayer } : null;
    },
    /** Wrap the three lookups and add the pre-verify refusal. Idempotent. */
    install(s) {
      if (!s || server) return s;
      server = s;
      origKind = s.getSupportedKind.bind(s);
      origExt = s.getFacilitatorExtensions.bind(s);
      origClient = s.getFacilitatorClient.bind(s);
      const mine = (v, n, sc) => v === 2 && n === network && String(sc || "").toLowerCase() === "exact";
      s.getSupportedKind = (v, n, sc) => {
        const ctx = scope.getStore();
        if (ctx?.entry && mine(v, n, sc)) {
          const k = ctx.entry.state.kind;
          return ctx.feePayer && ctx.feePayer !== k.extra.feePayer ? { ...k, extra: { ...k.extra, feePayer: ctx.feePayer } } : k;
        }
        return origKind(v, n, sc);
      };
      s.getFacilitatorExtensions = (v, n, sc) => {
        const ctx = scope.getStore();
        if (ctx?.entry && mine(v, n, sc)) return ctx.entry.state.extensions || [];
        return origExt(v, n, sc);
      };
      s.getFacilitatorClient = (v, n, sc) => {
        const ctx = scope.getStore();
        if (ctx?.entry && mine(v, n, sc)) return ctx.entry.client;
        return origClient(v, n, sc);
      };
      if (typeof s.onBeforeVerify === "function") {
        s.onBeforeVerify(async (ctx) => {
          const sc = scope.getStore();
          if (!sc?.refuse || ctx?.requirements?.network !== network) return undefined;
          return { abort: true, reason: SVM_FEE_PAYER_NOT_OFFERED, message: SVM_FEE_PAYER_NOT_OFFERED_MESSAGE };
        });
      }
      return s;
    },
    /** Run a payment middleware inside the request's scope. */
    wrap(mw) {
      return function svmFacilitatorSplit(req, res, next) {
        let ctx = null;
        try { ctx = split.decide(req); } catch { ctx = null; }
        return ctx ? scope.run(ctx, () => mw(req, res, next)) : mw(req, res, next);
      };
    },
  };
  return split;
}

/** For tests: run `fn` inside a split scope. */
export function runInSvmSplitScope(ctx, fn) { return scope.run(ctx, fn); }
