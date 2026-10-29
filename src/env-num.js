// Numeric settings read from the environment (or any loose value), with a
// default when the value is missing, not a number, or out of range.

/** `v` as a number when it is finite and above zero, else `d`. */
export function positiveNum(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

/** The environment variable `k` as a number above zero, else `d`. */
export function envPositive(k, d) { return positiveNum(process.env[k], d); }

/** The environment variable `k` as a number of at least `min`, else `d`. */
export function envAtLeast(k, d, min = 1) { const n = Number(process.env[k]); return Number.isFinite(n) && n >= min ? n : d; }
