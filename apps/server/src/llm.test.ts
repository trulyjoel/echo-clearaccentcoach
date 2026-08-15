import { SUPPORTED_L1S } from "@kalli/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const anthropicTestState = vi.hoisted(() => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ __modelId: modelId })),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: anthropicTestState.createAnthropic }));

async function* textDeltas(text: string): AsyncGenerator<string> {
  yield text;
}

const aiTestState = vi.hoisted(() => ({
  generateObjectCalls: [] as unknown[],
  streamTextCalls: [] as unknown[],
}));
vi.mock("ai", () => ({
  generateObject: vi.fn(async (args: { model: unknown }) => {
    aiTestState.generateObjectCalls.push(args.model);
    return { object: { errors: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
  }),
  streamText: vi.fn((args: { model: unknown }) => {
    aiTestState.streamTextCalls.push(args.model);
    return {
      textStream: textDeltas("Nice job!"),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    };
  }),
}));

const { buildAnalysisSystemPrompt, buildReplySystemPrompt, getLLMProvider } =
  await import("./llm.js");

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

describe("buildReplySystemPrompt", () => {
  it("includes the no-error few-shot example when there are no detected errors", () => {
    const prompt = buildReplySystemPrompt([]);

    expect(prompt).toContain("just talk normally and I'll jump in when something's off");
  });

  it("includes the error-present few-shot examples when errors are detected", () => {
    const prompt = buildReplySystemPrompt([
      {
        category: "article_usage",
        original: "I saw movie last night.",
        corrected: "I saw a movie last night.",
        explanation: "Singular countable nouns need an article.",
      },
    ]);

    expect(prompt).toContain("Small thing — 'I saw a movie.'");
    expect(prompt).toContain("you'd say 'I've been living here for three years' though");
    expect(prompt).not.toContain("just talk normally and I'll jump in when something's off");
  });
});

describe("generateReply streaming", () => {
  it("exposes the mocked model's deltas via textStream and its usage via usage", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    const provider = getLLMProvider();

    const stream = provider.generateReply([{ role: "user", content: "hi" }], []);

    const deltas: string[] = [];
    for await (const delta of stream.textStream) deltas.push(delta);

    expect(deltas.join("")).toBe("Nice job!");
    expect(await stream.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });
});

describe("per-pass model selection", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    aiTestState.generateObjectCalls.length = 0;
    aiTestState.streamTextCalls.length = 0;
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
    expect(aiTestState.streamTextCalls.at(-1)).toEqual({ __modelId: "claude-sonnet-5" });
  });

  it("honors ANALYSIS_LLM_MODEL and LLM_MODEL independently", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANALYSIS_LLM_MODEL"] = "custom-analysis-model";
    process.env["LLM_MODEL"] = "custom-reply-model";
    const provider = getLLMProvider();

    await provider.analyzeErrors("she go to school", "spanish");
    await provider.generateReply([{ role: "user", content: "hi" }], []);

    expect(aiTestState.generateObjectCalls.at(-1)).toEqual({ __modelId: "custom-analysis-model" });
    expect(aiTestState.streamTextCalls.at(-1)).toEqual({ __modelId: "custom-reply-model" });
  });
});
