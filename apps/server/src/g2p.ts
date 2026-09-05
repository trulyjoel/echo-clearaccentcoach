import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { phonemize } = require("phonemize") as typeof import("phonemize");

/** One transcript word and its canonical (target-accent) ARPAbet phones, stress-digit-free to
 * match HuPER's phone convention. */
export interface CanonicalWord {
  word: string;
  phones: string[];
}

/** Matches runs of word characters and apostrophes (so contractions like "don't" stay one word),
 * discarding surrounding punctuation — `phonemize` would otherwise treat punctuation as its own
 * token. */
const WORD_PATTERN = /[\p{L}\p{N}']+/gu;

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
    }) as Array<{ phoneme: string; word: string; position: number }>;
    const phoneStr = result[0]?.phoneme ?? "";
    const phones = phoneStr.split(" ").filter((p) => p.length > 0);
    return {
      word,
      phones,
    };
  });
}
