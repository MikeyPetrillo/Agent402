// Resolves "{{step N}}" in a plan step's params from step N's output, so a
// chained plan (resolve an ENS name, then read that address's balances) runs
// end to end. A value is taken only when it can be named without guessing:
//   - the output itself is a scalar;
//   - the output carries a field with the parameter's own name;
//   - the parameter asks for an address and the output carries exactly one
//     distinct address-shaped value.
// Anything else is "missing" and the step is skipped with the reason, never
// filled with a value that merely looks plausible. Only scalars travel, and
// only up to MAX_LEN characters: an earlier seller's body is untrusted, and
// the receiving tool's schema is still checked by the caller.

const REF = /^\{\{step (\d+)\}\}$/;
const MAX_LEN = 2000;
const MAX_NODES = 2000;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADDRESS_PARAM = /(^|_|[a-z])(address|wallet|owner|account|holder|recipient)$/i;

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
const isScalar = (v) => (typeof v === "string" && v.length > 0 && v.length <= MAX_LEN) || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean";
const isAddress = (v) => typeof v === "string" && (EVM_ADDRESS.test(v) || SOLANA_ADDRESS.test(v));

// Breadth-first over objects and arrays, bounded, so the shallowest match wins.
function* leaves(root) {
  const queue = [[null, root]];
  let seen = 0;
  while (queue.length && seen < MAX_NODES) {
    const [key, v] = queue.shift();
    seen++;
    if (v && typeof v === "object") {
      // An array's elements keep the key the array sat under.
      if (Array.isArray(v)) for (const child of v) queue.push([key, child]);
      else for (const [k, child] of Object.entries(v)) queue.push([k, child]);
    } else yield [key, v];
  }
}

export function valueForParam(name, output) {
  if (output == null) return { ok: false, why: "produced no output" };
  if (isScalar(output)) return { ok: true, value: output };
  if (typeof output !== "object") return { ok: false, why: "produced no usable value" };
  const want = norm(name);
  for (const [k, v] of leaves(output)) if (k != null && norm(k) === want && isScalar(v)) return { ok: true, value: v };
  if (ADDRESS_PARAM.test(name) || want === "address") {
    const found = new Set();
    for (const [, v] of leaves(output)) if (isAddress(v)) found.add(v);
    if (found.size === 1) return { ok: true, value: [...found][0] };
    if (found.size > 1) return { ok: false, why: `carries ${found.size} different addresses, so which one "${name}" means is not clear` };
  }
  return { ok: false, why: `has no value for "${name}"` };
}

// params: the step's params; outputs: { [step]: result } of steps that ran ok.
// Returns { ok: true, params } with every reference replaced, or
// { ok: false, reason } naming the first one that could not be.
export function resolveStepRefs(params, outputs) {
  const out = { ...params };
  for (const [name, v] of Object.entries(params || {})) {
    const m = typeof v === "string" ? REF.exec(v) : null;
    if (!m) continue;
    const n = m[1];
    if (!Object.hasOwn(outputs, n)) return { ok: false, reason: `needs the output of step ${n}, which did not run: pass params for this step` };
    const r = valueForParam(name, outputs[n]);
    if (!r.ok) return { ok: false, reason: `step ${n}'s output ${r.why}: pass params for this step` };
    out[name] = r.value;
  }
  return { ok: true, params: out };
}

export const STEP_REF = REF;
