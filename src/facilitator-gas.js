// Gas runway of the facilitators' settlement signers on a chain they settle
// for us.
//
// An external facilitator pays the gas of every settlement from its own
// signer wallet. When that wallet runs dry, its settle answers a revert for
// every payment until someone refills it, and nothing on our side says why:
// verify still passes, the buyer's payment is valid, and the facilitator
// stays reachable. So the signers are read directly: each facilitator's
// GET /supported names them (`signers["eip155:*"]`, or the network's own key),
// and the chain's RPC gives each one's native balance and the current gas
// price. Runway is the number of settlements the balance still pays for at a
// fixed gas allowance per settlement.
//
// A reading is "low" under the minimum runway, and "unread" after enough
// consecutive failed reads that the balance cannot be vouched for; a single
// failed read keeps the last good reading. A failed read is our RPC read
// failing, not evidence of a short balance: "unread" makes the
// facilitatorFunds word read unknown, never low; unknown pages under its own
// title only once it has held past FACILITATOR_UNREAD_PAGE_HOURS
// (alert=sustained, src/tool-failure-monitor.js). A facilitator whose /supported
// answers but names no signer for the network reads "unknown": nothing to
// watch is not a failure, so it is logged once and never pages. Readings feed the facilitatorFunds
// word through the tool-failure monitor (noteRelayerGas), which shares them
// across replicas.
import { positiveNum as num } from "./env-num.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_SIGNERS = 5;

/** Defaults, env-tunable: the runway that reads low, the gas one settlement is
 *  budgeted at, consecutive failed reads before a signer reads unread, and
 *  the check cadence. */
export function gasCheckSettings(env = process.env) {
  return {
    minRunway: num(env.FACILITATOR_GAS_MIN_SETTLEMENTS, 500),
    gasPerSettlement: num(env.FACILITATOR_GAS_PER_SETTLEMENT, 100_000),
    failAfter: num(env.FACILITATOR_GAS_FAIL_AFTER, 3),
    intervalMs: num(env.FACILITATOR_GAS_CHECK_MS, 10 * 60_000),
  };
}

/** The settlement signers a /supported body names for `network`: its own key
 *  first, then the `eip155:*` wildcard; addresses only, at most a few. */
export function signersFromSupported(body, network) {
  const s = body && typeof body === "object" ? body.signers : null;
  if (!s || typeof s !== "object") return [];
  const out = [];
  for (const key of [network, "eip155:*"]) {
    const list = Array.isArray(s[key]) ? s[key] : [];
    for (const a of list) {
      const addr = String(a || "").trim();
      if (ADDRESS.test(addr) && !out.some((x) => x.toLowerCase() === addr.toLowerCase())) out.push(addr);
    }
  }
  return out.slice(0, MAX_SIGNERS);
}

/** Settlements a balance still pays for: floor(balance / (gasPrice x gas)). */
export function runwayOf(balanceWei, gasPriceWei, gasPerSettlement) {
  const per = BigInt(gasPriceWei) * BigInt(Math.max(1, Math.round(gasPerSettlement)));
  if (per <= 0n) return null;
  const r = BigInt(balanceWei) / per;
  return r > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(r);
}

/** The floor alarm's settings, env-tunable: the share of the chain's price
 *  floor one settlement's gas may reach before the word reads low, the gas
 *  units one settlement uses, how long an ETH price is reused before it is
 *  read again (an upstream with a monthly credit budget), and how long a last
 *  good ETH price stands in for a failed read (one TTL plus an hour by
 *  default, so a single failed refresh does not read unknown). */
export function floorGasSettings(env = process.env) {
  const share = Number(env.FLOOR_GAS_ALARM_SHARE);
  return {
    share: Number.isFinite(share) && share > 0 && share <= 1 ? share : 0.8,
    gasUnits: num(env.FLOOR_GAS_UNITS, 85_400),
    priceTtlMs: num(env.FLOOR_GAS_PRICE_TTL_MS, 60 * 60_000),
    priceMaxAgeMs: num(env.FLOOR_GAS_PRICE_MAX_AGE_MS, num(env.FLOOR_GAS_PRICE_TTL_MS, 60 * 60_000) + 60 * 60_000),
  };
}

/**
 * Settlement gas against the chain's price floor. A floored chain's calls are
 * priced at least the floor in USD, but the gas one settlement burns is paid
 * in ETH, so its USD cost moves with ETH's price. Each check prices one
 * settlement (gas units x gas price x ETH/USD) and reads "low" with reason
 * gasNearFloor once that passes `share` of the floor. A failed ETH price read
 * keeps the last good price for `priceMaxAgeMs`, then reads "unknown" (never
 * a page by itself). One log line per state change.
 * @param {object} o
 * @param {string} o.network - CAIP-2
 * @param {() => number} o.floorUsd - the floor now (0 = no floor, no row)
 * @param {() => Promise<number>} o.readEthUsd
 */
export function createFloorGasCheck({ network, floorUsd, readEthUsd, settings = floorGasSettings(), now = Date.now, log = console.warn } = {}) {
  let lastPrice = null; // { usd, at }
  let lastState = null;
  const row = (fields) => ({ network, facilitator: "price floor", signer: null, balanceEth: null, runway: null, ...fields });
  async function check(gasPriceWei) {
    const at = now();
    const floor = Number(typeof floorUsd === "function" ? floorUsd() : floorUsd) || 0;
    if (!(floor > 0)) return null;
    let error = null;
    // ETH/USD is read at most once per TTL; between reads the last good price
    // stands. A failed read is retried on the next check.
    if (!lastPrice || at - lastPrice.at >= settings.priceTtlMs) {
      try {
        const usd = Number(await readEthUsd());
        if (Number.isFinite(usd) && usd > 0) lastPrice = { usd, at };
        else error = "ETH price read answered no price";
      } catch (e) { error = String(e?.message || e).slice(0, 120); }
    }
    let reading;
    if (!lastPrice || at - lastPrice.at > settings.priceMaxAgeMs) {
      reading = row({ status: "unknown", reason: "ethPriceUnread", floorUsd: floor, error: error || "no ETH price yet", at });
    } else if (gasPriceWei === null || gasPriceWei === undefined) {
      reading = row({ status: "unknown", reason: "gasPriceUnread", floorUsd: floor, ethUsd: lastPrice.usd, at });
    } else {
      const gasUsd = (Number(BigInt(gasPriceWei) * BigInt(Math.round(settings.gasUnits))) / 1e18) * lastPrice.usd;
      const near = gasUsd > floor * settings.share;
      reading = row({
        status: near ? "low" : "ok", ...(near ? { reason: "gasNearFloor" } : {}),
        gasUsd: Math.round(gasUsd * 1e6) / 1e6, floorUsd: floor, sharePct: Math.round((gasUsd / floor) * 1000) / 10,
        ethUsd: lastPrice.usd, ...(error ? { error: `last good ETH price kept: ${error}` } : {}), at,
      });
    }
    const state = `${reading.status}:${reading.reason || ""}`;
    if (state !== lastState) {
      lastState = state;
      try { log(`[facilitator-gas] ${network} settlement gas vs price floor: ${reading.status}${reading.reason ? ` (${reading.reason})` : ""}${reading.sharePct !== undefined ? `, ${reading.sharePct}% of the floor` : ""}`); } catch { /* logging only */ }
    }
    return reading;
  }
  return { check };
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url || "").slice(0, 80); } };

/**
 * One checker for a set of facilitators on one network.
 * @param {object} o
 * @param {string[]} o.urls - facilitator base URLs, in settle order
 * @param {string} o.network - CAIP-2 (eip155:<id>)
 * @param {string|null} o.rpcUrl - the chain's JSON-RPC endpoint
 * @param {Function} [o.fetchImpl]
 * @param {object} [o.settings] - gasCheckSettings() shape
 * @param {Array<{label: string, signer: string}>} [o.ownSigners] - signers we
 *   run ourselves (our own relayer), read directly with no /supported
 */
export function createRelayerGasCheck({ urls, network, rpcUrl, fetchImpl = fetch, settings = gasCheckSettings(), timeoutMs = 10_000, now = Date.now, log = console.warn, ownSigners = [], floorCheck = null } = {}) {
  const namedNoSigner = new Set(); // urls already logged as publishing no signer
  const signersByUrl = new Map(); // url -> last signers read from /supported
  const state = new Map(); // `${url}|${signer}` -> { failures, last }

  async function getJson(url, init = {}) {
    const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  let rpcId = 0;
  async function rpc(method, params) {
    if (!rpcUrl) throw new Error("no RPC for this network");
    const body = await getJson(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    if (body?.error) throw new Error(String(body.error?.message || "rpc error").slice(0, 120));
    if (typeof body?.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(body.result) || body.result === "0x") throw new Error("rpc answered no value");
    return BigInt(body.result);
  }

  /** Read every signer once; resolves to the readings (never throws). */
  async function check() {
    const at = now();
    let gasPrice = null, gasError = null;
    try { gasPrice = await rpc("eth_gasPrice", []); } catch (e) { gasError = String(e?.message || e).slice(0, 120); }
    const readings = [];
    if (floorCheck) {
      try { const f = await floorCheck.check(gasPrice); if (f) readings.push(f); } catch { /* the floor row is advisory */ }
    }
    // Our own relayer is a facilitator of its own: its signer is known, so
    // there is no /supported to read, only its balance.
    const own = (Array.isArray(ownSigners) ? ownSigners : []).filter((o) => ADDRESS.test(String(o?.signer || "")));
    for (const url of [...urls, ...own.map((o) => ({ own: o }))]) {
      if (url && typeof url === "object" && url.own) {
        const { label, signer } = url.own;
        // Whether our relayer's minimum sale price is at or under the lowest
        // price sold on this chain (src/payments.js ownRelayerCoversLowestPrice).
        let covers = {};
        if (typeof url.own.coversLowestPrice === "function") { try { covers = { coversLowestPrice: url.own.coversLowestPrice() === true }; } catch { covers = { coversLowestPrice: false }; } }
        const key = `own:${label}|${signer}`;
        const s = state.get(key) || { failures: 0, last: null };
        let error = gasError, reading = null;
        if (!error) {
          try {
            const balance = await rpc("eth_getBalance", [signer, "latest"]);
            const runway = runwayOf(balance, gasPrice, settings.gasPerSettlement);
            reading = { network, facilitator: String(label || "own relayer"), signer, own: true, balanceEth: Number(balance) / 1e18, runway, status: runway !== null && runway < settings.minRunway ? "low" : "ok", ...covers, at };
          } catch (e) { error = String(e?.message || e).slice(0, 120); }
        }
        if (reading) { s.failures = 0; s.last = reading; state.set(key, s); readings.push(reading); continue; }
        s.failures++;
        state.set(key, s);
        if (s.failures >= settings.failAfter) readings.push({ network, facilitator: String(label || "own relayer"), signer, own: true, balanceEth: s.last?.balanceEth ?? null, runway: s.last?.runway ?? null, status: "unread", failures: s.failures, error, ...covers, at });
        else if (s.last) readings.push({ ...s.last, ...covers, failures: s.failures, error });
        continue;
      }
      const facilitator = hostOf(url);
      let signers = signersByUrl.get(url) || [];
      let supportedError = null;
      let publishesNoSigner = false;
      try {
        const fresh = signersFromSupported(await getJson(`${url.replace(/\/+$/, "")}/supported`), network);
        if (fresh.length) { signers = fresh; signersByUrl.set(url, fresh); } else if (!signers.length) publishesNoSigner = true;
      } catch (e) {
        supportedError = String(e?.message || e).slice(0, 120);
      }
      if (publishesNoSigner) {
        if (!namedNoSigner.has(url)) {
          namedNoSigner.add(url);
          try { log(`[facilitator-gas] ${facilitator} names no settlement signer for ${network} in /supported: its gas cannot be watched`); } catch { /* logging only */ }
        }
        state.delete(`${url}|`);
        readings.push({ network, facilitator, signer: null, balanceEth: null, runway: null, status: "unknown", error: "no signer named for this network", at });
        continue;
      }
      // No signer known at all: one row for the facilitator itself.
      const targets = signers.length ? signers : [null];
      for (const signer of targets) {
        const key = `${url}|${signer || ""}`;
        const s = state.get(key) || { failures: 0, last: null };
        let error = signer ? gasError : (supportedError || "no signer known");
        let reading = null;
        if (!error) {
          try {
            const balance = await rpc("eth_getBalance", [signer, "latest"]);
            const runway = runwayOf(balance, gasPrice, settings.gasPerSettlement);
            reading = {
              network, facilitator, signer,
              balanceEth: Number(balance) / 1e18,
              runway,
              status: runway !== null && runway < settings.minRunway ? "low" : "ok",
              at,
            };
          } catch (e) { error = String(e?.message || e).slice(0, 120); }
        }
        if (reading) {
          s.failures = 0;
          s.last = reading;
          state.set(key, s);
          readings.push(reading);
          continue;
        }
        s.failures++;
        state.set(key, s);
        if (s.failures >= settings.failAfter) {
          readings.push({ network, facilitator, signer, balanceEth: s.last?.balanceEth ?? null, runway: s.last?.runway ?? null, status: "unread", failures: s.failures, error, at });
        } else if (s.last) {
          readings.push({ ...s.last, failures: s.failures, error });
        }
      }
    }
    return readings;
  }

  return { check, _state: state };
}

/**
 * Log lines for one EVM gas check's readings. The facilitator settled first
 * (`primary`, the first in the settle order) and our own relayer log every
 * low or unread reading on every check, as before. A later fallback in the
 * order logs once per state change only (low, unread, and back to ok), since
 * a fallback that never takes a settlement while the first one answers is a
 * spare, not an outage; its readings stay on the operator detail every
 * check. `seen` keeps each fallback signer's last logged state across checks.
 */
export function evmGasLogLines(readings, { network, primary = null, seen = new Map() } = {}) {
  const lines = [];
  for (const r of Array.isArray(readings) ? readings : []) {
    if (!r || r.facilitator === "price floor") continue;
    const bad = r.status === "low" || r.status === "unread";
    const line = `[facilitator-gas] ${r.facilitator} signer ${r.signer || "(unknown)"} on ${network}: ${r.status}${r.runway !== null && r.runway !== undefined ? ` (runway ${r.runway} settlements)` : ""}${r.error ? ` - ${r.error}` : ""}`;
    if (r.own || !primary || r.facilitator === primary) { if (bad) lines.push(line); continue; }
    const key = `${r.facilitator}|${r.signer || ""}`;
    const state = bad ? r.status : "ok";
    const prev = seen.get(key);
    if (prev === state || (prev === undefined && !bad)) { seen.set(key, state); continue; }
    seen.set(key, state);
    lines.push(`${line} (a fallback after ${primary} in the settle order; logged once per state change)`);
  }
  return lines;
}

// ---- Solana fee payers ------------------------------------------------------
//
// A Solana x402 payment settles only at the facilitator whose fee payer the
// buyer's transaction names (src/svm-facilitator-split.js), and that fee
// payer pays the transaction's fee in SOL. When it runs dry every Solana
// payment quoted with it is refused (uncharged) until it is refilled. So each
// fee payer a quote can name is read: its address from the facilitator's
// cached /supported answer (extra.feePayer of exact on Solana mainnet), its
// SOL balance from getBalance over the shared Solana RPC list (the keyed lane
// first, so its calls count under that provider's daily ceiling), once per
// check, never per payment.
//
// Runway is the settlements the balance still pays for at a fixed fee per
// settlement. The estimate (FACILITATOR_SVM_LAMPORTS_PER_SETTLEMENT, default
// 20,000 lamports): an exact Solana payment carries two signatures (the fee
// payer's and the buyer's), each 5,000 lamports of base fee, plus a
// priority-fee allowance of 10,000 lamports. The exact client asks for a
// 20,000 compute unit limit at 1 microlamport per unit (well under one
// lamport of priority fee), so the allowance holds for a compute unit price
// up to 500,000 microlamports. The fee payer also keeps a rent-exempt minimum
// for a plain account (890,880 lamports) that fees cannot spend, so that much
// is subtracted before the runway is counted.
//
// Each row reads ok, low (runway under FACILITATOR_SVM_GAS_MIN_SETTLEMENTS),
// empty (runway under FACILITATOR_SVM_GAS_EMPTY_SETTLEMENTS), unread (the
// balance could not be read FACILITATOR_GAS_FAIL_AFTER times running; one
// failed read keeps the last reading) or unknown (the facilitator names no
// fee payer). A row carries its facilitator's share of Solana quotes; a
// facilitator with share 0 is marked standby: it is reported but never pages.

/** The rent-exempt minimum of a plain system account, in lamports. */
export const SOL_RENT_RESERVE_LAMPORTS = 890_880;
const SOLANA_MAINNET_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_FEE_PAYERS = 6;

/** Defaults, env-tunable (see the block above). */
export function svmGasCheckSettings(env = process.env) {
  return {
    minRunway: num(env.FACILITATOR_SVM_GAS_MIN_SETTLEMENTS, 500),
    emptyRunway: num(env.FACILITATOR_SVM_GAS_EMPTY_SETTLEMENTS, 1),
    lamportsPerSettlement: num(env.FACILITATOR_SVM_LAMPORTS_PER_SETTLEMENT, 20_000),
    failAfter: num(env.FACILITATOR_GAS_FAIL_AFTER, 3),
    intervalMs: num(env.FACILITATOR_GAS_CHECK_MS, 10 * 60_000),
  };
}

/** Settlements a balance still pays for once the rent reserve is kept. */
export function svmRunwayOf(lamports, perSettlement, reserve = SOL_RENT_RESERVE_LAMPORTS) {
  const per = Math.max(1, Math.round(Number(perSettlement) || 0));
  const usable = Math.max(0, Number(lamports) - reserve);
  return Number.isFinite(usable) ? Math.floor(usable / per) : null;
}

const shareOf = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0; };

/**
 * The Solana facilitators a quote can name now, with each one's fee payer and
 * share of quotes: the listed ones from the split (src/svm-facilitator-split.js
 * feePayers(); the active one takes its share, the others none) and the
 * boot-order facilitator, which takes the rest (all of it with no split).
 * @param {object} o
 * @param {Array<{label:string,url:string|null,feePayer:string|null,share:number}>|null} o.split - split.feePayers(), or null with no split
 * @param {string|null} o.bootFeePayer - the boot-order facilitator's fee payer (its cached /supported)
 * @param {string} o.bootLabel - the boot-order facilitator's label
 */
export function svmFeePayerTargets({ split = null, bootFeePayer = null, bootLabel = "boot-order" } = {}) {
  const out = [];
  if (Array.isArray(split)) {
    for (const e of split) {
      if (!e) continue;
      if (e.label === "boot-order") { out.push({ facilitator: bootLabel, feePayer: e.feePayer || bootFeePayer || null, share: shareOf(e.share) }); continue; }
      out.push({ facilitator: hostOf(e.url || e.label), feePayer: e.feePayer || null, share: shareOf(e.share) });
    }
    if (!out.some((t) => t.facilitator === bootLabel)) out.push({ facilitator: bootLabel, feePayer: bootFeePayer || null, share: 100 - out.reduce((a, t) => a + t.share, 0) });
  } else {
    out.push({ facilitator: bootLabel, feePayer: bootFeePayer || null, share: 100 });
  }
  return out.slice(0, MAX_FEE_PAYERS);
}

/**
 * One checker for the Solana fee payers.
 * @param {object} o
 * @param {() => (Array|Promise<Array>)} o.targets - svmFeePayerTargets() shape, read each check
 * @param {string[]} o.rpcUrls - Solana JSON-RPC endpoints, tried in order
 */
export function createSvmFeePayerGasCheck({ targets, rpcUrls = [], network = SOLANA_MAINNET_NET, fetchImpl = globalThis.fetch, settings = svmGasCheckSettings(), timeoutMs = 10_000, now = Date.now, log = console.warn } = {}) {
  const state = new Map(); // `${facilitator}|${feePayer}` -> { failures, last }
  const logged = new Map(); // same key -> last logged state
  let rpcId = 0;

  async function readLamports(address) {
    let lastError = null;
    for (const url of (Array.isArray(rpcUrls) ? rpcUrls : []).slice(0, 4)) {
      try {
        const r = await fetchImpl(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "getBalance", params: [address, { commitment: "confirmed" }] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        if (body?.error) throw new Error(String(body.error?.message || "rpc error").slice(0, 120));
        const v = body?.result?.value;
        if (!Number.isSafeInteger(v) || v < 0) throw new Error("rpc answered no balance");
        return v;
      } catch (e) {
        // Never the URL: a keyed lane carries its key in the path.
        lastError = new Error(String(e?.name === "TimeoutError" ? "timed out" : e?.message || e).replace(/https?:\/\/\S+/g, "(rpc)").slice(0, 120));
      }
    }
    throw lastError || new Error("no Solana RPC configured");
  }

  function noteLog(r) {
    const key = `${r.facilitator}|${r.signer || ""}`;
    const st = `${r.status}|${r.standby ? "standby" : "paging"}`;
    const prev = logged.get(key);
    logged.set(key, st);
    if (prev === st || (prev === undefined && r.status === "ok")) return;
    try {
      log(`[facilitator-gas] Solana fee payer ${r.signer || "(none named)"} of ${r.facilitator} (${r.share}% of Solana quotes${r.standby ? ", standby: does not page" : ""}): ${r.status}${Number.isFinite(r.runway) ? ` (runway ${r.runway} settlements)` : ""}${r.error ? ` - ${r.error}` : ""}`);
    } catch { /* logging only */ }
  }

  /** Read every fee payer once; resolves to the readings (never throws). */
  async function check() {
    const at = now();
    let list = [];
    try { list = await (typeof targets === "function" ? targets() : targets); } catch { list = []; }
    const readings = [];
    for (const t of (Array.isArray(list) ? list : []).slice(0, MAX_FEE_PAYERS)) {
      const facilitator = String(t?.facilitator || "unknown").slice(0, 120);
      const share = shareOf(t?.share);
      const base = { network, facilitator, share, ...(share > 0 ? {} : { standby: true }) };
      const feePayer = SOL_ADDRESS.test(String(t?.feePayer || "")) ? String(t.feePayer) : null;
      let reading;
      if (!feePayer) {
        reading = { ...base, signer: null, balanceSol: null, runway: null, status: "unknown", error: "no fee payer named in its /supported", at };
      } else {
        const key = `${facilitator}|${feePayer}`;
        const s = state.get(key) || { failures: 0, last: null };
        try {
          const lamports = await readLamports(feePayer);
          const runway = svmRunwayOf(lamports, settings.lamportsPerSettlement);
          const status = runway < settings.emptyRunway ? "empty" : runway < settings.minRunway ? "low" : "ok";
          reading = { ...base, signer: feePayer, balanceSol: lamports / 1e9, runway, status, at };
          s.failures = 0;
          s.last = reading;
        } catch (e) {
          s.failures++;
          const error = String(e?.message || e).slice(0, 120);
          if (s.failures >= settings.failAfter || !s.last) {
            reading = s.failures >= settings.failAfter
              ? { ...base, signer: feePayer, balanceSol: s.last?.balanceSol ?? null, runway: s.last?.runway ?? null, status: "unread", failures: s.failures, error, at }
              : null;
          } else {
            reading = { ...s.last, ...base, failures: s.failures, error };
          }
        }
        state.set(key, s);
      }
      if (!reading) continue;
      readings.push(reading);
      noteLog(reading);
    }
    return readings;
  }

  return { check, _state: state };
}
