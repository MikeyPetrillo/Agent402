// exampleParams must validate against the tool's input schema before a plan
// ships. The row schemas here are a small subset (object, top-level typed
// properties, required, enum), so the validator is too: it checks exactly
// what the plan promises and nothing it cannot.

const TYPE_OK = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
};
const STEP_REF = /^\{\{step \d+\}\}$/;

export function validateParams(schema, params) {
  const errors = [];
  if (!params || typeof params !== "object" || Array.isArray(params)) return { ok: false, errors: ["params must be an object"] };
  const props = schema?.properties || {};
  for (const k of Object.keys(params)) {
    if (!Object.hasOwn(props, k)) errors.push(`unknown property ${k}`);
  }
  for (const k of schema?.required || []) {
    if (!Object.hasOwn(params, k) || params[k] === "" || params[k] === null || params[k] === undefined) errors.push(`missing required ${k}`);
  }
  for (const [k, v] of Object.entries(params)) {
    const p = props[k];
    if (!p) continue;
    if (typeof v === "string" && STEP_REF.test(v)) continue; // filled from an earlier step at run time
    if (typeof p.type === "string" && TYPE_OK[p.type] && !TYPE_OK[p.type](v)) errors.push(`${k} must be ${p.type}`);
    if (Array.isArray(p.enum) && !p.enum.includes(v)) errors.push(`${k} must be one of ${p.enum.slice(0, 8).join(", ")}`);
  }
  return { ok: errors.length === 0, errors };
}

/** A step's params are written for its primary tool. A backup tool that names
 *  the same single input differently (`query` where the primary took `name`)
 *  gets the value under its own name: only when exactly one given key is
 *  unknown to it and exactly one of its required keys is missing, the value is
 *  a scalar, and its declared type (if any) accepts it. Anything else is left
 *  alone and the validator decides. Never drops a key: a backup that cannot
 *  take a given input (a chain it does not serve, say) is not called with the
 *  input quietly removed. */
export function fitParamsToSchema(schema, params) {
  const props = schema?.properties;
  if (!props || !params || typeof params !== "object" || Array.isArray(params)) return params;
  const unknown = Object.keys(params).filter((k) => !Object.hasOwn(props, k));
  const missing = (schema.required || []).filter((k) => !Object.hasOwn(params, k));
  if (unknown.length !== 1 || missing.length !== 1) return params;
  const [from] = unknown, [to] = missing, v = params[from];
  if (!(typeof v === "string" || typeof v === "number" || typeof v === "boolean")) return params;
  const t = props[to]?.type;
  if (typeof t === "string" && TYPE_OK[t] && !TYPE_OK[t](v) && !(typeof v === "string" && STEP_REF.test(v))) return params;
  const out = {};
  for (const [k, val] of Object.entries(params)) out[k === from ? to : k] = val;
  return out;
}

/** Only declared properties, never prototype keys. */
export function pruneParams(schema, params) {
  const props = schema?.properties || {};
  const out = {};
  if (!params || typeof params !== "object") return out;
  for (const [k, v] of Object.entries(params)) if (Object.hasOwn(props, k) && k !== "__proto__") out[k] = v;
  return out;
}

/** A fill-in skeleton: every required field named, typed placeholders. */
export function skeletonParams(schema) {
  const out = {};
  for (const k of schema?.required || []) {
    const p = schema.properties?.[k] || {};
    if (Array.isArray(p.enum) && p.enum.length) out[k] = p.enum[0];
    else if (p.type === "number" || p.type === "integer") out[k] = 0;
    else if (p.type === "boolean") out[k] = false;
    else if (p.type === "array") out[k] = [];
    else if (p.type === "object") out[k] = {};
    else out[k] = `<${k}>`;
  }
  return out;
}
