// A store's first load against the state database, retried until it lands.
//
// Each store loads once at boot (its tables, the one-time import of its file,
// the pull into its mirror). A load that failed once (a database blip during
// the boot, two containers creating the same tables at the same moment) must
// not leave the store dead until the next deploy: the failed attempt is
// forgotten, so the next caller tries again, and a background timer retries
// with backoff, so a store nobody calls recovers too.
//
//   const load = retryingLoad("[stats]", async () => { ... });
//   await load.ready();          // the load's value, or the attempt's error
//   load.isLoaded();             // true once an attempt has succeeded
//   trackStoreReady(load.eventually);  // resolves on the first success
//
// STATE_STORE_RETRY_MS (first delay, default 1 s) doubles per failure up to
// STATE_STORE_RETRY_MAX_MS (default 60 s).
const envMs = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };

const unloaded = new Set();
/** Labels of the stores whose first load has not landed yet (for a status word). */
export function unloadedStores() { return [...unloaded]; }

export function retryingLoad(label, load, { log = console.warn, onLoaded = null } = {}) {
  const base = envMs("STATE_STORE_RETRY_MS", 1000);
  const max = envMs("STATE_STORE_RETRY_MAX_MS", 60_000);
  let current = null;
  let loaded = false;
  let timer = null;
  let delay = base;
  let lastWhy = "";
  let failures = 0;
  let resolveEventually;
  const eventually = new Promise((r) => { resolveEventually = r; });
  unloaded.add(label);
  const schedule = () => {
    if (timer || loaded) return;
    timer = setTimeout(() => { timer = null; ready().catch(() => {}); }, delay);
    timer.unref?.();
    delay = Math.min(max, delay * 2);
  };
  function ready() {
    if (!current) {
      current = Promise.resolve().then(load).then((v) => {
        loaded = true;
        unloaded.delete(label);
        if (timer) { clearTimeout(timer); timer = null; }
        if (failures) log(`${label} first load landed after ${failures} failed attempt(s)`);
        resolveEventually(true);
        try { onLoaded?.(v); } catch { /* the hook never fails the load */ }
        return v;
      }, (e) => {
        current = null; // the next caller (or the timer) tries again
        failures++;
        const why = String(e?.message || e).slice(0, 160);
        if (why !== lastWhy) log(`${label} first load failed (${why}); retrying`);
        lastWhy = why;
        schedule();
        throw e;
      });
    }
    return current;
  }
  return { ready, isLoaded: () => loaded, eventually, failures: () => failures };
}
