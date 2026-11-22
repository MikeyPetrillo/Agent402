// A workflow log, a step summary and an uploaded artifact on this repository
// are public. A script a workflow runs prints its money figures (a spend, a
// balance, a refund total) through these helpers, so that under PUBLIC_LOG=1,
// which the workflow sets, the figure becomes a word and the line keeps its
// shape. Run by hand (no PUBLIC_LOG), the script prints in full.
//
//   installPublicLog()      wraps console.log/info/warn/error once
//   redactFigures(text)     "$0.0123" -> "$[withheld]"
//   publicCopy(value)       a report object without its aggregate money keys

import { inspect } from "node:util";

export const isPublicLog = (env = process.env) => String(env.PUBLIC_LOG || "").trim() === "1";

const FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?/g;
export function redactFigures(text) {
  return String(text).replace(FIGURE, "$[withheld]");
}

const redactArg = (a) => {
  if (typeof a === "string") return redactFigures(a);
  if (a instanceof Error) return redactFigures(a.stack || String(a));
  if (a && typeof a === "object") return redactFigures(inspect(publicCopy(a), { depth: 6, breakLength: 120 }));
  return a;
};

let installed = false;
/** Under PUBLIC_LOG=1, every console line this process prints has its dollar figures withheld. */
export function installPublicLog(env = process.env, target = console) {
  if (!isPublicLog(env) || installed) return false;
  installed = true;
  for (const m of ["log", "info", "warn", "error"]) {
    const orig = target[m].bind(target);
    target[m] = (...args) => orig(...args.map(redactArg));
  }
  return true;
}

// Aggregate money keys: what a run spent, what a wallet holds, what a set of
// rows adds up to (any key ending Usd, Micros or Atomic). A per-route price
// (priceUsd, a quote, a row's amount) is the catalog's or the seller's own
// published figure and stays.
const KEEP = new Set(["priceUsd", "maxPriceUsd", "quoteUsd", "amountUsd", "listPriceUsd", "priceMicros", "priceAtomic"]);
const MONEY_KEY = /(?:Usd|USD|Micros|Atomic)$/;
/** A deep copy of a report with its aggregate money keys left out (for a file an artifact uploads). */
export function publicCopy(value) {
  if (Array.isArray(value)) return value.map(publicCopy);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) if (KEEP.has(k) || !MONEY_KEY.test(k)) out[k] = publicCopy(v);
  return out;
}

/** What a script writes to a file a workflow uploads: under PUBLIC_LOG=1 the public copy, else the value itself. */
export const forPublicFile = (value, env = process.env) => (isPublicLog(env) ? publicCopy(value) : value);

/** Text a script appends to a file a workflow publishes (a step summary): under PUBLIC_LOG=1 its dollar figures become words. */
export const forPublicText = (text, env = process.env) => (isPublicLog(env) ? redactFigures(text) : text);

/** One money figure in a printed line: under PUBLIC_LOG=1 the word "[withheld]", else the figure. */
export const figure = (value, env = process.env) => (isPublicLog(env) ? "[withheld]" : String(value));
