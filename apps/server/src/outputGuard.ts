/**
 * Starter set only — a last-resort catch for the crudest cases, not a general moderation
 * system. Extend per the product's actual content policy; each entry is matched as a whole
 * phrase so it won't trip on unrelated words that happen to contain the same letters.
 */
const DISALLOWED_PHRASES = ["kill yourself", "kys"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DISALLOWED_PATTERN = new RegExp(
  `\\b(${DISALLOWED_PHRASES.map(escapeRegExp).join("|")})\\b`,
  "i",
);

/** Whether `text` contains a denylisted phrase — a coarse last line of defense before TTS. */
export function containsDisallowedContent(text: string): boolean {
  return DISALLOWED_PATTERN.test(text);
}
