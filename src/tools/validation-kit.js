// Validation kit — phone formatting, XML well-formedness, CSV linting,
// cron-next scheduling, IPv6 expansion. Pure-CPU format validators that
// agents reach for when sanitising input or verifying identifiers.
// No network, no npm deps — proof-of-work eligible (free tier).

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// ---- phone country configs --------------------------------------------------
const PHONE_COUNTRIES = {
  US: { code: "1",  len: [10],     fmt: (d) => `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` },
  UK: { code: "44", len: [10, 11], fmt: (d) => `${d.slice(0,4)} ${d.slice(4)}` },
  DE: { code: "49", len: [10, 11], fmt: (d) => `${d.slice(0,4)} ${d.slice(4)}` },
  FR: { code: "33", len: [9],      fmt: (d) => `${d.slice(0,1)} ${d.slice(1,3)} ${d.slice(3,5)} ${d.slice(5,7)} ${d.slice(7)}` },
  AU: { code: "61", len: [9],      fmt: (d) => `${d.slice(0,4)} ${d.slice(4)}` },
  IN: { code: "91", len: [10],     fmt: (d) => `${d.slice(0,5)} ${d.slice(5)}` },
};

function detectCountry(digits) {
  if (digits.startsWith("1") && digits.length === 11) return { country: "US", national: digits.slice(1) };
  if (digits.startsWith("44")) return { country: "UK", national: digits.slice(2) };
  if (digits.startsWith("49")) return { country: "DE", national: digits.slice(2) };
  if (digits.startsWith("33")) return { country: "FR", national: digits.slice(2) };
  if (digits.startsWith("61")) return { country: "AU", national: digits.slice(2) };
  if (digits.startsWith("91")) return { country: "IN", national: digits.slice(2) };
  if (digits.startsWith("1")) return { country: "US", national: digits.slice(1) };
  return null;
}

// ---- XML well-formedness checker (pure regex + stack) -----------------------
function xmlValidate(xml) {
  const errors = [];
  const stack = [];
  const stripped = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const tagRe = /<\/?([a-zA-Z_][\w.:_-]*)([\s\S]*?)(\/?)>/g;
  let match;
  while ((match = tagRe.exec(stripped))) {
    const [full, name, , selfClose] = match;
    if (full.startsWith("</")) {
      if (stack.length === 0) { errors.push(`Closing tag </${name}> without matching open tag`); }
      else if (stack[stack.length - 1] !== name) { errors.push(`Expected </${stack[stack.length - 1]}> but found </${name}>`); }
      else { stack.pop(); }
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  for (const tag of stack) errors.push(`Unclosed tag <${tag}>`);
  const noTags = stripped.replace(/<[^>]*>/g, "");
  if (noTags.includes("<")) errors.push("Unexpected '<' character in content");
  const cleaned = noTags.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, "");
  if (cleaned.includes("&")) errors.push("Unescaped '&' character in content");
  return errors;
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


// ---- IPv6 expand/compress ---------------------------------------------------
function ipv6Expand(addr) {
  let full = addr.toLowerCase().trim();
  if (full.includes("::")) {
    const [left, right] = full.split("::");
    const lGroups = left ? left.split(":") : [];
    const rGroups = right ? right.split(":") : [];
    const missing = 8 - lGroups.length - rGroups.length;
    if (missing < 0) throw bad("too many groups in IPv6 address");
    const mid = Array(missing).fill("0000");
    full = [...lGroups, ...mid, ...rGroups].join(":");
  }
  const groups = full.split(":");
  if (groups.length !== 8) throw bad(`IPv6 address must have 8 groups (got ${groups.length})`);
  const expanded = groups.map((g) => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) throw bad(`invalid IPv6 group "${g}"`);
    return g.padStart(4, "0");
  });
  return expanded.join(":");
}

function ipv6Compress(expanded) {
  const groups = expanded.split(":").map((g) => g.replace(/^0+/, "") || "0");
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === "0") {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    } else { curStart = -1; curLen = 0; }
  }
  if (bestLen >= 2) {
    const before = groups.slice(0, bestStart).join(":");
    const after = groups.slice(bestStart + bestLen).join(":");
    return (before ? before : "") + "::" + (after ? after : "");
  }
  return groups.join(":");
}

export const VALIDATION_TOOLS = [
  // ---- 1. phone-format -----------------------------------------------------
  {
    route: "POST /api/phone-format", name: "Phone format", slug: "phone-format", category: "validation", price: "$0.001",
    description:
      "Parse and format phone numbers into E.164 and national formats. Supports US (+1), UK (+44), DE (+49), FR (+33), AU (+61), IN (+91). Pure regex — no libphonenumber dependency.",
    tags: ["phone", "validation", "format"],
    discovery: {
      bodyType: "json",
      input: { phone: "+1 (555) 234-5678" },
      inputSchema: {
        type: "object",
        properties: {
          phone: { type: "string", description: "phone number (any common format)" },
          country: { type: "string", description: "ISO country code hint: US, UK, DE, FR, AU, IN (default US)" },
        },
        required: ["phone"],
      },
      output: {
        example: {
          original: "+1 (555) 234-5678",
          digits: "15552345678",
          e164: "+15552345678",
          national: "(555) 234-5678",
          country: "US",
          valid: true,
        },
      },
    },
    handler(input) {
      if (!input.phone || typeof input.phone !== "string") throw bad('Missing or invalid "phone"');
      const original = input.phone.trim();
      const hasPlus = original.startsWith("+");
      const digits = original.replace(/[^\d]/g, "");
      if (digits.length === 0) throw bad("phone contains no digits");

      let country = null;
      let national = null;

      if (input.country) {
        const hint = input.country.toUpperCase();
        const cfg = PHONE_COUNTRIES[hint];
        if (!cfg) throw bad(`unsupported country "${input.country}" (US, UK, DE, FR, AU, IN)`);
        country = hint;
        national = digits.startsWith(cfg.code) ? digits.slice(cfg.code.length) : digits;
      } else if (hasPlus || digits.length > 10) {
        const detected = detectCountry(digits);
        if (detected) { country = detected.country; national = detected.national; }
        else { country = "US"; national = digits.length > 10 ? digits.slice(digits.length - 10) : digits; }
      } else {
        country = "US";
        national = digits;
      }

      const cfg = PHONE_COUNTRIES[country];
      const valid = cfg.len.includes(national.length);
      const e164 = `+${cfg.code}${national}`;
      const formatted = valid ? cfg.fmt(national) : national;

      return { original, digits, e164, national: formatted, country, valid };
    },
  },

  // ---- 2. xml-validate -----------------------------------------------------
  {
    route: "POST /api/xml-validate", name: "XML validate", slug: "xml-validate", category: "validation", price: "$0.001",
    description:
      "Check XML well-formedness: balanced open/close tags, proper nesting, unescaped entities. No DTD/schema validation — syntax only. Pure CPU, deterministic.",
    tags: ["xml", "validation", "parse"],
    discovery: {
      bodyType: "json",
      input: { xml: "<root><item id=\"1\">Hello</item></root>" },
      inputSchema: {
        type: "object",
        properties: { xml: { type: "string", description: "XML string to validate" } },
        required: ["xml"],
      },
      output: { example: { valid: true, errors: [], rootTag: "root", tagCount: 2 } },
    },
    handler(input) {
      if (!input.xml || typeof input.xml !== "string") throw bad('Missing or invalid "xml"');
      const xml = input.xml.trim();
      if (!xml) throw bad('"xml" must not be empty');
      const errors = xmlValidate(xml);
      const tagRe = /<([a-zA-Z_][\w.:_-]*)[\s\S]*?(?:\/?>)/g;
      let tagCount = 0, rootTag = null, m;
      while ((m = tagRe.exec(xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "")))) {
        if (!rootTag) rootTag = m[1];
        tagCount++;
      }
      return { valid: errors.length === 0, errors, rootTag: rootTag || null, tagCount };
    },
  },

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

  // ---- 4. base-detect -------------------------------------------------------
  {
    route: "POST /api/base-detect", name: "Base detect", slug: "base-detect", category: "validation", price: "$0.001",
    description:
      "Auto-detect the encoding format of a string: base64, base32, hex, binary, decimal, or plain text. Returns confidence scores and decoded preview for each candidate. Pure CPU, deterministic.",
    tags: ["base64", "hex", "detect", "encoding"],
    discovery: {
      bodyType: "json",
      input: { text: "SGVsbG8gV29ybGQ=" },
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "encoded string to identify" } },
        required: ["text"],
      },
      output: {
        example: {
          detected: "base64",
          candidates: [
            { format: "base64", confidence: 0.95, decoded: "Hello World" },
            { format: "hex", confidence: 0.1 },
          ],
        },
      },
    },
    handler(input) {
      if (!input.text || typeof input.text !== "string") throw bad('Missing or invalid "text"');
      const text = input.text.trim();
      if (!text) throw bad('"text" must not be empty');
      const candidates = [];

      // Hex check
      const hexClean = text.replace(/[\s:-]/g, "");
      if (/^[0-9a-fA-F]+$/.test(hexClean) && hexClean.length % 2 === 0 && hexClean.length >= 2) {
        const buf = Buffer.from(hexClean, "hex");
        const preview = buf.toString("utf8").replace(/[^\x20-\x7E]/g, "");
        const printable = preview.length / buf.length;
        candidates.push({ format: "hex", confidence: +(0.5 + printable * 0.4).toFixed(2), decoded: preview.slice(0, 100) });
      }

      // Base64 check
      const b64Clean = text.replace(/\s/g, "");
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64Clean) && b64Clean.length >= 4) {
        try {
          const buf = Buffer.from(b64Clean, "base64");
          const preview = buf.toString("utf8").replace(/[^\x20-\x7E]/g, "");
          const printable = preview.length / Math.max(buf.length, 1);
          candidates.push({ format: "base64", confidence: +(0.6 + printable * 0.35).toFixed(2), decoded: preview.slice(0, 100) });
        } catch { /* ignore */ }
      }

      // Base32 check
      const b32Clean = text.replace(/[\s=]/g, "").toUpperCase();
      if (/^[A-Z2-7]+$/.test(b32Clean) && b32Clean.length >= 4) {
        candidates.push({ format: "base32", confidence: 0.4 });
      }

      // Binary check (space-separated 8-bit groups)
      const binGroups = text.trim().split(/\s+/);
      if (binGroups.every((g) => /^[01]{8}$/.test(g)) && binGroups.length >= 1) {
        const decoded = binGroups.map((b) => String.fromCharCode(parseInt(b, 2))).join("");
        candidates.push({ format: "binary", confidence: 0.9, decoded: decoded.slice(0, 100) });
      }

      // Decimal check
      if (/^\d+$/.test(text) && text.length <= 20) {
        candidates.push({ format: "decimal", confidence: 0.3 });
      }

      candidates.sort((a, b) => b.confidence - a.confidence);
      const detected = candidates.length > 0 ? candidates[0].format : "plaintext";
      if (candidates.length === 0) candidates.push({ format: "plaintext", confidence: 1.0 });

      return { detected, candidates };
    },
  },

  // ---- 5. ipv6-expand ------------------------------------------------------
  {
    route: "POST /api/ipv6-expand", name: "IPv6 expand/compress", slug: "ipv6-expand", category: "validation", price: "$0.001",
    description:
      "Expand a compressed IPv6 address to full 8-group notation (:: to 0000:...) or compress a full address by collapsing the longest zero run. Also validates format. Pure CPU, deterministic.",
    tags: ["ipv6", "network", "validation"],
    discovery: {
      bodyType: "json",
      input: { address: "2001:db8::1" },
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "IPv6 address to expand or compress" },
          compress: { type: "boolean", description: "If true, compress instead of expand (default: false)" },
        },
        required: ["address"],
      },
      output: {
        example: {
          expanded: "2001:0db8:0000:0000:0000:0000:0000:0001",
          compressed: "2001:db8::1",
          valid: true,
          groups: 8,
        },
      },
    },
    handler(input) {
      if (!input.address || typeof input.address !== "string") throw bad('Missing or invalid "address"');
      const addr = input.address.trim();
      if (!addr) throw bad('"address" must not be empty');
      try {
        const expanded = ipv6Expand(addr);
        const compressed = ipv6Compress(expanded);
        return { expanded, compressed, valid: true, groups: 8 };
      } catch (e) {
        if (e.statusCode) throw e;
        return { expanded: addr, compressed: addr, valid: false, groups: 0 };
      }
    },
  },
];
