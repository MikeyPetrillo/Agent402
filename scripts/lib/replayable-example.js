// The example input a 402 carries, made replayable.
//
// A route whose 402 is over its byte budget gives up long strings in its input
// example first (src/payments.js fitChallenge): each becomes a placeholder
// naming its length and /openapi.json. A sweep that posts the 402's example as
// is sends that placeholder, and the tool answers 400 to its own example
// (html-frames on the Algorand sweep: "does not define window.renderAt(t)").
// Every script that buys from the 402's example reads it through here, so a
// shortened example is replaced by the full one /openapi.json publishes.
import { isShortenedExampleString } from "../../src/payments.js";
import { requestExampleOf } from "../../src/openapi-request.js";

/** True when any string inside `v` is a shortened-example placeholder. */
export function hasShortenedExample(v) {
  if (isShortenedExampleString(v)) return true;
  if (Array.isArray(v)) return v.some(hasShortenedExample);
  if (v && typeof v === "object") return Object.values(v).some(hasShortenedExample);
  return false;
}

/** The operation /openapi.json publishes for `method path`, or null. */
export function openapiOperation(openapi, method, path) {
  return openapi?.paths?.[path]?.[String(method || "").toLowerCase()] || null;
}

/**
 * `input` (the 402's `extensions.bazaar.info.input`) with a shortened body
 * replaced by the full example `op` (its /openapi.json operation) publishes.
 * Returns `input` itself when nothing was shortened, and null when it was and
 * no full example is available (the caller reports that instead of sending a
 * placeholder).
 */
export function replayableInput(input, op) {
  if (!input || typeof input !== "object") return input;
  if (!hasShortenedExample(input.body) && !hasShortenedExample(input.queryParams)) return input;
  if (hasShortenedExample(input.queryParams)) return null;
  const full = requestExampleOf(op)?.example;
  if (!full || typeof full !== "object" || hasShortenedExample(full)) return null;
  return { ...input, body: full };
}

/** A reader that fetches `${target}/openapi.json` once, on first need. */
export function openapiReader(target, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  let doc = null;
  return async () => {
    if (!doc) {
      doc = fetchImpl(`${target}/openapi.json`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    const out = await doc;
    if (!out) doc = null; // a failed read is retried next time
    return out;
  };
}

/** `input` made replayable for `method path` against `target`'s /openapi.json. */
export async function resolveReplayableInput(input, { method, path, readOpenapi }) {
  if (!hasShortenedExample(input?.body) && !hasShortenedExample(input?.queryParams)) return input;
  return replayableInput(input, openapiOperation(await readOpenapi(), method, path));
}
