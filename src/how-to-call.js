// A ready-to-run call for a catalog tool, built from the tool's own published
// example: the method, the full URL and the JSON body (or the query string),
// carried by every input-validation 400 so a caller that sent nothing, or the
// wrong shape, can retry with a request that works as written.
//
// WHICH METHODS ARE REAL. Each tool is registered on one verb. The method
// alias in src/server.js serves the other verb at the same path when the
// catalog has no route of that verb there: a POST to a GET-only tool runs it
// with the JSON body as input, and a GET to a POST-only tool runs it with the
// query string as input (src/handler-input.js merges query and body). Express
// parses a query string into strings only, so a GET form is offered only when
// every example value survives as a query parameter: a string for a POST-only
// tool (its handler validates types it was written to receive as JSON), and a
// string, number or boolean for a GET tool (its handler reads the query).
// Anything nested or an array is a POST body only.
//
// The origin is the server's BASE_URL, set once at boot (configureHowToCall).
let origin = "";
let catalogRef = null;

/** server.js calls this once its catalog and public origin are known. */
export function configureHowToCall({ baseUrl, catalog } = {}) {
  origin = String(baseUrl || "").replace(/\/+$/, "");
  // Held by reference and read per call, so routes added after boot count.
  catalogRef = catalog && typeof catalog === "object" ? catalog : null;
}

// Long example text makes an unwieldy URL; past this the GET form is left out.
export const MAX_GET_URL_CHARS = 2000;

function exampleOf(def) {
  const d = def?.discovery || {};
  const ex = d.input ?? d.example;
  return ex && typeof ex === "object" && !Array.isArray(ex) ? ex : null;
}

function queryStringOf(example, method) {
  const scalarOk = method === "GET"
    ? (v) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))
    : (v) => typeof v === "string";
  const entries = Object.entries(example);
  if (!entries.every(([, v]) => scalarOk(v))) return null;
  return new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

/** The call to show for `def`, or null when it has no route. Shape:
 *  { method, url, headers?, body? | form?, alternate? } where `alternate` is the same
 *  call under the other method when the server really accepts it. */
export function howToCallFor(def) {
  const route = typeof def?.route === "string" ? def.route : "";
  const sp = route.indexOf(" ");
  if (sp < 0) return null;
  const method = route.slice(0, sp).toUpperCase();
  const path = route.slice(sp + 1);
  if ((method !== "GET" && method !== "POST") || !path.startsWith("/")) return null;
  const url = `${origin}${path}`;
  const other = method === "GET" ? "POST" : "GET";
  // The alias serves the other verb only where the catalog has no route of it.
  const otherServed = catalogRef ? !Object.prototype.hasOwnProperty.call(catalogRef, `${other} ${path}`) : false;
  const example = exampleOf(def);
  // A multipart upload (the transcription wires) is a file part, never a
  // JSON body or a query string.
  if (method === "POST" && def?.discovery?.bodyType === "form-data") {
    return { method: "POST", url, headers: { "Content-Type": "multipart/form-data" }, form: example || {} };
  }

  const postForm = () => ({
    method: "POST",
    url,
    headers: { "Content-Type": "application/json" },
    body: example || {},
  });
  const getForm = () => {
    if (!example || !Object.keys(example).length) return { method: "GET", url };
    // Typed by the tool's own method: a GET tool reads strings from its query.
    const qs = queryStringOf(example, method);
    if (qs === null) return null;
    const full = qs ? `${url}?${qs}` : url;
    return full.length <= MAX_GET_URL_CHARS ? { method: "GET", url: full } : null;
  };

  if (method === "POST") {
    const primary = postForm();
    const alt = otherServed ? getForm() : null;
    return alt ? { ...primary, alternate: alt } : primary;
  }
  // A GET tool: its own query form when the example fits one, else the POST
  // body form the alias serves.
  const own = getForm();
  const alt = otherServed ? postForm() : null;
  if (own) return alt ? { ...own, alternate: alt } : own;
  return alt;
}

/** `{ howToCall }` for spreading into a 400 envelope, or `{}` when none. */
export function howToCallField(def) {
  const call = howToCallFor(def);
  return call ? { howToCall: call } : {};
}

// A 402 body's own fields share one small budget (scripts/
// test-bazaar-contracts.js); a call whose example is large (an image as base64,
// a long schema) goes out as its method and URL only there, since the 402's
// Bazaar extension carries the same example as the request body.
export const MAX_402_CALL_BYTES = 1024;

/** `{ howToCall }` for a 402 body: the full call when it fits
 *  MAX_402_CALL_BYTES, else `{ method, url }`; `{}` when none. */
export function howToCall402Field(def) {
  const call = howToCallFor(def);
  if (!call) return {};
  let bytes = Infinity;
  try { bytes = Buffer.byteLength(JSON.stringify(call), "utf8"); } catch { /* sized as too large */ }
  return { howToCall: bytes <= MAX_402_CALL_BYTES ? call : { method: call.method, url: call.url } };
}
