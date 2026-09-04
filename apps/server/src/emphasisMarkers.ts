/**
 * Resolves `«word»`-marked text from a streamed LLM reply into ordered segments, each carrying a
 * `plain` form (marker stripped, original casing — used for captions, persistence, and
 * conversation history), a `speechText` form (marker stripped, wrapped word upper-cased — used
 * only to feed TTS), and whether the segment IS the marked word itself. Kalli marks the single
 * word it wants emphasized inline, in its real grammatical position, since post-hoc text search
 * for "which occurrence of a common word" is inherently ambiguous (see correction-word-emphasis
 * spec).
 *
 * `feed()` returns an array rather than one aggregated result per call because a single delta can
 * contain both a sentence boundary and a marker — the caller needs to know which sentence
 * boundaries fall before vs. after the marker to route only the right sentence to
 * higher-quality TTS, not just whether the delta contained a marker somewhere. Splitting at each
 * marker boundary makes that ordering explicit instead of requiring separate position tracking.
 *
 * Upper-casing (rather than a respelling table) is a pure case transform — it never changes
 * string length, so a segment's `plain` and `speechText` stay character-length-identical, which
 * is what lets callers run sentence-splitting on either buffer and get matching boundaries.
 */

const MARKER_OPEN = "«";
const MARKER_CLOSE = "»";

export interface MarkerSegment {
  plain: string;
  speechText: string;
  /** True when this segment is the marked word itself (already upper-cased in `speechText`). */
  emphasized: boolean;
}

export interface MarkerResolver {
  /** Feeds one delta of streamed text, returning ordered segments split at each marker boundary
   * resolved within this delta. Empty when the delta contained no text worth emitting yet (e.g.
   * entirely swallowed into a still-open marker). */
  feed(delta: string): MarkerSegment[];
  /** Call once after the stream ends: flushes an unterminated marker as literal plain text (never
   * `emphasized`, since it was never actually resolved as a marker). */
  flush(): MarkerSegment;
}

/** Each turn gets its own resolver instance — mirrors `sentenceBuffer` being a fresh local per
 * turn in `session.ts`'s reply loop. */
export function createMarkerResolver(): MarkerResolver {
  let insideMarker = false;
  let pendingWord = "";

  function feed(delta: string): MarkerSegment[] {
    const segments: MarkerSegment[] = [];
    let plain = "";
    let i = 0;

    while (i < delta.length) {
      if (!insideMarker) {
        const openIndex = delta.indexOf(MARKER_OPEN, i);
        if (openIndex === -1) {
          plain += delta.slice(i);
          break;
        }
        plain += delta.slice(i, openIndex);
        if (plain) segments.push({ plain, speechText: plain, emphasized: false });
        plain = "";
        insideMarker = true;
        i = openIndex + MARKER_OPEN.length;
      } else {
        const closeIndex = delta.indexOf(MARKER_CLOSE, i);
        if (closeIndex === -1) {
          pendingWord += delta.slice(i);
          break;
        }
        const word = pendingWord + delta.slice(i, closeIndex);
        pendingWord = "";
        insideMarker = false;
        if (word) segments.push({ plain: word, speechText: word.toUpperCase(), emphasized: true });
        i = closeIndex + MARKER_CLOSE.length;
      }
    }

    if (plain) segments.push({ plain, speechText: plain, emphasized: false });
    return segments;
  }

  function flush(): MarkerSegment {
    if (!insideMarker) return { plain: "", speechText: "", emphasized: false };
    const leftover = MARKER_OPEN + pendingWord;
    insideMarker = false;
    pendingWord = "";
    return { plain: leftover, speechText: leftover, emphasized: false };
  }

  return { feed, flush };
}
