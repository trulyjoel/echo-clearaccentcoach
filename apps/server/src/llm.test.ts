import { SUPPORTED_L1S } from "@callie/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const anthropicTestState = vi.hoisted(() => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ __modelId: modelId })),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: anthropicTestState.createAnthropic }));

const aiTestState = vi.hoisted(() => ({
  generateObjectCalls: [] as unknown[],
  generateTextCalls: [] as unknown[],
}));
vi.mock("ai", () => ({
  generateObject: vi.fn(async (args: { model: unknown }) => {
    aiTestState.generateObjectCalls.push(args.model);
    return { object: { errors: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
  }),
  generateText: vi.fn(async (args: { model: unknown }) => {
    aiTestState.generateTextCalls.push(args.model);
    return { text: "Nice job!", usage: { inputTokens: 1, outputTokens: 1 } };
  }),
}));

const { buildAnalysisSystemPrompt, getLLMProvider } = await import("./llm.js");

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

describe("per-pass model selection", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    aiTestState.generateObjectCalls.length = 0;
    aiTestState.generateTextCalls.length = 0;
  });

  it("defaults the analysis pass to a faster model than the reply pass", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    delete process.env["ANALYSIS_LLM_MODEL"];
    delete process.env["LLM_MODEL"];
    const provider = getLLMProvider();

    await provider.analyzeErrors("she go to school", "spanish");
    await provider.generateReply([{ role: "user", content: "hi" }], []);

    expect(aiTestState.generateObjectCalls.at(-1)).toEqual({
      __modelId: "claude-haiku-4-5-20251001",
    });
    expect(aiTestState.generateTextCalls.at(-1)).toEqual({ __modelId: "claude-sonnet-5" });
  });

  it("honors ANALYSIS_LLM_MODEL and LLM_MODEL independently", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANALYSIS_LLM_MODEL"] = "custom-analysis-model";
    process.env["LLM_MODEL"] = "custom-reply-model";
    const provider = getLLMProvider();

    await provider.analyzeErrors("she go to school", "spanish");
    await provider.generateReply([{ role: "user", content: "hi" }], []);

    expect(aiTestState.generateObjectCalls.at(-1)).toEqual({ __modelId: "custom-analysis-model" });
    expect(aiTestState.generateTextCalls.at(-1)).toEqual({ __modelId: "custom-reply-model" });
  });
});
