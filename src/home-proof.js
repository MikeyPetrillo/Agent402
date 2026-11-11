// The home hero's first-party figures: uptime as outside observers measured
// it, paid calls from buyers outside our own wallets, the chains live, and the
// median tool latency. Each is read from a value another surface already
// keeps (the /status snapshot, the /revenue external count, the rails list,
// the /api/stats performance block) and carries the time it was measured.
//
// The page never waits on a read: a proofCell answers with the last value it
// holds and refreshes in the background when that value is older than its
// ttl. A figure with no value yet is left out of the page, never drawn as a
// dash or a zero.

/** One cached source. `read` may be slow or async; `peek()` never waits on
 *  it. Returns { value, at } or null when nothing has been read yet. */
export function proofCell(read, { ttlMs = 60_000, now = () => Date.now() } = {}) {
  let held = null;
  let pending = null;
  const refresh = () => {
    if (pending) return;
    // The read starts on a later turn, so not even its synchronous part runs
    // inside the request that asked.
    pending = new Promise((r) => setImmediate(r))
      .then(read)
      .then((v) => { if (v && v.value != null) held = { value: v.value, at: Number(v.at) || now() }; })
      .catch(() => { /* keep the last good value */ })
      .finally(() => { pending = null; });
  };
  return {
    peek() {
      if (!held || now() - held.at >= ttlMs) refresh();
      return held;
    },
    // For tests: settles once the refresh in flight (if any) is done.
    settled: () => pending || Promise.resolve(),
  };
}

const iso = (ms) => new Date(ms).toISOString();
const fmtInt = (n) => Math.round(Number(n)).toLocaleString("en-US");
// The /status rule: 100 only from 99.995 up, three places from 99.9.
const fmtPct = (v) => `${v >= 99.995 ? "100" : v.toFixed(v >= 99.9 ? 3 : 2)}%`;

/** The figures to draw, in order, from whatever the sources hold. Each source
 *  is { value, at } or null; a null or unusable one is left out.
 *   uptime:   { pct, observed, windowDays }
 *   external: { count }
 *   chains:   { count } (the x402 chains; the hero line beside it names Tempo)
 *   latency:  { p50Ms } */
export function homeProofFigures({ uptime, external, chains, latency } = {}) {
  const out = [];
  const u = uptime?.value;
  if (u && Number.isFinite(u.pct) && Number(u.observed) > 0) {
    out.push({ key: "uptime", value: fmtPct(u.pct), label: `uptime · ${u.windowDays}d`, href: "/status", asOf: iso(uptime.at) });
  }
  const e = external?.value;
  if (e && Number.isFinite(Number(e.count)) && Number(e.count) > 0) {
    out.push({ key: "paid", value: fmtInt(e.count), label: "external payments", href: "/revenue", asOf: iso(external.at) });
  }
  const c = chains?.value;
  if (c && Number(c.count) > 0) {
    out.push({ key: "chains", value: fmtInt(c.count), label: "chains live", href: "/how-to-pay", asOf: iso(chains.at) });
  }
  const l = latency?.value;
  if (l && Number.isFinite(Number(l.p50Ms)) && Number(l.p50Ms) > 0) {
    out.push({ key: "latency", value: `${fmtInt(l.p50Ms)} ms`, label: "median latency", href: "/api/stats", asOf: iso(latency.at) });
  }
  return out;
}
