// Which string inputs a tool's handler caps by length, measured by calling
// the handler: no reading of error text for numbers, no list kept by hand.
//
// A field is CAPPED at N when the handler answers a very long run of one
// letter in it with a 4xx, answers some shorter run differently, and N is the
// longest run it does not answer that way (so N + 1 letters are refused as
// the very long value is). Two readings are left out:
//   - a limit per ENTRY of a list (a comma, space or line separated value far
//     longer than N is not refused that way): a list of short entries may be
//     longer than one entry may be, so the field declares no maxLength;
//   - a limit that does not hold for a real value: where the published
//     example gives the field a string, that value padded with letters must
//     run out at the same N (a file name's limit counts its extension; an
//     image's bytes are not letters), or nothing is established.
//
// Everything runs offline: fetch and the address guard's lookups fail at
// once, so a handler that passes its own checks ends on a failed read. A
// handler that answers the long value with a 5xx (its key is not set here, or
// it reads upstream before it checks its input) gives no verdict.
import { readdirSync } from "node:fs";
import { stubGuardResolver } from "./guard-resolver-stub.js";

export const LONG = 100_000;
const SHORT_PROBES = [1, 3, 8, 20, 44, 64, 300, 2_000, 20_000];
const CALL_MS = 4_000;

/** Every tool definition the kits export (slug -> def, with its file). */
export async function kitTools() {
  const dir = new URL("../../src/tools/", import.meta.url);
  const tools = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js") && !/-worker\.js$/.test(f)).sort()) {
    const mod = await import(new URL(file, dir));
    for (const v of Object.values(mod)) if (Array.isArray(v)) for (const t of v) if (t && typeof t === "object" && typeof t.slug === "string" && typeof t.route === "string" && typeof t.handler === "function" && !tools.has(t.slug)) tools.set(t.slug, Object.assign(Object.create(t), { file }));
  }
  return tools;
}

/** Put the process offline. Returns a function that undoes it. */
export function goOffline() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("offline"), { code: "ENOTFOUND" }) }); };
  const undoDns = stubGuardResolver(() => Promise.reject(Object.assign(new Error("offline"), { code: "ENOTFOUND" })));
  return () => { globalThis.fetch = realFetch; undoDns(); };
}

/** The top-level input fields of a tool that take a string. */
export function stringFields(tool) {
  return Object.entries(tool.discovery?.inputSchema?.properties || {}).filter(([, p]) => p && [].concat(p.type || []).includes("string")).map(([name, p]) => ({ name, schema: p }));
}

/** How the handler answers `value` in `field`, the rest of the input being
 *  the published example (or nothing, with `alone`): "ok", "timeout", or the
 *  status with its message (digits folded, so a message that quotes the
 *  length sent reads the same). */
export async function outcomeOf(tool, field, value, alone = false) {
  const input = { ...(alone ? {} : structuredClone(tool.discovery?.input || tool.discovery?.example || {})), [field]: value };
  let timer;
  const late = new Promise((r) => { timer = setTimeout(r, CALL_MS, "timeout"); });
  try {
    return await Promise.race([
      Promise.resolve().then(() => tool.handler(input, { headers: {}, query: {}, body: input })).then(() => "ok", (e) => `${Number.isInteger(e?.statusCode) ? e.statusCode : "error"}:${String(e?.message || "").replace(/\d[\d,_.]*/g, "#").slice(0, 200)}`),
      late,
    ]);
  } catch (e) { return `error:${String(e?.message || "").slice(0, 80)}`; } finally { clearTimeout(timer); }
}
const is4xx = (o) => /^4\d\d:/.test(o);
const letters = (n) => "a".repeat(n);
/** `seed` padded with letters to `n` characters (the seed itself when it is that long). */
const padded = (seed, n) => (seed.length >= n ? seed : seed + "a".repeat(n - seed.length));
/** The longest padded length of `seed` not answered as `long` is, searching (lo, hi). */
async function edge(tool, field, seed, long, lo, hi, alone) {
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await outcomeOf(tool, field, padded(seed, mid), alone)) === long) hi = mid; else lo = mid;
  }
  return lo;
}
/** A value LONG characters long made of short entries. */
const listOf = (sep) => Array.from({ length: Math.ceil(LONG / 4) }, () => "aaa").join(sep);

/**
 * { cap } when the handler caps `field` as a whole at `cap` characters,
 * { cap: null, why } when it does not, { cap: undefined, why } when the
 * handler gives no verdict offline. Measured beside the published example's
 * other fields, and, when that establishes nothing, with the field sent alone
 * (an example that locates a place by coordinates never reads its name).
 */
export async function measuredCap(tool, field) {
  const beside = await measure(tool, field, false);
  if (Number.isInteger(beside.cap)) return beside;
  const alone = await measure(tool, field, true);
  return Number.isInteger(alone.cap) ? { ...alone, alone: true } : beside;
}
async function measure(tool, field, alone) {
  const long = await outcomeOf(tool, field, letters(LONG), alone);
  if (!is4xx(long)) return { cap: /^(5\d\d|error|timeout)/.test(long) ? undefined : null, why: `a ${LONG}-letter value answers ${long.slice(0, 60)}` };
  // Some shorter value must be answered differently, or the refusal is about
  // the value's form, not its length.
  let passes = 0;
  for (const n of SHORT_PROBES) if ((await outcomeOf(tool, field, letters(n), alone)) !== long) { passes = n; break; }
  if (!passes) return { cap: null, why: "every length is answered alike: the form is refused, not the length" };
  // A list of short entries as long as the long value: refused the same way
  // only when the cap is on the whole value.
  for (const sep of [",", " ", "\n"]) if ((await outcomeOf(tool, field, listOf(sep), alone)) !== long) return { cap: null, why: "the limit is per entry of a list, not on the whole value" };
  const cap = await edge(tool, field, "", long, passes, LONG, alone);
  // The published example's own value, padded, must run out at the same length.
  const seed = (tool.discovery?.input || tool.discovery?.example || {})[field];
  if (typeof seed === "string" && seed.length > 0 && seed.length <= cap) {
    const seededLong = await outcomeOf(tool, field, padded(seed, LONG), alone);
    if (!is4xx(seededLong)) return { cap: null, why: "the example's value padded to the same length is not refused" };
    if ((await outcomeOf(tool, field, seed, alone)) === seededLong) return { cap: null, why: "the example's own value is answered as its padded form is" };
    const seeded = await edge(tool, field, seed, seededLong, seed.length, LONG, alone);
    if (seeded !== cap) return { cap: null, why: `a run of letters runs out at ${cap}, the example's value padded at ${seeded}: no one limit on the whole value` };
  } else if (typeof seed === "string" && seed.length > cap) {
    return { cap: null, why: `the published example's value (${seed.length} characters) is longer than the ${cap} letters accepted` };
  }
  return { cap, long };
}

/** Whether a declared cap is the handler's: `cap` letters are not answered
 *  as a very long value is, `cap + 1` are (beside the example's other fields,
 *  or with the field alone when the example makes the handler pass it by). */
export async function declaredCapHolds(tool, field, cap) {
  let last = null;
  for (const alone of [false, true]) {
    const long = await outcomeOf(tool, field, letters(Math.max(LONG, cap * 2 + 2)), alone);
    if (!is4xx(long)) { last = last || { verdict: /^(5\d\d|error|timeout)/.test(long) ? "no verdict" : "not refused", long }; continue; }
    const at = await outcomeOf(tool, field, letters(cap), alone), over = await outcomeOf(tool, field, letters(cap + 1), alone);
    const verdict = at !== long && over === long ? "holds" : at === long ? "refused at the cap" : "accepted past the cap";
    if (verdict === "holds") return { verdict, long, alone };
    last = { verdict, long, at, over };
  }
  return last;
}
