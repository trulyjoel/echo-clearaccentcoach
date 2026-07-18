import { SUPPORTED_L1S } from "@callie/types";
import { describe, expect, it } from "vitest";
import { buildAnalysisSystemPrompt } from "./llm.js";

describe("buildAnalysisSystemPrompt", () => {
  it("includes the generic taxonomy for an unsupported/other L1", () => {
    const prompt = buildAnalysisSystemPrompt("other");

    expect(prompt).toContain("word_order");
    expect(prompt).toContain("verb_tense_aspect");
    expect(prompt).toContain("subject_verb_agreement");
    expect(prompt).toContain("article_usage");
    expect(prompt).toContain("preposition_choice");
    expect(prompt).not.toContain("native language");
  });

  for (const l1 of SUPPORTED_L1S) {
    it(`includes ${l1}-specific interference hints for a ${l1} learner`, () => {
      const prompt = buildAnalysisSystemPrompt(l1);
      const genericPrompt = buildAnalysisSystemPrompt("other");

      expect(prompt).toContain(l1);
      expect(prompt.length).toBeGreaterThan(genericPrompt.length);
      // Still uses only the five generic categories — hints bias detection, not new categories.
      expect(prompt).toContain("word_order");
      expect(prompt).toContain("preposition_choice");
    });
  }

  it("produces a different prompt per supported L1", () => {
    const prompts = SUPPORTED_L1S.map((l1) => buildAnalysisSystemPrompt(l1));
    expect(new Set(prompts).size).toBe(SUPPORTED_L1S.length);
  });
});
