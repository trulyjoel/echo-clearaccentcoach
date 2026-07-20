import { describe, expect, it } from "vitest";
import { matchFlaggedSpans, splitIntoSegments } from "./inlineErrorMatch.js";
import { makeError } from "./testFixtures.js";

describe("matchFlaggedSpans", () => {
  it("finds an error's flagged text verbatim in the turn's text", () => {
    const error = makeError({ original: "go I" });
    const matches = matchFlaggedSpans("yesterday go I to the store", [error]);
    expect(matches).toEqual([{ start: 10, end: 14, error }]);
  });

  it("omits an error whose flagged text can't be found verbatim", () => {
    const error = makeError({ original: "go I", id: "error-2" });
    expect(matchFlaggedSpans("something completely different", [error])).toEqual([]);
  });

  it("matches non-overlapping errors, sorted left to right regardless of input order", () => {
    const errorA = makeError({ id: "error-a", original: "she go" });
    const errorB = makeError({ id: "error-b", original: "I saw" });
    const matches = matchFlaggedSpans("I saw her and she go home", [errorA, errorB]);
    expect(matches.map((m) => m.error.id)).toEqual(["error-b", "error-a"]);
    expect(matches[0]).toEqual({ start: 0, end: 5, error: errorB });
    expect(matches[1]).toEqual({ start: 14, end: 20, error: errorA });
  });

  it("drops a later error whose only occurrence overlaps an already-matched span", () => {
    // "I are" (0-5) and "are go" (2-8) overlap on "are" — the first error wins the slot, the
    // second is dropped from the inline highlight (it still stays in the corrections panel).
    const errorA = makeError({ id: "error-a", original: "I are" });
    const errorB = makeError({ id: "error-b", original: "are go" });
    const matches = matchFlaggedSpans("I are go", [errorA, errorB]);
    expect(matches).toEqual([{ start: 0, end: 5, error: errorA }]);
  });

  it("finds a later non-overlapping occurrence when an earlier one is already taken", () => {
    const errorA = makeError({ id: "error-a", original: "go" });
    const errorB = makeError({ id: "error-b", original: "go" });
    const matches = matchFlaggedSpans("go go", [errorA, errorB]);
    expect(matches).toEqual([
      { start: 0, end: 2, error: errorA },
      { start: 3, end: 5, error: errorB },
    ]);
  });

  it("returns nothing for an empty error list", () => {
    expect(matchFlaggedSpans("hello there", [])).toEqual([]);
  });
});

describe("splitIntoSegments", () => {
  it("returns the whole text as one plain segment with no matches", () => {
    expect(splitIntoSegments("hello there", [])).toEqual([{ text: "hello there" }]);
  });

  it("splits around a single matched span", () => {
    const error = makeError();
    const segments = splitIntoSegments("yesterday go I to the store", [
      { start: 10, end: 14, error },
    ]);
    expect(segments).toEqual([
      { text: "yesterday " },
      { text: "go I", error },
      { text: " to the store" },
    ]);
  });

  it("splits around adjacent matches with no plain text in between", () => {
    const errorA = makeError({ id: "error-a" });
    const errorB = makeError({ id: "error-b" });
    const segments = splitIntoSegments("abcdef", [
      { start: 0, end: 3, error: errorA },
      { start: 3, end: 6, error: errorB },
    ]);
    expect(segments).toEqual([
      { text: "abc", error: errorA },
      { text: "def", error: errorB },
    ]);
  });
});
