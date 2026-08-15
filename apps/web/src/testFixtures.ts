import type { PersistedError } from "@kalli/types";

/** A minimal, override-able `PersistedError` for tests that don't care about most of its fields. */
export function makeError(overrides: Partial<PersistedError> = {}): PersistedError {
  return {
    id: "error-1",
    hasClip: false,
    bookmarked: false,
    category: "word_order",
    original: "go I",
    corrected: "I go",
    explanation: "Subject comes before the verb.",
    ...overrides,
  };
}
