/** The generic (non-L1-specific) error taxonomy pass 1 tags each detected error with. */
export const ERROR_CATEGORIES = [
  "word_order",
  "verb_tense_aspect",
  "subject_verb_agreement",
  "article_usage",
  "preposition_choice",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface DetectedError {
  category: ErrorCategory;
  original: string;
  corrected: string;
  explanation: string;
}
