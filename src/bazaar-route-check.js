// The vendor's bazaar route check, moved off the boot path.
//
// @x402/express builds its payment middleware and then, after one dynamic
// import, runs validateBazaarRouteExtensions over every route: a new Ajv
// instance and a schema compile per route, in one synchronous loop. With the
// whole catalog that loop held the event loop for seconds while the state
// stores' first reads were in flight, so their replies sat unread and their
// read timers fired first. The check only ever logs a warning; it decides
// nothing about how a route is served.
//
// So the middleware is built while the routes' bazaar declarations are out of
// sight of the vendor's "is bazaar needed" test (the declarations are put
// back on the same objects before the call returns, so every 402 still
// carries them), and the same vendor check runs here instead: one route at a
// time, a short slice per event-loop turn, after the server is up.
import { validateBazaarRouteExtensions } from "@x402/extensions/bazaar";

/**
 * Run `build()` with each route config's `bazaar` extension hidden, then put
 * every one back. Returns what `build()` returns.
 */
export function withBazaarHidden(routes, build) {
  const held = [];
  for (const cfg of Object.values(routes || {})) {
    const ext = cfg && typeof cfg === "object" ? cfg.extensions : null;
    if (!ext || typeof ext !== "object" || !("bazaar" in ext)) continue;
    const rest = { ...ext };
    delete rest.bazaar;
    held.push([cfg, ext]);
    cfg.extensions = rest;
  }
  try { return build(); }
  finally { for (const [cfg, ext] of held) cfg.extensions = ext; }
}

/**
 * The vendor's check over `routes`, `sliceMs` of work per turn. Resolves
 * { routes, ms, longestTurnMs }. `validate` is injectable for tests.
 */
export async function checkBazaarRoutesInSlices(routes, { sliceMs = 15, validate = validateBazaarRouteExtensions, yieldTurn = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
  const entries = Object.entries(routes || {}).filter(([, cfg]) => cfg?.extensions && "bazaar" in cfg.extensions);
  const t0 = performance.now();
  let longest = 0, i = 0;
  while (i < entries.length) {
    const turn0 = performance.now();
    do {
      const [pattern, cfg] = entries[i++];
      try { validate({ [pattern]: cfg }); } catch { /* the check only warns */ }
    } while (i < entries.length && performance.now() - turn0 < sliceMs);
    longest = Math.max(longest, performance.now() - turn0);
    if (i < entries.length) await yieldTurn();
  }
  return { routes: entries.length, ms: Math.round(performance.now() - t0), longestTurnMs: Math.round(longest) };
}

/** Schedule the sliced check `delayMs` after now (unref'd); logs one summary line. */
export function scheduleBazaarRouteCheck(routes, { delayMs = Number(process.env.BAZAAR_ROUTE_CHECK_DELAY_MS ?? 60_000), log = console.log } = {}) {
  if (String(process.env.BAZAAR_ROUTE_CHECK || "").toLowerCase() === "off") return null;
  const t = setTimeout(() => {
    checkBazaarRoutesInSlices(routes)
      .then((r) => log(`[payments] bazaar route check: ${r.routes} route(s) in ${r.ms}ms (longest turn ${r.longestTurnMs}ms)`))
      .catch(() => {});
  }, Math.max(0, delayMs));
  t.unref?.();
  return t;
}
