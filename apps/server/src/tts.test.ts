import { afterEach, describe, expect, it, vi } from "vitest";

const elevenLabsTestState = vi.hoisted(() => ({
  streamCalls: [] as { voiceId: string; text: string }[],
}));
vi.mock("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class {
    textToSpeech = {
      stream: vi.fn(async (voiceId: string, options: { text: string }) => {
        elevenLabsTestState.streamCalls.push({ voiceId, text: options.text });
        return (async function* () {})();
      }),
    };
  },
}));

const { getTTSProvider, sanitizeForSpeech } = await import("./tts.js");

describe("sanitizeForSpeech", () => {
  it("strips straight double quotes", () => {
    expect(sanitizeForSpeech('Small thing — "I saw a movie."')).toBe(
      "Small thing — I saw a movie.",
    );
  });

  it("strips curly/typographic double quotes", () => {
    expect(sanitizeForSpeech("Small thing — “I saw a movie.”")).toBe(
      "Small thing — I saw a movie.",
    );
  });

  it("preserves apostrophes in contractions", () => {
    expect(sanitizeForSpeech("you'd say I've been living here")).toBe(
      "you'd say I've been living here",
    );
  });

  it("preserves em dashes", () => {
    expect(sanitizeForSpeech("bare Make needs something — after it")).toBe(
      "bare Make needs something — after it",
    );
  });

  it("strips multiple quoted segments in one sentence", () => {
    const input = 'Ha, gotta say "Make it fast" or "speed things up" — bare "Make" needs it!';
    expect(sanitizeForSpeech(input)).toBe(
      "Ha, gotta say Make it fast or speed things up — bare Make needs it!",
    );
  });
});

describe("ElevenLabsTTSProvider.synthesize", () => {
  afterEach(() => {
    elevenLabsTestState.streamCalls.length = 0;
  });

  it("sends sanitized text to ElevenLabs, not the raw quoted text", async () => {
    process.env["ELEVENLABS_API_KEY"] = "test-key";
    const provider = getTTSProvider();

    const { model } = await provider.synthesize('Small thing — "I saw a movie."');

    expect(elevenLabsTestState.streamCalls.at(-1)?.text).toBe("Small thing — I saw a movie.");
    expect(model).toBe("eleven_flash_v2_5");
  });
});
