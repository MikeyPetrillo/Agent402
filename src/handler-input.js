import { applyInputAliases } from "./input-aliases.js";
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
  const input = { ...(req.query ?? {}), ...(req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}) };
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
  const filled = applyInputAliases(input, def);
  if (!filled.length) return;
  try {
    const prev = req.__aliasedParams || [];
    Object.defineProperty(req, "__aliasedParams", { value: [...new Set([...prev, ...filled])], enumerable: false, writable: true, configurable: true });
  } catch { /* frozen req in a test */ }
}
