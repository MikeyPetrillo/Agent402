// String kit — 5 pure-CPU string-analysis tools: Jaccard similarity,
// case conversion, multi-metric similarity, character frequency, and
// word wrapping. No network, no npm deps — proof-of-work eligible.

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Extract character bigrams from a string. */
function bigrams(s) {
  const set = new Set();
  const lower = s.toLowerCase();
  for (let i = 0; i < lower.length - 1; i++) {
    set.add(lower.slice(i, i + 2));
  }
  return set;
}

/** Split an identifier/phrase into lowercase word tokens. */
function splitWords(text) {
  // Insert boundary before uppercase letters preceded by lowercase (camelCase)
  let s = text.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Insert boundary between consecutive uppercase and following lowercase (XMLParser → XML Parser)
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  // Split on underscores, hyphens, spaces, dots
  return s
    .split(/[_\-\s.]+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const STRING_TOOLS = [
  // 1. Jaccard similarity
  {
    route: "POST /api/jaccard-similarity",
    name: "Jaccard similarity",
    slug: "jaccard-similarity",
    category: "text",
    price: "$0.001",
    description:
      "Compute the Jaccard similarity coefficient between two strings using character bigrams or word tokens. Returns the ratio of intersection to union (0 = no overlap, 1 = identical sets). Deterministic, pure CPU.",
    tags: ["jaccard", "similarity", "bigram", "text"],
    discovery: {
      bodyType: "json",
      input: { a: "night", b: "nacht", mode: "bigram" },
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "string", description: "First string" },
          b: { type: "string", description: "Second string" },
          mode: {
            type: "string",
            enum: ["bigram", "word"],
            description: 'Tokenization mode: "bigram" (character bigrams) or "word" (whitespace-delimited tokens). Default: "word".',
          },
        },
        required: ["a", "b"],
      },
      output: {
        example: { similarity: 0.142857, intersection: 1, union: 7, mode: "bigram" },
      },
    },
    handler(input) {
      if (typeof input.a !== "string") throw bad('Missing or invalid "a"');
      if (typeof input.b !== "string") throw bad('Missing or invalid "b"');
      const mode = input.mode || "word";
      if (mode !== "bigram" && mode !== "word") throw bad('"mode" must be "bigram" or "word"');

      let setA, setB;
      if (mode === "bigram") {
        setA = bigrams(input.a);
        setB = bigrams(input.b);
      } else {
        setA = new Set(input.a.toLowerCase().split(/\s+/).filter(Boolean));
        setB = new Set(input.b.toLowerCase().split(/\s+/).filter(Boolean));
      }

      let intersection = 0;
      for (const v of setA) {
        if (setB.has(v)) intersection++;
      }
      const union = setA.size + setB.size - intersection;
      const similarity = union === 0 ? 1 : intersection / union;

      return {
        similarity: Math.round(similarity * 1e6) / 1e6,
        intersection,
        union,
        mode,
      };
    },
  },

  // 2. Case convert
  {
    route: "POST /api/case-convert",
    name: "Case convert",
    slug: "case-convert",
    category: "text",
    price: "$0.001",
    description:
      "Convert text between naming conventions: camelCase, PascalCase, snake_case, kebab-case, CONSTANT_CASE, and Title Case. Auto-detects the input format by splitting on camelCase boundaries, underscores, hyphens, and spaces. Deterministic, pure CPU.",
    tags: ["case", "convert", "camel", "snake", "kebab", "pascal"],
    discovery: {
      bodyType: "json",
      input: { text: "myVariableName", to: "snake" },
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The identifier or phrase to convert" },
          to: {
            type: "string",
            enum: ["camel", "pascal", "snake", "kebab", "constant", "title"],
            description: "Target naming convention",
          },
        },
        required: ["text", "to"],
      },
      output: {
        example: { result: "my_variable_name", from: "auto-detected", to: "snake" },
      },
    },
    handler(input) {
      if (typeof input.text !== "string") throw bad('Missing or invalid "text"');
      if (!input.text.trim()) throw bad('"text" must not be empty');
      const to = input.to;
      const valid = ["camel", "pascal", "snake", "kebab", "constant", "title"];
      if (!valid.includes(to)) throw bad(`"to" must be one of: ${valid.join(", ")}`);

      const words = splitWords(input.text);
      if (!words.length) throw bad("Could not extract any words from input");

      let result;
      switch (to) {
        case "camel":
          result = words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
          break;
        case "pascal":
          result = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
          break;
        case "snake":
          result = words.join("_");
          break;
        case "kebab":
          result = words.join("-");
          break;
        case "constant":
          result = words.map((w) => w.toUpperCase()).join("_");
          break;
        case "title":
          result = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
          break;
      }

      return { result, from: "auto-detected", to };
    },
  },

  // 3. String similarity (multi-metric)
  {
    route: "POST /api/string-similarity",
    name: "String similarity",
    slug: "string-similarity",
    category: "text",
    price: "$0.001",
    description:
      "Compute multiple similarity metrics between two strings at once: Dice coefficient, Jaccard index, overlap coefficient (all bigram-based), and normalized length difference. All values 0–1. Deterministic, pure CPU.",
    tags: ["similarity", "dice", "jaccard", "overlap", "text"],
    discovery: {
      bodyType: "json",
      input: { a: "healed", b: "sealed" },
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "string", description: "First string" },
          b: { type: "string", description: "Second string" },
        },
        required: ["a", "b"],
      },
      output: {
        example: { dice: 0.8, jaccard: 0.666667, overlap: 0.8, lengthDiff: 0 },
      },
    },
    handler(input) {
      if (typeof input.a !== "string") throw bad('Missing or invalid "a"');
      if (typeof input.b !== "string") throw bad('Missing or invalid "b"');

      const setA = bigrams(input.a);
      const setB = bigrams(input.b);

      let intersection = 0;
      for (const v of setA) {
        if (setB.has(v)) intersection++;
      }

      const sumSize = setA.size + setB.size;
      const union = sumSize - intersection;
      const minSize = Math.min(setA.size, setB.size);

      const dice = sumSize === 0 ? 1 : (2 * intersection) / sumSize;
      const jaccard = union === 0 ? 1 : intersection / union;
      const overlap = minSize === 0 ? 1 : intersection / minSize;

      const maxLen = Math.max(input.a.length, input.b.length);
      const lengthDiff =
        maxLen === 0 ? 0 : Math.abs(input.a.length - input.b.length) / maxLen;

      const r = (n) => Math.round(n * 1e6) / 1e6;
      return { dice: r(dice), jaccard: r(jaccard), overlap: r(overlap), lengthDiff: r(lengthDiff) };
    },
  },

  // 4. Character frequency
  {
    route: "POST /api/char-frequency",
    name: "Character frequency",
    slug: "char-frequency",
    category: "text",
    price: "$0.001",
    description:
      "Analyze the character frequency distribution of a string. Returns counts by category (letters, digits, spaces, punctuation, other) and the top-N most frequent characters with counts and percentages. Deterministic, pure CPU.",
    tags: ["frequency", "character", "analysis", "text"],
    discovery: {
      bodyType: "json",
      input: { text: "Hello, World!", top: 5 },
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to analyze" },
          top: {
            type: "integer",
            description: "Number of top characters to return (default 10, max 100)",
          },
        },
        required: ["text"],
      },
      output: {
        example: {
          total: 13,
          unique: 10,
          frequencies: [
            { char: "l", count: 3, percent: 23.08 },
            { char: "o", count: 2, percent: 15.38 },
          ],
          categories: { letters: 10, digits: 0, spaces: 1, punctuation: 2, other: 0 },
        },
      },
    },
    handler(input) {
      if (typeof input.text !== "string") throw bad('Missing or invalid "text"');
      if (!input.text.length) throw bad('"text" must not be empty');

      let top = input.top !== undefined ? Number(input.top) : 10;
      if (!Number.isFinite(top) || top < 1) top = 10;
      if (top > 100) top = 100;

      const freq = {};
      const categories = { letters: 0, digits: 0, spaces: 0, punctuation: 0, other: 0 };
      const total = input.text.length;

      for (const ch of input.text) {
        freq[ch] = (freq[ch] || 0) + 1;

        if (/[a-zA-Z]/.test(ch)) categories.letters++;
        else if (/[0-9]/.test(ch)) categories.digits++;
        else if (/\s/.test(ch)) categories.spaces++;
        else if (/[^\w\s]/.test(ch)) categories.punctuation++;
        else categories.other++;
      }

      const sorted = Object.entries(freq)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, top)
        .map(([char, count]) => ({
          char,
          count,
          percent: Math.round((count / total) * 10000) / 100,
        }));

      return {
        total,
        unique: Object.keys(freq).length,
        frequencies: sorted,
        categories,
      };
    },
  },

  // 5. Word wrap
  {
    route: "POST /api/word-wrap",
    name: "Word wrap",
    slug: "word-wrap",
    category: "text",
    price: "$0.001",
    description:
      "Wrap text to a specified column width, breaking at word boundaries. Words longer than the width are forcibly broken. An optional indent string is prepended to each line. Deterministic, pure CPU.",
    tags: ["wrap", "text", "format", "column"],
    discovery: {
      bodyType: "json",
      input: { text: "The quick brown fox jumps over the lazy dog.", width: 20 },
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to wrap" },
          width: {
            type: "integer",
            description: "Maximum line width in characters (default 80, max 500)",
          },
          indent: {
            type: "string",
            description: 'String to prepend to each line (default "")',
          },
        },
        required: ["text"],
      },
      output: {
        example: {
          result: "The quick brown fox\njumps over the lazy\ndog.",
          lines: 3,
          longestLine: 19,
        },
      },
    },
    handler(input) {
      if (typeof input.text !== "string") throw bad('Missing or invalid "text"');

      let width = input.width !== undefined ? Number(input.width) : 80;
      if (!Number.isFinite(width) || width < 1) width = 80;
      if (width > 500) width = 500;

      const indent = typeof input.indent === "string" ? input.indent : "";
      const effectiveWidth = Math.max(width - indent.length, 1);

      const paragraphs = input.text.split("\n");
      const outputLines = [];

      for (const para of paragraphs) {
        const words = para.split(/\s+/).filter(Boolean);
        if (!words.length) {
          outputLines.push(indent);
          continue;
        }

        let line = "";
        for (const word of words) {
          if (word.length > effectiveWidth) {
            // Flush current line if non-empty
            if (line) {
              outputLines.push(indent + line);
              line = "";
            }
            // Break the long word into chunks
            for (let i = 0; i < word.length; i += effectiveWidth) {
              const chunk = word.slice(i, i + effectiveWidth);
              if (i + effectiveWidth < word.length) {
                outputLines.push(indent + chunk);
              } else {
                line = chunk;
              }
            }
          } else if (!line) {
            line = word;
          } else if (line.length + 1 + word.length <= effectiveWidth) {
            line += " " + word;
          } else {
            outputLines.push(indent + line);
            line = word;
          }
        }
        if (line) outputLines.push(indent + line);
      }

      const result = outputLines.join("\n");
      let longestLine = 0;
      for (const l of outputLines) {
        if (l.length > longestLine) longestLine = l.length;
      }

      return {
        result,
        lines: outputLines.length,
        longestLine,
      };
    },
  },
];
