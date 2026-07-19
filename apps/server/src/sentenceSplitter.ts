/**
 * A sentence boundary is terminal punctuation (., !, or ?, possibly repeated, e.g. "?!") followed
 * by whitespace. The trailing whitespace requirement is deliberate: punctuation at the very end of
 * the buffer might just be a delta boundary mid-abbreviation/decimal (e.g. "3." before "14"
 * arrives), not a real sentence end, so it's held back as remainder until more text confirms it.
 */
const SENTENCE_BOUNDARY = /[.!?]+["')\]]*\s+/g;

export interface SplitSentencesResult {
  /** Complete sentences extracted from `buffer`, in order, trimmed. */
  sentences: string[];
  /** Trailing text after the last complete sentence, not yet known to be terminated. */
  remainder: string;
}

/** Extracts every complete sentence from the front of `buffer`, leaving any tail as remainder. */
export function splitSentences(buffer: string): SplitSentencesResult {
  const sentences: string[] = [];
  let lastIndex = 0;
  for (const match of buffer.matchAll(SENTENCE_BOUNDARY)) {
    const end = match.index + match[0].length;
    sentences.push(buffer.slice(lastIndex, end).trim());
    lastIndex = end;
  }
  return { sentences, remainder: buffer.slice(lastIndex) };
}
