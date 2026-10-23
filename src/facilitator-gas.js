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
// failed read keeps the last good reading. A facilitator whose /supported
// answers but names no signer for the network reads "unknown": nothing to
// watch is not a failure, so it is logged once and never pages. Readings feed the facilitatorFunds
// word through the tool-failure monitor (noteRelayerGas), which shares them
// across replicas.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_SIGNERS = 5;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

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
export function createRelayerGasCheck({ urls, network, rpcUrl, fetchImpl = fetch, settings = gasCheckSettings(), timeoutMs = 10_000, now = Date.now, log = console.warn, ownSigners = [] } = {}) {
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
    // Our own relayer is a facilitator of its own: its signer is known, so
    // there is no /supported to read, only its balance.
    const own = (Array.isArray(ownSigners) ? ownSigners : []).filter((o) => ADDRESS.test(String(o?.signer || "")));
    for (const url of [...urls, ...own.map((o) => ({ own: o }))]) {
      if (url && typeof url === "object" && url.own) {
        const { label, signer } = url.own;
        const key = `own:${label}|${signer}`;
        const s = state.get(key) || { failures: 0, last: null };
        let error = gasError, reading = null;
        if (!error) {
          try {
            const balance = await rpc("eth_getBalance", [signer, "latest"]);
            const runway = runwayOf(balance, gasPrice, settings.gasPerSettlement);
            reading = { network, facilitator: String(label || "own relayer"), signer, own: true, balanceEth: Number(balance) / 1e18, runway, status: runway !== null && runway < settings.minRunway ? "low" : "ok", at };
          } catch (e) { error = String(e?.message || e).slice(0, 120); }
        }
        if (reading) { s.failures = 0; s.last = reading; state.set(key, s); readings.push(reading); continue; }
        s.failures++;
        state.set(key, s);
        if (s.failures >= settings.failAfter) readings.push({ network, facilitator: String(label || "own relayer"), signer, own: true, balanceEth: s.last?.balanceEth ?? null, runway: s.last?.runway ?? null, status: "unread", failures: s.failures, error, at });
        else if (s.last) readings.push({ ...s.last, failures: s.failures, error });
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
