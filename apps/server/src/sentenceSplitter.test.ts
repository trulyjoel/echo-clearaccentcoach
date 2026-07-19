import { describe, expect, it } from "vitest";
import { splitSentences } from "./sentenceSplitter.js";

describe("splitSentences", () => {
  it("returns no sentences and the whole buffer as remainder when unterminated", () => {
    expect(splitSentences("Hello there")).toEqual({ sentences: [], remainder: "Hello there" });
  });

  it("extracts one sentence terminated by punctuation and trailing whitespace", () => {
    expect(splitSentences("Hello there. ")).toEqual({ sentences: ["Hello there."], remainder: "" });
  });

  it("holds back punctuation with no trailing whitespace yet as remainder", () => {
    // Guards against splitting mid-delta, e.g. "3." before "14" arrives in the next chunk.
    expect(splitSentences("That costs $3.")).toEqual({
      sentences: [],
      remainder: "That costs $3.",
    });
  });

  it("extracts multiple sentences from one buffer", () => {
    expect(splitSentences("Hi there. How are you? Great!  ")).toEqual({
      sentences: ["Hi there.", "How are you?", "Great!"],
      remainder: "",
    });
  });

  it("extracts complete sentences and leaves a trailing partial one as remainder", () => {
    expect(splitSentences("Hi there. How are")).toEqual({
      sentences: ["Hi there."],
      remainder: "How are",
    });
  });

  it("handles repeated terminal punctuation as one boundary", () => {
    expect(splitSentences("Really?! Yes. ")).toEqual({
      sentences: ["Really?!", "Yes."],
      remainder: "",
    });
  });

  it("includes a trailing closing quote/paren/bracket in the sentence", () => {
    expect(splitSentences('She said "hi." Then left. ')).toEqual({
      sentences: ['She said "hi."', "Then left."],
      remainder: "",
    });
  });

  it("returns an empty remainder and no sentences for an empty buffer", () => {
    expect(splitSentences("")).toEqual({ sentences: [], remainder: "" });
  });
});
