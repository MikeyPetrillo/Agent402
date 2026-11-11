// The operator routes an app has registered, read from its router: every
// route whose path is /__operator or under it, as { method, path } rows.
// Served to the operator at /__operator/routes.json, so a check that every
// operator route refuses a caller without the token (scripts/
// test-operator-routes-refuse.js) covers a new route without a list anyone
// has to keep.
//
// A router mounted under a path keeps no readable mount string, so its routes
// cannot be listed from here: `nested` counts the mounted routers that answer
// an /__operator path, and the suite fails on any (register operator routes
// on the app itself).
const PREFIX = "/__operator";
const underPrefix = (p) => typeof p === "string" && (p === PREFIX || p.startsWith(`${PREFIX}/`));

export function operatorRoutesOf(app) {
  const stack = app?.router?.stack || app?._router?.stack || [];
  const routes = [];
  let nested = 0;
  let unreadable = 0;
  for (const layer of stack) {
    const route = layer?.route;
    if (!route) {
      if (Array.isArray(layer?.handle?.stack)) {
        let hit = false;
        try { hit = layer.match(`${PREFIX}/routes-probe`) === true; } catch { hit = false; }
        if (hit) nested++;
      }
      continue;
    }
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    for (const path of paths) {
      // A pattern that is not a string (a RegExp path) cannot be requested by name.
      if (typeof path !== "string") { if (path instanceof RegExp && path.source.includes("__operator")) unreadable++; continue; }
      if (!underPrefix(path)) continue;
      const methods = Object.keys(route.methods || {}).filter((m) => route.methods[m]);
      for (const m of methods) routes.push({ method: m === "_all" ? "ALL" : m.toUpperCase(), path });
    }
  }
  routes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
  return { routes, nested, unreadable };
}
