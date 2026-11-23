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
// Everything runs offline: fetch, every name lookup and every socket fail at
// once, so a handler that passes its own checks ends on a failed read. A
// handler that answers the long value with a 5xx gives no verdict, and the
// measurement says which kind: it READ UPSTREAM with the long value (no cap
// stands before the read), or it answered before reading anything (a switch
// or a key gate in front of its checks, which hides whatever cap is behind
// it). The second kind is a finding, so the suite runs every handler
// configured: pinConfiguration() gives the process the example cost table and
// a placeholder for each key a kit gates on, whatever the caller exported.
import { readdirSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import dnsPromises from "node:dns/promises";
import net from "node:net";
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

// Keys and switches a kit reads before it reads its input. Each gets a
// placeholder (nothing leaves the process, so none is ever presented).
const PLACEHOLDER_KEYS = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY", "BRAVE_ANSWERS_API_KEY", "APOLLO_API_KEY", "ALCHEMY_API_KEY", "FRED_API_KEY", "TYPESAFE_API_KEY", "X_BEARER_TOKEN"];
// Switches that put a tool on, and the day's spend alarms set out of reach:
// the measurement's own calls book estimates in this process, and a day
// ceiling met halfway through would answer the rest before their checks.
const SWITCHES_ON = { KALSHI_TOOLS: "on", X_DATA_DAILY_MAX_USD: "1000000" };

/**
 * One configuration for the measurement, whatever the caller's shell or the
 * CI job exports: the example cost table (placeholder numbers), a placeholder
 * for every key a kit gates on, and a signing key made here for the one kit
 * that parses its key. Call it before the first src/ import: the cost table
 * and several keys are read once.
 */
export function pinConfiguration() {
  delete process.env.UPSTREAM_COSTS_JSON;
  process.env.UPSTREAM_COSTS_FILE = fileURLToPath(new URL("../../docs/example-upstream-costs.json", import.meta.url));
  for (const k of PLACEHOLDER_KEYS) process.env[k] = "offline-placeholder";
  for (const [k, v] of Object.entries(SWITCHES_ON)) process.env[k] = v;
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.CDP_API_KEY_ID = "offline-placeholder";
  process.env.CDP_API_KEY_SECRET = privateKey.export({ type: "sec1", format: "pem" });
}

// The call in progress, so a read that leaves the process is booked to the
// call that made it (a read a handler leaves running lands on its own call).
const inCall = new AsyncLocalStorage();
const upstreamOutcomes = new Set();
const noteEgress = () => { const c = inCall.getStore(); if (c) c.egress = true; };
/** Whether `outcome` was ever the answer of a call that tried to read
 *  upstream in this run: a breaker or a cached failed lookup answers later
 *  calls with the same words and no new read. */
export const readUpstream = (outcome) => upstreamOutcomes.has(outcome);

/** Put the process offline. Returns a function that undoes it. */
export function goOffline() {
  const offline = () => Object.assign(new Error("offline"), { code: "ENOTFOUND" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { noteEgress(); throw Object.assign(new TypeError("fetch failed"), { cause: offline() }); };
  const undoGuard = stubGuardResolver(() => { noteEgress(); return Promise.reject(offline()); });
  // Every other question a resolver can be asked (the DNS tools ask MX, TXT,
  // NS and the rest), and any socket a client library opens itself.
  const R = dnsPromises.Resolver.prototype, realR = {};
  for (const fn of Object.getOwnPropertyNames(R)) if (/^(resolve(?!4$|6$)\w*|reverse)$/.test(fn) && typeof R[fn] === "function") { realR[fn] = R[fn]; R[fn] = function offlineResolve() { noteEgress(); return Promise.reject(offline()); }; }
  const realLookup = dnsPromises.lookup;
  dnsPromises.lookup = function offlineLookup() { noteEgress(); return Promise.reject(offline()); };
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function offlineConnect() { noteEgress(); process.nextTick(() => this.destroy(offline())); return this; };
  return () => { globalThis.fetch = realFetch; undoGuard(); Object.assign(R, realR); dnsPromises.lookup = realLookup; net.Socket.prototype.connect = realConnect; };
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
  const call = { egress: false };
  let out;
  try {
    out = await inCall.run(call, () => Promise.race([
      Promise.resolve().then(() => tool.handler(input, { headers: {}, query: {}, body: input })).then(() => "ok", (e) => `${Number.isInteger(e?.statusCode) ? e.statusCode : "error"}:${String(e?.message || "").replace(/\d[\d,_.]*/g, "#").slice(0, 200)}`),
      late,
    ]));
  } catch (e) { out = `error:${String(e?.message || "").slice(0, 80)}`; } finally { clearTimeout(timer); }
  if (call.egress || out === "timeout") upstreamOutcomes.add(out);
  return out;
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
  if (!is4xx(long)) return { cap: /^(5\d\d|error|timeout)/.test(long) ? undefined : null, why: `a ${LONG}-letter value answers ${long.slice(0, 60)}`, outcome: long };
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

// Values past a cap that are not a run of one letter: a leading sign a
// handler strips (@name, $TICKER, #tag) and a second part after a separator
// (en-gb, name.eth). A cap that holds for letters and lets one of these
// through is shorter than a value the handler takes.
const SIGNS = ["@", "$", "#"];
const SEPARATORS = ["-", "_", ".", "/", ":", " ", ","];
const longerForms = (cap) => [...SIGNS.map((s) => s + letters(cap)), ...SEPARATORS.flatMap((s) => [letters(cap) + s + "aa", letters(cap) + s + letters(cap)])];
const OTHER_LETTERS = ["q", "z", "x", "k"];
/** Values exactly `n` long: a run of letters, a sign and letters, two parts and a separator. */
const formsAt = (n) => [letters(n), ...(n > 1 ? SIGNS.map((s) => s + letters(n - 1)) : []), ...(n > 2 ? SEPARATORS.map((s) => letters(Math.ceil((n - 1) / 2)) + s + letters(Math.floor((n - 1) / 2))) : [])];
const short = (v) => JSON.stringify(v.length > 40 ? `${v.slice(0, 12)}...${v.slice(-12)}` : v);

/** Whether a declared cap is the handler's: some value `cap` long is taken
 *  (a run of letters, or another form: "@" and a name, two parts and a
 *  hyphen; `witness` is the suite's own value for a form made of neither),
 *  every value `cap + 1` long is refused as a very long value is, no longer
 *  value of another form is taken, and the handler does not tell one letter's
 *  run from another's at the cap (a handler that takes "a" and refuses "z" is
 *  matching a set of words: that is an `enum`, not a length; `words` names
 *  the letters it refused). Measured beside the example's other fields, or
 *  with the field alone when the example makes the handler pass it by. */
export async function declaredCapHolds(tool, field, cap, { witness = null } = {}) {
  let last = null;
  for (const alone of [false, true]) {
    const long = await outcomeOf(tool, field, letters(Math.max(LONG, cap * 2 + 2)), alone);
    if (!is4xx(long)) { last = last || { verdict: /^(5\d\d|error|timeout)/.test(long) ? "no verdict" : "not refused", long }; continue; }
    const run = (await outcomeOf(tool, field, letters(cap), alone)) !== long;
    let taken = run ? letters(cap) : null;
    for (const v of taken ? [] : [...(witness && witness.length === cap ? [witness] : []), ...formsAt(cap)]) if (!is4xx(await outcomeOf(tool, field, v, alone))) { taken = v; break; }
    if (!taken) { last = { verdict: "refused at the cap", long }; continue; }
    let over = null;
    for (const v of formsAt(cap + 1)) { const o = await outcomeOf(tool, field, v, alone); if (v === letters(cap + 1) ? o !== long : !is4xx(o)) { over = v; break; } }
    if (over) { last = { verdict: over === letters(cap + 1) ? "accepted past the cap" : `a longer value is taken: ${over.length} characters, ${short(over)}`, long }; continue; }
    for (const v of longerForms(cap)) {
      if (!is4xx(await outcomeOf(tool, field, v, alone))) return { verdict: `a longer value is taken: ${v.length} characters, ${short(v)}`, long, alone };
    }
    const words = [];
    if (run) for (const l of OTHER_LETTERS) if ((await outcomeOf(tool, field, l.repeat(cap), alone)) === long) words.push(l);
    return { verdict: "holds", long, alone, words, taken };
  }
  return last;
}

/** How the handler answers each member of a published `enum`, against a
 *  value that is no member: the members it refuses the same way (the value
 *  sent is folded out of the words, so a message that quotes it reads alike).
 *  null when the handler does not refuse a non-member for being one. */
export async function refusedMembers(tool, field, members) {
  const NOT_A_MEMBER = "zq-not-a-member-qz";
  const fold = (o, v) => o.split(v).join("<v>").split(v.toLowerCase()).join("<v>").split(v.toUpperCase()).join("<v>");
  for (const alone of [false, true]) {
    const stranger = await outcomeOf(tool, field, NOT_A_MEMBER, alone);
    if (!is4xx(stranger)) continue;
    // The refusal must be about this field: the same answer with the field
    // left out is about something else the input lacks.
    const input = alone ? {} : structuredClone(tool.discovery?.input || tool.discovery?.example || {});
    delete input[field];
    const without = await outcomeOf({ ...tool, handler: tool.handler, discovery: { input } }, "__absent__", undefined, false);
    if (without === stranger) continue;
    const refused = [];
    for (const m of members) if (fold(await outcomeOf(tool, field, m, alone), m) === fold(stranger, NOT_A_MEMBER)) refused.push(m);
    return refused;
  }
  return null;
}
