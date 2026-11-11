// The home hero's first-party figures: uptime as outside observers measured
// it, paid calls from buyers outside our own wallets, the chains live, and the
// median tool latency. Each is read from a value another surface already
// keeps (the /status snapshot, the /revenue external count, the offered rails on /api/rails,
// the /api/stats performance block) and carries the time it was measured.
//
// The page never waits on a read: a proofCell answers with the last value it
// holds and refreshes in the background when that value is older than its
// ttl. A figure with no value yet is left out of the page, never drawn as a
// dash or a zero.

/** One cached source. `read` may be slow or async; `peek()` never waits on
 *  it. Returns { value, at } or null when nothing usable is held.
 *
 *  Each read is bounded by `timeoutMs`: a read that has not answered by then
 *  is abandoned (its late answer is ignored) and the next peek starts a new
 *  one, so a hung source never pins the figure. A held value is served only
 *  while its last successful read is younger than `maxAgeMs`; past that the
 *  figure is left out (null), never drawn stale and never as a zero. */
export function proofCell(read, { ttlMs = 60_000, timeoutMs = 10_000, maxAgeMs = 5 * Math.max(ttlMs, 60_000), now = () => Date.now() } = {}) {
  let held = null; // { value, at, readAt }
  let pending = null;
  let gen = 0;
  const refresh = () => {
    if (pending) return;
    const mine = ++gen;
    let timer = null;
    // The read starts on a later turn, so not even its synchronous part runs
    // inside the request that asked.
    const attempt = new Promise((r) => setImmediate(r))
      .then(read)
      .then((v) => { if (mine === gen && v && v.value != null) held = { value: v.value, at: Number(v.at) || now(), readAt: now() }; })
      .catch(() => { /* keep the last good value */ });
    const deadline = new Promise((r) => { timer = setTimeout(r, Math.max(1, timeoutMs)); });
    pending = Promise.race([attempt, deadline]).finally(() => {
      clearTimeout(timer);
      if (mine === gen) { gen++; pending = null; } // a late answer from this read is ignored
    });
  };
  return {
    peek() {
      if (!held || now() - held.readAt >= ttlMs) refresh();
      return held && now() - held.readAt < maxAgeMs ? { value: held.value, at: held.at } : null;
    },
    // For tests: settles once the refresh in flight (if any) is done or abandoned.
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
