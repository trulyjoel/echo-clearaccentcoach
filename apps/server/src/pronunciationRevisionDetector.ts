import type { DetectedPronunciationError } from "@kalli/types";
import { g2p } from "./g2p.js";

/**
 * Finds words Flux's finalized transcript smoothed over mid-turn: a prior transcript hypothesis
 * for the same turn differed from the final one at a word position, and the two words' canonical
 * phone sequences differ by exactly one substitution — the shape of a real L1-interference swap
 * (e.g. "berry"/"very" for a Spanish speaker's b/v confusion), not unrelated ASR noise.
 * See docs/superpowers/specs/2026-09-05-flux-transcript-revision-detection-design.md.
 */
export function detectAsrSmoothedDeviations(
  finalTranscript: string,
  priorTranscripts: string[],
): DetectedPronunciationError[] {
  const finalWords = g2p(finalTranscript);
  const flaggedIndices = new Set<number>();
  const deviations: DetectedPronunciationError[] = [];

  for (const prior of priorTranscripts) {
    const priorWords = g2p(prior);
    if (priorWords.length !== finalWords.length) continue;

    for (let i = 0; i < finalWords.length; i++) {
      if (flaggedIndices.has(i)) continue;
      const finalWord = finalWords[i];
      const priorWord = priorWords[i];
      if (!finalWord || !priorWord) continue;
      if (finalWord.word.toLowerCase() === priorWord.word.toLowerCase()) continue;

      const substitution = singlePhoneSubstitution(finalWord.phones, priorWord.phones);
      if (!substitution) continue;

      flaggedIndices.add(i);
      deviations.push({
        word: finalWord.word,
        op: "sub",
        expectedPhoneme: substitution.expectedPhoneme,
        spokenPhoneme: substitution.spokenPhoneme,
        source: "transcript_revision",
      });
    }
  }

  return deviations;
}

/**
 * Returns the single differing phone pair if two phone sequences are the same length and differ
 * at exactly one position, or `null` for a different length or more than one differing position —
 * both treated as unrelated ASR noise rather than a pronunciation cue.
 */
function singlePhoneSubstitution(
  finalPhones: string[],
  priorPhones: string[],
): { expectedPhoneme: string; spokenPhoneme: string } | null {
  if (finalPhones.length === 0 || finalPhones.length !== priorPhones.length) return null;

  let diffIndex = -1;
  for (let i = 0; i < finalPhones.length; i++) {
    if (finalPhones[i] !== priorPhones[i]) {
      if (diffIndex !== -1) return null;
      diffIndex = i;
    }
  }
  if (diffIndex === -1) return null;

  const expectedPhoneme = finalPhones[diffIndex];
  const spokenPhoneme = priorPhones[diffIndex];
  if (!expectedPhoneme || !spokenPhoneme) return null;
  return { expectedPhoneme, spokenPhoneme };
}
