// Validate-more kit: three pure-CPU tools agents asked for.
//
//   id-validate        format and check digits for financial and national
//                      identifiers (BIC, UK NINO, CPF, CNPJ, ABN, SEDOL, ISIN,
//                      LEI, Norwegian organization number); offline, no registry
//   build-log-triage   the first real error in a CI or build log, its class,
//                      the failing step and command, and a fixed next step
//   json-repair        repairs common breakage in JSON text and lists each fix
//
// No network, no child process, no npm dependency: proof-of-work eligible.
// Every scan is one linear pass with an explicit bound on its input; the only
// regular expressions run on short, length-capped slices and have no nested
// or overlapping quantifiers (scripts/test-redos-free-tier.js times them).

import { readFileSync } from "node:fs";
import { partialFields } from "../partial-answer.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/** A string field (a number is read as its digits); anything else is the caller's 400. */
function stringField(input, field, { max, required = true } = {}) {
  const v = input?.[field];
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`"${field}" is required`);
    return null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") throw bad(`"${field}" must be a string`);
  if (max && v.length > max) throw bad(`"${field}" is longer than ${max.toLocaleString("en-US")} characters`);
  return v;
}

// One pass over `text` that turns each offset into a 1-based line and column.
function positionsOf(text, offsets) {
  const order = offsets.map((o, k) => [o, k]).sort((a, b) => a[0] - b[0]);
  const out = new Array(offsets.length);
  let line = 1, lineStart = 0, p = 0;
  for (const [o, k] of order) {
    for (; p < o && p < text.length; p++) if (text.charCodeAt(p) === 10) { line++; lineStart = p + 1; }
    out[k] = { line, column: o - lineStart + 1 };
  }
  return out;
}

// ============================================================================
// id-validate
// ============================================================================
const ID_MAX_CHARS = 64;
const COUNTRY_CODES = new Set(
  JSON.parse(readFileSync(new URL("../data/countries.json", import.meta.url), "utf8")).map((c) => c.code2),
);

const isDigits = (s) => /^[0-9]+$/.test(s);
const digitsOf = (s) => [...s].map((c) => c.charCodeAt(0) - 48);
// A=10 ... Z=35, digits as themselves (ISIN, LEI, SEDOL).
const alnumValue = (c) => (c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55);

/** ISO 7064 MOD 97-10 remainder of an alphanumeric string (letters expand to two digits). */
function mod97(s) {
  let rem = 0;
  for (const c of s) {
    const v = alnumValue(c);
    rem = v >= 10 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return rem;
}

/** Luhn over a digit string, the last digit being the check digit. */
function luhnOk(digits) {
  let sum = 0, dbl = false;
  for (let k = digits.length - 1; k >= 0; k--) {
    let d = digits.charCodeAt(k) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

const result = (valid, reason, extra = {}) => ({ valid, reason, ...extra });

// Each validator takes the normalized value (uppercase, separators removed)
// and answers { format, valid, reason, ...details }. `format` false means the
// value does not have the type's shape at all (auto-detect skips it).
const ID_TYPES = {
  bic: {
    label: "BIC / SWIFT code (ISO 9362)",
    check(v) {
      if (!/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v)) return { format: false, ...result(false, "A BIC is 8 or 11 characters: 4 institution, 2 country letters, 2 location, optional 3 branch") };
      const country = v.slice(4, 6);
      const details = { institution: v.slice(0, 4), country, location: v.slice(6, 8), branch: v.length === 11 ? v.slice(8) : null, testCode: v[7] === "0" };
      if (!COUNTRY_CODES.has(country)) return { format: true, ...result(false, `"${country}" is not an ISO 3166 country code`, details) };
      return { format: true, ...result(true, "Format and country code are valid; a BIC carries no check digit", details) };
    },
  },
  "uk-nino": {
    label: "UK National Insurance number",
    check(v) {
      if (!/^[A-Z]{2}[0-9]{6}[A-Z]?$/.test(v)) return { format: false, ...result(false, "A National Insurance number is 2 letters, 6 digits and a suffix letter A to D") };
      const suffix = v.length === 9 ? v[8] : null;
      if (suffix !== null && !"ABCD".includes(suffix)) return { format: true, ...result(false, `The suffix letter must be A, B, C or D, not ${suffix}`) };
      if ("DFIQUV".includes(v[0])) return { format: true, ...result(false, `The first letter cannot be ${v[0]}`) };
      if ("DFIOQUV".includes(v[1])) return { format: true, ...result(false, `The second letter cannot be ${v[1]}`) };
      if (["BG", "GB", "KN", "NK", "NT", "TN", "ZZ"].includes(v.slice(0, 2))) return { format: true, ...result(false, `The prefix ${v.slice(0, 2)} is not allocated`) };
      return { format: true, ...result(true, suffix ? "Format and prefix rules are valid; the number carries no check digit" : "Format and prefix rules are valid (no suffix letter given); the number carries no check digit", { suffix }) };
    },
  },
  "br-cpf": {
    label: "Brazil CPF (individual taxpayer number)",
    check(v) {
      if (!/^[0-9]{11}$/.test(v)) return { format: false, ...result(false, "A CPF is 11 digits") };
      if (/^(\d)\1{10}$/.test(v)) return { format: true, ...result(false, "A CPF of one repeated digit is not issued") };
      const d = digitsOf(v);
      const dv = (n) => { let s = 0; for (let k = 0; k < n; k++) s += d[k] * (n + 1 - k); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
      if (dv(9) !== d[9] || dv(10) !== d[10]) return { format: true, ...result(false, "Check digits do not match") };
      return { format: true, ...result(true, "Check digits match", { formatted: `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6, 9)}-${v.slice(9)}` }) };
    },
  },
  "br-cnpj": {
    label: "Brazil CNPJ (company taxpayer number, numeric or alphanumeric)",
    check(v) {
      if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(v)) return { format: false, ...result(false, "A CNPJ is 14 characters: 12 digits or capital letters, then 2 check digits") };
      if (/^(\d)\1{13}$/.test(v)) return { format: true, ...result(false, "A CNPJ of one repeated digit is not issued") };
      // Each character counts as its code point minus 48 (digits as themselves, A as 17).
      const vals = [...v].map((c) => c.charCodeAt(0) - 48);
      const dv = (n) => {
        const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        let s = 0; for (let k = 0; k < n; k++) s += vals[k] * w[k];
        const r = s % 11; return r < 2 ? 0 : 11 - r;
      };
      if (dv(12) !== vals[12] || dv(13) !== vals[13]) return { format: true, ...result(false, "Check digits do not match") };
      return { format: true, ...result(true, "Check digits match", { formatted: `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}`, alphanumeric: !isDigits(v) }) };
    },
  },
  "au-abn": {
    label: "Australian Business Number",
    check(v) {
      if (!/^[0-9]{11}$/.test(v)) return { format: false, ...result(false, "An ABN is 11 digits") };
      if (v[0] === "0") return { format: true, ...result(false, "An ABN does not start with 0") };
      const d = digitsOf(v); d[0] -= 1;
      const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
      let s = 0; for (let k = 0; k < 11; k++) s += d[k] * w[k];
      if (s % 89 !== 0) return { format: true, ...result(false, "The weighted sum is not divisible by 89") };
      return { format: true, ...result(true, "Check digits match", { formatted: `${v.slice(0, 2)} ${v.slice(2, 5)} ${v.slice(5, 8)} ${v.slice(8)}` }) };
    },
  },
  sedol: {
    label: "SEDOL (London Stock Exchange security code)",
    check(v) {
      if (!/^[0-9BCDFGHJKLMNPQRSTVWXYZ]{6}[0-9]$/.test(v)) return { format: false, ...result(false, "A SEDOL is 7 characters: 6 digits or consonants, then a check digit") };
      const w = [1, 3, 1, 7, 3, 9];
      let s = 0; for (let k = 0; k < 6; k++) s += alnumValue(v[k]) * w[k];
      const check = (10 - (s % 10)) % 10;
      if (check !== v.charCodeAt(6) - 48) return { format: true, ...result(false, `The check digit should be ${check}`) };
      return { format: true, ...result(true, "Check digit matches") };
    },
  },
  isin: {
    label: "ISIN (ISO 6166 security identifier)",
    check(v) {
      if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(v)) return { format: false, ...result(false, "An ISIN is 12 characters: 2 letters, 9 letters or digits, then a check digit") };
      let digits = "";
      for (const c of v) digits += String(alnumValue(c));
      if (!luhnOk(digits)) return { format: true, ...result(false, "The check digit does not match") };
      return { format: true, ...result(true, "Check digit matches", { prefix: v.slice(0, 2), nsin: v.slice(2, 11) }) };
    },
  },
  lei: {
    label: "LEI (ISO 17442 legal entity identifier)",
    check(v) {
      if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(v)) return { format: false, ...result(false, "An LEI is 20 characters: 18 letters or digits, then 2 check digits") };
      if (mod97(v) !== 1) return { format: true, ...result(false, "The ISO 7064 MOD 97-10 check does not match") };
      return { format: true, ...result(true, "Check digits match (ISO 7064 MOD 97-10)", { lou: v.slice(0, 4) }) };
    },
  },
  "no-orgnr": {
    label: "Norwegian organization number",
    check(v) {
      if (!/^[0-9]{9}$/.test(v)) return { format: false, ...result(false, "A Norwegian organization number is 9 digits") };
      const d = digitsOf(v);
      const w = [3, 2, 7, 6, 5, 4, 3, 2];
      let s = 0; for (let k = 0; k < 8; k++) s += d[k] * w[k];
      const r = 11 - (s % 11);
      const check = r === 11 ? 0 : r;
      if (check === 10) return { format: true, ...result(false, "No check digit exists for these first eight digits") };
      if (check !== d[8]) return { format: true, ...result(false, `The check digit should be ${check}`) };
      return { format: true, ...result(true, "Check digit matches (MOD 11)", { formatted: `${v.slice(0, 3)} ${v.slice(3, 6)} ${v.slice(6)}` }) };
    },
  },
};
const ID_TYPE_ALIASES = {
  swift: "bic", "swift-bic": "bic", bic: "bic",
  nino: "uk-nino", "uk-nino": "uk-nino", "national-insurance": "uk-nino",
  cpf: "br-cpf", "br-cpf": "br-cpf",
  cnpj: "br-cnpj", "br-cnpj": "br-cnpj",
  abn: "au-abn", "au-abn": "au-abn",
  sedol: "sedol", isin: "isin", lei: "lei",
  orgnr: "no-orgnr", "no-orgnr": "no-orgnr", "organisasjonsnummer": "no-orgnr",
};
const ID_TYPE_NAMES = Object.keys(ID_TYPES);

/** Uppercase, with spaces, dots, dashes and slashes removed. */
const normalizeId = (raw) => raw.replace(/[\s./-]+/g, "").toUpperCase();

export function idValidate(input) {
  const raw = stringField(input, "value", { max: ID_MAX_CHARS });
  const typeRaw = stringField(input, "type", { max: 40, required: false });
  const normalized = normalizeId(raw);
  const base = { normalized, registryChecked: false };
  if (!normalized) throw bad(`"value" has no characters left once spaces and separators are removed`);
  if (typeRaw !== null) {
    const type = ID_TYPE_ALIASES[typeRaw.trim().toLowerCase()];
    if (!type) throw bad(`"type" must be one of ${ID_TYPE_NAMES.join(", ")} (or omit it to detect)`);
    const { format, ...r } = ID_TYPES[type].check(normalized);
    return { type, label: ID_TYPES[type].label, ...r, ...base };
  }
  const candidates = [];
  for (const type of ID_TYPE_NAMES) {
    const { format, valid, reason } = ID_TYPES[type].check(normalized);
    if (format) candidates.push({ type, valid, reason });
  }
  const valids = candidates.filter((c) => c.valid);
  if (valids.length) {
    const type = valids[0].type;
    const { format, ...r } = ID_TYPES[type].check(normalized);
    const ambiguous = valids.length > 1;
    return {
      type, label: ID_TYPES[type].label, ...r,
      ...(ambiguous ? { reason: `${r.reason}; it is also valid as ${valids.slice(1).map((c) => c.type).join(", ")}: pass "type" to choose` } : {}),
      detected: true, ambiguous, candidates, ...base,
    };
  }
  if (candidates.length) {
    return {
      type: candidates.length === 1 ? candidates[0].type : null, valid: false,
      reason: candidates.length === 1 ? candidates[0].reason : `It has the shape of ${candidates.map((c) => c.type).join(", ")} but fails each check`,
      detected: true, ambiguous: candidates.length > 1, candidates, ...base,
    };
  }
  return { type: null, valid: false, reason: `It does not have the shape of any supported type (${ID_TYPE_NAMES.join(", ")})`, detected: true, ambiguous: false, candidates, ...base };
}

// ============================================================================
// build-log-triage
// ============================================================================
const LOG_MAX_BYTES = 100_000;
const LINE_SCAN_CHARS = 1_000;   // the slice of each line the matchers read
const LINE_SHOW_CHARS = 300;     // the slice of each line the answer shows
const SHOWN_MAX = 30;

export const ERROR_CLASSES = [
  "lockfile-mismatch", "dependency-resolution", "compile-error", "test-failure",
  "timeout", "out-of-memory", "network", "permission",
];

// A fixed table: the same class always reads the same next step.
export const NEXT_STEPS = {
  "lockfile-mismatch": "Regenerate the lockfile with the same package manager and version the build uses, commit it, and run the frozen install again.",
  "dependency-resolution": "Check that the named package and version exist in the registry the build reads and that the version ranges agree; align conflicting peer versions rather than forcing the install.",
  "compile-error": "Fix the first compiler or type error at the file and line shown; later errors often follow from it.",
  "test-failure": "Run the failing test on its own to reproduce it, then read its assertion message and stack trace.",
  timeout: "Find the step that stalled and check it for a hang (waiting on input, a network call, a lock) before raising its time limit.",
  "out-of-memory": "Lower peak memory (fewer parallel workers, smaller batches) or raise the memory limit for the step, for Node with NODE_OPTIONS=--max-old-space-size.",
  network: "Retry the step once; if it fails again, check the host named in the error, the proxy and DNS settings of the runner, and the registry's status.",
  permission: "Check the token's scopes or the workflow's permissions, and the owner and mode of the path named in the error.",
  unknown: "Read the lines shown around the first error; it matched no known failure pattern.",
};

// Matchers: [class, kind, test]. kind "has" is a substring test, "re" a
// regular expression without nested quantifiers.
// Order matters only within a line: the first matching rule names its class.
const RULES = [
  // lockfile mismatch
  ["lockfile-mismatch", "has", "can only install packages when your package.json and package-lock.json"],
  ["lockfile-mismatch", "has", "ERR_PNPM_OUTDATED_LOCKFILE"],
  ["lockfile-mismatch", "has", "Cannot install with \"frozen-lockfile\""],
  ["lockfile-mismatch", "has", "Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`"],
  ["lockfile-mismatch", "has", "The lockfile would have been modified by this install, which is explicitly forbidden"],
  ["lockfile-mismatch", "has", "needs to be updated but --locked was passed"],
  ["lockfile-mismatch", "has", "go: updates to go.mod needed"],
  ["lockfile-mismatch", "has", "missing go.sum entry"],
  ["lockfile-mismatch", "has", "DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE"],
  ["lockfile-mismatch", "has", "changed significantly since poetry.lock was last generated"],
  ["lockfile-mismatch", "has", "lock file is not up to date"],
  // out of memory
  ["out-of-memory", "has", "JavaScript heap out of memory"],
  ["out-of-memory", "has", "Reached heap limit"],
  ["out-of-memory", "has", "java.lang.OutOfMemoryError"],
  ["out-of-memory", "re", /^(?:E\s+)?MemoryError\b/],
  ["out-of-memory", "has", "Cannot allocate memory"],
  ["out-of-memory", "re", /memory allocation of \d+ bytes failed/],
  ["out-of-memory", "has", "OOMKilled"],
  ["out-of-memory", "re", /exit code 137\b/],
  ["out-of-memory", "has", "signal: killed"],
  // timeout
  ["timeout", "has", "has exceeded the maximum execution time"],
  ["timeout", "re", /\btimed out after\b/i],
  ["timeout", "re", /Timeout of \d+ms exceeded/],
  ["timeout", "has", "Exceeded timeout of"],
  ["timeout", "has", "context deadline exceeded"],
  ["timeout", "has", "The operation was canceled."],
  // network
  ["network", "re", /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/],
  ["network", "has", "getaddrinfo"],
  ["network", "has", "Could not resolve host"],
  ["network", "has", "Temporary failure in name resolution"],
  ["network", "has", "Connection reset by peer"],
  ["network", "has", "TLS handshake timeout"],
  ["network", "has", "i/o timeout"],
  ["network", "has", "Max retries exceeded with url"],
  ["network", "has", "socket hang up"],
  ["network", "has", "502 Bad Gateway"],
  ["network", "has", "503 Service Unavailable"],
  ["network", "has", "Read timed out"],
  // permission
  ["permission", "re", /\b(?:EACCES|EPERM)\b/],
  ["permission", "has", "Permission denied"],
  ["permission", "has", "permission denied"],
  ["permission", "has", "Operation not permitted"],
  ["permission", "has", "Resource not accessible by integration"],
  ["permission", "has", "403 Forbidden"],
  ["permission", "has", "401 Unauthorized"],
  ["permission", "has", "requested access to the resource is denied"],
  ["permission", "re", /remote: Permission to \S+ denied/],
  // dependency resolution
  ["dependency-resolution", "re", /\bERESOLVE\b/],
  ["dependency-resolution", "re", /\bcode (?:ETARGET|E404)\b/],
  ["dependency-resolution", "has", "No matching version found for"],
  ["dependency-resolution", "has", "ERR_PNPM_NO_MATCHING_VERSION"],
  ["dependency-resolution", "has", "ERR_PNPM_PEER_DEP_ISSUES"],
  ["dependency-resolution", "has", "Couldn't find any versions for"],
  ["dependency-resolution", "has", "Could not find a version that satisfies the requirement"],
  ["dependency-resolution", "has", "No matching distribution found for"],
  ["dependency-resolution", "has", "ResolutionImpossible"],
  ["dependency-resolution", "has", "failed to select a version for"],
  ["dependency-resolution", "has", "no matching package named"],
  ["dependency-resolution", "has", "cannot find module providing package"],
  ["dependency-resolution", "has", "unknown revision"],
  ["dependency-resolution", "has", "Could not resolve dependencies for project"],
  ["dependency-resolution", "has", "Could not find artifact"],
  ["dependency-resolution", "has", "Could not resolve all files for configuration"],
  ["dependency-resolution", "has", "Could not resolve all dependencies"],
  ["dependency-resolution", "has", "Error: Cannot find module"],
  ["dependency-resolution", "re", /^(?:E\s+)?ModuleNotFoundError: /],
  // test failure (before compile, so a test runner's own summary is read as such)
  ["test-failure", "re", /^FAIL\s+\S/],
  ["test-failure", "re", /^--- FAIL: /],
  ["test-failure", "re", /^FAILED \S/],
  ["test-failure", "re", /^=+ FAILURES =+$/],
  ["test-failure", "re", /^=+ (?:\d+ (?:passed|skipped|warnings?|errors?), )*\d+ failed/],
  ["test-failure", "re", /^Tests:\s+\d+ failed/],
  ["test-failure", "re", /^test result: FAILED\b/],
  ["test-failure", "re", /^\s*\d+ failing$/],
  ["test-failure", "re", /^# fail [1-9]/],
  ["test-failure", "re", /Tests run: \d+, Failures: [1-9]/],
  ["test-failure", "re", /Tests run: \d+, Failures: \d+, Errors: [1-9]/],
  ["test-failure", "has", "There are test failures"],
  ["test-failure", "has", "There were failing tests"],
  ["test-failure", "re", /\btests completed, \d+ failed\b/],
  ["test-failure", "re", /^not ok \d+ /],
  // compile error
  ["compile-error", "re", /\berror TS\d{1,5}:/],
  ["compile-error", "re", /^error\[E\d{4}\]/],
  ["compile-error", "has", "error: could not compile"],
  ["compile-error", "re", /\.go:\d+:\d+: /],
  ["compile-error", "has", "COMPILATION ERROR"],
  ["compile-error", "has", "Compilation failed; see the compiler error output"],
  ["compile-error", "re", /\.java:\[?\d+[,:]\d+\]?:? error:/],
  ["compile-error", "re", /\.java:\d+: error:/],
  ["compile-error", "re", /\.(?:c|cc|cpp|cxx|h|hpp|m|mm|swift|kt|scala|cs):\d+:\d+: (?:fatal )?error/],
  ["compile-error", "re", /\.(?:kt|cs)\(\d+,\d+\): error/],
  ["compile-error", "re", /^(?:E\s+)?(?:SyntaxError|IndentationError|TabError): /],
  ["compile-error", "has", "Module build failed"],
  ["compile-error", "has", "Build failed with "],
  ["compile-error", "has", "Rollup failed to resolve"],
  ["compile-error", "re", /^ERROR in \S/],
];

// Lines that mark an error without naming a class: the first one stands in
// for the first error when no rule above matches anywhere.
const GENERIC_ERROR = [
  (l) => l.startsWith("##[error]"),
  (l) => l.startsWith("npm ERR!") || l.startsWith("npm error "),
  (l) => l.startsWith("ERR_PNPM_") || l.startsWith(" ERR_PNPM_"),
  (l) => l.startsWith("error ") || l.startsWith("error:") || l.startsWith("Error:") || l.startsWith("ERROR:") || l.startsWith("ERROR "),
  (l) => l.startsWith("[ERROR]"),
  (l) => l.startsWith("FATAL") || l.startsWith("fatal:"),
  (l) => l.startsWith("Traceback (most recent call last):"),
  (l) => l.startsWith("panic:"),
  (l) => l.startsWith("Exception in thread"),
  (l) => l.startsWith("BUILD FAILED") || l.startsWith("FAILURE: Build failed"),
  (l) => l.startsWith("make: *** ") || l.startsWith("make[") && l.includes("*** "),
];

function classify(line) {
  for (const [cls, kind, test] of RULES) {
    if (kind === "has" ? line.includes(test) : test.test(line)) return cls;
  }
  return null;
}

// GitHub Actions prefixes every line with an ISO timestamp; ANSI color codes
// ride along in most CI logs. Both are cut before matching.
const GHA_STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const cleanLine = (raw) => {
  let s = raw.length > LINE_SCAN_CHARS ? raw.slice(0, LINE_SCAN_CHARS) : raw;
  if (s.includes("\x1b")) s = s.replace(ANSI, "");
  if (s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
  return s.replace(GHA_STAMP, "");
};

const ECOSYSTEM_MARKERS = [
  ["github-actions", (l) => l.startsWith("##[") || l.startsWith("Run actions/") || l.includes("Process completed with exit code")],
  ["npm", (l) => l.startsWith("npm ERR!") || l.startsWith("npm error") || l.startsWith("npm warn") || l.startsWith("npm WARN") || l.startsWith("> ") && l.includes("@")],
  ["pnpm", (l) => l.includes("ERR_PNPM_") || l.startsWith("pnpm ") || l.includes("Lockfile is up to date")],
  ["yarn", (l) => l.startsWith("yarn ") || l.includes("YN0") || l.startsWith("error Command failed") || l.startsWith("info Visit https://yarnpkg.com")],
  ["pip", (l) => l.includes("pip install") || l.startsWith("Collecting ") || l.startsWith("ERROR: Could not find a version") || l.includes("pytest") || l.startsWith("Traceback (most recent call last):")],
  ["cargo", (l) => l.includes("Compiling ") && l.includes(" v") || l.startsWith("error[E") || l.includes("cargo ") || l.startsWith("test result:")],
  ["go", (l) => l.startsWith("go: ") || l.startsWith("--- FAIL") || l.startsWith("ok  \t") || l.startsWith("FAIL\t") || /\.go:\d+:\d+: /.test(l)],
  ["maven", (l) => l.startsWith("[INFO]") || l.startsWith("[ERROR]") && l.includes("maven") || l.includes("BUILD FAILURE")],
  ["gradle", (l) => l.startsWith("> Task :") || l.includes("FAILURE: Build failed with an exception") || l.includes("gradle")],
];

// Where a failing step or command is named.
function stepOf(line) {
  if (line.startsWith("##[group]Run ")) return { kind: "step", text: line.slice("##[group]".length) };
  if (line.startsWith("##[group]")) return { kind: "step", text: line.slice("##[group]".length) };
  return null;
}
function commandOf(line) {
  let m;
  if ((m = /^npm (?:ERR!|error) command (.+)$/.exec(line))) return m[1].replace(/^sh -c /, "");
  if ((m = /^npm (?:ERR!|error) (?:Failed at the \S+ script\.?|Lifecycle script `([^`]+)` failed)/.exec(line))) return m[1] ? `npm run ${m[1]}` : null;
  if ((m = /^Execution failed for task '([^']+)'/.exec(line))) return `gradle ${m[1]}`;
  if ((m = /^\[ERROR\] Failed to execute goal (\S+)/.exec(line))) return `mvn ${m[1]}`;
  if ((m = /^make(?:\[\d+\])?: \*\*\* \[([^\]]+)\]/.exec(line))) return `make ${m[1]}`;
  if ((m = /^> Task (:\S+) FAILED/.exec(line))) return `gradle ${m[1]}`;
  return null;
}

export function buildLogTriage(input) {
  const log = stringField(input, "log", { max: LOG_MAX_BYTES });
  if (Buffer.byteLength(log, "utf8") > LOG_MAX_BYTES) throw bad(`"log" is larger than ${LOG_MAX_BYTES.toLocaleString("en-US")} bytes; send the last part of the log, where the failure is`);
  const raw = log.split("\n");
  const lines = raw.map(cleanLine);
  const signals = Object.fromEntries(ERROR_CLASSES.map((c) => [c, 0]));
  const ecoHits = new Map();
  let first = null, firstGeneric = null, lastStep = null, stepAtError = null, command = null, exitCode = null;
  const classLines = [];
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (!l) continue;
    const t = l.trimStart();
    for (const [eco, test] of ECOSYSTEM_MARKERS) if (test(t)) ecoHits.set(eco, (ecoHits.get(eco) || 0) + 1);
    const step = stepOf(t);
    if (step) { lastStep = { line: k + 1, text: step.text.slice(0, LINE_SHOW_CHARS), kind: step.kind }; continue; }
    const cmd = commandOf(t);
    if (cmd && !command) command = { line: k + 1, text: cmd.slice(0, LINE_SHOW_CHARS) };
    const ex = /(?:exit code|exit status|exited with code|Error) (\d{1,3})\b/.exec(t);
    if (ex && exitCode === null && (t.includes("##[error]") || t.startsWith("make") || t.includes("Command failed") || t.includes("exit status") || t.includes("exited with code"))) exitCode = Number(ex[1]);
    const cls = classify(t);
    if (cls) {
      signals[cls]++;
      if (!first) { first = { line: k + 1, cls }; stepAtError = lastStep; }
      if (classLines.length < SHOWN_MAX) classLines.push({ k, cls });
    } else if (!firstGeneric && GENERIC_ERROR.some((g) => g(t))) {
      firstGeneric = { line: k + 1, cls: null };
      if (!first) stepAtError = lastStep;
    }
  }
  const pick = first || firstGeneric;
  const errorClass = first ? first.cls : "unknown";
  // The lines shown: the first error with two lines before and four after,
  // then the other classified lines, in log order, each once.
  const keep = new Set();
  if (pick) for (let k = Math.max(0, pick.line - 3); k < Math.min(lines.length, pick.line + 4); k++) keep.add(k);
  for (const c of classLines) { if (keep.size >= SHOWN_MAX) break; keep.add(c.k); }
  if (command && keep.size < SHOWN_MAX) keep.add(command.line - 1);
  const shownIdx = [...keep].sort((a, b) => a - b).filter((k) => lines[k]);
  const ecosystems = [...ecoHits.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
  const classifiedTotal = Object.values(signals).reduce((a, b) => a + b, 0);
  const shownClassified = classLines.filter((c) => keep.has(c.k)).length;
  return {
    errorClass,
    firstError: pick ? { line: pick.line, text: lines[pick.line - 1].trim().slice(0, LINE_SHOW_CHARS) } : null,
    failingStep: stepAtError || lastStep || null,
    failingCommand: command,
    exitCode,
    nextStep: NEXT_STEPS[errorClass],
    ecosystems,
    signals,
    lines: shownIdx.map((k) => ({ line: k + 1, text: lines[k].slice(0, LINE_SHOW_CHARS), ...(classLines.find((c) => c.k === k) ? { class: classLines.find((c) => c.k === k).cls } : {}) })),
    lineCount: lines.length,
    // returned / matched count the classified lines: shown in "lines", and found in the log.
    ...partialFields(classifiedTotal, shownClassified),
  };
}

// ============================================================================
// json-repair
// ============================================================================
const REPAIR_MAX = 100_000;
const REPAIR_MAX_DEPTH = 512;
const FIXES_SHOWN = 200;

class Unrepairable extends Error {
  constructor(message, offset) { super(message); this.offset = offset; }
}

const SMART_OPEN = { "\u201c": "\u201d", "\u201d": "\u201d", "\u2018": "\u2019", "\u2019": "\u2019" };
const isIdentStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isIdentChar = (c) => isIdentStart(c) || (c >= "0" && c <= "9");
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const BARE_VALUES = { NaN: "null", undefined: "null", Infinity: "null", None: "null", True: "true", False: "false", null: "null", true: "true", false: "false", Null: "null", NULL: "null", TRUE: "true", FALSE: "false" };

/**
 * One pass over the text: a tokenizer that reads the lenient forms, and a
 * bracket stack that writes strict JSON. Every change is recorded with the
 * offset in the input where it applies. Throws Unrepairable for anything it
 * cannot fix without guessing at the author's meaning.
 */
export function repairJson(text) {
  const n = text.length;
  const out = [];
  const fixes = [];
  const fix = (kind, offset, message) => fixes.push({ kind, offset, message });
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) { fix("byte-order-mark", 0, "Removed the byte order mark"); i = 1; }

  // A Markdown code fence around the JSON (```json ... ```): cut it.
  let end = n;
  {
    let j = i; while (j < n && /\s/.test(text[j])) j++;
    if (text.startsWith("```", j)) {
      let k = text.indexOf("\n", j);
      if (k < 0) throw new Unrepairable("A code fence opens but holds no JSON", j);
      fix("code-fence", j, "Removed the Markdown code fence around the JSON");
      i = k + 1;
      let e = n; while (e > i && /\s/.test(text[e - 1])) e--;
      if (text.startsWith("```", e - 3) && e - 3 >= i) end = e - 3;
    }
  }

  // ---- tokenizer -----------------------------------------------------------
  const skip = () => {
    while (i < end) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      if (c === "\u00a0" || c === "\ufeff") { fix("whitespace", i, "Replaced a non-standard space"); i++; continue; }
      if (c === "/" && text[i + 1] === "/") {
        fix("comment", i, "Removed a // comment");
        const k = text.indexOf("\n", i); i = k < 0 || k > end ? end : k; continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        const k = text.indexOf("*/", i + 2);
        if (k < 0 || k + 2 > end) throw new Unrepairable("A /* comment is never closed", i);
        fix("comment", i, "Removed a /* */ comment"); i = k + 2; continue;
      }
      if (c === "#" && (i === 0 || text[i - 1] === "\n" || text[i - 1] === " " || text[i - 1] === "\t")) {
        fix("comment", i, "Removed a # comment");
        const k = text.indexOf("\n", i); i = k < 0 || k > end ? end : k; continue;
      }
      break;
    }
  };

  // Reads a string opened at text[i] by `q` (", ', or a typographic quote)
  // and returns it as a JSON string literal.
  const readString = () => {
    const start = i;
    const open = text[i];
    const smart = SMART_OPEN[open];
    const closers = smart ? [smart, "\u201c", "\u2018", '"'] : [open];
    if (smart) fix("smart-quotes", start, "Replaced typographic quotes around a string with double quotes");
    else if (open === "'") fix("single-quotes", start, "Replaced single quotes around a string with double quotes");
    i++;
    let s = '"';
    let run = i;
    while (true) {
      if (i >= end) {
        s += text.slice(run, end);
        fix("unterminated-string", start, "Closed a string that was never closed");
        i = end;
        return s + '"';
      }
      const c = text[i];
      if (closers.includes(c)) { s += text.slice(run, i); i++; return s + '"'; }
      if (c === "\\") {
        s += text.slice(run, i);
        const e = text[i + 1];
        if (e === "'" ) { s += "'"; i += 2; }
        else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { s += text.slice(i, i + 6); i += 6; }
        else if (e !== undefined && '"\\/bfnrt'.includes(e)) { s += "\\" + e; i += 2; }
        else if (e === "\n") { fix("escape", i, "Removed a backslash line continuation"); i += 2; }
        else { fix("escape", i, `Escaped a backslash before "${e ?? ""}" that is not a JSON escape`); s += "\\\\"; i += 1; }
        run = i; continue;
      }
      if (c === '"' && open !== '"') { s += text.slice(run, i) + '\\"'; i++; run = i; continue; }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        s += text.slice(run, i);
        fix("control-character", i, "Escaped a raw control character inside a string");
        s += c === "\n" ? "\\n" : c === "\t" ? "\\t" : c === "\r" ? "\\r" : "\\u" + code.toString(16).padStart(4, "0");
        i++; run = i; continue;
      }
      i++;
    }
  };

  // ---- writer: a bracket stack, one state per level ------------------------
  // frame: { type: "object"|"array", open, state } where state is
  //   "start" (just opened), "key" (expecting a key), "colon", "value", "after"
  const stack = [];
  let rootDone = false;
  let lastCommaOut = -1, lastCommaAt = -1;
  const pushValueStart = () => {
    const f = stack[stack.length - 1];
    if (!f) { if (rootDone) throw new Unrepairable("More than one JSON value at the top level", i); return; }
    if (f.type === "array") {
      if (f.state === "after") throw new Unrepairable('Expected "," or "]" between array elements', i);
      f.state = "after";
    } else {
      if (f.state !== "value") throw new Unrepairable("Expected an object key", i);
      f.state = "after";
    }
  };
  const valueDone = () => { if (!stack.length) rootDone = true; };

  while (true) {
    skip();
    if (i >= end) break;
    const c = text[i];
    const f = stack[stack.length - 1];
    if (c === "{" || c === "[") {
      pushValueStart(); if (f) f.pendingComma = false;
      if (stack.length >= REPAIR_MAX_DEPTH) throw new Unrepairable(`Nesting deeper than ${REPAIR_MAX_DEPTH} levels`, i);
      stack.push({ type: c === "{" ? "object" : "array", open: i, state: c === "{" ? "key" : "start" });
      out.push(c); i++; continue;
    }
    if (c === "}" || c === "]") {
      if (!f) throw new Unrepairable(`"${c}" closes a bracket that was never opened`, i);
      const want = f.type === "object" ? "}" : "]";
      if (c !== want) throw new Unrepairable(`"${c}" does not match the "${f.type === "object" ? "{" : "["}" opened at offset ${f.open}`, i);
      if (f.state === "colon" || (f.type === "object" && f.state === "value")) throw new Unrepairable("An object key has no value", i);
      if (f.pendingComma) {
        out[lastCommaOut] = "";
        fix("trailing-comma", lastCommaAt, `Removed a trailing comma before "${c}"`);
      }
      stack.pop(); out.push(c); i++; valueDone(); continue;
    }
    if (c === ",") {
      if (!f || f.state !== "after") {
        if (f && (f.pendingComma || f.state === "start" || f.state === "key")) { fix("extra-comma", i, "Removed an extra comma"); i++; continue; }
        throw new Unrepairable("Unexpected comma", i);
      }
      f.state = f.type === "object" ? "key" : "elem";
      f.pendingComma = true; lastCommaOut = out.length; lastCommaAt = i;
      out.push(","); i++; continue;
    }
    if (c === ":") {
      if (!f || f.type !== "object" || f.state !== "colon") throw new Unrepairable("Unexpected colon", i);
      f.state = "value"; out.push(":"); i++; continue;
    }
    // A key position in an object: a string, or a bare identifier to quote.
    if (f && f.type === "object" && f.state === "key") {
      if (c === '"' || c === "'" || SMART_OPEN[c]) { out.push(readString()); }
      else if (isIdentStart(c) || (c >= "0" && c <= "9")) {
        const s = i; while (i < end && isIdentChar(text[i])) i++;
        fix("unquoted-key", s, `Quoted the key ${text.slice(s, i)}`);
        out.push(JSON.stringify(text.slice(s, i)));
      } else throw new Unrepairable(`Expected an object key but found "${c}"`, i);
      f.state = "colon"; f.pendingComma = false;
      continue;
    }
    if (f && f.type === "object" && f.state === "colon") throw new Unrepairable('Expected ":" after the object key', i);
    // A value.
    if (c === '"' || c === "'" || SMART_OPEN[c]) {
      pushValueStart(); if (f) f.pendingComma = false;
      out.push(readString()); valueDone(); continue;
    }
    if (c === "-" || c === "+" || c === "." || (c >= "0" && c <= "9")) {
      const s = i; i++;
      while (i < end && /[0-9a-zA-Z.+-]/.test(text[i])) i++;
      let tok = text.slice(s, i);
      if (tok === "-Infinity" || tok === "+Infinity") { pushValueStart(); if (f) f.pendingComma = false; fix("non-json-literal", s, `Replaced ${tok} with null`); out.push("null"); valueDone(); continue; }
      if (tok.length > 1 && tok[0] === "+") { fix("number", s, "Removed a leading plus sign"); tok = tok.slice(1); }
      if (JSON_NUMBER.test(tok)) { pushValueStart(); if (f) f.pendingComma = false; out.push(tok); valueDone(); continue; }
      throw new Unrepairable(`"${tok.slice(0, 40)}" is not a JSON number`, s);
    }
    if (isIdentStart(c)) {
      const s = i; while (i < end && isIdentChar(text[i])) i++;
      const word = text.slice(s, i);
      const rep = Object.hasOwn(BARE_VALUES, word) ? BARE_VALUES[word] : null;
      if (rep === null) throw new Unrepairable(`Unquoted word "${word.slice(0, 40)}" is not a JSON value; it is left for you to quote or remove`, s);
      pushValueStart(); if (f) f.pendingComma = false;
      if (rep !== word) fix(rep === "null" && !/^null$/i.test(word) ? "non-json-literal" : "literal-case", s, `Replaced ${word} with ${rep}`);
      out.push(rep); valueDone(); continue;
    }
    throw new Unrepairable(`Unexpected character "${c}"`, i);
  }
  if (!stack.length && !rootDone) throw new Unrepairable("No JSON value found", i);
  // Close what is still open, innermost first.
  for (let k = stack.length - 1; k >= 0; k--) {
    const f = stack[k];
    if (f.type === "object" && (f.state === "colon" || f.state === "value")) throw new Unrepairable("The input ends inside an object entry with no value", end);
    if (f.pendingComma && k === stack.length - 1) { out[lastCommaOut] = ""; fix("trailing-comma", lastCommaAt, "Removed a trailing comma at the end of the input"); }
    fix("missing-bracket", end, `Added the "${f.type === "object" ? "}" : "]"}" for the "${f.type === "object" ? "{" : "["}" opened at offset ${f.open}`);
    out.push(f.type === "object" ? "}" : "]");
  }
  return { repaired: out.join(""), fixes };
}

export function jsonRepair(input) {
  const text = stringField(input, "json", { max: REPAIR_MAX });
  let r;
  try { r = repairJson(text); } catch (e) {
    if (!(e instanceof Unrepairable)) throw e;
    const [p] = positionsOf(text, [e.offset]);
    throw Object.assign(bad(`Cannot repair this JSON safely: ${e.message} (line ${p.line}, column ${p.column}, offset ${e.offset})`), { offset: e.offset, line: p.line, column: p.column });
  }
  // The output is strict JSON or the call is refused; never a guess passed on.
  try { JSON.parse(r.repaired); } catch {
    throw bad("Cannot repair this JSON safely: the repaired text still does not parse");
  }
  r.fixes.sort((a, b) => a.offset - b.offset);
  const pos = positionsOf(text, r.fixes.map((f) => f.offset));
  const shown = r.fixes.slice(0, FIXES_SHOWN).map((f, k) => ({ kind: f.kind, line: pos[k].line, column: pos[k].column, offset: f.offset, message: f.message }));
  const kinds = {};
  for (const f of r.fixes) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
  return {
    repaired: r.repaired,
    changed: r.fixes.length > 0,
    fixCount: r.fixes.length,
    fixKinds: kinds,
    fixes: shown,
    ...partialFields(r.fixes.length, shown.length),
  };
}

// ============================================================================
// Tool definitions
// ============================================================================
export const VALIDATE_MORE_TOOLS = [
  {
    route: "POST /api/id-validate",
    name: "Identifier check digits",
    slug: "id-validate", aliases: ["bic-validate", "swift-validate", "isin-validate", "lei-validate", "cpf-validate", "cnpj-validate", "abn-validate", "sedol-validate", "nino-validate"],
    category: "validation",
    price: "$0.001",
    description:
      "Check the format and check digits of a financial or national identifier: BIC/SWIFT code, UK National Insurance number, Brazil CPF and CNPJ (numeric and alphanumeric), Australian ABN, SEDOL, ISIN, LEI (ISO 17442, MOD 97-10) and Norwegian organization number. Pass type, or omit it and the tool tries every type and lists the candidates. Answers type, valid, normalized and the reason. Offline: format and check digits only, with no registry lookup, so a valid answer does not mean the number is issued or active.",
    tags: ["validate", "check-digit", "bic", "swift", "isin", "lei", "sedol", "cpf", "cnpj", "abn", "nino", "national-insurance", "organization-number", "identifier", "finance"],
    discovery: {
      bodyType: "json",
      input: { value: "US0378331005" },
      inputSchema: {
        properties: {
          value: { type: "string", maxLength: ID_MAX_CHARS, description: `The identifier; spaces, dots, dashes and slashes are ignored (max ${ID_MAX_CHARS} characters)` },
          type: { type: "string", description: `One of ${ID_TYPE_NAMES.join(", ")} (also swift, nino, cpf, cnpj, abn, orgnr); omit to detect` },
        },
        required: ["value"],
      },
      output: {
        example: {
          type: "isin", label: "ISIN (ISO 6166 security identifier)", valid: true, reason: "Check digit matches", prefix: "US", nsin: "037833100",
          detected: true, ambiguous: false, candidates: [{ type: "isin", valid: true, reason: "Check digit matches" }],
          normalized: "US0378331005", registryChecked: false,
        },
      },
    },
    handler: (input) => idValidate(input),
  },
  {
    route: "POST /api/build-log-triage",
    name: "Build log triage",
    slug: "build-log-triage", aliases: ["ci-log-triage", "ci-failure-triage", "build-failure-diagnose"],
    category: "developer",
    price: "$0.002",
    description:
      "Read a CI or build log (npm, pnpm, yarn, pip and pytest, cargo, go, Maven, Gradle, GitHub Actions) and find the first real error: its line, the failing step and command, the exit code, and its class (lockfile mismatch, dependency resolution, compile error, test failure, timeout, out of memory, network, permission). Returns the relevant lines with their line numbers and a fixed next step for the class. Rule-based pattern matching, no model; up to 100 KB of log.",
    tags: ["ci", "build", "log", "triage", "error", "failure", "github-actions", "npm", "pip", "cargo", "go", "maven", "gradle", "debug"],
    discovery: {
      bodyType: "json",
      input: {
        log: "##[group]Run npm ci\nnpm ci\n##[endgroup]\nnpm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.\nnpm error Missing: left-pad@1.3.0 from lock file\n##[error]Process completed with exit code 1.",
      },
      inputSchema: {
        properties: {
          log: { type: "string", description: "The log text, up to 100,000 bytes; send the end of a longer log, where the failure is" },
        },
        required: ["log"],
      },
      output: {
        example: {
          errorClass: "lockfile-mismatch",
          firstError: { line: 5, text: "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing." },
          failingStep: { line: 1, text: "Run npm ci", kind: "step" },
          failingCommand: null,
          exitCode: 1,
          nextStep: NEXT_STEPS["lockfile-mismatch"],
          ecosystems: ["github-actions", "npm"],
          signals: { "lockfile-mismatch": 1, "dependency-resolution": 0, "compile-error": 0, "test-failure": 0, timeout: 0, "out-of-memory": 0, network: 0, permission: 0 },
          lines: [
            { line: 3, text: "##[endgroup]" },
            { line: 4, text: "npm error code EUSAGE" },
            { line: 5, text: "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.", class: "lockfile-mismatch" },
            { line: 6, text: "npm error Missing: left-pad@1.3.0 from lock file" },
            { line: 7, text: "##[error]Process completed with exit code 1." },
          ],
          lineCount: 7, returned: 1, matched: 1, complete: true, truncated: false,
        },
      },
    },
    handler: (input) => buildLogTriage(input),
  },
  {
    route: "POST /api/json-repair",
    name: "JSON repair",
    slug: "json-repair", aliases: ["fix-json", "repair-json", "json-fix", "clean-json"],
    category: "data",
    price: "$0.001",
    description:
      "Repair broken JSON text and list every fix with its line, column and offset: trailing and extra commas, single or typographic quotes, unquoted keys, // and /* */ comments, missing closing brackets, unclosed strings, raw line breaks inside strings, NaN, Infinity and undefined (to null), Python True, False and None, and a Markdown code fence around the JSON. The answer always parses as strict JSON; when a fix would mean guessing (an unquoted word as a value, a mismatched bracket) it answers 400 with the reason and position instead. Input up to 100,000 characters.",
    tags: ["json", "repair", "fix", "clean", "parse", "llm-output", "trailing-comma", "comments", "lenient"],
    discovery: {
      bodyType: "json",
      input: { json: "{name: 'Ada', tags: [\"eng\", \"math\",], // note\n score: NaN" },
      inputSchema: {
        properties: {
          json: { type: "string", description: "The broken JSON text (at most 100,000 characters)" },
        },
        required: ["json"],
      },
      output: {
        example: {
          repaired: "{\"name\":\"Ada\",\"tags\":[\"eng\",\"math\"],\"score\":null}",
          changed: true, fixCount: 8,
          fixKinds: { "unquoted-key": 3, "single-quotes": 1, "trailing-comma": 1, comment: 1, "non-json-literal": 1, "missing-bracket": 1 },
          fixes: [
            { kind: "unquoted-key", line: 1, column: 2, offset: 1, message: "Quoted the key name" },
            { kind: "single-quotes", line: 1, column: 8, offset: 7, message: "Replaced single quotes around a string with double quotes" },
            { kind: "unquoted-key", line: 1, column: 15, offset: 14, message: "Quoted the key tags" },
            { kind: "trailing-comma", line: 1, column: 35, offset: 34, message: "Removed a trailing comma before \"]\"" },
            { kind: "comment", line: 1, column: 39, offset: 38, message: "Removed a // comment" },
            { kind: "unquoted-key", line: 2, column: 2, offset: 47, message: "Quoted the key score" },
            { kind: "non-json-literal", line: 2, column: 9, offset: 54, message: "Replaced NaN with null" },
            { kind: "missing-bracket", line: 2, column: 12, offset: 57, message: "Added the \"}\" for the \"{\" opened at offset 0" },
          ],
          returned: 8, matched: 8, complete: true, truncated: false,
        },
      },
    },
    handler: (input) => jsonRepair(input),
  },
];

export const _test = { idValidate, buildLogTriage, repairJson, jsonRepair, ID_TYPES };
