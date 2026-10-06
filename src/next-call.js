// The flagship first calls name the call that usually follows them (web.search
// -> web.answer, decide.plan -> decide.execute), so an agent that just
// succeeded sees the next step and its price without a second lookup.
//
// Additive and informational only: a `next` object (slug, route, price) on the
// JSON answer, never an instruction, never on a streamed or binary answer, and
// never replacing a `next` the handler already set. Prices come from the
// catalog def, so a repricing moves this too.

/** The `next` object for a catalog def. */
export function nextCallFor(def) {
  return {
    slug: def.slug,
    route: def.route,
    price: def.price,
    ...(typeof def.quote === "function" ? { priced: "quoted per request; the listed price is the floor" } : {}),
  };
}

/** Wrap a tool handler so its JSON answers carry `next`. */
export function withNextCall(handler, next) {
  if (typeof handler !== "function" || handler.__nextCall) return handler;
  const wrapped = async (...args) => {
    const out = await handler(...args);
    if (!out || typeof out !== "object" || Array.isArray(out) || out.__sse || out.__binary || "next" in out) return out;
    // Copy with descriptors: a handler may attach a non-enumerable sentinel
    // (the meter's) that a spread would silently drop.
    const copy = Object.create(Object.getPrototypeOf(out), Object.getOwnPropertyDescriptors(out));
    copy.next = next;
    return copy;
  };
  wrapped.__nextCall = true;
  return wrapped;
}
