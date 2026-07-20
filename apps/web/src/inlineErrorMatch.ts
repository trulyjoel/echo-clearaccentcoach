import type { PersistedError } from "@callie/types";

export interface MatchedSpan {
  start: number;
  end: number;
  error: PersistedError;
}

/**
 * Finds where each error's flagged text appears verbatim in the turn's rendered text, in
 * left-to-right order and without overlapping spans. An error whose text can't be found at all,
 * or only in a spot that would overlap an earlier match, is simply omitted here — it stays fully
 * visible in the corrections panel, just without an inline highlight.
 */
export function matchFlaggedSpans(text: string, errors: readonly PersistedError[]): MatchedSpan[] {
  const matches: MatchedSpan[] = [];
  for (const error of errors) {
    if (!error.original) continue;
    let searchFrom = 0;
    while (searchFrom <= text.length) {
      const start = text.indexOf(error.original, searchFrom);
      if (start === -1) break;
      const end = start + error.original.length;
      const overlaps = matches.some((match) => start < match.end && end > match.start);
      if (!overlaps) {
        matches.push({ start, end, error });
        break;
      }
      searchFrom = start + 1;
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

export interface TextSegment {
  text: string;
  error?: PersistedError;
}

/** Splits `text` into plain and flagged segments per `matches`, for rendering. */
export function splitIntoSegments(text: string, matches: readonly MatchedSpan[]): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start) });
    segments.push({ text: text.slice(match.start, match.end), error: match.error });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
