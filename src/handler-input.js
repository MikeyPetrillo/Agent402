import { applyInputAliases, applyShapeAliases, ignoredShapeParams, shapeRefusal } from "./input-aliases.js";
// The ONE construction of the object a tool handler is served, shared by the
// dispatcher and by every place that PRICES a request from its body.
//
// Why one place: the metered gateway quotes each 402 from the request, and the
// 2026-08-26 security review found the quote read `req.body` while the
// dispatcher served `{...req.query, ...req.body}` with `params`/`input`/`args`
// envelopes unwrapped. A body the quoter could not price ({input:{model,...}})
// was quoted at the $0.001 floor and then served in full once unwrapped - an
// Opus-sized call for a tenth of a cent. Pricing and serving now read the same
// object, memoized on the request (one construction, every rail and gate).
export function handlerInputOf(req, def) {
  if (!req || typeof req !== "object") return {};
  // A memo HIT must still alias: the first call may have been made without a
  // tool def (a gate pricing the request before dispatch), and returning early
  // would hand the handler an un-aliased input while the test that pins "one
  // object for pricing and serving" still passed. The fill only adds a missing
  // key, so running it on every call is idempotent.
  if (req.__handlerInput) { aliasInto(req, req.__handlerInput, def); return req.__handlerInput; }
  // A Buffer is an object and is not an Array, so the plain shape test spread
  // RAW BODIES one property per BYTE. Measured 2026-09-19: a 3 MB multipart
  // upload became 3,145,728 keys in 500 ms of blocked event loop, and this
  // runs on every paid request through the dispatcher and again at the route
  // binder. It arrived with the transcription wire earlier today, the first
  // route to mount express.raw. A raw body is the handler's business, never a
  // bag of named parameters.
  const bodyIsParams = req.body && typeof req.body === "object" && !Array.isArray(req.body) && !Buffer.isBuffer(req.body);
  const input = { ...(req.query ?? {}), ...(bodyIsParams ? req.body : {}) };
  // Accept MCP-style envelopes posted directly to the HTTP route. Agents
  // frequently mirror the shape they use over /mcp ({slug, params:{...}})
  // into POST /api/<slug> bodies, or wrap fields in {input:{...}} /
  // {args:{...}}. Top-level fields win on conflict - explicit beats nested.
  for (const wrap of ["params", "input", "args"]) {
    const inner = input[wrap];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      for (const [k, v] of Object.entries(inner)) {
        if (input[k] === undefined) input[k] = v;
      }
    }
  }
  try { Object.defineProperty(req, "__handlerInput", { value: input, enumerable: false, writable: true }); } catch { /* frozen req in a test */ }
  aliasInto(req, input, def);
  return input;
}

// Fill a missing REQUIRED parameter from an accepted synonym (src/input-aliases.js).
// Applied to the memoized object, so pricing and serving still read ONE input
// however many times this is called: the fill only ever ADDS a key the caller
// omitted, never rewrites one, which makes a later call with the tool def
// idempotent against an earlier one made without it.
function aliasInto(req, input, def) {
  if (!def) return;
  const filled = [...applyInputAliases(input, def), ...applyShapeAliases(input, def)];
  // Recognised request-shape fields this tool does not apply, named back to the
  // caller in the answer's `ignoredParams` (never silently dropped). Recomputed
  // on every call, so it always describes the object the handler is served.
  const ignored = ignoredShapeParams(input, def);
  try {
    if (ignored.length || req.__ignoredParams) Object.defineProperty(req, "__ignoredParams", { value: ignored, enumerable: false, writable: true, configurable: true });
  } catch { /* frozen req in a test */ }
  if (!filled.length) return;
  try {
    const prev = req.__aliasedParams || [];
    Object.defineProperty(req, "__aliasedParams", { value: [...new Set([...prev, ...filled])], enumerable: false, writable: true, configurable: true });
  } catch { /* frozen req in a test */ }
}

/** Cheap input check a paid gate can run BEFORE its payment round trip.
 *  Returns null when the input may proceed, else `{status: 400, body}` with the
 *  same self-correcting envelope the dispatcher's 400 carries (error, tool,
 *  expected, required, example). Two checks only, both of which the handler
 *  makes anyway:
 *    - every key the tool's published inputSchema marks `required` is present
 *      (after the accepted input aliases are filled; null/undefined = absent);
 *    - the tool's own pure `validateInput(input)`, when it declares one, does
 *      not throw a 4xx.
 *  Types, ranges and upstream facts stay the handler's call. A throw that is
 *  not a 4xx is ignored here and left to the handler. */
export function preValidateInput(def, req) {
  if (!def || !req) return null;
  const input = handlerInputOf(req, def);
  const schema = def.discovery?.inputSchema || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((k) => input[k] === undefined || input[k] === null);
  let message = shapeRefusal(input, def)
    || (missing.length ? `Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}` : null);
  if (!message && typeof def.validateInput === "function") {
    try { def.validateInput(input); }
    catch (e) { const s = Number(e?.statusCode); if (s >= 400 && s < 500) message = String(e?.message || "Invalid input"); }
  }
  if (!message) return null;
  return {
    status: 400,
    body: { error: message, tool: def.slug, expected: schema.properties || {}, required, example: def.discovery?.input || {} },
  };
}

/** Merge `ignoredParams` into a JSON object answer when the request carried
 *  recognised request-shape fields the tool did not apply. Returns a NEW object
 *  (the handler's result may be cached and served to another caller) or the
 *  result unchanged. Arrays, binaries, streams and non-objects pass through. */
export function withIgnoredParams(result, req) {
  const ignored = req?.__ignoredParams;
  if (!Array.isArray(ignored) || !ignored.length) return result;
  if (!result || typeof result !== "object" || Array.isArray(result) || Buffer.isBuffer(result)) return result;
  if (result.__binary || typeof result.__sse === "function") return result;
  return { ...result, ignoredParams: ignored };
}
