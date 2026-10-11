// Boot-time database init with retries. Measured 2026-08-25: the app fires
// initLeadsDb/initAnalyticsDb at module top level, and pg's connection timer
// (connectionTimeoutMillis) expires INSIDE the ~10 s post-listen event-loop
// stall (@x402/express's per-route Ajv compile), so "listening" and both
// "init failed: Connection terminated due to connection timeout" lines share
// one millisecond in the log while a TCP probe a second later connects in
// 10 ms. Every boot lost its databases to its own boot; one deploy in a row
// happened to win the race. So: the first attempt is allowed to fail, and
// the retries land after the stall. `delaysMs` is the schedule after each
// failure; success stops it; exhaustion leaves the module's own on-demand
// path (an on-demand ensureSchema / recordToolCall backoff) as the last resort.
export function initWithRetry(label, init, { delaysMs = [20_000, 60_000, 300_000], onResult, log = console.log, schedule = setTimeout } = {}) {
  let attempt = 0;
  const run = async () => {
    attempt++;
    let r;
    try { r = await init(); } catch (e) { r = { ok: false, reason: e?.message || "threw" }; }
    if (onResult) { try { onResult(r, attempt); } catch { /* observer only */ } }
    if (r?.ok) {
      log(`[${label}] ready${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      return r;
    }
    if (r?.reason === "no-db") { log(`[${label}] disabled (no-db)`); return r; }
    const delay = delaysMs[attempt - 1];
    if (delay == null) { log(`[${label}] disabled (${r?.reason || "unknown"}) after ${attempt} attempts; on-demand retry only`); return r; }
    log(`[${label}] init failed (${r?.reason || "unknown"}); retrying in ${Math.round(delay / 1000)}s`);
    const t = schedule(run, delay);
    if (t && typeof t.unref === "function") t.unref();
    return r;
  };
  return run();
}
