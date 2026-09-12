import { phonemize } from "phonemizer";

/** One transcript word and its canonical (target-accent) IPA phones, stress-digit-free and
 * restricted to facebook/wav2vec2-xlsr-53-espeak-cv-ft's vocabulary (verified against that
 * model's vocab.json). */
export interface CanonicalWord {
  word: string;
  phones: string[];
}

/** Matches runs of word characters and apostrophes (so contractions like "don't" stay one word),
 * discarding surrounding punctuation — `phonemizer` would otherwise treat punctuation as its own
 * token. */
const WORD_PATTERN = /[\p{L}\p{N}']+/gu;

/** facebook/wav2vec2-xlsr-53-espeak-cv-ft's Recognizer only recognizes these 39 phones (excluding
 * special tokens like `<pad>`/`<unk>`) — the subset of its 392-symbol vocabulary that
 * `IPA_TO_CANONICAL` ever targets. */
export const CANONICAL_VALID_PHONES = new Set([
  "aɪ", "aʊ", "b", "d", "dʒ", "eɪ", "f", "h", "iː", "j", "k", "l", "m", "n", "oʊ", "p", "s", "t",
  "tʃ", "uː", "v", "w", "z", "æ", "ð", "ŋ", "ɑː", "ɔɪ", "ɚ", "ɛ", "ɡ", "ɪ", "ɹ", "ɾ", "ʃ", "ʊ", "ʌ",
  "ʒ", "θ",
]);

/** IPA symbol (as emitted by `phonemizer`, a WASM build of real espeak-ng) -> its canonical
 * wav2vec2-xlsr-53-espeak-cv-ft target symbol. The 39 entries whose key equals its value are pure
 * vocabulary membership checks (espeak already spells them the way the recognizer expects). The
 * remaining entries collapse espeak-ng symbols with no direct wav2vec2 target of their own onto
 * the nearest American-English accent target: reduced vowels, a glottal-stop /t/ allophone, and
 * cot-caught/NURSE vowel spelling variants. */
const IPA_TO_CANONICAL: Record<string, string> = {
  ɑː: "ɑː", æ: "æ", ʌ: "ʌ", aʊ: "aʊ", aɪ: "aɪ", b: "b",
  tʃ: "tʃ", d: "d", ð: "ð", ɾ: "ɾ", ɛ: "ɛ", ɚ: "ɚ",
  eɪ: "eɪ", f: "f", ɡ: "ɡ", h: "h", ɪ: "ɪ", iː: "iː",
  dʒ: "dʒ", k: "k", l: "l", m: "m", n: "n", ŋ: "ŋ",
  oʊ: "oʊ", ɔɪ: "ɔɪ", p: "p", ɹ: "ɹ", s: "s", ʃ: "ʃ",
  t: "t", θ: "θ", ʊ: "ʊ", uː: "uː", v: "v", w: "w",
  j: "j", z: "z", ʒ: "ʒ",
  ə: "ʌ", // reduced schwa
  ᵻ: "ɪ", // espeak's "barred i" — reduced /ɪ/
  ʔ: "t", // glottal-stop realization of /t/ (e.g. "cotton")
  ɔː: "ɑː", // /ɔ/ (cot-caught merger)
  ɜː: "ɚ", // NURSE vowel spelled without its rhotic glide (e.g. "world")
  i: "iː", // unstressed short "happY" vowel (e.g. word-final "-y" in "very")
  // espeak shortens a long vowel's citation form (no "ː") in some unstressed/less-prominent
  // syllables (e.g. "stronger" -> "stɹɔŋɡɚ", not "...ɔːŋ...") — same vowel, same target.
  ɑ: "ɑː",
  u: "uː",
  ɔ: "ɑː",
  ɜ: "ɚ",
  ɐ: "ʌ", // another reduced/near-schwa vowel espeak uses in unstressed syllables (e.g. "along")
  oː: "ɑː", // NORTH/FORCE vowel before /r/ (e.g. "more") — monophthongal, not the OW diphthong
};

/** Sorted longest-symbol-first so multi-character IPA symbols (diphthongs, affricates, long
 * vowels) match before any single-character symbol that happens to be their prefix. */
const IPA_SYMBOLS = Object.keys(IPA_TO_CANONICAL).sort((a, b) => b.length - a.length);

/** Combining vertical line below (U+0329) — espeak's syllabicity diacritic, e.g. "cotton" ->
 * "kˈɑːʔn̩". Rewritten to an explicit preceding schwa before tokenizing, matching how espeak
 * already spells syllabic L directly as schwa + consonant (e.g. "little" -> "lˈɪɾəl") rather than
 * a diacritic. */
const SYLLABIC_MARK = /(.)̩/gu;

function tokenizeIpa(ipa: string): string[] {
  const cleaned = ipa.replace(/[ˈˌ]/gu, "").replace(SYLLABIC_MARK, "ə$1");
  const phones: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    if (cleaned[i] === " ") {
      i += 1;
      continue;
    }
    const symbol = IPA_SYMBOLS.find((s) => cleaned.startsWith(s, i));
    if (!symbol) {
      throw new Error(`No canonical-phone mapping for IPA symbol in "${cleaned}" at index ${i}`);
    }
    phones.push(IPA_TO_CANONICAL[symbol]!);
    i += symbol.length;
  }
  return phones;
}

/**
 * G2P's the turn's transcript into a word-aligned canonical IPA phone sequence (wav2vec2's own
 * vocabulary), used as the "expected" reference the pronunciation-scoring service diffs the actual
 * audio against. `phonemizer` is called once per word — not once per transcript — so a numeral or
 * other multi-token expansion (e.g. "1995" -> "nineteen hundred ninety five") still resolves to
 * exactly one `CanonicalWord`, keeping phones word-index-aligned with the transcript for the
 * caller.
 */
export async function g2p(transcript: string): Promise<CanonicalWord[]> {
  const words = transcript.match(WORD_PATTERN) ?? [];
  const canonicalWords: CanonicalWord[] = [];
  for (const word of words) {
    const [ipa] = await phonemize(word, "en-us");
    canonicalWords.push({ word, phones: tokenizeIpa(ipa ?? "") });
  }
  return canonicalWords;
}
