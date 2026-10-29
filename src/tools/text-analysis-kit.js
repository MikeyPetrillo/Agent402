// Text-analysis kit — readability scores. Pure-CPU, no network, no LLM — proof-of-work eligible.
// Covered by scripts/test-text-analysis-kit.js.

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// ---------------------------------------------------------------------------
// Syllable counter (simple English heuristic): count vowel groups, subtract
// silent-e, floor at 1.
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return /\d/.test(word) ? 1 : 0; // a numeric token is ~1 syllable, not 0 (kept Flesch off-scale)
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




];
