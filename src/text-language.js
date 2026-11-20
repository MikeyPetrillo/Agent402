// A cheap language guess for a transcript whose upstream answer named no
// language (the json response format of the transcription model carries only
// the text). Counts common function words of a few languages and answers an
// ISO-639-1 code only when one language clearly leads; otherwise null, so a
// caller never reads a guess the words do not support. Pure CPU, bounded: it
// reads at most the first MAX_WORDS words.

const MAX_WORDS = 400;
const MIN_HITS = 3;
const STOPWORDS = {
  en: "the and is are was were you this that with for have not but what can be of to it in on we they there so",
  es: "el la los las y es son que de en un una por para con no pero muy lo se del al como esta este",
  fr: "le la les et est sont que de des un une pour avec ne pas mais tres il elle nous vous ce cette du au",
  de: "der die das und ist sind nicht ein eine mit fur auf aber sehr ich du wir sie es zu den dem des auch",
  it: "il lo la gli le e sono che di un una per con non ma molto io tu noi voi del della questo questa",
  pt: "o a os as e que de em um uma para com nao mas muito eu voce nos eles do da isso este esta",
  nl: "de het een en is zijn niet met voor op maar zeer ik jij wij zij dat dit van te ook",
};
const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(" "))]));

/** @returns {string|null} an ISO-639-1 code, or null when no language clearly leads. */
export function guessTextLanguage(text) {
  if (typeof text !== "string" || !text) return null;
  const words = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z]+/g);
  if (!words) return null;
  const counts = Object.fromEntries(Object.keys(SETS).map((k) => [k, 0]));
  for (const w of words.slice(0, MAX_WORDS)) for (const k in SETS) if (SETS[k].has(w)) counts[k]++;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [[best, top], [, second]] = ranked;
  return top >= MIN_HITS && top >= 1.5 * second ? best : null;
}

/** The answer's language: the upstream's own, else the caller's hint (the
 *  model was told that language), else a guess from the transcript, else null. */
export function answerLanguage(upstream, hint, text) {
  if (typeof upstream === "string" && upstream) return upstream;
  if (typeof hint === "string" && /^[a-z]{2,3}$/i.test(hint.trim())) return hint.trim().toLowerCase();
  return guessTextLanguage(text);
}
