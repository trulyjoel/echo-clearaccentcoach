import { createRequire } from "module";
// A plain `import { phonemize } from "phonemize"` throws `ERR_IMPORT_ATTRIBUTE_MISSING` on Node 26
// (this repo's runtime): the package's bundled `anyascii.json` import lacks a `type: "json"`
// import attribute. Loading it via `require` instead sidesteps ESM import-attribute enforcement.
const require = createRequire(import.meta.url);
const { phonemize } = require("phonemize") as typeof import("phonemize");

/** One transcript word and its canonical (target-accent) ARPAbet phones, stress-digit-free and
 * restricted to HuPER's 39-phone vocabulary (verified against the installed model's tokenizer). */
export interface CanonicalWord {
  word: string;
  phones: string[];
}

/** Matches runs of word characters and apostrophes (so contractions like "don't" stay one word),
 * discarding surrounding punctuation — `phonemize` would otherwise treat punctuation as its own
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

/** `phonemize` emits a number of extended-ARPAbet symbols outside HuPER's 39-phone vocabulary
 * (verified directly against the installed `phonemize` package by running its en-US G2P over a
 * ~40k-word English sample and diffing the resulting symbol set against `HUPER_VALID_PHONES`).
 * Each entry maps a `phonemize` output to the HuPER-valid phone(s) it corresponds to, chosen from
 * that symbol's own IPA definition in `phonemize`'s ARPABET_TO_IPA table. `SAW` is the most
 * consequential: `phonemize` never emits the standard `AO` symbol for the /ɔ/ vowel (its
 * IPA<->ARPAbet reverse-mapping table happens to prefer `SAW` for that IPA symbol) — this is the
 * same vowel HuPER folds into `AA` (cot-caught merger) rather than keeping as a separate `AO`. */
const PHONE_NORMALIZATION: Record<string, string[]> = {
  AX: ["AH"], // reduced schwa -> nearest HuPER vowel
  AXR: ["ER"], // r-colored schwa (e.g. "-er" in "teacher") -> unstressed ER
  EL: ["AH", "L"], // syllabic L (e.g. "little") -> vowel + consonant
  IN: ["IH", "N"], // reduced -ing/-in nasal -> vowel + nasal
  EN: ["AH", "N"], // reduced -en/-on nasal (e.g. "cotton") -> vowel + nasal
  UN: ["UH", "N"], // reduced -un nasal -> vowel + nasal
  SAW: ["AA"], // phonemize's alias for the AO (/ɔ/) vowel -> HuPER's merged AA
  TS: ["T", "S"], // voiceless affricate cluster (e.g. plural "-s" after a stop) -> stop + fricative
  AB: ["AA", "B"], // rule-based-fallback digraph -> vowel + stop
  UA: ["UW", "AA"], // rule-based-fallback digraph -> vowel + vowel
  UO: ["UW", "OW"], // rule-based-fallback digraph -> vowel + vowel
  UY: ["UW", "IY"], // rule-based-fallback digraph -> vowel + vowel
  YE: ["Y", "EH"], // rule-based-fallback digraph -> glide + vowel
};

function normalizePhone(phone: string): string[] {
  return PHONE_NORMALIZATION[phone] ?? [phone];
}

/**
 * G2P's the turn's transcript into a word-aligned canonical ARPAbet phone sequence, used as the
 * "expected" reference the pronunciation-scoring service diffs the actual audio against.
 * Dictionary words come from `phonemize`'s bundled CMUdict-derived lexicon; out-of-dictionary
 * words (names, coinages) fall through to its rule-based G2P automatically — both paths return
 * through the same call, so this function doesn't need to know which one fired.
 */
export function g2p(transcript: string): CanonicalWord[] {
  const words = transcript.match(WORD_PATTERN) ?? [];
  return words.map((word) => {
    const result = phonemize(word, {
      language: "en-US",
      format: "arpabet",
      stripStress: true,
      returnArray: true,
    });
    // `phonemize` returns one entry per output token, expanding/transliterating during
    // tokenization (e.g. "1995" -> "nineteen"/"ninety"/"five") — every entry's phones must be
    // included, not just the first, or multi-token words get silently truncated.
    const phones = result
      .flatMap((token) => token.phoneme.split(" "))
      // `phonemize` emits the literal string "undefined" for characters it can't map (e.g. some
      // non-Latin scripts) — drop it rather than pass a non-phone token through as a canonical
      // phone.
      .filter((p) => p.length > 0 && p !== "undefined")
      .flatMap(normalizePhone);
    return {
      word,
      phones,
    };
  });
}
