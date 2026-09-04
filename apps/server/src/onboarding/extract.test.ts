import { afterEach, describe, expect, it, vi } from "vitest";

const anthropicTestState = vi.hoisted(() => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ __modelId: modelId })),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: anthropicTestState.createAnthropic }));

interface RecordedGenerateObjectCall {
  model: unknown;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
}

const aiTestState = vi.hoisted(() => ({
  calls: [] as RecordedGenerateObjectCall[],
  nextObject: {} as Record<string, unknown>,
}));
vi.mock("ai", () => ({
  generateObject: vi.fn(async (args: RecordedGenerateObjectCall) => {
    aiTestState.calls.push(args);
    return { object: aiTestState.nextObject, usage: { inputTokens: 1, outputTokens: 1 } };
  }),
}));

const { extractOnboardingAnswer, extractOnboardingConfirmation } = await import("./extract.js");

describe("extractOnboardingAnswer", () => {
  afterEach(() => {
    aiTestState.calls.length = 0;
  });

  it("returns the extracted free-text value for the name field", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    aiTestState.nextObject = { value: "Maria", l1: null, proficiency: null, confident: true };

    const result = await extractOnboardingAnswer("name", "You can call me Maria");

    expect(result).toEqual({
      value: "Maria",
      l1: null,
      proficiency: null,
      confident: true,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(aiTestState.calls[0]?.prompt).toBe("You can call me Maria");
  });

  it("returns the mapped l1 for the l1 field", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    aiTestState.nextObject = { value: "Spanish", l1: "spanish", proficiency: null, confident: true };

    const result = await extractOnboardingAnswer("l1", "I speak Spanish");

    expect(result.l1).toBe("spanish");
  });

  it("returns the mapped proficiency for the proficiency field", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    aiTestState.nextObject = {
      value: "intermediate",
      l1: null,
      proficiency: "intermediate",
      confident: true,
    };

    const result = await extractOnboardingAnswer("proficiency", "I'd say intermediate");

    expect(result.proficiency).toBe("intermediate");
  });

  it("returns free text for the context and goals fields", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    aiTestState.nextObject = {
      value: "work meetings",
      l1: null,
      proficiency: null,
      confident: true,
    };

    const result = await extractOnboardingAnswer("context", "Mostly for work meetings");

    expect(result.value).toBe("work meetings");
  });

  it("passes confident: false through unchanged", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    aiTestState.nextObject = { value: null, l1: null, proficiency: null, confident: false };

    const result = await extractOnboardingAnswer("goals", "uh, I don't know");

    expect(result.confident).toBe(false);
  });

  it("includes the spelling instruction in the system prompt only when spelling is requested", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    aiTestState.nextObject = { value: "Maria", l1: null, proficiency: null, confident: true };

    await extractOnboardingAnswer("name", "M A R I A", { spelling: true });
    const withSpelling = aiTestState.calls[0]?.system ?? "";

    await extractOnboardingAnswer("name", "Maria");
    const withoutSpelling = aiTestState.calls[1]?.system ?? "";

    expect(withSpelling).toContain("spelling");
    expect(withoutSpelling).not.toContain("spelling");
  });
});

describe("extractOnboardingConfirmation", () => {
  afterEach(() => {
    aiTestState.calls.length = 0;
  });

  it("returns confirmed: true for an affirmative reply", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    aiTestState.nextObject = { confirmed: true };

    const result = await extractOnboardingConfirmation("yep, that's right");

    expect(result).toEqual({ confirmed: true, usage: { inputTokens: 1, outputTokens: 1 } });
    expect(aiTestState.calls[0]?.prompt).toBe("yep, that's right");
  });

  it("returns confirmed: false for a rejection", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    aiTestState.nextObject = { confirmed: false };

    const result = await extractOnboardingConfirmation("no, that's not it");

    expect(result).toEqual({ confirmed: false, usage: { inputTokens: 1, outputTokens: 1 } });
  });
});
