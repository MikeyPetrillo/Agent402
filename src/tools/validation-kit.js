// Validation kit: CSV linting. A pure-CPU format validator agents reach
// for when sanitizing input.
// No network, no npm deps — proof-of-work eligible (free tier).

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
      const delimiter = (input.delimiter || ",").charAt(0);
      return csvLint(input.text, delimiter);
    },
  },


];
