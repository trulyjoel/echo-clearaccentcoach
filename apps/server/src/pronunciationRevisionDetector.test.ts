import { describe, expect, it } from "vitest";
import { detectAsrSmoothedDeviations } from "./pronunciationRevisionDetector.js";

describe("detectAsrSmoothedDeviations", () => {
  it("flags a word Flux revised to a phonetically close real word by EndOfTurn", () => {
    const result = detectAsrSmoothedDeviations("I had a very good day", ["I had a berry good day"]);

    expect(result).toEqual([
      {
        word: "very",
        op: "sub",
        expectedPhoneme: "V",
        spokenPhoneme: "B",
        source: "transcript_revision",
      },
    ]);
  });

  it("ignores a prior transcript with a different word count than the final one", () => {
    const result = detectAsrSmoothedDeviations("I need to cancel please", ["I need to cancel"]);

    expect(result).toEqual([]);
  });

  it("discards a revision where the words' phone sequences have different lengths", () => {
    const result = detectAsrSmoothedDeviations("to fly", ["for fly"]);

    expect(result).toEqual([]);
  });

  it("dedupes when multiple prior transcripts flag the same word position", () => {
    const result = detectAsrSmoothedDeviations("I had a very good day", [
      "I had a berry good day",
      "I had a berry good day",
    ]);

    expect(result).toHaveLength(1);
  });

  it("returns an empty array when no prior transcript differs from the final one", () => {
    expect(detectAsrSmoothedDeviations("hello Kalli", ["hello Kalli"])).toEqual([]);
  });

  it("returns an empty array when there are no prior transcripts at all", () => {
    expect(detectAsrSmoothedDeviations("hello Kalli", [])).toEqual([]);
  });
});
