// Validation kit: CSV linting and EU VAT number checks. Pure-CPU format
// validators agents reach for when sanitizing input.
// No network, no npm deps — proof-of-work eligible (free tier).

import { VAT_COUNTRIES, vatCode, checkVat } from "./vat-numbers.js";

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// ---- CSV structure checker --------------------------------------------------
function csvLint(text, delimiter) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { valid: true, rows: 0, columns: 0, errors: [], delimiter };
  const errors = [];
  const columnCounts = [];
  for (let i = 0; i < lines.length; i++) {
    let cols = 0, inQuote = false;
    for (let j = 0; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === delimiter && !inQuote) { cols++; }
    }
    if (inQuote) errors.push(`Row ${i + 1}: unclosed quote`);
    columnCounts.push(cols + 1);
  }
  const expected = columnCounts[0];
  for (let i = 1; i < columnCounts.length; i++) {
    if (columnCounts[i] !== expected) {
      errors.push(`Row ${i + 1}: expected ${expected} columns, found ${columnCounts[i]}`);
    }
  }
  return { valid: errors.length === 0, rows: lines.length, columns: expected, errors, delimiter };
}

// ---- EU VAT number check ----------------------------------------------------
export const VAT_MAX_CHARS = 40;
const VAT_PREFIXES = Object.keys(VAT_COUNTRIES).join(", ");

export function vatValidate(input) {
  const raw = input.vat;
  if (typeof raw !== "string" && typeof raw !== "number") throw bad('Missing or invalid "vat" (a string such as "DE123456788")');
  const text = String(raw);
  if (text.length > VAT_MAX_CHARS) throw bad(`"vat" exceeds ${VAT_MAX_CHARS} characters`);
  let given = null;
  if (input.country !== undefined && input.country !== null && input.country !== "") {
    if (typeof input.country !== "string" || !(given = vatCode(input.country.trim()))) {
      throw bad(`"country" must be one of ${VAT_PREFIXES} (GR is read as EL)`);
    }
  }
  // Separators a person types between groups; one pass, linear in length.
  const compact = text.replace(/[\s.\-/,:_]+/g, "").toUpperCase();
  if (!compact) throw bad('Missing or invalid "vat" (a string such as "DE123456788")');

  let code = given, national = compact, prefix = null;
  const lead = /^[A-Z]{2}/.test(compact) ? compact.slice(0, 2) : null;
  if (given) {
    // With a country named, its own prefix (or GR for EL) is optional.
    if (lead && vatCode(lead) === given) national = compact.slice(2);
  } else {
    if (!lead) throw bad('"vat" has no 2-letter country prefix; send "country" too');
    prefix = lead;
    code = vatCode(lead);
    national = compact.slice(2);
  }
  const answer = { input: text, normalized: (code || prefix) + national, country: code || prefix, countryName: code ? VAT_COUNTRIES[code] : null };
  if (!code) {
    return { ...answer, formatValid: false, checksumValid: null, valid: false, registryChecked: false, reason: `${prefix} is not an EU VAT prefix (expected one of ${VAT_PREFIXES})` };
  }
  if (!/^[A-Z0-9+*]+$/.test(national)) {
    return { ...answer, formatValid: false, checksumValid: null, valid: false, registryChecked: false, reason: "Holds characters other than letters and digits" };
  }
  const r = checkVat(national, code);
  const valid = r.format && r.checksum !== false;
  return {
    ...answer,
    formatValid: r.format,
    checksumValid: r.format ? r.checksum : null,
    valid,
    registryChecked: false,
    ...(r.kind ? { kind: r.kind } : {}),
    ...(valid ? {} : { reason: r.reason }),
  };
}


export const VALIDATION_TOOLS = [


  // ---- 3. csv-lint ---------------------------------------------------------
  {
    route: "POST /api/csv-lint", name: "CSV lint", slug: "csv-lint", category: "validation", price: "$0.001",
    description:
      "Validate CSV structure: consistent column counts across rows, properly closed quotes, delimiter detection. Returns row/column counts and any structural errors. Pure CPU.",
    tags: ["csv", "validation", "lint"],
    discovery: {
      bodyType: "json",
      input: { text: "name,age,city\nAlice,30,NYC\nBob,25,LA" },
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "CSV text to validate" },
          delimiter: { type: "string", description: "column delimiter (default \",\")" },
        },
        required: ["text"],
      },
      output: { example: { valid: true, rows: 3, columns: 3, errors: [], delimiter: "," } },
    },
    handler(input) {
      if (!input.text || typeof input.text !== "string") throw bad('Missing or invalid "text"');
      if (input.delimiter && typeof input.delimiter !== "string") throw bad('"delimiter" must be a string');
      const delimiter = (input.delimiter || ",").charAt(0);
      return csvLint(input.text, delimiter);
    },
  },


  // ---- vat-validate ---------------------------------------------------------
  // Format and check digits only, offline: it never asks a registry whether a
  // number is registered or active, and its answer says so in a field.
  {
    route: "POST /api/vat-validate", name: "EU VAT number check", slug: "vat-validate", category: "validation", price: "$0.001",
    description:
      "Check an EU VAT number offline: the country prefix, the national format and the published check-digit rule where the number carries one, for all 27 member states plus XI (Northern Ireland). Format and check digits only: it does not query any registry, so it does not confirm that a number is registered or active.",
    tags: ["vat", "eu", "tax", "validate", "finance"],
    discovery: {
      bodyType: "json",
      input: { vat: "DE 123 456 788" },
      inputSchema: {
        type: "object",
        properties: {
          vat: { type: "string", description: `VAT number, with or without its 2-letter prefix; spaces, dots and dashes are ignored (max ${VAT_MAX_CHARS} characters)` },
          country: { type: "string", description: "2-letter VAT prefix (EL or GR for Greece, XI for Northern Ireland); needed when vat has no prefix" },
        },
        required: ["vat"],
      },
      output: {
        example: {
          input: "DE 123 456 788", normalized: "DE123456788", country: "DE", countryName: "Germany",
          formatValid: true, checksumValid: true, valid: true, registryChecked: false,
        },
      },
    },
    handler(input) {
      return vatValidate(input);
    },
  },


];
