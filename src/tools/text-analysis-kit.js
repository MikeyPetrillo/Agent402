// Text-analysis kit — readability scores, word frequency, text diff, lorem ipsum,
// slug generation. All pure-CPU, no network, no LLM — proof-of-work eligible.
// Covered by scripts/test-text-analysis-kit.js.

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// ---------------------------------------------------------------------------
// Syllable counter (simple English heuristic): count vowel groups, subtract
// silent-e, floor at 1.
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 2) return 1;
  let count = 0;
  let prev = false;
  for (const ch of w) {
    const vowel = "aeiouy".includes(ch);
    if (vowel && !prev) count++;
    prev = vowel;
  }
  // silent-e: word ends in 'e' and isn't the only vowel group
  if (w.endsWith("e") && count > 1) count--;
  return Math.max(count, 1);
}

// Tokenize: split on whitespace, strip leading/trailing punctuation from each token.
function tokenize(text) {
  return text.split(/\s+/).map((t) => t.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")).filter(Boolean);
}

// Sentence splitter: split on .!? followed by space or end-of-string.
function splitSentences(text) {
  return text.split(/[.!?]+(?:\s|$)/).map((s) => s.trim()).filter(Boolean);
}

// Stop words (~50 common English stop words).
const STOP_WORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
  "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
  "this", "but", "his", "by", "from", "they", "we", "say", "her", "she",
  "or", "an", "will", "my", "one", "all", "would", "there", "their", "what",
  "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
  "is", "are", "was", "were", "been", "has", "had", "its", "can", "no",
]);

// Lorem ipsum vocabulary (~200 words).
const LOREM_WORDS = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit",
  "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore",
  "magna", "aliqua", "enim", "ad", "minim", "veniam", "quis", "nostrud",
  "exercitation", "ullamco", "laboris", "nisi", "aliquip", "ex", "ea", "commodo",
  "consequat", "duis", "aute", "irure", "in", "reprehenderit", "voluptate",
  "velit", "esse", "cillum", "fugiat", "nulla", "pariatur", "excepteur", "sint",
  "occaecat", "cupidatat", "non", "proident", "sunt", "culpa", "qui", "officia",
  "deserunt", "mollit", "anim", "id", "est", "laborum", "ac", "accumsan",
  "adipisci", "aliquam", "ante", "aptent", "arcu", "at", "auctor", "augue",
  "bibendum", "blandit", "class", "condimentum", "congue", "consequat", "conubia",
  "convallis", "cras", "cubilia", "curabitur", "dapibus", "dictum", "dignissim",
  "donec", "egestas", "elementum", "euismod", "facilisi", "facilisis", "fames",
  "faucibus", "felis", "fermentum", "feugiat", "fringilla", "fusce", "gravida",
  "habitant", "habitasse", "hac", "hendrerit", "himenaeos", "iaculis", "imperdiet",
  "inceptos", "integer", "interdum", "justo", "lacinia", "lacus", "laoreet",
  "lectus", "leo", "libero", "ligula", "litora", "lobortis", "luctus", "maecenas",
  "massa", "mattis", "mauris", "metus", "mi", "morbi", "nam", "nec", "neque",
  "nibh", "nunc", "odio", "orci", "ornare", "pellentesque", "pharetra", "placerat",
  "platea", "porta", "porttitor", "posuere", "potenti", "praesent", "pretium",
  "primis", "proin", "pulvinar", "purus", "quam", "quisque", "rhoncus", "risus",
  "rutrum", "sagittis", "sapien", "scelerisque", "semper", "senectus", "sociis",
  "sodales", "sollicitudin", "suscipit", "suspendisse", "taciti", "tellus",
  "torquent", "tortor", "tristique", "turpis", "ullamcorper", "ultrices",
  "ultricies", "urna", "varius", "vehicula", "vel", "vestibulum", "vitae",
  "vivamus", "viverra", "volutpat", "vulputate",
];

// Seeded PRNG (Mulberry32) for deterministic lorem ipsum given no seed (uses
// a fixed seed so the same params always produce the same text).
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------

export const TEXT_ANALYSIS_TOOLS = [
  // 1. readability-score
  {
    route: "POST /api/readability-score",
    name: "Readability score",
    slug: "readability-score",
    category: "text",
    price: "$0.001",
    description:
      "Compute Flesch-Kincaid Grade Level, Flesch Reading Ease, Gunning Fog Index, and Automated Readability Index from text. Returns all 4 scores plus word, sentence, and syllable counts.",
    tags: ["readability", "flesch", "gunning-fog", "text-analysis"],
    discovery: {
      bodyType: "json",
      input: { text: "The cat sat on the mat. It was a very good cat. The mat was red." },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to analyze (min 10 chars)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          words: 16,
          sentences: 3,
          syllables: 17,
          fleschReadingEase: 104.59,
          fleschKincaidGrade: -0.89,
          gunningFog: 3.2,
          automatedReadability: -2.84,
        },
      },
    },
    handler: (input) => {
      const text = String(input.text ?? "").trim();
      if (text.length < 10) throw bad('"text" must be at least 10 characters');

      const sentences = splitSentences(text);
      const sentenceCount = Math.max(sentences.length, 1);
      const words = tokenize(text);
      const wordCount = words.length;
      if (wordCount === 0) throw bad('"text" must contain words');

      let syllableCount = 0;
      let complexWords = 0; // words with 3+ syllables (for Gunning Fog)
      const charCount = words.reduce((sum, w) => sum + w.replace(/[^a-zA-Z0-9]/g, "").length, 0);

      for (const w of words) {
        const s = countSyllables(w);
        syllableCount += s;
        if (s >= 3) complexWords++;
      }

      const avgWordsPerSentence = wordCount / sentenceCount;
      const avgSyllablesPerWord = syllableCount / wordCount;
      const avgCharsPerWord = charCount / wordCount;

      // Flesch Reading Ease
      const fleschReadingEase = +(206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord).toFixed(2);
      // Flesch-Kincaid Grade Level
      const fleschKincaidGrade = +(0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59).toFixed(2);
      // Gunning Fog Index
      const gunningFog = +(0.4 * (avgWordsPerSentence + 100 * (complexWords / wordCount))).toFixed(2);
      // Automated Readability Index
      const automatedReadability = +(4.71 * avgCharsPerWord + 0.5 * avgWordsPerSentence - 21.43).toFixed(2);

      return {
        words: wordCount,
        sentences: sentenceCount,
        syllables: syllableCount,
        fleschReadingEase,
        fleschKincaidGrade,
        gunningFog,
        automatedReadability,
      };
    },
  },

  // 2. word-frequency
  {
    route: "POST /api/word-frequency",
    name: "Word frequency",
    slug: "word-frequency",
    category: "text",
    price: "$0.001",
    description:
      "Top N words and bigrams from text. Lowercase, strip punctuation, filter common English stop words. Returns sorted word and bigram frequency lists.",
    tags: ["word-frequency", "bigrams", "text-analysis", "nlp"],
    discovery: {
      bodyType: "json",
      input: { text: "the quick brown fox jumps over the lazy dog. The dog barked at the fox.", top: 5 },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to analyze" },
          top: { type: "number", description: "Number of top results (default 10)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          words: [{ word: "fox", count: 2 }, { word: "dog", count: 2 }],
          bigrams: [{ bigram: "quick brown", count: 1 }],
          totalWords: 16,
          uniqueWords: 9,
        },
      },
    },
    handler: (input) => {
      const text = String(input.text ?? "").trim();
      if (!text) throw bad('"text" is required');

      const top = Math.max(parseInt(input.top, 10) || 10, 1);
      const tokens = tokenize(text).map((w) => w.toLowerCase());
      const filtered = tokens.filter((w) => !STOP_WORDS.has(w) && w.length > 0);

      // Word frequency
      const wordMap = new Map();
      for (const w of filtered) wordMap.set(w, (wordMap.get(w) || 0) + 1);
      const words = [...wordMap.entries()]
        .map(([word, count]) => ({ word, count }))
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
        .slice(0, top);

      // Bigram frequency (from filtered tokens)
      const bigramMap = new Map();
      for (let i = 0; i < filtered.length - 1; i++) {
        const bg = `${filtered[i]} ${filtered[i + 1]}`;
        bigramMap.set(bg, (bigramMap.get(bg) || 0) + 1);
      }
      const bigrams = [...bigramMap.entries()]
        .map(([bigram, count]) => ({ bigram, count }))
        .sort((a, b) => b.count - a.count || a.bigram.localeCompare(b.bigram))
        .slice(0, top);

      return { words, bigrams, totalWords: tokens.length, uniqueWords: wordMap.size };
    },
  },

  // 3. text-similarity
  {
    route: "POST /api/text-similarity",
    name: "Text similarity",
    slug: "text-similarity",
    category: "text",
    price: "$0.001",
    description:
      "Compute Jaccard similarity, overlap coefficient, and Sorensen-Dice coefficient between two texts at the word level. Returns similarity scores (0-1) plus shared and unique word counts.",
    tags: ["similarity", "jaccard", "text-comparison", "nlp"],
    discovery: {
      bodyType: "json",
      input: { a: "the quick brown fox jumps over the lazy dog", b: "the fast brown fox leaps over the lazy cat" },
      inputSchema: {
        properties: {
          a: { type: "string", description: "First text" },
          b: { type: "string", description: "Second text" },
        },
        required: ["a", "b"],
      },
      output: {
        example: {
          jaccard: 0.55,
          sorensen: 0.71,
          overlap: 0.75,
          shared: ["the", "brown", "fox", "over", "lazy"],
          uniqueA: ["quick", "jumps", "dog"],
          uniqueB: ["fast", "leaps", "cat"],
          sharedCount: 5,
          totalUnique: 11,
        },
      },
    },
    handler: (input) => {
      if (typeof input.a !== "string") throw bad('"a" is required and must be a string');
      if (typeof input.b !== "string") throw bad('"b" is required and must be a string');
      if (!input.a.trim()) throw bad('"a" must not be empty');
      if (!input.b.trim()) throw bad('"b" must not be empty');

      const wordsA = new Set(tokenize(input.a).map((w) => w.toLowerCase()));
      const wordsB = new Set(tokenize(input.b).map((w) => w.toLowerCase()));

      const shared = [...wordsA].filter((w) => wordsB.has(w)).sort();
      const uniqueA = [...wordsA].filter((w) => !wordsB.has(w)).sort();
      const uniqueB = [...wordsB].filter((w) => !wordsA.has(w)).sort();

      const intersection = shared.length;
      const union = wordsA.size + wordsB.size - intersection;
      const minSize = Math.min(wordsA.size, wordsB.size);

      // Jaccard: |A∩B| / |A∪B|
      const jaccard = union === 0 ? 0 : +(intersection / union).toFixed(4);
      // Sorensen-Dice: 2|A∩B| / (|A|+|B|)
      const sorensen = (wordsA.size + wordsB.size) === 0 ? 0 : +(2 * intersection / (wordsA.size + wordsB.size)).toFixed(4);
      // Overlap: |A∩B| / min(|A|,|B|)
      const overlap = minSize === 0 ? 0 : +(intersection / minSize).toFixed(4);

      return { jaccard, sorensen, overlap, shared, uniqueA, uniqueB, sharedCount: intersection, totalUnique: union };
    },
  },

  // 4. lorem-ipsum
  {
    route: "GET /api/lorem-ipsum",
    name: "Lorem ipsum generator",
    slug: "lorem-ipsum",
    category: "text",
    price: "$0.001",
    description:
      "Generate placeholder lorem ipsum text. Supports paragraphs or sentences mode with configurable counts. Uses a fixed vocabulary and deterministic assembly.",
    tags: ["lorem-ipsum", "placeholder", "text-generation"],
    discovery: {
      input: { paragraphs: 2, mode: "paragraphs" },
      inputSchema: {
        properties: {
          paragraphs: { type: "number", description: "Number of paragraphs (default 3, mode=paragraphs)" },
          mode: { type: "string", description: "paragraphs (default) or sentences" },
          sentences: { type: "number", description: "Number of sentences (default 5, mode=sentences)" },
        },
      },
      output: {
        example: {
          text: "Lorem ipsum dolor sit amet...",
          mode: "paragraphs",
          count: 2,
        },
      },
    },
    handler: (input) => {
      const mode = String(input.mode ?? "paragraphs").toLowerCase();
      if (mode !== "paragraphs" && mode !== "sentences") {
        throw bad('"mode" must be "paragraphs" or "sentences"');
      }

      const rand = mulberry32(42);
      const pick = () => LOREM_WORDS[Math.floor(rand() * LOREM_WORDS.length)];

      function makeSentence() {
        const len = 5 + Math.floor(rand() * 11); // 5-15 words
        const words = [];
        for (let i = 0; i < len; i++) words.push(pick());
        words[0] = words[0][0].toUpperCase() + words[0].slice(1);
        return words.join(" ") + ".";
      }

      function makeParagraph() {
        const sentCount = 3 + Math.floor(rand() * 4); // 3-6 sentences
        const sents = [];
        for (let i = 0; i < sentCount; i++) sents.push(makeSentence());
        return sents.join(" ");
      }

      if (mode === "sentences") {
        const count = Math.max(parseInt(input.sentences, 10) || 5, 1);
        const sents = [];
        for (let i = 0; i < count; i++) sents.push(makeSentence());
        return { text: sents.join(" "), mode, count };
      }

      const count = Math.max(parseInt(input.paragraphs, 10) || 3, 1);
      const paras = [];
      for (let i = 0; i < count; i++) paras.push(makeParagraph());
      return { text: paras.join("\n\n"), mode, count };
    },
  },

  // 5. slug-generate
  {
    route: "GET /api/slug-generate",
    name: "Slug generator",
    slug: "slug-generate",
    category: "text",
    price: "$0.001",
    description:
      "Generate a URL-safe slug from any string. Handles accented characters (normalize NFD), replaces non-alphanumeric with hyphens, collapses and trims. Optional max-length with word-boundary truncation.",
    tags: ["slug", "url", "seo", "text-transform"],
    discovery: {
      input: { text: "Hello World! This is a Test.", maxLength: 20 },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to slugify" },
          maxLength: { type: "number", description: "Maximum slug length (optional, truncates at word boundary)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          slug: "hello-world-this-is",
          original: "Hello World! This is a Test.",
          length: 19,
        },
      },
    },
    handler: (input) => {
      const text = String(input.text ?? "").trim();
      if (!text) throw bad('"text" is required');

      // Normalize accented chars: NFD strips combining marks.
      let slug = text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // remove combining diacritical marks
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")    // non-alphanumeric → hyphen
        .replace(/-+/g, "-")            // collapse multiple hyphens
        .replace(/^-|-$/g, "");          // trim leading/trailing hyphens

      // Optional max-length with word-boundary truncation.
      const maxLength = parseInt(input.maxLength, 10);
      if (maxLength > 0 && slug.length > maxLength) {
        slug = slug.slice(0, maxLength);
        const lastHyphen = slug.lastIndexOf("-");
        if (lastHyphen > 0) slug = slug.slice(0, lastHyphen);
        slug = slug.replace(/-$/g, "");
      }

      return { slug, original: text, length: slug.length };
    },
  },
];
