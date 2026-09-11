import { phonemize } from "phonemizer";

/** One transcript word and its canonical (target-accent) ARPAbet phones, stress-digit-free and
 * restricted to HuPER's 39-phone vocabulary (verified against the installed model's tokenizer). */
export interface CanonicalWord {
  word: string;
  phones: string[];
}

/** Matches runs of word characters and apostrophes (so contractions like "don't" stay one word),
 * discarding surrounding punctuation — `phonemizer` would otherwise treat punctuation as its own
 * token. */
const WORD_PATTERN = /[\p{L}\p{N}']+/gu;

/** HuPER's Recognizer only recognizes these 39 phones (excluding special tokens like `<PAD>`/
 * `<UNK>`), verified directly against the installed model's tokenizer — notably no `AO`, but does
 * include the flap allophone `DX`. */
export const HUPER_VALID_PHONES = new Set([
  "AA", "AE", "AH", "AW", "AY", "B", "CH", "D", "DH", "DX", "EH", "ER", "EY", "F", "G", "HH", "IH",
  "IY", "JH", "K", "L", "M", "N", "NG", "OW", "OY", "P", "R", "S", "SH", "T", "TH", "UH", "UW", "V",
  "W", "Y", "Z", "ZH",
]);

/** IPA symbol (as emitted by `phonemizer`, a WASM build of real espeak-ng) -> HuPER-valid ARPAbet
 * phone(s). The 39 single-phone entries are the exact inverse of
 * `apps/pronunciation-service/arpabet_to_ipa.py`'s `ARPABET_TO_IPA` table — that table is the
 * source of truth for the ARPAbet<->IPA correspondence shared with the comparison model, so keep
 * the two in sync. The remaining entries cover espeak-ng symbols with no ARPAbet source phone:
 * reduced vowels, a glottal-stop /t/ allophone, and cot-caught/NURSE vowel spelling variants. */
const IPA_TO_ARPABET: Record<string, string[]> = {
  ɑː: ["AA"], æ: ["AE"], ʌ: ["AH"], aʊ: ["AW"], aɪ: ["AY"], b: ["B"],
  tʃ: ["CH"], d: ["D"], ð: ["DH"], ɾ: ["DX"], ɛ: ["EH"], ɚ: ["ER"],
  eɪ: ["EY"], f: ["F"], ɡ: ["G"], h: ["HH"], ɪ: ["IH"], iː: ["IY"],
  dʒ: ["JH"], k: ["K"], l: ["L"], m: ["M"], n: ["N"], ŋ: ["NG"],
  oʊ: ["OW"], ɔɪ: ["OY"], p: ["P"], ɹ: ["R"], s: ["S"], ʃ: ["SH"],
  t: ["T"], θ: ["TH"], ʊ: ["UH"], uː: ["UW"], v: ["V"], w: ["W"],
  j: ["Y"], z: ["Z"], ʒ: ["ZH"],
  ə: ["AH"], // reduced schwa
  ᵻ: ["IH"], // espeak's "barred i" — reduced /ɪ/
  ʔ: ["T"], // glottal-stop realization of /t/ (e.g. "cotton")
  ɔː: ["AA"], // /ɔ/ (cot-caught merger, same as HuPER folding AO into AA)
  ɜː: ["ER"], // NURSE vowel spelled without its rhotic glide (e.g. "world")
  i: ["IY"], // unstressed short "happY" vowel (e.g. word-final "-y" in "very")
  // espeak shortens a long vowel's citation form (no "ː") in some unstressed/less-prominent
  // syllables (e.g. "stronger" -> "stɹɔŋɡɚ", not "...ɔːŋ...") — same vowel, same ARPAbet target.
  ɑ: ["AA"],
  u: ["UW"],
  ɔ: ["AA"],
  ɜ: ["ER"],
  ɐ: ["AH"], // another reduced/near-schwa vowel espeak uses in unstressed syllables (e.g. "along")
  oː: ["AA"], // NORTH/FORCE vowel before /r/ (e.g. "more") — monophthongal, not the OW diphthong
};

/** Sorted longest-symbol-first so multi-character IPA symbols (diphthongs, affricates, long
 * vowels) match before any single-character symbol that happens to be their prefix. */
const IPA_SYMBOLS = Object.keys(IPA_TO_ARPABET).sort((a, b) => b.length - a.length);

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
      throw new Error(`No ARPAbet mapping for IPA symbol in "${cleaned}" at index ${i}`);
    }
    phones.push(...IPA_TO_ARPABET[symbol]!);
    i += symbol.length;
  }
  return phones;
}

/**
 * G2P's the turn's transcript into a word-aligned canonical ARPAbet phone sequence, used as the
 * "expected" reference the pronunciation-scoring service diffs the actual audio against.
 * `phonemizer` is called once per word — not once per transcript — so a numeral or other
 * multi-token expansion (e.g. "1995" -> "nineteen hundred ninety five") still resolves to exactly
 * one `CanonicalWord`, keeping phones word-index-aligned with the transcript for the caller.
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
