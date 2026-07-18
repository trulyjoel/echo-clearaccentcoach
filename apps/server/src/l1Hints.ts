import type { SupportedL1 } from "@callie/types";

/**
 * Interference-pattern hints for pass 1's error-analysis prompt, one per supported L1 —
 * grounded in established contrastive-analysis / L2 error literature (e.g. Swan & Smith,
 * "Learner English") on each language's typical transfer errors into English. These bias
 * detection toward known patterns; they don't add categories beyond the generic taxonomy.
 */
export const L1_INTERFERENCE_HINTS: Record<SupportedL1, string> = {
  spanish:
    "Spanish speakers often drop subject pronouns and carry over Spanish word order in " +
    "questions and negation; confuse the English simple past/present perfect and progressive " +
    "aspect (Spanish preterite/imperfect doesn't map cleanly onto English tense/aspect); use " +
    'definite articles with generic or abstract nouns ("I like the coffee"); and mis-select ' +
    'prepositions because Spanish "en" covers both "in" and "on", and verbs like ' +
    '"llegar a" produce "arrive to" instead of "arrive at/in".',
  mandarin:
    "Mandarin speakers often omit tense/aspect marking entirely, since Mandarin verbs don't " +
    "inflect for tense and instead rely on time words and aspect particles, producing missing " +
    '"-ed"/"-s" endings and subject-verb agreement errors; omit articles, since Mandarin has ' +
    "no article system; carry over topic-comment word order; and mis-select prepositions, since " +
    "Mandarin's prepositions don't map one-to-one onto English ones.",
  vietnamese:
    "Vietnamese speakers often omit tense/aspect and subject-verb agreement marking, since " +
    "Vietnamese verbs don't conjugate and instead use separate particles for aspect; omit " +
    "articles and plural marking, since Vietnamese has no article system and uses classifiers " +
    "instead; and mis-select prepositions, since Vietnamese preposition usage doesn't map " +
    "one-to-one onto English.",
  korean:
    "Korean speakers often carry over SOV (verb-final) word order into English, especially in " +
    "complex or subordinate clauses; drop subjects and articles, since Korean is pro-drop and " +
    "has no article system; mis-select prepositions, since Korean uses postpositions attached " +
    "to nouns rather than a separate preposition system; and produce tense/aspect errors, since " +
    "Korean's aspect marking maps imperfectly onto English tense distinctions.",
  arabic:
    "Arabic speakers often over- or under-use definite articles, since Arabic marks " +
    'definiteness only with a prefix ("al-") and has no indefinite article; confuse English ' +
    "tense with Arabic's perfect/imperfect aspect system, which doesn't map directly onto " +
    "English past/present/future; mis-select prepositions, since Arabic verbs pair with fixed " +
    "prepositions that don't match their English equivalents; and occasionally carry over " +
    "flexible VSO word order.",
};
